import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusService } from '../src/chat/status-service.js';

const quietLogger = { debug() {}, warn() {} };

test('startup reconciliation removes stale bot statuses before applying the desired one', async () => {
  const calls = [];
  const job = {
    id: 'job-1',
    platform: 'slack',
    channelId: 'C1',
    sourceMessageId: '1.0',
    appliedStatus: '5',
    desiredStatus: '6',
  };
  const store = {
    listReactionSyncJobs: () => [job],
    setAppliedStatus: (jobId, status, stage) => calls.push(['applied', jobId, status, stage]),
  };
  const adapter = {
    async reconcileStatusReaction(reference, status) {
      calls.push(['reconcile', reference, status]);
    },
  };
  const adapters = { get: () => adapter };
  const service = new StatusService({ store, adapters, logger: quietLogger });

  await service.reconcile();

  assert.deepEqual(calls, [
    ['reconcile', { workspaceId: undefined, channelId: 'C1', sourceMessageId: '1.0' }, '6'],
    ['applied', 'job-1', '6', 6],
  ]);
});
