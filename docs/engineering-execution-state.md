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

---

# Continuation run — v0.17.0 final hardening

## 12. Entry state (2026-10-18, this run)
- HEAD `96e22fd` (chore(release): v0.17.0), branch `main`, `git status` clean.
  The harden commit `5c1dbf6` is in history; the phases below were NOT covered by it.
- Baseline before any change: `npm test` → 141 tests, 141 pass, 0 fail (~22 s).
- Inspected: `server/services/taskService.js`, `server/routes/taskRoutes.js`,
  `scripts/sentinel.js`, `server/config.js`, `server/security/auth.js`,
  `server/database/db.js`, existing task/node/auth tests, README task-mesh section,
  `.env.example`, `docs/architecture.md`.

### Real protocol flow (as implemented)
claim (`attempt++`, mint `claim_token`, set `lease_until=now+90s`)
→ sentinel `runTask` holds `{child, claimToken}` in `running` map
→ heartbeat every ~4 s sends `{node, capacity, active, load, running:[ids]}`; server
renews leases then answers `{node, cancel:[...]}`
→ child exit → `POST /api/tasks/:id/result {status, claimToken}`
→ expiry: `reclaimExpired()` (inside claim/heartbeat transactions) requeues (attempts
remain) or fails; `cancelling` finalises as `cancelled`.

## 13. Confirmed defects (this run)
- C1 (lease renewal, on-screen bug): `taskService.heartbeat()` renewed
  `UPDATE tasks SET lease_until=? WHERE status='running' AND node=?` — the `running`
  array was used ONLY for cancel notifications. A task whose process/sentinel died
  (or an orphaned child after a sentinel restart) kept being renewed forever by the
  healthy node heartbeat, so `reclaimExpired` never fired. Confirmed by reading
  taskService.js:470-473 + sentinel.js:151-161.
- C2 (completion after expiry): `completeTask()` checked `claim_token` + status but
  never `lease_until`. Between lease expiry and the next claim/heartbeat (lazy
  `reclaimExpired`), a stale worker could finalise a task whose attempt had already
  lost its lease. Full overwrite of a newer attempt was already blocked by
  `claim_token`; the gap is authority after expiry. Confirmed by code read.
- C3 (node identity): one shared `CITADEL_NODE_TOKEN` authenticates every sentinel and
  the node id is client-declared, so any token holder can claim/heartbeat/report as
  any node id (breaks task pinning and per-node attribution). Within the
  same-operator/shared-perimeter model this is an accepted limitation, but the code
  offered no way to bind a credential to a node. Confirmed by taskRoutes.js:16-30.
- Disproved: stale claim token overwriting a newer attempt is already blocked;
  `cancelling` leases are already not renewed; sentinel already includes running ids.

## 14. Design decisions (this run)
- Heartbeat reconcile: `running` entries may be `"id"` (legacy) or `{id, claimToken}`
  (new). With the list present, only listed tasks are renewed, each guarded by
  `status='running' AND node=? AND (claim_token matches when provided)`. Unlisted
  tasks stop being renewed and expire naturally via `reclaimExpired` (no eager
  fail/requeue: a delayed heartbeat or restart must not kill live work). If the list
  is ABSENT (third-party legacy client) renewal falls back to node-wide renewal +
  a one-time warning event — otherwise an old client's live tasks would be requeued
  every lease and executed twice.
- Expiry rule: a result is authorised only while `lease_until` is in the future.
  On an expired lease `completeTask` atomically runs `reclaimExpired` in the same
  transaction (requeue or bounded failure) and then rejects with an explicit error.
  Cancellation confirmation after an expired lease is also rejected, but
  `reclaimExpired` already finalises the task as `cancelled` (same terminal state).
- `cancelTask` on a running task whose lease is already expired finalises it as
  `cancelled` immediately (no worker has authority) instead of parking in
  `cancelling` until lazy reclaim.
- Node identity: optional `CITADEL_NODE_TOKENS="nodeId:token,..."` binds each
  credential to one node id. When configured, the shared `CITADEL_NODE_TOKEN` is
  ignored for worker endpoints (fail closed, warning logged) and worker routes
  enforce `body.node === authenticated node id`; result reports additionally require
  the task's node to match. Sessions keep full access (orchestrator trust).
  Revocation/rotation = edit the env map and restart (stateless).
