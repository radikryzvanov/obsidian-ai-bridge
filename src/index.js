import { Bot, InlineKeyboard } from 'grammy';
import { run } from '@grammyjs/runner';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { config, validateConfig } from './config.js';
import * as aiModule from './ai.js';
import * as mediaModule from './media.js';
import { saveProcessed } from './pipeline.js';
import { appendToDailyNote, moveNote, trashNote, INBOX, REVIEWS, MOVE_TARGETS } from './obsidian.js';
import { getFile, removeFile } from './registry.js';
import {
  collectOpenTasks,
  getNotesIndex,
  noteBody,
  notesForQuiz,
  searchNotes,
  staleInboxNotes,
  weekMaterials
} from './vault.js';
import {
  addStudy,
  answerCard,
  countDue,
  dueCards,
  endQuiz,
  getCard,
  getQuiz,
  getState,
  parseStudyArgs,
  setState,
  startQuiz,
  studyTotals,
  touchQuiz
} from './study.js';
import { Semaphore, UserError, chunkText, dateStr, deriveTitle, escapeHtml } from './utils.js';

export const defaultDeps = { ai: aiModule, media: mediaModule };

const INLINE_LIMIT = 8 * 1024 * 1024; // файлы больше 8 МБ отправляем в Gemini через Files API
const TG_LIMIT_TEXT =
  '⚠️ Telegram не даёт боту скачивать файлы больше 20 МБ. Пришлите ссылку (YouTube и др.) или файл поменьше.';

const HELP_TEXT = `Просто пришлите мысль, голосовое, фото, видео, PDF, Word-документ или ссылку — я сделаю заметку в Inbox.

Что можно:
• ссылка на YouTube/Instagram/VK/RuTube/TikTok — конспект видео
• ссылка на статью — конспект статьи
• /idea текст — разбор идеи
• /task текст — превратить в задачу с шагами
• /learn тема — объяснение простыми словами + карточки
• /d текст — быстро записать в дневник

Своя база знаний:
• /ask вопрос — ответ по вашим заметкам
• /tasks — все незакрытые задачи
• /inbox — что ждёт разбора

Учёба:
• /quiz [тема] — проверка знаний по конспектам (/skip, /stop)
• /cards — повторение карточек
• /study тема часы — записать время учёбы, например /study Angular 1.5
• /review — обзор недели`;

export const BOT_COMMANDS = [
  { command: 'help', description: 'Что умеет бот' },
  { command: 'ask', description: 'Вопрос по моим заметкам' },
  { command: 'learn', description: 'Объяснить тему + карточки' },
  { command: 'quiz', description: 'Проверить знания' },
  { command: 'cards', description: 'Повторить карточки' },
  { command: 'study', description: 'Записать время учёбы' },
  { command: 'tasks', description: 'Открытые задачи' },
  { command: 'inbox', description: 'Что ждёт разбора' },
  { command: 'review', description: 'Обзор недели' },
  { command: 'idea', description: 'Разобрать идею' },
  { command: 'task', description: 'Сделать задачу' },
  { command: 'd', description: 'Запись в дневник' }
];

function obsidianUrl(relPath) {
  return `obsidian://open?vault=${encodeURIComponent(config.vaultName)}&file=${encodeURIComponent(relPath)}`;
}

function buildNoteKeyboard(shortId) {
  return new InlineKeyboard()
    .text('📁 В «Учеба»', `mv:Учеба:${shortId}`)
    .text('📁 В «Проекты»', `mv:Проекты:${shortId}`)
    .row()
    .text('📅 Ссылку в дневник', `daily:${shortId}`)
    .text('🗑 Удалить', `del:${shortId}`);
}

