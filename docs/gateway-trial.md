# Claude Code gateway trial

The credential-free protocol experiment remains a developer tool. For the
optional local installation, ChatGPT connection and activation screen, see
[AI Gateway setup](ai-gateway.md). This trial reuses
[CLIProxyAPI v8.0.43](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.43)
and does not install a persistent service or use provider credentials.

## Reproduce the credential-free protocol test

Download the Linux binary from that release into a temporary directory and
verify its SHA-256 against the release's `checksums.txt` before executing it.
The tested artifact was `CLIProxyAPI_8.0.43_linux_amd64_no-plugin.tar.gz`.
With Claude Code already installed, run:

```bash
GATEWAY_TRIAL_BINARY=/absolute/path/to/cli-proxy-api node scripts/gateway-trial.js
```

The script starts a loopback-only gateway and a local fake upstream, uses an
empty temporary Claude configuration and workspace, and enables only Write.
It injects an HTTP 429 for one upstream model, checks that the alternate model
answers, has the actual Claude Code client write a temporary file, and verifies
that the tool result returns to the upstream with its call ID. It also checks
client authentication and that management is disabled. Processes and temporary
files are removed on exit. No Citadel database or existing CLI OAuth cache is
opened. The binary uses embedded model catalogs; panel downloads are disabled.

On 2026-10-25 this passed with three upstream requests: injected 429, translated
Write call, then a context-preserving tool result and final response. This proves
protocol compatibility for that small fixture, not live subscription access,
model quality, billing, long-context behaviour or exactly-once side effects
across arbitrary network failures. The alias pool rotates candidates; it does
not establish a user-configured primary/secondary preference.

## Remaining live validation

The initial device authorization expired without completion. The integrated
Settings screen can now start a fresh login and activate an experimental local
gateway at the operator's request. No live ChatGPT provider call is claimed.
Before relying on cross-model routing for autonomous work, validate actual model
availability, long context, permitted edits and tool-result round trips. Ordered
quota fallback, cancellation during a provider request and exhausted-pool
behaviour still require live checks; the Settings integration does not enable
automatic quota fallback.
