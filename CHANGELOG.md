# Changelog

All notable changes to Citadel, newest first. Generated from the commit history by `scripts/changelog.js`; each version links to its release on GitHub.

## [0.64.0](https://github.com/maksymhs/Citadel/releases/tag/v0.64.0) · 2026-10-30

### Fixed

- **panel**: Unify System Back arrow and show three Settings tiles per row

## [0.63.0](https://github.com/maksymhs/Citadel/releases/tag/v0.63.0) · 2026-10-30

### Added

- **system**: Open System as three summary cards and sort processes by CPU or memory

## [0.62.0](https://github.com/maksymhs/Citadel/releases/tag/v0.62.0) · 2026-10-30

### Added

- **panel**: Show System as sections under Files and enlarge Settings on desktop

## [0.61.0](https://github.com/maksymhs/Citadel/releases/tag/v0.61.0) · 2026-10-30

### Added

- **panel**: Add System controls and simplify workspaces and Settings
- **updates**: Roll out latest stable after the initiating machine restarts

## [0.60.0](https://github.com/maksymhs/Citadel/releases/tag/v0.60.0) · 2026-10-29

### Added

- **workspace**: Simplify mode selection and project discovery

## [0.59.0](https://github.com/maksymhs/Citadel/releases/tag/v0.59.0) · 2026-10-29

### Changed

- **workspace**: Keep only Terminal and VS Code modes

## [0.58.0](https://github.com/maksymhs/Citadel/releases/tag/v0.58.0) · 2026-10-29

### Added

- **workspace**: Simplify project navigation and add chat commands

## [0.57.0](https://github.com/maksymhs/Citadel/releases/tag/v0.57.0) · 2026-10-28

### Added

- **workspace**: Integrate VS Code and add persistent project mode chooser
- **workspace**: Remember independent project terminal and chat views
- **chat**: Polish conversation layout with Citadel theme
- **chat**: Replace embedded OpenCode GUI with native gateway-backed chat
- **workspace**: Integrate contextual OpenCode sessions and shared model defaults
- **workspace**: Add OpenCode web option

### Fixed

- **workspace**: Adapt OpenCode GUI to project-prefixed routing
- **workspace**: Forward OpenCode root API endpoints
- **workspace**: Preserve OpenCode API referrers in browser
- **workspace**: Enforce OpenCode server authentication and preserve missing routes
- **workspace**: Proxy OpenCode root asset routes

## [0.56.0](https://github.com/maksymhs/Citadel/releases/tag/v0.56.0) · 2026-10-28

### Added

- **gateway**: Add By role and Balanced routing with ChatGPT-first Auto

## [0.55.0](https://github.com/maksymhs/Citadel/releases/tag/v0.55.0) · 2026-10-27

### Added

- **gateway**: Simplify AI Gateway setup and add optional Codex routing

## [0.54.0](https://github.com/maksymhs/Citadel/releases/tag/v0.54.0) · 2026-10-27

### Added

- **gateway**: Add experimental OpenCode client with Plan and Build models

## [0.53.0](https://github.com/maksymhs/Citadel/releases/tag/v0.53.0) · 2026-10-26

### Added

- **terminal**: Add clipboard image paste

## [0.52.0](https://github.com/maksymhs/Citadel/releases/tag/v0.52.0) · 2026-10-26

### Added

- **settings**: Rename gateway and add controlled System terminals

## [0.51.0](https://github.com/maksymhs/Citadel/releases/tag/v0.51.0) · 2026-10-26

### Added

- **gateway**: Simplify settings with visual usage meters

## [0.50.0](https://github.com/maksymhs/Citadel/releases/tag/v0.50.0) · 2026-10-26

### Added

- **gateway**: Discover models and usage with 1m context

## [0.49.0](https://github.com/maksymhs/Citadel/releases/tag/v0.49.0) · 2026-10-25

### Added

- **gateway**: Hot switch Claude and ChatGPT with opt-in quota fallback

## [0.48.0](https://github.com/maksymhs/Citadel/releases/tag/v0.48.0) · 2026-10-25

### Added

- **editor**: Open browser VS Code from project terminals with dark defaults

### Fixed

- **gateway**: Route Claude typed in project terminals through the enabled gateway

## [0.47.0](https://github.com/maksymhs/Citadel/releases/tag/v0.47.0) · 2026-10-25

### Added

- **workspace**: Add AI Gateway settings and browser VS Code with return to Citadel

