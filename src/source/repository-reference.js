const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function normalizeRepositoryReference(input, {
  defaultHost = 'github.com',
  allowedHosts = ['github.com'],
} = {}) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, reason: 'Repository is empty.' };
  }
  if (input.length > 512 || /[\0\r\n]/.test(input)) {
    return { ok: false, reason: 'Repository contains invalid characters or is too long.' };
  }

  const allowed = new Set(allowedHosts.map((host) => String(host).toLowerCase()));
  const fallbackHost = String(defaultHost).toLowerCase();
  if (!allowed.has(fallbackHost)) {
    return { ok: false, reason: 'Default repository host is not allowlisted.' };
  }

  let host;
  let repositoryPath;
  const value = input.trim();

  if (/^[^/@:]+\/[^/]+$/.test(value)) {
    host = fallbackHost;
    repositoryPath = value;
  } else if (/^[^/:]+\/[^/]+\/[^/]+$/.test(value) && !value.includes('://')) {
    const [candidateHost, owner, repository] = value.split('/');
    host = candidateHost.toLowerCase();
    repositoryPath = `${owner}/${repository}`;
  } else {
    const scp = /^git@([^:]+):(.+)$/.exec(value);
    if (scp) {
      host = scp[1].toLowerCase();
      repositoryPath = scp[2];
    } else {
      let url;
      try {
        url = new URL(value);
      } catch {
        return { ok: false, reason: 'Repository must be owner/name or a supported GitHub URL.' };
      }
      host = url.hostname.toLowerCase();
      if (url.protocol === 'ssh:') {
        if (url.username !== 'git' || url.password || (url.port && url.port !== '22') || url.search || url.hash) {
          return { ok: false, reason: 'SSH repository URL must use git user, port 22, and no credentials/query/fragment.' };
        }
      } else if (url.protocol === 'https:') {
        if (url.username || url.password || (url.port && url.port !== '443') || url.search || url.hash) {
          return { ok: false, reason: 'HTTPS repository URL must not contain credentials/query/fragment.' };
        }
      } else {
        return { ok: false, reason: 'Repository URL must use SSH or HTTPS.' };
      }
      repositoryPath = url.pathname.replace(/^\/+/, '');
    }
  }

  if (!allowed.has(host)) {
    return { ok: false, reason: `Repository host ${host} is not allowlisted.` };
  }

  const normalizedPath = repositoryPath.replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = normalizedPath.split('/');
  if (segments.length !== 2) {
    return { ok: false, reason: 'Repository must identify exactly one owner and repository.' };
  }
  const [owner, repository] = segments;
  if (!OWNER_PATTERN.test(owner)) {
    return { ok: false, reason: 'Repository owner is invalid.' };
  }
  if (!REPOSITORY_PATTERN.test(repository) || repository === '.' || repository === '..') {
    return { ok: false, reason: 'Repository name is invalid.' };
  }

  const canonicalOwner = owner.toLowerCase();
  const canonicalRepository = repository.toLowerCase();
  const id = `${host}/${canonicalOwner}/${canonicalRepository}`;
  return {
    ok: true,
    value: {
      id,
      host,
      owner: canonicalOwner,
      name: canonicalRepository,
      displayName: host === fallbackHost
        ? `${canonicalOwner}/${canonicalRepository}`
        : id,
      sshUrl: `git@${host}:${canonicalOwner}/${canonicalRepository}.git`,
    },
  };
}
