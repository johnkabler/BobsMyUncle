import type { Element, ElementKind, FileFacts, Member, NameRef, RawImport, Visibility } from '../core/model.js'
import { getParser, line, endLine, walk, namedChildren, firstOfType, descendantsOfType, type Node } from './treesitter.js'

const DECISIONS = new Set([
  'if_statement',
  'elif_clause',
  'for_statement',
  'while_statement',
  'except_clause',
  'conditional_expression',
  'case_clause',
  'for_in_clause',
  'if_clause',
])

export function pyComplexity(node: Node): number {
  let cc = 1
  walk(node, (n) => {
    if (DECISIONS.has(n.type)) cc++
    else if (n.type === 'boolean_operator') cc++
  })
  return cc
}

/** test_*.py, *_test.py, conftest.py, or anything under a tests/ or test/ directory. */
export const isPyTestFile = (p: string): boolean => {
  const base = p.split('/').pop() ?? p
  if (base === 'conftest.py') return true
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) return true
  return /(^|\/)(tests|test)\//.test(p)
}

const isPascal = (s: string) => /^[A-Z][A-Za-z0-9_]*$/.test(s)
const isUpperConst = (s: string) => /^[A-Z][A-Z0-9_]*$/.test(s)

const BUILTIN_TYPE_NAMES = new Set([
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'dict',
  'list',
  'set',
  'tuple',
  'frozenset',
  'type',
  'object',
  'None',
  'Any',
  'Optional',
  'Union',
  'Literal',
  'Final',
  'ClassVar',
  'Annotated',
  'Self',
  'Type',
  'TypeVar',
  'Generic',
  'Protocol',
  'Callable',
  'Iterable',
  'Iterator',
  'Sequence',
  'Mapping',
  'MutableMapping',
  'Awaitable',
  'Coroutine',
  'datetime',
  'date',
  'time',
  'timedelta',
  'Decimal',
  'UUID',
  'Path',
  'Enum',
  'StrEnum',
  'IntEnum',
  'BaseModel',
  'ABC',
  'Model',
])

const SKIP_BASE_NAMES = new Set(['object', 'Protocol', 'ABC', 'Generic', 'type'])
const SKIP_BASE_QUALIFIED = new Set([
  'typing.Protocol',
  'typing_extensions.Protocol',
  'abc.ABC',
  'typing.Generic',
])

const PROTOCOL_BASES = new Set(['Protocol', 'typing.Protocol', 'typing_extensions.Protocol'])
const ABC_BASES = new Set(['ABC', 'abc.ABC'])
const ENUM_BASES = new Set(['Enum', 'StrEnum', 'IntEnum', 'enum.Enum', 'enum.StrEnum', 'enum.IntEnum'])
const ENTITY_BASE_ENDS = new Set(['Model', 'DeclarativeBase', 'Base'])
const DJANGO_REL: Record<string, string> = {
  ForeignKey: '*..1',
  OneToOneField: '1..1',
  ManyToManyField: '*..*',
}
const PROVIDER_KINDS = new Set(['Factory', 'Singleton', 'Resource', 'Callable'])

interface Ctx {
  elements: Element[]
  refs: NameRef[]
  imports: RawImport[]
  moduleMembers: Member[]
  hasClass: boolean
}

