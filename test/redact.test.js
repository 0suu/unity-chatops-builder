import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretRedactor } from '../src/core/redact.js';

test('can explicitly redact a short signing secret without changing the default threshold', () => {
  const redactor = new SecretRedactor();
  redactor.add('common');
  assert.equal(redactor.redact('common text'), 'common text');
  redactor.add('secret', { allowShort: true });
  assert.equal(redactor.redact('the secret value'), 'the [REDACTED] value');
});