## [0.46.0](https://github.com/maksymhs/Citadel/releases/tag/v0.46.0) · 2026-10-25

### Changed

- **core**: Remove Project hub and preserve core task execution

## [0.45.0](https://github.com/maksymhs/Citadel/releases/tag/v0.45.0) · 2026-10-25

### Added

- **project-hub**: Unify project work with code graphs and live execution traces

## [0.44.0](https://github.com/maksymhs/Citadel/releases/tag/v0.44.0) · 2026-10-25

### Added

- **trial**: Add a Linux Docker trial and document the project workflow
- **projects**: Discover folders and open projects in desktop VS Code
- **missions**: Add Work, Docs and autonomous learning

### Fixed

- **work**: Enforce attempt budgets and acceptance review with durable docs links

### Improved

- **core**: Avoid repeated session writes and add an isolated API benchmark

## [0.43.0](https://github.com/maksymhs/Citadel/releases/tag/v0.43.0) · 2026-10-25

### Added

- **agents**: Validate isolated installs and add update and removal actions

## [0.42.2](https://github.com/maksymhs/Citadel/releases/tag/v0.42.2) · 2026-10-21

_Maintenance release._

## [0.42.1](https://github.com/maksymhs/Citadel/releases/tag/v0.42.1) · 2026-10-21

### Fixed

- **tests**: Make monitor and terminal tests independent of the host; drop dead code

### Changed

- **ui**: Split app.js into feature scripts and add a jsdom UI smoke test

## [0.42.0](https://github.com/maksymhs/Citadel/releases/tag/v0.42.0) · 2026-10-21

### Added

- **macos**: One-time Full Disk Access setup with `citadel permissions`
- **dev**: Agent guide, generated code map and changelog, optional Graphify graph
- **ui**: Redesign machine selector with live status, icon tile and richer menu
- **dashboard**: Redesign machine overview with gauge cards, KPI tiles and incident timeline
- **monitor**: Real RAM usage on macOS and temperature in the machine panel

### Fixed

- **monitor**: Call ioreg by absolute path so the service finds it under launchd
- **config**: Resolve relative data/projects/logs/plugins paths against the app root

## [0.41.0](https://github.com/maksymhs/Citadel/releases/tag/v0.41.0) · 2026-10-21

### Added

- Setup code, security alerts, Tailscale wizard, WSL support and aligned installers
- **macos**: Menu bar icon, terminal-only QR, mac disk cleanup, opt-in tunnel
- **files**: Many more cleanup categories with per-item selection
- **files**: Scan on demand, faster scans and a proper loading state
- **files**: Disk usage analysis and quick cleanup
- **monitor**: Let the dashboard dismiss alerts until they fire again
- **cli**: Add `citadel reset-password` for offline admin recovery
- **agents**: Add Kilo Code CLI and Qwen Code to the agent installer

### Fixed

- **terminal**: Drop hover-only mouse reports from the web terminal input

## [0.40.0](https://github.com/maksymhs/Citadel/releases/tag/v0.40.0) · 2026-10-20

### Added

- **machines**: Custom names for paired machines, and renaming this machine
- **ui**: Command palette, mobile terminal keys, connection banner, text size, a11y
- **ui**: Light/dark/auto theme, favicon, web app manifest
- **terminal**: Easier copy and paste from phones and other PCs
- **tools**: Drop the "Show not installed" toggle; list installed tools only
- **tools**: Show common tools below the AI coding agents
- **tools**: Cleaner Tools tab with compact tiles
- **tools**: Detect common tools installed on each machine
- **selector**: Manage machines opens Settings · Machines directly
- **dashboard,settings**: Drop Alerts and Check now from the dashboard; Alerts section in Settings
- **activity**: Redesign Activity & Audit as a filterable timeline
- **activity**: Service log tab in Activity & Audit; machine Logs button opens it
- **dashboard**: Remove the machine cards; the dashboard shows the active machine
- **dashboard**: Compact machine cards with the active machine's detail below
- **dashboard**: Minimal dashboard; each machine opens its own detail screen
- **dashboard**: Drop the Machines widget heading and summary text
- **settings**: Hub with tiles and secondary screens, larger QR
- **dashboard**: Machines widget stretches to fill the row and drops the header button
- **dashboard**: Redesign the Machines widget with per-machine cards and ring gauges
- **terminals**: Persistent terminals as a screen, not a popup
- **dashboard**: Active projects opens a terminals window; VPS host opens Settings
- **projects**: Cleaner Projects screen
- **settings,files**: Compact "this machine" header with QR left; Files opens as grid
- **settings**: Remove the Optional modules section
- **settings**: Move Update paired machines next to the update buttons; drop the explanatory text
- **ui**: Machines overview from the machine selector; Back button on detail screens
- **settings**: Reorganize Settings into coherent sections, Updates first
- **mesh**: Auto-pair is always on; remove the toggle and Sync now button
- **update**: Always propagate updates to paired machines
- **monitor**: Machines screen with fleet health, alerts and remote actions
- **update**: Stable/main channels, fleet-wide Update now, auto vault sync with deletions

