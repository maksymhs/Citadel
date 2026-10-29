# Citadel — System Architecture

How Citadel is put together and why. For where each file lives see [code-map.md](code-map.md); for which files make up each feature see [features.md](features.md); for the decisions behind it see [decisions.md](decisions.md).

## 1. What it is

A self-hosted web panel that runs on one machine (a VPS, a Mac, a laptop) and gives you, from a browser or phone:

- projects and Git repositories, and persistent terminals (`xterm.js` + `node-pty` + `tmux`);
- a launcher for AI CLI agents running as the service's OS user;
- a view of **every paired Citadel machine** (health, alerts, remote terminals, files, updates) behind one URL;
- optional publishing (Caddy), container inspection (Docker), a task queue for agents (task mesh) and plugins.

Every installation is a complete, independent Citadel. "Fleet" features are peers talking to peers; there is no central server.

### Principles

1. **Development environment first.** Publishing and deployment are accessory.
2. **Few dependencies.** Node.js, Fastify, SQLite. No Redis, queues, containers or remote databases; runs on 512 MB.
3. **Degrade, don't fail.** Missing `tmux`, `caddy`, `docker`, an agent, Wi-Fi hardware or `systemd` is reported, never fatal.
4. **Local and unprivileged by default.** `127.0.0.1`, no root, no public tunnel unless asked. Every widening of exposure or privilege is an explicit opt-in.
5. **Structured execution.** Processes are spawned with argument arrays, paths are validated against the managed tree, secrets are encrypted at rest and never logged.

## 2. Layers

```
Browser (SPA in public/)  ──HTTP + WebSocket──►  Fastify (server/index.js)
                                                   │  helmet, rate limit, cookies, static, websocket
                                                   │  auth guard on every /api route (except setup status)
        ┌──────────────────────────────────────────┤
        ▼                                          ▼
  routes/*Routes.js  ──►  services/*Service.js  ──►  SQLite (data/citadel.db, WAL)
  (validate, authorize)    (business logic)          the host OS: tmux, git, cloudflared, systemd/launchd
        │
        └─ /api/remote/:hostId/*  and  /ws/remote/:hostId/...  ──►  another paired Citadel
```

- **Routes** are thin: validate input, check the session (`requireAuth`; admin checks for mutations), call a service, audit sensitive actions.
- **Services** hold the logic and talk to the OS and the database. They are the unit tests target.
- **Frontend** is framework-free. `public/js/app.js` is the shell (state, API helper, navigation, dashboard, projects, terminals, Settings); each other screen is its own script that registers `window.CitadelX` and receives the shell's helpers once through `init(ctx)`: `monitor.js` (Machines), `files.js`, `disk-cleanup.js`, `fleet.js`, `activity.js`, `repos.js`, `deployments.js` (proxy and Docker), `pairing.js`, `settings-tunnel.js`, `settings-tailscale.js`. A new screen should follow that pattern instead of growing `app.js`; `tests/ui-smoke.test.js` loads the whole SPA in jsdom to catch a missing dependency.
- **Modules** (`server/modules/registry.js`) describe built-in capabilities and whether they are available and enabled. **Plugins** (`plugins/*/plugin.json`) are third-party style extensions loaded in isolation by `pluginLoader.js`.

## 3. Request flow and machine switching

The browser only ever talks to **its own** server. When you select another machine in the selector, the shell keeps the same URL and sends API calls to `/api/remote/<hostId>/…` and terminal sockets to `/ws/remote/<hostId>/terminal/<sessionId>`. `remoteProxyRoutes.js` forwards them using the stored outbound token for that peer, so a peer token never reaches the browser, and only registered hosts can be reached (no arbitrary URL, so no SSRF).

Some APIs always stay local (`LOCAL_ONLY_API` in `app.js`: auth, pairing, host list, fleet, monitor) because they are about *this* panel's view of the world.

## 4. Pairing, mesh and machine identity

- Every installation has a stable random **instance id** (`app_config`). A peer is a **list of candidate addresses** (LAN IP, own domain, Cloudflare Quick Tunnel, Tailscale), because tunnel URLs change on restart. Peers re-announce their addresses at boot and every five minutes, and every peer response carries the sender's current addresses, so stored rows heal themselves (`hostService.js`).
- **Pairing** (`pairingService.js`) is a bidirectional handshake started by a QR/link: machine B redeems A's single-use invitation, each side stores the other with an **independent token per direction** (inbound stored as a SHA-256 hash, outbound encrypted at rest). Either side can unpair, which removes both rows.
- **Mesh** (`meshService.js`): machines already paired introduce each other, so everyone ends up paired with everyone, with no credential-vault merge.
- **Vault sync** (`secretSyncService.js`): the encrypted credential vault is merged between paired machines over HTTPS only; the newest `updated_at` wins and deletions travel as tombstones.
- The legacy **Fleet** module (`fleetService.js`) manages manually added URL + token hosts for bulk status/update/agent actions.

## 5. Monitoring and alerts

