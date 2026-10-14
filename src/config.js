import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Настройки читаются из окружения в момент обращения (удобно для тестов).
export const config = {
  get telegramToken() { return process.env.TELEGRAM_BOT_TOKEN; },
  get allowedId() { return Number(process.env.ALLOWED_USER_ID); },
  get geminiKey() { return process.env.GEMINI_API_KEY; },
  get model() { return process.env.GEMINI_MODEL || 'gemini-3.6-flash'; },
  // Запасная модель: используется, если основная перегружена или отвечает ошибкой сервера
  get fallbackModel() {
    if (process.env.GEMINI_FALLBACK_MODEL !== undefined) return process.env.GEMINI_FALLBACK_MODEL.trim();
    return this.model === 'gemini-3.6-flash' ? 'gemini-3.8-flash' : 'gemini-3.6-flash';
  },
  get vaultPath() { return process.env.OBSIDIAN_VAULT_PATH; },
  get vaultName() { return process.env.OBSIDIAN_VAULT_NAME || 'Obsidian Vault'; },
  get dataDir() { return path.resolve(process.env.DATA_DIR || './data'); },
  get cookiesPath() { return process.env.YT_COOKIES_PATH || ''; },
  get ytdlpProxy() { return process.env.YTDLP_PROXY || ''; },
  // Час ежедневного напоминания. REMINDER_HOUR=off — отключить.
  get reminderHour() {
    const raw = (process.env.REMINDER_HOUR ?? '9').trim().toLowerCase();
    if (raw === 'off' || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 9;
  }
};

// Возвращает список проблем в настройках (пустой — всё хорошо)
export function validateConfig() {
  const problems = [];
  if (!config.telegramToken) problems.push('Не указан TELEGRAM_BOT_TOKEN');
  if (!Number.isInteger(config.allowedId) || config.allowedId <= 0) {
    problems.push('ALLOWED_USER_ID должен быть числом (ваш Telegram ID)');
  }
  if (!config.geminiKey) problems.push('Не указан GEMINI_API_KEY');
  if (!config.vaultPath) {
    problems.push('Не указан OBSIDIAN_VAULT_PATH (путь к папке хранилища Obsidian)');
  } else if (!fs.existsSync(config.vaultPath)) {
    problems.push(`Папка хранилища не найдена: ${config.vaultPath}`);
  }
  return problems;
}
