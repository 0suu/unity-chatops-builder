import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseLfsPointer } from '../src/source/lfs-pointer.js';

test('parses a strict Git LFS v1 pointer', () => {
  const oid = createHash('sha256').update('hello').digest('hex');
  assert.deepEqual(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 5\n`), {
    version: 'https://git-lfs.github.com/spec/v1', oidSha256: oid, sizeBytes: 5,
  });
});

test('rejects malformed pointer fields', () => {
  assert.throws(() => parseLfsPointer('version https://git-lfs.github.com/spec/v1\noid sha1:abc\nsize -1\n'), (error) => error.code === 'LFS_POINTER_INVALID');
});
