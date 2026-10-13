import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Lang } from '../core/model.js'
import type { BmuConfig, RunnerConfig } from '../core/config.js'

export interface RunPlan {
  lang: Lang
  tool: 'vitest' | 'jest' | 'pytest' | 'exunit'
  cwd: string // absolute
  cmd: string[] // argv
  env: Record<string, string>
  outDir: string // absolute dir where the report lands
  /** report files to ingest after the run (absolute) */
  reports: string[]
  tests: string[]
  description: string
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function nearestUp(root: string, fromRel: string, marker: (dir: string) => boolean): string | null {
  let dir = path.join(root, path.dirname(fromRel))
  for (;;) {
    if (marker(dir)) return dir
    if (dir === root || !dir.startsWith(root)) return null
    dir = path.dirname(dir)
  }
}

function jsTool(dir: string): 'vitest' | 'jest' | null {
  const pj = read(path.join(dir, 'package.json'))
  if (!pj) return null
  if (/"vitest"\s*:/.test(pj)) return 'vitest'
  if (/"jest"\s*:/.test(pj) || /"ts-jest"\s*:/.test(pj)) return 'jest'
  return null
}

function shellSplit(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (const c of s) {
    if (q) {
      if (c === q) q = null
      else cur += c
    } else if (c === '"' || c === "'") q = c
    else if (/\s/.test(c)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) out.push(cur)
  return out
}

function applyWrap(cmd: string[], rc?: RunnerConfig, env: Record<string, string> = {}): string[] {
  if (!rc?.wrap) return cmd
  const q = (a: string) => (/[\s"'$;&|<>(){}*]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)
  // inside a container the command must run through a shell (it may contain `;`)
  const inner = cmd[0] === 'sh' && cmd[1] === '-c' ? cmd[2] : cmd.map(q).join(' ')
  const wrapped = `sh -c ${q(inner)}`
  const envFlags = Object.entries(env)
    .filter(([k]) => k !== 'CI')
    .map(([k, v]) => `-e ${k}=${q(v)}`)
    .join(' ')
  let w = rc.wrap.replace('{env}', envFlags)
  w = w.includes('{cmd}') ? w.replace('{cmd}', wrapped) : `${w} ${wrapped}`
  return ['sh', '-c', w]
}

const rel = (from: string, to: string) => path.relative(from, to).split(path.sep).join('/') || '.'

/** Plan coverage runs for the given test files (repo-relative), grouped by tool + project dir. */
export function planRuns(root: string, config: BmuConfig, tests: string[], sources: string[], runId: string): RunPlan[] {
  const groups = new Map<string, { lang: Lang; dir: string; tool: RunPlan['tool']; tests: string[] }>()
  for (const t of tests) {
    let lang: Lang | null = null
    let dir: string | null = null
    let tool: RunPlan['tool'] | null = null
    if (/\.[cm]?[jt]sx?$/.test(t)) {
      lang = 'typescript'
      dir = nearestUp(root, t, (d) => !!jsTool(d))
      tool = dir ? jsTool(dir) : null
    } else if (t.endsWith('.py')) {
      lang = 'python'
      dir = nearestUp(root, t, (d) => existsSync(path.join(d, 'pyproject.toml')) || existsSync(path.join(d, 'pytest.ini')) || existsSync(path.join(d, 'setup.cfg')))
      tool = 'pytest'
    } else if (t.endsWith('.exs')) {
      lang = 'elixir'
      // umbrella: prefer the root mix.exs that has apps_path, else nearest
      dir = nearestUp(root, t, (d) => existsSync(path.join(d, 'mix.exs')))
      const top = existsSync(path.join(root, 'mix.exs')) && /apps_path/.test(read(path.join(root, 'mix.exs'))) ? root : null
      if (top) dir = top
      tool = 'exunit'
    }
    if (!lang || !dir || !tool) continue
    if (config.runners[lang]?.disabled) continue
    const key = `${tool}|${dir}`
    const g = groups.get(key) ?? { lang, dir, tool, tests: [] }
    g.tests.push(t)
    groups.set(key, g)
  }
  const plans: RunPlan[] = []
  let i = 0
  for (const g of groups.values()) {
    const outDir = path.join(root, '.bmu', 'cov', `${runId}-${i++}`)
    mkdirSync(outDir, { recursive: true })
    const rc = config.runners[g.lang]
    const testArgs = g.tests.map((t) => rel(g.dir, path.join(root, t)))
    const srcArgs = sources.filter((s) => path.join(root, s).startsWith(g.dir + path.sep)).map((s) => rel(g.dir, path.join(root, s)))
    const env: Record<string, string> = { CI: '1', ...(rc?.env ?? {}) }
    let cmd: string[]
    let reports: string[] = [path.join(outDir, 'lcov.info')]
    if (g.tool === 'vitest') {
      cmd = ['npx', '--no-install', 'vitest', 'run', ...testArgs, '--coverage.enabled=true', '--coverage.provider=v8', '--coverage.reporter=lcovonly', `--coverage.reportsDirectory=${outDir}`, '--passWithNoTests']
      for (const s of srcArgs) cmd.push(`--coverage.include=${s}`)
    } else if (g.tool === 'jest') {
      const pj = read(path.join(g.dir, 'package.json'))
      if (/NODE_ENV=test/.test(pj)) env.NODE_ENV ??= 'test'
      cmd = ['npx', '--no-install', 'jest', ...testArgs, '--coverage', '--coverageReporters=lcovonly', `--coverageDirectory=${outDir}`, '--coverageThreshold={}', '--passWithNoTests', '--forceExit']
      for (const s of srcArgs) cmd.push(`--collectCoverageFrom=${s}`)
    } else if (g.tool === 'pytest') {
      const py = read(path.join(g.dir, 'pyproject.toml'))
      const uv = existsSync(path.join(g.dir, 'uv.lock')) || /\[tool\.uv/.test(py)
      const hasTestGroup = /\[dependency-groups\][\s\S]*?^test\s*=/m.test(py)
      const hasPytestCov = /pytest-cov/.test(py)
      const hasCoverage = /["']coverage(\[toml\])?[>=<~"' ]/.test(py)
      const prefix = uv ? ['uv', 'run', ...(hasTestGroup ? ['--group', 'test'] : [])] : ['python', '-m']
      const markers = rc?.excludeMarkers ?? (/integration/.test(py) ? ['integration'] : [])
      const markArgs = markers.length ? ['-m', markers.map((m) => `not ${m}`).join(' and ')] : []
      const lcov = path.join(outDir, 'lcov.info')
      if (hasPytestCov || !hasCoverage) {
        const covPrefix = hasPytestCov ? prefix : uv ? [...prefix, '--with', 'pytest-cov'] : prefix
        cmd = [...covPrefix, 'pytest', ...testArgs, ...markArgs, '-q', '-p', 'no:cacheprovider', '--cov', `--cov-report=lcov:${lcov}`, '--no-cov-on-fail']
        if (!uv && !hasPytestCov) cmd = ['python', '-m', 'pytest', ...cmd.slice(cmd.indexOf('pytest') + 1)]
      } else {
        const data = path.join(outDir, '.coverage')
        const run = [...prefix, 'coverage', 'run', `--data-file=${data}`, '-m', 'pytest', ...testArgs, ...markArgs, '-q', '-p', 'no:cacheprovider']
        const report = [...prefix, 'coverage', 'lcov', `--data-file=${data}`, '-o', lcov]
        const q = (a: string[]) => a.map((x) => (/[\s"'$]/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : x)).join(' ')
        cmd = ['sh', '-c', `${q(run)}; ${q(report)}`]
      }
    } else {
      // exunit
      const mix = read(path.join(g.dir, 'mix.exs'))
      env.MIX_ENV = 'test'
      const relOut = rel(g.dir, outDir)
      if (/excoveralls/.test(mix) || existsSync(path.join(g.dir, 'coveralls.json'))) {
        cmd = ['mix', 'coveralls.lcov', ...testArgs]
        reports = [path.join(g.dir, 'cover', 'lcov.info')]
      } else {
        const script = [
          `out = "${relOut}/lcov.info"`,
          `Path.wildcard(Path.join(to_string(:code.root_dir()), "lib/tools-*/ebin")) |> Enum.each(&:code.add_path(to_charlist(&1))); :cover.start(); :cover.import(~c"${relOut}/bmu.coverdata")`,
          `body = for m <- :cover.imported_modules(), src = (try do to_string(m.module_info(:compile)[:source]) rescue _ -> nil end), src != nil, {:ok, lines} = :cover.analyse(m, :calls, :line), into: "" do`,
          `  da = lines |> Enum.filter(fn {{_, l}, _} -> l > 0 end) |> Enum.map(fn {{_, l}, c} -> "DA:#{l},#{c}\\n" end) |> Enum.join()`,
          `  "SF:#{src}\\n" <> da <> "end_of_record\\n"`,
          `end`,
          `File.write!(out, body)`,
        ].join('\n')
        const q = (a: string[]) => a.map((x) => `'${x.replace(/'/g, `'\\''`)}'`).join(' ')
        cmd = ['sh', '-c', `mix test --cover --export-coverage bmu ${q(testArgs)}; cp cover/bmu.coverdata ${relOut}/bmu.coverdata 2>/dev/null; mix run --no-start -e ${q([script])}`]
      }
    }
    if (rc?.command) {
      cmd = shellSplit(rc.command.replace('{tests}', testArgs.join(' ')).replace('{files}', srcArgs.join(' ')).replace('{out}', outDir))
    }
    cmd = applyWrap(cmd, rc, env)
    plans.push({ lang: g.lang, tool: g.tool, cwd: g.dir, cmd, env, outDir, reports, tests: g.tests, description: `${g.tool} (${g.tests.length} test file${g.tests.length > 1 ? 's' : ''}) in ${rel(root, g.dir)}` })
  }
  return plans
}

export interface RunResult {
  plan: RunPlan
  code: number | null
  ms: number
  output: string
  reports: string[]
}

export function execute(plan: RunPlan, timeoutMs = 15 * 60_000): Promise<RunResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(plan.cmd[0], plan.cmd.slice(1), { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const keep = (d: Buffer) => {
      output += d.toString()
      if (output.length > 200_000) output = output.slice(-100_000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    const done = (code: number | null) => {
      clearTimeout(timer)
      const reports = plan.reports.filter((r) => existsSync(r))
      // also pick up any lcov files the tool wrote into outDir
      try {
        for (const f of readdirSync(plan.outDir)) if (/lcov\.info$|\.lcov$/.test(f)) {
          const p = path.join(plan.outDir, f)
          if (!reports.includes(p)) reports.push(p)
        }
      } catch {
        /* ignore */
      }
      resolve({ plan, code, ms: Date.now() - t0, output, reports })
    }
    child.on('error', (e) => {
      output += String(e)
      done(-1)
    })
    child.on('close', done)
  })
}
