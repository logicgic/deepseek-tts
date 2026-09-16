import { LIMITS } from './config.mjs';
import { AppError } from './errors.mjs';

const protocol = (message) => new AppError('CHAT_PROTOCOL', message);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export async function* sseEvents(body, maxBytes = LIMITS.maxStreamBytes) {
  if (!body) throw protocol('文字响应没有数据流。');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = '', data = [], bytes = 0;
  function line(value) {
    if (value === '') {
      const frame = data.length ? { event, data: data.join('\n') } : null;
      event = ''; data = [];
      return frame;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') event = content;
    if (field === 'data') data.push(content);
    return null;
  }
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw protocol('文字流超过大小限制。');
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const match = /\r\n|\r|\n/u.exec(buffer);
      if (!match || (match[0] === '\r' && match.index === buffer.length - 1)) break;
      const frame = line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (frame) yield frame;
    }
  }
  buffer += decoder.decode();
  if (buffer.endsWith('\r')) {
    const frame = line(buffer.slice(0, -1));
    buffer = '';
    if (frame) yield frame;
  }
  if (buffer.length || data.length) throw protocol('文字流在事件结束前中断。');
}

export class PatchDecoder {
  path = '';
  op = 'SET';

  parse(patch, depth = 0) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || depth > 30 || !Object.hasOwn(patch, 'v')) throw protocol('文字增量格式无效。');
    this.path = patch.p ?? this.path;
    this.op = patch.o ?? this.op;
    if (typeof this.path !== 'string' || !['SET', 'APPEND', 'BATCH'].includes(this.op)) throw protocol('未知的文字增量操作。');
    if (this.op !== 'BATCH') return [{ path: this.path, op: this.op, value: patch.v }];
    if (!Array.isArray(patch.v)) throw protocol('文字批次不是数组。');
    const child = new PatchDecoder();
    return patch.v.flatMap((item) => child.parse(item, depth + 1).map((op) => ({
      ...op, path: `${this.path ? `${this.path}/` : ''}${op.path}`,
    })));
  }
}

export function applyPatch(root, { path, op, value }) {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((key) => forbidden.has(key))) throw protocol('文字增量包含非法路径。');
  if (!parts.length) {
    if (op !== 'SET' || !value || typeof value !== 'object' || Array.isArray(value)) throw protocol('初始文字响应无效。');
    return structuredClone(value);
  }
  if (parts[0] !== 'response') throw protocol('文字增量不属于回答对象。');
  let parent = root;
  for (const key of parts.slice(0, -1)) {
    if (!parent || typeof parent !== 'object') throw protocol('文字增量父路径不存在。');
    if (Array.isArray(parent)) {
      if (!/^-?\d+$/u.test(key)) throw protocol('文字增量数组索引无效。');
      parent = parent.at(Number(key));
    } else {
      if (!Object.hasOwn(parent, key)) throw protocol('文字增量父路径不存在。');
      parent = parent[key];
    }
  }
  if (!parent || typeof parent !== 'object') throw protocol('文字增量父路径不存在。');
  const last = parts.at(-1);
  let key = last;
  if (Array.isArray(parent)) {
    if (!/^-?\d+$/u.test(last)) throw protocol('文字增量数组索引无效。');
    key = Number(last);
    if (op === 'APPEND' && Array.isArray(value)) { parent.splice(key, 0, ...structuredClone(value)); return root; }
    if (key < 0) key += parent.length;
    if (key < 0 || key > parent.length) throw protocol('文字增量数组索引越界。');
  }
  if (op === 'SET') parent[key] = structuredClone(value);
  else if (op === 'APPEND' && typeof value === 'string' && typeof parent[key] === 'string') parent[key] += value;
  else if (op === 'APPEND' && Array.isArray(value) && Array.isArray(parent[key])) parent[key].push(...structuredClone(value));
  else throw protocol('文字增量的数据类型不匹配。');
  return root;
}

export async function collectAnswer(body) {
  const patches = new PatchDecoder();
  let root = {}, readyId, initialId;
  for await (const frame of sseEvents(body)) {
    let data;
    // The official parser ignores data on finish. Do not infer success from it.
    if (frame.event === 'finish') continue;
    try { data = JSON.parse(frame.data); }
    catch { throw protocol('文字流含无效 JSON。'); }
    if (frame.event === '' || frame.event === 'message' || frame.event === 'delta') {
      for (const patch of patches.parse(data)) {
        root = applyPatch(root, patch);
        if (root.response?.message_id !== undefined) {
          if (initialId === undefined) initialId = root.response.message_id;
          else if (initialId !== root.response.message_id) throw protocol('文字流中的回答 ID 发生变化。');
        }
      }
    } else if (frame.event === 'ready') readyId = data.response_message_id;
    else if ((frame.event === 'hint' || frame.event === 'toast') && (data.type === 'error' || data.clear_response || data.finish_reason)) {
      throw new AppError('CHAT_REJECTED', 'DeepSeek 未完成回答或撤回了回答。');
    } else if (!['close', 'title', 'update_session', 'update_parent_message', 'update_file', 'debug', 'hint', 'toast'].includes(frame.event)) {
      throw protocol('DeepSeek 文字流协议出现未知事件。');
    }
  }
  const response = root.response;
  if (response?.status !== 'FINISHED') throw new AppError('CHAT_INCOMPLETE', '助手回答尚未完整完成，未请求朗读音频。');
  if (!(Number.isSafeInteger(response.message_id) && response.message_id > 0) || response.role !== 'ASSISTANT') throw protocol('缺少有效的助手回答 ID。');
  if (!Array.isArray(response.fragments) || response.fragments.some((f) => f.type === 'TEMPLATE_RESPONSE')) throw new AppError('CHAT_REJECTED', '返回内容不是可朗读的普通回答。');
  const fragments = response.fragments.filter((f) => f.type === 'RESPONSE');
  if (!fragments.length || fragments.some((f) => typeof f.content !== 'string')) throw protocol('缺少助手回答正文。');
  return { text: fragments.map((f) => f.content).join(''), messageId: response.message_id, readyId };
}