### Fixed

- **settings**: Restore the Settings hub styles removed by mistake
- **update**: Reload only once the service is back, avoiding the Cloudflare 502

## [0.36.7](https://github.com/maksymhs/Citadel/releases/tag/v0.36.7) · 2026-10-20

### Fixed

- **tunnel**: Overwrite a stale DNS record when setting up an own-domain tunnel

## [0.36.6](https://github.com/maksymhs/Citadel/releases/tag/v0.36.6) · 2026-10-20

### Added

- **tunnel**: Own-domain tunnel setup from Settings on macOS

## [0.36.5](https://github.com/maksymhs/Citadel/releases/tag/v0.36.5) · 2026-10-20

### Added

- **qr**: Large QR page in the browser (citadel qr --open, opened by the macOS installer)

## [0.36.4](https://github.com/maksymhs/Citadel/releases/tag/v0.36.4) · 2026-10-20

### Fixed

- **qr**: Draw terminal QR with one glyph and fixed 256-colour cells

## [0.36.3](https://github.com/maksymhs/Citadel/releases/tag/v0.36.3) · 2026-10-20

### Fixed

- **install**: Bypass raw CDN cache when fetching platform scripts

## [0.36.2](https://github.com/maksymhs/Citadel/releases/tag/v0.36.2) · 2026-10-20

### Added

- **macos**: Minimal installer output, launchd Cloudflare tunnel and a single 2-in-1 QR

## [0.36.1](https://github.com/maksymhs/Citadel/releases/tag/v0.36.1) · 2026-10-20

### Fixed

- **install**: MacOS bash 3.2 empty-array error when delegating to platform scripts

## [0.36.0](https://github.com/maksymhs/Citadel/releases/tag/v0.36.0) · 2026-10-20

### Added

- **update**: Opt-in staged update propagation across paired machines

## [0.35.0](https://github.com/maksymhs/Citadel/releases/tag/v0.35.0) · 2026-10-20

### Added

- **mesh**: Opt-in automatic pairing between all machines

## [0.34.0](https://github.com/maksymhs/Citadel/releases/tag/v0.34.0) · 2026-10-20

### Added

- **hosts**: Addresses in the machine selector and peer discovery

## [0.33.13](https://github.com/maksymhs/Citadel/releases/tag/v0.33.13) · 2026-10-20

### Added

- **pairing**: Announce address changes to peers immediately; fix tunnel label

## [0.33.12](https://github.com/maksymhs/Citadel/releases/tag/v0.33.12) · 2026-10-20

### Added

- **tunnel**: Verify the domain answers and roll back to a temporary URL otherwise

## [0.33.11](https://github.com/maksymhs/Citadel/releases/tag/v0.33.11) · 2026-10-20

### Fixed

- **tunnel**: Add catch-all ingress to named tunnel runs (fixes HTTP 503)

## [0.33.10](https://github.com/maksymhs/Citadel/releases/tag/v0.33.10) · 2026-10-20

### Added

- **tunnel**: Live cloudflared output, setup log and explicit step timeouts

## [0.33.9](https://github.com/maksymhs/Citadel/releases/tag/v0.33.9) · 2026-10-20

### Fixed

- **update**: Let the service run its scoped sudo helpers (NoNewPrivileges drop-in)

## [0.33.8](https://github.com/maksymhs/Citadel/releases/tag/v0.33.8) · 2026-10-20

### Fixed

- **tunnel**: Pick up the cert cloudflared login writes to ~/.cloudflared

## [0.33.7](https://github.com/maksymhs/Citadel/releases/tag/v0.33.7) · 2026-10-20

### Added

- **installer**: Claude Code-style minimal installer and uninstaller

## [0.33.6](https://github.com/maksymhs/Citadel/releases/tag/v0.33.6) · 2026-10-20

### Fixed

- **installer**: Final QR always carries a pairing invite for the displayed URL

