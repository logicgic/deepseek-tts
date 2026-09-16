import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAnswer, PatchDecoder, applyPatch } from '../src/sse.mjs';

function stream(text, step = 1) {
  const bytes = Buffer.from(text);
  return (async function* () { for (let i = 0; i < bytes.length; i += step) yield bytes.subarray(i, i + step); })();
}
const event = (name, data) => `${name ? `event: ${name}\r\n` : ''}data: ${JSON.stringify(data)}\r\n\r\n`;
function initial(text = '') {
  return event('ready', { response_message_id: 2, request_message_id: 1 }) + event('', { v: {
    response: { message_id: 2, role: 'ASSISTANT', status: 'WIP', fragments: [{ type: 'RESPONSE', content: text }] },
  } });
}
const done = event('', { p: 'response/status', o: 'SET', v: 'FINISHED' });

test('SSE reconstructs unnamed patches across every UTF-8 and CRLF boundary', async () => {
  const input = initial() + event('', { p: 'response/fragments/0', o: 'BATCH', v: [
    { p: 'content', o: 'APPEND', v: '你好' }, { v: '，世界！' },
  ] }) + done + event('finish', {}) + event('close', {});
  const result = await collectAnswer(stream(input));
  assert.equal(result.text, '你好，世界！');
  assert.equal(result.messageId, 2);
});

test('BATCH scope inherits only within its own child parser', () => {
  const decoder = new PatchDecoder();
  const operations = decoder.parse({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'BATCH', v: [{ p: '-1/content', o: 'APPEND', v: 'A' }, { v: 'B' }] },
    { p: 'status', o: 'SET', v: 'FINISHED' },
  ] });
  assert.deepEqual(operations.map((x) => x.path), ['response/fragments/-1/content', 'response/fragments/-1/content', 'response/status']);
  assert.throws(() => decoder.parse({ v: 'not a batch' }), { code: 'CHAT_PROTOCOL' });
});

test('array insertion and negative index append match the upstream patch model', () => {
  let root = { response: { fragments: [{ content: 'A' }, { content: 'C' }] } };
  root = applyPatch(root, { path: 'response/fragments/1', op: 'APPEND', value: [{ content: 'B' }] });
  root = applyPatch(root, { path: 'response/fragments/-1/content', op: 'APPEND', value: 'D' });
  assert.deepEqual(root.response.fragments.map((f) => f.content), ['A', 'B', 'CD']);
  assert.throws(() => applyPatch(root, { path: 'response/__proto__/polluted', op: 'SET', value: true }), { code: 'CHAT_PROTOCOL' });
  assert.equal({}.polluted, undefined);
});

test('finish does not turn WIP text into a completed answer', async () => {
  await assert.rejects(collectAnswer(stream(initial('partial') + event('finish', {}))), { code: 'CHAT_INCOMPLETE' });
});

test('clear-response hint overrides previously completed text', async () => {
  await assert.rejects(collectAnswer(stream(initial('text') + done + event('hint', { type: 'error', clear_response: true }))), { code: 'CHAT_REJECTED' });
});

test('normal EOF with FINISHED is accepted, truncated SSE and transport failure are not', async () => {
  assert.equal((await collectAnswer(stream(initial('ok') + done))).text, 'ok');
  await assert.rejects(collectAnswer(stream(initial('ok') + done + 'data: {')), { code: 'CHAT_PROTOCOL' });
  const failing = (async function* () { yield Buffer.from(initial('ok') + done); throw new Error('network failure'); })();
  await assert.rejects(collectAnswer(failing), /network failure/u);
});

test('TTS uses response.message_id, and detects mutation within the stream', async () => {
  const input = initial('ok').replace('"response_message_id":2', '"response_message_id":99') + done;
  assert.equal((await collectAnswer(stream(input))).messageId, 2);
  await assert.rejects(collectAnswer(stream(initial('ok') + event('', { p: 'response/message_id', v: 3 }) + done)), { code: 'CHAT_PROTOCOL' });
});
