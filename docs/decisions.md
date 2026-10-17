# Architecture Decision Record (ADR)

## ADR-001: Lightweight backend with Node.js LTS and Fastify
- **Context**: A fast, secure web server with low memory usage (<= 50 MB at rest) is needed for modest VPS instances.
- **Decision**: Fastify over Express or NestJS for its superior performance, native validation schema support and modular WebSocket support (`@fastify/websocket`).
- **Consequences**: Near-instant startup, minimal overhead and high capacity for concurrent terminal streams.

## ADR-002: Embedded SQLite database with WAL
- **Context**: Citadel must be self-contained per server without requiring a database daemon such as PostgreSQL or MySQL.
- **Decision**: SQLite using `better-sqlite3` with WAL mode (`journal_mode = WAL`) and normal synchronization.
- **Consequences**: Zero database maintenance, a single file in `data/citadel.db`, straightforward file-copy backups and immediate persistence.

## ADR-003: Terminal persistence via PTY + tmux decoupling
- **Context**: A pure PTY dies if the connection is interrupted or the panel process restarts. Long-running AI agents (such as Claude Code compiling or editing) would lose their working state.
- **Decision**: Use `tmux` as the session persistence backend. `node-pty` acts as the WebSocket bridge between the xterm.js client and `tmux attach/new-session`.
- **Consequences**: Disconnecting the browser does not interrupt the process; reconnecting restores the full screen. If `tmux` is not present on the system, fall back to direct PTY.

## ADR-004: Session authentication with HttpOnly cookies
- **Context**: The platform manages commands and files on the server. Token theft from localStorage via XSS would be catastrophic.
- **Decision**: Sessions stored in SQLite with a random 256-bit identifier, transmitted in an `HttpOnly`, `SameSite=Strict` and `Secure` cookie (when HTTPS is used).
- **Consequences**: Protection against token theft from JavaScript; automatic expiration and immediate revocation capability.

## ADR-005: Strict control of Path Traversal and symbolic links
- **Context**: Project management allows opening and cloning repositories on the host disk. Malicious paths (`../../etc/passwd` or symlinks) could compromise the system.
- **Decision**: Every project path goes through canonical resolution verification (`fs.realpathSync`) and prefix validation against the list of allowed directories (`PROJECTS_DIR` or explicitly authorized paths).
- **Consequences**: Escapes outside the authorized working tree are prevented.

## ADR-006: Agent launching with structured processes
- **Context**: Launching AI tools with arbitrary shell strings exposes the system to command injection.
- **Decision**: The agent registry defines allowed binaries and structured arguments (`string[]`). The validated binary is executed directly in the project's working directory.
- **Consequences**: Zero command injection at the agent layer.

## ADR-007: Optional integrations as decoupled providers
- **Context**: Not every server has Docker or Caddy installed.
- **Decision**: Caddy and Docker are implemented with prior availability detection. If the API or the socket does not respond, the interface shows the "Unavailable / Optional" state without degrading the core project and terminal functionality.
- **Consequences**: The core works 100% on a clean VPS without Docker or Caddy.
