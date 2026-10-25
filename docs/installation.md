# Installation & configuration

Everything about installing, updating, configuring and removing Citadel. Back to the [README](../README.md).

## One-line install (Linux and macOS)

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
| `--no-tunnel` | Skip the public Cloudflare Quick Tunnel (on by default, on Linux and macOS) |
| `--admin-terminal[=user]` | Root-capable System Terminal (privileged) |
| `--no-updater` | Skip the root-owned in-panel updater (on by default) |
| `--24-7` (or `--keep-awake`) | Default: ignore lid close and block suspend/hibernate |
| `--no-24-7` (or `--no-keep-awake`) | Allow the host to suspend normally |

The panel listens on `127.0.0.1` unless you pass `--lan`/`--host`, and nothing privileged is enabled until a flag asks for it. Creating the first administrator account needs a **setup code** that only someone with shell access to the machine can read: the installer prints it, and `citadel setup-code` shows it again. A stranger who finds the panel first cannot claim it, and five wrong codes replace it with a new one. The code disappears once the account exists. (Set `CITADEL_SETUP_CODE` to choose your own for automation, or `CITADEL_REQUIRE_SETUP_CODE=0` to turn the requirement off, which is not recommended.)

Preview what it will do without changing the system:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --check-only
```

On macOS, install prerequisites first (`brew install node git tmux`) and run the same command **without** `sudo`. It creates a per-user `launchd` service that starts Citadel after login and restarts it if it exits. Use `~/.local/bin/citadel status`, `logs`, `start`, `stop` and `restart`; add `~/.local/bin` to your `PATH` if necessary. Pair the Mac with the VPS through Tailscale or another reachable private address. A closed MacBook normally sleeps, so keep it powered and awake when it must remain an online paired host.

The macOS installer behaves like the Linux one: it opens a public Cloudflare Quick Tunnel and ends with the public address, the **setup code** (needed to create the administrator account) and a QR in the terminal; pass `--no-tunnel` to keep the panel on this Mac only. Run it as your normal user, with Node 18+, git and tmux already installed (`brew install node git tmux`).

On macOS only, the installer also tries to add a **menu bar icon** (next to the clock) that shows whether Citadel is running and lets you open the dashboard in the browser, start, stop or restart the service and open the log. It is a tiny Swift app built on your Mac, so it needs the Xcode Command Line Tools (`xcode-select --install`) and a graphical login session; without them (or over SSH) the install still finishes from the command line and tells you how to add the icon later. Skip it with `--no-menubar` (or `CITADEL_NO_MENUBAR=1`), and add or remove it later with `citadel menubar on|off`. **Disk → Quick clean** on macOS looks at `~/Library/Caches` (not `com.apple.*`), `~/Library/Logs`, Xcode (`DerivedData`, archives, device support), simulator caches and Homebrew, plus the cross-platform project and cache categories; it never reads `~/Downloads` or the Trash, which would trigger a macOS permission prompt. On Terminal.app the QR is drawn with coloured cells (no glyphs, so no seams) and the window is enlarged if the code does not fit.

## macOS permissions (Full Disk Access)

macOS asks for permission each time the Citadel service, or a terminal, agent or `git` it starts, first touches a protected folder (Desktop, Documents, Downloads, iCloud Drive, external or network disks). Granting **Full Disk Access** once removes those prompts:

```bash
citadel permissions open   # opens Privacy & Security > Full Disk Access and shows the file in Finder
citadel permissions        # what the service sees, and which files to allow
```

Drag the file shown into the list (or **+**, then `Cmd+Shift+G` to type the path) and switch it on. Allow the real `node` path and, if terminal prompts remain, `tmux`; if a prompt names another program, allow that one too. The service re-checks every minute and records the result in `DATA_DIR/permissions.json`, so `citadel permissions` reports whether it worked without a restart.

Limits you cannot script around: macOS only lets the user grant this in System Settings (Screen Sharing works if the Mac is across the room), or an organisation's MDM profile. It does **not** cover *Local Network* (macOS 15+ when pairing over a LAN address), Automation, Accessibility, Photos, camera or microphone, which are separate prompts. After `brew upgrade node` the real path changes and the grant is lost: repeat the steps and remove the old entry.

## Security alerts

Besides machine alerts (offline, disk, memory, CPU), the panel can tell you about security events through the same channels (webhook, ntfy, Telegram; **Settings → Alerts**, on by default): a sign-in from an address that user has not used before, repeated failed sign-ins (from one address, or spread over many), a machine that pairs with this one (it gets administrator access), the first administrator being created, a setup code that had to be replaced, and a password reset with `citadel reset-password`. Each message names the machine. Every event is also in the activity log under the `security` category even when pushing is off. Behind a proxy that hides client addresses the "new address" check cannot tell clients apart (see `CITADEL_TRUST_PROXY`).

## Windows (via WSL2)

Citadel does not run natively on Windows (it needs tmux, systemd and POSIX tools). On Windows 10 (2004+) or Windows 11 it runs inside **WSL2 (Ubuntu)**, as one more Linux machine:

1. In PowerShell as administrator: `wsl --install -d Ubuntu-24.04`. Restart if asked and finish creating the Linux user.
2. Enable systemd once. In the Ubuntu terminal: `printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf`; then, from Windows, `wsl --shutdown`, and open Ubuntu again.
3. In the Ubuntu terminal, run the normal Linux one-line installer above.

The installer recognises WSL: the panel stays local-only (no public tunnel unless you pass `--tunnel`), the laptop 24/7 settings are skipped, and if systemd is missing it stops before changing anything and prints step 2. Open `http://localhost:3000` in the Windows browser. To reach it from your other machines, use **Settings → Tailscale** inside Ubuntu. WSL2 needs virtualization enabled in the BIOS/UEFI, so very old PCs without it cannot run this. Windows may stop an idle WSL distro, which takes Citadel offline until a Ubuntu window is opened again; keeping it always on has not been verified. Not tested on a real Windows PC: the WSL detection is covered by `tests/install-wsl.test.js` with a faked host.

