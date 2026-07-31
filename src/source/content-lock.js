import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export class ContentLock {
  constructor(lockPath, { timeoutMs = 10 * 60 * 1000, pollIntervalMs = 100, staleAfterMs = 60 * 60 * 1000, signal } = {}) {
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.staleAfterMs = staleAfterMs;
    this.signal = signal;
    this.handle = null;
    this.token = `${process.pid}:${randomUUID()}`;
  }

  async acquire() {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (this.signal?.aborted) throw this.signal.reason ?? new Error('Lock acquisition aborted.');
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ token: this.token, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
        await handle.sync();
        this.handle = handle;
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (await this.#isStale()) { await rm(this.lockPath, { force: true }); continue; }
        await sleep(this.pollIntervalMs, this.signal);
      }
    }
    const error = new Error(`Timed out acquiring ${this.lockPath}.`);
    error.code = 'CONTENT_LOCK_TIMEOUT';
    throw error;
  }

  async release() {
    if (!this.handle) return;
    try { await this.handle.close(); } finally { this.handle = null; }
    try {
      const state = JSON.parse(await readFile(this.lockPath, 'utf8'));
      if (state.token === this.token) await rm(this.lockPath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async #isStale() {
    try {
      const state = JSON.parse(await readFile(this.lockPath, 'utf8'));
      const createdAt = Date.parse(state.createdAt);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > this.staleAfterMs) return true;
      if (!Number.isInteger(state.pid) || state.pid <= 0) return true;
      try { process.kill(state.pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
    } catch (error) {
      return error?.code === 'ENOENT' || error instanceof SyntaxError;
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted.')); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}
