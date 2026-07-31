import dns from 'node:dns/promises';
import net from 'node:net';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';

export class LfsEndpointPolicy {
  constructor({ allowedHosts, allowRepositoryLfsconfig = false, lookup = dns.lookup, resolveDns = true } = {}) {
    if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) throw new TypeError('allowedHosts must contain at least one host.');
    this.allowedHosts = [...new Set(allowedHosts.map(normalizeHostname))];
    this.allowRepositoryLfsconfig = Boolean(allowRepositoryLfsconfig);
    this.lookup = lookup;
    this.resolveDns = resolveDns;
  }

  async resolve({ trustedRemoteUrl, configuredEndpointUrl = null, lfsConfigContent = null }) {
    const repositoryUrls = parseLfsConfigUrls(lfsConfigContent);
    if (repositoryUrls.length > 0 && !this.allowRepositoryLfsconfig) {
      throw endpointError('Repository内の.lfsconfigによるLFS Endpoint変更は許可されていません。', { configuredKeys: repositoryUrls.map((item) => item.key) });
    }
    if (repositoryUrls.length > 1) throw endpointError('.lfsconfigに複数のLFS Endpointが設定されています。');
    const candidate = configuredEndpointUrl ?? repositoryUrls[0]?.url ?? deriveDefaultLfsEndpoint(trustedRemoteUrl);
    return this.assertAllowedUrl(candidate, { purpose: 'LFS endpoint', allowQuery: false });
  }

  async assertAllowedUrl(input, { purpose = 'LFS URL', allowQuery = true } = {}) {
    let url;
    try { url = input instanceof URL ? new URL(input.href) : new URL(input); } catch { throw endpointError(`${purpose}が有効なURLではありません。`); }
    if (url.protocol !== 'https:') throw endpointError(`${purpose}はHTTPSである必要があります。`, { protocol: url.protocol });
    if (url.username || url.password) throw endpointError(`${purpose}のURLにcredentialを含めることはできません。`);
    if (url.hash || (!allowQuery && url.search)) throw endpointError(`${purpose}のURLにquery credentialまたはfragmentを含めることはできません。`);
    if (url.port && url.port !== '443') throw endpointError(`${purpose}のportは443だけを許可します。`, { port: url.port });
    const hostname = normalizeHostname(url.hostname);
    if (isForbiddenHostname(hostname) || !this.allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
      throw endpointError(`${purpose}のhostはallowlistにありません。`, { hostname });
    }
    if (this.resolveDns && net.isIP(hostname) === 0) {
      let addresses;
      try { addresses = await this.lookup(hostname, { all: true, verbatim: true }); }
      catch (error) { throw endpointError(`${purpose}のDNS解決に失敗しました。`, { hostname, cause: error.message }); }
      if (!addresses?.length || addresses.some((entry) => isForbiddenAddress(entry.address))) {
        throw endpointError(`${purpose}がprivate、loopback、link-localアドレスへ解決されました。`, { hostname, addresses: addresses?.map((entry) => entry.address) ?? [] });
      }
    }
    url.hostname = hostname;
    return url;
  }

  validateRedirect(fromUrl, location) {
    return this.assertAllowedUrl(new URL(location, fromUrl), { purpose: 'LFS redirect URL', allowQuery: true });
  }
}

export function deriveDefaultLfsEndpoint(remoteUrl) {
  const remote = parseTrustedRemote(remoteUrl);
  if (!['ssh', 'https'].includes(remote.kind)) throw endpointError('信頼済みremoteからHTTPSのLFS Endpointを解決できません。');
  const repositoryPath = remote.repositoryPath.endsWith('.git') ? remote.repositoryPath : `${remote.repositoryPath}.git`;
  return `https://${remote.host}/${repositoryPath}/info/lfs`;
}

export function parseTrustedRemote(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') throw endpointError('信頼済みremote URLが空です。');
  const trimmed = remoteUrl.trim();
  const scp = /^(?:([^@/:]+)@)?([^/:]+):(.+)$/.exec(trimmed);
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return validateRemoteParts({ kind: 'ssh', user: scp[1] ?? 'git', host: scp[2], port: null, repositoryPath: scp[3] });
  }
  let url;
  try { url = new URL(trimmed); } catch { return { kind: 'local', path: trimmed }; }
  if (url.protocol === 'https:') {
    if (url.search || url.hash) throw endpointError('remote URLにqueryまたはfragmentを含めることはできません。');
    if (url.username || url.password) throw endpointError('remote URLにcredentialを含めることはできません。');
    return validateRemoteParts({ kind: 'https', user: null, host: url.hostname, port: url.port || null, repositoryPath: url.pathname.replace(/^\/+/, '') });
  }
  if (url.protocol === 'ssh:') {
    if (url.search || url.hash) throw endpointError('SSH remote URLにqueryまたはfragmentを含めることはできません。');
    if (url.password) throw endpointError('SSH remote URLにpasswordを含めることはできません。');
    return validateRemoteParts({ kind: 'ssh', user: url.username || 'git', host: url.hostname, port: url.port || null, repositoryPath: url.pathname.replace(/^\/+/, '') });
  }
  throw endpointError('remote URLはSSHまたはHTTPSである必要があります。', { protocol: url.protocol });
}

export function parseLfsConfigUrls(content) {
  if (content === null || content === undefined || content === '') return [];
  if (typeof content !== 'string' || content.includes('\0')) throw endpointError('.lfsconfigの形式が不正です。');
  let section = '';
  const endpoints = [];
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) { section = sectionMatch[1].trim().toLowerCase(); continue; }
    const assignment = /^([A-Za-z0-9.-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1].toLowerCase();
    const value = unquote(assignment[2].trim());
    if ((section === 'lfs' && (key === 'url' || key === 'pushurl')) || (section.startsWith('remote ') && (key === 'lfsurl' || key === 'lfspushurl'))) {
      endpoints.push({ key: `${section}.${key}`, url: value });
    }
  }
  return endpoints;
}

export function isForbiddenAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (family === 6) {
    const v = address.toLowerCase().split('%')[0];
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  return false;
}

function validateRemoteParts(parts) {
  const repositoryPath = parts.repositoryPath.replace(/^\/+/, '');
  if (!repositoryPath || repositoryPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) throw endpointError('remoteのrepository pathが不正です。');
  if (!/^[A-Za-z0-9._~/-]+$/.test(repositoryPath) || repositoryPath.startsWith('-')) throw endpointError('remoteのrepository pathに許可されていない文字があります。');
  return { ...parts, host: normalizeHostname(parts.host), repositoryPath };
}
function normalizeHostname(hostname) { return String(hostname).trim().toLowerCase().replace(/\.$/, ''); }
function isForbiddenHostname(hostname) { return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || isForbiddenAddress(hostname); }
function unquote(value) { if (value.startsWith('"') && value.endsWith('"')) { try { return JSON.parse(value); } catch { throw endpointError('.lfsconfigのquoted valueが不正です。'); } } return value; }
function endpointError(message, details = null) { return new CiError({ code: 'LFS_ENDPOINT_NOT_ALLOWED', category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details }); }
