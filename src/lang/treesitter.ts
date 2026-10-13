import { Parser, Language, type Node } from 'web-tree-sitter'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export type { Node }

const grammarsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars')

let initPromise: Promise<void> | null = null
const languages = new Map<string, Promise<Language>>()
const parsers = new Map<string, Parser>()

export type GrammarName = 'typescript' | 'tsx' | 'python' | 'elixir'

async function init() {
  if (!initPromise) initPromise = Parser.init()
  return initPromise
}

export async function getParser(name: GrammarName): Promise<Parser> {
  await init()
  const cached = parsers.get(name)
  if (cached) return cached
  let langP = languages.get(name)
  if (!langP) {
    langP = Language.load(path.join(grammarsDir, `tree-sitter-${name}.wasm`))
    languages.set(name, langP)
  }
  const parser = new Parser()
  parser.setLanguage(await langP)
  parsers.set(name, parser)
  return parser
}

export const line = (n: Node) => n.startPosition.row + 1
export const endLine = (n: Node) => n.endPosition.row + 1

/** Depth-first walk. Return false from visitor to skip children. */
export function walk(node: Node, visit: (n: Node) => boolean | void) {
  const stack: Node[] = [node]
  while (stack.length) {
    const n = stack.pop()!
    if (visit(n) === false) continue
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i)
      if (c) stack.push(c)
    }
  }
}

export function namedChildren(n: Node): Node[] {
  const out: Node[] = []
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i)
    if (c) out.push(c)
  }
  return out
}

export function childrenOfType(n: Node, type: string): Node[] {
  return namedChildren(n).filter((c) => c.type === type)
}

export function firstOfType(n: Node, type: string): Node | null {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i)
    if (c && c.type === type) return c
  }
  return null
}

export function descendantsOfType(n: Node, types: string | string[]): Node[] {
  const set = new Set(Array.isArray(types) ? types : [types])
  const out: Node[] = []
  walk(n, (c) => {
    if (c !== n && set.has(c.type)) out.push(c)
  })
  return out
}
