import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function validConfig() {
  return {
    dataDir: './data',
    repository: {
      alias: 'project', sshUrl: 'git@github.com:example/project.git', allowedBranchPatterns: ['^suu/.+$'],
      sourceDependencies: {
        gitLfs: { enabled: true, mode: 'materialize_in_source_snapshot', maxObjectBytes: 10737418240, maxTotalBytesPerJob: 53687091200, allowRepositoryLfsconfig: false, allowedEndpointHosts: ['github.com', 'githubusercontent.com'] },
        submodules: { enabled: false },
      },
    },
    unity: { editorsRoot: '/Applications/Unity/Hub/Editor', buildTimeoutMinutes: 90, allowedBuildProfiles: ['Assets/BuildProfiles/PICO.asset'] },
    storage: { lfsObjects: { maxTotalGb: 300, retentionDays: 60 } },
    slack: {
      enabled: true, workspaceId: 'T1', botToken: { file: './secrets/slack-bot' }, appToken: { env: 'SLACK_APP_TOKEN' }, allowedChannelIds: ['C1'], allowedUserIds: ['U1'],
      statusEmojiNames: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, `ci_${i}`])),
    },
    discord: { enabled: false },
  };
}

test('normalizes LFS source policy defaults and paths', () => {
  const config = validateConfig(validConfig(), '/tmp/config-root');
  assert.equal(config.dataDir, path.resolve('/tmp/config-root/data'));
  assert.equal(config.repository.sourceDependencies.gitLfs.mode, 'materialize_in_source_snapshot');
  assert.equal(config.repository.sourceDependencies.gitLfs.maxObjectBytes, 10 * 1024 ** 3);
  assert.equal(config.storage.lfsObjects.maxTotalBytes, 300 * 1024 ** 3);
  assert.equal(config.repository.sourceDependencies.submodules.enabled, false);
});

test('accepts snake_case policy names', () => {
  const input = validConfig();
  input.repository.source_dependencies = {
    git_lfs: { enabled: true, mode: 'materialize_in_source_snapshot', max_object_bytes: 1000, max_total_bytes_per_job: 2000, allow_repository_lfsconfig: false, allowed_endpoint_hosts: ['github.com'] },
    submodules: { enabled: false },
  };
  delete input.repository.sourceDependencies;
  const config = validateConfig(input);
  assert.equal(config.repository.sourceDependencies.gitLfs.maxObjectBytes, 1000);
});

test('rejects legacy worker-side LFS and enabled submodules', () => {
  const input = validConfig(); input.repository.useGitLfs = 'auto'; input.repository.sourceDependencies.submodules.enabled = true;
  assert.throws(() => validateConfig(input), (error) => /useGitLfs was removed/.test(error.message) && /submodules\.enabled=true/.test(error.message));
});

test('rejects non-HTTPS or non-allowlisted endpoint', () => {
  const input = validConfig(); input.repository.sourceDependencies.gitLfs.endpointUrl = 'http://127.0.0.1/lfs';
  assert.throws(() => validateConfig(input), /must be HTTPS/);
});
