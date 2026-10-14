import { createHash } from 'node:crypto'
import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { BmuConfig } from '../core/config.js'
import type { FileFacts, Model } from '../core/model.js'
import { computeFindings, bySeverity, stabilizeCycleIds, type Finding } from '../core/findings.js'
import { componentMetrics, type ComponentMetrics } from '../core/graph.js'
import { extract, langOf, DEFAULT_EXCLUDES, EXTRACTOR_VERSION } from '../lang/index.js'
import { makeResolvers } from '../lang/resolve.js'
import { mapReportPaths, pathMapper, parseCoverage, spanCoverage, crap } from '../ingest/coverage.js'
import { parseMutationReport } from '../ingest/mutation.js'
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
    measuredFiles: number
    byLang: Record<string, number>
  }
}

export const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex')
export const lineHashes = (src: string) => src.split('\n').map((l) => createHash('md5').update(l).digest('base64').slice(0, 6))

function readLines(root: string, file: string): string[] | null {
  try {
    return lineHashes(readFileSync(path.join(root, file), 'utf8'))
  } catch {
    return null
  }
}

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

/** Cheap fingerprint of all analysed inputs (paths, mtimes, sizes, coverage reports, config). */
export function fingerprint(root: string, config: BmuConfig): string {
  const { sources } = sourceFiles(root, config)
  const h = createHash('sha1')
  h.update(JSON.stringify(config))
  for (const f of [...sources, ...config.coverage.reports, '.coverage', ...config.mutation.reports]) {
    try {
      const st = statSync(path.join(root, f))
      h.update(`${f}:${st.mtimeMs}:${st.size}\n`)
    } catch {
      /* missing */
    }
  }
  return h.digest('hex')
}

/** coverage.py writes a binary `.coverage` file by default; convert it to LCOV when it changes. */
function convertCoveragePy(root: string, store: Store): string | null {
  const data = path.join(root, '.coverage')
  if (!existsSync(data)) return null
  const st = statSync(data)
  const stamp = `${st.mtimeMs}:${st.size}`
  const out = path.join(root, '.bmu', 'cov', 'coverage-py.lcov')
  if (store.getMeta('covpy') === stamp && existsSync(out)) return '.bmu/cov/coverage-py.lcov'
  const uv = existsSync(path.join(root, 'uv.lock'))
  const cmd = uv ? ['uv', 'run', '--no-sync', 'coverage', 'lcov', '-i', '--data-file', data, '-o', out, '-q'] : ['python3', '-m', 'coverage', 'lcov', '-i', '--data-file', data, '-o', out, '-q']
  try {
    mkdirSync(path.dirname(out), { recursive: true })
    execFileSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'ignore', timeout: 60_000 })
    store.setMeta('covpy', stamp)
    return '.bmu/cov/coverage-py.lcov'
  } catch {
    store.setMeta('covpy', stamp) // don't retry every scan
    return null
  }
}

/** Ingest coverage report files that changed since we last read them. Returns number of files updated. */
export function ingestReports(root: string, store: Store, config: BmuConfig, known: Map<string, string>, extraReports: string[] = [], onlyFiles?: Set<string>): number {
  let n = 0
  const covpy = convertCoveragePy(root, store)
  for (const rel of [...config.coverage.reports, ...(covpy ? [covpy] : []), ...extraReports]) {
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
      store.putCoverage(file, known.get(file)!, hits, rel, readLines(root, file))
      n++
    }
    store.setMeta(key, stamp)
    store.event('coverage.ingested', { report: rel, files: mapped.size })
  }
  return n
}

/** Ingest mutation reports (Stryker schema or generic list) that changed since last read. */
export function ingestMutation(root: string, store: Store, config: BmuConfig, known: Map<string, string>, extra: string[] = []): number {
  let n = 0
  for (const rel of [...config.mutation.reports, ...extra]) {
    const p = path.isAbsolute(rel) ? rel : path.join(root, rel)
    if (!existsSync(p)) continue
    const st = statSync(p)
    const key = `mut:${rel}`
    const stamp = `${st.mtimeMs}:${st.size}`
    if (store.getMeta(key) === stamp) continue
    const report = parseMutationReport(readFileSync(p, 'utf8'))
    const map = pathMapper(root, known.keys())
    for (const [raw, mutants] of report) {
      const file = map(raw)
      if (!file) continue
      store.putMutation(file, known.get(file)!, mutants)
      n++
    }
    store.setMeta(key, stamp)
    store.event('mutation.ingested', { report: rel, files: n })
  }
  return n
}

