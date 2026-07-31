import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizedEnvironment } from '../src/core/process-runner.js';
import { coordinatorCredentialEnvironment, coordinatorSourceEnvironment } from '../src/source/lfs-auth-provider.js';

test('Worker child environment excludes SSH, Git credential, LFS, and chat credentials', () => {
  const input = {
    PATH: '/bin',
    LANG: 'ja_JP.UTF-8',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    SSH_AGENT_PID: '123',
    GIT_ASKPASS: '/tmp/askpass',
    GIT_CONFIG_GLOBAL: '/tmp/gitconfig',
    GITHUB_TOKEN: 'secret',
    GH_TOKEN: 'secret',
    LFS_AUTHORIZATION: 'secret',
    SLACK_BOT_TOKEN: 'secret',
    SAFE_VALUE: 'kept',
  };
  assert.deepEqual(sanitizedEnvironment(input), {
    PATH: '/bin',
    LANG: 'ja_JP.UTF-8',
    SAFE_VALUE: 'kept',
  });
});

test('Coordinator source and credential environments expose only their required credential surface', () => {
  const input = {
    PATH: '/bin', HOME: '/home/ci', SSH_AUTH_SOCK: '/tmp/agent.sock',
    GITHUB_TOKEN: 'secret', SLACK_BOT_TOKEN: 'secret', RANDOM_VALUE: 'drop',
  };
  const source = coordinatorSourceEnvironment(input);
  assert.equal(source.SSH_AUTH_SOCK, '/tmp/agent.sock');
  assert.equal(source.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(source.GITHUB_TOKEN, undefined);
  assert.equal(source.SLACK_BOT_TOKEN, undefined);
  assert.equal(source.RANDOM_VALUE, undefined);

  const credentials = coordinatorCredentialEnvironment(input);
  assert.equal(credentials.SSH_AUTH_SOCK, '/tmp/agent.sock');
  assert.equal(credentials.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(credentials.GITHUB_TOKEN, undefined);
});
