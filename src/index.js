import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import crypto from 'crypto';
import fs from 'fs';
import { processContent, processLargeMedia } from './ai.js';
import { saveNoteToVault, moveNote, deleteNote, appendToDailyNote } from './obsidian.js';
import { detectMediaUrl, fetchYouTubeTranscript, downloadAudioWithYtDlp } from './media.js';
 
console.log('⏳ Проверяю переменные окружения...');
 
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Ошибка: Не указан TELEGRAM_BOT_TOKEN в файле .env');
  process.exit(1);
}
 
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
 
const ALLOWED_ID = Number(process.env.ALLOWED_USER_ID);
const VAULT_NAME = 'Obsidian Vault';
 
const fileRegistry = new Map();
 
function registerFile(fileName, title, tags, rawContent = '') {
  const shortId = crypto.randomBytes(4).toString('hex');
  fileRegistry.set(shortId, { fileName, title, tags, rawContent });
  return shortId;
}
 
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
 
// Скачивает аудио через yt-dlp, отправляет в Gemini через Files API,
// и в любом случае (успех или ошибка) удаляет временный файл с диска.
async function transcribeVideoAudio(url, promptText) {
  const audio = await downloadAudioWithYtDlp(url);
  try {
    const result = await processLargeMedia({
      text: promptText,
      filePath: audio.filePath,
      mimeType: audio.mimeType,
      isMedia: true
    });
    return result;
  } finally {
    fs.promises.unlink(audio.filePath).catch(() => {});
  }
}
 
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ALLOWED_ID) {
    return ctx.reply('Доступ ограничен.');
  }
  await next();
});
 
function buildNoteKeyboard(shortId) {
  return new InlineKeyboard()
    .text('📁 В «Учеба»', `mv:Учеба:${shortId}`)
    .text('📁 В «Проекты»', `mv:Проекты:${shortId}`)
    .row()
    .text('📅 В заметку за сегодня', `daily:${shortId}`)
    .text('🗑 Удалить', `del:${shortId}`);
}
 
function formatSuccessMessage(title, fileName, tags, currentFolder = 'Inbox') {
  const safeTitle = escapeHtml(title);
  const safeFileName = escapeHtml(fileName);
  const openUrl = `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(currentFolder + '/' + fileName)}`;
  const formattedTags = tags.map(t => '#' + escapeHtml(t.replace(/^#/, ''))).join(' ');
 
  let message = `✅ <b>${safeTitle}</b>\n\n` +
                `📄 <a href="${openUrl}">Открыть заметку в Obsidian</a>\n` +
                `📁 Файл: <code>${safeFileName}</code>\n` +
                `🏷 ${formattedTags}`;
 
  if (currentFolder !== 'Inbox') {
    message += `\n\n📁 <b>Перемещено в папку:</b> <code>${escapeHtml(currentFolder)}</code>`;
  }
 
  return message;
}
 
bot.command(['daily', 'd'], async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) {
    return ctx.reply('✍️ Напишите текст после команды:\n<code>/d Тестовая мысль</code>', { parse_mode: 'HTML' });
  }
 
  try {
    const { dateStr, timeStr, fileName } = await appendToDailyNote(text);
    const openUrl = `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent('Daily/' + fileName)}`;
    await ctx.reply(`📅 Добавлено в <a href="${openUrl}">${escapeHtml(dateStr)}.md</a> в <b>${escapeHtml(timeStr)}</b>\n\n<blockquote>${escapeHtml(text)}</blockquote>`, {
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Ошибка при записи в Daily Note.');
  }
});
 
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  const media = detectMediaUrl(text);
 
  if (media) {
    const status = await ctx.reply('🎬 Ссылка принята. Проверяю субтитры...');
 
    try {
      let aiResult;
 
      if (media.type === 'youtube') {
        const transcript = await fetchYouTubeTranscript(media.url, media.videoId);
 
        if (transcript) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            status.message_id,
            '⚡ Субтитры найдены! Gemini анализирует структуру и готовит конспект...'
          );
 
          const prompt = `Это расшифровка и таймкоды видео YouTube (${media.url}). Сделай глубокий инженерный конспект по правилам:\n\n${transcript.slice(0, 70000)}`;
          aiResult = await processContent({ text: prompt, isMedia: true });
        } else {
          await ctx.api.editMessageText(
            ctx.chat.id,
            status.message_id,
            '🎙 Субтитров нет. Скачиваю аудиодорожку через yt-dlp... (может занять несколько минут для длинных видео)'
          );
 
          await ctx.api.editMessageText(
            ctx.chat.id,
            status.message_id,
            '🧠 Аудио скачано, загружаю в Gemini и жду анализа...'
          );
 
          aiResult = await transcribeVideoAudio(
            media.url,
            `Сделай глубокий структурированный конспект этого видео (${media.url}):`
          );
        }
      } else {
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          '🎙 Скачиваю аудиодорожку ролика...'
        );
 
        aiResult = await transcribeVideoAudio(
          media.url,
          `Сделай структурированный разбор этого ролика (${media.url}):`
        );
      }
 
      const finalContent = `> [!info] Источник: [Открыть видео](${media.url})\n\n${aiResult.content}`;
      const fileName = await saveNoteToVault(aiResult.title, finalContent, [...aiResult.tags, media.type]);
      const shortId = registerFile(fileName, aiResult.title, aiResult.tags, finalContent);
 
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
        {
          parse_mode: 'HTML',
          reply_markup: buildNoteKeyboard(shortId)
        }
      );
    } catch (error) {
      console.error('Ошибка обработки медиа-ссылки:', error);
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `❌ Не удалось обработать медиа: ${error.message || 'Ошибка загрузки'}`
      );
    }
    return;
  }
 
  const status = await ctx.reply('⏳ Обрабатываю мысль...');
  try {
    const aiResult = await processContent({ text });
    const fileName = await saveNoteToVault(aiResult.title, aiResult.content, aiResult.tags);
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags, aiResult.content);
 
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'HTML',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Ошибка при сохранении заметки.');
  }
});
 
