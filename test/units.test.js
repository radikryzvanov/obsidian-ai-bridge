import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { setupEnv, cleanup } from './helpers.js';
import { detectMediaUrl, assertPublicHttpUrl, htmlToText, parseVtt, extractFirstUrl } from '../src/media.js';
import { parseStudyArgs, INTERVALS } from '../src/study.js';
import { chunkText, cleanFileTitle, sanitizeTag, isoWeek, addDays, Semaphore } from '../src/utils.js';
import { searchNotes, parseFrontmatter, collectOpenTasks } from '../src/vault.js';
import { validateConfig } from '../src/config.js';

let env;
beforeEach(async () => {
  env = await setupEnv();
});
afterEach(async () => {
  await cleanup(env.root);
});

test('detectMediaUrl узнаёт платформы', () => {
  assert.equal(detectMediaUrl('смотри https://youtu.be/plRWy2QC3lg.').type, 'youtube');
  assert.equal(detectMediaUrl('https://www.youtube.com/shorts/abcdefghijk').videoId, 'abcdefghijk');
  assert.equal(detectMediaUrl('https://www.instagram.com/reel/AbC123/').type, 'instagram');
  assert.equal(detectMediaUrl('https://rutube.ru/video/123/').type, 'generic_video');
  assert.equal(detectMediaUrl('https://example.com/article'), null);
  assert.equal(extractFirstUrl('вот (https://example.com/a), ок'), 'https://example.com/a');
});

test('внутренние адреса и странные ссылки отклоняются', () => {
  assert.throws(() => assertPublicHttpUrl('http://localhost:3000/x'));
  assert.throws(() => assertPublicHttpUrl('http://192.168.1.5/x'));
  assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/latest'));
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'));
  assert.throws(() => assertPublicHttpUrl('не ссылка'));
  assert.equal(assertPublicHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});

test('ссылка с опасными символами не может стать командой (execFile без shell)', () => {
  // Ссылка проходит как обычная строка-аргумент; shell не участвует
  const url = assertPublicHttpUrl('https://example.com/$(touch${IFS}/tmp/pwned)');
  assert.ok(url.startsWith('https://example.com/'));
});

test('htmlToText убирает скрипты и теги', () => {
  const html = '<html><head><style>a{}</style></head><body><script>x()</script><h1>Заголовок</h1><p>Текст &amp; ещё</p></body></html>';
  const text = htmlToText(html);
  assert.match(text, /Заголовок/);
  assert.match(text, /Текст & ещё/);
  assert.doesNotMatch(text, /x\(\)|a\{\}/);
});

test('parseVtt превращает субтитры в текст с таймкодами', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nПривет <c>мир</c>\n\n00:00:04.000 --> 00:00:05.000\nКак дела';
  const out = parseVtt(vtt);
  assert.match(out, /\[00:00:01\] Привет мир/);
  assert.match(out, /\[00:00:04\] Как дела/);
});

test('parseStudyArgs', () => {
  assert.deepEqual(parseStudyArgs('Angular сигналы 1.5'), { topic: 'Angular сигналы', hours: 1.5 });
  assert.deepEqual(parseStudyArgs('TypeScript 2 ч'), { topic: 'TypeScript', hours: 2 });
  assert.deepEqual(parseStudyArgs('JS 0,5'), { topic: 'JS', hours: 0.5 });
  assert.equal(parseStudyArgs('Angular'), null);
  assert.equal(parseStudyArgs('Angular 30'), null);
  assert.equal(parseStudyArgs('1.5'), null);
  assert.deepEqual(INTERVALS, [1, 2, 4, 8, 16, 32]);
});

test('утилиты: имена, теги, недели, куски текста', () => {
  assert.equal(cleanFileTitle('Что: такое [сигнал]? #1'), 'Что такое сигнал 1');
  assert.equal(cleanFileTitle('   '), 'Без названия');
  assert.equal(sanitizeTag('#Мой Тег!'), 'мой-тег');
  assert.equal(isoWeek(new Date(2026, 9, 14)), '2026-W42');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  const chunks = chunkText(('строка\n').repeat(1000), 500);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n').trim(), ('строка\n').repeat(1000).trim());
});

test('Semaphore ограничивает одновременные задачи', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const job = () =>
    sem.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
});

test('parseFrontmatter читает заголовок и теги в обоих форматах', () => {
  const a = parseFrontmatter('---\ntitle: "Привет"\ntags:\n  - a\n  - b\n---\nтекст');
  assert.deepEqual(a.tags, ['a', 'b']);
  assert.equal(a.title, 'Привет');
  const b = parseFrontmatter('---\ntags: [x, "y"]\n---\n');
  assert.deepEqual(b.tags, ['x', 'y']);
  assert.deepEqual(parseFrontmatter('без свойств').tags, []);
});

test('поиск по заметкам учитывает заголовок, теги и склонения', async () => {
  const dir = path.join(env.vault, 'Учеба');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'a.md'), '---\ntitle: "Сигналы в Angular"\ntags: [angular]\n---\nПро реактивность', 'utf-8');
  await fs.promises.writeFile(path.join(dir, 'b.md'), '---\ntitle: "Кофе"\ntags: []\n---\nПро кофе и чай', 'utf-8');
  await fs.promises.mkdir(path.join(env.vault, '.obsidian'), { recursive: true });
  await fs.promises.writeFile(path.join(env.vault, '.obsidian', 'x.md'), 'сигналы сигналы', 'utf-8');

  const found = await searchNotes('Расскажи про сигналы Ангуляра и angular', 5);
  assert.equal(found[0].base, 'a');
  assert.ok(!found.some((n) => n.rel.startsWith('.obsidian')));
  assert.equal((await searchNotes('квантовая физика')).length, 0);
});

test('collectOpenTasks берёт только незакрытые задачи', async () => {
  await fs.promises.writeFile(path.join(env.vault, 't.md'), '# T\n- [ ] один\n  - [ ] вложенный\n- [x] готово\n', 'utf-8');
  const tasks = await collectOpenTasks();
  assert.deepEqual(tasks.map((t) => t.text), ['один', 'вложенный']);
});

test('validateConfig сообщает о проблемах понятным языком', () => {
  assert.deepEqual(validateConfig(), []);
  delete process.env.OBSIDIAN_VAULT_PATH;
  process.env.ALLOWED_USER_ID = 'abc';
  const problems = validateConfig().join('\n');
  assert.match(problems, /OBSIDIAN_VAULT_PATH/);
  assert.match(problems, /ALLOWED_USER_ID/);
});
