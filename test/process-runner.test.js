import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizedEnvironment } from '../src/core/process-runner.js';

test('removes chat and credential-like environment variables', () => {
  const env = sanitizedEnvironment({
    PATH: '/bin',
    HOME: '/tmp/home',
    SLACK_BOT_TOKEN: 'secret',
    DISCORD_TOKEN: 'secret',
    API_KEY: 'secret',
    SAFE_VALUE: 'ok',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.SAFE_VALUE, 'ok');
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.DISCORD_TOKEN, undefined);
  assert.equal(env.API_KEY, undefined);
});
