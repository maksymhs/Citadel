# Diagnostics, recovery & maintenance

Back to the [README](../README.md).


The local CLI works without the web server, dashboard login, GitHub or Internet
access. It reuses the installed Node.js runtime and has no extra dependencies.

```bash
# Read-only overview: host, load, memory, disk/inodes, systemd, network, Wi-Fi, Citadel
citadel doctor
citadel doctor --json

# Detailed interface, route, DNS and Wi-Fi diagnosis
citadel network
citadel network --json

# Wi-Fi is optional (a VPS without wireless hardware is fine)
citadel wifi list
citadel wifi list --json
citadel wifi connect "Home Wi-Fi"          # saved NetworkManager profile
citadel wifi connect --ssid="Home Wi-Fi"
citadel wifi connect                       # pick from the visible list
citadel wifi connect "New Network"         # new networks prompt via: nmcli --ask

# List and apply only explicitly supported recovery actions
citadel repair
citadel repair --json
citadel repair --action=restart:citadel.service --yes
```

From a source checkout, use `node scripts/doctor.js <command>` (or `npm run doctor`).
The commands target Debian/Ubuntu with systemd first; missing tools, systemd or
Wi-Fi are reported as **SKIP**, never as a crash. A VPS without NetworkManager or
wireless hardware still gets full wired/Citadel diagnostics.

Safety rules:

- `doctor` and `network` are read-only. They never edit Netplan, NetworkManager,
  systemd or firewall configuration, and they do not require the panel to be
  running. DNS/HTTP/gateway failures are reported as observations because a
  read-only host check cannot prove why the Internet is unavailable.
- `repair` only offers allow-listed actions: restart a **failed** systemd unit,
  restart `citadel.service`, unblock the Wi-Fi radio with `rfkill`, or activate a
  saved NetworkManager profile. It validates the unit, asks for confirmation,
  verifies the result and reports failure honestly. There is no generic command
  runner and no automatic rollback.
- Wi-Fi passwords are **never** accepted as command-line arguments and are never
  written to history, logs or JSON. New networks are joined with `nmcli --ask`,
  which prompts on the terminal; saved profiles use `nmcli connection up id`.
- Over SSH, a Wi-Fi change warns that the session can drop and refuses
  `--yes` unless `--confirm-remote` is also supplied. Keep console/IPMI access.
- Exit codes: `0` = no confirmed problem / action verified, `1` = problem or
  failed action, `2` = invalid usage. In `--json` mode stdout contains only the
  JSON document; progress and warnings go to stderr.

## Maintenance

```bash
# Update the application while preserving data and projects (run with sudo on a server)
./scripts/update.sh
sudo /usr/local/sbin/citadel-update --check   # verify the updater without changing anything

# A failing update rolls back both the code and, if the new version may have
# migrated it, the database. A reliable SQLite snapshot is taken first; if one
# cannot be produced (or the service cannot be stopped to restore it) the update
# is refused before the checkout changes. Snapshots live in data/backups/.

# Uninstall (service, scripts, /srv/citadel, the user). The source checkout is kept.
./scripts/uninstall.sh

# ...but keep the database and projects
./scripts/uninstall.sh --keep-data

# ...also delete the local checkout (asks for interactive confirmation)
./scripts/uninstall.sh --remove-source

# ...validate paths and show the plan without changing anything
./scripts/uninstall.sh --dry-run
```