`monitorService.js` runs in each panel: every 60 s it probes this machine and every paired one (latency, load, memory, disk, uptime, version, temperature), stores samples in `host_checks` (30 days) and computes 24 h / 7 d availability. A machine is **offline after two failed checks in a row**. Alerts (offline, disk, memory, CPU) show in the panel and can be pushed once at start and once at recovery to a webhook, ntfy or Telegram. `securityAlertService.js` reuses the same channels for security events (new sign-in address, failed-login bursts, a machine pairing in, setup code replaced, password reset). Monitoring is per panel: a machine cannot alert about its own outage.

## 6. Updates

`updateService.js` reports the running version and checks GitHub. The **stable** channel follows the newest `vX.Y.Z` tag, **main** follows the latest commit (`scripts/update.sh`). The actual update runs through a root-owned helper (Linux, installed by default) or `install-macos.sh --update`; it snapshots the SQLite database first and rolls back code and database if the new version fails. After a healthy update, `updateRolloutService.js` updates paired machines one at a time, waiting for each to come back on the new version and stopping at the first that does not.

## 7. Terminals and agents

Each terminal is a `tmux` session `citadel_<project_slug>_<id>`; `node-pty` runs `tmux new-session -A` in the project directory, so closing the browser or restarting the panel does not kill processes and reconnecting reattaches (`terminalManager.js`, `wsTerminal.js`). Without `tmux` it falls back to a direct PTY and says so. `agentRegistry.js` detects AI CLI tools on safe paths and `PATH`; each argument is individually quoted before it is written to the PTY, so browser-supplied arguments cannot inject commands. `agentInstallService.js` delegates administrator-only install/reinstall/remove actions to the fixed `agentCatalogue.js` and isolated `agentLifecycle.js` helper. New releases under `CITADEL_AGENTS_DIR/packages/<binary>` are validated before an atomic launcher switch; the service-account fallback is `~/.citadel/agents`. Removal unlinks only the managed launcher and retains releases for running processes. Existing user configuration and separate Codex daemon packages are never deleted.

Terminal clipboard image paste uploads the image to the active terminal's host via an authenticated API (forwarded by `remoteProxyRoutes.js` for paired hosts). The terminal image service validates type, size and file signature, then asks `fsAgent.js` to create a private temporary file as the terminal's OS identity. The UI inserts the resulting path with xterm's paste API, never image bytes or an implicit Enter. See [the image paste limits](security.md#deployment-details).

## 8. Reachability

`connectService.js` works out the panel's address (configured URL, Cloudflare or Tailscale, LAN, public IP) and its QR codes, for the panel, `citadel url|qr` and the installers. Public access is opt-in: a Cloudflare Quick Tunnel (`tunnelService.js` plus `citadel-tunnel.service` or the launchd job), a named tunnel on your own domain (`cloudflareTunnelService.js`) or a private tailnet HTTPS address (`tailscaleService.js`, `tailscale serve`, never funnel). Details in [remote-access.md](remote-access.md).

## 9. Data

SQLite in WAL mode at `DATA_DIR/citadel.db`; fresh databases get the `CREATE TABLE IF NOT EXISTS` schema, existing ones are upgraded by ordered, idempotent migrations recorded in `schema_migrations` (both in `server/database/db.js`).

| Group | Tables |
| --- | --- |
| Identity and access | `users`, `sessions`, `login_ips`, `audit_logs` |
| Projects and terminals | `projects`, `project_repos`, `term_sessions`, `deployments` |
| Credentials | `git_credentials`, `secrets`, `secret_tombstones` |
| Machines | `fleet_hosts` (paired and fleet hosts), `peer_tokens`, `pairing_invites`, `host_checks` |
| Task mesh | `tasks`, `nodes` |
| Observability | `events`, `metric_samples` |
| Platform | `app_config` (key/value), `plugins`, `schema_migrations` |

The retained legacy Chat backend uses a **separate** WAL database,
`DATA_DIR/chat/metadata.sqlite`, created lazily by `chatService`, not the main
schema/migrations. Removing the native GUI does not delete this data. Its `sessions`
table scopes engine IDs to owner, project and canonical directory; `requests`
stores message request IDs/digests for deduplication. It does not store full
message bodies there. OpenCode owns transcripts/state in the hashed per-owner/
project/directory HOME and separate XDG directories below `DATA_DIR/chat`.
The Chat root is mode 0700 and metadata file 0600; this is filesystem privacy,
not Chat encryption or an OS sandbox. Protect the whole Chat tree in backups.

Beside the database, `DATA_DIR` holds `secret.key` (AES-256-GCM key, mode 0600, or `CITADEL_SECRET_KEY`), `tunnel-url`, `connect-qr`, `update-status.json`, `update-channel`, `permissions.json` (macOS) and backups under `backups/`. Services read settings through `server/config.js`; `.env.example` documents every variable.

## 10. Where the details are

