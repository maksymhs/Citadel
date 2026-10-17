# Citadel — System Architecture

## 1. Overview and Design Principles

Citadel is a self-hosted, ultralight, modular and secure web platform designed for developers and AI agents working on a VPS. It provides:

- Unified management of projects and Git repositories.
- Interactive, persistent web terminals (`xterm.js` + `node-pty` + `tmux`).
- A launcher for AI CLI tools and agents (Claude Code, Codex, OpenCode, and custom executables) running under the authorized local Linux identity.
- Monitoring of sessions, processes, resources and auditing.
- Optional publishing through a reverse proxy (Caddy) and optional container support (Docker).
- Reproducible, idempotent deployment through a one-line installer (`install.sh`).

### Core Principles
1. **Development environment first**: Citadel is a workstation for developers and AI agents. Publishing and deployment are accessory capabilities.
2. **Zero heavy dependencies**: It requires no Kubernetes, microservices, Redis, external queues or remote databases. It runs on cheap VPS instances with 512 MB - 1 GB of RAM.
3. **Resilience to missing dependencies**: If `tmux`, `caddy`, `docker` or a CLI agent is not installed, the core degrades gracefully and keeps working.
4. **Secure by design**:
   - Listens on `127.0.0.1` by default.
   - `HttpOnly` and `SameSite=Strict` session cookies.
   - Origin validation on WebSockets.
   - Strict Path Traversal prevention via canonical resolution.
   - Structured process execution (`spawn` with argument arrays), avoiding shell interpolation.
   - Mandatory initial administrator account registration with no default passwords.

---

## 2. Layered Architecture Diagram

```
+-----------------------------------------------------------------+
|                       Web Frontend (SPA)                       |
|   Dashboard | Projects | Terminal (xterm.js) | Agents | System  |
+-----------------------------------------------------------------+
                                | HTTP REST & WebSockets
                                v
+-----------------------------------------------------------------+
|                    Fastify Core & Middleware                   |
|   Rate Limiter | Helmet | Session Auth | CSRF/Origin Guard      |
+-----------------------------------------------------------------+
        |                        |                       |
        v                        v                       v
+---------------+        +---------------+       +---------------+
|  HTTP Routes  |        |  WS Terminal  |       | Plugin Loader |
| /api/auth     |        | /ws/terminal  |       | plugin.json   |
| /api/projects |        +---------------+       +---------------+
| /api/agents   |                |
| /api/git      |                v
| /api/proxy    |        +-------------------------------+
| /api/system   |        | Session & Terminal Manager   |
+---------------+        | (node-pty + tmux attach/spawn)|
        |                +-------------------------------+
        v
+-----------------------------------------------------------------+
|                       Service Layer                             |
| ProjectService | AgentRegistry | GitService | ProxyProvider     |
| DockerService  | AuditLogger   | NodeService (Local / Remote)   |
+-----------------------------------------------------------------+
        |                                        |
        v                                        v
+-----------------------+              +--------------------------+
| SQLite (better-sqlite3)|              | Host Linux OS            |
| data/citadel.db       |              | - Projects (/srv/...)    |
| WAL mode              |              | - tmux sessions          |
+-----------------------+              | - CLI agents / binaries  |
                                       +--------------------------+
```

---

## 3. Data Model (SQLite)

1. **`users`**: ID, username, password_hash, salt, role, created_at, updated_at.
2. **`sessions`**: ID (256-bit token), user_id, expires_at, created_at, last_active.
3. **`projects`**: ID, name, slug, description, path, git_remote, git_branch, created_at, updated_at.
4. **`term_sessions`**: ID, project_id, name, tmux_session, agent_id, status, created_at, last_active.
5. **`audit_logs`**: ID, user_id, action, target_type, target_id, details, ip, created_at.
6. **`deployments`**: ID, project_id, domain, target_port, status, ssl_active, created_at.
7. **`plugins`**: ID, name, version, enabled, config, created_at.
8. **`git_credentials`**: provider (github/gitlab), username, token_encrypted, created_at, updated_at.

