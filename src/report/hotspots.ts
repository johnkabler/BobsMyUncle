import { execFileSync } from 'node:child_process'
import type { Analysis } from '../engine/analyze.js'

/** Churn (commits touching a file in the window) × complexity: where change risk concentrates. */
export function hotspots(a: Analysis, opts: { since?: string; top?: number } = {}): string {
  const churn = new Map<string, number>()
  try {
    const log = execFileSync('git', ['log', `--since=${opts.since ?? '6 months ago'}`, '--name-only', '--pretty=format:'], { cwd: a.root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    for (const l of log.split('\n')) if (l.trim()) churn.set(l.trim(), (churn.get(l.trim()) ?? 0) + 1)
  } catch {
    return 'bmu hotspots needs git history'
  }
  const rows: { file: string; churn: number; cc: number; worst: string; cov?: number; score: number }[] = []
  for (const m of a.model.modules.values()) {
    if (m.isTest) continue
    const c = churn.get(m.id) ?? 0
    if (!c) continue
    let total = 0
    let worst = { cc: 0, name: '' }
    let cov = 0
    let inst = 0
    for (const el of m.elements)
      for (const mm of el.members) {
        const cc = mm.metrics.cc ?? 0
        total += cc
        if (cc > worst.cc) worst = { cc, name: el.kind === 'module' ? mm.name : `${el.name}.${mm.name}` }
        cov += mm.metrics.coveredLines ?? 0
        inst += mm.metrics.instrumentedLines ?? 0
      }
    rows.push({ file: m.id, churn: c, cc: total, worst: worst.name ? `${worst.name} (cc ${worst.cc})` : '-', cov: inst ? cov / inst : undefined, score: c * total })
  }
  rows.sort((x, y) => y.score - x.score)
  const top = rows.slice(0, opts.top ?? 15)
  if (!top.length) return 'no hotspots (no churn in the window)'
  return [
    `hotspots (commits since ${opts.since ?? '6 months ago'} × total complexity):`,
    ...top.map((r, i) => `${String(i + 1).padStart(2)}. ${r.file}  churn ${r.churn}, cc ${r.cc}, cov ${r.cov === undefined ? 'n/a' : Math.round(r.cov * 100) + '%'} — worst ${r.worst}`),
  ].join('\n')
}
