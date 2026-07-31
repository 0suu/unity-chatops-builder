import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBuildProfilePath } from './core/paths.js';

const STATUS_KEYS = Array.from({ length: 10 }, (_, index) => String(index));

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absolutePath, 'utf8'));
  return validateConfig(raw, path.dirname(absolutePath));
}

export function validateConfig(raw, baseDirectory = process.cwd()) {
  const errors = [];
  const requireObject = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${name} must be an object.`);
      return {};
    }
    return value;
  };

  const root = requireObject(raw, 'config');
  const repository = requireObject(root.repository, 'repository');
  const unity = requireObject(root.unity, 'unity');
  const artifacts = requireObject(root.artifacts ?? {}, 'artifacts');
  const runner = requireObject(root.runner ?? {}, 'runner');
  const slack = requireObject(root.slack ?? { enabled: false }, 'slack');
  const discord = requireObject(root.discord ?? { enabled: false }, 'discord');

  const dataDir = resolvePath(root.dataDir, baseDirectory, 'dataDir', errors);
  const alias = nonEmptyString(repository.alias, 'repository.alias', errors);
  const sshUrl = nonEmptyString(repository.sshUrl, 'repository.sshUrl', errors);
  const branchPatterns = stringArray(repository.allowedBranchPatterns, 'repository.allowedBranchPatterns', errors, { nonEmpty: true });
  const compiledBranchPatterns = [];
  for (const pattern of branchPatterns) {
    try {
      compiledBranchPatterns.push(new RegExp(pattern));
    } catch (error) {
      errors.push(`Invalid repository.allowedBranchPatterns entry ${JSON.stringify(pattern)}: ${error.message}`);
    }
  }

  const useGitLfs = repository.useGitLfs ?? 'auto';
  if (!['auto', 'always', 'never'].includes(useGitLfs)) {
    errors.push('repository.useGitLfs must be auto, always, or never.');
  }

  const editorsRoot = resolvePath(unity.editorsRoot ?? '/Applications/Unity/Hub/Editor', baseDirectory, 'unity.editorsRoot', errors);
  const configuredBuildProfiles = stringArray(
    unity.allowedBuildProfiles,
    'unity.allowedBuildProfiles',
    errors,
    { nonEmpty: true },
  );
  const buildProfiles = configuredBuildProfiles.filter((profile) => {
    const result = validateBuildProfilePath(profile);
    if (!result.ok) {
      errors.push(`Invalid unity.allowedBuildProfiles entry ${JSON.stringify(profile)}: ${result.reason}`);
      return false;
    }
    return true;
  });
  const buildTimeoutMinutes = positiveInteger(unity.buildTimeoutMinutes ?? 90, 'unity.buildTimeoutMinutes', errors);

  const maxBytes = positiveInteger(artifacts.maxBytes ?? 1_000_000_000, 'artifacts.maxBytes', errors);
  const successfulRetentionDays = nonNegativeNumber(artifacts.successfulRetentionDays ?? 3, 'artifacts.successfulRetentionDays', errors);
  const failedRetentionDays = nonNegativeNumber(artifacts.failedRetentionDays ?? 1, 'artifacts.failedRetentionDays', errors);
  const logsRetentionDays = nonNegativeNumber(artifacts.logsRetentionDays ?? 14, 'artifacts.logsRetentionDays', errors);

  const pollIntervalMs = positiveInteger(runner.pollIntervalMs ?? 2_000, 'runner.pollIntervalMs', errors);
  const heartbeatIntervalMs = positiveInteger(runner.heartbeatIntervalMs ?? 15_000, 'runner.heartbeatIntervalMs', errors);
  const interruptedJobRetries = nonNegativeInteger(runner.interruptedJobRetries ?? 1, 'runner.interruptedJobRetries', errors);
  const gitTimeoutSeconds = positiveInteger(runner.gitTimeoutSeconds ?? 600, 'runner.gitTimeoutSeconds', errors);

  const normalizedSlack = validateSlack(slack, maxBytes, errors, baseDirectory);
  const normalizedDiscord = validateDiscord(discord, errors, baseDirectory);
  if (!normalizedSlack.enabled && !normalizedDiscord.enabled) {
    errors.push('At least one of slack.enabled or discord.enabled must be true.');
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_CONFIG';
    throw error;
  }

  return {
    dataDir,
    repository: {
      alias,
      sshUrl,
      allowedBranchPatterns: branchPatterns,
      compiledBranchPatterns,
      useGitLfs,
    },
    unity: {
      editorsRoot,
      allowedBuildProfiles: buildProfiles,
      buildTimeoutMinutes,
    },
    artifacts: {
      maxBytes,
      successfulRetentionDays,
      failedRetentionDays,
      logsRetentionDays,
    },
    runner: {
      pollIntervalMs,
      heartbeatIntervalMs,
      interruptedJobRetries,
      gitTimeoutSeconds,
    },
    slack: normalizedSlack,
    discord: normalizedDiscord,
  };
}

function validateSlack(value, globalMaxBytes, errors, baseDirectory) {
  const enabled = Boolean(value.enabled);
  if (!enabled) return { enabled: false };

  const statusEmojiNames = validateStatusMap(value.statusEmojiNames, 'slack.statusEmojiNames', errors);
  const failureEmojiName = nonEmptyString(value.failureEmojiName ?? 'x', 'slack.failureEmojiName', errors);
  validateUniqueStatuses(statusEmojiNames, failureEmojiName, 'slack', errors);
  const allowedChannelIds = stringArray(value.allowedChannelIds, 'slack.allowedChannelIds', errors, { nonEmpty: true });
  const allowedUserIds = stringArray(value.allowedUserIds, 'slack.allowedUserIds', errors, { nonEmpty: true });

  return {
    enabled,
    workspaceId: nonEmptyString(value.workspaceId, 'slack.workspaceId', errors),
    botToken: validateSecretReference(value.botToken, 'slack.botToken', errors, baseDirectory),
    appToken: validateSecretReference(value.appToken, 'slack.appToken', errors, baseDirectory),
    allowedChannelIds,
    allowedUserIds,
    nativeUploadLimitBytes: positiveInteger(value.nativeUploadLimitBytes ?? globalMaxBytes, 'slack.nativeUploadLimitBytes', errors),
    statusEmojiNames,
    failureEmojiName,
  };
}

function validateDiscord(value, errors, baseDirectory) {
  const enabled = Boolean(value.enabled);
  if (!enabled) return { enabled: false };

  const allowedUserIds = stringArray(value.allowedUserIds ?? [], 'discord.allowedUserIds', errors);
  const allowedRoleIds = stringArray(value.allowedRoleIds ?? [], 'discord.allowedRoleIds', errors);
  if (allowedUserIds.length === 0 && allowedRoleIds.length === 0) {
    errors.push('discord must allow at least one user or role.');
  }

  const statusEmojiIds = validateStatusMap(value.statusEmojiIds, 'discord.statusEmojiIds', errors);
  for (const [stage, emojiId] of Object.entries(statusEmojiIds)) {
    if (emojiId && !/^\d{15,22}$/.test(emojiId)) {
      errors.push(`discord.statusEmojiIds.${stage} must be a Discord custom emoji ID.`);
    }
  }
  const failureEmoji = nonEmptyString(value.failureEmoji ?? '❌', 'discord.failureEmoji', errors);
  validateUniqueStatuses(statusEmojiIds, failureEmoji, 'discord', errors);

  return {
    enabled,
    guildId: nonEmptyString(value.guildId, 'discord.guildId', errors),
    token: validateSecretReference(value.token, 'discord.token', errors, baseDirectory),
    allowedChannelIds: stringArray(value.allowedChannelIds, 'discord.allowedChannelIds', errors, { nonEmpty: true }),
    allowedUserIds,
    allowedRoleIds,
    nativeUploadLimitBytes: positiveInteger(value.nativeUploadLimitBytes ?? 10 * 1024 * 1024, 'discord.nativeUploadLimitBytes', errors),
    statusEmojiIds,
    failureEmoji,
    threadAutoArchiveMinutes: discordArchiveDuration(value.threadAutoArchiveMinutes ?? 1440, errors),
  };
}

function validateStatusMap(value, name, errors) {
  const map = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (map !== value) errors.push(`${name} must be an object.`);
  const result = {};
  for (const key of STATUS_KEYS) {
    result[key] = nonEmptyString(map[key], `${name}.${key}`, errors);
  }
  return result;
}


function validateUniqueStatuses(statusMap, failureEmoji, name, errors) {
  const values = Object.values(statusMap).filter(Boolean);
  if (new Set(values).size !== values.length) {
    errors.push(`${name} status emojis must be unique.`);
  }
  if (values.includes(failureEmoji)) {
    errors.push(`${name} failure emoji must differ from status emojis.`);
  }
}

function validateSecretReference(value, name, errors, baseDirectory) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${name} must be an object with env or file.`);
    return {};
  }
  const hasEnv = typeof value.env === 'string' && value.env.length > 0;
  const hasFile = typeof value.file === 'string' && value.file.length > 0;
  if (hasEnv === hasFile) {
    errors.push(`${name} must specify exactly one of env or file.`);
    return {};
  }
  return hasEnv ? { env: value.env } : { file: path.resolve(baseDirectory, value.file) };
}

function resolvePath(value, baseDirectory, name, errors) {
  const stringValue = nonEmptyString(value, name, errors);
  return stringValue ? path.resolve(baseDirectory, stringValue) : '';
}

function nonEmptyString(value, name, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${name} must be a non-empty string.`);
    return '';
  }
  return value.trim();
}

function stringArray(value, name, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    errors.push(`${name} must be an array of non-empty strings.`);
    return [];
  }
  const result = value.map((item) => item.trim());
  if (nonEmpty && result.length === 0) errors.push(`${name} must not be empty.`);
  return [...new Set(result)];
}


function discordArchiveDuration(value, errors) {
  const allowed = new Set([60, 1440, 4320, 10080]);
  if (!allowed.has(value)) {
    errors.push('discord.threadAutoArchiveMinutes must be one of 60, 1440, 4320, or 10080.');
    return 1440;
  }
  return value;
}

function positiveInteger(value, name, errors) {
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${name} must be a positive integer.`);
    return 1;
  }
  return value;
}

function nonNegativeInteger(value, name, errors) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${name} must be a non-negative integer.`);
    return 0;
  }
  return value;
}

function nonNegativeNumber(value, name, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${name} must be a non-negative number.`);
    return 0;
  }
  return value;
}
