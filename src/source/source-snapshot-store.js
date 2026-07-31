import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../core/canonical-json.js';
import { isPathInsideOrEqual } from '../core/paths.js';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';

const DAY_MS = 86_400_000;

export class SourceSnapshotStore {
  constructor({ root, workspaceRoot, logger }) {
    this.root = root;
    this.workspaceRoot = workspaceRoot;
    this.logger = logger;
  }

  async publish({ repositoryId, commitSha, stagingPath, lfsObjects }) {
    const sourceEntries = await describeTree(stagingPath, { excludeGit: true });
    const filesDigest = sha256Hex(canonicalJson(sourceEntries));
    const normalizedLfs = normalizeLfs(lfsObjects);
    const identity = {
      repositoryId,
      commitSha,
      filesDigest,
      lfs: {
        enabled: true,
        objectCount: normalizedLfs.length,
        totalSizeBytes: normalizedLfs.reduce((sum, item) => sum + item.sizeBytes, 0),
        objects: normalizedLfs,
      },
    };
    // snapshotId/createdAt are excluded from the identity to avoid self-reference and nondeterminism.
    const snapshotId = sha256Hex(canonicalJson(identity));
    const manifest = { snapshotId, ...identity, createdAt: new Date().toISOString() };
    const finalDirectory = this.snapshotDirectory(snapshotId);
    const existing = await tryReadManifest(path.join(finalDirectory, 'manifest.json'));
    if (existing) {
      if (canonicalJson(stripGeneratedFields(existing)) !== canonicalJson(identity)) throw snapshotError('SOURCE_SNAPSHOT_COLLISION', '同じsnapshotIdに異なるManifestが存在します。');
      return { snapshotId, manifest: existing, sourcePath: path.join(finalDirectory, 'source') };
    }

    const parent = path.dirname(finalDirectory);
    await mkdir(parent, { recursive: true });
    const temporaryDirectory = path.join(parent, `.${snapshotId}.${randomUUID()}.tmp`);
    const temporarySource = path.join(temporaryDirectory, 'source');
    try {
      await mkdir(temporarySource, { recursive: true });
      await copyTree(stagingPath, temporarySource, { excludeGit: true, writable: false });
      const copiedEntries = await describeTree(temporarySource, { excludeGit: false });
      if (sha256Hex(canonicalJson(copiedEntries)) !== filesDigest) throw snapshotError('SOURCE_SNAPSHOT_DIGEST_MISMATCH', 'Source Snapshot公開前のtree digestが一致しません。');
      await writeFile(path.join(temporaryDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: 'wx' });
      await makeReadOnly(temporarySource);
      await chmod(temporaryDirectory, 0o555);
      await fsyncTree(temporaryDirectory);
      try { await rename(temporaryDirectory, finalDirectory); }
      catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
        const concurrent = await tryReadManifest(path.join(finalDirectory, 'manifest.json'));
        if (!concurrent || canonicalJson(stripGeneratedFields(concurrent)) !== canonicalJson(identity)) throw error;
      }
      await fsyncDirectory(parent);
      return { snapshotId, manifest: await this.readManifest(snapshotId), sourcePath: path.join(finalDirectory, 'source') };
    } finally { await makeWritable(temporaryDirectory).catch(() => {}); await rm(temporaryDirectory, { recursive: true, force: true }); }
  }

  snapshotDirectory(snapshotId) {
    assertSnapshotId(snapshotId);
    return path.join(this.root, 'sha256', snapshotId.slice(0, 2), snapshotId);
  }

  async readManifest(snapshotId) {
    const manifest = await tryReadManifest(path.join(this.snapshotDirectory(snapshotId), 'manifest.json'));
    if (!manifest || manifest.snapshotId !== snapshotId) throw snapshotError('SOURCE_SNAPSHOT_NOT_FOUND', 'Source Snapshotが存在しないかManifestが不正です。', { snapshotId });
    return manifest;
  }

  async materializeWorkspace({ snapshotId, workspacePath }) {
    const root = path.resolve(this.workspaceRoot);
    const target = path.resolve(workspacePath);
    if (!isPathInsideOrEqual(root, target)) throw snapshotError('WORKSPACE_PATH_INVALID', 'Workspace pathが許可root外です。');
    const manifest = await this.readManifest(snapshotId);
    const sourcePath = path.join(this.snapshotDirectory(snapshotId), 'source');
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    try {
      await copyTree(sourcePath, target, { excludeGit: true, writable: true });
      const entries = await describeTree(target, { excludeGit: true });
      if (sha256Hex(canonicalJson(entries)) !== manifest.filesDigest) throw snapshotError('WORKSPACE_DIGEST_MISMATCH', 'Worker Workspaceのtree digestがSnapshotと一致しません。');
      if (await pathExists(path.join(target, '.git'))) throw snapshotError('WORKSPACE_GIT_METADATA_PRESENT', 'Worker Workspaceに.gitを含めることはできません。');
      return target;
    } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
  }

  cleanupWorkspace(workspacePath) {
    return rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  async collectLfsOids(snapshotIds) {
    const result = new Set();
    for (const snapshotId of snapshotIds) {
      try {
        const manifest = await this.readManifest(snapshotId);
        for (const object of manifest.lfs?.objects ?? []) if (/^[0-9a-f]{64}$/.test(object.oidSha256)) result.add(object.oidSha256);
      } catch (error) { this.logger?.warn('Failed to read snapshot while collecting LFS references.', { snapshotId, error }); }
    }
    return result;
  }

  async listSnapshotIds() {
    const result = [];
    const root = path.join(this.root, 'sha256');
    for (const prefix of await safeReadDir(root)) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      for (const entry of await safeReadDir(path.join(root, prefix.name))) if (entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name)) result.push(entry.name);
    }
    return result;
  }

  async gc({ protectedSnapshotIds = new Set(), retentionDays = 60, now = Date.now() } = {}) {
    let deletedCount = 0;
    for (const snapshotId of await this.listSnapshotIds()) {
      if (protectedSnapshotIds.has(snapshotId)) continue;
      const directory = this.snapshotDirectory(snapshotId);
      const info = await lstat(directory);
      if (now - info.mtimeMs < retentionDays * DAY_MS) continue;
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
      deletedCount += 1;
    }
    return { deletedCount };
  }
}

