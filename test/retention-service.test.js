import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RetentionService } from '../src/maintenance/retention-service.js';

test('protects LFS objects referenced by retained snapshots during GC', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'retention-'));
  try {
    let snapshotProtection; let objectProtection;
    const store = { listFinishedJobs() { return []; }, listProtectedSourceSnapshotIds() { return ['a'.repeat(64)]; } };
    const snapshotStore = {
      async gc(input) { snapshotProtection = input.protectedSnapshotIds; return {}; },
      async listSnapshotIds() { return ['a'.repeat(64), 'b'.repeat(64)]; },
      async collectLfsOids(ids) { assert.equal(ids.length, 2); return new Set(['c'.repeat(64)]); },
    };
    const lfsObjectCache = { async gc(input) { objectProtection = input.protectedOids; return {}; } };
    const service = new RetentionService({
      config: { artifacts: { successfulRetentionDays: 3, failedRetentionDays: 1, logsRetentionDays: 14 }, storage: { sourceSnapshots: { retentionDays: 60 } } },
      dataDir: directory, store, snapshotStore, lfsObjectCache, logger: { warn() {} },
    });
    await service.runOnce(Date.now());
    assert.equal(snapshotProtection.has('a'.repeat(64)), true);
    assert.equal(objectProtection.has('c'.repeat(64)), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
