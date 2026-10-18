# Citadel

A self-hosted, lightweight, modular and secure web platform to manage multiple software projects, persistent terminals and AI CLI coding agents on your VPS.

---

## 1. Key Features

- **Unified Project Management**: Register, create, import and clone Git repositories with live status and branch inspection.
- **Git Provider Integration**: Connect GitHub or GitLab with a personal access token to browse and one-click clone your private repositories. Tokens are encrypted at rest (AES-256-GCM) and never sent to any host other than the provider's.
- **Persistent Terminals with tmux**: A web terminal built on `xterm.js`, `node-pty` and `tmux`. Your processes and sessions keep running even if you close the browser or restart the panel.
- **AI CLI Agent Launcher**: Detects and runs CLI tools such as **Claude Code**, **Codex CLI**, **OpenCode** and custom binaries under the server's authorized Linux account, without requiring commercial APIs or exposing secrets. Missing agents can be **installed with one click** from the panel (the official one-line installer runs in a System Terminal). Agents install **once for every user**: the installer targets a shared, world-readable directory (`CITADEL_AGENTS_DIR`, default `/opt/citadel/agents`) and symlinks the binary into `/usr/local/bin`, so any OS user or panel session can run it.
- **Low Resource Usage**: A lean architecture built on Fastify and SQLite in WAL mode, designed to run on VPS instances with as little as 512 MB of RAM.
- **Secure by Design**:
  - Listens on `127.0.0.1` by default.
  - Mandatory authentication with `HttpOnly`, `SameSite=Strict` cookies.
  - WebSocket origin validation and strict path-traversal prevention.
  - Git provider tokens encrypted at rest with AES-256-GCM; the key lives in `DATA_DIR/secret.key` (0600) or `CITADEL_SECRET_KEY`.
  - Audit log with automatic credential redaction.
- **Domain Publishing (Optional)**: Caddy integration through its local admin API for reverse proxying and automatic HTTPS via Let's Encrypt.
- **Docker Monitoring (Optional)**: Container inspection over a protected Unix socket. The core works 100% without Docker or Caddy.
- **Fleet (Multi-Host)**: Register other Citadel instances (URL + token, encrypted at rest) and manage them from one panel — a **single-pane-of-glass dashboard** shows every device (online/offline, version, updates, agents installed) and offers **Check All** / **Update All** bulk actions. You can also browse each host's status/version, list and install AI agents and trigger self-updates remotely. The token is a bearer session id accepted by the remote API.
- **Distributed Task Mesh**: A minimal, pull-based work queue so one smart orchestrator agent can split work across many nodes. A per-node **sentinel** pulls one task at a time when it has a free slot, so load balancing is emergent; a short lease keeps crashed workers harmless. Exposed over HTTP and as a dependency-free **MCP server** (`scripts/citadel-mcp.js`).
- **Observability (Logs & Metrics)**: A built-in **event trace** (task lifecycle, node health) plus periodic **resource samples** (load, memory, terminals/tasks), shown as a live sparkline and a filterable timeline with **JSON/CSV export** — so you can debug and tune from real data. Retention and sampling interval are configurable.
- **Plugin System**: Standardized `plugin.json` manifests with fault isolation so no plugin can take down the core.
- **Idempotent Installation**: An `install.sh` installer and a systemd unit for Debian/Ubuntu and POSIX environments.

---

## 2. System Requirements

- **Operating System**: Debian 11/12, Ubuntu 20.04/22.04/24.04 (or macOS for local development).
- **Architecture**: `x86_64` or `arm64 / aarch64`.
- **Node.js**: v18 LTS, v20 LTS, v22 LTS or later.
- **tmux**: For full session persistence (optional: direct PTY fallback).
- **Git**: Native CLI installed on the system.
- **RAM**: Minimum 512 MB (1 GB recommended for AI agents).

---

## 3. Quick Start

