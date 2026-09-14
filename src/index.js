import 'dotenv/config';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { Bot, InlineKeyboard } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import crypto from 'crypto';
import { processContent } from './ai.js';
import { saveNoteToVault, moveNote, deleteNote, appendToDailyNote } from './obsidian.js';

const proxyUrl = 'http://127.0.0.1:3067';
setGlobalDispatcher(new ProxyAgent(proxyUrl));

console.log('⏳ Проверяю переменные окружения...');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Ошибка: Не указан TELEGRAM_BOT_TOKEN в файле .env');
  process.exit(1);
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
  client: {
    baseFetchConfig: {
      agent: new HttpsProxyAgent(proxyUrl)
    }
  }
});

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
  const status = await ctx.reply('⏳ Обрабатываю мысль...');
  try {
    const aiResult = await processContent({ text: ctx.message.text });
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