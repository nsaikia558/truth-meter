import { loadQuestions, saveQuestions, newId, parseImport, DEFAULT_QUESTIONS } from './questions.js';
import { RPPG } from './rppg.js';
import { Voice } from './voice.js';
import { computeResults, FEATURES, MIN_BASELINE } from './scoring.js';

const $ = (s, el = document) => el.querySelector(s);
const SIM = new URLSearchParams(location.search).has('sim'); // ?sim=1 -> fake sensor data, for testing the flow
const HOLD_SEC = SIM ? 1 : 6;     // "hold still" time after each answer (lets heart rate react)
const READY_MS = SIM ? 300 : 1500;
const ANSWER_TIMEOUT_MS = 20000;

let questions = loadQuestions();
let editingId = null;
let lastResults = loadLast();

const S = {
  stream: null, landmarker: null, analyzer: null, vision: null,
  voice: new Voice(), rppg: new RPPG(), frames: [],
  loopOn: false, uiTimer: null, liveHr: null, micCalibrated: false,
  abort: false, answerResolve: null, sensorsStarting: null,
};

/* ---------- small helpers ---------- */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (v, dp = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : '–');
function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function loadLast() { try { return JSON.parse(localStorage.getItem('ld.lastResults.v1')); } catch { return null; } }
function saveLast(r) { try { localStorage.setItem('ld.lastResults.v1', JSON.stringify(r)); } catch { /* ignore */ } }

/* ---------- navigation ---------- */
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
  const slot = $(`#${id} .sensor-slot`);
  if (slot) slot.append($('#sensor'));
  if (id === 'home') renderHome();
  if (id === 'questions') renderQuestions();
  if (id === 'setup') enterSetup();
  if (id !== 'setup' && id !== 'test') stopSensors();
  window.scrollTo(0, 0);
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && !go.disabled) { if (S.answerResolve) stopTest(); show(go.dataset.go); }
});

/* ---------- home ---------- */
function counts() {
  const b = questions.filter((q) => q.type === 'baseline').length;
  return { b, t: questions.length - b };
}
function renderHome() {
  const { b, t } = counts();
  $('#home-count').textContent = `${questions.length} questions: ${b} baseline, ${t} test.`;
  $('#btn-last').hidden = !lastResults;
}
$('#btn-last').onclick = () => { renderResults(lastResults); show('results'); };

