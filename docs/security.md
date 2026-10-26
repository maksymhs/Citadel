# Security, isolation & limitations

Back to the [README](../README.md).


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


## Deployment details

Moved from the architecture guide.

Citadel provides **logical separation** between projects: each project has its own directory, its own terminal sessions and its own deployment record. However, its real isolation scope is worth understanding:

- **A single Linux user**: all projects, terminals and agents run under the same system user (the `citadel.service` user, or whichever user runs the server). **There is no OS-level isolation** (no containers, `chroot`, namespaces or distinct UIDs) between projects. A project can, in principle, read or modify the files of another project that this user can access.
- **A terminal is equivalent to a shell for the service user**: obtaining a terminal in the panel is equivalent to obtaining an interactive shell with the privileges of the account running Citadel. By default that account **is not root** and the service grants no elevated privileges; running the server as `root` would result in a `root` terminal.
- **Privileged System Terminal** (opt-in: `--admin-terminal[=user]`, skipped by default and with `--no-admin-terminal`): only an administrator may create, list, attach to, capture, use copy-mode on, or delete global/System sessions. The configured System shell starts as the chosen OS user through a scoped sudoers rule; project shells still start as the Citadel service user. This is **not an OS isolation boundary**: the sudoers grant belongs to the shared service UID, project processes and agents run as that UID, and the systemd sandbox is relaxed for the whole service (`NoNewPrivileges=false`, `ProtectSystem=false`, `ProtectHome=false`). The existing Files integration can also access host paths under this configuration. Do not use this mode with untrusted projects or users; use separate OS identities and an isolated privilege broker for that threat model. The installer validates the target account, and the application never stores sudo passwords or silently falls back to another identity.
- **In-panel updater** (opt-in: `--enable-updater`, disabled by default and with `--no-updater`): installs a root-owned helper at `/usr/local/sbin/citadel-update` and a sudoers rule allowing the service user to run *only* that helper as root. Before executing it the server verifies the helper is a regular, root-owned file that is not group/other-writable. The privilege granted is narrow (no arbitrary commands), and the helper only pulls the configured branch.
- **Network exposure**: the server binds `127.0.0.1` and trusts forwarded headers only from the local loopback proxy (`CITADEL_TRUST_PROXY`, default `loopback`). LAN binding (`--lan`/`--host`) and the Cloudflare tunnel (`--tunnel`) are explicit opt-ins, so a fresh install is never published before the administrator account exists.
- **Git credential helper**: the installer registers a system git credential helper (`/usr/local/bin/citadel-git-credential`) that resolves the host to a provider and decrypts the stored token on demand, so project terminals can `git push` without storing tokens in clear text. Only the service user that owns `DATA_DIR` (and thus `secret.key`) can decrypt them.
- **Path validation**: an ad-hoc terminal directory sent by the client and the recursive deletion of project files are validated against the managed tree (`PROJECTS_DIR`). Docs paths are resolved against both the canonical project and docs roots, only Markdown files are accepted, and symlinks may not escape; autonomous mission files stay under `CITADEL_MISSIONS_DIR`. The *import* project operation deliberately allows registering any host directory chosen by the administrator (it is an intentional feature, not a vulnerability, and it requires authentication).
- **WebSocket origin validation**: connections without an `Origin` header (non-browser clients, scripts) are accepted, but in all cases a valid authenticated session via cookie or token is required.
- **Optional integrations**: Caddy and Docker are only queried when available locally. The Caddy admin API must keep listening on `127.0.0.1:2019` and never be exposed publicly; Docker is accessed only through the local, read-only Unix socket for inspection.
- **No absolute security guarantee**: Citadel reduces the exposure surface through `HttpOnly`/`SameSite=Strict` cookies, origin validation, rate limiting, security headers and structured process execution, but it does not replace a security review specific to each deployment.


## Task queue and activity boundaries

Task orchestration endpoints require an administrator session; workers use scoped
node tokens for heartbeat, claim and result reporting. Retired autonomous work is
excluded from claims, and migration 017 cancels pending work and requests running
work to stop without discarding its execution identity. Historical metadata and
user Markdown are retained; removed Project hub APIs and scripts are not served.

Session activity timestamps update at most once per minute. Expiry is still
checked on every request. Shared redaction handles quoted values, JSON keys,
Basic/Bearer authorization, credential URLs and private-key blocks; it is a
format heuristic, not proof that arbitrary text contains no secret. Activity
redacts nested credential fields, including historical rows. No raw PTY output
or keystrokes are copied into this journal.

Project discovery lists bounded immediate directories and never executes code
or follows directory symlinks. The optional [browser editor](browser-editor.md)
requires administrator access for setup, HTTP and WebSockets. Its protected
backend binds only to loopback, with server-side authentication; browser session
credentials are filtered at the proxy. It runs as the Citadel user and is not a
project sandbox. Stopping it terminates its editor process group.

The optional [Claude Code Gateway](ai-gateway.md) requires administrator setup and access
to gateway-enabled project terminals. It binds to loopback and uses separate
Claude/ChatGPT authorization. Persistent credentials are encrypted; the external
proxy needs private temporary plaintext files while running (Linux uses
`/dev/shm` where available). Clean shutdown removes them; abrupt termination can
leave temporary files until host cleanup. Request/error-body capture and panel
downloads are disabled. The loopback management API requires a separate private
key for Claude OAuth, with remote access disabled; its wildcard callback
forwarder is not used. Browser callbacks validate pending state and redirect
origin/path. Existing CLI OAuth caches are never imported. Stable aliases and
explicit Claude/ChatGPT/Auto routing are supported; live account-pair
compatibility and arbitrary streaming/tool replay remain unverified.
