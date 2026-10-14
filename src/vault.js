import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { addDays, dateStr } from './utils.js';

// Чтение хранилища: список заметок, поиск, задачи, материалы для обзоров.

const MAX_FILES = 3000;
const SKIP_DIRS = new Set(['node_modules']);

const STOP_WORDS = new Set([
  'это', 'что', 'как', 'для', 'при', 'или', 'про', 'так', 'его', 'она', 'они', 'мне', 'нам',
  'где', 'кто', 'чем', 'уже', 'все', 'вся', 'был', 'была', 'есть', 'ещё', 'еще', 'мой', 'моя',
  'the', 'and', 'for', 'with', 'what', 'how', 'why', 'are', 'was'
]);

function root() {
  return config.vaultPath;
}

async function walk(dirRel = '', acc = []) {
  if (acc.length >= MAX_FILES) return acc;
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(root(), dirRel), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(rel, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(rel);
    }
    if (acc.length >= MAX_FILES) break;
  }
  return acc;
}

export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = { title: '', tags: [], created: '' };
  if (!match) return meta;
  const block = match[1];

  const titleMatch = block.match(/^title:\s*(.+)$/m);
  if (titleMatch) {
    const raw = titleMatch[1].trim();
    try {
      meta.title = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^'|'$/g, '');
    } catch {
      meta.title = raw;
    }
  }

  const createdMatch = block.match(/^created:\s*(.+)$/m);
  if (createdMatch) meta.created = createdMatch[1].trim();

  const inline = block.match(/^tags:\s*\[(.*)\]\s*$/m);
  if (inline) {
    meta.tags = inline[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  } else {
    const list = block.match(/^tags:\s*\r?\n((?:\s+-\s+.+\r?\n?)+)/m);
    if (list) {
      meta.tags = list[1].split(/\r?\n/).map((l) => l.replace(/^\s+-\s+/, '').trim()).filter(Boolean);
    }
  }
  return meta;
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

async function readNote(rel) {
  const full = path.join(root(), rel);
  const [text, stat] = await Promise.all([
    fs.promises.readFile(full, 'utf-8'),
    fs.promises.stat(full)
  ]);
  const meta = parseFrontmatter(text);
  const base = path.basename(rel, '.md');
  const h1 = stripFrontmatter(text).match(/^#\s+(.+)$/m);
  return {
    rel,
    base,
    folder: rel.includes('/') ? rel.split('/')[0] : '',
    title: meta.title || (h1 ? h1[1].trim() : base),
    tags: meta.tags,
    mtimeMs: stat.mtimeMs,
    text
  };
}

export async function listNotes() {
  const files = await walk();
  const notes = [];
  for (const rel of files) {
    try {
      notes.push(await readNote(rel));
    } catch {
      // файл мог исчезнуть между обходом и чтением — пропускаем
    }
  }
  return notes;
}

// Короткий список имён заметок для подсказки модели (чтобы связи вели на настоящие заметки)
export async function getNotesIndex(max = 250) {
  const notes = (await listNotes())
    .filter((n) => n.folder !== 'Daily' && n.folder !== 'Обзоры')
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, max);
  return notes.map((n) => `- ${n.base}${n.tags.length ? ` [${n.tags.join(', ')}]` : ''}`).join('\n');
}

export async function existingBaseNames() {
  const notes = await listNotes();
  return new Map(notes.map((n) => [n.base, n]));
}

function stems(query) {
  const words = String(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...new Set(words.map((w) => w.slice(0, 5)))];
}

export async function searchNotes(query, limit = 8) {
  const wanted = stems(query);
  if (!wanted.length) return [];

  const notes = await listNotes();
  const scored = [];
  for (const note of notes) {
    const title = note.title.toLowerCase();
    const tags = note.tags.join(' ').toLowerCase();
    const body = stripFrontmatter(note.text).toLowerCase();
    let score = 0;
    for (const stem of wanted) {
      if (title.includes(stem)) score += 5;
      if (tags.includes(stem)) score += 3;
      let count = 0;
      let idx = body.indexOf(stem);
      while (idx !== -1 && count < 10) {
        count++;
        idx = body.indexOf(stem, idx + stem.length);
      }
      score += count;
    }
    if (score > 0) scored.push({ ...note, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function noteBody(note, maxChars = 6000) {
  return stripFrontmatter(note.text).trim().slice(0, maxChars);
}

// Заметки для квиза: по теме или самые свежие учебные
const LEARN_TAGS = ['learning', 'learn', 'video', 'youtube', 'article', 'учеба', 'учёба', 'обучение'];

export async function notesForQuiz(topic, limit = 5) {
  if (topic) return searchNotes(topic, limit);
  const notes = (await listNotes()).filter((n) => n.folder !== 'Daily' && n.folder !== 'Обзоры');
  const study = notes.filter(
    (n) => n.folder === 'Учеба' || n.tags.some((t) => LEARN_TAGS.includes(t.toLowerCase()))
  );
  const pool = study.length ? study : notes;
  return pool.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// Все незакрытые задачи (- [ ] ...) из хранилища
export async function collectOpenTasks() {
  const notes = await listNotes();
  const tasks = [];
  for (const note of notes) {
    if (note.folder === 'Обзоры') continue;
    for (const line of stripFrontmatter(note.text).split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s+\[ \]\s+(.+)$/);
      if (m) tasks.push({ rel: note.rel, base: note.base, title: note.title, text: m[1].trim() });
    }
  }
  return tasks;
}

// Заметки в Inbox старше N дней
export async function staleInboxNotes(days = 3) {
  const inboxDir = path.join(root(), 'Inbox');
  let names = [];
  try {
    names = (await fs.promises.readdir(inboxDir)).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch {
    return { stale: [], total: 0 };
  }
  const limit = Date.now() - days * 24 * 60 * 60 * 1000;
  const stale = [];
  for (const name of names) {
    try {
      const stat = await fs.promises.stat(path.join(inboxDir, name));
      if (stat.mtimeMs < limit) stale.push(name);
    } catch {
      // пропускаем
    }
  }
  return { stale, total: names.length };
}

// Материалы за последние N дней для недельного обзора
export async function weekMaterials(days = 7) {
  const today = dateStr();
  const dailyParts = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    try {
      const text = await fs.promises.readFile(path.join(root(), 'Daily', `${date}.md`), 'utf-8');
      dailyParts.push(`### ${date}\n${text.trim()}`);
    } catch {
      // за этот день записей нет
    }
  }

  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = (await listNotes())
    .filter((n) => n.folder !== 'Daily' && n.folder !== 'Обзоры' && n.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    daily: dailyParts.join('\n\n'),
    notes: recent.map((n) => ({
      base: n.base,
      title: n.title,
      tags: n.tags,
      folder: n.folder
    }))
  };
}
