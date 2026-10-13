import type { Element, ElementKind, FileFacts, Member, NameRef, RawImport, Visibility } from '../core/model.js'
import { getParser, line, endLine, walk, namedChildren, firstOfType, descendantsOfType, type Node } from './treesitter.js'

const DECISIONS = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'ternary_expression',
])
const LOGICAL = new Set(['&&', '||', '??'])

export function tsComplexity(node: Node, skip?: Set<number>): number {
  let cc = 1
  walk(node, (n) => {
    if (skip && n !== node && skip.has(n.startIndex)) return false
    if (DECISIONS.has(n.type)) cc++
    else if (n.type === 'switch_case') cc++ // `default` is switch_default
    else if (n.type === 'binary_expression') {
      const op = n.childForFieldName('operator')?.text
      if (op && LOGICAL.has(op)) cc++
    } else if (n.type === 'augmented_assignment_expression') {
      const op = n.childForFieldName('operator')?.text
      if (op === '&&=' || op === '||=' || op === '??=') cc++
    }
  })
  return cc
}

const isFunctionLike = (n: Node) =>
  n.type === 'arrow_function' || n.type === 'function_expression' || n.type === 'function' || n.type === 'function_declaration'

export const isTsTestFile = (p: string) =>
  /(^|\/)(__tests__|__mocks__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)spec\.[cm]?[jt]sx?$/.test(p) || /(^|\/)e2e\//.test(p)

const isPascal = (s: string) => /^[A-Z][A-Za-z0-9]*$/.test(s)
const isHookName = (s: string) => /^use[A-Z0-9]/.test(s)

function stringValue(n: Node | null): string | null {
  if (!n) return null
  if (n.type === 'string') {
    const frag = firstOfType(n, 'string_fragment')
    return frag ? frag.text : ''
  }
  if (n.type === 'template_string') return n.text.slice(1, -1)
  return null
}

function containsJsx(n: Node): boolean {
  let found = false
  walk(n, (c) => {
    if (found) return false
    if (c.type === 'jsx_element' || c.type === 'jsx_self_closing_element' || c.type === 'jsx_fragment') {
      found = true
      return false
    }
  })
  return found
}

function decoratorName(d: Node): string {
  // decorator -> call_expression(function: identifier|member_expression) | identifier
  const expr = namedChildren(d)[0]
  if (!expr) return d.text.replace(/^@/, '')
  if (expr.type === 'call_expression') return expr.childForFieldName('function')?.text ?? expr.text
  return expr.text
}

/** Extract a type name usable for resolution from a type annotation node: `Foo`, `ns.Foo`, `Foo<Bar>` -> Foo. */
function typeName(n: Node | null): string | null {
  if (!n) return null
  if (n.type === 'type_annotation') return typeName(namedChildren(n)[0] ?? null)
  if (n.type === 'type_identifier' || n.type === 'identifier' || n.type === 'predefined_type') return n.text
  if (n.type === 'array_type') { const t = typeName(namedChildren(n)[0] ?? null); return t ? t + '[]' : null }
  if (n.type === 'nested_type_identifier') return n.text
  if (n.type === 'generic_type') return typeName(n.childForFieldName('name') ?? namedChildren(n)[0] ?? null)
  return null
}

function visibilityOf(n: Node, name: string): Visibility {
  const acc = firstOfType(n, 'accessibility_modifier')?.text
  if (acc === 'private' || name.startsWith('#')) return 'private'
  if (acc === 'protected') return 'protected'
  return 'public'
}

interface Ctx {
  elements: Element[]
  refs: NameRef[]
  imports: RawImport[]
  moduleMembers: Member[]
  /** local names bound to zustand/xstate factories */
  factories: Map<string, 'store' | 'machine'>
}

const ENTITY_DECORATORS = new Set(['Entity', 'ViewEntity', 'ChildEntity'])
const SERVICE_DECORATORS = new Set(['injectable', 'Injectable', 'singleton', 'scoped', 'autoInjectable', 'Service'])
const CONTROLLER_DECORATORS = new Set(['Controller', 'controller', 'Resolver'])
const RELATION_DECORATORS: Record<string, string> = {
  ManyToOne: '*..1',
  OneToMany: '1..*',
  OneToOne: '1..1',
  ManyToMany: '*..*',
}

