# AGENTS.md

Guide for AI coding agents (and humans) working on Citadel. Read this first, then open the file the task points at. Keep it short: if something here is stale, fix it in the same change.

## What this is

Citadel is a self-hosted web panel to manage projects, persistent terminals (tmux) and AI CLI agents on a VPS, Mac or laptop. Node.js + Fastify 5 + SQLite (`better-sqlite3`, WAL) on the backend, a framework-free SPA in `public/`, bash installers in `install.sh` and `scripts/`. Users, features and install flags are described in [README.md](README.md).

## How to find things (read in this order, stop when you have enough)

1. This file (already loaded).
2. [docs/features.md](docs/features.md): task phrased as a feature ("the Machines screen", "pairing") gives you the exact files, tests and guide.
3. [docs/code-map.md](docs/code-map.md): every source file with a one-line purpose and the screens in `public/js/app.js`.
4. [docs/architecture.md](docs/architecture.md) only when you need to understand how pieces interact (request flow, pairing, updates, data).
5. The source files themselves. `public/js/app.js` (the shell, about 3.9k lines) still holds the terminals, dashboard, projects and Settings: `grep -n "function renderXView" public/js/app.js` and read a slice, never the whole file.

**Do not read whole:** `docs/history/ledger-0001-0097.md` (about 25k tokens; `grep` it for a topic) and `docs/engineering-execution-state.md` (recent ledger; `tail -40` is enough). Add a ledger entry with `cat >> docs/engineering-execution-state.md <<'EOF'`, which needs no read.

