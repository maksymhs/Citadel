# Core API performance baseline

Run `node scripts/benchmark.js > /tmp/citadel-benchmark.json` (or `npm run benchmark`).
The script replaces all data paths before loading Citadel, uses a temporary
SQLite database and removes it on exit. It opens no network port and launches
no agents, terminals or installers. The fixture contains 20 projects, one
unregistered folder and one queued task; each route gets 40 serial requests
after warmup. Fastify injection includes client overhead in latency and CPU.

On 2026-10-25, Node 22.23.3, Linux x64, an isolated run measured:

| Route | Median | p95 | Changed rows in 40 requests |
| --- | ---: | ---: | ---: |
| `/api/projects` | 0.55 ms | 1.39 ms | 0 |
| `/api/projects/discover` | 1.96 ms | 4.81 ms | 0 |
| `/api/tasks` | 0.53 ms | 0.80 ms | 0 |
| `/api/logs/events` | 0.47 ms | 0.72 ms | 0 |

RSS was 104 MiB after warmup and 110 MiB after the workload; heap used was
17–22 MiB. Idle CPU was 5.63 ms over 1.5 seconds. These are a short core baseline,
not a measurement of the complete running service or a memory guarantee.

The same workload before throttling `sessions.last_active` changed 40 rows per
route. Updating activity at most once per minute removed these 160 redundant
writes. Session expiry checks still run on every request. The current workload covers
core routes after retiring Project hub.

Next measurements need actual usage: a full service at idle for several minutes,
1/5/10 persistent terminals, an agent running tests, repeated browser navigation,
and process cleanup after closing workspaces. Record Citadel, tmux and agent
processes separately, plus browser polling and DB/WAL growth. Compare like-for-like
runs on the same host; short latency or RAM differences can come from GC and
other host activity. No results for these scenarios or a real Mac are claimed.