### One-line install (Debian / Ubuntu)

Run the installer directly from the repository:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | sudo bash
```

That command installs the service **local-only and unprivileged by default**. Every additional capability is opt-in:

| Flag | Effect |
| --- | --- |
| `--lan` (or `--host=ADDR`) | Reachable on your local network (QR from your phone) |
| `--tunnel` | Public Cloudflare Quick Tunnel URL |
| `--admin-terminal[=user]` | Root-capable System Terminal (privileged) |
| `--enable-updater` | Root-owned in-panel updater |

The panel listens on `127.0.0.1` unless you pass `--lan`/`--host`, and nothing privileged is enabled until a flag asks for it. **Until you create the administrator account, whoever reaches the panel first can claim it** — so prefer the local QR flow, set up the admin, and only then add a tunnel if you need one.

Preview what it will do without changing the system:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --check-only
```

### One-line uninstall

Remove **everything** (service, helper scripts, `/srv/citadel`, the service user **and the local source checkout** the installer ran from):

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/scripts/uninstall.sh | sudo bash
```

Pass `--keep-data` to preserve `/srv/citadel` (database and projects) or `--keep-source` to keep the local git checkout.

### Install from a clone

```bash
git clone https://github.com/maksymhs/Citadel.git /srv/citadel/app
cd /srv/citadel/app
./install.sh
```

Both methods are idempotent. The installer:

1. Checks the operating system, memory and dependencies.
2. Installs Node.js and build tools if needed.
3. Prepares the layout under `/srv/citadel` (`app`, `data`, `projects`, `logs`).
4. Configures and starts the `citadel.service` systemd unit.

When it finishes, the installer prints the panel address (a **QR code** too). With the default local-only install, open it on this machine and create the administrator account; install with `--lan` if you want to scan the QR from your phone on the same Wi-Fi.

You can override the source repository or branch with the `CITADEL_REPO_URL` and `CITADEL_REPO_BRANCH` environment variables.

### Updating an existing installation

Re-running the same installer upgrades in place: it pulls the latest code from the configured branch, reinstalls dependencies, refreshes the service unit and helper scripts, and restarts Citadel. Your data, `.env` and projects are preserved.

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --update
# or, once installed:
citadel update
```

### Managing Citadel (`citadel` CLI)

Once installed, a small `citadel` command is available system-wide:

```bash
citadel status     # service, version, panel URL and health
citadel url        # print the panel URL
citadel qr         # scannable QR code for the panel URL
citadel logs       # follow the service logs
citadel restart    # restart the service
citadel update     # update to the latest version
citadel tunnel     # global URL via a Cloudflare Quick Tunnel
```

`citadel update` and `citadel tunnel` need root and re-invoke `sudo` automatically.

### Privileged System Terminal (opt-in)

The **System Terminal** can run as a privileged account so you can administer the whole host from the panel. It is **disabled by default**; enable it explicitly:

```bash
sudo bash install.sh --admin-terminal            # run terminals as the installing user
sudo bash install.sh --admin-terminal=deploy     # run terminals as 'deploy'
sudo bash install.sh --no-admin-terminal         # unprivileged service user only (default)
```

The named user must exist on the host; the installer validates it and refuses to continue otherwise. It installs a scoped `sudoers` rule, relaxes the systemd sandbox and sets `TERMINAL_ADMIN_USER` in `.env`. **Security warning:** it makes the panel root-equivalent — anyone able to log into the panel can obtain a root shell on the host. Only enable it on a personal, single-admin server.

### In-panel Updater (opt-in)

Citadel checks GitHub for new releases (System view) and — when the updater is installed — can update itself with one click. It is **disabled by default**; enable it explicitly:

```bash
sudo bash install.sh --enable-updater
```

