import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { ContentLock } from './content-lock.js';

const DAY_MS = 86_400_000;

export class LfsObjectCache {
  constructor({ root, maxObjectBytes, maxTotalBytesPerJob, maxCacheBytes, retentionDays, logger, now = () => Date.now() }) {
    this.root = root;
    this.objectRoot = path.join(root, 'sha256');
    this.tmpRoot = path.join(root, 'tmp');
    this.lockRoot = path.join(root, 'locks');
    this.protectionRoot = path.join(root, 'protections');
    this.corruptRoot = path.join(root, 'corrupt');
    this.maxObjectBytes = maxObjectBytes;
    this.maxTotalBytesPerJob = maxTotalBytesPerJob;
    this.maxCacheBytes = maxCacheBytes;
    this.retentionDays = retentionDays;
    this.logger = logger;
    this.now = now;
  }

  async acquireProtection(pointers) {
    const uniqueOids = [...new Set(pointers.map((pointer) => pointer.oidSha256))];
    for (const oid of uniqueOids) assertOid(oid);
    await mkdir(this.protectionRoot, { recursive: true });
    const protectionPath = path.join(this.protectionRoot, `${randomUUID()}.json`);
    await durableJson(protectionPath, { pid: process.pid, createdAt: new Date(this.now()).toISOString(), oids: uniqueOids });
    let released = false;
    return {
      oids: new Set(uniqueOids),
      async release() {
        if (released) return;
        released = true;
        await rm(protectionPath, { force: true });
      },
    };
  }

