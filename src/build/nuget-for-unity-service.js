import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { CiError, asCiError } from '../core/errors.js';
import { isPathInsideOrEqual } from '../core/paths.js';
import { sanitizedEnvironment, runProcess } from '../core/process-runner.js';
import { STAGES } from '../core/stages.js';

const TOOL_VERSION = '4.5.0';
const TOOL_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOOL_MANIFEST = path.join(TOOL_ROOT, '.config', 'dotnet-tools.json');
const TOOL_NUGET_CONFIG = path.join(TOOL_ROOT, '.config', 'NuGet.Config');
const ALLOWED_PACKAGE_SOURCE = 'https://api.nuget.org/v3/index.json';
const MAX_CAPTURE_BYTES = 1024 * 1024;

export class NugetForUnityService {
  constructor({ config, logger, processRunner = runProcess }) {
    this.config = config;
    this.logger = logger;
    this.processRunner = processRunner;
    this.cliReady = null;
  }

  async restore({ projectPath, signal }) {
    if (!this.config.unity.nugetForUnity.enabled) return { restored: false, reason: 'disabled' };

    const files = await inspectProjectFiles(projectPath);
    if (!files.nugetConfig && !files.packagesConfig) return { restored: false, reason: 'not-configured' };
    if (!files.nugetConfig || !files.packagesConfig) {
      throw dependencyError('NUGET_CONFIGURATION_INVALID', 'NuGetForUnityの設定ファイルが片方しかありません。Assets/NuGet.configとAssets/packages.configの両方が必要です。', {
        nugetConfigPresent: Boolean(files.nugetConfig),
        packagesConfigPresent: Boolean(files.packagesConfig),
      });
    }

    await validateProjectConfiguration(files);
    const nugetCachePath = await prepareJobCache(projectPath, files.projectRealPath);
    await this.#ensureCli(signal);

    let result;
    try {
      result = await this.processRunner('dotnet', ['tool', 'run', 'nugetforunity', '--allow-roll-forward', '--', 'restore', projectPath], {
        cwd: TOOL_ROOT,
        env: dependencyEnvironment({ nugetCachePath }),
        timeoutMs: this.config.unity.nugetForUnity.restoreTimeoutSeconds * 1000,
        maxCaptureBytes: MAX_CAPTURE_BYTES,
        signal,
        logger: this.logger,
      });
    } catch (error) {
      throw asCiError(error, {
        code: 'NUGET_RESTORE_FAILED',
        category: 'DEPENDENCY_ERROR',
        message: 'NuGetForUnity CLIの起動に失敗しました。',
        stage: STAGES.RESTORING_DEPENDENCIES,
      });
    }

    assertSuccessfulProcess(result, {
      failedCode: 'NUGET_RESTORE_FAILED',
      timeoutCode: 'NUGET_RESTORE_TIMEOUT',
      abortedCode: 'NUGET_RESTORE_ABORTED',
      failedMessage: 'NuGet packageの復元に失敗しました。',
      timeoutMessage: 'NuGet packageの復元がタイムアウトしました。',
      abortedMessage: 'NuGet packageの復元がRunner停止により中断されました。',
    });
    return { restored: true };
  }

  async #ensureCli(signal) {
    if (!this.cliReady) {
      this.cliReady = this.#restoreCli(signal).catch((error) => {
        this.cliReady = null;
        throw error;
      });
    }
    return this.cliReady;
  }

  async #restoreCli(signal) {
    let result;
    try {
      result = await this.processRunner('dotnet', ['tool', 'restore', '--tool-manifest', TOOL_MANIFEST, '--configfile', TOOL_NUGET_CONFIG], {
        cwd: TOOL_ROOT,
        env: dependencyEnvironment(),
        timeoutMs: this.config.unity.nugetForUnity.cliRestoreTimeoutSeconds * 1000,
        maxCaptureBytes: MAX_CAPTURE_BYTES,
        signal,
        logger: this.logger,
      });
    } catch (error) {
      throw asCiError(error, {
        code: 'NUGETFORUNITY_CLI_UNAVAILABLE',
        category: 'UNITY_ENV_ERROR',
        message: `NuGetForUnity CLI ${TOOL_VERSION} を準備できませんでした。`,
        stage: STAGES.RESTORING_DEPENDENCIES,
      });
    }

    assertSuccessfulProcess(result, {
      failedCode: 'NUGETFORUNITY_CLI_UNAVAILABLE',
      timeoutCode: 'NUGETFORUNITY_CLI_RESTORE_TIMEOUT',
      abortedCode: 'NUGET_RESTORE_ABORTED',
      failedMessage: `NuGetForUnity CLI ${TOOL_VERSION} を準備できませんでした。`,
      timeoutMessage: 'NuGetForUnity CLIの準備がタイムアウトしました。',
      abortedMessage: 'NuGetForUnity CLIの準備がRunner停止により中断されました。',
      failedCategory: 'UNITY_ENV_ERROR',
      timeoutCategory: 'UNITY_ENV_ERROR',
    });
  }
}

