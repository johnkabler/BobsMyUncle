import { watch as fsWatch } from 'node:fs'
import type { BmuConfig } from '../core/config.js'
import type { Store } from '../store/db.js'
import { analyze, reconcile, type Analysis } from './analyze.js'
import { affectedTests } from './build.js'
import { queueCoverage, spawnBackgroundCoverage } from './background.js'
import { langOf, DEFAULT_EXCLUDES } from '../lang/index.js'

const IGNORE = /(^|\/)(\.git|\.bmu|node_modules|_build|deps|dist|build|\.venv|__pycache__|coverage|cover)(\/|$)/

export type Listener = (a: Analysis, lines: string[]) => void

/**
 * Watch the repo. Prints one line per *new or worsened* finding (deduped per id/value) so it can
 * feed Grok's `monitor` tool or a terminal. Does not mark findings as reported: in-band hooks
 * still deliver them to the agent.
 */
export async function watch(root: string, store: Store, config: BmuConfig, out: (s: string) => void, onUpdate?: Listener) {
  const printed = new Map<string, number>()
  let timer: NodeJS.Timeout | null = null
  let running = false
  let again = false
  const coverageReports = new Set(config.coverage.reports)

  const run = async (initial = false) => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const a = await analyze(root, store, config)
      const d = reconcile(store, a.findings, { mark: false })
      const lines: string[] = []
      for (const f of [...d.fresh, ...d.worse]) {
        if ((printed.get(f.id) ?? -Infinity) >= f.value) continue
        printed.set(f.id, f.value)
        lines.push(`bmu ▲ ${f.id} ${f.message}`)
      }
      // findings that disappeared since we printed them
      const open = new Set(a.findings.map((f) => f.id))
      for (const id of [...printed.keys()]) {
        if (!open.has(id)) {
          printed.delete(id)
          lines.push(`bmu ✓ ${id} resolved`)
        }
      }
      if (initial) {
        out(`bmu watching ${root} — ${a.stats.modules} modules, ${a.findings.length} findings (baseline), ${a.stats.ms}ms`)
        for (const f of [...d.fresh, ...d.worse]) printed.set(f.id, f.value)
      } else for (const l of lines) out(l)
      if (!initial && a.changed.length && config.coverage.background && affectedTests(a.model, a.changed).length) {
        queueCoverage(root, a.changed)
        spawnBackgroundCoverage(root)
      }
      onUpdate?.(a, initial ? [] : lines)
    } catch (e) {
      out(`bmu error: ${(e as Error).message}`)
    } finally {
      running = false
      if (again) {
        again = false
        schedule()
      }
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void run(), 300)
  }
  await run(true)
  fsWatch(root, { recursive: true }, (_ev, file) => {
    if (!file) return
    const f = file.toString().split('\\').join('/')
    if (coverageReports.has(f)) return schedule()
    if (IGNORE.test(f) || !langOf(f) || DEFAULT_EXCLUDES.some((r) => r.test(f))) return
    schedule()
  })
  await new Promise(() => {})
}
