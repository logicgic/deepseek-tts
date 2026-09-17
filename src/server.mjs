import { createServer as nodeServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LIMITS, localPort } from './config.mjs';
import { loadSession } from './auth.mjs';
import { DeepSeekHttp } from './http-client.mjs';
import { VoiceService, validateInput, validateChatInput } from './service.mjs';
import { SerialQueue } from './queue.mjs';
import { AppError, normalizeError } from './errors.mjs';
import { playWav } from './playback.mjs';

async function bodyJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError('CONTENT_TYPE', '请使用 Content-Type: application/json。', 415);
  if (Number(request.headers['content-length']) > LIMITS.maxBodyBytes) throw new AppError('BODY_TOO_LARGE', '请求体过大。', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LIMITS.maxBodyBytes) throw new AppError('BODY_TOO_LARGE', '请求体过大。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('INVALID_JSON', '请求体不是有效 JSON。', 400); }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createApiServer({
  serviceFactory = async (requestId) => new VoiceService(new DeepSeekHttp(await loadSession()), {
    onProgress: (stage) => console.log(JSON.stringify({ request_id: requestId, stage })),
  }),
  log = (record) => console.log(JSON.stringify(record)),
  player = playWav,
} = {}) {
  const queue = new SerialQueue(LIMITS.maxQueued);
  const shutdown = new AbortController();
  const server = nodeServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    const requestId = randomUUID();
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-request-id', requestId);
    const disconnected = new AbortController();
    response.once('close', () => {
      if (!response.writableEnded) disconnected.abort(new DOMException('Client disconnected', 'AbortError'));
    });
    const signal = AbortSignal.any([shutdown.signal, disconnected.signal, AbortSignal.timeout(LIMITS.jobTimeoutMs)]);
    try {
      const port = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!hosts.has(request.headers.host)) throw new AppError('LOCAL_ONLY', 'API 仅供本机访问。', 403);
      if (request.headers.origin && !hosts.has(new URL(request.headers.origin).host)) throw new AppError('CROSS_ORIGIN', '不接受其他网站发起的请求。', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('CROSS_ORIGIN', '不接受跨站请求。', 403);
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok', ...queue.status, limits: { max_characters: LIMITS.maxCharacters, timeout_ms: LIMITS.jobTimeoutMs } });
        return;
      }
      if (request.method === 'GET' && ['/voices', '/auth/status'].includes(url.pathname)) {
        const result = await queue.run(async () => {
          const service = await serviceFactory(requestId);
          return url.pathname === '/voices' ? service.voices(signal) : service.authStatus(signal);
        }, signal);
        if (!response.destroyed) sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && ['/tts', '/chat/tts'].includes(url.pathname)) {
        const input = await bodyJson(request);
        const isChat = url.pathname === '/chat/tts';
        let responseFormat = 'wav';
        if (isChat) responseFormat = validateChatInput(input).responseFormat;
        else validateInput(input);
        if (input.play !== undefined && typeof input.play !== 'boolean') throw new AppError('INVALID_PLAY', 'play 必须为布尔值。', 400);
        const result = await queue.run(async () => {
          const service = await serviceFactory(requestId);
          const audio = await (isChat ? service.chat(input, signal) : service.synthesize(input, signal));
          let playback = 'disabled';
          if (input.play !== false) {
            signal.throwIfAborted();
            try { playback = await player(audio.wav, signal); }
            catch (error) {
              signal.throwIfAborted();
              playback = 'failed';
              log({ request_id: requestId, status: 'playback_failed' });
            }
          }
          return { ...audio, playback };
        }, signal);
        signal.throwIfAborted();
        response.setHeader('x-audio-playback', result.playback);
        if (isChat && responseFormat === 'json') {
          sendJson(response, 200, {
            text: result.text,
            chat_session_id: result.sessionId,
            message_id: result.messageId,
            voice_id: result.voiceId,
            playback: result.playback,
            audio: { format: 'wav', sample_rate: 24000, channels: 1, duration_seconds: result.seconds, base64: result.wav.toString('base64') },
            request_id: requestId,
          });
          log({ request_id: requestId, status: 'completed', mode: 'chat', bytes: result.wav.length, seconds: result.seconds });
          return;
        }
        response.writeHead(200, {
          'content-type': 'audio/wav', 'content-length': result.wav.length,
          'content-disposition': `attachment; filename="speech-${requestId}.wav"`,
          'x-deepseek-session-id': encodeURIComponent(result.sessionId),
          'x-deepseek-message-id': String(result.messageId),
          'x-voice-id': encodeURIComponent(result.voiceId),
          'x-audio-duration': result.seconds.toFixed(3),
        });
        response.end(result.wav);
        log({ request_id: requestId, status: 'completed', bytes: result.wav.length, seconds: result.seconds });
        return;
      }
      throw new AppError('NOT_FOUND', '接口不存在。可用接口：GET /health、GET /auth/status、GET /voices、POST /tts、POST /chat/tts。', 404);
    } catch (error) {
      const safe = normalizeError(signal.aborted ? signal.reason : error);
      log({ request_id: requestId, status: 'failed', code: safe.code });
      if (!response.destroyed && !response.headersSent) sendJson(response, safe.status, { error: { code: safe.code, message: safe.message, details: safe.details }, request_id: requestId });
      else if (!response.destroyed) response.destroy();
    }
  });
  server.requestTimeout = LIMITS.jobTimeoutMs + 10_000;
  server.headersTimeout = 10_000;
  server.shutdown = () => {
    shutdown.abort(new DOMException('Server shutting down', 'AbortError'));
    server.close();
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = localPort();
  const server = createApiServer();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请勿重复启动同一账号的服务。` : `服务启动失败：${error.code || 'UNKNOWN'}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`DeepSeek 朗读 API：http://127.0.0.1:${port}（本机访问）`));
  process.once('SIGINT', () => server.shutdown());
  process.once('SIGTERM', () => server.shutdown());
}