async function inspectProjectFiles(projectPath) {
  const projectRealPath = await realpath(projectPath);
  const assetsPath = path.join(projectPath, 'Assets');
  const packagesPath = path.join(projectPath, 'Packages');
  const nugetConfig = await inspectOptionalRegularFile(path.join(assetsPath, 'NuGet.config'), projectRealPath);
  const packagesConfig = await inspectOptionalRegularFile(path.join(assetsPath, 'packages.config'), projectRealPath);
  const manifest = await inspectRequiredRegularFile(path.join(packagesPath, 'manifest.json'), projectRealPath);
  return { projectRealPath, nugetConfig, packagesConfig, manifest };
}

async function inspectOptionalRegularFile(file, projectRealPath) {
  try {
    return await inspectRequiredRegularFile(file, projectRealPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw dependencyError('NUGET_CONFIGURATION_INVALID', 'NuGetForUnityの設定ファイルが通常ファイルではないか、Unityプロジェクト外を参照しています。', { file, cause: error.message }, error);
  }
}

async function inspectRequiredRegularFile(file, projectRealPath) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular non-symlink file');
  const resolved = await realpath(file);
  if (!isPathInsideOrEqual(projectRealPath, resolved)) throw new Error('file escapes Unity project');
  return { path: file, content: await readFile(file, 'utf8') };
}

async function validateProjectConfiguration(files) {
  let manifest;
  try {
    manifest = JSON.parse(files.manifest.content);
  } catch (error) {
    throw dependencyError('NUGET_CONFIGURATION_INVALID', 'Packages/manifest.jsonを解析できません。', { cause: error.message }, error);
  }
  const installedVersion = manifest?.dependencies?.['com.github-glitchenzo.nugetforunity'];
  if (installedVersion !== TOOL_VERSION) {
    throw dependencyError('NUGETFORUNITY_VERSION_UNSUPPORTED', `NuGetForUnity ${TOOL_VERSION} のみ対応しています。`, { installedVersion });
  }

  const configuration = parseNugetConfiguration(files.nugetConfig.content);
  const sources = onlyItem(configuration.packageSources, 'packageSources');
  if (!sameKeys(sources, ['clear', 'add']) || sources.clear !== '') {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', 'NuGet.configのpackageSourcesには単一のclearが必要です。');
  }
  const sourceEntries = sources.add;
  const expectedSource = {
    '@_key': 'nuget.org',
    '@_value': ALLOWED_PACKAGE_SOURCE,
    '@_enableCredentialProvider': 'false',
  };
  if (!Array.isArray(sourceEntries) || sourceEntries.length !== 1 || !sameObject(sourceEntries[0], expectedSource)) {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', `NuGet package sourceは資格情報なしの ${ALLOWED_PACKAGE_SOURCE} だけを許可しています。`);
  }

  const activeSource = onlyItem(configuration.activePackageSource, 'activePackageSource');
  if (!sameKeys(activeSource, ['add']) || !Array.isArray(activeSource.add) || activeSource.add.length !== 1 || !sameObject(activeSource.add[0], { '@_key': 'All', '@_value': '(Aggregate source)' })) {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', 'NuGet.configのactivePackageSourceはAggregate sourceだけを許可しています。');
  }
  if (configuration.disabledPackageSources !== '') {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', 'NuGet.configのdisabledPackageSources設定は許可されていません。');
  }

  const settingsSection = onlyItem(configuration.config, 'config');
  if (!sameKeys(settingsSection, ['add']) || !Array.isArray(settingsSection.add)) {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', 'NuGet.configに許可されていないconfig設定があります。');
  }
  const settingEntries = settingsSection.add.map((entry) => ({ key: entry['@_key'], value: entry['@_value'], valid: sameKeys(entry, ['@_key', '@_value']) }));
  const expected = {
    packageInstallLocation: 'CustomWithinAssets',
    repositoryPath: './Packages',
    PackagesConfigDirectoryPath: '.',
    slimRestore: 'true',
    PreferNetStandardOverNetFramework: 'true',
  };
  const settings = Object.fromEntries(settingEntries.map((entry) => [entry.key, entry.value]));
  if (settingEntries.length !== Object.keys(expected).length
    || settingEntries.some((entry) => !entry.valid)
    || new Set(settingEntries.map((entry) => entry.key)).size !== settingEntries.length
    || Object.keys(settings).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => settings[key] !== value)) {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', 'NuGet.configの保存先または復元設定が許可された構成と一致しません。', { expected });
  }
}

