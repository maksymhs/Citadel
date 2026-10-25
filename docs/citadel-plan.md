# Citadel working plan

Keep Citadel focused on projects, persistent terminals, machines and existing
CLI agents. Project hub and its internal planning/docs/learning/graph machinery
have been retired; historical user data remains available on disk.

- [x] Remove Project hub UI, APIs, services and automatic work claims.
- [x] Keep the task mesh, native Claude/Codex/OpenCode adapters and activity journal.
- [x] Prove Claude Code tool/context translation and injected-429 fallback through
  an isolated, existing gateway. See [gateway trial](gateway-trial.md).
- [ ] Validate a real ChatGPT-authenticated provider session through that gateway.
- [x] Add opt-in [AI Gateway Settings](ai-gateway.md) with local installation,
  ChatGPT device login, model aliases and connection test; keep native mode.
- [x] Add stable gateway aliases, Claude/ChatGPT/Auto modes and explicit Claude authorization.
- [ ] Validate a real two-subscription quota failover and streamed response failures.
- [ ] Assess Telegram using existing notification support first; add private-chat
  allowlists and narrow actions before arbitrary terminal control.
- [ ] Build/run the Docker trial where socket access exists. Linux containers do
  not simulate macOS; test macOS on a real Mac or macOS VM.
- [x] Replace desktop/SSH links with optional browser VS Code and a Citadel return button.
- [ ] Validate browser editor on macOS and add paired-machine editor transport.
- [ ] Measure full-service idle cost, live terminals/agents and browser polling;
  use the [core baseline](performance-baseline.md) for repeatable comparisons.
- [ ] Use Citadel for one external open source contribution before adding further
  orchestration features. Have the operator review publication.
