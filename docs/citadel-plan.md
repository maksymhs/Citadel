# Citadel working plan

Keep Citadel focused on projects, persistent terminals, machines and existing
CLI agents. Project hub and its internal planning/docs/learning/graph machinery
have been retired; historical user data remains available on disk.

- [x] Remove Project hub UI, APIs, services and automatic work claims.
- [x] Keep the task mesh, native Claude/Codex/OpenCode adapters and activity journal.
- [x] Prove Claude Code tool/context translation and injected-429 fallback through
  an isolated, existing gateway. See [gateway trial](gateway-trial.md).
- [ ] Validate a real ChatGPT-authenticated provider session through that gateway.
- [ ] After validation, add opt-in Settings for endpoint, model aliases, explicit
  fallback order and connection test. Keep native CLI mode available.
- [ ] Assess Telegram using existing notification support first; add private-chat
  allowlists and narrow actions before arbitrary terminal control.
- [ ] Build/run the Docker trial where socket access exists. Linux containers do
  not simulate macOS; test macOS on a real Mac or macOS VM.
- [ ] Exercise local/SSH VS Code links on a desktop.
- [ ] Measure full-service idle cost, live terminals/agents and browser polling;
  use the [core baseline](performance-baseline.md) for repeatable comparisons.
- [ ] Use Citadel for one external open source contribution before adding further
  orchestration features. Have the operator review publication.