> Note: the session identifier is stored directly in the `sessions` table; no additional hashing is applied because it is already a random 256-bit value that the client only knows through an `HttpOnly` cookie.

---

## 3.1 Git Provider Credentials

- Providers (GitHub, GitLab) are connected from the **Repositories** view using a personal access token.
- Tokens are encrypted at rest with AES-256-GCM before being stored in `git_credentials`. The 256-bit key is read from `CITADEL_SECRET_KEY` or generated once into `DATA_DIR/secret.key` (mode `0600`).
- The token is never returned to the browser. Repository discovery uses the provider REST API; cloning and pulling inject the token as a host-scoped `http.<host>.extraheader` **only** for the provider's own host, and `GIT_TERMINAL_PROMPT=0` makes missing credentials fail fast instead of hanging.

---

## 4. Terminal Persistence with `tmux`

- Each project can open multiple terminals.
- Each terminal is bound to a deterministically and safely identified `tmux` session: `citadel_<project_slug>_<session_id>`.
- `node-pty` runs `tmux new-session -A -s citadel_<project_slug>_<session_id>` with the project's working directory.
- If the browser disconnects and reconnects, it reattaches to the same PTY or resumes the tmux session without losing state or killing running processes.
- If `tmux` is not installed on the OS, the manager uses `node-pty` in direct mode and notifies the user to install `tmux` for persistence across restarts.

---

## 5. AI CLI Agent Launcher

The agent registry defines standardized specifications for tools such as:
- **Claude Code** (`claude`)
- **Codex CLI** (`codex`)
- **OpenCode** (`opencode`)
- **Custom Agent** (configured by the administrator)

Each agent is detected by inspecting safe paths and `PATH`. It runs in a dedicated terminal inside the selected project's directory, leveraging the server's Linux user configuration and credentials without exposing secrets to the browser.

The binary and each argument are individually quoted (`shellQuote`) before being written to the PTY, so extra arguments supplied by the browser cannot inject additional commands.

---

## 6. Real Isolation and Limitations

Citadel provides **logical separation** between projects: each project has its own directory, its own terminal sessions and its own deployment record. However, its real isolation scope is worth understanding:

- **A single Linux user**: all projects, terminals and agents run under the same system user (the `citadel.service` user, or whichever user runs the server). **There is no OS-level isolation** (no containers, `chroot`, namespaces or distinct UIDs) between projects. A project can, in principle, read or modify the files of another project that this user can access.
- **A terminal is equivalent to a shell for the service user**: obtaining a terminal in the panel is equivalent to obtaining an interactive shell with the privileges of the account running Citadel. By default that account **is not root** and the service grants no elevated privileges; running the server as `root` would result in a `root` terminal.
- **Opt-in privileged System Terminal** (`--admin-terminal`): when enabled, the non-project *System Terminal* is launched as a chosen OS user (e.g. `ubuntu`) via a scoped `sudoers` rule, and the systemd sandbox is relaxed (`NoNewPrivileges=false`, `ProtectSystem=false`, `ProtectHome=false`). This intentionally makes the panel **root-equivalent**; it is disabled by default and must be enabled deliberately.
- **Path validation**: an ad-hoc terminal directory sent by the client and the recursive deletion of project files are validated against the managed tree (`PROJECTS_DIR`). The *import* project operation deliberately allows registering any host directory chosen by the administrator (it is an intentional feature, not a vulnerability, and it requires authentication).
- **WebSocket origin validation**: connections without an `Origin` header (non-browser clients, scripts) are accepted, but in all cases a valid authenticated session via cookie or token is required.
- **Optional integrations**: Caddy and Docker are only queried when available locally. The Caddy admin API must keep listening on `127.0.0.1:2019` and never be exposed publicly; Docker is accessed only through the local, read-only Unix socket for inspection.
- **No absolute security guarantee**: Citadel reduces the exposure surface through `HttpOnly`/`SameSite=Strict` cookies, origin validation, rate limiting, security headers and structured process execution, but it does not replace a security review specific to each deployment.
