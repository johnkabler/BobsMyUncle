import path from 'node:path'
import type { Edge, ElementNode, FileFacts, Lang, Model, ModuleNode, RawImport } from '../core/model.js'
import type { ImportResolver } from '../lang/resolve.js'

const RESOLVABLE_KINDS = new Set(['class', 'interface', 'service', 'entity', 'controller', 'type', 'protocol', 'behaviour', 'struct', 'component', 'hook', 'store', 'enum', 'container', 'live_view', 'worker', 'genserver', 'machine'])

/** Build the resolved model (modules, elements, edges) from per-file facts. */
export function buildModel(root: string, facts: FileFacts[], resolvers: Record<Lang, ImportResolver>): Model {
  const modules = new Map<string, ModuleNode>()
  const elements = new Map<string, ElementNode>()
  const byFile = new Map<string, FileFacts>()
  for (const f of facts) {
    byFile.set(f.path, f)
    const dir = path.posix.dirname(f.path)
    const mod: ModuleNode = { id: f.path, file: f.path, lang: f.lang, component: dir === '.' ? '' : dir, loc: f.loc, isTest: f.isTest, elements: [] }
    for (const e of f.elements) {
      const id = `${f.path}#${e.name}`
      const node: ElementNode = {
        ...e,
        id,
        module: f.path,
        members: e.members.map((m) => ({ ...m, id: `${id}.${m.name}`, metrics: { cc: m.cc } })),
      }
      mod.elements.push(node)
      elements.set(id, node)
    }
    modules.set(f.path, mod)
  }

  // global name index for fallback resolution (DI tokens, Elixir module names)
  const byName = new Map<string, ElementNode[]>()
  for (const el of elements.values()) {
    if (!RESOLVABLE_KINDS.has(el.kind)) continue
    const arr = byName.get(el.name) ?? []
    arr.push(el)
    byName.set(el.name, arr)
  }

  const moduleEdges: Edge[] = []
  const resolvedImports = new Map<string, { imp: RawImport; targets: string[] }[]>()
  for (const f of facts) {
    const r = resolvers[f.lang]
    const list: { imp: RawImport; targets: string[] }[] = []
    const seen = new Map<string, Edge>()
    for (const imp of f.imports) {
      const targets = r.resolve(f.path, imp)
      list.push({ imp, targets })
      for (const t of targets) {
        if (t === f.path) continue
        const kind = imp.kind === 'reexport' || imp.kind === 'call' ? 'import' : imp.kind
        const prev = seen.get(t)
        // strongest kind wins: import > compile-time > type-only
        if (prev) {
          if (prev.kind === 'type-only' && kind !== 'type-only') prev.kind = kind
          continue
        }
        const e: Edge = { from: f.path, to: t, kind, line: imp.line }
        seen.set(t, e)
        moduleEdges.push(e)
      }
    }
    resolvedImports.set(f.path, list)
  }

  // --- element-level edges ---
  const findInFile = (file: string, name: string, depth = 0): ElementNode | null => {
    const local = elements.get(`${file}#${name}`)
    if (local) return local
    if (depth > 4) return null
    // follow re-exports (barrels)
    for (const { imp, targets } of resolvedImports.get(file) ?? []) {
      if (imp.kind !== 'reexport') continue
      if (!imp.names.includes('*') && !imp.names.includes(name)) continue
      for (const t of targets) {
        const hit = findInFile(t, name, depth + 1)
        if (hit) return hit
      }
    }
    return null
  }

  const resolveName = (f: FileFacts, rawTarget: string): ElementNode | null => {
    const target = rawTarget.replace(/^['"`]|['"`]$/g, '')
    if (f.lang === 'elixir') {
      for (const el of byName.get(target) ?? []) return el
      return null
    }
    const local = elements.get(`${f.path}#${target}`)
    if (local) return local
    const [head, ...rest] = target.split('.')
    const last = target.split('.').pop()!
    for (const { imp, targets } of resolvedImports.get(f.path) ?? []) {
      const aliased = imp.aliases?.[head]
      const importedName = aliased ?? (imp.names.includes(head) ? head : null)
      if (importedName === null && !imp.names.includes('*')) continue
      for (const t of targets) {
        if (t.startsWith('ext:')) continue
        if (importedName === '*' || (aliased === undefined && imp.names.includes('*') && importedName === null)) {
          // namespace import: ns.Foo  /  python `import pkg.mod` then `pkg.mod.Foo`
          const hit = findInFile(t, last)
          if (hit) return hit
          continue
        }
        if (importedName === 'default') {
          const els = (modules.get(t)?.elements ?? []).filter((e) => e.kind !== 'module' && e.exported)
          if (els.length) return els.find((e) => e.name === head) ?? els[0]
          continue
        }
        if (importedName) {
          const hit = findInFile(t, rest.length ? last : importedName)
          if (hit) return hit
          // python: `from pkg import mod` then `mod.Foo`
          if (rest.length) {
            const hit2 = findInFile(t, last)
            if (hit2) return hit2
          }
        }
      }
    }
    // unique global fallback (string DI tokens, Python module-qualified names)
    const cands = byName.get(last)
    if (cands && cands.length === 1 && cands[0].module !== f.path) return cands[0]
    return null
  }

  const elementEdges: Edge[] = []
  const edgeKeys = new Set<string>()
  for (const f of facts) {
    if (f.isTest) continue
    for (const ref of f.refs) {
      const from = elements.get(`${f.path}#${ref.from}`) ?? (f.elements.find((e) => e.kind === 'module') ? elements.get(`${f.path}#${f.elements.find((e) => e.kind === 'module')!.name}`) : undefined)
      if (!from) continue
      const to = resolveName(f, ref.target)
      if (!to || to.id === from.id) continue
      const key = `${from.id}|${to.id}|${ref.kind}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      elementEdges.push({ from: from.id, to: to.id, kind: ref.kind, label: ref.label, line: ref.line })
      // DI and other refs imply a module dependency even with string tokens
      if (to.module !== f.path && !moduleEdges.some((e) => e.from === f.path && e.to === to.module)) {
        if (ref.kind === 'injects' || ref.kind === 'implements' || ref.kind === 'inherits') {
          moduleEdges.push({ from: f.path, to: to.module, kind: 'import', line: ref.line })
        }
      }
    }
  }

  return { root, modules, elements, moduleEdges, elementEdges }
}

/** Reverse-dependency closure: which test files (transitively) depend on the given files. */
export function affectedTests(model: Model, changed: string[]): string[] {
  const rev = new Map<string, string[]>()
  for (const e of model.moduleEdges) {
    if (e.to.startsWith('ext:')) continue
    ;(rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from)
  }
  const seen = new Set<string>(changed)
  const queue = [...changed]
  const tests = new Set<string>()
  while (queue.length) {
    const f = queue.shift()!
    const m = model.modules.get(f)
    if (m?.isTest) tests.add(f)
    for (const p of rev.get(f) ?? []) {
      if (!seen.has(p)) {
        seen.add(p)
        queue.push(p)
      }
    }
  }
  return [...tests].filter((t) => isRunnableTest(t)).sort()
}

const isRunnableTest = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)spec\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p) || /_test\.exs$/.test(p)
