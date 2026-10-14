import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { setupEnv, cleanup, makeBot, fakeDeps, listDir, readFirst, USER_ID } from './helpers.js';
import { endQuiz } from '../src/study.js';
import { reminderTick, buildReminderText } from '../src/index.js';
import { dateStr } from '../src/utils.js';

let env;
beforeEach(async () => {
  env = await setupEnv();
  endQuiz(USER_ID);
});
afterEach(async () => {
  await cleanup(env.root);
});

const inbox = () => path.join(env.vault, 'Inbox');

test('текст превращается в заметку в Inbox с кнопками', async () => {
  const { api } = makeBot();
  await api.sendText('Хочу разобраться с сигналами');

  const { name, text } = await readFirst(inbox());
  assert.match(name, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_Тест note\.md$/);
  assert.match(text, /^---\ntitle: "Тест note"/);
  assert.match(text, /tags:\n {2}- test-tag\n {2}- second/);
  assert.match(text, /# Тест note/);

  const edit = api.lastEdit();
  assert.match(edit.text, /✅/);
  assert.equal(edit.reply_markup.inline_keyboard.flat().length, 4);
});

test('если ИИ упал, текст сохраняется как есть', async () => {
  const deps = fakeDeps({
    ai: {
      processContent: async () => {
        throw Object.assign(new Error('boom'), { status: 429 });
      }
    }
  });
  const { api } = makeBot(deps);
  await api.sendText('Важная мысль про проект');

  const { text } = await readFirst(inbox());
  assert.match(text, /Важная мысль про проект/);
  assert.match(text, /type: raw/);
  assert.match(api.lastEdit().text, /Сохранил текст как есть/);
  assert.match(api.lastEdit().text, /лимит/i);
});

test('чужому пользователю бот не отвечает', async () => {
  const { api } = makeBot();
  await api.sendText('привет', 999);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(await listDir(inbox()), []);
});

test('/d пишет в дневник, многострочный текст остаётся в одном пункте', async () => {
  const { api } = makeBot();
  await api.sendText('/d первая мысль');
  await api.sendText('/d вторая');

  const dailyDir = path.join(env.vault, 'Daily');
  const { text } = await readFirst(dailyDir);
  assert.match(text, /^# Дневник на \d{4}-\d{2}-\d{2}\n/);
  assert.match(text, /- \*\*\d{2}:\d{2}\*\* первая мысль/);
  assert.match(text, /- \*\*\d{2}:\d{2}\*\* вторая/);
});

test('кнопка «Переместить» работает и после перезапуска бота', async () => {
  const first = makeBot();
  await first.api.sendText('мысль для учёбы');
  const keyboard = first.api.lastEdit().reply_markup.inline_keyboard.flat();
  const moveData = keyboard.find((b) => b.text.includes('Учеба')).callback_data;

  const second = makeBot(); // «перезапуск»: реестр читается с диска
  await second.api.press(moveData);

  assert.deepEqual(await listDir(inbox()), []);
  assert.equal((await listDir(path.join(env.vault, 'Учеба'))).length, 1);
  assert.match(second.api.lastEdit().text, /Перемещено в папку/);
});

test('кнопка «Удалить» переносит заметку в .trash, а не стирает', async () => {
  const { api } = makeBot();
  await api.sendText('ненужная мысль');
  const del = api.lastEdit().reply_markup.inline_keyboard.flat().find((b) => b.text.includes('Удалить'));
  await api.press(del.callback_data);

  assert.deepEqual(await listDir(inbox()), []);
  assert.equal((await listDir(path.join(env.vault, '.trash'))).length, 1);
});

test('кнопка «Ссылку в дневник» не удаляет заметку', async () => {
  const { api } = makeBot();
  await api.sendText('мысль');
  const btn = api.lastEdit().reply_markup.inline_keyboard.flat().find((b) => b.text.includes('дневник'));
  await api.press(btn.callback_data);

  assert.equal((await listDir(inbox())).length, 1);
  const { text } = await readFirst(path.join(env.vault, 'Daily'));
  assert.match(text, /📌 \[\[\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_Тест note\|Тест note\]\]/);
});

test('связи ставятся только на реально существующие заметки', async () => {
  await fs.promises.mkdir(path.join(env.vault, 'Учеба'), { recursive: true });
  await fs.promises.writeFile(
    path.join(env.vault, 'Учеба', 'Angular сигналы.md'),
    '---\ntitle: "Angular сигналы"\ntags:\n  - angular\n---\n\n# Angular сигналы\nТекст',
    'utf-8'
  );
  const deps = fakeDeps({
    ai: {
      processContent: async () => ({
        title: 'Новая',
        content: 'Тело',
        tags: [],
        related: ['Angular сигналы', 'Выдуманная заметка'],
        cards: []
      })
    }
  });
  const { api } = makeBot(deps);
  await api.sendText('что-то про сигналы');

  const { text } = await readFirst(inbox());
  assert.match(text, /## Связанные заметки\n- \[\[Angular сигналы\|Angular сигналы\]\]/);
  assert.doesNotMatch(text, /Выдуманная/);
});

test('/tasks собирает незакрытые задачи', async () => {
  await fs.promises.mkdir(inbox(), { recursive: true });
  await fs.promises.writeFile(path.join(inbox(), 'a.md'), '# A\n- [ ] купить хлеб\n- [x] сделано\n', 'utf-8');
  const { api } = makeBot();
  await api.sendText('/tasks');
  assert.match(api.lastText(), /Открытых задач: 1/);
  assert.match(api.lastText(), /купить хлеб/);
  assert.doesNotMatch(api.lastText(), /сделано/);
});

test('/ask отвечает по заметкам и даёт ссылки', async () => {
  await fs.promises.mkdir(inbox(), { recursive: true });
  await fs.promises.writeFile(
    path.join(inbox(), 'Про сигналы.md'),
    '---\ntitle: "Про сигналы"\ntags: []\n---\n\nСигналы в Angular — реактивные значения.',
    'utf-8'
  );
  const { api } = makeBot();
  await api.sendText('/ask что такое сигналы в Angular?');
  const text = api.lastEdit().text;
  assert.match(text, /Ответ из заметок/);
  assert.match(text, /obsidian:\/\/open\?vault=Test%20Vault&file=Inbox%2F/);

  await api.sendText('/ask квантовая физика');
  assert.match(api.lastEdit().text, /Ничего не нашёл/);
});

test('квиз: вопросы, проверка ответов, итог пишется в дневник', async () => {
  await fs.promises.mkdir(inbox(), { recursive: true });
  await fs.promises.writeFile(path.join(inbox(), 'k.md'), '---\ntitle: "К"\ntags: [learning]\n---\nТекст', 'utf-8');
  const { api } = makeBot();

  await api.sendText('/quiz');
  assert.match(api.lastText(), /Вопрос 1 из 2/);

  await api.sendText('это реактивное значение'); // ответ на вопрос, а не новая заметка
  assert.match(api.lastText(), /Вопрос 2 из 2/);
  assert.deepEqual((await listDir(inbox())).length, 1); // новых заметок не появилось

  await api.sendText('блок интерфейса');
  assert.match(api.lastText(), /Результат: 2 из 2/);

  const { text } = await readFirst(path.join(env.vault, 'Daily'));
  assert.match(text, /🧠 Квиз по конспектам: 2 из 2/);

  await api.sendText('обычная мысль после квиза');
  assert.equal((await listDir(inbox())).length, 2);
});

test('/skip и /stop управляют квизом', async () => {
  await fs.promises.mkdir(inbox(), { recursive: true });
  await fs.promises.writeFile(path.join(inbox(), 'k.md'), '# К\nТекст', 'utf-8');
  const { api } = makeBot();
  await api.sendText('/quiz');
  await api.sendText('/skip');
  assert.match(api.texts().at(-2), /Эталонный ответ/);
  assert.match(api.lastText(), /Вопрос 2 из 2/);
  await api.sendText('/stop');
  assert.match(api.lastText(), /Квиз остановлен/);
});

test('карточки: создаются из конспекта и повторяются с интервалами', async () => {
  const deps = fakeDeps({
    ai: {
      processContent: async () => ({
        title: 'Сигналы',
        content: 'Тело',
        tags: ['learning'],
        related: [],
        cards: [{ q: 'Что такое signal?', a: 'Реактивное значение' }]
      })
    }
  });
  const { api } = makeBot(deps);
  await api.sendText('/learn сигналы');

  const { text } = await readFirst(inbox());
  assert.match(text, /## Карточки\nЧто такое signal\?::Реактивное значение/);
  assert.match(api.lastEdit().text, /Карточек для повторения: 1/);

  const cards = JSON.parse(await fs.promises.readFile(path.join(process.env.DATA_DIR, 'cards.json'), 'utf-8'));
  assert.equal(cards.cards.length, 1);

  // Сразу после создания карточка ещё не «просрочена» (повтор завтра)
  await api.sendText('/cards');
  assert.match(api.lastText(), /карточек нет/);

  // Сдвигаем срок на сегодня и проходим карточку
  cards.cards[0].due = dateStr();
  await fs.promises.writeFile(path.join(process.env.DATA_DIR, 'cards.json'), JSON.stringify(cards));
  await api.sendText('/cards');
  const shown = api.calls.filter((c) => c.method === 'sendMessage').at(-1).payload;
  const showData = shown.reply_markup.inline_keyboard[0][0].callback_data;
  await api.press(showData);
  assert.match(api.lastEdit().text, /💡 Реактивное значение/);

  const knowData = api.lastEdit().reply_markup.inline_keyboard[0][0].callback_data;
  await api.press(knowData);
  assert.match(api.lastEdit().text, /Повтор через 2 дн/);

  const after = JSON.parse(await fs.promises.readFile(path.join(process.env.DATA_DIR, 'cards.json'), 'utf-8'));
  assert.equal(after.cards[0].box, 1);
});

test('/study записывает часы и показывает итог недели', async () => {
  const { api } = makeBot();
  await api.sendText('/study Angular сигналы 1,5');
  await api.sendText('/study Angular формы 2');
  assert.match(api.lastText(), /За 7 дней всего: 3\.5 ч/);

  await api.sendText('/study без часов');
  assert.match(api.lastText(), /Напишите тему и часы/);

  const { text } = await readFirst(path.join(env.vault, 'Daily'));
  assert.match(text, /📚 Учёба: Angular сигналы — 1\.5 ч/);
});

test('/review собирает неделю и сохраняет обзор в папку «Обзоры»', async () => {
  const { api } = makeBot();
  await api.sendText('/review');
  assert.match(api.lastText(), /нет записей/);

  await api.sendText('/d сегодня учился');
  await api.sendText('/review');
  assert.equal((await listDir(path.join(env.vault, 'Обзоры'))).length, 1);
  assert.match(api.texts().join('\n'), /Итоги недели/);
});

test('ссылка на статью обрабатывается как статья', async () => {
  let fetched;
  const deps = fakeDeps({
    media: {
      fetchArticleText: async (url) => {
        fetched = url;
        return { title: 'Про Angular', text: 'текст '.repeat(100) };
      }
    }
  });
  const { api } = makeBot(deps);
  await api.sendText('https://example.com/angular-signals');
  assert.equal(fetched, 'https://example.com/angular-signals');
  const { text } = await readFirst(inbox());
  assert.match(text, /source: "https:\/\/example.com\/angular-signals"/);
  assert.match(text, /> \[!info\] Источник: https:\/\/example.com/);
});

test('ссылка на YouTube с субтитрами даёт конспект видео', async () => {
  const { api } = makeBot();
  await api.sendText('https://youtu.be/plRWy2QC3lg');
  const { text } = await readFirst(inbox());
  assert.match(text, /type: video/);
  assert.match(text, /- learning\n {2}- video\n {2}- youtube/);
});

test('голосовое сообщение обрабатывается, большой файл — отклоняется с понятным текстом', async () => {
  const { api } = makeBot();
  await api.sendMedia({ voice: { file_id: 'v1', file_unique_id: 'u', duration: 3, mime_type: 'audio/ogg', file_size: 1000 } });
  assert.equal((await listDir(inbox())).length, 1);

  await api.sendMedia({ video: { file_id: 'v2', file_unique_id: 'u2', width: 1, height: 1, duration: 1, file_size: 50 * 1024 * 1024 } });
  assert.match(api.lastText(), /больше 20 МБ/);
  assert.equal((await listDir(inbox())).length, 1);
});

test('неизвестная команда не превращается в заметку', async () => {
  const { api } = makeBot();
  await api.sendText('/qwerty');
  assert.match(api.lastText(), /Неизвестная команда/);
  assert.deepEqual(await listDir(inbox()), []);
});

test('одинаковые заголовки в одну минуту не перезаписывают друг друга', async () => {
  const { api } = makeBot();
  await api.sendText('первая');
  await api.sendText('вторая');
  const files = await listDir(inbox());
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.endsWith('-2.md')));
});

test('напоминание: сообщает о карточках и шлёт один раз в день', async () => {
  const deps = fakeDeps({
    ai: {
      processContent: async () => ({
        title: 'Т',
        content: '- [ ] сделать шаг',
        tags: [],
        related: [],
        cards: [{ q: 'q', a: 'a' }]
      })
    }
  });
  const { api, bot } = makeBot(deps);
  await api.sendText('/learn что-то');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);

  const text = await buildReminderText(tomorrow);
  assert.match(text, /Карточек к повторению: 1/);
  assert.match(text, /Открытых задач: 1/);

  const before = api.calls.length;
  assert.equal(await reminderTick(bot.api, tomorrow), true);
  assert.equal(api.calls.length, before + 1);
  assert.equal(await reminderTick(bot.api, tomorrow), false); // повторно в тот же день — нет

  const early = new Date(tomorrow);
  early.setDate(early.getDate() + 1);
  early.setHours(6, 0, 0, 0);
  assert.equal(await reminderTick(bot.api, early), false); // раньше назначенного часа — нет
});
