import { loadQuestions, saveQuestions, loadSettings, saveSettings, newId, parseImport, DEFAULT_QUESTIONS, TYPES } from './questions.js';
import { RPPG } from './rppg.js';
import { Voice } from './voice.js';
import { computeResults, FEATURES, MIN } from './scoring.js';

const $ = (s, el = document) => el.querySelector(s);
const SIM = new URLSearchParams(location.search).has('sim'); // ?sim=1 -> fake sensor data, for testing the flow
const FIX_MS = SIM ? 150 : 1000;     // "+" before each question
const AFTER_MS = SIM ? 150 : 2500;   // quiet gap after each answer (blinks / tension window)
const ANSWER_TIMEOUT_MS = 10000;
const SEC_PER_ITEM = 6;
const READ_S_PER_WORD = 0.12;        // reading-time allowance subtracted from answer times

let questions = loadQuestions();
let settings = loadSettings();
let editingId = null;
let lastResults = loadLast();

const S = {
  stream: null, landmarker: null, analyzer: null, vision: null,
  voice: new Voice(), rppg: new RPPG(), frames: [],
  loopOn: false, loopGen: 0, uiTimer: null, micCalibrated: false,
  abort: false, answerResolve: null,
};

/* ---------- small helpers ---------- */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
function loadLast() { try { return JSON.parse(localStorage.getItem('ld.lastResults.v2')); } catch { return null; } }
function saveLast(r) { try { localStorage.setItem('ld.lastResults.v2', JSON.stringify(r)); } catch { /* ignore */ } }

/* ---------- navigation ---------- */
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
  const slot = $(`#${id} .sensor-slot`);
  if (slot) slot.append($('#sensor'));
  if (id === 'home') $('#btn-last').hidden = !lastResults;
  if (id === 'questions') renderQuestions();
  if (id === 'setup') enterSetup();
  if (id !== 'setup' && id !== 'test') stopSensors();
  window.scrollTo(0, 0);
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && !go.disabled) { if (S.answerResolve) stopTest(); show(go.dataset.go); }
});
$('#btn-last').onclick = () => { renderResults(lastResults); show('results'); };

/* ---------- question manager (admin) ---------- */
function counts() {
  const c = { truth: 0, lie: 0, test: 0 };
  for (const q of questions) c[q.type]++;
  return c;
}
function setupProblems() {
  const c = counts(), p = [];
  if (c.truth < MIN.truth) p.push(`${MIN.truth - c.truth} more truth practice`);
  if (c.lie < MIN.lie) p.push(`${MIN.lie - c.lie} more lie practice`);
  if (c.test < MIN.test) p.push('at least 1 test question');
  return p;
}
function renderQuestions() {
  const c = counts();
  const probs = setupProblems();
  $('#q-counts').textContent = `${c.truth} truth · ${c.lie} lie · ${c.test} test` + (probs.length ? `  (add ${probs.join(', ')})` : '');
  $('#btn-ready').disabled = probs.length > 0;
  $('#rounds').value = String(settings.rounds);
  const mins = Math.ceil((questions.length * settings.rounds * SEC_PER_ITEM) / 60);
  $('#duration').textContent = `≈ ${mins} min test`;

  const ul = $('#qlist');
  ul.replaceChildren(...questions.map((q, i) => {
    if (q.id === editingId) {
      const ta = h('textarea', { rows: 2, maxlength: 200 }); ta.value = q.text;
      const sel = h('select', {}, ...Object.entries(TYPES).map(([k, t]) => h('option', { value: k, selected: q.type === k }, t.label)));
      return h('li', {}, h('div', { class: 'edit' }, ta, h('div', { class: 'row' }, sel,
        h('button', { class: 'btn primary small', onclick: () => {
          if (!ta.value.trim()) return;
          q.text = ta.value.trim(); q.type = sel.value; editingId = null; commit();
        } }, 'Save'),
        h('button', { class: 'btn ghost small', onclick: () => { editingId = null; renderQuestions(); } }, 'Cancel'))));
    }
    return h('li', {},
      h('span', { class: `badge ${q.type}` }, TYPES[q.type].badge),
      h('span', { class: 'qt' }, q.text),
      h('span', { class: 'acts' },
        h('button', { class: 'btn ghost icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn ghost icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === questions.length - 1, onclick: () => move(i, 1) }, '↓'),
        h('button', { class: 'btn ghost icon', title: 'Edit', 'aria-label': 'Edit', onclick: () => { editingId = q.id; renderQuestions(); } }, '✎'),
        h('button', { class: 'btn ghost icon', title: 'Delete', 'aria-label': 'Delete', onclick: () => {
          if (confirm(`Delete this question?\n\n"${q.text}"`)) { questions.splice(i, 1); commit(); }
        } }, '✕')));
  }));
}
function move(i, d) {
  const j = i + d;
  [questions[i], questions[j]] = [questions[j], questions[i]];
  commit();
}
function commit() { saveQuestions(questions); renderQuestions(); }

$('#rounds').onchange = (e) => { settings.rounds = Number(e.target.value); saveSettings(settings); renderQuestions(); };
$('#qform').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#qtext').value.trim();
  if (!text) return;
  questions.push({ id: newId(), type: $('#qtype').value, text });
  $('#qtext').value = '';
  commit();
  $('#qtext').focus();
});
$('#qtext').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#qform').requestSubmit(); }
});
$('#q-export').onclick = () => download('truth-meter-questions.json', JSON.stringify(questions.map(({ type, text }) => ({ type, text })), null, 2), 'application/json');
$('#q-import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const list = parseImport(await file.text());
    if (confirm(`Replace your ${questions.length} questions with ${list.length} imported ones?`)) { questions = list; commit(); }
  } catch (err) { alert(`Could not import: ${err.message}`); }
};
$('#q-reset').onclick = () => {
  if (confirm('Replace your questions with the example set?')) { questions = DEFAULT_QUESTIONS.map((q) => ({ ...q })); commit(); }
};

