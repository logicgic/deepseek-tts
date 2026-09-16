import { DEEPSEEK_ORIGIN, LIMITS } from './config.mjs';
import { AppError, assertRecord } from './errors.mjs';

export async function readLimited(response, maxBytes = LIMITS.maxStreamBytes) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw new AppError('UPSTREAM_PROTOCOL', '服务端返回空响应。');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError('UPSTREAM_TOO_LARGE', '服务端响应超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function decodeEnvelope(body) {
  assertRecord(body);
  if ([40002, 40003].includes(body.code)) {
    throw new AppError('LOGIN_EXPIRED', '登录凭据无效，请重新运行 npm run login。', 401);
  }
  if (body.code !== 0) throw new AppError('UPSTREAM_REJECTED', 'DeepSeek 拒绝了请求。', 502, { upstream_code: body.code });
  assertRecord(body.data);
  if (body.data.biz_code !== 0) {
    throw new AppError('UPSTREAM_REJECTED', 'DeepSeek 未能完成请求。', 502, { business_code: body.data.biz_code });
  }
  return body.data.biz_data;
}

export class DeepSeekHttp {
  constructor(session, { baseUrl = DEEPSEEK_ORIGIN, fetchImpl = fetch } = {}) {
    this.session = session;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async headers(url, extra = {}) {
    const cookie = await this.session.jar.getCookieString(url);
    return {
      ...this.session.headers,
      authorization: `Bearer ${this.session.token}`,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      ...(cookie ? { cookie } : {}),
      ...extra,
    };
  }

  async request(path, { method = 'GET', json, signal, headers = {}, timeoutMs = LIMITS.requestTimeoutMs } = {}) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) throw new AppError('INVALID_UPSTREAM', '上游请求地址无效。');
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
    combinedSignal.throwIfAborted();
    const response = await this.fetchImpl(url, {
      method, redirect: 'error', signal: combinedSignal,
      headers: await this.headers(url.href, {
        accept: 'application/json', ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
      }),
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    for (const cookie of response.headers.getSetCookie?.() || []) {
      await this.session.jar.setCookie(cookie, url.href);
    }
    if (response.headers.get('x-amzn-waf-action') || response.headers.get('cf-mitigated') === 'challenge') {
      await response.body?.cancel();
      throw new AppError('BROWSER_VERIFICATION_REQUIRED', 'DeepSeek 要求浏览器验证，请运行 npm run login 完成人工验证。', 403);
    }
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      throw new AppError(response.status === 401 ? 'LOGIN_EXPIRED' : 'ACCESS_DENIED', 'DeepSeek 拒绝访问，请检查登录会话或在登录浏览器中确认账号状态。', response.status);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new AppError('RATE_LIMITED', 'DeepSeek 请求频率受限，请稍后再试。', 429);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('UPSTREAM_HTTP', 'DeepSeek 服务请求失败。', 502, { upstream_status: response.status });
    }
    return response;
  }

  async json(path, options) {
    const response = await this.request(path, options);
    if (!response.headers.get('content-type')?.includes('json')) {
      await response.body?.cancel();
      throw new AppError('BROWSER_VERIFICATION_REQUIRED', 'DeepSeek 返回了非 API 页面，请在登录浏览器中验证会话。', 403);
    }
    let body;
    try { body = JSON.parse(await readLimited(response)); }
    catch (error) { if (error instanceof SyntaxError) throw new AppError('UPSTREAM_PROTOCOL', 'DeepSeek 返回了无效 JSON。'); throw error; }
    return decodeEnvelope(body);
  }
}