function extractClass(node: Node, exported: boolean, outerDecorators: Node[], ctx: Ctx) {
  const name = node.childForFieldName('name')?.text
  if (!name) return
  const decorators = [...outerDecorators, ...namedChildren(node).filter((c) => c.type === 'decorator')].map(decoratorName)
  let kind: ElementKind = 'class'
  if (decorators.some((d) => ENTITY_DECORATORS.has(d))) kind = 'entity'
  else if (decorators.some((d) => CONTROLLER_DECORATORS.has(d))) kind = 'controller'
  else if (decorators.some((d) => SERVICE_DECORATORS.has(d))) kind = 'service'
  const members: Member[] = []
  const heritage = firstOfType(node, 'class_heritage')
  if (heritage) {
    for (const clause of namedChildren(heritage)) {
      if (clause.type === 'extends_clause') {
        const v = clause.childForFieldName('value') ?? namedChildren(clause)[0]
        const t = v ? (v.type === 'call_expression' ? null : v.text.replace(/<.*$/s, '')) : null
        if (t) ctx.refs.push({ from: name, kind: 'inherits', target: t, line: line(clause) })
      } else if (clause.type === 'implements_clause') {
        for (const t of namedChildren(clause)) {
          const tn = typeName(t)
          if (tn) ctx.refs.push({ from: name, kind: 'implements', target: tn, line: line(t) })
        }
      }
    }
  }
  const body = node.childForFieldName('body')
  if (body) {
    let pendingDecorators: Node[] = []
    for (const m of namedChildren(body)) {
      if (m.type === 'decorator') {
        pendingDecorators.push(m)
        continue
      }
      const memberDecorators = [...pendingDecorators, ...namedChildren(m).filter((c) => c.type === 'decorator')]
      pendingDecorators = []
      if (m.type === 'method_definition' || m.type === 'abstract_method_signature' || m.type === 'method_signature') {
        const mname = m.childForFieldName('name')?.text ?? '?'
        const isStatic = namedChildren(m).some((c) => c.type === 'static') || /^\s*(public\s+|private\s+|protected\s+)?static\s/.test(m.text)
        members.push({
          name: mname,
          kind: 'method',
          visibility: visibilityOf(m, mname),
          start: line(m),
          end: endLine(m),
          cc: m.type === 'method_definition' ? tsComplexity(m) : undefined,
          type: isStatic ? 'static' : undefined,
        })
        if (mname === 'constructor') {
          const params = m.childForFieldName('parameters')
          if (params) {
            for (const p of namedChildren(params)) {
              if (p.type !== 'required_parameter' && p.type !== 'optional_parameter') continue
              const injectDec = namedChildren(p).find((c) => c.type === 'decorator' && /^inject/i.test(decoratorName(c)))
              let target: string | null = null
              if (injectDec) {
                const call = namedChildren(injectDec)[0]
                const arg = call?.childForFieldName('arguments')
                const first = arg ? namedChildren(arg)[0] : null
                if (first) target = first.type === 'identifier' || first.type === 'member_expression' ? first.text : null
              }
              if (!target) target = typeName(p.childForFieldName('type'))
              if (target && (kind === 'service' || kind === 'controller' || injectDec || firstOfType(p, 'accessibility_modifier'))) {
                ctx.refs.push({ from: name, kind: 'injects', target, line: line(p) })
              }
              const pname = p.childForFieldName('pattern')?.text
              if (pname && firstOfType(p, 'accessibility_modifier')) {
                members.push({ name: pname, kind: 'field', visibility: visibilityOf(p, pname), start: line(p), end: endLine(p), type: target ?? undefined })
              }
            }
          }
        }
      } else if (m.type === 'public_field_definition' || m.type === 'property_signature') {
        const fname = m.childForFieldName('name')?.text ?? '?'
        const ftype = typeName(m.childForFieldName('type'))
        const value = m.childForFieldName('value')
        if (value && isFunctionLike(value)) {
          members.push({ name: fname, kind: 'method', visibility: visibilityOf(m, fname), start: line(m), end: endLine(m), cc: tsComplexity(value) })
        } else {
          members.push({ name: fname, kind: 'field', visibility: visibilityOf(m, fname), start: line(m), end: endLine(m), type: ftype ?? undefined })
        }
        for (const d of memberDecorators) {
          const dn = decoratorName(d)
          if (dn in RELATION_DECORATORS) {
            // @ManyToOne(() => User, ...) — first arg is an arrow returning the target
            const call = namedChildren(d)[0]
            const args = call?.childForFieldName('arguments')
            const first = args ? namedChildren(args)[0] : null
            let target: string | null = null
            if (first?.type === 'arrow_function') {
              const b = first.childForFieldName('body')
              if (b && (b.type === 'identifier' || b.type === 'member_expression')) target = b.text
            } else if (first?.type === 'string') target = stringValue(first)
            if (!target && ftype) target = ftype
            if (target) ctx.refs.push({ from: name, kind: 'association', target, line: line(m), label: `${fname} ${RELATION_DECORATORS[dn]}` })
          }
        }
      }
    }
  }
  ctx.elements.push({
    name,
    kind,
    start: line(node),
    end: endLine(node),
    exported,
    abstract: node.type === 'abstract_class_declaration',
    members,
    decorators: decorators.length ? decorators : undefined,
  })
}

