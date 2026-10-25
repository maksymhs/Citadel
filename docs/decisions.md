# Architecture Decision Record (ADR)

## ADR-001: Lightweight backend with Node.js LTS and Fastify
- **Context**: A fast, secure web server with low memory usage (<= 50 MB at rest) is needed for modest VPS instances.
- **Decision**: Fastify over Express or NestJS for its superior performance, native validation schema support and modular WebSocket support (`@fastify/websocket`).
- **Consequences**: Near-instant startup, minimal overhead and high capacity for concurrent terminal streams.

## ADR-002: Embedded SQLite database with WAL
- **Context**: Citadel must be self-contained per server without requiring a database daemon such as PostgreSQL or MySQL.
- **Decision**: SQLite using `better-sqlite3` with WAL mode (`journal_mode = WAL`) and normal synchronization.
- **Consequences**: Zero database maintenance, a single file in `data/citadel.db`, straightforward file-copy backups and immediate persistence.

## ADR-003: Terminal persistence via PTY + tmux decoupling
- **Context**: A pure PTY dies if the connection is interrupted or the panel process restarts. Long-running AI agents (such as Claude Code compiling or editing) would lose their working state.
- **Decision**: Use `tmux` as the session persistence backend. `node-pty` acts as the WebSocket bridge between the xterm.js client and `tmux attach/new-session`.
- **Consequences**: Disconnecting the browser does not interrupt the process; reconnecting restores the full screen. If `tmux` is not present on the system, fall back to direct PTY.

## ADR-004: Session authentication with HttpOnly cookies
- **Context**: The platform manages commands and files on the server. Token theft from localStorage via XSS would be catastrophic.
- **Decision**: Sessions stored in SQLite with a random 256-bit identifier, transmitted in an `HttpOnly`, `SameSite=Strict` and `Secure` cookie (when HTTPS is used).
- **Consequences**: Protection against token theft from JavaScript; automatic expiration and immediate revocation capability.

## ADR-005: Strict control of Path Traversal and symbolic links
- **Context**: Project management allows opening and cloning repositories on the host disk. Malicious paths (`../../etc/passwd` or symlinks) could compromise the system.
- **Decision**: Every project path goes through canonical resolution verification (`fs.realpathSync`) and prefix validation against the list of allowed directories (`PROJECTS_DIR` or explicitly authorized paths).
- **Consequences**: Escapes outside the authorized working tree are prevented.

## ADR-006: Agent launching with structured processes
- **Context**: Launching AI tools with arbitrary shell strings exposes the system to command injection.
- **Decision**: The agent registry defines allowed binaries and structured arguments (`string[]`). The validated binary is executed directly in the project's working directory.
- **Consequences**: Zero command injection at the agent layer.

## ADR-007: Optional integrations as decoupled providers
- **Context**: Not every server has Docker or Caddy installed.
- **Decision**: Caddy and Docker are implemented with prior availability detection. If the API or the socket does not respond, the interface shows the "Unavailable / Optional" state without degrading the core project and terminal functionality.
- **Consequences**: The core works 100% on a clean VPS without Docker or Caddy.

## ADR-008: Execution identity and explicit uncertainty for the task mesh
- **Context**: A lease proves that a worker stopped talking, not that its process stopped running. Requeueing on expiry can duplicate a live task, while treating expiry as success can lose work. PIDs are reused, and a sentinel may crash after spawning but before recording the child.
- **Decision**: Protocol-2 sentinels spawn detached children, journal the execution identity (execId, pid, pgid, start token) before and after spawn, and report it in the heartbeat. The server persists that identity with the attempt and, when a lease expires with execution evidence, moves the task to `reconcile_state='uncertain'` instead of requeueing it. Only the owning node can resolve it (`alive`, `terminated`, `unknown`) with the attempt's claim token and execId. Termination is SIGTERM → bounded grace → SIGKILL → bounded confirmation against the process group; an unverifiable process is never reported as terminated. A per-node journal lock prevents two sentinels from adopting the same executions.
- **Consequences**: No duplicate execution after a lost heartbeat, and no false `cancelled`/`failed` while a process may still be alive. The cost is an explicit operator decision for genuinely unknown executions, a small durable journal (0600, contains claim tokens), and weaker recovery on platforms without `/proc` (macOS descendants can remain `unknown`). Legacy protocol-1 clients keep the previous expiry/requeue semantics until upgraded.

