/** Mutation-testing results per file: one entry per mutant. */
export interface Mutant {
  line: number
  status: 'killed' | 'survived' | 'nocoverage' | 'timeout' | 'other'
  mutator: string
}
export type MutationReport = Map<string, Mutant[]>

const norm = (s: string): Mutant['status'] => {
  const x = s.toLowerCase()
  if (x === 'killed') return 'killed'
  if (x === 'survived') return 'survived'
  if (x === 'nocoverage' || x === 'no_coverage' || x === 'uncovered') return 'nocoverage'
  if (x === 'timeout') return 'timeout'
  return 'other'
}

/**
 * Stryker's mutation-testing-report-schema (also emitted by Stryker.NET/4s and several other tools):
 * { files: { "<path>": { mutants: [{ mutatorName, location: { start: { line } }, status }] } } }
 * Also accepts a generic `{ mutants: [{ file, line, status, mutator }] }` list (e.g. converted mutmut/Muex output).
 */
export function parseMutationReport(text: string): MutationReport {
  const out: MutationReport = new Map()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    return out
  }
  if (json && typeof json.files === 'object' && !Array.isArray(json.files)) {
    for (const [file, data] of Object.entries<any>(json.files)) {
      const list: Mutant[] = []
      for (const m of data?.mutants ?? []) {
        const line = m?.location?.start?.line
        if (typeof line !== 'number') continue
        list.push({ line, status: norm(String(m.status ?? '')), mutator: String(m.mutatorName ?? m.mutator ?? '?') })
      }
      out.set(file, list)
    }
  } else if (Array.isArray(json?.mutants)) {
    for (const m of json.mutants) {
      if (!m?.file || typeof m.line !== 'number') continue
      const arr = out.get(m.file) ?? []
      arr.push({ line: m.line, status: norm(String(m.status ?? '')), mutator: String(m.mutator ?? m.mutatorName ?? '?') })
      out.set(m.file, arr)
    }
  }
  return out
}
