import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/db/job-store.js';
import { AdapterRegistry } from '../src/chat/adapter-registry.js';
import { StatusService } from '../src/chat/status-service.js';
import { BuildWorker } from '../src/build/worker.js';

const logger = { warn() {}, debug() {}, info() {}, error() {} };
class FakeAdapter {
  platform = 'slack'; statuses = []; uploads = []; threadMessages = [];
  async replaceStatusReaction(_message, _previous, next) { this.statuses.push(next); }
  async reconcileStatusReaction() {}
  async postThreadMessage(_thread, text) { this.threadMessages.push(text); }
}

test('Worker consumes only the published snapshot and performs no Git/LFS operation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'worker-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  const adapter = new FakeAdapter(); const adapters = new AdapterRegistry([adapter]); const statusService = new StatusService({ store, adapters, logger });
  let worker;
  try {
    const apkPath = path.join(directory, 'app.apk'); await writeFile(apkPath, 'apk');
    const { job } = store.createJob({ platform: 'slack', workspaceId: 'T1', channelId: 'C1', sourceMessageId: '100.1', requesterId: 'U1', repositoryAlias: 'project', projectPath: 'UnityProject', requestedBranch: 'suu/test', buildProfilePath: 'Assets/BuildProfiles/PICO.asset' });
    store.setThread(job.id, '100.1');
    const manifest = { snapshotId: 'b'.repeat(64), repositoryId: 'project', commitSha: 'a'.repeat(40), filesDigest: 'c'.repeat(64), lfs: { enabled: true, objectCount: 1, totalSizeBytes: 3, objects: [] }, createdAt: new Date().toISOString() };
    store.setResolvedSource(job.id, { commitSha: manifest.commitSha, sourceSnapshotId: manifest.snapshotId, sourceSnapshotManifest: manifest, unityVersion: '6000.0.59f2' });
    store.setQueued(job.id);
    let materialized = 0;
    const snapshotStore = {
      async materializeWorkspace({ snapshotId, workspacePath }) { assert.equal(snapshotId, manifest.snapshotId); materialized += 1; await mkdir(workspacePath, { recursive: true }); return workspacePath; },
      async cleanupWorkspace(workspacePath) { await rm(workspacePath, { recursive: true, force: true }); },
    };
    const unityService = {
      async inspectProject(_workspacePath, buildProfilePath, projectPath) { assert.equal(buildProfilePath, 'Assets/BuildProfiles/PICO.asset'); assert.equal(projectPath, 'UnityProject'); return { unityVersion: '6000.0.59f2', unityExecutable: '/fake/Unity', projectPath: path.join(directory, 'workspace', 'UnityProject') }; },
      async build({ onSpawn, projectPath }) { assert.equal(projectPath, path.join(directory, 'workspace', 'UnityProject')); onSpawn(); return { path: apkPath, name: 'app.apk', logPath: path.join(directory, 'unity.log') }; },
    };
    const artifactVerifier = { async verify(candidate) { return { ...candidate, size: 3, sha256: 'd'.repeat(64) }; } };
    const artifactPublisher = { async publish(jobValue, artifact, text) { adapter.uploads.push({ job: jobValue, artifact, text }); return { platform: 'slack', fileIds: ['F1'] }; } };
    worker = new BuildWorker({ config: { dataDir: directory, runner: { pollIntervalMs: 10, heartbeatIntervalMs: 20 } }, store, adapters, statusService, snapshotStore, unityService, artifactVerifier, artifactPublisher, logger, redactor: { redact(value) { return value; } } });
    worker.start(); worker.wake();
    await waitUntil(() => store.getJob(job.id).status === 'SUCCEEDED');
    assert.equal(materialized, 1);
    assert.deepEqual(adapter.statuses, ['3', '4', '5', '6', '7', '8', '9']);
    assert.equal(adapter.uploads.length, 1);
  } finally { await worker?.stop(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
async function waitUntil(predicate, timeoutMs = 3000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Timed out.'); }
