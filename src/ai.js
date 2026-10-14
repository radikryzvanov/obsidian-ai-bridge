import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { config } from './config.js';

let client;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiKey });
  return client;
}

// ---------- Схемы ответов (Gemini сам вернёт валидный JSON) ----------

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    content: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    related: { type: 'array', items: { type: 'string' } },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: { q: { type: 'string' }, a: { type: 'string' } },
        required: ['q', 'a']
      }
    }
  },
  required: ['title', 'content', 'tags']
};

const QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, answer: { type: 'string' } },
        required: ['question', 'answer']
      }
    }
  },
  required: ['questions']
};

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['correct', 'partial', 'wrong'] },
    feedback: { type: 'string' }
  },
  required: ['verdict', 'feedback']
};

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } }
  },
  required: ['answer', 'sources']
};

// ---------- Инструкции ----------

const COMMON_RULES = `
Всегда отвечай на русском языке. Пиши простыми словами, без воды и банальностей.
Верни JSON строго по схеме:
- title: точный заголовок сути, 3–6 слов, без кавычек и двоеточий.
- content: заметка в Markdown БЕЗ заголовка первого уровня (его добавит система). Не ставь [[ссылки]] в тексте.
- tags: 2–5 коротких тегов без #, без пробелов (например: tech, career, learning).
- related: до 5 имён заметок из списка «Существующие заметки» (копируй имя точно как в списке), только если они реально связаны по смыслу. Если подходящих нет — пустой массив. Ничего не выдумывай.
- cards: заполняй только если это требуется в режиме ниже, иначе пустой массив. Карточка: q — короткий вопрос, a — короткий точный ответ (1–2 предложения).
`;

const MODES = {
  note: `
Ты — персональный второй мозг и аналитический партнёр. Превращай любую мысль, идею, ситуацию, вопрос или голосовую заметку в структурированную заметку для Obsidian.
Адаптируйся к теме:
- Техническая тема: разбери компромиссы, риски, альтернативы и порядок реализации.
- Личная или жизненная: выдели суть, первопричину, скрытые мотивы или когнитивные искажения, дай взгляд со стороны.
- Деловая: оцени целесообразность, ресурсы, узкие места и первый шаг.
Обязательно: ясные шаги к действию (- [ ]) и 1–2 глубоких вопроса для размышления.
Если входное сообщение — аудио, сначала пойми речь, потом оформи как заметку. Если фото — извлеки текст и смысл.`,

  idea: `
Ты — трезвый бизнес-аналитик. Оцени идею: суть, для кого она, чем ценна, главные риски, как проверить её за 1–2 дня без вложений.
Заверши списком первых шагов (- [ ]) и одним вопросом, который нужно проверить первым.`,

  task: `
Преврати мысль в понятную задачу: результат одной фразой, шаги (- [ ]) в нужном порядке, что нужно подготовить, возможные препятствия.
Если срок или приоритет очевидны — укажи. Коротко и по делу.`,

  learn: `
Ты — терпеливый наставник по программированию. Объясни тему простыми словами, как новичку.
Структура: простое определение (1–2 предложения) → аналогия из обычной жизни → как это выглядит на практике (короткий пример кода в блоке \`\`\`, если тема про код) → частые ошибки → «Проверь себя» (3 вопроса) → чек-лист (- [ ]).
Заполни cards: 4–8 карточек для запоминания.`,

  video: `
Ты — аналитик обучающего контента. Сделай глубокий, содержательный конспект видео (лекции, урока, доклада, рилса).
Структура content:
- **Суть (TL;DR):** 2–3 предложения о главном посыле автора.
- **Карта видео:** хронологический список этапов с таймкодами [MM:SS] и коротким тезисом.
- **Разбор тем:** последовательно концепции, нюансы, код и инструменты, предостережения спикера. Без поверхностного пересказа.
- **Мини-задание:** одно практическое задание, которое можно сделать за 15–30 минут.
- **Проверь себя:** 5 вопросов (ответы не пиши).
- **Чек-лист:** конкретные действия (- [ ]).
В tags обязательно: learning, video и платформа (youtube или instagram, если известна).
Заполни cards: 5–10 карточек по главным понятиям.`,

  article: `
Ты — аналитик чтения. Сделай конспект статьи.
Структура content: **Суть (TL;DR)** → **Ключевые идеи** → **Детали и нюансы** → **Что применить** (- [ ]).
В tags обязательно: article. Заполни cards: 3–6 карточек по главным мыслям.`,

  review: `
Ты — коуч по личной эффективности. По дневнику, списку заметок, учёбе и задачам недели составь обзор недели.
Структура content: **Итоги** → **Чему научился** → **Что застряло и почему** → **3 приоритета на следующую неделю** → шаги (- [ ]).
Опирайся только на данные, не выдумывай событий. Тон: честный, поддерживающий. В tags обязательно: review.`
};