  async prepare({ pointers, lfsClient, remoteUrl, endpointUrl, signal, protectionLease = null }) {
    const unique = validateLimits(pointers, this.maxObjectBytes, this.maxTotalBytesPerJob);
    await Promise.all([this.objectRoot, this.tmpRoot, this.lockRoot, this.protectionRoot].map((dir) => mkdir(dir, { recursive: true })));
    const lease = protectionLease ?? await this.acquireProtection(unique);
    for (const pointer of unique) {
      if (!lease.oids?.has(pointer.oidSha256)) throw new TypeError('The protection lease does not cover every requested LFS object.');
    }
    try {
      const ready = new Map();
      const missing = [];
      for (const pointer of unique) {
        const cached = await this.#getVerified(pointer);
        if (cached) ready.set(pointer.oidSha256, cached); else missing.push(pointer);
      }
      const plan = missing.length ? await lfsClient.createDownloadPlan({ remoteUrl, endpointUrl, objects: missing, signal }) : new Map();
      for (const pointer of missing) {
        const objectPath = await this.#ensure(pointer, async (temporaryPath) => {
          const action = plan.get(pointer.oidSha256);
          if (!action) throw lfsError('LFS_OBJECT_NOT_FOUND', 'LFS download planにobjectがありません。', pointer);
          await lfsClient.downloadPlannedObject({ action, destinationPath: temporaryPath, expectedSizeBytes: pointer.sizeBytes, signal });
        }, signal);
        ready.set(pointer.oidSha256, objectPath);
      }
      return ready;
    } finally {
      if (!protectionLease) await lease.release();
    }
  }

  async materialize({ cachePath, destinationPath, mode = 0o644, expectedOidSha256, expectedSizeBytes }) {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const temp = `${destinationPath}.lfs-${randomUUID()}`;
    try {
      await copyFile(cachePath, temp, fsConstants.COPYFILE_FICLONE);
      await chmod(temp, mode & 0o777);
      const info = await lstat(temp);
      if (!info.isFile() || info.size !== expectedSizeBytes) throw lfsError('LFS_OBJECT_SIZE_MISMATCH', 'materializeしたLFS fileのsizeが不正です。', { destinationPath });
      const digest = await hashFile(temp);
      if (digest !== expectedOidSha256) throw lfsError('LFS_OBJECT_HASH_MISMATCH', 'materializeしたLFS fileのhashが不正です。', { destinationPath });
      await rename(temp, destinationPath);
    } finally { await rm(temp, { force: true }); }
  }

  objectPath(oid) {
    assertOid(oid);
    return path.join(this.objectRoot, oid.slice(0, 2), oid);
  }

  async gc({ protectedOids = new Set(), now = this.now() } = {}) {
    const protectedSet = new Set(protectedOids);
    for (const oid of await this.#activeProtectionOids()) protectedSet.add(oid);
    for (const entry of await safeReadDir(this.lockRoot)) if (entry.isFile() && /^[0-9a-f]{64}\.lock$/.test(entry.name)) protectedSet.add(entry.name.slice(0, 64));
    const objects = await this.#listObjects();
    const beforeBytes = objects.reduce((sum, item) => sum + item.size, 0);
    let remaining = beforeBytes;
    const cutoff = now - this.retentionDays * DAY_MS;
    let deletedCount = 0;
    let deletedBytes = 0;
    for (const object of objects.filter((item) => !protectedSet.has(item.oidSha256)).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (object.mtimeMs >= cutoff && remaining <= this.maxCacheBytes) continue;
      await rm(object.path, { force: true });
      remaining -= object.size;
      deletedCount += 1;
      deletedBytes += object.size;
    }
    const auxiliaryDeleted = await this.#cleanupAuxiliaryFiles(now);
    return { beforeBytes, afterBytes: remaining, deletedCount, deletedBytes, auxiliaryDeleted };
  }

  async #ensure(pointer, downloader, signal) {
    const lock = new ContentLock(path.join(this.lockRoot, `${pointer.oidSha256}.lock`), { signal });
    await lock.acquire();
    try {
      const hit = await this.#getVerified(pointer);
      if (hit) return hit;
      const finalPath = this.objectPath(pointer.oidSha256);
      await mkdir(path.dirname(finalPath), { recursive: true });
      const temp = path.join(this.tmpRoot, `${pointer.oidSha256}.${randomUUID()}.part`);
      try {
        await downloader(temp);
        const info = await lstat(temp);
        if (!info.isFile() || info.size !== pointer.sizeBytes) throw lfsError('LFS_OBJECT_SIZE_MISMATCH', '取得したLFS objectのsizeがpointerと一致しません。', { oidSha256: pointer.oidSha256, expectedSizeBytes: pointer.sizeBytes, actualSizeBytes: info.size });
        const digest = await hashFile(temp);
        if (digest !== pointer.oidSha256) throw lfsError('LFS_OBJECT_HASH_MISMATCH', '取得したLFS objectのSHA-256がpointerと一致しません。', { oidSha256: pointer.oidSha256, actualSha256: digest });
        const handle = await open(temp, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        await chmod(temp, 0o444);
        try {
          await access(finalPath);
          const existing = await this.#getVerified(pointer);
          if (existing) return existing;
          await this.#quarantine(finalPath, pointer.oidSha256);
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await rename(temp, finalPath);
        await fsyncDirectory(path.dirname(finalPath));
        return finalPath;
      } finally { await rm(temp, { force: true }); }
    } finally { await lock.release(); }
  }

  async #getVerified(pointer) {
    const objectPath = this.objectPath(pointer.oidSha256);
    let info;
    try { info = await lstat(objectPath); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== pointer.sizeBytes || await hashFile(objectPath) !== pointer.oidSha256) {
      await this.#quarantine(objectPath, pointer.oidSha256);
      return null;
    }
    const now = new Date(this.now());
    await utimes(objectPath, now, now).catch(() => {});
    return objectPath;
  }

  async #quarantine(filePath, oid) {
    try { await mkdir(this.corruptRoot, { recursive: true }); await rename(filePath, path.join(this.corruptRoot, `${oid}.${this.now()}.${randomUUID()}`)); }
    catch (error) { if (error?.code !== 'ENOENT') { this.logger?.warn('Failed to quarantine corrupt LFS object.', { oid, error }); await rm(filePath, { force: true }); } }
  }

  async #activeProtectionOids() {
    const result = new Set();
    for (const entry of await safeReadDir(this.protectionRoot)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.protectionRoot, entry.name);
      try {
        const state = JSON.parse(await readFile(file, 'utf8'));
        if (!Number.isFinite(Date.parse(state.createdAt)) || this.now() - Date.parse(state.createdAt) > DAY_MS) { await rm(file, { force: true }); continue; }
        for (const oid of state.oids ?? []) if (/^[0-9a-f]{64}$/.test(oid)) result.add(oid);
      } catch { await rm(file, { force: true }); }
    }
    return result;
  }

  async #listObjects() {
    const result = [];
    for (const prefix of await safeReadDir(this.objectRoot)) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      for (const entry of await safeReadDir(path.join(this.objectRoot, prefix.name))) {
        if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
        const filePath = path.join(this.objectRoot, prefix.name, entry.name);
        const info = await lstat(filePath);
        if (info.isFile() && !info.isSymbolicLink()) result.push({ oidSha256: entry.name, path: filePath, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    return result;
  }

  async #cleanupAuxiliaryFiles(now) {
    const tmpCutoff = now - DAY_MS;
    const corruptCutoff = now - this.retentionDays * DAY_MS;
    const deleted = { tmp: 0, corrupt: 0 };
    for (const [name, root, cutoff] of [['tmp', this.tmpRoot, tmpCutoff], ['corrupt', this.corruptRoot, corruptCutoff]]) {
      for (const entry of await safeReadDir(root)) {
        if (!entry.isFile()) continue;
        const filePath = path.join(root, entry.name);
        let info;
        try { info = await lstat(filePath); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
        if (info.mtimeMs >= cutoff) continue;
        await rm(filePath, { force: true }); deleted[name] += 1;
      }
    }
    return deleted;
  }
}

function validateLimits(pointers, maxObject, maxTotal) {
  let total = 0;
  const unique = new Map();
  for (const pointer of pointers) {
    if (pointer.sizeBytes > maxObject) throw lfsError('LFS_OBJECT_TOO_LARGE', 'Git LFS objectがRepository Policyの上限を超えています。', { path: pointer.path, sizeBytes: pointer.sizeBytes, maxObjectBytes: maxObject });
    total += pointer.sizeBytes;
    if (!Number.isSafeInteger(total) || total > maxTotal) throw lfsError('LFS_TOTAL_SIZE_LIMIT_EXCEEDED', 'ジョブのGit LFS総容量がRepository Policyの上限を超えています。', { totalSizeBytes: total, maxTotalBytesPerJob: maxTotal });
    const prior = unique.get(pointer.oidSha256);
    if (prior && prior.sizeBytes !== pointer.sizeBytes) throw lfsError('LFS_POINTER_INVALID', '同じOIDに異なるsizeが指定されています。', { oidSha256: pointer.oidSha256 });
    unique.set(pointer.oidSha256, pointer);
  }
  return [...unique.values()];
}
async function hashFile(filePath) {
  const handle = await open(filePath, 'r'); const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } }
  finally { await handle.close(); }
  return hash.digest('hex');
}
async function durableJson(filePath, value) { await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(filePath, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); const handle = await open(filePath, 'r'); try { await handle.sync(); } finally { await handle.close(); } await fsyncDirectory(path.dirname(filePath)); }
async function fsyncDirectory(directory) { try { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error; } }
async function safeReadDir(directory) { try { return await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; } }
function assertOid(oid) { if (!/^[0-9a-f]{64}$/.test(oid)) throw new TypeError('Invalid SHA-256 OID.'); }
function lfsError(code, message, details = null) { return new CiError({ code, category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details }); }
