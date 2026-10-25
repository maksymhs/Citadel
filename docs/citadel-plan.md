# Citadel working plan

Release preparation for v0.44.0, 2026-10-25. External contribution and platform
checks remain tracked below.

- [x] Repair review/retry, per-attempt budgets, plan transactions, Markdown links
  and credential redaction, with regression coverage.
- [x] Prepare the Linux Docker trial: postinstall inputs, non-root runtime,
  persistent data and configurable loopback port (3001 by default).
- [ ] Build and run that image on a machine with Docker socket access. This host
  cannot do so with the current account. Docker does not simulate macOS.
- [x] Discover project folders automatically when opening Projects; keep import
  explicit and scans bounded, without a background watcher.
- [x] Prepare local/SSH desktop VS Code links from project actions.
- [ ] Exercise those links with a real desktop VS Code and an SSH connection.
- [x] Simplify runtime costs: unchanged Docs reads and stable failure refreshes
  avoid writes; session activity writes are limited to once per minute.
- [x] Add and run an isolated core API benchmark. See
  [measurements and limits](performance-baseline.md).
- [ ] Measure the complete service with live terminals, agents and a browser.
- [x] Prepare the current Citadel fixes as a local open source contribution
  candidate and document a [contribution workflow](contribution-workflow.md).
- [ ] Choose an external issue, use Citadel for the full contribution and have
  the operator review the patch before publication.
- [ ] Validate macOS behaviour on an actual Mac or macOS VM.

A hosted editor or more autonomous machinery should follow evidence from the
contribution exercise. No second queue, scheduler, database or external service
is introduced by this work.
