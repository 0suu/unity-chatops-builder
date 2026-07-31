import { readFile } from 'node:fs/promises';

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

export function codeBlock(text, maxCharacters = 20_000) {
  const safe = String(text ?? '').replace(/```/g, '``\u200b`');
  const trimmed = safe.length <= maxCharacters ? safe : safe.slice(safe.length - maxCharacters);
  return `\`\`\`text\n${trimmed}\n\`\`\``;
}

export async function tailFile(filePath, { maxBytes = 20_000, maxLines = 100 } = {}) {
  try {
    const content = await readFile(filePath, 'utf8');
    const byteTrimmed = Buffer.byteLength(content, 'utf8') <= maxBytes
      ? content
      : Buffer.from(content, 'utf8').subarray(-maxBytes).toString('utf8');
    return byteTrimmed.split(/\r?\n/).slice(-maxLines).join('\n').trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : 'unknown';
}