function extractInterface(node: Node, exported: boolean, ctx: Ctx) {
  const name = node.childForFieldName('name')?.text
  if (!name) return
  const members: Member[] = []
  const body = node.childForFieldName('body')
  if (body) {
    for (const m of namedChildren(body)) {
      const mname = m.childForFieldName('name')?.text
      if (!mname) continue
      if (m.type === 'method_signature') members.push({ name: mname, kind: 'method', visibility: 'public', start: line(m), end: endLine(m) })
      else if (m.type === 'property_signature')
        members.push({ name: mname, kind: 'field', visibility: 'public', start: line(m), end: endLine(m), type: typeName(m.childForFieldName('type')) ?? undefined })
    }
  }
  const ext = firstOfType(node, 'extends_type_clause')
  if (ext) for (const t of namedChildren(ext)) {
    const tn = typeName(t)
    if (tn) ctx.refs.push({ from: name, kind: 'inherits', target: tn, line: line(t) })
  }
  ctx.elements.push({ name, kind: 'interface', start: line(node), end: endLine(node), exported, members })
}

/** Handle `function f(){}` / `const f = () => {}` at module top level. */
const HOOK_WRAPPERS = /^(React\.)?(useCallback|useMemo)$/
const EFFECTS = /^(React\.)?(useEffect|useLayoutEffect|useInsertionEffect)$/

/** Handlers/effects declared at the top level of a component or hook body, measured separately. */
function innerFunctions(fn: Node): { name: string; fn: Node; decl: Node }[] {
  const body = fn.childForFieldName('body')
  if (!body || body.type !== 'statement_block') return []
  const out: { name: string; fn: Node; decl: Node }[] = []
  for (const st of namedChildren(body)) {
    if (st.type === 'function_declaration') {
      const n = st.childForFieldName('name')?.text
      if (n) out.push({ name: n, fn: st, decl: st })
    } else if (st.type === 'lexical_declaration' || st.type === 'variable_declaration') {
      for (const vd of namedChildren(st).filter((c) => c.type === 'variable_declarator')) {
        const n = vd.childForFieldName('name')
        let v = vd.childForFieldName('value')
        if (!n || n.type !== 'identifier' || !v) continue
        if (v.type === 'call_expression' && HOOK_WRAPPERS.test(v.childForFieldName('function')?.text ?? '')) {
          const args = v.childForFieldName('arguments')
          v = args ? namedChildren(args)[0] ?? null : null
        }
        if (v && isFunctionLike(v)) out.push({ name: n.text, fn: v, decl: st })
      }
    } else if (st.type === 'expression_statement') {
      const call = namedChildren(st)[0]
      if (call?.type === 'call_expression' && EFFECTS.test(call.childForFieldName('function')?.text ?? '')) {
        const args = call.childForFieldName('arguments')
        const f = args ? namedChildren(args)[0] : null
        if (f && isFunctionLike(f)) out.push({ name: `effect@L${line(st)}`, fn: f, decl: st })
      }
    }
  }
  return out
}