export function formatSuccessMessage({ title, fileName, folder = INBOX, tags = [], cardsCount = 0 }) {
  const openUrl = obsidianUrl(`${folder}/${fileName}`);
  const formattedTags = tags.map((t) => '#' + escapeHtml(t.replace(/^#/, ''))).join(' ');

  let message =
    `✅ <b>${escapeHtml(title)}</b>\n\n` +
    `📄 <a href="${openUrl}">Открыть заметку в Obsidian</a>\n` +
    `📁 Файл: <code>${escapeHtml(fileName)}</code>`;
  if (formattedTags) message += `\n🏷 ${formattedTags}`;
  if (cardsCount) message += `\n🃏 Карточек для повторения: ${cardsCount} (/cards)`;
  if (folder !== INBOX) message += `\n\n📁 <b>Перемещено в папку:</b> <code>${escapeHtml(folder)}</code>`;
  return message;
}

export function friendlyError(error) {
  if (error?.userMessage) return error.userMessage;
  const status = Number(error?.status);
  if (status === 429) return 'Превышен лимит запросов к Gemini. Попробуйте через минуту.';
  if (status === 503 || status === 500) return 'Сервис Gemini сейчас перегружен. Попробуйте позже.';
  if (status === 401 || status === 403) return 'Gemini не принял ключ API. Проверьте GEMINI_API_KEY.';
  return String(error?.message || 'Неизвестная ошибка').slice(0, 250);
}

async function safeEdit(api, chatId, messageId, text, extra = {}) {
  try {
    await api.editMessageText(chatId, messageId, text, extra);
  } catch (error) {
    if (!/message is not modified/i.test(String(error?.description || error?.message))) {
      console.error('Не удалось изменить сообщение:', error?.message);
    }
  }
}

async function withTempFile(buffer, fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-'));
  try {
    const filePath = path.join(dir, 'upload.bin');
    await fs.promises.writeFile(filePath, buffer);
    return await fn(filePath);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Текст напоминания на день (пустая строка, если сообщать нечего)
export async function buildReminderText(now = new Date()) {
  const parts = [];

  const due = await countDue(dateStr(now));
  if (due) parts.push(`🃏 Карточек к повторению: ${due} — /cards`);

  const { stale } = await staleInboxNotes(3);
  if (stale.length) parts.push(`📥 В Inbox ждут разбора заметки старше 3 дней: ${stale.length} — /inbox`);

  const tasks = await collectOpenTasks();
  if (tasks.length) parts.push(`☐ Открытых задач: ${tasks.length} — /tasks`);

  if (now.getDay() === 0) parts.push('📊 Воскресенье — хорошее время для /review');

  return parts.length ? `☀️ Доброе утро!\n\n${parts.join('\n')}` : '';
}

export function createBot(deps = defaultDeps) {
  const bot = new Bot(config.telegramToken);
  const heavy = new Semaphore(2); // не больше двух тяжёлых загрузок видео одновременно

  bot.catch((err) => {
    console.error('Необработанная ошибка в обработчике:', err.error?.message || err);
  });

  // Доступ только владельцу; остальным не отвечаем вообще
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.allowedId) {
      console.warn(`Попытка доступа от чужого пользователя: ${ctx.from?.id}`);
      return;
    }
    await next();
  });

  // ---------- Общие сценарии ----------

  async function finishNote(ctx, status, aiResult, options) {
    const saved = await saveProcessed(aiResult, options);
    await safeEdit(ctx.api, ctx.chat.id, status.message_id, formatSuccessMessage(saved), {
      parse_mode: 'HTML',
      reply_markup: buildNoteKeyboard(saved.shortId)
    });
    return saved;
  }

  // Мысль не должна теряться: если ИИ недоступен, сохраняем текст как есть
  async function saveRawFallback(ctx, status, text, error) {
    try {
      const saved = await saveProcessed(
        { title: deriveTitle(text), content: text, tags: ['raw'] },
        { type: 'raw' }
      );
      await safeEdit(
        ctx.api,
        ctx.chat.id,
        status.message_id,
        `⚠️ ИИ не справился: ${escapeHtml(friendlyError(error))}\nСохранил текст как есть — разберёте позже.\n\n` +
          formatSuccessMessage(saved),
        { parse_mode: 'HTML', reply_markup: buildNoteKeyboard(saved.shortId) }
      );
      return true;
    } catch (fallbackError) {
      console.error('Не удалось сохранить даже сырой текст:', fallbackError);
      return false;
    }
  }

  async function handleTextNote(ctx, text, { mode = 'note', extraTags = [] } = {}) {
    const status = await ctx.reply('⏳ Обрабатываю мысль...');
    try {
      const notesIndex = await getNotesIndex();
      const aiResult = await deps.ai.processContent({ text, mode, notesIndex });
      await finishNote(ctx, status, aiResult, { type: mode, extraTags });
    } catch (error) {
      console.error('Ошибка обработки заметки:', error);
      const saved = await saveRawFallback(ctx, status, text, error);
      if (!saved) {
        await safeEdit(ctx.api, ctx.chat.id, status.message_id, `❌ Не удалось сохранить заметку: ${friendlyError(error)}`);
      }
    }
  }

  async function handleVideoLink(ctx, media) {
    const status = await ctx.reply('🎬 Ссылка принята. Проверяю субтитры...');
    const edit = (text) => safeEdit(ctx.api, ctx.chat.id, status.message_id, text);

    try {
      const notesIndex = await getNotesIndex();
      let aiResult;

      const viaAudio = async (prompt) => {
        await edit('🎙 Скачиваю аудиодорожку... (для длинных видео это может занять несколько минут)');
        return heavy.run(async () => {
          const audio = await deps.media.downloadAudioWithYtDlp(media.url);
          try {
            await edit('🧠 Аудио скачано, загружаю в Gemini и жду анализа...');
            return await deps.ai.processLargeMedia({
              text: prompt,
              filePath: audio.filePath,
              mimeType: audio.mimeType,
              mode: 'video',
              notesIndex
            });
          } finally {
            await audio.cleanup();
          }
        });
      };

      if (media.type === 'youtube') {
        const transcript = await deps.media.fetchYouTubeTranscript(media.url, media.videoId);
        if (transcript) {
          await edit('⚡ Субтитры найдены! Gemini готовит конспект...');
          const prompt = `Это расшифровка с таймкодами видео YouTube (${media.url}). Сделай конспект по правилам:\n\n${transcript.slice(0, 120000)}`;
          aiResult = await deps.ai.processContent({ text: prompt, mode: 'video', notesIndex });
        } else {
          aiResult = await viaAudio(`Сделай конспект этого видео (${media.url}):`);
        }
      } else {
        aiResult = await viaAudio(`Сделай конспект этого ролика (${media.url}):`);
      }

      const platformTag = media.type === 'generic_video' ? 'video' : media.type;
      await finishNote(ctx, status, aiResult, {
        type: 'video',
        source: media.url,
        extraTags: ['learning', 'video', platformTag]
      });
    } catch (error) {
      console.error('Ошибка обработки видео-ссылки:', error);
      await edit(`❌ Не удалось обработать видео: ${friendlyError(error)}`);
    }
  }

  async function handleArticleLink(ctx, url, comment) {
    const status = await ctx.reply('📰 Читаю статью...');
    try {
      const article = await deps.media.fetchArticleText(url);
      const notesIndex = await getNotesIndex();
      const prompt =
        `Статья «${article.title || url}» (${url}).` +
        (comment ? `\nКомментарий пользователя: ${comment}` : '') +
        `\n\nТекст:\n${article.text}`;
      const aiResult = await deps.ai.processContent({ text: prompt, mode: 'article', notesIndex });
      await finishNote(ctx, status, aiResult, { type: 'article', source: url, extraTags: ['article'] });
    } catch (error) {
      console.error('Ошибка обработки статьи:', error);
      await safeEdit(ctx.api, ctx.chat.id, status.message_id, `❌ Не удалось прочитать статью: ${friendlyError(error)}`);
    }
  }

  // Голос, фото, видео, аудио, PDF
  async function handleBinary(ctx, { fileId, fileSize, mimeType, text = '', startText }) {
    if (fileSize && fileSize > mediaModule.TELEGRAM_FILE_LIMIT) {
      return ctx.reply(TG_LIMIT_TEXT);
    }
    const status = await ctx.reply(startText);
    try {
      const buffer = await deps.media.downloadTelegramFile(ctx.api, fileId);
      const notesIndex = await getNotesIndex();

      const aiResult =
        buffer.length > INLINE_LIMIT
          ? await withTempFile(buffer, (filePath) =>
              deps.ai.processLargeMedia({ text, filePath, mimeType, mode: 'note', notesIndex })
            )
          : await deps.ai.processContent({
              text,
              mimeType,
              dataBase64: buffer.toString('base64'),
              mode: 'note',
              notesIndex
            });

      await finishNote(ctx, status, aiResult, { type: 'note' });
    } catch (error) {
      console.error('Ошибка обработки файла:', error);
      await safeEdit(ctx.api, ctx.chat.id, status.message_id, `❌ Не удалось обработать файл: ${friendlyError(error)}`);
    }
  }

  // ---------- Квиз ----------

  async function askNextQuestion(ctx, quiz) {
    const q = quiz.questions[quiz.index];
    await ctx.reply(
      `❓ Вопрос ${quiz.index + 1} из ${quiz.questions.length}\n\n${q.question}\n\nОтвечайте текстом. /skip — пропустить, /stop — закончить.`
    );
  }

  async function advanceQuiz(ctx, quiz) {
    quiz.index++;
    touchQuiz(quiz);
    if (quiz.index >= quiz.questions.length) {
      endQuiz(ctx.chat.id);
      const total = quiz.questions.length;
      const label = quiz.topic ? `«${quiz.topic}»` : 'по конспектам';
      await appendToDailyNote(`🧠 Квиз ${label}: ${quiz.score} из ${total}`).catch(() => {});
      await ctx.reply(`🏁 Квиз окончен. Результат: ${quiz.score} из ${total}.`);
      return;
    }
    await askNextQuestion(ctx, quiz);
  }

  async function handleQuizAnswer(ctx, quiz, text) {
    const q = quiz.questions[quiz.index];
    const status = await ctx.reply('🤔 Проверяю ответ...');
    try {
      const result = await deps.ai.checkAnswer({
        question: q.question,
        referenceAnswer: q.answer,
        userAnswer: text
      });
      const icon = { correct: '✅ Верно!', partial: '🟡 Частично верно', wrong: '❌ Пока не то' }[result.verdict];
      quiz.score += result.verdict === 'correct' ? 1 : result.verdict === 'partial' ? 0.5 : 0;
      await safeEdit(
        ctx.api,
        ctx.chat.id,
        status.message_id,
        `${icon}\n\n${escapeHtml(result.feedback)}\n\n📌 Эталон: ${escapeHtml(q.answer)}`,
        { parse_mode: 'HTML' }
      );
      await advanceQuiz(ctx, quiz);
    } catch (error) {
      console.error('Ошибка проверки ответа:', error);
      await safeEdit(
        ctx.api,
        ctx.chat.id,
        status.message_id,
        `❌ Не удалось проверить ответ: ${friendlyError(error)}\nПопробуйте отправить ответ ещё раз.`
      );
    }
  }

  // ---------- Команды ----------

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP_TEXT));

  bot.command(['daily', 'd'], async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      return ctx.reply('✍️ Напишите текст после команды:\n<code>/d Тестовая мысль</code>', { parse_mode: 'HTML' });
    }
    try {
      const { dateStr: date, timeStr: time, fileName } = await appendToDailyNote(text);
      const openUrl = obsidianUrl('Daily/' + fileName);
      await ctx.reply(
        `📅 Добавлено в <a href="${openUrl}">${escapeHtml(date)}.md</a> в <b>${escapeHtml(time)}</b>\n\n<blockquote>${escapeHtml(text)}</blockquote>`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error(error);
      await ctx.reply('❌ Ошибка при записи в дневник.');
    }
  });

  const modeCommands = [
    ['idea', 'idea', '💡 Напишите идею после команды:\n/idea Сделать бота для записи на массаж', ['idea']],
    ['task', 'task', '☐ Напишите мысль после команды:\n/task Разобраться с формами в Angular', ['task']],
    ['learn', 'learn', '🎓 Напишите тему после команды:\n/learn Сигналы в Angular', ['learning']]
  ];
  for (const [command, mode, usage, extraTags] of modeCommands) {
    bot.command(command, async (ctx) => {
      const text = ctx.match?.trim();
      if (!text) return ctx.reply(usage);
      await handleTextNote(ctx, text, { mode, extraTags });
    });
  }

  bot.command('ask', async (ctx) => {
    const question = ctx.match?.trim();
    if (!question) return ctx.reply('🔎 Задайте вопрос после команды:\n/ask Что я записывал про сигналы в Angular?');

    const status = await ctx.reply('🔎 Ищу в ваших заметках...');
    try {
      const found = await searchNotes(question, 8);
      if (!found.length) {
        return safeEdit(
          ctx.api,
          ctx.chat.id,
          status.message_id,
          'Ничего не нашёл по этим словам. Попробуйте другими словами или сначала сохраните заметки по теме.'
        );
      }
      const result = await deps.ai.askVault({
        question,
        notes: found.map((n) => ({ base: n.base, title: n.title, text: noteBody(n) }))
      });
      const used = found.filter((n) => result.sources.includes(n.base));
      const links = (used.length ? used : found.slice(0, 3))
        .map((n) => `• <a href="${obsidianUrl(n.rel.replace(/\.md$/i, ''))}">${escapeHtml(n.title)}</a>`)
        .join('\n');

      const answer = escapeHtml(result.answer || 'Ответа в заметках нет.');
      const text = `${answer}\n\n📚 Заметки:\n${links}`;
      const [first, ...rest] = chunkText(text);
      await safeEdit(ctx.api, ctx.chat.id, status.message_id, first, { parse_mode: 'HTML' });
      for (const part of rest) await ctx.reply(part, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Ошибка /ask:', error);
      await safeEdit(ctx.api, ctx.chat.id, status.message_id, `❌ Не удалось ответить: ${friendlyError(error)}`);
    }
  });

  bot.command('tasks', async (ctx) => {
    try {
      const tasks = await collectOpenTasks();
      if (!tasks.length) return ctx.reply('🎉 Открытых задач в заметках нет.');

      const shown = tasks.slice(0, 40);
      const groups = new Map();
      for (const t of shown) {
        if (!groups.has(t.rel)) groups.set(t.rel, { title: t.title, rel: t.rel, items: [] });
        groups.get(t.rel).items.push(t.text);
      }
      let text = `☐ Открытых задач: ${tasks.length}${tasks.length > shown.length ? ` (показаны первые ${shown.length})` : ''}\n`;
      for (const g of groups.values()) {
        text += `\n📄 <a href="${obsidianUrl(g.rel.replace(/\.md$/i, ''))}">${escapeHtml(g.title)}</a>\n`;
        text += g.items.map((i) => `☐ ${escapeHtml(i)}`).join('\n') + '\n';
      }
      for (const part of chunkText(text)) await ctx.reply(part, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Ошибка /tasks:', error);
      await ctx.reply('❌ Не удалось собрать задачи.');
    }
  });

  bot.command('inbox', async (ctx) => {
    try {
      const { stale, total } = await staleInboxNotes(3);
      if (!total) return ctx.reply('✨ Inbox пуст.');
      let text = `📥 В Inbox заметок: ${total}, старше 3 дней: ${stale.length}`;
      if (stale.length) {
        const list = stale
          .slice(0, 15)
          .map((name) => `• <a href="${obsidianUrl(INBOX + '/' + name.replace(/\.md$/i, ''))}">${escapeHtml(name.replace(/\.md$/i, ''))}</a>`)
          .join('\n');
        text += `\n\nПора разобрать:\n${list}`;
      }
      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Ошибка /inbox:', error);
      await ctx.reply('❌ Не удалось прочитать Inbox.');
    }
  });

  bot.command('quiz', async (ctx) => {
    const topic = ctx.match?.trim() || '';
    const status = await ctx.reply('🧠 Готовлю вопросы по вашим конспектам...');
    try {
      const notes = await notesForQuiz(topic, 5);
      if (!notes.length && !topic) {
        return safeEdit(
          ctx.api,
          ctx.chat.id,
          status.message_id,
          'Пока нет конспектов для квиза. Сохраните несколько заметок (например, /learn тема) и возвращайтесь.'
        );
      }
      const { questions } = await deps.ai.generateQuiz({
        topic,
        notes: notes.map((n) => ({ title: n.title, text: noteBody(n) })),
        count: 5
      });
      if (!questions.length) throw new UserError('Не получилось составить вопросы.');

      const quiz = startQuiz(ctx.chat.id, questions, topic);
      await safeEdit(
        ctx.api,
        ctx.chat.id,
        status.message_id,
        `🧠 Квиз готов: ${questions.length} вопросов${notes.length ? ` по заметкам: ${notes.map((n) => n.title).join(', ')}` : ' по теме (в заметках ничего не нашлось)'}.`
      );
      await askNextQuestion(ctx, quiz);
    } catch (error) {
      console.error('Ошибка /quiz:', error);
      await safeEdit(ctx.api, ctx.chat.id, status.message_id, `❌ Не удалось начать квиз: ${friendlyError(error)}`);
    }
  });

  bot.command('skip', async (ctx) => {
    const quiz = getQuiz(ctx.chat.id);
    if (!quiz) return ctx.reply('Сейчас нет активного квиза. Начать: /quiz');
    const q = quiz.questions[quiz.index];
    await ctx.reply(`⏭ Пропускаем. Эталонный ответ:\n${q.answer}`);
    await advanceQuiz(ctx, quiz);
  });

  bot.command('stop', async (ctx) => {
    const quiz = getQuiz(ctx.chat.id);
    if (!quiz) return ctx.reply('Сейчас нет активного квиза.');
    endQuiz(ctx.chat.id);
    await ctx.reply(`Квиз остановлен. Набрано: ${quiz.score} из ${quiz.questions.length}.`);
  });

  bot.command('cards', async (ctx) => {
    try {
      const due = await dueCards(5);
      if (!due.length) return ctx.reply('🎉 На сегодня карточек нет. Новые появляются из конспектов (/learn, видео, статьи).');
      const left = (await countDue()) - due.length;
      for (const card of due) {
        await ctx.reply(`🃏 ${escapeHtml(card.q)}`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('👀 Показать ответ', `cs:${card.id}`)
        });
      }
      if (left > 0) await ctx.reply(`Ещё карточек на сегодня: ${left}. Отправьте /cards снова после этих.`);
    } catch (error) {
      console.error('Ошибка /cards:', error);
      await ctx.reply('❌ Не удалось загрузить карточки.');
    }
  });

  bot.command('study', async (ctx) => {
    const parsed = parseStudyArgs(ctx.match);
    if (!parsed) {
      return ctx.reply('📚 Напишите тему и часы:\n/study Angular сигналы 1.5');
    }
    try {
      await addStudy(parsed.topic, parsed.hours);
      await appendToDailyNote(`📚 Учёба: ${parsed.topic} — ${parsed.hours} ч`);
      const week = await studyTotals(7);
      await ctx.reply(
        `📚 Записал: ${parsed.topic} — ${parsed.hours} ч.\nЗа 7 дней всего: ${week.total} ч` +
          (week.lines.length ? `\n${week.lines.map((l) => `• ${l}`).join('\n')}` : '')
      );
    } catch (error) {
      console.error('Ошибка /study:', error);
      await ctx.reply('❌ Не удалось записать учёбу.');
    }
  });

  bot.command('review', async (ctx) => {
    const status = await ctx.reply('📊 Собираю материалы недели...');
    try {
      const materials = await weekMaterials(7);
      const study = await studyTotals(7);
      const tasks = await collectOpenTasks();
      if (!materials.daily && !materials.notes.length && !study.total) {
        return safeEdit(ctx.api, ctx.chat.id, status.message_id, 'За эту неделю пока нет записей для обзора.');
      }
      const aiResult = await deps.ai.weeklyReview({
        daily: materials.daily,
        notes: materials.notes,
        study,
        tasks,
        notesIndex: await getNotesIndex()
      });
      const saved = await saveProcessed(aiResult, { type: 'review', folder: REVIEWS, extraTags: ['review'] });
      const link = `<a href="${obsidianUrl(`${REVIEWS}/${saved.fileName}`)}">Открыть обзор в Obsidian</a>`;
      const [first, ...rest] = chunkText(`📊 <b>${escapeHtml(saved.title)}</b>\n\n${escapeHtml(aiResult.content)}`);
      await safeEdit(ctx.api, ctx.chat.id, status.message_id, first, { parse_mode: 'HTML' });
      for (const part of rest) await ctx.reply(part, { parse_mode: 'HTML' });
      await ctx.reply(`📄 ${link}`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Ошибка /review:', error);
      await safeEdit(ctx.api, ctx.chat.id, status.message_id, `❌ Не удалось составить обзор: ${friendlyError(error)}`);
    }
  });

  // ---------- Сообщения ----------

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    if (text.startsWith('/')) {
      return ctx.reply('Неизвестная команда. /help — список команд.');
    }

    const quiz = getQuiz(ctx.chat.id);
    if (quiz) return handleQuizAnswer(ctx, quiz, text);

    const media = deps.media.detectMediaUrl(text);
    if (media) return handleVideoLink(ctx, media);

    // Сообщение почти целиком состоит из ссылки — считаем это статьёй
    const url = deps.media.extractFirstUrl(text);
    if (url) {
      const comment = text.replace(url, '').trim();
      if (comment.length < 40) return handleArticleLink(ctx, url, comment);
    }

    return handleTextNote(ctx, text);
  });

  bot.on('message:voice', (ctx) =>
    handleBinary(ctx, {
      fileId: ctx.message.voice.file_id,
      fileSize: ctx.message.voice.file_size,
      mimeType: ctx.message.voice.mime_type || 'audio/ogg',
      startText: '🎙 Слушаю голос и анализирую...'
    })
  );

  bot.on('message:audio', (ctx) =>
    handleBinary(ctx, {
      fileId: ctx.message.audio.file_id,
      fileSize: ctx.message.audio.file_size,
      mimeType: ctx.message.audio.mime_type || 'audio/mpeg',
      text: ctx.message.caption || '',
      startText: '🎧 Слушаю аудио и анализирую...'
    })
  );

  bot.on('message:photo', (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    return handleBinary(ctx, {
      fileId: photo.file_id,
      fileSize: photo.file_size,
      mimeType: 'image/jpeg',
      text: ctx.message.caption || '',
      startText: '🖼 Читаю изображение...'
    });
  });

  bot.on(['message:video', 'message:video_note'], (ctx) => {
    const video = ctx.message.video || ctx.message.video_note;
    return handleBinary(ctx, {
      fileId: video.file_id,
      fileSize: video.file_size,
      mimeType: video.mime_type || 'video/mp4',
      text: ctx.message.caption || '',
      startText: '🎬 Анализирую видеоряд и звук...'
    });
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name || 'документ';
    const mime = doc.mime_type || '';
    const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
    const isDocx =
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(name);
    const isText = mime.startsWith('text/') || /\.(md|markdown|txt)$/i.test(name);

    if (!isPdf && !isText && !isDocx) {
      return ctx.reply('Пока умею читать PDF, Word (.docx) и текстовые файлы (.txt, .md). Для остального пришлите текст или фото.');
    }

    if (isPdf) {
      return handleBinary(ctx, {
        fileId: doc.file_id,
        fileSize: doc.file_size,
        mimeType: 'application/pdf',
        text: ctx.message.caption || `Файл: ${name}`,
        startText: '📄 Читаю документ...'
      });
    }

    if (doc.file_size && doc.file_size > mediaModule.TELEGRAM_FILE_LIMIT) return ctx.reply(TG_LIMIT_TEXT);
    try {
      const buffer = await deps.media.downloadTelegramFile(ctx.api, doc.file_id);
      const fullText = isDocx ? await deps.media.extractDocxText(buffer) : buffer.toString('utf-8');
      const content = fullText.slice(0, 120000);
      const caption = ctx.message.caption ? `${ctx.message.caption}\n\n` : '';
      const label = isDocx ? 'Документ Word' : 'Файл';
      await handleTextNote(ctx, `${caption}${label} «${name}»:\n\n${content}`);
    } catch (error) {
      console.error('Ошибка чтения текстового файла:', error);
      await ctx.reply(`❌ Не удалось прочитать файл: ${friendlyError(error)}`);
    }
  });

  // ---------- Кнопки ----------

  bot.callbackQuery(/^daily:([a-f0-9]{8})$/, async (ctx) => {
    const data = await getFile(ctx.match[1]);
    if (!data) {
      return ctx.answerCallbackQuery({ text: 'Действие устарело.', show_alert: true });
    }
    try {
      const base = data.fileName.replace(/\.md$/i, '');
      const { dateStr: date } = await appendToDailyNote(`📌 [[${base}|${data.title}]]`);
      await ctx.answerCallbackQuery({ text: `Ссылка добавлена в дневник за ${date}` });
    } catch (error) {
      console.error(error);
      await ctx.answerCallbackQuery({ text: 'Ошибка при записи в дневник.', show_alert: true });
    }
  });

  bot.callbackQuery(/^mv:(.+):([a-f0-9]{8})$/, async (ctx) => {
    const [, targetFolder, shortId] = ctx.match;
    const data = await getFile(shortId);
    if (!data || !MOVE_TARGETS.includes(targetFolder)) {
      return ctx.answerCallbackQuery({ text: 'Файл уже перемещён или действие устарело.', show_alert: true });
    }
    try {
      const finalName = await moveNote(data.fileName, targetFolder);
      await removeFile(shortId);
      await ctx.answerCallbackQuery({ text: `Перемещено в «${targetFolder}»` });
      await ctx.editMessageText(
        formatSuccessMessage({ title: data.title, fileName: finalName, tags: data.tags, folder: targetFolder }),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      );
    } catch (error) {
      console.error(error);
      await ctx.answerCallbackQuery({ text: 'Ошибка при перемещении файла.', show_alert: true });
    }
  });

  bot.callbackQuery(/^del:([a-f0-9]{8})$/, async (ctx) => {
    const shortId = ctx.match[1];
    const data = await getFile(shortId);
    if (!data) {
      return ctx.answerCallbackQuery({ text: 'Файл уже удалён.', show_alert: true });
    }
    try {
      await trashNote(data.fileName);
      await removeFile(shortId);
      await ctx.answerCallbackQuery({ text: 'Перенесено в корзину' });
      await ctx.editMessageText('🗑 <b>Заметка перенесена в корзину Obsidian</b> (папка .trash) — её можно вернуть.', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
    } catch (error) {
      console.error(error);
      await ctx.answerCallbackQuery({ text: 'Не удалось удалить файл.', show_alert: true });
    }
  });

  bot.callbackQuery(/^cs:([a-f0-9]{8})$/, async (ctx) => {
    const card = await getCard(ctx.match[1]);
    if (!card) return ctx.answerCallbackQuery({ text: 'Карточка не найдена.', show_alert: true });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`🃏 ${escapeHtml(card.q)}\n\n💡 ${escapeHtml(card.a)}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('✅ Знал', `ck:${card.id}:1`).text('❌ Не знал', `ck:${card.id}:0`)
    });
  });

  bot.callbackQuery(/^ck:([a-f0-9]{8}):([01])$/, async (ctx) => {
    const [, id, flag] = ctx.match;
    const card = await getCard(id);
    if (!card) return ctx.answerCallbackQuery({ text: 'Карточка не найдена.', show_alert: true });
    const result = await answerCard(id, flag === '1');
    await ctx.answerCallbackQuery();
    const verdict =
      flag === '1' ? `✅ Запомнил. Повтор через ${result.days} дн.` : '🔁 Повторим завтра.';
    await ctx.editMessageText(`🃏 ${escapeHtml(card.q)}\n\n💡 ${escapeHtml(card.a)}\n\n${verdict}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    });
  });

  return bot;
}

