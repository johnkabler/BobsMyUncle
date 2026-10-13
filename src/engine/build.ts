import path from 'node:path'
import type { Edge, ElementNode, FileFacts, Lang, Model, ModuleNode, RawImport } from '../core/model.js'
import type { ImportResolver } from '../lang/resolve.js'

const RESOLVABLE_KINDS = new Set(['class', 'interface', 'service', 'entity', 'controller', 'type', 'protocol', 'behaviour', 'struct', 'component', 'hook', 'store', 'enum', 'container', 'live_view', 'worker', 'genserver', 'machine'])

type Resolved = { imp: RawImport; targets: string[] }

const edgeKind = (imp: RawImport): Edge['kind'] => (imp.kind === 'reexport' || imp.kind === 'call' ? 'import' : imp.kind)

/** Builds the resolved model (modules, elements, edges) from per-file facts. */
class ModelBuilder {
  readonly modules = new Map<string, ModuleNode>()
  readonly elements = new Map<string, ElementNode>()
  readonly byName = new Map<string, ElementNode[]>()
  readonly moduleEdges: Edge[] = []
  readonly elementEdges: Edge[] = []
  private readonly resolved = new Map<string, Resolved[]>()
  private readonly moduleEdgeKeys = new Set<string>()

  constructor(private readonly facts: FileFacts[]) {}

  addNodes() {
    for (const f of this.facts) {
      const dir = path.posix.dirname(f.path)
      const mod: ModuleNode = { id: f.path, file: f.path, lang: f.lang, component: dir === '.' ? '' : dir, loc: f.loc, isTest: f.isTest, elements: [] }
      for (const e of f.elements) {
        const id = `${f.path}#${e.name}`
        const node: ElementNode = { ...e, id, module: f.path, members: e.members.map((m) => ({ ...m, id: `${id}.${m.name}`, metrics: { cc: m.cc } })) }
        mod.elements.push(node)
        this.elements.set(id, node)
        if (RESOLVABLE_KINDS.has(node.kind)) (this.byName.get(node.name) ?? this.byName.set(node.name, []).get(node.name)!).push(node)
      }
      this.modules.set(f.path, mod)
    }
  }

  /** Resolve imports to module edges; the strongest kind wins (import > compile-time > type-only). */
  addModuleEdges(resolvers: Record<Lang, ImportResolver>) {
    for (const f of this.facts) {
      const list: Resolved[] = []
      const seen = new Map<string, Edge>()
      for (const imp of f.imports) {
        const targets = resolvers[f.lang].resolve(f.path, imp)
        list.push({ imp, targets })
        for (const t of targets) {
          if (t === f.path) continue
          const kind = edgeKind(imp)
          const prev = seen.get(t)
          if (prev) {
            if (prev.kind === 'type-only' && kind !== 'type-only') prev.kind = kind
            continue
          }
          const e: Edge = { from: f.path, to: t, kind, line: imp.line }
          seen.set(t, e)
          this.pushModuleEdge(e)
        }
      }
      this.resolved.set(f.path, list)
    }
  }

  private pushModuleEdge(e: Edge) {
    this.moduleEdges.push(e)
    this.moduleEdgeKeys.add(e.from + '\0' + e.to)
  }

  /** Find an element by name in a file, following re-export barrels. */
  findInFile(file: string, name: string, depth = 0): ElementNode | null {
    const local = this.elements.get(`${file}#${name}`)
    if (local || depth > 4) return local ?? null
    for (const { imp, targets } of this.resolved.get(file) ?? []) {
      if (imp.kind !== 'reexport' || (!imp.names.includes('*') && !imp.names.includes(name))) continue
      for (const t of targets) {
        const hit = this.findInFile(t, name, depth + 1)
        if (hit) return hit
      }
    }
    return null
  }

  /** Resolve `name` (maybe `ns.Name`) through one import of the file. */
  private viaImport({ imp, targets }: Resolved, head: string, last: string, qualified: boolean): ElementNode | null {
    const aliased = imp.aliases?.[head]
    const importedName = aliased ?? (imp.names.includes(head) ? head : null)
    if (importedName === null && !imp.names.includes('*')) return null
    for (const t of targets) {
      if (t.startsWith('ext:')) continue
      let hit: ElementNode | null = null
      if (importedName === '*' || importedName === null) hit = this.findInFile(t, last) // namespace import / python module import
      else if (importedName === 'default') {
        const els = (this.modules.get(t)?.elements ?? []).filter((e) => e.kind !== 'module' && e.exported)
        hit = els.find((e) => e.name === head) ?? els[0] ?? null
      } else hit = this.findInFile(t, qualified ? last : importedName) ?? (qualified ? this.findInFile(t, last) : null)
      if (hit) return hit
    }
    return null
  }

