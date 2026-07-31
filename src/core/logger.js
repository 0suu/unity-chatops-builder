const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

export function createLogger({ level = 'info', redactor } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(logLevel, message, fields = undefined) {
    if ((LEVELS[logLevel] ?? 100) < threshold) return;

    const record = {
      time: new Date().toISOString(),
      level: logLevel,
      message,
    };

    if (fields !== undefined) {
      record.fields = sanitize(fields, redactor);
    }

    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

function sanitize(value, redactor) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactor?.redact(value.message) ?? value.message,
      stack: redactor?.redact(value.stack ?? '') ?? value.stack,
      code: value.code,
    };
  }

  if (Array.isArray(value)) return value.map((item) => sanitize(item, redactor));

  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = sanitize(item, redactor);
    }
    return result;
  }

  if (typeof value === 'string') return redactor?.redact(value) ?? value;
  return value;
}
