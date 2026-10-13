import { createHash } from 'node:crypto'
import { readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { BmuConfig } from '../core/config.js'
import type { FileFacts, Model } from '../core/model.js'
import { computeFindings, bySeverity, type Finding } from '../core/findings.js'
import { componentMetrics, type ComponentMetrics } from '../core/graph.js'
import { extract, langOf, DEFAULT_EXCLUDES } from '../lang/index.js'
import { makeResolvers } from '../lang/resolve.js'
import { mapReportPaths, parseCoverage, spanCoverage, crap } from '../ingest/coverage.js'
import type { Store, FindingRow } from '../store/db.js'
import { listFiles, globToRegExp } from './files.js'
import { buildModel } from './build.js'

export interface Analysis {
  root: string
  config: BmuConfig
  model: Model
  findings: Finding[]
  cycles: string[][]
  components: ComponentMetrics[]
  changed: string[]
  stats: {
    files: number
    modules: number
    elements: number
    tests: number
    parsed: number
    ms: number
    coverage?: number
    covered?: number
    instrumented?: number
    staleFiles: number
    byLang: Record<string, number>
  }
}

export const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex')

export function sourceFiles(root: string, config: BmuConfig): { all: string[]; sources: string[] } {
  const all = listFiles(root)
  const extra = config.exclude.map(globToRegExp)
  const include = config.include.map((p) => p.replace(/\/+$/, ''))
  const sources = all.filter((f) => {
    if (!langOf(f)) return false
    if (DEFAULT_EXCLUDES.some((r) => r.test(f))) return false
    if (extra.some((r) => r.test(f))) return false
    if (include.length && !include.some((p) => f === p || f.startsWith(p + '/'))) return false
    return true
  })
  return { all, sources }
}

/** Ingest coverage report files that changed since we last read them. Returns number of files updated. */
export function ingestReports(root: string, store: Store, config: BmuConfig, known: Map<string, string>, extraReports: string[] = [], onlyFiles?: Set<string>): number {
  let n = 0
  for (const rel of [...config.coverage.reports, ...extraReports]) {
    const restrict = onlyFiles && extraReports.includes(rel) ? onlyFiles : undefined
    const p = path.isAbsolute(rel) ? rel : path.join(root, rel)
    if (!existsSync(p)) continue
    const st = statSync(p)
    const key = `cov:${rel}`
    const stamp = `${st.mtimeMs}:${st.size}`
    if (store.getMeta(key) === stamp) continue
    const report = parseCoverage(readFileSync(p, 'utf8'))
    const mapped = mapReportPaths(report, root, known.keys())
    for (const [file, hits] of mapped) {
      if (restrict && !restrict.has(file)) continue
      store.putCoverage(file, known.get(file)!, hits, rel)
      n++
    }
    store.setMeta(key, stamp)
    store.event('coverage.ingested', { report: rel, files: mapped.size })
  }
  return n
}

export async function analyze(root: string, store: Store, config: BmuConfig, opts: { extraReports?: string[]; onlyFiles?: string[] } = {}): Promise<Analysis> {
  const t0 = Date.now()
  const { all, sources } = sourceFiles(root, config)
  const index = store.fileIndex()
  const cached = new Map<string, FileFacts>()
  const needCached: string[] = []
  const changed: string[] = []
  let parsed = 0
  const facts: FileFacts[] = []
  const current = new Map<string, string>() // path -> hash

  for (const f of sources) {
    const abs = path.join(root, f)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.size > 2_000_000) continue
    const prev = index.get(f)
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
      needCached.push(f)
      current.set(f, prev.hash)
      continue
    }
    const src = readFileSync(abs, 'utf8')
    const hash = sha1(src)
    current.set(f, hash)
    if (prev && prev.hash === hash) {
      store.touchFile(f, st.mtimeMs, st.size)
      needCached.push(f)
      continue
    }
    try {
      const ff = await extract(f, src, hash)
      if (!ff) continue
      store.putFacts(ff, st.mtimeMs, st.size)
      facts.push(ff)
      parsed++
      if (prev) changed.push(f)
    } catch (e) {
      process.stderr.write(`bmu: failed to parse ${f}: ${(e as Error).message}\n`)
    }
  }
  if (needCached.length) {
    const want = new Set(needCached)
    for (const ff of store.allFacts()) if (want.has(ff.path)) cached.set(ff.path, ff)
    facts.push(...cached.values())
  }
  const removed = [...index.keys()].filter((p) => !current.has(p))
  if (removed.length) store.deleteFiles(removed)

  ingestReports(root, store, config, current, opts.extraReports, opts.onlyFiles ? new Set(opts.onlyFiles) : undefined)

  const resolvers = makeResolvers(root, all, facts)
  const model = buildModel(root, facts, resolvers)

  // ---- apply coverage + CRAP ----
  const cov = store.allCoverage()
  let covered = 0
  let instrumented = 0
  let staleFiles = 0
  for (const mod of model.modules.values()) {
    if (mod.isTest) continue
    const row = cov.get(mod.id)
    if (!row) continue
    const stale = row.hash !== current.get(mod.id)
    if (stale) staleFiles++
    for (const el of mod.elements) {
      for (const m of el.members) {
        if (m.kind === 'field' || m.kind === 'callback' || m.cc === undefined) continue
        const sc = spanCoverage(row.hits, m.start, m.end)
        if (!sc.instrumented) continue
        m.metrics.coverage = sc.ratio
        m.metrics.coveredLines = sc.covered
        m.metrics.instrumentedLines = sc.instrumented
        m.metrics.uncovered = sc.uncovered
        m.metrics.crap = crap(m.cc, sc.ratio ?? 0)
        m.metrics.stale = stale || undefined
        if (!stale) {
          covered += sc.covered
          instrumented += sc.instrumented
        }
      }
    }
  }

  const { findings, cycles, edges } = computeFindings(model, config)
  findings.sort(bySeverity)
  const byLang: Record<string, number> = {}
  for (const m of model.modules.values()) if (!m.isTest) byLang[m.lang] = (byLang[m.lang] ?? 0) + 1
  return {
    root,
    config,
    model,
    findings,
    cycles,
    components: componentMetrics(model, edges),
    changed,
    stats: {
      files: sources.length,
      modules: [...model.modules.values()].filter((m) => !m.isTest).length,
      elements: [...model.elements.values()].filter((e) => !model.modules.get(e.module)?.isTest).length,
      tests: [...model.modules.values()].filter((m) => m.isTest).length,
      parsed,
      ms: Date.now() - t0,
      coverage: instrumented ? covered / instrumented : undefined,
      covered,
      instrumented,
      staleFiles,
      byLang,
    },
  }
}

