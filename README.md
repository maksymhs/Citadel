# Citadel

A self-hosted, lightweight, modular and secure web platform to manage multiple software projects, persistent terminals and AI CLI coding agents on your VPS.

---

## 1. Key Features

- **Unified Project Management**: Register, create, import and clone Git repositories with live status and branch inspection.
- **Git Provider Integration**: Connect GitHub or GitLab with a personal access token to browse and one-click clone your private repositories. Tokens are encrypted at rest (AES-256-GCM) and never sent to any host other than the provider's.
- **Unified Credential Vault**: One encrypted store for every secret — git provider tokens, environment variables and files (SSH keys). Terminals receive env/git credentials automatically at spawn, and agents can read any entry on demand with the `citadel-creds` CLI (`list`, `get`, `env`, `exec -- <cmd>`, `materialize`). There is a single place to add, rotate and revoke credentials.
- **Persistent Terminals with tmux**: A web terminal built on `xterm.js`, `node-pty` and `tmux`. Your processes and sessions keep running even if you close the browser or restart the panel.
- **AI CLI Agent Launcher**: Detects and runs CLI tools such as **Claude Code**, **Codex CLI**, **OpenCode**, **Antigravity CLI** (`agy`) and custom binaries under the server's authorized Linux account, without requiring commercial APIs or exposing secrets. Missing agents can be **installed with one click** from the panel (the official one-line installer runs in a System Terminal). Agents install **once for every user**: the installer always runs as the service user, without sudo, into a shared, world-readable directory owned by that user (`CITADEL_AGENTS_DIR`, default `/opt/citadel/agents`) and links the binary into `$CITADEL_AGENTS_DIR/bin`. That directory is on the PATH of every panel terminal (including the privileged System Terminal) and of every non-root login shell through `/etc/profile.d/citadel-agents.sh`. Installations made before this layout existed are fixed by re-running the installer.
- **Low Resource Usage**: A lean architecture built on Fastify and SQLite in WAL mode, designed to run on VPS instances with as little as 512 MB of RAM.
- **Secure by Design**:
  - Listens on `127.0.0.1` by default.
  - Mandatory authentication with `HttpOnly`, `SameSite=Strict` cookies.
  - WebSocket origin validation and strict path-traversal prevention.
  - Git provider tokens encrypted at rest with AES-256-GCM; the key lives in `DATA_DIR/secret.key` (0600) or `CITADEL_SECRET_KEY`.
  - Audit log with automatic credential redaction.
- **Domain Publishing (Optional)**: Caddy integration through its local admin API for reverse proxying and automatic HTTPS via Let's Encrypt.
- **Docker Monitoring (Optional)**: Container inspection over a protected Unix socket. The core works 100% without Docker or Caddy.
- **Paired Machines (single URL, multiple hosts)**: Pair two Citadel installations by scanning a QR code (or pasting its link) and switch between them from the machine selector at the top of the sidebar. The browser always stays on the same URL: the local server proxies API calls and terminal WebSockets to the selected machine, so projects, files, terminals and settings all follow the switch. Pairing is **bidirectional** (both machines can reach each other), uses independent revocable tokens per direction, and is keyed by a stable instance id plus a list of candidate addresses, so a rotating **Cloudflare Quick Tunnel URL never loses the association**: peers re-announce on boot and every five minutes, and every peer response includes the sender's current addresses so the stored row heals itself on the next successful call. The legacy **Fleet** module remains for bulk status/update/agent actions over manual URL+token hosts.
- **Machines (health, alerts and quick actions)**: A **Machines** screen and dashboard widget show every paired machine at a glance: online/offline, CPU load, memory, disk, uptime, latency, version and 24 h / 7 d availability, with per-machine history and an incident trail. Each panel checks its paired machines every 60 s and raises an alert when one stays offline (two failed checks) or crosses a disk, memory or CPU threshold. Alerts show in the panel and can also be pushed to a **webhook** (Slack/Discord-compatible), **ntfy** or **Telegram**, once when they start and once when they recover; channel secrets are stored encrypted and never shown again. From a machine's details you can read its service log and **restart Citadel** remotely (terminals in tmux keep running). A machine cannot alert about its own outage, so configure alerts on a second machine as well.
- **Distributed Task Mesh**: A minimal, pull-based work queue so one smart orchestrator agent can split work across many nodes. A per-node **sentinel** pulls one task at a time when it has a free slot, so load balancing is emergent; a short lease keeps crashed workers harmless. Exposed over HTTP and as a dependency-free **MCP server** (`scripts/citadel-mcp.js`).
- **Observability (Logs & Metrics)**: A built-in **event trace** (task lifecycle, node health) plus periodic **resource samples** (load, memory, terminals/tasks), shown as a live sparkline and a filterable timeline with **JSON/CSV export** — so you can debug and tune from real data. Retention and sampling interval are configurable.
- **Plugin System**: Standardized `plugin.json` manifests with fault isolation so no plugin can take down the core.
- **Idempotent Installation**: An `install.sh` installer and a systemd unit for Debian/Ubuntu and POSIX environments.

