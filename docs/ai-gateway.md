# AI Gateway for Claude Code

Open **Settings → AI Gateway** as an administrator. This optional integration
runs pinned CLIProxyAPI 8.0.43 locally and routes Claude Code to your explicitly
connected Claude and/or ChatGPT accounts. It is experimental: availability,
subscription entitlement and third-party protocol compatibility must be checked
with your accounts. It does not import existing CLI login caches.

## Connect accounts

1. Click **Install local gateway**. Citadel downloads the pinned platform binary
   and verifies its SHA-256, then installs only the executable under
   `DATA_DIR/gateway`. Linux/macOS x64/arm64 and `tar` are supported. No sudo or
   system service is installed.
2. **Connect ChatGPT** starts a device login. Open the OpenAI link, enter the
   one-time code and authorize in your browser. Enable device login in ChatGPT
   security settings if requested. Wait for **ChatGPT connected**.
3. **Connect Claude** shows a Claude authorization link. After approving it, your
   browser may fail to open the localhost callback address. Copy that complete
   address from the browser address bar into **Claude callback URL**, then click
   **Finish Claude connection**. Wait for **Claude connected**. Submit this URL
   only in Citadel, never in chat, logs or an issue. Expired flows can be started
   again. The authorization is separate from native Claude Code login.

Claude authorization uses CLIProxyAPI's internal OAuth endpoints with
`is_webui=false`. This avoids its wildcard callback listener: there is no SSH
forwarding, extra callback port or public listener. The final code exchange
still happens in the proxy. ChatGPT device login retains its existing flow.
A setup-only proxy stops once Claude authorization finishes.

## Modes and model preferences

| Mode | Selection |
| --- | --- |
| ChatGPT only | ChatGPT/Codex supplies all three model roles |
| Claude only | Your gateway-connected Claude account supplies all three roles |
| Auto | Claude has priority; ChatGPT is the fallback on eligible quota/availability failures |

Select a mode and model IDs for each provider, then **Save**. ChatGPT defaults
remain Sol for planning and Luna for execution/background work. Claude defaults
are Opus 5.5 / Sonnet 5.5 / Haiku 5.5 from the pinned catalog; defaults do not
establish account access. **Refresh status / models** loads advertised model IDs.
**Test model** sends a small execution-role request using your allowance and
shows the returned model ID when available. Test each provider's mode separately
before relying on Auto. Auto requires both accounts connected.

Enable **Use gateway for Claude Code in new project terminals**. The checkbox
saves immediately; **Save** applies later mode/model edits. Open a new project
terminal and type `claude`. The terminal prints **AI Gateway active**.
Project agent launches use the same configuration.

### Changing routes without restarting Claude

New shells use fixed model IDs: `citadel-planning`, `citadel-execution`,
`citadel-small`. `opusplan` selects planning versus execution; the gateway maps
those IDs to real upstream models. Saving mode or model changes updates the
proxy's runtime configuration in place. The next request uses the updated map;
an already in-flight request retains its original route. No CLI binary or
provider identity is modified.

**Existing v0.48.0 terminals need one reopen** to adopt these aliases. A session
started with a concrete upstream model ID keeps requesting that ID and is not
controlled by the role aliases. After adopting them, ordinary route/model edits
do not require reopening Claude. Changing the shared context budget or local
port still requires a new terminal; disable the gateway before changing ports.

Auto uses priority 100 for Claude, 50 for ChatGPT, fill-first selection and
session affinity. A conversation on its fallback can stay there even when
Claude recovers; a new conversation prefers the available primary. Select
**Claude only** to force a return. This avoids switching providers on every
message. Quota and transient availability failures can fail over; invalid
requests, authentication, billing and policy-denial statuses are surfaced.
If all eligible accounts are exhausted, the request fails explicitly.

The context budget defaults to the previous conservative 200,000-token
assumption and is declared with `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, avoiding the
unknown-alias context warning. Set a budget supported by **every** eligible
model. This is operator configuration, not verified model capacity. Requests
already emitted and arbitrary tool side effects are not guaranteed replayable;
streaming/live subscription interoperability still needs real-account tests.

## Disable and disconnect

Disabling stops the proxy and interrupts its dependent sessions; new terminals
use native mode. A pending Claude authorization is cancelled locally when it is
stopped. **Disconnect** removes both gateway accounts from Citadel and cancels
pending login; it does not sign your native CLIs out or revoke the provider's
account-side authorization. Enabled gateways resume after a Citadel restart.

Project shells inherit the gateway endpoint and aliases, so other commands in
those shells also inherit those variables. System shells and headless task-mesh
jobs retain their own setup. No shell profile is edited.

## Security and verification

The listener binds to `127.0.0.1`. Its management API is now enabled only on that
listener, with remote access disabled and a separate random key kept in private
runtime memory/files, never returned to the browser. Citadel exposes only
administrator-authenticated, origin-checked setup/settings/test/callback routes.
OAuth callback state and redirect origin/path are validated, callback URLs never
enter audit details, and responses use `Cache-Control: no-store`. Panel downloads,
network discovery, usage aggregation and request/error-body capture are disabled.
Provider stdout/stderr are discarded.

Account tokens and the client key persist encrypted with Citadel's existing
AES-GCM key in `app_config`. The proxy needs plaintext while running: its own
credential files and launch configuration live in a private temporary directory
(0700, files 0600; Linux `/dev/shm` when available). Refreshed credentials are
checkpointed encrypted and cleaned up after idle login, disable or clean
shutdown. Abrupt termination can leave temporary material until host cleanup and
lose the latest refresh. Other systems may place runtime plaintext on disk.
Gateway execution has the Citadel service account's privileges.

Tests cover auth boundaries, callback validation, encryption, account separation,
priority/alias generation, lifecycle, typed `claude` and Settings actions. The
real pinned binary was checked for Claude OAuth initialization without a new
callback listener and for hot OAuth-alias catalog changes using fixture files.
The [routing trial](gateway-routing.md) verifies cross-protocol priority, an
in-flight non-streaming request, tool-result history, injected 429 fallback and
explicit pool exhaustion with fake upstreams. The operator separately reported
Luna responding; no real Claude-to-ChatGPT subscription failover, arbitrary
stream replay safety or real macOS validation is claimed.

See [Claude Code gateway documentation](https://code.claude.com/docs/en/llm-gateway)
and [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth).
Anthropic does not support routing Claude Code to non-Claude models; provider
account/workspace restrictions continue to apply.
