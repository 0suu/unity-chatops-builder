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
  platform = 'slack'; statuses = []; messages = [];
  setIncomingHandler(handler) { this.handler = handler; }
  async createThread(reference) { return { channelId: reference.channelId, threadId: reference.sourceMessageId }; }
  async postThreadMessage(_thread, text) { this.messages.push(text); }
  async replaceStatusReaction(_message, _previous, next) { this.statuses.push(next); }
  async reconcileStatusReaction() {}
}
function config() { return { repository: { alias: 'project', compiledBranchPatterns: [/^suu\/.+$/] }, unity: { allowedBuildProfiles: ['Assets/BuildProfiles/PICO.asset'] } }; }

test('Coordinator resolves and publishes source before queueing a Worker job', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const adapter = new FakeAdapter(); const adapters = new AdapterRegistry([adapter]); const statusService = new StatusService({ store, adapters, logger });
    let wakeCount = 0;
    const resolver = {
      async validateBranchName() {},
      async resolve() { return { commitSha: 'a'.repeat(40), unityVersion: '6000.0.59f2', sourceSnapshotId: 'b'.repeat(64), sourceSnapshotManifest: { snapshotId: 'b'.repeat(64), lfs: { objectCount: 2, totalSizeBytes: 100 } } }; },
    };
    const coordinator = new BuildCoordinator({ config: config(), store, adapters, statusService, sourceResolver: resolver, logger, onQueued: () => { wakeCount += 1; } });
    await coordinator.handleIncomingMessage({ platform: 'slack', workspaceId: 'T1', channelId: 'C1', sourceMessageId: '100.1', requesterId: 'U1', requesterName: 'suu', text: 'unity-build\nbranch: suu/test\nprofile: Assets/BuildProfiles/PICO.asset' });
    const job = store.getJobByMessage('slack', 'C1', '100.1');
    assert.equal(job.status, 'QUEUED');
    assert.equal(job.sourceSnapshotId, 'b'.repeat(64));
    assert.deepEqual(adapter.statuses, ['0', '1', '2']);
    assert.equal(wakeCount, 1);
    assert.match(adapter.messages[0], /Snapshot/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
