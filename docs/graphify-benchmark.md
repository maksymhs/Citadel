# Graphify benchmark

Question: does the optional Graphify code graph (`npm run graph`) reduce the tokens an agent spends on Citadel tasks **without** making answers worse? Reported savings come from the tool's own materials and secondary write-ups; nobody has measured it on this repo. Until this table is filled in, treat the graph as an experiment and do not rely on it in `AGENTS.md` beyond the optional note.

## Setup (once)

```bash
uv tool install graphifyy      # or: pipx install graphifyy   (Python 3.10+)
npm run graph -- --require     # builds graphify-out/ ; fails if Graphify is missing
```

Check that `graphify-out/GRAPH_REPORT.md` is not empty and `graph.json` exists (a blank report has been reported by other users). Run the tasks on a clean checkout of the same commit, same model, same effort level.

## Arms

| Arm | State |
| --- | --- |
| **A. Docs only** | `graphify-out/` deleted. The agent uses `AGENTS.md`, `docs/features.md` and `docs/code-map.md`. |
| **B. Docs + graph** | `graphify-out/` freshly built (`npm run graph -- --full`), unchanged otherwise. |

Start every run in a **new session** so nothing is cached in the conversation. Do not install Graphify's own Claude Code hook for arm B: `AGENTS.md` already tells the agent to read the report, and the hook has been reported to break across Claude Code versions.

## Tasks

Use the exact wording. Each has a known right answer so correctness can be judged.

| # | Prompt | Right answer includes |
| --- | --- | --- |
| T1 | "How many failed checks make a paired machine show as offline, and where is that decided?" | `OFFLINE_AFTER_FAILURES = 2` in `server/services/monitorService.js` |
| T2 | "What happens, step by step, when a paired machine's Cloudflare tunnel URL changes?" | candidate address list per peer, re-announce at boot and every 5 min, rows healing from peer responses (`hostService.js`) |
| T3 | "Make the number of failed checks before offline configurable with an environment variable, with a test." | change in `monitorService.js` and `server/config.js`, `.env.example` entry, test in `tests/monitor.test.js`, tests pass |
| T4 | "After a restart some terminal sessions show as closed although tmux is still running them. Where would you look and why?" | `terminalManager.reconcileStaleSessions` and its startup call in `server/index.js` |
| T5 | "Where is the machine selector rendered in the UI and which API does it call to learn each machine's status?" | `public/js/app.js` machine selector, `/api/hosts/status` |

## Record

For each run write the tokens Claude Code reports at the end (`/cost`: input, output, cache read/write) and the number of tool calls. Judge correctness as **right / partly / wrong** against the right answer (for T3: do the tests pass and is the diff minimal). Run each task **twice per arm** and use the median.

| Task | Arm | Input tok | Output tok | Cache read | Tool calls | Correct |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | A | | | | | |
| T1 | B | | | | | |
| T2 | A | | | | | |
| T2 | B | | | | | |
| T3 | A | | | | | |
| T3 | B | | | | | |
| T4 | A | | | | | |
| T4 | B | | | | | |
| T5 | A | | | | | |
| T5 | B | | | | | |

Also note: time to build the graph, size of `graphify-out/`, and whether `GRAPH_REPORT.md` pointed the agent anywhere wrong.

## Decision rule

- **Keep** if the median total-token reduction of B over A is at least **30 %**, correctness is not worse in any task, and the graph builds in under a minute on a normal laptop. Then document the install in the README's Development section and consider committing `GRAPH_REPORT.md` at release time.
- **Drop** otherwise: delete `scripts/graph.js`, `tests/graph.test.js`, the `graph` npm script, the `.gitignore` entry and the Graphify paragraph in `AGENTS.md`, and record the result in the ledger.
- If B is only better on structural questions (T2, T4), keep it as a documented optional tool without a threshold claim.

## Results

Not run yet. Fill the table above, then write the decision here with the date and the Citadel version.
