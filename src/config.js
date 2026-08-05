import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBuildProfilePath, validateUnityProjectPath } from './core/paths.js';

const STATUS_KEYS = Array.from({ length: 10 }, (_, index) => String(index));
const DEFAULT_MAX_LFS_OBJECT_BYTES = 10 * 1024 ** 3;
const DEFAULT_MAX_LFS_TOTAL_BYTES_PER_JOB = 50 * 1024 ** 3;

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  return validateConfig(JSON.parse(await readFile(absolutePath, 'utf8')), path.dirname(absolutePath));
}

export function validateConfig(raw, baseDirectory = process.cwd()) {
  const errors = [];
  const requireObject = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${name} must be an object.`); return {}; }
    return value;
  };
  const root = requireObject(raw, 'config');
  const repositoryAccess = requireObject(root.repositoryAccess ?? root.repository_access ?? {}, 'repositoryAccess');
  const legacyRepository = root.repository && typeof root.repository === 'object' && !Array.isArray(root.repository) ? root.repository : {};
  if (legacyRepository.alias || legacyRepository.sshUrl || legacyRepository.remote_url) errors.push('Fixed repository.alias/repository.sshUrl configuration was removed. Use repositoryAccess and specify repository in each chat request.');
  const unity = requireObject(root.unity, 'unity');
  const artifacts = requireObject(root.artifacts ?? {}, 'artifacts');
  const runner = requireObject(root.runner ?? {}, 'runner');
  const storage = requireObject(root.storage ?? {}, 'storage');
  const slack = requireObject(root.slack ?? { enabled: false }, 'slack');
  const discord = requireObject(root.discord ?? { enabled: false }, 'discord');

  const dataDir = resolvePath(root.dataDir, baseDirectory, 'dataDir', errors);
  const defaultHost = hostname(repositoryAccess.defaultHost ?? repositoryAccess.default_host ?? 'github.com', 'repositoryAccess.defaultHost', errors);
  const allowedHosts = hostnameArray(repositoryAccess.allowedHosts ?? repositoryAccess.allowed_hosts ?? [defaultHost], 'repositoryAccess.allowedHosts', errors);
  if (defaultHost && !allowedHosts.includes(defaultHost)) errors.push('repositoryAccess.defaultHost must be included in repositoryAccess.allowedHosts.');
  const branchPatterns = stringArray(repositoryAccess.allowedBranchPatterns ?? repositoryAccess.allowed_branch_patterns ?? ['.+'], 'repositoryAccess.allowedBranchPatterns', errors, { nonEmpty: true });
  const compiledBranchPatterns = [];
  for (const pattern of branchPatterns) { try { compiledBranchPatterns.push(new RegExp(pattern)); } catch (error) { errors.push(`Invalid repositoryAccess.allowedBranchPatterns entry ${JSON.stringify(pattern)}: ${error.message}`); } }

  const dependencies = requireObject(root.sourceDependencies ?? root.source_dependencies ?? legacyRepository.sourceDependencies ?? legacyRepository.source_dependencies ?? {}, 'sourceDependencies');
  const gitLfsRaw = requireObject(dependencies.gitLfs ?? dependencies.git_lfs ?? {}, 'sourceDependencies.gitLfs');
  const submodulesRaw = requireObject(dependencies.submodules ?? {}, 'sourceDependencies.submodules');
  const gitLfsEnabled = booleanValue(gitLfsRaw.enabled ?? true, 'sourceDependencies.gitLfs.enabled', errors);
  const gitLfsMode = gitLfsRaw.mode ?? 'materialize_in_source_snapshot';
  if (gitLfsMode !== 'materialize_in_source_snapshot') errors.push('sourceDependencies.gitLfs.mode must be materialize_in_source_snapshot.');
  const maxObjectBytes = positiveInteger(gitLfsRaw.maxObjectBytes ?? gitLfsRaw.max_object_bytes ?? DEFAULT_MAX_LFS_OBJECT_BYTES, 'sourceDependencies.gitLfs.maxObjectBytes', errors);
  const maxTotalBytesPerJob = positiveInteger(gitLfsRaw.maxTotalBytesPerJob ?? gitLfsRaw.max_total_bytes_per_job ?? DEFAULT_MAX_LFS_TOTAL_BYTES_PER_JOB, 'sourceDependencies.gitLfs.maxTotalBytesPerJob', errors);
  const allowRepositoryLfsconfig = booleanValue(gitLfsRaw.allowRepositoryLfsconfig ?? gitLfsRaw.allow_repository_lfsconfig ?? false, 'sourceDependencies.gitLfs.allowRepositoryLfsconfig', errors);
  const allowedEndpointHosts = hostnameArray(gitLfsRaw.allowedEndpointHosts ?? gitLfsRaw.allowed_endpoint_hosts ?? ['github.com', 'githubusercontent.com'], 'sourceDependencies.gitLfs.allowedEndpointHosts', errors);
  const endpointUrl = optionalHttpsUrl(gitLfsRaw.endpointUrl ?? gitLfsRaw.endpoint_url ?? null, 'sourceDependencies.gitLfs.endpointUrl', allowedEndpointHosts, errors);
  const submodulesEnabled = booleanValue(submodulesRaw.enabled ?? false, 'sourceDependencies.submodules.enabled', errors);
  if (submodulesEnabled) errors.push('sourceDependencies.submodules.enabled=true is not supported by the initial release.');

  const editorsRoot = resolvePath(unity.editorsRoot ?? '/Applications/Unity/Hub/Editor', baseDirectory, 'unity.editorsRoot', errors);
  const configuredBuildProfiles = stringArray(unity.allowedBuildProfiles ?? [], 'unity.allowedBuildProfiles', errors);
  const buildProfiles = configuredBuildProfiles.filter((profile) => {
    const result = validateBuildProfilePath(profile);
    if (!result.ok) { errors.push(`Invalid unity.allowedBuildProfiles entry ${JSON.stringify(profile)}: ${result.reason}`); return false; }
    return true;
  });
  const buildTimeoutMinutes = positiveInteger(unity.buildTimeoutMinutes ?? 90, 'unity.buildTimeoutMinutes', errors);
  const nugetForUnityRaw = requireObject(unity.nugetForUnity ?? unity.nuget_for_unity ?? {}, 'unity.nugetForUnity');
  const nugetForUnityEnabled = booleanValue(nugetForUnityRaw.enabled ?? true, 'unity.nugetForUnity.enabled', errors);
  const nugetRestoreTimeoutSeconds = positiveInteger(nugetForUnityRaw.restoreTimeoutSeconds ?? nugetForUnityRaw.restore_timeout_seconds ?? 600, 'unity.nugetForUnity.restoreTimeoutSeconds', errors);
  const nugetCliRestoreTimeoutSeconds = positiveInteger(nugetForUnityRaw.cliRestoreTimeoutSeconds ?? nugetForUnityRaw.cli_restore_timeout_seconds ?? 300, 'unity.nugetForUnity.cliRestoreTimeoutSeconds', errors);
  const androidSigning = validateAndroidSigning(unity.androidSigning ?? unity.android_signing ?? [], errors, baseDirectory);
  const forceAndroidDebugSigning = booleanValue(unity.forceAndroidDebugSigning ?? unity.force_android_debug_signing ?? false, 'unity.forceAndroidDebugSigning', errors);
  const maxBytes = positiveInteger(artifacts.maxBytes ?? 1_000_000_000, 'artifacts.maxBytes', errors);
  const successfulRetentionDays = nonNegativeNumber(artifacts.successfulRetentionDays ?? 3, 'artifacts.successfulRetentionDays', errors);
  const failedRetentionDays = nonNegativeNumber(artifacts.failedRetentionDays ?? 1, 'artifacts.failedRetentionDays', errors);
  const logsRetentionDays = nonNegativeNumber(artifacts.logsRetentionDays ?? 14, 'artifacts.logsRetentionDays', errors);
  const pollIntervalMs = positiveInteger(runner.pollIntervalMs ?? 2_000, 'runner.pollIntervalMs', errors);
  const heartbeatIntervalMs = positiveInteger(runner.heartbeatIntervalMs ?? 15_000, 'runner.heartbeatIntervalMs', errors);
  const interruptedJobRetries = nonNegativeInteger(runner.interruptedJobRetries ?? 1, 'runner.interruptedJobRetries', errors);
  const gitTimeoutSeconds = positiveInteger(runner.gitTimeoutSeconds ?? 600, 'runner.gitTimeoutSeconds', errors);
  const lfsRequestTimeoutSeconds = positiveInteger(runner.lfsRequestTimeoutSeconds ?? runner.lfs_request_timeout_seconds ?? 600, 'runner.lfsRequestTimeoutSeconds', errors);

  const lfsObjectsRaw = requireObject(storage.lfsObjects ?? storage.lfs_objects ?? {}, 'storage.lfsObjects');
  const maxTotalBytes = positiveInteger(lfsObjectsRaw.maxTotalBytes ?? lfsObjectsRaw.max_total_bytes ?? gbToBytes(lfsObjectsRaw.maxTotalGb ?? lfsObjectsRaw.max_total_gb ?? 300, 'storage.lfsObjects.maxTotalGb', errors), 'storage.lfsObjects.maxTotalBytes', errors);
  const lfsRetentionDays = nonNegativeNumber(lfsObjectsRaw.retentionDays ?? lfsObjectsRaw.retention_days ?? 60, 'storage.lfsObjects.retentionDays', errors);
  const snapshotRaw = requireObject(storage.sourceSnapshots ?? storage.source_snapshots ?? {}, 'storage.sourceSnapshots');
  const snapshotRetentionDays = nonNegativeNumber(snapshotRaw.retentionDays ?? snapshotRaw.retention_days ?? 60, 'storage.sourceSnapshots.retentionDays', errors);

  const normalizedSlack = validateSlack(slack, maxBytes, errors, baseDirectory);
  const normalizedDiscord = validateDiscord(discord, errors, baseDirectory);
  if (!normalizedSlack.enabled && !normalizedDiscord.enabled) errors.push('At least one of slack.enabled or discord.enabled must be true.');
  if (errors.length) { const error = new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`); error.code = 'INVALID_CONFIG'; throw error; }

  return {
    dataDir,
    repositoryAccess: { defaultHost, allowedHosts, allowedBranchPatterns: branchPatterns, compiledBranchPatterns },
    sourceDependencies: { gitLfs: { enabled: gitLfsEnabled, mode: gitLfsMode, maxObjectBytes, maxTotalBytesPerJob, allowRepositoryLfsconfig, allowedEndpointHosts, endpointUrl }, submodules: { enabled: submodulesEnabled } },
    unity: {
      editorsRoot,
      allowedBuildProfiles: buildProfiles,
      buildTimeoutMinutes,
      androidSigning,
      forceAndroidDebugSigning,
      nugetForUnity: {
        enabled: nugetForUnityEnabled,
        restoreTimeoutSeconds: nugetRestoreTimeoutSeconds,
        cliRestoreTimeoutSeconds: nugetCliRestoreTimeoutSeconds,
      },
    },
    artifacts: { maxBytes, successfulRetentionDays, failedRetentionDays, logsRetentionDays },
    runner: { pollIntervalMs, heartbeatIntervalMs, interruptedJobRetries, gitTimeoutSeconds, lfsRequestTimeoutSeconds },
    storage: { lfsObjects: { maxTotalBytes, retentionDays: lfsRetentionDays }, sourceSnapshots: { retentionDays: snapshotRetentionDays } },
    slack: normalizedSlack,
    discord: normalizedDiscord,
  };
}

