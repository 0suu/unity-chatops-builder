import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, sanitizedEnvironment } from '../src/core/process-runner.js';

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

test('reports stdout and stderr truncation instead of silently accepting incomplete output', async () => {
  const result = await runProcess('/bin/sh', ['-c', 'printf "%s" "$1"; printf "%s" "$1" >&2', 'shell', 'x'.repeat(128)], { maxCaptureBytes: 16 });
  assert.equal(result.code, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.stdout.length, 16);
  assert.equal(result.stderr.length, 16);
});
