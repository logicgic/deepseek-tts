export class AppError extends Error {
  constructor(code, message, status = 502, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeError(error) {
  if (error instanceof AppError) return error;
  if (error?.name === 'TimeoutError') return new AppError('TIMEOUT', '请求超时，未返回不完整音频。', 504);
  if (error?.name === 'AbortError') return new AppError('CANCELLED', '请求已取消。', 499);
  return new AppError('UPSTREAM_UNAVAILABLE', '请求失败，请检查网络和登录状态。');
}

export function assertRecord(value, code = 'UPSTREAM_PROTOCOL') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(code, '收到无法识别的数据结构。');
  }
  return value;
}
