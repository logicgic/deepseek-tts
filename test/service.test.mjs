import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceService, normalizeText, validateChatInput } from '../src/service.mjs';

function fakeHttp(answers) {
  const calls = [];
  let reply = 0;
  return {
    calls, session: { headers: {} },
    async json(path, options) {
      calls.push({ path, json: options?.json });
      if (path.endsWith('/voices')) return { current_voice_id: 'a', default_voice_id: 'a', voices: [{ voice_id: 'a' }, { voice_id: 'b' }] };
      if (path.startsWith('/api/v0/client/settings')) return { settings: { model_configs: { value: [{ model_type: 'synthetic', enabled: true, is_default: true }] } } };
      if (path.endsWith('/create')) return { chat_session: { id: `chat-${reply}` } };
      if (path.endsWith('/create_pow_challenge')) return { challenge: {} };
      if (path.endsWith('/voice')) return {};
      throw new Error('unexpected request');
    },
    async request(path, options) {
      calls.push({ path, json: options?.json });
      const answer = answers[reply++];
      const sse = `data: ${JSON.stringify({ v: { response: { message_id: reply, role: 'ASSISTANT', status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: answer }] } } })}\n\nevent: finish\ndata: {}\n\n`;
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
}

test('normalization preserves internal spaces, punctuation and line count', () => {
  assert.equal(normalizeText(' \r\n你好\r\n世界\r\n'), '你好\n世界');
  assert.notEqual(normalizeText('价格￥10'), normalizeText('价格10元'));
  assert.notEqual(normalizeText('a  b'), normalizeText('a b'));
  assert.notEqual(normalizeText('a\n\nb'), normalizeText('a\nb'));
});

test('mismatched first answer is retried once; only the matching message reaches TTS', async () => {
  const http = fakeHttp(['改写结果', '原文']);
  const audioCalls = [];
  const service = new VoiceService(http, {
    powSolver: async () => 'synthetic-proof',
    audioDownloader: async (_http, args) => { audioCalls.push(args); return { pcm: Buffer.from([1, 0]) }; },
  });
  const result = await service.synthesize({ text: '原文', voice_id: 'b' });
  assert.equal(audioCalls.length, 1); assert.equal(audioCalls[0].messageId, 2);
  assert.equal(result.wav.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(http.calls.filter((call) => call.path.endsWith('/voice')).map((call) => call.json), [{ voice_id: 'b' }]);
});

test('two mismatches never set the voice or consume TTS', async () => {
  const http = fakeHttp(['不一致1', '不一致2']);
  let audioCalls = 0;
  const service = new VoiceService(http, { powSolver: async () => 'proof', audioDownloader: async () => { audioCalls++; } });
  await assert.rejects(service.synthesize({ text: '原文', voice_id: 'b' }), { code: 'TEXT_MISMATCH', status: 422 });
  assert.equal(audioCalls, 0);
  assert.equal(http.calls.some((call) => call.path.endsWith('/voice')), false);
});

test('invalid voice is rejected before creating a conversation', async () => {
  const http = fakeHttp([]);
  await assert.rejects(new VoiceService(http).synthesize({ text: '原文', voice_id: 'unknown' }), { code: 'INVALID_VOICE' });
  assert.equal(http.calls.length, 1);
});

test('chat sends the exact question and reads the generated answer without repetition or retry', async () => {
  const http = fakeHttp(['因为大气散射，天空呈蓝色。']);
  const audioCalls = [];
  const service = new VoiceService(http, {
    powSolver: async () => 'proof',
    audioDownloader: async (_http, args) => { audioCalls.push(args); return { pcm: Buffer.from([1, 0]) }; },
  });
  const result = await service.chat({ prompt: '天空为什么是蓝色？', voice_id: 'b' });
  const completions = http.calls.filter((call) => call.path.endsWith('/completion'));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].json.prompt, '天空为什么是蓝色？');
  assert.equal(completions[0].json.parent_message_id, null);
  assert.equal(result.text, '因为大气散射，天空呈蓝色。');
  assert.equal(audioCalls[0].messageId, 1);
  assert.equal(audioCalls[0].sessionId, result.sessionId);
  assert.equal(result.voiceId, 'b');
});

test('chat follow-up reuses the session and exact parent instead of creating a new conversation', async () => {
  const http = fakeHttp(['这是接着上一轮的回答。']);
  const service = new VoiceService(http, { powSolver: async () => 'proof', audioDownloader: async () => ({ pcm: Buffer.from([1, 0]) }) });
  const result = await service.chat({ prompt: '再说详细些。', chat_session_id: 'existing-session', parent_message_id: 42 });
  assert.equal(result.sessionId, 'existing-session');
  assert.equal(http.calls.some((call) => call.path.endsWith('/create')), false);
  const completion = http.calls.find((call) => call.path.endsWith('/completion')).json;
  assert.equal(completion.parent_message_id, 42);
  assert.equal(completion.chat_session_id, 'existing-session');
});

test('empty and incomplete chat answers never reach audio', async () => {
  for (const incomplete of [false, true]) {
    const http = fakeHttp(['   ']);
    if (incomplete) http.request = async () => new Response(`data: ${JSON.stringify({ v: { response: { message_id: 1, role: 'ASSISTANT', status: 'WIP', fragments: [{ type: 'RESPONSE', content: '部分回答' }] } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    let audioCalls = 0;
    const service = new VoiceService(http, { powSolver: async () => 'proof', audioDownloader: async () => { audioCalls++; } });
    await assert.rejects(service.chat({ prompt: '你好' }), { code: incomplete ? 'CHAT_INCOMPLETE' : 'CHAT_EMPTY' });
    assert.equal(audioCalls, 0);
  }
});

test('chat validates continuation pairs and output format before contacting DeepSeek', () => {
  for (const input of [
    { prompt: 'hi', chat_session_id: 'session' },
    { prompt: 'hi', parent_message_id: 1 },
    { prompt: 'hi', chat_session_id: 'session', parent_message_id: -1 },
    { prompt: 'hi', response_format: 'mp3' },
    { prompt: 'hi', unknown: true },
    { prompt: ' ' },
  ]) assert.throws(() => validateChatInput(input), { code: 'INVALID_INPUT' });
  assert.equal(validateChatInput({ prompt: '你好' }).responseFormat, 'wav');
});
