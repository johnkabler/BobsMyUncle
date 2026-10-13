# BobsMyUncle (`bmu`) — Research & Plan (rev 3)

A live architecture and code quality monitor for polyglot codebases.
It is built for **LLM coding agents** and the humans who watch them.

`bmu` watches the repo and keeps a UML-style model of the code up to date. The model carries metrics: complexity, test coverage, CRAP, mutation score, coupling, dependency-rule violations, and cycles. `bmu` sends agents **short, non-blocking reports of what got worse**. A browser viewer shows humans a live diagram they can drill into.

**Decisions so far (rev 3)**

| Topic | Decision |
|---|---|
| First harnesses | **OpenCode V2 only** (no V1 support) and **Grok Build CLI** via **per-repo hook files** (`.grok/hooks/bmu.json`). A Grok plugin/marketplace can come later. |
| Agent interaction | **Report only, never block.** No Stop-gate blocking and no forced continuations. |
| Background coverage runs | **On by default**, debounced, one at a time per worktree, cancellable. |
| Python tests | pytest via **uv**. Uses pytest-cov when present, otherwise `coverage run` or an ephemeral `uv run --with pytest-cov`. Details in §3.2. |
| TypeScript tests | **Vitest 4 + `@vitest/coverage-v8`** (distribution-ui) and **Jest 30 + ts-jest** (ai-middleware). Details in §3.1. |
| Elixir tests | ExUnit + ExCoveralls (gamma, b2b). For repos without ExCoveralls (Precogs), bmu ships its own Mix archive. Details in §3.3. |
| Metric history | **Local-first; nothing is pushed to GitHub by default.** Inspired by beads/beadwork: an agent-first CLI over a local DB, findings with stable IDs, committed policy files. Sharing via a git ref is optional and comes later. See §8. |
| Language order | TypeScript → Python → Elixir. |
| Reference repos | TS: `automatiq-team/distribution-ui`, `automatiq-team/ai-middleware`. Python: `brokergenius/datateam-datamart-mcp`, `automatiq-team/buildwithai-api`, `brokergenius/datateam-mcp`. Elixir: `SeatScouts/gamma`, `SeatScouts/b2b`, `automatiq-team/Precogs`. |

---

## 1. Inspiration: Uncle Bob's `uml-viewer`

Source: https://github.com/unclebob/uml-viewer (Clojure, Quil/JVM).

**Ideas we keep**
- A topology IR plus a separate metrics overlay.
- The namespace tree is the component tree, with drill-down to source.
- Dependency rule via `:levels`.
- CRAP and mutation coloring, with missing data shown as red.
- What-if **proposals**.
- A viewer↔agent mailbox.

**What we do better**
- Real elements per file instead of one class per file. Tree-sitter-based, React- and DI-aware.
- Works with any harness, not just Grok+tmux.
- `bmu` runs the metrics itself, incrementally.
- Agents get **deltas vs. a baseline**, not full dumps.
- Staleness is tracked.
- Martin package metrics and cycle detection.
- Findings have stable IDs, so agents can acknowledge them and are not nagged again.

---

## 2. Harness integration: OpenCode + Grok Build (researched Oct 2026)

General finding: MCP resource *subscriptions* don't reach agents in any major harness, and the 2026-07-28 spec removed `resources/subscribe` anyway. Updates have to be pushed through each harness's own extension points.

### 2.1 OpenCode (V2 plugin API, `@opencode/plugin`)

OpenCode is the richest target. A plugin runs inside the server process, so it can do everything in-band, without shell hooks.

| Need | OpenCode V2 mechanism | How bmu uses it |
|---|---|---|
| Report right after an edit | `ctx.tool.hook("execute.after")` can modify `event.result` | Append a ≤3-line bmu delta to the result of edit/write/patch/bash calls. The agent sees it in the same step. Nothing blocks. |
| Live status in every model call | `ctx.session.hook("context")` pushes onto `event.system` (ephemeral, not persisted) | A small "bmu status" system block: open findings since baseline, coverage staleness. Token-capped and refreshed each call. |
| Native tools (no MCP needed) | `ctx.tool.transform` → `editor.namespace({name:"bmu"})` + `editor.add(...)` | `bmu_status`, `bmu_diagram`, `bmu_explain`, `bmu_hotspots`, `bmu_findings`, `bmu_ack`, `bmu_propose`, `bmu_run_coverage`, `bmu_inbox`. Code Mode friendly. |
| Viewer → agent messages | `ctx.session.synthetic(...)` / `ctx.session.prompt({delivery:"queue"})` | Viewer actions ("explain this hotspot", "show proposal X") are queued into the active session. |
| Session lifecycle | `ctx.event.subscribe()` (idle, session events) | Record the baseline at session start. Run heavier checks (affected-test coverage) when the session goes idle. Results arrive on the next turn. |
| Plugin state | `ctx.storage` | Per-plugin cursor, last-reported finding IDs, cooldowns. |
| Distribution | `.opencode/plugins/bmu/` (auto-loaded) or the npm package `opencode-bmu` in `plugins` | `bmu install opencode` writes either. **V2 API only** (`Plugin.define`); no V1 `server()` export. |

The plugin is thin. It talks to the `bmu` daemon (§7) over a local socket, so all analysis logic stays in one place.

### 2.2 Grok Build CLI

Grok is hook-based (Claude-compatible) and has some unique extras.