## [0.33.5](https://github.com/maksymhs/Citadel/releases/tag/v0.33.5) · 2026-10-20

### Added

- **installer**: One-line progress, final status and single QR

## [0.33.4](https://github.com/maksymhs/Citadel/releases/tag/v0.33.4) · 2026-10-20

### Fixed

- **pairing**: Compact Settings QR, surface invite errors, clearer parse errors

## [0.33.3](https://github.com/maksymhs/Citadel/releases/tag/v0.33.3) · 2026-10-20

### Added

- **installer**: Minimal output and a single 2-in-1 QR at the end

## [0.33.2](https://github.com/maksymhs/Citadel/releases/tag/v0.33.2) · 2026-10-20

### Fixed

- **terminal**: Mobile Paste button no longer hangs; one-step paste

## [0.33.1](https://github.com/maksymhs/Citadel/releases/tag/v0.33.1) · 2026-10-20

### Added

- **installer**: Enable the in-panel updater by default (--no-updater to skip)
- Copy button in terminal toolbars; fix README tunnel default

## [0.33.0](https://github.com/maksymhs/Citadel/releases/tag/v0.33.0) · 2026-10-20

### Added

- Own-domain Cloudflare named tunnel (CLI and Settings UI)

### Fixed

- Paginate git repo listing, add repo search, fit QR on short terminals
- Compact QR to fit terminal and ensure public URL is used for pairing

### Other

- New fixes

## [0.32.0](https://github.com/maksymhs/Citadel/releases/tag/v0.32.0) · 2026-10-19

### Added

- Add macOS installer and pairing QR defaults

## [0.31.1](https://github.com/maksymhs/Citadel/releases/tag/v0.31.1) · 2026-10-19

### Fixed

- **pairing**: Auto-merge credentials after Settings pairing

## [0.31.0](https://github.com/maksymhs/Citadel/releases/tag/v0.31.0) · 2026-10-19

### Added

- **pairing**: Sync credential vault between paired hosts

### Fixed

- **pairing**: Keep terminal QR scannable and unpair offline hosts

## [0.30.0](https://github.com/maksymhs/Citadel/releases/tag/v0.30.0) · 2026-10-19

### Added

- Dual-purpose pairing QR, camera fallback and 24/7 laptop mode

## [0.29.1](https://github.com/maksymhs/Citadel/releases/tag/v0.29.1) · 2026-10-19

### Fixed

- **install**: Run NodeSource setup correctly when already root

## [0.29.0](https://github.com/maksymhs/Citadel/releases/tag/v0.29.0) · 2026-10-19

### Added

- **hosts**: Bidirectional pairing and single-URL machine switching

## [0.28.0](https://github.com/maksymhs/Citadel/releases/tag/v0.28.0) · 2026-10-19

### Added

- **files**: Full-height explorer with grid view, breadcrumbs and keyboard/touch support

### Fixed

- **files**: Repair folder expansion and dark-theme the file tree

## [0.27.0](https://github.com/maksymhs/Citadel/releases/tag/v0.27.0) · 2026-10-19

### Added

- **ui**: Settings reorg, core Files/Metrics, 2-level workspace, Wunderbaum file tree

## [0.26.0](https://github.com/maksymhs/Citadel/releases/tag/v0.26.0) · 2026-10-19

### Added

- **updater**: Built-in unprivileged self-update from the panel

## [0.25.0](https://github.com/maksymhs/Citadel/releases/tag/v0.25.0) · 2026-10-19

### Added

- **secrets**: Unified credential vault and citadel-creds for agents

## [0.24.0](https://github.com/maksymhs/Citadel/releases/tag/v0.24.0) · 2026-10-19

### Added

- **ui,git**: Token-only git, drop System view, 3-level workspace tree

## [0.23.0](https://github.com/maksymhs/Citadel/releases/tag/v0.23.0) · 2026-10-19

### Added

- **git**: Connect GitHub/GitLab via OAuth device flow

## [0.22.0](https://github.com/maksymhs/Citadel/releases/tag/v0.22.0) · 2026-10-19

### Added

- **ui,install**: Cloudflare tunnel by default, drop AI Agents module, simpler panel

## [0.21.0](https://github.com/maksymhs/Citadel/releases/tag/v0.21.0) · 2026-10-19

### Added

- **ui,integrations**: Public URL settings, agent installs and nav cleanup

## [0.20.0](https://github.com/maksymhs/Citadel/releases/tag/v0.20.0) · 2026-10-19

