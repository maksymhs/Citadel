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
| `--tunnel` | Public Cloudflare Quick Tunnel URL |
| `--admin-terminal[=user]` | Root-capable System Terminal (privileged) |
| `--enable-updater` | Root-owned in-panel updater |
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
POST /api/tasks/claim        {node, protocol?}                            # pull one (204 if none) → returns claimToken
POST /api/tasks/:id/result   {status, exitCode?, resultRef?, error?, result?, claimToken, execId?}  # report + captured output
POST /api/tasks/:id/reconcile {state: alive|terminated|unknown, claimToken, execId, exitCode?, signal?, pid?, pgid?, startedAt?}  # worker-only
POST /api/tasks/:id/cancel                                                # request cancel (queued or running, idempotent)
GET  /api/tasks?status=&node=                                             # progress
POST /api/nodes/heartbeat    {node, capacity, active, load, tags?, running?: [{id, claimToken, execId?, pid?, pgid?, startedAt?}]}  # liveness + lease renewal
GET  /api/nodes                                                           # list nodes and load
```

The heartbeat `running` list is a *witness list*: the server renews exactly those attempts and only while the reported claim token still matches the stored one. A running task that stops being reported is not renewed and expires through the normal reclaim path; a delayed or duplicated heartbeat cannot resurrect a finished task or extend an older attempt. For compatibility, plain id strings (or objects without `claimToken`) are still accepted, but their guarantee is explicitly weaker — renewal binds only id/node/status, so a delayed beat from an earlier attempt of the same node can extend a newer one. Expired attempts are still safe (reclaim runs before renewal, so they cannot be resurrected) and a task re-claimed by another node is protected by the node guard; the server emits a one-time `node_heartbeat_unbound` warning so operators know to upgrade the client. An omitted `running` list is treated as a legacy client and renews node-wide (with a one-time `node_heartbeat_legacy` warning), because refusing to renew would requeue tasks that are still executing.

**Claim tokens and retries.** Every claim mints a random `claimToken` and bumps `attempt`; reporting a result requires that exact token, so a worker whose lease expired (and whose task was retried elsewhere) can never overwrite the newer attempt's result. Expired leases requeue the task while attempts remain (`task_lease_expired` event) and mark it failed once `maxAttempts` is reached (`task_attempts_exhausted`).

**Tracked executions (sentinel protocol 2).** A sentinel that sends `protocol: 2` promises a durable local journal and process-level reconciliation. The claim records the protocol, every spawned execution gets a random `execId` and its PID/PGID/start token are reported in the heartbeat, and an expired lease no longer implies "nothing is running": an attempt with execution evidence becomes `reconcile_state='uncertain'` instead of being requeued. The owning node then calls `POST /api/tasks/:id/reconcile` with the attempt's `claimToken` and `execId` and the observed `state`: `alive` re-authorizes the same execution and renews its lease, `terminated` finalises it (with an exit code) or requeues it safely (outcome unknown but the process is provably gone), and `unknown` keeps it blocked for an operator. A late or foreign execution can never resolve a newer attempt, and reconciliation is idempotent. Once a lease has expired, the attempt loses authority even if no one has reclaimed it yet; a result arriving after expiry is rejected and must use the reconcile path.

**Execution authority.** A result is accepted only while the attempt still holds a valid lease *and* presents the current claim token; both checks and the write happen atomically with the ownership guard. Once the lease has expired the attempt has no authority even if nobody has reclaimed the task yet: the result is rejected (`task_result_rejected_expired` event) and the task is requeued — or failed when `maxAttempts` is reached — in the same transaction. A running row whose lease is missing (NULL/empty — only possible from a manually repaired or legacy database) is treated the same way and rejected with `task_result_rejected_no_lease`; a null lease is never read as an indefinite one, and the same reclaim path recovers the row. A tracked attempt whose lease expired is not finalised by time alone: it stays `running` (or `cancelling`) with `reconcile_state='uncertain'` until its node proves the process outcome. Cancelling a running task whose lease already expired (or is missing) finalises it as `cancelled` immediately when there is no execution evidence; with a tracked execution it remains a request. A late result can never reopen a terminal state.

**Agent tasks.** Instead of a raw command, enqueue `{"agent":"claude|codex|opencode","prompt":"..."}` and Citadel builds the headless invocation from the agent registry (`opencode run`, `claude -p --output-format json`, `codex exec --json`), so the orchestrator never needs to know each CLI's flags.

**Result and cancellation.** The sentinel captures a bounded tail of the task's stdout/stderr and stores it in `result` (readable via `GET /api/tasks/:id`), and exports `CITADEL_TASK_ID`, `CITADEL_TASK_NODE`, `CITADEL_TASK_PROJECT` and `CITADEL_EXEC_ID` to the child so agents can name worktrees/branches idempotently. Executions are spawned detached in their own process group, so cancellation reaches descendants too. Cancelling a running task is a *request*: the task moves to `cancelling`, the sentinel receives it on the next heartbeat (SIGTERM, then SIGKILL after a bounded grace period, default 10 s), and the task becomes `cancelled` only when the worker confirms that the process tree is gone. Cancellation is idempotent: repeating it on `cancelling`/`cancelled` returns the current state (HTTP 200) instead of an error. If termination cannot be confirmed, the task is reported as `unknown` and is never marked cancelled falsely. A journaled execution that outlives a sentinel restart is re-adopted; one that is provably gone is reported terminated; one that cannot be verified stays blocked for an operator.

**Sentinel (one per node).** Run it inside a Citadel terminal so tmux keeps it alive across restarts, or as a systemd unit. The journal lives in `CITADEL_SENTINEL_STATE_DIR` (default `~/.citadel/sentinel`, directory `0700`, file `0600`) and contains per-claim tokens — never log or copy it to a world-readable location. A lock file per node/state directory prevents two sentinels from adopting the same executions; a lock left by a dead process is reclaimed. Tune the escalation with `CITADEL_KILL_GRACE_MS` (default 10000) and `CITADEL_KILL_CONFIRM_MS` (default 5000), and the HTTP bound with `CITADEL_HTTP_TIMEOUT_MS`. Prefer **per-node credentials**: set `CITADEL_NODE_TOKENS="vps-2:<random>,vps-3:<random>"` on the server and give each sentinel its own value in `CITADEL_NODE_TOKEN`. The credential is bound to that node id, so a node cannot claim, heartbeat, report or reconcile as another node, and the shared token is ignored while per-node tokens are configured (no silent downgrade). If the variable is set but every entry is malformed (short token, missing separator, invalid node id), the server **fails closed**: worker node-token auth is disabled — the shared token is *not* used as a fallback — and a clear error is logged until the value is fixed. Leave the variable unset (or empty) to keep the legacy installation-wide `CITADEL_NODE_TOKEN` shared by every node — any holder may declare any node id — which is only appropriate when all nodes are inside the same operator's trust perimeter. `CITADEL_TOKEN=<session id>` also still works but grants the node a full panel session. Rotate or revoke by editing the map and restarting the server:

```
CITADEL_URL=https://panel.example.com \
CITADEL_NODE_TOKEN=<this node's secret> \
CITADEL_NODE=vps-2 \
CITADEL_CAPACITY=2 \
node scripts/sentinel.js
```

**Tracking limits.** Process attribution is strongest on Linux (`/proc` start time plus `CITADEL_EXEC_ID` in the inherited environment). On macOS the start token and process group are still verified, but descendants that outlive their leader cannot be found by environment scanning; the sentinel reports `unknown` rather than relaunching. The legacy shared token does not give per-node cryptographic identity, and pre-protocol-2 clients keep the older expiry/requeue semantics (an expired lease is assumed to mean the process is gone). A node that never returns leaves its tracked attempt `uncertain` until an operator reconciles it.

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

The installer and `citadel qr` print a scannable one-time pairing QR code, and **Settings → Connection** shows a fresh pairing code. The encoded address is chosen automatically: an explicit `CITADEL_PUBLIC_URL`, otherwise an active **Cloudflare Quick Tunnel**, otherwise a **Tailscale** `*.ts.net` address, otherwise the LAN IP (which only works on the same Wi-Fi).

The same code does both jobs: scanning it with any camera app opens the panel, while scanning it from another Citadel's **Pair a machine** screen pairs the two hosts. **Settings → Connection** always shows a fresh single-use pairing code (it expires in 10 minutes); use **New code** to generate another one.

> **Camera on a phone:** the live in-browser camera requires HTTPS (or `localhost`). When the panel is opened over plain HTTP, or in a browser without live QR support, pairing still works with **Take a photo of the QR** (native camera capture) or by pasting the link.

### Switching between paired machines

The machine selector above the sidebar lists this host plus every paired machine with a live status dot. **Pair a machine…** accepts a scanned or pasted code:

1. On machine A: open **Settings → Connection** to show the dual-purpose QR.
2. On machine B: sidebar → machine selector → **Pair a machine…**, then scan the code (live camera or photo) or paste its link.
3. Both sides store each other. Use the selector to jump between them; the browser URL never changes.

Pairing stores a stable instance id and **every candidate address** the host reports. A Cloudflare Quick Tunnel URL changes on every restart, so paired hosts re-announce their current addresses right after boot and every five minutes; the proxy tries each candidate until one answers. If an address is stale, the next announcement repairs it — no re-pairing needed. Because every peer request and response carries the sender's identity and current addresses, a single successful call in either direction repairs both sides. The browser also caches addresses it has seen and syncs them back on load, which covers the case where only the panel's own tunnel rotated. Unpair from **Settings → Machines** (or the selector's **Manage machines…**): it always removes the machine locally, and revokes the token on the remote side when that machine can be reached.

Peer credentials are separate per direction: the inbound token is stored only as a SHA-256 hash, the outbound token is encrypted at rest with the existing vault key, and neither is ever exposed to the browser. Pairing links carry the secret in the URL fragment (`#pair=…`), so it is not sent to the server or written to proxy logs.

