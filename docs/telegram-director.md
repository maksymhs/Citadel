# Telegram project director (experimental)

One private bot directs multiple projects while preserving independent execution,
conversation and policy. The feature is disabled until an administrator configures
and enables it in **Settings → Telegram director**. Linux is the execution target.

## Setup

1. Run Citadel as a dedicated unprivileged user, without the privileged System
   Terminal. In **Settings → Telegram director → Coordinator AI**, click
   **Install Codex**, then **Connect ChatGPT**. Open the official authorization
   link, enter the displayed one-time code and finish in your browser. No SSH
   login command is needed. Finally click **Test coordinator**: this makes one
   short real model request and verifies the reply. Native subscription login
   is checked as the Citadel service user; API-key login does not count as a
   connected ChatGPT subscription. Device-code login may need enabling in your
   account's security settings. API credentials are not required.
2. Create a bot with BotFather. In Settings enter its token, your numeric Telegram
   user ID and your private chat ID. Tokens are encrypted at rest, never returned.
   Use a dedicated bot: no other application may consume its updates or configure
   a webhook. Citadel uses outgoing long polling; no public endpoint is needed.
3. Register/import projects using the existing panel. New project requests from
   Telegram can initialize a Git repository or clone a credential-free HTTPS
   GitHub URL. Existing unmanaged folders are never overwritten.
4. Configure project tests and, optionally, publishing policy. These settings
   authorize execution; only an administrator can change them.
5. Enable the director and refresh status. Citadel runs a journaled local sentinel
   with two project slots by default and an additional conversation routing slot.
   The bot remains experimental until exercised with your native login and repos.

Example general project policy:

```json
{
  "adapter": "general",
  "priority": 0,
  "tests": [{"cmd": "npm", "args": ["test"]}],
  "publish": true,
  "repository": "owner/repository",
  "base": "main",
  "requiredChecks": ["test"],
  "workflow": "deploy.yml"
}
```

The repository's existing workflow must deploy on merge to the authorized branch.
Native `gh` login needs access to that repository. Production credentials belong
in CI. Without publishing authorization, verified changes remain in a worktree;
without tests the bot asks for verification configuration before publication.
An optional HTTPS `healthUrl` reports PASS, FAIL or UNKNOWN separately from workflow
success. Do not configure endpoints that cause effects on a GET.

## Conversation

Ask “¿Cómo vamos con Oceans?”, “¿Por dónde seguimos?” or “Mientras sigue Oceans,
añade login al portfolio”. Status and menus do not call a model. Consultation
inspects source/backlog under the adapter and returns a recommendation; “sigue”
starts that proposal. The router requires a project when the destination is
ambiguous. A selected project affects new messages, not replies to older cards.

Chat mode is the default, including existing installations: replies contain text
and no inline menus. Send `/manual` or `/menu` to explicitly enable menus, and
`/chat` to return to conversation. The preference persists and is also available
as **Manual mode · show Telegram menus** in Settings → Telegram director.

`/projects`, `/status`, `/decisions`, `/pauseall`, and `/resumeall` remain
available without a model. Manual project cards offer consultation, continuation,
pause, resume and cancellation. In chat mode, decision questions list their
options in text; reply to the decision message to answer.
The owner may also use the panel for configuration and decisions.

Repos share a scheduling identity across Git worktrees. A second job for the same
repo waits. Jobs on other repos proceed until capacity is filled. Priority changes
affect the next eligible job. The system does not invent new product work when a
requested objective is complete. An empty local queue means idle, not proof of
an empty external backlog.

## Recovery and limits

Incoming messages and outgoing deliveries are durable. Duplicate updates do not
create another instruction. Telegram sendMessage has no idempotency key: a response
lost after delivery can still cause a duplicate notification; it cannot duplicate
work or accept a decision twice.

Pause requests cancellation through the existing worker protocol, preserving the
worktree. Resume reconciles in the original native session. Cancellation is only
confirmed after the worker confirms termination. Unknown process outcomes retain
repository exclusion and require operator reconciliation through the existing task
mesh protocol. Never delete a journal to make a task eligible again.

Publication reads GitHub state before effects and binds merge to the verified PR
head. Uncertain publication is stopped for operator reconciliation; inspect the
stored result, branch, PR and workflow before submitting further instructions.
This version does not automatically recover a missing native session or renew
project permissions. Reconnect a provider manually from Coordinator AI when needed. Quota pauses do not switch
to another billing account. Timeouts default to 30 minutes and preserve work.
Tests and CLI authentication must already work on the host; dependency installation
may need the operator's configured native sandbox/network policy.

Worktrees are private organizational workspaces, not an OS sandbox. Projects of
the service user can access one another's files, including service-account data.
Use trusted repositories. Do not use root or privileged System Terminal grants.
No claim of isolation between project processes is made.

## Oceans compatibility

Oceans uses its own kernel, Jira backlog, local exact-head CI, checkpoint/session
identity, operation journal and merge guardian. Generic publishing is never used.
Diagnostics require the kernel's Codex permission check and authenticated Telegram
decision bridge. The current inspected kernel lacks both interfaces, so the
adapter **refuses autonomous execution**, rather than bypassing permission gates.

See [the integration contract](oceans-director-contract.md). Kernel changes must
be separately reviewed and accepted under its own amendment procedure. Citadel
alone cannot activate or certify them. Existing historical mission records remain
untouched; no retired Project hub automation is reenabled.

## Administrative API

All routes require administrator authentication, reject cross-site browser calls
and return no-store responses. Mutations are audited without message/token content.

- `GET /api/director`: configuration without token, projects, jobs and runtime state.
- `PUT /api/director/config`: enabled, ownerId, chatId, token, concurrency (1–6),
  timeoutMs (60,000–7,200,000). Omit token to retain it.
- `PUT /api/director/projects/:id`: adapter and verification/publication policy.
- `POST /api/director/projects/:id/diagnose`: native and kernel compatibility probes.
- `POST /api/director/projects/:id/instructions`: `{kind: "consult"|"execute", instruction}`.
- `POST /api/director/projects/:id/control`: `{action: "pause"|"resume"|"cancel"}`.
- `POST /api/director/control`: `{action: "pause"|"resume"}` globally.
- `POST /api/director/decisions/:id/answer`: `{answer}`; Oceans requires its bridge.

`CITADEL_DIRECTOR_TICK_MS` sets the local scheduling interval (default 2000,
minimum 1000). No Telegram credentials are passed in worker environment variables.

### Coordinator AI setup API

Administrator-only, same origin protections as other director endpoints:
`GET /api/director/setup`, `POST /api/director/setup/install`,
`POST /api/director/setup/login`, and `POST /api/director/setup/test`.
Installation reuses the fixed Codex lifecycle with validation and retained releases.
The browser can never supply an installer command or executable path. Authorization
runs `codex login --device-auth` as the service user; only the approved OpenAI URL
and temporary code are returned, never raw CLI output or account tokens. Codes are
cleared when authorization ends and are not persisted in Citadel configuration.
The actual installed executable is resolved through the agent registry for setup,
project diagnosis and director workers, independently of the SSH user's PATH.