/* ---------- sensors ---------- */
async function startSensors() {
  if (SIM || S.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser can only use the camera on a secure page (https:// or localhost).');
  }
  const video = $('#video');
  const vc = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  let hasMic = true;
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: vc, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    if (['NotAllowedError', 'NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(err.name)) {
      S.stream = await navigator.mediaDevices.getUserMedia({ video: vc });
      hasMic = false;
    } else throw err;
  }
  video.srcObject = S.stream;
  await video.play();
  $('#vid-empty').hidden = true;
  setCheck('ck-cam', 'ok');

  if (hasMic) {
    await S.voice.start(S.stream);
    setMsg('Measuring room noise, please stay quiet…');
    await S.voice.calibrateNoise(1500);
    S.micCalibrated = true;
  }

  if (!S.landmarker) {
    setMsg('Loading face tracker (first time takes a few seconds)…');
    S.vision = await import('./vision.js');
    S.landmarker = await S.vision.createLandmarker();
  }
  S.analyzer = new S.vision.FrameAnalyzer(video, S.landmarker, $('#overlay'));
  S.rppg.reset();
  S.frames = [];
  S.loopOn = true;
  const gen = ++S.loopGen;
  frameLoop(gen);
  setMsg('');
}

function frameLoop(gen) {
  if (!S.loopOn || gen !== S.loopGen) return;
  const video = $('#video');
  const now = performance.now();
  try {
    const fr = S.analyzer.process(now);
    if (fr) {
      fr.t = now;
      S.frames.push(fr);
      if (fr.face) S.rppg.push(now, ...fr.rgb);
      while (S.frames.length && S.frames[0].t < now - 120000) S.frames.shift();
    }
  } catch (err) { console.error(err); }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => frameLoop(gen));
  else requestAnimationFrame(() => frameLoop(gen));
}

function stopSensors() {
  S.loopOn = false;
  clearInterval(S.uiTimer); S.uiTimer = null;
  if (S.voice.ready) S.voice.stop();
  S.micCalibrated = false;
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  $('#video').srcObject = null;
  setVidMsg(SIM ? 'Simulation mode: no camera' : 'Camera off');
  const o = $('#overlay'); o.getContext('2d').clearRect(0, 0, o.width, o.height);
}

