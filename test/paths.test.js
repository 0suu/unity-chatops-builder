import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathInside, safeSlug, validateBuildProfilePath, validateUnityProjectPath } from '../src/core/paths.js';

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

test('validates Unity project subdirectory paths', () => {
  assert.deepEqual(validateUnityProjectPath('.'), { ok: true, value: '.' });
  assert.deepEqual(validateUnityProjectPath('STYLY-NetSync-Unity'), { ok: true, value: 'STYLY-NetSync-Unity' });
  assert.equal(validateUnityProjectPath('Unity Projects/STYLY').ok, true);
  assert.equal(validateUnityProjectPath('../outside').ok, false);
  assert.equal(validateUnityProjectPath('/tmp/project').ok, false);
  assert.equal(validateUnityProjectPath('STYLY\\Project').ok, false);
});

test('creates safe artifact slugs', () => {
  assert.equal(safeSlug('suu/feature: test'), 'suu-feature-test');
});
