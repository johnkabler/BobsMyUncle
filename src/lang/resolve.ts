import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ResolverFactory } from 'oxc-resolver'
import YAML from 'yaml'
import type { FileFacts, Lang, RawImport } from '../core/model.js'

/** Resolves a RawImport from a file to repo-relative file paths and/or `ext:<pkg>` ids. */
export interface ImportResolver {
  resolve(fromFile: string, imp: RawImport): string[]
}

const ASSET = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|json|md|mdx|html|txt|woff2?|ttf|wasm|graphql|gql|yaml|yml)(\?.*)?$/i
const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

const toPosix = (p: string) => p.split(path.sep).join('/')

function packageNameOf(spec: string): string {
  if (spec.startsWith('node:')) return 'node'
  const parts = spec.split('/')
  return spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]
}

interface WorkspacePkg {
  name: string
  dir: string // repo-relative
  exports?: unknown
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Discover JS workspace packages (pnpm-workspace.yaml / package.json workspaces) from the list of package.json files. */
function workspacePackages(root: string, files: Set<string>): Map<string, WorkspacePkg> {
  const out = new Map<string, WorkspacePkg>()
  for (const f of files) {
    if (!f.endsWith('package.json') || f.includes('node_modules/')) continue
    const pj = readJson(path.join(root, f))
    if (!pj?.name) continue
    out.set(pj.name, { name: pj.name, dir: path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f), exports: pj.exports })
  }
  // also include package.json files that are not tracked in the file list but listed in pnpm-workspace
  const ws = path.join(root, 'pnpm-workspace.yaml')
  if (existsSync(ws)) {
    try {
      YAML.parse(readFileSync(ws, 'utf8'))
    } catch {
      /* ignore */
    }
  }
  return out
}

function pickExportTarget(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    for (const k of ['source', 'development', 'import', 'module', 'default', 'require', 'types']) {
      const v = (entry as Record<string, unknown>)[k]
      const t = pickExportTarget(v)
      if (t) return t
    }
  }
  return null
}