---

## 2. System Requirements

- **Operating System**: Debian 11/12, Ubuntu 20.04/22.04/24.04, or macOS 13+.
- **Architecture**: `x86_64` or `arm64 / aarch64`.
- **Node.js**: v18 LTS, v20 LTS, v22 LTS or later.
- **tmux**: For full session persistence (optional: direct PTY fallback).
- **Git**: Native CLI installed on the system.
- **RAM**: Minimum 512 MB (1 GB recommended for AI agents).

---

## 3. Quick Start

### One-line install (Linux and macOS)

Run the installer directly from the repository:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash
```

On Debian/Ubuntu, add `sudo` before `bash` to install the system service:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | sudo bash
```

That command installs the service **local-only and unprivileged by default**. Every additional capability is opt-in:

| Flag | Effect |
| --- | --- |
| `--lan` (or `--host=ADDR`) | Reachable on your local network (QR from your phone) |
| `--no-tunnel` | Skip the public Cloudflare Quick Tunnel (on by default) |
| `--admin-terminal[=user]` | Root-capable System Terminal (privileged) |
| `--no-updater` | Skip the root-owned in-panel updater (on by default) |
| `--24-7` (or `--keep-awake`) | Default: ignore lid close and block suspend/hibernate |
| `--no-24-7` (or `--no-keep-awake`) | Allow the host to suspend normally |

The panel listens on `127.0.0.1` unless you pass `--lan`/`--host`, and nothing privileged is enabled until a flag asks for it. **Until you create the administrator account, whoever reaches the panel first can claim it** — so prefer the local QR flow, set up the admin, and only then add a tunnel if you need one.

Preview what it will do without changing the system:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --check-only
```

On macOS, install prerequisites first (`brew install node git tmux`) and run the same command **without** `sudo`. It creates a per-user `launchd` service that starts Citadel after login and restarts it if it exits. Use `~/.local/bin/citadel status`, `logs` and `restart`; add `~/.local/bin` to your `PATH` if necessary. Pair the Mac with the VPS through Tailscale or another reachable private address. A closed MacBook normally sleeps, so keep it powered and awake when it must remain an online paired host.

### One-line uninstall (Linux and macOS)

Remove the service, helper scripts, `/srv/citadel` (data/projects) and the service user. The local source checkout the installer ran from is **kept** by default:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --uninstall
```

On Debian/Ubuntu, add `sudo` before `bash` (or allow the uninstaller to request it) to remove the system service.

Pass `--keep-data` after `--uninstall` to preserve the database and projects. On Linux, `--remove-source` also deletes the local checkout after an interactive confirmation. Before any change the installer validates the target and requires Citadel installation evidence; `--dry-run` (`--check-only`) prints the plan without touching anything.

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
citadel qr         # one-time QR code to pair another Citadel (valid 10 minutes)
citadel logs       # follow the service logs
citadel restart    # restart the service
citadel update     # update to the latest version
citadel tunnel     # global URL via a Cloudflare Quick Tunnel
citadel power      # show lid-close/sleep state (laptop hosts)
citadel power on   # 24/7 mode: ignore lid close, block suspend/hibernate
citadel power off  # restore the system sleep defaults
```

`citadel update`, `citadel tunnel` and `citadel power on|off` need root and re-invoke `sudo` automatically.

### Laptop server / always-on mode

Citadel enables 24/7 mode by default so closing a laptop lid does not suspend the panel, terminals or agents. Use `--no-24-7` during installation to opt out, or run `sudo citadel power on` later to enable it:

- make **systemd-logind ignore the lid switch** (on battery, AC and docked);
- mask the **sleep, suspend, hibernate and hybrid-sleep** targets so nothing else can suspend the host;
- set `IdleAction=ignore`.

The change survives reboots. `sudo citadel power off` removes the Citadel drop-in and unmasks only the targets Citadel masked, restoring the previous power policy. The live camera pairing and all web features keep working while the lid is closed; the display itself may still turn off depending on your desktop environment.

### Privileged System Terminal (opt-in)

The **System Terminal** can run as a privileged account so you can administer the whole host from the panel. It is **disabled by default**; enable it explicitly:

```bash
sudo bash install.sh --admin-terminal            # run terminals as the installing user
sudo bash install.sh --admin-terminal=deploy     # run terminals as 'deploy'
sudo bash install.sh --no-admin-terminal         # unprivileged service user only (default)
```

The named user must exist on the host; the installer validates it and refuses to continue otherwise. It installs a scoped `sudoers` rule, relaxes the systemd sandbox and sets `TERMINAL_ADMIN_USER` in `.env`. **Security warning:** it makes the panel root-equivalent — anyone able to log into the panel can obtain a root shell on the host. Only enable it on a personal, single-admin server.

### In-panel Updater

Citadel checks GitHub for new releases (System view) and — when the updater is installed — can update itself with one click. It is **enabled by default**; skip it with `--no-updater`. To add it to an existing install, re-run the installer:

```bash
sudo bash install.sh --update
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

