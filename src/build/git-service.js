import { access, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { runProcess, sanitizedEnvironment } from '../core/process-runner.js';
import { safeSlug } from '../core/paths.js';

export class GitService {
  constructor({ config, dataDir, logger }) {
    this.config = config;
    this.dataDir = dataDir;
    this.logger = logger;
    this.mirrorPath = path.join(dataDir, 'repositories', `${safeSlug(config.repository.alias)}.git`);
    this.timeoutMs = config.runner.gitTimeoutSeconds * 1000;
  }

  async validateBranchName(branch) {
    const result = await this.#run(['check-ref-format', '--branch', branch], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      throw new CiError({
        code: 'INVALID_BRANCH_NAME',
        category: 'REQUEST_ERROR',
        message: 'Gitのブランチ名として不正です。',
        stage: STAGES.VALIDATING,
        details: { branch, stderr: result.stderr.trim() },
      });
    }
  }

  async synchronizeAndResolve(branch) {
    await mkdir(path.dirname(this.mirrorPath), { recursive: true });
    const mirrorExists = await exists(this.mirrorPath);

    if (!mirrorExists) {
      const clone = await this.#run([
        'clone', '--bare', '--no-tags', '--',
        this.config.repository.sshUrl,
        this.mirrorPath,
      ]);
      this.#assertSuccess(clone, 'GIT_CLONE_FAILED', 'Gitリポジトリのクローンに失敗しました。');
    }

    this.#assertSuccess(
      await this.#run(['--git-dir', this.mirrorPath, 'remote', 'set-url', 'origin', this.config.repository.sshUrl]),
      'GIT_REMOTE_CONFIGURATION_FAILED',
      'Git remoteの設定に失敗しました。',
    );
    this.#assertSuccess(
      await this.#run([
        '--git-dir', this.mirrorPath,
        'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*',
      ]),
      'GIT_REMOTE_CONFIGURATION_FAILED',
      'Git fetch refspecの設定に失敗しました。',
    );
    this.#assertSuccess(
      await this.#run([
        '--git-dir', this.mirrorPath,
        'fetch', '--prune', '--no-tags', 'origin',
      ]),
      'GIT_FETCH_FAILED',
      'GitHubからブランチ情報を取得できませんでした。',
    );

    const ref = `refs/remotes/origin/${branch}^{commit}`;
    const resolved = await this.#run(['--git-dir', this.mirrorPath, 'rev-parse', '--verify', ref]);
    if (resolved.code !== 0) {
      throw new CiError({
        code: 'BRANCH_NOT_FOUND',
        category: 'GIT_ERROR',
        message: '指定されたリモートブランチが見つかりません。',
        stage: STAGES.SYNCING_REPOSITORY,
        details: { branch, stderr: resolved.stderr.trim() },
      });
    }

    const commitSha = resolved.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
      throw new CiError({
        code: 'INVALID_COMMIT_SHA',
        category: 'GIT_ERROR',
        message: 'Gitが返したコミットSHAを検証できませんでした。',
        stage: STAGES.SYNCING_REPOSITORY,
        details: { output: commitSha },
      });
    }
    return commitSha;
  }

  async prepareWorkspace(jobId, commitSha) {
    const workspacePath = path.join(this.dataDir, 'workspaces', jobId);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await rm(workspacePath, { recursive: true, force: true });

    await this.#run(['--git-dir', this.mirrorPath, 'worktree', 'prune']);
    const add = await this.#run([
      '--git-dir', this.mirrorPath,
      'worktree', 'add', '--detach', '--', workspacePath, commitSha,
    ]);
    this.#assertSuccess(add, 'WORKTREE_CREATE_FAILED', 'ビルド用worktreeを作成できませんでした。', STAGES.PREPARING_WORKSPACE);

    const submodules = await this.#run([
      '-C', workspacePath,
      'submodule', 'update', '--init', '--recursive',
    ]);
    this.#assertSuccess(submodules, 'SUBMODULE_UPDATE_FAILED', 'Git submoduleの取得に失敗しました。', STAGES.PREPARING_WORKSPACE);

    if (await this.#shouldPullLfs(workspacePath)) {
      const version = await this.#run(['lfs', 'version'], { timeoutMs: 30_000 });
      if (version.code !== 0) {
        throw new CiError({
          code: 'GIT_LFS_NOT_INSTALLED',
          category: 'WORKSPACE_ERROR',
          message: 'Git LFS対象ファイルがありますが、Git LFSがインストールされていません。',
          stage: STAGES.PREPARING_WORKSPACE,
        });
      }
      const pull = await this.#run(['-C', workspacePath, 'lfs', 'pull']);
      this.#assertSuccess(pull, 'GIT_LFS_PULL_FAILED', 'Git LFSファイルの取得に失敗しました。', STAGES.PREPARING_WORKSPACE);
    }

    return workspacePath;
  }

  async cleanupWorkspace(workspacePath) {
    if (!workspacePath) return;
    const remove = await this.#run([
      '--git-dir', this.mirrorPath,
      'worktree', 'remove', '--force', '--', workspacePath,
    ], { timeoutMs: 120_000 });
    if (remove.code !== 0) {
      this.logger.warn('git worktree remove failed; removing the directory directly.', {
        workspacePath,
        stderr: remove.stderr,
      });
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await this.#run(['--git-dir', this.mirrorPath, 'worktree', 'prune'], { timeoutMs: 30_000 });
    }
  }

  async #shouldPullLfs(workspacePath) {
    if (this.config.repository.useGitLfs === 'always') return true;
    if (this.config.repository.useGitLfs === 'never') return false;

    for (const file of await findNamedFiles(workspacePath, '.gitattributes', 8)) {
      try {
        if ((await readFile(file, 'utf8')).includes('filter=lfs')) return true;
      } catch {}
    }
    return false;
  }

  #assertSuccess(result, code, message, stage = STAGES.SYNCING_REPOSITORY) {
    if (result.code === 0 && !result.timedOut && !result.aborted) return;
    throw new CiError({
      code,
      category: stage === STAGES.PREPARING_WORKSPACE ? 'WORKSPACE_ERROR' : 'GIT_ERROR',
      message,
      stage,
      details: processDetails(result),
    });
  }

  #run(args, overrides = {}) {
    return runProcess('git', args, {
      timeoutMs: this.timeoutMs,
      env: sanitizedEnvironment(),
      logger: this.logger,
      ...overrides,
    });
  }
}

function processDetails(result) {
  return {
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stderr: result.stderr.trim().slice(-20_000),
    stdout: result.stdout.trim().slice(-20_000),
  };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function findNamedFiles(root, filename, maxDepth, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'Library' || entry.name === 'Temp') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === filename) results.push(fullPath);
    else if (entry.isDirectory()) results.push(...await findNamedFiles(fullPath, filename, maxDepth, depth + 1));
  }
  return results;
}