## One-line uninstall (Linux and macOS)

Remove the service, helper scripts, `/srv/citadel` (data/projects) and the service user. The local source checkout the installer ran from is **kept** by default:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --uninstall
```

On Debian/Ubuntu, add `sudo` before `bash` (or allow the uninstaller to request it) to remove the system service.

Pass `--keep-data` after `--uninstall` to preserve the database and projects. On Linux, `--remove-source` also deletes the local checkout after an interactive confirmation. Before any change the installer validates the target and requires Citadel installation evidence; `--dry-run` (`--check-only`) prints the plan without touching anything.

## Install from a clone

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

## Try it without installing (Docker)

To look at the panel on a machine you do not want to install on, there is a **development-only** image. It is not the supported deployment: it has no systemd, no host Docker socket and no privileges, so the updater, tunnels, `doctor`, laptop mode and the privileged System Terminal do not apply inside it (the updater is disabled).

```bash
git clone https://github.com/maksymhs/Citadel.git && cd Citadel
docker compose up --build
```

Open `http://127.0.0.1:3001`. Set `CITADEL_TRIAL_PORT=3010` to choose another port before running Compose. The first-run **setup code** stays inside the container's data volume, reachable only with shell access there:

```bash
docker compose exec citadel cat /data/setup-code
```

State (SQLite and projects) lives in the `citadel-data` volume: `docker compose down` keeps it, `docker compose down -v` discards it. The port is published on loopback only; change it in `compose.yaml` if you deliberately want LAN access.

The image includes `tmux` and `git`, so persistent terminals and projects work. AI CLI agents are **not** installed — install them inside the container only for a throwaway test. To use your own repositories, add a bind mount under `/data/projects` in `compose.yaml`.

This image is for trying Citadel out, not for running it. For anything real, use the installer above so tmux, agents, tunnels and updates are managed on the host.

This image exercises **Linux**, including when Docker runs on a Mac. It does not
simulate macOS or validate launchd, Keychain or macOS permissions. Run platform
checks on a real Mac or a macOS VM; Linux trial checks need no host installation.

### Optional AI Gateway

Open **Settings → AI Gateway** as an administrator to install the local component,
connect ChatGPT by device login, choose planning/execution models and enable it
for new Claude Code sessions launched from Projects. It binds only to loopback,
requires no sudo and remains off by default. This experimental integration does
not enable automatic quota fallback. See [setup and limitations](ai-gateway.md).

### Project folders and VS Code

Opening **Projects**, or clicking **Refresh**, scans immediate non-hidden folders
under `PROJECTS_DIR`. Suggestions are read-only; choose **Import folder** to
register one. Registered projects and associated repositories are excluded, as
are directory symlinks and `node_modules`. Scans stop after 500 entries or 100
suggestions and never recurse or execute repository code. Use **Import folder**
for other folders or to choose a different project name.