It installs a root-owned helper at `/usr/local/sbin/citadel-update` plus a scoped `sudoers` rule granting the service user permission to run **only that helper** as root. The helper fetches the configured branch, resets the working tree, reinstalls dependencies and restarts the service. Before running it the panel verifies the helper is a regular, root-owned file that is not group/world-writable, and refuses otherwise. Without the helper the System view still reports the running version and available updates, but applying them requires running `scripts/update.sh` manually.

### Local network access (opt-in)

The panel listens on `127.0.0.1` only unless you ask for network access. To reach it from your phone on the same Wi-Fi (the installer then whitelists the LAN origin in `ALLOWED_ORIGINS`, required by the terminal WebSocket, and opens the port in `ufw` when active):

```bash
sudo bash install.sh --lan                 # listen on 0.0.0.0 (QR works on your LAN)
sudo bash install.sh --host=192.168.1.10   # or bind a specific address
sudo bash install.sh --local              # explicit local-only (the default)
```

For access from **any** network without exposing the host, prefer Tailscale (see *Access from your phone* below).

Reverse-proxy trust: by default only loopback peers may set `X-Forwarded-*` headers (`CITADEL_TRUST_PROXY`, default `loopback`). A directly connected client can therefore never spoof its IP to bypass rate limits. If you put Citadel behind a proxy on another host, set `CITADEL_TRUST_PROXY` to that proxy's IP/CIDR (comma-separated); `true` trusts every client and should only be used when the app is not directly reachable.

### Synchronized updates across hosts

To make one "Update" action roll out to several hosts, give each host the same secret and the list of its peers in `.env`:

```
CITADEL_PEERS=https://vps2.example.com
CITADEL_PEER_TOKEN=<long-random-shared-secret>
```

When set, triggering an update also asks every peer to update itself. The peer endpoint is token-authenticated (constant-time) and never fans out again, so there are no update loops. Keep the token out of version control.

### Distributed task mesh (parallel work across nodes)

The simplest and most solid way to spread work is a **pull queue**: the orchestrator (a smart agent) decides *what* and *how much*; each node is dumb and only pulls when it has a free slot, so load balancing is emergent and no node is a scheduler. A short lease, renewed by the sentinel heartbeat, means a crashed worker's task is retried automatically up to `maxAttempts` (default 3) and then fails explicitly. The heartbeat reports the attempts the node is actually executing, with their claim tokens, and only those are renewed: a task whose process disappeared while the node keeps beating stops being renewed and is reclaimed at lease expiry instead of holding `running` forever.

**Control plane (HTTP).** Orchestrator routes need an authenticated session; worker routes (claim/result/heartbeat) also accept the scoped `X-Citadel-Node-Token` header when `CITADEL_NODE_TOKEN` is set on the server:

```
POST /api/tasks              {cmd,args} OR {agent,prompt} + projectPath?, priority?, node?, maxAttempts?  # enqueue
POST /api/tasks/claim        {node}                                       # pull one (204 if none) → returns claimToken
POST /api/tasks/:id/result   {status, exitCode?, resultRef?, error?, result?, claimToken}  # report + captured output
POST /api/tasks/:id/cancel                                                # request cancel (queued or running)
GET  /api/tasks?status=&node=                                             # progress
POST /api/nodes/heartbeat    {node, capacity, active, load, tags?, running?: [{id, claimToken}]}  # liveness + lease renewal
GET  /api/nodes                                                           # list nodes and load
```

The heartbeat `running` list is a *witness list*: the server renews exactly those attempts and only while the reported claim token still matches the stored one. A running task that stops being reported is not renewed and expires through the normal reclaim path; a delayed or duplicated heartbeat cannot resurrect a finished task or extend an older attempt. For compatibility, plain id strings (or objects without `claimToken`) are still accepted, but their guarantee is explicitly weaker — renewal binds only id/node/status, so a delayed beat from an earlier attempt of the same node can extend a newer one. Expired attempts are still safe (reclaim runs before renewal, so they cannot be resurrected) and a task re-claimed by another node is protected by the node guard; the server emits a one-time `node_heartbeat_unbound` warning so operators know to upgrade the client. An omitted `running` list is treated as a legacy client and renews node-wide (with a one-time `node_heartbeat_legacy` warning), because refusing to renew would requeue tasks that are still executing.