  resolveName(f: FileFacts, rawTarget: string): ElementNode | null {
    const target = rawTarget.replace(/^['"`]|['"`]$/g, '')
    if (f.lang === 'elixir') return this.byName.get(target)?.[0] ?? null
    const local = this.elements.get(`${f.path}#${target}`)
    if (local) return local
    const parts = target.split('.')
    const head = parts[0]
    const last = parts[parts.length - 1]
    for (const r of this.resolved.get(f.path) ?? []) {
      const hit = this.viaImport(r, head, last, parts.length > 1)
      if (hit) return hit
    }
    // unique global fallback (string DI tokens, Python module-qualified names)
    const cands = this.byName.get(last)
    return cands && cands.length === 1 && cands[0].module !== f.path ? cands[0] : null
  }

  addElementEdges() {
    const keys = new Set<string>()
    for (const f of this.facts) {
      if (f.isTest) continue
      const moduleEl = f.elements.find((e) => e.kind === 'module')
      for (const ref of f.refs) {
        const from = this.elements.get(`${f.path}#${ref.from}`) ?? (moduleEl ? this.elements.get(`${f.path}#${moduleEl.name}`) : undefined)
        const to = from ? this.resolveName(f, ref.target) : null
        if (!from || !to || to.id === from.id) continue
        const key = `${from.id}|${to.id}|${ref.kind}`
        if (keys.has(key)) continue
        keys.add(key)
        this.elementEdges.push({ from: from.id, to: to.id, kind: ref.kind, label: ref.label, line: ref.line })
        // DI/inheritance refs imply a module dependency even with string tokens
        const implied = ref.kind === 'injects' || ref.kind === 'implements' || ref.kind === 'inherits'
        if (implied && to.module !== f.path && !this.moduleEdgeKeys.has(f.path + '\0' + to.module)) this.pushModuleEdge({ from: f.path, to: to.module, kind: 'import', line: ref.line })
      }
    }
  }
}

/** Build the resolved model (modules, elements, edges) from per-file facts. */
export function buildModel(root: string, facts: FileFacts[], resolvers: Record<Lang, ImportResolver>): Model {
  const b = new ModelBuilder(facts)
  b.addNodes()
  b.addModuleEdges(resolvers)
  b.addElementEdges()
  return { root, modules: b.modules, elements: b.elements, moduleEdges: b.moduleEdges, elementEdges: b.elementEdges }
}

const stem = (p: string) =>
  p
    .split('/')
    .pop()!
    .replace(/\.(test|spec)(?=\.)/, '')
    .replace(/^test_/, '')
    .replace(/_test(?=\.)/, '')
    .replace(/\.[^.]+$/, '')

/**
 * Tests most likely to exercise the changed files: name-matched tests and direct importers first,
 * then transitive dependents by increasing distance, up to `limit` files.
 */
export function affectedTests(model: Model, changed: string[], limit = 25): string[] {
  const rev = new Map<string, string[]>()
  for (const e of model.moduleEdges) {
    if (e.to.startsWith('ext:')) continue
    ;(rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from)
  }
  const picked: string[] = []
  const add = (t: string) => {
    if (!picked.includes(t) && isRunnableTest(t)) picked.push(t)
  }
  // changed tests themselves
  for (const c of changed) if (model.modules.get(c)?.isTest) add(c)
  // name-matched tests (foo.ts <-> foo.test.ts / test_foo.py / foo_test.exs)
  const stems = new Set(changed.map(stem))
  const tests = [...model.modules.values()].filter((m) => m.isTest)
  for (const t of tests) if (stems.has(stem(t.id)) && changed.some((c) => model.moduleEdges.some((e) => e.from === t.id && e.to === c))) add(t.id)
  // BFS by distance
  const seen = new Set<string>(changed)
  let frontier = [...changed]
  while (frontier.length && picked.length < limit) {
    const next: string[] = []
    for (const f of frontier) {
      for (const p of rev.get(f) ?? []) {
        if (seen.has(p)) continue
        seen.add(p)
        if (model.modules.get(p)?.isTest) add(p)
        else next.push(p)
      }
    }
    frontier = next
  }
  return picked.slice(0, Math.max(limit, 1))
}

const isRunnableTest = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)spec\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p) || /_test\.exs$/.test(p)
