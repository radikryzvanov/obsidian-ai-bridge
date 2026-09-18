
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
 
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});
 
const SYSTEM_INSTRUCTION = `
Ты — персональный второй мозг, мудрый собеседник и аналитический партнёр.
Твоя задача — глубоко вникать в любую входящую мысль, идею, жизненную ситуацию, вопрос или голосовую заметку и превращать её в структурированную, осмысленную заметку для Obsidian.
 
Принципы глубокого анализа:
1. Адаптивность к контексту:
   - Если тема техническая (код, архитектура, инструменты): разбери технические компромиссы, риски, альтернативные подходы и порядок реализации.
   - Если тема жизненная или личная (решения, сомнения, привычки, отношения): выдели суть ситуации, первопричину, скрытые мотивы или когнитивные искажения, предложи взвешенный взгляд со стороны.
   - Если тема деловая (проекты, идеи заработка, планирование): оцени целесообразность, ресурсы, узкие места и первый шаг.
2. Никаких банальностей и воды: избегай очевидных нравоучений. Фокусируйся на сути, неочевидных деталях и конкретике.
3. Практический результат:
   - Сформулируй ясные шаги к действию (- [ ]).
   - Сформулируй 1-2 глубоких вопроса для размышления (на что обратить внимание, что перепроверить).
4. Связи для Obsidian: щедро расставляй двусторонние ссылки [[Понятие]], [[Сфера жизни]] или [[Проект]], чтобы мысли связывались в единую паутину смыслов.
5. Теги: подбирай семантические теги (например: #decision, #career, #psychology, #tech, #finance, #idea).
 
Формат ответа СТРОГО валидный JSON без markdown-блоков:
{
  "title": "Емкий, точный заголовок сути (3-5 слов)",
  "content": "Отредактированный, чистый структурированный текст заметки в Markdown",
  "tags": ["тег1", "тег2"]
}
`;
 
const VIDEO_SYSTEM_INSTRUCTION = `
Ты — экспертный аналитик обучающего контента и архитектор базы знаний Obsidian.
Твоя задача — сделать глубокий, содержательный инженерный конспект видеоматериала (лекции, урока, доклада или рилса).
 
Принципы анализа видеоматериалов:
1. Никаких поверхностных пересказов. Даже для лекции на 2-3 часа раскрой фундаментальную техническую суть, идеи автора, проблемы и их решения.
2. Структура заметки:
   - **Суть (TL;DR):** 2-3 ёмких предложения о главном посыле автора.
   - **Карта урока (Ключевые таймкоды):** хронологический список основных этапов с метками времени [MM:SS] и кратким тезисом.
   - **Глубокий разбор тем (Deep Dive):** последовательный разбор концепций, нюансов, разборов кода/инструментов и предостережений от спикера.
   - **Практический чек-лист (- [ ]):** конкретные действия или шаги, которые нужно применить/проверить на практике.
   - **Связи в графе:** ключевые понятия через [[Двусторонние ссылки]] для графа Obsidian.
3. Теги: семантические теги тематики видео + обязательно теги платформы/обучения (#learning, #video, #youtube или #instagram).
 
Формат ответа СТРОГО валидный JSON без markdown-блоков:
{
  "title": "Точный заголовок темы видео (до 5 слов)",
  "content": "Структурированный Markdown конспекта (Суть -> Карта с таймкодами -> Глубокий разбор -> Чек-лист шагов -> Связи [[...]])",
  "tags": ["тег1", "тег2"]
}
`;
 
function parseAiResponse(response) {
  const responseText = response.text.trim();
  return JSON.parse(responseText);
}
 
// Для небольших файлов (голосовые/фото из Telegram, обычно до нескольких МБ) —
// передаём данные прямо внутри запроса, как раньше.
export async function processContent({ text, mimeType, dataBase64, isMedia = false }) {
  const contents = [];
 
  if (text) {
    contents.push({ text });
  }
 
  if (mimeType && dataBase64) {
    contents.push({
      inlineData: {
        mimeType,
        data: dataBase64
      }
    });
  }
 
  const selectedInstruction = isMedia ? VIDEO_SYSTEM_INSTRUCTION : SYSTEM_INSTRUCTION;
  const budget = isMedia ? 2048 : 1024;
 
  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents,
    config: {
      systemInstruction: selectedInstruction,
      responseMimeType: 'application/json',
      thinkingConfig: {
        thinkingBudget: budget
      }
    }
  });
 
  return parseAiResponse(response);
}
 
// Для больших файлов (аудио из длинных YouTube-видео, лекций и т.д.) —
// сначала загружаем файл через Files API, потом ссылаемся на него.
// Это надёжнее, чем пытаться передать весь файл одним запросом.
export async function processLargeMedia({ text, filePath, mimeType, isMedia = true }) {
  console.log(`📤 Загружаю файл в Gemini Files API: ${filePath}`);
 
  let uploadedFile = await ai.files.upload({
    file: filePath,
    config: { mimeType }
  });
 
  // Файл обрабатывается на стороне Google некоторое время — ждём готовности
  let attempts = 0;
  while (uploadedFile.state === 'PROCESSING' && attempts < 30) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    uploadedFile = await ai.files.get({ name: uploadedFile.name });
    attempts++;
  }
 
  if (uploadedFile.state === 'FAILED') {
    throw new Error('Gemini не смог обработать загруженный файл.');
  }
 
  console.log('✅ Файл готов, отправляю запрос на анализ...');
 
  const contents = [];
  if (text) {
    contents.push({ text });
  }
  contents.push({
    fileData: {
      fileUri: uploadedFile.uri,
      mimeType: uploadedFile.mimeType
    }
  });
 
  const selectedInstruction = isMedia ? VIDEO_SYSTEM_INSTRUCTION : SYSTEM_INSTRUCTION;
 
  // Повторяем попытку при обрыве соединения — на больших файлах через VPN
  // это иногда случается один раз, но обычно проходит со второго-третьего раза
  let response;
  let lastError;
  const MAX_ATTEMPTS = 3;
 
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents,
        config: {
          systemInstruction: selectedInstruction,
          responseMimeType: 'application/json',
          thinkingConfig: {
            thinkingBudget: 2048
          }
        }
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.error(`⚠️ Попытка ${attempt}/${MAX_ATTEMPTS} не удалась:`, error.message);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
 
  if (lastError) {
    throw lastError;
  }
 
  // Файл на серверах Google можно удалить, он нам больше не нужен
  ai.files.delete({ name: uploadedFile.name }).catch(() => {});
 
  return parseAiResponse(response);
}