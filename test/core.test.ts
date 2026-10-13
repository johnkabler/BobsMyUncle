import { describe, it, expect } from 'vitest'
import { findCycles, cyclePath, ruleViolations } from '../src/core/graph.js'
import { stabilizeCycleIds, findingId, type Finding } from '../src/core/findings.js'
import { parseLcov, parseCobertura, mapReportPaths, spanCoverage, crap, ranges } from '../src/ingest/coverage.js'
import { mergeConfig, defaultConfig } from '../src/core/config.js'

const e = (from: string, to: string) => ({ from, to, kind: 'import' as const })

describe('graph', () => {
  it('finds SCCs and a readable cycle path', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('c', 'd'), e('x', 'y')]
    const cycles = findCycles(['a', 'b', 'c', 'd', 'x', 'y'], edges)
    expect(cycles).toEqual([['a', 'b', 'c']])
    expect(cyclePath(cycles[0], edges)).toEqual(['a', 'b', 'c', 'a'])
  })

  it('applies the dependency rule with longest-prefix layer matching', () => {
    const v = ruleViolations([e('src/domain/x.ts', 'src/http/y.ts'), e('src/http/y.ts', 'src/domain/x.ts')], {
      layers: [['src/domain'], ['src/http']],
      forbidden: [{ from: 'src/http', to: 'src/domain/x.ts' }],
    })
    expect(v.map((x) => x.rule)).toEqual(['layer', 'forbidden'])
    expect(v[0].from).toBe('src/domain/x.ts')
  })
})

describe('findings', () => {
  it('keeps cycle ids stable as an SCC grows', () => {
    const mk = (members: string[]): Finding => ({ id: findingId('cycle', members.join('|')), rule: 'cycle', subject: members.join('|'), file: members[0], value: members.length, severity: 'high', message: 'cycle' })
    const prev = mk(['a', 'b', 'c'])
    const grown = mk(['a', 'b', 'c', 'd'])
    stabilizeCycleIds([grown], [{ id: prev.id, subject: prev.subject }])
    expect(grown.id).toBe(prev.id)
    expect(grown.message).toMatch(/new in cycle: d/)
    const unrelated = mk(['x', 'y'])
    const id = unrelated.id
    stabilizeCycleIds([unrelated], [{ id: prev.id, subject: prev.subject }])
    expect(unrelated.id).toBe(id)
  })
})

describe('coverage ingest', () => {
  it('parses LCOV and Cobertura and maps CI/Docker paths by suffix', () => {
    const lcov = parseLcov('SF:/app/lib/shop/orders.ex\nDA:1,1\nDA:2,0\nend_of_record\n')
    const cob = parseCobertura('<coverage><sources><source>/home/ci/repo</source></sources><packages><package><classes><class filename="src/x.py"><lines><line number="3" hits="2"/><line number="4" hits="0"/></lines></class></classes></package></packages></coverage>')
    const mapped = mapReportPaths(new Map([...lcov, ...cob]), '/Users/me/repo', ['lib/shop/orders.ex', 'src/x.py', 'other/x.py'])
    expect([...mapped.keys()].sort()).toEqual(['lib/shop/orders.ex', 'src/x.py'])
    const sc = spanCoverage(mapped.get('src/x.py')!, 1, 10)
    expect(sc).toMatchObject({ instrumented: 2, covered: 1, uncovered: [4] })
    expect(crap(10, 0)).toBe(110)
    expect(crap(10, 1)).toBe(10)
    expect(ranges([1, 2, 3, 7, 9, 10])).toBe('1-3, 7, 9-10')
  })
})

describe('config', () => {
  it('merges snake_case YAML over defaults', () => {
    const c = mergeConfig(defaultConfig(), { thresholds: { crap: 12 }, coverage: { debounce_seconds: 5 }, runners: { elixir: { wrap: 'docker compose exec app {cmd}' } } })
    expect(c.thresholds.crap).toBe(12)
    expect(c.thresholds.cc).toBe(15)
    expect(c.coverage.debounceSeconds).toBe(5)
    expect(c.runners.elixir?.wrap).toMatch(/docker/)
  })
})

import { globToRegExp } from '../src/engine/files.js'
describe('globs', () => {
  it('translates ** and * globs', () => {
    expect(globToRegExp('test/fixtures/**').test('test/fixtures/a/b.ts')).toBe(true)
    expect(globToRegExp('**/*.spec.ts').test('src/a/b.spec.ts')).toBe(true)
    expect(globToRegExp('**/*.spec.ts').test('b.spec.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true)
  })
})
