import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from './config.js';
import { UserError } from './utils.js';

const execFileAsync = util.promisify(execFile);

// ---------- Ссылки ----------

export function extractFirstUrl(text = '') {
  const match = String(text).match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[.,!?;)\]]+$/, '') : null;
}

// Не даём боту ходить на локальные и внутренние адреса
export function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserError('Некорректная ссылка.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UserError('Поддерживаются только ссылки http и https.');
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '0.0.0.0';
  if (isPrivate) throw new UserError('Ссылки на внутренние адреса не поддерживаются.');
  return url.toString();
}

// Видео: YouTube, Instagram, VK, RuTube, TikTok
export function detectMediaUrl(text = '') {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const matches = String(text).match(urlRegex);
  if (!matches) return null;

  for (const rawUrl of matches) {
    const cleanUrl = rawUrl.replace(/[.,!?;]+$/, '');

    const ytMatch = cleanUrl.match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/i
    );
    if (ytMatch) return { type: 'youtube', url: cleanUrl, videoId: ytMatch[1] };

    if (/instagram\.com\/(?:p|reel|tv)\/[a-zA-Z0-9_-]+/i.test(cleanUrl)) {
      return { type: 'instagram', url: cleanUrl };
    }

    if (/vk\.com\/video|rutube\.ru\/video|tiktok\.com/i.test(cleanUrl)) {
      return { type: 'generic_video', url: cleanUrl };
    }
  }
  return null;
}

// ---------- Настройки yt-dlp ----------

// Если YouTube снова начнёт ругаться («The page needs to be reloaded»),
// сначала обновите yt-dlp: pip install -U yt-dlp
const YTDLP_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=default,web_embedded'];

function ytdlpCommonArgs() {
  const args = [...YTDLP_CLIENT_ARGS];
  if (config.cookiesPath) args.push('--cookies', config.cookiesPath);
  if (config.ytdlpProxy) args.push('--proxy', config.ytdlpProxy);
  return args;
}

async function makeTempDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-'));
}

async function removeDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ---------- Субтитры YouTube ----------

async function fetchDirectSubtitles(videoId) {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: AbortSignal.timeout(20000)
    });
    const html = await pageRes.text();

    const captionsMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionsMatch) return null;

    const captionTracks = JSON.parse(captionsMatch[1]);
    if (!captionTracks || captionTracks.length === 0) return null;

    const track = captionTracks.find((t) => t.languageCode === 'ru') || captionTracks[0];
    if (!track || !track.baseUrl) return null;

    const subRes = await fetch(`${track.baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(20000) });
    const subJson = await subRes.json();
    if (!subJson.events) return null;

    const result = [];
    for (const ev of subJson.events) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8).join('').trim();
      if (!text || text === '\n') continue;

      const totalSec = Math.floor((ev.tStartMs || 0) / 1000);
      const m = Math.floor(totalSec / 60);
      const s = String(totalSec % 60).padStart(2, '0');
      result.push(`[${m}:${s}] ${text}`);
    }
    return result.length > 0 ? result.join('\n') : null;
  } catch {
    return null;
  }
}

export function parseVtt(rawContent) {
  const resultParts = [];
  for (const line of rawContent.split('\n')) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('WEBVTT') ||
      trimmed.startsWith('Kind:') ||
      trimmed.startsWith('Language:') ||
      /^\d+$/.test(trimmed)
    ) {
      continue;
    }
    if (trimmed.includes('-->')) {
      const timeMatch = trimmed.match(/(\d{2}:\d{2}:\d{2})/);
      if (timeMatch) resultParts.push(`\n[${timeMatch[1]}]`);
      continue;
    }
    resultParts.push(trimmed.replace(/<[^>]+>/g, ''));
  }
  return resultParts.join(' ').replace(/\s+/g, ' ').trim();
}

// Сначала прямой способ, если не вышло — через yt-dlp
export async function fetchYouTubeTranscript(url, videoId) {
  if (videoId) {
    const direct = await fetchDirectSubtitles(videoId);
    if (direct && direct.length > 50) {
      console.log('✅ Субтитры получены напрямую из плеера');
      return direct;
    }
  }

  const safeUrl = assertPublicHttpUrl(url);
  const dir = await makeTempDir();
  try {
    await execFileAsync(
      'yt-dlp',
      [
        ...ytdlpCommonArgs(),
        '--write-auto-sub',
        '--write-sub',
        '--sub-lang', 'all,-live_chat',
        '--skip-download',
        '--sub-format', 'vtt',
        '-o', path.join(dir, 'sub.%(ext)s'),
        '--', safeUrl
      ],
      { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }
    );

    const subFiles = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.vtt'));
    if (subFiles.length === 0) return null;

    const selected = subFiles.find((f) => f.includes('.ru')) || subFiles[0];
    const raw = await fs.promises.readFile(path.join(dir, selected), 'utf-8');
    return parseVtt(raw);
  } catch (error) {
    console.error('yt-dlp не смог получить субтитры:', error.message);
    return null;
  } finally {
    await removeDir(dir);
  }
}

// ---------- Аудио ----------

// Возвращает путь к файлу и функцию cleanup(), которую нужно вызвать после использования.
export async function downloadAudioWithYtDlp(url) {
  const safeUrl = assertPublicHttpUrl(url);
  const dir = await makeTempDir();
  try {
    await execFileAsync(
      'yt-dlp',
      [
        ...ytdlpCommonArgs(),
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '5',
        '-o', path.join(dir, 'audio.%(ext)s'),
        '--', safeUrl
      ],
      { timeout: 600000, maxBuffer: 10 * 1024 * 1024 }
    );

    const file = (await fs.promises.readdir(dir)).find((f) => f.startsWith('audio.'));
    if (!file) throw new Error('Файл аудио не найден');

    return {
      filePath: path.join(dir, file),
      mimeType: 'audio/mp3',
      cleanup: () => removeDir(dir)
    };
  } catch (error) {
    await removeDir(dir);
    if (error.code === 'ENOENT') {
      throw new UserError('На сервере не установлен yt-dlp.');
    }
    throw error;
  }
}

// ---------- Статьи ----------

const MAX_PAGE_BYTES = 3 * 1024 * 1024;

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|iframe|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export async function fetchArticleText(rawUrl) {
  const url = assertPublicHttpUrl(rawUrl);
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) throw new UserError(`Сайт ответил ошибкой ${res.status}.`);

  const type = res.headers.get('content-type') || '';
  if (!/text\/(html|plain)|application\/xhtml/i.test(type)) {
    throw new UserError('По этой ссылке не веб-страница (поддерживаются статьи).');
  }
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_PAGE_BYTES) throw new UserError('Страница слишком большая.');

  const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = htmlToText(html);

  if (text.length < 300) {
    throw new UserError('Не удалось вытащить текст со страницы (возможно, нужен вход или она грузится скриптами).');
  }
  return { title: titleMatch ? htmlToText(titleMatch[1]) : '', text: text.slice(0, 120000) };
}

// ---------- Файлы из Telegram ----------

export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;

export async function downloadTelegramFile(api, fileId) {
  const file = await api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new UserError(`Telegram не отдал файл (код ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
