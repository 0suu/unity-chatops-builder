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
class FakeAdapter { platform = 'slack'; statuses = []; messages = []; setIncomingHandler(handler) { this.handler = handler; } async createThread(reference) { return { channelId: reference.channelId, threadId: reference.sourceMessageId }; } async postThreadMessage(_thread, text) { this.messages.push(text); } async replaceStatusReaction(_message, _previous, next) { this.statuses.push(next); } async reconcileStatusReaction() {} }
function config() { return { repositoryAccess: { defaultHost: 'github.com', allowedHosts: ['github.com'], compiledBranchPatterns: [/.+/] }, unity: { allowedBuildProfiles: [] } }; }

test('Coordinator resolves the repository from the message before queueing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-')); const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const adapter = new FakeAdapter(); const adapters = new AdapterRegistry([adapter]); const statusService = new StatusService({ store, adapters, logger }); let wakeCount = 0; let resolveRequest = null;
    const resolver = { async validateBranchName() {}, async resolve(request) { resolveRequest = request; return { repositoryId: request.repository.id, repositoryDisplayName: request.repository.displayName, commitSha: 'a'.repeat(40), unityVersion: '6000.0.59f2', sourceSnapshotId: 'b'.repeat(64), sourceSnapshotManifest: { snapshotId: 'b'.repeat(64), lfs: { objectCount: 2, totalSizeBytes: 100 } } }; } };
    const coordinator = new BuildCoordinator({ config: config(), store, adapters, statusService, sourceResolver: resolver, logger, onQueued: () => { wakeCount += 1; } });
    await coordinator.handleIncomingMessage({ platform: 'slack', workspaceId: 'T1', channelId: 'C1', sourceMessageId: '100.1', requesterId: 'U1', requesterName: 'suu', text: 'unity-build\nrepository: 0suu/Unity-Project\nproject: UnityProject\nbranch: main\nprofile: Assets/BuildProfiles/PICO.asset' });
    const job = store.getJobByMessage('slack', 'C1', '100.1'); assert.equal(job.status, 'QUEUED'); assert.equal(job.repositoryAlias, 'github.com/0suu/unity-project'); assert.equal(job.projectPath, 'UnityProject'); assert.equal(job.sourceSnapshotId, 'b'.repeat(64)); assert.equal(resolveRequest.repository.sshUrl, 'git@github.com:0suu/unity-project.git'); assert.equal(resolveRequest.requestedRef, 'main'); assert.equal(resolveRequest.projectPath, 'UnityProject'); assert.deepEqual(adapter.statuses, ['0', '1', '2']); assert.equal(wakeCount, 1); assert.match(adapter.messages[0], /0suu\/unity-project/); assert.match(adapter.messages[1], /Project: `UnityProject`/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Coordinator rejects a repository on a non-allowlisted SSH host', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-')); const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const adapter = new FakeAdapter(); const adapters = new AdapterRegistry([adapter]); const statusService = new StatusService({ store, adapters, logger }); let called = false;
    const coordinator = new BuildCoordinator({ config: config(), store, adapters, statusService, sourceResolver: { async validateBranchName() { called = true; }, async resolve() { called = true; } }, logger });
    await coordinator.handleIncomingMessage({ platform: 'slack', workspaceId: 'T1', channelId: 'C1', sourceMessageId: '100.2', requesterId: 'U1', requesterName: 'suu', text: 'unity-build\nrepository: git@example.com:team/project.git\nbranch: main\nprofile: Assets/P.asset' });
    const job = store.getJobByMessage('slack', 'C1', '100.2'); assert.equal(job.status, 'FAILED'); assert.equal(job.errorCode, 'INVALID_REPOSITORY'); assert.equal(called, false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