## ADR-009: Local-first diagnostics with a narrow, verified recovery surface
- **Context**: An operator can lose panel access because of a failed unit, a bad route, DNS or Wi-Fi. Requiring the web UI, Internet access or a new daemon to diagnose that state creates a circular dependency. At the same time, a generic "fix my network" command that edits configuration or executes arbitrary privileged commands is too risky for a recovery tool.
- **Decision**: Reuse the existing Node.js runtime and CLI (`scripts/citadel` + `scripts/doctor.js`) with a capability-driven, read-only collector library (`scripts/diagnostics.js`). Report unsupported or missing tools as skipped. Limit mutations to an allow-list: restart an observed failed unit or `citadel.service`, `rfkill unblock wifi`, and activate a saved NetworkManager profile. Validate inputs, explain impact, confirm (with an SSH-specific `--confirm-remote`), execute without a shell, and verify the result. Keep `--json` stdout machine-readable and never accept Wi-Fi passwords in argv, logs or JSON.
- **Consequences**: Diagnosis works on a machine whose panel, DNS, route or Wi-Fi is broken, and on a VPS without Wi-Fi. No new daemon, dependency, database or privileged helper is required. Some recovery remains intentionally unsupported (editing Netplan/NetworkManager config, arbitrary commands, automatic rollback); Wi-Fi changes require NetworkManager, and an unverifiable change is reported as unverified rather than successful. Operators retain console/IPMI as the fallback.

## ADR-010: Isolated agent releases with retained payloads
- **Decision:** install each CLI into a new release directory, validate it, and
  atomically switch a managed launcher. Restrict lifecycle actions to admins and
  the fixed catalogue. Remove only the launcher; retain downloaded releases.
- **Reason:** updating or deleting an in-use package can strand running processes
  when they later spawn companion executables. Sharing permissions must never be
  applied recursively to an existing tree containing user state or credentials.
- **Trade-off:** failed attempts and old releases consume disk space. Removal
  deactivates Citadel's launcher rather than reclaiming package storage; other
  PATH installations can remain visible. Automatic garbage collection and repair
  of externally managed Codex daemon packages are outside this change.

## ADR-011: A development-only Docker image for trying Citadel without installing it
- **Context**: Someone may want to see the panel on a machine they do not want to install onto (no systemd unit, no `/srv/citadel`, no sudo). Citadel already manages Docker as an optional integration (ADR-007) and discovers its socket, so a container is on-brand, but Citadel's core value — tmux sessions, CLI agents, git projects, tunnels, the updater and host diagnostics — depends on the host, which a container cannot faithfully reproduce. A container also adds a third install path beside the Linux and macOS installers.
- **Decision**: Ship a small, clearly-labelled `Dockerfile` (multi-stage, `node:22-bookworm-slim`, non-root, no Docker socket) plus `compose.yaml`, documented under "Try it without installing" and stated to be development-only. It binds the published port to `127.0.0.1` by default, keeps all state in a named volume, disables the updater and includes `tmux` and `git`. It is never presented as the supported deployment, and takes no privileged or networking flags.
- **Consequences**: A throwaway trial needs only Docker: `docker compose up --build`. The image cannot exercise systemd, tunnels, laptop mode, host `doctor` or agent binaries, and is therefore not a support target; users who want those are pointed to the installers. The `?v=` cache-buster and installer logic, which ship through tags, are unaffected.

## ADR-012: Persist daily attempt usage in the existing SQLite database
- **Context**: Counting task rows by their first start date undercounts retries and stops counting an older task's later attempts. Deleting task history must not restore spent budget.
- **Decision**: Store one `autonomous_daily_usage` row per local calendar day and increment it in the same transaction that claims an autonomous task. Keep the existing queue, scheduler and database. Backfill today's tasks conservatively on upgrade; older versions cannot reconstruct exact attempt dates.
- **Consequences**: Every future claim consumes budget, including retries, independently of task retention. Storage grows by one small row per active day. The counter measures attempts rather than provider billing and uses the server's configured timezone.

## ADR-013: Discover folders on demand and hand editing to desktop VS Code
- **Context**: Project discovery and editing should not add a resident watcher, a second service, editor authentication or a large idle memory cost before real usage demonstrates the need.
- **Decision**: Scan bounded immediate directories when Projects opens or refreshes, show read-only import suggestions, and prepare explicit local/SSH links to desktop VS Code. Keep SSH credentials in the operator's existing client configuration.
- **Consequences**: No new dependency, process or listening port. Folders still require explicit import and the editor requires desktop VS Code; an embedded web editor remains a separate product decision after a real contribution exercise.

## ADR-014: One optional project hub with a scoped execution journal
- **Context**: Separate Work, Docs and Learning navigation split one project's work into unrelated screens and obscured what agents and terminals were doing.
- **Decision**: Keep the existing `missions` module preference and service APIs, expose one Project hub view, and combine tasks/priorities, Markdown, confirmed context, an on-demand static JS/TS graph and execution traces. Persist project scope on existing event rows and index `(project_id, id)` for cursor reads. Record lifecycle events, not PTY transcripts or private model reasoning. Stop polling when the view is hidden or left.
- **Consequences**: No extra queue, scheduler, database, runtime dependency or graph daemon. Task deletion does not erase trace scope. Historical events without a recoverable project remain in Activity. Graphs are bounded file-import approximations, and projectless legacy missions remain available through the existing APIs. Existing review, cancellation, redaction and module guards continue to apply.