| Topic | Guide |
| --- | --- |
| Install, update, flags, pairing, observability endpoints | [installation.md](installation.md) |
| Tunnels, QR, own domain, Tailscale | [remote-access.md](remote-access.md) |
| Task queue, sentinel, MCP, reconciliation | [task-mesh.md](task-mesh.md) |
| Isolation, limitations, privileged modes | [security.md](security.md) |
| `doctor`, `repair`, maintenance | [operations.md](operations.md) |
| What changed and how it was verified | [engineering-execution-state.md](engineering-execution-state.md) |

## Optional developer tools

AI Gateway settings supervise one optional local CLIProxyAPI process. Credentials
persist encrypted in the existing app_config store; a private runtime directory
supplies the external process and scoped Claude/OpenCode/Codex project launchers.
OpenCode uses inline custom-provider configuration. Codex uses per-process
Responses provider overrides; a private PATH shim in project shells resolves the
native executable without rewriting user config or login caches. Stable
role aliases allow the proxy to hot-reload Claude/ChatGPT/Auto mappings while
keeping client names fixed. A private loopback management key drives Claude
OAuth without a separate callback listener; user callbacks pass through the
admin-authenticated panel. System shells and headless jobs keep their existing
setup. Internal API paths and persisted keys retain the `gateway` name for
compatibility. See [AI Gateway](ai-gateway.md).

Browser VS Code uses an optional pinned code-server distribution, started on
demand through an administrator-only HTTP/WebSocket bridge to a protected loopback
listener. Browser/peer credentials are not passed upstream; a return action remains
outside its iframe. Its install, lifecycle and native terminal gateway paths are unchanged.

Projects is the first-entry screen: the System (host) terminal card comes first,
then imported/registered projects, then a compact detected-folders list without
introductory copy. Each discovery row shows name/path, **Import folder** and a
dismiss **×**. Dismissal only hides the current suggestion, without deleting files
or registering a project; Refresh restores it, and dismissing all suggestions
hides the section. Discovery remains read-only and non-recursive under
`PROJECTS_DIR`, excluding hidden folders, directory symlinks, `node_modules`,
registered projects and associated repositories, with limits of 500 entries or
100 suggestions; it never executes repository code.

Project workspaces offer two compact whole-card buttons, **Terminal** and
**VS Code**, with no heading, helper descriptions, running statuses or stop
controls. They remember the selected mode per owner/panel/host/project,
preserving independent terminal selection and editor state. The icon-only
**Choose mode** arrow beside the sidebar toggle clears only the mode choice and
returns to the chooser, preserving mounted terminals and editor processes;
navigation and mode switching do not stop work. An old saved Chat mode returns
to the chooser without starting a runtime. Opening remembered VS Code does not
create a terminal. Existing terminal controls and the standalone editor's
explicit stop action remain separate and unchanged.

The sidebar Workspace group is derived from observed terminal activity and
browser-local editor hints, not saved mode choices or legacy Chat activity. The
shared editor has no authoritative per-folder state. Removal defaults to
registration-only, while disk deletion is separately confirmed. The panel checks
terminal/editor status before submitting removal. The server additionally
serializes its guard and synchronous deletion through the retained Chat queue,
rejecting any owner's running project engine, and checks live registered terminals
and the shared editor before mutation.

### Retained legacy Chat backend

The native Chat GUI (`public/js/chat.js`), its entry points and slash-command
composer are removed. The panel makes no Chat API calls and offers no Chat status
or stop controls. Existing histories, preferences and user data are retained;
removing the GUI does not stop existing engines. `chatRoutes` and `chatService`
remain registered in `server/index.js` for legacy API compatibility and project
removal safety, with their backend tests and storage intact.

The legacy service starts the installed `opencode serve` through the opt-in
OpenCode AI Gateway launcher only, never native provider fallback. Startup requires
OpenCode 1.19.x, checks required API operations and verifies gateway-exclusive
provider/model configuration. Build/Plan use execution/planning aliases;
permissions default to ask, with edit/bash/task/external-directory denied in Plan.
Session-cookie administrator auth, origin checks and owner/project/canonical-
directory checks apply to snapshots, mutations and SSE; peer tokens are not
accepted, and paired-machine Chat transport remains unsupported. Its bounded
snapshots, approvals, questions and cancellation endpoints remain legacy API
capabilities, not panel features. One engine is active at a time; busy work blocks
owner/project switching. Clean shutdown still stops editor and legacy Chat process
groups. See [legacy Chat API boundaries](security.md#legacy-chat-api-boundaries).

The earlier embedded OpenCode GUI, bundle adapter and root API proxies remain
removed; VS Code remains an iframe. Native terminal agents and gateway routing
are unchanged. See [project workspaces and browser editor](browser-editor.md).

## Retired project management

Project hub and its mission, document, learning and graph APIs have been removed.
Migration 017 retires pending automation and requests cancellation of running
automation. Historical database records and user Markdown remain untouched.
The task mesh, native CLI adapters and terminal lifecycle journal remain core.
