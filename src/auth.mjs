import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { AUTH_FILE, DEEPSEEK_ORIGIN } from './config.mjs';
import { AppError } from './errors.mjs';

export const CLIENT_HEADER_NAMES = [
  'user-agent', 'x-device-id', 'x-device-model', 'x-client-platform',
  'x-client-version', 'x-client-bundle-id', 'x-client-locale',
  'x-client-timezone-offset', 'x-hif-leim', 'x-hif-dliq',
];

export function readSessionValues(storageState) {
  const origin = storageState?.origins?.find((entry) => entry.origin === DEEPSEEK_ORIGIN);
  const values = new Map(origin?.localStorage?.map(({ name, value }) => [name, value]) || []);
  let token;
  try { token = JSON.parse(values.get('userToken') || 'null')?.value; } catch { /* Invalid saved state is rejected below. */ }
  if (typeof token !== 'string' || !token || /[\r\n]/u.test(token)) {
    throw new AppError('LOGIN_REQUIRED', '请先运行 npm run login 完成登录。', 401);
  }
  return { token, values };
}

export async function saveSession(storageState, clientHeaders = {}, file = AUTH_FILE) {
  readSessionValues(storageState);
  const headers = Object.fromEntries(CLIENT_HEADER_NAMES
    .filter((name) => typeof clientHeaders[name] === 'string')
    .map((name) => [name, clientHeaders[name]]));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), clientHeaders: headers, storageState }), { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600);
}

export async function loadSession(file = AUTH_FILE) {
  let saved;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new AppError('LOGIN_REQUIRED', '请先运行 npm run login 完成登录。', 401);
    throw new AppError('AUTH_FILE_INVALID', '无法读取登录会话，请重新运行 npm run login。', 401);
  }
  const state = saved.storageState || saved;
  const { token, values } = readSessionValues(state);
  const jar = new CookieJar();
  for (const item of state.cookies || []) {
    if (typeof item.domain !== 'string' || !(item.domain === 'deepseek.com' || item.domain.endsWith('.deepseek.com'))) continue;
    if (item.expires > 0 && item.expires * 1000 <= Date.now()) continue;
    const cookie = [`${item.name}=${item.value}`, `Path=${item.path || '/'}`];
    if (item.domain.startsWith('.')) cookie.push(`Domain=${item.domain}`);
    if (item.secure) cookie.push('Secure');
    if (item.httpOnly) cookie.push('HttpOnly');
    if (item.expires > 0) cookie.push(`Expires=${new Date(item.expires * 1000).toUTCString()}`);
    try { await jar.setCookie(cookie.join('; '), `https://${item.domain.replace(/^\./u, '')}${item.path || '/'}`); }
    catch { throw new AppError('AUTH_FILE_INVALID', '登录文件中的 Cookie 无效，请重新登录。', 401); }
  }
  const headers = {
    'x-client-platform': 'web', 'x-client-version': '2.5.0',
    'x-client-bundle-id': 'com.deepseek.chat', 'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': '28800', 'x-device-model': '',
  };
  for (const name of CLIENT_HEADER_NAMES) {
    const value = saved.clientHeaders?.[name];
    if (typeof value === 'string' && !/[\r\n]/u.test(value)) headers[name] = value;
  }
  const deviceId = values.get('deepseek-device-id:chat');
  if (deviceId && !/[\r\n]/u.test(deviceId)) headers['x-device-id'] = deviceId;
  for (const [key, header] of [['hif_leim_cached', 'x-hif-leim'], ['hif_dliq_cached', 'x-hif-dliq']]) {
    try {
      const value = JSON.parse(values.get(key) || 'null');
      if (typeof value === 'string' && !/[\r\n]/u.test(value)) headers[header] = value;
    } catch { /* Optional cache entries are not authentication credentials. */ }
  }
  return { token, headers, jar, savedAt: saved.savedAt || null };
}