| Need | Grok mechanism | How bmu uses it |
|---|---|---|
| Report right after an edit | `PostToolUse` → `hookSpecificOutput.additionalContext` (≤10k chars, delivered with the tool result, same turn, non-blocking) | `bmu hook post-tool --harness grok`, matcher `Edit\|Write\|MultiEdit\|Bash` (aliases cover `search_replace` and `run_terminal_command`). Prints a ≤3-line delta or nothing. Always `exit 0`, because exit 2 would feed stderr to the model. |
| Session start | `SessionStart` is **passive** (stdout ignored) | Only records the baseline. Context is primed through `AGENTS.md` / skill text ("run `bmu prime` at the start of a task"). |
| Prompt submit | `UserPromptSubmit`: allowing hooks' `additionalContext` is **discarded** | Not used for context. |
| Turn end | `Stop` additionalContext/block **keeps the agent working** | **Not used for feedback** (we report, we don't block). Used passively: record the snapshot and start background coverage. Results arrive on the next PostToolUse. |
| Agent wants live events | Grok **`monitor` tool**: each stdout line becomes a notification and can wake the agent | `bmu monitor` prints one tight line per *new* finding (rate-limited, deduped by finding ID). The agent opts in with `monitor("bmu monitor", persistent)`. This is the real "watch and react" loop for Grok. |
| Human glance | **Status line** `[ui.status_line] type="command"` (stdin JSON, ≤5 lines) | `bmu statusline`: `bmu ▲2 new │ cov 84% (stale 3) │ CRAP max 41 │ 0 cycles`. |
| Pull tools | MCP servers (stdio), skills | `bmu mcp` (stdio) and a `bmu` skill with workflow guidance. |
| Distribution (now) | **Per-repo hook file** `.grok/hooks/bmu.json` + `/hooks-trust` once per repo | `bmu install grok` writes the hook file and an MCP entry, and adds `bmu prime` guidance to `AGENTS.md`. The default `--local` mode adds those paths to `.git/info/exclude`, so teammates aren't affected until you choose to commit them. Hook commands call `bmu` on `PATH` (falling back to `npx -y bobsmyuncle`). |
| Distribution (later) | Grok plugin (hooks + MCP + skill) from a git repo or marketplace | Deferred. The same hook JSON moves into a plugin unchanged. |

Example `.grok/hooks/bmu.json`:
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bmu hook session-start --harness grok", "timeout": 5 }] }],
    "PostToolUse":  [{ "matcher": "Edit|Write|MultiEdit|Bash",
                       "hooks": [{ "type": "command", "command": "bmu hook post-tool --harness grok", "timeout": 10 }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "bmu hook turn-end --harness grok", "timeout": 5 }] }]
  }
}
```
(`turn-end` never prints a decision. It only records the snapshot and queues background coverage, so the agent is never kept working.)

Gotchas:
- Grok **also loads `.claude/settings.json` and `.cursor/hooks.json` hooks**, and dedupes them by `(event, command, matcher)`. When we add Claude/Cursor later, use the *identical* command string so Grok doesn't run the hook twice.
- The input envelope is camelCase (`toolInput`, `workspaceRoot`, `stopHookActive`). `tool_response` is an alias of `toolResult`.
- The default hook timeout is 5s, except PostToolUse, which is 600s. Keep PostToolUse fast anyway: target <300 ms, and hand anything longer to the daemon.

### 2.3 Shared rules for agent-facing output

- **Only regressions or new findings**, ranked by severity, capped (default 400 tokens / 3 lines in hooks). Nothing at all when there is nothing new.
- **One line per finding with a stable ID**, for example:
  `bmu-7f3a CRAP 12→48 OrderService.applyDiscount (src/core/domains/orders/order.service.ts:88) — cc 9, cov 0%`
- **Deduped**: a finding is announced once, and again only if it gets worse. Agents can `bmu ack <id> "<reason>"`.
- **Points at the full detail** (`bmu explain bmu-7f3a`, or `.bmu/reports/latest.md`) instead of inlining it.

---

## 3. Target repos at Automatiq (researched)

Things all of them share:
- Many use **Conductor/Worktrunk worktrees** (distribution-ui, gamma, b2b), so bmu state is per worktree.
- Most already have `.claude/` + `AGENTS.md`/`CLAUDE.md`. bmu appends a short section; it never rewrites those files.
- Grok will also run any hooks in their `.claude/settings.json`. That's harmless, but keep it in mind.

### 3.1 TypeScript

#### `automatiq-team/distribution-ui` (large React SPA)
- **Toolchain:**
  - Node 24.21, pnpm 12 workspace (`.` + `packages/web-ui`), Turbo.
  - Vite 8, **TypeScript 7 (native/Go `tsgo`)** via catalog.
  - Biome + oxlint ("anti-slop").
  - `madge` is already a dev dep for circular-dependency checks; bmu covers that and more.
- **Tests:**
  - **Vitest 4**, jsdom, globals.
  - Test files are `**/spec.{ts,tsx}` and `**/*.spec.{ts,tsx}` (co-located `spec.tsx` files).
  - Coverage is `provider: 'v8'`, `reporter: ['lcovonly']`, written to `./coverage`. It reports loaded sources only.
  - **`VITEST_TEST_PLAN` env var: a JSON file listing test includes.** This is a ready-made hook for passing bmu's affected-test list.
- **Resolution:**
  - tsconfig `paths` `~/*` → repo root. Vite alias `~` → `/.`.
  - The workspace package `@automatiq/web-ui` has an `exports` map pointing to `dist/`, which bmu must map back to `packages/web-ui/src`.
  - `moduleResolution: bundler`.
- **Code shape:** mostly function components, hooks, zustand stores, xstate machines, TanStack Router/Query. There are few classes. So "UML" here means **modules, components, hooks, and stores** as stereotyped elements (§5), not classic class boxes.
- **Worktrees:** the repo uses Conductor/Worktrunk (`.conductor`, `.worktreeinclude`, per-worktree `VITE_PORT`). bmu must be **worktree-aware**: state per worktree, and a viewer port hashed from the worktree path.

#### `automatiq-team/ai-middleware` (Fastify API)
- **Toolchain:** Node 24, npm, TypeScript 6, CommonJS, ESLint + Prettier, `tsc-alias`.
- **Tests:**
  - **Jest 30 + ts-jest**, test files `**/*.test.ts`.
  - `collectCoverage: true`, `collectCoverageFrom: ./src/**/*.ts`, reporters `lcov` + `text` into `coverage/`.
  - **100% global coverage threshold.**
  - A long, commented `coveragePathIgnorePatterns` list. bmu should reuse it as "intentionally uncovered".
- **Resolution:** tsconfig `paths`: `@domains/*`, `@application/*`, `@infra/*`, `@http/*`, `@utils`, `@helpers/*`, `@tools/*`, `@configs/*`, `@test-helpers`. Jest `moduleNameMapper` mirrors them.
- **Architecture:** `src/core/{domains,application,infra,helpers}`, `src/http`, `src/configs`, plus `tools`. A natural `layers` rule: `domains` < `application` < `infra`/`http` < entry points.
- **Code shape:**
  - **tsyringe DI** (`@injectable`, `@inject(token)`, constructor injection) → DI dependency edges.
  - **TypeORM entities** (`@Entity`, `@ManyToOne`/`@OneToMany`/…) → real UML associations with multiplicity.
  - Zod schemas/DTOs.
  - Classes are common, so classic class diagrams make sense here.

### 3.2 Python

All three use **uv** (`uv.lock`) and a `src/` layout. Two are Python **3.14**, one is ≥3.13. All three use pytest with `--import-mode=importlib`.

#### `brokergenius/datateam-datamart-mcp` (FastMCP server over ClickHouse)
- `src/datateam/datamart/…`. `pythonpath = ["src"]`. Tests in `tests/unit` and `tests/integration`.
- `integration` tests need Docker (testcontainers ClickHouse). **bmu's background runs default to `-m "not integration"`.**
- **pytest-cov** + `coverage[toml]`, with `[tool.coverage.run] source=["src"]` and `exclude_also`.
- **Code shape:**
  - `dependency-injector` containers/providers → `injects` edges.
  - FastMCP `@mcp.tool`/resource functions → a `tool` stereotype.
  - pydantic models → fields.
  - Jinja templates, asyncclick CLI.

#### `automatiq-team/buildwithai-api` (Django 6.1 + django-ninja)
- `src/bwai/{domain,application,infrastructure,api}`: **clean-architecture layers.** Natural rule: `domain` < `application` < `infrastructure`/`api`.
- `coverage[toml]` with `branch = true`, `source = ["src/bwai"]`, migrations omitted. There is **no pytest-cov**, so bmu uses `coverage run --data-file=.bmu/cov/<run>/.coverage -m pytest …` then `coverage lcov`.
- pytest-django (`DJANGO_SETTINGS_MODULE = "tests.settings"`), `asyncio_mode = auto`. Tests never need the DB (`make test-local`).
- **Code shape:**
  - Django models → `entity` with `ForeignKey`/`ManyToMany` → associations.
  - Ninja routers → `controller`/`route`.
  - `dependency-injector` (`provider.py`).
  - mypy strict.

#### `brokergenius/datateam-mcp` (FastMCP proxy server)
- `src/datateam/mcp/…`. Only **pytest** in the test group (one test file today). **No coverage tool at all**, so bmu runs `uv run --with pytest-cov pytest --cov=src …` (ephemeral, with no change to `pyproject.toml`).
- Expect very red coverage. A good stress test for "useful, not noisy" reporting: report *new* gaps, and don't re-announce the existing ones.

Python runner rules:
1. Always run through `uv run` (with `--group test` when that group exists).
2. Use pytest-cov if installed, else `coverage run`, else ephemeral `--with pytest-cov`.
3. Honor `[tool.coverage.*]` (`source`, `omit`, `exclude_also`, `branch`) and `[tool.pytest.ini_options]` (`testpaths`, `python_files`, `pythonpath`, markers).
4. Select affected tests from the import graph. `pythonpath`/`src` roots tell us how to resolve imports.
5. The tree-sitter-python grammar must parse **3.14 syntax** (e.g. t-strings, deferred annotations). Verify in the Phase 0 spike.

### 3.3 Elixir

#### `SeatScouts/gamma` (umbrella)
- **Umbrella** with `apps/{shared, project_three, reconcile, seatscouts_web}`. Elixir 1.17 / OTP 26. ExCoveralls (`test_coverage: [tool: ExCoveralls]`), Credo. `seatscouts_web` also has a JS test suite (`yarn test`).
- **Umbrella apps are the top-level components.** `in_umbrella: true` deps in each app's `mix.exs` give the app-level dependency graph and a natural layering rule (`shared` lowest).
- Uses Conductor worktrees (`.env.worktree.sample`).

#### `SeatScouts/b2b` (large Phoenix app; Koushik Dasika's most active Elixir repo, ~94 commits)
- Elixir **1.20.2 / OTP 29**. `lib/{b2b, b2b_web, b2b_mcp, b2b_ops}`.
- Phoenix + LiveView, Ecto, Oban (Pro), Broadway, Tesla/Req, Mox, ExMachina.
- **ExCoveralls** (`export: "cov"`), with **`coveralls.json` `skip_files`** (reuse as "excluded"). CI produces **Cobertura per shard** (`mix coveralls.cobertura --partitions 3`, merged by octocov).
- Tooling: Credo plus custom checks (`credo/`), Recode, Tidewave, `ex_unit_json`, justfile, Worktrunk.
- **Tests often run inside Docker** (`docker compose run --rm app mix test`), so coverage paths come out as container paths (`/app/lib/...`). **bmu needs a `path_map` setting** (e.g. `/app → .`).

#### `automatiq-team/Precogs` (Phoenix LiveView + Jido AI agents; Koushik ~38 commits)
- Elixir ~> 1.20, LiveView, `live_react`, the Jido agent framework, Ecto. **No ExCoveralls.**
- Already uses **beads** (`.beads/`), so agents here are used to `prime`-style CLIs.

Other Elixir repos Koushik commits to (from Slack + GitHub): `SeatScouts/b2b-spikes`, `automatiq-team/elixir-lessons` (small). Other Elixir repos in the orgs: `SeatScouts/catalog`, `ticket-operator`, `synapse-elixir`, `ex_ticket_utils`, `automatiq-team/distro`.

**Elixir design consequences**
- Ship a tiny **`bmu` Mix archive** (`mix archive.install hex bmu_mix`) so no project dependency changes are needed. It provides:
  - `mix bmu.cover`: runs ExUnit under `:cover` and writes **LCOV** to `.bmu/cov/<run>`. Works without ExCoveralls (Precogs), and alongside it.
  - `mix bmu.graph`: a compiler-tracer dump of exact module dependencies (compile-time vs runtime, macros, `use`). This is the "precise mode" that complements tree-sitter.
- Ingest the ExCoveralls outputs that already exist (`coveralls.lcov`/`.json`/`.cobertura`) when present.
- **Affected tests:** `mix test --stale` is the native option. bmu can also pass explicit test files picked from its graph.
- Umbrella-aware: run per app (`mix cmd --app <app>` or `cd apps/<app>`).
- Ecto schemas (`schema`, `belongs_to`/`has_many`/`many_to_many`) → `entity` + associations. Phoenix controllers/LiveViews → `controller`/`live_view`. Oban workers → `worker`. Behaviours/protocols as before.
- tree-sitter-elixir must parse 1.17–1.20 syntax. Verify in Phase 0.

### Consequences for the design
1. **Don't depend on the TypeScript compiler's JS API.** TS 7 is native, and its JS API is not the stable path. Use tree-sitter for syntax and **`oxc-resolver`** for resolution (tsconfig `paths`, `exports`, workspaces, CJS/ESM).
2. **Test runner adapters:** vitest (with a `VITEST_TEST_PLAN` / `vitest related` path), jest (`--findRelatedTests`), and pytest. All three emit **LCOV**, which is our canonical coverage format.
3. **Coverage runs owned by bmu write to `.bmu/cov/<run>`** (`--coverage.reportsDirectory` / `--coverageDirectory` / `--cov-report=lcov:`). Narrow them to the changed files (`--coverage.include` / `--collectCoverageFrom`) so partial runs never overwrite the developer's `coverage/`. They also never get mistaken for "everything else dropped to 0%".
4. **Passive ingest:** also watch `coverage/lcov.info`. When the agent runs the suite itself, bmu picks it up for free. A partial run only updates files whose tests actually ran (§6).
5. **Respect existing exclusions:** read jest `coveragePathIgnorePatterns` and vitest `coverage.exclude`. Those files are shown as "excluded", not red.
6. **React- and DI-aware extraction** is a phase-1 requirement, not a nice-to-have.

---

## 4. Language & stack: TypeScript (Node ≥ 24, Bun-compatible)

Why TypeScript:
- One language from parser to pixels: tree-sitter WASM, ELK.js layout, browser UI, and MCP SDK.
- The OpenCode plugin *is* TypeScript and can share types with the daemon.
- It matches the team's toolchain (Node 24 + pnpm).

| Concern | Choice |
|---|---|
| Parsing | `web-tree-sitter` + grammars for typescript, tsx, python, elixir (pinned WASM). Our own `.scm` queries. |
| Resolution | `oxc-resolver` (TS/JS); custom resolvers for Python (src roots, relative imports) and Elixir (module→file index). |
| Watching | `@parcel/watcher` + debounce/batch; honors `.gitignore`; worktree-aware. |
| Storage | `bun:sqlite` / `better-sqlite3` locally, plus a JSONL / git-notes layer (§8). |
| Layout & render | ELK.js (layered, orthogonal, compound nodes) + our own SVG renderer, shared by the UI and PNG export (`@resvg/resvg-js`). |
| UI | Vite + React + SSE. |
| Agent surfaces | CLI, OpenCode plugin, Grok hooks/plugin, MCP stdio server. |
| Tests | Vitest + golden IR fixtures. Stryker on bmu itself. |
| Packaging | npm package `bobsmyuncle` (bin `bmu`), `bun build --compile` single binary, Homebrew tap. |

---

## 5. Domain model (language-neutral IR)

```
Workspace (worktree root)
 └─ Component  (dir / python package / TS folder / workspace package / Elixir namespace prefix) — tree
     └─ Module (file; Elixir: defmodule, many per file)
         └─ Element  stereotype: class | interface | type | enum | function-group
                                | component (React) | hook | store | machine | entity | service | controller
                                | protocol | behaviour | struct
             └─ Member  method | function | field | prop | callback | route   (visibility, arity, signature, span)
Edge  kind: import | type-only | call | inherits | implements | injects (DI) | association{multiplicity}
            | renders (JSX) | uses-hook | compile-time | uses-macro
      attrs: weight, sites[], violating?, cycleId?, confidence
```

TypeScript enrichments:
- **React:** PascalCase functions/arrow consts that return JSX → `component` with props type as fields; `useX` → `hook`; JSX usage → `renders` edges; hook calls → `uses-hook` edges.
- **State:** `create(...)` from zustand → `store`; `createMachine`/`setup().createMachine` (xstate) → `machine`.
- **tsyringe:** `@injectable()` classes → `service`; constructor params and `@inject(TOKEN)` → `injects` edges. Tokens are resolved to their implementing class where registrations are visible.
- **TypeORM:** `@Entity` → `entity`. Relation decorators → `association` with multiplicity (`1..*`) and `aggregation`/`composition` hints.
- **Fastify:** route registration → `controller`/`route` members (phase 2).

Python: classes, `Protocol`/`ABC` → interface, dataclass/pydantic fields, `TYPE_CHECKING` → type-only edges, `__all__`.

Elixir: modules, `@behaviour`/`@callback`, protocols/`defimpl`, `defstruct`, `alias`/`import`/`require`/`use` (compile-time), remote calls. Optional precise mode through a Mix tracer.

**Stable IDs**, e.g. `ts:src/core/domains/orders/order.service.ts#OrderService.applyDiscount` or `py:pkg.mod.Class.method`. Each fact carries its **content hash**, so staleness and renames (via body-hash match) can be detected.

---

## 6. Metrics & test integration

| Metric | Source / method |
|---|---|
| Cyclomatic + cognitive complexity | Computed from the tree-sitter AST with the same rules in every language. JSX conditionals (`&&`, ternaries) count. |
| Line/branch coverage | **LCOV** (vitest v8, jest, pytest-cov / `coverage lcov`, Elixir excoveralls). Cobertura/Istanbul JSON as fallbacks. Mapped to members by span. |
| CRAP | `CC² × (1 − cov)³ + CC` per member. μ/σ/max pooled up the tree. |
| Mutation | Stryker `mutation-testing-report-schema` JSON (canonical), mutmut (Python), Muex JSON (Elixir). On demand only. |
| Martin metrics | Ca, Ce, I, A, D per component. |
| Cycles | Tarjan SCC on the module and component graphs. A new cycle is always a finding. |
| Rules | `layers`, `forbidden`, `independent`, `exceptions` (cross-language, import-linter-style). |
| Hotspots | git churn × complexity. |

**Affected tests, with no extra plugins needed.** bmu already has the import graph. Changed files → reverse dependency closure → test files matched by the runner's include globs. Then:
- vitest: write the list to a JSON file → `VITEST_TEST_PLAN=<file> vitest run --coverage --coverage.reportsDirectory=.bmu/cov/<run> --coverage.include=<changed>`. Fall back to `vitest related <files> --run`.
- jest: `jest --findRelatedTests <files> --coverage --coverageDirectory=.bmu/cov/<run> --collectCoverageFrom=<changed>`. Respect `--forceExit` and the repo's `NODE_ENV=test`. ai-middleware's `test` script runs migrations, so use `test:local`-style invocation, configurable.
- pytest (via `uv run`):
  - With pytest-cov: `uv run --group test pytest <tests> -m "not integration" --cov=<src> --cov-report=lcov:.bmu/cov/<run>/lcov.info`.
  - Without pytest-cov but with coverage.py: `uv run coverage run --data-file=.bmu/cov/<run>/.coverage -m pytest <tests>`, then `coverage lcov`.
  - With neither: `uv run --with pytest-cov …`.
  - Optional `--cov-context=test` gives a precise test→code map, so later runs select tests by real coverage, not just imports. pytest-testmon is used if present.
- ExUnit:
  - `mix bmu.cover <test files>` (bmu's Mix archive, LCOV output), or the repo's ExCoveralls (`mix coveralls.lcov`).
  - `mix test --stale` as the native affected-test fallback.
  - Umbrella apps run per app.
  - Docker-wrapped commands get a `path_map`.

**When coverage runs:** background runs are **on by default** (confirmed). They are debounced after an edit burst or on session idle, with concurrency 1 per worktree. Results become findings and are delivered on the agent's next tool call. They can also be run explicitly with `bmu coverage run` or the `bmu_run_coverage` tool.

**Staleness:** coverage and mutation facts carry the content hash they were measured against. Changed spans show as *stale* (hatched in the UI, `cov? (stale)` in text), not as wrong numbers.

**Thresholds can be repo-specific.** ai-middleware enforces 100%, so there **any newly uncovered line is a finding**, reported with exact line ranges.

---

## 7. Runtime architecture

```
            ┌──────────── bmu daemon (one per worktree, auto-started, idle-exits) ────────────┐
 fs events →│ watcher → incremental parse (hash cache) → resolve → graph metrics → findings   │
 hook calls→│ coverage/mutation runners (background queue) → ingest → findings                │
            │ store (SQLite + JSONL event log)                                                │
            └──┬───────────────┬────────────────┬──────────────┬──────────────┬───────────────┘
        unix socket       HTTP+SSE         MCP stdio        CLI (`bmu …`)    status line / monitor
               │               │                │              │
     OpenCode plugin      Browser viewer   Grok / other    Grok hooks, humans, CI
```

- **The daemon is optional.** Every CLI command also works one-shot (cold scan + cache), so hooks work even if the daemon isn't running. A hook first tries the socket (fast) and falls back to in-process.
- **Worktree-aware:** state lives in `<worktree>/.bmu/`, the socket is `.bmu/bmu.sock`, and the HTTP port is hashed from the worktree path (overridable with `BMU_PORT`).
- **Performance targets:** under 200 ms for the structural delta after an edit on a 5k-file repo; a few seconds for a cold scan; PostToolUse hook latency under 300 ms.

---

## 8. Storage & history for agents (beads/beadwork-inspired, local-first)

What beads (and beadwork, which Koushik switched to) get right for agents:
- A CLI with `--json` everywhere, so agents never read raw DB files.
- **`bd prime`**: one command that prints exactly the context an agent needs.
- **Hash IDs** (`bd-a1b2`) that never collide across branches or agents.
- A **JSONL** export for git, viewers, and interchange.
- **Compaction/"memory decay"**, which summarizes old data to save context.
- `bd setup <harness>` installers.
- `bd remember` for durable facts.
- **Beadwork's lesson:** Koushik left Dolt-backed beads because syncing a DB across four machines meant paying for or self-hosting a remote. Beadwork keeps all its data on a **git orphan branch** written straight into git's object database. It never touches the working tree, and sync is just `git push`. bmu follows the same rule: **never require a server, and never commit churny data to working branches.**

How bmu applies them:

| Layer | Where | Git | Purpose |
|---|---|---|---|
| **Fact cache + time series** | `.bmu/bmu.db` (SQLite) | ignored | Per-file parse facts keyed by hash, full snapshots, metric history, fast queries. Rebuildable. |
| **Event log** | `.bmu/events.jsonl` | ignored | Append-only: snapshot created, finding opened/worsened/resolved/acked, coverage run. Replayable, tail-able (feeds `bmu monitor` and SSE). |
| **Findings** | in the DB, IDs `bmu-<4–6 hex>` (hash of rule + subject) | — | Stable handles: the same problem gets the same ID across runs and branches. Status: `open → acked(reason) → resolved`. Reopened if it gets worse. |
| **Team-shared policy & memory** | `bmu.config.yaml`, `.bmu/acks.jsonl`, `.bmu/proposals/*.yaml`, `.bmu/notes.jsonl` | **committed** | Rules, thresholds, acknowledged findings with reasons ("generated file"), proposals, durable architecture notes (`bmu remember "billing must not import pos"`). Line-oriented and sorted, so merges are clean. |
| **Per-commit summaries** | **Local only by default:** a `commit_summaries` table in `.bmu/bmu.db`, keyed by commit SHA | never pushed | Baselines like `--since git:main`. If there's no summary for `main`'s commit yet, bmu computes the structural metrics from a temporary `git worktree` of that commit (a few seconds) and caches them. Coverage for that baseline is included only if it was measured before. |
| **Shared summaries (optional, later)** | An orphan ref (beadwork-style), e.g. `refs/bmu/summaries` | opt-in `bmu sync` | Lets teammates and machines share baselines. **Off unless you turn it on.** See §8.1 for permissions. |
| **Compaction** | `bmu compact` (automatic) | — | Keep full snapshots for recent sessions and N commits, then decay to daily/per-commit summaries. |

### 8.1 What "per-commit summaries" means, and GitHub permissions

A per-commit summary is a small JSON record: "at commit `abc123`, these were the metrics and findings." Its only job is to give agents a **baseline** ("what got worse on this branch compared to `main`?") without re-analyzing `main` every time.

| Option | Where summaries live | Touches GitHub? | Permissions needed |
|---|---|---|---|
| **A. Local only (default)** | `.bmu/bmu.db` on your machine (gitignored) | **No.** Nothing is pushed. | **None.** It only reads your local git history. No risk to company policy. |
| B. Shared git ref (opt-in) | A non-branch ref like `refs/bmu/summaries`, pushed with `bmu sync` | Yes, a `git push` of an extra ref | The same push access you already use. Org rulesets or branch protection may block unusual refs, and some orgs object to extra refs. **Ask the GitHub admins before enabling.** |
| C. CI-published (not planned) | A GitHub Actions job pushes summaries for `main` | Yes, from CI | Editing workflows plus a token with `contents: write`. That usually needs repo-admin/DevOps sign-off. **We won't do this without approval.** |

**Plan: ship with A only.** B is a later, opt-in feature that is clearly labeled. C stays off the roadmap unless the company asks for it. bmu never pushes anything to a remote unless you run an explicit `bmu sync` command.

Agent-facing commands built on this:
- **`bmu prime`**: architecture brief (top components, layer rules), open findings since baseline, stale coverage, and remembered notes. ≤1.5k tokens. OpenCode injects it automatically through the context hook. Grok gets it through `AGENTS.md`/skill instructions.
- **`bmu findings [--new|--open|--since …] --json`**, **`bmu ack <id> "<reason>"`**, **`bmu explain <id|element>`**.
- **`bmu history <element> [--metric crap]`**: a short trend (`12 → 15 → 48 (this session)`).
- Every command takes `--json` (versioned schema) and `--md` (compact, default for agents), plus `--max-tokens`.
- Optional bridge: `bmu findings --to-beads` creates `bd` issues for findings the team wants tracked as work.

---

## 9. Interfaces

### CLI
```
bmu init                      # detect langs/runners/tsconfig/jest|vitest|pytest config → bmu.config.yaml
bmu install opencode|grok     # plugin / hooks / MCP / skill / AGENTS.md snippet; idempotent
bmu daemon [start|stop|status]
bmu ui                        # open viewer for this worktree
bmu prime | status | findings | ack | explain | history | hotspots
bmu diagram [--level <path>] [--format mermaid|plantuml|d2|svg|png|json] [--max-nodes 40]
bmu coverage run [--affected|--all] | bmu mutate [--files …]
bmu check                     # CI: exit non-zero on rule/threshold violations (CI only; agents just get reports)
bmu propose <name> …          # what-if grouping
bmu hook post-tool|turn-end|session-start --harness grok   # hook entry points (JSON stdin → JSON stdout, never blocks)
bmu monitor                   # tight event stream for Grok's monitor tool
bmu statusline                # Grok status line
bmu mcp                       # MCP stdio server
bmu remember "<note>" | compact | baseline [<git-ref>]   # baselines are local; `bmu sync` (opt-in, later) shares them
```

### Diagrams for agents
- **Mermaid** `classDiagram`/`flowchart` slices at one drill level, node-capped. Violations and cycles are styled *and* listed as text.
- JSON slices for exact reasoning. PNG when a multimodal look helps.

### Browser viewer for humans
- **Drill-down:** components → elements → element card (members, CC, coverage, CRAP, mutation) → source.
- **Coloring:** grade colors, red violation edges, highlighted cycles, bundled edges with hover lists, and declutter modes (from Uncle Bob).
- **Delta mode:** a since-baseline highlight and a snapshot timeline scrubber.
- **Proposals:** drag modules into virtual components, then send the proposal to the agent.
- **Right-click actions:** refresh coverage, mutate, explain-to-agent, ack, omit. These are delivered through the OpenCode plugin (`synthetic`/`prompt`) or the Grok `monitor` stream / `bmu_inbox`.

---

## 10. Configuration example (ai-middleware)

```yaml
sources:
  - { lang: typescript, root: src, tsconfig: tsconfig.json }
exclude: ["**/*.test.ts", "src/test-helpers/**", "src/core/infra/db/migrations/**"]
components: auto            # directory tree; optional named groupings below
rules:
  layers: [[core/domains], [core/application], [core/infra, http, tools], [configs, index]]
  forbidden: [{ from: core/domains, to: http }]
thresholds: { crap: 30, coverage_min: 1.0, new_uncovered_lines: 0, cc: 10, new_cycles: 0 }
coverage:
  ingest: [coverage/lcov.info]
  ignore_from: jest          # reuse coveragePathIgnorePatterns as "excluded"
runners:
  typescript: { kind: jest, affected: "npx jest --findRelatedTests {files} --coverage --coverageDirectory {out} {collectFrom}", env: { NODE_ENV: test } }
report: { hook_max_lines: 3, context_max_tokens: 400 }
```

distribution-ui would use `kind: vitest`, `test_plan_env: VITEST_TEST_PLAN`, the workspace mapping `@automatiq/web-ui → packages/web-ui/src`, and alias `~ → .`.

buildwithai-api (Python):
```yaml
sources:
  - { lang: python, root: src, packages: [bwai] }
exclude: ["**/migrations/**", "tests/**"]
rules:
  layers: [[bwai/domain], [bwai/application], [bwai/infrastructure, bwai/api], [bwai/settings, bwai/urls, bwai/asgi, bwai/__main__]]
coverage: { config_from: pyproject }        # source/omit/branch from [tool.coverage.*]
runners:
  python: { kind: pytest, via: uv, groups: [test], cov: coverage-run, markers_exclude: [] }
```
datateam-datamart-mcp sets `markers_exclude: [integration]` and `cov: pytest-cov`. datateam-mcp sets `cov: ephemeral` (`uv run --with pytest-cov`).

b2b (Elixir):
```yaml
sources:
  - { lang: elixir, root: lib }
exclude_from: coveralls.json               # skip_files → "excluded"
rules:
  layers: [[b2b], [b2b_web, b2b_mcp, b2b_ops]]
runners:
  elixir: { kind: exunit, cover: bmu-mix, wrap: "docker compose run --rm app {cmd}", path_map: { "/app": "." } }
```
gamma sets `components: umbrella` (apps become the top-level components; `in_umbrella` deps become the app graph).

---

## 11. Project layout

```
packages/
  core/            # IR, metrics math, CRAP, Martin, SCC, rules, diff, findings (pure)
  lang-typescript/ # tree-sitter queries, React/tsyringe/TypeORM enrichers, oxc-resolver glue
  lang-python/     # + dependency-injector, Django/Ninja, FastMCP, pydantic enrichers
  lang-elixir/     # + umbrella, Ecto, Phoenix/LiveView, Oban enrichers
  ingest/          # lcov, cobertura, istanbul, coverage.py, excoveralls, stryker schema, mutmut, muex
  runners/         # vitest, jest, pytest(uv), exunit: affected selection, isolated output, path_map
  store/           # sqlite, events.jsonl, commit summaries, compaction (+ opt-in orphan-ref sync later)
  engine/          # watcher, incremental pipeline, daemon, socket API
  layout/          # ELK + SVG renderer (UI + PNG)
  cli/             # bmu commands, hook adapters, installers, statusline, monitor
  mcp/             # MCP stdio server
  opencode-plugin/ # V2 Plugin.define only; thin socket client
  grok-hooks/      # .grok/hooks/bmu.json template + AGENTS.md snippet (plugin packaging later)
  server/ ui/      # HTTP+SSE, React viewer
mix_archive/       # `bmu_mix` Elixir archive: mix bmu.cover (LCOV), mix bmu.graph (compiler tracer)
fixtures/          # mini repos mirroring each reference repo's patterns (TS ×2, Python ×3, Elixir ×3)
```

Our own `layers` rule: `core` < `lang-*`, `ingest`, `layout`, `store` < `runners`, `engine` < `cli`, `mcp`, `server`, `ui`, plugins.

---

## 12. Roadmap (re-sequenced)

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Spike** (2–3 days) | Tree-sitter WASM for ts/tsx/python/elixir in Node 24 + Bun, including **Python 3.14** and **Elixir 1.20** syntax samples from the reference repos; `oxc-resolver` on **distribution-ui** (`~` alias, workspace `exports`→src) and **ai-middleware** (`@domains/*` etc.); ELK on ~2k nodes; a hello-world OpenCode V2 plugin (`execute.after` + `context`); a Grok `.grok/hooks` PostToolUse round-trip | Pass/fail recorded for each item, grammars pinned |
| **1. TS core** | IR, TS extractor with React/tsyringe/TypeORM enrichers, resolution, CC, LCOV ingest, CRAP, cycles, layer rules, `bmu scan/explain/diagram/prime` | Golden IR tests; accurate graphs on both Automatiq repos |
| **2. Live + findings + store** | Watcher, incremental cache, daemon, SQLite + events.jsonl, findings with stable IDs, ack/remember, local baselines (session, `git:<ref>` via temp worktree) | Under 200 ms delta; findings stay deduped across runs; nothing is written outside `.bmu/` |
| **3. OpenCode + Grok** | OpenCode V2 plugin (tools, `execute.after`, `context`, inbox); Grok per-repo hooks (PostToolUse, passive SessionStart/Stop) + statusline + monitor + MCP; `bmu install opencode\|grok [--local]`; AGENTS.md text | In both harnesses, an agent introducing a CRAP spike or layer violation sees it in-band within the same step and addresses it unprompted, with no blocking |
| **4. Tests** | vitest and jest runners (affected selection, isolated output, exclusion reuse), passive ingest, staleness | After editing a service in ai-middleware, newly uncovered lines are reported automatically |
| **5. Viewer** | Drill-down UI, colors, delta mode, element card, source pane, right-click → agent | Human follows the agent live; actions reach the session |
| **6. Python** | Python extractor (dependency-injector, Django/Ninja, FastMCP, pydantic), uv-based pytest runner (pytest-cov / coverage run / ephemeral), marker exclusion | Accurate graphs + coverage findings on **buildwithai-api**, **datateam-datamart-mcp**, **datateam-mcp** |
| **7. Elixir** | Elixir extractor (umbrella, Ecto, Phoenix/LiveView, Oban), `bmu_mix` archive (`bmu.cover`, `bmu.graph`), ExCoveralls ingest, docker `path_map` | Accurate graphs + coverage on **gamma** (umbrella), **b2b** (docker-wrapped tests), **Precogs** (no ExCoveralls) |
| **8. Mutation & polish** | Stryker/mutmut/Muex ingest + on-demand runs, proposals, timeline, PNG export, hotspots, compaction, packaging (npm, binary, brew), Grok plugin packaging, opt-in `bmu sync` (only if GitHub admins OK it), Claude/Cursor/Codex adapters | Dogfooded on bmu + work repos |

---

## 13. Risks & mitigations

- **TS 7 / tooling churn:** no dependency on the TS JS API; tree-sitter + oxc only.
- **Aliases, barrels, workspace `exports`→`dist`:** resolver tests built from the real repos in Phase 0. Map built paths back to source.
- **Noise:** report only new findings or ones that got worse. Hash-ID dedupe, acks, cooldowns, token caps. Never block.
- **Grok non-blocking constraints:** Stop/UserPromptSubmit/SessionStart can't carry non-blocking context. Rely on PostToolUse, `monitor`, the status line, and AGENTS.md priming.
- **Coverage run cost and DB side effects** (ai-middleware's `test` runs migrations): runner commands are configurable, with a safe default (`test:local` style). Background runs have concurrency 1 and can be cancelled. Output stays isolated in `.bmu/cov`.
- **Parallel agents/worktrees:** per-worktree daemon and state. Findings' hash IDs are stable across worktrees, so acks merge.
- **Big graphs:** one drill level at a time, node caps, collapsed components; agents get slices only.
- **Tests inside Docker (b2b):** `wrap` + `path_map` config. bmu detects container paths in LCOV/Cobertura and warns if they're unmapped.
- **Integration tests needing Docker/DBs (datamart):** excluded by marker in background runs. Explicit `bmu coverage run --all` can include them.
- **Repos with no coverage tooling (datateam-mcp, Precogs):** ephemeral `uv run --with pytest-cov` and the `bmu_mix` archive. Project files are never modified.
- **GitHub/company policy:** bmu never pushes, never edits CI, and never needs tokens. Sharing is a later, opt-in feature that waits on admin approval.
- **Per-repo Grok hooks affecting teammates:** `bmu install grok --local` keeps them out of git (via `.git/info/exclude`) until the team agrees to commit them.

## 14. Resolved (rev 3)

- OpenCode: V2 only.
- Grok: per-repo `.grok/hooks/bmu.json` now; plugin later.
- Background coverage runs: on by default.
- Per-commit summaries: local only. Sharing is an opt-in ref later, and CI publishing is not planned (§8.1).
- Reference repos: TS ×2, Python ×3, Elixir ×3 (see the decisions table).

## 15. Open questions

1. Should `bmu install grok` default to `--local` (uncommitted, just you) or committed hooks (whole team)? Proposed: `--local` until it has proven itself.
2. b2b: do agents normally run `mix test` inside Docker (`docker compose run --rm app …`) or natively? This sets the default `wrap`.
3. Is it OK to install a small `bmu_mix` Mix archive globally (`~/.mix/archives`) on dev machines? It changes no project files.
4. Where should bmu itself live: this personal repo (`BobsMyUncle`), or an `automatiq-team` repo once it's useful?
