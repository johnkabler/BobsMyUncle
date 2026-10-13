import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Analysis } from '../engine/analyze.js'
import type { Store } from '../store/db.js'
import { makeResolvers } from '../lang/resolve.js'
import { listFiles } from '../engine/files.js'

/** Diagnose how well bmu understands this repo: parse errors, unresolved imports, coverage, runners. */
export function doctor(a: Analysis, store: Store): string {
  const out: string[] = []
  const facts = store.allFacts()
  const s = a.stats
  out.push(`root: ${a.root}`)
  out.push(`files: ${s.files} source files (${Object.entries(s.byLang).map(([l, n]) => `${l} ${n}`).join(', ')}), ${s.tests} tests; scan ${s.ms}ms`)
  const errs = facts.filter((f) => f.parseError)
  out.push(`parse errors: ${errs.length}${errs.length ? ' — e.g. ' + errs.slice(0, 5).map((f) => f.path).join(', ') : ''}`)

  // unresolved project-looking imports
  const resolvers = makeResolvers(a.root, listFiles(a.root), facts)
  const unresolved = new Map<string, number>()
  let total = 0
  let ok = 0
  for (const f of facts) {
    for (const imp of f.imports) {
      if (f.lang === 'elixir' && imp.kind === 'call') continue
      const local = f.lang === 'typescript' ? imp.spec.startsWith('.') || /^[~@#]\//.test(imp.spec) : f.lang === 'python' ? !!imp.level : false
      if (!local) continue
      total++
      const r = resolvers[f.lang].resolve(f.path, imp)
      if (r.some((x) => !x.startsWith('ext:'))) ok++
      else {
        const key = imp.spec.replace(/\/[^/]*$/, '/…')
        unresolved.set(key, (unresolved.get(key) ?? 0) + 1)
      }
    }
  }
  out.push(`local imports resolved: ${ok}/${total}${total ? ` (${Math.round((ok / total) * 100)}%)` : ''}`)
  const top = [...unresolved.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
  if (top.length) out.push('  most common unresolved: ' + top.map(([k, n]) => `${k} ×${n}`).join(', '))

  const reports = a.config.coverage.reports.filter((r) => existsSync(path.join(a.root, r)))
  out.push(`coverage reports found: ${reports.length ? reports.join(', ') : 'none (bmu runs affected tests in the background, or run `bmu coverage run --all`)'}`)
  out.push(`coverage: ${s.measuredFiles} files measured, ${s.staleFiles} stale; overall ${s.coverage === undefined ? 'n/a' : Math.round(s.coverage * 100) + '%'}`)
  out.push(`background coverage: ${a.config.coverage.background ? `on (debounce ${a.config.coverage.debounceSeconds}s)` : 'off'}`)
  for (const [lang, rc] of Object.entries(a.config.runners)) if (rc) out.push(`runner ${lang}: ${JSON.stringify(rc)}`)
  out.push(`layers: ${a.config.rules.layers?.length ? a.config.rules.layers.map((l) => l.join(' + ')).join('  →  ') : 'none configured (run `bmu init`)'}`)
  out.push(`elements: ${s.elements}; module edges: ${a.model.moduleEdges.length}; element edges: ${a.model.elementEdges.length}; cycles: ${a.cycles.length}`)
  return out.join('\n')
}