- Compatibility: shared token and session auth unchanged when `CITADEL_NODE_TOKENS`
  is unset; legacy heartbeat bodies still renew; no schema migration required.

## 15. Progress log (this run)
- [x] C1 fixed: heartbeat renews only the reported attempts (claim-token
  guarded), legacy no-list fallback keeps renewal + one-time warning;
  `scripts/sentinel.js` sends `{id, claimToken}` witness entries.
- [x] C2 fixed: `completeTask` checks lease/status/token atomically, reclaims on
  expiry in the same transaction and rejects with an explicit error; a late
  result cannot reopen a terminal state. `cancelTask` finalises a running task
  whose lease already expired.
- [x] C3 implemented: optional per-node `CITADEL_NODE_TOKENS` map with
  credential→node binding on claim/heartbeat/result; shared token disabled for
  worker endpoints when the map is set (warning, fail closed); secrets never
  logged or echoed.
- [x] Regression tests: `tests/task-leases.test.js` (14),
  `tests/task-node-identity.test.js` (7), sentinel witness test, config
  validation test. Full suite `npm test` → 164/164 pass.
- [x] Docs: README task-mesh section (witness list, lease authority, per-node
  credentials), `.env.example` (`CITADEL_NODE_TOKENS` + precedence),
  `docs/architecture.md` §6 worker-credentials bullet, sentinel header comment.
- See §18 for the final record.
- [x] Release: user explicitly requested publication in this run. Published as
  `v0.17.1` (patch) with commits `fix(task-mesh): ...` and
  `chore(release): v0.17.1`, tag pushed to `origin`. See §19.

## 16. Regression tests required (mapped to defects)
- C1: listed task renewed / unlisted task not renewed; stale claim token cannot renew
  a newer attempt; duplicate & obsolete heartbeats are no-ops; legacy list-less body
  still renews (documented fallback); `cancelling` never renewed.
- C2: complete before expiry OK; complete after expiry rejected + requeued; after
  expiry with attempts exhausted → failed; stale token after new attempt finished →
  rejected; cancel + late result cannot reopen a terminal state; expired running task
  cancels immediately.
- C3: per-node token cannot declare another node (403); cannot report another node's
  task; revoked/shared-fallback tokens rejected when per-node map is set; secrets
  never echoed in errors; session compatibility.

## 17. Next exact step (if context is compacted)
Implement §14 C2 in `completeTask`/`cancelTask`, then C3 in `server/config.js` +
`server/routes/taskRoutes.js`, then add `tests/task-leases.test.js` and
`tests/task-node-identity.test.js`, run `npm test`, update §15-16 and
README/.env.example/architecture. No commits/pushes/deploys.

## 18. Continuation results (FINAL for this run)
### Behaviour: before → after
- Heartbeat (C1): before renewed `status='running' AND node=?` regardless of the
  `running` list → an orphaned task held `running`/lease forever. After: renews
  only reported attempts, guarded by `node`, `status='running'` and (when the
  entry carries it) `claim_token`; unreported attempts are not renewed and are
  reclaimed by the existing expiry path (lease window, no eager requeue).
  Legacy body without `running` keeps node-wide renewal + one-time
  `node_heartbeat_legacy` warning event.
- Completion (C2): before accepted any result while `claim_token` matched and
  status was `running|cancelling`, even past `lease_until`. After: the same
  transaction re-reads the row, checks token + status (+ per-node identity when
  a node credential is used) + lease; expired lease triggers `reclaimExpired`
  in-transaction and an explicit rejection (`task_result_rejected_expired`).
  `cancelTask` on an expired running task finalises `cancelled` immediately;
  cancellation confirmation after expiry is rejected but the terminal state is
  already `cancelled` (no reopening).