function validateSlack(value, globalMaxBytes, errors, baseDirectory) {
  const enabled = Boolean(value.enabled); if (!enabled) return { enabled: false };
  const statusEmojiNames = validateStatusMap(value.statusEmojiNames, 'slack.statusEmojiNames', errors);
  const failureEmojiName = nonEmptyString(value.failureEmojiName ?? 'x', 'slack.failureEmojiName', errors);
  validateUniqueStatuses(statusEmojiNames, failureEmojiName, 'slack', errors);
  return { enabled, workspaceId: nonEmptyString(value.workspaceId, 'slack.workspaceId', errors), botToken: validateSecretReference(value.botToken, 'slack.botToken', errors, baseDirectory), appToken: validateSecretReference(value.appToken, 'slack.appToken', errors, baseDirectory), allowedChannelIds: stringArray(value.allowedChannelIds, 'slack.allowedChannelIds', errors, { nonEmpty: true }), allowedUserIds: stringArray(value.allowedUserIds, 'slack.allowedUserIds', errors, { nonEmpty: true }), nativeUploadLimitBytes: positiveInteger(value.nativeUploadLimitBytes ?? globalMaxBytes, 'slack.nativeUploadLimitBytes', errors), statusEmojiNames, failureEmojiName };
}
function validateDiscord(value, errors, baseDirectory) {
  const enabled = Boolean(value.enabled); if (!enabled) return { enabled: false };
  const allowedUserIds = stringArray(value.allowedUserIds ?? [], 'discord.allowedUserIds', errors);
  const allowedRoleIds = stringArray(value.allowedRoleIds ?? [], 'discord.allowedRoleIds', errors);
  if (!allowedUserIds.length && !allowedRoleIds.length) errors.push('discord must allow at least one user or role.');
  const statusEmojiIds = validateStatusMap(value.statusEmojiIds, 'discord.statusEmojiIds', errors);
  for (const [stage, id] of Object.entries(statusEmojiIds)) if (id && !/^\d{15,22}$/.test(id)) errors.push(`discord.statusEmojiIds.${stage} must be a Discord custom emoji ID.`);
  const failureEmoji = nonEmptyString(value.failureEmoji ?? '❌', 'discord.failureEmoji', errors);
  validateUniqueStatuses(statusEmojiIds, failureEmoji, 'discord', errors);
  return { enabled, guildId: nonEmptyString(value.guildId, 'discord.guildId', errors), token: validateSecretReference(value.token, 'discord.token', errors, baseDirectory), allowedChannelIds: stringArray(value.allowedChannelIds, 'discord.allowedChannelIds', errors, { nonEmpty: true }), allowedUserIds, allowedRoleIds, nativeUploadLimitBytes: positiveInteger(value.nativeUploadLimitBytes ?? 10 * 1024 * 1024, 'discord.nativeUploadLimitBytes', errors), statusEmojiIds, failureEmoji, threadAutoArchiveMinutes: discordArchiveDuration(value.threadAutoArchiveMinutes ?? 1440, errors) };
}
function validateAndroidSigning(value, errors, baseDirectory) {
  if (!Array.isArray(value)) { errors.push('unity.androidSigning must be an array.'); return []; }
  const normalized = value.map((entry, index) => {
    const name = `unity.androidSigning.${index}`;
    const rule = requirePlainObject(entry, name, errors);
    const repository = nonEmptyString(rule.repository, `${name}.repository`, errors);
    if (repository && (!/^[A-Za-z0-9.-]+\/[^/\s]+\/[^/\s]+$/.test(repository) || repository.endsWith('.git'))) errors.push(`${name}.repository must use canonical host/owner/repository form without .git.`);
    const projectResult = validateUnityProjectPath(rule.project ?? '.');
    if (!projectResult.ok) errors.push(`${name}.project: ${projectResult.reason}`);
    const branches = stringArray(rule.branches, `${name}.branches`, errors, { nonEmpty: true });
    const configuredProfiles = stringArray(rule.buildProfiles ?? rule.build_profiles, `${name}.buildProfiles`, errors, { nonEmpty: true });
    const buildProfiles = configuredProfiles.filter((profile) => {
      const result = validateBuildProfilePath(profile);
      if (!result.ok) { errors.push(`${name}.buildProfiles contains invalid entry ${JSON.stringify(profile)}: ${result.reason}`); return false; }
      return true;
    });
    return {
      repository,
      project: projectResult.ok ? projectResult.value : '.',
      branches,
      buildProfiles,
      keystorePassword: validateSecretReference(rule.keystorePassword ?? rule.keystore_password, `${name}.keystorePassword`, errors, baseDirectory),
      keyaliasPassword: validateSecretReference(rule.keyaliasPassword ?? rule.keyalias_password, `${name}.keyaliasPassword`, errors, baseDirectory),
    };
  });
  const scopes = new Set();
  for (const [index, rule] of normalized.entries()) {
    for (const branch of rule.branches) for (const profile of rule.buildProfiles) {
      const scope = JSON.stringify([rule.repository, rule.project, branch, profile]);
      if (scopes.has(scope)) errors.push(`unity.androidSigning.${index} overlaps another Android signing rule for the same repository, project, branch, and Build Profile.`);
      scopes.add(scope);
    }
  }
  return normalized;
}
function requirePlainObject(value, name, errors) { if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${name} must be an object.`); return {}; } return value; }
function validateStatusMap(value, name, errors) { const map = value && typeof value === 'object' && !Array.isArray(value) ? value : {}; if (map !== value) errors.push(`${name} must be an object.`); return Object.fromEntries(STATUS_KEYS.map((key) => [key, nonEmptyString(map[key], `${name}.${key}`, errors)])); }
function validateUniqueStatuses(map, failure, name, errors) { const values = Object.values(map).filter(Boolean); if (new Set(values).size !== values.length) errors.push(`${name} status emojis must be unique.`); if (values.includes(failure)) errors.push(`${name} failure emoji must differ from status emojis.`); }
function validateSecretReference(value, name, errors, baseDirectory) { if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${name} must be an object with env or file.`); return {}; } const hasEnv = typeof value.env === 'string' && value.env.length; const hasFile = typeof value.file === 'string' && value.file.length; if (Boolean(hasEnv) === Boolean(hasFile)) { errors.push(`${name} must specify exactly one of env or file.`); return {}; } return hasEnv ? { env: value.env } : { file: path.resolve(baseDirectory, value.file) }; }
function resolvePath(value, base, name, errors) { const text = nonEmptyString(value, name, errors); return text ? path.resolve(base, text) : ''; }
function nonEmptyString(value, name, errors) { if (typeof value !== 'string' || !value.trim()) { errors.push(`${name} must be a non-empty string.`); return ''; } return value.trim(); }
function stringArray(value, name, errors, { nonEmpty = false } = {}) { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) { errors.push(`${name} must be an array of non-empty strings.`); return []; } const result = [...new Set(value.map((item) => item.trim()))]; if (nonEmpty && !result.length) errors.push(`${name} must not be empty.`); return result; }
function hostname(value, name, errors) { if (typeof value !== 'string' || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(value)) { errors.push(`${name} must be a valid hostname.`); return ''; } return value.toLowerCase(); }
function hostnameArray(value, name, errors) { return stringArray(value, name, errors, { nonEmpty: true }).map((host, index) => hostname(host, `${name}.${index}`, errors)).filter(Boolean); }
function optionalHttpsUrl(value, name, hosts, errors) { if (value === null || value === undefined || value === '') return null; if (typeof value !== 'string') { errors.push(`${name} must be an HTTPS URL.`); return null; } try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) errors.push(`${name} must be HTTPS, contain no credentials/query/fragment, and match allowedEndpointHosts.`); return value; } catch { errors.push(`${name} must be an HTTPS URL.`); return null; } }
function booleanValue(value, name, errors) { if (typeof value !== 'boolean') { errors.push(`${name} must be a boolean.`); return false; } return value; }
function positiveInteger(value, name, errors) { if (!Number.isSafeInteger(value) || value <= 0) { errors.push(`${name} must be a positive safe integer.`); return 1; } return value; }
function nonNegativeInteger(value, name, errors) { if (!Number.isInteger(value) || value < 0) { errors.push(`${name} must be a non-negative integer.`); return 0; } return value; }
function nonNegativeNumber(value, name, errors) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { errors.push(`${name} must be a non-negative number.`); return 0; } return value; }
function gbToBytes(value, name, errors) { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) { errors.push(`${name} must be a positive number.`); return 1; } const bytes = value * 1024 ** 3; if (!Number.isSafeInteger(bytes)) { errors.push(`${name} is too large.`); return 1; } return bytes; }
function discordArchiveDuration(value, errors) { if (![60, 1440, 4320, 10080].includes(value)) { errors.push('discord.threadAutoArchiveMinutes must be one of 60, 1440, 4320, or 10080.'); return 1440; } return value; }
