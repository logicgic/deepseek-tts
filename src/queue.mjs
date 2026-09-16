import { AppError } from './errors.mjs';

export class SerialQueue {
  #active = false;
  #waiting = [];

  constructor(maxQueued = 8) { this.maxQueued = maxQueued; }
  get status() { return { active: this.#active ? 1 : 0, queued: this.#waiting.length }; }

  run(task, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#active && this.#waiting.length >= this.maxQueued) return Promise.reject(new AppError('QUEUE_FULL', '等待队列已满，请稍后重试。', 429));
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, signal, abort: null };
      entry.abort = () => {
        const index = this.#waiting.indexOf(entry);
        if (index >= 0) {
          this.#waiting.splice(index, 1);
          signal.removeEventListener('abort', entry.abort);
          reject(signal.reason);
        }
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.#waiting.push(entry);
      this.#pump();
    });
  }

  #pump() {
    if (this.#active) return;
    const entry = this.#waiting.shift();
    if (!entry) return;
    this.#active = true;
    entry.signal?.removeEventListener('abort', entry.abort);
    Promise.resolve().then(() => {
      entry.signal?.throwIfAborted();
      return entry.task();
    }).then(entry.resolve, entry.reject).finally(() => { this.#active = false; this.#pump(); });
  }
}
