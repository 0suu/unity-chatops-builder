import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function validConfig() {
  return {
    dataDir: './data',
    repository: {
      alias: 'project',
      sshUrl: 'git@github.com:example/project.git',
      allowedBranchPatterns: ['^suu/.+$'],
      useGitLfs: 'auto',
    },
    unity: {
      editorsRoot: '/Applications/Unity/Hub/Editor',
      buildTimeoutMinutes: 90,
      allowedBuildProfiles: ['Assets/BuildProfiles/PICO.asset'],
    },
    slack: {
      enabled: true,
      workspaceId: 'T1',
      botToken: { file: './secrets/slack-bot' },
      appToken: { env: 'SLACK_APP_TOKEN' },
      allowedChannelIds: ['C1'],
      allowedUserIds: ['U1'],
      statusEmojiNames: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, `ci_${i}`])),
    },
    discord: { enabled: false },
  };
}

test('normalizes defaults and relative paths', () => {
  const config = validateConfig(validConfig(), '/tmp/config-root');
  assert.equal(config.dataDir, path.resolve('/tmp/config-root/data'));
  assert.equal(config.slack.botToken.file, path.resolve('/tmp/config-root/secrets/slack-bot'));
  assert.equal(config.artifacts.maxBytes, 1_000_000_000);
  assert.equal(config.repository.compiledBranchPatterns[0].test('suu/example'), true);
});

test('requires at least one enabled platform', () => {
  const input = validConfig();
  input.slack.enabled = false;
  assert.throws(() => validateConfig(input), /At least one/);
});

test('rejects unsupported Discord thread archive durations', () => {
  const input = validConfig();
  input.slack.enabled = false;
  input.discord = {
    enabled: true,
    guildId: 'G1',
    token: { env: 'DISCORD_TOKEN' },
    allowedChannelIds: ['C1'],
    allowedUserIds: ['U1'],
    allowedRoleIds: [],
    threadAutoArchiveMinutes: 30,
    statusEmojiIds: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, `10000000000000000${i}`])),
  };
  assert.throws(() => validateConfig(input), /threadAutoArchiveMinutes/);
});


test('reports an invalid secret reference instead of throwing a path TypeError', () => {
  const input = validConfig();
  input.slack.botToken = {};
  assert.throws(
    () => validateConfig(input),
    (error) => error.code === 'INVALID_CONFIG' && /slack\.botToken must specify exactly one/.test(error.message),
  );
});

test('rejects duplicate status emojis and malformed Build Profile allowlists', () => {
  const input = validConfig();
  input.slack.statusEmojiNames['9'] = input.slack.statusEmojiNames['8'];
  input.unity.allowedBuildProfiles = ['../PICO.asset'];
  assert.throws(
    () => validateConfig(input),
    (error) => /status emojis must be unique/.test(error.message)
      && /Invalid unity\.allowedBuildProfiles/.test(error.message),
  );
});
