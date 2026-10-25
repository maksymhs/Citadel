/** Regression coverage for credential formats that can reach Work and Learning. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scrub } = require('../server/security/redact');

test('redacts complete JSON, quoted and authorization credentials', () => {
  for (const value of [
    '{"token":"demo-token-value"}',
    'password="demo secret phrase"',
    "passwd='demo secret phrase'",
    'Authorization: Basic ZGVtbzpwYXNz',
    'Authorization: Bearer demo-token-value',
    '{"api_key": "demo-token-value"}',
    'https://demo:demo-pass@example.test/repository',
    '-----BEGIN PRIVATE KEY-----\ndemo key material\n-----END PRIVATE KEY-----',
    'password="escaped \\" quote secret"',
  ]) {
    const result = scrub(value);
    assert.match(result, /\[REDACTED\]/);
    assert.doesNotMatch(result, /demo|phrase|ZGVtbz|quote secret/);
  }
  assert.equal(JSON.parse(scrub('{"token":"demo-token-value"}')).token, '[REDACTED]');
  assert.match(scrub('Authorization: Basic ZGVtbzpwYXNz'), /Basic \[REDACTED\]/);
  assert.equal(scrub('Review the token handling and document the API'), 'Review the token handling and document the API');
});