### Added

- **modules**: Add module registry and project-centric workspace redesign

### Fixed

- **hardening**: Isolate task secrets, retry results, guard repairs and rollback

## [0.19.0](https://github.com/maksymhs/Citadel/releases/tag/v0.19.0) · 2026-10-19

### Added

- **diagnostics**: Add local doctor, network, wifi and repair commands

## [0.18.0](https://github.com/maksymhs/Citadel/releases/tag/v0.18.0) · 2026-10-19

### Added

- **task-mesh**: Track executions and reconcile after restarts

## [0.17.2](https://github.com/maksymhs/Citadel/releases/tag/v0.17.2) · 2026-10-18

### Fixed

- **task-mesh**: Fail closed on invalid node-token maps and null-lease authority

## [0.17.1](https://github.com/maksymhs/Citadel/releases/tag/v0.17.1) · 2026-10-18

### Fixed

- **task-mesh**: Bound leases to live attempts and enforce ownership

## [0.17.0](https://github.com/maksymhs/Citadel/releases/tag/v0.17.0) · 2026-10-18

### Added

- **security**: Harden install defaults, auth, task mesh and process lifecycle
- **observability**: Event trace and resource metrics with Logs view and export
- **task-mesh**: Agent tasks, result capture, task env and cancellation
- **task-mesh**: Pull-based distributed work queue with sentinel and MCP
- **fleet**: Aggregated multi-device dashboard with Check/Update all
- **fleet**: Manage and control remote Citadel hosts from one panel
- **agents**: Install CLI agents once for all users and print panel QR on startup

### Fixed

- **terminal**: Add paste button for mobile web terminals

## [0.11.1](https://github.com/maksymhs/Citadel/releases/tag/v0.11.1) · 2026-10-18

### Fixed

- **agents**: Make installed CLIs resolvable in terminals

## [0.11.0](https://github.com/maksymhs/Citadel/releases/tag/v0.11.0) · 2026-10-18

### Added

- **agents**: One-click install of CLI agents from the panel

## [0.10.2](https://github.com/maksymhs/Citadel/releases/tag/v0.10.2) · 2026-10-18

### Added

- **uninstall**: Also delete the local source checkout

## [0.10.1](https://github.com/maksymhs/Citadel/releases/tag/v0.10.1) · 2026-10-18

### Added

- **install**: Enable the Cloudflare tunnel by default and show its URL in the final QR

## [0.10.0](https://github.com/maksymhs/Citadel/releases/tag/v0.10.0) · 2026-10-18

### Added

- **tunnel**: Global URL via Cloudflare Quick Tunnel (citadel tunnel)

## [0.9.1](https://github.com/maksymhs/Citadel/releases/tag/v0.9.1) · 2026-10-18

### Added

- One-line install/uninstall with everything on by default

## [0.9.0](https://github.com/maksymhs/Citadel/releases/tag/v0.9.0) · 2026-10-18

### Added

- Remove the kiosk mode entirely

## [0.8.8](https://github.com/maksymhs/Citadel/releases/tag/v0.8.8) · 2026-10-18

### Fixed

- **net**: Pick the default-route LAN IP for the QR (not docker/VPN)

## [0.8.7](https://github.com/maksymhs/Citadel/releases/tag/v0.8.7) · 2026-10-18

### Fixed

- **uninstall**: Also remove the kiosk configuration

## [0.8.6](https://github.com/maksymhs/Citadel/releases/tag/v0.8.6) · 2026-10-18

### Added

- **install**: Ask about the kiosk at the end when a display is present

## [0.8.5](https://github.com/maksymhs/Citadel/releases/tag/v0.8.5) · 2026-10-18

### Added

- **install**: One-line install ends with a QR to start from your phone

## [0.8.4](https://github.com/maksymhs/Citadel/releases/tag/v0.8.4) · 2026-10-17

### Fixed

- **qr**: Larger, crisp QR so phone cameras can read it

## [0.8.3](https://github.com/maksymhs/Citadel/releases/tag/v0.8.3) · 2026-10-17

### Added

- **install**: Install the 'citadel' CLI launcher early

## [0.8.2](https://github.com/maksymhs/Citadel/releases/tag/v0.8.2) · 2026-10-17

### Fixed

- **update**: Install the 'citadel' CLI launcher during updates

## [0.8.1](https://github.com/maksymhs/Citadel/releases/tag/v0.8.1) · 2026-10-17

### Added

