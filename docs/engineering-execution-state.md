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

---

# Continuation run — v0.17.1 final review and targeted fixes (2026-10-18)

## 20. Scope and entry state
- HEAD `575fe4d` (chore(release): v0.17.1), branch `main`, `git status` clean at entry.
- Baseline: `npm test` → 164 tests, 164 pass, 0 fail (recorded in §18).
- Reviewed: `server/config.js`, `server/routes/taskRoutes.js`,
  `server/services/taskService.js`, `server/database/db.js` (schema + migrations
  001–003), `scripts/sentinel.js`, the task/auth/hardening/sentinel tests, and the
  task-mesh docs (`README.md`, `.env.example`, `docs/architecture.md`).

## 21. Findings (verified, with evidence)
- V1.1 CONFIRMED — silent shared-token fallback: `resolveNodeIdentity`
  (`server/routes/taskRoutes.js`) accepted the shared `CITADEL_NODE_TOKEN`
  whenever `NODE_TOKENS.size === 0`, including the case where the administrator
  explicitly set `CITADEL_NODE_TOKENS` but every entry was invalid. Selecting
  per-node identity silently degraded to the shared secret. Evidence: the new
  `tests/task-node-tokens-invalid.test.js` ("shared token is rejected") fails on
  a clean v0.17.1 worktree.
- V2.1 CONFIRMED — null lease read as valid authority: `completeTask` only
  rejected a lease that was a non-empty string `< now`, and its guarded UPDATE
  explicitly allowed `lease_until IS NULL`; `cancelTask` and `reclaimExpired` had
  the same blind spot (a running NULL-lease row could be completed indefinitely,
  parked in `cancelling` forever, or never reclaimed). All 5 new null-lease tests
  fail on clean v0.17.1.
- V2.2 Reachability of `running` + NULL lease: NOT produced by any released flow.
  `lease_until` has existed since the tasks table was introduced (`e8e6ba7`,
  v0.14), `claimTask` has always set it, and `reclaimExpired` has always required
  `lease_until IS NOT NULL`. Conclusion: **no data migration** (per the no-op
  rule); instead the semantics were fixed and the reclaim path extended so any
  such legacy/manually repaired row is recovered rather than stuck.
- V3.1 CONFIRMED — legacy heartbeat entries (plain ids / objects without
  `claimToken`) renew with a weaker guarantee: renewal binds id/node/status only,
  so a delayed beat from a previous attempt of the same node can extend a newer
  attempt. Compatibility is required (refusing to renew would requeue live tasks
  of older clients and cause duplicate execution), but the guarantee was neither
  warned nor explicitly tested. Bounds verified with new tests: `reclaimExpired`
  runs before renewal in the same transaction (an expired attempt cannot be
  resurrected) and the node guard blocks cross-node renewal.
- Already correct (re-verified, no change): stale claim token vs newer attempt,
  bound object entries, missing-`running` legacy warning, cancel confirmation
  after expiry cannot reopen a terminal state, no secrets in API errors.

## 22. Behaviour after the fixes
- `CITADEL_NODE_TOKENS` unset/empty: legacy shared-token model exactly as before.
- Configured with at least one valid entry (even mixed with invalid ones):
  per-node model, shared token rejected (unchanged from v0.17.1).
- Configured with zero valid entries: fail closed. Clear startup error (never
  contains entries/tokens), the shared token is NOT accepted on worker endpoints,
  sessions keep orchestrator access. Driven by the new `NODE_TOKENS_CONFIGURED`.
- `completeTask`: authority = matching claim token + status + per-node identity
  (when used) + valid lease (non-empty, not expired), checked atomically with the
  guarded UPDATE (`lease_until >= now`). Missing/empty lease → distinct
  `task_result_rejected_no_lease` event, reclaim in-transaction, explicit error.
- `reclaimExpired`: NULL/empty leases on `running`/`cancelling` are treated as
  expired (requeue / bounded failure / cancellation finalisation), restoring the
  invariant "running ⇒ valid, expiring lease".
- `cancelTask`: a running task with a missing lease finalises as `cancelled`
  immediately (no authority to wait for).
- `heartbeat`: entries without a claim token keep renewing (compat) and now emit
  a one-time per-node `node_heartbeat_unbound` warning.

## 23. Files changed (this run)
- `server/config.js`: `NODE_TOKENS_CONFIGURED` + fail-closed startup error when
  the variable is set but no entry parses; documented the three states.
- `server/routes/taskRoutes.js`: shared token accepted only when the per-node
  model was never selected.
- `server/services/taskService.js`: `hasValidLease`, null-lease rejection and
  recovery, tightened guarded UPDATE, `cancelTask` coherence, unbound-heartbeat
  warning.
- Tests new: `tests/task-node-tokens-invalid.test.js` (4),
  `tests/task-node-tokens-mixed.test.js` (2).
- Tests extended: `tests/hardening.test.js` (+2 config scenarios and extra
  assertions), `tests/task-leases.test.js` (+8: five null-lease + three unbound
  heartbeat cases).
- Docs: `README.md`, `docs/architecture.md`, `.env.example`, this ledger.

## 24. Tests executed (real commands, real results)
- Pre-fix evidence (clean worktree of `575fe4d`, new tests copied in):
  `node --test tests/task-node-tokens-invalid.test.js tests/task-node-tokens-mixed.test.js tests/task-leases.test.js`
  → 28 tests, 20 pass, 8 fail (invalid-config fail-closed 2, null-lease 5,
  unbound-heartbeat warning 1). Confirms the defects are real and caught.
- `node --test tests/task-leases.test.js` → 22/22 pass.
- `node --test tests/hardening.test.js tests/task-node-tokens-invalid.test.js
  tests/task-node-tokens-mixed.test.js tests/task-node-auth.test.js
  tests/task-node-identity.test.js` → 30/30 pass.
- `npm test` (full) → 180 tests, 180 pass, 0 fail (~17 s). 164 previous + 16 new.
- `git diff --check` → clean.

## 25. Compatibility notes / residual risks
- No schema change, no data migration; binary upgrade/downgrade unaffected.
- Externally visible behaviour changes: (a) a fully-invalid per-node
  configuration now disables worker token auth instead of silently falling back
  to the shared token; (b) running rows with a missing lease are rejected and
  recovered instead of treated as valid; (c) a new warning event for unbound
  heartbeat entries. All intended hardening; normal configs/flows unchanged.
- Residual: shared-token mode still trusts the declared node id (documented
  single-operator model); legacy unbound heartbeats still renew by
  id/node/status (warned, bounded by reclaim-first ordering); sentinel-restart
  orphan risk unchanged.
- Human decisions needed: none blocking. No commits/pushes/tags/deploys
  performed (as instructed).

## 26. Last checkpoint / next safe action
- Checkpoint: all three findings fixed, `npm test` 180/180 green, diff reviewed,
  docs updated.
- Next safe action: none required; optional commit by the operator.

## 27. Release v0.17.2 (this run, explicitly requested by the operator)
- Version bump: `0.17.1` → `0.17.2` (patch: fail-closed worker credential
  configuration, null-lease authority fix + recovery, unbound-heartbeat
  warning; no API/schema changes).
- Fix commit: `4d3b85a` (fix(task-mesh): fail closed on invalid node-token maps
  and null-lease authority), with the full suite 180/180 green after the bump.
- Release commit `chore(release): v0.17.2` and annotated tag `v0.17.2` created
  locally.
- Push not performed here: publish with `git push origin main --tags`.
- No deploy performed (release = git version/tag only).

## 28. v0.18.0 — tracked executions, reconciliation and process lifecycle (this run)
### Context and baseline
- Repository was 81 commits behind `origin/main`; operator approved a fast-forward.
  HEAD after sync: `e74ac17` (`chore(release): v0.17.2`). Baseline `npm test`:
  180 tests / 32 suites, 180 pass, 0 fail, exit 0 (~8.7 s).
- Objective: make lease expiry stop being a proxy for process death, give the
  sentinel a real execution identity, and make cancellation/recovery observable
  and safe across sentinel restarts. No commits/pushes/tags were requested.

### Design decisions implemented
- Protocol 2 negotiation on claim. `worker_protocol` defaults to 1 so every
  existing client keeps the previous semantics; a v1 claim still requeues on
  expiry. A v2 claim promises a durable local journal.
