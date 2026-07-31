import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildRequest } from '../src/core/request-parser.js';

test('parses a valid build request', () => {
  assert.deepEqual(parseBuildRequest(`
    unity-build
    branch: suu/feature/example
    profile: Assets/BuildProfiles/PICO-Development.asset
  `), {
    recognized: true,
    value: {
      branch: 'suu/feature/example',
      profile: 'Assets/BuildProfiles/PICO-Development.asset',
    },
  });
});

test('ignores unrelated messages', () => {
  assert.deepEqual(parseBuildRequest('hello'), { recognized: false });
});

test('rejects duplicate and unknown keys', () => {
  const result = parseBuildRequest(`unity-build
branch: main
branch: other
profile: Assets/Profile.asset
repo: arbitrary`);
  assert.equal(result.recognized, true);
  assert.match(result.errors.join('\n'), /Duplicate key: branch/);
  assert.match(result.errors.join('\n'), /Unknown key: repo/);
});
