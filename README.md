<div align="center">

<img src="public/icons/icon-192.png" alt="Citadel" width="96" height="96">

# Citadel

**Your own command center for projects, terminals and AI coding agents.**<br>
Self-hosted, lightweight and secure. Runs on a VPS, a Mac or a spare laptop.

[![Release](https://img.shields.io/github/v/release/maksymhs/Citadel?style=flat-square&color=4f46e5)](https://github.com/maksymhs/Citadel/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?style=flat-square&logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20WSL2-444?style=flat-square)
![RAM](https://img.shields.io/badge/RAM-512%20MB-f59e0b?style=flat-square)

[Quick start](#-quick-start) ·
[Features](#-features) ·
[CLI](#-the-citadel-cli) ·
[Releases](#-releases) ·
[Docs](#-documentation) ·
[Changelog](CHANGELOG.md)

<br>

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/img/dashboard-light.png">
  <img src="docs/img/dashboard-dark.png" alt="Citadel dashboard: CPU, memory and disk gauges, uptime, availability and incidents for one machine, with an alert about another" width="900">
</picture>

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🖥️ Persistent terminals
`xterm.js` + `node-pty` + `tmux`. Close the browser, restart the panel: your sessions keep running. Phone-friendly, with on-screen keys, native text selection, clipboard copy and image paste for AI coding tools.

</td>
<td width="50%" valign="top">

### 🤖 AI agent launcher
Run **Claude Code**, **Codex CLI**, **OpenCode**, **Antigravity**, **Kilo Code**, **Qwen Code** or your own binaries. Missing agents install with one click, once for every user.

</td>
<td width="50%" valign="top">

### 🔀 Optional Claude Code Gateway
Connect Claude and ChatGPT separately, choose discovered models for planning, execution and background work, then route new conversations to **Claude**, **ChatGPT** or opt-in **Auto** fallback. Provider-reported usage windows and reset times appear when available. Experimental; account access and model compatibility are not guaranteed. [Setup and limitations →](docs/ai-gateway.md)

</td>
</tr>
<tr>
<td valign="top">

### 📁 Projects & Git
Register, create, import and clone repositories with live branch status. Connect GitHub or GitLab and clone your private repos in one click. Open optional [browser VS Code](docs/browser-editor.md) without SSH and return to Citadel with one button.

</td>
<td valign="top">

### 🔐 Credential vault
One encrypted store (AES-256-GCM) for git tokens, env vars and SSH keys. Terminals get them at spawn; agents read them on demand with `citadel-creds`.

</td>
</tr>
<tr>
<td valign="top">

### 🌐 Paired machines
Pair Citadels with a QR code and switch between them from one URL. Survives rotating Cloudflare Quick Tunnel addresses, mesh-pairs automatically and propagates updates.

</td>
<td valign="top">

### 📊 Health & alerts
Online/offline, CPU, memory, disk, latency and 24 h / 7 d availability for every machine. Alerts to **webhook**, **ntfy** or **Telegram**, including security events.

</td>
</tr>
<tr>
<td valign="top">

### 🧩 Distributed task mesh
A pull-based work queue so one orchestrator agent can split work across nodes, with a dependency-free **MCP server**. See [task mesh](docs/task-mesh.md).

</td>
<td valign="top">

### 🗂️ Files & disk cleanup
Browse and edit the host filesystem, analyse disk usage and run quick cleanups with per-item selection.

</td>
</tr>
<tr>
<td valign="top">

### 🔭 Observability
Event trace plus periodic resource samples, a live sparkline, a filterable timeline and JSON/CSV export.

</td>
<td valign="top">

### 🪶 Lean by design
Fastify + SQLite (WAL). Runs on 512 MB of RAM. Plugin system with fault isolation. Optional Caddy and Docker integrations.

</td>
</tr>
</table>

<details>
<summary><b>More</b></summary>

- **Command palette** (`Ctrl/Cmd+K`) to jump to any screen, setting, machine or project.
- **Light, dark and system themes**, installable as a web app.
- **Domain publishing** through Caddy's local admin API with automatic HTTPS.
- **Idempotent installer** and systemd unit (Debian/Ubuntu), `launchd` on macOS.

</details>

## 🔒 Secure by default

| | |
| --- | --- |
| 🏠 Local-only | Listens on `127.0.0.1` unless you opt in to LAN or a tunnel |
| 🔑 Setup code | The first admin account needs a code only someone with shell access can read |
| 🍪 Strict sessions | `HttpOnly`, `SameSite=Strict` cookies, WebSocket origin validation, path-traversal prevention |
| 🧾 Audit log | Every sensitive action is recorded, credentials redacted |
| 🚫 Not root | The service runs unprivileged; every extra capability is an explicit flag |

Citadel does not sandbox projects from each other and a terminal is a shell with the service account's rights. Read the [limitations](docs/security.md) before exposing it.

## 🚀 Quick start

**Linux and macOS**, one line:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/Citadel/main/install.sh | bash
```

On Debian/Ubuntu add `sudo` before `bash` to install the system service. The installer prints the panel address, a **setup code** and a **QR**. Open the address and create the administrator account.

Every extra capability is opt-in:

| Flag | Effect |
| --- | --- |
| `--lan` / `--host=ADDR` | Reachable on your local network |
| `--no-tunnel` | Skip the public Cloudflare Quick Tunnel |
| `--admin-terminal[=user]` | Root-capable System Terminal (privileged) |
| `--no-updater` | Skip the in-panel updater |
| `--24-7` / `--no-24-7` | Keep a laptop awake with the lid closed, or not |
| `--check-only` | Preview what the installer would do |

**Windows** runs inside WSL2 (Ubuntu); **macOS** gets a menu bar icon. Updating, uninstalling, installing from a clone, laptop mode, tunnels and more are in [docs/installation.md](docs/installation.md).

To just look at the panel without installing anything on the machine, there is a development-only Docker image: `docker compose up --build` (see [docs/installation.md](docs/installation.md#try-it-without-installing-docker)). It is not the supported deployment.

Projects discovers folders under `PROJECTS_DIR`; import a suggestion and use **More actions → Open in VS Code** for local or SSH editing. [Details](docs/installation.md#project-folders-and-vs-code).

### Requirements

| | |
| --- | --- |
| **OS** | Debian 11/12, Ubuntu 20.04–24.04, macOS 13+, Windows 10 (2004+) / 11 via WSL2 |
| **Arch** | `x86_64`, `arm64` |
| **Node.js** | 18 LTS or later |
| **Also** | Git, and tmux for session persistence (optional) |
| **RAM** | 512 MB minimum, 1 GB recommended for AI agents |

## 🧰 The `citadel` CLI

```bash
citadel status          # service, version, panel URL and health
citadel url             # print the panel URL
citadel qr              # one-time QR to pair another Citadel (10 minutes)
citadel setup-code      # first-run code to create the admin account
citadel update          # update to the latest version
citadel tunnel          # global URL via a Cloudflare Quick Tunnel
citadel logs            # follow the service logs
citadel restart         # also: start, stop
citadel doctor          # read-only host, network and Citadel diagnosis
citadel repair          # allow-listed recovery actions
citadel reset-password  # forgot the panel password (needs shell access)
```

Full reference, including Wi-Fi, power and menu bar commands: [installation](docs/installation.md#managing-citadel-citadel-cli) and [diagnostics & maintenance](docs/operations.md).

## 📦 Releases

Citadel follows `vX.Y.Z` tags. The panel checks GitHub for new releases and, with the updater installed, updates itself in one click and propagates the update to your paired machines. Pick the **stable** channel (latest release tag) or **main** (latest commit) in **Settings → Updates**.

| Latest | |
| --- | --- |
| **[v0.54.0](https://github.com/maksymhs/Citadel/releases/tag/v0.54.0)** | Experimental OpenCode gateway with separate Plan/Build models and context compaction |
| [v0.52.0](https://github.com/maksymhs/Citadel/releases/tag/v0.52.0) | Claude Code Gateway, responsive Settings, 1M context budget and controlled System terminals |
| [v0.51.0](https://github.com/maksymhs/Citadel/releases/tag/v0.51.0) | Simplified AI Gateway settings with visual provider usage meters and model discovery |
| [v0.50.0](https://github.com/maksymhs/Citadel/releases/tag/v0.50.0) | AI Gateway model discovery, per-provider usage/reset display and 1M context default |
| [v0.49.0](https://github.com/maksymhs/Citadel/releases/tag/v0.49.0) | Hot Claude / ChatGPT / Auto routing with stable model aliases, separate Claude authorization and opt-in quota fallback |
| [v0.48.0](https://github.com/maksymhs/Citadel/releases/tag/v0.48.0) | Gateway applies when typing claude in new project terminals; terminal VS Code button and dark editor defaults |
| [v0.47.0](https://github.com/maksymhs/Citadel/releases/tag/v0.47.0) | Optional AI Gateway activation and model settings; browser VS Code without SSH, with return to Citadel |
| [v0.46.0](https://github.com/maksymhs/Citadel/releases/tag/v0.46.0) | Simpler Citadel: Project hub removed, historical data preserved, admin-only task orchestration |
| [v0.45.0](https://github.com/maksymhs/Citadel/releases/tag/v0.45.0) | One optional Project hub with tasks and priorities, Markdown, a code graph and live execution traces |
| [v0.44.0](https://github.com/maksymhs/Citadel/releases/tag/v0.44.0) | Work, Docs and Learning with acceptance review and attempt budgets; project discovery, VS Code links and a Linux Docker trial |
| [v0.43.0](https://github.com/maksymhs/Citadel/releases/tag/v0.43.0) | Isolated AI agent installs with validation, reinstall/update and managed-launcher removal |
| [v0.42.2](https://github.com/maksymhs/Citadel/releases/tag/v0.42.2) | Documentation maintenance: open items and known gaps recorded |
| [v0.42.1](https://github.com/maksymhs/Citadel/releases/tag/v0.42.1) | Maintenance: the web app code split into per-screen scripts with a browser-level smoke test, tests that no longer depend on the host, architecture and feature guides rewritten |
| [v0.42.0](https://github.com/maksymhs/Citadel/releases/tag/v0.42.0) | Redesigned machine overview and selector, real RAM and temperature on macOS, one-time Full Disk Access setup (`citadel permissions`), new README and guides, `AGENTS.md` for contributors and AI agents |
| [v0.41.0](https://github.com/maksymhs/Citadel/releases/tag/v0.41.0) | Setup code, security alerts, Tailscale wizard, WSL support, macOS menu bar icon, disk usage analysis and quick cleanup, `citadel reset-password`, Kilo Code and Qwen Code agents |

➡️ **[Full changelog](CHANGELOG.md)** · [All releases on GitHub](https://github.com/maksymhs/Citadel/releases)

## 📚 Documentation

| Guide | What's in it |
| --- | --- |
| [Installation & configuration](docs/installation.md) | Install, update, uninstall, WSL2, LAN, tunnels, pairing, updater, laptop mode |
| [Diagnostics & maintenance](docs/operations.md) | `doctor`, `network`, `wifi`, `repair`, rollbacks, uninstall options |
| [Security & limitations](docs/security.md) | Security layers and what Citadel does **not** protect against |
| [Remote access](docs/remote-access.md) | QR pairing, Cloudflare tunnels, own domain |
| [Task mesh](docs/task-mesh.md) | Parallel work across paired nodes |
| [Claude Code Gateway](docs/ai-gateway.md) | Optional Claude/ChatGPT routing, model choices, usage windows and limitations |
| [Feature map](docs/features.md) | Which files make up each feature, with their tests and guide |
| [Code map](docs/code-map.md) | Every source file with its purpose, and where each screen lives |
| [Architecture](docs/architecture.md) · [Decisions](docs/decisions.md) | How it is built and why |

## 🛠️ Development

```bash
npm install     # dependencies and local xterm bundles
npm run doctor  # system health check
npm test        # full automated test suite
npm run dev     # development server (or: npm start)
```

Then open <http://127.0.0.1:3000>.

The optional [AI Gateway](docs/ai-gateway.md) can route Claude Code and OpenCode
through the same connected Claude/ChatGPT accounts. OpenCode supports separate
Plan/Build models with automatic context compaction and tool-output pruning.

Administrators can install, reinstall/update and remove managed AI CLI launchers
from **Machines → Tools**. Releases are retained for active sessions; see
[agent management](docs/installation.md#managing-ai-cli-agents-from-the-panel).

Contributing, with a human or an AI agent? [AGENTS.md](AGENTS.md) explains how the project is organised, how to make common changes, which docs to update and how releases work.

See also [CONTRIBUTING.md](CONTRIBUTING.md), the [security policy](SECURITY.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Questions and ideas are welcome in [Discussions](https://github.com/maksymhs/Citadel/discussions).

<details>
<summary><b>Repository layout</b></summary>

```
citadel/
├── server/      # Node.js + Fastify backend (config, database, security, services, routes)
├── public/      # SPA frontend: HTML5, responsive CSS, modular JS, local vendor bundles (0 CDNs)
├── plugins/     # Official plugins (plugin.json)
├── scripts/     # Installer helpers, updater, tunnel, doctor, uninstaller, systemd unit
├── tests/       # Automated tests
├── docs/        # Guides, architecture and ADRs
├── install.sh   # Main installer
└── CHANGELOG.md
```

</details>

## 📄 License

MIT. See [LICENSE](LICENSE).
