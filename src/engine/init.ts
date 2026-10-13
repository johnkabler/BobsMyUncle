import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

/** Conventional clean-architecture directory names, inner (most stable) first. */
const LAYER_NAMES: string[][] = [
  ['domain', 'domains', 'entities', 'model', 'models', 'core'],
  ['application', 'app', 'usecases', 'use_cases', 'services'],
  ['infrastructure', 'infra', 'adapters', 'persistence', 'repositories', 'gateways'],
  ['api', 'http', 'web', 'controllers', 'routes', 'interfaces', 'presentation', 'cli', 'ui'],
]

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '_build', 'deps', '.venv', 'venv', '__pycache__', '.bmu', 'coverage', 'cover', 'test', 'tests', 'spec'])

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Find a directory whose children look like architecture layers; returns layer groups (repo-relative). */
export function inferLayers(root: string, maxDepth = 4): string[][] | null {
  let best: { groups: string[][]; score: number } | null = null
  const visit = (rel: string, depth: number) => {
    if (depth > maxDepth) return
    const kids = subdirs(path.join(root, rel))
    const groups: string[][] = LAYER_NAMES.map(() => [])
    for (const k of kids) {
      const i = LAYER_NAMES.findIndex((names) => names.includes(k.toLowerCase()))
      if (i >= 0) groups[i].push(rel ? `${rel}/${k}` : k)
    }
    const filled = groups.filter((g) => g.length)
    // need at least an inner layer and one outer layer
    if (filled.length >= 2 && groups[0].length + groups[1].length > 0) {
      // outer layers often live next to the core dir (e.g. src/core/{domains,application,infra} + src/http)
      if (rel) {
        const parent = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
        for (const sib of subdirs(path.join(root, parent))) {
          const full = parent ? `${parent}/${sib}` : sib
          if (full === rel) continue
          if (LAYER_NAMES[3].includes(sib.toLowerCase())) groups[3].push(full)
          else if (LAYER_NAMES[2].includes(sib.toLowerCase())) groups[2].push(full)
        }
      }
      const all = groups.filter((g) => g.length)
      const score = all.length * 10 - depth
      if (!best || score > best.score) best = { groups: all, score }
    }
    for (const k of kids) visit(rel ? `${rel}/${k}` : k, depth + 1)
  }
  visit('', 0)
  return best ? (best as { groups: string[][] }).groups : null
}

/** Phoenix convention: lib/<app> (domain) is inner, lib/<app>_web and other lib/<app>_* are outer. */
export function inferPhoenixLayers(root: string): string[][] | null {
  if (!existsSync(path.join(root, 'mix.exs'))) return null
  const kids = subdirs(path.join(root, 'lib'))
  for (const k of kids) {
    if (kids.includes(`${k}_web`)) {
      const outer = kids.filter((x) => x !== k && x.startsWith(`${k}_`)).map((x) => `lib/${x}`)
      return [[`lib/${k}`], outer]
    }
  }
  return null
}

/** Elixir umbrella: order apps by in_umbrella dependencies (apps nobody depends on are outermost). */
export function inferUmbrellaLayers(root: string): string[][] | null {
  const mix = path.join(root, 'mix.exs')
  if (!existsSync(mix) || !/apps_path/.test(readFileSync(mix, 'utf8'))) return null
  const apps = subdirs(path.join(root, 'apps'))
  const deps = new Map<string, string[]>()
  for (const a of apps) {
    const m = path.join(root, 'apps', a, 'mix.exs')
    const txt = existsSync(m) ? readFileSync(m, 'utf8') : ''
    deps.set(a, [...txt.matchAll(/\{:(\w+),\s*in_umbrella:\s*true/g)].map((x) => x[1]).filter((d) => apps.includes(d)))
  }
  // longest-path layering: depth(app) = 1 + max depth(dep)
  const depth = new Map<string, number>()
  const d = (a: string, seen = new Set<string>()): number => {
    if (depth.has(a)) return depth.get(a)!
    if (seen.has(a)) return 0
    seen.add(a)
    const v = Math.max(-1, ...(deps.get(a) ?? []).map((x) => d(x, seen))) + 1
    depth.set(a, v)
    return v
  }
  apps.forEach((a) => d(a))
  const max = Math.max(0, ...depth.values())
  if (max === 0) return null
  const layers: string[][] = []
  for (let i = 0; i <= max; i++) layers.push(apps.filter((a) => depth.get(a) === i).map((a) => `apps/${a}`))
  return layers.filter((l) => l.length)
}

/** Detect how a repo runs its Elixir tests (e.g. SeatScouts/b2b runs `docker compose exec app mix test`). */
export function detectElixirWrap(root: string): string | null {
  for (const f of ['justfile', 'Justfile', 'Makefile']) {
    const p = path.join(root, f)
    if (!existsSync(p)) continue
    const txt = readFileSync(p, 'utf8')
    const m = txt.match(/\bexec\s+(?:-T\s+)?(\w[\w-]*)\s+mix\s+test/)
    if (m && /docker[- ]compose/.test(txt)) return `docker compose exec -T {env} ${m[1]} {cmd}`
  }
  return null
}

export interface InitResult {
  file: string
  config: Record<string, unknown>
  notes: string[]
}

export function initConfig(root: string, opts: { shared?: boolean; force?: boolean } = {}): InitResult {
  const file = opts.shared ? path.join(root, 'bmu.config.yaml') : path.join(root, '.bmu', 'config.yaml')
  const notes: string[] = []
  const config: Record<string, any> = {}
  const layers = inferUmbrellaLayers(root) ?? inferPhoenixLayers(root) ?? inferLayers(root)
  if (layers) {
    config.rules = { layers }
    notes.push(`inferred dependency-rule layers (inner → outer): ${layers.map((l) => l.join(' + ')).join('  →  ')}`)
  } else notes.push('no conventional layer directories found; add rules.layers by hand to enable dependency-rule checks')
  const wrap = detectElixirWrap(root)
  if (wrap) {
    config.runners = { elixir: { wrap } }
    notes.push(`Elixir tests appear to run in Docker; background coverage will use: ${wrap.replace('{env} ', '').replace(' {cmd}', ' mix …')}`)
  }
  const exampleDirs = subdirs(root).filter((d) => /^(examples?|samples?|demo|playground|sandbox|fixtures)$/i.test(d))
  if (exampleDirs.length) {
    config.exclude = exampleDirs.map((d) => `${d}/**`)
    notes.push(`excluding ${exampleDirs.join(', ')}`)
  }
  if (existsSync(file) && !opts.force) {
    notes.unshift(`${path.relative(root, file)} already exists; not overwritten (use --force)`)
    return { file, config, notes }
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const header = `# bmu configuration (generated by \`bmu init\`). See https://github.com/johnkabler/BobsMyUncle#configuration-optional\n`
  writeFileSync(file, header + (Object.keys(config).length ? YAML.stringify(config) : '{}\n'))
  return { file, config, notes }
}