**Claim tokens and retries.** Every claim mints a random `claimToken` and bumps `attempt`; reporting a result requires that exact token, so a worker whose lease expired (and whose task was retried elsewhere) can never overwrite the newer attempt's result. Expired leases requeue the task while attempts remain (`task_lease_expired` event) and mark it failed once `maxAttempts` is reached (`task_attempts_exhausted`).

**Lease authority.** A result is accepted only while the attempt still holds a valid lease *and* presents the current claim token; both checks and the write happen atomically with the ownership guard. Once the lease has expired the attempt has no authority even if nobody has reclaimed the task yet: the result is rejected (`task_result_rejected_expired` event) and the task is requeued — or failed when `maxAttempts` is reached — in the same transaction. A running row whose lease is missing (NULL/empty — only possible from a manually repaired or legacy database) is treated the same way and rejected with `task_result_rejected_no_lease`; a null lease is never read as an indefinite one, and the same reclaim path recovers the row. Cancelling a running task whose lease already expired (or is missing) finalises it as `cancelled` immediately, and a late result can never reopen a terminal state.

**Agent tasks.** Instead of a raw command, enqueue `{"agent":"claude|codex|opencode","prompt":"..."}` and Citadel builds the headless invocation from the agent registry (`opencode run`, `claude -p --output-format json`, `codex exec --json`), so the orchestrator never needs to know each CLI's flags.

**Result and cancellation.** The sentinel captures a bounded tail of the task's stdout/stderr and stores it in `result` (readable via `GET /api/tasks/:id`), and exports `CITADEL_TASK_ID`, `CITADEL_TASK_NODE` and `CITADEL_TASK_PROJECT` to the child so agents can name worktrees/branches idempotently. Cancelling a running task is a *request*: the task moves to `cancelling`, the sentinel receives it on the next heartbeat (SIGTERM, then SIGKILL after 10s), and the task becomes `cancelled` only when the worker confirms termination with its claim token (or the lease expires first).

**Sentinel (one per node).** Run it inside a Citadel terminal so tmux keeps it alive across restarts, or as a systemd unit. Prefer **per-node credentials**: set `CITADEL_NODE_TOKENS="vps-2:<random>,vps-3:<random>"` on the server and give each sentinel its own value in `CITADEL_NODE_TOKEN`. The credential is bound to that node id, so a node cannot claim, heartbeat or report as another node, and the shared token is ignored while per-node tokens are configured (no silent downgrade). If the variable is set but every entry is malformed (short token, missing separator, invalid node id), the server **fails closed**: worker node-token auth is disabled — the shared token is *not* used as a fallback — and a clear error is logged until the value is fixed. Leave the variable unset (or empty) to keep the legacy installation-wide `CITADEL_NODE_TOKEN` shared by every node — any holder may declare any node id — which is only appropriate when all nodes are inside the same operator's trust perimeter. `CITADEL_TOKEN=<session id>` also still works but grants the node a full panel session. Rotate or revoke by editing the map and restarting the server:

```
CITADEL_URL=https://panel.example.com \
CITADEL_NODE_TOKEN=<this node's secret> \
CITADEL_NODE=vps-2 \
CITADEL_CAPACITY=2 \
node scripts/sentinel.js
```

`cmd` is executed directly (no shell); for shell one-liners use `{"cmd":"bash","args":["-lc","..."]}`. Leave `node` off a task to let any free node pull it, or pin it to place work manually. Data/artifacts stay on your own transport (git branches, an object store) — the queue only carries small JSON.

