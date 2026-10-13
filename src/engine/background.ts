import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { BmuConfig } from '../core/config.js'
import type { Store } from '../store/db.js'
import { analyze, reconcile, type Analysis } from './analyze.js'
import { affectedTests } from './build.js'
import { planRuns, execute, type RunResult } from '../runners/index.js'

interface Pending {
  at: number
  files: string[]
}

const pendingPath = (root: string) => path.join(root, '.bmu', 'coverage.pending.json')
const lockPath = (root: string) => path.join(root, '.bmu', 'coverage.lock')

export function readPending(root: string): Pending | null {
  try {
    return JSON.parse(readFileSync(pendingPath(root), 'utf8'))
  } catch {
    return null
  }
}

/** Record changed source files for the next background coverage run. */
export function queueCoverage(root: string, files: string[]) {
  if (!files.length) return
  const cur = readPending(root)
  const set = new Set([...(cur?.files ?? []), ...files])
  mkdirSync(path.join(root, '.bmu'), { recursive: true })
  writeFileSync(pendingPath(root), JSON.stringify({ at: Date.now(), files: [...set] }))
}

const binPath = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'bmu.js')

/** Spawn a detached `bmu coverage run --pending` that waits for quiet, then runs affected tests. */
export function spawnBackgroundCoverage(root: string) {
  const logFile = path.join(root, '.bmu', 'coverage.log')
  const fd = openSync(logFile, 'a')
  const child = spawn(process.execPath, [binPath(), 'coverage', 'run', '--pending'], { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, BMU_BACKGROUND: '1' } })
  child.unref()
  closeSync(fd)
}

function acquireLock(root: string): boolean {
  const p = lockPath(root)
  try {
    if (existsSync(p)) {
      const { pid, at } = JSON.parse(readFileSync(p, 'utf8'))
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
      if (alive && Date.now() - at < 30 * 60_000) return false
    }
    writeFileSync(p, JSON.stringify({ pid: process.pid, at: Date.now() }))
    return true
  } catch {
    return false
  }
}

function releaseLock(root: string) {
  try {
    unlinkSync(lockPath(root))
  } catch {
    /* ignore */
  }
}

export interface CoverageOutcome {
  results: RunResult[]
  tests: string[]
  skipped?: string
  analysis?: Analysis
}

/** Run affected tests (or the given tests) with coverage and ingest the reports. */
export async function runCoverage(root: string, store: Store, config: BmuConfig, opts: { files?: string[]; all?: boolean; pending?: boolean; log?: (s: string) => void }): Promise<CoverageOutcome> {
  const log = opts.log ?? (() => {})
  if (opts.pending) {
    // debounce: wait until no new edits have been queued for debounceSeconds
    const quiet = config.coverage.debounceSeconds * 1000
    for (;;) {
      const p = readPending(root)
      if (!p) return { results: [], tests: [], skipped: 'nothing pending' }
      const wait = p.at + quiet - Date.now()
      if (wait <= 0) break
      await new Promise((r) => setTimeout(r, Math.min(wait, 5000)))
    }
  }
  if (!acquireLock(root)) return { results: [], tests: [], skipped: 'another coverage run is in progress' }
  try {
    let files = opts.files ?? []
    if (opts.pending) {
      const p = readPending(root)
      files = p?.files ?? []
      try {
        unlinkSync(pendingPath(root))
      } catch {
        /* ignore */
      }
    }
    const a = await analyze(root, store, config)
    if (!files.length) files = a.changed
    const tests = opts.all
      ? [...a.model.modules.values()].filter((m) => m.isTest).map((m) => m.id)
      : affectedTests(a.model, files)
    const runnable = tests.filter((t) => /\.(test|spec)\.|(^|\/)spec\.|(^|\/)test_|_test\.(py|exs)$/.test(t))
    if (!runnable.length) return { results: [], tests: [], skipped: 'no affected tests found' }
    const sources = files.length ? files : [...a.model.modules.values()].filter((m) => !m.isTest).map((m) => m.id)
    const runId = new Date().toISOString().replace(/[:.]/g, '-')
    const plans = planRuns(root, config, runnable, opts.all ? [] : sources, runId)
    const results: RunResult[] = []
    for (const plan of plans) {
      log(`bmu: running ${plan.description}`)
      store.event('coverage.started', { tool: plan.tool, tests: plan.tests.length })
      const r = await execute(plan)
      results.push(r)
      store.event('coverage.finished', { tool: plan.tool, code: r.code, ms: r.ms, reports: r.reports.length })
      log(`bmu: ${plan.tool} exited ${r.code} in ${(r.ms / 1000).toFixed(1)}s; ${r.reports.length} report(s)`)
      if (!r.reports.length) log(r.output.slice(-3000))
    }
    const reports = results.flatMap((r) => r.reports.map((p) => path.relative(root, p)))
    const after = await analyze(root, store, config, { extraReports: reports, onlyFiles: opts.all ? undefined : files })
    reconcile(store, after.findings, { mark: false })
    // let the next hook deliver coverage-driven findings even if no source file changed
    store.setMeta('hook_pending_report', '1')
    return { results, tests: runnable, analysis: after }
  } finally {
    releaseLock(root)
  }
}