### Distributed task mesh

Parallel work across paired nodes. See [docs/task-mesh.md](docs/task-mesh.md).

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

### Remote access, pairing and tunnels

Scan a QR from your phone, pair several Citadel machines and expose the panel globally (Cloudflare Quick Tunnel, or a stable URL on your own domain from **Settings → Tunnel**). Quick start: `citadel qr` (or `citadel qr --url` on small terminals), `citadel tunnel`, `citadel tunnel --domain=HOST --token=TOKEN`. Full details: [docs/remote-access.md](docs/remote-access.md).

**Mesh pairing (opt-in).** In **Settings → Machines** turn on *Auto-pair with all my machines* on each Citadel that should join. Machines that are already paired then introduce them to each other, so every machine ends up paired with every other one (single-use invitations, one token per direction, no credential vault merge). Once paired, the machine selector under the logo opens any machine's terminals, logs and processes. Machines with mesh off refuse introductions; *Unpair* removes a machine from both sides.

**Update propagation (always on).** Once this machine is updated and healthy, it updates each paired machine that is behind, waiting for it to come back on the new version before starting the next, and stops at the first one that does not. *Update paired machines now* runs it on demand. Machines updated this way do not propagate further.

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
│   ├── diagnostics.js    # Capability-driven host/network collectors (read-only)
│   ├── doctor.js         # `citadel doctor|network|wifi|repair` CLI
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

## 6. Diagnostics, Recovery & Maintenance

The local CLI works without the web server, dashboard login, GitHub or Internet
access. It reuses the installed Node.js runtime and has no extra dependencies.

```bash
# Read-only overview: host, load, memory, disk/inodes, systemd, network, Wi-Fi, Citadel
citadel doctor
citadel doctor --json

# Detailed interface, route, DNS and Wi-Fi diagnosis
citadel network
citadel network --json

# Wi-Fi is optional (a VPS without wireless hardware is fine)
citadel wifi list
citadel wifi list --json
citadel wifi connect "Home Wi-Fi"          # saved NetworkManager profile
citadel wifi connect --ssid="Home Wi-Fi"
citadel wifi connect                       # pick from the visible list
citadel wifi connect "New Network"         # new networks prompt via: nmcli --ask

# List and apply only explicitly supported recovery actions
citadel repair
citadel repair --json
citadel repair --action=restart:citadel.service --yes
```

From a source checkout, use `node scripts/doctor.js <command>` (or `npm run doctor`).
The commands target Debian/Ubuntu with systemd first; missing tools, systemd or
Wi-Fi are reported as **SKIP**, never as a crash. A VPS without NetworkManager or
wireless hardware still gets full wired/Citadel diagnostics.

Safety rules:

- `doctor` and `network` are read-only. They never edit Netplan, NetworkManager,
  systemd or firewall configuration, and they do not require the panel to be
  running. DNS/HTTP/gateway failures are reported as observations because a
  read-only host check cannot prove why the Internet is unavailable.
- `repair` only offers allow-listed actions: restart a **failed** systemd unit,
  restart `citadel.service`, unblock the Wi-Fi radio with `rfkill`, or activate a
  saved NetworkManager profile. It validates the unit, asks for confirmation,
  verifies the result and reports failure honestly. There is no generic command
  runner and no automatic rollback.
- Wi-Fi passwords are **never** accepted as command-line arguments and are never
  written to history, logs or JSON. New networks are joined with `nmcli --ask`,
  which prompts on the terminal; saved profiles use `nmcli connection up id`.
- Over SSH, a Wi-Fi change warns that the session can drop and refuses
  `--yes` unless `--confirm-remote` is also supplied. Keep console/IPMI access.
- Exit codes: `0` = no confirmed problem / action verified, `1` = problem or
  failed action, `2` = invalid usage. In `--json` mode stdout contains only the
  JSON document; progress and warnings go to stderr.

### Maintenance

```bash
# Update the application while preserving data and projects (run with sudo on a server)
./scripts/update.sh
sudo /usr/local/sbin/citadel-update --check   # verify the updater without changing anything

# A failing update rolls back both the code and, if the new version may have
# migrated it, the database. A reliable SQLite snapshot is taken first; if one
# cannot be produced (or the service cannot be stopped to restore it) the update
# is refused before the checkout changes. Snapshots live in data/backups/.

# Uninstall (service, scripts, /srv/citadel, the user). The source checkout is kept.
./scripts/uninstall.sh

# ...but keep the database and projects
./scripts/uninstall.sh --keep-data

# ...also delete the local checkout (asks for interactive confirmation)
./scripts/uninstall.sh --remove-source

# ...validate paths and show the plan without changing anything
./scripts/uninstall.sh --dry-run
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
