import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

try {
  const { challenge, file, sha256 } = workerData;
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('POW_ASSET_INVALID');
  const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const write = (value) => {
    const encoded = encoder.encode(value);
    const ptr = wasm.__wbindgen_export_0(encoded.length, 1) >>> 0;
    new Uint8Array(wasm.memory.buffer, ptr, encoded.length).set(encoded);
    return [ptr, encoded.length];
  };
  const resultPtr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [challengePtr, challengeLength] = write(challenge.challenge);
    const [prefixPtr, prefixLength] = write(`${challenge.salt}_${challenge.expire_at}_`);
    wasm.wasm_solve(resultPtr, challengePtr, challengeLength, prefixPtr, prefixLength, challenge.difficulty);
    const result = new DataView(wasm.memory.buffer);
    const answer = result.getFloat64(resultPtr + 8, true);
    if (!result.getInt32(resultPtr, true) || !Number.isSafeInteger(answer) || answer < 0) throw new Error('POW_NO_SOLUTION');
    parentPort.postMessage({ answer });
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
} catch (error) {
  const allowed = new Set(['POW_ASSET_INVALID', 'POW_NO_SOLUTION']);
  parentPort.postMessage({ error: allowed.has(error.message) ? error.message : 'POW_FAILED' });
}
