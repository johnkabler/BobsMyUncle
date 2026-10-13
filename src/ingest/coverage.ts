import path from 'node:path'

/** line number -> hit count, for one file */
export type LineHits = Map<number, number>
export type CoverageReport = Map<string, LineHits> // raw path as written in the report -> hits

export function parseLcov(text: string): CoverageReport {
  const out: CoverageReport = new Map()
  let cur: LineHits | null = null
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (l.startsWith('SF:')) {
      const file = l.slice(3)
      cur = out.get(file) ?? new Map()
      out.set(file, cur)
    } else if (l.startsWith('DA:') && cur) {
      const [ln, hits] = l.slice(3).split(',')
      const n = Number(ln)
      const h = Number(hits)
      if (Number.isFinite(n)) cur.set(n, Math.max(cur.get(n) ?? 0, Number.isFinite(h) ? h : 0))
    } else if (l === 'end_of_record') cur = null
  }
  return out
}

export function parseCobertura(xml: string): CoverageReport {
  const out: CoverageReport = new Map()
  const sources = [...xml.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => m[1].trim())
  const classRe = /<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g
  for (const m of xml.matchAll(classRe)) {
    let file = m[1]
    if (sources.length && !path.isAbsolute(file)) file = sources[0].replace(/\/$/, '') + '/' + file
    const hits = out.get(file) ?? new Map<number, number>()
    for (const lm of m[2].matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) {
      const n = Number(lm[1])
      hits.set(n, Math.max(hits.get(n) ?? 0, Number(lm[2])))
    }
    out.set(file, hits)
  }
  return out
}

export function parseCoverage(text: string): CoverageReport {
  return text.trimStart().startsWith('<') ? parseCobertura(text) : parseLcov(text)
}

/**
 * Build a mapper from report paths to repo-relative files. Handles absolute paths from CI or Docker
 * (`/app/lib/x.ex`, `/home/ci/work/repo/src/x.ts`) by longest-suffix match against known files.
 */
export function pathMapper(root: string, known: Iterable<string>): (raw: string) => string | null {
  const knownSet = new Set(known)
  const bySuffix = new Map<string, string[]>()
  for (const k of knownSet) {
    const base = k.split('/').pop()!
    const arr = bySuffix.get(base) ?? []
    arr.push(k)
    bySuffix.set(base, arr)
  }
  return (raw: string) => {
    const norm = raw.split('\\').join('/')
    if (knownSet.has(norm)) return norm
    if (path.isAbsolute(norm) && norm.startsWith(root + '/') && knownSet.has(norm.slice(root.length + 1))) return norm.slice(root.length + 1)
    if (knownSet.has(norm.replace(/^\.\//, ''))) return norm.replace(/^\.\//, '')
    let best: string | null = null
    for (const c of bySuffix.get(norm.split('/').pop()!) ?? []) if ((norm === c || norm.endsWith('/' + c)) && (!best || c.length > best.length)) best = c
    return best
  }
}

export function mapReportPaths(report: CoverageReport, root: string, known: Iterable<string>): Map<string, LineHits> {
  const map = pathMapper(root, known)
  const out = new Map<string, LineHits>()
  for (const [raw, hits] of report) {
    const rel = map(raw)
    if (!rel) continue
    const prev = out.get(rel)
    if (prev) for (const [l, h] of hits) prev.set(l, Math.max(prev.get(l) ?? 0, h))
    else out.set(rel, new Map(hits))
  }
  return out
}

/** Coverage of a [start,end] span: instrumented/covered line counts and uncovered lines. */
export function spanCoverage(hits: LineHits, start: number, end: number) {
  let instrumented = 0
  let covered = 0
  const uncovered: number[] = []
  for (const [l, h] of hits) {
    if (l < start || l > end) continue
    instrumented++
    if (h > 0) covered++
    else uncovered.push(l)
  }
  uncovered.sort((a, b) => a - b)
  return { instrumented, covered, uncovered, ratio: instrumented ? covered / instrumented : undefined }
}

export const crap = (cc: number, coverage: number) => cc * cc * Math.pow(1 - coverage, 3) + cc

/** Compress sorted line numbers into "12-15, 19" ranges. */
export function ranges(lines: number[]): string {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    let j = i
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`)
    i = j + 1
  }
  return out.join(', ')
}
