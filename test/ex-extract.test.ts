import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractElixir, isExTestFile, exComplexity } from '../src/lang/elixir.js'
import { getParser } from '../src/lang/treesitter.js'

const F = 'test/fixtures/ex-app/'
const ex = (p: string) => extractElixir(p, readFileSync(F + p, 'utf8'), 'h')

describe('elixir extractor', () => {
  it('extracts defines including nested modules', async () => {
    const f = await ex('lib/shop/orders.ex')
    expect(f.defines).toContain('Shop.Orders')
    expect(f.defines).toContain('Shop.Orders.Stats')
    expect(f.elements.map((e) => e.name)).toEqual(expect.arrayContaining(['Shop.Orders', 'Shop.Orders.Stats']))
  })

  it('detects entity kind and associations with labels', async () => {
    const user = await ex('lib/shop/accounts/user.ex')
    const u = user.elements.find((e) => e.name === 'Shop.Accounts.User')!
    expect(u.kind).toBe('entity')
    expect(user.refs).toContainEqual(
      expect.objectContaining({
        from: 'Shop.Accounts.User',
        kind: 'association',
        target: 'Shop.Orders.Order',
        label: 'orders 1..*',
      }),
    )
    expect(u.members.some((m) => m.name === 'email' && m.kind === 'field' && m.type === 'string')).toBe(true)

    const order = await ex('lib/shop/orders/order.ex')
    const o = order.elements.find((e) => e.name === 'Shop.Orders.Order')!
    expect(o.kind).toBe('entity')
    expect(order.refs).toContainEqual(
      expect.objectContaining({
        kind: 'association',
        target: 'Shop.Accounts.User',
        label: 'user *..1',
      }),
    )
  })

  it('detects behaviour, live_view, controller, worker, protocol', async () => {
    const gw = await ex('lib/shop/payments/gateway.ex')
    expect(gw.elements[0]!.kind).toBe('behaviour')
    expect(gw.elements[0]!.members.filter((m) => m.kind === 'callback').map((m) => m.name)).toEqual(
      expect.arrayContaining(['charge/2', 'refund/1']),
    )

    const lv = await ex('lib/shop_web/live/order_live.ex')
    expect(lv.elements[0]!.kind).toBe('live_view')

    const ctrl = await ex('lib/shop_web/controllers/order_controller.ex')
    expect(ctrl.elements[0]!.kind).toBe('controller')

    const w = await ex('lib/shop/workers/sync_worker.ex')
    expect(w.elements[0]!.kind).toBe('worker')

    const proto = await ex('lib/shop/render.ex')
    expect(proto.elements.find((e) => e.name === 'Shop.Render')!.kind).toBe('protocol')
    expect(proto.defines).toContain('Shop.Render')
    expect(proto.defines).toContain('Shop.Render.Shop.Orders.Order')
    expect(proto.refs).toContainEqual(
      expect.objectContaining({ from: 'Shop.Render.Shop.Orders.Order', kind: 'implements', target: 'Shop.Render' }),
    )
  })

  it('merges multi-clause functions with arity naming and complexity', async () => {
    const f = await ex('lib/shop/orders.ex')
    const mod = f.elements.find((e) => e.name === 'Shop.Orders')!
    const list = mod.members.find((m) => m.name === 'list_orders/1')!
    expect(list).toBeDefined()
    expect(list.arity).toBe(1)
    // 2 clauses: guard clause + catch-all; cc includes bodies + (clauses-1) + guards
    expect(list.cc!).toBeGreaterThanOrEqual(3)
    expect(list.start).toBeLessThan(list.end)

    const list0 = mod.members.find((m) => m.name === 'list_orders/0')!
    expect(list0).toBeDefined()

    const build = mod.members.find((m) => m.name === 'build/2')!
    expect(build.visibility).toBe('private')

    const create = mod.members.find((m) => m.name === 'create_order/2')!
    expect(create.cc!).toBeGreaterThanOrEqual(2)
  })

  it('records @behaviour implements and compile-time imports', async () => {
    const stripe = await ex('lib/shop/payments/stripe.ex')
    expect(stripe.refs).toContainEqual(
      expect.objectContaining({
        from: 'Shop.Payments.Stripe',
        kind: 'implements',
        target: 'Shop.Payments.Gateway',
      }),
    )
    expect(stripe.imports).toContainEqual(
      expect.objectContaining({ spec: 'Shop.Payments.Gateway', kind: 'compile-time' }),
    )
  })

  it('expands multi-alias Shop.{Repo, Orders.Order}', async () => {
    const f = await ex('lib/shop/orders.ex')
    expect(f.imports).toContainEqual(expect.objectContaining({ spec: 'Shop.Repo', kind: 'import', names: ['Repo'] }))
    expect(f.imports).toContainEqual(
      expect.objectContaining({ spec: 'Shop.Orders.Order', kind: 'import', names: ['Order'] }),
    )
    // remote calls / struct via expanded alias
    expect(f.imports.some((i) => i.kind === 'call' && i.spec === 'Shop.Repo')).toBe(true)
  })

  it('records use/import/require as compile-time and remote calls', async () => {
    const user = await ex('lib/shop/accounts/user.ex')
    expect(user.imports).toContainEqual(expect.objectContaining({ spec: 'Ecto.Schema', kind: 'compile-time' }))
    expect(user.imports).toContainEqual(expect.objectContaining({ spec: 'Ecto.Changeset', kind: 'compile-time' }))

    const bad = await ex('lib/shop/orders/bad.ex')
    expect(bad.imports).toContainEqual(
      expect.objectContaining({ spec: 'ShopWeb.OrderLive', kind: 'call' }),
    )

    const lv = await ex('lib/shop_web/live/order_live.ex')
    expect(lv.imports).toContainEqual(expect.objectContaining({ spec: 'ShopWeb', kind: 'compile-time' }))
    expect(lv.imports).toContainEqual(expect.objectContaining({ spec: 'Shop.Orders', kind: 'call' }))
  })

  it('flags test files including test/support', async () => {
    expect(isExTestFile('test/shop/orders_test.exs')).toBe(true)
    expect(isExTestFile('test/support/data_case.ex')).toBe(true)
    expect(isExTestFile('lib/shop/orders.ex')).toBe(false)
    expect(isExTestFile('foo_test.exs')).toBe(true)

    const t = await ex('test/shop/orders_test.exs')
    expect(t.isTest).toBe(true)
    const s = await ex('test/support/data_case.ex')
    expect(s.isTest).toBe(true)
  })

  it('parses Elixir 1.17+ syntax without parseError', async () => {
    const src = `defmodule Shop.Modern do
  def foo(x) do
    dbg(x)
    y = x || 0
    for i <- 1..3, reduce: 0 do
      acc -> acc + i
    end
  end
end
`
    const f = await extractElixir('lib/shop/modern.ex', src, 'h')
    expect(f.parseError).toBeUndefined()
    expect(f.elements[0]!.name).toBe('Shop.Modern')
  })

  it('exComplexity counts if/case/with/logical/when/fn clauses', async () => {
    const parser = await getParser('elixir')
    const src = `def f(x) when x > 0 do
  if x || false do
    case x do
      1 -> :a
      2 -> :b
    end
  else
    with {:ok, a} <- g(x),
         {:ok, b} <- h(a) do
      fn
        1 -> :x
        2 -> :y
      end
    end
  end
end
`
    const tree = parser.parse(src)!
    const cc = exComplexity(tree.rootNode)
    // base 1 + when + if + || + case(1) + with arrows(1) + fn clauses(1) = at least 6
    expect(cc).toBeGreaterThanOrEqual(6)
  })
})
