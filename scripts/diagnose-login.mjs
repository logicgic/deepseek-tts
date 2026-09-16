// A bounded, read-only navigation probe. No query strings, cookies or headers are logged.
import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { PROFILE_DIR, DEEPSEEK_ORIGIN } from '../src/config.mjs';

const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: true });
const counts = new Map();
const paths = [];
try {
  const page = context.pages()[0] || await context.newPage();
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(frame.url());
    paths.push({ origin: url.origin, path: url.pathname });
  });
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (!['https:', 'http:'].includes(url.protocol) || ![DEEPSEEK_ORIGIN, 'https://open.weixin.qq.com', 'https://lp.open.weixin.qq.com'].includes(url.origin)) return;
    const key = `${request.method()} ${url.origin}${url.pathname}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  await page.goto(DEEPSEEK_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await delay(12_000);
  const loginTransitions = paths.filter((entry) => entry.path === '/sign_in').length;
  const repeated = paths.length > 5 || loginTransitions > 1;
  console.log(JSON.stringify({ navigation: paths, repeatedRedirect: repeated, requests: Object.fromEntries(counts) }, null, 2));
  process.exitCode = repeated ? 1 : 0;
} finally {
  await context.close();
}
