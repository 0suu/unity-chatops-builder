import { open, rm, stat } from 'node:fs/promises';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';

const MEDIA_TYPE = 'application/vnd.git-lfs+json';

export class GitLfsClient {
  constructor({ endpointPolicy, authProvider, fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000, maxRedirects = 5 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
    this.endpointPolicy = endpointPolicy;
    this.authProvider = authProvider;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRedirects = maxRedirects;
  }

  async createDownloadPlan({ remoteUrl, endpointUrl, objects, signal }) {
    const unique = dedupe(objects);
    const auth = this.authProvider ? await this.authProvider.resolve({ remoteUrl, endpointUrl }) : { endpointUrl, headers: {} };
    const endpoint = await this.endpointPolicy.assertAllowedUrl(auth.endpointUrl ?? endpointUrl, { purpose: 'LFS batch endpoint', allowQuery: false });
    const batchUrl = new URL(endpoint.href);
    batchUrl.pathname = batchUrl.pathname.replace(/\/+$/, '');
    if (!batchUrl.pathname.endsWith('/objects/batch')) batchUrl.pathname += '/objects/batch';
    const plan = new Map();

    for (let offset = 0; offset < unique.length; offset += 100) {
      const chunk = unique.slice(offset, offset + 100);
      const response = await this.#request(batchUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { Accept: MEDIA_TYPE, 'Content-Type': MEDIA_TYPE, ...auth.headers },
        body: JSON.stringify({ operation: 'download', transfers: ['basic'], hash_algo: 'sha256', objects: chunk.map((item) => ({ oid: item.oidSha256, size: item.sizeBytes })) }),
        signal,
      });
      if ([401, 403].includes(response.status)) throw lfsError('LFS_AUTHENTICATION_FAILED', 'Git LFS Batch APIの認証に失敗しました。', { status: response.status });
      if (!response.ok) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS Batch APIからobject情報を取得できませんでした。', { status: response.status });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS Batch API応答が大きすぎます。');
      let payload;
      try { payload = JSON.parse(text); } catch { throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS Batch API応答がJSONではありません。'); }
      if (!Array.isArray(payload.objects)) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS Batch API応答形式が不正です。');
      for (const object of payload.objects) {
        const requested = chunk.find((item) => item.oidSha256 === object?.oid);
        if (!requested) continue;
        if (object.error) {
          const status = Number(object.error.code);
          throw lfsError([401, 403].includes(status) ? 'LFS_AUTHENTICATION_FAILED' : 'LFS_OBJECT_NOT_FOUND', object.error.message || 'Git LFS objectを取得できません。', { oidSha256: object.oid, status });
        }
        const action = object.actions?.download;
        if (!action?.href) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS objectにdownload actionがありません。', { oidSha256: object.oid });
        plan.set(object.oid, {
          href: await this.endpointPolicy.assertAllowedUrl(action.href, { purpose: 'LFS object URL', allowQuery: true }),
          headers: validateHeaders(action.header ?? {}),
          expiresAt: action.expires_at ?? null,
        });
      }
      for (const object of chunk) if (!plan.has(object.oidSha256)) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS Batch API応答に要求objectがありません。', { oidSha256: object.oidSha256 });
    }
    return plan;
  }

  async downloadPlannedObject({ action, destinationPath, expectedSizeBytes, signal }) {
    let url = action.href instanceof URL ? new URL(action.href.href) : new URL(action.href);
    let headers = { ...action.headers };
    try {
      for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
        const response = await this.#request(url, { method: 'GET', redirect: 'manual', headers, signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || redirects === this.maxRedirects) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS objectのredirectが不正または上限超過です。');
          const next = await this.endpointPolicy.validateRedirect(url, location);
          if (next.origin !== url.origin) headers = stripSensitiveHeaders(headers);
          url = next;
          continue;
        }
        if ([401, 403].includes(response.status)) throw lfsError('LFS_AUTHENTICATION_FAILED', 'Git LFS objectのdownload認証に失敗しました。', { status: response.status });
        if ([404, 410].includes(response.status)) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS objectが見つかりません。', { status: response.status });
        if (!response.ok || !response.body) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS objectのdownloadに失敗しました。', { status: response.status });
        const contentLength = parseLength(response.headers.get('content-length'));
        if (contentLength !== null && contentLength !== expectedSizeBytes) throw lfsError('LFS_OBJECT_SIZE_MISMATCH', 'Git LFS objectのContent-Lengthがpointerと一致しません。', { expectedSizeBytes, actualSizeBytes: contentLength });
        await writeBody(response.body, destinationPath, expectedSizeBytes);
        const info = await stat(destinationPath);
        if (info.size !== expectedSizeBytes) throw lfsError('LFS_OBJECT_SIZE_MISMATCH', 'Git LFS objectのdownloadサイズがpointerと一致しません。', { expectedSizeBytes, actualSizeBytes: info.size });
        return;
      }
    } catch (error) {
      await rm(destinationPath, { force: true });
      throw error;
    }
  }

  async #request(url, options) {
    const timeout = AbortSignal.timeout ? AbortSignal.timeout(this.timeoutMs) : null;
    const signal = options.signal && timeout && AbortSignal.any ? AbortSignal.any([options.signal, timeout]) : options.signal ?? timeout ?? undefined;
    try { return await this.fetchImpl(url, { ...options, signal }); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS network requestに失敗しました。', { cause: error instanceof Error ? error.message : String(error) });
    }
  }
}

function dedupe(objects) {
  const map = new Map();
  for (const object of objects) {
    const prior = map.get(object.oidSha256);
    if (prior && prior.sizeBytes !== object.sizeBytes) throw lfsError('LFS_POINTER_INVALID', '同じOIDに異なるsizeが指定されています。', { oidSha256: object.oidSha256 });
    map.set(object.oidSha256, object);
  }
  return [...map.values()];
}
async function writeBody(body, destinationPath, expectedSize) {
  const handle = await open(destinationPath, 'wx', 0o600);
  let written = 0;
  try {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      written += chunk.length;
      if (written > expectedSize) { await reader.cancel(); throw lfsError('LFS_OBJECT_SIZE_MISMATCH', 'Git LFS objectがpointerのsizeを超えました。', { expectedSizeBytes: expectedSize, actualSizeBytes: written }); }
      await handle.write(chunk);
    }
    await handle.sync();
  } finally { await handle.close(); }
}
function validateHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS action headerが不正です。');
  const result = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw lfsError('LFS_OBJECT_NOT_FOUND', 'Git LFS action headerに不正な値があります。');
    result[name] = value;
  }
  return result;
}
function stripSensitiveHeaders(headers) { return Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(?:authorization|cookie|proxy-authorization)$/i.test(name))); }
function parseLength(value) { if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null; const n = Number(value); return Number.isSafeInteger(n) ? n : null; }
function lfsError(code, message, details = null) { return new CiError({ code, category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details }); }