**MCP server.** Any MCP-capable agent can drive the mesh with the tools `citadel_nodes`, `citadel_node_load`, `citadel_enqueue_task`, `citadel_tasks`, `citadel_task` and `citadel_cancel_task`:

```
CITADEL_URL=https://panel.example.com CITADEL_TOKEN=<session id> node scripts/citadel-mcp.js
```

It is dependency-free: newline-delimited JSON-RPC 2.0 on stdio. To distribute load-aware, the agent reads `citadel_nodes`/`citadel_node_load` and either enqueues unpinned (any idle node) or pins to the least busy one.

### Observability (logs & metrics)

The **Logs & Metrics** view turns Citadel's own operation into something you can debug and improve from. It has two layers, both stored in SQLite and exportable:

- **Event trace** — task lifecycle (`enqueued`, `claimed`, `completed`, `failed`, `cancelled`) and node health transitions (`stale`, `recovered`), plus server start. Sensitive keys (`token`, `password`, `secret`, …) are redacted before storage.
- **Resource samples** — load average, CPU cores, memory and active terminal/task counts, captured every 30s by a background sampler and shown as a live sparkline.

The view shows 24h summary cards (errors/warns, task status, peak load/memory, nodes online), a filterable event timeline and the slowest tasks, with one-click **Export JSON/CSV**:

```
GET /api/logs/events?level=&category=&node=&taskId=&since=&limit=   # trace
GET /api/logs/metrics?host=&since=&limit=                          # samples (oldest first)
GET /api/logs/summary                                              # 24h health overview
GET /api/logs/export?type=events|metrics&format=json|csv           # download
```

Retention is configurable: `CITADEL_LOG_RETENTION_DAYS` (default `30`), sampler interval `CITADEL_METRICS_INTERVAL_MS` (default `30000`), node staleness `CITADEL_NODE_STALE_MS` (default `90000`).

### File Explorer

The **Files** view browses the host filesystem: navigate directories, read and edit text files, create folders/files, rename, delete and download. When the panel is configured with an admin user (`--admin-terminal`), it can reach the **whole host** (the operations run as that user through the existing scoped `sudo` rule, with paths passed as data — never interpolated into a shell). Without an admin user it is limited to what the service user can access. Write operations are recorded in the audit log.

### Access from your phone (no domain needed)

The installer prints a scannable QR code pointing at the panel, and the **System** view has a **"Connect from your phone"** card with the same code. The encoded address is chosen automatically: an explicit `CITADEL_PUBLIC_URL`, otherwise an active **Cloudflare Quick Tunnel**, otherwise a **Tailscale** `*.ts.net` address, otherwise the LAN IP (which only works on the same Wi-Fi).

### Global URL with a Cloudflare Quick Tunnel (no account, no domain)

To reach the panel from **any network with a single command**, start a Cloudflare Quick Tunnel:

```bash
citadel tunnel          # installs cloudflared, starts the tunnel, prints the URL + QR
citadel tunnel stop     # stop it
citadel tunnel remove   # stop and delete the service
```

It gives you a public `https://<random>.trycloudflare.com` URL that works everywhere. The installer no longer starts it by default: pass `--tunnel` at install time, or run `citadel tunnel` afterwards. The URL **changes on every restart**, so the panel reads it dynamically and the QR always shows the current one (no need to touch `.env`). Because it is a **public** URL, create your administrator account before starting the tunnel and use a strong password.

To reach the panel privately instead (only your own devices), use Tailscale:

1. Install Tailscale on the host and on your phone, signing in to the same account.
2. On the host, proxy the panel onto your tailnet: `tailscale serve https / http://127.0.0.1:3000`.
3. Reload the panel — the QR now points at `https://<host>.<tailnet>.ts.net` and works everywhere, without exposing anything to the public Internet.

Set `CITADEL_PUBLIC_URL` in `.env` to pin any other address (e.g. a named Cloudflare tunnel).

### Git credentials for terminals

