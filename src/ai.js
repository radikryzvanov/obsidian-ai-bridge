
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();
 
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
 
export async function processContent({ text, mimeType, dataBase64 }) {
  const prompt = `Ты — ассистент по ведению личной базы знаний в Obsidian.
Твоя задача — структурировать полученную информацию:
1. Придумай краткий, понятный заголовок для заметки (максимум 5-6 слов).
2. Выдели главное, разбей на тезисы в формате Markdown (если есть код — оформи в кодовые блоки).
3. Подбери 3-5 релевантных тегов на русском или английском.
 
Ответь СТРОГО в формате JSON:
{
  "title": "Заголовок заметки",
  "content": "Отформатированный Markdown-текст",
  "tags": ["tag1", "tag2"]
}`;
 
  const contents = [];
 
  if (mimeType && dataBase64) {
    contents.push({
      inlineData: {
        mimeType,
        data: dataBase64
      }
    });
  }
 
  contents.push(text ? `${prompt}\n\nВходной текст:\n${text}` : prompt);
 
  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: contents,
    config: {
      responseMimeType: 'application/json'
    }
  });
 
  return JSON.parse(response.text);
}