// Turns per-question measurements into a stress score, a Truth/Lie verdict and a confidence.
//
// 1. Baseline questions (answered truthfully) give each signal's normal mean and spread.
// 2. Every question's signals become z-scores vs that baseline (how many "normal spreads" away).
// 3. Stress score = weighted average of the z-scores (signed so higher = more stress).
// 4. Baseline scores (leave-one-out, so they aren't scored against themselves) give the
//    person's normal score range. Threshold = baseline mean + 1 baseline spread.
// 5. Test score above threshold -> "Lie", below -> "Truth".
//    Confidence grows with distance from the threshold and shrinks with poor signal quality.

export const FEATURES = [
  { key: 'responseTime', label: 'Answer delay', unit: 's', dir: 1, w: 1.5, floor: 0.35, dp: 2 },
  { key: 'voiceLatency', label: 'Time to start speaking', unit: 's', dir: 1, w: 1.0, floor: 0.3, dp: 2 },
  { key: 'hr', label: 'Heart rate', unit: 'bpm', dir: 1, w: 1.5, floor: 3, dp: 0, qualityKey: 'hrQuality' },
  { key: 'rmssd', label: 'Heart rate variability', unit: 'ms', dir: -1, w: 0.3, floor: 15, dp: 0, qualityKey: 'hrQuality' },
  { key: 'tension', label: 'Face tension', unit: '', dir: 1, w: 1.0, floor: 0.03, dp: 3 },
  { key: 'blinkRate', label: 'Blink rate', unit: '/min', dir: 1, w: 0.75, floor: 6, dp: 0 },
  { key: 'gazeMove', label: 'Eye movement', unit: '', dir: 1, w: 0.75, floor: 0.05, dp: 2 },
  { key: 'headMotion', label: 'Head movement', unit: '', dir: 1, w: 0.5, floor: 0.01, dp: 3 },
  { key: 'pitch', label: 'Voice pitch', unit: 'Hz', dir: 1, w: 0.75, floor: 8, dp: 0 },
];

export const MIN_BASELINE = 3;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function meanSd(vals) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1)) : 0;
  return { mean: m, sd };
}

function buildStats(records) {
  const stats = {};
  for (const f of FEATURES) {
    const vals = records.map((r) => r.features[f.key]).filter(finite);
    if (vals.length >= 2) {
      const { mean, sd } = meanSd(vals);
      stats[f.key] = { mean, sd: Math.max(sd, f.floor) };
    }
  }
  return stats;
}

function scoreRecord(r, stats) {
  let s = 0, W = 0;
  const contribs = [];
  for (const f of FEATURES) {
    const st = stats[f.key];
    const v = r.features[f.key];
    if (!st || !finite(v)) continue;
    let w = f.w;
    if (f.qualityKey) w *= r.features[f.qualityKey] || 0;
    if (w <= 0.05) continue;
    const z = Math.max(-4, Math.min(4, (v - st.mean) / st.sd)) * f.dir;
    s += w * z; W += w;
    contribs.push({ key: f.key, label: f.label, unit: f.unit, dp: f.dp, value: v, baseline: st.mean, z, weight: w });
  }
  contribs.sort((a, b) => b.weight * Math.abs(b.z) - a.weight * Math.abs(a.z));
  return { score: W ? s / W : null, contribs };
}

export function computeResults(records) {
  const base = records.filter((r) => r.type === 'baseline');
  if (base.length < MIN_BASELINE) {
    return { error: `Need at least ${MIN_BASELINE} answered baseline questions (got ${base.length}).` };
  }
  const stats = buildStats(base);

  const looScores = base.map((r) => scoreRecord(r, buildStats(base.filter((x) => x !== r))).score);
  const baseScores = looScores.filter(finite);
  if (baseScores.length < 2) return { error: 'Not enough usable signal on the baseline questions. Check lighting and microphone, then try again.' };
  const { mean: baseMean, sd: baseSd } = meanSd(baseScores);
  const spread = Math.max(baseSd, 0.25);
  const threshold = baseMean + spread;

  let bi = 0;
  const items = records.map((r) => {
    if (r.type === 'baseline') {
      const own = scoreRecord(r, stats);
      const loo = looScores[bi++];
      return { ...r, score: finite(loo) ? loo : own.score, contribs: own.contribs, verdict: 'baseline' };
    }
    const { score, contribs } = scoreRecord(r, stats);
    if (!finite(score)) return { ...r, score: null, contribs, verdict: 'unknown', confidence: null };
    const dist = (score - threshold) / spread;
    const raw = 50 + 45 * Math.tanh(Math.abs(dist));
    const q = r.features.quality ?? 0.5;
    return {
      ...r, score, contribs,
      verdict: score > threshold ? 'lie' : 'truth',
      confidence: Math.round(50 + (raw - 50) * q),
    };
  });

  return { baseMean, spread, threshold, items, stats };
}
