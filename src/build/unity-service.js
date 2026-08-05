import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { isPathInsideOrEqual, safeSlug, validateUnityProjectPath } from '../core/paths.js';
import { runProcess, sanitizedEnvironment } from '../core/process-runner.js';
import { tailFile } from '../utils/format.js';

export class UnityService {
  constructor({ config, dataDir, logger, androidSigningService = null }) {
    this.config = config;
    this.dataDir = dataDir;
    this.logger = logger;
    this.androidSigningService = androidSigningService;
  }

  async inspectProject(workspacePath, buildProfilePath, projectPath = '.') {
    const project = validateUnityProjectPath(projectPath);
    if (!project.ok) {
      throw new CiError({
        code: 'INVALID_UNITY_PROJECT_PATH',
        category: 'UNITY_ENV_ERROR',
        message: project.reason,
        stage: STAGES.PREPARING_PROJECT,
      });
    }

    const projectAbsolutePath = path.join(workspacePath, ...project.value.split('/'));
    let workspaceRealPath;
    let projectRealPath;
    try {
      const projectStat = await lstat(projectAbsolutePath);
      if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error('not a regular non-symlink directory');
      [workspaceRealPath, projectRealPath] = await Promise.all([
        realpath(workspacePath),
        realpath(projectAbsolutePath),
      ]);
      if (!isPathInsideOrEqual(workspaceRealPath, projectRealPath)) throw new Error('project escapes workspace');
    } catch (error) {
      throw new CiError({
        code: 'UNITY_PROJECT_NOT_FOUND',
        category: 'UNITY_ENV_ERROR',
        message: '指定されたUnityプロジェクトをcheckout後のRepository内で確認できませんでした。',
        stage: STAGES.PREPARING_PROJECT,
        details: { projectPath: project.value },
        cause: error,
      });
    }

    const projectVersionPath = path.join(projectAbsolutePath, 'ProjectSettings', 'ProjectVersion.txt');
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

    const profileAbsolutePath = path.join(projectAbsolutePath, ...buildProfilePath.split('/'));
    try {
      const profileStat = await lstat(profileAbsolutePath);
      if (!profileStat.isFile() || profileStat.isSymbolicLink()) throw new Error('not a regular non-symlink file');
      const profileRealPath = await realpath(profileAbsolutePath);
      if (!isPathInsideOrEqual(projectRealPath, profileRealPath)) throw new Error('profile escapes project');
    } catch (error) {
      throw new CiError({
        code: 'BUILD_PROFILE_NOT_FOUND',
        category: 'UNITY_ENV_ERROR',
        message: '指定されたBuild Profile assetをcheckout後のプロジェクト内で確認できませんでした。',
        stage: STAGES.PREPARING_PROJECT,
        details: { projectPath: project.value, buildProfilePath },
        cause: error,
      });
    }

    return { unityVersion, unityExecutable, projectPath: projectAbsolutePath };
  }

  async build({ job, workspacePath, projectPath = workspacePath, unityExecutable, onSpawn, signal }) {
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
      '-projectPath', projectPath,
      '-activeBuildProfile', job.buildProfilePath,
      '-build', artifactPath,
      '-logFile', logPath,
    ];

    const signing = this.androidSigningService
      ? await this.androidSigningService.prepare({ job, projectPath })
      : { environment: {} };

    let result;
    try {
      result = await runProcess(unityExecutable, args, {
        timeoutMs: this.config.unity.buildTimeoutMinutes * 60_000,
        env: sanitizedEnvironment(process.env, signing.environment),
        signal,
        logger: this.logger,
        onSpawn,
        maxCaptureBytes: 1024 * 1024,
      });
    } finally {
      try { await signing.cleanup?.(); }
      catch (error) { this.logger?.warn('Failed to remove the temporary Android signing hook.', { jobId: job.id, error }); }
    }

    const [logTail, reportedBuild] = await Promise.all([
      tailFile(logPath),
      inspectUnityBuildLog(logPath),
    ]);
    if (result.code !== 0 || result.timedOut || result.aborted) {
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

    const reportedResult = reportedBuild.result;
    if (reportedResult) {
      const signingFailed = reportedBuild.signingFailed;
      throw new CiError({
        code: signingFailed ? 'ANDROID_SIGNING_FAILED' : reportedResult === 'cancelled' ? 'UNITY_BUILD_CANCELLED' : 'UNITY_BUILD_FAILED',
        category: 'UNITY_BUILD_ERROR',
        message: signingFailed
          ? 'Androidアプリの署名に失敗しました。keystoreとkey aliasのパスワードを確認してください。'
          : reportedResult === 'cancelled'
            ? 'Unityがビルドのキャンセルを報告しました。'
            : 'Unityがログ上でビルド失敗を報告しました。',
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

async function inspectUnityBuildLog(logPath) {
  let result = null;
  let signingFailed = false;
  const lines = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const match = /Build Finished, Result:\s*(Failure|Failed|Cancelled)\./i.exec(line);
      if (match) result = match[1].toLowerCase() === 'cancelled' ? 'cancelled' : 'failure';
      if (/Can not sign the application|Unable to sign the application; please provide passwords!/i.test(line)) signingFailed = true;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    lines.close();
  }
  return { result, signingFailed };
}