/* ---------- question manager ---------- */
function renderQuestions() {
  const { b, t } = counts();
  $('#q-counts').textContent = `${b} baseline · ${t} test` + (b < MIN_BASELINE ? `  (add ${MIN_BASELINE - b} more baseline)` : '') + (t < 1 ? '  (add at least 1 test question)' : '');
  $('#btn-ready').disabled = b < MIN_BASELINE || t < 1;
  const ul = $('#qlist');
  ul.replaceChildren(...questions.map((q, i) => {
    if (q.id === editingId) {
      const ta = h('textarea', { rows: 2, maxlength: 200 }); ta.value = q.text;
      const sel = h('select', {},
        h('option', { value: 'test', selected: q.type === 'test' }, 'Test question'),
        h('option', { value: 'baseline', selected: q.type === 'baseline' }, 'Baseline (answer truthfully)'));
      return h('li', {}, h('div', { class: 'edit' }, ta, h('div', { class: 'row' }, sel,
        h('button', { class: 'btn primary small', onclick: () => {
          if (!ta.value.trim()) return;
          q.text = ta.value.trim(); q.type = sel.value; editingId = null; commit();
        } }, 'Save'),
        h('button', { class: 'btn ghost small', onclick: () => { editingId = null; renderQuestions(); } }, 'Cancel'))));
    }
    return h('li', {},
      h('span', { class: `badge ${q.type}` }, q.type),
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
  if (SIM) return;
  if (S.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser can only use the camera on a secure page. Open the app at http://localhost or an https:// address.');
  }
  const video = $('#video');
  const vc = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  let hasMic = true;
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: vc, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
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
  const gen = (S.loopGen = (S.loopGen || 0) + 1);
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
      while (S.frames.length && S.frames[0].t < now - 90000) S.frames.shift();
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
  const video = $('#video');
  video.srcObject = null;
  setVidMsg(SIM ? 'Simulation mode: no camera' : 'Camera off');
  const o = $('#overlay'); o.getContext('2d').clearRect(0, 0, o.width, o.height);
}

function liveStatus() {
  if (SIM) return { face: 1, bright: 140, hr: { bpm: 74 + Math.random() * 3, quality: 0.8 }, blinks: 0 };
  const now = performance.now();
  const recent = S.frames.filter((f) => f.t > now - 1000);
  const faces = recent.filter((f) => f.face);
  const face = recent.length ? faces.length / recent.length : 0;
  const bright = mean(faces.map((f) => f.brightness));
  const hr = S.rppg.estimate(now, 10);
  let blinks = 0, prev = false;
  for (const f of S.frames) if (f.face && f.t > now - 60000) { const b = f.blink > 0.45; if (b && !prev) blinks++; prev = b; }
  return { face, bright, hr, blinks };
}

function updateLive() {
  const st = liveStatus();
  S.liveHr = st.hr;
  $('#live-hr').textContent = st.hr && st.hr.quality > 0.2 ? Math.round(st.hr.bpm) : '--';
  $('#live-blink').textContent = st.blinks;
  $('#live-mic').style.width = `${Math.min(100, (S.voice.level / (S.voice.threshold * 3)) * 100)}%`;
  const q = 0.6 * st.face + 0.4 * (st.hr?.quality || 0);
  const light = $('#q-light');
  light.className = `light ${q > 0.75 ? 'good' : q > 0.45 ? 'fair' : 'poor'}`;
  $('#live-q').textContent = q > 0.75 ? 'Good signal' : q > 0.45 ? 'Fair signal' : 'Poor signal';

  if (!$('#setup').hidden) {
    setCheck('ck-face', st.face > 0.7 ? 'ok' : st.face > 0.3 ? 'mid' : 'bad');
    const b = st.bright;
    setCheck('ck-light', b == null ? '' : b < 60 || b > 225 ? 'bad' : b < 85 || b > 205 ? 'mid' : 'ok',
      b == null ? 'Lighting' : b < 60 ? 'Lighting: too dark' : b > 225 ? 'Lighting: too bright' : 'Lighting');
    const hq = st.hr?.quality || 0;
    setCheck('ck-hr', hq > 0.45 ? 'ok' : hq > 0.2 ? 'mid' : 'bad', hq > 0.45 ? 'Heart rate signal' : 'Heart rate: hold still…');
    setCheck('ck-mic', SIM || S.micCalibrated ? 'ok' : S.voice.ready ? 'mid' : 'bad', SIM || S.voice.ready ? 'Microphone' : 'Microphone: off');
    $('#btn-begin').disabled = !(SIM || st.face > 0.7);
    if (!SIM && st.face > 0.7 && hq <= 0.45 && !$('#setup-msg').dataset.busy) {
      setMsg('Heart rate needs ~10 s of stillness to lock on. You can start anyway; it will just count for less.');
    }
  }
}

function setVidMsg(t) {
  const el = $('#vid-empty');
  el.textContent = t;
  el.hidden = false;
}

function setCheck(id, cls, label) {
  const li = $(`#${id}`);
  li.className = cls;
  if (label) li.lastChild.textContent = label;
}
function setMsg(t) {
  const m = $('#setup-msg');
  m.textContent = t;
  m.dataset.busy = t && t.endsWith('…') ? '1' : '';
}

async function enterSetup() {
  $('#btn-begin').disabled = true;
  ['ck-cam', 'ck-face', 'ck-light', 'ck-hr', 'ck-mic'].forEach((id) => setCheck(id, ''));
  if (counts().b < MIN_BASELINE) {
    setMsg(`You need at least ${MIN_BASELINE} baseline questions. Add more in "Edit questions".`);
    return;
  }
  if (SIM) setMsg('Simulation mode: no camera or mic is used, sensor data is made up.');
  clearInterval(S.uiTimer);
  S.uiTimer = setInterval(updateLive, 500);
  try {
    S.sensorsStarting = startSensors();
    await S.sensorsStarting;
    if (SIM) ['ck-cam', 'ck-face', 'ck-light', 'ck-hr', 'ck-mic'].forEach((id) => setCheck(id, 'ok'));
  } catch (err) {
    console.error(err);
    setCheck('ck-cam', 'bad');
    const blocked = err.name === 'NotAllowedError';
    setVidMsg(blocked ? 'Camera blocked' : 'Camera not available');
    setMsg(blocked
      ? 'Camera permission was blocked. Click the camera icon in the address bar, allow camera and microphone, then reload. (The Claude app\'s built-in browser can\'t use the camera: open this page in Chrome or Edge.)'
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

function stopTest() {
  S.abort = true;
  S.answerResolve?.('none');
}

function waitAnswer(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done('none'), ms);
    function done(a) { clearTimeout(timer); S.answerResolve = null; resolve(a); }
    S.answerResolve = done;
  });
}

function setStage({ kind = '', text = '', hint = '', big = false, answers = false }) {
  $('#t-kind').textContent = kind;
  const t = $('#t-text');
  t.textContent = text;
  t.classList.toggle('big', big);
  $('#t-hint').textContent = hint;
  $('#t-answers').style.visibility = answers ? 'visible' : 'hidden';
}

async function runTest() {
  const list = questions.slice();
  S.abort = false;
  show('test');
  const records = [];
  for (let i = 0; i < list.length; i++) {
    if (S.abort) return;
    const q = list[i];
    $('#t-progress').textContent = `Question ${i + 1} of ${list.length}`;
    setStage({ kind: 'Get ready', text: '+', big: true });
    await sleep(READY_MS);
    if (S.abort) return;

    const t0 = performance.now();
    setStage({
      kind: q.type === 'baseline' ? 'Baseline · answer truthfully' : 'Question',
      text: q.text,
      hint: 'Say your answer out loud, then tap it (or press Y / N).',
      answers: true,
    });
    const answer = await waitAnswer(ANSWER_TIMEOUT_MS);
    if (S.abort) return;
    const tAns = performance.now();

    for (let s = HOLD_SEC; s > 0; s--) {
      setStage({ kind: 'Hold still', text: String(s), big: true, hint: 'Keep looking at the screen and breathe normally.' });
      await sleep(1000);
      if (S.abort) return;
    }
    const t1 = performance.now();
    records.push({
      id: q.id, type: q.type, text: q.text, answer,
      features: SIM ? simFeatures(q, tAns - t0) : extract(q, t0, tAns, t1),
    });
  }
  const res = computeResults(records);
  res.sim = SIM;
  res.date = new Date().toISOString();
  lastResults = res;
  saveLast(res);
  renderResults(res);
  show('results');
}

// Per-question measurements from the sensor logs
function extract(q, t0, tAns, t1) {
  const fr = S.frames.filter((f) => f.t >= t0 && f.t <= t1);
  const faces = fr.filter((f) => f.face);
  const dur = (t1 - t0) / 1000;
  const faceFrac = fr.length ? faces.length / fr.length : 0;
  const readAdj = 0.15 * q.text.split(/\s+/).length; // longer questions take longer to read

  let blinks = 0, prev = false;
  for (const f of faces) { const b = f.blink > 0.45; if (b && !prev) blinks++; prev = b; }

  let gaze = 0;
  for (let i = 1; i < faces.length; i++) gaze += Math.abs(faces[i].gazeX - faces[i - 1].gazeX) + Math.abs(faces[i].gazeY - faces[i - 1].gazeY);

  let headMotion = null;
  if (faces.length > 10) {
    const fw = mean(faces.map((f) => f.faceW)) || 1;
    const mx = mean(faces.map((f) => f.noseX)), my = mean(faces.map((f) => f.noseY));
    headMotion = Math.sqrt(mean(faces.map((f) => ((f.noseX - mx) ** 2 + (f.noseY - my) ** 2) / fw ** 2)));
  }

  const hr = S.rppg.estimate(t1, 10);
  const v = S.voice.ready ? S.voice.window(t0, tAns + 1500) : null;
  const enough = faces.length > 10;
  const hrQuality = hr?.quality || 0;
  const voiceLatency = v?.onset != null ? v.onset - readAdj : null;

  return {
    responseTime: tAns - t0 < ANSWER_TIMEOUT_MS - 50 ? (tAns - t0) / 1000 - readAdj : null,
    voiceLatency,
    pitch: v?.pitchMean ?? null,
    hr: hr?.bpm ?? null,
    rmssd: hr?.rmssd ?? null,
    hrQuality,
    tension: enough ? mean(faces.map((f) => f.tension)) : null,
    blinkRate: enough ? blinks / (dur / 60) : null,
    gazeMove: enough ? gaze / dur : null,
    headMotion,
    faceFrac,
    quality: 0.5 * faceFrac + 0.35 * hrQuality + 0.15 * (voiceLatency != null ? 1 : 0),
  };
}

// Fake data for ?sim=1: test questions are randomly "lies" with raised stress signals
function simFeatures(q, rtMs) {
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / Math.sqrt(0.5); };
  const lie = q.type === 'test' && Math.random() < 0.5;
  const k = lie ? 1.6 : 0;
  return {
    responseTime: 1.2 + 0.3 * g() + 0.5 * k,
    voiceLatency: 0.9 + 0.25 * g() + 0.4 * k,
    pitch: 150 + 8 * g() + 10 * k,
    hr: 75 + 3 * g() + 5 * k,
    rmssd: 40 + 8 * g() - 8 * k,
    hrQuality: 0.8,
    tension: 0.12 + 0.03 * g() + 0.04 * k,
    blinkRate: 18 + 5 * g() + 4 * k,
    gazeMove: 0.6 + 0.1 * g() + 0.1 * k,
    headMotion: 0.02 + 0.005 * g() + 0.006 * k,
    faceFrac: 1,
    quality: 0.85,
    simLie: lie,
  };
}

/* ---------- results ---------- */
function renderResults(res) {
  const body = $('#r-body');
  body.replaceChildren();
  if (!res) return;
  if (res.error) {
    body.append(h('div', { class: 'warn' }, res.error));
    return;
  }
  const tests = res.items.filter((r) => r.type === 'test');
  const nLie = tests.filter((r) => r.verdict === 'lie').length;
  const nTruth = tests.filter((r) => r.verdict === 'truth').length;

  if (res.sim) body.append(h('p', { class: 'sim' }, 'Simulated data (?sim=1). No real sensors were used.'));
  body.append(
    h('div', { class: 'summary' },
      stat(fmt(res.baseMean, 2), 'Baseline stress score'),
      stat(fmt(res.threshold, 2), 'Lie threshold'),
      stat(String(nTruth), 'Marked Truth'),
      stat(String(nLie), 'Marked Lie')),
    h('p', { class: 'muted small' }, 'Stress score 0 ≈ your baseline average. Above the threshold (baseline + 1 normal spread) = Lie, below = Truth. Confidence drops when the answer is close to the threshold or the signal was poor.'),
    h('div', { class: 'card chart' }, chart(res)),
    h('h2', {}, 'Test questions'),
    ...tests.map((r) => resultCard(r, res)),
    h('details', { class: 'card' },
      h('summary', {}, `Baseline questions (${res.items.length - tests.length})`),
      ...res.items.filter((r) => r.type === 'baseline').map((r) =>
        h('p', { class: 'meta' }, `${r.text} · answered ${r.answer} · score ${fmt(r.score, 2)}`))),
    h('div', { class: 'warn small' }, 'Experimental. These signals measure stress and effort, not honesty. Do not use the verdicts to judge or make decisions about anyone.'),
  );
}
function stat(v, label) { return h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, label)); }

function resultCard(r, res) {
  const q = r.features.quality ?? 0;
  const qLabel = q > 0.75 ? 'good' : q > 0.45 ? 'fair' : 'poor';
  const verdictText = r.verdict === 'lie' ? 'LIE' : r.verdict === 'truth' ? 'TRUTH' : 'NO DATA';
  return h('div', { class: `result ${r.verdict}` },
    h('div', { class: 'head' },
      h('div', { class: 'qq' }, r.text),
      h('span', { class: `pill ${r.verdict}` }, r.confidence != null ? `${verdictText} · ${r.confidence}%` : verdictText)),
    h('div', { class: 'meta' },
      `Answered: ${r.answer === 'none' ? 'no answer' : r.answer} · stress score ${fmt(r.score, 2)} (threshold ${fmt(res.threshold, 2)}) · signal ${qLabel}` +
      (r.features.simLie != null ? ` · sim was ${r.features.simLie ? 'a lie' : 'true'}` : '')),
    r.contribs?.length ? h('details', {},
      h('summary', {}, 'What drove this'),
      h('table', {},
        h('tr', {}, h('th', {}, 'Signal'), h('th', {}, 'This answer'), h('th', {}, 'Baseline'), h('th', {}, 'vs normal')),
        ...r.contribs.slice(0, 6).map((c) => h('tr', {},
          h('td', {}, c.label),
          h('td', {}, `${fmt(c.value, c.dp)} ${c.unit}`),
          h('td', {}, `${fmt(c.baseline, c.dp)} ${c.unit}`),
          h('td', { class: c.z > 0.5 ? 'up' : c.z < -0.5 ? 'down' : '' }, `${c.z >= 0 ? '+' : ''}${c.z.toFixed(1)}× ${c.z >= 0 ? 'more stress' : 'calmer'}`))))) : null);
}

function chart(res) {
  const NS = 'http://www.w3.org/2000/svg';
  const items = res.items.filter((r) => typeof r.score === 'number');
  const W = 600, rowH = 26, top = 24, left = 34, right = 16;
  const Hh = top + items.length * rowH + 8;
  const lim = Math.max(2, ...items.map((r) => Math.abs(r.score)), Math.abs(res.threshold) + 0.5);
  const x = (v) => left + ((v + lim) / (2 * lim)) * (W - left - right);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Stress score per question compared with the lie threshold');
  const el = (tag, a, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  const css = getComputedStyle(document.documentElement);
  const c = (n) => css.getPropertyValue(n).trim();
  el('line', { x1: x(0), x2: x(0), y1: top - 6, y2: Hh, stroke: c('--line') });
  el('text', { x: x(0), y: 12, fill: c('--muted'), 'font-size': 11, 'text-anchor': 'middle' }, 'baseline');
  items.forEach((r, i) => {
    const y = top + i * rowH;
    const col = r.verdict === 'lie' ? c('--lie') : r.verdict === 'truth' ? c('--truth') : c('--muted');
    const x0 = Math.min(x(0), x(r.score)), w = Math.max(2, Math.abs(x(r.score) - x(0)));
    el('text', { x: 4, y: y + 16, fill: c('--muted'), 'font-size': 12 }, String(res.items.indexOf(r) + 1));
    el('rect', { x: x0, y: y + 5, width: w, height: rowH - 10, rx: 3, fill: col, opacity: r.type === 'baseline' ? 0.45 : 0.9 });
  });
  el('line', { x1: x(res.threshold), x2: x(res.threshold), y1: top - 6, y2: Hh, stroke: c('--lie'), 'stroke-dasharray': '4 4' });
  el('text', { x: x(res.threshold) + 4, y: 12, fill: c('--lie'), 'font-size': 11 }, 'lie threshold');
  return svg;
}

$('#r-csv').onclick = () => {
  if (!lastResults?.items) return;
  const cols = ['n', 'type', 'question', 'answer', 'verdict', 'confidence', 'score', 'quality', ...FEATURES.map((f) => f.key), 'hrQuality'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = lastResults.items.map((r, i) => [i + 1, r.type, r.text, r.answer, r.verdict, r.confidence ?? '', r.score ?? '', r.features.quality ?? '',
    ...FEATURES.map((f) => r.features[f.key] ?? ''), r.features.hrQuality ?? ''].map(esc).join(','));
  download('truth-meter-results.csv', [cols.join(','), ...rows].join('\n'), 'text/csv');
};

$('#sim-banner').hidden = !SIM;
show('home');
