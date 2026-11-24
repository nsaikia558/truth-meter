// Question list + test settings, stored in this browser (localStorage), set by the admin first.
// type "truth" = practice: the person answers truthfully   (old name "baseline" still accepted)
// type "lie"   = practice: the person LIES on purpose (calibration)
// type "test"  = the question being checked

const KEY = 'ld.questions.v1';
const SKEY = 'ld.settings.v1';

export const TYPES = {
  truth: { badge: 'truth', label: 'Practice: tell the truth' },
  lie: { badge: 'lie', label: 'Practice: lie on purpose' },
  test: { badge: 'test', label: 'Test question' },
};

export const DEFAULT_QUESTIONS = [
  { id: 'p1', type: 'truth', text: 'Is the sky blue on a clear day?' },
  { id: 'p2', type: 'lie', text: 'Is snow cold?' },
  { id: 'p3', type: 'truth', text: 'Do fish live in water?' },
  { id: 'p4', type: 'lie', text: 'Do you have a phone or computer in front of you?' },
  { id: 'p5', type: 'truth', text: 'Are you awake right now?' },
  { id: 'p6', type: 'lie', text: 'Is fire hot?' },
  { id: 'p7', type: 'truth', text: 'Is a week seven days long?' },
  { id: 't1', type: 'test', text: 'Have you ever lied to get out of plans with a friend?' },
  { id: 't2', type: 'test', text: 'Did you have breakfast today?' },
  { id: 't3', type: 'test', text: 'Have you checked your phone in the last ten minutes?' },
];

export const DEFAULT_SETTINGS = { rounds: 3 };

export function newId() {
  return Math.random().toString(36).slice(2, 9);
}

function normalise(q) {
  return { ...q, type: q.type === 'baseline' ? 'truth' : q.type };
}

export function isValid(q) {
  return q && typeof q.text === 'string' && q.text.trim() && ['truth', 'lie', 'test', 'baseline'].includes(q.type);
}

export function loadQuestions() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(saved) && saved.length) {
      const list = saved.filter(isValid).map(normalise);
      // Lists saved before "lie on purpose" existed get the example practice lies added
      if (!list.some((q) => q.type === 'lie')) {
        list.unshift(...DEFAULT_QUESTIONS.filter((q) => q.type === 'lie').map((q) => ({ ...q, id: newId() })));
      }
      return list;
    }
  } catch { /* storage blocked or corrupt: fall back to defaults */ }
  return DEFAULT_QUESTIONS.map((q) => ({ ...q }));
}

export function saveQuestions(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SKEY)) }; } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function parseImport(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(arr)) throw new Error('Expected a list of questions');
  const list = arr.filter(isValid).map((q) => normalise({ id: newId(), type: q.type, text: q.text.trim() }));
  if (!list.length) throw new Error('No valid questions found');
  return list;
}
