import type { Analysis, Delta } from '../engine/analyze.js'
import type { FindingRow, Store } from '../store/db.js'
import type { Finding } from '../core/findings.js'
import { bySeverity } from '../core/findings.js'

const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${Math.round(x * 100)}%`)
const approxTokens = (s: string) => Math.ceil(s.length / 4)

/** Truncate a list of lines to a token budget, appending "+N more". */
export function budget(lines: string[], maxTokens: number, moreHint = ''): string[] {
  const out: string[] = []
  let used = 0
  for (let i = 0; i < lines.length; i++) {
    const t = approxTokens(lines[i]) + 1
    if (used + t > maxTokens && out.length) {
      out.push(`… +${lines.length - i} more${moreHint}`)
      break
    }
    out.push(lines[i])
    used += t
  }
  return out
}

export function deltaLines(delta: Delta): string[] {
  const lines: string[] = []
  const worse = [...delta.fresh, ...delta.worse].sort(bySeverity as (a: FindingRow, b: FindingRow) => number)
  for (const f of worse) {
    const tag = delta.fresh.includes(f) ? 'new' : `worse (was ${Math.max(f.baseline_value ?? 0, f.reported_value ?? 0)})`
    lines.push(`${f.id} [${tag}] ${f.message}`)
  }
  for (const f of delta.resolved) lines.push(`${f.id} [resolved] ${f.message.split(' (')[0]}`)
  return lines
}

/** Short agent-facing note for hooks; empty string when nothing is notable. */
export function hookMessage(delta: Delta, maxLines: number): string {
  const lines = deltaLines(delta)
  if (!lines.length) return ''
  const shown = lines.slice(0, maxLines)
  if (lines.length > maxLines) shown.push(`… +${lines.length - maxLines} more (run \`bmu findings --new\`)`)
  const bad = delta.fresh.length + delta.worse.length
  const head = bad ? `bmu: ${bad} code-quality regression${bad > 1 ? 's' : ''} from your recent changes (report only, not blocking):` : 'bmu: fixed since your last edit:'
  return [head, ...shown.map((l) => '  ' + l), bad ? '  Fix if in scope, or `bmu ack <id> "<reason>"` if intentional. Details: `bmu explain <id>`.' : ''].filter(Boolean).join('\n')
}

export function statusSummary(a: Analysis, store: Store): string {
  const rows = store.allFindings().filter((r) => r.status === 'open')
  const newSince = rows.filter((r) => r.baseline_value === null || r.value > r.baseline_value)
  const s = a.stats
  const parts = [
    `${s.modules} modules`,
    `${s.elements} elements`,
    `cov ${pct(s.coverage)}${s.measuredFiles ? ` of ${s.measuredFiles} measured file${s.measuredFiles > 1 ? 's' : ''}` : ''}${s.staleFiles ? ` (${s.staleFiles} stale)` : ''}`,
    `${a.cycles.length} cycles`,
    `${rows.length} open findings (${newSince.length} new since baseline)`,
  ]
  return parts.join(' │ ')
}

export function statusLine(a: Analysis, store: Store): string {
  const rows = store.allFindings().filter((r) => r.status === 'open')
  const newSince = rows.filter((r) => r.baseline_value === null || r.value > r.baseline_value).length
  const maxCrap = Math.max(0, ...rows.filter((r) => r.rule === 'crap').map((r) => r.value))
  return `bmu ${newSince ? `▲${newSince} new` : '✓'} │ cov ${pct(a.stats.coverage)}${a.stats.staleFiles ? ` (stale ${a.stats.staleFiles})` : ''} │ CRAP max ${maxCrap || '-'} │ ${a.cycles.length} cycles`
}

export function findingLine(f: Finding | FindingRow): string {
  const st = 'status' in f && f.status !== 'open' ? ` (${f.status})` : ''
  return `${f.id} ${f.severity.toUpperCase().padEnd(6)} ${f.message}${st}`
}

/** Architecture brief + current state for priming an agent at the start of a task. */
export function prime(a: Analysis, store: Store, maxTokens = 1500): string {
  const out: string[] = []
  out.push(`# bmu prime — ${a.root.split('/').pop()}`)
  out.push('')
  out.push(`bmu watches this repo's structure, complexity, coverage and dependency rules and reports regressions to you after edits (it never blocks).`)
  out.push(`Status: ${statusSummary(a, store)}`)
  const langs = Object.entries(a.stats.byLang)
    .map(([l, n]) => `${l} ${n}`)
    .join(', ')
  out.push(`Languages: ${langs}`)
  const layers = a.config.rules.layers
  if (layers?.length) out.push(`Dependency rule (inner → outer; inner must not import outer): ${layers.map((g) => g.join(' + ')).join('  ←  ')}`)
  // top components by size
  const comps = [...a.components].filter((c) => c.modules > 0).sort((x, y) => y.modules - x.modules).slice(0, 12)
  if (comps.length) {
    out.push('')
    out.push('## Largest components (modules, instability I, distance D)')
    for (const c of comps) out.push(`- ${c.component || '.'}: ${c.modules} mods, I=${c.instability.toFixed(2)}, D=${c.distance.toFixed(2)}`)
  }
  const rows = store
    .allFindings()
    .filter((r) => r.status === 'open')
    .sort(bySeverity as any)
  const newer = rows.filter((r) => r.baseline_value === null || r.value > r.baseline_value)
  if (newer.length) {
    out.push('')
    out.push('## Regressions since baseline')
    for (const r of newer.slice(0, 10)) out.push('- ' + findingLine(r))
  }
  const top = rows.filter((r) => !newer.includes(r)).slice(0, 8)
  if (top.length) {
    out.push('')
    out.push(`## Pre-existing debt (top ${top.length} of ${rows.length - newer.length}; not your fault, don't fix unless asked)`)
    for (const r of top) out.push('- ' + findingLine(r))
  }
  const notes = store.notes()
  if (notes.length) {
    out.push('')
    out.push('## Team notes')
    for (const n of notes.slice(-10)) out.push('- ' + n.text)
  }
  out.push('')
  out.push('Commands: `bmu status`, `bmu findings --new`, `bmu explain <id|file|Element>`, `bmu diagram <dir>`, `bmu ack <id> "<reason>"`, `bmu coverage run`.')
  return budget(out, maxTokens).join('\n')
}
