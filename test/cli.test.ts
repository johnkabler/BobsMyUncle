import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BIN = path.resolve('bin/bmu.js')
let root: string
const bmu = (args: string[], input?: string) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, input, encoding: 'utf8' })

beforeAll(() => {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { stdio: 'ignore' })
  root = mkdtempSync(path.join(tmpdir(), 'bmu-cli-'))
  cpSync('test/fixtures/ts-app', root, { recursive: true, filter: (s) => !s.includes('/.bmu') })
  execFileSync('git', ['init', '-q'], { cwd: root })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('cli', () => {
  it('scan / findings --json / explain', () => {
    expect(bmu(['scan']).stdout).toMatch(/15 modules/)
    const rows = JSON.parse(bmu(['findings', '--json']).stdout)
    expect(rows.map((r: any) => r.rule).sort()).toEqual(['cycle', 'layer', 'mutants', 'uncovered', 'uncovered'])
    expect(bmu(['explain', rows[0].id]).stdout).toMatch(new RegExp(rows[0].id))
  })

  it('grok post-tool hook emits additionalContext JSON only for new regressions', () => {
    bmu(['hook', 'session-start', '--harness', 'grok'], '{}')
    appendFileSync(path.join(root, 'src/core/domains/orders/order.repository.ts'), '\nimport { routes } from "@http/orders.controller"\nexport const n = routes.length\n')
    const r = bmu(['hook', 'post-tool', '--harness', 'grok'], JSON.stringify({ toolName: 'search_replace' }))
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput.additionalContext).toMatch(/dependency-rule violation/)
    const again = bmu(['hook', 'post-tool', '--harness', 'grok'], JSON.stringify({ toolName: 'run_terminal_command' }))
    expect(again.stdout).toBe('')
    // read-only tools are ignored entirely
    expect(bmu(['hook', 'post-tool', '--harness', 'grok'], JSON.stringify({ toolName: 'read_file' })).stdout).toBe('')
    // turn-end never prints a decision (would keep grok working)
    expect(bmu(['hook', 'turn-end', '--harness', 'grok'], '{}').stdout).toBe('')
    expect(readFileSync(path.join(root, '.bmu/context.md'), 'utf8')).toMatch(/bmu/)
  })

  it('opencode harness prints plain text; check exits 1 on findings', () => {
    appendFileSync(path.join(root, 'src/core/domains/users/user.entity.ts'), '\nimport { getOrder } from "@http/orders.controller"\nexport const g = getOrder\n')
    const r = bmu(['hook', 'post-tool', '--harness', 'opencode'], JSON.stringify({ tool: 'edit' }))
    expect(r.stdout).toMatch(/^bmu: 1 code-quality regression/)
    expect(bmu(['check', '--new']).status).toBe(1)
  })

  it('install grok/opencode (local) and mcp tools/list', () => {
    expect(bmu(['install', 'grok']).stdout).toMatch(/\.grok\/hooks\/bmu\.json/)
    expect(existsSync(path.join(root, '.grok/config.toml'))).toBe(true)
    expect(readFileSync(path.join(root, '.git/info/exclude'), 'utf8')).toMatch(/\.grok\/hooks\/bmu\.json/)
    expect(bmu(['install', 'opencode']).stdout).toMatch(/plugins\/bmu/)
    const mcp = bmu(['mcp'], ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'].join('\n') + '\n')
    const lines = mcp.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[1].result.tools.map((t: any) => t.name)).toContain('bmu_findings')
  })

  it('diagram prints mermaid', () => {
    expect(bmu(['diagram', 'src/core/application']).stdout).toMatch(/classDiagram/)
  })
})
