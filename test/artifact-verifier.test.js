import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ArtifactVerifier } from '../src/build/artifact-verifier.js';

const logger = { warn() {}, debug() {}, info() {}, error() {} };

test('verifies a minimal APK-shaped ZIP and computes SHA-256', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-apk-'));
  try {
    const input = path.join(directory, 'input');
    await mkdir(input);
    await writeFile(path.join(input, 'AndroidManifest.xml'), 'manifest');
    await writeFile(path.join(input, 'classes.dex'), 'dex');
    const apkPath = path.join(directory, 'app.apk');
    await run('/usr/bin/zip', ['-q', apkPath, 'AndroidManifest.xml', 'classes.dex'], input);

    const verifier = new ArtifactVerifier({ maxBytes: 1_000_000, logger });
    const artifact = await verifier.verify({ path: apkPath, name: 'app.apk' });
    assert.equal(artifact.name, 'app.apk');
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an APK without AndroidManifest.xml', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-apk-'));
  try {
    const input = path.join(directory, 'input');
    await mkdir(input);
    await writeFile(path.join(input, 'classes.dex'), 'dex');
    const apkPath = path.join(directory, 'bad.apk');
    await run('/usr/bin/zip', ['-q', apkPath, 'classes.dex'], input);

    const verifier = new ArtifactVerifier({ maxBytes: 1_000_000, logger });
    await assert.rejects(() => verifier.verify({ path: apkPath }), (error) => error.code === 'ARTIFACT_MANIFEST_MISSING');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
