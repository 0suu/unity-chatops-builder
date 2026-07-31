import path from 'node:path';

export function validateBuildProfilePath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'Build Profile path is empty.' };
  }
  if (input.includes('\\') || input.includes('\0')) {
    return { ok: false, reason: 'Build Profile path must use forward slashes.' };
  }
  if (path.posix.isAbsolute(input)) {
    return { ok: false, reason: 'Build Profile path must be relative.' };
  }

  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: false, reason: 'Build Profile path contains an invalid segment.' };
  }
  if (segments[0] !== 'Assets') {
    return { ok: false, reason: 'Build Profile must be under Assets/.' };
  }
  if (!input.endsWith('.asset')) {
    return { ok: false, reason: 'Build Profile must end with .asset.' };
  }

  const normalized = path.posix.normalize(input);
  if (normalized !== input) {
    return { ok: false, reason: 'Build Profile path is not normalized.' };
  }

  return { ok: true, value: normalized };
}

export function validateUnityProjectPath(input) {
  const value = input === undefined || input === null || input === '' ? '.' : input;
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'Unity project path is empty.' };
  }
  if (value === '.') return { ok: true, value };
  if (value.includes('\\') || value.includes('\0')) {
    return { ok: false, reason: 'Unity project path must use forward slashes.' };
  }
  if (path.posix.isAbsolute(value)) {
    return { ok: false, reason: 'Unity project path must be relative.' };
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: false, reason: 'Unity project path contains an invalid segment.' };
  }

  const normalized = path.posix.normalize(value);
  if (normalized !== value) {
    return { ok: false, reason: 'Unity project path is not normalized.' };
  }

  return { ok: true, value: normalized };
}

export function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function isPathInsideOrEqual(parentPath, candidatePath) {
  return path.resolve(parentPath) === path.resolve(candidatePath) || isPathInside(parentPath, candidatePath);
}

export function safeSlug(input, maxLength = 64) {
  const slug = String(input)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return (slug || 'build').slice(0, maxLength);
}
