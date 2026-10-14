import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, cleanup } from './helpers.js';
import { checkAnswer, setClientForTests, retryConfig } from '../src/ai.js';
import { config } from '../src/config.js';
import { friendlyError } from '../src/index.js';

let env;
beforeEach(async () => {
  env = await setupEnv();
  retryConfig.delayMs = 1;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODEL;
});
afterEach(async () => {
  setClientForTests(undefined);
  await cleanup(env.root);
});

function fakeClient(handler) {
  const calls = [];
  const client = {
    models: {
      generateContent: async (params) => {
        calls.push(params.model);
        return handler(params, calls.length);
      }
    }
  };
  return { client, calls };
}

const ok = { text: JSON.stringify({ verdict: 'correct', feedback: 'Верно.' }) };
const overloaded = () => Object.assign(new Error('The model is overloaded'), { status: 503 });
const input = { question: 'q', referenceAnswer: 'a', userAnswer: 'a' };

test('запасная модель по умолчанию отличается от основной', () => {
  assert.equal(config.model, 'gemini-3.6-flash');
  assert.equal(config.fallbackModel, 'gemini-3.8-flash');
  process.env.GEMINI_MODEL = 'gemini-3.8-flash';
  assert.equal(config.fallbackModel, 'gemini-3.6-flash');
  process.env.GEMINI_FALLBACK_MODEL = '';
  assert.equal(config.fallbackModel, '');
});

test('при перегрузке основной модели запрос уходит в запасную', async () => {
  const { client, calls } = fakeClient((params) => {
    if (params.model === 'gemini-3.6-flash') throw overloaded();
    return ok;
  });
  setClientForTests(client);

  const result = await checkAnswer(input);
  assert.equal(result.verdict, 'correct');
  assert.deepEqual(calls, ['gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.8-flash']);
});

test('временная ошибка проходит с повтора, запасная модель не нужна', async () => {
  const { client, calls } = fakeClient((_params, n) => {
    if (n === 1) throw overloaded();
    return ok;
  });
  setClientForTests(client);
  await checkAnswer(input);
  assert.deepEqual(calls, ['gemini-3.6-flash', 'gemini-3.6-flash']);
});

test('ошибка самого запроса (400) не повторяется и не переключает модель', async () => {
  const { client, calls } = fakeClient(() => {
    throw Object.assign(new Error('bad request'), { status: 400 });
  });
  setClientForTests(client);
  await assert.rejects(() => checkAnswer(input), /bad request/);
  assert.equal(calls.length, 1);
});

test('если сбой у обеих моделей, ошибка доходит до пользователя', async () => {
  const { client, calls } = fakeClient(() => {
    throw overloaded();
  });
  setClientForTests(client);
  await assert.rejects(() => checkAnswer(input), /overloaded/);
  assert.equal(calls.length, 5); // 3 попытки основной + 2 запасной
});

test('понятные тексты ошибок содержат код', () => {
  assert.match(friendlyError({ status: 503 }), /перегружен \(503\)/);
  assert.match(friendlyError({ status: 500 }), /Временная ошибка.*500/);
  assert.match(friendlyError({ status: 429 }), /лимит.*429/i);
  assert.match(friendlyError({ status: 404 }), /GEMINI_MODEL/);
  assert.match(friendlyError({ status: 400, message: 'invalid schema' }), /400.*invalid schema/);
  assert.match(friendlyError({ status: 401 }), /GEMINI_API_KEY/);
  assert.match(
    friendlyError({ message: 'fetch failed', cause: { code: 'ETIMEDOUT' } }),
    /Нет связи с серверами Gemini \(ETIMEDOUT\).*VPN/
  );
  assert.match(friendlyError(new Error('fetch failed')), /Нет связи с серверами Gemini\. Проверьте/);
});
