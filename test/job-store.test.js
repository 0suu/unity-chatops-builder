import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/db/job-store.js';

const request = {
  platform: 'slack',
  workspaceId: 'T1',
  channelId: 'C1',
  sourceMessageId: '100.1',
  requesterId: 'U1',
  requesterName: 'suu',
  repositoryAlias: 'project',
  requestedBranch: 'suu/test',
  buildProfilePath: 'Assets/BuildProfiles/Test.asset',
};

test('deduplicates messages and claims queued jobs once', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-db-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const first = store.createJob(request);
    const duplicate = store.createJob(request);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);

    store.setQueued(first.job.id);
    const claimed = store.claimNextJob();
    assert.equal(claimed.id, first.job.id);
    assert.equal(claimed.attempt, 1);
    assert.equal(store.claimNextJob(), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('requeues one interrupted attempt and then fails at the configured limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-db-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const { job } = store.createJob({ ...request, sourceMessageId: '100.2' });
    store.setQueued(job.id);
    store.claimNextJob();
    assert.deepEqual(store.recoverInterruptedJobs(1), [{ jobId: job.id, action: 'requeued' }]);

    const secondAttempt = store.claimNextJob();
    assert.equal(secondAttempt.attempt, 2);
    assert.deepEqual(store.recoverInterruptedJobs(1), [{ jobId: job.id, action: 'failed' }]);
    assert.equal(store.getJob(job.id).status, 'FAILED');
    assert.equal(store.getJob(job.id).desiredStatus, 'failure');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
