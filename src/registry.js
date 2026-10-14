import crypto from 'crypto';
import { readJson, updateJson } from './store.js';

// Реестр заметок для кнопок под сообщениями.
// Хранится на диске, поэтому кнопки работают и после перезапуска бота.

const FILE = 'registry.json';
const MAX_ITEMS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function registerFile({ fileName, title, tags = [] }) {
  const id = crypto.randomBytes(4).toString('hex');
  await updateJson(FILE, { items: {} }, (data) => {
    data.items[id] = { fileName, title, tags, ts: Date.now() };

    const now = Date.now();
    for (const [key, item] of Object.entries(data.items)) {
      if (now - item.ts > MAX_AGE_MS) delete data.items[key];
    }
    const entries = Object.entries(data.items).sort((a, b) => b[1].ts - a[1].ts);
    for (const [key] of entries.slice(MAX_ITEMS)) delete data.items[key];
  });
  return id;
}

export async function getFile(id) {
  const data = await readJson(FILE, { items: {} });
  return data.items[id] || null;
}

export async function removeFile(id) {
  await updateJson(FILE, { items: {} }, (data) => {
    delete data.items[id];
  });
}
