import path from 'node:path';
import { CiError, asCiError } from '../core/errors.js';
import { STAGES, stageName } from '../core/stages.js';
import { threadReference } from '../chat/status-service.js';
import { codeBlock, formatBytes, formatDuration, shortSha, tailFile } from '../utils/format.js';

export class BuildWorker {
  constructor({ config, store, adapters, statusService, snapshotStore, unityService, dependencyRestorer, artifactVerifier, artifactPublisher, logger, redactor }) {
    this.config = config; this.store = store; this.adapters = adapters; this.statusService = statusService; this.snapshotStore = snapshotStore; this.unityService = unityService; this.dependencyRestorer = dependencyRestorer;
    this.artifactVerifier = artifactVerifier; this.artifactPublisher = artifactPublisher; this.logger = logger; this.redactor = redactor;
    this.stopping = false; this.loopPromise = null; this.waitResolver = null; this.currentAbortController = null;
  }
  start() { if (!this.loopPromise) this.loopPromise = this.#loop(); }
  wake() { this.waitResolver?.(); this.waitResolver = null; }
  async stop() { this.stopping = true; this.currentAbortController?.abort(); this.wake(); await this.loopPromise; }

  async #loop() {
    while (!this.stopping) {
      const job = this.store.claimNextJob();
      if (!job) { await this.#waitForWork(); continue; }
      await this.#processJob(job);
    }
  }
  async #waitForWork() {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.waitResolver === wake) this.waitResolver = null; resolve(); }, this.config.runner.pollIntervalMs); timer.unref?.();
      const wake = () => { clearTimeout(timer); resolve(); }; this.waitResolver = wake;
    });
  }

  async #processJob(claimedJob) {
    const startedAt = Date.now();
    let workspacePath = null;
    let unityLogPath = null;
    let cleaned = false;
    this.currentAbortController = new AbortController();
    const heartbeat = setInterval(() => this.store.heartbeat(claimedJob.id), this.config.runner.heartbeatIntervalMs); heartbeat.unref?.();
    try {
      if (!claimedJob.sourceSnapshotId) throw new CiError({ code: 'SOURCE_SNAPSHOT_MISSING', category: 'RUNNER_ERROR', message: 'WorkerへSource Snapshot IDが渡されていません。', stage: STAGES.MATERIALIZING_WORKSPACE });
      await this.statusService.setStage(claimedJob.id, STAGES.MATERIALIZING_WORKSPACE);
      workspacePath = path.join(this.config.dataDir, 'workspaces', claimedJob.id);
      await this.snapshotStore.materializeWorkspace({ snapshotId: claimedJob.sourceSnapshotId, workspacePath });

      await this.statusService.setStage(claimedJob.id, STAGES.ENSURING_UNITY);
      let job = this.store.getJob(claimedJob.id);
      const project = await this.unityService.inspectProject(workspacePath, job.buildProfilePath, job.projectPath);
      if (job.unityVersion && project.unityVersion !== job.unityVersion) {
        throw new CiError({ code: 'SOURCE_SNAPSHOT_UNITY_VERSION_MISMATCH', category: 'UNITY_ENV_ERROR', message: 'SnapshotのUnity versionがCoordinatorの検証結果と一致しません。', stage: STAGES.ENSURING_UNITY, details: { expected: job.unityVersion, actual: project.unityVersion } });
      }
      if (!job.unityVersion) this.store.setUnityVersion(job.id, project.unityVersion);

      await this.statusService.setStage(job.id, STAGES.RESTORING_DEPENDENCIES);
      await this.dependencyRestorer.restore({ projectPath: project.projectPath, signal: this.currentAbortController.signal });
      job = this.store.getJob(job.id);
      let stageSixUpdate = Promise.resolve();
      const candidate = await this.unityService.build({
        job, workspacePath, projectPath: project.projectPath, unityExecutable: project.unityExecutable, signal: this.currentAbortController.signal,
        onSpawn: () => { stageSixUpdate = this.statusService.setStage(job.id, STAGES.BUILDING); stageSixUpdate.catch((error) => this.logger?.warn('Failed to update BUILDING status.', { jobId: job.id, error })); },
      });
      await stageSixUpdate;
      unityLogPath = candidate.logPath;
      this.store.setBuildSucceeded(job.id);

      await this.statusService.setStage(job.id, STAGES.PUBLISHING_ARTIFACT);
      const artifact = await this.artifactVerifier.verify(candidate);
      this.store.setArtifact(job.id, artifact);
      job = this.store.getJob(job.id);
      this.store.markDeliveryAttempted(job.id);
      const published = await this.artifactPublisher.publish(job, artifact, formatSuccess(job, artifact, Date.now() - startedAt));
      this.store.setDeliverySucceeded(job.id, published);

      await this.statusService.setStage(job.id, STAGES.CLEANING_UP);
      await this.snapshotStore.cleanupWorkspace(workspacePath);
      workspacePath = null; cleaned = true;
      this.store.markSuccess(job.id);
      await this.statusService.setStage(job.id, STAGES.SUCCEEDED);
      this.logger?.info('Build job succeeded.', { jobId: job.id, commitSha: job.resolvedCommitSha, sourceSnapshotId: job.sourceSnapshotId, size: artifact.size, durationMs: Date.now() - startedAt });
    } catch (error) {
      const ciError = asCiError(error, { code: 'UNEXPECTED_RUNNER_ERROR', category: 'RUNNER_ERROR', message: 'Runnerで予期しないエラーが発生しました。', stage: this.#currentStage(claimedJob.id) });
      if (this.stopping && (ciError.code === 'UNITY_BUILD_ABORTED' || this.currentAbortController.signal.aborted)) {
        this.store.appendEvent(claimedJob.id, 'RUNNER_SHUTDOWN_INTERRUPTED_JOB', ciError.stage, { message: ciError.message });
      } else {
        if (!ciError.details?.logTail && unityLogPath) ciError.details = { ...(ciError.details ?? {}), logTail: await tailFile(unityLogPath) };
        this.store.markFailure(claimedJob.id, ciError, resultForCategory(ciError.category));
        await this.statusService.setFailure(claimedJob.id);
        await this.#postThreadSafely(claimedJob.id, formatFailure(this.store.getJob(claimedJob.id), ciError, this.redactor));
        this.logger?.error('Build job failed.', { jobId: claimedJob.id, error: ciError });
      }
    } finally {
      clearInterval(heartbeat); this.currentAbortController = null;
      if (workspacePath && !cleaned) {
        try { await this.snapshotStore.cleanupWorkspace(workspacePath); }
        catch (error) { this.logger?.warn('Workspace cleanup failed.', { jobId: claimedJob.id, workspacePath, error }); this.store.appendEvent(claimedJob.id, 'WORKSPACE_CLEANUP_FAILED', 8, { message: error instanceof Error ? error.message : String(error) }); }
      }
    }
  }
  #currentStage(jobId) { const desired = this.store.getJob(jobId)?.desiredStatus; return /^\d$/.test(desired ?? '') ? Number(desired) : null; }
  async #postThreadSafely(jobId, text) { const job = this.store.getJob(jobId); const thread = job ? threadReference(job) : null; if (!thread) return false; try { await this.adapters.get(job.platform).postThreadMessage(thread, text); return true; } catch (error) { this.logger?.warn('Failed to post build progress to the thread.', { jobId, error }); return false; } }
}

