# Status (autonomous build session, Oct 12–13 2026)

## What works today

| Area | State | Verified on |
|---|---|---|
| TS/JS extraction (tree-sitter WASM): classes, interfaces, enums, types, React components/hooks (handlers + effects as separate members), zustand stores, xstate machines, tsyringe DI (`injects`), TypeORM entities + associations | ✅ | fixtures, distribution-ui (7.2k files, 6.9s cold), ai-middleware |
| TS resolution: tsconfig `paths`, workspace packages (`exports` → `src`), barrels, `import type`, dynamic `import()`, recovery of imports inside parser ERROR regions | ✅ | distribution-ui 100% local imports resolved, ai-middleware 100% |
| Python extraction: classes, Protocol/ABC, Django models + FK associations, pydantic/dataclass fields, dependency-injector containers, FastMCP tools, FastAPI/ninja routes, TYPE_CHECKING imports, 3.14 syntax | ✅ | buildwithai-api, datateam-datamart-mcp, datateam-mcp |
| Elixir extraction: modules (nested), behaviours/@callback, protocols/defimpl, Ecto schemas + associations, LiveView/controller/Oban/GenServer kinds, multi-clause functions with guards, alias expansion, compile-time vs runtime deps, 1.17–1.20 syntax | ✅ | gamma (umbrella), b2b, Precogs |
| Metrics: cyclomatic complexity, coverage per member, CRAP, uncovered lines, mutation (Stryker schema), cycles (Tarjan; Elixir only compile-time), dependency-rule layers + forbidden, Martin I/A/D, hotspots (churn × cc) | ✅ | |
| Coverage ingest: LCOV + Cobertura, CI/Docker absolute paths mapped by suffix, member-level staleness (per-line hashes) | ✅ | |
| Background affected-test coverage: vitest, jest, pytest (uv; pytest-cov / coverage run / ephemeral), ExUnit (ExCoveralls or built-in `:cover` → LCOV), Docker wrap | ✅ vitest (bmu itself), jest (ai-middleware, 25 tests in 6s), pytest (buildwithai-api, datamart), ExUnit (local mix project) | b2b Docker path not run (needs its dev env) |
| Findings: stable ids, baseline per session, new/worse/resolved, only code-level findings in touched files, acks, re-baseline on extractor/policy change, cycle ids stable as SCCs grow | ✅ | |
| Grok Build: per-repo `.grok/hooks/bmu.json` (PostToolUse additionalContext; passive SessionStart/Stop), `.grok/rules/bmu.md`, MCP server in `.grok/config.toml`, statusline, `bmu watch` for monitor | ✅ real headless Grok sessions: agent ran `bmu prime`, saw the note, acked/fixed | |
| OpenCode V2: plugin with `tool.hook("execute.after")` note, `session.hook("context")` status, native `bmu.*` tools, per-session baselines via event stream | ✅ real `opencode run` sessions | |
| CLI: prime, status, scan, findings, explain, diagram (Mermaid class/component), ack, baseline, diff vs git ref (temp worktree, cached locally), coverage run, mutate, check, init (layer inference), doctor, hotspots, watch, serve (viewer), mcp | ✅ 43 vitest tests, CI green | |
| MCP server (`bmu mcp`), registered for Grok in `.grok/config.toml` | ✅ real Grok session called `bmu_status` via MCP | |
| Proposals (what-if groupings), mutation ingest (Stryker schema) + `bmu mutate`, hotspots | ✅ | |
| Passive coverage: `coverage/lcov.info`, `cover/lcov.info`, Cobertura, coverage.py `.coverage` (auto-converted) | ✅ datamart: 99% of 38 files after a plain `pytest --cov` | |
| Background runs that can't execute tests (missing env/DB) are detected; coverage is not ingested and the agent is told once | ✅ found in a real Grok session on buildwithai-api (doppler env) | |
| Browser viewer (`bmu serve`): drill-down Mermaid diagrams, findings panel, details, SSE live updates | ✅ screenshot-verified with headless Chrome | |

## Observed agent behaviour (real sessions)
- Grok on the TS fixture: ran `bmu prime` unprompted (from `.grok/rules/bmu.md`), got the dependency-rule note after its edit and acked it as intentional.
- OpenCode on the TS fixture: read the dependency rule from the injected context and avoided the violation entirely; when forced, the note was appended to the edit result.
- Grok on buildwithai-api: after adding `clamp()`, bmu reported newly uncovered lines and the agent went on to write tests for them (it then hit a doppler-env problem in background runs, which led to the error-surfacing fix above).

## Findings about the reference repos
- **SeatScouts/b2b runs tests in Docker** (`just test` → `docker compose exec app mix test`). `bmu init` detects this and sets
  `runners.elixir.wrap: "docker compose exec -T {env} app {cmd}"`. Precogs uses the same pattern (via `rtk docker compose`).
- `bmu init` infers layers: ai-middleware `src/core/domains → application → infra → src/http`; buildwithai-api and datamart
  `domain → application → infrastructure → api/server`; gamma umbrella `shared → project_three + reconcile → seatscouts_web`;
  Phoenix apps `lib/<app> → lib/<app>_web (+ _mcp, _ops)`. distribution-ui has no conventional layer dirs (configure by hand).
- With those inferred rules, ai-middleware has ~55 pre-existing `application → infra` imports (strict Clean Architecture);
  they are baselined, not reported as regressions.

## Deviations from the plan (and why)
- **One npm package** with layered `src/` dirs instead of a pnpm monorepo — simpler to install and iterate; bmu checks its own layering (`bmu.config.yaml`).
- **`node:sqlite`** instead of better-sqlite3, **`fs.watch`** instead of @parcel/watcher — zero native builds (Node ≥ 22.5).
- **Mermaid** (bundled locally) instead of a custom ELK renderer for the viewer — agents and humans share one diagram format.
- No long-running daemon yet: hooks run incrementally (content-hash cache) with a fast path (≈0.2s when nothing changed, ≈0.7s on a 7k-file repo after an edit).

## Local setup done on this machine
- `npm link` → `bmu` is on PATH (`~/.nvm/versions/node/v22.15.0/bin/bmu`).
- Reference repos cloned (shallow) to `~/projects/bmu-ref/` with `.bmu/` state; e2e sandboxes `~/projects/bmu-ref/e2e-ts` (Grok, added to `~/.grok/trusted_folders.toml`) and `e2e-oc` (OpenCode).
- Nothing was installed into the real work repos and nothing was pushed anywhere except this personal repo.

## Next ideas
- Proposals (Uncle Bob's what-if groupings) in config + viewer.
- Mutation runners for mutmut/Muex once their JSON formats are confirmed (ingest already accepts a generic `{mutants:[…]}` list).
- Optional daemon to keep the model in memory for sub-100ms hooks on very large repos.
- Viewer: C/M grade dots, edge hover lists, timeline of snapshots.
