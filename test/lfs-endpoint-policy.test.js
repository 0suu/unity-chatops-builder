import test from 'node:test';
import assert from 'node:assert/strict';
import { LfsEndpointPolicy, deriveDefaultLfsEndpoint } from '../src/source/lfs-endpoint-policy.js';

test('derives and allows a trusted GitHub LFS endpoint', async () => {
  assert.equal(deriveDefaultLfsEndpoint('git@github.com:example/project.git'), 'https://github.com/example/project.git/info/lfs');
  const policy = new LfsEndpointPolicy({ allowedHosts: ['github.com', 'githubusercontent.com'], resolveDns: false });
  const endpoint = await policy.resolve({ trustedRemoteUrl: 'git@github.com:example/project.git' });
  assert.equal(endpoint.href, 'https://github.com/example/project.git/info/lfs');
});

test('rejects .lfsconfig by default and private destinations', async () => {
  const policy = new LfsEndpointPolicy({ allowedHosts: ['github.com'], resolveDns: false });
  await assert.rejects(() => policy.resolve({ trustedRemoteUrl: 'git@github.com:example/project.git', lfsConfigContent: '[lfs]\nurl = https://github.com/other/repo\n' }), (error) => error.code === 'LFS_ENDPOINT_NOT_ALLOWED');
  await assert.rejects(() => policy.assertAllowedUrl('https://127.0.0.1/object'), (error) => error.code === 'LFS_ENDPOINT_NOT_ALLOWED');
});

test('revalidates redirect hosts', async () => {
  const policy = new LfsEndpointPolicy({ allowedHosts: ['githubusercontent.com'], resolveDns: false });
  await assert.rejects(() => policy.validateRedirect('https://objects.githubusercontent.com/a', 'https://evil.example/file'), (error) => error.code === 'LFS_ENDPOINT_NOT_ALLOWED');
});

test('rejects query credentials and fragments on configured endpoints and remotes', async () => {
  const policy = new LfsEndpointPolicy({ allowedHosts: ['github.com', 'githubusercontent.com'], resolveDns: false });
  await assert.rejects(
    policy.resolve({ trustedRemoteUrl: 'git@github.com:org/repo.git', configuredEndpointUrl: 'https://github.com/org/repo.git/info/lfs?token=secret' }),
    (error) => error.code === 'LFS_ENDPOINT_NOT_ALLOWED',
  );
  await assert.rejects(
    policy.resolve({ trustedRemoteUrl: 'https://github.com/org/repo.git?token=secret' }),
    (error) => error.code === 'LFS_ENDPOINT_NOT_ALLOWED',
  );
});
