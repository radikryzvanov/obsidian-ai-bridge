import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import {
  cleanFileTitle,
  dateStr,
  timeStr,
  timestampPrefix,
  uniqueTags
} from './utils.js';

export const INBOX = 'Inbox';
export const DAILY = 'Daily';
export const REVIEWS = 'Обзоры';
export const TRASH = '.trash'; // та же корзина, что использует сам Obsidian
export const MOVE_TARGETS = ['Учеба', 'Проекты'];

function vaultRoot() {
  if (!config.vaultPath) {
    throw new Error('Не задан OBSIDIAN_VAULT_PATH в файле .env');
  }
  return config.vaultPath;
}

export function vaultFile(...parts) {
  return path.join(vaultRoot(), ...parts);
}

// Записывает файл; если имя занято — добавляет -2, -3 и т.д. Ничего не перезаписывает.
async function writeUnique(dir, fileName, body) {
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? fileName : `${base}-${n}${ext}`;
    try {
      await fs.promises.writeFile(path.join(dir, candidate), body, { encoding: 'utf-8', flag: 'wx' });
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Не удалось подобрать свободное имя файла');
}

async function freeName(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? fileName : `${base}-${n}${ext}`;
    try {
      await fs.promises.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  throw new Error('Не удалось подобрать свободное имя файла');
}

// folder — куда класть заметку (по умолчанию Inbox).
// type: note | idea | task | learn | video | article | raw | review
export async function saveNoteToVault({
  title,
  content,
  tags = [],
  type = 'note',
  source = '',
  folder = INBOX
}) {
  const targetDir = vaultFile(folder);
  const cleanTitle = cleanFileTitle(title);
  const fileName = `${timestampPrefix()}_${cleanTitle}.md`;

  const cleanTags = uniqueTags(tags);
  const tagsBlock = cleanTags.length
    ? `tags:\n${cleanTags.map((t) => `  - ${t}`).join('\n')}`
    : 'tags: []';

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(String(title))}`,
    `created: ${new Date().toISOString()}`,
    `type: ${type}`,
    folder === INBOX ? 'status: inbox' : null,
    source ? `source: ${JSON.stringify(source)}` : null,
    tagsBlock,
    '---'
  ].filter(Boolean).join('\n');

  const body = `${frontmatter}\n\n# ${title}\n\n${content}\n`;
  const finalName = await writeUnique(targetDir, fileName, body);
  return { fileName: finalName, folder };
}

// Перемещает заметку из Inbox в разрешённую папку
export async function moveNote(fileName, targetFolder) {
  if (!MOVE_TARGETS.includes(targetFolder)) {
    throw new Error('Недопустимая папка назначения');
  }
  const safeName = path.basename(fileName);
  const sourcePath = vaultFile(INBOX, safeName);
  const targetDir = vaultFile(targetFolder);

  await fs.promises.mkdir(targetDir, { recursive: true });
  const finalName = await freeName(targetDir, safeName);
  await fs.promises.rename(sourcePath, path.join(targetDir, finalName));
  return finalName;
}

// «Удаление» = перенос в корзину Obsidian (.trash), чтобы можно было вернуть
export async function trashNote(fileName) {
  const safeName = path.basename(fileName);
  const sourcePath = vaultFile(INBOX, safeName);
  const trashDir = vaultFile(TRASH);

  try {
    await fs.promises.access(sourcePath);
  } catch {
    return; // файла уже нет — ничего делать не нужно
  }
  await fs.promises.mkdir(trashDir, { recursive: true });
  const finalName = await freeName(trashDir, safeName);
  await fs.promises.rename(sourcePath, path.join(trashDir, finalName));
}

// Запись в дневную заметку. Параллельные вызовы выстраиваются в очередь.
let dailyLock = Promise.resolve();

async function doAppendToDaily(text) {
  const dailyDir = vaultFile(DAILY);
  await fs.promises.mkdir(dailyDir, { recursive: true });

  const now = new Date();
  const date = dateStr(now);
  const time = timeStr(now);
  const fileName = `${date}.md`;
  const filePath = path.join(dailyDir, fileName);

  // Многострочный текст остаётся внутри одного пункта списка
  const lines = String(text).trim().split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const [first = '', ...rest] = lines;
  const entry = `\n- **${time}** ${first}${rest.map((l) => `\n    ${l}`).join('')}\n`;

  let exists = true;
  try {
    await fs.promises.access(filePath);
  } catch {
    exists = false;
  }

  if (exists) {
    await fs.promises.appendFile(filePath, entry, 'utf-8');
  } else {
    await fs.promises.writeFile(filePath, `# Дневник на ${date}\n${entry}`, 'utf-8');
  }

  return { dateStr: date, timeStr: time, fileName };
}

export function appendToDailyNote(text) {
  const run = dailyLock.then(() => doAppendToDaily(text));
  dailyLock = run.catch(() => {});
  return run;
}
