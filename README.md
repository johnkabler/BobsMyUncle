# BobsMyUncle (`bmu`)

A live UML + code-quality monitor **built for LLM coding agents** (OpenCode, Grok Build) and the humans watching them.
Inspired by Uncle Bob's [uml-viewer](https://github.com/unclebob/uml-viewer), rebuilt for **TypeScript, Python and Elixir**.

`bmu` keeps a UML-style model of your repo up to date as files change: modules, classes, React components/hooks,
DI services, ORM entities, Elixir behaviours/schemas/LiveViews, and the dependencies between them. It computes

- **cyclomatic complexity** per function/method (React handlers and effects measured separately),
- **test coverage** per member (LCOV / Cobertura from vitest, jest, pytest/coverage.py, ExUnit/ExCoveralls),
- **CRAP** (`cc² × (1 − cov)³ + cc`), **newly uncovered lines**,
- **import cycles**, **dependency-rule (layer) violations**, and Robert C. Martin's package metrics (I, A, D),

and tells the agent — in-band, right after an edit — **only what got worse** because of its change.
It never blocks the agent. Pre-existing debt is baselined and not nagged about.

```
bmu: 1 code-quality regression from your recent changes (report only, not blocking):
  bmu-8681e [new] dependency-rule violation: src/core/domains/users/user.entity.ts:3 → src/http/orders.controller.ts (src/core/domains (inner) must not depend on src/http (outer))
  Fix if in scope, or `bmu ack <id> "<reason>"` if intentional. Details: `bmu explain <id>`.
```

## Install

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). No native build steps: parsing uses tree-sitter WASM.

```sh
git clone https://github.com/johnkabler/BobsMyUncle && cd BobsMyUncle
pnpm install && pnpm build && npm link     # puts `bmu` on your PATH
```

## Hook it into your agent

Run inside the repo you want to watch. Installs are **local by default**: files are added to `.git/info/exclude`,
so teammates are unaffected and nothing is committed.

```sh
bmu install opencode     # .opencode/plugins/bmu/index.js (OpenCode V2 plugin)
bmu install grok         # .grok/hooks/bmu.json + .grok/rules/bmu.md, then run /hooks-trust once in grok
bmu install grok --shared   # same, but writes an AGENTS.md section and doesn't hide the files from git
```

What each harness gets:

| | OpenCode V2 | Grok Build |
|---|---|---|
| After every edit/bash | regression note appended to the tool result (`tool.hook("execute.after")`) | `PostToolUse` → `additionalContext` |
| Every model call | small live status block (`session.hook("context")`) | — |
| Session start | baseline reset | `SessionStart` hook resets the baseline |
| Tools | native `bmu.prime/status/findings/explain/diagram/ack/coverage_run` | CLI via `.grok/rules/bmu.md` instructions |
| Turn end | — | `Stop` hook only snapshots (never keeps the agent working) |
| Status bar | — | `bmu statusline` for `[ui.status_line] type="command"` |
| Live events | — | `bmu watch` works as a Grok `monitor` stream |

Both were verified end-to-end with real sessions: the agent reads `bmu prime`, sees the note after a bad edit,
and either fixes the problem or acknowledges it with `bmu ack`.

## CLI

```
bmu prime                  architecture brief + current findings (for agents at task start)
bmu status                 one-line health summary
bmu scan                   analyse (incremental, cached by content hash)
bmu findings [--new]       open findings; --new = regressions since baseline
bmu explain <id|file|dir|Element>
bmu diagram [path] [--view auto|classes|components]   Mermaid UML (class or component view)
bmu ack <id> <reason>      acknowledge (not reported again unless it gets worse)
bmu baseline               accept current findings as the baseline
bmu coverage run [--all] [files...]   run affected tests with coverage and ingest
bmu check [--new]          CI gate: exit 1 on (new) high/medium findings
bmu watch                  print regressions as files change
bmu serve [--port N]       live browser viewer (drill-down diagrams, findings, SSE updates)
bmu remember <note>        durable architecture note shown in prime
```

## Coverage

- **Passive:** whenever `coverage/lcov.info`, `cover/lcov.info`, `coverage.xml`, … change, bmu ingests them.
  Absolute CI/Docker paths (`/app/lib/x.ex`, `/home/ci/...`) are mapped back to repo files automatically.
- **Background (default on):** after an edit, bmu picks the tests most likely to exercise the changed files
  (name-matched tests, direct importers, then transitive dependents; max 25) and runs them with coverage,
  writing reports to `.bmu/cov/` so your own `coverage/` is never touched. Results arrive with the next hook.
  - vitest: `vitest run <tests> --coverage.include=<changed>` · jest: `--coverageDirectory .bmu/cov/... --coverageThreshold={}`
  - pytest via `uv run`: pytest-cov if present, else `coverage run`, else an ephemeral `uv run --with pytest-cov`.
    `integration`-marked tests are skipped in background runs.
  - ExUnit: `mix coveralls.lcov` when ExCoveralls is present, otherwise `mix test --cover --export-coverage` and a
    small `:cover` → LCOV export (no project changes).
- Coverage measured against an older version of a file is marked **stale** instead of producing bogus findings.

## Configuration (optional)

`bmu.config.yaml` (or local-only `.bmu/config.yaml`) in the repo root:

```yaml
exclude: ["example/**"]
rules:
  layers:                 # inner (most stable) first; inner must not depend on outer
    - [src/core/domains]
    - [src/core/application]
    - [src/core/infra, src/http]
  forbidden:
    - { from: src/billing, to: src/pos, reason: "billing is independent of POS" }
thresholds: { crap: 30, cc: 15, uncovered: true }
coverage:
  background: true
  debounce_seconds: 20
runners:
  elixir: { wrap: "docker compose exec app {cmd}" }   # e.g. SeatScouts/b2b runs tests in Docker
  python: { exclude_markers: [integration, slow] }
report: { hook_max_lines: 3, context_max_tokens: 400 }
```

## How findings work

Every finding has a stable id (`bmu-` + hash of rule and subject), so the same problem keeps the same id across runs,
branches and worktrees. State lives in `.bmu/bmu.db` (SQLite, local, gitignored) plus an append-only `.bmu/events.jsonl`.

- The first scan (and every session start) sets the **baseline**: existing findings are not reported.
- A finding is reported once when it is **new**, again only if it gets **worse**, and once when it's **resolved**.
- Code-level findings (CRAP, complexity, uncovered lines) are only reported for files changed since the baseline.
- `bmu ack <id> "<reason>"` silences a finding unless it gets worse.

Nothing is ever pushed to GitHub; there are no tokens and no CI changes.

## Development

```sh
pnpm test          # vitest: extractors + end-to-end pipeline on TS/Python/Elixir fixtures
pnpm build         # tsc → dist/
bmu scan           # bmu analyses itself (see bmu.config.yaml)
```

Layout: `src/core` (pure IR, graph metrics, findings) ← `src/lang` (tree-sitter extractors, resolvers), `src/ingest`,
`src/store` ← `src/engine`, `src/runners`, `src/report` ← `src/cli`, `src/server`. See [docs/PLAN.md](docs/PLAN.md).