function reactMembers(mainName: string, fnNode: Node, declNode: Node): Member[] {
  const inner = innerFunctions(fnNode)
  const skip = new Set(inner.map((i) => i.fn.startIndex))
  const members: Member[] = [{ name: mainName, kind: 'function', visibility: 'public', start: line(declNode), end: endLine(declNode), cc: tsComplexity(fnNode, skip) }]
  for (const i of inner) members.push({ name: i.name, kind: 'function', visibility: 'private', start: line(i.decl), end: endLine(i.decl), cc: tsComplexity(i.fn) })
  return members
}

function extractFunction(name: string, fnNode: Node, declNode: Node, exported: boolean, ctx: Ctx) {
  const cc = tsComplexity(fnNode)
  if (isPascal(name) && containsJsx(fnNode)) {
    ctx.elements.push({
      name,
      kind: 'component',
      start: line(declNode),
      end: endLine(declNode),
      exported,
      members: reactMembers('render', fnNode, declNode),
    })
    collectReactRefs(name, fnNode, ctx)
    return
  }
  if (isHookName(name)) {
    ctx.elements.push({
      name,
      kind: 'hook',
      start: line(declNode),
      end: endLine(declNode),
      exported,
      members: reactMembers(name, fnNode, declNode),
    })
    collectReactRefs(name, fnNode, ctx)
    return
  }
  ctx.moduleMembers.push({ name, kind: 'function', visibility: exported ? 'public' : 'private', start: line(declNode), end: endLine(declNode), cc })
  collectReactRefs(null, fnNode, ctx)
}

function collectReactRefs(from: string | null, fn: Node, ctx: Ctx) {
  const seen = new Set<string>()
  walk(fn, (n) => {
    if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
      const nm = n.childForFieldName('name')?.text
      if (nm && /^[A-Z]/.test(nm) && from && !seen.has('r:' + nm)) {
        seen.add('r:' + nm)
        ctx.refs.push({ from, kind: 'renders', target: nm, line: line(n) })
      }
    } else if (n.type === 'call_expression') {
      const f = n.childForFieldName('function')
      if (f?.type === 'identifier' && isHookName(f.text) && from && !seen.has('h:' + f.text)) {
        seen.add('h:' + f.text)
        ctx.refs.push({ from, kind: 'uses-hook', target: f.text, line: line(n) })
      }
    }
  })
}

