import WebSocket from 'ws';
import { LIMITS } from './config.mjs';
import { AppError } from './errors.mjs';

const reasons = new Map([
  [1, ['TTS_INTERNAL', '朗读服务内部错误。']],
  [2, ['TTS_INVALID_INPUT', '朗读请求参数无效。']],
  [3, ['TTS_UNAVAILABLE', '朗读服务暂不可用。']],
  [4, ['TTS_QUOTA', '朗读额度已用尽。']],
  [5, ['RATE_LIMITED', '朗读请求频率受限。']],
  [6, ['TTS_EMPTY', '回答没有可合成内容。']],
  [7, ['TTS_LANGUAGE', '当前文本语言不支持朗读。']],
  [8, ['TTS_VOICE_LANGUAGE', '所选音色不支持当前文本语言。']],
  [9, ['TTS_UNAVAILABLE', '当前会话无法使用朗读服务。']],
  [10, ['TTS_RESUME_EXPIRED', '音频续传已过期。']],
  [11, ['TTS_FORBIDDEN', 'DeepSeek 拒绝了朗读请求。']],
  [12, ['TTS_CONTENT_FILTER', '朗读内容被服务端过滤。']],
]);

export function wavFromPcm(pcm) {
  if (!pcm.length || pcm.length % 2 || pcm.length > 0xffffffff - 36) throw new AppError('AUDIO_INVALID', 'PCM 音频数据无效。');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function downloadPcm(http, { sessionId, messageId, signal, maxBytes = LIMITS.maxAudioBytes, idleMs = LIMITS.audioIdleMs }) {
  signal?.throwIfAborted();
  const { ticket } = await http.json('/api/v0/auth/ticket', { method: 'POST', json: { scope: 'tts' }, signal });
  if (typeof ticket !== 'string' || !ticket) throw new AppError('TTS_TICKET', '没有获取到朗读票据。');
  const url = new URL('/api/v0/chat/tts/', http.baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({
    chat_session_id: sessionId, message_id: String(messageId), ticket, mode: 'manual', format: 'pcm',
  }).toString();
  const cookie = await http.session.jar.getCookieString(new URL('/api/v0/chat/tts/', http.baseUrl).href);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      origin: http.baseUrl, handshakeTimeout: 10_000, maxPayload: 1024 * 1024,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(http.session.headers['user-agent'] ? { 'user-agent': http.session.headers['user-agent'] } : {}),
      },
    });
    let settled = false, ready = false, bytes = 0, nextSeq = 0, audioId;
    const chunks = [];
    let idleTimer;
    let ackTimer;
    const send = (value) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer); clearInterval(ackTimer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        send({ event: 'abort', reason: 'user_interrupt' });
        socket.terminate();
        reject(error);
      } else {
        send({ event: 'finish' });
        socket.close();
        const closeTimer = setTimeout(() => socket.terminate(), 1500);
        closeTimer.unref();
        socket.once('close', () => clearTimeout(closeTimer));
        resolve({ pcm: Buffer.concat(chunks, bytes), audioId, frames: nextSeq });
      }
    };
    const abort = () => finish(signal.reason);
    const touch = () => {
      if (settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(new AppError('AUDIO_TIMEOUT', '音频流长时间没有进展，未返回部分音频。', 504)), idleMs);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    touch();
    socket.on('open', () => {
      if (settled) return;
      touch();
      ackTimer = setInterval(() => {
        // A download does not render samples to a speaker. Do not invent a playback clock.
        if (ready) send({ event: 'ack', received_seq: nextSeq, played_seq: 0 });
      }, 1000);
    });
    socket.on('message', (data, binary) => {
      if (settled) return;
      try {
        if (binary) {
          if (!ready || data.length <= 4 || (data.length - 4) % 2) throw new AppError('AUDIO_PROTOCOL', 'PCM 分片结构无效。');
          const seq = data.readUInt32BE(0);
          const payload = data.subarray(4);
          if (seq < nextSeq) {
            if (!chunks[seq]?.equals(payload)) throw new AppError('AUDIO_PROTOCOL', '重复音频分片内容不一致。');
            return;
          }
          if (seq !== nextSeq) throw new AppError('AUDIO_GAP', '音频分片缺失，未返回不完整 WAV。');
          if (bytes + payload.length > maxBytes || nextSeq >= 100_000) throw new AppError('AUDIO_TOO_LARGE', '音频超过第一版大小限制。', 413);
          chunks.push(Buffer.from(payload)); bytes += payload.length; nextSeq++;
          touch();
          return;
        }
        const message = JSON.parse(data.toString('utf8'));
        if (message.event === 'ready') {
          if (ready || typeof message.audio_id !== 'string' || !message.audio_id) throw new AppError('AUDIO_PROTOCOL', '音频准备消息无效。');
          if ((message.format ?? 'pcm') !== 'pcm') throw new AppError('AUDIO_FORMAT', '服务端未接受 PCM 格式，未生成 WAV。');
          audioId = message.audio_id; ready = true; touch();
        } else if (message.event === 'finish') {
          if (message.code !== 0) {
            const [code, text] = reasons.get(message.code) || ['TTS_REJECTED', 'DeepSeek 未能完成朗读。'];
            throw new AppError(code, text, message.code === 5 ? 429 : 502, { upstream_code: message.code });
          }
          if (!ready || !bytes) throw new AppError('AUDIO_EMPTY', '朗读结束但没有收到音频。');
          send({ event: 'ack', received_seq: nextSeq, played_seq: 0 });
          finish();
        } else throw new AppError('AUDIO_PROTOCOL', '收到未知的音频控制消息。');
      } catch (error) {
        finish(error instanceof AppError ? error : new AppError('AUDIO_PROTOCOL', '音频协议解析失败。'));
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      finish(new AppError('TTS_HANDSHAKE', '朗读连接被服务端拒绝。', 502, { upstream_status: response.statusCode }));
    });
    socket.on('error', () => finish(new AppError('AUDIO_CONNECTION', '朗读连接失败，请检查网络和登录状态。')));
    socket.on('close', () => {
      if (!settled) finish(new AppError('AUDIO_INTERRUPTED', '音频流未成功结束，未返回部分 WAV。'));
    });
  });
}
