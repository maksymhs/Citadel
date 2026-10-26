# AI Gateway for Claude Code

Open **Settings → AI Gateway** as an administrator. This optional integration
runs pinned CLIProxyAPI 8.0.43 locally and routes Claude Code to your explicitly
connected Claude and/or ChatGPT accounts. It is experimental: availability,
subscription entitlement and third-party protocol compatibility must be checked
with your accounts. It does not import existing CLI login caches.

## Connect accounts

1. Select **Install component**. Citadel downloads the pinned platform binary
   and verifies its SHA-256, then installs only the executable under
   `DATA_DIR/gateway`. Linux/macOS x64/arm64 and `tar` are supported. No sudo or
   system service is installed.
2. Select **Connect ChatGPT**. Open the device-login link, enter the one-time
   code and authorize in your browser. Enable device login in ChatGPT security
   settings if requested. Wait for **Connected**.
3. Select **Connect Claude** and authorize from the displayed link. Your browser
   may fail to open the localhost callback address. Copy that complete address
   from the browser address bar into **Claude callback URL**, then select
   **Finish connection**. Submit this URL only in Citadel, never in chat, logs or
   an issue. Expired flows can be started again. This authorization is separate
   from native Claude Code login.

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

The compact Settings screen has one card per provider. Each card contains its
connection status and actions, three model selectors (planning, execution and
background), and separate usage meters when the account reports them. A meter
shows the percentage and a thin bar; unavailable values are labeled rather than
shown as zero. Reset dates are displayed with local time and relative time. Each
account and each usage window stays separate: Citadel does not add percentages or
infer a daily limit from an unnamed window. **Refresh** updates that provider's
catalog and usage. Catalog provenance, freshness and account-access caveats are
available in the card's model-list details. A listed model is informational and
does not guarantee that your subscription can use it. A saved model remains
selected and marked unverified if a later catalog does not list it; there is no
manual-ID editor.

Provider-reported usage windows may include Claude's five-hour/seven-day windows
or Codex's windows when the upstream account reports their duration. These
subscription endpoints are not stable public API contracts: usage may be
unavailable or stale without preventing model configuration. A missing value is
not unlimited usage.

ChatGPT defaults remain Sol for planning and Luna for execution/background work.
Claude defaults remain Opus 5.5 / Sonnet 5.5 / Haiku 5.5 from the pinned catalog;
these defaults do not establish account access. Refresh a provider to update its
catalog and usage. **Test saved configuration** sends a small execution-role
request and consumes your allowance. Test each provider separately before relying
on Auto; Auto requires both accounts connected.

The **Use in new terminals** switch applies immediately to the saved
configuration and does not save other pending edits. Use **Save configuration**
to apply model or mode changes; pending edits are kept separate from activation.
Open a new project terminal and type `claude`. The terminal prints **AI Gateway
active**. Project agent launches use the same configuration.

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

The shared context budget defaults to 1,000,000 tokens and is declared with
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, avoiding the unknown-alias context warning. The
current built-in Claude defaults and GPT-6.1 Sol / GPT-6 Luna defaults support at
least 1M tokens, but discovered or previously saved custom model IDs may have
smaller windows. Set a budget supported by **every** eligible model, including Auto's
fallback; this is operator configuration, not verified model capacity. Previously
saved budgets are preserved and can be changed in Advanced options. Context
changes require a new terminal. Requests already emitted and arbitrary tool side
effects are not guaranteed replayable; streaming/live subscription interoperability
still needs real-account tests.

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
administrator-authenticated, origin-checked setup/settings/test/callback and
provider-discovery routes. OAuth callback state and redirect origin/path are
validated, callback URLs never enter audit details, and responses use
`Cache-Control: no-store`. Discovery sends fixed read-only subscription-usage
requests through the local proxy; it does not expose credentials, account
identifiers, upstream headers or response bodies. Panel downloads, passive usage
aggregation and request/error-body capture are disabled. Provider stdout/stderr
are discarded.

### Per-model statistics

Per-model request statistics are not collected or shown. CLIProxyAPI 8.0.43's
management `usage/queue` endpoint consumes queued events when read (`PopOldest`);
it is not a passive snapshot. Events can contain credentials or account/source
identifiers, session/trace IDs, headers, tokens and error bodies. They represent
upstream attempts rather than necessarily user conversations, and are not the
subscription's global usage. The in-memory queue can also lose events on expiry
or restart. Citadel therefore keeps event capture disabled and does not poll this
endpoint from Settings. A future opt-in design would need bounded server-side
aggregation over an allowlist without retaining raw events, explicit loss
semantics, and privacy tests.

Sources pinned to the bundled CLIProxyAPI version:
- [Management API contract (v8.0.43)](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.43/docs/management-api-v8.md#L83-L100)
- [Usage queue handler: destructive pop](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.43/internal/api/handlers/management/usage.go#L23-L54)
- [Queued event fields](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.43/internal/redisqueue/plugin.go#L181-L242)

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
