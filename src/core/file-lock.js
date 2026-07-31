import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export class FileLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.acquired = false;
  }

  async acquire() {
    await mkdir(path.dirname(this.lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.close();
        this.acquired = true;
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;

        const stale = await this.#isStale();
        if (!stale) {
          throw new Error(`Another unity-chatops-builder process holds ${this.lockPath}.`);
        }
        await rm(this.lockPath, { force: true });
      }
    }

    throw new Error(`Unable to acquire ${this.lockPath}.`);
  }

  async release() {
    if (!this.acquired) return;
    await rm(this.lockPath, { force: true });
    this.acquired = false;
  }

  async #isStale() {
    try {
      const pid = Number.parseInt((await readFile(this.lockPath, 'utf8')).trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) return true;
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH' || error?.code === 'ENOENT';
    }
  }
}
