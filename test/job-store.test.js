import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/db/job-store.js';

test('stores the resolved snapshot before queueing and exposes GC protections', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'job-store-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const { job } = store.createJob({ platform: 'slack', channelId: 'C1', sourceMessageId: '1', requesterId: 'U1', repositoryAlias: 'project', projectPath: 'UnityProject', requestedBranch: 'suu/test', buildProfilePath: 'Assets/PICO.asset' });
    const manifest = { snapshotId: 'b'.repeat(64), repositoryId: 'project', commitSha: 'a'.repeat(40), filesDigest: 'c'.repeat(64), lfs: { enabled: true, objectCount: 1, totalSizeBytes: 4, objects: [{ path: 'a', oidSha256: 'd'.repeat(64), sizeBytes: 4 }] }, createdAt: new Date().toISOString() };
    store.setResolvedSource(job.id, { commitSha: 'a'.repeat(40), sourceSnapshotId: manifest.snapshotId, sourceSnapshotManifest: manifest, unityVersion: '6000.0.59f2' });
    store.setQueued(job.id);
    const stored = store.getJob(job.id);
    assert.equal(stored.sourceSnapshotId, manifest.snapshotId);
    assert.equal(stored.projectPath, 'UnityProject');
    assert.equal(stored.status, 'QUEUED');
    assert.deepEqual(store.listProtectedSourceSnapshotIds(), [manifest.snapshotId]);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('does not retry an interrupted worker without a published snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'job-store-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const { job } = store.createJob({ platform: 'slack', channelId: 'C1', sourceMessageId: '2', requesterId: 'U1', repositoryAlias: 'project', requestedBranch: 'suu/test', buildProfilePath: 'Assets/PICO.asset' });
    const recovery = store.recoverInterruptedJobs(1);
    assert.equal(recovery[0].action, 'source-resolution-failed');
    assert.equal(store.getJob(job.id).status, 'FAILED');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('migrates an existing initial-version database before creating the snapshot index', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'job-store-migration-'));
  const databasePath = path.join(directory, 'jobs.sqlite3');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE jobs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      workspace_id TEXT,
      channel_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      thread_id TEXT,
      requester_id TEXT NOT NULL,
      requester_name TEXT,
      repository_alias TEXT NOT NULL,
      requested_branch TEXT,
      build_profile_path TEXT,
      resolved_commit_sha TEXT,
      unity_version TEXT,
      status TEXT NOT NULL,
      desired_status TEXT,
      applied_status TEXT,
      job_result TEXT,
      build_result TEXT,
      artifact_result TEXT,
      delivery_result TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      queued_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      heartbeat_at TEXT,
      error_code TEXT,
      error_summary TEXT,
      error_details_json TEXT,
      artifact_path TEXT,
      artifact_name TEXT,
      artifact_size INTEGER,
      artifact_sha256 TEXT,
      published_json TEXT,
      UNIQUE(platform, channel_id, source_message_id)
    ) STRICT;
    CREATE TABLE job_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      stage INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    ) STRICT;
  `);
  legacy.close();

  const migrated = new JobStore(databasePath);
  try {
    const columns = migrated.db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name);
    assert.ok(columns.includes('source_snapshot_id'));
    assert.ok(columns.includes('source_manifest_json'));
    assert.ok(columns.includes('project_path'));
    const indexes = migrated.db.prepare('PRAGMA index_list(jobs)').all().map((row) => row.name);
    assert.ok(indexes.includes('jobs_snapshot_idx'));
  } finally {
    migrated.close();
    await rm(directory, { recursive: true, force: true });
  }
});
