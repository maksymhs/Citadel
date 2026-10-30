/** Process-control tests use synthetic readers and replace native signaling before every test. */
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-process-control-'));
Object.assign(process.env, {
  DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'),
  PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'),
  CITADEL_SELF_UPDATE: '0', CITADEL_REQUIRE_SETUP_CODE: '0',
});
const Fastify = require('fastify');
const auth = require('../server/security/auth');
const { getDatabase, closeDatabase } = require('../server/database/db');
const nodeService = require('../server/services/nodeService');
const processControl = require('../server/services/processControlService');
const processRoutes = require('../server/routes/processControlRoutes');
const originalRead = nodeService.readProcessIdentity.bind(nodeService);
const originalContext = nodeService.getProcessControlContext.bind(nodeService);
const bootId = '11111111-2222-3333-4444-555555555555';
// Deliberately outside ordinary Linux PID ranges; every signal is mocked anyway.
const targetPid = 2147483000;
const identity = `linux:${bootId}:${targetPid}:123456789`;
let app, cookie, viewerCookie, signalMock;

function info(pid = targetPid, overrides = {}) {
  return { pid, ppid: 2, uid: 1000, uids: [1000, 1000, 1000, 1000], identity: `linux:${bootId}:${pid}:123456789`, ...overrides };
}

function terminate(payload = { identity, signal: 'TERM' }, pid = targetPid, session = cookie) {
  return app.inject({
    method: 'POST', url: `/api/system/processes/${encodeURIComponent(pid)}/terminate`,
    cookies: session ? { session_id: session } : {}, payload,
  });
}

function audits() {
  return getDatabase().prepare("SELECT * FROM audit_logs WHERE action = 'process_signal_sent'").all();
}

function procStat(pid, { ppid = 2, start = '123456789', name = 'worker (odd) name' } = {}) {
  const rest = Array(22).fill('0');
  rest[0] = 'S'; rest[1] = String(ppid); rest[11] = '10'; rest[12] = '5'; rest[19] = start;
  return `${pid} (${name}) ${rest.join(' ')}\n`;
}

