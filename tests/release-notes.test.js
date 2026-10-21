const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractSection, notesFor } = require('../scripts/release-notes');

const SAMPLE = `# Changelog

## [0.3.0](https://example.test/v0.3.0) · 2026-02-01

### Added

- **ui**: New thing

## [0.2.0](https://example.test/v0.2.0) · 2026-01-01

_Maintenance release._
`;

describe('release notes from the changelog', () => {
  test('returns only the requested version, without its heading', () => {
    assert.equal(extractSection(SAMPLE, 'v0.3.0'), '### Added\n\n- **ui**: New thing');
    assert.equal(extractSection(SAMPLE, '0.2.0'), '_Maintenance release._');
  });

  test('returns null for a version that is not in the changelog', () => {
    assert.equal(extractSection(SAMPLE, 'v9.9.9'), null);
  });

  test('adds a footer, and falls back to a pointer when the section is missing', () => {
    assert.match(notesFor(SAMPLE, 'v0.3.0'), /New thing[\s\S]*Full history: \[CHANGELOG\.md\]/);
    assert.match(notesFor(SAMPLE, 'v9.9.9'), /^See the \[changelog\]/);
  });
});
