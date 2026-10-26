/** Normalize provider model catalogs and subscription usage for Claude Code Gateway Settings. */
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/+()-]{0,159}$/;
const MAX_MODELS = 256;

function validReset(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' && value.length <= 80) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function normalizeModels(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !MODEL.test(id) || /^citadel-/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof item?.display_name === 'string' && item.display_name.length <= 160 ? item.display_name : id;
    models.push({ id, label });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function normalizePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function normalizeClaudeUsage(payload) {
  const windows = [];
  for (const [key, value] of Object.entries(payload && typeof payload === 'object' ? payload : {})) {
    if (!value || typeof value !== 'object') continue;
    const usedPercent = normalizePercent(value.utilization);
    const resetsAt = validReset(value.resets_at);
    if (usedPercent === null && !resetsAt) continue;
    const durationSeconds = key === 'five_hour' ? 18000 : key.startsWith('seven_day') ? 604800 : null;
    windows.push({ id: key.slice(0, 80), label: key.replaceAll('_', ' '), durationSeconds, usedPercent, resetsAt });
  }
  return windows.slice(0, 16);
}

function normalizeCodexUsage(payload) {
  const windows = [];
  const visited = new Set();
  function addWindow(id, value) {
    if (!value || typeof value !== 'object' || visited.has(id)) return;
    visited.add(id);
    const rawDuration = value.limit_window_seconds ?? value.limitWindowSeconds;
    const durationSeconds = Number.isFinite(rawDuration) && rawDuration > 0 && rawDuration <= 366 * 86400 ? rawDuration : null;
    const rawReset = value.reset_at ?? value.resetAt;
    let resetsAt = validReset(rawReset);
    if (!resetsAt) {
      const after = value.reset_after_seconds ?? value.resetAfterSeconds;
      if (Number.isFinite(after) && after >= 0 && after <= 366 * 86400) resetsAt = new Date(Date.now() + after * 1000).toISOString();
    }
    const usedPercent = normalizePercent(value.used_percent ?? value.usedPercent);
    if (usedPercent === null && !resetsAt) return;
    const duration = durationSeconds;
    windows.push({ id, label: duration === 18000 ? '5-hour window' : duration === 604800 ? '7-day window' : duration ? `${Math.round(duration / 3600)}-hour window` : id, durationSeconds: duration, usedPercent, resetsAt });
  }
  const base = payload?.rate_limit ?? payload?.rateLimit ?? {};
  addWindow('primary', base.primary_window ?? base.primaryWindow);
  addWindow('secondary', base.secondary_window ?? base.secondaryWindow);
  const extra = payload?.additional_rate_limits ?? payload?.additionalRateLimits;
  if (Array.isArray(extra)) extra.slice(0, 12).forEach((entry, i) => {
    const info = entry?.rate_limit ?? entry?.rateLimit ?? {};
    addWindow(`additional-${i + 1}-primary`, info.primary_window ?? info.primaryWindow);
    addWindow(`additional-${i + 1}-secondary`, info.secondary_window ?? info.secondaryWindow);
  });
  return windows;
}

function safeProviderSnapshot(connected, cached) {
  if (!connected) return { connected: false, models: { status: 'not_connected', source: null, fetchedAt: null, stale: false, items: [] }, usage: { status: 'not_connected', fetchedAt: null, stale: false, accounts: [] } };
  if (!cached) return { connected: true, models: { status: 'unavailable', source: null, fetchedAt: null, stale: false, items: [] }, usage: { status: 'unavailable', fetchedAt: null, stale: false, accounts: [] } };
  const stale = state => state ? { ...state, stale: state.stale || (Date.parse(state.expiresAt) > 0 && Date.parse(state.expiresAt) <= Date.now()) } : state;
  return { connected: true, models: stale(cached.models), usage: stale(cached.usage), ...(cached.error ? { message: 'Refresh failed; showing the last available result.' } : {}) };
}

module.exports = { normalizeModels, normalizeClaudeUsage, normalizeCodexUsage, safeProviderSnapshot, validReset };