- Identity (C3): before one shared token, client-declared node id (any holder
  could impersonate any node id). After: optional `CITADEL_NODE_TOKENS`
  (`nodeId:token` list) binds a credential to one node id; claim/heartbeat must
  declare that id (403 otherwise) and result reports additionally require the
  task's `node` to match (403). When the map is configured the shared
  `CITADEL_NODE_TOKEN` is ignored for worker endpoints (warning at startup, no
  silent downgrade). Sessions keep full worker access (orchestrator trust).
  Unset map = previous behaviour, fully compatible.

### Files modified (this run)
- `server/services/taskService.js`: `parseRunningEntries`, witness-list renewal,
  legacy fallback warning, expiry-aware atomic `completeTask`, immediate
  `cancelTask` on expired lease, rejection events.
- `scripts/sentinel.js`: heartbeat sends `{id, claimToken}` entries; `runTask`
  returns the running entry (testability); header docs.
- `server/config.js`: `parseNodeTokens` + `NODE_TOKENS` (+ shared-token-ignored
  warning); exported.
- `server/routes/taskRoutes.js`: token→identity resolution, `assertNodeIdentity`
  on claim/heartbeat, `expectedNode` on result, 403 support (`sendError`).
- Tests new: `tests/task-leases.test.js`, `tests/task-node-identity.test.js`.
- Tests extended: `tests/sentinel.test.js` (witness list),
  `tests/hardening.test.js` (per-node token parsing).
- Docs: `README.md`, `.env.example`, `docs/architecture.md`,
  `scripts/sentinel.js` comment, this ledger.

### Tests executed (real commands, real results)
- `npm test` (baseline, before changes): 141/141 pass, 0 fail.
- `node --test tests/task-leases.test.js`: 14/14 pass (the 6 C1 cases + 8 C2
  cases incl. expiry/requeue, exhausted attempts, stale-token-after-new-attempt,
  cancelled-terminal, expired-cancel).
- `node --test tests/task-node-identity.test.js`: 7/7 pass (own-node act,
  cross-node claim/heartbeat 403, cross-node result 403, revoked token 401,
  shared token ignored 401, session compatibility, no claimToken in list).
- `node --test tests/sentinel.test.js`: 3/3 pass (overlap guard, guard reset,
  witness list with claim token).
- `node --test tests/task-node-identity.test.js tests/hardening.test.js
  tests/tasks.test.js tests/task-node-auth.test.js`: 39/39 pass.
- `npm test` (final, full, re-run after all code/doc edits): 164/164 pass,
  0 fail (~25 s). No pre-existing failures observed. `git diff --check` clean.

### Compatibility / migration
- New optional env `CITADEL_NODE_TOKENS`; unset = previous shared-token/session
  behaviour. Setting it requires each sentinel to use its own token (same env
  name `CITADEL_NODE_TOKEN`) and a distinct `CITADEL_NODE` matching the map.
- Heartbeat contract is additive: object entries preferred, plain id strings and
  a missing list still work (missing list logs a legacy warning).
- No schema change, no data migration; `npm run doctor`/fresh installs
  unaffected. Existing sessions, cookies, proxy trust and install defaults
  untouched.

### Residual risks (explicitly accepted / documented)
- Shared-token mode (default when `CITADEL_NODE_TOKENS` is unset) still allows a
  token holder inside the trust perimeter to declare any node id. This is the
  documented single-operator model; use per-node tokens to remove it.
- A sentinel restart that orphans a still-running child cannot be distinguished
  from a dead process: the task loses its lease at expiry and may run twice.
  The sentinel is designed to survive restarts under tmux; `CITADEL_TASK_ID`
  lets agents make work idempotent.
- Legacy clients that omit the witness list keep node-wide renewal until
  upgraded (warning event `node_heartbeat_legacy`).
- C3 is stateless env configuration: revocation/rotation requires a server
  restart (documented). No PKI was introduced.

### Human decisions needed
- None blocking.

## 19. Release v0.17.1 (this run, explicitly requested by the user)
- Version bump: `0.17.0` → `0.17.1` (patch: bug fixes + opt-in hardening, no
  breaking API/schema changes).
- Commits: `fix(task-mesh): bound leases to live attempts, enforce expiry
  authority and node identity binding`; `chore(release): v0.17.1`.
- Tag `v0.17.1` pushed to `origin` together with `main`.
- No deploy performed (release = git tag/version only).