function formatSuccess(job, artifact, durationMs) {
  return [`✅ Build \`${job.id}\` succeeded`, '', `Branch: \`${job.requestedBranch}\``, ...(job.projectPath !== '.' ? [`Project: \`${job.projectPath}\``] : []), `Commit: \`${shortSha(job.resolvedCommitSha)}\``, `Snapshot: \`${job.sourceSnapshotId}\``, `Profile: \`${job.buildProfilePath}\``, `Unity: \`${job.unityVersion}\``, `Size: ${formatBytes(artifact.size)}`, `SHA-256: \`${artifact.sha256}\``, `Duration: ${formatDuration(durationMs)}`].join('\n');
}
function formatFailure(job, error, redactor) { const stage = error.stage; const lines = [`❌ Build \`${job.id}\` failed`, '', `Stage: ${stage === null || stage === undefined ? 'unknown' : `${stage} / ${stageName(stage)}`}`, `Code: \`${error.code}\``]; if (job.resolvedCommitSha) lines.push(`Commit: \`${shortSha(job.resolvedCommitSha)}\``); if (job.sourceSnapshotId) lines.push(`Snapshot: \`${job.sourceSnapshotId}\``); lines.push('', error.message); const logTail = error.details?.logTail ?? error.details?.stderr; if (logTail) lines.push('', 'ログ末尾:', codeBlock(redactor?.redact(logTail) ?? logTail)); if (error.category === 'DELIVERY_ERROR' && job.artifactPath) lines.push('', `APKはMac上に保持されています: \`${job.artifactPath}\``); return lines.join('\n'); }
function resultForCategory(category) { return ['REQUEST_ERROR', 'SOURCE_ERROR', 'GIT_ERROR', 'WORKSPACE_ERROR', 'DEPENDENCY_ERROR', 'UNITY_ENV_ERROR', 'UNITY_BUILD_ERROR', 'ARTIFACT_ERROR', 'DELIVERY_ERROR', 'RUNNER_ERROR'].includes(category) ? category : 'FAILED'; }
