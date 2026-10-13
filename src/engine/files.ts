import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { defaultConfig, mergeConfig, type BmuConfig } from '../core/config.js'

/** Find the repo/worktree root: nearest dir with .git (file or dir), else cwd. */
export function findRoot(start = process.cwd()): string {
  let dir = path.resolve(start)
  for (;;) {
    if (existsSync(path.join(dir, '.git')) || existsSync(path.join(dir, 'bmu.config.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

/** All tracked + untracked-but-not-ignored files, repo-relative posix paths. */
export function listFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const files = out.toString('utf8').split('\0').filter(Boolean)
    if (files.length) return files.filter((f) => existsSync(path.join(root, f)))
  } catch {
    /* not a git repo */
  }
  const out: string[] = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '_build', 'deps', '.venv', 'venv', '__pycache__', '.bmu'])
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk(root, '')
  return out
}

export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
        i += glob[i + 2] === '/' ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

export function loadConfig(root: string): BmuConfig {
  let cfg = defaultConfig()
  for (const f of ['bmu.config.yaml', 'bmu.config.yml', '.bmu/config.yaml']) {
    const p = path.join(root, f)
    if (!existsSync(p)) continue
    try {
      cfg = mergeConfig(cfg, YAML.parse(readFileSync(p, 'utf8')))
    } catch (e) {
      process.stderr.write(`bmu: could not parse ${f}: ${(e as Error).message}\n`)
    }
  }
  return cfg
}
