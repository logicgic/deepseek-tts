import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from 'tough-cookie';
import { DeepSeekHttp } from '../src/http-client.mjs';

test('HTTP errors keep their API codes and release the response stream', async () => {
  for (const [status, headers, code] of [
    [200, { 'cf-mitigated': 'challenge' }, 'BROWSER_VERIFICATION_REQUIRED'],
    [401, {}, 'LOGIN_EXPIRED'],
    [403, {}, 'ACCESS_DENIED'],
    [429, {}, 'RATE_LIMITED'],
    [500, {}, 'UPSTREAM_HTTP'],
  ]) {
    let cancelled = false;
    const http = new DeepSeekHttp({ token: 'test', headers: {}, jar: new CookieJar() }, {
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers }),
    });
    await assert.rejects(http.request('/api/test'), { code });
    assert.equal(cancelled, true);
  }
});

test('successful HTTP responses restore cookies and decode the business envelope', async () => {
  const session = { token: 'test', headers: {}, jar: new CookieJar() };
  const http = new DeepSeekHttp(session, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer test');
      return Response.json({ code: 0, data: { biz_code: 0, biz_data: { value: 1 } } }, {
        headers: { 'set-cookie': 'session=test; Path=/; Secure' },
      });
    },
  });
  assert.deepEqual(await http.json('/api/test'), { value: 1 });
  assert.equal(await session.jar.getCookieString(http.baseUrl), 'session=test');
});
