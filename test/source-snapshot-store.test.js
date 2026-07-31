import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceSnapshotStore } from '../src/source/source-snapshot-store.js';

const logger = { warn() {} };

test('publishes deterministic read-only snapshots and omits .git', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'snapshot-'));
  let store;
  try {
    const staging = path.join(directory, 'staging');
    await mkdir(path.join(staging, 'Assets'), { recursive: true });
    await mkdir(path.join(staging, '.git'), { recursive: true });
    await writeFile(path.join(staging, 'Assets', 'data.bin'), 'materialized');
    await writeFile(path.join(staging, '.git', 'config'), 'secret');
    store = new SourceSnapshotStore({ root: path.join(directory, 'snapshots'), workspaceRoot: path.join(directory, 'workspaces'), logger });
    const input = { repositoryId: 'project', commitSha: 'a'.repeat(40), stagingPath: staging, lfsObjects: [{ path: 'Assets/data.bin', oidSha256: 'b'.repeat(64), sizeBytes: 12 }] };
    const one = await store.publish(input);
    const two = await store.publish(input);
    assert.equal(one.snapshotId, two.snapshotId);
    const sourceRoot = path.join(store.snapshotDirectory(one.snapshotId), 'source');
    await assert.rejects(() => stat(path.join(sourceRoot, '.git')), /ENOENT/);
    assert.equal((await stat(sourceRoot)).mode & 0o222, 0);

    const workspace = path.join(directory, 'workspaces', 'job-1');
    await store.materializeWorkspace({ snapshotId: one.snapshotId, workspacePath: workspace });
    assert.equal(await readFile(path.join(workspace, 'Assets', 'data.bin'), 'utf8'), 'materialized');
    await assert.rejects(() => stat(path.join(workspace, '.git')), /ENOENT/);
  } finally { await store?.gc({ retentionDays: 0 }); await rm(directory, { recursive: true, force: true }); }
});

test('snapshot ID changes when materialized file content changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'snapshot-'));
  let store;
  try {
    const staging = path.join(directory, 'staging'); await mkdir(staging);
    store = new SourceSnapshotStore({ root: path.join(directory, 'snapshots'), workspaceRoot: path.join(directory, 'workspaces'), logger });
    await writeFile(path.join(staging, 'file'), 'one');
    const one = await store.publish({ repositoryId: 'project', commitSha: 'a'.repeat(40), stagingPath: staging, lfsObjects: [] });
    await writeFile(path.join(staging, 'file'), 'two');
    const two = await store.publish({ repositoryId: 'project', commitSha: 'a'.repeat(40), stagingPath: staging, lfsObjects: [] });
    assert.notEqual(one.snapshotId, two.snapshotId);
  } finally { await store?.gc({ retentionDays: 0 }); await rm(directory, { recursive: true, force: true }); }
});