bot.on('message:voice', async (ctx) => {
  const status = await ctx.reply('🎙 Слушаю голос и анализирую...');
  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
 
    const aiResult = await processContent({
      mimeType: 'audio/ogg',
      dataBase64: base64
    });
 
    const fileName = await saveNoteToVault(aiResult.title, aiResult.content, aiResult.tags);
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags, aiResult.content);
 
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'HTML',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Не удалось обработать аудио.');
  }
});
 
bot.on('message:photo', async (ctx) => {
  const status = await ctx.reply('🖼 Читаю изображение...');
  try {
    const photo = ctx.message.photo.pop();
    const file = await ctx.api.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
 
    const aiResult = await processContent({
      text: ctx.message.caption || '',
      mimeType: 'image/jpeg',
      dataBase64: base64
    });
 
    const fileName = await saveNoteToVault(aiResult.title, aiResult.content, aiResult.tags);
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags, aiResult.content);
 
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'HTML',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Ошибка при распознавании фото.');
  }
});
 
bot.on(['message:video', 'message:video_note'], async (ctx) => {
  const status = await ctx.reply('🎬 Анализирую видеоряд и звук...');
  try {
    const videoObj = ctx.message.video || ctx.message.video_note;
    const file = await ctx.api.getFile(videoObj.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
 
    const aiResult = await processContent({
      text: ctx.message.caption || '',
      mimeType: 'video/mp4',
      dataBase64: base64
    });
 
    const fileName = await saveNoteToVault(aiResult.title, aiResult.content, aiResult.tags);
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags, aiResult.content);
 
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'HTML',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Ошибка при анализе видео.');
  }
});
 
bot.callbackQuery(/^daily:([a-f0-9]{8})$/, async (ctx) => {
  const shortId = ctx.match[1];
  const fileData = fileRegistry.get(shortId);
 
  if (!fileData) {
    return ctx.answerCallbackQuery({ text: 'Действие устарело или файл уже перемещен.', show_alert: true });
  }
 
  try {
    const entryText = `${fileData.title}: ${fileData.rawContent}`;
    const { dateStr, timeStr } = await appendToDailyNote(entryText);
 
    await deleteNote(fileData.fileName);
    fileRegistry.delete(shortId);
 
    await ctx.answerCallbackQuery({ text: `Добавлено в заметку за ${dateStr}!` });
    await ctx.editMessageText(`📅 <b>Перенесено в дневную заметку (${escapeHtml(dateStr)}.md в ${escapeHtml(timeStr)})</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({ text: 'Ошибка при переносе.', show_alert: true });
  }
});
 
bot.callbackQuery(/^mv:(.+):([a-f0-9]{8})$/, async (ctx) => {
  const [, targetFolder, shortId] = ctx.match;
  const fileData = fileRegistry.get(shortId);
 
  if (!fileData) {
    return ctx.answerCallbackQuery({ text: 'Файл уже перемещен или действие устарело.', show_alert: true });
  }
 
  try {
    await moveNote(fileData.fileName, targetFolder);
    fileRegistry.delete(shortId);
 
    await ctx.answerCallbackQuery({ text: `Перемещено в "${targetFolder}"!` });
 
    const updatedText = formatSuccessMessage(
      fileData.title,
      fileData.fileName,
      fileData.tags,
      targetFolder
    );
 
    await ctx.editMessageText(updatedText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({ text: 'Ошибка при перемещении файла.', show_alert: true });
  }
});
 
bot.callbackQuery(/^del:([a-f0-9]{8})$/, async (ctx) => {
  const shortId = ctx.match[1];
  const fileData = fileRegistry.get(shortId);
 
  if (!fileData) {
    return ctx.answerCallbackQuery({ text: 'Файл уже удален.', show_alert: true });
  }
 
  try {
    await deleteNote(fileData.fileName);
    fileRegistry.delete(shortId);
 
    await ctx.answerCallbackQuery({ text: 'Файл удален' });
    await ctx.editMessageText('🗑 <b>Заметка удалена из хранилища.</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({ text: 'Не удалось удалить файл.', show_alert: true });
  }
});
 
console.log('📡 Подключаюсь к серверам Telegram...');
bot.start({
  onStart: () => console.log('🚀 Бот успешно запущен!')
});