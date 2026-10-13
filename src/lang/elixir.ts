import type { Element, ElementKind, FileFacts, Member, NameRef, RawImport, Visibility } from '../core/model.js'
import { getParser, line, endLine, walk, namedChildren, firstOfType, type Node } from './treesitter.js'

const DEF_FORMS = new Set(['def', 'defp', 'defmacro', 'defmacrop', 'defdelegate'])
const PRIVATE_FORMS = new Set(['defp', 'defmacrop'])
const MACRO_FORMS = new Set(['defmacro', 'defmacrop'])
const BRANCH_CALLS = new Set(['case', 'cond', 'receive', 'with', 'try'])
const IF_CALLS = new Set(['if', 'unless'])
const LOGICAL_OPS = new Set(['and', 'or', '&&', '||'])
const ASSOC_LABELS: Record<string, string> = {
  belongs_to: '*..1',
  has_many: '1..*',
  has_one: '1..1',
  many_to_many: '*..*',
  embeds_one: '1..1',
  embeds_many: '1..*',
}

export const isExTestFile = (p: string): boolean => {
  const norm = p.replace(/\\/g, '/')
  if (/(^|\/)test\//.test(norm)) return true
  return /_test\.exs$/.test(norm)
}

/** tree-sitter-elixir: `call` only has field `target`; args/do_block are plain named children. */
function callArgs(n: Node): Node | null {
  return firstOfType(n, 'arguments')
}
function callDo(n: Node): Node | null {
  return firstOfType(n, 'do_block')
}

function opText(n: Node): string | null {
  return n.childForFieldName('operator')?.text ?? null
}

function countStabClauses(n: Node): number {
  let count = 0
  walk(n, (c) => {
    if (c.type === 'stab_clause') count++
  })
  return count
}

/** Cyclomatic complexity for an Elixir AST subtree (function body / expression). */
export function exComplexity(node: Node): number {
  let cc = 1
  walk(node, (n) => {
    if (n.type === 'call') {
      const t = n.childForFieldName('target')
      const name = t?.type === 'identifier' ? t.text : null
      if (name && IF_CALLS.has(name)) {
        cc++
      } else if (name && BRANCH_CALLS.has(name)) {
        const stabs = countStabClauses(n)
        if (stabs > 1) cc += stabs - 1
        if (name === 'with') {
          const args = callArgs(n)
          if (args) {
            let arrows = 0
            for (const a of namedChildren(args)) {
              if (a.type === 'binary_operator' && opText(a) === '<-') arrows++
            }
            if (arrows > 1) cc += arrows - 1
          }
        }
      }
    } else if (n.type === 'binary_operator') {
      const op = opText(n)
      if (op && LOGICAL_OPS.has(op)) cc++
      else if (op === 'when') cc++
    } else if (n.type === 'anonymous_function') {
      const stabs = namedChildren(n).filter((c) => c.type === 'stab_clause').length
      if (stabs > 1) cc += stabs - 1
    }
  })
  return cc
}

function callTargetName(n: Node): string | null {
  if (n.type !== 'call') return null
  const t = n.childForFieldName('target')
  if (!t) return null
  if (t.type === 'identifier') return t.text
  return null
}

function atomText(n: Node | null): string | null {
  if (!n) return null
  if (n.type === 'atom') {
    const t = n.text
    return t.startsWith(':') ? t.slice(1) : t
  }
  return null
}

function keywordKey(n: Node): string | null {
  if (n.type !== 'keyword') return null
  return n.text.replace(/\s*$/, '').replace(/:$/, '')
}

function shortNameOf(fq: string): string {
  const parts = fq.split('.')
  return parts[parts.length - 1]!
}

function expandAliasPath(path: string, currentModule: string, aliases: Map<string, string>): string {
  if (path === '__MODULE__') return currentModule
  if (path.startsWith('__MODULE__.')) return currentModule + path.slice('__MODULE__'.length)
  const parts = path.split('.')
  const first = parts[0]!
  const mapped = aliases.get(first)
  if (mapped) return [mapped, ...parts.slice(1)].join('.')
  return path
}

function resolveModuleExpr(n: Node | null, currentModule: string, aliases: Map<string, string>): string | null {
  if (!n) return null
  if (n.type === 'alias') return expandAliasPath(n.text, currentModule, aliases)
  if (n.type === 'identifier') {
    if (n.text === '__MODULE__') return currentModule
    if (/^[A-Z]/.test(n.text)) return expandAliasPath(n.text, currentModule, aliases)
    return null
  }
  if (n.type === 'dot') {
    const left = n.childForFieldName('left')
    const right = n.childForFieldName('right')
    if (!left || !right) return null
    const leftName = resolveModuleExpr(left, currentModule, aliases)
    if (!leftName) return null
    if (right.type === 'alias' || right.type === 'identifier') return `${leftName}.${right.text}`
    return null
  }
  return null
}

interface AliasEntry {
  short: string
  full: string
}

function parseAliasCall(n: Node, currentModule: string, aliases: Map<string, string>): AliasEntry[] {
  const args = callArgs(n)
  if (!args) return []
  const kids = namedChildren(args)
  if (kids.length === 0) return []

  let asName: string | null = null
  for (const k of kids) {
    if (k.type !== 'keywords') continue
    for (const pair of namedChildren(k)) {
      if (pair.type !== 'pair') continue
      const key = pair.childForFieldName('key')
      const val = pair.childForFieldName('value')
      if (key && keywordKey(key) === 'as' && val) {
        asName = val.type === 'alias' || val.type === 'identifier' ? val.text : null
      }
    }
  }

  const first = kids[0]!
  const out: AliasEntry[] = []

  if (first.type === 'alias') {
    const full = expandAliasPath(first.text, currentModule, aliases)
    out.push({ short: asName ?? shortNameOf(full), full })
  } else if (first.type === 'dot') {
    const left = first.childForFieldName('left')
    const right = first.childForFieldName('right')
    if (right?.type === 'tuple' && left) {
      const base = resolveModuleExpr(left, currentModule, aliases)
      if (base) {
        for (const item of namedChildren(right)) {
          if (item.type === 'alias') {
            const full = `${base}.${item.text}`
            out.push({ short: shortNameOf(item.text), full })
          }
        }
      }
    } else {
      const full = resolveModuleExpr(first, currentModule, aliases)
      if (full) out.push({ short: asName ?? shortNameOf(full), full })
    }
  } else if (first.type === 'identifier' && first.text === '__MODULE__') {
    out.push({ short: asName ?? shortNameOf(currentModule), full: currentModule })
  }

  return out
}

function arityOfArgs(argsNode: Node | null): number {
  if (!argsNode) return 0
  return namedChildren(argsNode).length
}

interface DefHead {
  name: string
  arity: number
  guardCount: number
}

function parseDefHead(defCall: Node): DefHead | null {
  const args = callArgs(defCall)
  if (!args) return null
  const originalHead = namedChildren(args)[0]
  if (!originalHead) return null

  let guardCount = 0
  walk(originalHead, (c) => {
    if (c.type === 'binary_operator' && opText(c) === 'when') guardCount++
  })

  let head: Node = originalHead
  while (head.type === 'binary_operator' && opText(head) === 'when') {
    head = head.childForFieldName('left')!
  }

  if (head.type === 'identifier') {
    return { name: head.text, arity: 0, guardCount }
  }
  if (head.type === 'call') {
    const t = head.childForFieldName('target')
    if (!t || t.type !== 'identifier') return null
    return {
      name: t.text,
      arity: arityOfArgs(callArgs(head)),
      guardCount,
    }
  }
  return null
}

function defBody(defCall: Node): Node | null {
  const doBlock = callDo(defCall)
  if (doBlock) return doBlock
  const args = callArgs(defCall)
  if (!args) return null
  for (const k of namedChildren(args)) {
    if (k.type !== 'keywords') continue
    for (const pair of namedChildren(k)) {
      if (pair.type !== 'pair') continue
      const key = pair.childForFieldName('key')
      if (key && keywordKey(key) === 'do') return pair.childForFieldName('value')
    }
  }
  return null
}

function clauseComplexity(defCall: Node): number {
  const body = defBody(defCall)
  const bodyCc = body ? exComplexity(body) : 1
  const head = parseDefHead(defCall)
  return bodyCc + (head?.guardCount ?? 0)
}

interface PendingClause {
  name: string
  arity: number
  start: number
  end: number
  cc: number
  kind: 'function' | 'macro'
  visibility: Visibility
}

function mergeClauses(clauses: PendingClause[]): Member[] {
  const map = new Map<string, PendingClause & { clauseCount: number }>()
  for (const c of clauses) {
    const key = `${c.name}/${c.arity}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { ...c, clauseCount: 1 })
    } else {
      existing.end = Math.max(existing.end, c.end)
      existing.start = Math.min(existing.start, c.start)
      existing.cc += c.cc
      existing.clauseCount++
      if (c.visibility === 'private') existing.visibility = 'private'
      if (c.kind === 'macro') existing.kind = 'macro'
    }
  }
  return [...map.values()].map((c) => ({
    name: `${c.name}/${c.arity}`,
    kind: c.kind,
    visibility: c.visibility,
    start: c.start,
    end: c.end,
    cc: c.cc + (c.clauseCount - 1),
    arity: c.arity,
  }))
}

function parseDefstructFields(argsNode: Node): Member[] {
  const members: Member[] = []
  for (const a of namedChildren(argsNode)) {
    if (a.type === 'list') {
      for (const item of namedChildren(a)) {
        if (item.type === 'atom') {
          members.push({
            name: atomText(item) ?? item.text,
            kind: 'field',
            visibility: 'public',
            start: line(item),
            end: endLine(item),
          })
        } else if (item.type === 'keywords') {
          for (const pair of namedChildren(item)) {
            if (pair.type !== 'pair') continue
            const key = pair.childForFieldName('key')
            if (key) {
              members.push({
                name: keywordKey(key) ?? key.text,
                kind: 'field',
                visibility: 'public',
                start: line(pair),
                end: endLine(pair),
              })
            }
          }
        }
      }
    } else if (a.type === 'keywords') {
      for (const pair of namedChildren(a)) {
        if (pair.type !== 'pair') continue
        const key = pair.childForFieldName('key')
        if (key) {
          members.push({
            name: keywordKey(key) ?? key.text,
            kind: 'field',
            visibility: 'public',
            start: line(pair),
            end: endLine(pair),
          })
        }
      }
    }
  }
  return members
}

function parseCallback(unary: Node): Member | null {
  const call = unary.childForFieldName('operand')
  if (!call || call.type !== 'call') return null
  if (callTargetName(call) !== 'callback') return null
  const args = callArgs(call)
  if (!args) return null
  let head = namedChildren(args)[0]
  if (!head) return null
  if (head.type === 'binary_operator' && opText(head) === '::') {
    head = head.childForFieldName('left')!
  }
  let name = '?'
  let arity = 0
  if (head.type === 'call') {
    const t = head.childForFieldName('target')
    name = t?.text ?? '?'
    arity = arityOfArgs(callArgs(head))
  } else if (head.type === 'identifier') {
    name = head.text
    arity = 0
  }
  return {
    name: `${name}/${arity}`,
    kind: 'callback',
    visibility: 'public',
    start: line(unary),
    end: endLine(unary),
    arity,
  }
}

interface ModuleMarkers {
  hasCallback: boolean
  hasDefstruct: boolean
  hasSchema: boolean
  uses: string[]
  useAtoms: Map<string, string[]>
}

function collectModuleMarkers(body: Node): ModuleMarkers {
  const uses: string[] = []
  const useAtoms = new Map<string, string[]>()
  let hasCallback = false
  let hasDefstruct = false
  let hasSchema = false

  for (const child of namedChildren(body)) {
    if (child.type === 'unary_operator') {
      const operand = child.childForFieldName('operand')
      if (operand?.type === 'call' && callTargetName(operand) === 'callback') hasCallback = true
    } else if (child.type === 'call') {
      const cn = callTargetName(child)
      if (cn === 'defstruct') hasDefstruct = true
      if (cn === 'schema' || cn === 'embedded_schema') hasSchema = true
      if (cn === 'use') {
        const a = callArgs(child)
        if (a) {
          const kids = namedChildren(a)
          const mod = kids[0]
          if (mod && (mod.type === 'alias' || mod.type === 'identifier' || mod.type === 'dot')) {
            const modName = mod.text
            uses.push(modName)
            const atoms: string[] = []
            for (const k of kids.slice(1)) {
              if (k.type === 'atom') {
                const at = atomText(k)
                if (at) atoms.push(at)
              }
            }
            if (atoms.length) useAtoms.set(modName, atoms)
          }
        }
      }
    }
  }
  return { hasCallback, hasDefstruct, hasSchema, uses, useAtoms }
}

function detectKind(markers: ModuleMarkers, aliases: Map<string, string>, currentModule: string): ElementKind {
  if (markers.hasCallback) return 'behaviour'

  const expandedUses = markers.uses.map((u) => expandAliasPath(u, currentModule, aliases))
  const hasUse = (...names: string[]) => expandedUses.some((u) => names.includes(u))
  const hasUseAtom = (atom: string) => {
    for (const atoms of markers.useAtoms.values()) {
      if (atoms.includes(atom)) return true
    }
    return false
  }

  if (hasUse('Ecto.Schema') || markers.hasSchema) return 'entity'
  if (hasUse('Phoenix.LiveView') || hasUseAtom('live_view') || hasUseAtom('live_component')) return 'live_view'
  if (hasUse('Phoenix.Controller') || hasUseAtom('controller')) return 'controller'
  if (hasUse('Oban.Worker') || hasUse('Oban.Pro.Worker')) return 'worker'
  if (hasUse('GenServer') || hasUse('Agent')) return 'genserver'
  if (markers.hasDefstruct) return 'struct'
  return 'class'
}

interface FileCtx {
  elements: Element[]
  refs: NameRef[]
  imports: RawImport[]
  defines: string[]
  callImportKeys: Set<string>
}

function addCallImport(ctx: FileCtx, spec: string, ln: number) {
  const key = `call:${spec}`
  if (ctx.callImportKeys.has(key)) return
  ctx.callImportKeys.add(key)
  ctx.imports.push({ spec, names: ['*'], kind: 'call', line: ln })
}

function addCompileImport(ctx: FileCtx, spec: string, ln: number) {
  ctx.imports.push({ spec, names: ['*'], kind: 'compile-time', line: ln })
}

function addAliasImport(ctx: FileCtx, spec: string, shortNames: string[], ln: number, aliasMap?: Record<string, string>) {
  ctx.imports.push({
    spec,
    names: shortNames,
    aliases: aliasMap && Object.keys(aliasMap).length ? aliasMap : undefined,
    kind: 'import',
    line: ln,
  })
}

function parseFieldCall(stmt: Node): Member | null {
  const a = callArgs(stmt)
  if (!a) return null
  const kids = namedChildren(a)
  const nameNode = kids[0]
  const typeNode = kids[1]
  const fname = nameNode ? atomText(nameNode) ?? nameNode.text.replace(/^:/, '') : '?'
  const ftype = typeNode
    ? typeNode.type === 'atom'
      ? atomText(typeNode) ?? typeNode.text
      : typeNode.text
    : undefined
  return {
    name: fname,
    kind: 'field',
    visibility: 'public',
    start: line(stmt),
    end: endLine(stmt),
    type: ftype,
  }
}

function parseAssocCall(
  stmt: Node,
  cn: string,
  moduleName: string,
  aliases: Map<string, string>,
  ctx: FileCtx,
) {
  const a = callArgs(stmt)
  if (!a) return
  const kids = namedChildren(a)
  const nameNode = kids[0]
  const targetNode = kids[1]
  const aname = nameNode ? atomText(nameNode) ?? nameNode.text.replace(/^:/, '') : '?'
  let target: string | null = null
  if (targetNode) {
    target = resolveModuleExpr(targetNode, moduleName, aliases)
    if (!target && (targetNode.type === 'alias' || targetNode.type === 'identifier')) {
      target = expandAliasPath(targetNode.text, moduleName, aliases)
    }
  }
  if (target) {
    ctx.refs.push({
      from: moduleName,
      kind: 'association',
      target,
      line: line(stmt),
      label: `${aname} ${ASSOC_LABELS[cn]}`,
    })
  }
}

function collectCallsAndStructs(body: Node, moduleName: string, aliases: Map<string, string>, ctx: FileCtx) {
  walk(body, (n) => {
    if (n !== body && n.type === 'call') {
      const cn = callTargetName(n)
      if (cn === 'defmodule' || cn === 'defimpl' || cn === 'defprotocol') return false
    }

    if (n.type === 'call') {
      const t = n.childForFieldName('target')
      if (t?.type === 'dot') {
        const mod = moduleFromDotCall(t, moduleName, aliases)
        if (mod && mod !== moduleName) addCallImport(ctx, mod, line(n))
      }
    } else if (n.type === 'map') {
      const s = firstOfType(n, 'struct')
      if (s) {
        const inner = namedChildren(s)[0]
        if (inner) {
          const mod = resolveModuleExpr(inner, moduleName, aliases)
          if (mod) addCallImport(ctx, mod, line(n))
        }
      }
    }
  })
}

function moduleFromDotCall(dot: Node, currentModule: string, aliases: Map<string, string>): string | null {
  const right = dot.childForFieldName('right')
  const left = dot.childForFieldName('left')
  if (!left || !right) return null
  if (right.type !== 'identifier') return null
  if (left.type === 'identifier' && left.text !== '__MODULE__' && !/^[A-Z]/.test(left.text)) return null
  return resolveModuleExpr(left, currentModule, aliases)
}

function extractModuleBody(
  body: Node,
  moduleName: string,
  parentAliases: Map<string, string>,
  ctx: FileCtx,
  opts: { isProtocol?: boolean } = {},
): Element {
  const aliases = new Map(parentAliases)
  const clauses: PendingClause[] = []
  const members: Member[] = []
  const markers = collectModuleMarkers(body)

  // Pass 1: aliases, import/require/use, @behaviour
  for (const child of namedChildren(body)) {
    if (child.type === 'call') {
      const cn = callTargetName(child)
      if (cn === 'alias') {
        const entries = parseAliasCall(child, moduleName, aliases)
        for (const e of entries) {
          aliases.set(e.short, e.full)
          const aliasRec =
            e.short !== shortNameOf(e.full) ? { [e.short]: shortNameOf(e.full) } : undefined
          addAliasImport(ctx, e.full, [e.short], line(child), aliasRec)
        }
      } else if (cn === 'import' || cn === 'require' || cn === 'use') {
        const a = callArgs(child)
        const modNode = a ? namedChildren(a)[0] : null
        if (modNode) {
          const expanded =
            resolveModuleExpr(modNode, moduleName, aliases) ??
            (modNode.type === 'alias' || modNode.type === 'identifier' || modNode.type === 'dot'
              ? expandAliasPath(modNode.text, moduleName, aliases)
              : null)
          if (expanded) addCompileImport(ctx, expanded, line(child))
        }
      }
    } else if (child.type === 'unary_operator') {
      const operand = child.childForFieldName('operand')
      if (operand?.type === 'call' && callTargetName(operand) === 'behaviour') {
        const a = callArgs(operand)
        const t = a ? namedChildren(a)[0] : null
        if (t) {
          const target =
            resolveModuleExpr(t, moduleName, aliases) ??
            (t.type === 'alias' ? expandAliasPath(t.text, moduleName, aliases) : t.text)
          ctx.refs.push({ from: moduleName, kind: 'implements', target, line: line(child) })
          addCompileImport(ctx, target, line(child))
        }
      }
    }
  }

  const kind = opts.isProtocol ? 'protocol' : detectKind(markers, aliases, moduleName)

  // Pass 2: members, nested modules, schema fields/assocs
  for (const child of namedChildren(body)) {
    if (child.type === 'unary_operator') {
      const cb = parseCallback(child)
      if (cb) members.push(cb)
      continue
    }
    if (child.type !== 'call') continue
    const cn = callTargetName(child)
    if (!cn) continue

    if (cn === 'defmodule') {
      extractDefmodule(child, moduleName, aliases, ctx)
      continue
    }
    if (DEF_FORMS.has(cn)) {
      const head = parseDefHead(child)
      if (!head) continue
      clauses.push({
        name: head.name,
        arity: head.arity,
        start: line(child),
        end: endLine(child),
        cc: clauseComplexity(child),
        kind: MACRO_FORMS.has(cn) ? 'macro' : 'function',
        visibility: PRIVATE_FORMS.has(cn) ? 'private' : 'public',
      })
      continue
    }
    if (cn === 'defstruct') {
      const a = callArgs(child)
      if (a) members.push(...parseDefstructFields(a))
      continue
    }
    if (cn === 'field') {
      const f = parseFieldCall(child)
      if (f) members.push(f)
      continue
    }
    if (cn in ASSOC_LABELS) {
      parseAssocCall(child, cn, moduleName, aliases, ctx)
      continue
    }
    if (cn === 'schema' || cn === 'embedded_schema') {
      const db = callDo(child)
      if (db) {
        for (const stmt of namedChildren(db)) {
          if (stmt.type !== 'call') continue
          const sn = callTargetName(stmt)
          if (sn === 'field') {
            const f = parseFieldCall(stmt)
            if (f) members.push(f)
          } else if (sn && sn in ASSOC_LABELS) {
            parseAssocCall(stmt, sn, moduleName, aliases, ctx)
          }
        }
      }
      continue
    }
  }

  members.push(...mergeClauses(clauses))
  collectCallsAndStructs(body, moduleName, aliases, ctx)

  return {
    name: moduleName,
    kind,
    start: line(body),
    end: endLine(body),
    exported: true,
    members,
  }
}

function resolveDefmoduleName(
  nameNode: Node,
  parentModule: string | null,
  parentAliases: Map<string, string>,
): string {
  // Nested short name: defmodule Child inside Parent → Parent.Child
  if (parentModule && nameNode.type === 'alias' && !nameNode.text.includes('.')) {
    return `${parentModule}.${nameNode.text}`
  }
  const raw = nameNode.text
  if (raw === '__MODULE__' || raw.startsWith('__MODULE__')) {
    if (!parentModule) return raw
    return resolveModuleExpr(nameNode, parentModule, parentAliases) ?? `${parentModule}.${raw.replace(/^__MODULE__\.?/, '')}`
  }
  if (parentModule && /^[A-Z][A-Za-z0-9_]*$/.test(raw)) {
    return `${parentModule}.${raw}`
  }
  return expandAliasPath(raw, parentModule ?? '', parentAliases)
}

function extractDefmodule(
  node: Node,
  parentModule: string | null,
  parentAliases: Map<string, string>,
  ctx: FileCtx,
): void {
  const args = callArgs(node)
  const nameNode = args ? namedChildren(args)[0] : null
  if (!nameNode) return

  const moduleName = resolveDefmoduleName(nameNode, parentModule, parentAliases)
  ctx.defines.push(moduleName)

  const body = callDo(node)
  if (!body) {
    ctx.elements.push({
      name: moduleName,
      kind: 'class',
      start: line(node),
      end: endLine(node),
      exported: true,
      members: [],
    })
    return
  }

  const el = extractModuleBody(body, moduleName, parentAliases, ctx)
  el.start = line(node)
  el.end = endLine(node)
  ctx.elements.push(el)
}

function extractProtocol(node: Node, ctx: FileCtx): void {
  const args = callArgs(node)
  const nameNode = args ? namedChildren(args)[0] : null
  if (!nameNode || nameNode.type !== 'alias') return
  const moduleName = nameNode.text
  ctx.defines.push(moduleName)
  const body = callDo(node)
  const members: Member[] = []
  if (body) {
    for (const child of namedChildren(body)) {
      if (child.type === 'call' && DEF_FORMS.has(callTargetName(child) ?? '')) {
        const head = parseDefHead(child)
        if (!head) continue
        members.push({
          name: `${head.name}/${head.arity}`,
          kind: 'function',
          visibility: 'public',
          start: line(child),
          end: endLine(child),
          arity: head.arity,
          cc: clauseComplexity(child),
        })
      }
    }
  }
  ctx.elements.push({
    name: moduleName,
    kind: 'protocol',
    start: line(node),
    end: endLine(node),
    exported: true,
    members,
  })
}

function extractImpl(node: Node, ctx: FileCtx): void {
  const args = callArgs(node)
  if (!args) return
  const kids = namedChildren(args)
  const protoNode = kids.find((k) => k.type === 'alias' || k.type === 'identifier')
  let forType: string | null = null
  for (const k of kids) {
    if (k.type !== 'keywords') continue
    for (const pair of namedChildren(k)) {
      if (pair.type !== 'pair') continue
      const key = pair.childForFieldName('key')
      const val = pair.childForFieldName('value')
      if (key && keywordKey(key) === 'for' && val) {
        forType = val.type === 'alias' || val.type === 'identifier' ? val.text : val.text
      }
    }
  }
  if (!protoNode || !forType) return
  const proto = protoNode.text
  const moduleName = `${proto}.${forType}`
  ctx.defines.push(moduleName)

  const body = callDo(node)
  const aliases = new Map<string, string>()
  const members: Member[] = []
  if (body) {
    for (const child of namedChildren(body)) {
      if (child.type === 'call' && callTargetName(child) === 'alias') {
        for (const e of parseAliasCall(child, moduleName, aliases)) {
          aliases.set(e.short, e.full)
          addAliasImport(ctx, e.full, [e.short], line(child))
        }
      }
    }
    const clauses: PendingClause[] = []
    for (const child of namedChildren(body)) {
      if (child.type === 'call' && DEF_FORMS.has(callTargetName(child) ?? '')) {
        const head = parseDefHead(child)
        if (!head) continue
        const cn = callTargetName(child)!
        clauses.push({
          name: head.name,
          arity: head.arity,
          start: line(child),
          end: endLine(child),
          cc: clauseComplexity(child),
          kind: MACRO_FORMS.has(cn) ? 'macro' : 'function',
          visibility: PRIVATE_FORMS.has(cn) ? 'private' : 'public',
        })
      }
    }
    members.push(...mergeClauses(clauses))
    collectCallsAndStructs(body, moduleName, aliases, ctx)
  }

  ctx.refs.push({ from: moduleName, kind: 'implements', target: proto, line: line(node) })
  ctx.elements.push({
    name: moduleName,
    kind: 'class',
    start: line(node),
    end: endLine(node),
    exported: true,
    members,
  })
}

export async function extractElixir(relPath: string, source: string, hash: string): Promise<FileFacts> {
  const parser = await getParser('elixir')
  const tree = parser.parse(source)
  if (!tree) throw new Error('parse failed: ' + relPath)
  const root = tree.rootNode
  const ctx: FileCtx = {
    elements: [],
    refs: [],
    imports: [],
    defines: [],
    callImportKeys: new Set(),
  }

  for (const stmt of namedChildren(root)) {
    if (stmt.type !== 'call') continue
    const cn = callTargetName(stmt)
    if (cn === 'defmodule') extractDefmodule(stmt, null, new Map(), ctx)
    else if (cn === 'defprotocol') extractProtocol(stmt, ctx)
    else if (cn === 'defimpl') extractImpl(stmt, ctx)
  }

  return {
    path: relPath,
    lang: 'elixir',
    hash,
    loc: source.split('\n').length,
    isTest: isExTestFile(relPath),
    defines: ctx.defines,
    elements: ctx.elements,
    imports: ctx.imports,
    refs: ctx.refs,
    parseError: root.hasError || undefined,
  }
}