before(async () => {
  auth.createInitialAdmin('processadmin', 'Process-password-123');
  cookie = auth.login('processadmin', 'Process-password-123').sessionId;
  getDatabase().prepare(`
    INSERT INTO users (id, username, password_hash, salt, role, created_at, updated_at)
    SELECT 'process-viewer', 'viewer', password_hash, salt, 'viewer', created_at, updated_at FROM users LIMIT 1
  `).run();
  viewerCookie = auth.login('viewer', 'Process-password-123').sessionId;
  // Minimal server exercises the real authentication/database without unrelated
  // startup jobs, external commands or any live service state.
  app = Fastify({ logger: false });
  await app.register(require('@fastify/cookie'));
  await app.register(processRoutes);
  await app.ready();
});
beforeEach((t) => {
  signalMock = t.mock.method(process, 'kill', () => true);
  t.mock.method(nodeService, 'getProcessControlContext', () => ({ uid: 1000, protectedPids: new Set([1, process.pid, process.ppid, 777777]) }));
  t.mock.method(nodeService, 'readProcessIdentity', (pid) => info(pid));
  getDatabase().prepare('DELETE FROM audit_logs').run();
});
after(async () => {
  await app.close();
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('termination requires authenticated administrators before any process inspection', async () => {
  assert.equal((await terminate(undefined, targetPid, null)).statusCode, 401);
  assert.equal((await terminate(undefined, targetPid, viewerCookie)).statusCode, 403);
  assert.equal(nodeService.readProcessIdentity.mock.calls.length, 0);
  assert.equal(nodeService.getProcessControlContext.mock.calls.length, 0);
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('invalid, grouped, fractional, unsafe, and ambiguous PIDs cannot reach signaling', async () => {
  for (const pid of ['0', '-1', '-123', '1.5', '1e3', '01', '+1', 'abc', '2147483648', '9007199254740993']) {
    assert.equal((await terminate({ identity, signal: 'TERM' }, pid)).statusCode, 400, pid);
  }
  for (const pid of [null, undefined, {}, [], true, NaN, Infinity]) {
    assert.throws(() => processControl.terminateProcess({ pid, identity, signal: 'TERM' }), { statusCode: 400 });
  }
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('a listing identity and an explicit TERM or KILL are mandatory', async () => {
  for (const payload of [
    {}, { identity }, { identity, signal: 'SIGTERM' }, { identity, signal: 'term' },
    { identity, signal: 'INT' }, { identity, signal: null }, { identity, signal: 9 },
    { signal: 'TERM' }, { identity: '', signal: 'TERM' }, { identity: '12345', signal: 'TERM' },
    { identity: {}, signal: 'TERM' }, { identity: 'x'.repeat(500), signal: 'KILL' },
  ]) assert.equal((await terminate(payload)).statusCode, 400, JSON.stringify(payload));
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('PID 1, Citadel itself, its parent and all discovered ancestors are protected', async () => {
  for (const pid of new Set([1, process.pid, process.ppid, 777777])) {
    if (pid < 1) continue;
    assert.equal((await terminate({ identity: info(pid).identity, signal: 'KILL' }, pid)).statusCode, 403);
  }
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('all real/effective/saved/filesystem UIDs must equal the service UID', async (t) => {
  for (let index = 0; index < 4; index++) {
    const uids = [1000, 1000, 1000, 1000];
    uids[index] = 0;
    t.mock.method(nodeService, 'readProcessIdentity', () => info(targetPid, { uids }));
    assert.equal((await terminate()).statusCode, 403, `UID index ${index}`);
  }
  t.mock.method(nodeService, 'readProcessIdentity', () => info(targetPid, { uids: null }));
  assert.equal((await terminate()).statusCode, 403);
  t.mock.method(nodeService, 'getProcessControlContext', () => ({ uid: 0, protectedPids: new Set([1]) }));
  t.mock.method(nodeService, 'readProcessIdentity', () => info());
  assert.equal((await terminate()).statusCode, 403, 'a root service must not signal another UID either');
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('stale or mismatched boot/PID/start identities cannot signal a reused PID', async (t) => {
  for (const supplied of [
    identity.replace(':123456789', ':999'), identity.replace(bootId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    info(targetPid - 1).identity,
  ]) assert.equal((await terminate({ identity: supplied, signal: 'TERM' })).statusCode, 409);
  let reads = 0;
  t.mock.method(nodeService, 'readProcessIdentity', () => info(targetPid, { identity: ++reads === 1 ? identity : `${identity}0` }));
  assert.equal((await terminate()).statusCode, 409, 'identity is checked again immediately before sending');
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('ownership changes during final inspection prevent signaling', async (t) => {
  let reads = 0;
  t.mock.method(nodeService, 'readProcessIdentity', () => info(targetPid, { uids: ++reads === 1 ? [1000, 1000, 1000, 1000] : [1000, 0, 0, 0] }));
  assert.equal((await terminate()).statusCode, 403);
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('missing/inaccessible/unsupported/invalid process readers fail closed with sanitized errors', async (t) => {
  for (const [code, expected] of [['ENOENT', 404], ['ESRCH', 404], ['ESTALE', 409], ['EACCES', 403], ['EPROCESS', 503]]) {
    t.mock.method(nodeService, 'readProcessIdentity', () => { throw Object.assign(new Error('secret command arguments'), { code }); });
    const res = await terminate();
    assert.equal(res.statusCode, expected, code);
    assert.doesNotMatch(res.json().error, /secret|arguments/);
  }
  t.mock.method(nodeService, 'getProcessControlContext', () => { throw Object.assign(new Error('secret ancestor'), { code: 'ENOENT' }); });
  assert.equal((await terminate()).statusCode, 503, 'unreadable ancestry is never ignored');
  t.mock.method(nodeService, 'getProcessControlContext', () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
  assert.equal((await terminate()).statusCode, 501);
  assert.equal(signalMock.mock.calls.length, 0);
  assert.equal(audits().length, 0);
});

test('native signal errors never claim success, leak raw errors, or produce success audits', async (t) => {
  for (const [code, expected] of [['EPERM', 403], ['ESRCH', 404], ['EIO', 503]]) {
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('secret process command'), { code }); });
    const res = await terminate();
    assert.equal(res.statusCode, expected, code);
    assert.doesNotMatch(res.json().error, /secret|command/);
  }
  t.mock.method(process, 'kill', () => false);
  assert.equal((await terminate()).statusCode, 503);
  assert.equal(audits().length, 0);
});

test('explicit TERM and KILL send only numeric targeted native signals and audit metadata', async () => {
  for (const signal of ['TERM', 'KILL']) {
    const res = await terminate({ identity, signal, command: 'must not be logged', secret: 'do not log' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true, pid: targetPid, signal, signalSent: true });
    assert.deepEqual(signalMock.mock.calls.at(-1).arguments, [targetPid, `SIG${signal}`]);
  }
  assert.equal(signalMock.mock.calls.length, 2, 'no automatic escalation, probes, or process-group signals');
  const entries = audits();
  assert.equal(entries.length, 2);
  for (const [index, signal] of ['TERM', 'KILL'].entries()) {
    assert.equal(entries[index].target_type, 'process');
    assert.equal(entries[index].target_id, String(targetPid));
    assert.deepEqual(JSON.parse(entries[index].details), { pid: targetPid, signal });
    assert.doesNotMatch(entries[index].details, /must not be logged|do not log|command|secret/);
  }
});

test('inspection through native signal dispatch is synchronous', async () => {
  let nextTurn = false;
  const queued = Promise.resolve().then(() => { nextTurn = true; });
  const result = processControl.terminateProcess({ pid: targetPid, identity, signal: 'TERM' });
  assert.equal(nextTurn, false);
  assert.equal(result.then, undefined);
  assert.equal(result.signalSent, true);
  assert.equal(signalMock.mock.calls.length, 1);
  await queued;
});

test('process-list formatting preserves metrics and adds only safe control hints', () => {
  const rows = [
    { ...info(), name: 'worker', cpuPercent: 7.23, rssBytes: 1024 },
    { ...info(777777), name: 'ancestor', cpuPercent: 6, rssBytes: 1024 },
    { ...info(targetPid - 1, { uids: [1000, 0, 0, 0] }), name: 'setuid', cpuPercent: 5, rssBytes: 1024 },
    { pid: targetPid - 2, name: 'ps fallback', cpuPercent: 4, rssBytes: 1024 },
  ];
  const result = nodeService._formatProcessResult(rows, 50, 10240);
  assert.deepEqual(result.processes[0], {
    pid: targetPid, name: 'worker', cpuPercent: 7.2, rssBytes: 1024, memPercent: 10,
    uid: 1000, identity, canTerminate: true,
  });
  assert.equal(result.processes[1].canTerminate, false);
  assert.equal(result.processes[2].canTerminate, false);
  assert.equal(result.processes[3].canTerminate, false);
  assert.equal(result.processes[3].identity, null);
  assert.equal(result.processes[3].uid, null);
});

test('a failure to establish service ancestry disables all process-list controls', (t) => {
  t.mock.method(nodeService, 'getProcessControlContext', () => { throw new Error('unavailable'); });
  const result = nodeService._formatProcessResult([{ ...info(), name: 'worker', cpuPercent: 1, rssBytes: 1024 }], 50, 10240);
  assert.equal(result.processes[0].canTerminate, false);
});

test('the Linux reader parses start ticks and all owner IDs using synthetic proc files', { skip: process.platform !== 'linux' }, (t) => {
  t.mock.method(nodeService, '_getLinuxBootId', () => bootId);
  t.mock.method(fs, 'readFileSync', (file) => {
    if (file === `/proc/${targetPid}/stat`) return procStat(targetPid);
    if (file === `/proc/${targetPid}/status`) return 'Name:\tworker\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t1 kB\n';
    throw new Error('Unexpected process file read.');
  });
  assert.deepEqual(originalRead(targetPid), info());
  assert.equal(signalMock.mock.calls.length, 0);
});

test('the existing Linux sampler supplies the same stable identity to listed rows', { skip: process.platform !== 'linux' }, (t) => {
  t.mock.method(nodeService, '_getLinuxBootId', () => bootId);
  t.mock.method(fs, 'readdirSync', () => [String(targetPid), 'not-a-process']);
  t.mock.method(fs, 'readFileSync', (file) => {
    if (file === '/proc/stat') return 'cpu 100 0 0 100 0 0 0 0\n';
    if (file === `/proc/${targetPid}/stat`) return procStat(targetPid);
    if (file === `/proc/${targetPid}/status`) return 'Uid:\t1000\t1000\t1000\t1000\nVmRSS:\t2 kB\n';
    throw new Error('Unexpected process file read.');
  });
  const previous = nodeService._lastProcSample;
  t.after(() => { nodeService._lastProcSample = previous; });
  nodeService._lastProcSample = null;
  const sample = nodeService._sampleLinuxProcesses();
  assert.equal(sample.length, 1);
  assert.equal(sample[0].identity, identity);
  const [row] = nodeService._formatProcessResult(sample, 50, 10240).processes;
  assert.equal(row.canTerminate, true);
  assert.equal(row.uid, 1000);
  assert.equal(row.rssBytes, 2048);
  assert.equal(row.name, 'worker (odd) name');
  assert.equal(signalMock.mock.calls.length, 0);
});

test('the Linux reader detects PID replacement between stat and owner reads', { skip: process.platform !== 'linux' }, (t) => {
  let reads = 0;
  t.mock.method(nodeService, '_getLinuxBootId', () => bootId);
  t.mock.method(fs, 'readFileSync', (file) => file.endsWith('/stat')
    ? procStat(targetPid, { start: ++reads === 1 ? '123456789' : '999' })
    : 'Uid:\t1000\t1000\t1000\t1000\n');
  assert.throws(() => originalRead(targetPid), { code: 'ESTALE' });
  assert.equal(signalMock.mock.calls.length, 0);
});

test('malformed proc data cannot supply an actionable identity', { skip: process.platform !== 'linux' }, (t) => {
  t.mock.method(nodeService, '_getLinuxBootId', () => bootId);
  for (const [stat, status] of [
    ['malformed', 'Uid:\t1000\t1000\t1000\t1000\n'],
    [procStat(targetPid, { start: 'oops' }), 'Uid:\t1000\t1000\t1000\t1000\n'],
    [procStat(targetPid), 'Uid:\t1000\n'],
    [procStat(targetPid + 1), 'Uid:\t1000\t1000\t1000\t1000\n'],
  ]) {
    t.mock.method(fs, 'readFileSync', (file) => file.endsWith('/stat') ? stat : status);
    assert.throws(() => originalRead(targetPid), { code: 'EPROCESS' });
  }
  assert.equal(signalMock.mock.calls.length, 0);
});

test('the service ancestry walk protects every parent and rejects loops', { skip: process.platform !== 'linux' }, (t) => {
  t.mock.method(nodeService, 'readProcessIdentity', (pid) => info(pid, { ppid: pid === process.pid ? 777777 : 1 }));
  const context = originalContext();
  assert.equal(context.uid, process.geteuid());
  for (const pid of [1, process.pid, process.ppid, 777777]) assert.ok(context.protectedPids.has(pid));
  t.mock.method(nodeService, 'readProcessIdentity', (pid) => info(pid, { ppid: pid }));
  assert.throws(() => originalContext(), { code: 'EPROCESS' });
  assert.equal(signalMock.mock.calls.length, 0);
});
