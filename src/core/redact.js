const BUILTIN_PATTERNS = [
  [/xox(?:a|b|p|r|s)-[A-Za-z0-9-]+/g, '[REDACTED_SLACK_TOKEN]'],
  [/xapp-[A-Za-z0-9-]+/g, '[REDACTED_SLACK_APP_TOKEN]'],
  [/(authorization\s*:\s*(?:bearer|bot)\s+)[^\s]+/gi, '$1[REDACTED]'],
  [/((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]'],
];

export class SecretRedactor {
  #secrets = new Set();

  add(secret, { allowShort = false } = {}) {
    if (typeof secret === 'string' && (allowShort ? secret.length > 0 : secret.length >= 8)) this.#secrets.add(secret);
  }

  redact(value) {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) text = String(value);

    for (const secret of this.#secrets) {
      text = text.split(secret).join('[REDACTED]');
    }
    for (const [pattern, replacement] of BUILTIN_PATTERNS) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }
}
