import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSession, saveSession, readSessionValues } from '../src/auth.mjs';
import { decodeEnvelope } from '../src/http-client.mjs';

test('saved login state restores token and only matching, unexpired cookies', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ds-voice-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const state = {
    origins: [{ origin: 'https://chat.deepseek.com', localStorage: [
      { name: 'userToken', value: JSON.stringify({ value: 'synthetic-token', __version: '0' }) },
      { name: 'deepseek-device-id:chat', value: 'synthetic-device' },
    ] }],
    cookies: [
      { name: 'valid', value: 'synthetic', domain: 'chat.deepseek.com', path: '/', secure: true, expires: -1 },
      { name: 'expired', value: 'old', domain: 'chat.deepseek.com', path: '/', expires: 1 },
      { name: 'foreign', value: 'foreign', domain: 'unrelated.example', path: '/', expires: -1 },
    ],
  };
  await saveSession(state, { 'user-agent': 'test-agent', authorization: 'must-not-be-extra-header' }, file);
  const loaded = await loadSession(file);
  assert.equal(loaded.token, 'synthetic-token');
  assert.equal(loaded.headers['x-device-id'], 'synthetic-device');
  assert.equal(loaded.headers.authorization, undefined);
  assert.equal(await loaded.jar.getCookieString('https://chat.deepseek.com/api/v0/users/current'), 'valid=synthetic');
  assert.equal(await loaded.jar.getCookieString('https://unrelated.example/'), '');
});

test('missing credentials and expired auth envelope have explicit errors', () => {
  assert.throws(() => readSessionValues({ origins: [] }), { code: 'LOGIN_REQUIRED' });
  assert.throws(() => decodeEnvelope({ code: 40003 }), { code: 'LOGIN_EXPIRED' });
  assert.throws(() => decodeEnvelope({ code: 0, data: { biz_code: 1 } }), { code: 'UPSTREAM_REJECTED' });
});