// ---------- Ежедневное напоминание ----------

export async function reminderTick(api, now = new Date()) {
  const hour = config.reminderHour;
  if (hour === null || now.getHours() < hour) return false;

  const today = dateStr(now);
  const state = await getState();
  if (state.lastReminder === today) return false;
  await setState({ lastReminder: today });

  const text = await buildReminderText(now);
  if (!text) return false;
  await api.sendMessage(config.allowedId, text);
  return true;
}

function startReminders(bot) {
  const tick = () => reminderTick(bot.api).catch((e) => console.error('Ошибка напоминания:', e.message));
  tick();
  return setInterval(tick, 10 * 60 * 1000);
}

// ---------- Запуск ----------

async function main() {
  console.log('⏳ Проверяю настройки...');
  const problems = validateConfig();
  if (problems.length) {
    console.error('❌ Проблемы с настройками (.env):\n' + problems.map((p) => ` - ${p}`).join('\n'));
    process.exit(1);
  }

  const bot = createBot();
  await bot.api.setMyCommands(BOT_COMMANDS).catch((e) => console.warn('Не удалось задать меню команд:', e.message));

  console.log('📡 Подключаюсь к серверам Telegram...');
  const runner = run(bot);
  const timer = startReminders(bot);
  console.log('🚀 Бот запущен!');

  const stop = async () => {
    clearInterval(timer);
    if (runner.isRunning()) await runner.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Фатальная ошибка:', error);
    process.exit(1);
  });
}
