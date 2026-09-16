import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';
import { loadSession } from '../src/auth.mjs';
import { DeepSeekHttp } from '../src/http-client.mjs';
import { VoiceService } from '../src/service.mjs';
import { normalizeError } from '../src/errors.mjs';

try {
  const session = await loadSession();
  const service = new VoiceService(new DeepSeekHttp(session), { onProgress: (stage) => console.log(`stage=${stage}`) });
  const signal = AbortSignal.timeout(300_000);
  console.log(JSON.stringify(await service.authStatus(signal)));
  const voices = await service.voices(signal);
  console.log(JSON.stringify({ current_voice_id: voices.current_voice_id, voices: voices.voices.map((v) => ({ voice_id: v.voice_id, name: v.name })) }));
  if (process.argv.includes('--synthesize')) {
    const result = await service.synthesize({ text: '你好，这是语音接口测试。' }, signal);
    const directory = path.join(ROOT, 'output');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'live-test.wav');
    await writeFile(file, result.wav);
    console.log(JSON.stringify({ file, bytes: result.wav.length, seconds: result.seconds, voice_id: result.voiceId }));
  }
} catch (error) {
  const safe = normalizeError(error);
  console.error(JSON.stringify({ code: safe.code, message: safe.message, details: safe.details }));
  process.exitCode = 1;
}
