import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// Маленькое хранилище JSON-файлов в папке data/.
// Все изменения одного файла идут строго по очереди, запись атомарная,
// поэтому данные не портятся, даже если бот обрабатывает несколько сообщений сразу.

const chains = new Map();

function filePath(name) {
  return path.join(config.dataDir, name);
}

export async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath(name), 'utf-8'));
  } catch {
    return structuredClone(fallback);
  }
}

async function atomicWrite(name, data) {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const target = filePath(name);
  const tmp = `${target}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.promises.rename(tmp, target);
}

// mutate получает данные, меняет их «на месте» и может вернуть результат.
export function updateJson(name, fallback, mutate) {
  const prev = chains.get(name) || Promise.resolve();
  const next = prev.then(async () => {
    const data = await readJson(name, fallback);
    const result = await mutate(data);
    await atomicWrite(name, data);
    return result;
  });
  chains.set(name, next.catch(() => {}));
  return next;
}
