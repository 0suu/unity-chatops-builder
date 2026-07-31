import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';

export const LFS_POINTER_VERSION = 'https://git-lfs.github.com/spec/v1';
export const MAX_LFS_POINTER_BYTES = 1024;

export function parseLfsPointer(input, { path = null } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  if (buffer.length === 0 || buffer.length > MAX_LFS_POINTER_BYTES || buffer.includes(0)) {
    throw pointerError(path, 'Git LFS pointerの長さまたはエンコーディングが不正です。');
  }
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD') || text.startsWith('\uFEFF')) throw pointerError(path, 'Git LFS pointerはBOMなしUTF-8である必要があります。');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3 || lines[0] !== `version ${LFS_POINTER_VERSION}`) throw pointerError(path, 'Git LFS pointerのversion行が不正です。');

  const values = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(' ');
    if (separator <= 0 || separator === line.length - 1) throw pointerError(path, 'Git LFS pointerに不正な行があります。');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^(?:ext-[A-Za-z0-9.-]+|oid|size)$/.test(key) || values.has(key)) throw pointerError(path, 'Git LFS pointerに未知または重複したキーがあります。');
    values.set(key, value);
  }

  const oid = values.get('oid');
  const sizeText = values.get('size');
  if (!oid || !sizeText || !/^sha256:[0-9a-f]{64}$/.test(oid) || !/^(?:0|[1-9][0-9]*)$/.test(sizeText)) {
    throw pointerError(path, 'Git LFS pointerのoidまたはsizeが不正です。');
  }
  const sizeBytes = Number(sizeText);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw pointerError(path, 'Git LFS pointerのsizeが安全な整数範囲外です。');
  return { version: LFS_POINTER_VERSION, oidSha256: oid.slice(7), sizeBytes };
}

function pointerError(path, message) {
  return new CiError({ code: 'LFS_POINTER_INVALID', category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details: path ? { path } : null });
}
