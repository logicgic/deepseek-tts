import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiServer } from '../src/server.mjs';
import { SerialQueue } from '../src/queue.mjs';
import { wavFromPcm } from '../src/audio.mjs';
import { AppError } from '../src/errors.mjs';

async function api(t, service) {
  const server = createApiServer({ serviceFactory: async () => service, log: () => {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.shutdown(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('API returns a complete WAV and accepts voice selection', async (t) => {
  const base = await api(t, { synthesize: async (input) => {
    assert.equal(input.voice_id, 'synthetic');
    return { wav: wavFromPcm(Buffer.from([1, 0])), voiceId: 'synthetic', sessionId: 'chat', messageId: 2, seconds: 1 / 24000 };
  } });
  const response = await fetch(`${base}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好', voice_id: 'synthetic' }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal((await response.arrayBuffer()).byteLength, 46);
});

test('invalid requests and hostile web origins cannot trigger synthesis', async (t) => {
  let calls = 0;
  const base = await api(t, { synthesize: async () => { calls++; } });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hello"}' };
  assert.equal((await fetch(`${base}/tts`, { ...options, headers: { ...options.headers, origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(`${base}/tts`, { ...options, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/tts`, { ...options, body: '{"text":""}' })).status, 400);
  assert.equal((await fetch(`${base}/tts`, { ...options, body: JSON.stringify({ text: 'a'.repeat(5001) }) })).status, 413);
  assert.equal(calls, 0);
});

test('upstream failures are JSON errors and do not expose exception secrets', async (t) => {
  const base = await api(t, { voices: async () => { throw new Error('secret token must not leak'); }, authStatus: async () => { throw new AppError('LOGIN_EXPIRED', '请重新登录', 401); } });
  const failed = await fetch(`${base}/voices`);
  assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /secret token/u);
  assert.equal((await fetch(`${base}/auth/status`)).status, 401);
});

test('same-account jobs execute serially and queued cancellation never starts a job', async () => {
  const queue = new SerialQueue(2);
  const controller = new AbortController();
  let active = 0, max = 0, cancelledRan = false;
  const task = async () => { active++; max = Math.max(max, active); await delay(20); active--; return 'ok'; };
  const first = queue.run(task);
  const second = queue.run(() => { cancelledRan = true; }, controller.signal);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  const third = queue.run(task);
  await assert.rejects(queue.run(task), { code: 'QUEUE_FULL' });
  controller.abort();
  await Promise.all([first, rejected, third]);
  assert.equal(cancelledRan, false); assert.equal(max, 1);
});

test('chat endpoint can return both generated text and base64 WAV with continuation IDs', async (t) => {
  const wav = wavFromPcm(Buffer.from([8, 0]));
  const base = await api(t, { chat: async (input) => {
    assert.equal(input.prompt, '告诉我答案');
    return { wav, text: '这是答案。', voiceId: 'a', sessionId: 'session-a', messageId: 8, seconds: 1 / 24000 };
  } });
  const response = await fetch(`${base}/chat/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '告诉我答案', response_format: 'json' }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.text, '这是答案。');
  assert.equal(result.chat_session_id, 'session-a');
  assert.equal(result.message_id, 8);
  assert.deepEqual(Buffer.from(result.audio.base64, 'base64'), wav);
});

test('chat endpoint defaults to WAV and rejects malformed continuation before generation', async (t) => {
  let calls = 0;
  const base = await api(t, { chat: async () => {
    calls++;
    return { wav: wavFromPcm(Buffer.from([1, 0])), text: '回答', voiceId: 'a', sessionId: 'session', messageId: 2, seconds: 1 / 24000 };
  } });
  const post = (input) => fetch(`${base}/chat/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const success = await post({ prompt: '你好' });
  assert.equal(success.headers.get('content-type'), 'audio/wav');
  assert.equal(success.headers.get('x-deepseek-message-id'), '2');
  assert.equal((await success.arrayBuffer()).byteLength, 46);
  assert.equal((await post({ prompt: '继续', chat_session_id: 'session' })).status, 400);
  assert.equal(calls, 1);
});

test('chat and verbatim reading share one queue so voices cannot overlap', async (t) => {
  let active = 0, maximum = 0;
  const respond = async () => {
    active++; maximum = Math.max(maximum, active);
    await delay(25); active--;
    return { wav: wavFromPcm(Buffer.from([1, 0])), text: '回答', voiceId: 'a', sessionId: 'session', messageId: 2, seconds: 1 / 24000 };
  };
  const base = await api(t, { chat: respond, synthesize: respond });
  const responses = await Promise.all([
    fetch(`${base}/chat/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"你好"}' }),
    fetch(`${base}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"你好"}' }),
  ]);
  for (const response of responses) { assert.equal(response.status, 200); await response.arrayBuffer(); }
  assert.equal(maximum, 1);
});
