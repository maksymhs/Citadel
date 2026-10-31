/** Dashboard metric links preserve the displayed host and ignore detached views. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('remote machine metric buttons route all destinations with the correct host', async () => {
  const dom = new JSDOM('<div id="dash-machine-pane"></div>', { runScripts: 'dangerously' });
  const win = dom.window, opened = [];
  const host = { id: 'peer-one', name: 'Peer', online: true, alerts: [], version: '0.65.0', latencyMs: 20, uptime7d: 100,
    health: { loadPerCore: 0.2, load1: 0.2, cores: 2, memory: { usedPercent: 30 }, disk: { usedPercent: 40 } } };
  try {
    win.eval(fs.readFileSync(path.join(__dirname, '../public/js/monitor.js'), 'utf8'));
    await win.CitadelMonitor.renderMachine({
      escapeHtml: value => String(value), activeHostId: () => host.id,
      openMetric: (...args) => opened.push(args),
      localApi: async url => url === '/api/monitor/overview' ? { hosts: [host] } : { points: [], events: [], uptime: 100 },
    }, host.id);
    const buttons = [...win.document.querySelectorAll('button[data-metric]')];
    assert.deepEqual(buttons.map(button => button.dataset.metric), ['cpu', 'memory', 'disk', 'terminals', 'audit', 'audit', 'updates']);
    for (const button of buttons) button.click();
    assert.deepEqual(opened, buttons.map(button => [host.id, button.dataset.metric]));
    const oldClick = buttons[0].onclick;
    win.document.getElementById('dash-machine-pane').remove();
    oldClick();
    assert.equal(opened.length, 7);
  } finally { win.close(); }
});
