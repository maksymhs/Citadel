# Oceans integration contract — pending kernel acceptance

This document is an implementation proposal for the canonical Oceans kernel,
not an activated amendment. Inspected source: oceans-app/oceans-api main, kernel
v11. The existing kernel explicitly states that only Claude permission rendering
has been verified. Autonomous Codex execution must remain blocked until verified.

Required kernel additions, delivered as a separate human-reviewed amendment:

1. `permissions.py check --runtime codex`: verify the actual native Codex permission
   configuration against the runtime-neutral policy. Reject drift, unknown formats,
   missing rules and broad bypasses. Do not change policy values or grant privileges.
2. `telegram_bridge.py check`: verify owner/account mapping, authenticated transport,
   permission to forward human decisions and provenance read-back. An exit code
   alone must not substitute for the checks; implement and test them in the kernel.
3. A bridge operation accepts the kernel question reference, authenticated human
   identity, Telegram chat/message/update references, exact response and immutable
   provenance. It records via the kernel's authorized effect entry and operation
   log; closes a decision only after accepted read-back. Agent-generated text is
   never promoted to human evidence. Replays and outdated questions are rejected.
4. Session identity must persist through Codex resume, and checkpoint/spool identity
   must remain stable across worktrees. A second live session or executor is refused.
   Reconcile pending effects before mutation. A missing native session is not a
   reason to hand execution to a new agent automatically.
5. Tests must cover unchanged permissions, direct-command denials, expired charter,
   human-only risk, exact-head local evidence, forged/duplicated Telegram responses,
   session recovery and interruption during external effects.

Citadel calls the first two interfaces during diagnosis and refuses execution if
unsupported. Implementing the bridge also requires wiring decision delivery and
answer acknowledgement in the Citadel adapter; general answers currently reject
Oceans explicitly. This is an outstanding integration, not proof of compatibility.
No change to Oceans production, kernel activation, charter or Jira is performed by
this Citadel change. A real two-repository Telegram/Codex run is still required.
