---
name: bmu
description: Use bmu (BobsMyUncle) to understand this repo's architecture and code quality — UML diagrams, complexity, coverage, CRAP, import cycles and dependency-rule (layer) violations — and to respond to bmu regression notes after edits.
---

# bmu workflow

bmu watches the repo and, after your edits, reports **only regressions your change introduced** (it never blocks):
complexity/CRAP spikes, newly uncovered lines, surviving mutants, new import cycles, and dependency-rule violations
(an inner layer importing an outer one). Existing debt is baselined at session start.

1. At the start of a task, read the bmu brief (injected at session start) or call `bmu_prime`.
2. Before restructuring code, look at the shape: `bmu_diagram` (component or class view of a directory) and
   `bmu_explain` (a file, directory, element, or finding id).
3. When a bmu note appears after an edit:
   - **fix it** if it is in scope (move the dependency behind an interface in the inner layer, split the function,
     add tests for the listed uncovered lines), or
   - **acknowledge it** with `bmu_ack` and a reason if it is intentional.
4. Don't fix pre-existing debt unless the user asks.
5. Before finishing a larger change, `bmu_diff` shows structural regressions against the main branch.

CLI equivalents: `bmu prime`, `bmu findings --new`, `bmu explain <id>`, `bmu diagram <dir>`, `bmu ack <id> "<reason>"`, `bmu diff main`.
