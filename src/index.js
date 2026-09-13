import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { processContent } from './ai.js';
import { saveNoteToVault, moveNote, deleteNote } from './obsidian.js';

dotenv.config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_ID = Number(process.env.ALLOWED_USER_ID);
const VAULT_NAME = 'Obsidian Vault';

// Реестр заметок в памяти (хранит метаданные для безопасного рендеринга)
const fileRegistry = new Map();

function registerFile(fileName, title, tags) {
  const shortId = crypto.randomBytes(4).toString('hex');
  fileRegistry.set(shortId, { fileName, title, tags });
  return shortId;
}

// Защита доступа по ID
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ALLOWED_ID) {
    return ctx.reply('Доступ ограничен.');
  }
  await next();
});

// Генерация кнопок управления
function buildNoteKeyboard(shortId) {
  return new InlineKeyboard()
    .text('📁 В «Учеба»', `mv:Учеба:${shortId}`)
    .text('📁 В «Проекты»', `mv:Проекты:${shortId}`)
    .row()
    .text('🗑 Удалить', `del:${shortId}`);
}

// Формирование текста ответа с защитой от ошибок парсинга Markdown
function formatSuccessMessage(title, fileName, tags, currentFolder = 'Inbox') {
  // Экранируем управляющие символы Markdown в заголовке
  const safeTitle = title.replace(/[*_`]/g, '');
  const openUrl = `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(currentFolder + '/' + fileName)}`;
  const formattedTags = tags.map(t => '#' + t.replace(/^#/, '')).join(' ');

  let message = `✅ *${safeTitle}*\n\n` +
                `📄 [Открыть заметку в Obsidian](${openUrl})\n` +
                `📁 Файл: \`${fileName}\`\n` +
                `🏷 ${formattedTags}`;

  if (currentFolder !== 'Inbox') {
    message += `\n\n📁 *Перемещено в папку:* \`${currentFolder}\``;
  }

  return message;
}

// 1. Текстовые сообщения
bot.on('message:text', async (ctx) => {
  const status = await ctx.reply('⏳ Обрабатываю мысль...');
  try {
    const aiResult = await processContent({ text: ctx.message.text });
    const fileName = await saveNoteToVault(aiResult.title, aiResult.content, aiResult.tags);
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'Markdown',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Ошибка при сохранении заметки.');
  }
});

// 2. Голосовые сообщения
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
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'Markdown',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Не удалось обработать аудио.');
  }
});

// 3. Фотографии
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
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'Markdown',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Ошибка при распознавании фото.');
  }
});

// 4. Видео и видеосообщения
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
    const shortId = registerFile(fileName, aiResult.title, aiResult.tags);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatSuccessMessage(aiResult.title, fileName, aiResult.tags),
      {
        parse_mode: 'Markdown',
        reply_markup: buildNoteKeyboard(shortId)
      }
    );
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Ошибка при анализе видео.');
  }
});

// Обработка кнопки перемещения
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
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({ text: 'Ошибка при перемещении файла.', show_alert: true });
  }
});

// Обработка кнопки удаления
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
    await ctx.editMessageText('🗑 *Заметка удалена из хранилища.*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    console.error(err);
    await ctx.answerCallbackQuery({ text: 'Не удалось удалить файл.', show_alert: true });
  }
});

bot.start({
  onStart: () => console.log('🚀 Бот с надежными кнопками запущен!')
});