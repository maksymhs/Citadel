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
