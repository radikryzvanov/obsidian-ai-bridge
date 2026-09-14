import fs from 'fs';
import path from 'path';

function getTimestampPrefix() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  return `${year}-${month}-${day}_${hours}-${minutes}`;
}

export async function saveNoteToVault(title, content, tags = []) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const targetDir = path.join(vaultPath, 'Inbox');

  await fs.promises.mkdir(targetDir, { recursive: true });

  const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '').trim();
  const prefix = getTimestampPrefix();
  const fileName = `${prefix}_${cleanTitle}.md`;
  const filePath = path.join(targetDir, fileName);

  const formattedTags = tags.map(t => `  - ${t.replace(/^#/, '')}`).join('\n');
  const fileBody = `---
created: ${new Date().toISOString()}
tags:
${formattedTags}
---

# ${title}

${content}
`;

  await fs.promises.writeFile(filePath, fileBody, 'utf-8');
  return fileName;
}

export async function moveNote(fileName, targetFolder) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const sourcePath = path.join(vaultPath, 'Inbox', fileName);
  const targetDir = path.join(vaultPath, targetFolder);
  const targetPath = path.join(targetDir, fileName);

  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.rename(sourcePath, targetPath);
}

export async function deleteNote(fileName) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const filePath = path.join(vaultPath, 'Inbox', fileName);

  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

export async function appendToDailyNote(text) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const dailyDir = path.join(vaultPath, 'Daily');

  await fs.promises.mkdir(dailyDir, { recursive: true });

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const fileName = `${dateStr}.md`;
  const filePath = path.join(dailyDir, fileName);

  const entry = `\n- **${timeStr}** ${text.trim()}\n`;

  try {
    await fs.promises.access(filePath);
    await fs.promises.appendFile(filePath, entry, 'utf-8');
  } catch {
    const initialContent = `# Дневник на ${dateStr}\n${entry}`;
    await fs.promises.writeFile(filePath, initialContent, 'utf-8');
  }

  return { dateStr, timeStr, fileName };
}