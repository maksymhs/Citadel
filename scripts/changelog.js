#!/usr/bin/env node
/**
 * Regenerates CHANGELOG.md from git tags and Conventional Commit subjects.
 * Run it as part of a release, after the tag exists: `node scripts/changelog.js`.
 * Commits after the newest tag appear under "Unreleased".
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'https://github.com/maksymhs/Citadel';
const SECTIONS = [['feat', 'Added'], ['fix', 'Fixed'], ['perf', 'Improved'], ['refactor', 'Changed'], ['other', 'Other']];
const SKIPPED = /^(chore|docs|test|ci|build|style)(\(|:|!)/;

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const capitalize = (s) => s.trim().charAt(0).toUpperCase() + s.trim().slice(1);

function render(subjects) {
  const groups = {};
  for (const s of subjects) {
    if (SKIPPED.test(s)) continue;
    const m = s.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/);
    let type = 'other';
    let scope = '';
    let text = s;
    if (m) {
      type = SECTIONS.some(([k]) => k === m[1]) ? m[1] : 'other';
      scope = m[2] || '';
      text = m[3];
    }
    (groups[type] = groups[type] || []).push(`- ${scope ? `**${scope}**: ` : ''}${capitalize(text)}`);
  }
  let body = '';
  for (const [k, label] of SECTIONS) if (groups[k]) body += `\n### ${label}\n\n${groups[k].join('\n')}\n`;
  return body;
}

const tags = sh('git tag --sort=v:refname').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
const entries = [];
tags.forEach((tag, i) => {
  const range = i ? `${tags[i - 1]}..${tag}` : tag;
  const subjects = sh(`git log --no-merges --format=%s ${range}`).split('\n').filter(Boolean);
  const date = sh(`git log -1 --format=%cs ${tag}`);
  entries.push(`## [${tag.slice(1)}](${REPO}/releases/tag/${tag}) · ${date}\n${render(subjects) || '\n_Maintenance release._\n'}`);
});

const last = tags[tags.length - 1];
const pending = last ? sh(`git log --no-merges --format=%s ${last}..HEAD`).split('\n').filter(Boolean) : [];
const unreleased = render(pending);
if (unreleased) entries.push(`## Unreleased\n${unreleased}`);

const out = '# Changelog\n\nAll notable changes to Citadel, newest first. Generated from the commit history by `scripts/changelog.js`; each version links to its release on GitHub.\n\n'
  + entries.reverse().join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), out);
console.log(`CHANGELOG.md updated (${tags.length} releases${unreleased ? ', plus unreleased changes' : ''}).`);
