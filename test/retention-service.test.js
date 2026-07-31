import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { RetentionService } from '../src/maintenance/retention-service.js';

const quietLogger = { warn() {} };

test('removes orphaned artifact directories even when no artifact path reached SQLite', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'unity-ci-retention-'));
  const artifactDirectory = path.join(dataDir, 'artifacts', 'job-1');
  const logDirectory = path.join(dataDir, 'logs', 'job-1');
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, 'partial.apk'), 'partial');
  await writeFile(path.join(logDirectory, 'unity.log'), 'log');

  let cleared = null;
  const store = {
    listFinishedJobs() {
      return [{
        id: 'job-1',
        status: 'FAILED',
        finishedAt: '2026-01-01T00:00:00.000Z',
        artifactPath: null,
      }];
    },
    clearArtifact(jobId) {
      cleared = jobId;
    },
  };
  const config = {
    artifacts: {
      successfulRetentionDays: 3,
      failedRetentionDays: 1,
      logsRetentionDays: 14,
    },
  };

  const service = new RetentionService({ config, dataDir, store, logger: quietLogger });
  await service.runOnce(Date.parse('2026-02-01T00:00:00.000Z'));

  await assert.rejects(access(artifactDirectory), { code: 'ENOENT' });
  await assert.rejects(access(logDirectory), { code: 'ENOENT' });
  assert.equal(cleared, 'job-1');
});
