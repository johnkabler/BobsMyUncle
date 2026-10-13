import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/store/db.js'
import { analyze, reconcile } from '../src/engine/analyze.js'
import { loadConfig } from '../src/engine/files.js'
import { affectedTests } from '../src/engine/build.js'
import { hookMessage, prime } from '../src/report/format.js'
import { diagram } from '../src/report/mermaid.js'

function copyFixture(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), `bmu-${name}-`))
  cpSync(path.join('test/fixtures', name), dir, { recursive: true, filter: (s) => !s.includes('/.bmu') })
  return dir
}

async function run(root: string, mark = true) {
  const store = new Store(root)
  const config = loadConfig(root)
  const a = await analyze(root, store, config)
  const d = reconcile(store, a.findings, { mark })
  return { store, config, a, d }
}

describe('pipeline: typescript fixture', () => {
  let root: string
  beforeEach(() => {
    root = copyFixture('ts-app')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('first scan becomes the baseline; new regressions are reported once', async () => {
    const r1 = await run(root)
    expect(r1.a.findings.map((f) => f.rule).sort()).toEqual(['cycle', 'layer', 'uncovered', 'uncovered'])
    expect(r1.d.fresh).toHaveLength(0) // baseline: existing debt is not reported
    r1.store.close()

    // introduce a new layer violation and a complex function
    appendFileSync(
      path.join(root, 'src/core/domains/users/user.entity.ts'),
      `\nimport { getOrder } from '@http/orders.controller'\nexport function messy(a: number, b: string) {\n  if (a > 1 && b) return 1\n  if (a > 2 || !b) return 2\n  for (const x of [1,2]) { if (x) a++ }\n  while (a < 10) { a += b ? 1 : 2 }\n  switch (b) { case 'x': return 3; case 'y': return 4; case 'z': return 5 }\n  try { a = a ?? 0 } catch { a = 0 }\n  return a > 5 ? (b ? 6 : 7) : a < 0 ? 8 : getOrder ? 9 : 10\n}\n`,
    )
    const r2 = await run(root)
    const rules = r2.d.fresh.map((f) => f.rule).sort()
    expect(rules).toContain('layer')
    expect(rules).toContain('complexity')
    const msg = hookMessage(r2.d, 3)
    expect(msg).toMatch(/regression/)
    expect(msg).toMatch(/user\.entity\.ts/)
    r2.store.close()

    // nothing changed: nothing reported again
    const r3 = await run(root)
    expect(r3.d.fresh).toHaveLength(0)
    expect(r3.d.worse).toHaveLength(0)
    expect(hookMessage(r3.d, 3)).toBe('')

    // ack the complexity finding, then fix the layer violation -> resolved
    const cx = r3.store.allFindings().find((f) => f.rule === 'complexity')!
    expect(r3.store.ack(cx.id, 'legacy')).toBe(true)
    r3.store.close()
    const src = readFileSync(path.join(root, 'src/core/domains/users/user.entity.ts'), 'utf8')
    writeFileSync(path.join(root, 'src/core/domains/users/user.entity.ts'), src.replace("import { getOrder } from '@http/orders.controller'", 'const getOrder = 1'))
    const r4 = await run(root)
    expect(r4.d.resolved.map((f) => f.rule)).toContain('layer')
    expect(r4.d.fresh).toHaveLength(0)
    r4.store.close()
  })

  it('computes CRAP from coverage, affected tests and diagrams', async () => {
    const { a, store } = await run(root)
    const svc = a.model.elements.get('src/core/application/order.service.ts#OrderService')!
    const m = svc.members.find((x) => x.name === 'applyDiscount')!
    expect(m.metrics.coverage).toBeCloseTo(8 / 12, 2)
    expect(m.metrics.crap).toBeGreaterThan(10)
    expect(affectedTests(a.model, ['src/core/domains/orders/order.entity.ts'])).toEqual(['src/core/application/order.service.test.ts'])
    const mm = diagram(a, { level: 'src/core/application', view: 'classes' })
    expect(mm).toMatch(/classDiagram/)
    expect(mm).toMatch(/<<service>>/)
    expect(mm).toMatch(/injects/)
    expect(prime(a, store)).toMatch(/Dependency rule/)
    const comp = diagram(a, { level: '', view: 'components', interactive: true })
    expect(comp).toMatch(/flowchart TB/)
    expect(comp).toMatch(/click n_src call bmuOpen\("src"\)/)
    const core = diagram(a, { level: 'src', view: 'components' })
    expect(core).toMatch(/linkStyle/) // red dependency-rule violation edge core -> http
    expect(diagram(a, { level: 'src/core/helpers' })).toMatch(/classDiagram/)
    // appending code keeps existing members' coverage fresh; editing a member makes only it stale
    store.close()
    appendFileSync(path.join(root, 'src/core/application/order.service.ts'), '\nexport const later = 1\n')
    const r2 = await run(root, false)
    const fresh = r2.a.model.elements.get('src/core/application/order.service.ts#OrderService')!.members.find((x) => x.name === 'applyDiscount')!
    expect(fresh.metrics.stale).toBeUndefined()
    r2.store.close()
    const src = readFileSync(path.join(root, 'src/core/application/order.service.ts'), 'utf8')
    writeFileSync(path.join(root, 'src/core/application/order.service.ts'), src.replace("discount = 10", "discount = 11"))
    const r3 = await run(root, false)
    const ms = r3.a.model.elements.get('src/core/application/order.service.ts#OrderService')!.members
    expect(ms.find((x) => x.name === 'applyDiscount')!.metrics.stale).toBe(true)
    expect(ms.find((x) => x.name === 'helper')!.metrics.stale).toBeUndefined()
    r3.store.close()
  })
})

describe('pipeline: python + elixir fixtures', () => {
  it('python: layer violation, DI and Django associations resolve', async () => {
    const root = copyFixture('py-app')
    const { a, store } = await run(root)
    expect(a.findings.some((f) => f.rule === 'layer' && f.subject.startsWith('src/app/domain/bad.py'))).toBe(true)
    const kinds = a.model.elementEdges.map((e) => e.kind)
    expect(kinds).toContain('association')
    expect(kinds).toContain('injects')
    expect(affectedTests(a.model, ['src/app/domain/models.py'])).toContain('tests/unit/test_service.py')
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('elixir: module index resolution, behaviours, layer violation', async () => {
    const root = copyFixture('ex-app')
    const { a, store } = await run(root)
    expect(a.findings.some((f) => f.rule === 'layer' && f.subject.startsWith('lib/shop/orders/bad.ex'))).toBe(true)
    expect(a.model.elementEdges.some((e) => e.kind === 'implements' && e.to.endsWith('#Shop.Payments.Gateway'))).toBe(true)
    expect(a.model.elementEdges.some((e) => e.kind === 'association')).toBe(true)
    const money = a.model.elements.get('lib/shop/render.ex#Shop.Money')!
    expect(money.kind).toBe('struct')
    expect(money.members.filter((m) => m.kind === 'field').map((m) => m.name)).toEqual(['amount', 'currency', 'precision'])
    expect(affectedTests(a.model, ['lib/shop/orders/order.ex'])).toContain('test/shop/orders_test.exs')
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
})

import { inferLayers, inferPhoenixLayers, detectElixirWrap } from '../src/engine/init.js'
describe('init inference', () => {
  it('infers clean-architecture layers including sibling outer layers', () => {
    expect(inferLayers('test/fixtures/ts-app')).toEqual([['src/core/domains'], ['src/core/application'], ['src/core/infra'], ['src/http', 'src/ui']])
    expect(inferLayers('test/fixtures/py-app')).toEqual([['src/app/domain'], ['src/app/application'], ['src/app/infrastructure'], ['src/app/api']])
  })
  it('infers Phoenix layers and docker-wrapped mix test', () => {
    expect(inferPhoenixLayers('test/fixtures/ex-app')).toEqual([['lib/shop'], ['lib/shop_web']])
    const dir = mkdtempSync(path.join(tmpdir(), 'bmu-just-'))
    writeFileSync(path.join(dir, 'justfile'), 'compose := "docker compose"\ntest *args:\n    {{compose}} exec app mix test {{args}}\n')
    expect(detectElixirWrap(dir)).toBe('docker compose exec -T {env} app {cmd}')
    rmSync(dir, { recursive: true, force: true })
  })
})

import { execFileSync } from 'node:child_process'
import { findingsAt, structuralFindings, diffFindings } from '../src/engine/baseline.js'
describe('diff vs git ref', () => {
  it('reports structural findings added since a commit', async () => {
    const root = copyFixture('ts-app')
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' })
    g('init', '-q')
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
    appendFileSync(path.join(root, 'src/core/domains/orders/order.repository.ts'), '\nimport { routes } from "@http/orders.controller"\nexport const n = routes.length\n')
    const { store, config, a } = await run(root, false)
    const base = await findingsAt(root, store, config, 'HEAD')
    const d = diffFindings(base.findings, structuralFindings(a), base.sha)
    expect(d.added.map((f) => f.rule)).toEqual(['layer'])
    expect(d.fixed).toHaveLength(0)
    // cached by sha the second time
    expect(store.getCommitSummary(base.sha)).not.toBeNull()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
})
