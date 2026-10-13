export interface LayerRuleConfig {
  /** Groups of path prefixes, INNER (most stable / highest level) first. Inner may not depend on outer. */
  layers?: string[][]
  forbidden?: { from: string; to: string; reason?: string }[]
  /** count type-only imports as dependencies for cycles/layers (default false) */
  includeTypeOnly?: boolean
}

export interface RunnerConfig {
  /** override the auto-detected command; {tests} {files} {out} placeholders */
  command?: string
  /** wrap the command, e.g. "docker compose exec app {cmd}" */
  wrap?: string
  env?: Record<string, string>
  /** pytest markers to exclude in background runs */
  excludeMarkers?: string[]
  disabled?: boolean
}

export interface BmuConfig {
  /** extra exclude globs (in addition to built-in excludes and .gitignore) */
  exclude: string[]
  /** limit analysis to these path prefixes (default: whole repo) */
  include: string[]
  thresholds: {
    crap: number
    cc: number
    /** report members with uncovered lines (only new/worsened) */
    uncovered: boolean
    /** optional minimum file coverage 0..1 */
    fileCoverageMin?: number
  }
  rules: LayerRuleConfig
  coverage: {
    /** report files to ingest passively when they change (relative to root). Defaults are auto-detected. */
    reports: string[]
    /** run affected tests with coverage in the background after edits */
    background: boolean
    /** seconds of quiet before a background run */
    debounceSeconds: number
  }
  mutation: {
    /** mutation report files to ingest when they change (Stryker JSON or generic {mutants:[...]}) */
    reports: string[]
  }
  runners: Partial<Record<'typescript' | 'python' | 'elixir', RunnerConfig>>
  report: {
    hookMaxLines: number
    contextMaxTokens: number
  }
}

export const DEFAULT_COVERAGE_REPORTS = [
  'coverage/lcov.info',
  'coverage.lcov',
  'lcov.info',
  'cover/lcov.info',
  'cover/excoveralls.lcov',
  'coverage.xml',
  'cover/cobertura.xml',
  'coverage/cobertura-coverage.xml',
]

export function defaultConfig(): BmuConfig {
  return {
    exclude: [],
    include: [],
    thresholds: { crap: 30, cc: 15, uncovered: true },
    rules: {},
    coverage: { reports: [...DEFAULT_COVERAGE_REPORTS], background: true, debounceSeconds: 20 },
    mutation: { reports: ['reports/mutation/mutation.json', 'reports/mutation/mutation-report.json', 'mutation.json', '.bmu/mutation.json'] },
    runners: {},
    report: { hookMaxLines: 3, contextMaxTokens: 400 },
  }
}

/** Deep-merge a partial user config over defaults. */
export function mergeConfig(base: BmuConfig, user: any): BmuConfig {
  if (!user || typeof user !== 'object') return base
  const out: any = structuredClone(base)
  const merge = (t: any, s: any) => {
    for (const [k, v] of Object.entries(s)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) merge(t[k], v)
      else t[k] = v
    }
  }
  // accept snake_case keys commonly used in YAML
  const norm = (o: any): any => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o
    const r: any = {}
    for (const [k, v] of Object.entries(o)) r[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = norm(v)
    return r
  }
  merge(out, norm(user))
  return out
}
