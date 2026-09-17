import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
export const AUTH_DIR = path.resolve(process.env.DS_AUTH_DIR || path.join(ROOT, '.auth'));
export const AUTH_FILE = path.join(AUTH_DIR, 'session.json');
export const PROFILE_DIR = path.join(AUTH_DIR, 'browser-profile');
export const WASM_FILE = path.join(ROOT, 'assets/sha3.wasm');
export const WASM_SHA256 = 'b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d';

export const LIMITS = Object.freeze({
  maxCharacters: 5000,
  maxBodyBytes: 128 * 1024,
  maxAudioBytes: 64 * 1024 * 1024,
  maxStreamBytes: 4 * 1024 * 1024,
  jobTimeoutMs: 300_000,
  requestTimeoutMs: 30_000,
  audioIdleMs: 30_000,
  maxQueued: 8,
});

export function localPort() {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
  return port;
}
