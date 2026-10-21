# Citadel — Engineering ledger (recent)

One numbered entry per meaningful change: what changed, how it was verified, known gaps. This file holds the recent entries only; entries 1-97 are in [history/ledger-0001-0097.md](history/ledger-0001-0097.md). **Add an entry with `cat >> docs/engineering-execution-state.md <<'EOF'`; you never need to read the whole file** (`tail -40` is enough to see the last entry number).

## 98. Fleet monitor, dashboard and Settings redesign, terminal copy/paste, themes (v0.40.0)
- **Machines monitoring.** `GET /api/system/health` plus a per-panel monitor
  that probes every paired machine each 60 s (history in `host_checks`, 30 days),
  raises offline / disk / memory / CPU alerts and notifies a webhook, ntfy or
  Telegram (secrets encrypted). Admin actions: service log tail
  (`/api/system/logs`) and remote restart (`/api/system/restart`). Common tools
  detection (`/api/system/tools`).
- **Dashboard.** Reduced to the active machine's panel (Overview, Projects,
  Terminals, Processes, Tools) plus a cross-machine alerts strip. Settings is a
  hub of screens (Updates, Machines, Network & access, Alerts, Credentials,
  Activity & Audit). Projects and Activity & Audit screens redesigned.
- **Paired machines.** Update propagation and mesh pairing are always on (the
  opt-in switches were removed). Private display names for paired machines
  (`fleet_hosts.alias`, migration 009) and renaming this machine.
- **Terminal.** Select view with tmux history (`GET /api/terminals/:id/capture`),
  OSC 52 copy from tmux, Ctrl+C copies a selection, optional Enter after paste,
  on-screen keys and A-/A+ on touch devices.
- **UI.** Light / dark / system theme, favicon and web app manifest, command
  palette (Ctrl/Cmd+K), connection-lost banner, focus rings. The panel waits
  for the service to answer again before reloading after an update (no more
  Cloudflare 502 page).
- Version bumped to `0.40.0`; asset cache-buster token moved to `v0400`.

## 99. macOS QR drawn in the terminal only (v0.41.0)
- The browser QR page (`scripts/qr-page.js`, `citadel qr --open`, the macOS
  installer opening it) is removed. It existed because the half-block QR did not
  scan on macOS Terminal (the font draws `▀` slightly short, leaving seams).
- On Terminal.app (`TERM_PROGRAM=Apple_Terminal`) `print-qr.js` now draws
  glyph-free cells: two background-coloured spaces per module, which fill the
  whole cell and cannot leave seams. It needs about 47 rows for the pairing
  link, so when the window is too small it asks Terminal.app to grow
  (`CSI 8;rows;cols t`, opt out with `CITADEL_QR_NO_RESIZE=1`), then falls back to
  the short panel-URL code, then to a clear "QR needs WxH" error. It never falls
  back to the glyph mode there (`CITADEL_QR_MODE=unicode` still forces it).
- Other terminals (iTerm2, Linux, ...) keep the compact half-block output.
- Tests decode the cell grid with jsQR and check the no-glyph fallbacks. The
  resize path was exercised on Linux with a pseudo-terminal that honours the
  request; not run on a real Mac.

## 100. macOS menu bar icon, `citadel start|stop` (v0.41.0)
- New `scripts/macos/CitadelMenu.swift`: a status-bar app (no Dock icon) that
  polls `/api/auth/status` every 5 s and offers Open Dashboard, Start/Stop,
  Restart, Open Log and Quit Menu Icon; actions call the `citadel` CLI.
- `scripts/menubar-macos.sh install|remove|status` compiles it with `swiftc`
  into `<target>/CitadelMenu.app` (rebuilt only when the source hash changes),
  ad-hoc signs it and registers the `com.citadel.menubar` LaunchAgent (RunAtLoad,
  restart only on crash, Aqua sessions). Without `swiftc` it exits 3 and changes
  nothing; the installer treats the icon as optional (`--no-menubar`,
  `CITADEL_NO_MENUBAR=1`, later `citadel menubar on|off`). The uninstaller removes it.