### Credentials follow the pairing

A pairing code created in **Settings → Connection** (the startup/installer QR does not, as it has no administrator attached) also merges the encrypted credential vault in both directions: environment variables, GitHub/GitLab tokens and the other vault entries (SSH keys, files). The merge runs server-to-server with the paired peer token, so values never reach the browser. The newest `updated_at` wins, equal values are skipped, and deletions stay local. For safety it only runs over HTTPS (or loopback); pairing over a plain-HTTP LAN address still succeeds but skips the merge. Use **Settings → Machines → Sync credentials** to merge again after adding or rotating a token.

### Stable URL on your own domain (named tunnel)

With a domain on Cloudflare (e.g. `citadel.example.com`): in Zero Trust → Networks → Tunnels create a tunnel, add a *Public hostname* pointing to `http://localhost:3000`, and copy its token. Then:

```bash
citadel tunnel --domain=citadel.example.com --token=<TOKEN>
citadel tunnel --quick     # back to a random trycloudflare.com URL
```

**From the panel:** run `sudo citadel tunnel setup` once (installs `cloudflared` and a scoped root helper; the installer already does it), then open **Settings → Tunnel (your own domain)**, enter the hostname and click *Connect domain*. You authorize once in Cloudflare and the panel creates the tunnel, the DNS record and starts the service; the login certificate is deleted afterwards and only the tunnel token is kept.

