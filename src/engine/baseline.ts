import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BmuConfig } from '../core/config.js'
import { findingId, memberLabel, type Finding } from '../core/findings.js'
import { Store } from '../store/db.js'
import { analyze, type Analysis } from './analyze.js'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

/** Coverage-independent findings, comparable across commits: cycles, rule violations, complexity hotspots. */
export function structuralFindings(a: Analysis): Finding[] {
  const out = a.findings.filter((f) => f.rule === 'cycle' || f.rule === 'layer' || f.rule === 'forbidden')
  for (const el of a.model.elements.values()) {
    if (a.model.modules.get(el.module)?.isTest) continue
    for (const m of el.members) {
      const cc = m.metrics.cc
      if (cc === undefined || cc <= a.config.thresholds.cc) continue
      out.push({
        id: findingId('complexity', m.id),
        rule: 'complexity',
        subject: m.id,
        file: el.module,
        line: m.start,
        value: cc,
        severity: cc > a.config.thresholds.cc * 2 ? 'medium' : 'low',
        message: `complexity ${cc} ${memberLabel(el.name, m.name, el.kind)} (${el.module}:${m.start})`,
      })
    }
  }
  return out
}

/** Resolve the default comparison base: merge-base with origin/main, main, origin/master or master. */
export function defaultBase(root: string): string {
  for (const ref of ['origin/main', 'main', 'origin/master', 'master', 'origin/develop', 'develop']) {
    try {
      return git(root, ['merge-base', 'HEAD', ref])
    } catch {
      /* try next */
    }
  }
  return git(root, ['rev-parse', 'HEAD'])
}

/** Structural findings at a commit, computed in a temporary detached worktree and cached locally by sha. */
export async function findingsAt(root: string, store: Store, config: BmuConfig, ref: string, log: (s: string) => void = () => {}): Promise<{ sha: string; findings: Finding[] }> {
  const sha = git(root, ['rev-parse', ref])
  const cached = store.getCommitSummary(sha)
  if (cached?.findings) return { sha, findings: cached.findings }
  const dir = mkdtempSync(path.join(tmpdir(), `bmu-base-${sha.slice(0, 8)}-`))
  log(`bmu: analysing ${ref} (${sha.slice(0, 8)}) in a temporary worktree…`)
  try {
    git(root, ['worktree', 'add', '--detach', '--force', dir, sha])
    const tmpStore = new Store(dir)
    try {
      const a = await analyze(dir, tmpStore, config)
      const findings = structuralFindings(a)
      store.putCommitSummary(sha, { findings, stats: a.stats })
      return { sha, findings }
    } finally {
      tmpStore.close()
    }
  } finally {
    try {
      git(root, ['worktree', 'remove', '--force', dir])
    } catch {
      rmSync(dir, { recursive: true, force: true })
      try {
        git(root, ['worktree', 'prune'])
      } catch {
        /* ignore */
      }
    }
  }
}

export interface RefDiff {
  base: string
  added: Finding[]
  worse: { f: Finding; was: number }[]
  fixed: Finding[]
}

export function diffFindings(base: Finding[], current: Finding[], baseSha: string): RefDiff {
  const b = new Map(base.map((f) => [f.id, f]))
  const c = new Map(current.map((f) => [f.id, f]))
  const added: Finding[] = []
  const worse: { f: Finding; was: number }[] = []
  for (const f of current) {
    const old = b.get(f.id)
    if (!old) added.push(f)
    else if (f.value > old.value) worse.push({ f, was: old.value })
  }
  const fixed = base.filter((f) => !c.has(f.id))
  return { base: baseSha, added, worse, fixed }
}
