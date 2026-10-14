import crypto from 'crypto';
import { readJson, updateJson } from './store.js';
import { addDays, dateStr } from './utils.js';

// ---------- Карточки с интервальным повторением (система коробок Лейтнера) ----------

const CARDS_FILE = 'cards.json';
// Через сколько дней показывать карточку снова, в зависимости от «коробки»
export const INTERVALS = [1, 2, 4, 8, 16, 32];

export async function addCards(cards, noteBase) {
  if (!cards.length) return 0;
  const today = dateStr();
  await updateJson(CARDS_FILE, { cards: [] }, (data) => {
    for (const card of cards) {
      data.cards.push({
        id: crypto.randomBytes(4).toString('hex'),
        q: card.q.trim(),
        a: card.a.trim(),
        noteBase,
        box: 0,
        due: addDays(today, 1),
        created: today
      });
    }
  });
  return cards.length;
}

export async function dueCards(limit = 5, today = dateStr()) {
  const data = await readJson(CARDS_FILE, { cards: [] });
  return data.cards.filter((c) => c.due <= today).sort((a, b) => a.due.localeCompare(b.due)).slice(0, limit);
}

export async function countDue(today = dateStr()) {
  const data = await readJson(CARDS_FILE, { cards: [] });
  return data.cards.filter((c) => c.due <= today).length;
}

export async function getCard(id) {
  const data = await readJson(CARDS_FILE, { cards: [] });
  return data.cards.find((c) => c.id === id) || null;
}

// known=true — карточка уходит в следующую коробку, false — возвращается в первую
export async function answerCard(id, known, today = dateStr()) {
  return updateJson(CARDS_FILE, { cards: [] }, (data) => {
    const card = data.cards.find((c) => c.id === id);
    if (!card) return null;
    card.box = known ? Math.min(card.box + 1, INTERVALS.length - 1) : 0;
    const days = INTERVALS[card.box];
    card.due = addDays(today, days);
    return { days, box: card.box };
  });
}

// ---------- Журнал учёбы ----------

const STUDY_FILE = 'study.json';

export async function addStudy(topic, hours, today = dateStr()) {
  await updateJson(STUDY_FILE, { log: [] }, (data) => {
    data.log.push({ date: today, topic, hours });
    if (data.log.length > 2000) data.log = data.log.slice(-2000);
  });
}

export async function studyTotals(days = 7, today = dateStr()) {
  const data = await readJson(STUDY_FILE, { log: [] });
  const since = addDays(today, -(days - 1));
  const byTopic = new Map();
  let total = 0;
  for (const entry of data.log) {
    if (entry.date < since || entry.date > today) continue;
    total += entry.hours;
    byTopic.set(entry.topic, (byTopic.get(entry.topic) || 0) + entry.hours);
  }
  const round = (n) => Math.round(n * 10) / 10;
  return {
    total: round(total),
    lines: [...byTopic.entries()].map(([topic, h]) => `${topic}: ${round(h)} ч`)
  };
}

// Разбор «/study Angular сигналы 1.5»
export function parseStudyArgs(text = '') {
  const match = String(text).trim().match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(?:ч|h|час\p{L}*)?$/iu);
  if (!match || !match[1].trim()) return null;
  const hours = Number(match[2].replace(',', '.'));
  if (!(hours > 0) || hours > 24) return null;
  return { topic: match[1].trim(), hours };
}

// ---------- Служебное состояние (например, когда последний раз слали напоминание) ----------

const STATE_FILE = 'state.json';

export async function getState() {
  return readJson(STATE_FILE, {});
}

export async function setState(patch) {
  await updateJson(STATE_FILE, {}, (data) => {
    Object.assign(data, patch);
  });
}

// ---------- Квиз (хранится только в памяти) ----------

const QUIZ_TTL_MS = 2 * 60 * 60 * 1000;
const quizzes = new Map();

export function startQuiz(chatId, questions, topic) {
  quizzes.set(chatId, { questions, index: 0, score: 0, topic, ts: Date.now() });
  return quizzes.get(chatId);
}

export function getQuiz(chatId) {
  const session = quizzes.get(chatId);
  if (!session) return null;
  if (Date.now() - session.ts > QUIZ_TTL_MS) {
    quizzes.delete(chatId);
    return null;
  }
  return session;
}

export function touchQuiz(session) {
  session.ts = Date.now();
}

export function endQuiz(chatId) {
  quizzes.delete(chatId);
}
