import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LfsObjectCache } from '../src/source/lfs-object-cache.js';

const logger = { warn() {} };
function cache(root, overrides = {}) { return new LfsObjectCache({ root, maxObjectBytes: 1024, maxTotalBytesPerJob: 2048, maxCacheBytes: 4096, retentionDays: 60, logger, ...overrides }); }

test('downloads, verifies, caches, and materializes by OID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lfs-cache-'));
  try {
    const bytes = Buffer.from('verified object');
    const oid = createHash('sha256').update(bytes).digest('hex');
    let downloads = 0;
    const lfsClient = {
      async createDownloadPlan() { return new Map([[oid, { href: new URL('https://objects.githubusercontent.com/object'), headers: {} }]]); },
      async downloadPlannedObject({ destinationPath }) { downloads += 1; await writeFile(destinationPath, bytes, { flag: 'wx' }); },
    };
    const objectCache = cache(root);
    const pointers = [{ path: 'Assets/model.bin', oidSha256: oid, sizeBytes: bytes.length }];
    const first = await objectCache.prepare({ pointers, lfsClient, remoteUrl: 'unused', endpointUrl: new URL('https://github.com/repo/info/lfs') });
    const second = await objectCache.prepare({ pointers, lfsClient, remoteUrl: 'unused', endpointUrl: new URL('https://github.com/repo/info/lfs') });
    assert.equal(downloads, 1);
    assert.equal(first.get(oid), second.get(oid));
    const destination = path.join(root, 'materialized.bin');
    await objectCache.materialize({ cachePath: first.get(oid), destinationPath: destination, expectedOidSha256: oid, expectedSizeBytes: bytes.length });
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal((await stat(first.get(oid))).mode & 0o222, 0);
  } finally { await chmod(root, 0o755).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('never publishes a hash-mismatched object and enforces limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lfs-cache-'));
  try {
    const expected = Buffer.from('expected');
    const oid = createHash('sha256').update(expected).digest('hex');
    const lfsClient = {
      async createDownloadPlan() { return new Map([[oid, {}]]); },
      async downloadPlannedObject({ destinationPath }) { await writeFile(destinationPath, Buffer.from('mismatch'), { flag: 'wx' }); },
    };
    await assert.rejects(() => cache(root).prepare({ pointers: [{ path: 'x', oidSha256: oid, sizeBytes: expected.length }], lfsClient, remoteUrl: '', endpointUrl: '' }), (error) => ['LFS_OBJECT_HASH_MISMATCH', 'LFS_OBJECT_SIZE_MISMATCH'].includes(error.code));
    await assert.rejects(() => cache(root, { maxObjectBytes: 2 }).prepare({ pointers: [{ path: 'x', oidSha256: oid, sizeBytes: 8 }], lfsClient, remoteUrl: '', endpointUrl: '' }), (error) => error.code === 'LFS_OBJECT_TOO_LARGE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OID lock prevents duplicate concurrent downloads and protection lease blocks GC until snapshot publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lfs-cache-'));
  try {
    const bytes = Buffer.from('parallel-object');
    const oid = createHash('sha256').update(bytes).digest('hex');
    let downloads = 0;
    const lfsClient = {
      async createDownloadPlan() { return new Map([[oid, {}]]); },
      async downloadPlannedObject({ destinationPath }) {
        downloads += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await writeFile(destinationPath, bytes, { flag: 'wx' });
      },
    };
    const objectCache = cache(root, { maxCacheBytes: 0, retentionDays: 0 });
    const pointers = [{ path: 'a', oidSha256: oid, sizeBytes: bytes.length }];
    const lease = await objectCache.acquireProtection(pointers);
    await Promise.all([
      objectCache.prepare({ pointers, lfsClient, remoteUrl: '', endpointUrl: '', protectionLease: lease }),
      objectCache.prepare({ pointers, lfsClient, remoteUrl: '', endpointUrl: '', protectionLease: lease }),
    ]);
    assert.equal(downloads, 1);
    await objectCache.gc({ protectedOids: new Set(), now: Date.now() + 1000 });
    assert.equal((await stat(objectCache.objectPath(oid))).isFile(), true);
    await lease.release();
    await objectCache.gc({ protectedOids: new Set(), now: Date.now() + 2000 });
    await assert.rejects(() => stat(objectCache.objectPath(oid)), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('enforces total materialized LFS bytes per job', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lfs-cache-'));
  try {
    const objectCache = cache(root, { maxObjectBytes: 10, maxTotalBytesPerJob: 5 });
    const pointers = [
      { path: 'a', oidSha256: 'a'.repeat(64), sizeBytes: 3 },
      { path: 'b', oidSha256: 'b'.repeat(64), sizeBytes: 3 },
    ];
    await assert.rejects(() => objectCache.prepare({ pointers, lfsClient: {}, remoteUrl: '', endpointUrl: '' }), (error) => error.code === 'LFS_TOTAL_SIZE_LIMIT_EXCEEDED');
  } finally { await rm(root, { recursive: true, force: true }); }
});