function handleDeclaration(decl: Node, exported: boolean, outerDecorators: Node[], ctx: Ctx) {
  switch (decl.type) {
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class':
      extractClass(decl, exported, outerDecorators, ctx)
      break
    case 'interface_declaration':
      extractInterface(decl, exported, ctx)
      break
    case 'type_alias_declaration': {
      const name = decl.childForFieldName('name')?.text
      if (!name) break
      const value = decl.childForFieldName('value')
      const members: Member[] = []
      if (value?.type === 'object_type') {
        for (const m of namedChildren(value)) {
          const mname = m.childForFieldName('name')?.text
          if (!mname) continue
          if (m.type === 'property_signature') members.push({ name: mname, kind: 'field', visibility: 'public', start: line(m), end: endLine(m), type: typeName(m.childForFieldName('type')) ?? undefined })
          else if (m.type === 'method_signature') members.push({ name: mname, kind: 'method', visibility: 'public', start: line(m), end: endLine(m) })
        }
      }
      ctx.elements.push({ name, kind: 'type', start: line(decl), end: endLine(decl), exported, members })
      break
    }
    case 'enum_declaration': {
      const name = decl.childForFieldName('name')?.text
      if (!name) break
      const body = decl.childForFieldName('body')
      const members: Member[] = body
        ? namedChildren(body)
            .filter((c) => c.type === 'property_identifier' || c.type === 'enum_assignment')
            .map((c) => ({ name: (c.childForFieldName('name') ?? c).text, kind: 'field' as const, visibility: 'public' as const, start: line(c), end: endLine(c) }))
        : []
      ctx.elements.push({ name, kind: 'enum', start: line(decl), end: endLine(decl), exported, members })
      break
    }
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = decl.childForFieldName('name')?.text
      if (name) extractFunction(name, decl, decl, exported, ctx)
      break
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const vd of namedChildren(decl).filter((c) => c.type === 'variable_declarator')) {
        const nameNode = vd.childForFieldName('name')
        const value = vd.childForFieldName('value')
        if (!nameNode || nameNode.type !== 'identifier') continue
        const name = nameNode.text
        let fn = value
        // unwrap memo(...)/forwardRef(...)/observer(...)
        if (fn && fn.type === 'call_expression') {
          const callee = fn.childForFieldName('function')?.text ?? ''
          const args = fn.childForFieldName('arguments')
          const first = args ? namedChildren(args)[0] : null
          const base = callee.split('.').pop() ?? ''
          if (['memo', 'forwardRef', 'observer', 'React.memo', 'React.forwardRef'].includes(callee) || base === 'memo' || base === 'forwardRef') {
            if (first && isFunctionLike(first)) fn = first
          } else {
            const factory = factoryKind(fn, ctx)
            if (factory) {
              ctx.elements.push({
                name,
                kind: factory,
                start: line(decl),
                end: endLine(decl),
                exported,
                members: [{ name, kind: 'function', visibility: 'public', start: line(decl), end: endLine(decl), cc: tsComplexity(fn) }],
              })
              continue
            }
          }
        }
        if (fn && isFunctionLike(fn)) {
          extractFunction(name, fn, decl, exported, ctx)
        } else if (exported) {
          ctx.moduleMembers.push({ name, kind: 'field', visibility: 'public', start: line(decl), end: endLine(decl), type: typeName(vd.childForFieldName('type')) ?? undefined })
        }
      }
      break
    }
  }
}

function factoryKind(call: Node, ctx: Ctx): 'store' | 'machine' | null {
  // create<T>()(...) / create(...) from zustand; createMachine / setup(...).createMachine from xstate
  let f = call.childForFieldName('function')
  while (f && f.type === 'call_expression') f = f.childForFieldName('function')
  const name = f?.text ?? ''
  const base = name.split('.').pop() ?? ''
  if (ctx.factories.get(name) === 'store' || ctx.factories.get(base) === 'store') return 'store'
  if (base === 'createMachine') return 'machine'
  if (ctx.factories.get(name) === 'machine') return 'machine'
  return null
}

function parseImport(n: Node, ctx: Ctx) {
  const source = stringValue(n.childForFieldName('source'))
  if (source === null) return
  const typeOnly = /^import\s+type\s/.test(n.text)
  const names: string[] = []
  const aliases: Record<string, string> = {}
  const clause = firstOfType(n, 'import_clause')
  if (clause) {
    for (const c of namedChildren(clause)) {
      if (c.type === 'identifier') {
        names.push('default')
        aliases[c.text] = 'default'
      } else if (c.type === 'named_imports') {
        for (const s of namedChildren(c).filter((x) => x.type === 'import_specifier')) {
          const imported = s.childForFieldName('name')?.text
          const local = s.childForFieldName('alias')?.text ?? imported
          if (!imported) continue
          names.push(imported)
          if (local && local !== imported) aliases[local] = imported
        }
      } else if (c.type === 'namespace_import') {
        const id = firstOfType(c, 'identifier')?.text
        names.push('*')
        if (id) aliases[id] = '*'
      }
    }
  }
  if (source === 'zustand' || source.startsWith('zustand/')) {
    for (const nm of names) ctx.factories.set(Object.entries(aliases).find(([, v]) => v === nm)?.[0] ?? nm, 'store')
  }
  ctx.imports.push({ spec: source, names, aliases: Object.keys(aliases).length ? aliases : undefined, kind: typeOnly ? 'type-only' : 'import', line: line(n) })
}

