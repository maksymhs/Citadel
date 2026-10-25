/** Provider model catalogs and subscription usage normalization for AI Gateway. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModels, normalizeClaudeUsage, normalizeCodexUsage, safeProviderSnapshot } = require('../server/services/gatewayDiscoveryService');

test('model catalogs retain only bounded unique upstream IDs', () => {
  assert.deepEqual(normalizeModels([
    { id: 'claude-opus', display_name: 'Claude Opus' },
    { id: 'claude-opus', display_name: 'Duplicate' },
    { id: 'citadel-execution' }, { id: 'bad model' }, { id: 123 },
  ]), [{ id: 'claude-opus', label: 'Claude Opus' }]);
});

test('Claude usage preserves zero and labels known rolling windows', () => {
  const reset = new Date(Date.now() + 60000).toISOString();
  const windows = normalizeClaudeUsage({ five_hour: { utilization: 0, resets_at: reset }, seven_day: { utilization: 72, resets_at: reset }, seven_day_opus: { utilization: 50 } });
  assert.equal(windows.length, 3);
  assert.equal(windows[0].usedPercent, 0);
  assert.equal(windows[0].durationSeconds, 18000);
  assert.equal(windows[1].durationSeconds, 604800);
  assert.equal(windows[2].durationSeconds, 604800);
});

test('Codex usage uses explicit window durations and does not invent daily or weekly limits', () => {
  const resetAfter = 900;
  const windows = normalizeCodexUsage({ rate_limit: {
    primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: resetAfter },
    secondary_window: { used_percent: 25 },
  }, additional_rate_limits: [{ limit_name: 'review', rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 86400 } } }] });
  assert.equal(windows[0].durationSeconds, 18000);
  assert.equal(windows[0].usedPercent, 5);
  assert.ok(Date.parse(windows[0].resetsAt) > Date.now());
  assert.equal(windows[1].durationSeconds, null);
  assert.equal(windows[2].durationSeconds, 86400);
  assert.equal(windows[2].usedPercent, 0);
});

test('discovery snapshot hides cached provider data after disconnect', () => {
  assert.deepEqual(safeProviderSnapshot(false, { models: { items: [{ id: 'secret' }] }, usage: { accounts: [] } }), {
    connected: false,
    models: { status: 'not_connected', source: null, fetchedAt: null, stale: false, items: [] },
    usage: { status: 'not_connected', fetchedAt: null, stale: false, accounts: [] },
  });
});
