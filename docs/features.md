# Feature map

Which files make up each feature. Start here when a task is phrased in product terms ("the Machines screen", "pairing", "disk cleanup"), then open only those files. Per-file purposes are in [code-map.md](code-map.md); how the pieces fit is in [architecture.md](architecture.md). Hand-maintained: update the row when a feature gains or loses a file.

| Feature | Server (routes → services) | UI (`public/js/`) | Tests (`tests/`) | Guide |
| --- | --- | --- | --- | --- |
| Sign-in, sessions, first-run setup code | `authRoutes` → `security/auth.js`, `security/setupCode.js` | `app.js` (`renderSetupView`, `renderLoginView`) | `auth`, `setup-code`, `security`, `hardening` | [security](security.md) |
| Projects and Git repositories | `projectRoutes`, `gitRoutes` → `projectService`, `gitService`, `gitCredentialsService` | `app.js` (`renderProjectsView`), `repos.js`, `project-tools.js` | `projects`, `project-repos`, `project-discovery`, `ui-smoke`, `git`, `gitcred` | [installation](installation.md) |
| Persistent terminals | `terminalRoutes`, `wsTerminal` → `terminalManager` | `app.js` (`renderWorkspaceView`, terminal tabs) | `terminal` | [architecture §7](architecture.md) |
| AI agents (launch, one-click install) | `agentRoutes` → `agentRegistry`, `agentInstallService` | `app.js` | `agents`, `agent-install` | [architecture §7](architecture.md) |
| Credential vault, `citadel-creds` | `secretRoutes` → `secretStore`, `secretSyncService`, `security/secrets.js`; CLI `scripts/citadel-creds.js` | `app.js` (Settings) | `secrets`, `secret-sync`, `gitcred` | [security](security.md) |
| Files explorer | `fileRoutes` → `fileService`; `scripts/fsAgent.js` (privileged ops) | `files.js` | `files`, `ui-smoke` | [installation](installation.md) |
| Disk usage and quick cleanup | `fileRoutes` (`/api/files/cleanup`) → `fileService`, `scripts/fsAgent.js` | `disk-cleanup.js` | `files` | [installation](installation.md) |
| Machine switching (one URL, many hosts) | `hostRoutes`, `remoteProxyRoutes` → `hostService` | `app.js` (machine selector) | `remote-proxy`, `known-peers` | [architecture §3](architecture.md) |
| Pairing (QR/link), mesh, unpair | `hostRoutes` → `pairingService`, `hostService`, `meshService`; `scripts/pair-qr.js` | `pairing.js` (Pair a machine modal), `app.js` (Settings → Machines) | `pairing`, `known-peers`, `peer` | [remote-access](remote-access.md) |
| Machines screen, health, alerts | `monitorRoutes` → `monitorService`, `memoryStats`, `temperature`, `nodeService` | `monitor.js` | `monitor`, `memory-stats` | [architecture §5](architecture.md) |
| Security alerts | `authRoutes`, `hostRoutes` (and `scripts/reset-password.js`) → `securityAlertService` (reuses the monitor channels) | `app.js` (Settings → Alerts) | `security-alerts` | [installation](installation.md) |
| Updates (panel, CLI, fleet rollout) | `systemRoutes`, `peerRoutes`, `hostRoutes` → `updateService`, `updateRolloutService` (started from `server/index.js`); `scripts/update.sh`, `self-update.js` | `app.js` (Settings → Updates) | `update`, `update-rollback`, `update-rollout`, `selfUpdate` | [architecture §6](architecture.md) |
| Public address: Quick Tunnel, own domain | `settingsRoutes`, `systemRoutes` → `tunnelService`, `cloudflareTunnelService`, `connectService`; `scripts/tunnel*.sh` | `settings-tunnel.js` | `tunnel`, `connect`, `settings-connect` | [remote-access](remote-access.md) |
| Tailscale private address | `tailscaleRoutes` → `tailscaleService` | `settings-tailscale.js` | `tailscale` | [remote-access](remote-access.md) |
| Activity, audit, service log, metrics | `logRoutes`, `systemRoutes` → `logService`, `auditService`, `serviceLogService` | `activity.js` | `logs`, `system`, `ui-smoke` | [installation](installation.md) |
| Task mesh, sentinel, MCP | `taskRoutes` → `taskService`; `scripts/sentinel*.js`, `citadel-mcp.js` | — | `tasks`, `task-*`, `sentinel*`, `mcp` | [task-mesh](task-mesh.md) |
| Work, Docs, Learning (autonomous loop, Markdown wiki, memory) | `missionRoutes`/`learningRoutes`/`docRoutes` → `missionService`/`learningService`/`docService`, `taskService` | `missions.js`, `knowledge.js` | `missions*`, `missions-budget`, `learning`, `docs`, `knowledge-http`, `ui-smoke` | [missions](missions.md) |
| Fleet (legacy URL + token hosts) | `fleetRoutes` → `fleetService` | `fleet.js` | `fleet`, `ui-smoke` | [architecture §4](architecture.md) |
| Domain publishing, Docker (optional) | `proxyRoutes`, `dockerRoutes` → `proxyProvider`, `dockerService` | `deployments.js` | `integrations`, `ui-smoke` | [architecture](architecture.md) |
| Modules and plugins | `moduleRoutes`, `pluginRoutes` → `modules/registry.js`, `pluginLoader` | `app.js` | `modules`, `plugins` | [architecture §2](architecture.md) |
| Tools detection | `systemRoutes` → `toolsService` | `app.js` (Settings → Tools) | none yet | — |
| CLI: `doctor`, `network`, `wifi`, `repair` | `scripts/doctor.js`, `scripts/diagnostics.js` | — | `diagnostics`, `doctor-cli` | [operations](operations.md) |
| CLI: `citadel` wrapper, `reset-password`, `setup-code` | `scripts/citadel`, `reset-password.js`, `setup-code.js` | — | `cli` | [installation](installation.md) |
| Installers and uninstallers | `install.sh`, `scripts/install-macos.sh`, `uninstall*.sh`, `power.sh` | — | `install-wsl`, `uninstall`, `menubar`, `cli` | [installation](installation.md) |
| macOS menu bar icon, Full Disk Access | `scripts/menubar-macos.sh`, `scripts/macos/CitadelMenu.swift`, `macPermissions`, `scripts/permissions.js` | — | `menubar`, `mac-permissions` | [installation](installation.md) |
| Database and migrations | `database/db.js` | — | `db-upgrade` | [architecture §9](architecture.md) |
| Configuration | `config.js`, `.env.example` | — | `config-paths` | [installation](installation.md) |

Some names above are prefixes (`task-*` covers `task-execution`, `task-leases`, `task-node-*`; `sentinel*` covers `sentinel`, `sentinel-env`, `sentinel-process`, `sentinel-report`). Check a suite exists with `ls tests | grep <name>`.
