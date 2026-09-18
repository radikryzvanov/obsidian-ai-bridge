import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
 
const execPromise = util.promisify(exec);
 
// 1. Определение ссылки
export function detectMediaUrl(text = '') {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const matches = text.match(urlRegex);
  if (!matches) return null;
 
  for (const rawUrl of matches) {
    const cleanUrl = rawUrl.replace(/[.,!?;]+$/, '');
 
    // YouTube
    const ytMatch = cleanUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/i);
    if (ytMatch) {
      return {
        type: 'youtube',
        url: cleanUrl,
        videoId: ytMatch[1]
      };
    }
 
    // Instagram
    if (/instagram\.com\/(?:p|reel|tv)\/[a-zA-Z0-9_-]+/i.test(cleanUrl)) {
      return { type: 'instagram', url: cleanUrl };
    }
 
    // Другие платформы (VK, RuTube, TikTok)
    if (/vk\.com\/video|rutube\.ru\/video|tiktok\.com/i.test(cleanUrl)) {
      return { type: 'generic_video', url: cleanUrl };
    }
  }
 
  return null;
}
 
// Прямой парсер субтитров через страницу YouTube (без капчи и без сторонних утилит)
async function fetchDirectSubtitles(videoId) {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    const html = await pageRes.text();
 
    const captionsMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionsMatch) return null;
 
    const captionTracks = JSON.parse(captionsMatch[1]);
    if (!captionTracks || captionTracks.length === 0) return null;
 
    const track = captionTracks.find(t => t.languageCode === 'ru') || captionTracks[0];
    if (!track || !track.baseUrl) return null;
 
    const subRes = await fetch(`${track.baseUrl}&fmt=json3`);
    const subJson = await subRes.json();
 
    if (!subJson.events) return null;
 
    const result = [];
    for (const ev of subJson.events) {
      if (!ev.segs) continue;
      const text = ev.segs.map(s => s.utf8).join('').trim();
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
 
// ВАЖНО: набор клиентов yt-dlp для обхода защиты YouTube от ботов.
// YouTube регулярно меняет, какие клиенты работают — если через какое-то
// время снова появится ошибка "The page needs to be reloaded", в первую
// очередь обновите сам yt-dlp (pip install -U yt-dlp), а если не поможет —
// поищите в issues репозитория yt-dlp на GitHub, какой клиент сейчас
// рекомендуют вместо android_vr.
const YTDLP_CLIENT_ARGS = '--extractor-args "youtube:player_client=default,web_embedded"';
 
// Куки из файла cookies.txt (экспортированного вручную из браузера) —
// надёжнее, чем читать куки напрямую из Chrome: Chrome с недавних версий
// шифрует куки так, что yt-dlp не может их прочитать напрямую (см.
// https://github.com/yt-dlp/yt-dlp/issues/10927). Файл cookies.txt не
// зависит от этой проблемы. Путь задаётся в .env через YT_COOKIES_PATH.
// Если переменная не задана — куки не используются вообще.
const cookiesPath = process.env.YT_COOKIES_PATH;
const YTDLP_COOKIES_ARGS = cookiesPath ? `--cookies "${cookiesPath}"` : '';
 
// Извлечение субтитров (сначала прямой способ, если не вышло — через yt-dlp)
export async function fetchYouTubeTranscript(url, videoId) {
  if (videoId) {
    const directTranscript = await fetchDirectSubtitles(videoId);
    if (directTranscript && directTranscript.length > 50) {
      console.log('✅ Субтитры успешно получены напрямую из плеера!');
      return directTranscript;
    }
  }
 
  const tempDir = os.tmpdir();
  const outputPrefix = `yt_sub_${Date.now()}`;
  const outputTemplate = path.join(tempDir, `${outputPrefix}.%(ext)s`);
  const subArgs = '--write-auto-sub --write-sub --sub-lang "all,-live_chat" --skip-download --sub-format vtt';
 
  try {
    await execPromise(`yt-dlp ${YTDLP_CLIENT_ARGS} ${YTDLP_COOKIES_ARGS} ${subArgs} -o "${outputTemplate}" "${url}"`, { timeout: 45000 });
 
    const files = await fs.promises.readdir(tempDir);
    const subFiles = files.filter(f => f.startsWith(outputPrefix) && f.endsWith('.vtt'));
 
    if (subFiles.length === 0) return null;
 
    const selectedFile = subFiles.find(f => f.includes('.ru')) || subFiles[0];
    const fullPath = path.join(tempDir, selectedFile);
    const rawContent = await fs.promises.readFile(fullPath, 'utf-8');
 
    for (const f of subFiles) {
      await fs.promises.unlink(path.join(tempDir, f)).catch(() => {});
    }
 
    const lines = rawContent.split('\n');
    const resultParts = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('WEBVTT') || trimmed.startsWith('Kind:') || trimmed.startsWith('Language:') || /^\d+$/.test(trimmed)) continue;
      if (trimmed.includes('-->')) {
        const timeMatch = trimmed.match(/(\d{2}:\d{2}:\d{2})/);
        if (timeMatch) resultParts.push(`\n[${timeMatch[1]}]`);
        continue;
      }
      resultParts.push(trimmed.replace(/<[^>]+>/g, ''));
    }
 
    return resultParts.join(' ').replace(/\s+/g, ' ').trim();
  } catch (error) {
    console.error('yt-dlp субтитры не смог получить:', error.message);
    return null;
  }
}
 
// Загрузка аудиодорожки через yt-dlp. Возвращает путь к файлу (не base64!) —
// для больших файлов (длинные лекции) base64 в памяти был бы слишком тяжёлым
// и не проходил бы через Gemini одним запросом. Вызывающий код сам решает,
// когда удалить временный файл (после успешной загрузки в Gemini).
export async function downloadAudioWithYtDlp(url) {
  const tempDir = os.tmpdir();
  const outputTemplate = path.join(tempDir, `bridge_audio_${Date.now()}.%(ext)s`);
 
  const command = `yt-dlp ${YTDLP_CLIENT_ARGS} ${YTDLP_COOKIES_ARGS} -x --audio-format mp3 --audio-quality 5 -o "${outputTemplate}" "${url}"`;
 
  await execPromise(command, { timeout: 600000 });
 
  const basePrefix = outputTemplate.replace('.%(ext)s', '');
  const files = await fs.promises.readdir(tempDir);
  const matchedFile = files.find(f => f.startsWith(path.basename(basePrefix)));
 
  if (!matchedFile) throw new Error('Файл аудио не найден');
 
  const filePath = path.join(tempDir, matchedFile);
 
  return {
    filePath,
    mimeType: 'audio/mp3'
  };
}