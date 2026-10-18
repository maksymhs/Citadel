# Citadel — Engineering Execution State

## 1. Objective and scope
Harden security, reliability and maintainability of the existing Citadel repo (no rewrites):
Phase 1 privilege/install hardening, Phase 2 auth/network trust, Phase 3 task-mesh
reliability, Phase 4 process lifecycle, Phase 5 docs/compatibility, Phase 6 final
verification. No commits/pushes/deploys. Ledger updated after every phase.

## 2. Repository baseline
- Branch: `main`, HEAD `1f853cb` (chore(release): v0.16.1). `git status --short`: clean.
- Node test suite baseline: `npm test` → 116 tests, 116 pass, 0 fail (~13 s).
- Stack: Fastify 5 + better-sqlite3 + node-pty + tmux; ~7.3k LOC; tests in `tests/`.

## 3. Confirmed findings
### Phase 1 (privilege/installation)
- F1.1 `install.sh`: privileged features enabled by default: `ADMIN_TERMINAL_USER` defaults
  to installing user (root-capable terminal), `ENABLE_UPDATER=true`, `LAN_ACCESS=true`,
  `TUNNEL=true`. A fresh install before admin setup is reachable on LAN + public
  Cloudflare tunnel; first visitor can claim `/api/auth/setup`.
- F1.2 `install.sh` writes sudoers `($ADMIN_TERMINAL_USER)` without validating the user
  exists; `--admin-terminal` silently defaults to `ubuntu`.
- F1.3 `updateService.triggerUpdate()` runs `sudo -n $UPDATER_PATH` using env-provided path
  without verifying the helper is root-owned / not writable by others.
### Phase 2 (auth/network trust)
- F2.1 `server/index.js:43` `trustProxy: true` trusts `X-Forwarded-For` from any direct
  connection → per-IP rate limits (`authRoutes` credential limiter included) are bypassable
  by spoofing headers. Cookie `secure` flag also derives from spoofable protocol.
- F2.2 `authRoutes` setup/login return `sessionId` in JSON body (session id leak into JS
  state/logs); cookie already set, frontend does not consume the JSON field.
- F2.3 `createInitialAdmin` check-then-insert is not atomic across processes
  (`INSERT ... WHERE NOT EXISTS` needed); `verifyPassword` throws on malformed hash.
### Phase 3 (task mesh)
- F3.1 `completeTask` accepts results from any caller holding any session while task status
  is `queued|running`; no claim token/attempt check → stale/expired worker can overwrite a
  newer attempt's result; task can be completed by a node that never claimed it.
- F3.2 No attempt counter / retry limit: expired lease requeues forever, silently.
- F3.3 Cancellation marks task `cancelled` immediately (request, not confirmed termination);
  sentinel's SIGTERM is fire-and-forget; no confirmation path.
- F3.4 Sentinel authenticates with a full admin session token (`CITADEL_TOKEN=<session id>`);
  no scoped node credential exists.
### Phase 4 (process lifecycle)
- F4.1 (fixed) `terminalManager._spawnPty` tmux spawn failure silently fell back to `/bin/sh`
  as the service user for admin sessions (identity downgrade, no audit).
- F4.2 (fixed in Phase 1) `_buildRunAs`/`fileService` trusted `TERMINAL_ADMIN_USER` as-is;
  now format-validated in `config.js` (invalid → null + warning).
- F4.3 (fixed) `createSession` could leave a DB row `active` when the PTY failed to spawn;
  `attachClient` could crash on re-spawn failure. Both now close/fail cleanly.
- F4.4 (fixed) Sentinel `api()` fetch had no timeout (a hung panel stalls the node forever)
  and `tick()` could overlap with itself (double claims). Now `AbortSignal.timeout` +
  in-flight guard.
- F4.5 (residual, documented) No hard cap on concurrent terminal sessions; sessions are
  closed on exit and buffers bounded (64 KB). Kept as-is to avoid breaking workflows.

## 4. Findings disproved / already fixed
- Logout already destroys the session server-side (`authRoutes` + `destroySession`).
- `createInitialAdmin` already blocks a second setup within one process (test exists).
- All API/WS routes already require authentication (verified via grep preHandler).
- PTY/tmux sessions already bounded ring buffer (64 KB) and WS payload cap (1 MB).

## 5. Phase status
- Phase 0: COMPLETE (baseline above).
- Phase 1: COMPLETE — installer defaults opt-in, admin user validated, updater helper
  ownership/permission check. Tests: tests/hardening.test.js (10 pass).
- Phase 2: COMPLETE — trustProxy=loopback default (+CITADEL_TRUST_PROXY), sessionId removed
  from JSON, cookie attrs asserted, atomic initial-admin insert, safe password verify,
  logout invalidation test. Tests: auth (9), hardening proxy tests.
