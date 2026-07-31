import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function validConfig() { return {
  dataDir: './data',
  repositoryAccess: { defaultHost: 'github.com', allowedHosts: ['github.com'] },
  sourceDependencies: { gitLfs: { enabled: true, mode: 'materialize_in_source_snapshot', maxObjectBytes: 10737418240, maxTotalBytesPerJob: 53687091200, allowRepositoryLfsconfig: false, allowedEndpointHosts: ['github.com', 'githubusercontent.com'] }, submodules: { enabled: false } },
  unity: { editorsRoot: '/Applications/Unity/Hub/Editor', buildTimeoutMinutes: 90 },
  storage: { lfsObjects: { maxTotalGb: 300, retentionDays: 60 } },
  slack: { enabled: true, workspaceId: 'T1', botToken: { file: './secrets/slack-bot' }, appToken: { env: 'SLACK_APP_TOKEN' }, allowedChannelIds: ['C1'], allowedUserIds: ['U1'], statusEmojiNames: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index, `ci_${index}`])) },
  discord: { enabled: false },
}; }

test('normalizes dynamic repository access, LFS defaults, and paths', () => { const config = validateConfig(validConfig(), '/tmp/config-root'); assert.equal(config.dataDir, path.resolve('/tmp/config-root/data')); assert.equal(config.repositoryAccess.defaultHost, 'github.com'); assert.deepEqual(config.repositoryAccess.allowedHosts, ['github.com']); assert.equal(config.repositoryAccess.compiledBranchPatterns[0].test('main'), true); assert.deepEqual(config.unity.allowedBuildProfiles, []); assert.equal(config.sourceDependencies.gitLfs.mode, 'materialize_in_source_snapshot'); assert.equal(config.sourceDependencies.gitLfs.maxObjectBytes, 10 * 1024 ** 3); assert.equal(config.storage.lfsObjects.maxTotalBytes, 300 * 1024 ** 3); });
test('accepts snake_case dynamic source policy names', () => { const input = validConfig(); input.repository_access = { default_host: 'github.com', allowed_hosts: ['github.com', 'github.example.com'], allowed_branch_patterns: ['^main$', '^feature/.+$'] }; delete input.repositoryAccess; input.source_dependencies = { git_lfs: { enabled: true, mode: 'materialize_in_source_snapshot', max_object_bytes: 1000, max_total_bytes_per_job: 2000, allow_repository_lfsconfig: false, allowed_endpoint_hosts: ['github.com'] }, submodules: { enabled: false } }; delete input.sourceDependencies; const config = validateConfig(input); assert.equal(config.sourceDependencies.gitLfs.maxObjectBytes, 1000); assert.deepEqual(config.repositoryAccess.allowedHosts, ['github.com', 'github.example.com']); });
test('allows an optional global Build Profile allowlist', () => { const input = validConfig(); input.unity.allowedBuildProfiles = ['Assets/BuildProfiles/PICO.asset']; assert.deepEqual(validateConfig(input).unity.allowedBuildProfiles, ['Assets/BuildProfiles/PICO.asset']); });
test('rejects legacy fixed repository configuration and enabled submodules', () => { const input = validConfig(); input.repository = { alias: 'project', sshUrl: 'git@github.com:example/project.git' }; input.sourceDependencies.submodules.enabled = true; assert.throws(() => validateConfig(input), (error) => /Fixed repository/.test(error.message) && /submodules\.enabled=true/.test(error.message)); });
test('rejects non-HTTPS or non-allowlisted LFS endpoint', () => { const input = validConfig(); input.sourceDependencies.gitLfs.endpointUrl = 'http://127.0.0.1/lfs'; assert.throws(() => validateConfig(input), /must be HTTPS/); });