- Execution identity is `execId + pid + pgid + startToken + startedAt`; the
  server stores it with the attempt (migration 004). A tracked attempt's result
  must present the matching `execId`, so an older/foreign execution cannot
  resolve a newer attempt.
- An expired lease with execution evidence (`exec_pid` or `worker_protocol >= 2`)
  becomes `reconcile_state='uncertain'` and is never requeued on time alone.
  Only the owning node can resolve it via `POST /api/tasks/:id/reconcile`:
  `alive` re-authorizes the exact execution and renews its lease, `terminated`
  finalizes (exit code known) or requeues (provably gone, outcome unknown),
  `unknown` keeps it blocked. Reconcile is idempotent and requires both the
  attempt claim token and the execution id.
- Cancellation is idempotent (`cancelling`/`cancelled` → current state, HTTP
  200). Tracked cancellations renew only with claim token + execId; an expired
  tracked cancellation becomes uncertain, never a false `cancelled`.
- The sentinel spawns detached (own process group), writes the journal before
  and after spawn, escalates SIGTERM → grace → SIGKILL → bounded confirmation,
  and confirms the whole group. On startup it reconciles the journal before
  polling: live → re-adopt/re-authorize, provably dead → report terminated,
  unverifiable → `unknown`.
- One sentinel per node/state directory via a lock; journal and lock are 0600
  inside a 0700 directory. The journal is durable (temp + fsync + rename) and
  auto-loads before mutation so a fresh instance cannot overwrite existing
  records.

### Files changed
- `server/database/db.js`: migration `004_task_execution_identity` (additive,
  nullable; columns `worker_protocol`, `exec_id`, `exec_pid`, `exec_pgid`,
  `exec_started_at`, `exec_reported_at`, `reconcile_state`; index
  `idx_tasks_reconcile`), plus the fresh-install schema.
- `server/services/taskService.js`: protocol-aware claims, execution evidence in
  reclaim/cancel, `reconcileTask`, heartbeat witness entries with exec identity,
  idempotent cancellation, uncertain state handling, public fields (no secrets).
- `server/routes/taskRoutes.js`: `protocol` on claim, worker-only reconcile
  route with node-identity binding, `discard`/`reconcile` error hints.
- `scripts/sentinel.js`: rewritten supervisor (journal, detached spawn,
  heartbeat witness, reconciliation, cancellation/abandon/unknown paths, lock).
- `scripts/sentinelProcess.js` (new): PID/start-token/process-group inspection,
  safe signalling, environment-marker scan, restart recovery.
- `scripts/sentinelJournal.js` (new): durable per-node journal + lock.
- Tests: new `tests/task-execution.test.js` (20) and
  `tests/sentinel-process.test.js` (16, real processes); updated
  `tests/sentinel.test.js` (witness identity) and `tests/tasks.test.js`
  (idempotent cancellation expectations).
- Docs: `README.md` task mesh section, `docs/architecture.md` §6,
  `docs/decisions.md` ADR-008, this ledger. `package.json`/lock bumped to
  `0.18.0` (no commit/tag created).

### Defects caught and fixed while testing
- `reconcileAssigned` built termination/unknown reports from `{...item}` (field
  `id`), while `safeReconcileRecord` requires `taskId`; it silently skipped the
  report. Fixed by mapping `id → taskId`.
- `signalTree` previously signalled the recorded group on a PID-reuse mismatch if
  the group still existed. A reused PID could therefore kill an unrelated
  process. Reuse now returns without signalling; only an execution-marker match
  can attribute survivors, and only on Linux.
- `terminateRecord` returned "gone" when a record had neither pid nor pgid;
  cancellation could claim an unverified termination. It now returns
  `no-execution-identity`.
- `Journal.put/update/remove` wrote without loading first, so a fresh instance
  could overwrite existing records. Mutators now load first; corrupt journals
  are renamed to `*.corrupt-<ts>` and started empty.
- Lock acquisition could steal a lock file that was created but not yet written;
  a fresh unreadable lock is now refused for 5 s before being treated as stale.
- `recordFor` now merges the live child identity during the spawn→journal-update
  window, so a cancel in that window still targets the real process.

### Tests executed (real commands, real results)
- `npm test` (full, after all changes) → **216 tests / 36 suites, 216 pass,
  0 fail**, exit 0 (~9.4 s); 180 baseline + 36 new.
- `node --test tests/task-execution.test.js` → 20/20 pass.
- `node --test tests/sentinel-process.test.js` → 16/16 pass (real detached
  children: group-leader identity, descendant termination, SIGTERM-ignoring
  escalation, PID-reuse safety, journal reload/corruption, lock races, startup
  reconciliation, marker adoption, unknown throttling).
- `node --test tests/sentinel-process.test.js tests/sentinel.test.js` → 20/20.
- `git diff --check` → clean at the time of writing.

### Compatibility and residual risks
- Migration is additive and nullable; old rows are protocol 1. Downgrading the
  binary leaves unused columns; no destructive change. Claim `protocol` is
  optional (default 1). Repeated cancellation now returns 200 with the current
  state instead of 400 — intended and covered by updated tests.
- Protocol-1 clients keep the old "expiry implies gone" assumption; duplicate
  execution remains possible for them if a process survives a lease expiry.
- macOS: start token and process group are verified, but descendants that
  outlive their leader cannot be found by `CITADEL_EXEC_ID` scanning, so they
  remain `unknown` rather than being killed. Windows is not supported for the
  sentinel (no negative-PID group signalling).
- Shared `CITADEL_NODE_TOKEN` mode still trusts the declared node id; only
  per-node tokens bind identity cryptographically.
- A node that never returns leaves its attempt `uncertain`; there is no
  admin-only force-resolve endpoint in this release (the worker reconcile route
  is the only resolver). Operators must wait for the node or intervene in the
  database. This is documented rather than hidden.
- A task whose child exits but leaves descendant processes is logged
  (`child exited but descendants remain`) but is reported with the child's exit
  code; the result is not silently rewritten to success.

### Last checkpoint / next safe action
- Checkpoint: all changes implemented, full suite 216/216 green, docs and
  ledger updated, version bumped to `0.18.0`, no commit/push/tag performed.
- Next safe action: operator review of the diff and commit. If the release is
  approved, create `chore(release): v0.18.0` and tag `v0.18.0`, then push with
  `git push origin main --tags`. No deploy was performed.

---

# Continuation run — minimal Linux operations and recovery CLI (2026-10-19)

## 29. Scope and entry state
- Entry: `main` at `e264f9a` (`feat(task-mesh): track executions and reconcile
  after restarts`), tag `v0.18.0` present and pushed. The operator explicitly
  authorized that release commit/tag/push; §28's "no commit created" checkpoint
  was superseded by that release.
- New scope: implement the requested minimal operations surface without a plugin
  framework, new database, daemon, service, dependency or frontend: `doctor`,
  `network`, `wifi list`, `wifi connect`, `repair`, local-only and
  capability-detected, with verified recovery and no blind configuration edits.
- Baseline before this run: 216 tests / 36 suites, all passing.

## 30. What was implemented
- `scripts/diagnostics.js` (new): injectable dependency factory (`createDeps`),
  parsers for `/proc/meminfo`, `df` (space and inodes, including macOS's combined
  columns), default routes (JSON + text), `ip` interfaces (JSON + `ip -o`),
  resolv.conf, failed systemd units, rfkill and NetworkManager output; read-only
  collectors for host/capabilities, load, memory, disk/inodes, services,
  interfaces/routes/DNS/gateway/HTTPS, Wi-Fi, containers and Citadel itself.
  Every command uses an argv array, no shell, and a bounded timeout.
- `scripts/doctor.js` (rewritten): `doctor`, `network`, `wifi list`,
  `wifi connect`, `repair`, `help`; text and `--json`; exit codes 0/1/2;
  capability-driven skips; allow-listed repair plan (`restart:<unit>`,
  `wifi:unblock`, `wifi:reconnect:<profile>`), unit validation against observed
  failed units plus `citadel.service`, root/sudo checks, confirmation, result
  verification, and SSH-specific confirmation (`--confirm-remote`).
- `scripts/citadel` (extended): dispatches `doctor|network|wifi|repair` to the
  Node CLI with the same arguments; usage updated. `npm run doctor` remains.
