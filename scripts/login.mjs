import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AUTH_FILE, DEEPSEEK_ORIGIN, PROFILE_DIR } from '../src/config.mjs';
import { CLIENT_HEADER_NAMES, readSessionValues, saveSession } from '../src/auth.mjs';

async function browserChannel() {
  if (process.env.DS_BROWSER) return process.env.DS_BROWSER;
  if (process.platform === 'win32') {
    for (const [channel, filename] of [
      ['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['msedge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ]) {
      try { await access(filename); return channel; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return undefined;
}

let context;
let shuttingDown = false;
const stop = async () => {
  shuttingDown = true;
  if (context) await context.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: await browserChannel(), headless: false,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: null,
  });
  context.once('close', () => { shuttingDown = true; });
  const captured = {};
  let verifiedToken = null;
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== DEEPSEEK_ORIGIN || !url.pathname.startsWith('/api/')) return;
    const headers = request.headers();
    for (const key of CLIENT_HEADER_NAMES) if (headers[key] !== undefined) captured[key] = headers[key];
  });
  context.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.origin !== DEEPSEEK_ORIGIN || url.pathname !== '/api/v0/users/current' || response.status() !== 200) return;
    try {
      const body = await response.json();
      if (body.code === 0 && body.data?.biz_code === 0 && body.data.biz_data && typeof body.data.biz_data === 'object') {
        const authorization = response.request().headers().authorization;
        if (authorization?.startsWith('Bearer ')) verifiedToken = authorization.slice(7);
      }
    } catch { /* Navigation may dispose an in-flight response; wait for the next one. */ }
  });
  const page = context.pages()[0] || await context.newPage();
  console.log('请在打开的专用浏览器中完成 DeepSeek 登录。无需复制密码或 token。');
  console.log('脚本会自动保存已验证的登录会话；可用 Ctrl+C 取消。');
  await page.goto(DEEPSEEK_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const deadline = Date.now() + 15 * 60_000;
  while (!shuttingDown && Date.now() < deadline) {
    const storage = await context.storageState();
    let token;
    try { ({ token } = readSessionValues(storage)); } catch { /* Wait for the user's login. */ }
    if (token && token === verifiedToken) {
      captured['user-agent'] = await page.evaluate(() => navigator.userAgent);
      await saveSession(storage, captured);
      console.log(`登录会话已保存：${AUTH_FILE}`);
      console.log('之后运行 npm start；登录失效时重新运行 npm run login。');
      await stop();
      break;
    }
    await delay(1000);
  }
  if (!shuttingDown) {
    console.error('等待登录超时，尚未保存会话。请重新运行 npm run login。');
    process.exitCode = 1;
    await stop();
  }
} catch (error) {
  if (!shuttingDown) {
    console.error('登录脚本未完成。请关闭此项目已有的登录浏览器后重试；没有浏览器时先运行 npx playwright install chromium。');
    console.error(`错误类型：${error.name || 'Error'}（不会打印凭据）`);
    process.exitCode = 1;
  }
  if (context && !shuttingDown) await stop();
}
