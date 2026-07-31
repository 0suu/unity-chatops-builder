import { CiError, asCiError } from '../core/errors.js';
import { STAGES, stageName } from '../core/stages.js';
import { threadReference } from '../chat/status-service.js';
import { codeBlock, formatBytes, formatDuration, shortSha, tailFile } from '../utils/format.js';

export class BuildWorker {
  constructor({ config, store, adapters, statusService, gitService, unityService, artifactVerifier, artifactPublisher, logger, redactor }) {
    this.config = config;
    this.store = store;
    this.adapters = adapters;
    this.statusService = statusService;
    this.gitService = gitService;
    this.unityService = unityService;
    this.artifactVerifier = artifactVerifier;
    this.artifactPublisher = artifactPublisher;
    this.logger = logger;
    this.redactor = redactor;
    this.stopping = false;
    this.loopPromise = null;
    this.waitResolver = null;
    this.currentAbortController = null;
  }

  start() {
    if (this.loopPromise) return;
    this.loopPromise = this.#loop();
  }

  wake() {
    this.waitResolver?.();
    this.waitResolver = null;
  }

  async stop() {
    this.stopping = true;
    this.currentAbortController?.abort();
    this.wake();
    await this.loopPromise;
  }

  async #loop() {
    while (!this.stopping) {
      const job = this.store.claimNextJob();
      if (!job) {
        await this.#waitForWork();
        continue;
      }
      await this.#processJob(job);
    }
  }

  async #waitForWork() {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waitResolver === wake) this.waitResolver = null;
        resolve();
      }, this.config.runner.pollIntervalMs);
      timer.unref?.();

      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waitResolver = wake;
    });
  }

  async #processJob(claimedJob) {
    const startedAt = Date.now();
    let workspacePath = null;
    let unityLogPath = null;
    this.currentAbortController = new AbortController();
    const heartbeat = setInterval(() => this.store.heartbeat(claimedJob.id), this.config.runner.heartbeatIntervalMs);
    heartbeat.unref?.();

    this.logger.info('Build job started.', {
      jobId: claimedJob.id,
      branch: claimedJob.requestedBranch,
      platform: claimedJob.platform,
      attempt: claimedJob.attempt,
    });

    try {
      await this.statusService.setStage(claimedJob.id, STAGES.SYNCING_REPOSITORY);
      const commitSha = await this.gitService.synchronizeAndResolve(claimedJob.requestedBranch);
      this.store.setResolvedCommit(claimedJob.id, commitSha);
      await this.#postThreadSafely(claimedJob.id, `Commitを \`${shortSha(commitSha)}\` に固定しました。`);

      await this.statusService.setStage(claimedJob.id, STAGES.PREPARING_WORKSPACE);
      workspacePath = await this.gitService.prepareWorkspace(claimedJob.id, commitSha);

      await this.statusService.setStage(claimedJob.id, STAGES.PREPARING_PROJECT);
      let job = this.store.getJob(claimedJob.id);
      const project = await this.unityService.inspectProject(workspacePath, job.buildProfilePath);
      this.store.setUnityVersion(job.id, project.unityVersion);

      await this.statusService.setStage(job.id, STAGES.LOADING_UNITY);
      job = this.store.getJob(job.id);
      let stageSixUpdate = Promise.resolve();
      const candidate = await this.unityService.build({
        job,
        workspacePath,
        unityExecutable: project.unityExecutable,
        signal: this.currentAbortController.signal,
        onSpawn: () => {
          stageSixUpdate = this.statusService.setStage(job.id, STAGES.BUILDING);
          stageSixUpdate.catch((error) => this.logger.warn('Failed to update BUILDING status.', { jobId: job.id, error }));
        },
      });
      await stageSixUpdate;
      unityLogPath = candidate.logPath;
      this.store.setBuildSucceeded(job.id);

      await this.statusService.setStage(job.id, STAGES.VERIFYING_ARTIFACT);
      const artifact = await this.artifactVerifier.verify(candidate);
      this.store.setArtifact(job.id, artifact);

      await this.statusService.setStage(job.id, STAGES.UPLOADING);
      job = this.store.getJob(job.id);
      const successText = formatSuccess(job, artifact, Date.now() - startedAt);
      const published = await this.artifactPublisher.publish(job, artifact, successText);
      this.store.setDeliverySucceeded(job.id, published);
      this.store.markSuccess(job.id);
      await this.statusService.setStage(job.id, STAGES.SUCCEEDED);

      this.logger.info('Build job succeeded.', {
        jobId: job.id,
        commitSha,
        size: artifact.size,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const ciError = asCiError(error, {
        code: 'UNEXPECTED_RUNNER_ERROR',
        category: 'RUNNER_ERROR',
        message: 'Runnerで予期しないエラーが発生しました。',
        stage: this.#currentStage(claimedJob.id),
      });

      if (this.stopping && (ciError.code === 'UNITY_BUILD_ABORTED' || this.currentAbortController.signal.aborted)) {
        this.store.appendEvent(claimedJob.id, 'RUNNER_SHUTDOWN_INTERRUPTED_JOB', ciError.stage, {
          message: ciError.message,
        });
        this.logger.warn('Build job left running for startup recovery because the runner is stopping.', {
          jobId: claimedJob.id,
        });
      } else {
        if (!ciError.details?.logTail && unityLogPath) {
          ciError.details = {
            ...(ciError.details ?? {}),
            logTail: await tailFile(unityLogPath),
          };
        }
        this.store.markFailure(claimedJob.id, ciError, resultForCategory(ciError.category));
        await this.statusService.setFailure(claimedJob.id);
        await this.#postThreadSafely(claimedJob.id, formatFailure(this.store.getJob(claimedJob.id), ciError, this.redactor));
        this.logger.error('Build job failed.', { jobId: claimedJob.id, error: ciError });
      }
    } finally {
      clearInterval(heartbeat);
      this.currentAbortController = null;
      if (workspacePath) {
        try {
          await this.gitService.cleanupWorkspace(workspacePath);
        } catch (error) {
          this.logger.warn('Workspace cleanup failed.', { jobId: claimedJob.id, workspacePath, error });
          this.store.appendEvent(claimedJob.id, 'WORKSPACE_CLEANUP_FAILED', null, {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  #currentStage(jobId) {
    const desired = this.store.getJob(jobId)?.desiredStatus;
    return /^\d$/.test(desired ?? '') ? Number(desired) : null;
  }

  async #postThreadSafely(jobId, text) {
    const job = this.store.getJob(jobId);
    const thread = job ? threadReference(job) : null;
    if (!job || !thread) return false;
    try {
      await this.adapters.get(job.platform).postThreadMessage(thread, text);
      return true;
    } catch (error) {
      this.logger.warn('Failed to post build progress to the thread.', { jobId, error });
      return false;
    }
  }
}

function formatSuccess(job, artifact, durationMs) {
  return [
    `✅ Build \`${job.id}\` succeeded`,
    '',
    `Branch: \`${job.requestedBranch}\``,
    `Commit: \`${shortSha(job.resolvedCommitSha)}\``,
    `Profile: \`${job.buildProfilePath}\``,
    `Unity: \`${job.unityVersion}\``,
    `Size: ${formatBytes(artifact.size)}`,
    `SHA-256: \`${artifact.sha256}\``,
    `Duration: ${formatDuration(durationMs)}`,
  ].join('\n');
}

function formatFailure(job, error, redactor) {
  const stage = error.stage;
  const lines = [
    `❌ Build \`${job.id}\` failed`,
    '',
    `Stage: ${stage === null || stage === undefined ? 'unknown' : `${stage} / ${stageName(stage)}`}`,
    `Code: \`${error.code}\``,
  ];
  if (job.resolvedCommitSha) lines.push(`Commit: \`${shortSha(job.resolvedCommitSha)}\``);
  lines.push('', error.message);

  const logTail = error.details?.logTail ?? error.details?.stderr;
  if (logTail) {
    lines.push('', 'ログ末尾:', codeBlock(redactor?.redact(logTail) ?? logTail));
  }
  if (error.category === 'DELIVERY_ERROR' && job.artifactPath) {
    lines.push('', `APKはMac上に保持されています: \`${job.artifactPath}\``);
  }
  return lines.join('\n');
}

function resultForCategory(category) {
  return [
    'REQUEST_ERROR',
    'GIT_ERROR',
    'WORKSPACE_ERROR',
    'UNITY_ENV_ERROR',
    'UNITY_BUILD_ERROR',
    'ARTIFACT_ERROR',
    'DELIVERY_ERROR',
    'RUNNER_ERROR',
  ].includes(category) ? category : 'FAILED';
}
