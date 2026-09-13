import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const INBOX_PATH = process.env.OBSIDIAN_INBOX_PATH;

/**
 * Создает новую заметку в формате Markdown в папке Inbox
 */
export async function saveNoteToVault(title, content, tags = []) {
  await fs.mkdir(INBOX_PATH, { recursive: true });

  const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'Новая заметка';
  const timestamp = new Date().toISOString().split('T')[0];
  const fileName = `${timestamp}_${cleanTitle}.md`;
  const filePath = path.join(INBOX_PATH, fileName);

  const formattedTags = tags.map(t => `#${t.replace(/^#/, '')}`).join(' ');

  const fileContent = `---
date: ${new Date().toISOString()}
tags: [${tags.join(', ')}]
source: telegram-bot
---

# ${cleanTitle}

${content}

---
**Метки:** ${formattedTags}
`;

  await fs.writeFile(filePath, fileContent, 'utf-8');
  return fileName;
}

/**
 * Перемещает заметку из Inbox в указанную подпапку хранилища
 */
export async function moveNote(fileName, targetFolder) {
  // Определяем корневую директорию хранилища (на уровень выше Inbox)
  const vaultRoot = path.resolve(INBOX_PATH, '..');
  const sourcePath = path.join(INBOX_PATH, fileName);
  const targetDir = path.join(vaultRoot, targetFolder);
  const targetPath = path.join(targetDir, fileName);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.rename(sourcePath, targetPath);
  return targetPath;
}

/**
 * Удаляет заметку из Inbox
 */
export async function deleteNote(fileName) {
  const filePath = path.join(INBOX_PATH, fileName);
  await fs.unlink(filePath);
}