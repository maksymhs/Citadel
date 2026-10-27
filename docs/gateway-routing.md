# Gateway hot routing: feasibility and isolated proof

CLIProxyAPI 8.0.43 can change routes without restarting its listener. The
[upstream hot-reload guide](https://help.router-for.me/configuration/hot-reloading)
covers configuration and credential reloads; the
[pinned example](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.43/config.example.yaml)
documents priorities, model aliases and session affinity. This document describes
a verified development trial. The integration now exposes explicit
Claude/ChatGPT/Auto modes in [Settings](ai-gateway.md); Auto remains opt-in and
requires both accounts connected.

## Reproduce

Use a checksum-verified CLIProxyAPI v8.0.43 binary, as in the
[protocol trial](gateway-trial.md), then run:

```bash
GATEWAY_TRIAL_BINARY=/absolute/path/to/cli-proxy-api node scripts/gateway-routing-trial.js
```

The script creates its own temporary configuration and empty auth directory,
starts one loopback gateway and a local upstream fixture, and removes them on
exit. No Citadel database, provider subscription, existing CLI auth cache or
production configuration is accessed. All credentials are fixtures. The primary
uses the Anthropic Messages protocol; the secondary uses OpenAI-compatible chat
completions. This does not exercise OAuth subscription authentication.

Verified against the pinned binary:

- One client-visible alias, `citadel-execution`, first routes to the primary.
- Rewriting its configuration changes the next call to the secondary without
  changing the listener, client alias, key or gateway PID.
- A non-streaming request already in flight completes on its original route.
- A tool-result history survives the route change and is translated correctly.
- In Auto configuration, priority 100 selects the primary over priority 50.
- An injected primary HTTP 429 falls back to the secondary. The following call
  does not retry the exhausted primary. When both exhaust, the call fails
  explicitly rather than looping.

The configuration used `routing.strategy: fill-first`, session affinity enabled,
`session-affinity-rebind-on: quota` and no additional credential retry rounds.
The trial uses no side-effecting tools, actual user conversation, streamed
mid-response failure or live account limits. Exactly-once execution and long
context compatibility are not established by it.

## Important pinned-watcher detail

In-place writes to the config file hot-reloaded successfully. Replacing that
file with a temporary-file rename failed to reload in the same isolated trial
with the same startup delay. The pinned watcher registers the config file itself
and only treats Write/Create/Rename as config events; replacement can lose the
watched inode. The experiment is reproducible with `GATEWAY_TRIAL_ATOMIC=1`,
which is expected to fail on this tested Linux host.

Citadel currently writes the runtime config in place. The controller must
keep writes serialized and validate the full configuration before writing. Do
not introduce rename-based replacement without a reload acknowledgement or a
verified upstream watcher fix. Management remains disabled; enabling its API is
not necessary for the tested reload path.

## Integrated Citadel behaviour

Keep Claude Code pointed at one local endpoint and fixed, descriptive aliases:
`citadel-planning`, `citadel-execution`, `citadel-small`. Map these aliases to
actual models inside the gateway, rather than changing CLI environment variables
for each model switch or disguising GPT as a known Claude model.

Settings exposes three modes:

| Mode | Route policy |
| --- | --- |
| Claude | Only the explicitly connected Claude provider |
| ChatGPT | Only the explicitly connected Codex/ChatGPT provider |
| Auto | Prefer Claude; fall back to ChatGPT on eligible failures; keep a session on its fallback while it continues |

The selected model pair controls planning and execution independently. Priorities
select the initial provider; session affinity prevents repeated oscillation.
A returning primary should normally be used on a new conversation or explicit
operator switch. Change routing between requests; never promise to interrupt an
already emitted response or replay already completed tools safely. Advertise
actual provider/model and switch reason in Citadel. Use a declared context budget
compatible with every eligible model, not Claude capabilities assumed from a
misleading alias.

The integration uses stable aliases and a separate Claude OAuth authorization
flow. Existing v0.48.0 shells need one reopen to adopt aliases. Native Claude
login does not by itself connect that account to the proxy; saved CLI tokens
are never imported. API-key fixture success is not proof that every live
Claude/Codex OAuth pair behaves identically. Test both account routes, their
actual limits and streaming/tool use before relying on Auto.

The routing trial also checks `/v1/chat/completions`, the OpenCode adapter path,
against Claude and OpenAI-compatible fixture upstreams. The fixtures emit SSE when
the gateway requests streaming. This validates protocol conversion with CLIProxyAPI
8.0.43, not a live subscription or a complete OpenCode conversation.
