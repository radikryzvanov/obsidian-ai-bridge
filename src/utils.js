// Мелкие общие функции: даты, экранирование, имена файлов, теги.

export class UserError extends Error {
  // Ошибка, текст которой можно показать пользователю как есть.
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

export const pad = (n) => String(n).padStart(2, '0');

export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function timeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function timestampPrefix(d = new Date()) {
  return `${dateStr(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

export function addDays(dateString, n) {
  const d = new Date(`${dateString}T12:00:00`);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

// Номер недели по ISO (для имён обзоров, например 2026-W42)
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Режет длинный текст на куски, которые влезают в одно сообщение Telegram
export function chunkText(text, max = 3800) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export function sanitizeTag(tag) {
  return String(tag)
    .replace(/^#+/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '');
}

export function uniqueTags(tags = []) {
  return [...new Set(tags.map(sanitizeTag).filter(Boolean))];
}

// Убирает символы, которые ломают имена файлов и ссылки Obsidian
export function cleanFileTitle(title) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || 'Без названия';
}

export function deriveTitle(text, words = 6) {
  const first = String(text).split('\n').find((l) => l.trim()) || '';
  return cleanFileTitle(first.split(/\s+/).slice(0, words).join(' '));
}

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
