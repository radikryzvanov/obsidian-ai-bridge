import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBot } from '../src/index.js';
import { detectMediaUrl, extractFirstUrl } from '../src/media.js';

export const USER_ID = 42;

// Чистое окружение для каждого теста: новое хранилище и папка данных
export async function setupEnv() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'obs-test-'));
  const vault = path.join(root, 'vault');
  await fs.promises.mkdir(vault, { recursive: true });
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
  process.env.ALLOWED_USER_ID = String(USER_ID);
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.OBSIDIAN_VAULT_NAME = 'Test Vault';
  process.env.REMINDER_HOUR = '9';
  return { root, vault };
}

export async function cleanup(root) {
  await fs.promises.rm(root, { recursive: true, force: true });
}

export function fakeDeps(overrides = {}) {
  const ai = {
    processContent: async ({ text, mode }) => ({
      title: `Тест ${mode}`,
      content: `Конспект: ${String(text).slice(0, 40)}`,
      tags: ['Test Tag', '#second'],
      related: [],
      cards: []
    }),
    processLargeMedia: async () => ({ title: 'Большой файл', content: 'Текст', tags: [], related: [], cards: [] }),
    generateQuiz: async () => ({
      questions: [
        { question: 'Что такое сигнал?', answer: 'Реактивное значение' },
        { question: 'Что такое компонент?', answer: 'Блок интерфейса' }
      ]
    }),
    checkAnswer: async () => ({ verdict: 'correct', feedback: 'Всё верно.' }),
    askVault: async ({ notes }) => ({ answer: 'Ответ из заметок.', sources: [notes[0].base] }),
    weeklyReview: async () => ({ title: 'Обзор недели', content: 'Итоги недели', tags: ['review'], related: [], cards: [] }),
    ...(overrides.ai || {})
  };
  const media = {
    detectMediaUrl,
    extractFirstUrl,
    fetchArticleText: async () => ({ title: 'Статья', text: 'Длинный текст статьи '.repeat(30) }),
    fetchYouTubeTranscript: async () => '[0:01] привет',
    downloadAudioWithYtDlp: async () => {
      throw new Error('не должно вызываться');
    },
    downloadTelegramFile: async () => Buffer.from('данные'),
    extractDocxText: async () => 'Текст из Word-документа',
    ...(overrides.media || {})
  };
  return { ai, media };
}

// Бот с подменённой сетью Telegram: все вызовы API записываются в calls
export function makeBot(deps = fakeDeps()) {
  const bot = createBot(deps);
  const calls = [];
  let nextMessageId = 100;

  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: ++nextMessageId, date: 0, chat: { id: USER_ID, type: 'private' }, text: payload.text } };
    }
    if (method === 'getFile') return { ok: true, result: { file_id: 'f', file_path: 'files/f.bin' } };
    return { ok: true, result: true };
  });

  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'Test',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false
  };

  let updateId = 0;
  const base = (fromId) => ({
    message_id: ++nextMessageId,
    date: 0,
    chat: { id: USER_ID, type: 'private' },
    from: { id: fromId, is_bot: false, first_name: 'Тест' }
  });

  const api = {
    calls,
    async sendText(text, fromId = USER_ID) {
      const message = { ...base(fromId), text };
      if (text.startsWith('/')) {
        message.entities = [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }];
      }
      await bot.handleUpdate({ update_id: ++updateId, message });
    },
    async sendMedia(fields) {
      await bot.handleUpdate({ update_id: ++updateId, message: { ...base(USER_ID), ...fields } });
    },
    async press(data, fromId = USER_ID) {
      await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          from: { id: fromId, is_bot: false, first_name: 'Тест' },
          chat_instance: 'x',
          data,
          message: { ...base(USER_ID), text: 'старое сообщение' }
        }
      });
    },
    texts() {
      return calls
        .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
        .map((c) => c.payload.text);
    },
    lastText() {
      const all = api.texts();
      return all[all.length - 1];
    },
    lastEdit() {
      const edits = calls.filter((c) => c.method === 'editMessageText');
      return edits[edits.length - 1]?.payload;
    },
    alerts() {
      return calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload);
    }
  };
  return { bot, api };
}

export async function listDir(dir) {
  try {
    return (await fs.promises.readdir(dir)).sort();
  } catch {
    return [];
  }
}

export async function readFirst(dir) {
  const [name] = await listDir(dir);
  return { name, text: await fs.promises.readFile(path.join(dir, name), 'utf-8') };
}
