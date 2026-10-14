import { saveNoteToVault } from './obsidian.js';
import { registerFile } from './registry.js';
import { existingBaseNames } from './vault.js';
import { addCards } from './study.js';
import { uniqueTags } from './utils.js';

// Берёт готовый ответ модели и превращает в заметку в хранилище:
// проверяет связи, добавляет источник и карточки, регистрирует кнопки.
export async function saveProcessed(
  aiResult,
  { type = 'note', source = '', extraTags = [], folder } = {}
) {
  const tags = uniqueTags([...(aiResult.tags || []), ...extraTags]);
  let body = aiResult.content;

  if (source) {
    body = `> [!info] Источник: ${source}\n\n${body}`;
  }

  // Связи — только на реально существующие заметки (никаких «мёртвых» ссылок)
  if (aiResult.related?.length) {
    const known = await existingBaseNames();
    const links = [...new Set(aiResult.related)]
      .filter((name) => known.has(name))
      .slice(0, 5)
      .map((name) => `- [[${name}|${known.get(name).title}]]`);
    if (links.length) body += `\n\n## Связанные заметки\n${links.join('\n')}`;
  }

  // Карточки: и в тексте (формат «вопрос::ответ»), и в очереди повторения бота
  const cards = (aiResult.cards || []).filter((c) => c.q && c.a);
  if (cards.length) {
    const oneLine = (s) => s.replace(/\s*\n+\s*/g, ' ').trim();
    body += `\n\n## Карточки\n${cards.map((c) => `${oneLine(c.q)}::${oneLine(c.a)}`).join('\n')}`;
  }

  const { fileName, folder: savedFolder } = await saveNoteToVault({
    title: aiResult.title,
    content: body,
    tags,
    type,
    source,
    folder
  });

  const base = fileName.replace(/\.md$/i, '');
  if (cards.length) await addCards(cards, base);

  const shortId = await registerFile({ fileName, title: aiResult.title, tags });
  return { fileName, folder: savedFolder, title: aiResult.title, tags, shortId, base, cardsCount: cards.length };
}
