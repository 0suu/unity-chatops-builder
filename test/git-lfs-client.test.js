import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitLfsClient } from '../src/source/git-lfs-client.js';
import { LfsEndpointPolicy } from '../src/source/lfs-endpoint-policy.js';

test('uses Batch API and strips authorization across an allowed cross-origin redirect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lfs-client-'));
  try {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url: String(url), headers: options.headers });
      if (String(url).endsWith('/objects/batch')) return new Response(JSON.stringify({ objects: [{ oid: 'a'.repeat(64), size: 3, actions: { download: { href: 'https://github.com/download', header: { Authorization: 'Bearer secret' } } } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (String(url) === 'https://github.com/download') return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/object' } });
      return new Response(Buffer.from('abc'), { status: 200, headers: { 'content-length': '3' } });
    };
    const policy = new LfsEndpointPolicy({ allowedHosts: ['github.com', 'githubusercontent.com'], resolveDns: false });
    const client = new GitLfsClient({ endpointPolicy: policy, fetchImpl, timeoutMs: 5000 });
    const plan = await client.createDownloadPlan({ remoteUrl: '', endpointUrl: new URL('https://github.com/repo/info/lfs'), objects: [{ oidSha256: 'a'.repeat(64), sizeBytes: 3 }] });
    const destination = path.join(directory, 'object');
    await client.downloadPlannedObject({ action: plan.get('a'.repeat(64)), destinationPath: destination, expectedSizeBytes: 3 });
    assert.equal(await readFile(destination, 'utf8'), 'abc');
    const redirected = seen.find((item) => item.url === 'https://objects.githubusercontent.com/object');
    assert.equal(Object.keys(redirected.headers).some((key) => key.toLowerCase() === 'authorization'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('maps Batch API authentication and missing-object failures to stable error codes', async () => {
  const policy = new LfsEndpointPolicy({ allowedHosts: ['github.com'], resolveDns: false });
  for (const [status, code] of [[401, 'LFS_AUTHENTICATION_FAILED'], [404, 'LFS_OBJECT_NOT_FOUND']]) {
    const client = new GitLfsClient({ endpointPolicy: policy, fetchImpl: async () => new Response('', { status }), timeoutMs: 5000 });
    await assert.rejects(
      () => client.createDownloadPlan({ remoteUrl: '', endpointUrl: new URL('https://github.com/repo/info/lfs'), objects: [{ oidSha256: 'a'.repeat(64), sizeBytes: 3 }] }),
      (error) => error.code === code,
    );
  }
});