export class TsResolver implements ImportResolver {
  private factory: ResolverFactory
  private files: Set<string>
  private workspace: Map<string, WorkspacePkg>
  private cache = new Map<string, string[]>()
  constructor(private root: string, files: Iterable<string>) {
    this.files = new Set(files)
    this.factory = new ResolverFactory({
      tsconfig: 'auto',
      extensions: [...TS_EXT, '.json', '.d.ts'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] },
      conditionNames: ['source', 'development', 'import', 'require', 'node', 'default', 'types'],
      mainFields: ['source', 'module', 'main', 'types'],
      symlinks: true,
    })
    this.workspace = workspacePackages(root, this.files)
  }

  /** Map a path inside the repo (maybe a build output) to a tracked source file. */
  private toSource(rel: string): string | null {
    if (this.files.has(rel) && !/\.d\.[cm]?ts$/.test(rel)) return rel
    const candidates: string[] = []
    const stripped = rel.replace(/\.d\.[cm]?ts$/, '').replace(/\.[cm]?jsx?$/, '').replace(/\.[cm]?tsx?$/, '')
    const variants = [stripped]
    for (const d of ['/dist/', '/build/', '/lib/', '/out/', '/esm/', '/cjs/']) {
      if (stripped.includes(d)) variants.push(stripped.replace(d, '/src/'))
      if (stripped.startsWith(d.slice(1))) variants.push('src/' + stripped.slice(d.length - 1))
    }
    for (const v of variants) for (const e of ['.ts', '.tsx', '.mts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) candidates.push(v + e)
    return candidates.find((c) => this.files.has(c)) ?? null
  }

  private resolveWorkspace(spec: string): string | null {
    const name = packageNameOf(spec)
    const pkg = this.workspace.get(name)
    if (!pkg) return null
    const sub = spec.slice(name.length) // '' or '/x'
    const key = sub ? '.' + sub : '.'
    let target: string | null = null
    const exp = pkg.exports
    if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
      const map = exp as Record<string, unknown>
      if (key in map) target = pickExportTarget(map[key])
      else if (!Object.keys(map).some((k) => k.startsWith('.'))) target = key === '.' ? pickExportTarget(map) : null
      else {
        for (const [k, v] of Object.entries(map)) {
          if (k.includes('*')) {
            const [pre, post] = k.split('*')
            if (key.startsWith(pre) && key.endsWith(post)) {
              const t = pickExportTarget(v)
              if (t) target = t.replace('*', key.slice(pre.length, key.length - post.length))
            }
          }
        }
      }
    } else if (typeof exp === 'string' && key === '.') target = exp
    const base = pkg.dir ? pkg.dir + '/' : ''
    if (target) return this.toSource(path.posix.normalize(base + target.replace(/^\.\//, '')))
    return this.toSource(path.posix.normalize(base + (sub ? sub.slice(1) : 'src/index')))
  }

  resolve(fromFile: string, imp: RawImport): string[] {
    const spec = imp.spec
    if (ASSET.test(spec)) return []
    const key = fromFile + '\0' + spec
    const hit = this.cache.get(key)
    if (hit) return hit
    let out: string[] = []
    const abs = path.join(this.root, fromFile)
    const r = this.factory.resolveFileSync(abs, spec)
    if (r.builtin) out = ['ext:node']
    else if (r.path) {
      const rel = toPosix(path.relative(this.root, r.path))
      if (!rel.startsWith('..') && !rel.includes('node_modules/')) {
        const src = this.toSource(rel)
        out = src ? [src] : []
      } else {
        const ws = spec.startsWith('.') ? null : this.resolveWorkspace(spec)
        out = ws ? [ws] : spec.startsWith('.') ? [] : ['ext:' + packageNameOf(spec)]
      }
    } else if (!spec.startsWith('.') && !spec.startsWith('/')) {
      const ws = this.resolveWorkspace(spec)
      out = ws ? [ws] : ['ext:' + packageNameOf(spec)]
    }
    this.cache.set(key, out)
    return out
  }
}

/** Python: module index over source roots. */
export class PyResolver implements ImportResolver {
  private modules = new Map<string, string>() // dotted module -> file
  private fileModule = new Map<string, string>() // file -> dotted module
  constructor(private root: string, files: Iterable<string>, roots?: string[]) {
    const py = [...files].filter((f) => f.endsWith('.py'))
    const rootSet = new Set<string>(roots ?? [])
    // discover roots from pyproject files
    for (const f of [...files].filter((x) => x.endsWith('pyproject.toml'))) {
      const dir = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f)
      const pre = dir ? dir + '/' : ''
      rootSet.add(dir)
      if (py.some((p) => p.startsWith(pre + 'src/'))) rootSet.add(pre + 'src')
      try {
        const txt = readFileSync(path.join(root, f), 'utf8')
        const m = txt.match(/pythonpath\s*=\s*\[([^\]]*)\]/)
        if (m) for (const s of m[1].matchAll(/["']([^"']+)["']/g)) rootSet.add(path.posix.normalize(pre + s[1]).replace(/^\.$/, ''))
      } catch {
        /* ignore */
      }
    }
    if (!rootSet.size) rootSet.add('')
    if (py.some((p) => p.startsWith('src/'))) rootSet.add('src')
    // longest roots first so `src/app/x.py` maps to `app.x` rather than `src.app.x`
    const sorted = [...rootSet].sort((a, b) => b.length - a.length)
    for (const f of py) {
      for (const r of sorted) {
        const pre = r ? r + '/' : ''
        if (r && !f.startsWith(pre)) continue
        let mod = f.slice(pre.length).replace(/\.py$/, '').split('/').join('.')
        mod = mod.replace(/(^|\.)__init__$/, '')
        if (!mod) continue
        if (!this.modules.has(mod)) this.modules.set(mod, f)
        if (!this.fileModule.has(f)) this.fileModule.set(f, mod)
      }
    }
  }

  moduleOf(file: string) {
    return this.fileModule.get(file)
  }

  private lookup(mod: string): string | null {
    return this.modules.get(mod) ?? null
  }

  resolve(fromFile: string, imp: RawImport): string[] {
    let base = imp.spec
    if (imp.level && imp.level > 0) {
      const cur = this.fileModule.get(fromFile) ?? ''
      const isPkg = fromFile.endsWith('__init__.py')
      const parts = cur ? cur.split('.') : []
      const pkgParts = isPkg ? parts : parts.slice(0, -1)
      const up = pkgParts.slice(0, Math.max(0, pkgParts.length - (imp.level - 1)))
      base = [...up, ...(imp.spec ? [imp.spec] : [])].join('.')
    }
    const out = new Set<string>()
    // from base import name -> submodule base.name if it exists
    for (const n of imp.names) {
      if (n === '*') continue
      const f = this.lookup(base ? `${base}.${n}` : n)
      if (f) out.add(f)
    }
    if (!out.size || imp.names.some((n) => !this.lookup(base ? `${base}.${n}` : n))) {
      let m = base
      while (m) {
        const f = this.lookup(m)
        if (f) {
          out.add(f)
          break
        }
        m = m.includes('.') ? m.slice(0, m.lastIndexOf('.')) : ''
      }
      if (!out.size && base && !imp.level) out.add('ext:' + base.split('.')[0])
    }
    out.delete(fromFile)
    return [...out]
  }
}

/** Elixir: global module-name index from FileFacts.defines. */
export class ExResolver implements ImportResolver {
  private modules = new Map<string, string>()
  constructor(facts: Iterable<FileFacts>) {
    for (const f of facts) for (const m of f.defines ?? []) if (!this.modules.has(m) || !f.isTest) this.modules.set(m, f.path)
  }
  fileOf(mod: string) {
    return this.modules.get(mod)
  }
  resolve(fromFile: string, imp: RawImport): string[] {
    let m = imp.spec
    while (m) {
      const f = this.modules.get(m)
      if (f) return f === fromFile ? [] : [f]
      m = m.includes('.') ? m.slice(0, m.lastIndexOf('.')) : ''
    }
    // externals: only keep compile-time deps (use/import/require) to avoid noise
    return imp.kind === 'compile-time' ? ['ext:' + imp.spec.split('.')[0]] : []
  }
}

export function makeResolvers(root: string, files: string[], facts: FileFacts[]): Record<Lang, ImportResolver> {
  return {
    typescript: new TsResolver(root, files),
    python: new PyResolver(root, files),
    elixir: new ExResolver(facts.filter((f) => f.lang === 'elixir')),
  }
}
