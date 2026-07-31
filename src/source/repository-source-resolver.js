import { access, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CiError, asCiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { runProcess } from '../core/process-runner.js';
import { isPathInsideOrEqual, safeSlug } from '../core/paths.js';
import { coordinatorSourceEnvironment } from './lfs-auth-provider.js';
import { parseLfsPointer } from './lfs-pointer.js';

export class RepositorySourceResolver {
  constructor({ config, dataDir, logger, endpointPolicy, lfsObjectCache, lfsClient, snapshotStore, processRunner = runProcess }) {
    this.config = config;
    this.dataDir = dataDir;
    this.logger = logger;
    this.endpointPolicy = endpointPolicy;
    this.lfsObjectCache = lfsObjectCache;
    this.lfsClient = lfsClient;
    this.snapshotStore = snapshotStore;
    this.processRunner = processRunner;
    this.mirrorPath = path.join(dataDir, 'repositories', `${safeSlug(config.repository.alias)}.git`);
    this.stagingRoot = path.join(dataDir, 'source-staging');
    this.timeoutMs = config.runner.gitTimeoutSeconds * 1000;
    this.environment = coordinatorSourceEnvironment();
    this.serial = Promise.resolve();
  }

  validateBranchName(branch) {
    return this.#assertValidBranch(branch);
  }

  resolve({ requestedRef }) {
    const task = this.serial.then(() => this.#resolve(requestedRef));
    this.serial = task.catch(() => {});
    return task;
  }

  async #resolve(branch) {
    await this.#assertValidBranch(branch);
    const commitSha = await this.#synchronizeAndResolve(branch);
    const stagingPath = path.join(this.stagingRoot, `${safeSlug(this.config.repository.alias)}-${commitSha.slice(0, 12)}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(this.stagingRoot, { recursive: true });
    let worktreeAdded = false;
    try {
      const add = await this.#git([
        '-c', 'filter.lfs.process=',
        '-c', 'filter.lfs.smudge=',
        '-c', 'filter.lfs.required=false',
        '--git-dir', this.mirrorPath,
        'worktree', 'add', '--detach', '--', stagingPath, commitSha,
      ]);
      this.#assertGit(add, 'SOURCE_CHECKOUT_FAILED', 'CommitをSource Stagingへcheckoutできませんでした。');
      worktreeAdded = true;

      const tracked = await this.#trackedFiles(stagingPath);
      await this.#assertNoSubmodules(stagingPath);
      const lfsPaths = await this.#lfsTrackedPaths(stagingPath, tracked);
      if (lfsPaths.length > 0 && !this.config.repository.sourceDependencies.gitLfs.enabled) {
        throw sourceError('LFS_REQUIRED_BUT_DISABLED', 'RepositoryでGit LFSが使われていますがRepository Policyで無効です。');
      }

      const pointers = [];
      for (const relativePath of lfsPaths) {
        const absolute = safeSourcePath(stagingPath, relativePath);
        const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink()) throw sourceError('LFS_POINTER_INVALID', 'LFS対象pathはregular fileである必要があります。', { path: relativePath });
        const pointer = parseLfsPointer(await readFile(absolute), { path: relativePath });
        pointers.push({ path: relativePath, mode: info.mode & 0o777, ...pointer });
      }

      const protectionLease = pointers.length > 0
        ? await this.lfsObjectCache.acquireProtection(pointers)
        : null;
      let snapshot;
      let unityVersion;
      try {
        if (pointers.length > 0) {
          const lfsConfigContent = await readOptional(path.join(stagingPath, '.lfsconfig'));
          const endpointUrl = await this.endpointPolicy.resolve({
            trustedRemoteUrl: this.config.repository.sshUrl,
            configuredEndpointUrl: this.config.repository.sourceDependencies.gitLfs.endpointUrl,
            lfsConfigContent,
          });
          const objectPaths = await this.lfsObjectCache.prepare({
            pointers,
            lfsClient: this.lfsClient,
            remoteUrl: this.config.repository.sshUrl,
            endpointUrl,
            protectionLease,
          });
          for (const pointer of pointers) {
            await this.lfsObjectCache.materialize({
              cachePath: objectPaths.get(pointer.oidSha256),
              destinationPath: safeSourcePath(stagingPath, pointer.path),
              mode: pointer.mode,
              expectedOidSha256: pointer.oidSha256,
              expectedSizeBytes: pointer.sizeBytes,
            });
          }
        }

        unityVersion = await readUnityVersion(stagingPath);
        snapshot = await this.snapshotStore.publish({
          repositoryId: this.config.repository.alias,
          commitSha,
          stagingPath,
          lfsObjects: pointers,
        });
      } finally {
        await protectionLease?.release();
      }
      return {
        commitSha,
        unityVersion,
        sourceSnapshotId: snapshot.snapshotId,
        sourceSnapshotManifest: snapshot.manifest,
      };
    } catch (error) {
      throw asCiError(error, { code: 'SOURCE_RESOLUTION_FAILED', category: 'SOURCE_ERROR', message: 'Source Snapshotの解決に失敗しました。', stage: STAGES.RESOLVING_SOURCE });
    } finally {
      if (worktreeAdded) {
        const result = await this.#git(['--git-dir', this.mirrorPath, 'worktree', 'remove', '--force', '--', stagingPath], { timeoutMs: 120_000 });
        if (result.code !== 0) this.logger?.warn('Failed to remove source staging worktree.', { stagingPath, stderr: result.stderr });
      }
      await rm(stagingPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await this.#git(['--git-dir', this.mirrorPath, 'worktree', 'prune'], { timeoutMs: 30_000 }).catch(() => {});
    }
  }

  async #assertValidBranch(branch) {
    const result = await this.#git(['check-ref-format', '--branch', branch], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new CiError({ code: 'INVALID_BRANCH_NAME', category: 'REQUEST_ERROR', message: 'Gitのブランチ名として不正です。', stage: STAGES.VALIDATING, details: { branch, stderr: result.stderr.trim() } });
  }

  async #synchronizeAndResolve(branch) {
    await mkdir(path.dirname(this.mirrorPath), { recursive: true });
    if (!await exists(this.mirrorPath)) {
      const clone = await this.#git(['clone', '--bare', '--no-tags', '--', this.config.repository.sshUrl, this.mirrorPath]);
      this.#assertGit(clone, 'GIT_CLONE_FAILED', 'Gitリポジトリのクローンに失敗しました。');
    }
    this.#assertGit(await this.#git(['--git-dir', this.mirrorPath, 'remote', 'set-url', 'origin', this.config.repository.sshUrl]), 'GIT_REMOTE_CONFIGURATION_FAILED', 'Git remoteの設定に失敗しました。');
    this.#assertGit(await this.#git(['--git-dir', this.mirrorPath, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']), 'GIT_REMOTE_CONFIGURATION_FAILED', 'Git fetch refspecの設定に失敗しました。');
    this.#assertGit(await this.#git(['--git-dir', this.mirrorPath, 'fetch', '--prune', '--no-tags', 'origin']), 'GIT_FETCH_FAILED', '信頼済みremoteからCommitをfetchできませんでした。');
    const resolved = await this.#git(['--git-dir', this.mirrorPath, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
    if (resolved.code !== 0) throw sourceError('BRANCH_NOT_FOUND', '指定されたリモートブランチが見つかりません。', { branch, stderr: resolved.stderr.trim() });
    const commitSha = resolved.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw sourceError('INVALID_COMMIT_SHA', 'Gitが返したCommit SHAを検証できませんでした。');
    return commitSha.toLowerCase();
  }

  async #trackedFiles(stagingPath) {
    const result = await this.#git(['-C', stagingPath, 'ls-files', '-z']);
    this.#assertGit(result, 'SOURCE_FILE_LIST_FAILED', 'tracked file一覧を取得できませんでした。');
    return result.stdout.split('\0').filter(Boolean);
  }

  async #lfsTrackedPaths(stagingPath, tracked) {
    if (tracked.length === 0) return [];
    const input = `${tracked.join('\0')}\0`;
    const result = await this.#git(['-C', stagingPath, 'check-attr', '-z', '--stdin', 'filter'], { input, maxCaptureBytes: 64 * 1024 * 1024 });
    this.#assertGit(result, 'LFS_ATTRIBUTE_SCAN_FAILED', '.gitattributesからLFS対象を検出できませんでした。');
    const fields = result.stdout.split('\0');
    const selected = [];
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const [file, attribute, value] = fields.slice(index, index + 3);
      if (attribute === 'filter' && value === 'lfs') selected.push(file);
    }
    return selected.sort((a, b) => a.localeCompare(b, 'en'));
  }

  async #assertNoSubmodules(stagingPath) {
    const result = await this.#git(['-C', stagingPath, 'ls-files', '--stage', '-z']);
    this.#assertGit(result, 'SOURCE_FILE_LIST_FAILED', 'gitlink検査に失敗しました。');
    const gitlinks = result.stdout.split('\0').filter(Boolean).filter((record) => record.startsWith('160000 '));
    if (gitlinks.length > 0 || this.config.repository.sourceDependencies.submodules.enabled) {
      throw sourceError('SUBMODULES_DISABLED', '初期版ではGit submoduleを許可していません。', { count: gitlinks.length });
    }
  }

  #assertGit(result, code, message) {
    if (result.code === 0 && !result.timedOut && !result.aborted) return;
    throw sourceError(code, message, { exitCode: result.code, signal: result.signal, timedOut: result.timedOut, stderr: result.stderr.trim().slice(-20_000) });
  }

  #git(args, overrides = {}) {
    return this.processRunner('git', args, { timeoutMs: this.timeoutMs, env: this.environment, logger: this.logger, ...overrides });
  }
}

async function readUnityVersion(stagingPath) {
  const file = path.join(stagingPath, 'ProjectSettings', 'ProjectVersion.txt');
  let content;
  try { content = await readFile(file, 'utf8'); } catch (error) { throw sourceError('UNITY_VERSION_FILE_MISSING', 'ProjectSettings/ProjectVersion.txtを読めません。', { cause: error.message }); }
  const match = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(content);
  if (!match) throw sourceError('UNITY_VERSION_INVALID', 'ProjectVersion.txtからUnity versionを解析できません。');
  return match[1];
}
function safeSourcePath(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw sourceError('SOURCE_PATH_INVALID', 'Source pathが不正です。', { path: relative });
  const target = path.resolve(root, relative);
  if (!isPathInsideOrEqual(root, target)) throw sourceError('SOURCE_PATH_INVALID', 'Source pathがstaging外を指しています。', { path: relative });
  return target;
}
async function readOptional(file) { try { return await readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function exists(target) { try { await access(target); return true; } catch { return false; } }
function sourceError(code, message, details = null) { return new CiError({ code, category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details }); }