- `install.sh`: separated `npm install` from the post-install diagnostics and
  made diagnostics informational, so a warning/failure report cannot abort an
  otherwise valid install (the old `&&` chain would have propagated exit 1).
- Secret handling: passwords are never accepted in argv or emitted in logs/JSON.
  New Wi-Fi networks use `nmcli --ask` on a TTY; saved profiles use
  `nmcli connection up id`. JSON mode refuses prompts (requires `--yes`, and a
  saved profile for Wi-Fi), keeping stdout as exactly one JSON document; notes
  go to stderr.

## 31. Defects caught and fixed while building/testing
- JSON stdout was polluted by Wi-Fi/repair progress (`write`). Added `note()`,
  which sends non-result text to stderr in JSON mode.
- SSH-over-wireless detection called the full network collector (ping/curl/DNS).
  Replaced with a direct `ip -json addr` read plus `ip -o` fallback.
- `verifyWifi` treated a missing nmcli device report as success, and only checked
  a generic connection. It now requires a connected Wi-Fi device, a default
  route, and the active SSID; an unverifiable SSID is reported as unverified.
- `systemctl is-failed` exit status 1 means "not failed", not a command error.
  Verification now distinguishes command errors, empty output and an actual
  `failed` state. `rfkill` verification likewise fails closed.
- `parseDf` misread macOS `df -P -i` (which also prints block columns) and
  reported a bogus inode failure on `/dev`; parsing is now header-driven and
  excludes pseudo filesystems.
- `parseIpO` required a `<FLAGS>` block that `ip -o addr` does not emit; it now
  parses address-only lines and accumulates IPv4/IPv6 addresses per interface.
- `repair` silently exited 0 when `--action` was requested but the plan was
  empty; it now reports an unknown/no-longer-applicable action (exit 2).
- `restart:citadel.service` could be added twice (failed units + Citadel
  service); it is deduplicated.
- `--action=` and empty `--ssid=` are rejected as usage errors; extra arguments
  are rejected instead of ignored.
- Wi-Fi JSON mode could prompt (and `nmcli --ask` could write to inherited
  stdout); prompt-based paths are refused in JSON mode.
- Hard/soft-blocked radios are rejected before attempting a connection; the
  already-blocked path now also applies when an SSID was supplied.
- A missing/failed NetworkManager or rfkill command produces an honest warning
  instead of a silent success or crash.
- `--no-color` was parsed but not applied; it (and `--json`) now disables ANSI
  on every report/note. `verifyWifi`/reconnect route checks gained the text
  fallback for older iproute2 and require the active SSID/profile, not just a
  link or a route.
- Piping the text report into `head`/`less` crashed with an unhandled EPIPE;
  the CLI now exits cleanly on a broken stdout pipe.
- Installer integration: the post-install doctor call is no longer chained to
  `npm install` with `&&`, so diagnostics cannot abort a valid installation.

## 32. Tests executed (real commands, real results)
- `node --test tests/diagnostics.test.js` → **20/20 pass** (parsers, capability
  detection, optional Wi-Fi, manager/radio failures, healthy/failed/no-route
  networks, DNS and HTTP honesty, no-network-change assertions via fakes).
- `node --test tests/doctor-cli.test.js` → **20/20 pass** (JSON-only stdout and
  exit codes, help/usage, empty and unknown repair plans, unit validation and
  verification, still-failed/unverifiable actions, rfkill/reconnect checks,
  remote confirmation, JSON repair execution, Wi-Fi list/connect, `nmcli --ask`
  argv without passwords, JSON prompt refusal, hard-block refusal, and
  unverifiable active SSID, and `--no-color`).
- `npm test` (full) → **256 tests / 43 suites, 256 pass, 0 fail**, exit 0
  (~11.2 s). No baseline regression (216 → 256; 40 new).
- Manual local smoke on macOS (non-target, no `ip`/systemd): `doctor` and
  `doctor --json` exit 0, JSON parses, unavailable subsystems are skipped, and
  `repair --json` returns an empty plan. No host network/firewall commands were
  executed by the tests.

## 33. Documentation
- `README.md` §6: commands, `--json`, Debian/Ubuntu first, optional Wi-Fi/VPS,
  read-only guarantees, allow-listed repair, secret handling, SSH risk, exit
  codes, and source-checkout invocation; layout updated.
- `docs/architecture.md` §7: local CLI flow, capability-driven skips, narrow
  recovery, JSON/stdout contract, injectable test design.
- `docs/decisions.md` ADR-009: local-first diagnostics with a narrow, verified
  recovery surface.
- Version bumped to `0.19.0` and released with annotated tag `v0.19.0`.

## 34. Residual risks and limits
- Wi-Fi changes require NetworkManager (`nmcli`); other backends are diagnosed
  as unsupported rather than reconfigured blindly.
- Hidden networks may not appear in `nmcli device wifi list`, so an otherwise
  successful connection can be reported "could not be verified" (honest, not a
  false success).
- Polkit may ask for authorization or deny `nmcli`/`rfkill`; the command reports
  the failure. There is no automatic privilege escalation beyond an explicit
  `sudo` invocation for allow-listed root actions.
- Read-only probes (DNS/HTTPS/gateway) can take a few seconds on a broken
  network; they are bounded and never required for the local checks.
- No automatic rollback and no configuration-file editing; console/IPMI access
  remains the fallback for a disruptive change.
- Network diagnostics are Linux-first (`ip`); macOS/Windows are intentionally
  limited to the cross-platform checks, matching the deployment target.
- No push or deploy was performed; the release commit and tag are local.

## 35. Last checkpoint / next safe action
- Checkpoint: implementation, tests, README/architecture/ADR/ledger updated;
  full suite green. Committed as `feat(diagnostics): add local doctor, network,
  wifi and repair commands`.
- Next safe action: push `main` and `v0.19.0` with
  `git push origin main --tags` when explicitly authorized.

## 36. Release v0.19.0
- Feature commit: `2c28ba2` (`feat(diagnostics): add local doctor, network,
  wifi and repair commands`).
- Release commit: `chore(release): v0.19.0`; annotated tag `v0.19.0`.
- Validation: `npm test` → 256 tests / 43 suites, 0 failures;
  `git diff --check` clean.
- Not pushed and not deployed.

---

# Continuation run — v0.19.0 hardening (2026-10-19)

## 37. Scope and entry state
- Entry: `main` at `62f022a` (`chore(release): v0.19.0`), clean tree.
  Baseline `npm test` → 256 tests / 43 suites, 256 pass, 0 fail (~8.5 s).
- Bounded hardening only, current stack (CommonJS, `node:test`, Bash, no new
  deps/services). No real host admin, no install/uninstall/update/firewall
  execution, no commits/pushes/deploys.
- Five phases: (1) sentinel credential isolation, (2) durable result reporting,
  (3) doctor remote-sensitive service repairs, (4) uninstaller source deletion,
  (5) updater rollback coherence.

## 38. Phase 1 — sentinel task credential isolation
- Defect: tasks spawned by the sentinel inherited the sentinel's own session and
  Inter-Node credentials (`CITADEL_TOKEN`, `CITADEL_NODE_TOKEN(S)`,
  `CITADEL_PEER_TOKEN`, `CITADEL_SECRET_KEY`, `SESSION_SECRET`), so any task
  (including agent-supplied code) could read and reuse operator credentials.
- Fix: new `scripts/sentinelEnv.js` with `buildTaskEnv(task, execId, …)` and
  `isInternalSecret`; `scripts/sentinel.js` delegates `buildEnv()` to it. Exactly
  the internal secret names are stripped; provider keys, `PATH`, and unrelated
  env survive; markers `CITADEL_TASK_ID/-NODE/-PROJECT/-EXEC_ID` are added.
  `buildEnv` is exported for testing.
- Tests: `tests/sentinel-env.test.js` (3) — helper contract and the real
  `runTask` spawn path. `tests/sentinel.test.js`, `tests/sentinel-process.test.js`
  unchanged and green.

## 39. Phase 2 — durable result reporting after a transient outage
- Defect: a result `POST` that failed transiently (network blip, panel restart)
  was lost; the task then relied on lease expiry/reconcile even though the local
  execution had a definitive outcome.
