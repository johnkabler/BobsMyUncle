import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractPython, isPyTestFile, pyComplexity } from '../src/lang/python.js'
import { getParser } from '../src/lang/treesitter.js'

const F = 'test/fixtures/py-app/'
const ex = (p: string) => extractPython(p, readFileSync(F + p, 'utf8'), 'h')

describe('python extractor', () => {
  it('extracts absolute, relative, aliased, and type-only imports', async () => {
    const svc = await ex('src/app/application/service.py')
    const rel = svc.imports.find((i) => i.spec === 'domain.models')
    expect(rel).toMatchObject({ names: ['Order'], level: 2, kind: 'import' })
    const ports = svc.imports.find((i) => i.spec === 'domain.ports')
    expect(ports).toMatchObject({ names: ['OrderRepository'], level: 2 })

    const tools = await ex('src/app/api/tools.py')
    const typeOnly = tools.imports.find((i) => i.spec === 'app.application.service')
    expect(typeOnly).toMatchObject({ names: ['OrderService'], kind: 'type-only' })

    const models = await ex('src/app/domain/models.py')
    expect(models.imports.find((i) => i.spec === 'django.db')!.names).toContain('models')
    expect(models.imports.find((i) => i.spec === 'app.domain.users')).toMatchObject({
      names: ['User'],
      kind: 'import',
    })

    // alias + bare import
    const aliased = await extractPython(
      'x.py',
      'import a.b as x\nfrom pkg import c, d as e\n',
      'h',
    )
    expect(aliased.imports).toContainEqual(
      expect.objectContaining({ spec: 'a.b', names: ['*'], aliases: { x: 'a.b' }, kind: 'import' }),
    )
    expect(aliased.imports).toContainEqual(
      expect.objectContaining({
        spec: 'pkg',
        names: ['c', 'd'],
        aliases: { e: 'd' },
        kind: 'import',
      }),
    )

    // relative from . import y
    const relDot = await extractPython('x.py', 'from . import y\nfrom ..x import z\n', 'h')
    expect(relDot.imports).toContainEqual(
      expect.objectContaining({ spec: '', names: ['y'], level: 1 }),
    )
    expect(relDot.imports).toContainEqual(
      expect.objectContaining({ spec: 'x', names: ['z'], level: 2 }),
    )

    // from __future__ ignored
    const fut = await extractPython('x.py', 'from __future__ import annotations\nimport os\n', 'h')
    expect(fut.imports.map((i) => i.spec)).toEqual(['os'])
  })

  it('classifies entity, interface, and container kinds', async () => {
    const models = await ex('src/app/domain/models.py')
    expect(models.elements.find((e) => e.name === 'Order')!.kind).toBe('entity')
    expect(models.elements.find((e) => e.name === 'OrderDTO')!.kind).toBe('class')

    const ports = await ex('src/app/domain/ports.py')
    expect(ports.elements.find((e) => e.name === 'OrderRepository')!.kind).toBe('interface')

    const cont = await ex('src/app/infrastructure/container.py')
    const c = cont.elements.find((e) => e.name === 'Container')!
    expect(c.kind).toBe('container')
  })

  it('extracts Django association with multiplicity label', async () => {
    const models = await ex('src/app/domain/models.py')
    expect(models.refs).toContainEqual(
      expect.objectContaining({
        from: 'Order',
        kind: 'association',
        target: 'User',
        label: 'user *..1',
      }),
    )
    // pydantic annotated associations
    expect(models.refs).toContainEqual(
      expect.objectContaining({ from: 'OrderDTO', kind: 'association', target: 'User' }),
    )
    expect(models.refs).toContainEqual(
      expect.objectContaining({ from: 'OrderDTO', kind: 'association', target: 'Order' }),
    )
  })

  it('extracts dependency-injector injects edges', async () => {
    const cont = await ex('src/app/infrastructure/container.py')
    expect(cont.refs).toContainEqual(
      expect.objectContaining({ from: 'Container', kind: 'injects', target: 'OrderService' }),
    )
  })

  it('module element carries tools and routes', async () => {
    const tools = await ex('src/app/api/tools.py')
    const mod = tools.elements.find((e) => e.kind === 'module')!
    expect(mod.members.find((m) => m.name === 'list_orders')!.kind).toBe('tool')
    expect(mod.members.find((m) => m.name === 'get_order_resource')!.kind).toBe('tool')

    const routes = await ex('src/app/api/routes.py')
    const rmod = routes.elements.find((e) => e.kind === 'module')!
    expect(rmod.members.find((m) => m.name === 'get_x')!.kind).toBe('route')
    expect(routes.imports.find((i) => i.spec === 'app.application.service')).toBeTruthy()
  })

  it('records method visibility and complexity', async () => {
    const svc = await ex('src/app/application/service.py')
    const cls = svc.elements.find((e) => e.name === 'OrderService')!
    expect(cls.members.find((m) => m.name === 'apply_discount')!.visibility).toBe('public')
    expect(cls.members.find((m) => m.name === '_helper')!.visibility).toBe('protected')
    expect(cls.members.find((m) => m.name === '__secret')!.visibility).toBe('private')
    const apply = cls.members.find((m) => m.name === 'apply_discount')!
    expect(apply.cc).toBeGreaterThanOrEqual(6)
  })

  it('detects test files', () => {
    expect(isPyTestFile('tests/unit/test_service.py')).toBe(true)
    expect(isPyTestFile('tests/conftest.py')).toBe(true)
    expect(isPyTestFile('src/app/foo_test.py')).toBe(true)
    expect(isPyTestFile('src/app/test_foo.py')).toBe(true)
    expect(isPyTestFile('src/app/application/service.py')).toBe(false)
  })

  it('flags tests and the intentional domain→api layer violation import', async () => {
    const t = await ex('tests/unit/test_service.py')
    expect(t.isTest).toBe(true)
    const integ = await ex('tests/integration/test_db.py')
    expect(integ.isTest).toBe(true)
    const bad = await ex('src/app/domain/bad.py')
    expect(bad.imports).toContainEqual(
      expect.objectContaining({ spec: 'app.api.routes', names: ['get_x'] }),
    )
  })

  it('parses Python 3.14 syntax without parseError', async () => {
    const src = [
      't = t"hi {x}"',
      'type Alias = int',
      'def f(x):',
      '    match x:',
      '        case 1:',
      '            return 1',
      '        case 2 if True:',
      '            return 2',
      '        case _:',
      '            return 0',
      '',
    ].join('\n')
    const f = await extractPython('src/app/py314.py', src, 'h')
    expect(f.parseError).toBeFalsy()
    expect(f.lang).toBe('python')
  })

  it('pyComplexity counts decisions including boolean ops and comprehensions', async () => {
    const parser = await getParser('python')
    const src = `
def f(a, b, c):
    if a:
        pass
    elif b:
        pass
    for i in range(3):
        while False:
            pass
    try:
        pass
    except ValueError:
        pass
    y = a if b else c
    z = a and b or c
    xs = [i for i in range(3) if i > 0]
    return (lambda t: t + 1 if t else 0)(a)
`
    const tree = parser.parse(src)!
    const fn = tree.rootNode.namedChild(0)!
    // 1 base + if + elif + for + while + except + conditional + and + or + for_in + if_clause + lambda conditional
    expect(pyComplexity(fn)).toBeGreaterThanOrEqual(10)
  })
})