function liveStatus() {
  if (SIM) return { face: 1, bright: 140, hr: { bpm: 74 + Math.random() * 3, quality: 0.8 } };
  const now = performance.now();
  const recent = S.frames.filter((f) => f.t > now - 1000);
  const faces = recent.filter((f) => f.face);
  return {
    face: recent.length ? faces.length / recent.length : 0,
    bright: mean(faces.map((f) => f.brightness)),
    hr: S.rppg.estimate(now, 10),
  };
}

function updateLive() {
  const st = liveStatus();
  $('#live-hr').textContent = st.hr && st.hr.quality > 0.3 ? Math.round(st.hr.bpm) : '--';
  $('#live-mic').style.width = `${Math.min(100, (S.voice.level / (S.voice.threshold * 3)) * 100)}%`;
  const light = $('#q-light');
  const okLight = st.bright != null && st.bright >= 60 && st.bright <= 225;
  const q = st.face > 0.8 && okLight ? 'good' : st.face > 0.5 ? 'fair' : 'poor';
  light.className = `light ${q}`;
  $('#live-q').textContent = q === 'good' ? 'Good view' : q === 'fair' ? 'Face partly lost' : 'Face not found';

  if (!$('#setup').hidden) {
    setCheck('ck-face', st.face > 0.7 ? 'ok' : st.face > 0.3 ? 'mid' : 'bad');
    const b = st.bright;
    setCheck('ck-light', b == null ? '' : b < 60 || b > 225 ? 'bad' : b < 85 || b > 205 ? 'mid' : 'ok',
      b == null ? 'Lighting' : b < 60 ? 'Lighting: too dark' : b > 225 ? 'Lighting: too bright' : 'Lighting');
    setCheck('ck-mic', SIM || S.micCalibrated ? 'ok' : S.voice.ready ? 'mid' : 'bad', SIM || S.voice.ready ? 'Microphone' : 'Microphone: off (optional)');
    $('#btn-begin').disabled = !(SIM || st.face > 0.7);
  }
}

function setVidMsg(t) { const el = $('#vid-empty'); el.textContent = t; el.hidden = false; }
function setCheck(id, cls, label) {
  const li = $(`#${id}`);
  li.className = cls;
  if (label) li.lastChild.textContent = label;
}
function setMsg(t) { $('#setup-msg').textContent = t; }

async function enterSetup() {
  $('#btn-begin').disabled = true;
  ['ck-cam', 'ck-face', 'ck-light', 'ck-mic'].forEach((id) => setCheck(id, ''));
  const probs = setupProblems();
  if (probs.length) { setMsg(`The admin needs to add ${probs.join(', ')} first.`); return; }
  setMsg(SIM ? 'Simulation mode: no camera or mic is used, sensor data is made up.' : '');
  clearInterval(S.uiTimer);
  S.uiTimer = setInterval(updateLive, 500);
  try {
    await startSensors();
    if (SIM) ['ck-cam', 'ck-face', 'ck-light', 'ck-mic'].forEach((id) => setCheck(id, 'ok'));
  } catch (err) {
    console.error(err);
    setCheck('ck-cam', 'bad');
    const blocked = err.name === 'NotAllowedError';
    setVidMsg(blocked ? 'Camera blocked' : 'Camera not available');
    setMsg(blocked
      ? 'Camera permission was blocked. Allow camera (and microphone) for this page in the browser settings, then reload. The Claude app\'s built-in browser can\'t use the camera.'
      : `Could not start sensors: ${err.message}`);
  }
}

/* ---------- test flow ---------- */
$('#btn-begin').onclick = () => runTest();
$('#btn-stop').onclick = () => { stopTest(); show('home'); };
$('#t-answers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ans]');
  if (b && S.answerResolve) S.answerResolve(b.dataset.ans);
});
document.addEventListener('keydown', (e) => {
  if (!S.answerResolve || $('#test').hidden) return;
  if (e.key === 'y' || e.key === 'Y') S.answerResolve('yes');
  if (e.key === 'n' || e.key === 'N') S.answerResolve('no');
});

function stopTest() { S.abort = true; S.answerResolve?.('none'); }

function waitAnswer(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done('none'), ms);
    function done(a) { clearTimeout(timer); S.answerResolve = null; resolve(a); }
    S.answerResolve = done;
  });
}

