import test from 'node:test';
import assert from 'node:assert/strict';
import { solvePow } from '../src/pow.mjs';

test('bundled WASM runs in a worker without research files', async () => {
  await assert.rejects(solvePow({
    algorithm: 'DeepSeekHashV1', challenge: '0'.repeat(64), salt: 'test',
    signature: 'test', difficulty: 1, expire_at: 2_000_000_000,
  }), { code: 'POW_NO_SOLUTION' });
});
