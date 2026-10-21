#!/usr/bin/env node
/**
 * Prints the GitHub Release notes for a version: its section of CHANGELOG.md.
 * Used by .github/workflows/release.yml; run it by hand to preview what a tag
 * would publish: `node scripts/release-notes.js v0.42.2`.
 * Falls back to a one-line pointer to the changelog when the section is missing,
 * so a Release is still created.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_URL = 'https://github.com/maksymhs/Citadel';

/** Body of the `## [x.y.z]` section, without its heading, or null when absent. */
function extractSection(changelog, version) {
  const wanted = version.replace(/^v/, '');
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${wanted}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function notesFor(changelog, version) {
  const section = extractSection(changelog, version);
  const footer = `Full history: [CHANGELOG.md](${REPO_URL}/blob/main/CHANGELOG.md)`;
  if (!section) return `See the [changelog](${REPO_URL}/blob/main/CHANGELOG.md).`;
  return `${section}\n\n${footer}`;
}

if (require.main === module) {
  const version = process.argv[2];
  if (!/^v?\d+\.\d+\.\d+$/.test(version || '')) {
    console.error('Usage: node scripts/release-notes.js vX.Y.Z');
    process.exit(2);
  }
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  if (!extractSection(changelog, version)) console.error(`warning: no CHANGELOG.md section for ${version}; using a generic note`);
  process.stdout.write(`${notesFor(changelog, version)}\n`);
}

module.exports = { extractSection, notesFor };
