import type { Analysis } from '../engine/analyze.js'
import type { Store } from '../store/db.js'
import type { ElementNode } from '../core/model.js'
import { ranges } from '../ingest/coverage.js'
import { findingLine } from './format.js'

const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${Math.round(x * 100)}%`)

function elementBlock(a: Analysis, el: ElementNode): string[] {
  const out: string[] = []
  const stereo = el.kind === 'class' ? '' : ` «${el.kind}»`
  out.push(`### ${el.kind === 'module' ? el.module.split('/').pop() : el.name}${stereo}  (${el.module}:${el.start}-${el.end})`)
  if (el.decorators?.length) out.push(`decorators: ${el.decorators.map((d) => '@' + d).join(' ')}`)
  for (const m of el.members) {
    const vis = m.visibility === 'private' ? '-' : m.visibility === 'protected' ? '#' : '+'
    if (m.kind === 'field') {
      out.push(`  ${vis} ${m.name}${m.type ? ': ' + m.type : ''}`)
      continue
    }
    const mm = m.metrics
    const parts = [`cc ${mm.cc ?? '?'}`, `cov ${pct(mm.coverage)}${mm.stale ? ' (stale)' : ''}`]
    if (mm.crap !== undefined) parts.push(`CRAP ${Math.round(mm.crap)}`)
    if (mm.uncovered?.length) parts.push(`uncovered ${ranges(mm.uncovered)}`)
    if (mm.mutation) parts.push(`mutants ${mm.mutation.killed} killed / ${mm.mutation.survived} survived${mm.mutation.survivors.length ? ' @' + mm.mutation.survivors.slice(0, 4).map((x) => `${x.line} ${x.mutator}`).join(', ') : ''}`)
    out.push(`  ${vis} ${m.name}()  L${m.start}-${m.end}  ${parts.join(', ')}`)
  }
  const outEdges = a.model.elementEdges.filter((e) => e.from === el.id)
  const inEdges = a.model.elementEdges.filter((e) => e.to === el.id)
  const name = (id: string) => {
    const t = a.model.elements.get(id)
    return t ? `${t.name} (${t.module})` : id
  }
  if (outEdges.length) out.push('  → ' + outEdges.map((e) => `${e.kind}${e.label ? ' [' + e.label + ']' : ''} ${name(e.to)}`).join('; '))
  if (inEdges.length) out.push('  ← ' + inEdges.map((e) => `${e.kind} from ${name(e.from)}`).join('; '))
  return out
}

export function explain(a: Analysis, store: Store, target: string): string {
  const out: string[] = []
  // finding id
  if (/^bmu-[0-9a-f]{4,}$/.test(target)) {
    const f = store.getFinding(target)
    if (!f) return `unknown finding ${target}`
    out.push(findingLine(f))
    out.push(`rule: ${f.rule}; first seen ${new Date(f.first_seen).toISOString()}; baseline ${f.baseline_value ?? 'none (new)'}; status ${f.status}${f.ack_reason ? ' — ' + f.ack_reason : ''}`)
    const hint: Record<string, string> = {
      crap: 'CRAP = cc² × (1 − coverage)³ + cc. Lower it by adding tests for the uncovered branches, or by splitting the function (extract methods / early returns / lookup tables).',
      complexity: 'Cyclomatic complexity is high and there is no fresh coverage. Split the function or add tests and run `bmu coverage run`.',
      uncovered: 'These lines are not executed by any test. Add tests that exercise them (or delete dead code).',
      cycle: 'Modules import each other (directly or transitively). Break the cycle by extracting the shared piece into a lower-level module or by inverting a dependency through an interface.',
      layer: 'An inner (higher-level, more stable) layer depends on an outer one. Invert the dependency: define an interface in the inner layer and implement it in the outer one.',
      forbidden: 'This dependency is explicitly forbidden by the bmu config.',
      'file-coverage': 'File coverage is below the configured minimum.',
      mutants: 'Mutation testing changed this code and no test failed: the tests execute it but do not check the behaviour. Add assertions that would fail for the listed mutations.',
    }
    out.push(hint[f.rule] ?? '')
    const subjectEl = f.subject.includes('#') ? a.model.elements.get(f.subject.split('.').length > 1 ? f.subject.slice(0, f.subject.lastIndexOf('.')) : f.subject) : undefined
    const el = subjectEl ?? [...a.model.elements.values()].find((e) => f.subject.startsWith(e.id + '.'))
    if (el) out.push('', ...elementBlock(a, el))
    if (f.rule === 'cycle') out.push('modules: ' + f.subject.split('|').join(', '))
    return out.join('\n')
  }
  // file
  const file = a.model.modules.get(target.replace(/^\.\//, ''))
  if (file) {
    out.push(`## ${file.id}  (${file.lang}, ${file.loc} lines${file.isTest ? ', test' : ''})`)
    for (const el of file.elements) out.push(...elementBlock(a, el))
    const deps = a.model.moduleEdges.filter((e) => e.from === file.id)
    const users = a.model.moduleEdges.filter((e) => e.to === file.id)
    out.push(`imports (${deps.length}): ${deps.map((e) => e.to + (e.kind !== 'import' ? ` [${e.kind}]` : '')).join(', ') || '-'}`)
    out.push(`imported by (${users.length}): ${users.map((e) => e.from).join(', ') || '-'}`)
    const fs = store.allFindings().filter((r) => r.file === file.id && r.status !== 'resolved')
    if (fs.length) out.push('findings:', ...fs.map((r) => '  ' + findingLine(r)))
    return out.join('\n')
  }
  // element by name (or file#name)
  const matches = [...a.model.elements.values()].filter((e) => e.id === target || e.name === target || e.id.endsWith('#' + target))
  if (matches.length) {
    for (const el of matches.slice(0, 5)) out.push(...elementBlock(a, el), '')
    if (matches.length > 5) out.push(`… +${matches.length - 5} more matches`)
    return out.join('\n')
  }
  // directory
  const dir = target.replace(/^\.\//, '').replace(/\/+$/, '')
  const comp = a.components.find((c) => c.component === dir)
  if (comp) {
    out.push(`## ${dir}/  ${comp.modules} modules  Ca=${comp.ca} Ce=${comp.ce} I=${comp.instability.toFixed(2)} A=${comp.abstractness.toFixed(2)} D=${comp.distance.toFixed(2)}`)
    for (const m of a.model.modules.values()) if (m.component === dir && !m.isTest) out.push(`- ${m.id.split('/').pop()}: ${m.elements.map((e) => (e.kind === 'module' ? `${e.members.length} fns` : `${e.name}«${e.kind}»`)).join(', ')}`)
    return out.join('\n')
  }
  return `nothing matches "${target}" (try a finding id, a repo-relative file path, a directory, or an element name)`
}
