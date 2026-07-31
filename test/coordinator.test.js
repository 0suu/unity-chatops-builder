import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/db/job-store.js';
import { AdapterRegistry } from '../src/chat/adapter-registry.js';
import { StatusService } from '../src/chat/status-service.js';
import { BuildCoordinator } from '../src/chat/coordinator.js';

const logger = { warn() {}, debug() {}, info() {}, error() {} };

class FakeAdapter {
  platform = 'slack';
  statuses = [];
  messages = [];

  setIncomingHandler(handler) { this.handler = handler; }
  async createThread(reference) { return { channelId: reference.channelId, threadId: reference.sourceMessageId }; }
  async postThreadMessage(_thread, text) { this.messages.push(text); }
  async replaceStatusReaction(_message, _previous, next) { this.statuses.push(next); }
  async reconcileStatusReaction() {}
}

function config() {
  return {
    repository: {
      alias: 'project',
      compiledBranchPatterns: [/^suu\/.+$/],
    },
    unity: {
      allowedBuildProfiles: ['Assets/BuildProfiles/PICO.asset'],
    },
  };
}

test('accepts a valid message, creates a thread, and queues one job', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-coordinator-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const adapter = new FakeAdapter();
    const adapters = new AdapterRegistry([adapter]);
    const statusService = new StatusService({ store, adapters, logger });
    let wakeCount = 0;
    const coordinator = new BuildCoordinator({
      config: config(),
      store,
      adapters,
      statusService,
      gitService: { async validateBranchName() {} },
      logger,
      onQueued: () => { wakeCount += 1; },
    });

    await coordinator.handleIncomingMessage({
      platform: 'slack',
      workspaceId: 'T1',
      channelId: 'C1',
      sourceMessageId: '100.1',
      requesterId: 'U1',
      requesterName: 'suu',
      text: 'unity-build\nbranch: suu/test\nprofile: Assets/BuildProfiles/PICO.asset',
    });

    const job = store.getJobByMessage('slack', 'C1', '100.1');
    assert.equal(job.status, 'QUEUED');
    assert.equal(job.threadId, '100.1');
    assert.deepEqual(adapter.statuses, ['0', '1']);
    assert.equal(wakeCount, 1);
    assert.match(adapter.messages[0], /Queue: 1番目/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects malformed requests in the source message thread', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-coordinator-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const adapter = new FakeAdapter();
    const adapters = new AdapterRegistry([adapter]);
    const statusService = new StatusService({ store, adapters, logger });
    const coordinator = new BuildCoordinator({
      config: config(),
      store,
      adapters,
      statusService,
      gitService: { async validateBranchName() {} },
      logger,
    });

    await coordinator.handleIncomingMessage({
      platform: 'slack',
      workspaceId: 'T1',
      channelId: 'C1',
      sourceMessageId: '100.2',
      requesterId: 'U1',
      requesterName: 'suu',
      text: 'unity-build\nbranch: suu/test',
    });

    const job = store.getJobByMessage('slack', 'C1', '100.2');
    assert.equal(job.status, 'FAILED');
    assert.equal(job.jobResult, 'REQUEST_ERROR');
    assert.deepEqual(adapter.statuses, ['0', 'failure']);
    assert.match(adapter.messages[0], /INVALID_REQUEST_FORMAT/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
