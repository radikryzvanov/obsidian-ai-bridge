import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

async function testSubtitlesAndAudio() {
  const url = 'https://youtu.be/plRWy2QC3lg';
  const proxy = '--proxy "http://127.0.0.1:3067"';
  
  // Клиент android_vr обходит антибот-проверку YouTube
  const client = '--extractor-args "youtube:player_client=android_vr,web_safari"';

  console.log('1. Проверяю субтитры через android_vr клиент...');
  try {
    const cmdSub = `yt-dlp ${proxy} ${client} --list-subs "${url}"`;
    const { stdout } = await execPromise(cmdSub, { timeout: 30000 });
    console.log('--- ОТВЕТ ПО СУБТИТРАМ ---');
    console.log(stdout);
  } catch (err) {
    console.log('Субтитры ошибка:', err.message);
  }

  console.log('\n2. Проверяю аудиопоток через android_vr...');
  try {
    const cmdAudio = `yt-dlp ${proxy} ${client} -f "ba/ba*" --get-url "${url}"`;
    const { stdout } = await execPromise(cmdAudio, { timeout: 30000 });
    console.log('✅ Аудиопоток успешно получен!');
    console.log(stdout.slice(0, 120) + '...');
  } catch (err) {
    console.log('Аудио ошибка:', err.message);
  }
}

testSubtitlesAndAudio();