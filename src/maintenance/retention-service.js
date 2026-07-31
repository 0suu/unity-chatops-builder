import { rm } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideOrEqual } from '../core/paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class RetentionService {
  constructor({ config, dataDir, store, logger }) {
    this.config = config;
    this.dataDir = dataDir;
    this.store = store;
    this.logger = logger;
    this.timer = null;
  }

  async start() {
    await this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.logger.warn('Retention cleanup failed.', { error }));
    }, 6 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = Date.now()) {
    for (const job of this.store.listFinishedJobs()) {
      const finishedAt = Date.parse(job.finishedAt);
      if (!Number.isFinite(finishedAt)) continue;
      const age = now - finishedAt;
      const artifactDays = job.status === 'SUCCEEDED'
        ? this.config.artifacts.successfulRetentionDays
        : this.config.artifacts.failedRetentionDays;

      if (age >= artifactDays * DAY_MS) {
        const artifactRoot = path.join(this.dataDir, 'artifacts');
        const directory = path.join(artifactRoot, job.id);
        if (isPathInsideOrEqual(artifactRoot, directory)) {
          await rm(directory, { recursive: true, force: true });
          this.store.clearArtifact(job.id);
        } else {
          this.logger.warn('Refused to delete an artifact directory outside the artifact root.', {
            jobId: job.id,
            directory,
          });
        }
      }

      if (age >= this.config.artifacts.logsRetentionDays * DAY_MS) {
        const logDirectory = path.join(this.dataDir, 'logs', job.id);
        await rm(logDirectory, { recursive: true, force: true });
      }
    }
  }
}
