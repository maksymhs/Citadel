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
- **Privileged System Terminal** (opt-in: `--admin-terminal[=user]`, skipped by default and with `--no-admin-terminal`): the non-project *System Terminal* is launched as a chosen OS user via a scoped `sudoers` rule, and the systemd sandbox is relaxed (`NoNewPrivileges=false`, `ProtectSystem=false`, `ProtectHome=false`). This intentionally makes the panel **root-equivalent**; the installer validates that the user exists and refuses invalid names.
- **In-panel updater** (opt-in: `--enable-updater`, disabled by default and with `--no-updater`): installs a root-owned helper at `/usr/local/sbin/citadel-update` and a sudoers rule allowing the service user to run *only* that helper as root. Before executing it the server verifies the helper is a regular, root-owned file that is not group/other-writable. The privilege granted is narrow (no arbitrary commands), and the helper only pulls the configured branch.
- **Network exposure**: the server binds `127.0.0.1` and trusts forwarded headers only from the local loopback proxy (`CITADEL_TRUST_PROXY`, default `loopback`). LAN binding (`--lan`/`--host`) and the Cloudflare tunnel (`--tunnel`) are explicit opt-ins, so a fresh install is never published before the administrator account exists.
- **Git credential helper**: the installer registers a system git credential helper (`/usr/local/bin/citadel-git-credential`) that resolves the host to a provider and decrypts the stored token on demand, so project terminals can `git push` without storing tokens in clear text. Only the service user that owns `DATA_DIR` (and thus `secret.key`) can decrypt them.
- **Path validation**: an ad-hoc terminal directory sent by the client and the recursive deletion of project files are validated against the managed tree (`PROJECTS_DIR`). Docs paths are resolved against both the canonical project and docs roots, only Markdown files are accepted, and symlinks may not escape; autonomous mission files stay under `CITADEL_MISSIONS_DIR`. The *import* project operation deliberately allows registering any host directory chosen by the administrator (it is an intentional feature, not a vulnerability, and it requires authentication).
- **WebSocket origin validation**: connections without an `Origin` header (non-browser clients, scripts) are accepted, but in all cases a valid authenticated session via cookie or token is required.
- **Optional integrations**: Caddy and Docker are only queried when available locally. The Caddy admin API must keep listening on `127.0.0.1:2019` and never be exposed publicly; Docker is accessed only through the local, read-only Unix socket for inspection.
- **No absolute security guarantee**: Citadel reduces the exposure surface through `HttpOnly`/`SameSite=Strict` cookies, origin validation, rate limiting, security headers and structured process execution, but it does not replace a security review specific to each deployment.


## Autonomous work and memory boundaries

Project hub and its task/document/context endpoints are administrator-only and can be disabled as the
`missions` module. Mission plans are untrusted model output: the server accepts
only roles, earlier-task indices, installed agents and bounded acceptance
criteria, never commands, binaries or paths. One autonomous agent may run at a
time across the instance; manual queue work and persistent terminals are not
serialised by that guard, and `CITADEL_AUTONOMOUS_DAILY_BUDGET` bounds how many
autonomous attempts start per day. Learning content is advisory and redacted
before storage; mission goals, notes, review notes and prompts pass through the
same redaction, and a document whose body looks like a credential is refused.
Only an explicit operator promotion makes a lesson global, and no lesson can
change a security policy. Rejected task results, acceptance decisions and global
promotions are written to the audit log. See [missions](missions.md).

Session activity timestamps update at most once per minute to avoid writes on
every polling request. Expiry is still checked on every request and never
extended by this optimisation. Work redaction handles quoted values, JSON keys,
Basic/Bearer authorization, credential URLs and private-key blocks; it is a
format heuristic, not proof that arbitrary text contains no secret. Project
discovery only lists bounded immediate directories and never executes code or
follows directory symlinks. Opening VS Code is an explicit desktop action using
the operator's existing SSH configuration.

Project hub snapshot, trace and code-graph routes require the optional module and
an administrator session. Journal rows persist their project scope, independently
of task retention, and cursor queries use a project/event index. Traces redact
nested credential fields and matching text formats, including historical rows.
No raw PTY output or keystrokes are copied into this journal. The graph scanner
uses canonical paths, ignores symlinks and vendor directories, bounds file reads
and traversal, and executes no project code.
