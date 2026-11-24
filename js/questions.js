// Question list: stored in this browser (localStorage), editable in the "Questions" screen.
// type "baseline" = the person answers truthfully (used to learn their normal stress level)
// type "test"     = the question being checked

const KEY = 'ld.questions.v1';

export const DEFAULT_QUESTIONS = [
  { id: 'b1', type: 'baseline', text: 'Are you sitting down right now?' },
  { id: 'b2', type: 'baseline', text: 'Are you looking at a screen right now?' },
  { id: 't1', type: 'test', text: 'Have you ever lied to get out of plans with a friend?' },
  { id: 'b3', type: 'baseline', text: 'Is the sky blue on a clear day?' },
  { id: 't2', type: 'test', text: 'Did you have breakfast today?' },
  { id: 'b4', type: 'baseline', text: 'Do you know what month it is?' },
  { id: 't3', type: 'test', text: 'Have you ever taken credit for something you did not do?' },
  { id: 'b5', type: 'baseline', text: 'Have you ever drunk water?' },
  { id: 't4', type: 'test', text: 'Have you checked your phone in the last ten minutes?' },
];

export function newId() {
  return Math.random().toString(36).slice(2, 9);
}

export function loadQuestions() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(saved) && saved.length) return saved.filter(isValid);
  } catch { /* storage blocked or corrupt: fall back to defaults */ }
  return DEFAULT_QUESTIONS.map((q) => ({ ...q }));
}

export function saveQuestions(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function isValid(q) {
  return q && typeof q.text === 'string' && q.text.trim() && (q.type === 'baseline' || q.type === 'test');
}

export function parseImport(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(arr)) throw new Error('Expected a list of questions');
  const list = arr.filter(isValid).map((q) => ({ id: newId(), type: q.type, text: q.text.trim() }));
  if (!list.length) throw new Error('No valid questions found');
  return list;
}