function parseNugetConfiguration(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', 'NuGet.configのDOCTYPEまたはENTITYは許可されていません。');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw dependencyError('NUGET_CONFIGURATION_INVALID', 'NuGet.configが正しいXMLではありません。', { reason: validation.err?.msg });
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    isArray: (_name, jpath) => [
      'configuration.packageSources',
      'configuration.packageSources.add',
      'configuration.activePackageSource',
      'configuration.activePackageSource.add',
      'configuration.config',
      'configuration.config.add',
    ].includes(jpath),
  });
  const parsed = parser.parse(xml);
  const rootKeys = Object.keys(parsed).filter((key) => key !== '?xml');
  if (rootKeys.length !== 1 || rootKeys[0] !== 'configuration' || !parsed.configuration || Array.isArray(parsed.configuration)) {
    throw dependencyError('NUGET_CONFIGURATION_INVALID', 'NuGet.configには単一のconfiguration rootが必要です。');
  }
  if (!sameKeys(parsed.configuration, ['packageSources', 'disabledPackageSources', 'activePackageSource', 'config'])) {
    throw dependencyError('NUGET_CONFIGURATION_NOT_ALLOWED', 'NuGet.configに許可されていないsectionがあります。');
  }
  return parsed.configuration;
}

function sameKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.slice().sort().every((key, index) => key === actual[index]);
}

function sameObject(actual, expected) {
  return sameKeys(actual, Object.keys(expected)) && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function onlyItem(value, name) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object' || Array.isArray(value[0])) {
    throw dependencyError('NUGET_CONFIGURATION_INVALID', `NuGet.configの${name}は1つだけ必要です。`);
  }
  return value[0];
}

async function prepareJobCache(projectPath, projectRealPath) {
  const libraryPath = path.join(projectPath, 'Library');
  const cachePath = path.join(libraryPath, 'NuGetForUnityCache');
  await assertDirectoryInsideProjectIfPresent(libraryPath, projectRealPath);
  await mkdir(cachePath, { recursive: true });
  await assertDirectoryInsideProjectIfPresent(cachePath, projectRealPath, { required: true });
  return cachePath;
}

async function assertDirectoryInsideProjectIfPresent(directory, projectRealPath, { required = false } = {}) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a regular non-symlink directory');
    const resolved = await realpath(directory);
    if (!isPathInsideOrEqual(projectRealPath, resolved)) throw new Error('directory escapes Unity project');
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return;
    throw dependencyError('NUGET_CACHE_PATH_INVALID', 'NuGet cache pathが通常directoryではないか、Unityプロジェクト外を参照しています。', { directory, cause: error.message }, error);
  }
}

function dependencyEnvironment({ nugetCachePath } = {}) {
  return sanitizedEnvironment(process.env, {
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    NUGET_CREDENTIALPROVIDERS_PATH: '',
    ...(nugetCachePath ? { NuGetCachePath: nugetCachePath } : {}),
  });
}

function assertSuccessfulProcess(result, options) {
  if (result.code === 0 && !result.timedOut && !result.aborted) return;
  const aborted = result.aborted;
  const timedOut = result.timedOut;
  throw new CiError({
    code: aborted ? options.abortedCode : timedOut ? options.timeoutCode : options.failedCode,
    category: aborted ? 'RUNNER_ERROR' : timedOut ? options.timeoutCategory ?? 'DEPENDENCY_ERROR' : options.failedCategory ?? 'DEPENDENCY_ERROR',
    message: aborted ? options.abortedMessage : timedOut ? options.timeoutMessage : options.failedMessage,
    stage: STAGES.RESTORING_DEPENDENCIES,
    details: {
      exitCode: result.code,
      signal: result.signal,
      timedOut,
      stdout: result.stdout.trim().slice(-20_000),
      stderr: result.stderr.trim().slice(-20_000),
    },
  });
}

function dependencyError(code, message, details = null, cause = undefined) {
  return new CiError({ code, category: 'DEPENDENCY_ERROR', message, stage: STAGES.RESTORING_DEPENDENCIES, details, cause });
}