- `citadel stop` unloads the launchd agent so KeepAlive does not revive it;
  `citadel start` / `restart` reload it if needed (`start`/`stop` also map to
  systemctl on Linux).
- Tests run the scripts on Linux against fake `uname`/`swiftc`/`launchctl`.
  The Swift source was not compiled or run here (no macOS toolchain); the first
  install on a Mac is its first real build.

## 101. macOS: disk cleanup categories and opt-in public tunnel (v0.41.0)
- Disk cleanup is platform-aware. On macOS it offers `~/Library/Caches`
  (excluding `com.apple.*` and Homebrew's own folder), `~/Library/Logs`, Xcode
  DerivedData / Archives / iOS DeviceSupport, CoreSimulator caches and
  `brew cleanup -s --prune=all` (size from a dry run, binary units), in a new
  "Developer" group, with temp files read from `/private/tmp` and the per-user
  temp dir. The apt/journal/snap/`/var/log`/Trash/Downloads categories are
  Linux-only: on macOS the Trash and `~/Downloads` are permission-gated, so a
  scan must not touch them. macOS `find` has no `-printf`, so large files come
  from `find ... -exec stat -f '%b<TAB>%N' {} +`. `CITADEL_FSAGENT_PLATFORM`
  lets tests exercise the macOS branch on Linux (fake `brew` and `find`); not run
  on a real Mac.
- `install-macos.sh` no longer opens a public Cloudflare tunnel by default
  (`--tunnel` opts in; `--no-tunnel` is still accepted). The panel gives a shell
  and file access, so it stays local-only unless asked. Updating an install that
  already has the tunnel agent keeps the tunnel unless `--no-tunnel` is passed.
  Linux is unchanged.

## 102. Tailscale wizard and Windows (WSL2) installer (v0.41.0)
- **Tailscale.** `server/services/tailscaleService.js` reads `tailscale status
  --json` / `serve status` and manages `tailscale serve` for the panel's own
  port (new `--bg --https=443` spelling first, then the pre-1.52 `serve https /`).
  It never runs `funnel`. Routes `GET /api/network/tailscale`, `POST|DELETE
  /api/network/tailscale/serve` (admin, audited) feed a stepper card in Settings →
  Network (`public/js/settings-tailscale.js`): install, sign in (link or
  command), allow Citadel (`tailscale set --operator`), enable the private
  address; it polls while the user works in a terminal. `connectService` used to
  advertise `https://<host>.ts.net` as soon as Tailscale had a name even when
  nothing served it; it now does so only while a serve handler proxies the
  panel's port (and keeps the old behaviour if serve status cannot be read).
  `api()` errors now carry the response body as `error.details`. Tests drive a
  fake `tailscale` CLI through every state; not run against a real tailnet.
- **Windows is WSL2 only.** Native Windows is out of reach (tmux, node-pty,
  systemd, sudo, du/find). A PowerShell installer with a stubbed test harness and
  a Windows CI job was written and then dropped on purpose: Windows users set up
  WSL2 and run the regular Linux installer. `install.sh` detects WSL
  (`/proc/version` mentions Microsoft): it defaults to local-only (no tunnel
  unless `--tunnel`), skips the 24/7 laptop settings and, when systemd is not
  running, stops before changing anything and prints the `/etc/wsl.conf` +
  `wsl --shutdown` steps. `tests/install-wsl.test.js` fakes the host with
  `CITADEL_WSL_PROC_VERSION` / `CITADEL_SYSTEMD_RUN_DIR` and stubs sudo, git, curl
  and npm so it can never install anything. Not run on a real Windows PC; whether
  an idle WSL distro keeps Citadel running is unverified.

## 103. First-run setup code and security alerts (v0.41.0)
- **Setup code.** The first-run screen could be claimed by whoever reached the
  panel first. `server/security/setupCode.js` keeps a one-time `XXXX-XXXX` code in
  `DATA_DIR/setup-code` (0600, no ambiguous characters, ~40 bits) that
  `POST /api/auth/setup` requires while no user exists; the real server turns
  this on (`buildServer({ requireSetupCode })`, off by default so tests and
  embedding can create the admin through the API), generates the code at boot and
  deletes it once the account exists. Five wrong codes replace it with a new one
  and pause attempts for a minute (an environment-provided code is never rotated),
  independent of the per-IP rate limit. `citadel setup-code [--quiet]` prints it
  (runs as the database owner like `reset-password`); the Linux and macOS
  installers print it, and the screen has a code field. `CITADEL_SETUP_CODE` sets
  one for automation, `CITADEL_REQUIRE_SETUP_CODE=0` opts out.
- **Rate limit note.** The credential limiter builds its key in `onRequest`,
  before the body is parsed, so the username never was part of it: the limit is
  per client address (the comment said otherwise and was corrected). Guessing
  spread over many addresses is covered by the new failure-burst alert.
- **Security alerts.** `server/services/securityAlertService.js` records events
  under the `security` activity category and pushes them through the monitor's
  channels (new `securityAlerts` toggle in the monitor config, on by default):
  sign-in from a new address (table `login_ips`, migration 010; the first address
  a user ever uses is only remembered), 5+ failed sign-ins from one address in
  10 minutes, 15+ across 3+ addresses (critical), a machine paired in, admin
  created, setup code rotated, password reset from the shell. Pushes are throttled
  (30 min per key) and never block or fail a sign-in; messages name the machine.
  Tests: `tests/setup-code.test.js`, `tests/security-alerts.test.js` (real webhook
  receiver). Not covered: sign-ins behind a proxy that hides client addresses all
  look like one address.

## 104. macOS and Linux installers aligned (v0.41.0)
- Reverses the macOS-only part of entry 101: the macOS installer opens the public
  Cloudflare Quick Tunnel by default again (`--no-tunnel` opts out), because
  creating the first administrator now needs the setup code (entry 103), which
  removes the "first visitor claims it" risk that motivated the opt-in. Linux is
  unchanged. WSL stays local-only by default (a personal PC).
- Both installers end the same way: status, public address, `Setup code: XXXX-XXXX`,
  the scan hint and the QR right below it. An existing administrator (re-run of
  the installer) prints no code; the "run citadel setup-code" hint only appears
  when the lookup itself failed.
- The macOS menu bar icon is the only difference and can never stop the install:
  `menubar-macos.sh install` exits 3 without the Xcode tools (checking
  `xcode-select -p`, since a `swiftc` shim exists even without them) and 4 without
  a graphical login session (SSH), and the installer maps 0/3/4/other to a note
  printed after the QR instead of treating a failure as an install error.
- Verified by running the whole macOS installer on Linux with fake
  `uname`/`launchctl`/`swiftc`/`git`/`npm`/`curl` and a stubbed tunnel script
  (icon added; no Xcode tools; SSH session; `--no-tunnel`), plus
  `tests/menubar.test.js` (exit codes, defaults, output order). The Linux
  installer was only exercised with `--check-only` and by reading it; not run on
  a real Mac.

## 105. Release v0.41.0
- Highlights since v0.40.0: disk usage analysis and quick cleanup in Files
  (platform-aware, per-item selection), `citadel reset-password`, the first-run
  setup code and security alerts, the Tailscale wizard, WSL2 support for Windows,
  the macOS menu bar icon with `citadel start|stop`, terminal-only QR with a
  Terminal.app-safe renderer, and Linux/macOS installers that end the same way
  (public address, setup code, QR). Details in entries 99-104 and the disk
  cleanup work in the commit history.
- Known gaps: nothing here has been run on a real Mac, Windows PC or tailnet;
  7 pre-existing tests (doctor CLI output, fleet monitor alerts, tmux copy mode)
  still fail on this host as they did on v0.40.0.
- Version bumped to `0.41.0`; asset cache-buster token moved to `v0410`.


## 106. macOS Full Disk Access helper
- macOS asked for permission per protected folder because the LaunchAgent runs `node`
  and everything it starts (terminals, tmux, git, agents) as separate binaries. One
  Full Disk Access grant removes the folder prompts; it can only be made by the user
  in System Settings (or an MDM profile), so it cannot be scripted.
- `server/services/macPermissions.js`: the service probes two folders only listable
  with Full Disk Access and writes `DATA_DIR/permissions.json` every minute (macOS
  only). `citadel permissions [open]` (`scripts/permissions.js`) reports it, opens the
  right System Settings pane and reveals the real `node` path. The macOS installer
  prints a one-line pointer on fresh installs. Documented in `docs/installation.md`.
- Verified with fakes on Linux (`tests/mac-permissions.test.js`: probe results, status
  file, report text, `open` arguments) plus the existing menubar/CLI/WSL suites.
- Known gaps: never run on a real Mac. Unknown whether tmux-spawned terminals are
  covered by the node grant or need tmux allowed too; the docs tell the user to allow
  `tmux` and any program a prompt names. Local Network, Automation, Photos and camera
  prompts are separate permissions and are not covered. `brew upgrade node` changes the
  real path and loses the grant.

## 107. Release v0.42.0
- Highlights since v0.41.0: real RAM usage and temperature for macOS machines in the
  monitor; the machine overview and the machine selector redesigned (gauge cards, KPI
  tiles, incident timeline, live status); relative `data/projects/logs/plugins` paths
  resolved against the app root; `ioreg` called by absolute path so the service works
  under launchd; `citadel permissions` and the Full Disk Access check (entry 106);
  README and guides rewritten, `AGENTS.md`, generated `docs/code-map.md` and
  `CHANGELOG.md`, optional Graphify code graph (`npm run graph`).
- Verification: `node --test` gives 483 tests, 475 pass, 7 fail, in the same three suites
  that already failed on v0.41.0 (doctor CLI output, fleet monitor, terminal/tmux copy).
- Known gaps: the macOS monitor changes and the Full Disk Access flow have not been
  run on a real Mac by the author of this entry; Graphify was never run for real.
- Version bumped to `0.42.0`; asset cache-buster token moved to `v0420` (the rc builds
  still served `v0410`, so browsers could keep stale scripts).

## 108. app.js split and UI smoke test
- `public/js/app.js` went from 5.7k to 3.9k lines. Six self-contained screens moved to
  their own scripts, following the `monitor.js` pattern (`window.CitadelX`, helpers
  passed once through `init(ctx)`): `files.js`, `pairing.js`, `fleet.js`, `activity.js`,
  `repos.js`, `deployments.js` (proxy and Docker). `app.js` keeps one-line wrappers for
  the functions it still calls and wires every module right before the page-load hook.
  Each module checks at start-up that it received every dependency it uses
  (`REQUIRED`), so a missing one fails loudly at load instead of on one rarely used branch.
- Method: ESLint `no-undef` after each cut listed the variables the moved code still
  needed from `app.js`; none of them were reassignable (`let`) variables.
- `tests/ui-smoke.test.js` (new, devDependency `jsdom`) starts a real server in a
  temp directory, signs in and loads the SPA in jsdom: every script registers, the
  shell renders, Files / Settings / Projects / Dashboard open, and the extracted
  screens and the pairing modal render through their entry points, with no script errors.
  Breaking a dependency on purpose makes it fail with the module's message.
- Known gaps: jsdom has no canvas or real WebSocket, so terminals and QR drawing are
  not covered; buttons inside the moved screens were not clicked, only rendered; not
  checked in a real browser or on a phone.
- Incident: while building the smoke test an experimental server was started with the
  shell's `DATABASE_PATH` still pointing at the live database. It ran for about eight
  seconds and left one `server_started` event and one `plugin_initialized` audit row
  (v0.42.0) in the live `events` and `audit_logs`; no other data changed (no rollout, no
  session or user changes). AGENTS.md now says to override all four data paths.

## 109. Test isolation fixes, dead code removal and README screenshots
- Full suite on this host: 486 tests, 485 pass, 0 fail, 1 skipped (the update-rollback
  no-systemd branch, unreachable on a host with systemd). Two suites had failed only because of
  the host they ran on: `monitor.test.js` compared against this machine's real disk
  (86 % full, over the test's 85 % threshold) and `terminal.test.js` ran under a shell
  exporting `TERMINAL_ADMIN_USER`, which starts the global session as another user under
  a tmux server the test cannot see. Both tests now isolate themselves.
- Lint is clean (it had five warnings): removed two unused terminal close helpers, an
  unused constant and function in `app.js`, and unused test variables.
- README: hero dashboard screenshot (light and dark via `<picture>`) and a three-image
  gallery in `docs/img/`. They show a demo instance with simulated machines; all five are
  produced by `scripts/screenshots.js` (isolated temp data, fake machines and history,
  headless Chrome through `puppeteer-core`, which is not a dependency of the project).
- Known gaps: screenshots are taken with Chrome for Testing 155 on Linux, so fonts differ
  from a Mac or phone; they will age as the UI changes (the script regenerates them).
- Observation, not fixed: this host's root filesystem is 86 % full; about 4.4 GB is a
  Flutter/Chrome toolchain under `/srv/citadel/projects/.toolchain`, which is not part of
  Citadel.

## 110. README gallery redesigned
- "A look inside" now shows a persistent terminal and the file explorer next to the
  machine screens, in two rows of two large images plus a centred phone view. The demo
  instance in `scripts/screenshots.js` gained three projects with files and two real
  tmux terminals replaying a test run; those run on a private tmux server
  (`TMUX_TMPDIR` in the temp directory) and the temp directory is deleted at the end.
- Details that would have leaked the real host were fixed before publishing: the shell
  prompt and tmux status line use made-up names, the explorer is walked straight into the
  demo project (its path is shown as `/home/ada/projects/acme-api`), and the demo's own
  helper script lives outside the project folder.
- Known gap: with xterm.js attached, tmux's terminal-capability replies can land on the
  shell prompt as stray text (`1;2c0;276;0c`) if input is typed before they settle; the
  script clears the line first. It looks like a product quirk worth a separate look.

## 111. README gallery removed
- The "A look inside" section was dropped on request: the single dashboard screenshot at
  the top of the README is enough. The extra images (terminal, files, machine health,
  selector, phone) and the code that produced them are gone; `scripts/screenshots.js` now
  only builds the two dashboard images (dark and light) from the isolated demo instance.

## 112. Release v0.42.1
- Highlights since v0.42.0: `public/js/app.js` split into feature scripts (`files`,
  `pairing`, `fleet`, `activity`, `repos`, `deployments`) with a jsdom UI smoke test;
  monitor and terminal tests made independent of the host they run on; lint clean;
  architecture guide rewritten, feature map, ledger split into history and recent,
  graph benchmark protocol; dashboard screenshot in the README.
- Verification: `node --test` gives 486 tests, 485 pass, 0 fail, 1 skipped (the
  update-rollback no-systemd branch). Lint is clean.
- Known gaps: the moved screens were rendered in jsdom but not clicked through in a
  real browser; Graphify has not been measured; the macOS Full Disk Access flow from
  0.42.0 has not been run on a real Mac.
- Version bumped to `0.42.1`; asset cache-buster token moved to `v0421` (new scripts
  were added, so browsers must not reuse cached copies of `app.js`).
