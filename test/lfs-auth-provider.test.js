import test from 'node:test';
import assert from 'node:assert/strict';
import { LfsAuthProvider } from '../src/source/lfs-auth-provider.js';
import { LfsEndpointPolicy } from '../src/source/lfs-endpoint-policy.js';

const endpointPolicy = new LfsEndpointPolicy({ allowedHosts: ['github.com', 'githubusercontent.com'], resolveDns: false });
const result = (stdout) => ({ code: 0, signal: null, timedOut: false, aborted: false, stdout, stderr: '', stdoutTruncated: false });

test('rejects an SSH LFS auth response outside the endpoint allowlist', async () => {
  const provider = new LfsAuthProvider({
    endpointPolicy,
    runProcess: async () => result(JSON.stringify({ href: 'https://attacker.example/lfs' })),
  });
  await assert.rejects(
    () => provider.resolve({ remoteUrl: 'git@github.com:owner/repository.git', endpointUrl: null }),
    (error) => error.code === 'LFS_ENDPOINT_NOT_ALLOWED',
  );
});

test('rejects CRLF-containing LFS authorization headers', async () => {
  const provider = new LfsAuthProvider({
    endpointPolicy,
    runProcess: async () => result(JSON.stringify({ href: 'https://github.com/owner/repository.git/info/lfs', header: { Authorization: 'Bearer ok\r\nX-Injected: yes' } })),
  });
  await assert.rejects(
    () => provider.resolve({ remoteUrl: 'git@github.com:owner/repository.git', endpointUrl: null }),
    (error) => error.code === 'LFS_AUTHENTICATION_FAILED',
  );
});

test('rejects an incomplete HTTPS credential helper response', async () => {
  const provider = new LfsAuthProvider({
    endpointPolicy,
    runProcess: async () => result('username=alice\n'),
  });
  await assert.rejects(
    () => provider.resolve({ remoteUrl: 'https://github.com/owner/repository.git', endpointUrl: new URL('https://github.com/owner/repository.git/info/lfs') }),
    (error) => error.code === 'LFS_AUTHENTICATION_FAILED',
  );
});

test('maps a non-JSON SSH LFS auth response to a stable authentication error', async () => {
  const provider = new LfsAuthProvider({ endpointPolicy, runProcess: async () => result('not-json') });
  await assert.rejects(
    () => provider.resolve({ remoteUrl: 'git@github.com:owner/repository.git', endpointUrl: null }),
    (error) => error.code === 'LFS_AUTHENTICATION_FAILED',
  );
});
