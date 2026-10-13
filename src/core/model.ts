// Language-neutral intermediate representation (IR) for bmu.
// Pure types: no I/O. Everything else in bmu depends on this module.

export type Lang = 'typescript' | 'python' | 'elixir'

export type ElementKind =
  | 'module' // file-level holder of top-level functions/consts
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'component' // React component
  | 'hook' // React hook
  | 'store' // zustand etc.
  | 'machine' // xstate
  | 'entity' // ORM entity (TypeORM, Django, Ecto)
  | 'service' // DI-managed service
  | 'controller'
  | 'live_view'
  | 'worker'
  | 'genserver'
  | 'protocol'
  | 'behaviour'
  | 'struct'
  | 'container' // DI container

export type Visibility = 'public' | 'private' | 'protected'

export interface Member {
  name: string
  kind: 'function' | 'method' | 'field' | 'callback' | 'route' | 'tool' | 'macro'
  visibility: Visibility
  /** 1-based inclusive line span */
  start: number
  end: number
  /** cyclomatic complexity (functions only) */
  cc?: number
  arity?: number
  type?: string
}

export type EdgeKind =
  | 'import'
  | 'type-only'
  | 'compile-time'
  | 'inherits'
  | 'implements'
  | 'injects'
  | 'association'
  | 'renders'
  | 'uses-hook'
  | 'calls'

/** A reference from an element to a name that must be resolved to another element. */
export interface NameRef {
  from: string // element name within the file
  kind: EdgeKind
  target: string // as written in source (possibly qualified, e.g. "models.Model" or "MyApp.Repo")
  line: number
  label?: string // e.g. multiplicity "1..*"
}

export interface Element {
  name: string
  kind: ElementKind
  start: number
  end: number
  exported: boolean
  abstract?: boolean
  members: Member[]
  decorators?: string[]
}

export interface RawImport {
  /** module specifier as written ('./x', '@domains/y', 'pkg.mod', 'MyApp.Accounts') */
  spec: string
  /** imported names (TS named imports, python from-import names, elixir alias short names) */
  names: string[]
  /** local alias -> imported name (TS `import {a as b}`, Python `import x as y`, Elixir `alias A.B, as: C`) */
  aliases?: Record<string, string>
  kind: 'import' | 'type-only' | 'compile-time' | 'reexport' | 'call'
  line: number
  /** python relative import level (number of leading dots) */
  level?: number
}

/** Everything extracted from one source file. Cached by content hash. */
export interface FileFacts {
  path: string // repo-relative, posix
  lang: Lang
  hash: string
  loc: number
  isTest: boolean
  /** Elixir: module names defined in this file. Python/TS: unused. */
  defines?: string[]
  elements: Element[]
  imports: RawImport[]
  refs: NameRef[]
  parseError?: boolean
}

// ---------- Resolved model ----------

export interface ModuleNode {
  id: string // == file path
  file: string
  lang: Lang
  component: string // directory path ('' for root)
  loc: number
  isTest: boolean
  elements: ElementNode[]
}

export interface MemberMetrics {
  cc?: number
  /** fraction 0..1 of instrumented lines covered in the member's span; undefined = no data */
  coverage?: number
  coveredLines?: number
  instrumentedLines?: number
  uncovered?: number[]
  crap?: number
  stale?: boolean
}

export interface MemberNode extends Member {
  id: string
  metrics: MemberMetrics
}

export interface ElementNode extends Omit<Element, 'members'> {
  id: string // `${file}#${name}`
  module: string
  members: MemberNode[]
}

export interface Edge {
  from: string // module id or element id
  to: string // module id, element id, or `ext:<package>`
  kind: EdgeKind
  label?: string
  line?: number
}

export interface Model {
  root: string
  modules: Map<string, ModuleNode>
  elements: Map<string, ElementNode>
  moduleEdges: Edge[] // file -> file / ext
  elementEdges: Edge[] // element -> element
  /** module id -> test files that (transitively) import it are computed on demand */
}

export const isExternal = (id: string) => id.startsWith('ext:')