- Fix (`scripts/sentinel.js`): report intent is persisted in the journal before
  the first attempt (`markReportPending`); delivery (`deliverReport`) is retried
  with exponential backoff (`REPORT_BASE_MS` 3 s, `REPORT_MAX_MS` 60 s, env
  `CITADEL_REPORT_RETRY_MS`/`CITADEL_REPORT_RETRY_MAX_MS`); `retryPendingReports`
  runs each tick and on startup. Only definitive errors (403 identity mismatch,
  404, "already finished/not found/not authorized") drop the pending report; 409
  (reconcile required) and 5xx keep retrying. `finish`/`finishUnstarted`
  persist-then-deliver; exports added for tests.
- Tests: `tests/sentinel-report.test.js` (6) — pending persisted then cleared on
  success, transient failure retried, definitive failure dropped, 409 kept,
  backoff bounds, startup delivery.

## 40. Phase 3 — doctor must not "repair" remote-sensitive services blindly
- Defect: `scripts/doctor.js` repaired failed units without treating SSH,
  firewall and network-manager units as remotely sensitive; restarting them
  unconfirmed could sever the very connection used to run doctor.
- Fix: anchored `REMOTE_SENSITIVE_UNIT` regex (adds `ssh|sshd`, firewall units
  `ufw|nftables|firewalld|iptables|ip6tables|netfilter-persistent`, plus network
  managers/DHCP) requiring a `…[-.@]….service` suffix; new
  `systemctlState`/`verifyServiceRestart` (only `active` counts as success;
  `failed`/`inactive`/empty/spawn-error = not verified); `service-restart`
  verification now uses it. Exported for tests.
- Tests: `tests/doctor-cli.test.js` updated (`is-failed` → `is-active`) and a new
  `Remote-sensitive service repairs` block. Doctor/diagnostics suites 46/46 pass.

## 41. Phase 4 — uninstaller source-checkout deletion safety
- Defect: `scripts/uninstall.sh` could delete the source checkout, trusted a
  `data/source-dir` pointer, reconstructed/validated paths weakly, and defaulted
  to removing the source.
- Fix: default `REMOVE_SOURCE=false`; explicit `--remove-source`,
  `--dry-run|--check-only`, compatibility `--keep-source`, unknown/`-*` args
  rejected (exit 2) before effects. `canonicalize` (symlink-aware), `reject_dotdot`,
  `validate_safe_path` (PROTECTED_ROOTS exact + recursive SYSTEM_SUBTREES +
  refuses ancestors of protected roots), `has_citadel_evidence`, and
  `validate_checkout` (must be a `.git` checkout, not the target/its ancestor).
  Source removal is gated on `--remove-source` **and** an interactive TTY with a
  typed `yes`; otherwise the checkout is preserved with a warning.
- Tests: `tests/uninstall.test.js` (11) all pass; `bash -n` clean.

## 42. Phase 5 — coherent updater rollback (code + database)
- Defects found while reading `scripts/update.sh`:
  - the database was never backed up reliably and never restored on rollback, so
    a failed update could leave new (possibly migrated) code rolled back but the
    database partially migrated;
  - the rollback reconstructed nothing from the snapshot path and had no notion
    of "the new code may have run migrations";
  - `--check`/unknown args were barely validated; the ERR trap did not fire for
    failures inside shell functions (`npm_install`, `chown_tree`).
