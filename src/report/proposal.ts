import type { Analysis } from '../engine/analyze.js'
import { projectEdges, findCycles } from '../core/graph.js'

export interface Proposal {
  name: string
  /** components INNER (most stable) first; each groups existing path prefixes */
  components: { name: string; paths: string[] }[]
}

const safe = (s: string) => 'p_' + s.replace(/[^A-Za-z0-9_]/g, '_')
const matches = (file: string, p: string) => {
  const x = p.replace(/\/+$/, '')
  return file === x || file.startsWith(x + '/')
}

function assign(p: Proposal, file: string): number {
  let best = -1
  let len = -1
  p.components.forEach((c, i) => {
    for (const path of c.paths) if (matches(file, path) && path.length > len) {
      best = i
      len = path.length
    }
  })
  return best
}

/** Evaluate a what-if grouping of existing code without changing it: coupling, rule violations, cycles. */
export function evaluateProposal(a: Analysis, p: Proposal) {
  const edges = projectEdges(a.model, a.config.rules.includeTypeOnly)
  const n = p.components.length
  const unassigned = new Set<string>()
  const counts = new Map<string, number>()
  const violations: { from: string; to: string; n: number; examples: string[] }[] = []
  const vmap = new Map<string, { n: number; examples: string[] }>()
  const modsPer = new Array(n).fill(0)
  for (const m of a.model.modules.values()) {
    if (m.isTest) continue
    const i = assign(p, m.id)
    if (i < 0) unassigned.add(m.id)
    else modsPer[i]++
  }
  for (const e of edges) {
    const i = assign(p, e.from)
    const j = assign(p, e.to)
    if (i < 0 || j < 0 || i === j) continue
    const k = `${i}|${j}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
    if (i < j) {
      const v = vmap.get(k) ?? { n: 0, examples: [] }
      v.n++
      if (v.examples.length < 3) v.examples.push(`${e.from} → ${e.to}`)
      vmap.set(k, v)
    }
  }
  for (const [k, v] of vmap) {
    const [i, j] = k.split('|').map(Number)
    violations.push({ from: p.components[i].name, to: p.components[j].name, ...v })
  }
  const compEdges = [...counts.keys()].map((k) => {
    const [i, j] = k.split('|')
    return { from: i, to: j, kind: 'import' as const }
  })
  const cycles = findCycles(p.components.map((_, i) => String(i)), compEdges).map((c) => c.map((i) => p.components[Number(i)].name))
  return { counts, violations, cycles, unassigned: [...unassigned], modsPer }
}

export function proposalDiagram(a: Analysis, p: Proposal): string {
  const ev = evaluateProposal(a, p)
  const lines = ['flowchart TB', `  %% PROPOSAL "${p.name}" — not instantiated in code; inner (stable) components first`]
  p.components.forEach((c, i) => lines.push(`  ${safe(c.name)}[["${c.name}<br/><small>${ev.modsPer[i]} mods · level ${i}</small>"]]`))
  if (ev.unassigned.length) lines.push(`  unassigned["Unassigned<br/><small>${ev.unassigned.length} mods</small>"]`)
  let idx = 0
  const red: number[] = []
  for (const [k, n] of ev.counts) {
    const [i, j] = k.split('|').map(Number)
    lines.push(`  ${safe(p.components[i].name)} -->|${n}| ${safe(p.components[j].name)}`)
    if (i < j) red.push(idx)
    idx++
  }
  if (red.length) lines.push(`  linkStyle ${red.join(',')} stroke:#d33,stroke-width:3px`)
  return lines.join('\n')
}

export function proposalReport(a: Analysis, p: Proposal): string {
  const ev = evaluateProposal(a, p)
  const out = [`proposal "${p.name}": ${p.components.map((c, i) => `${c.name}(${ev.modsPer[i]})`).join(' ← ')}`]
  out.push(`dependency-rule violations under this grouping: ${ev.violations.reduce((s, v) => s + v.n, 0)}`)
  for (const v of ev.violations) out.push(`  ${v.from} → ${v.to} ×${v.n}  e.g. ${v.examples.join('; ')}`)
  out.push(`component cycles: ${ev.cycles.length ? ev.cycles.map((c) => c.join(' ↔ ')).join(' | ') : 'none'}`)
  if (ev.unassigned.length) out.push(`unassigned modules: ${ev.unassigned.length} (e.g. ${ev.unassigned.slice(0, 5).join(', ')})`)
  return out.join('\n')
}
