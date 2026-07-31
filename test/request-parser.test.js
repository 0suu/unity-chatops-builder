import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildRequest } from '../src/core/request-parser.js';

test('parses repository, branch, and build profile', () => {
  assert.deepEqual(parseBuildRequest(`
    unity-build
    repository: 0suu/unity-project
    branch: suu/feature/example
    profile: Assets/BuildProfiles/PICO-Development.asset
  `), { recognized: true, value: { repository: '0suu/unity-project', branch: 'suu/feature/example', profile: 'Assets/BuildProfiles/PICO-Development.asset' } });
});
test('accepts repo as a shorthand alias', () => { assert.equal(parseBuildRequest('unity-build\nrepo: 0suu/project\nbranch: main\nprofile: Assets/P.asset').value.repository, '0suu/project'); });
test('parses an optional Unity project subdirectory', () => {
  assert.deepEqual(parseBuildRequest('unity-build\nrepository: styly-dev/STYLY-NetSync\nproject: STYLY-NetSync-Unity\nbranch: develop\nprofile: Assets/Settings/Build Profiles/SyncObjectTest_User.asset').value, {
    repository: 'styly-dev/STYLY-NetSync', project: 'STYLY-NetSync-Unity', branch: 'develop', profile: 'Assets/Settings/Build Profiles/SyncObjectTest_User.asset',
  });
});
test('ignores unrelated messages', () => { assert.deepEqual(parseBuildRequest('hello'), { recognized: false }); });
test('rejects duplicate repository aliases and missing fields', () => { const result = parseBuildRequest('unity-build\nrepository: 0suu/a\nrepo: 0suu/b\nbranch: main'); assert.match(result.errors.join('\n'), /Duplicate key: repository/); assert.match(result.errors.join('\n'), /Missing key: profile/); });
