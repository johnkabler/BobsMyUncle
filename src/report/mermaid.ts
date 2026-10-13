import type { Analysis } from '../engine/analyze.js'
import { ruleViolations } from '../core/graph.js'
import { projectEdges } from '../core/graph.js'

const safeId = (s: string) => 'n_' + s.replace(/[^A-Za-z0-9_]/g, '_')
const esc = (s: string) => s.replace(/"/g, "'")
const pct = (x: number | undefined) => (x === undefined ? '' : ` ${Math.round(x * 100)}%`)

function under(path: string, level: string) {
  return level === '' || path === level || path.startsWith(level + '/')
}

/** The child of `level` that contains `path` (a sub-directory or a file directly in level). */
function childOf(path: string, level: string): string | null {
  if (!under(path, level) || path === level) return null
  const rest = level ? path.slice(level.length + 1) : path
  const seg = rest.split('/')[0]
  return level ? `${level}/${seg}` : seg
}

export interface DiagramOpts {
  level?: string
  view?: 'components' | 'classes' | 'auto'
  maxNodes?: number
}

export function diagram(a: Analysis, opts: DiagramOpts = {}): string {
  const level = (opts.level ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '')
  const view = opts.view && opts.view !== 'auto' ? opts.view : autoView(a, level)
  return view === 'classes' ? classDiagram(a, level, opts.maxNodes ?? 40) : componentDiagram(a, level, opts.maxNodes ?? 40)
}

function autoView(a: Analysis, level: string): 'components' | 'classes' {
  const direct = [...a.model.modules.values()].filter((m) => !m.isTest && m.component === level)
  const children = new Set([...a.model.modules.values()].filter((m) => !m.isTest).map((m) => childOf(m.id, level)).filter(Boolean))
  if (level.match(/\.(ts|tsx|py|ex|exs|js|jsx)$/)) return 'classes'
  return direct.length > 0 && children.size <= direct.length + 2 ? 'classes' : 'components'
}

function componentDiagram(a: Analysis, level: string, maxNodes: number): string {
  const mods = [...a.model.modules.values()].filter((m) => !m.isTest && under(m.id, level))
  const children = new Map<string, { modules: number; worstCrap: number; cov: [number, number] }>()
  for (const m of mods) {
    const c = childOf(m.id, level)!
    const info = children.get(c) ?? { modules: 0, worstCrap: 0, cov: [0, 0] }
    info.modules++
    for (const el of m.elements)
      for (const mm of el.members) {
        if (mm.metrics.crap) info.worstCrap = Math.max(info.worstCrap, mm.metrics.crap)
        info.cov[0] += mm.metrics.coveredLines ?? 0
        info.cov[1] += mm.metrics.instrumentedLines ?? 0
      }
    children.set(c, info)
  }
  const ranked = [...children.entries()].sort((x, y) => y[1].modules - x[1].modules)
  const shown = new Set(ranked.slice(0, maxNodes).map(([k]) => k))
  const edges = projectEdges(a.model, a.config.rules.includeTypeOnly)
  const violations = new Set(ruleViolations(edges, a.config.rules).map((v) => `${v.from}->${v.to}`))
  const cycleMembers = new Set(a.cycles.flat())
  const agg = new Map<string, { n: number; bad: boolean }>()
  for (const e of edges) {
    const f = childOf(e.from, level)
    const t = childOf(e.to, level)
    if (!f || !t || f === t || !shown.has(f) || !shown.has(t)) continue
    const k = `${f}|${t}`
    const cur = agg.get(k) ?? { n: 0, bad: false }
    cur.n++
    cur.bad ||= violations.has(`${e.from}->${e.to}`)
    agg.set(k, cur)
  }
  const lines = ['flowchart TB']
  for (const [c, info] of ranked.slice(0, maxNodes)) {
    const name = c.split('/').pop()!
    const isFile = /\.[a-z]+$/.test(name)
    const covTxt = info.cov[1] ? pct(info.cov[0] / info.cov[1]) : ''
    const label = `${esc(name)}${isFile ? '' : '/'}<br/><small>${info.modules} mod${info.modules > 1 ? 's' : ''}${covTxt ? ' · cov' + covTxt : ''}${info.worstCrap > a.config.thresholds.crap ? ' · CRAP ' + Math.round(info.worstCrap) : ''}</small>`
    lines.push(`  ${safeId(c)}${isFile ? `["${label}"]` : `[["${label}"]]`}`)
    const inCycle = [...cycleMembers].some((m) => under(m, c))
    const cls = info.worstCrap > a.config.thresholds.crap * 2 ? 'bad' : info.worstCrap > a.config.thresholds.crap ? 'warn' : 'ok'
    lines.push(`  class ${safeId(c)} ${cls}${inCycle ? ',cyc' : ''}`)
  }
  if (ranked.length > maxNodes) lines.push(`  more["… +${ranked.length - maxNodes} more"]`)
  let i = 0
  const red: number[] = []
  for (const [k, v] of agg) {
    const [f, t] = k.split('|')
    lines.push(`  ${safeId(f)} -->|${v.n}| ${safeId(t)}`)
    if (v.bad) red.push(i)
    i++
  }
  if (red.length) lines.push(`  linkStyle ${red.join(',')} stroke:#d33,stroke-width:3px`)
  lines.push('  classDef ok fill:#e8f6e8,stroke:#4a4')
  lines.push('  classDef warn fill:#fff4d6,stroke:#c90')
  lines.push('  classDef bad fill:#fde2e2,stroke:#c33')
  lines.push('  classDef cyc stroke-dasharray: 5 3')
  const notes: string[] = []
  const badEdges = [...agg.entries()].filter(([, v]) => v.bad).map(([k]) => k.replace('|', ' → '))
  if (badEdges.length) notes.push(`%% dependency-rule violations (red): ${badEdges.join('; ')}`)
  const cyc = a.cycles.filter((c) => c.some((m) => under(m, level)))
  if (cyc.length) notes.push(`%% cycles: ${cyc.map((c) => c.join(' ↔ ')).join(' | ')}`)
  return [...lines, ...notes].join('\n')
}

const STEREO: Record<string, string> = {
  interface: 'interface',
  service: 'service',
  entity: 'entity',
  component: 'component',
  hook: 'hook',
  store: 'store',
  controller: 'controller',
  behaviour: 'behaviour',
  protocol: 'protocol',
  enum: 'enumeration',
  type: 'type',
  module: 'module',
  live_view: 'live_view',
  worker: 'worker',
  genserver: 'genserver',
  struct: 'struct',
  container: 'container',
  machine: 'machine',
}

function classDiagram(a: Analysis, level: string, maxNodes: number): string {
  const isFile = /\.[a-z]+$/.test(level)
  const els = [...a.model.elements.values()].filter((e) => {
    const m = a.model.modules.get(e.module)
    if (!m || m.isTest) return false
    return isFile ? e.module === level : m.component === level
  })
  const shown = els.slice(0, maxNodes)
  const ids = new Set(shown.map((e) => e.id))
  const lines = ['classDiagram']
  const crapT = a.config.thresholds.crap
  for (const e of shown) {
    const name = safeId(e.id)
    lines.push(`  class ${name}["${esc(e.kind === 'module' ? e.module.split('/').pop()! : e.name)}"] {`)
    if (STEREO[e.kind] && e.kind !== 'class') lines.push(`    <<${STEREO[e.kind]}>>`)
    for (const m of e.members.slice(0, 15)) {
      const vis = m.visibility === 'private' ? '-' : m.visibility === 'protected' ? '#' : '+'
      if (m.kind === 'field') lines.push(`    ${vis}${esc(m.name)}${m.type ? ' ' + esc(m.type) : ''}`)
      else {
        const mm = m.metrics
        const tags = [mm.cc !== undefined ? `cc${mm.cc}` : '', mm.coverage !== undefined ? `cov${Math.round(mm.coverage * 100)}` : '', mm.crap !== undefined && mm.crap > crapT ? `CRAP${Math.round(mm.crap)}` : '']
          .filter(Boolean)
          .join(' ')
        lines.push(`    ${vis}${esc(m.name.replace(/\(.*$/, ''))}() ${tags}`)
      }
    }
    if (e.members.length > 15) lines.push(`    … ${e.members.length - 15} more`)
    lines.push('  }')
    const worst = Math.max(0, ...e.members.map((m) => m.metrics.crap ?? 0))
    if (worst > crapT) lines.push(`  style ${name} fill:${worst > crapT * 2 ? '#fde2e2' : '#fff4d6'}`)
  }
  // edges between shown elements, plus edges to outside elements as plain names
  const external = new Map<string, string>()
  for (const e of a.model.elementEdges) {
    const inF = ids.has(e.from)
    const inT = ids.has(e.to)
    if (!inF && !inT) continue
    if (!inF) continue
    let to = safeId(e.to)
    if (!inT) {
      const el = a.model.elements.get(e.to)
      if (!el) continue
      to = safeId(e.to)
      if (!external.has(e.to)) external.set(e.to, el.name + ' (' + el.module.split('/').slice(-2).join('/') + ')')
    }
    const from = safeId(e.from)
    const label = e.label ? ` : ${esc(e.label)}` : ` : ${e.kind}`
    switch (e.kind) {
      case 'inherits':
        lines.push(`  ${to} <|-- ${from}`)
        break
      case 'implements':
        lines.push(`  ${to} <|.. ${from}`)
        break
      case 'association':
        lines.push(`  ${from} --> ${to}${label}`)
        break
      default:
        lines.push(`  ${from} ..> ${to}${label}`)
    }
  }
  for (const [id, name] of external) lines.push(`  class ${safeId(id)}["${esc(name)}"]`)
  if (els.length > maxNodes) lines.push(`  %% … +${els.length - maxNodes} more elements`)
  return lines.join('\n')
}
