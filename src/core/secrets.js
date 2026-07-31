import { readFile, stat } from 'node:fs/promises';

export async function resolveSecret(reference, { redactor, logger, label }) {
  if (!reference || typeof reference !== 'object') {
    throw new Error(`${label} secret reference is missing.`);
  }

  let value;
  if (typeof reference.env === 'string') {
    value = process.env[reference.env];
    delete process.env[reference.env];
    if (!value) throw new Error(`${label} environment variable ${reference.env} is empty.`);
  } else if (typeof reference.file === 'string') {
    const fileStat = await stat(reference.file);
    if (!fileStat.isFile()) throw new Error(`${label} secret path is not a file.`);
    if ((fileStat.mode & 0o077) !== 0) {
      logger?.warn('Secret file is readable by group or others.', { label, path: reference.file, mode: fileStat.mode.toString(8) });
    }
    value = (await readFile(reference.file, 'utf8')).trim();
    if (!value) throw new Error(`${label} secret file is empty.`);
  } else {
    throw new Error(`${label} must specify exactly one of env or file.`);
  }

  redactor?.add(value);
  return value;
}