function buildInstruction(mode, notesIndex) {
  const index = notesIndex
    ? `\nСуществующие заметки (для поля related):\n${notesIndex}\n`
    : '\nСуществующих заметок пока нет — related оставь пустым массивом.\n';
  return `${MODES[mode] || MODES.note}\n${COMMON_RULES}${index}`;
}

const THINKING = {
  note: ThinkingLevel.LOW,
  idea: ThinkingLevel.LOW,
  task: ThinkingLevel.LOW,
  learn: ThinkingLevel.LOW,
  article: ThinkingLevel.LOW,
  video: ThinkingLevel.MEDIUM,
  review: ThinkingLevel.MEDIUM
};

// ---------- Общие помощники ----------

function parseJson(response) {
  const responseText = (response.text || '').trim();
  try {
    return JSON.parse(responseText);
  } catch {
    const first = responseText.indexOf('{');
    const last = responseText.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(responseText.slice(first, last + 1));
      } catch {
        // падаем ниже
      }
    }
    console.error('❌ Gemini вернул невалидный JSON:', responseText.slice(0, 500));
    throw new Error('Gemini вернул ответ не в формате JSON');
  }
}

function normalizeNote(raw) {
  if (!raw || typeof raw.title !== 'string' || typeof raw.content !== 'string') {
    throw new Error('Gemini вернул неполный ответ (нет заголовка или текста)');
  }
  return {
    title: raw.title.trim() || 'Без названия',
    content: raw.content.trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    related: Array.isArray(raw.related) ? raw.related.filter((t) => typeof t === 'string') : [],
    cards: Array.isArray(raw.cards)
      ? raw.cards.filter((c) => c && typeof c.q === 'string' && typeof c.a === 'string')
      : []
  };
}

// Повторяет запрос при временных ошибках (сеть, перегрузка), но не при ошибках запроса
async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status);
      if ([400, 401, 403, 404].includes(status)) throw error;
      console.error(`⚠️ Попытка ${attempt}/${attempts} не удалась: ${error.message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw lastError;
}

async function generate({ contents, instruction, schema, thinking = ThinkingLevel.LOW }) {
  return withRetry(() =>
    getClient().models.generateContent({
      model: config.model,
      contents,
      config: {
        systemInstruction: instruction,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        thinkingConfig: { thinkingLevel: thinking }
      }
    })
  );
}

// ---------- Заметки ----------

// Небольшие данные (текст, голос, фото) — прямо внутри запроса
export async function processContent({
  text,
  mimeType,
  dataBase64,
  mode = 'note',
  notesIndex = ''
}) {
  const contents = [];
  if (text) contents.push({ text });
  if (mimeType && dataBase64) {
    contents.push({ inlineData: { mimeType, data: dataBase64 } });
  }

  const response = await generate({
    contents,
    instruction: buildInstruction(mode, notesIndex),
    schema: NOTE_SCHEMA,
    thinking: THINKING[mode] ?? ThinkingLevel.LOW
  });
  return normalizeNote(parseJson(response));
}

// Большие файлы — сначала в Files API, потом ссылкой
export async function processLargeMedia({
  text,
  filePath,
  mimeType,
  mode = 'video',
  notesIndex = ''
}) {
  const ai = getClient();
  console.log(`📤 Загружаю файл в Gemini Files API: ${filePath}`);

  let uploaded = await withRetry(() => ai.files.upload({ file: filePath, config: { mimeType } }));

  try {
    let attempts = 0;
    while (uploaded.state === 'PROCESSING' && attempts < 60) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      uploaded = await ai.files.get({ name: uploaded.name });
      attempts++;
    }
    if (uploaded.state === 'FAILED') {
      throw new Error('Gemini не смог обработать загруженный файл.');
    }
    if (uploaded.state === 'PROCESSING') {
      throw new Error('Gemini слишком долго обрабатывает файл, попробуйте позже.');
    }

    const contents = [];
    if (text) contents.push({ text });
    contents.push({ fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || mimeType } });

    const response = await generate({
      contents,
      instruction: buildInstruction(mode, notesIndex),
      schema: NOTE_SCHEMA,
      thinking: THINKING[mode] ?? ThinkingLevel.MEDIUM
    });
    return normalizeNote(parseJson(response));
  } finally {
    ai.files.delete({ name: uploaded.name }).catch(() => {});
  }
}

// ---------- Вопросы к своей базе ----------

const ASK_INSTRUCTION = `
Ты отвечаешь на вопрос пользователя ТОЛЬКО по приведённым заметкам из его базы знаний.
Если в заметках ответа нет — так и скажи, ничего не выдумывай.
Пиши по-русски, простыми словами, обычным текстом без Markdown-разметки (короткие списки через дефис допустимы).
sources: имена заметок (поле base), на которые ты реально опирался.`;

export async function askVault({ question, notes }) {
  const material = notes
    .map((n) => `=== base: ${n.base}\n=== title: ${n.title}\n${n.text}`)
    .join('\n\n');
  const response = await generate({
    contents: [{ text: `Вопрос: ${question}\n\nЗаметки:\n${material}` }],
    instruction: ASK_INSTRUCTION,
    schema: ASK_SCHEMA,
    thinking: ThinkingLevel.LOW
  });
  const raw = parseJson(response);
  return {
    answer: String(raw.answer || '').trim(),
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s) => typeof s === 'string') : []
  };
}

// ---------- Квиз ----------

export async function generateQuiz({ topic, notes, count = 5 }) {
  const material = notes.length
    ? notes.map((n) => `### ${n.title}\n${n.text}`).join('\n\n').slice(0, 40000)
    : '';
  const instruction = `
Ты — преподаватель. Составь ${count} вопросов для проверки понимания.
${material ? 'Опирайся ТОЛЬКО на приведённые конспекты ученика.' : 'Конспектов нет, составь вопросы по теме из общих знаний.'}
Вопросы — на понимание, а не на зубрёжку. Формулируй просто, по-русски. answer — эталонный ответ в 1–3 предложениях.`;
  const response = await generate({
    contents: [{ text: `Тема: ${topic || 'по последним конспектам'}\n\n${material}` }],
    instruction,
    schema: QUIZ_SCHEMA,
    thinking: ThinkingLevel.LOW
  });
  const raw = parseJson(response);
  const questions = Array.isArray(raw.questions)
    ? raw.questions.filter((q) => q && q.question && q.answer)
    : [];
  return { questions };
}

