import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { LfsEndpointPolicy } from '../src/source/lfs-endpoint-policy.js';
import { LfsObjectCache } from '../src/source/lfs-object-cache.js';
import { SourceSnapshotStore } from '../src/source/source-snapshot-store.js';
import { RepositorySourceResolver } from '../src/source/repository-source-resolver.js';

const logger = { warn() {}, info() {}, debug() {}, error() {} };
test('Coordinator resolves a dynamically selected repository and nested Unity project into a verified snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'resolver-')); let snapshotStore;
  try {
    const source = path.join(directory, 'source'); await mkdir(source); await git(['init', '-b', 'main'], source); await git(['config', 'user.email', 'test@example.com'], source); await git(['config', 'user.name', 'Test'], source);
    const object = Buffer.from('large materialized object'); const oid = createHash('sha256').update(object).digest('hex');
    await mkdir(path.join(source, 'STYLY-NetSync-Unity', 'Assets'), { recursive: true }); await mkdir(path.join(source, 'STYLY-NetSync-Unity', 'ProjectSettings'), { recursive: true });
    await writeFile(path.join(source, '.gitattributes'), 'STYLY-NetSync-Unity/Assets/*.bin filter=lfs diff=lfs merge=lfs -text\n'); await writeFile(path.join(source, 'STYLY-NetSync-Unity', 'Assets', 'model.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${object.length}\n`); await writeFile(path.join(source, 'STYLY-NetSync-Unity', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.59f2\n');
    await git(['add', '.'], source); await git(['commit', '-m', 'lfs'], source); await git(['checkout', '-b', 'suu/test'], source);
    const dataDir = path.join(directory, 'data'); const endpointPolicy = new LfsEndpointPolicy({ allowedHosts: ['github.com', 'githubusercontent.com'], resolveDns: false });
    snapshotStore = new SourceSnapshotStore({ root: path.join(dataDir, 'source-snapshots'), workspaceRoot: path.join(dataDir, 'workspaces'), logger });
    const objectCache = new LfsObjectCache({ root: path.join(dataDir, 'lfs-objects'), maxObjectBytes: 1024, maxTotalBytesPerJob: 2048, maxCacheBytes: 4096, retentionDays: 60, logger });
    const fakeClient = { async createDownloadPlan() { return new Map([[oid, { href: new URL('https://objects.githubusercontent.com/object'), headers: {} }]]); }, async downloadPlannedObject({ destinationPath }) { await writeFile(destinationPath, object, { flag: 'wx' }); } };
    const config = { sourceDependencies: { gitLfs: { enabled: true, endpointUrl: 'https://github.com/example/project.git/info/lfs' }, submodules: { enabled: false } }, runner: { gitTimeoutSeconds: 60 } };
    const resolver = new RepositorySourceResolver({ config, dataDir, logger, endpointPolicy, lfsObjectCache: objectCache, lfsClient: fakeClient, snapshotStore });
    const repository = { id: 'github.com/example/project', owner: 'example', name: 'project', displayName: 'example/project', sshUrl: source };
    const resolved = await resolver.resolve({ repository, requestedRef: 'suu/test', projectPath: 'STYLY-NetSync-Unity' });
    assert.equal(resolved.repositoryId, repository.id); assert.equal(resolved.unityVersion, '6000.0.59f2'); assert.equal(resolved.sourceSnapshotManifest.repositoryId, repository.id); assert.equal(resolved.sourceSnapshotManifest.lfs.objectCount, 1);
    const workspace = path.join(dataDir, 'workspaces', 'job'); await snapshotStore.materializeWorkspace({ snapshotId: resolved.sourceSnapshotId, workspacePath: workspace }); assert.deepEqual(await readFile(path.join(workspace, 'STYLY-NetSync-Unity', 'Assets', 'model.bin')), object); await assert.rejects(() => readFile(path.join(workspace, '.git')), /ENOENT/);
  } finally { await snapshotStore?.gc({ retentionDays: 0 }); await rm(directory, { recursive: true, force: true }); }
});
function git(args, cwd) { return new Promise((resolve, reject) => { const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))); }); }
