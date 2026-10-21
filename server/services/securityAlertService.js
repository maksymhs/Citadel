/**
 * Security alerts: tell the administrator about events that matter while they
 * are not looking at the panel.
 *
 *   - a sign-in from an address that user has not used before,
 *   - a burst of failed sign-ins (from one address, or spread over many),
 *   - a machine that paired with this Citadel (it gets administrator access),
 *   - the first administrator being created, a setup code that had to be
 *     replaced after wrong guesses, a password reset from the shell.
 *
 * Every event is written to the activity log (category "security") and, unless
 * the administrator turned security alerts off, pushed to the same channels as
 * the machine alerts (webhook, ntfy, Telegram). The message always names this
 * machine, since several Citadels can report to one channel.
 *
 * Everything here is best effort and never throws: an alert must not be able to
 * break a sign-in. Repeated events are throttled so a noisy attacker cannot
 * flood the channel.
 */
const os = require('node:os');
const { getDatabase } = require('../database/db');
const logService = require('./logService');

const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 5;
const SPREAD_THRESHOLD = 15;
const THROTTLE_MS = 30 * 60 * 1000;
const MAX_IPS_PER_USER = 200;
const MAX_TRACKED = 1000;

const failuresByIp = new Map(); // ip -> [timestamps]
const lastAlertAt = new Map();  // throttle key -> timestamp

function machineName() {
  try {
    return require('./hostService').getInstanceName() || os.hostname();
  } catch {
    return os.hostname();
  }
}

function throttled(key, now) {
  const last = lastAlertAt.get(key);
  if (last !== undefined && now - last < THROTTLE_MS) return true;
  lastAlertAt.set(key, now);
  if (lastAlertAt.size > MAX_TRACKED) lastAlertAt.delete(lastAlertAt.keys().next().value);
  return false;
}

function shortAgent(userAgent) {
  const text = String(userAgent || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 80) : 'unknown client';
}

/**
 * Record the event and push it to the channels. Resolves when delivery has been
 * attempted, so callers that exit right away (the CLI) can await it.
 */
async function emit({ kind, severity = 'warning', title, message, details = null }) {
  const text = `${message} (${machineName()})`;
  try {
    logService.record({
      level: severity === 'critical' ? 'error' : severity === 'info' ? 'info' : 'warn',
      category: 'security', action: `security_${kind}`, message: text, details,
    });
    const monitor = require('./monitorService');
    if (!monitor.getConfig().securityAlerts) return;
    await monitor.notify({
      title: `Citadel security: ${title}`, message: text, severity, hostId: 'local', kind: `security_${kind}`, state: 'firing',
    });
  } catch (err) {
    console.error('[SecurityAlerts] Could not deliver alert:', err.message);
  }
}

/** A successful sign-in. The first address a user ever signs in from is just remembered. */
async function loginSucceeded({ user, ip, userAgent }) {
  try {
    if (!user || !ip) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    const known = db.prepare('SELECT COUNT(*) AS c FROM login_ips WHERE user_id = ?').get(user.id).c;
    const seen = db.prepare('SELECT 1 AS x FROM login_ips WHERE user_id = ? AND ip = ?').get(user.id, ip);
    if (seen) {
      db.prepare('UPDATE login_ips SET last_seen = ? WHERE user_id = ? AND ip = ?').run(now, user.id, ip);
      return;
    }
    db.prepare('INSERT INTO login_ips (user_id, ip, first_seen, last_seen) VALUES (?, ?, ?, ?)').run(user.id, ip, now, now);
    db.prepare(`
      DELETE FROM login_ips WHERE user_id = ? AND ip NOT IN (
        SELECT ip FROM login_ips WHERE user_id = ? ORDER BY last_seen DESC LIMIT ?
      )
    `).run(user.id, user.id, MAX_IPS_PER_USER);
    if (known === 0) return;
    await emit({
      kind: 'new_signin', title: 'New sign-in location',
      message: `"${user.username}" signed in from ${ip} (${shortAgent(userAgent)}), an address not used before. If this was not you, run "citadel reset-password" and review Activity`,
      details: { username: user.username, ip },
    });
  } catch (err) {
    console.error('[SecurityAlerts] loginSucceeded failed:', err.message);
  }
}

/** A failed sign-in: alert once a burst builds up, from one address or many. */
async function loginFailed({ ip, username }, now = Date.now()) {
  try {
    const key = ip || 'unknown';
    const recent = (failuresByIp.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    recent.push(now);
    failuresByIp.set(key, recent);
    if (failuresByIp.size > MAX_TRACKED) failuresByIp.delete(failuresByIp.keys().next().value);

    if (recent.length >= FAIL_THRESHOLD && !throttled(`fail:${key}`, now)) {
      await emit({
        kind: 'login_failures', title: 'Repeated failed sign-ins',
        message: `${recent.length} failed sign-ins from ${key} in the last ${FAIL_WINDOW_MS / 60000} minutes (last username tried: "${String(username || '').slice(0, 40)}")`,
        details: { ip: key, count: recent.length },
      });
      return;
    }
    let total = 0;
    let addresses = 0;
    for (const times of failuresByIp.values()) {
      const n = times.filter((t) => now - t < FAIL_WINDOW_MS).length;
      if (n > 0) { total += n; addresses += 1; }
    }
    if (total >= SPREAD_THRESHOLD && addresses >= 3 && !throttled('fail:spread', now)) {
      await emit({
        kind: 'login_spread', severity: 'critical', title: 'Failed sign-ins from many addresses',
        message: `${total} failed sign-ins from ${addresses} different addresses in ${FAIL_WINDOW_MS / 60000} minutes: someone may be guessing passwords`,
        details: { total, addresses },
      });
    }
  } catch (err) {
    console.error('[SecurityAlerts] loginFailed failed:', err.message);
  }
}

const setupCompleted = ({ username, ip }) => emit({
  kind: 'setup_completed', severity: 'info', title: 'Administrator account created',
  message: `The administrator account "${username}" was created from ${ip || 'an unknown address'}`,
  details: { username, ip },
});

const setupCodeRotated = ({ ip }) => emit({
  kind: 'setup_code_rotated', title: 'Wrong setup codes',
  message: `Too many wrong first-run setup codes from ${ip || 'an unknown address'}; a new code was generated`,
  details: { ip },
});

const peerPaired = ({ name, ip }) => emit({
  kind: 'peer_paired', title: 'A machine paired with this Citadel',
  message: `"${String(name || 'unknown').slice(0, 60)}" paired from ${ip || 'an unknown address'} and now has administrator access to this machine. Unpair it in Settings → Machines if you do not recognise it`,
  details: { name, ip },
});

const passwordReset = ({ username }) => emit({
  kind: 'password_reset', title: 'Password reset from the shell',
  message: `The password of "${username}" was reset with "citadel reset-password" and its sessions were signed out`,
  details: { username },
});

module.exports = {
  emit, loginSucceeded, loginFailed, setupCompleted, setupCodeRotated, peerPaired, passwordReset,
  FAIL_THRESHOLD, SPREAD_THRESHOLD,
};
