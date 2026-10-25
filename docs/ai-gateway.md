# AI Gateway for Claude Code

Open **Settings → AI Gateway** as an administrator on the machine where Claude
Code runs. This optional integration uses pinned
[CLIProxyAPI v8.0.43](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.43)
to connect Claude Code to models available through your ChatGPT account.
It is experimental: third-party protocol translation and account/model
availability are not guaranteed by Citadel or the model providers.

## Activate

1. Click **Install local gateway**. Citadel downloads the platform binary from
   that release, verifies its SHA-256 against the release checksums, and installs
   only the executable under `DATA_DIR/gateway`. Linux and macOS x64/arm64 are
   supported; `tar` is required. No sudo or system service is installed.
2. Click **Connect ChatGPT**. Open the displayed OpenAI device-login link and
   enter the one-time code. Complete authorization in your own browser. If
   requested, enable device login in ChatGPT security settings. Wait for
   **ChatGPT connected**. Expired or failed logins can be started again.
3. Choose planning, execution and small/background models. Defaults are
   `gpt-6.1-sol`, `gpt-6-luna` and `gpt-6-luna`; these are preferences, not a claim
   that your plan grants access. Enable **Use gateway for new Claude Code
   sessions** and click **Save**. The gateway must start successfully before
   activation is saved. Change port 8317 while disabled if it is already in use.
4. Click **Refresh status / models** for available model IDs. Update preferences
   and save as needed. **Test model** sends a small request using the saved
   execution model and your account allowance; it reports success or a bounded
   error without returning generated text or provider response bodies.
5. From **Projects**, launch **Claude Code** in the usual way. New Claude
   sessions use `opusplan`: planning maps to the planning model and execution to
   the execution model. Small/background requests use the small model alias.

Only Claude sessions launched from Citadel's project agent action use the
integration. Typing `claude` in an existing terminal, other agents and task mesh
headless jobs retain their existing setup. Model settings apply to new sessions;
restart a Claude session after changing them. No shell profile or existing CLI
login cache is edited. The gateway is local to each Citadel machine.

## Disable, restart and disconnect

Uncheck the enable box and save to stop the gateway and restore native mode for
new launches. Sessions already using the gateway lose connectivity when it
stops. To restart a failed process, disable and enable it. Enabled gateways
resume when Citadel starts; a startup failure is visible in Settings and does
not block the core panel. Citadel does not silently fall back to another account
or model when the gateway fails.

**Disconnect** stops the gateway, cancels pending device login and removes its
stored ChatGPT credentials from Citadel. It does not sign other CLIs out or
revoke the account's authorization at the provider. Use your account security
controls for provider-side revocation.

Automatic quota fallback is not enabled in this integration. The earlier
[protocol trial](gateway-trial.md) demonstrated an injected-429 alternate-model
pool with a fake upstream; ordered fallback, live quota handling and general
side-effect replay safety still need validation.

## Data and security

The listener binds only to `127.0.0.1`. Its management interface, panel downloads,
network discovery, request/error-body capture middleware and usage aggregation
are disabled. Provider stdout/stderr are drained without being copied to Citadel
logs. Setup/settings/test actions are audited without prompts or credentials.

Credentials and the local client key persist encrypted with Citadel's existing
AES-GCM key in `app_config`. The proxy needs plaintext while running: Citadel
materializes its own credential files and launch configuration in a private
0700 temporary directory (Linux `/dev/shm` when available), with files set to
0600. Refreshed credentials are checkpointed encrypted periodically and on clean
shutdown; runtime files are removed after login when idle, when disabled, and on clean
shutdown/disconnect. An abrupt kill
can leave temporary files until host cleanup and can lose the latest refresh.
On macOS or Linux without `/dev/shm`, temporary plaintext may reside on disk.
Never share or back up this runtime directory as ordinary project content.
Existing Claude/Codex OAuth caches are never imported. Third-party gateway
execution has the same unprivileged account access as Citadel.

Claude's [gateway guide](https://code.claude.com/docs/en/llm-gateway) describes
protocol compatibility; Anthropic does not support routing Claude Code to
non-Claude models. OpenAI's [authentication guide](https://learn.chatgpt.com/docs/auth)
describes ChatGPT/Codex device login, not a blanket compatibility guarantee for
this third-party gateway. Respect account and workspace restrictions.

## Verification limits

Lifecycle, encrypted persistence/resume, port conflicts, download verification,
admin boundaries, project launch routing and the Settings UI have isolated
regression tests. A real Linux release download/extraction was checked in a
temporary directory. The protocol trial used the actual Claude Code client with
fake upstream responses and a tool-result round trip. No live ChatGPT-authenticated
model call or real macOS run is claimed yet.