**Code graph (optional, saves tokens).** If `graphify-out/GRAPH_REPORT.md` exists, read it before searching broadly: it summarises the main modules and how they connect, and `graphify-out/graph.json` can be queried for callers and dependencies. It is a navigation aid built from the code at the time it ran, so confirm against the source before editing and rebuild it if it looks stale. Build or refresh it with `npm run graph` (needs [Graphify](https://github.com/safishamsi/graphify), a Python dev tool: `uv tool install graphifyy`; never needed on a production host). It is code-only and offline, output is git-ignored, and it is not run by `npm install` or the installer. Whether it is worth keeping is being measured: see [docs/graphify-benchmark.md](docs/graphify-benchmark.md).

## Map of the repo

| Path | What lives there |
| --- | --- |
| `server/index.js` | Bootstrap: plugins (cookie, helmet, rate-limit, websocket, static) and **route registration** |
| `server/config.js` | All environment/config values. New settings go here and in `.env.example` |
| `server/routes/*Routes.js` | HTTP + WebSocket endpoints. Thin: validate, authorize, call a service |
| `server/services/*Service.js` | Business logic (projects, terminals, agents, git, monitor, pairing, tunnels, updates...) |
| `server/security/` | Auth and sessions, `guard.js`, secret encryption, first-run setup code |
| `server/database/db.js` | Schema (`CREATE TABLE IF NOT EXISTS`) and the ordered **migrations** list |
| `server/modules/registry.js` | Catalogue of built-in modules and their enabled/available state |
| `public/index.html`, `public/js/*.js`, `public/css/app.css` | SPA. `app.js` is the shell; `monitor.js`, `disk-cleanup.js`, `settings-*.js` are feature scripts |
| `plugins/` | Third-party style plugins (`plugin.json` + `index.js`), loaded by `pluginLoader.js` |
| `scripts/` | The `citadel` CLI and its helpers, sentinel/MCP, updater, tunnels, doctor, uninstallers |
| `install.sh`, `scripts/install-macos.sh` | Installers. Linux and macOS must stay aligned in behaviour and final output |
| `tests/*.test.js` | `node:test` suites, one per area |
| `docs/` | Human documentation. See "Where to update docs" |
| `data/` | Runtime data (SQLite, secret key). **Git-ignored, never commit, never read secrets from it** |

## Commands

```bash
npm install        # also copies xterm bundles into public/vendor (git-ignored)
npm run dev        # server with --watch on http://127.0.0.1:3000
npm test           # whole suite (sets CITADEL_SELF_UPDATE=0)
CITADEL_SELF_UPDATE=0 node --test tests/monitor.test.js   # one suite
npm run lint       # eslint
npm run doctor     # read-only host diagnosis
node scripts/changelog.js   # regenerate CHANGELOG.md from tags and commits
node scripts/code-map.js    # regenerate docs/code-map.md from file header comments
npm run graph               # build/update the Graphify code graph in graphify-out/ (optional)
```

Run the suite for the area you touched, then `npm test` and `npm run lint` before finishing. Some suites already fail on certain hosts (doctor CLI output, fleet monitor alerts, tmux copy mode were noted in `docs/engineering-execution-state.md`): compare against a clean `main` before blaming your change, and never "fix" a failure by deleting or weakening a test.

## How to change things

**New API endpoint.** Add it to the matching `server/routes/*Routes.js` (or create one and `fastify.register` it in `server/index.js`). Authenticate with `requireAuth` (see `server/security/auth.js`); admin-only mutations need an admin check as in `secretRoutes.js`. Put logic in a service, write an audit entry for sensitive actions through `auditService`, and add a test.

**New setting / env var.** Read it in `server/config.js`, document it in `.env.example`, and mention user-facing ones in `docs/installation.md`.

**Database change.** Add the table/column to the schema **and** append an idempotent migration in `server/database/db.js` (existing installs upgrade through migrations, fresh ones get the schema). Never edit or reorder an applied migration. Cover it in `tests/db-upgrade.test.js`.

**UI change.** Plain JS and CSS, no framework, no build step, no CDNs (everything is served locally). New screens go in their own `public/js/<name>.js` (copy the pattern in `fleet.js`: `init(ctx)` with a `REQUIRED` list, `window.CitadelX = {...}`, a `<script>` tag before `app.js` in `public/index.html`), not into `app.js`. If a change alters how the dashboard or machine screens look, regenerate the README screenshots with `scripts/screenshots.js` (it runs an isolated demo instance with simulated machines; needs Chrome and `puppeteer-core`, see its header). After touching the frontend run `tests/ui-smoke.test.js` (needs the devDependency `jsdom`: `npm install --include=dev` when `NODE_ENV=production`). When you change a file under `public/js` or `public/css`, the `?v=` cache-buster in `public/index.html` must move on release (see below).

**Built-in module.** Register it in `server/modules/registry.js`. Third-party extensions go through `plugins/` and `plugin.json`, isolated so a plugin can never crash the core.

**Installer or CLI change.** `install.sh` and the macOS installer share flags and output; change both or say why not. The installers are idempotent. They are tested with fakes (`tests/install-wsl.test.js`, `tests/menubar.test.js`, `tests/cli.test.js`): extend those rather than running installers against the real machine.

## Rules that protect users

- Local-only and unprivileged by default. Anything that widens exposure or privilege (LAN, tunnel, admin terminal, updater) must be an explicit opt-in and documented.
- Never build shell commands by interpolating user input. Use structured arguments (`execFile`/`spawn` with an array) and validate paths against the managed tree with `realpath` (see ADR-005).
- Secrets are encrypted at rest and must never reach logs, audit entries, JSON responses or error messages. Redact before storing.
- Never commit `.env`, `data/`, keys, tokens or databases. Do not print secrets back into the conversation.
- On a live host your shell may already export `DATA_DIR`, `DATABASE_PATH`, `PROJECTS_DIR` and `LOGS_DIR` pointing at the real install. Anything that starts `server/index.js` (or a script that opens the database) must override **all four** with a temp directory, or it runs against production data. `tests/` and `tests/ui-smoke.test.js` do; ad-hoc experiments must too. Check with `env | grep -E 'DATA|DATABASE|PROJECTS|LOGS'`.
- Do not run installers, uninstallers, `systemctl`, the updater or anything destructive on the host you are working on without being asked; this machine may be a live Citadel.
- Honesty over green checkmarks: say what was run and what was not (for example "not tested on a real Mac"). The progress ledger does this and you should too.

## Code style

Match the neighbouring code: CommonJS, 2-space indent, single quotes, semicolons, a header comment explaining the purpose of each module, comments that explain *why*. Keep services dependency-light (the project targets 512 MB machines). Do not add a dependency for something a few lines can do.

## Where to update docs

Update docs in the same change as the code. Use the table to find the right file.

| You changed... | Update |
| --- | --- |
| Features, install flags, requirements, CLI summary, anything on the landing page | `README.md` (keep it short and visual; details go to `docs/`) |
| Install, update, uninstall, flags, WSL, LAN, tunnel, updater, laptop mode, pairing, observability endpoints | `docs/installation.md` |
| `citadel doctor/network/wifi/repair`, maintenance, rollback | `docs/operations.md` |
| Security layers or limitations | `docs/security.md` |
| Pairing, QR, Cloudflare/Tailscale access | `docs/remote-access.md` |
| Task queue, sentinel, MCP | `docs/task-mesh.md` |
| Structure, data flow, how machines pair/update/monitor | `docs/architecture.md` |
| A feature gains or loses a file, or a new feature appears | its row in `docs/features.md` (hand-maintained) |
| New, moved or re-purposed source file | its header comment, then `node scripts/code-map.js` (never edit `docs/code-map.md` by hand) |
| A decision with trade-offs (new dependency, storage, auth model) | new `ADR-NNN` entry in `docs/decisions.md` |
| Config values | `.env.example` |
| Any behaviour change worth a ledger line | append a numbered entry with `cat >>` to `docs/engineering-execution-state.md` (what changed, how it was verified, known gaps); do not read the file whole |

`CHANGELOG.md` is generated: never edit it by hand, run `node scripts/changelog.js`. It reads Conventional Commit subjects, so a clear subject is your changelog entry.

## Commits and releases

Commit subjects follow Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `refactor`, `perf`, `docs`, `test`, `chore`. Only `feat`, `fix`, `perf` and `refactor` appear in the changelog, so write them for users. One logical change per commit. Do not push, tag or release unless the maintainer asks.

A release is a `chore(release): vX.Y.Z` commit that:

1. bumps `version` in `package.json` and `package-lock.json`;
2. moves the `?v=` token on assets in `public/index.html` (`v0410` for 0.41.0);
3. adds a "Release vX.Y.Z" entry to `docs/engineering-execution-state.md`;
4. updates the "Latest" table in the README **Releases** section;
5. includes `CHANGELOG.md`: create the tag locally first, run `node scripts/changelog.js` (it needs the tag to list the version), `git commit --amend` the result into the release commit and move the tag (`git tag -f vX.Y.Z`). Do this before pushing anything;
6. is pushed to `main`, then the tag. The tag triggers `.github/workflows/release.yml`, which creates the GitHub Release (marked Latest) with that version's changelog section as its notes (`node scripts/release-notes.js vX.Y.Z` previews them). If the Release does not appear, check the repository's Actions tab; if it already exists the workflow leaves it alone.

The updater's **stable** channel follows the newest `vX.Y.Z` tag, so a tag is what ships to users.