export async function extractTypeScript(relPath: string, source: string, hash: string): Promise<FileFacts> {
  const grammar = /\.[cm]?[jt]sx$/.test(relPath) || /\.jsx?$/.test(relPath) ? 'tsx' : 'typescript'
  const parser = await getParser(grammar)
  const tree = parser.parse(source)
  if (!tree) throw new Error('parse failed: ' + relPath)
  const root = tree.rootNode
  const ctx: Ctx = { elements: [], refs: [], imports: [], moduleMembers: [], factories: new Map() }

  let pendingDecorators: Node[] = []
  for (const stmt of namedChildren(root)) {
    if (stmt.type === 'decorator') {
      pendingDecorators.push(stmt)
      continue
    }
    const decs = pendingDecorators
    pendingDecorators = []
    if (stmt.type === 'import_statement') parseImport(stmt, ctx)
    else if (stmt.type === 'export_statement') {
      const decl = stmt.childForFieldName('declaration')
      const src = stringValue(stmt.childForFieldName('source'))
      const exportDecorators = [...decs, ...namedChildren(stmt).filter((c) => c.type === 'decorator')]
      if (decl) handleDeclaration(decl, true, exportDecorators, ctx)
      else if (src !== null) {
        const clause = firstOfType(stmt, 'export_clause')
        const names = clause
          ? namedChildren(clause)
              .filter((s) => s.type === 'export_specifier')
              .map((s) => s.childForFieldName('name')?.text ?? '')
              .filter(Boolean)
          : ['*']
        ctx.imports.push({ spec: src, names, kind: 'reexport', line: line(stmt) })
      } else {
        // export default <expr> / export default function
        const value = stmt.childForFieldName('value') ?? namedChildren(stmt).find((c) => c.type !== 'decorator' && c.type !== 'comment')
        if (value && isFunctionLike(value)) {
          const name = value.childForFieldName('name')?.text ?? 'default'
          extractFunction(name, value, stmt, true, ctx)
        } else if (value && (value.type === 'class' || value.type === 'class_declaration')) {
          extractClass(value, true, exportDecorators, ctx)
        }
      }
    } else if (stmt.type === 'expression_statement') {
      // top-level side effects: require() calls handled below
    } else {
      handleDeclaration(stmt, false, decs, ctx)
    }
  }

  // dynamic import() and require('x') anywhere
  for (const call of descendantsOfType(root, 'call_expression')) {
    const f = call.childForFieldName('function')
    if (!f) continue
    if (f.type === 'import' || f.text === 'require') {
      const args = call.childForFieldName('arguments')
      const spec = stringValue(args ? namedChildren(args)[0] ?? null : null)
      if (spec) ctx.imports.push({ spec, names: ['*'], kind: 'import', line: line(call) })
    }
  }

  // recover imports the parser lost inside ERROR regions (e.g. `importOriginal<typeof import('x')>()` in TSX)
  if (root.hasError) {
    const have = new Set(ctx.imports.map((i) => i.spec))
    const re = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm
    for (const m of source.matchAll(re)) {
      const spec = m[3]
      if (have.has(spec)) continue
      have.add(spec)
      const lineNo = source.slice(0, m.index).split('\n').length
      ctx.imports.push({ spec, names: ['*'], kind: m[2] ? 'type-only' : m[1] === 'export' ? 'reexport' : 'import', line: lineNo })
    }
  }

  const base = relPath.split('/').pop()!.replace(/\.[^.]+$/, '')
  const elements = ctx.elements
  if (ctx.moduleMembers.length || elements.length === 0) {
    elements.unshift({ name: base, kind: 'module', start: 1, end: endLine(root), exported: true, members: ctx.moduleMembers })
  }
  return {
    path: relPath,
    lang: 'typescript',
    hash,
    loc: source.split('\n').length,
    isTest: isTsTestFile(relPath),
    elements,
    imports: ctx.imports,
    refs: ctx.refs,
    parseError: root.hasError || undefined,
  }
}
