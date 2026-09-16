import { Worker } from 'node:worker_threads';
import { WASM_FILE, WASM_SHA256 } from './config.mjs';
import { AppError } from './errors.mjs';

export async function solvePow(challenge, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  if (challenge?.algorithm !== 'DeepSeekHashV1') throw new AppError('UNSUPPORTED_POW', 'DeepSeek 的计算挑战算法已变更。');
  for (const key of ['challenge', 'salt', 'signature']) {
    if (typeof challenge[key] !== 'string' || challenge[key].length > 4096) throw new AppError('UPSTREAM_PROTOCOL', '计算挑战参数无效。');
  }
  if (!Number.isFinite(challenge.difficulty) || challenge.difficulty <= 0 || !Number.isFinite(challenge.expire_at)) {
    throw new AppError('UPSTREAM_PROTOCOL', '计算挑战参数无效。');
  }
  const answer = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pow-worker.mjs', import.meta.url), {
      workerData: { challenge, file: WASM_FILE, sha256: WASM_SHA256 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new AppError('POW_TIMEOUT', '计算挑战超时，请稍后重试。', 504)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', (message) => message.error
      ? finish(new AppError(message.error, '未能完成 DeepSeek 计算挑战。'))
      : finish(null, message.answer));
    worker.once('error', () => finish(new AppError('POW_FAILED', '计算挑战执行失败。')));
    worker.once('exit', () => { if (!settled) finish(new AppError('POW_FAILED', '计算挑战意外终止。')); });
  });
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt,
    answer, signature: challenge.signature, target_path: '/api/v0/chat/completion',
  }), 'utf8').toString('base64');
}