async function describeTree(root, { excludeGit }) {
  const entries = [];
  await walk(root, '');
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  async function walk(directory, relativeDirectory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (excludeGit && entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name);
      const info = await lstat(absolute);
      if (info.isDirectory()) { await walk(absolute, relative); continue; }
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        validateSymlink(root, absolute, target);
        entries.push({ path: relative, type: 'symlink', mode: info.mode & 0o777, target });
        continue;
      }
      if (!info.isFile()) throw snapshotError('SOURCE_SPECIAL_FILE_NOT_ALLOWED', 'Source Snapshotにregular file以外を含めることはできません。', { path: relative });
      entries.push({ path: relative, type: 'file', mode: info.mode & 0o555, sizeBytes: info.size, sha256: await hashFile(absolute) });
    }
  }
}

async function copyTree(sourceRoot, destinationRoot, { excludeGit, writable }) {
  await mkdir(destinationRoot, { recursive: true, mode: writable ? 0o755 : 0o700 });
  await copyDirectory(sourceRoot, destinationRoot);
  async function copyDirectory(source, destination) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (excludeGit && entry.name === '.git') continue;
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      const info = await lstat(from);
      if (info.isDirectory()) { await mkdir(to, { mode: writable ? (info.mode | 0o700) & 0o777 : 0o700 }); await copyDirectory(from, to); continue; }
      if (info.isSymbolicLink()) { const target = await readlink(from); validateSymlink(sourceRoot, from, target); await symlink(target, to); continue; }
      if (!info.isFile()) throw snapshotError('SOURCE_SPECIAL_FILE_NOT_ALLOWED', '特殊fileはcopyできません。');
      await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
      await chmod(to, writable ? (info.mode | 0o600) & 0o777 : info.mode & 0o555);
    }
  }
}

function validateSymlink(root, linkPath, target) {
  if (path.isAbsolute(target)) throw snapshotError('SOURCE_SYMLINK_ESCAPE', 'absolute symlinkは許可されません。', { linkPath, target });
  const resolved = path.resolve(path.dirname(linkPath), target);
  if (!isPathInsideOrEqual(root, resolved)) throw snapshotError('SOURCE_SYMLINK_ESCAPE', 'Source root外を指すsymlinkは許可されません。', { linkPath, target });
}
async function makeReadOnly(root) { for (const entry of await safeReadDir(root)) { const full = path.join(root, entry.name); const info = await lstat(full); if (info.isDirectory()) { await makeReadOnly(full); await chmod(full, 0o555); } else if (info.isFile()) await chmod(full, info.mode & 0o555); } await chmod(root, 0o555); }
async function makeWritable(root) { try { const info = await lstat(root); if (info.isDirectory()) { await chmod(root, info.mode | 0o700); for (const entry of await safeReadDir(root)) await makeWritable(path.join(root, entry.name)); } else if (info.isFile()) await chmod(root, info.mode | 0o600); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
async function fsyncTree(root) { for (const entry of await safeReadDir(root)) { const full = path.join(root, entry.name); const info = await lstat(full); if (info.isDirectory()) await fsyncTree(full); else if (info.isFile()) { const handle = await open(full, 'r'); try { await handle.sync(); } finally { await handle.close(); } } } await fsyncDirectory(root); }
async function fsyncDirectory(directory) { try { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error; } }
async function hashFile(filePath) { const handle = await open(filePath, 'r'); const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); try { while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } } finally { await handle.close(); } return hash.digest('hex'); }
async function safeReadDir(directory) { try { return await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; } }
async function tryReadManifest(filePath) { try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function pathExists(target) { try { await lstat(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
function normalizeLfs(objects) { return [...objects].map((item) => ({ path: item.path, oidSha256: item.oidSha256, sizeBytes: item.sizeBytes })).sort((a, b) => a.path.localeCompare(b.path, 'en')); }
function stripGeneratedFields(manifest) { const { snapshotId: _id, createdAt: _created, ...identity } = manifest; return identity; }
function assertSnapshotId(id) { if (!/^[0-9a-f]{64}$/.test(id)) throw snapshotError('SOURCE_SNAPSHOT_ID_INVALID', 'snapshotIdが不正です。'); }
function snapshotError(code, message, details = null) { return new CiError({ code, category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details }); }