## ADR-015: Retire Project hub and validate an external gateway before integration
- **Status**: accepted (2026-10-25); supersedes ADR-014's Project hub UI and services.
- **Context**: Project management adds complexity beyond Citadel's terminals, projects and machines. The operator wants a familiar Claude Code console with configurable models and quota fallback.
- **Decision**: Remove Hub, mission, document, learning and graph runtime capabilities. Preserve historical database/Markdown data, cancel pending automation and request running automation to stop while retaining execution identity. Keep the core task mesh and activity journal. Trial pinned CLIProxyAPI outside Citadel with isolated configuration; add permanent Settings only after live authentication and tool/context checks.
- **Consequences**: No automatic gateway installation or new runtime dependency. Credential-free protocol/fallback testing is reproducible, but is not evidence of subscription entitlement or production reliability. Telegram control and permanent gateway configuration remain separate follow-up work.

## ADR-016: Opt-in managed local AI gateway with scoped Claude launches
- **Status**: accepted (2026-10-25); updates ADR-015's Settings gate at the operator's explicit request to provide activation.
- **Context**: A developer trial alone does not let an operator activate the gateway from Citadel. Native CLI experience and existing credentials must remain usable.
- **Decision**: Add administrator-only Settings to install a pinned checksum-verified CLIProxyAPI binary, connect ChatGPT by its own device flow and enable a loopback process supervised by Citadel. Persist settings and encrypted credentials in the existing database; materialize private runtime credentials only while needed. Route new project Claude launches through a scoped wrapper with planning/execution aliases. Disable management, discovery, panel downloads and request/error-body capture middleware. Keep automatic quota fallback disabled pending live validation.
- **Consequences**: No new Node dependency, queue, scheduler, system service or Citadel database. There is one optional external proxy process. Existing terminals and native/headless agents retain their configuration. Runtime plaintext is unavoidable for this upstream tool and can remain after a crash; Linux uses memory-backed temporary storage where available. Account entitlement, non-Claude model compatibility and real macOS behaviour remain validation gaps.

## ADR-017: Optional browser VS Code instead of desktop/SSH handoff
- **Status**: accepted (2026-10-25); supersedes ADR-013's editor handoff while retaining on-demand project discovery.
- **Context**: Desktop URI handlers do not open server folders without SSH configuration. The operator wants one project action and a visible return to Citadel.
- **Decision**: Download a pinned, digest-verified code-server distribution only on explicit first-use installation. Run one protected loopback editor on demand, with administrator-only HTTP/WebSocket forwarding through Citadel and a separate browser overlay containing the return action. Keep backend authentication server-side; disable its built-in port proxy and telemetry. Stop the process group on explicit stop/shutdown and idle instances after 15 minutes.
- **Consequences**: No runtime dependency for the core panel, public listener, SSH requirement, new Citadel database or system service. The optional IDE has substantial download/disk/RAM costs and service-account command/file access; it is not a project sandbox. Paired-machine editor transport and real macOS validation remain follow-up work.

## ADR-018: Stable gateway roles with explicit hot routing and account authorization
- **Status**: accepted (2026-10-25); extends ADR-016's single-provider activation.
- **Decision**: Claude Code requests fixed Citadel planning/execution/small aliases. The proxy maps them to selected real models under explicit Claude-only, ChatGPT-only or opt-in Auto policy. Auto gives Claude priority and uses ChatGPT as an eligible quota/availability fallback with session affinity. Invalid requests, auth/billing failures and policy denials are surfaced. Persist existing credentials encrypted and never import native CLI auth files.
- **Authorization**: retain ChatGPT device login; use the proxy's management OAuth flow for Claude with is_webui=false and manual callback submission through Citadel. This avoids the upstream wildcard callback listener. Management is now enabled on the existing loopback listener with remote access disabled and a separate ephemeral private key, rather than exposing it through Citadel. Browser routes remain administrator/origin protected; callback state/origin/path are checked and callback values are not audited or echoed.
- **Consequences**: model/mode changes apply after reload to subsequent requests without restarting alias-based clients; old concrete-ID shells reopen once. Keep in-place config writes because the pinned inode watcher loses atomic-rename replacements. A declared shared context budget replaces unknown-ID assumptions. No extra queue, scheduler, database or listener is added. Live subscription-pair and streamed failure/tool replay validation remain required; the existing fixture routing proof does not establish those guarantees.