export async function checkAnswer({ question, referenceAnswer, userAnswer }) {
  const instruction = `
Ты — доброжелательный преподаватель. Сравни ответ ученика с эталоном по смыслу, а не по словам.
verdict: correct (верно по сути), partial (верно частично), wrong (неверно).
feedback: 1–3 предложения простыми словами: что верно и чего не хватает. Не начинай с «Ответ».`;
  const response = await generate({
    contents: [
      {
        text: `Вопрос: ${question}\nЭталон: ${referenceAnswer}\nОтвет ученика: ${userAnswer}`
      }
    ],
    instruction,
    schema: CHECK_SCHEMA,
    thinking: ThinkingLevel.LOW
  });
  const raw = parseJson(response);
  const verdict = ['correct', 'partial', 'wrong'].includes(raw.verdict) ? raw.verdict : 'wrong';
  return { verdict, feedback: String(raw.feedback || '').trim() };
}

// ---------- Расшифровка голоса (ответы в квизе) ----------

const TRANSCRIBE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text']
};

export async function transcribeAudio({ dataBase64, mimeType = 'audio/ogg' }) {
  const instruction = `
Расшифруй речь из аудио дословно, на том языке, на котором говорит человек.
Верни только сказанный текст, без комментариев и пояснений.
Если речи нет или её невозможно разобрать — верни пустую строку.`;
  const response = await generate({
    contents: [{ inlineData: { mimeType, data: dataBase64 } }],
    instruction,
    schema: TRANSCRIBE_SCHEMA,
    thinking: ThinkingLevel.MINIMAL
  });
  const raw = parseJson(response);
  return String(raw.text || '').trim();
}

// ---------- Обзор недели ----------

export async function weeklyReview({ daily, notes, study, tasks, notesIndex = '' }) {
  const parts = [
    `Дневник за неделю:\n${daily || '(записей нет)'}`,
    `Заметки недели:\n${notes.map((n) => `- ${n.title} [${n.tags.join(', ')}]`).join('\n') || '(нет)'}`,
    `Учёба (часы): ${study.total} ч. ${study.lines.join('; ')}`,
    `Открытые задачи (${tasks.length}):\n${tasks.slice(0, 25).map((t) => `- ${t.text}`).join('\n') || '(нет)'}`
  ];
  const response = await generate({
    contents: [{ text: parts.join('\n\n').slice(0, 60000) }],
    instruction: buildInstruction('review', notesIndex),
    schema: NOTE_SCHEMA,
    thinking: THINKING.review
  });
  return normalizeNote(parseJson(response));
}
