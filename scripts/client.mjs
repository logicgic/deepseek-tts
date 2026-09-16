import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, localPort } from '../src/config.mjs';

const [command, ...args] = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const base = `http://127.0.0.1:${localPort()}`;
try {
  let response;
  if (command === 'voices') {
    response = await fetch(`${base}/voices`);
  } else if (command === 'speak' || command === 'chat') {
    const file = value('--file');
    const text = file ? await readFile(file, 'utf8') : value('--text');
    if (!text) throw new Error('请使用 --text "文本" 或 --file 文本文件路径，可选 --voice 音色ID --out 输出.wav');
    const isChat = command === 'chat';
    const sessionId = value('--session');
    const parent = value('--parent');
    response = await fetch(`${base}${isChat ? '/chat/tts' : '/tts'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(isChat
        ? { prompt: text, voice_id: value('--voice'), response_format: 'json', chat_session_id: sessionId, parent_message_id: parent === undefined ? undefined : Number(parent) }
        : { text, voice_id: value('--voice') }), signal: AbortSignal.timeout(310_000),
    });
  } else throw new Error('用法：npm run voices，npm run speak -- --text "你好"，或 npm run chat -- --text "讲一个故事"');
  if (!response.ok) {
    const result = await response.json();
    throw new Error(`${result.error?.code || response.status}: ${result.error?.message || '请求失败'}`);
  }
  if (command === 'voices') console.log(JSON.stringify(await response.json(), null, 2));
  else {
    let audio, duration, answer;
    if (command === 'chat') {
      answer = await response.json();
      if (answer.audio?.format !== 'wav' || typeof answer.audio.base64 !== 'string') throw new Error('服务没有返回 WAV 音频。');
      audio = Buffer.from(answer.audio.base64, 'base64');
      duration = answer.audio.duration_seconds;
      console.log(`DeepSeek：\n${answer.text}`);
    } else {
      if (!response.headers.get('content-type')?.startsWith('audio/wav')) throw new Error('服务没有返回 WAV 音频。');
      audio = Buffer.from(await response.arrayBuffer());
      duration = response.headers.get('x-audio-duration');
    }
    const file = path.resolve(value('--out') || path.join(ROOT, 'output', `speech-${Date.now()}.wav`));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, audio);
    if (answer) {
      await writeFile(`${file}.txt`, answer.text, 'utf8');
      await writeFile(`${file}.json`, JSON.stringify({ text: answer.text, chat_session_id: answer.chat_session_id, message_id: answer.message_id, voice_id: answer.voice_id, duration_seconds: duration }, null, 2));
      console.log(`续聊参数：--session ${answer.chat_session_id} --parent ${answer.message_id}`);
    }
    console.log(`已保存 ${file}（${duration} 秒）`);
  }
} catch (error) {
  console.error(error.cause?.code === 'ECONNREFUSED' ? 'API 尚未启动，请先运行 npm start。' : error.message);
  process.exitCode = 1;
}