The URL survives restarts and reboots, and the panel, QR and pairing use it automatically. The token is stored in `data/tunnel-token` (mode 600).

### Global URL with a Cloudflare Quick Tunnel (no account, no domain)

To reach the panel from **any network with a single command**, start a Cloudflare Quick Tunnel:

```bash
citadel tunnel          # installs cloudflared, starts the tunnel, prints the URL + QR
citadel tunnel stop     # stop it
citadel tunnel remove   # stop and delete the service
```

It gives you a public `https://<random>.trycloudflare.com` URL that works everywhere. The installer no longer starts it by default: pass `--tunnel` at install time, or run `citadel tunnel` afterwards. The URL **changes on every restart**, so the panel reads it dynamically and the QR always shows the current one (no need to touch `.env`). If two machines are paired **only** through Quick Tunnels and both restart at the same time, neither can reach the other until one address is supplied again (switch to that panel once, or enter the new address in Settings → Machines). Giving at least one machine a stable address — Tailscale, a named tunnel or `CITADEL_PUBLIC_URL` — makes recovery fully automatic. Because it is a **public** URL, create your administrator account before starting the tunnel and use a strong password.

A Quick Tunnel URL is disposable: when `cloudflared` disconnects or restarts, the old hostname stops working permanently and is not reassigned to you. Nothing is lost — the panel simply follows the URL currently written to `data/tunnel-url` — but bookmarks, phone home-screen shortcuts and the old QR stop working. For a stable address use one of these instead:

- **Tailscale** (recommended for a personal laptop): stable `https://<host>.<tailnet>.ts.net`, no public exposure, no domain or port forwarding.
- **Named Cloudflare Tunnel**: create a tunnel and DNS route for a domain you own (`cloudflared tunnel login`, `cloudflared tunnel create citadel`, `cloudflared tunnel route dns citadel citadel.example.com`), run it as a service, then set `CITADEL_PUBLIC_URL=https://citadel.example.com` in `.env` and restart Citadel.
- **VPS with a public IP**: point a DNS record at the VPS, put Caddy/Nginx with TLS in front of `127.0.0.1:3000`, and set `CITADEL_PUBLIC_URL` to that HTTPS address. Do not expose port 3000 directly over plain HTTP.

On a laptop, 24/7 mode is enabled during installation by default. Run `sudo citadel power on` to re-enable it later if it was disabled. A laptop behind NAT should use Tailscale or a named tunnel rather than depending on a Quick Tunnel URL.


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