function setStage({ kind = '', kindClass = '', text = '', hint = '', big = false, answers = false }) {
  const k = $('#t-kind');
  k.textContent = kind;
  k.className = `qkind ${kindClass}`;
  const t = $('#t-text');
  t.textContent = text;
  t.classList.toggle('big', big);
  $('#t-hint').textContent = hint;
  $('#t-answers').style.visibility = answers ? 'visible' : 'hidden';
}

const KIND = {
  truth: { kind: 'Practice · tell the truth', cls: 'k-truth' },
  lie: { kind: 'Practice · LIE on purpose', cls: 'k-lie' },
  test: { kind: 'Question', cls: '' },
};

async function askOne(q) {
  setStage({ text: '+', big: true });
  await sleep(FIX_MS);
  if (S.abort) return null;
  const t0 = performance.now();
  setStage({ kind: KIND[q.type].kind, kindClass: KIND[q.type].cls, text: q.text, hint: 'Tap as fast as you can', answers: true });
  const answer = await waitAnswer(ANSWER_TIMEOUT_MS);
  if (S.abort) return null;
  const tAns = performance.now();
  setStage({ text: '', big: true });
  await sleep(AFTER_MS);
  if (S.abort) return null;
  return { answer, t0, tAns, t1: performance.now() };
}

async function runTest() {
  const rounds = settings.rounds;
  const plan = [];
  for (let r = 0; r < rounds; r++) for (const q of shuffle(questions)) plan.push({ q, round: r + 1 });
  S.abort = false;
  show('test');

  // Unscored warm-up (first answers are always exaggerated)
  $('#t-progress').textContent = 'Warm-up';
  $('#t-bar').style.width = '0%';
  const warm = await askOne({ type: 'test', text: 'Ready? Tap Yes to begin.' });
  if (!warm) return;

  const answers = [];
  for (let i = 0; i < plan.length; i++) {
    const { q, round } = plan[i];
    $('#t-progress').textContent = `${i + 1} of ${plan.length}`;
    $('#t-bar').style.width = `${(i / plan.length) * 100}%`;
    const r = await askOne(q);
    if (!r) return;
    const features = SIM ? simFeatures(q) : extract(q, r);
    answers.push({
      id: q.id, type: q.type, text: q.text, round, answer: r.answer, features,
      valid: r.answer !== 'none' && features.faceFrac >= 0.6,
    });
  }
  const res = computeResults(answers, rounds);
  res.sim = SIM;
  res.date = new Date().toISOString();
  res.raw = answers.map(({ id, type, text, round, answer, valid, S: score, features }) => ({ id, type, text, round, answer, valid, score, features }));
  lastResults = res;
  saveLast(res);
  renderResults(res);
  show('results');
}

// Per-answer measurements from the sensor logs
function extract(q, { t0, tAns, t1 }) {
  const fr = S.frames.filter((f) => f.t >= t0 && f.t <= t1);
  const faces = fr.filter((f) => f.face);
  const dur = (t1 - t0) / 1000;
  const readAdj = READ_S_PER_WORD * q.text.split(/\s+/).length;
  let blinks = 0, prev = false;
  for (const f of faces) { const b = f.blink > 0.45; if (b && !prev) blinks++; prev = b; }
  const enough = faces.length >= 8;
  const v = S.voice.ready ? S.voice.window(t0, tAns + 1500) : null;
  return {
    responseTime: tAns - t0 < ANSWER_TIMEOUT_MS - 50 ? (tAns - t0) / 1000 - readAdj : null,
    voiceLatency: v?.onset != null && v.onset < (tAns - t0) / 1000 + 1 ? v.onset - readAdj : null,
    pitch: v?.pitchMean ?? null,
    blinkRate: enough ? blinks / (dur / 60) : null,
    tension: enough ? mean(faces.map((f) => f.tension)) : null,
    faceFrac: fr.length ? faces.length / fr.length : 0,
  };
}

