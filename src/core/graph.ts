import type { Edge, Model, ModuleNode } from './model.js'
import { isExternal } from './model.js'
import type { LayerRuleConfig } from './config.js'

/** Runtime dependency edges between project (non-test) modules. */
export function projectEdges(model: Model, includeTypeOnly = false): Edge[] {
  return model.moduleEdges.filter((e) => {
    if (isExternal(e.to) || e.from === e.to) return false
    if (!includeTypeOnly && e.kind === 'type-only') return false
    const a = model.modules.get(e.from)
    const b = model.modules.get(e.to)
    return !!a && !!b && !a.isTest && !b.isTest
  })
}

/** Tarjan's strongly connected components; returns components with more than one node. */
export function findCycles(nodes: string[], edges: Edge[]): string[][] {
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n, [])
  for (const e of edges) adj.get(e.from)?.push(e.to)
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  // iterative Tarjan to avoid stack overflow on big graphs
  for (const start of nodes) {
    if (idx.has(start)) continue
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }]
    idx.set(start, index)
    low.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)
    while (work.length) {
      const top = work[work.length - 1]
      const succ = adj.get(top.v) ?? []
      if (top.i < succ.length) {
        const w = succ[top.i++]
        if (!idx.has(w)) {
          idx.set(w, index)
          low.set(w, index)
          index++
          stack.push(w)
          onStack.add(w)
          work.push({ v: w, i: 0 })
        } else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!))
      } else {
        work.pop()
        if (work.length) {
          const parent = work[work.length - 1].v
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!))
        }
        if (low.get(top.v) === idx.get(top.v)) {
          const comp: string[] = []
          let w: string
          do {
            w = stack.pop()!
            onStack.delete(w)
            comp.push(w)
          } while (w !== top.v)
          if (comp.length > 1) out.push(comp.sort())
        }
      }
    }
  }
  return out
}

/** Find one concrete loop path through an SCC for a readable message. */
export function cyclePath(comp: string[], edges: Edge[]): string[] {
  const set = new Set(comp)
  const adj = new Map<string, string[]>()
  for (const e of edges) if (set.has(e.from) && set.has(e.to)) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to)
  const start = comp[0]
  const prev = new Map<string, string>()
  const queue = [start]
  const seen = new Set([start])
  while (queue.length) {
    const v = queue.shift()!
    for (const w of adj.get(v) ?? []) {
      if (w === start) {
        const path = [start]
        let cur = v
        const rev: string[] = []
        while (cur !== start) {
          rev.push(cur)
          cur = prev.get(cur)!
        }
        return [...path, ...rev.reverse(), start]
      }
      if (!seen.has(w)) {
        seen.add(w)
        prev.set(w, v)
        queue.push(w)
      }
    }
  }
  return [...comp, comp[0]]
}

export interface ComponentMetrics {
  component: string
  modules: number
  ca: number // afferent: modules outside that depend on modules inside
  ce: number // efferent: modules inside depend on outside modules
  instability: number
  abstractness: number
  distance: number
}

const ABSTRACT_KINDS = new Set(['interface', 'type', 'protocol', 'behaviour'])

/** Robert C. Martin package metrics, per directory component (direct files only). */
export function componentMetrics(model: Model, edges: Edge[]): ComponentMetrics[] {
  const byComp = new Map<string, ModuleNode[]>()
  for (const m of model.modules.values()) {
    if (m.isTest) continue
    const arr = byComp.get(m.component) ?? []
    arr.push(m)
    byComp.set(m.component, arr)
  }
  const ca = new Map<string, Set<string>>()
  const ce = new Map<string, Set<string>>()
  for (const e of edges) {
    const a = model.modules.get(e.from)!.component
    const b = model.modules.get(e.to)!.component
    if (a === b) continue
    ;(ce.get(a) ?? ce.set(a, new Set()).get(a)!).add(e.to)
    ;(ca.get(b) ?? ca.set(b, new Set()).get(b)!).add(e.from)
  }
  const out: ComponentMetrics[] = []
  for (const [component, mods] of byComp) {
    const els = mods.flatMap((m) => m.elements.filter((e) => e.kind !== 'module'))
    const abstract = els.filter((e) => ABSTRACT_KINDS.has(e.kind) || e.abstract).length
    const A = els.length ? abstract / els.length : 0
    const caN = ca.get(component)?.size ?? 0
    const ceN = ce.get(component)?.size ?? 0
    const I = caN + ceN ? ceN / (caN + ceN) : 0
    out.push({ component, modules: mods.length, ca: caN, ce: ceN, instability: I, abstractness: A, distance: Math.abs(A + I - 1) })
  }
  return out.sort((a, b) => a.component.localeCompare(b.component))
}

export interface Violation {
  from: string
  to: string
  rule: 'layer' | 'forbidden'
  reason: string
  line?: number
}

const matchesPrefix = (file: string, prefix: string) => {
  const p = prefix.replace(/\/+$/, '')
  return p === '' || file === p || file.startsWith(p + '/') || file.startsWith(p + '.')
}

function layerIndex(file: string, layers: string[][]): { rank: number; prefix: string } | null {
  let best: { rank: number; prefix: string } | null = null
  layers.forEach((group, rank) => {
    for (const prefix of group) {
      if (matchesPrefix(file, prefix) && (!best || prefix.length > best.prefix.length)) best = { rank, prefix }
    }
  })
  return best
}

/** Dependency Rule: inner layers (lower index) must not depend on outer layers (higher index). */
export function ruleViolations(edges: Edge[], rules: LayerRuleConfig): Violation[] {
  const out: Violation[] = []
  const layers = rules.layers ?? []
  for (const e of edges) {
    if (layers.length) {
      const a = layerIndex(e.from, layers)
      const b = layerIndex(e.to, layers)
      if (a && b && a.rank < b.rank) {
        out.push({ from: e.from, to: e.to, rule: 'layer', reason: `${a.prefix} (inner) must not depend on ${b.prefix} (outer)`, line: e.line })
      }
    }
    for (const f of rules.forbidden ?? []) {
      if (matchesPrefix(e.from, f.from) && matchesPrefix(e.to, f.to)) {
        out.push({ from: e.from, to: e.to, rule: 'forbidden', reason: f.reason ?? `${f.from} must not depend on ${f.to}`, line: e.line })
      }
    }
  }
  return out
}
