import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/db/job-store.js';
import { AdapterRegistry } from '../src/chat/adapter-registry.js';
import { StatusService } from '../src/chat/status-service.js';
import { ArtifactVerifier } from '../src/build/artifact-verifier.js';
import { ArtifactPublisher } from '../src/build/artifact-publisher.js';
import { BuildWorker } from '../src/build/worker.js';
import { SecretRedactor } from '../src/core/redact.js';

const logger = { warn() {}, debug() {}, info() {}, error() {} };

class FakeAdapter {
  platform = 'slack';
  statuses = [];
  threadMessages = [];
  uploads = [];

  async replaceStatusReaction(_message, _previous, next) { this.statuses.push(next); }
  async reconcileStatusReaction() {}
  async postThreadMessage(_thread, text) { this.threadMessages.push(text); }
  getNativeUploadLimitBytes() { return 1_000_000; }
  async uploadArtifact(_thread, artifact, text) {
    this.uploads.push({ artifact, text });
    return { platform: 'slack', fileIds: ['F1'] };
  }
}

test('runs a queued job through build, verification, upload, and stage 9', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-worker-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  const adapter = new FakeAdapter();
  const adapters = new AdapterRegistry([adapter]);
  const statusService = new StatusService({ store, adapters, logger });
  let worker;

  try {
    const apkPath = path.join(directory, 'prepared.apk');
    const zipInput = path.join(directory, 'zip-input');
    await mkdir(zipInput);
    await writeFile(path.join(zipInput, 'AndroidManifest.xml'), 'manifest');
    await writeFile(path.join(zipInput, 'classes.dex'), 'dex');
    await run('/usr/bin/zip', ['-q', apkPath, 'AndroidManifest.xml', 'classes.dex'], zipInput);

    const { job } = store.createJob({
      platform: 'slack',
      workspaceId: 'T1',
      channelId: 'C1',
      sourceMessageId: '100.1',
      requesterId: 'U1',
      requesterName: 'suu',
      repositoryAlias: 'project',
      requestedBranch: 'suu/test',
      buildProfilePath: 'Assets/BuildProfiles/PICO.asset',
    });
    store.setThread(job.id, '100.1');
    store.setQueued(job.id);

    const gitService = {
      async synchronizeAndResolve() { return 'a'.repeat(40); },
      async prepareWorkspace() { return path.join(directory, 'workspace'); },
      async cleanupWorkspace() {},
    };
    const unityService = {
      async inspectProject() {
        return { unityVersion: '6000.0.59f2', unityExecutable: '/fake/Unity' };
      },
      async build({ onSpawn }) {
        onSpawn();
        return { path: apkPath, name: 'prepared.apk', logPath: path.join(directory, 'unity.log') };
      },
    };
    const config = {
      runner: { pollIntervalMs: 10, heartbeatIntervalMs: 20 },
      artifacts: { maxBytes: 1_000_000 },
    };

    worker = new BuildWorker({
      config,
      store,
      adapters,
      statusService,
      gitService,
      unityService,
      artifactVerifier: new ArtifactVerifier({ maxBytes: 1_000_000, logger }),
      artifactPublisher: new ArtifactPublisher({ adapters }),
      logger,
      redactor: new SecretRedactor(),
    });
    worker.start();
    worker.wake();

    await waitUntil(() => store.getJob(job.id).status === 'SUCCEEDED');
    const finished = store.getJob(job.id);
    assert.equal(finished.jobResult, 'SUCCEEDED');
    assert.equal(finished.deliveryResult, 'SUCCEEDED');
    assert.equal(finished.desiredStatus, '9');
    assert.deepEqual(adapter.statuses, ['2', '3', '4', '5', '6', '7', '8', '9']);
    assert.equal(adapter.uploads.length, 1);
    assert.match(adapter.uploads[0].text, /Build .* succeeded/);
  } finally {
    await worker?.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
