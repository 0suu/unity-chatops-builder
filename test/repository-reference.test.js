import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepositoryReference } from '../src/source/repository-reference.js';

test('normalizes owner/name to a GitHub SSH remote', () => {
  assert.deepEqual(normalizeRepositoryReference('0suu/Unity-Project'), { ok: true, value: { id: 'github.com/0suu/unity-project', host: 'github.com', owner: '0suu', name: 'unity-project', displayName: '0suu/unity-project', sshUrl: 'git@github.com:0suu/unity-project.git' } });
});
test('accepts canonical GitHub URL forms', () => {
  for (const input of ['git@github.com:0suu/project.git', 'ssh://git@github.com/0suu/project.git', 'https://github.com/0suu/project', 'github.com/0suu/project']) { const result = normalizeRepositoryReference(input); assert.equal(result.ok, true, input); assert.equal(result.value.id, 'github.com/0suu/project'); }
});
test('rejects non-allowlisted hosts and URL credentials', () => { assert.match(normalizeRepositoryReference('git@example.com:team/project.git').reason, /not allowlisted/); assert.match(normalizeRepositoryReference('https://token@github.com/team/project').reason, /credentials/); });
test('supports an explicitly allowlisted GitHub Enterprise host', () => { const result = normalizeRepositoryReference('git@github.example.com:team/project.git', { defaultHost: 'github.com', allowedHosts: ['github.com', 'github.example.com'] }); assert.equal(result.ok, true); assert.equal(result.value.id, 'github.example.com/team/project'); });
