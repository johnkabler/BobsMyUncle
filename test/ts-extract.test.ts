import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractTypeScript } from '../src/lang/typescript.js'

const F = 'test/fixtures/ts-app/'
const ex = (p: string) => extractTypeScript(p, readFileSync(F + p, 'utf8'), 'h')

describe('typescript extractor', () => {
  it('extracts a tsyringe service with DI edges and complexity', async () => {
    const f = await ex('src/core/application/order.service.ts')
    const svc = f.elements.find((e) => e.name === 'OrderService')!
    expect(svc.kind).toBe('service')
    const apply = svc.members.find((m) => m.name === 'applyDiscount')!
    expect(apply.cc).toBeGreaterThanOrEqual(8)
    expect(svc.members.find((m) => m.name === 'helper')!.visibility).toBe('private')
    expect(f.refs).toContainEqual(expect.objectContaining({ from: 'OrderService', kind: 'injects', target: 'OrderRepository' }))
    expect(f.imports.find((i) => i.spec === '@domains/orders/order.repository')!.kind).toBe('type-only')
  })

  it('extracts TypeORM entities with associations', async () => {
    const f = await ex('src/core/domains/orders/order.entity.ts')
    const order = f.elements.find((e) => e.name === 'Order')!
    expect(order.kind).toBe('entity')
    expect(f.refs).toContainEqual(expect.objectContaining({ kind: 'association', target: 'User' }))
  })

  it('extracts implements and interfaces', async () => {
    const f = await ex('src/core/infra/order.repo.typeorm.ts')
    expect(f.refs).toContainEqual(expect.objectContaining({ kind: 'implements', target: 'OrderRepository' }))
    const i = await ex('src/core/domains/orders/order.repository.ts')
    expect(i.elements[0].kind).toBe('interface')
    expect(i.elements[0].members.map((m) => m.name)).toEqual(['find', 'save'])
  })

  it('extracts React components, hooks, stores and render edges', async () => {
    const list = await ex('src/ui/OrderList.tsx')
    expect(list.elements.find((e) => e.name === 'OrderList')!.kind).toBe('component')
    expect(list.refs).toContainEqual(expect.objectContaining({ kind: 'renders', target: 'OrderRow' }))
    expect(list.refs).toContainEqual(expect.objectContaining({ kind: 'uses-hook', target: 'useOrders' }))
    const row = await ex('src/ui/OrderRow.tsx')
    expect(row.elements[0].kind).toBe('component')
    const hook = await ex('src/ui/useOrders.ts')
    expect(hook.elements[0].kind).toBe('hook')
    const store = await ex('src/ui/store.ts')
    expect(store.elements[0].kind).toBe('store')
  })

  it('records re-exports and flags tests', async () => {
    const idx = await ex('src/core/helpers/index.ts')
    expect(idx.imports.map((i) => i.kind)).toEqual(['reexport', 'reexport'])
    const t = await ex('src/core/application/order.service.test.ts')
    expect(t.isTest).toBe(true)
  })
})
