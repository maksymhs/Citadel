# Citadel

A self-hosted, lightweight, modular and secure web platform to manage multiple software projects, persistent terminals and AI CLI coding agents on your VPS.

---

## 1. Key Features

- **Unified Project Management**: Register, create, import and clone Git repositories with live status and branch inspection.
- **Git Provider Integration**: Connect GitHub or GitLab with a personal access token to browse and one-click clone your private repositories. Tokens are encrypted at rest (AES-256-GCM) and never sent to any host other than the provider's.
- **Persistent Terminals with tmux**: A web terminal built on `xterm.js`, `node-pty` and `tmux`. Your processes and sessions keep running even if you close the browser or restart the panel.
- **AI CLI Agent Launcher**: Detects and runs CLI tools such as **Claude Code**, **Codex CLI**, **OpenCode** and custom binaries under the server's authorized Linux account, without requiring commercial APIs or exposing secrets.
- **Low Resource Usage**: A lean architecture built on Fastify and SQLite in WAL mode, designed to run on VPS instances with as little as 512 MB of RAM.
- **Secure by Design**:
  - Listens on `127.0.0.1` by default.
  - Mandatory authentication with `HttpOnly`, `SameSite=Strict` cookies.
  - WebSocket origin validation and strict path-traversal prevention.
  - Git provider tokens encrypted at rest with AES-256-GCM; the key lives in `DATA_DIR/secret.key` (0600) or `CITADEL_SECRET_KEY`.
  - Audit log with automatic credential redaction.
- **Domain Publishing (Optional)**: Caddy integration through its local admin API for reverse proxying and automatic HTTPS via Let's Encrypt.
- **Docker Monitoring (Optional)**: Container inspection over a protected Unix socket. The core works 100% without Docker or Caddy.
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

That single command installs **everything** with no extra flags: the service, a **global Cloudflare Quick Tunnel** (so the printed QR works from any network), the privileged System Terminal and the in-panel updater. Opt out with `--no-tunnel`, `--no-admin-terminal`, `--no-updater` or `--local` if you prefer a minimal/private setup.

Preview what it will do without changing the system:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --check-only
```

### One-line uninstall

Remove **everything** (service, helper scripts, `/srv/citadel` and the service user):

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/scripts/uninstall.sh | sudo bash
```

Pass `--keep-data` to preserve `/srv/citadel` (database and projects).

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

When it finishes, the installer prints a **QR code**; scan it with your phone (same Wi-Fi) to open the panel and create the administrator account.

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

### Privileged System Terminal (enabled by default)

The **System Terminal** runs as a privileged account so you can administer the whole host from the panel. The installer picks the user that ran it (`$SUDO_USER`, falling back to `ubuntu`); override or disable it:

```bash
sudo bash install.sh --admin-terminal=deploy     # run terminals as 'deploy'
sudo bash install.sh --no-admin-terminal         # unprivileged service user only
```

It installs a scoped `sudoers` rule, relaxes the systemd sandbox and sets `TERMINAL_ADMIN_USER` in `.env`. **Security warning:** it makes the panel root-equivalent — anyone able to log into the panel can obtain a root shell on the host. Only enable it on a personal, single-admin server.

### In-panel Updater (enabled by default)

Citadel checks GitHub for new releases (System view) and can update itself with one click. To turn it off:

```bash
sudo bash install.sh --no-updater
```

It installs a root-owned helper at `/usr/local/sbin/citadel-update` plus a scoped `sudoers` rule granting the service user permission to run **only that helper** as root. The helper fetches the configured branch, resets the working tree, reinstalls dependencies and restarts the service. Without it the System view still reports the running version and available updates, but applying them requires running `scripts/update.sh` manually.

### Local network access

By default the installer exposes the panel on your local network so you can scan the QR it prints and start from your phone right away. It sets `HOST`, whitelists the LAN origin in `ALLOWED_ORIGINS` (required by the terminal WebSocket) and opens the port in `ufw` when active.

Keep it private to this machine instead:

```bash
sudo bash install.sh --local              # listen on 127.0.0.1 only
sudo bash install.sh --host=192.168.1.10  # or bind a specific address
```

For access from **any** network without exposing the host, prefer Tailscale (see *Access from your phone* below).

### Synchronized updates across hosts

To make one "Update" action roll out to several hosts, give each host the same secret and the list of its peers in `.env`:

```
CITADEL_PEERS=https://vps2.example.com
CITADEL_PEER_TOKEN=<long-random-shared-secret>
```

When set, triggering an update also asks every peer to update itself. The peer endpoint is token-authenticated (constant-time) and never fans out again, so there are no update loops. Keep the token out of version control.

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

It gives you a public `https://<random>.trycloudflare.com` URL that works everywhere. The installer starts it by default (so the QR it prints is already global); disable it with `--no-tunnel` or, once installed, `citadel tunnel stop`. The URL **changes on every restart**, so the panel reads it dynamically and the QR always shows the current one (no need to touch `.env`). Because it is a **public** URL, make sure you use a strong administrator password.

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

# Uninstall everything (service, scripts, /srv/citadel and the service user)
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
