import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { isPathInsideOrEqual, safeSlug } from '../core/paths.js';
import { runProcess, sanitizedEnvironment } from '../core/process-runner.js';
import { tailFile } from '../utils/format.js';

export class UnityService {
  constructor({ config, dataDir, logger }) {
    this.config = config;
    this.dataDir = dataDir;
    this.logger = logger;
  }

  async inspectProject(workspacePath, buildProfilePath) {
    const projectVersionPath = path.join(workspacePath, 'ProjectSettings', 'ProjectVersion.txt');
    let projectVersionText;
    try {
      projectVersionText = await readFile(projectVersionPath, 'utf8');
    } catch (error) {
      throw new CiError({
        code: 'PROJECT_VERSION_NOT_FOUND',
        category: 'UNITY_ENV_ERROR',
        message: 'ProjectSettings/ProjectVersion.txtを読み取れませんでした。',
        stage: STAGES.PREPARING_PROJECT,
        cause: error,
      });
    }

    const match = projectVersionText.match(/^m_EditorVersion:\s*(\S+)\s*$/m);
    if (!match) {
      throw new CiError({
        code: 'PROJECT_VERSION_INVALID',
        category: 'UNITY_ENV_ERROR',
        message: 'Unity EditorバージョンをProjectVersion.txtから取得できませんでした。',
        stage: STAGES.PREPARING_PROJECT,
      });
    }

    const unityVersion = match[1];
    const unityExecutable = path.join(
      this.config.unity.editorsRoot,
      unityVersion,
      'Unity.app', 'Contents', 'MacOS', 'Unity',
    );
    try {
      await access(unityExecutable, fsConstants.X_OK);
    } catch (error) {
      throw new CiError({
        code: 'UNITY_VERSION_NOT_INSTALLED',
        category: 'UNITY_ENV_ERROR',
        message: `Unity ${unityVersion} が指定パスにインストールされていません。`,
        stage: STAGES.PREPARING_PROJECT,
        details: { unityExecutable },
        cause: error,
      });
    }

    const profileAbsolutePath = path.join(workspacePath, ...buildProfilePath.split('/'));
    try {
      const profileStat = await lstat(profileAbsolutePath);
      if (!profileStat.isFile() || profileStat.isSymbolicLink()) throw new Error('not a regular non-symlink file');
      const [workspaceRealPath, profileRealPath] = await Promise.all([
        realpath(workspacePath),
        realpath(profileAbsolutePath),
      ]);
      if (!isPathInsideOrEqual(workspaceRealPath, profileRealPath)) throw new Error('profile escapes workspace');
    } catch (error) {
      throw new CiError({
        code: 'BUILD_PROFILE_NOT_FOUND',
        category: 'UNITY_ENV_ERROR',
        message: '指定されたBuild Profile assetをcheckout後のプロジェクト内で確認できませんでした。',
        stage: STAGES.PREPARING_PROJECT,
        details: { buildProfilePath },
        cause: error,
      });
    }

    return { unityVersion, unityExecutable };
  }

  async build({ job, workspacePath, unityExecutable, onSpawn, signal }) {
    const artifactDirectory = path.join(this.dataDir, 'artifacts', job.id);
    const logDirectory = path.join(this.dataDir, 'logs', job.id);
    await Promise.all([
      mkdir(artifactDirectory, { recursive: true }),
      mkdir(logDirectory, { recursive: true }),
    ]);

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const artifactName = [
      safeSlug(job.repositoryAlias, 40),
      safeSlug(job.requestedBranch, 60),
      job.resolvedCommitSha.slice(0, 8),
      timestamp,
    ].join('-') + '.apk';
    const artifactPath = path.join(artifactDirectory, artifactName);
    const logPath = path.join(logDirectory, 'unity.log');

    const args = [
      '-batchmode',
      '-quit',
      '-projectPath', workspacePath,
      '-activeBuildProfile', job.buildProfilePath,
      '-build', artifactPath,
      '-logFile', logPath,
    ];

    const result = await runProcess(unityExecutable, args, {
      timeoutMs: this.config.unity.buildTimeoutMinutes * 60_000,
      env: sanitizedEnvironment(),
      signal,
      logger: this.logger,
      onSpawn,
      maxCaptureBytes: 1024 * 1024,
    });

    if (result.code !== 0 || result.timedOut || result.aborted) {
      const logTail = await tailFile(logPath);
      throw new CiError({
        code: result.timedOut ? 'UNITY_BUILD_TIMEOUT' : result.aborted ? 'UNITY_BUILD_ABORTED' : 'UNITY_BUILD_FAILED',
        category: result.aborted ? 'RUNNER_ERROR' : 'UNITY_BUILD_ERROR',
        message: result.timedOut
          ? 'Unityビルドがタイムアウトしました。'
          : result.aborted
            ? 'UnityビルドがRunner停止により中断されました。'
            : 'Unityが非ゼロ終了コードを返しました。',
        stage: STAGES.BUILDING,
        details: {
          exitCode: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          logPath,
          logTail,
          stderr: result.stderr.trim().slice(-20_000),
        },
      });
    }

    return { path: artifactPath, name: artifactName, logPath };
  }
}