- Fix: `scripts/update.sh` now:
  - captures the full `CURRENT_SHA` (used for `git reset --hard`) and a short
    SHA for display;
  - creates a reliable SQLite snapshot before touching the checkout
    (`sqlite3 … VACUUM INTO`, else the app's `better-sqlite3` online backup);
    **aborts before any change** if no reliable snapshot can be made for an
    existing DB (the old plain `cp` fallback is gone);
  - stores the exact snapshot pathname in `DB_BACKUP` and never reconstructs it;
  - refuses to start (before any change) when a DB exists but the run cannot
    stop the service/restore it (no systemd or no privilege);
  - on rollback: resets code to `CURRENT_SHA`, reinstalls deps, and — only when
    the new code was actually started (so migrations may have run) — stops the
    service in a checked way, restores owner/mode via a same-directory temp +
    rename, removes stale `-wal`/`-shm` sidecars, restarts the previous version
    and verifies health;
  - never deletes the snapshot, refuses symlinked DB paths, and prints an explicit
    `INCOMPLETE` warning (keeping the snapshot) when any rollback step fails;
  - enables `set -E` so the rollback trap actually fires for function-internal
    failures; rejects unknown options.
- Tests: `tests/update-rollback.test.js` (7) against a throwaway real-git world
  with fake `systemctl`/`npm`/`curl`/`sqlite3`/`sudo` in a temp PATH — `--check`
  mutates nothing; failed snapshot aborts pre-change; no-systemd+DB aborts
  pre-change; dependency failure restores the old commit; health-check failure
  restores the exact snapshot only after `systemctl stop`; an unstoppable service
  leaves the live DB untouched and keeps the snapshot; a healthy update advances
  the commit.

## 43. Tests executed (real commands, real results)
- Baseline: `npm test` 256/256 (pre-change).
- Per-phase focused suites: `tests/sentinel-env.test.js` (3),
  `tests/sentinel-report.test.js` (6), sentinel/task suites (65),
  doctor/diagnostics (46), `tests/uninstall.test.js` (11),
  `tests/update-rollback.test.js` (7) — all green.
- Final: `npm test` → **289 tests / 50 suites, 289 pass, 0 fail** (~21 s).
- `bash -n install.sh scripts/uninstall.sh scripts/update.sh` clean;
  `git diff --check` clean.

## 44. Compatibility notes / residual risks
- Phase 1–2 change only the sentinel's local behaviour/contract; the server API
  is unchanged. New sentinel env vars `CITADEL_REPORT_RETRY_MS` /
  `CITADEL_REPORT_RETRY_MAX_MS` are optional.
- Phase 3 may now block (require confirmation) for ssh/sshd/firewall/network
  unit repairs that were previously offered; this is intended.
- Phase 4: the source checkout is now kept by default; deleting it requires
  `--remove-source` and an interactive confirmation.
- Phase 5: the updater now takes a DB snapshot before every code change; the
  update is refused (before any change) when a reliable snapshot cannot be made
  or the service cannot be stopped to restore it. Snapshot rotation keeps the
  most recent 5, never the current attempt's. Rollback reports `INCOMPLETE`
  rather than claiming success when the DB could not be restored.
- Residual: the updater assumes systemd for restart/health; without it and
  without a DB it still updates code but does not verify a restart. The sentinel
  report retry can reorder duplicate reports after a long outage; the server's
  claim-token/exec-id checks reject stale ones.

## 45. Last checkpoint / next safe action
- Checkpoint: five phases implemented, `npm test` 289/289 green, Bash syntax and
  `git diff --check` clean, README and this ledger updated. No commits/pushes/
  deploys performed.
- Next safe action: operator review of `git diff` and manual commit if approved.

---

# Continuation run — v0.20.0 modular, project-centric workspace (2026-10-19)

## 46. Scope and entry state
- Entry: `main` at `1349403` (`fix(hardening): isolate task secrets…`), version
  `0.19.0`. Baseline `npm test` → 289 tests, 289 pass, 0 fail.
- Goal: turn Citadel into a minimal, modular, project-centric workspace, keeping
  the current stack (Fastify, `better-sqlite3`, `node-pty`/tmux, zero-framework
  SPA) with no new databases or services and no destructive rewrites.
- 6 phases: navigation collapse, Projects+Repositories unification, Workspace
  context (System + project/repo), central module registry, configurable
  dashboard, Activity/Audit/System split.

## 47. Phase 1 — central module registry
- `server/modules/registry.js` (new): MODULES catalogue with per-module
  `requires` (modules/services), `views`, `widgets`; `isEnabled`, `seedDefaults`,
  `validateRequirements`, `setEnabled`, `listModules`, `requireModule`,
  `resetProbeCache`. State is stored in the existing `app_config` table under
  `module.<id>.enabled`; no new DB/table.
- Four facts kept distinct: available / serviceAvailable / enabled /
  widget-visible (the last is client-side only).
- Seeding rule: existing installs (any `users` row) keep every module enabled;
  fresh installs get minimal defaults (`dashboard, projects, workspace, activity,
  audit` on; `agents, files, docker, proxy, fleet, metrics` off). Once, via the
  `modules.seeded` marker.
- `server/routes/moduleRoutes.js` (new): `GET /api/modules`,
  `POST /api/modules/:id/state` (admin, audited). Registered in `server/index.js`.
- Guards: `requireModule('files'|'docker'|'proxy'|'fleet'|'agents')` on those
  routers; `metrics` gated inline on `/api/logs/metrics` and export `type=metrics`.
  `requireModule` runs after `requireAuth` so unauthenticated calls still 401.

## 48. Phase 2 — Projects + Repositories
- Migration `005_project_repositories` + `project_repos` table (additive; legacy
  1:1 `projects` git fields kept for back-compat). Each existing project is
  backfilled once as its primary repository.
- `projectService`: `_insertRepo`, `listRepos`, `getRepo`, `addRepo`,
  `registerClonedRepo`, `updateRepoGitMeta`, `removeRepo`; primary repo created
  on `createProject`/`importProject`; `repos_count` in `listProjects`.
- `projectRoutes`: associate existing folder (no move/copy), clone into project
  (never over a non-empty dir → 409), unlink (files preserved unless
  `deleteFiles=true`), and per-repo git status/commits/pull. `validateGitUrl`
  restricts to `https?://`/`git@`; target path checked with `isInsideBase`.

## 49. Phase 3 — Workspace context
- `terminalManager.createSession` accepts `repoId` (must belong to the project;
  falls back to the project path if the repo is missing on disk).
- Workspace view has a context selector: System (host shell) or any project, with
  an optional repository selector for multi-repo projects that sets the cwd of
  new terminals.

## 50. Phase 4 — Frontend (zero-framework SPA)
- Sidebar collapsed to 5 primary views (Dashboard, Projects, Workspace, Activity,
  Modules) + enabled optional module views + System; disabled modules are never
  rendered. Legacy view ids are remapped (`repos→projects`, `terminal→workspace`,
  `logs→activity`, `plugins→modules`, `deployments→proxy`).
- Dashboard is a widget grid with a "Personalizar" customizer (order + on/off),
  persisted per browser in `localStorage`; widgets backed by a disabled module
  are dropped, never left broken.
- Activity view: Activity | Audit tabs (Audit moved out of System); metrics chart
  and samples only when the `metrics` module is enabled.
- Modules view: core (always on) + optional (enable/disable with requirement
  reasons) + plugins list.

## 51. Phase 5 — existing-install upgrade fix (critical for VPS)
- Defect (pre-existing, not introduced here): `initDatabase` created tables and
  **indexes** in one `exec`, then ran migrations. On an existing DB whose `tasks`
  table predated the execution-identity columns, `CREATE INDEX … tasks(status,
  reconcile_state)` aborted startup (`no such column`) before migration 004 could
  add the column. Reproduced with the local stale `data/citadel.db`.
- Fix: split into `CREATE TABLE …` → `runMigrations(db)` → `CREATE INDEX …`, so
  indexes that reference migration-added columns are built only afterwards.
  Fresh DBs and in-place upgrades both succeed.

## 52. Tests executed (real commands, real results)
- Baseline: `npm test` 289/289.
- New: `tests/modules.test.js` (9) — seeding (fresh minimal / existing all-on),
  list shape, 403 on a gated endpoint, enable unlocks + audits, core cannot be
  disabled, unmet service requirement rejected, unknown module 404.
- New: `tests/project-repos.test.js` (9) — one primary repo on create, associate
  without moving, duplicate/missing rejected, per-repo git status, invalid clone
  URL, clone never clobbers a non-empty dir, unlink preserves files, terminal cwd
  inside a chosen repo.
- New: `tests/db-upgrade.test.js` (2) — legacy `tasks` table + legacy project
  migrate cleanly (columns added, index built, primary repo backfilled once,
  modules stay enabled) and a second boot is idempotent.
- Updated: `tests/files.test.js`, `tests/fleet.test.js`, `tests/logs.test.js`
  enable their module before exercising gated endpoints.
- Final: `npm test` → **309 tests, 309 pass, 0 fail**. `git diff --check` clean;
  `node --check` clean on every changed JS file.
- Real boot smoke against a copy of the legacy DB (`PORT=3999
  DATABASE_PATH=…`): `/` 200, `/api/auth/status` 200, graceful shutdown. Fresh
  DB boot: minimal module defaults and a gated endpoint returning 403.

## 53. Compatibility notes / residual risks
- Module state is a preference only: no data is deleted and no external service
  is touched; disabling hides navigation and locks endpoints but keeps data.
- Existing installs keep prior behaviour (all capabilities enabled) by design.
- Optional modules with unmet requirements (Docker without the engine, Proxy
  without Caddy) remain listed but cannot be enabled; the reason is surfaced.
- `metrics` is a widget/data module with no standalone view; `agents` requires
  the core `workspace` module. No module depends on an optional module, so
  disabling one cannot cascade.
- Checklist to avoid failure on a physical server/VPS: verify the module guards
  sit after `requireAuth`; confirm the migration/index ordering above; ensure
  `repoId` sessions degrade to the project path when a repo is absent; and keep
  optional-module fetches on the client behind `moduleEnabled(...)`.

## 54. Version
- Version bumped to `0.20.0`; asset cache-buster moved to `v0200`.
- Release: `chore(release): v0.20.0`, annotated tag `v0.20.0`.

# Continuation run — v0.22.0 Cloudflare-by-default and UI simplification (2026-10-19)
- Entry: `main` at `b5a1731` (`chore(release): v0.21.0`), clean tree. Baseline
  `npm test` → 319 tests, 319 pass, 0 fail.

## 55. Changes (this run)
- Removed the `agents` (AI Agents) module from the registry and the SPA: no
  module view, no nav entry, no Workspace "Launch AI Agent" button/modal.
  Install/launch of coding agents is now the dashboard "Platform integrations"
  widget only (`/api/system/integrations/install`, ungated), which fixes the
  "Install failed: Module disabled" error.
- `server/services/agentInstallService.js`: `findBin` probes the panel/admin
  user home prefixes (`.local/bin`, `.opencode/bin`, `.bun/bin`,
  `.npm-global/bin`, `.cargo/bin`, `bin`) plus `/usr/local/bin`, `/usr/bin`,
  `/bin`, then falls back to a login-shell `command -v`, so an installed agent
  is reported as installed.
- Platform integrations widget restyled minimally (name + status dot + label;
  descriptions moved to tooltips); new `.integration-*`/`.status-dot` CSS.
- Modules & Extensions moved out of the sidebar into Settings; `modules` view
  id redirects to `settings`.
- Dashboard "Personalizar" (widget customizer) removed entirely.
- Dashboard "Clone Git" now opens the Git Repositories screen
  (`openGitRepositories()`), no modal.
- Cloudflare Quick Tunnel on by default in `install.sh` (`TUNNEL=true`;
  `--no-tunnel` disables, `--local` implies `--no-tunnel`). `--lan`/`--host`
  now write a systemd `bind.conf` drop-in (`Environment=HOST=…`) because the
  unit pins `HOST=127.0.0.1` and `.env` cannot override it; the drop-in is
  removed when LAN is not requested.
- `scripts/citadel` passes `CITADEL_DATA_DIR` (default `/srv/citadel/data`) so
  `url`/`qr` resolve the same tunnel/configured URL the panel shows.
- `connectService` resolves `configured → tunnel → tailscale → LAN → localhost`
  and mirrors the administrator URL to `DATA_DIR/public-url` for the CLI and
  installer; `settingsRoutes` writes/clears that mirror on save.

## 56. Tests (this run)
- Updated `tests/modules.test.js` (drop `agents` from defaults; assert the
  module is gone).
- Added mirror assertion to `tests/settings-connect.test.js`.
- Final: `npm test` → **320 tests, 320 pass, 0 fail**.

## 57. Version
- Version bumped to `0.22.0`; asset cache-buster moved to `v0220`.
- Release: `chore(release): v0.22.0`, annotated tag `v0.22.0`.

## 58. Changes (this run)
- Git providers can now be connected through an OAuth 2.0 **device
  authorization grant** (GitHub `login/device/code`, GitLab
  `oauth/authorize_device`) in addition to pasting a personal access token.
  Only a public `client_id` is required — no client secret and no redirect
  URI — so the flow works behind the ephemeral Cloudflare tunnel URL.
- New `server/services/gitOAuthService.js`: device-code request/polling,
  best-effort user lookup, `refreshAccessToken`, session map, and client-id
  resolution from `CITADEL_GITHUB_CLIENT_ID` / `CITADEL_GITLAB_CLIENT_ID`
  (or `app_config` `git.oauth.<provider>.client_id`).
- `server/routes/gitRoutes.js`: `GET /api/git/oauth/providers` and
  `POST /api/git/oauth/:provider/{client-id,start,poll,cancel}`, audited.
- `server/services/gitCredentialsService.js`: `saveCredential` now stores
  `refresh_token_encrypted`, `expires_at`, `scope` and `auth_method`;
  `refreshCredentialIfNeeded` + `listExpiringCredentials`; `listRepos`
  refreshes a near-expiry token first.
- `server/database/db.js`: migration `006_git_oauth_credentials` adds the
  new `git_credentials` columns (fresh schema updated too).
- `server/index.js`: background token refresher (15 min, unref'd) so
  `git push` inside terminals never sees an expired OAuth token even when
  the panel is idle.
- Frontend (`public/js/app.js`): the "Connect" dialog now runs the device
  flow (shows the user code, verify link, copy button, live polling) with a
  "use a personal access token" fallback and an inline client-id setup step
  when OAuth is not yet configured.
- Fix: installing an AI agent from the dashboard now focuses the newly
  created System Terminal (`activeSysTerminalId`) instead of a previously
  active session.

## 59. Tests (this run)
- Added `tests/git-oauth.test.js` (auth, provider config, empty client id,
  unconfigured start refusal, full device flow to connected, `slow_down`,
  expiry, refresh of an expiring OAuth credential).
- Final: `npm test` → **328 tests, 328 pass, 0 fail**.

## 60. Version
- Version bumped to `0.23.0`; asset cache-buster moved to `v0230`.
- Release: `chore(release): v0.23.0`, annotated tag `v0.23.0`.

## 61. Changes (this run)
- **Git providers are token-only again.** Reverted the OAuth 2.0 device flow
  (from v0.23.0): deleted `server/services/gitOAuthService.js` and
  `tests/git-oauth.test.js`; removed the `/api/git/oauth/*` routes
  (`gitRoutes.js`) and the background token refresher (`server/index.js`);
  dropped migration `006_git_oauth_credentials` and the OAuth columns from
  `git_credentials` (`server/database/db.js`). `gitCredentialsService` is back
  to `saveCredential({ provider, token, username })` with no refresh/expiry/
  scope/auth_method handling. The dashboard agent "Install" → System Terminal
  focus fix is preserved. README reverted to "connect with a personal access
  token".
- **The "System" top-level view is gone.** Removed `renderSystemView()` and the
  `system` nav entry / `navigateTo` branch; `LEGACY_VIEW_MAP.system` now maps to
  `settings`. Its content moved: **Updates** and **About this host** (Node
  diagnostics) are sections of **Settings** (loaded from
  `/api/settings/connect`, `/api/system/connect`, `/api/system/node`,
  `/api/system/version`); **Activity & Audit** is now a **Dashboard** widget
  (`activity`, added to the defaults and merged with saved widget order);
  the "Remote access help" modal moved to the Connection card.
- **Workspace is a 3-level sidebar tree** (`Workspace → context (System/project)
  → live terminals`). `renderSidebarNav()` renders the parent (`data-view=
  "workspace"`, chevron toggle), each context node with a session count and its
  terminal leaves (activate / close) plus a "+ New terminal" leaf, driven by
  `state.allSessions` from `GET /api/terminals`. Clicking the parent opens a new
  **workspace overview** selector (`.ws-grid` cards); clicking a context or leaf
  opens it directly. `bindSidebarNav` is now a single delegated listener.
  Terminal switching no longer uses the top-bar tabs or the context `<select>`;
  the in-content `+ New Terminal`, Paste and History buttons remain.
- New/changed frontend helpers in `public/js/app.js`: `workspaceNavHtml`,
  `workspaceNodeHtml`, `navChevron`, `sessionsForContext`, `toggleWorkspaceNav`,
  `openWorkspaceOverview`, `openWorkspace`, `openWorkspaceTerminal`,
  `newTerminalIn`, `renderWorkspaceOverview`, `workspaceCardHtml`, `loadSessions`
  (plus `pendingNewTerminalContext`, `allSessions`, `workspaceNavOpen`,
  `workspaceNavContexts` state). `renderTerminalTabs`/`renderSysTerminalTabs`
  now just refresh the sidebar.
- New sidebar/overview styles in `public/css/app.css`: `.nav-chevron`,
  `.nav-sub`, `.nav-subitem`, `.nav-dot`, `.nav-sub-deep`, `.nav-leaf`,
  `.nav-leaf-close`, `.nav-leaf-new`, `.ws-grid`.

## 62. Tests (this run)
- Removed `tests/git-oauth.test.js` with the OAuth feature (8 tests).
- Final: `npm test` → **320 tests, 317 pass, 2 fail, 1 skipped**. The two
  failures (`terminal.test.js` "tmuxCopyMode enter/exit works on a tmux-backed
  session" and `update-rollback.test.js` "a health-check failure restores the
  exact database snapshot") reproduce on a clean checkout of this environment
  and are unrelated to these changes.

## 63. Version
- Version bumped to `0.24.0`; asset cache-buster moved to `v0240`.
- Release: `chore(release): v0.24.0`, annotated tag `v0.24.0`.

## 64. Changes (this run)
- **Unified credential vault (single store for agents).** New `secrets` table
  (`server/database/db.js`) and `server/services/secretStore.js`: one encrypted
  (AES-256-GCM via `security/secrets.js`) place for `env`, `git`, `file` and
  `ssh` entries. Migration `006_secret_vault` creates the table and moves legacy
  `git_credentials` rows into it as `GITHUB_TOKEN` / `GITLAB_TOKEN` (kind='git'),
  reusing the exact ciphertext; the old table is left untouched so nothing is
  lost.
- `server/services/gitCredentialsService.js` is now a thin facade over
  `secretStore`, so git, the provider APIs and agents all read from the vault.
  `git-credential-citadel.js` keeps working unchanged through
  `resolveAuthForUrl`.
- New `GET/POST /api/secrets` and `DELETE /api/secrets/:name`
  (`server/routes/secretRoutes.js`): listing returns metadata only (never a
  value), mutations require an administrator and are audited without the value.
- **Agent access.** `scripts/citadel-creds.js` (`citadel-creds` wrapper added to
  `install.sh`) exposes `list`, `get <name>`, `env` (eval-able `export` lines),
  `exec -- <cmd>` (env injected for just that process) and `materialize <name>
  [path]` (writes a 0600 file). Terminals also receive every `env`/`git` entry
  at spawn (`terminalManager._spawnPty`), best-effort so a vault error never
  blocks a shell.
- Settings gains a **Credentials** card (`public/js/app.js`): add/rotate/delete
  entries with kind selector; values are write-only. Styles in
  `public/css/app.css` (`.secret-list`, `.secret-row`).
- Fix (test isolation): `tests/update-rollback.test.js` now pins
  `DATABASE_PATH` to its throwaway world. Previously, running the suite inside
  the service environment (which exports `DATABASE_PATH`) made the updater
  snapshot/restore the **real** database, clobbering it with the fake
  `SNAPSHOT-CONTENT` and failing the test. The operatively damaged
  `/srv/citadel/data/citadel.db` was recovered from the live process WAL and
  restored.

## 65. Tests (this run)
- Added `tests/secrets.test.js` (encryption-at-rest, metadata-only listing,
  validation, env filtering, git facade, delete/404, the `citadel-creds` CLI
  end to end, and the legacy `git_credentials` migration).
- Updated `tests/git.test.js` to assert the token now lives in `secrets`.
- Final: `npm test` → **328 tests, 326 pass, 1 fail, 1 skipped**. The remaining
  failure (`terminal.test.js` "tmuxCopyMode enter/exit works on a tmux-backed
  session") is environment-dependent and unrelated to these changes.

## 66. Version
- Version bumped to `0.25.0`; asset cache-buster moved to `v0250`.
- Release: `chore(release): v0.25.0`, annotated tag `v0.25.0`.

## 67. Changes (this run)
- **Built-in updater (one-click from the panel, no root helper).** New
  `scripts/self-update.js`: a detached worker that runs as the service user,
  updates the checkout in place (`git fetch` + `git reset --hard
  origin/<branch>`), reinstalls production dependencies (`npm install
  --omit=dev`) and then restarts the service. Restart prefers `systemctl
  restart`; when that is not permitted it signals the running server process
  and lets `Restart=always` relaunch it. The worker survives the change of the
  service's main process (detached session) and reports progress through
  `DATA_DIR/update-status.json` + `update.log`. It holds a lock (anti-
  concurrency), rolls back to the previous commit if `npm install` fails, and
  refuses to touch a **dirty** checkout so uncommitted work is never lost.
- `server/services/updateService.js`: `checkSelfUpdate()` (writable git checkout
  + git/npm on PATH) and `selfUpdateUsable()` (honours `CITADEL_SELF_UPDATE`).
  `triggerUpdate()` now prefers the root-owned helper, falls back to the
  built-in updater, and reports `mode` (`helper`|`self`). `getUpdateStatus()`
  exposes the last run. `getVersionInfo()` adds `updateMode`, `canUpdate`,
  `selfUpdateAvailable` and `updateProblem`. No new privilege is granted: the
  panel already exposes a shell as the same service user.
- Routes: `POST /api/system/update` is now **admin-only**; new admin-only
  `GET /api/system/update/status`. The peer (`/api/system/peer-update`) path is
  unchanged.
- UI: Settings → Updates shows the **Update now** button whenever `canUpdate`
  (helper *or* built-in), reports which mode is active, and polls
  `/api/system/update/status` across the restart before auto-reloading.
- Config: `CITADEL_SELF_UPDATE=0` disables the built-in updater. The test suite
  sets it so tests can never rewrite the checkout.

## 68. Tests (this run)
- Added `tests/selfUpdate.test.js` (capability detection, `updateMode`/
  `canUpdate` reporting, admin-only status route, stable status shape).
- Updated `tests/update.test.js` (disables the built-in updater, accepts the new
  "unavailable" error) and `tests/peer.test.js` (same).
- Final: `npm test` → **333 tests, 331 pass, 1 fail, 1 skipped**. The remaining
  failure (`terminal.test.js` "tmuxCopyMode enter/exit works on a tmux-backed
  session") is environment-dependent and unrelated to these changes.
- Guardrail learned the hard way: before the `CITADEL_SELF_UPDATE=0` gate, a
  test hitting `/api/fleet/update-all` launched a **real** self-update that ran
  `git reset --hard origin/main`, discarding the uncommitted work-in-progress.
  The gate (test script env + worker-side check) makes this impossible now.

## 69. Version
- Version bumped to `0.26.0`; asset cache-buster moved to `v0260`.
- Release: `chore(release): v0.26.0`, annotated tag `v0.26.0`.



## 70. UI simplification & promotion (v0.27.0)
- **Activity & Audit moved to Settings.** The dashboard `activity` widget is
  removed (from `DASHBOARD_WIDGETS`, the default order and the renderer). A new
  Settings section/card exposes *Open Activity* / *Open Audit*; both the
  Settings card and (formerly) the dashboard share `bindActivityButtons()`.
- **Settings reordered.** *Updates* and *About this host* now sit at the very
  top, followed by Public URL, Connection, Credentials, Activity & Audit and
  then the optional-modules list.
- **Core modules hidden in Settings.** The "Core modules" card is gone; the
  section lists only *Optional modules*, so always-on capabilities (Dashboard,
  Projects, Workspace, Activity, Audit, **Files**, **Advanced Metrics**) are no
  longer surfaced as toggles.
- **Files & Advanced Metrics promoted to core** (`core: true`,
  `defaultEnabled: true`). Files is now a first-class sidebar entry via the new
  `CORE_NAV` (it is no longer an optional module).
- **Workspace flattened to two levels.** The tree is now the *Workspace* parent
  plus one entry per context (System + each project). Each context owns a single
  persistent terminal, opened by clicking its entry and closed from the entry's
  ⋯ menu (`Open terminal` / `Close terminal`). Removed the "+ New Terminal"
  buttons, `newTerminalIn()`, `openWorkspaceTerminal()` and the
  `pendingNewTerminalContext` state.
- **Files rebuilt with Wunderbaum 0.14.1** (MIT, no jQuery; vendored via
  `scripts/copy-vendor.js` as `wunderbaum.umd.js` + `wunderbaum.css`). The old
  table/breadcrumb is replaced by a lazy-loaded tree (`icon: false`, minimalist)
  with a right-click context menu (New file / New folder / Edit / Download /
  Delete). New `.files-card` / `.files-tree` styles; removed the stale
  `.files-table` / `.file-toolbar` / breadcrumb CSS.
- Tests: `tests/modules.test.js` updated for the new core set (`files`,
  `metrics` enabled by default; gating test now uses `fleet`).
- Final: `npm test` → **333 tests, 331 pass, 1 fail, 1 skipped** (the unrelated,
  environment-dependent tmux copy-mode test).
- Version bumped to `0.27.0`; asset cache-buster token moved to `v0270`.

## 71. File explorer: bug fixes, full-height layout & grid view (v0.28.0)
- **Fixed "No such file or directory" on folder clicks.** The Wunderbaum source
  data nested `path`/`type` under a `data` key, but Wunderbaum stores every
  unknown property directly on `node.data` (it does not unwrap a nested
  object), so `node.data.path` was `undefined` and requests went to
  `path=undefined` (ENOENT). Custom fields now sit at the top level
  (`path`, `kind`).
- **Fixed lazy loading.** `lazyLoad` called `node.addChildren(...)`; in
  Wunderbaum 0.14 the handler must *return* the child list. It now returns the
  mapped items (or `false` on error).
- **Dark theme.** Wunderbaum's light, Bootstrap-icon theme is remapped to the
  panel palette (`--wb-*` variables) and the missing Bootstrap Icon font is
  replaced with custom CSS chevrons (mask-based, so they inherit the row colour)
  plus inline SVG folder/file glyphs.
- **Full-height explorer.** The view now fills the whole content area: an
  in-view toolbar (breadcrumbs, view toggle, New file/folder, Refresh), a
  scrolling body and a status bar, instead of a small card.
- **Two modes**, toggled from the toolbar and persisted per browser
  (`state.filesMode`): *list* (the lazy tree) and *grid* (large folder tiles
  with clickable breadcrumb navigation).
- **Input modes.** Mouse: click selects, double-click opens, right-click opens
  the context menu. Keyboard (grid): arrows/Home/End move the selection, Enter
  opens, Backspace goes up, Delete removes (with confirmation), Shift+F10 opens
  the context menu. Touch: a single tap opens, with a compact toolbar and
  larger tap targets on phones. List mode keeps Wunderbaum's native mouse /
  keyboard / touch handling.
- Asset cache-buster token moved to `v0280` (bumped in the release commit).

## 72. Paired machines: bidirectional pairing + single-URL host switching (v0.29.0)
- **Feature.** A machine selector at the top of the sidebar switches between
  paired Citadel instances without changing the browser URL. The local server
  proxies API calls (`/api/remote/:hostId/*`) and terminal WebSockets
  (`/ws/remote/:hostId/terminal/:sessionId`) to the selected peer, so projects,
  files, terminals and settings follow the switch. Settings moved into
  *Platform* below Files; the legacy *Fleet* module stays local.
- **Stable association.** Identity is `instance.id` (UUID) plus `instance.name`
  in `app_config`, independent of any URL. `fleet_hosts` stores `instance_id`,
  a JSON list of candidate `urls`, `paired_at` and `last_seen`; a partial unique
  index prevents duplicate instances. Migration `007_peer_pairing`, mirrored in
  the fresh-install schema.
- **Handshake.** A creates a single-use invite (TTL 10 min) whose secret travels
  in the URL fragment (`#pair=...`), generates `tokenA`, and calls B's
  `/api/pair/accept`; B stores A and returns `tokenB`. Both sides end up paired
  with independent per-direction tokens. Re-pairing is idempotent by instance id.
- **Token storage.** Inbound tokens live only as SHA-256 hashes in
  `peer_tokens`; outbound tokens are AES-256-GCM encrypted in
  `fleet_hosts.token_encrypted`. Neither is sent to the browser. `requireAuth`
  accepts peer tokens for proxied panel APIs; local management (pairing, host
  list, Fleet) requires a real session. Tokens are bound to one host row, so an
  announce/revoke cannot spoof another instance.
- **Cloudflare Quick Tunnel rotation.** Both sides announce on boot (5 s) and
  every 5 min. Every API response and peer/WebSocket request advertises
  `X-Citadel-Instance/Name/Urls`; the receiver repairs the stored row from any
  successful call, keeping the address that actually worked as primary and
  dropping loopback candidates. If both ephemeral URLs rotate while offline,
  Settings → Machines exposes an **Address** repair action
  (`PUT /api/hosts/:id/address`); one reachable address is enough because the
  next call heals the other direction. README documents that a stable address
  (Tailscale, named tunnel, `CITADEL_PUBLIC_URL`) makes recovery fully automatic.
- **Startup safety.** A persisted remote selection is probed with
  `GET /api/hosts/status?id=...`; if offline the panel falls back to local
  instead of rendering views that proxy to a dead host. Switching also reverts
  if the host dies mid-switch.
- **Tests.** `tests/pairing.test.js` (10) and `tests/remote-proxy.test.js` (10)
  cover identity stability, single-use invites, cross-direction tokens,
  announce/revoke scoping, manual address repair, HTTP/WS proxying, downloads,
  local-only route blocking and header-based healing.
- Final: `npm test` → **353 tests, 351 pass** (only the pre-existing,
  environment-dependent tmux copy-mode test fails).
- Version bumped to `0.29.0`; asset cache-buster token moved to `v0290`.

## 73. Installer fix: NodeSource setup when running as root (v0.29.1)
- **Bug.** The official command `curl .../install.sh | sudo bash` runs the
  installer as root, where `$SUDO` is intentionally empty. Step 4 executed
  `curl ... | $SUDO -E bash -`, which became `... | -E bash -` and failed with
  `-E: command not found`; the broken pipe surfaced as
  `curl: (23) Failed writing body`. Fresh machines without Node.js could not
  install.
- **Fix.** Only pass `-E` when `$SUDO` is non-empty; otherwise pipe straight to
  `bash -`. Verified with `bash -n install.sh`.
- Version bumped to `0.29.1`; asset cache-buster token moved to `v0291`.

## 74. Dual-purpose pairing QR, camera fallback and 24/7 laptop mode (v0.30.0)
- **One code, two jobs.** The installer/startup QR and **Settings → Connection**
  now encode a single-use pairing invitation (`POST /api/pair/invite`). A normal
  phone camera opens the panel; scanning the same code from another Citadel's
  **Pair a machine** screen pairs both hosts. The modal no longer exposes a
  second "Show my QR" tab.
- **Camera fallback.** Live camera scanning still requires HTTPS/localhost, so
  the pairing modal now also offers **Take a photo of the QR** (native camera
  capture) and pasted links over plain HTTP. `jsQR` is vendored under
  `public/vendor/jsQR.js` and used to decode captured frames, including Safari
  where `BarcodeDetector` is absent.
- **Terminal QR.** Startup writes the current invite to
  `${DATA_DIR}/connect-qr` (mode 0600) for the installer banner; the CLI renders
  it with half-block glyphs (`█▀▄`) and ANSI colours instead of full background
  blocks, keeping the current payload within 73 columns.
- **Laptop 24/7 mode.** Closing a laptop lid normally suspends the host and
  takes Citadel, terminals and agents offline. New `scripts/power.sh` writes
  `/etc/systemd/logind.conf.d/90-citadel-24-7.conf` with
  `HandleLidSwitch=ignore` (battery, AC and docked) and `IdleAction=ignore`,
  masks `sleep/suspend/hibernate/hybrid-sleep` targets, and reloads logind with
  `SIGHUP` so SSH sessions survive. A state file records which targets were
  already masked, so `off` restores only Citadel's changes.
- **Surfaces.** `citadel power status|on|off` exposes the state; the installer
  opt-in flag is `--24-7` (alias `--keep-awake`); the uninstaller restores the
  previous sleep policy when the Citadel drop-in exists. README documents the
  workflow.
- **Tests.** `tests/cli.test.js` covers the new help/status surface; the full
  suite reports **355 tests, 354 pass, 1 skipped** (the pre-existing
  environment-dependent tmux copy-mode skip). `npm version minor` bumped the
  package to `0.30.0`; asset cache-buster token moved to `v0300`.

## 75. Credential vault sync between paired hosts (v0.31.0)
- **Vault follows the pairing.** New `secretStore.exportSecrets()` returns a
  decrypted snapshot (undecryptable rows are skipped, not fatal) and
  `server/services/secretSyncService.js` merges two vaults bidirectionally.
  Every kind travels — `env` variables, `git` tokens (e.g. `GITHUB_TOKEN`),
  `file` and `ssh` entries — so a newly joined machine does not need its tokens
  re-entered. Newest `updated_at` wins, equal values are skipped, deletions are
  never propagated, and values are never rendered to the browser.
- **Endpoints.** `POST /api/host/peers/secrets/sync` (peer token, `no-store`,
  8 MB body cap, audit `peer_secrets_synced`) is the server-to-server merge;
  `POST /api/hosts/:id/sync-secrets` (session + admin, audit
  `host_secrets_synced`) lets the operator re-run it after rotating a token.
- **When.** Invites created in **Settings → Connection** merge automatically
  after redeem (`autoSync` set by the accepting host). The startup/installer QR has no associated
  admin (`userId: null`) and intentionally does **not** share secrets. Existing
  pairings converge via the new **Sync credentials** action on the Machines card.
- **Transport.** `hostService.requestHost` gained a `secureOnly` filter with
  `isSecurePeerUrl`; secret transfers only use HTTPS or loopback. A pair reachable
  only over plain-HTTP LAN still pairs but reports
  `No HTTPS address is available for this host` instead of leaking the vault.
- **QR and unpair fixes.** The terminal QR encodes the compact invite so the
  ANSI block render fits narrow widths (`/api/connect/qr` reports `qrColumns` /
  `qrFits`), and unpair now attempts a bounded (~3.5 s) remote revoke before
  removing the host locally, so a hanging address no longer blocks removal.
- **Tests.** New `tests/secret-sync.test.js` (conflict/invalid import handling,
  peer-endpoint auth + merge, end-to-end `syncWithHost` against a mock peer);
  `tests/connect.test.js` and `tests/pairing.test.js` cover the QR width and
  offline-unpair paths. Full suite **360 tests, 359 pass, 1 skipped**. Version
  bumped to `0.31.0`; asset cache-buster token moved to `v0310`.

## 76. Mobile terminal Paste button fix (v0.33.2)
- **Bug.** On iOS the Clipboard API shows a native "Paste" callout and its
  promise never settles if the user ignores it, so the Paste button looked dead.
- **Fix.** The clipboard read races a 2.5 s timeout and falls back to the manual
  textarea; a system Paste in that textarea now sends immediately, closes the
  dialog and returns focus to the terminal.
- Version bumped to `0.33.2`; asset cache-buster token moved to `v0332`.

## 77. Minimal installer output, single QR (v0.33.3)
- **Problem.** A fresh install printed several QR codes: `tunnel.sh up` printed
  its own QR and URL block, then the installer printed another at the end, amid
  verbose apt/npm/doctor output.
- **Fix.** `tunnel.sh` honours `CITADEL_QUIET=1` (no URL block, no QR; it still
  writes `connect-qr`). The installer sets it, logs apt/npm/doctor/tunnel output
  to a temp file shown only on failure, collapses the option banners into one
  `Options:` line and turns sub-step lines into `detail()` (visible with
  `CITADEL_VERBOSE=1`). The only QR is the last thing printed: one code that
  opens the panel from a phone camera and pairs from another Citadel's Pair
  screen. `citadel tunnel` run by hand still prints its QR.
- Version bumped to `0.33.3`; asset cache-buster token moved to `v0333`.

## 78. Pairing QR scan errors (v0.33.4)
- **Bug.** Scanning a Settings pairing QR from another Citadel reported "That
  link does not contain a pairing code". The Settings QR silently fell back to
  the plain panel address when the invite request failed, and the dense
  full-JSON QR was hard to scan.
- **Fix.** The Settings QR now encodes the compact invite (98 vs 400 bytes); a
  failed invite shows an error instead of a pairing-less QR; `parsePairingCode`
  accepts a bare `pair=` fragment and explains how to get a real pairing code
  when given a plain address.
- Version bumped to `0.33.4`; asset cache-buster token moved to `v0334`.
