import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export class JobStore {
  constructor(databasePath, { logger } = {}) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.logger = logger;
    this.db = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
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
        project_path TEXT NOT NULL DEFAULT '.',
        requested_branch TEXT,
        build_profile_path TEXT,
        resolved_commit_sha TEXT,
        source_snapshot_id TEXT,
        source_manifest_json TEXT,
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
      CREATE TABLE IF NOT EXISTS job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        stage INTEGER,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, sequence);
      CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs(finished_at);
      CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, sequence);
    `);
    this.#ensureColumn('jobs', 'source_snapshot_id', 'TEXT');
    this.#ensureColumn('jobs', 'source_manifest_json', 'TEXT');
    this.#ensureColumn('jobs', 'project_path', "TEXT NOT NULL DEFAULT '.'");
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_snapshot_idx ON jobs(source_snapshot_id);');
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  createJob(input) {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO jobs (
        id, platform, workspace_id, channel_id, source_message_id,
        requester_id, requester_name, repository_alias, project_path,
        requested_branch, build_profile_path, status, created_at
      ) VALUES (
        :id, :platform, :workspaceId, :channelId, :sourceMessageId,
        :requesterId, :requesterName, :repositoryAlias, :projectPath,
        :requestedBranch, :buildProfilePath, 'VALIDATING', :createdAt
      )
    `).run({ id, platform: input.platform, workspaceId: input.workspaceId ?? null, channelId: input.channelId, sourceMessageId: input.sourceMessageId, requesterId: input.requesterId, requesterName: input.requesterName ?? null, repositoryAlias: input.repositoryAlias, projectPath: input.projectPath ?? '.', requestedBranch: input.requestedBranch ?? null, buildProfilePath: input.buildProfilePath ?? null, createdAt: now });
    const job = result.changes > 0 ? this.getJob(id) : this.getJobByMessage(input.platform, input.channelId, input.sourceMessageId);
    if (result.changes > 0) this.appendEvent(id, 'JOB_CREATED', 0, { platform: input.platform });
    return { created: result.changes > 0, job };
  }

  getJob(id) { return mapJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)); }
  getJobByMessage(platform, channelId, sourceMessageId) { return mapJob(this.db.prepare('SELECT * FROM jobs WHERE platform = ? AND channel_id = ? AND source_message_id = ?').get(platform, channelId, sourceMessageId)); }
  setThread(jobId, threadId) { this.db.prepare('UPDATE jobs SET thread_id = :threadId WHERE id = :jobId').run({ jobId, threadId }); this.appendEvent(jobId, 'THREAD_READY', null, { threadId }); }
  setDesiredStatus(jobId, desiredStatus, stage = null) { this.db.prepare('UPDATE jobs SET desired_status = :desiredStatus WHERE id = :jobId').run({ jobId, desiredStatus }); this.appendEvent(jobId, 'STATUS_DESIRED', stage, { desiredStatus }); }
  setAppliedStatus(jobId, appliedStatus, stage = null) { this.db.prepare('UPDATE jobs SET applied_status = :appliedStatus WHERE id = :jobId').run({ jobId, appliedStatus }); this.appendEvent(jobId, 'STATUS_APPLIED', stage, { appliedStatus }); }

  setResolvedSource(jobId, resolved) {
    this.db.prepare(`
      UPDATE jobs
      SET resolved_commit_sha = :commitSha,
          source_snapshot_id = :sourceSnapshotId,
          source_manifest_json = :sourceManifestJson,
          unity_version = :unityVersion
      WHERE id = :jobId
    `).run({
      jobId,
      commitSha: resolved.commitSha,
      sourceSnapshotId: resolved.sourceSnapshotId,
      sourceManifestJson: JSON.stringify(resolved.sourceSnapshotManifest),
      unityVersion: resolved.unityVersion,
    });
    this.appendEvent(jobId, 'SOURCE_SNAPSHOT_RESOLVED', 1, {
      commitSha: resolved.commitSha,
      sourceSnapshotId: resolved.sourceSnapshotId,
      unityVersion: resolved.unityVersion,
      lfsObjectCount: resolved.sourceSnapshotManifest?.lfs?.objectCount ?? 0,
      lfsTotalSizeBytes: resolved.sourceSnapshotManifest?.lfs?.totalSizeBytes ?? 0,
    });
  }

  setQueued(jobId) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET status = 'QUEUED', queued_at = COALESCE(queued_at, :now), heartbeat_at = NULL WHERE id = :jobId`).run({ jobId, now });
    this.appendEvent(jobId, 'JOB_QUEUED', 2, null);
    return this.getQueuePosition(jobId);
  }
  getQueuePosition(jobId) { return Number(this.db.prepare(`SELECT COUNT(*) AS position FROM jobs queued WHERE queued.status = 'QUEUED' AND queued.sequence <= (SELECT sequence FROM jobs WHERE id = :jobId)`).get({ jobId })?.position ?? 0); }

  claimNextJob() {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.db.prepare(`SELECT id FROM jobs WHERE status = 'QUEUED' ORDER BY sequence LIMIT 1`).get();
      if (!row) { this.db.exec('COMMIT;'); return null; }
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE jobs SET status = 'RUNNING', attempt = attempt + 1, started_at = COALESCE(started_at, :now), heartbeat_at = :now WHERE id = :jobId AND status = 'QUEUED'`).run({ jobId: row.id, now });
      this.db.exec('COMMIT;');
      this.appendEvent(row.id, 'JOB_CLAIMED', 2, null);
      return this.getJob(row.id);
    } catch (error) { try { this.db.exec('ROLLBACK;'); } catch {} throw error; }
  }

  setResolvedCommit(jobId, commitSha) { this.db.prepare('UPDATE jobs SET resolved_commit_sha = :commitSha WHERE id = :jobId').run({ jobId, commitSha }); this.appendEvent(jobId, 'COMMIT_RESOLVED', 1, { commitSha }); }
  setUnityVersion(jobId, unityVersion) { this.db.prepare('UPDATE jobs SET unity_version = :unityVersion WHERE id = :jobId').run({ jobId, unityVersion }); this.appendEvent(jobId, 'UNITY_VERSION_RESOLVED', 4, { unityVersion }); }
  heartbeat(jobId) { this.db.prepare(`UPDATE jobs SET heartbeat_at = :now WHERE id = :jobId AND status = 'RUNNING'`).run({ jobId, now: new Date().toISOString() }); }
  setBuildSucceeded(jobId) { this.db.prepare(`UPDATE jobs SET build_result = 'SUCCEEDED' WHERE id = :jobId`).run({ jobId }); this.appendEvent(jobId, 'BUILD_SUCCEEDED', 6, null); }
  setArtifact(jobId, artifact) { this.db.prepare(`UPDATE jobs SET artifact_result = 'SUCCEEDED', artifact_path = :path, artifact_name = :name, artifact_size = :size, artifact_sha256 = :sha256 WHERE id = :jobId`).run({ jobId, path: artifact.path, name: artifact.name, size: artifact.size, sha256: artifact.sha256 }); this.appendEvent(jobId, 'ARTIFACT_VERIFIED', 7, { size: artifact.size, sha256: artifact.sha256 }); }
  setDeliverySucceeded(jobId, published) { this.db.prepare(`UPDATE jobs SET delivery_result = 'SUCCEEDED', published_json = :publishedJson WHERE id = :jobId`).run({ jobId, publishedJson: JSON.stringify(published ?? {}) }); this.appendEvent(jobId, 'DELIVERY_SUCCEEDED', 7, published ?? null); }
  markSuccess(jobId) { const now = new Date().toISOString(); this.db.prepare(`UPDATE jobs SET status = 'SUCCEEDED', job_result = 'SUCCEEDED', finished_at = :now, heartbeat_at = NULL, error_code = NULL, error_summary = NULL, error_details_json = NULL WHERE id = :jobId`).run({ jobId, now }); this.appendEvent(jobId, 'JOB_SUCCEEDED', 9, null); }

  markFailure(jobId, error, jobResult = 'FAILED') {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET status = 'FAILED', job_result = :jobResult, finished_at = :now, heartbeat_at = NULL, error_code = :errorCode, error_summary = :errorSummary, error_details_json = :detailsJson WHERE id = :jobId`).run({ jobId, jobResult, now, errorCode: error.code ?? 'UNKNOWN_ERROR', errorSummary: error.message ?? String(error), detailsJson: JSON.stringify(error.details ?? {}) });
    this.appendEvent(jobId, 'JOB_FAILED', error.stage ?? null, { code: error.code, category: error.category, message: error.message });
  }
  appendEvent(jobId, eventType, stage = null, payload = null) { this.db.prepare(`INSERT INTO job_events (job_id, event_type, stage, payload_json, created_at) VALUES (:jobId, :eventType, :stage, :payloadJson, :createdAt)`).run({ jobId, eventType, stage, payloadJson: payload === null ? null : JSON.stringify(payload), createdAt: new Date().toISOString() }); }

  recoverInterruptedJobs(interruptedJobRetries) {
    const recovered = [];
    const planning = this.db.prepare(`SELECT * FROM jobs WHERE status = 'VALIDATING' ORDER BY sequence`).all().map(mapJob);
    for (const job of planning) {
      if (job.sourceSnapshotId) {
        this.setQueued(job.id); this.setDesiredStatus(job.id, '2', 2); recovered.push({ jobId: job.id, action: 'source-resolved-requeued' });
      } else {
        this.markFailure(job.id, { code: 'RUNNER_INTERRUPTED_DURING_SOURCE_RESOLUTION', category: 'RUNNER_ERROR', message: 'Runner stopped before a complete Source Snapshot was published.', stage: 1 }, 'RUNNER_ERROR');
        this.setDesiredStatus(job.id, 'failure', null); recovered.push({ jobId: job.id, action: 'source-resolution-failed' });
      }
    }
    const running = this.db.prepare(`SELECT * FROM jobs WHERE status = 'RUNNING' ORDER BY sequence`).all().map(mapJob);
    for (const job of running) {
      if (job.deliveryResult === 'SUCCEEDED') { this.markSuccess(job.id); this.setDesiredStatus(job.id, '9', 9); recovered.push({ jobId: job.id, action: 'finalized' }); continue; }
      if (job.sourceSnapshotId && job.attempt <= interruptedJobRetries) {
        this.db.prepare(`UPDATE jobs SET status = 'QUEUED', desired_status = '2', heartbeat_at = NULL, error_code = NULL, error_summary = NULL, error_details_json = NULL WHERE id = :jobId`).run({ jobId: job.id });
        this.appendEvent(job.id, 'JOB_RECOVERED_TO_QUEUE', 2, { previousAttempt: job.attempt }); recovered.push({ jobId: job.id, action: 'requeued' });
      } else {
        this.markFailure(job.id, { code: job.sourceSnapshotId ? 'RUNNER_INTERRUPTED' : 'SOURCE_SNAPSHOT_MISSING', category: 'RUNNER_ERROR', message: 'The runner stopped while this job was active and it cannot be safely retried.', stage: Number(job.desiredStatus), details: { attempts: job.attempt } }, 'RUNNER_ERROR');
        this.setDesiredStatus(job.id, 'failure', null); recovered.push({ jobId: job.id, action: 'failed' });
      }
    }
    return recovered;
  }

  listReactionSyncJobs() { return this.db.prepare(`SELECT * FROM jobs WHERE desired_status IS NOT NULL AND (applied_status IS NULL OR applied_status <> desired_status) ORDER BY sequence`).all().map(mapJob); }
  listFinishedJobs() { return this.db.prepare(`SELECT * FROM jobs WHERE status IN ('SUCCEEDED', 'FAILED') AND finished_at IS NOT NULL`).all().map(mapJob); }
  listProtectedSourceSnapshotIds() { return this.db.prepare(`SELECT DISTINCT source_snapshot_id FROM jobs WHERE source_snapshot_id IS NOT NULL AND (status IN ('VALIDATING', 'QUEUED', 'RUNNING') OR artifact_path IS NOT NULL)`).all().map((row) => row.source_snapshot_id); }
  listAllSourceSnapshotIds() { return this.db.prepare(`SELECT DISTINCT source_snapshot_id FROM jobs WHERE source_snapshot_id IS NOT NULL`).all().map((row) => row.source_snapshot_id); }
  clearArtifact(jobId) { this.db.prepare(`UPDATE jobs SET artifact_path = NULL WHERE id = :jobId`).run({ jobId }); }
  listEvents(jobId) { return this.db.prepare(`SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence`).all(jobId).map((row) => ({ sequence: Number(row.sequence), jobId: row.job_id, eventType: row.event_type, stage: row.stage === null ? null : Number(row.stage), payload: parseJson(row.payload_json), createdAt: row.created_at })); }
  close() { this.db.close(); }
}

function mapJob(row) {
  if (!row) return null;
  return {
    sequence: Number(row.sequence), id: row.id, platform: row.platform, workspaceId: row.workspace_id, channelId: row.channel_id, sourceMessageId: row.source_message_id, threadId: row.thread_id,
    requesterId: row.requester_id, requesterName: row.requester_name, repositoryAlias: row.repository_alias, projectPath: row.project_path ?? '.', requestedBranch: row.requested_branch, buildProfilePath: row.build_profile_path,
    resolvedCommitSha: row.resolved_commit_sha, sourceSnapshotId: row.source_snapshot_id, sourceSnapshotManifest: parseJson(row.source_manifest_json), unityVersion: row.unity_version,
    status: row.status, desiredStatus: row.desired_status, appliedStatus: row.applied_status, jobResult: row.job_result, buildResult: row.build_result, artifactResult: row.artifact_result, deliveryResult: row.delivery_result,
    attempt: Number(row.attempt), createdAt: row.created_at, queuedAt: row.queued_at, startedAt: row.started_at, finishedAt: row.finished_at, heartbeatAt: row.heartbeat_at,
    errorCode: row.error_code, errorSummary: row.error_summary, errorDetails: parseJson(row.error_details_json), artifactPath: row.artifact_path, artifactName: row.artifact_name,
    artifactSize: row.artifact_size === null ? null : Number(row.artifact_size), artifactSha256: row.artifact_sha256, published: parseJson(row.published_json),
  };
}
function parseJson(value) { if (value === null || value === undefined) return null; try { return JSON.parse(value); } catch { return null; } }