export async function analyze(root: string, store: Store, config: BmuConfig, opts: { extraReports?: string[]; onlyFiles?: string[] } = {}): Promise<Analysis> {
  const t0 = Date.now()
  if (store.getMeta('extractor') !== EXTRACTOR_VERSION) {
    store.db.exec('DELETE FROM files')
    // new extractor output must not show up as "new" regressions: re-baseline on next reconcile
    if (store.getMeta('extractor') !== null) store.db.exec("DELETE FROM meta WHERE key='baseline_at'")
    store.setMeta('extractor', EXTRACTOR_VERSION)
  }
  // changed rules/thresholds create findings that are not regressions: re-baseline on next reconcile
  const policy = sha1(JSON.stringify({ rules: config.rules, thresholds: config.thresholds, exclude: config.exclude, include: config.include }))
  if (store.getMeta('policy') !== policy) {
    if (store.getMeta('policy') !== null) store.db.exec("DELETE FROM meta WHERE key='baseline_at'")
    store.setMeta('policy', policy)
  }
  const { all, sources } = sourceFiles(root, config)
  const index = store.fileIndex()
  const firstScan = index.size === 0
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
      if (prev || !firstScan) changed.push(f)
    } catch (e) {
      process.stderr.write(`bmu: failed to parse ${f}: ${(e as Error).message}\n`)
    }
  }
  if (needCached.length) {
    const want = new Set(needCached)
    for (const ff of store.allFacts()) if (want.has(ff.path)) cached.set(ff.path, ff)
    facts.push(...cached.values())
  }
  if (changed.length && store.getMeta('baseline_at') !== null) store.markChanged(changed)
  const removed = [...index.keys()].filter((p) => !current.has(p))
  if (removed.length) store.deleteFiles(removed)

  ingestReports(root, store, config, current, opts.extraReports, opts.onlyFiles ? new Set(opts.onlyFiles) : undefined)

  ingestMutation(root, store, config, current)

  const resolvers = makeResolvers(root, all, facts)
  const model = buildModel(root, facts, resolvers)

  // ---- apply coverage + CRAP ----
  const cov = store.allCoverage()
  let covered = 0
  let instrumented = 0
  let staleFiles = 0
  let measuredFiles = 0
  for (const mod of model.modules.values()) {
    if (mod.isTest) continue
    const row = cov.get(mod.id)
    if (!row) continue
    const fileStale = row.hash !== current.get(mod.id)
    if (fileStale) staleFiles++
    else measuredFiles++
    // member-level staleness: a member is fresh if its lines are unchanged at the same positions
    const nowLines = fileStale && row.lines ? readLines(root, mod.id) : null
    const memberStale = (start: number, end: number) => {
      if (!fileStale) return false
      if (!nowLines || !row.lines) return true
      for (let l = start; l <= end; l++) if (row.lines[l - 1] !== nowLines[l - 1]) return true
      return false
    }
    for (const el of mod.elements) {
      for (const m of el.members) {
        if (m.kind === 'field' || m.kind === 'callback' || m.cc === undefined) continue
        const stale = memberStale(m.start, m.end)
        const nested = el.members.filter((o) => o !== m && o.cc !== undefined && o.start >= m.start && o.end <= m.end && (o.start !== m.start || o.end !== m.end))
        const hits = nested.length ? new Map([...row.hits].filter(([l]) => !nested.some((o) => l >= o.start && l <= o.end))) : row.hits
        const sc = spanCoverage(hits, m.start, m.end)
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

  // ---- apply mutation results ----
  for (const [file, row] of store.allMutation()) {
    const mod = model.modules.get(file)
    if (!mod || row.hash !== current.get(file)) continue
    for (const el of mod.elements)
      for (const m of el.members) {
        if (m.cc === undefined) continue
        const nested = el.members.filter((o) => o !== m && o.cc !== undefined && o.start >= m.start && o.end <= m.end && (o.start !== m.start || o.end !== m.end))
        const inSpan = row.mutants.filter((x: any) => x.line >= m.start && x.line <= m.end && !nested.some((o) => x.line >= o.start && x.line <= o.end))
        if (!inSpan.length) continue
        const count = (st: string) => inSpan.filter((x: any) => x.status === st).length
        m.metrics.mutation = {
          killed: count('killed'),
          survived: count('survived'),
          noCoverage: count('nocoverage'),
          timeout: count('timeout'),
          survivors: inSpan.filter((x: any) => x.status === 'survived').map((x: any) => ({ line: x.line, mutator: x.mutator })),
        }
      }
  }

  const { findings, cycles, edges } = computeFindings(model, config)
  stabilizeCycleIds(findings, store.allFindings().filter((r) => r.rule === 'cycle' && r.status !== 'resolved'))
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
      measuredFiles,
      byLang,
    },
  }
}

const MEMBER_RULES = new Set(['crap', 'complexity', 'uncovered', 'file-coverage', 'mutants'])

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
  store.db.exec('BEGIN IMMEDIATE')
  try {
    for (const f of findings) {
      currentIds.add(f.id)
      store.upsertFinding(f, now, firstRun ? f.value : null)
    }
    const resolved: FindingRow[] = []
    const touchedNow = store.changedSinceBaseline()
    for (const [id, row] of before) {
      if (row.status !== 'resolved' && !currentIds.has(id)) {
        store.resolveFinding(id)
        // announce fixes the agent made: reported/new findings, and baseline debt in files it touched
        if (row.reported_value !== null || row.baseline_value === null || touchedNow.has(row.file)) resolved.push(row)
      }
    }
    if (firstRun) {
      store.db.exec("UPDATE findings SET baseline_value=value, reported_value=NULL WHERE status != 'resolved'")
      store.setMeta('baseline_at', String(now))
    }
    const fresh: FindingRow[] = []
    const worse: FindingRow[] = []
    const touched = store.changedSinceBaseline()
    for (const f of findings) {
      const row = store.getFinding(f.id)!
      // code-level findings only count as regressions in files changed since the baseline
      // (a first coverage measurement of untouched code is pre-existing debt, not a regression)
      if (MEMBER_RULES.has(f.rule) && !touched.has(f.file)) {
        if (row.baseline_value === null) store.db.prepare('UPDATE findings SET baseline_value=? WHERE id=?').run(f.value, f.id)
        continue
      }
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