The installer also registers a git credential helper (`/usr/local/bin/citadel-git-credential`) system-wide. It lets plain `git fetch/pull/push` inside project terminals reuse the provider tokens you stored in **Repositories**, decrypting them on demand — tokens are never written to disk in clear text. It only resolves credentials for hosts that have a configured provider (GitHub/GitLab).

---

## 4. Local Development

```bash
# 1. Install dependencies and copy the local xterm bundles
npm install

# 2. Run the system health check
npm run doctor

# 3. Run the full automated test suite
npm test

# 4. Start the server in development mode
npm run dev
# Or in production:
npm start
```

Then open `http://127.0.0.1:3000` in your browser.

---

## 5. Repository Layout

```
citadel/
├── server/               # Node.js + Fastify backend
│   ├── config.js         # Configuration and environment variables
│   ├── index.js          # Server bootstrap and middleware
│   ├── database/         # Embedded SQLite with WAL
│   ├── security/         # Auth, sessions, cookies, path traversal
│   ├── services/         # Projects, terminals (tmux/pty), agents, git, proxy, docker
│   └── routes/           # HTTP REST endpoints and WebSockets (/ws/terminal)
├── public/               # SPA frontend (HTML5, dark responsive CSS, modular JS)
│   ├── css/app.css       # Self-contained styles, no external dependencies
│   ├── js/app.js         # SPA logic, xterm, WebSockets, modals
│   └── vendor/           # Local xterm.js bundles (0 CDNs)
├── plugins/              # Official plugins (plugin.json)
├── scripts/              # Maintenance scripts
│   ├── copy-vendor.js    # Copies xterm assets and applies +x permissions
│   ├── doctor.js         # Health and dependency diagnostics
│   ├── update.sh         # Self-updater (git fetch/reset + deps + restart)
│   ├── tunnel.sh         # Cloudflare Quick Tunnel (global URL, no account)
│   ├── uninstall.sh      # Full uninstaller (removes everything)
│   └── citadel.service   # systemd unit for Linux
├── tests/                # Automated tests
├── docs/                 # Architecture documentation and ADRs
├── install.sh            # Main installer
└── package.json
```

---

## 6. Diagnostics & Maintenance

```bash
# Full component and dependency diagnostics
node scripts/doctor.js

# Update the application while preserving data and projects (run with sudo on a server)
./scripts/update.sh
sudo /usr/local/sbin/citadel-update --check   # verify the updater without changing anything

# Uninstall everything (service, scripts, /srv/citadel, the user and the local clone)
./scripts/uninstall.sh

# ...but keep the database and projects
./scripts/uninstall.sh --keep-data
```

---

## 7. Security, Isolation & Limitations

Citadel applies several security layers by default:

- Listens on `127.0.0.1` unless another `HOST` is configured.
- Backend authentication is required for every API route except the initial setup status endpoint.
- Session cookies are `HttpOnly`, `SameSite=Strict` and `Secure` when HTTPS is used.
- WebSocket handshake origin validation plus a mandatory valid session.
- Security headers (CSP, `X-Content-Type-Options`, etc.) and request rate limiting.
- Process execution with structured arguments (no shell interpolation) and path validation against the managed tree.

**Important limitations** (we do not promise absolute security):

- **Projects are not isolated at the operating-system level.** They all run under the same Linux user as the service. Separation between projects is logical (own directories, sessions and records), not a sandbox.
- Getting a terminal is equivalent to getting a shell with the privileges of the account running Citadel. That account is **not root** by default; do not run the service as `root`.
- The *import project* feature intentionally lets an administrator register an arbitrary host directory (requires an admin session).
- The Caddy admin API must stay on `127.0.0.1`; Docker is only queried through the local Unix socket.
- With `HOST=0.0.0.0` the panel becomes reachable from the network: always place it behind a reverse proxy with HTTPS.

---

## 8. License

MIT. See [LICENSE](LICENSE) for the full terms.
