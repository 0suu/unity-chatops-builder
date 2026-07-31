import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { CiError, asCiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { runProcess } from '../core/process-runner.js';
import { isPathInsideOrEqual, safeSlug, validateUnityProjectPath } from '../core/paths.js';
import { coordinatorSourceEnvironment } from './lfs-auth-provider.js';
import { parseLfsPointer } from './lfs-pointer.js';

export class RepositorySourceResolver {
  constructor({ config, dataDir, logger, endpointPolicy, lfsObjectCache, lfsClient, snapshotStore, processRunner = runProcess }) {
    this.config = config; this.dataDir = dataDir; this.logger = logger; this.endpointPolicy = endpointPolicy; this.lfsObjectCache = lfsObjectCache; this.lfsClient = lfsClient; this.snapshotStore = snapshotStore; this.processRunner = processRunner;
    this.repositoriesRoot = path.join(dataDir, 'repositories'); this.stagingRoot = path.join(dataDir, 'source-staging'); this.timeoutMs = config.runner.gitTimeoutSeconds * 1000; this.environment = coordinatorSourceEnvironment(); this.serial = Promise.resolve();
  }
  validateBranchName(branch) { return this.#assertValidBranch(branch); }
  resolve({ repository, requestedRef, projectPath = '.' }) { const task = this.serial.then(() => this.#resolve(repository, requestedRef, projectPath)); this.serial = task.catch(() => {}); return task; }

  async #resolve(repository, branch, projectPath) {
    this.#assertRepository(repository); await this.#assertValidBranch(branch);
    const project = validateUnityProjectPath(projectPath);
    if (!project.ok) throw new CiError({ code: 'INVALID_UNITY_PROJECT_PATH', category: 'REQUEST_ERROR', message: project.reason, stage: STAGES.AUTHORIZING });
    const mirrorPath = this.#mirrorPath(repository);
    const commitSha = await this.#synchronizeAndResolve(repository, branch, mirrorPath);
    const stagingPath = path.join(this.stagingRoot, `${safeSlug(repository.owner)}-${safeSlug(repository.name)}-${commitSha.slice(0, 12)}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(this.stagingRoot, { recursive: true }); let worktreeAdded = false;
    try {
      const add = await this.#git(['-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', '--git-dir', mirrorPath, 'worktree', 'add', '--detach', '--', stagingPath, commitSha]);
      this.#assertGit(add, 'SOURCE_CHECKOUT_FAILED', 'CommitをSource Stagingへcheckoutできませんでした。'); worktreeAdded = true;
      const tracked = await this.#trackedFiles(stagingPath); await this.#assertNoSubmodules(stagingPath);
      const lfsPaths = await this.#lfsTrackedPaths(stagingPath, tracked);
      const lfsPolicy = this.config.sourceDependencies.gitLfs;
      if (lfsPaths.length > 0 && !lfsPolicy.enabled) throw sourceError('LFS_REQUIRED_BUT_DISABLED', 'RepositoryでGit LFSが使われていますがSource Policyで無効です。');

      const pointers = [];
      for (const relativePath of lfsPaths) {
        const absolute = safeSourcePath(stagingPath, relativePath); const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink()) throw sourceError('LFS_POINTER_INVALID', 'LFS対象pathはregular fileである必要があります。', { path: relativePath });
        const pointer = parseLfsPointer(await readFile(absolute), { path: relativePath }); pointers.push({ path: relativePath, mode: info.mode & 0o777, ...pointer });
      }

      const protectionLease = pointers.length > 0 ? await this.lfsObjectCache.acquireProtection(pointers) : null;
      let snapshot; let unityVersion;
      try {
        if (pointers.length > 0) {
          const lfsConfigContent = await readOptional(path.join(stagingPath, '.lfsconfig'));
          const endpointUrl = await this.endpointPolicy.resolve({ trustedRemoteUrl: repository.sshUrl, configuredEndpointUrl: lfsPolicy.endpointUrl, lfsConfigContent });
          const objectPaths = await this.lfsObjectCache.prepare({ pointers, lfsClient: this.lfsClient, remoteUrl: repository.sshUrl, endpointUrl, protectionLease });
          for (const pointer of pointers) await this.lfsObjectCache.materialize({ cachePath: objectPaths.get(pointer.oidSha256), destinationPath: safeSourcePath(stagingPath, pointer.path), mode: pointer.mode, expectedOidSha256: pointer.oidSha256, expectedSizeBytes: pointer.sizeBytes });
        }
        unityVersion = await readUnityVersion(stagingPath, project.value);
        snapshot = await this.snapshotStore.publish({ repositoryId: repository.id, commitSha, stagingPath, lfsObjects: pointers });
      } finally { await protectionLease?.release(); }
      return { repositoryId: repository.id, repositoryDisplayName: repository.displayName, commitSha, unityVersion, sourceSnapshotId: snapshot.snapshotId, sourceSnapshotManifest: snapshot.manifest };
    } catch (error) {
      throw asCiError(error, { code: 'SOURCE_RESOLUTION_FAILED', category: 'SOURCE_ERROR', message: 'Source Snapshotの解決に失敗しました。', stage: STAGES.RESOLVING_SOURCE });
    } finally {
      if (worktreeAdded) { const result = await this.#git(['--git-dir', mirrorPath, 'worktree', 'remove', '--force', '--', stagingPath], { timeoutMs: 120_000 }); if (result.code !== 0) this.logger?.warn('Failed to remove source staging worktree.', { stagingPath, stderr: result.stderr }); }
      await rm(stagingPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await this.#git(['--git-dir', mirrorPath, 'worktree', 'prune'], { timeoutMs: 30_000 }).catch(() => {});
    }
  }

  #assertRepository(repository) {
    if (!repository || typeof repository.id !== 'string' || typeof repository.sshUrl !== 'string' || !repository.id || !repository.sshUrl) throw new CiError({ code: 'INVALID_REPOSITORY', category: 'REQUEST_ERROR', message: '正規化済みRepository情報がありません。', stage: STAGES.AUTHORIZING });
  }
  #mirrorPath(repository) { const digest = createHash('sha256').update(repository.id).digest('hex').slice(0, 20); return path.join(this.repositoriesRoot, `${safeSlug(repository.name, 48)}-${digest}.git`); }
  async #assertValidBranch(branch) { const result = await this.#git(['check-ref-format', '--branch', branch], { timeoutMs: 30_000 }); if (result.code !== 0) throw new CiError({ code: 'INVALID_BRANCH_NAME', category: 'REQUEST_ERROR', message: 'Gitのブランチ名として不正です。', stage: STAGES.AUTHORIZING, details: { branch, stderr: result.stderr.trim() } }); }

  async #synchronizeAndResolve(repository, branch, mirrorPath) {
    await mkdir(path.dirname(mirrorPath), { recursive: true });
    if (!await exists(mirrorPath)) { const clone = await this.#git(['clone', '--bare', '--no-tags', '--', repository.sshUrl, mirrorPath]); this.#assertGit(clone, 'REPOSITORY_ACCESS_FAILED', '指定RepositoryをSSHでcloneできませんでした。ビルド用macOSアカウントのアクセス権を確認してください。'); }
    this.#assertGit(await this.#git(['--git-dir', mirrorPath, 'remote', 'set-url', 'origin', repository.sshUrl]), 'GIT_REMOTE_CONFIGURATION_FAILED', 'Git remoteの設定に失敗しました。');
    this.#assertGit(await this.#git(['--git-dir', mirrorPath, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']), 'GIT_REMOTE_CONFIGURATION_FAILED', 'Git fetch refspecの設定に失敗しました。');
    this.#assertGit(await this.#git(['--git-dir', mirrorPath, 'fetch', '--prune', '--no-tags', 'origin']), 'GIT_FETCH_FAILED', '指定RepositoryからCommitをfetchできませんでした。');
    const resolved = await this.#git(['--git-dir', mirrorPath, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
    if (resolved.code !== 0) throw sourceError('BRANCH_NOT_FOUND', '指定されたリモートブランチが見つかりません。', { repository: repository.id, branch, stderr: resolved.stderr.trim() });
    const commitSha = resolved.stdout.trim(); if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw sourceError('INVALID_COMMIT_SHA', 'Gitが返したCommit SHAを検証できませんでした。'); return commitSha.toLowerCase();
  }
  async #trackedFiles(stagingPath) { const result = await this.#git(['-C', stagingPath, 'ls-files', '-z']); this.#assertGit(result, 'SOURCE_FILE_LIST_FAILED', 'tracked file一覧を取得できませんでした。'); return result.stdout.split('\0').filter(Boolean); }
  async #lfsTrackedPaths(stagingPath, tracked) {
    if (tracked.length === 0) return [];
    const result = await this.#git(['-C', stagingPath, 'check-attr', '-z', '--stdin', 'filter'], { input: `${tracked.join('\0')}\0`, maxCaptureBytes: 64 * 1024 * 1024 });
    this.#assertGit(result, 'LFS_ATTRIBUTE_SCAN_FAILED', '.gitattributesからLFS対象を検出できませんでした。');
    const fields = result.stdout.split('\0'); const selected = [];
    for (let index = 0; index + 2 < fields.length; index += 3) { const [file, attribute, value] = fields.slice(index, index + 3); if (attribute === 'filter' && value === 'lfs') selected.push(file); }
    return selected.sort((left, right) => left.localeCompare(right, 'en'));
  }
  async #assertNoSubmodules(stagingPath) { const result = await this.#git(['-C', stagingPath, 'ls-files', '--stage', '-z']); this.#assertGit(result, 'SOURCE_FILE_LIST_FAILED', 'gitlink検査に失敗しました。'); const gitlinks = result.stdout.split('\0').filter(Boolean).filter((record) => record.startsWith('160000 ')); if (gitlinks.length > 0 || this.config.sourceDependencies.submodules.enabled) throw sourceError('SUBMODULES_DISABLED', '初期版ではGit submoduleを許可していません。', { count: gitlinks.length }); }
  #assertGit(result, code, message) { if (result.code === 0 && !result.timedOut && !result.aborted) return; throw sourceError(code, message, { exitCode: result.code, signal: result.signal, timedOut: result.timedOut, stderr: result.stderr.trim().slice(-20_000) }); }
  #git(args, overrides = {}) { return this.processRunner('git', args, { timeoutMs: this.timeoutMs, env: this.environment, logger: this.logger, ...overrides }); }
}

async function readUnityVersion(stagingPath, projectPath) {
  const projectRoot = safeSourcePath(stagingPath, projectPath);
  let projectRootRealPath;
  try {
    const projectStat = await lstat(projectRoot);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error('project is not a regular non-symlink directory');
    const [stagingRealPath, resolvedProjectRoot] = await Promise.all([realpath(stagingPath), realpath(projectRoot)]);
    if (!isPathInsideOrEqual(stagingRealPath, resolvedProjectRoot)) throw new Error('project escapes staging');
    projectRootRealPath = resolvedProjectRoot;
  } catch (error) {
    throw sourceError('UNITY_PROJECT_NOT_FOUND', '指定されたUnityプロジェクトをSource Staging内で確認できません。', { projectPath, cause: error.message });
  }

  const file = path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt');
  let content;
  try {
    const fileStat = await lstat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('ProjectVersion.txt is not a regular non-symlink file');
    const resolvedFile = await realpath(file);
    if (!isPathInsideOrEqual(projectRootRealPath, resolvedFile)) throw new Error('ProjectVersion.txt escapes project');
    content = await readFile(file, 'utf8');
  } catch (error) {
    throw sourceError('UNITY_VERSION_FILE_MISSING', '指定されたUnityプロジェクトのProjectSettings/ProjectVersion.txtを読めません。', { projectPath, cause: error.message });
  }
  const match = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(content);
  if (!match) throw sourceError('UNITY_VERSION_INVALID', 'ProjectVersion.txtからUnity versionを解析できません。', { projectPath });
  return match[1];
}
function safeSourcePath(root, relative) { if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw sourceError('SOURCE_PATH_INVALID', 'Source pathが不正です。', { path: relative }); const target = path.resolve(root, relative); if (!isPathInsideOrEqual(root, target)) throw sourceError('SOURCE_PATH_INVALID', 'Source pathがstaging外を指しています。', { path: relative }); return target; }
async function readOptional(file) { try { return await readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function exists(target) { try { await access(target); return true; } catch { return false; } }
function sourceError(code, message, details = null) { return new CiError({ code, category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details }); }
