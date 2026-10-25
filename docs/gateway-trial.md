# Claude Code gateway trial

This is a developer experiment, not an installed Citadel service. It reuses
[CLIProxyAPI v8.0.43](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.43)
rather than implementing provider protocols in Citadel. No runtime dependency,
second Citadel database, automatic installer or Settings switch has been added.

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

## Live validation and Settings gate

The operator selected ChatGPT device login for a separate gateway credential
store. The initial device authorization expired without completion; restart
the login flow to obtain a fresh code before a real provider call. Tokens
stay outside the repository and must never be returned by a Settings API.
[OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth)
describes ChatGPT sign-in and device authentication for Codex; third-party
gateway compatibility must still be validated independently.

Before adding permanent Settings:

1. Run Claude Code through the gateway against the authenticated provider,
   including one permitted file edit and its tool-result round trip.
2. Verify available model IDs rather than assuming subscription entitlement.
3. Exercise a controlled quota response, explicit fallback ordering, cancellation
   and exhausted-pool behaviour. Never replay an already emitted tool call.
4. Scope endpoint/model overrides to newly launched gateway sessions. Existing
   native Claude/Codex sessions and their own configuration must remain usable.
5. Expose endpoint, planning/execution model aliases, fallback preference and a
   connection test. Record model switches and reasons without prompts/tokens.

[Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway)
and [model configuration](https://code.claude.com/docs/en/model-config) describe
the compatible endpoint and model aliases. Changing an endpoint does not by
itself transfer subscription access. Keep the gateway local and opt-in; respect
provider account limits rather than rotating accounts to bypass them.
