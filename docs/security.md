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
- **Clipboard images in terminals**: image paste uploads PNG, JPEG, GIF or WebP (up to 5 MiB) over the authenticated API to the selected terminal host, then inserts only a generated file path. The file is private to the terminal's OS identity (directory `0700`, file `0600`) under the host's temporary directory; it is not sent through the PTY or written to logs. A 50 MiB per-identity quota is enforced, and files older than 24 hours are removed on a later image upload (not by a background timer). System images use the configured System account only when that terminal does; project images remain owned by the service user. This feature does not validate image contents beyond MIME and file signatures.
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

Project registration removal preserves files by default; the UI separates explicit
disk deletion with exact-path confirmation. Server removal guards reject live
registered terminals, any owner's running legacy Chat engine (without revealing
identity/history), and the shared editor process. Legacy Chat startup and guarded
deletion are serialized. The panel checks only terminal/editor status; the server's
legacy Chat guard remains authoritative even though the GUI is removed. Editor
status is global, not authoritative per-folder tracking, so all project removals
conservatively require that process stopped. These checks do
not detect arbitrary host processes or provide filesystem/OS isolation. Existing
explicit `deleteFiles=true` API behavior and managed-tree validation remain.

## Detected-folder deletion

The separate admin-only `DELETE /api/projects/discover` action requires an exact
canonical path and matching typed confirmation. It accepts only visible real
immediate directories under canonical `PROJECTS_DIR`; root, nested/outside paths,
aliases, symlinks, files and `node_modules` are refused. Registered projects/repos,
including registered descendants and canonical aliases, are rechecked before
synchronous removal. Successful removal is verified and audited; raw filesystem
errors/descendant names are not returned. Dismiss **×** is still purely local.

This protects registration boundaries, not arbitrary filesystem activity. The
validation/removal critical section prevents imports from interleaving in this
Node process, but does not atomically exclude hostile external filesystem changes.
A path-only request cannot identify a folder replaced before submission. Recursive
removal can fail partway; failure is never reported or audited as success. Back up
work first; this is not a trash/recovery feature.

## System management boundaries

System reads processes, persistent terminals, shared browser VS Code and tools
from the selected machine through existing authenticated local/paired APIs. Stop
controls require explicit confirmation; general process signaling and shared
editor management require an administrator. Terminal permissions remain enforced
by the existing routes. Closing the editor disconnects all projects using the
single shared instance; Workspace **Close all** warns about that effect too.

General process signals accept only a positive numeric PID, current Linux
boot/start-ticks identity and explicit TERM or KILL. Fresh synchronous checks
require real/effective/saved/filesystem UIDs to equal the service UID and protect
PID 1, Citadel and its ancestor chain; incomplete ancestry fails closed. No shell,
sudo, process-group signaling or automatic escalation is used. Non-Linux platforms
remain read-only for general processes (managed terminal/editor stops still work).
Only signal delivery is reported and audited, not confirmed process exit.

Node has no native pidfd signaling API: identity checks reject stale listings and
narrow, but cannot eliminate, external PID reuse after the last inspection. These
controls are not an OS sandbox and do not grant new OS privileges. Running Citadel
as root still exposes root-owned processes and is not recommended.

## Legacy Chat API boundaries

The native Chat GUI and all panel entry points have been removed. The panel no
longer makes Chat API calls or offers Chat status/stop controls. `chatRoutes`,
`chatService` and their storage/tests remain for legacy API compatibility and
server-side project removal safety. Removing the GUI does not delete histories,
preferences or user data and does not stop existing engines.

The retained API requires an administrator's browser session cookie; bearer/peer
credentials are not accepted. Routes reject unexpected
origins, cross-site fetches and query parameters, use `no-store`, validate bounded
inputs and check owner, project and canonical directory for every session operation.
SSE periodically rechecks the signed-in administrator and session scope. Audit
entries record action/project identity, not prompts, answers or transcripts.

The legacy service requires an installed OpenCode 1.19.x engine and an explicitly
opted-in, running OpenCode AI Gateway configuration. Startup checks required APIs and the
resolved gateway-only provider/model configuration; no native-provider fallback
or CLI login-cache import is allowed. The engine listens on loopback with random
Basic authentication held server-side. Browser cookies and engine credentials
are not exposed through an arbitrary proxy: the embedded GUI and root OpenCode
API proxies are removed; VS Code's scoped proxy remains. Engine error diagnostics
expose only normalized operations and status/reason, never upstream response bodies
or engine session/request IDs. Startup also checks exact gateway aliases and Plan
deny rules; HOME/XDG runtime directories reject symlinks before launching.

Metadata/request digests live in private `DATA_DIR/chat/metadata.sqlite` (WAL),
separate from the main schema. Transcripts/state persist in hashed HOME/XDG trees
scoped to owner, project and canonical directory. Chat uses an allowlisted child
environment and disables project config, external skills, Claude Code config
loading, sharing and auto-update. Build defaults to ask; Plan additionally denies
edit, bash, task and external-directory permissions. The legacy API supports
one-time allow/reject and question replies/rejection, not permanent grants.
These are logical/application boundaries, **not a sandbox**: the engine and
approved tools run as the shared Citadel service user and can access files that
user can access. Chat does not
encrypt its metadata/transcripts; treat the whole tree and backups as sensitive.

Disconnecting or closing the panel does not cancel an existing legacy runtime.
The retained cancellation/stop endpoints and clean server shutdown keep their
existing behavior; shutdown kills its process group. Legacy SSE provides update
notifications and bounded snapshots, not guaranteed full history/event replay.
Paired-machine Chat transport remains unavailable. Backend fixtures and an
isolated installed-engine capability/session/snapshot check do not establish
real-model or browser compatibility.

## Browser workspace preferences

Browser localStorage remembers Terminal/VS Code mode and selection hints scoped
by owner, panel instance, selected host and project; terminal selection and editor
state are independent. Stored choices are not authorization. Old Chat preferences
are retained but an old saved Chat mode opens the chooser without starting work.
Server ownership and canonical-directory checks remain authoritative. Browser
storage is not encrypted or a security boundary against same-origin scripts or
people with access to the browser profile.

## AI Gateway boundaries

The optional [AI Gateway](ai-gateway.md) requires administrator setup and access
to gateway-enabled project terminals. It binds to loopback and uses separate
Claude/ChatGPT authorization. Persistent credentials are encrypted; the external
proxy needs private temporary plaintext files while running (Linux uses
`/dev/shm` where available). Clean shutdown removes them; abrupt termination can
leave temporary files until host cleanup. Request/error-body capture and panel
downloads are disabled. The loopback management API requires a separate private
key for Claude OAuth, with remote access disabled; its wildcard callback
forwarder is not used. Browser callbacks validate pending state and redirect
origin/path. Existing CLI OAuth caches are never imported. Stable aliases and
explicit Claude/ChatGPT/Auto routing are supported. Opt-in OpenCode and Codex
launchers reuse the local client key through process environment variables; Codex
uses private PATH shims and structured provider overrides, not global config or
login-cache edits. Gateway-enabled launches remain administrator-only; live account-pair
compatibility and arbitrary streaming/tool replay remain unverified.
