import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathInside, safeSlug, validateBuildProfilePath } from '../src/core/paths.js';

test('validates Unity Build Profile paths', () => {
  assert.deepEqual(validateBuildProfilePath('Assets/BuildProfiles/PICO.asset'), {
    ok: true,
    value: 'Assets/BuildProfiles/PICO.asset',
  });
  assert.equal(validateBuildProfilePath('../PICO.asset').ok, false);
  assert.equal(validateBuildProfilePath('/Assets/PICO.asset').ok, false);
  assert.equal(validateBuildProfilePath('Packages/PICO.asset').ok, false);
  assert.equal(validateBuildProfilePath('Assets\\PICO.asset').ok, false);
});

test('checks path containment without prefix confusion', () => {
  assert.equal(isPathInside('/tmp/work', '/tmp/work/file'), true);
  assert.equal(isPathInside('/tmp/work', '/tmp/work-other/file'), false);
});

test('creates safe artifact slugs', () => {
  assert.equal(safeSlug('suu/feature: test'), 'suu-feature-test');
});
