import { createHash } from 'node:crypto'
import type { Model, Edge } from './model.js'
import type { BmuConfig } from './config.js'
import { findCycles, cyclePath, ruleViolations, projectEdges } from './graph.js'

export type Rule = 'crap' | 'complexity' | 'uncovered' | 'cycle' | 'layer' | 'forbidden' | 'file-coverage'
export type Severity = 'high' | 'medium' | 'low'

export interface Finding {
  id: string
  rule: Rule
  subject: string
  file: string
  line?: number
  /** higher = worse */
  value: number
  severity: Severity
  message: string
}

export const findingId = (rule: string, subject: string) => 'bmu-' + createHash('sha1').update(rule + '\0' + subject).digest('hex').slice(0, 5)

const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${Math.round(x * 100)}%`)

function lineRanges(lines: number[]): string {
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    let j = i
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`)
    i = j + 1
  }
  return out.join(',')
}

export function memberLabel(elementName: string, memberName: string, elementKind: string) {
  if (elementKind === 'module') return memberName
  if ((elementKind === 'component' || elementKind === 'hook' || elementKind === 'store' || elementKind === 'machine') && (memberName === 'render' || memberName === elementName)) return elementName
  return `${elementName}.${memberName}`
}

export function computeFindings(model: Model, config: BmuConfig): { findings: Finding[]; edges: Edge[]; cycles: string[][] } {
  const out: Finding[] = []
  const t = config.thresholds
  for (const el of model.elements.values()) {
    const mod = model.modules.get(el.module)
    if (!mod || mod.isTest) continue
    for (const m of el.members) {
      const label = memberLabel(el.name, m.name, el.kind)
      const where = `${el.module}:${m.start}`
      const mm = m.metrics
      if (mm.crap !== undefined && !mm.stale && mm.crap > t.crap) {
        const subject = m.id
        out.push({
          id: findingId('crap', subject),
          rule: 'crap',
          subject,
          file: el.module,
          line: m.start,
          value: Math.round(mm.crap),
          severity: mm.crap > t.crap * 2 ? 'high' : 'medium',
          message: `CRAP ${Math.round(mm.crap)} ${label} (${where}) cc ${mm.cc}, cov ${pct(mm.coverage)}`,
        })
      } else if (mm.cc !== undefined && mm.cc > t.cc && (mm.crap === undefined || mm.stale)) {
        out.push({
          id: findingId('complexity', m.id),
          rule: 'complexity',
          subject: m.id,
          file: el.module,
          line: m.start,
          value: mm.cc,
          severity: mm.cc > t.cc * 2 ? 'medium' : 'low',
          message: `complexity ${mm.cc} ${label} (${where}) — no fresh coverage`,
        })
      }
      if (t.uncovered && mm.uncovered && mm.uncovered.length && !mm.stale) {
        out.push({
          id: findingId('uncovered', m.id),
          rule: 'uncovered',
          subject: m.id,
          file: el.module,
          line: mm.uncovered[0],
          value: mm.uncovered.length,
          severity: 'medium',
          message: `${mm.uncovered.length} uncovered line${mm.uncovered.length > 1 ? 's' : ''} in ${label} (${el.module}:${lineRanges(mm.uncovered)})`,
        })
      }
    }
  }

  const edges = projectEdges(model, config.rules.includeTypeOnly)
  const nodes = [...model.modules.values()].filter((m) => !m.isTest).map((m) => m.id)
  // Elixir: runtime calls between modules are normal; only compile-time cycles (use/import/require) hurt.
  const cycleEdges = edges.filter((e) => !(model.modules.get(e.from)?.lang === 'elixir' && e.kind !== 'compile-time'))
  const cycles = findCycles(nodes, cycleEdges)
  for (const comp of cycles) {
    const subject = comp.join('|')
    const p = cyclePath(comp, cycleEdges)
    out.push({
      id: findingId('cycle', subject),
      rule: 'cycle',
      subject,
      file: comp[0],
      value: comp.length,
      severity: 'high',
      message: `import cycle (${comp.length} modules): ${p.length <= 8 ? p.join(' → ') : [...p.slice(0, 6), '…', p[p.length - 1]].join(' → ')}`,
    })
  }

  // one finding per violating module pair
  const seen = new Set<string>()
  for (const v of ruleViolations(edges, config.rules)) {
    const subject = `${v.from}->${v.to}`
    const key = v.rule + subject
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: findingId(v.rule, subject),
      rule: v.rule,
      subject,
      file: v.from,
      line: v.line,
      value: 1,
      severity: 'high',
      message: `${v.rule === 'layer' ? 'dependency-rule violation' : 'forbidden dependency'}: ${v.from}${v.line ? ':' + v.line : ''} → ${v.to} (${v.reason})`,
    })
  }

  if (t.fileCoverageMin !== undefined) {
    for (const mod of model.modules.values()) {
      if (mod.isTest) continue
      let inst = 0
      let cov = 0
      let stale = false
      for (const el of mod.elements) for (const m of el.members) {
        inst += m.metrics.instrumentedLines ?? 0
        cov += m.metrics.coveredLines ?? 0
        stale ||= !!m.metrics.stale
      }
      if (!inst || stale) continue
      const ratio = cov / inst
      if (ratio < t.fileCoverageMin) {
        out.push({
          id: findingId('file-coverage', mod.id),
          rule: 'file-coverage',
          subject: mod.id,
          file: mod.id,
          value: Math.round((1 - ratio) * 100),
          severity: 'low',
          message: `file coverage ${pct(ratio)} < ${pct(t.fileCoverageMin)} in ${mod.id}`,
        })
      }
    }
  }
  return { findings: out, edges, cycles }
}

const SEV = { high: 0, medium: 1, low: 2 }
export const bySeverity = (a: Finding, b: Finding) => SEV[a.severity] - SEV[b.severity] || b.value - a.value

/**
 * Keep cycle finding ids stable as strongly-connected components grow or shrink: a new SCC that
 * mostly overlaps a previously known cycle inherits its id (so growth reads as "worse", not
 * "resolved + new").
 */
export function stabilizeCycleIds(findings: Finding[], previous: { id: string; subject: string }[]): Finding[] {
  const prev = previous.map((p) => ({ id: p.id, members: new Set(p.subject.split('|')) }))
  const used = new Set<string>()
  for (const f of findings) {
    if (f.rule !== 'cycle') continue
    const members = f.subject.split('|')
    if (prev.some((p) => p.id === f.id)) {
      used.add(f.id)
      continue
    }
    let best: { id: string; members: Set<string> } | null = null
    let bestScore = 0
    for (const p of prev) {
      if (used.has(p.id)) continue
      const overlap = members.filter((m) => p.members.has(m)).length
      const score = overlap / Math.min(members.length, p.members.size)
      if (score > bestScore) {
        best = p
        bestScore = score
      }
    }
    if (best && bestScore >= 0.5) {
      used.add(best.id)
      const added = members.filter((m) => !best!.members.has(m))
      f.id = best.id
      if (added.length && added.length <= 3) f.message += ` (new in cycle: ${added.join(', ')})`
    }
  }
  return findings
}