export interface Delta {
  fresh: FindingRow[] // new since baseline
  worse: FindingRow[] // got worse than baseline / last report
  resolved: FindingRow[]
}

/**
 * Reconcile current findings with stored state. The very first evaluation establishes the
 * baseline (existing debt is not reported). Returns what is notable *now*; if `mark` is set,
 * records those as reported so they are not announced again unless they get worse.
 */
export function reconcile(store: Store, findings: Finding[], opts: { mark: boolean }): Delta {
  const now = Date.now()
  const firstRun = store.getMeta('baseline_at') === null
  const before = new Map(store.allFindings().map((r) => [r.id, r]))
  const currentIds = new Set<string>()
  store.db.exec('BEGIN')
  try {
    for (const f of findings) {
      currentIds.add(f.id)
      store.upsertFinding(f, now, firstRun ? f.value : null)
    }
    const resolved: FindingRow[] = []
    for (const [id, row] of before) {
      if (row.status !== 'resolved' && !currentIds.has(id)) {
        store.resolveFinding(id)
        if (row.reported_value !== null || row.baseline_value === null) resolved.push(row)
      }
    }
    if (firstRun) store.setMeta('baseline_at', String(now))
    const fresh: FindingRow[] = []
    const worse: FindingRow[] = []
    for (const f of findings) {
      const row = store.getFinding(f.id)!
      if (row.status === 'acked' && (row.reported_value === null || row.value <= row.reported_value)) continue
      const floor = Math.max(row.baseline_value ?? -Infinity, row.reported_value ?? -Infinity)
      if (row.value <= floor) continue
      if (row.baseline_value === null && row.reported_value === null) fresh.push(row)
      else worse.push(row)
      if (opts.mark) store.markReported(row.id, row.value)
    }
    if (opts.mark) for (const r of resolved) store.markReported(r.id, r.value)
    store.db.exec('COMMIT')
    if (opts.mark && (fresh.length || worse.length || resolved.length)) {
      store.event('findings.reported', { fresh: fresh.map((r) => r.id), worse: worse.map((r) => r.id), resolved: resolved.map((r) => r.id) })
    }
    return { fresh, worse, resolved: opts.mark ? resolved : resolved }
  } catch (e) {
    store.db.exec('ROLLBACK')
    throw e
  }
}