- Phase 3: COMPLETE — migration 003 (attempt/max_attempts/claim_token), claim tokens required
  for results, bounded retries, cancellation request vs confirmation, scoped node token for
  worker endpoints (CITADEL_NODE_TOKEN), sentinel kill escalation+confirmation.
  Tests: tasks (13), task-node-auth (4), logs lifecycle.
- Phase 4: COMPLETE — `_spawnPty` throws instead of downgrading identity (F4.1), createSession
  marks the row closed on spawn failure (F4.3), attachClient reports spawn errors to the WS
  instead of crashing (F4.3), sentinel HTTP timeout + non-overlapping ticks + testable
  exports (F4.4). Tests: terminal (no-fallback, failed-spawn cleanup), sentinel (overlap,
  guard reset); full suite 141/141.
- Phase 5: COMPLETE — README (install flags opt-in table, privileged terminal/updater/LAN,
  trust-proxy note, task-mesh claim tokens/retries/cancellation, sentinel node token,
  tunnel no longer default), `docs/architecture.md` §6 security posture, `.env.example`
  (`CITADEL_TRUST_PROXY`, `CITADEL_NODE_TOKEN`, updater/admin-user notes).
- Phase 6: COMPLETE — full `npm test` 141/141 (see §7), diff reviewed, ledger corrected.

## 6. Files changed (reason)
- `docs/engineering-execution-state.md` (new): this ledger.
- `install.sh`: secure-by-default flags (F1.1), admin user validation (F1.2).
- `server/config.js`: `TRUST_PROXY` parsing, `TERMINAL_ADMIN_USER` format validation,
  `CITADEL_NODE_TOKEN` config.
- `server/index.js`: explicit trust proxy (F2.1), expose node token to routes.
- `server/security/auth.js`: atomic initial admin insert, safe password verify (F2.3).
- `server/routes/authRoutes.js`: no sessionId in JSON (F2.2).
- `server/services/updateService.js`: verify updater helper ownership/permissions (F1.3).
- `server/database/db.js`: migration `003_task_attempt_claims` (attempt, claim_token,
  max_attempts) for Phase 3.
- `server/services/taskService.js`: claim tokens/attempts/retry limit (F3.1/F3.2),
  cancellation confirmation state (F3.3), heartbeat token semantics.
- `server/routes/taskRoutes.js`: scoped node auth for worker endpoints (F3.4).
- `scripts/sentinel.js`: node token support, claim token on result, cancel confirmation,
  HTTP timeout, tick in-flight guard, `require.main` guard + exports (F4.4).
- `server/services/terminalManager.js`: no silent `/bin/sh` downgrade (F4.1), spawn-failure
  row cleanup + attachClient error path (F4.3).
- Tests updated: `tests/auth.test.js`, `tests/tasks.test.js`, `tests/logs.test.js`,
  `tests/terminal.test.js`. New: `tests/hardening.test.js`, `tests/task-node-auth.test.js`,
  `tests/sentinel.test.js`.
- Docs: `README.md`, `docs/architecture.md`, `.env.example` (Phase 5).

## 7. Tests executed and results
- Baseline: `npm test` 116/116 pass (pre-change).
- After Phase 1+2: 129/129 pass. After Phase 3 (task suites): 31/31 pass.
- After Phase 4: `npm test` 141/141 pass (~15.9 s): 116 original + hardening (10),
  task-node-auth (4), sentinel (2), plus 9 new cases inside auth/tasks/terminal/logs.
- Final (Phase 6): `npm test` 141/141 pass, 0 fail.

## 8. Pre-existing failures
- None observed at baseline.

## 9. Compatibility notes / manual actions
- API: `/api/tasks/claim` now returns `claimToken`; `/api/tasks/:id/result` requires it.
  Update any external sentinel. `scripts/sentinel.js` updated; MCP unaffected.
- `/api/auth/login|setup` responses no longer include `sessionId`; clients must use the
  `session_id` cookie. CLI users can still read `Set-Cookie` or use a node token.
- New env: `CITADEL_NODE_TOKEN` (optional, scoped worker credential),
  `CITADEL_TRUST_PROXY` (default `loopback`).
- Installer defaults changed: privileged terminal, updater, LAN and tunnel are now opt-in
  (`--admin-terminal`, `--enable-updater`, `--lan`, `--tunnel`).
- Required manual step for existing installs: none; schema migration is additive
  (`003_task_attempt_claims`).
- `install.sh` still refuses to overwrite an existing `.env`; toggling flags later means
  re-running with the flag (for terminal/user) or editing `.env`. Existing installs keep
  whatever they enabled previously — the new opt-in defaults only affect fresh installs.

## 10. Remaining tasks
- (none in scope; optional follow-ups: scoped tokens for MCP orchestrator, per-node
  identity beyond the shared node token, hard cap on concurrent terminal sessions F4.5.)

## 11. Last checkpoint / next safe action
- Last checkpoint: Phase 6 complete. Full suite 141/141, migration additive, diff reviewed.
- Next safe action: none required. Optional: review `git diff` and decide whether to
  commit manually (not performed).