function stringLiteralValue(n: Node | null): string | null {
  if (!n) return null
  if (n.type === 'string') {
    const content = firstOfType(n, 'string_content')
    if (content) return content.text
    // fallback: strip quotes / prefixes
    const t = n.text
    const m = t.match(/^[a-zA-Z]*['"](.*)['"]$/s)
    return m ? m[1]! : t.slice(1, -1)
  }
  return null
}

function dottedText(n: Node | null): string | null {
  if (!n) return null
  if (n.type === 'identifier' || n.type === 'dotted_name' || n.type === 'attribute') return n.text
  if (n.type === 'subscript') {
    const v = n.childForFieldName('value') ?? namedChildren(n)[0]
    return dottedText(v)
  }
  return n.text
}

/** Strip Generic[...] / subscript; keep last simple or dotted base name. */
function baseName(n: Node): string {
  if (n.type === 'subscript') {
    const v = n.childForFieldName('value') ?? namedChildren(n)[0]
    return v ? baseName(v) : n.text
  }
  return n.text
}

function shouldSkipBase(name: string): boolean {
  if (SKIP_BASE_NAMES.has(name)) return true
  if (SKIP_BASE_QUALIFIED.has(name)) return true
  const simple = name.split('.').pop() ?? name
  if (simple === 'Generic') return true
  if (simple === 'object') return true
  return false
}

function visibilityOf(name: string): Visibility {
  if (name.startsWith('__') && !name.endsWith('__')) return 'private'
  if (name.startsWith('_')) return 'protected'
  return 'public'
}

function moduleVisibility(name: string): Visibility {
  return name.startsWith('_') ? 'protected' : 'public'
}

function decoratorName(d: Node): string {
  // decorator: "@" + (identifier | attribute | call)
  const expr = namedChildren(d)[0]
  if (!expr) return d.text.replace(/^@/, '')
  if (expr.type === 'call') {
    const f = expr.childForFieldName('function')
    return f?.text ?? expr.text
  }
  return expr.text
}

function isToolDecorator(dn: string): boolean {
  return /(^|\.)(tool|resource|prompt)(\(|$)/.test(dn) || /\.(tool|resource|prompt)$/.test(dn)
}

function isRouteDecorator(dn: string): boolean {
  // router.get / app.post / api.patch etc.
  return /^(router|app|api)\.(get|post|put|patch|delete|head|options|trace)(\(|$)/.test(dn)
}

function moduleElementName(relPath: string): string {
  const parts = relPath.split('/')
  const base = parts[parts.length - 1] ?? relPath
  if (base === '__init__.py') {
    return parts.length >= 2 ? parts[parts.length - 2]! : '__init__'
  }
  return base.replace(/\.py$/, '')
}

function isTypeCheckingCondition(cond: Node | null): boolean {
  if (!cond) return false
  const t = cond.text
  return t === 'TYPE_CHECKING' || t.endsWith('.TYPE_CHECKING')
}

function collectImports(root: Node, ctx: Ctx) {
  // Walk statements; track TYPE_CHECKING blocks at any nesting of if.
  const visitBlock = (nodes: Node[], typeOnly: boolean) => {
    for (const stmt of nodes) {
      if (stmt.type === 'future_import_statement') continue
      if (stmt.type === 'import_statement' || stmt.type === 'import_from_statement') {
        parseImport(stmt, ctx, typeOnly)
        continue
      }
      if (stmt.type === 'if_statement') {
        const cond = stmt.childForFieldName('condition')
        const blockTypeOnly = typeOnly || isTypeCheckingCondition(cond)
        const consequence = stmt.childForFieldName('consequence')
        if (consequence) visitBlock(namedChildren(consequence), blockTypeOnly)
        // elif / else
        for (const alt of namedChildren(stmt).filter((c) => c.type === 'elif_clause' || c.type === 'else_clause')) {
          const altCond = alt.type === 'elif_clause' ? alt.childForFieldName('condition') : null
          const altTypeOnly = typeOnly || isTypeCheckingCondition(altCond)
          const body = alt.childForFieldName('consequence') ?? firstOfType(alt, 'block')
          if (body) visitBlock(namedChildren(body), altTypeOnly)
        }
        continue
      }
      // Nested functions / classes: still collect imports inside (kind import unless already typeOnly)
      if (stmt.type === 'function_definition' || stmt.type === 'class_definition') {
        const body = stmt.childForFieldName('body')
        if (body) visitBlock(namedChildren(body), typeOnly)
        continue
      }
      if (stmt.type === 'decorated_definition') {
        const def = stmt.childForFieldName('definition')
        if (def) {
          const body = def.childForFieldName('body')
          if (body) visitBlock(namedChildren(body), typeOnly)
        }
        continue
      }
      // try/with/for/while/match: recurse into bodies so nested imports are found
      const body = stmt.childForFieldName('body') ?? firstOfType(stmt, 'block')
      if (body && body.type === 'block') visitBlock(namedChildren(body), typeOnly)
      for (const c of namedChildren(stmt)) {
        if (c.type === 'block') visitBlock(namedChildren(c), typeOnly)
        if (c.type === 'except_clause' || c.type === 'else_clause' || c.type === 'finally_clause' || c.type === 'case_clause') {
          const b = c.childForFieldName('consequence') ?? firstOfType(c, 'block')
          if (b) visitBlock(namedChildren(b), typeOnly)
        }
      }
    }
  }
  visitBlock(namedChildren(root), false)
}

function parseImport(n: Node, ctx: Ctx, typeOnly: boolean) {
  if (n.type === 'import_statement') {
    // import a.b.c  |  import a.b as x  |  import a, b as c
    for (const child of namedChildren(n)) {
      if (child.type === 'dotted_name') {
        ctx.imports.push({
          spec: child.text,
          names: ['*'],
          kind: typeOnly ? 'type-only' : 'import',
          line: line(n),
        })
      } else if (child.type === 'aliased_import') {
        const name = child.childForFieldName('name')
        const alias = child.childForFieldName('alias')
        if (!name) continue
        const aliases: Record<string, string> = {}
        if (alias) aliases[alias.text] = name.text
        ctx.imports.push({
          spec: name.text,
          names: ['*'],
          aliases: Object.keys(aliases).length ? aliases : undefined,
          kind: typeOnly ? 'type-only' : 'import',
          line: line(n),
        })
      }
    }
    return
  }
  if (n.type === 'import_from_statement') {
    const moduleName = n.childForFieldName('module_name')
    let spec = ''
    let level: number | undefined
    if (moduleName?.type === 'relative_import') {
      const prefix = firstOfType(moduleName, 'import_prefix')
      level = prefix ? prefix.text.length : 0
      const dotted = firstOfType(moduleName, 'dotted_name')
      spec = dotted?.text ?? ''
    } else if (moduleName) {
      spec = moduleName.text
    }
    // from __future__ already handled as future_import_statement; double-check
    if (spec === '__future__') return

    const names: string[] = []
    const aliases: Record<string, string> = {}
    // named children: module_name then name fields (dotted_name | aliased_import | wildcard_import).
    // Node wrappers are not referentially equal across childForFieldName/namedChild, so skip by span.
    const modStart = moduleName?.startIndex
    const modEnd = moduleName?.endIndex
    for (const child of namedChildren(n)) {
      if (moduleName && child.startIndex === modStart && child.endIndex === modEnd) continue
      if (child.type === 'relative_import') continue
      if (child.type === 'dotted_name' || child.type === 'identifier') {
        names.push(child.text)
      } else if (child.type === 'aliased_import') {
        const name = child.childForFieldName('name')
        const alias = child.childForFieldName('alias')
        if (!name) continue
        names.push(name.text)
        if (alias && alias.text !== name.text) aliases[alias.text] = name.text
      } else if (child.type === 'wildcard_import') {
        names.push('*')
      }
    }
    const imp: RawImport = {
      spec,
      names: names.length ? names : ['*'],
      kind: typeOnly ? 'type-only' : 'import',
      line: line(n),
    }
    if (Object.keys(aliases).length) imp.aliases = aliases
    if (level !== undefined && level > 0) imp.level = level
    ctx.imports.push(imp)
  }
}

/** Extract project-ish type target from an annotation type node. */
function projectTypeTarget(typeNode: Node | null): string | null {
  if (!typeNode) return null
  // unwrap `type` wrapper
  let n = typeNode
  if (n.type === 'type') n = namedChildren(n)[0] ?? n

  // string forward ref
  if (n.type === 'string') {
    const v = stringLiteralValue(n)
    if (!v) return null
    const last = v.split('.').pop() ?? v
    return isPascal(last) && !BUILTIN_TYPE_NAMES.has(last) ? last : null
  }

  // User | None  /  None | User
  if (n.type === 'binary_operator' && n.text.includes('|')) {
    for (const c of namedChildren(n)) {
      if (c.type === 'none') continue
      const t = projectTypeTarget(c)
      if (t) return t
    }
    return null
  }

  // Optional[X], list[X], list[X] via generic_type or subscript
  if (n.type === 'generic_type' || n.type === 'subscript') {
    const head = n.type === 'subscript' ? n.childForFieldName('value') ?? namedChildren(n)[0] : namedChildren(n)[0]
    const headName = head ? (head.type === 'attribute' ? head.text.split('.').pop()! : head.text) : ''
    // type parameters
    const params: Node[] = []
    if (n.type === 'generic_type') {
      const tp = firstOfType(n, 'type_parameter')
      if (tp) for (const c of namedChildren(tp)) params.push(c)
    } else {
      // subscript: value [ index... ]
      for (const c of namedChildren(n).slice(1)) params.push(c)
    }
    if (headName === 'Optional' || headName === 'list' || headName === 'List' || headName === 'Sequence' || headName === 'Iterable') {
      for (const p of params) {
        const t = projectTypeTarget(p)
        if (t) return t
      }
      return null
    }
    if (headName === 'Union') {
      for (const p of params) {
        const t = projectTypeTarget(p)
        if (t) return t
      }
      return null
    }
    // Annotated[User, ...] — first type param
    if (headName === 'Annotated') {
      if (params[0]) return projectTypeTarget(params[0])
      return null
    }
    // bare Generic-like Capitalized head (e.g. Order) — treat head if Pascal
    if (head && (head.type === 'identifier' || head.type === 'attribute')) {
      const simple = head.text.split('.').pop()!
      if (isPascal(simple) && !BUILTIN_TYPE_NAMES.has(simple)) return simple
    }
    // dict[str, Order] — prefer value-side Capitalized
    for (const p of params) {
      const t = projectTypeTarget(p)
      if (t) return t
    }
    return null
  }

  if (n.type === 'identifier') {
    if (isPascal(n.text) && !BUILTIN_TYPE_NAMES.has(n.text)) return n.text
    return null
  }
  if (n.type === 'attribute' || n.type === 'dotted_name') {
    const simple = n.text.split('.').pop()!
    if (isPascal(simple) && !BUILTIN_TYPE_NAMES.has(simple)) return simple
    return null
  }
  return null
}

function firstCallArgTarget(call: Node): string | null {
  const args = call.childForFieldName('arguments')
  if (!args) return null
  for (const a of namedChildren(args)) {
    if (a.type === 'keyword_argument') continue
    if (a.type === 'identifier' || a.type === 'attribute' || a.type === 'dotted_name') return a.text
    if (a.type === 'string') {
      const v = stringLiteralValue(a)
      if (!v) return null
      return v.split('.').pop() ?? v
    }
    return null
  }
  return null
}

function extractClass(classNode: Node, decorators: string[], ctx: Ctx) {
  const name = classNode.childForFieldName('name')?.text
  if (!name) return
  ctx.hasClass = true

  let kind: ElementKind = 'class'
  let abstract = false
  const supers = classNode.childForFieldName('superclasses')
  const baseNodes = supers ? namedChildren(supers) : []

  for (const b of baseNodes) {
    const full = baseName(b)
    const simple = full.split('.').pop() ?? full

    if (PROTOCOL_BASES.has(full) || PROTOCOL_BASES.has(simple)) kind = 'interface'
    else if (ABC_BASES.has(full) || ABC_BASES.has(simple)) {
      kind = 'interface'
      abstract = true
    } else if (ENUM_BASES.has(full) || ENUM_BASES.has(simple)) kind = 'enum'
    else if (full.endsWith('DeclarativeContainer') || simple.endsWith('DeclarativeContainer')) kind = 'container'
    else if (
      full === 'models.Model' ||
      simple === 'Model' ||
      full.endsWith('.Model') ||
      simple === 'DeclarativeBase' ||
      full === 'DeclarativeBase' ||
      full.endsWith('.DeclarativeBase') ||
      simple === 'Base' ||
      full === 'Base' ||
      full.endsWith('.Base')
    ) {
      // Prefer entity over class when ORM base present (don't override interface/enum/container)
      if (kind === 'class') kind = 'entity'
    }

    if (!shouldSkipBase(full) && !shouldSkipBase(simple)) {
      // skip Protocol/ABC/object/Generic for refs
      if (
        PROTOCOL_BASES.has(full) ||
        PROTOCOL_BASES.has(simple) ||
        ABC_BASES.has(full) ||
        ABC_BASES.has(simple) ||
        simple === 'Generic' ||
        full.startsWith('Generic')
      ) {
        // skip ref
      } else {
        ctx.refs.push({ from: name, kind: 'inherits', target: full, line: line(b) })
      }
    }
  }

  // dataclass stays class (already default)
  const members: Member[] = []
  const body = classNode.childForFieldName('body')
  if (body) {
    for (const stmt of namedChildren(body)) {
      extractClassBodyStmt(stmt, name, kind, members, ctx)
    }
  }

  ctx.elements.push({
    name,
    kind,
    start: line(classNode),
    end: endLine(classNode),
    exported: true,
    abstract: abstract || undefined,
    members,
    decorators: decorators.length ? decorators : undefined,
  })
}

function extractClassBodyStmt(stmt: Node, className: string, classKind: ElementKind, members: Member[], ctx: Ctx) {
  if (stmt.type === 'decorated_definition') {
    const decs = namedChildren(stmt)
      .filter((c) => c.type === 'decorator')
      .map(decoratorName)
    const def = stmt.childForFieldName('definition')
    if (!def) return
    if (def.type === 'function_definition') {
      extractMethod(def, decs, members)
    } else if (def.type === 'class_definition') {
      // nested class — treat as nested element
      extractClass(def, decs, ctx)
    }
    return
  }
  if (stmt.type === 'function_definition') {
    extractMethod(stmt, [], members)
    return
  }
  if (stmt.type === 'expression_statement') {
    const assign = firstOfType(stmt, 'assignment') ?? (namedChildren(stmt)[0]?.type === 'assignment' ? namedChildren(stmt)[0]! : null)
    if (!assign) return
    extractField(assign, className, classKind, members, ctx)
  }
}

function extractMethod(fn: Node, decorators: string[], members: Member[]) {
  const name = fn.childForFieldName('name')?.text
  if (!name) return
  const isProperty = decorators.some((d) => d === 'property' || d.endsWith('.property'))
  members.push({
    name,
    kind: isProperty ? 'field' : 'method',
    visibility: visibilityOf(name),
    start: line(fn),
    end: endLine(fn),
    cc: isProperty ? undefined : pyComplexity(fn),
  })
}

function extractField(assign: Node, className: string, classKind: ElementKind, members: Member[], ctx: Ctx) {
  const left = assign.childForFieldName('left')
  if (!left || left.type !== 'identifier') return
  const fname = left.text
  const typeNode = assign.childForFieldName('type')
  const value = assign.childForFieldName('right') ?? assign.childForFieldName('value')
  const typeText = typeNode?.text

  members.push({
    name: fname,
    kind: 'field',
    visibility: visibilityOf(fname),
    start: line(assign),
    end: endLine(assign),
    type: typeText,
  })

  // Django relation fields
  if (value && value.type === 'call') {
    const fn = value.childForFieldName('function')
    const fnText = fn?.text ?? ''
    const simple = fnText.split('.').pop() ?? fnText
    if (simple in DJANGO_REL) {
      const target = firstCallArgTarget(value)
      if (target) {
        const last = target.split('.').pop() ?? target
        ctx.refs.push({
          from: className,
          kind: 'association',
          target: last,
          line: line(assign),
          label: `${fname} ${DJANGO_REL[simple]}`,
        })
      }
      return
    }
    // dependency-injector providers inside container
    if (classKind === 'container') {
      const provider = fnText.split('.').pop() ?? ''
      if (PROVIDER_KINDS.has(provider) || (fnText.includes('providers.') && PROVIDER_KINDS.has(provider))) {
        const target = firstCallArgTarget(value)
        if (target) {
          ctx.refs.push({ from: className, kind: 'injects', target, line: line(assign) })
        }
        return
      }
    }
  }

  // Pydantic/dataclass annotated association to project types
  if (typeNode) {
    const target = projectTypeTarget(typeNode)
    if (target) {
      ctx.refs.push({ from: className, kind: 'association', target, line: line(assign) })
    }
  }
}

function extractTopLevelFunction(fn: Node, decorators: string[], ctx: Ctx) {
  const name = fn.childForFieldName('name')?.text
  if (!name) return
  let kind: Member['kind'] = 'function'
  if (decorators.some(isToolDecorator)) kind = 'tool'
  else if (decorators.some(isRouteDecorator)) kind = 'route'
  ctx.moduleMembers.push({
    name,
    kind,
    visibility: moduleVisibility(name),
    start: line(fn),
    end: endLine(fn),
    cc: pyComplexity(fn),
  })
}

function extractTopLevelAssignment(assign: Node, ctx: Ctx) {
  const left = assign.childForFieldName('left')
  if (!left || left.type !== 'identifier') return
  const name = left.text
  if (moduleVisibility(name) !== 'public') return
  const typeNode = assign.childForFieldName('type')
  const isAnnotated = !!typeNode
  if (!isAnnotated && !isUpperConst(name)) return
  ctx.moduleMembers.push({
    name,
    kind: 'field',
    visibility: 'public',
    start: line(assign),
    end: endLine(assign),
    type: typeNode?.text,
  })
}

function handleTopLevel(stmt: Node, ctx: Ctx) {
  if (stmt.type === 'decorated_definition') {
    const decs = namedChildren(stmt)
      .filter((c) => c.type === 'decorator')
      .map(decoratorName)
    const def = stmt.childForFieldName('definition')
    if (!def) return
    if (def.type === 'class_definition') extractClass(def, decs, ctx)
    else if (def.type === 'function_definition') extractTopLevelFunction(def, decs, ctx)
    return
  }
  if (stmt.type === 'class_definition') {
    extractClass(stmt, [], ctx)
    return
  }
  if (stmt.type === 'function_definition') {
    extractTopLevelFunction(stmt, [], ctx)
    return
  }
  if (stmt.type === 'expression_statement') {
    const assign = firstOfType(stmt, 'assignment')
    if (assign) extractTopLevelAssignment(assign, ctx)
  }
}

export async function extractPython(relPath: string, source: string, hash: string): Promise<FileFacts> {
  const parser = await getParser('python')
  const tree = parser.parse(source)
  if (!tree) throw new Error('parse failed: ' + relPath)
  const root = tree.rootNode
  const ctx: Ctx = { elements: [], refs: [], imports: [], moduleMembers: [], hasClass: false }

  collectImports(root, ctx)

  for (const stmt of namedChildren(root)) {
    // skip imports — already collected
    if (
      stmt.type === 'import_statement' ||
      stmt.type === 'import_from_statement' ||
      stmt.type === 'future_import_statement'
    ) {
      continue
    }
    handleTopLevel(stmt, ctx)
  }

  const modName = moduleElementName(relPath)
  const elements = ctx.elements
  if (ctx.moduleMembers.length || !ctx.hasClass) {
    elements.unshift({
      name: modName,
      kind: 'module',
      start: 1,
      end: endLine(root),
      exported: true,
      members: ctx.moduleMembers,
    })
  }

  return {
    path: relPath,
    lang: 'python',
    hash,
    loc: source.split('\n').length,
    isTest: isPyTestFile(relPath),
    elements,
    imports: ctx.imports,
    refs: ctx.refs,
    parseError: root.hasError || undefined,
  }
}
