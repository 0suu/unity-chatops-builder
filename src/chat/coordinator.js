import { parseBuildRequest } from '../core/request-parser.js';
import { validateBuildProfilePath, validateUnityProjectPath } from '../core/paths.js';
import { CiError, asCiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { codeBlock, formatBytes, shortSha } from '../utils/format.js';
import { messageReference, threadReference } from './status-service.js';
import { normalizeRepositoryReference } from '../source/repository-reference.js';

export class BuildCoordinator {
  constructor({ config, store, adapters, statusService, sourceResolver, logger, onQueued }) {
    this.config = config; this.store = store; this.adapters = adapters; this.statusService = statusService; this.sourceResolver = sourceResolver; this.logger = logger; this.onQueued = onQueued;
  }
  registerHandlers() { for (const adapter of this.adapters.values()) adapter.setIncomingHandler((message) => this.handleIncomingMessage(message)); }

  async handleIncomingMessage(message) {
    const parsed = parseBuildRequest(message.text);
    if (!parsed.recognized) return;
    const repository = normalizeRepositoryReference(parsed.value?.repository, { defaultHost: this.config.repositoryAccess.defaultHost, allowedHosts: this.config.repositoryAccess.allowedHosts });
    const repositoryIdentity = repository.ok ? repository.value.id : parsed.value?.repository ?? 'invalid-repository';
    const { created, job: initialJob } = this.store.createJob({
      platform: message.platform, workspaceId: message.workspaceId, channelId: message.channelId, sourceMessageId: message.sourceMessageId,
      requesterId: message.requesterId, requesterName: message.requesterName, repositoryAlias: repositoryIdentity,
      projectPath: parsed.value?.project ?? '.', requestedBranch: parsed.value?.branch ?? null, buildProfilePath: parsed.value?.profile ?? null,
    });
    if (!created) { this.logger?.debug('Duplicate chat event ignored.', { jobId: initialJob?.id }); return; }
    const adapter = this.adapters.get(message.platform);
    await this.statusService.setStage(initialJob.id, STAGES.AUTHORIZING);
    let job = initialJob;
    try {
      const thread = await adapter.createThread(messageReference(job), { jobId: job.id, repository: parsed.value?.repository, branch: parsed.value?.branch });
      this.store.setThread(job.id, thread.threadId); job = this.store.getJob(job.id);
    } catch (error) {
      await this.#reject(job, asCiError(error, { code: 'THREAD_CREATE_FAILED', category: 'REQUEST_ERROR', message: '結果返信用のスレッドを作成できませんでした。', stage: STAGES.AUTHORIZING }));
      return;
    }

    try {
      const request = this.#validateRequest(parsed, repository);
      await this.sourceResolver.validateBranchName(parsed.value.branch);
      await this.statusService.setStage(job.id, STAGES.RESOLVING_SOURCE);
      const resolved = await this.sourceResolver.resolve({ repository: repository.value, requestedRef: parsed.value.branch, projectPath: request.projectPath });
      this.store.setResolvedSource(job.id, resolved); job = this.store.getJob(job.id);
      await this.#postThreadSafely(job, [
        'Sourceを解決しました。',
        `Repository: \`${repository.value.displayName}\``,
        `Commit: \`${shortSha(resolved.commitSha)}\``,
        `Snapshot: \`${resolved.sourceSnapshotId}\``,
        `LFS: ${resolved.sourceSnapshotManifest.lfs.objectCount} files / ${formatBytes(resolved.sourceSnapshotManifest.lfs.totalSizeBytes)}`,
      ].join('\n'));
      const queuePosition = this.store.setQueued(job.id);
      await this.statusService.setStage(job.id, STAGES.WAITING_FOR_WORKER); job = this.store.getJob(job.id);
      await this.#postThreadSafely(job, [
        `Build \`${job.id}\` を受け付けました。`, '',
        `Repository: \`${repository.value.displayName}\``,
        `Branch: \`${job.requestedBranch}\``,
        ...(job.projectPath !== '.' ? [`Project: \`${job.projectPath}\``] : []),
        `Profile: \`${request.profilePath}\``,
        `Queue: ${queuePosition}番目`,
      ].join('\n'));
      this.onQueued?.();
    } catch (error) {
      await this.#reject(job, asCiError(error, { code: 'REQUEST_OR_SOURCE_RESOLUTION_FAILED', category: 'SOURCE_ERROR', message: '要求検証またはSource Snapshot解決に失敗しました。', stage: STAGES.RESOLVING_SOURCE }));
    }
  }

  #validateRequest(parsed, repository) {
    if (parsed.errors?.length) throw new CiError({ code: 'INVALID_REQUEST_FORMAT', category: 'REQUEST_ERROR', message: 'ビルド要求の形式が正しくありません。', stage: STAGES.AUTHORIZING, details: { errors: parsed.errors } });
    if (!repository.ok) throw new CiError({ code: 'INVALID_REPOSITORY', category: 'REQUEST_ERROR', message: repository.reason, stage: STAGES.AUTHORIZING });
    const project = validateUnityProjectPath(parsed.value.project ?? '.');
    if (!project.ok) throw new CiError({ code: 'INVALID_UNITY_PROJECT_PATH', category: 'REQUEST_ERROR', message: project.reason, stage: STAGES.AUTHORIZING });
    const profile = validateBuildProfilePath(parsed.value.profile);
    if (!profile.ok) throw new CiError({ code: 'INVALID_BUILD_PROFILE_PATH', category: 'REQUEST_ERROR', message: profile.reason, stage: STAGES.AUTHORIZING });
    if (this.config.unity.allowedBuildProfiles.length > 0 && !this.config.unity.allowedBuildProfiles.includes(profile.value)) throw new CiError({ code: 'BUILD_PROFILE_NOT_ALLOWED', category: 'REQUEST_ERROR', message: '指定されたBuild Profileは許可リストにありません。', stage: STAGES.AUTHORIZING });
    if (!this.config.repositoryAccess.compiledBranchPatterns.some((pattern) => pattern.test(parsed.value.branch))) throw new CiError({ code: 'BRANCH_NOT_ALLOWED', category: 'REQUEST_ERROR', message: '指定されたブランチ名は許可パターンに一致しません。', stage: STAGES.AUTHORIZING });
    return { projectPath: project.value, profilePath: profile.value };
  }

  async #reject(job, error) {
    this.store.markFailure(job.id, error, error.category === 'REQUEST_ERROR' ? 'REQUEST_ERROR' : 'SOURCE_ERROR');
    await this.statusService.setFailure(job.id);
    const latest = this.store.getJob(job.id);
    if (latest.threadId) await this.#postThreadSafely(latest, formatRequestError(latest, error));
    this.logger?.warn('Build request rejected.', { jobId: job.id, error });
  }
  async #postThreadSafely(job, text) { const thread = threadReference(job); if (!thread) return false; try { await this.adapters.get(job.platform).postThreadMessage(thread, text); return true; } catch (error) { this.logger?.warn('Failed to post a thread message.', { jobId: job.id, error }); return false; } }
}
function formatRequestError(job, error) { const lines = [`❌ Build \`${job.id}\` rejected`, '', `Code: \`${error.code}\``, error.message]; if (Array.isArray(error.details?.errors)) lines.push('', codeBlock(error.details.errors.map((item) => `- ${item}`).join('\n'), 8000)); return lines.join('\n'); }
