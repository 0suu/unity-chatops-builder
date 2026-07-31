const ALLOWED_KEYS = new Set(['branch', 'profile']);

export function parseBuildRequest(text) {
  if (typeof text !== 'string') return { recognized: false };
  if (text.length > 4096) {
    return {
      recognized: text.trimStart().startsWith('unity-build'),
      errors: ['Request is too long (maximum 4096 characters).'],
    };
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();

  if (lines.length === 0 || lines[0].trim() !== 'unity-build') {
    return { recognized: false };
  }

  const values = new Map();
  const errors = [];

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator <= 0) {
      errors.push(`Invalid line: ${line}`);
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`Unknown key: ${key}`);
      continue;
    }
    if (values.has(key)) {
      errors.push(`Duplicate key: ${key}`);
      continue;
    }
    if (value === '') {
      errors.push(`Value is empty: ${key}`);
      continue;
    }

    values.set(key, value);
  }

  for (const required of ALLOWED_KEYS) {
    if (!values.has(required)) errors.push(`Missing key: ${required}`);
  }

  if (errors.length > 0) return { recognized: true, errors };

  return {
    recognized: true,
    value: {
      branch: values.get('branch'),
      profile: values.get('profile'),
    },
  };
}