- **install**: Re-running the installer updates in place

## [0.8.0](https://github.com/maksymhs/Citadel/releases/tag/v0.8.0) · 2026-10-17

### Added

- **cli**: Citadel management command + LAN access option

## [0.7.0](https://github.com/maksymhs/Citadel/releases/tag/v0.7.0) · 2026-10-17

### Added

- **connect**: Phone QR card + remote-access auto-detect

## [0.6.1](https://github.com/maksymhs/Citadel/releases/tag/v0.6.1) · 2026-10-17

### Fixed

- **ui**: Show only the file/folder name in the mobile Files view

## [0.6.0](https://github.com/maksymhs/Citadel/releases/tag/v0.6.0) · 2026-10-17

### Added

- **files**: Host-wide file explorer with in-panel editor

## [0.5.0](https://github.com/maksymhs/Citadel/releases/tag/v0.5.0) · 2026-10-17

### Added

- **install**: Opt-in kiosk display via --kiosk
- **updates**: Synchronized peer updates via shared token

## [0.4.5](https://github.com/maksymhs/Citadel/releases/tag/v0.4.5) · 2026-10-17

### Fixed

- **ui**: Denser two-column mobile cards

## [0.4.4](https://github.com/maksymhs/Citadel/releases/tag/v0.4.4) · 2026-10-17

### Added

- **ui**: Compact responsive cards, smaller console font, a11y polish

### Fixed

- **ui**: Show the running version when no update is available

## [0.4.3](https://github.com/maksymhs/Citadel/releases/tag/v0.4.3) · 2026-10-17

### Fixed

- **ui**: Stop the dashboard poll timer leaking and clean up on logout
- **updates**: Report against the tracked branch; clean full uninstall
- **updates**: Snapshot the DB, roll back and verify health on self-update

## [0.4.2](https://github.com/maksymhs/Citadel/releases/tag/v0.4.2) · 2026-10-17

### Fixed

- **security**: Path-boundary check, WS authz and credential throttling
- **ui**: Anchor the app to the visual viewport so the mobile keyboard fits

## [0.4.1](https://github.com/maksymhs/Citadel/releases/tag/v0.4.1) · 2026-10-17

### Fixed

- **updates**: Pick the highest version tag instead of /releases/latest

## [0.4.0](https://github.com/maksymhs/Citadel/releases/tag/v0.4.0) · 2026-10-17

### Added

- **ui**: Card layouts for mobile tables and compact terminal font

### Fixed

- **terminal**: Touch-scroll tmux-backed sessions via SGR wheel events

## [0.3.1](https://github.com/maksymhs/Citadel/releases/tag/v0.3.1) · 2026-10-17

### Fixed

- **ui**: Keep the sidebar off-canvas on mobile/touch
- **systemd**: Guarantee KillMode=process so tmux sessions survive restarts

## [0.3.0](https://github.com/maksymhs/Citadel/releases/tag/v0.3.0) · 2026-10-17

### Added

- Process monitor, terminal session reconciliation and persistent tmux across updates
- **git**: Credential helper so project terminals can push using stored provider tokens

### Fixed

- **ui**: Restore the last view, project and terminals after a reload
- **terminal**: Stop system-shell tmux chdir permission denied
- **terminal**: Keep live terminals across view changes and stop black screens
- **git**: Normalize repo-relative data paths in the credential helper
- **ui**: Show the real version in the sidebar instead of a hardcoded v0.1.0
- **update**: Restore service-user ownership before npm so the updater can run as root
- **api**: Stop sending JSON content-type without a body; accept empty JSON bodies
- **update**: Use safe.directory so root git ops work on service-owned checkout

## [0.2.0](https://github.com/maksymhs/Citadel/releases/tag/v0.2.0) · 2026-10-17

### Added

- **update**: Self-update system, schema migrations and version endpoint
- **git**: Browse and clone private repos with encrypted provider tokens
- **ui**: Add host-level System Terminal view in sidebar
- **config**: Load .env at startup; create .env on install
- **core**: Initial implementation of NexusVPS architecture and functional MVP

### Fixed

- **ui**: Implement missing System Terminal view; add opt-in privileged run-as
- **installer**: Drop duplicate vendor copy; chmod linux spawn-helper; honor DATA_DIR in doctor
- **installer**: Make code detection privileged and update existing clone on re-run
- **installer**: Run dependency install as service user to avoid permission denied
- **installer**: Report check-only dry run honestly and flag missing prerequisites