// Fake data for ?sim=1. Each test question is randomly a "lie" for the whole session.
const simTruth = new Map();
function simFeatures(q) {
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / Math.sqrt(0.5); };
  if (q.type === 'test' && !simTruth.has(q.id)) simTruth.set(q.id, Math.random() < 0.5);
  const lie = q.type === 'lie' || (q.type === 'test' && simTruth.get(q.id));
  const k = lie ? 1 : 0;
  return {
    responseTime: 0.9 + 0.18 * g() + 0.3 * k,
    voiceLatency: 0.8 + 0.2 * g() + 0.2 * k,
    pitch: 150 + 8 * g() + 4 * k,
    blinkRate: 18 + 5 * g() - 3 * k,
    tension: 0.12 + 0.03 * g() + 0.015 * k,
    faceFrac: 1,
    simLie: q.type === 'test' ? lie : undefined,
  };
}

/* ---------- results (simple) ---------- */
const VERDICT = {
  truth: { label: 'Likely truth', cls: 'truth' },
  lie: { label: 'Likely lie', cls: 'lie' },
  unsure: { label: "Can't tell", cls: 'unsure' },
};

function renderResults(res) {
  const body = $('#r-body');
  body.replaceChildren();
  if (!res?.calibration) return;
  if (res.sim) body.append(h('p', { class: 'sim' }, 'Simulated data. No real sensors were used.'));

  const c = res.calibration;
  const calTitle = { good: 'Practice check: good', weak: 'Practice check: weak', failed: "Practice check: didn't work" }[c.status];
  const calText = c.status === 'failed'
    ? `${c.reason} Every answer below is "Can't tell". Try again with the phone on a stand, good light, and answering as fast as possible.`
    : `On the practice questions, the app told this person's truths from their lies ${c.correct} out of ${c.total} times.` +
      (c.status === 'weak' ? ' That is only a little better than guessing, so treat the results below with extra caution.' : '');
  body.append(h('div', { class: `cal ${c.status}` }, h('b', {}, calTitle), h('p', {}, calText)));

  body.append(h('h2', {}, 'Test questions'));
  for (const q of res.questions) body.append(resultRow(q));

  body.append(h('p', { class: 'muted small explain' },
    'Each question was asked ', String(res.rounds), ' times. "Likely" means about 3 in 4 or more by this app\'s estimate; anything in between is "Can\'t tell". ',
    'It mostly measures answer speed and tension, not honesty. Even professional polygraphs are wrong about 1 time in 7, and phone tests are usually wrong more often.'));
}

function resultRow(q) {
  const v = VERDICT[q.verdict];
  const odds = q.p == null ? q.why
    : q.p < 0.5 ? `About ${Math.floor((1 - q.p) * 10 + 1e-9)} in 10 chance it was true`
    : `About ${Math.floor(q.p * 10 + 1e-9)} in 10 chance it was a lie`;
  return h('div', { class: `res ${v.cls}` },
    h('div', { class: 'res-head' },
      h('div', { class: 'res-q' }, q.text),
      h('span', { class: `pill ${v.cls}` }, v.label)),
    h('div', { class: 'meter3', role: 'img', 'aria-label': `${v.label}. ${odds}` },
      h('span', { class: 'z truth' }, 'Truth'), h('span', { class: 'z unsure' }, "Can't tell"), h('span', { class: 'z lie' }, 'Lie'),
      q.p != null ? h('i', { class: 'marker', style: `left:${(q.p * 100).toFixed(1)}%` }) : null),
    h('p', { class: 'res-odds' }, odds),
    h('p', { class: 'res-meta' }, `Answered ${q.answer}` + (q.reasons?.length ? ` · ${q.reasons.join(' · ')}` : '') +
      (q.simLie != null ? ` · (simulated as ${q.simLie ? 'a lie' : 'true'})` : '')));
}

$('#r-csv').onclick = () => {
  if (!lastResults?.raw) return;
  const keys = FEATURES.map((f) => f.key);
  const cols = ['n', 'round', 'type', 'question', 'answer', 'valid', 'lieScore', ...keys, 'faceFrac'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = lastResults.raw.map((r, i) => [i + 1, r.round, r.type, r.text, r.answer, r.valid, r.score ?? '',
    ...keys.map((k) => r.features[k] ?? ''), r.features.faceFrac ?? ''].map(esc).join(','));
  download('truth-meter-results.csv', [cols.join(','), ...rows].join('\n'), 'text/csv');
};

$('#sim-banner').hidden = !SIM;
show('home');