A project's **More actions → Open VS Code in browser** opens the optional web
editor inside Citadel. On first use, choose **Install browser editor and open
project**; afterwards the project action opens it directly. **Back to Citadel**
restores the panel. The project terminal toolbar also has a **VS Code** button.
New editor profiles start in dark mode; existing theme preferences are preserved.
No desktop app or SSH setup is required. The editor is
administrator-only, runs on demand and consumes additional resources. It
currently supports the machine serving this panel; for paired machines, use
that machine's own panel. See [browser editor setup](browser-editor.md).

## Updating an existing installation

Re-running the same installer upgrades in place: it pulls the latest code from the configured branch, reinstalls dependencies, refreshes the service unit and helper scripts, and restarts Citadel. Your data, `.env` and projects are preserved.

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash -s -- --update
# or, once installed:
citadel update
```

## Managing Citadel (`citadel` CLI)

Once installed, a small `citadel` command is available system-wide:

```bash
citadel status     # service, version, panel URL and health
citadel url        # print the panel URL
citadel qr         # one-time QR code to pair another Citadel (valid 10 minutes)
citadel logs       # follow the service logs
citadel start      # start the service (after `citadel stop`)
citadel stop       # stop the service
citadel setup-code # first-run code needed to create the admin account
citadel restart    # restart the service
citadel menubar on # macOS: menu bar icon (on|off|status)
citadel reset-password [--list | USER]  # forgot the panel password: set a new one (needs shell access)
citadel update     # update to the latest version
citadel tunnel     # global URL via a Cloudflare Quick Tunnel
citadel power      # show lid-close/sleep state (laptop hosts)
citadel power on   # 24/7 mode: ignore lid close, block suspend/hibernate
citadel power off  # restore the system sleep defaults
```

`citadel update`, `citadel tunnel` and `citadel power on|off` need root and re-invoke `sudo` automatically.

`citadel reset-password` is the recovery path for a forgotten panel login. It runs as the account that owns the database (via `sudo` when needed), prompts for the new password (or reads it from stdin), signs out that user's sessions and writes an audit entry. Each instance has its own login, so run it on the machine whose password you lost. Paired-machine tokens and the credential vault are not affected.

## Laptop server / always-on mode

Citadel enables 24/7 mode by default so closing a laptop lid does not suspend the panel, terminals or agents. Use `--no-24-7` during installation to opt out, or run `sudo citadel power on` later to enable it:

- make **systemd-logind ignore the lid switch** (on battery, AC and docked);
- mask the **sleep, suspend, hibernate and hybrid-sleep** targets so nothing else can suspend the host;
- set `IdleAction=ignore`.

The change survives reboots. `sudo citadel power off` removes the Citadel drop-in and unmasks only the targets Citadel masked, restoring the previous power policy. The live camera pairing and all web features keep working while the lid is closed; the display itself may still turn off depending on your desktop environment.

## Privileged System Terminal (opt-in)

The **System Terminal** can run as a privileged account so you can administer the whole host from the panel. It is **disabled by default**; enable it explicitly:

```bash
sudo bash install.sh --admin-terminal            # run terminals as the installing user
sudo bash install.sh --admin-terminal=deploy     # run terminals as 'deploy'
sudo bash install.sh --no-admin-terminal         # unprivileged service user only (default)
```

The named user must exist on the host; the installer validates it and refuses to continue otherwise. It installs a scoped `sudoers` rule, relaxes the systemd sandbox and sets `TERMINAL_ADMIN_USER` in `.env`. **Security warning:** it makes the panel root-equivalent — anyone able to log into the panel can obtain a root shell on the host. Only enable it on a personal, single-admin server.

## In-panel Updater

Citadel checks GitHub for new releases (System view) and — when the updater is installed — can update itself with one click. It is **enabled by default**; skip it with `--no-updater`. To add it to an existing install, re-run the installer:

```bash
sudo bash install.sh --update
```

It installs a root-owned helper at `/usr/local/sbin/citadel-update` plus a scoped `sudoers` rule granting the service user permission to run **only that helper** as root. The helper fetches the configured branch, resets the working tree, reinstalls dependencies and restarts the service. Before running it the panel verifies the helper is a regular, root-owned file that is not group/world-writable, and refuses otherwise. Without the helper the System view still reports the running version and available updates, but applying them requires running `scripts/update.sh` manually.

## Local network access (opt-in)

The panel listens on `127.0.0.1` only unless you ask for network access. To reach it from your phone on the same Wi-Fi (the installer then whitelists the LAN origin in `ALLOWED_ORIGINS`, required by the terminal WebSocket, and opens the port in `ufw` when active):

```bash
sudo bash install.sh --lan                 # listen on 0.0.0.0 (QR works on your LAN)
sudo bash install.sh --host=192.168.1.10   # or bind a specific address
sudo bash install.sh --local              # explicit local-only (the default)
```

For access from **any** network without exposing the host, prefer Tailscale (see *Access from your phone* below).

Reverse-proxy trust: by default only loopback peers may set `X-Forwarded-*` headers (`CITADEL_TRUST_PROXY`, default `loopback`). A directly connected client can therefore never spoof its IP to bypass rate limits. If you put Citadel behind a proxy on another host, set `CITADEL_TRUST_PROXY` to that proxy's IP/CIDR (comma-separated); `true` trusts every client and should only be used when the app is not directly reachable.

## Synchronized updates across hosts

To make one "Update" action roll out to several hosts, give each host the same secret and the list of its peers in `.env`:

```
CITADEL_PEERS=https://vps2.example.com
CITADEL_PEER_TOKEN=<long-random-shared-secret>
```

When set, triggering an update also asks every peer to update itself. The peer endpoint is token-authenticated (constant-time) and never fans out again, so there are no update loops. Keep the token out of version control.

## Distributed task mesh

Parallel work across paired nodes. See [docs/task-mesh.md](task-mesh.md).

## Observability (logs & metrics)

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

## File Explorer

The **Files** view browses the host filesystem: navigate directories, read and edit text files, create folders/files, rename, delete and download. When the panel is configured with an admin user (`--admin-terminal`), it can reach the **whole host** (the operations run as that user through the existing scoped `sudo` rule, with paths passed as data — never interpolated into a shell). Without an admin user it is limited to what the service user can access. Write operations are recorded in the audit log.

## Remote access, pairing and tunnels

Scan a QR from your phone, pair several Citadel machines and expose the panel globally (Cloudflare Quick Tunnel, or a stable URL on your own domain from **Settings → Tunnel**). Quick start: `citadel qr` (or `citadel qr --url` on small terminals), `citadel tunnel`, `citadel tunnel --domain=HOST --token=TOKEN`. Full details: [docs/remote-access.md](remote-access.md).

**Mesh pairing (always on).** Machines that are already paired introduce each other, so every machine ends up paired with every other one (single-use invitations, one token per direction, no credential vault merge), with no setting to turn on. Once paired, the machine selector under the logo opens any machine's terminals, logs and processes. *Unpair* removes a machine from both sides.

**Update propagation (always on).** Once this machine is updated and healthy, it updates each paired machine that is behind, waiting for it to come back on the new version before starting the next, and stops at the first one that does not. *Update paired machines now* runs it on demand. Machines updated this way do not propagate further.

## Git credentials for terminals

The installer also registers a git credential helper (`/usr/local/bin/citadel-git-credential`) system-wide. It lets plain `git fetch/pull/push` inside project terminals reuse the provider tokens you stored in **Repositories**, decrypting them on demand — tokens are never written to disk in clear text. It only resolves credentials for hosts that have a configured provider (GitHub/GitLab).

## Managing AI CLI agents from the panel

In **Machines → Tools**, administrators can install, reinstall/update, or remove a
Citadel-managed agent. These actions open a terminal as the service account;
installation success is reported only after the downloaded executable passes its
version check. Codex must also include a working `codex-code-mode-host`.

New installations use isolated releases below
`$CITADEL_AGENTS_DIR/packages/<binary>/release-*`, with an atomically replaced
launcher in `$CITADEL_AGENTS_DIR/bin`. If the shared root is unavailable, the
installer uses `~/.citadel/agents` for the service account only. Existing PATH and
older shared installations remain detectable. Reinstall/update downloads the
vendor's current default version; it does not promise a version increase.
Restart agent sessions after activation.

**Remove** removes only the managed launcher. Downloaded releases (including
failed attempts) remain on disk for recovery and to avoid breaking processes that
still use their companion executables. This does not reclaim their disk space.
Other installations in PATH may still be detected afterwards. Citadel does not
remove external installations, user credentials, sessions, or `~/.codex` data.
Reinstall an older agent through the panel to create a managed installation before
using Remove. Do not delete retained releases while agents or daemons use them.

The installer changes sharing permissions only within the newly downloaded
release, never recursively on existing agent directories. Linux and macOS use the
same lifecycle helper; no change to the host/system installers is required.
