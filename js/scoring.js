// Scoring v2, based on the research in reports/Camera lie test accuracy.md
//
// 1. Practice questions give two reference sets for THIS person: their truths and their
//    on-purpose lies (each asked several times, in shuffled rounds).
// 2. Each answer gets a "lie-likeness" score S: signals standardised against all practice
//    answers (median / spread, with floors), signed so higher = more lie-like, combined with
//    evidence-based weights. Answer speed dominates (strongest evidence a phone can measure).
// 3. Calibration check: if the person's practice lies don't score clearly above their practice
//    truths, the whole session is "Can't tell".
// 4. Each test question averages S over its rounds and is compared with the truth and lie sets
//    (likelihood ratio, 50/50 prior, widened for small samples and for the fact that
//    instructed lies only partly resemble real ones) -> chance of a lie.
// 5. Bands: >= 75% "Likely lie", <= 25% "Likely truth", otherwise "Can't tell". Shown chance capped at 85%.

export const FEATURES = [
  { key: 'responseTime', dir: 1, w: 1.0, floor: 0.08, more: (d) => `Answered ${fmtS(d)} slower than your true answers`, less: (d) => `Answered ${fmtS(d)} faster than your true answers` },
  { key: 'voiceLatency', dir: 1, w: 0.5, floor: 0.08, more: (d) => `Started speaking ${fmtS(d)} later than usual`, less: (d) => `Started speaking ${fmtS(d)} sooner than usual` },
  { key: 'blinkRate', dir: -1, w: 0.25, floor: 4, more: () => 'Blinked more than usual', less: () => 'Blinked less than usual' },
  { key: 'tension', dir: 1, w: 0.25, floor: 0.02, more: () => 'More face tension than usual', less: () => 'Less face tension than usual' },
  { key: 'pitch', dir: 1, w: 0.25, floor: 6, more: () => 'Voice pitch higher than usual', less: () => 'Voice pitch lower than usual' },
];

export const MIN = { truth: 3, lie: 2, test: 1 }; // distinct questions the admin must set
const MIN_VALID = { truth: 4, lie: 3 };          // usable practice answers needed to score
// Chosen by simulation (see notes.md): with a research-typical answer-time effect, these give
// ~80% correct on committed calls and ~40% "Can't tell"; with no real effect, ~95% "Can't tell".
const LIE_BAND = 0.75, TRUTH_BAND = 0.25;
const WIDEN = 1.0;                                // honesty factor on the spread

function fmtS(d) { return `${Math.abs(d).toFixed(1)} s`; }
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const variance = (a) => { if (a.length < 2) return 0; const m = mean(a); return a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); };

function buildStats(calib) {
  const stats = {};
  for (const f of FEATURES) {
    const vals = calib.map((r) => r.features[f.key]).filter(finite);
    if (vals.length < 4) continue;
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med))) * 1.4826;
    stats[f.key] = { center: med, scale: Math.max(mad, f.floor) };
  }
  return stats;
}

function lieScore(r, stats) {
  let s = 0, W = 0;
  for (const f of FEATURES) {
    const st = stats[f.key], v = r.features[f.key];
    if (!st || !finite(v)) continue;
    const z = Math.max(-3, Math.min(3, (v - st.center) / st.scale));
    s += f.w * f.dir * z; W += f.w;
  }
  return W >= 0.9 ? s / W : null; // needs answer speed (or several weaker signals)
}

function refModel(T, L) {
  const muT = mean(T), muL = mean(L);
  const pooled = Math.sqrt(((T.length - 1) * variance(T) + (L.length - 1) * variance(L)) / Math.max(1, T.length + L.length - 2));
  const sd = Math.max(pooled, 0.3);
  return { muT, muL, sd, nT: T.length, nL: L.length, sep: (muL - muT) / sd };
}

// Chance (0..1) that a mean score m over n answers came from the lie set
function chanceOfLie(m, n, M) {
  const s2 = (M.sd * WIDEN) ** 2;
  const vT = s2 / n + s2 / M.nT, vL = s2 / n + s2 / M.nL;
  const logN = (x, mu, v) => -0.5 * Math.log(v) - ((x - mu) ** 2) / (2 * v);
  const llr = logN(m, M.muL, vL) - logN(m, M.muT, vT);
  // Capped at 85%: a phone test can't honestly claim more certainty than that
  return Math.min(0.85, Math.max(0.15, 1 / (1 + Math.exp(-llr))));
}

