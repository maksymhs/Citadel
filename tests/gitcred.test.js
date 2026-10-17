const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Point the app at an isolated data dir BEFORE loading config-dependent modules.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cred-'));
process.env.DATA_DIR = tmpDir;
process.env.DATABASE_PATH = path.join(tmpDir, 'citadel.db');

const { initDatabase, closeDatabase } = require('../server/database/db');
const gitCredentialsService = require('../server/services/gitCredentialsService');
const helper = require('../scripts/git-credential-citadel');

const scriptPath = path.resolve(__dirname, '../scripts/git-credential-citadel.js');

function runHelper(input, env = {}) {
  return spawnSync('node', [scriptPath, 'get'], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: tmpDir, DATABASE_PATH: path.join(tmpDir, 'citadel.db'), ...env },
  });
}

describe('Git credential helper', () => {
  after(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parseCredentialInput parses the git-credential protocol', () => {
    const fields = helper.parseCredentialInput('protocol=https\nhost=github.com\n\n');
    assert.equal(fields.protocol, 'https');
    assert.equal(fields.host, 'github.com');
  });

  test('resolveDataEnv derives absolute paths from DATA_DIR', () => {
    const out = helper.resolveDataEnv({
      DATA_DIR: '/srv/citadel/data',
      PROJECTS_DIR: './data/projects',
      LOGS_DIR: './data/logs',
    });
    assert.equal(out.DATABASE_PATH, '/srv/citadel/data/citadel.db');
    assert.equal(out.PROJECTS_DIR, '/srv/citadel/projects');
    assert.equal(out.LOGS_DIR, '/srv/citadel/logs');
  });

  test('returns stored credentials for a known host', () => {
    initDatabase();
    gitCredentialsService.saveCredential({ provider: 'github', token: 'ghp_helperTestToken123', username: 'octocat' });

    const res = runHelper('protocol=https\nhost=github.com\n');
    assert.equal(res.status, 0);
    assert.match(res.stdout, /username=x-access-token/);
    assert.match(res.stdout, /password=ghp_helperTestToken123/);
  });

  test('emits nothing for an unknown host', () => {
    const res = runHelper('protocol=https\nhost=example.com\n');
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });

  test('store/erase actions are no-ops', () => {
    const res = spawnSync('node', [scriptPath, 'store'], {
      input: 'protocol=https\nhost=github.com\nusername=x\npassword=y\n',
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: tmpDir, DATABASE_PATH: path.join(tmpDir, 'citadel.db') },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });
});