function band(p) { return p >= LIE_BAND ? 'lie' : p <= TRUTH_BAND ? 'truth' : 'unsure'; }

export function computeResults(answers, rounds) {
  const valid = answers.filter((a) => a.valid);
  const calib = valid.filter((a) => a.type === 'truth' || a.type === 'lie');
  const stats = buildStats(calib);
  for (const a of answers) a.S = a.valid ? lieScore(a, stats) : null;

  const T = answers.filter((a) => a.type === 'truth' && finite(a.S)).map((a) => a.S);
  const L = answers.filter((a) => a.type === 'lie' && finite(a.S)).map((a) => a.S);

  const out = { rounds, calibration: null, questions: [] };
  if (T.length < MIN_VALID.truth || L.length < MIN_VALID.lie) {
    out.calibration = { status: 'failed', reason: 'Not enough clear practice answers (face not visible, or answers missed).' };
  } else {
    const M = refModel(T, L);
    // Leave-one-out: how often the model sorts the practice answers themselves correctly
    const practice = answers.filter((a) => (a.type === 'truth' || a.type === 'lie') && finite(a.S));
    let correct = 0;
    for (const a of practice) {
      const T2 = practice.filter((b) => b !== a && b.type === 'truth').map((b) => b.S);
      const L2 = practice.filter((b) => b !== a && b.type === 'lie').map((b) => b.S);
      const p = chanceOfLie(a.S, 1, refModel(T2, L2));
      if ((p > 0.5) === (a.type === 'lie')) correct++;
    }
    const status = M.sep < 0.5 ? 'failed' : M.sep < 1.0 ? 'weak' : 'good';
    out.calibration = {
      status, sep: M.sep, correct, total: practice.length,
      reason: status === 'failed' ? 'Your practice lies looked the same as your practice truths, so the app has nothing to compare against.' : '',
    };
    out.model = M;
  }

  // Truth-set feature centres for plain-language reasons
  const truthAns = answers.filter((a) => a.type === 'truth' && a.valid);
  const truthCentre = {};
  for (const f of FEATURES) {
    const vals = truthAns.map((a) => a.features[f.key]).filter(finite);
    if (vals.length >= 3) truthCentre[f.key] = median(vals);
  }

  const byQ = new Map();
  for (const a of answers.filter((x) => x.type === 'test')) {
    if (!byQ.has(a.id)) byQ.set(a.id, []);
    byQ.get(a.id).push(a);
  }
  for (const [id, list] of byQ) {
    const scored = list.filter((a) => finite(a.S));
    const yes = list.filter((a) => a.answer === 'yes').length, no = list.filter((a) => a.answer === 'no').length;
    const q = {
      id, text: list[0].text,
      answer: yes > no ? 'Yes' : no > yes ? 'No' : yes ? 'Mixed' : 'No answer',
      good: scored.length, asked: list.length,
      simLie: list[0].features.simLie,
    };
    if (out.calibration.status === 'failed') {
      q.verdict = 'unsure'; q.why = 'Practice check failed.';
    } else if (scored.length < Math.max(1, Math.ceil(list.length / 2))) {
      q.verdict = 'unsure'; q.why = 'Not enough clear readings for this question.';
    } else {
      const m = mean(scored.map((a) => a.S));
      q.p = chanceOfLie(m, scored.length, out.model);
      q.verdict = band(q.p);
      q.reasons = reasons(scored, truthCentre);
    }
    out.questions.push(q);
  }
  return out;
}

function reasons(scored, centre) {
  const list = [];
  for (const f of FEATURES) {
    if (!(f.key in centre)) continue;
    const vals = scored.map((a) => a.features[f.key]).filter(finite);
    if (!vals.length) continue;
    const d = mean(vals) - centre[f.key];
    const big = f.key === 'responseTime' || f.key === 'voiceLatency' ? Math.abs(d) >= 0.15 : Math.abs(d) >= f.floor * 1.5;
    if (big) list.push({ w: f.w * Math.abs(d) / f.floor, text: d > 0 ? f.more(d) : f.less(d) });
  }
  return list.sort((a, b) => b.w - a.w).slice(0, 2).map((r) => r.text);
}
