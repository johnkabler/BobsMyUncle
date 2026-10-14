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

describe('claude code', () => {
  let croot: string
  const run = (args: string[], input?: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [BIN, ...args], { cwd: croot, input, encoding: 'utf8', env: { ...process.env, BMU_SKIP_MCP_REGISTER: '1', ...env } })
  beforeAll(() => {
    croot = mkdtempSync(path.join(tmpdir(), 'bmu-claude-'))
    cpSync('test/fixtures/ts-app', croot, { recursive: true, filter: (s) => !s.includes('/.bmu') })
    execFileSync('git', ['init', '-q'], { cwd: croot })
  })
  afterAll(() => rmSync(croot, { recursive: true, force: true }))

  it('installs local hooks into settings.local.json, idempotently, keeping other settings', () => {
    const { writeFileSync, mkdirSync } = require('node:fs')
    mkdirSync(path.join(croot, '.claude'), { recursive: true })
    writeFileSync(path.join(croot, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }))
    expect(run(['install', 'claude']).stdout).toMatch(/settings\.local\.json/)
    run(['install', 'claude', '--statusline'])
    const s = JSON.parse(readFileSync(path.join(croot, '.claude/settings.local.json'), 'utf8'))
    expect(s.permissions.allow).toEqual(['Bash(ls:*)'])
    for (const ev of ['SessionStart', 'PostToolUse', 'UserPromptSubmit', 'Stop']) {
      const cmds = s.hooks[ev].flatMap((g: any) => g.hooks.map((h: any) => h.command))
      expect(cmds.filter((c: string) => c.includes('hook'))).toHaveLength(1)
    }
    expect(s.statusLine.command).toMatch(/statusline/)
    expect(existsSync(path.join(croot, '.claude/rules/bmu.md'))).toBe(true)
    expect(readFileSync(path.join(croot, '.git/info/exclude'), 'utf8')).toMatch(/settings\.local\.json/)
  })

  it('SessionStart injects the prime brief; PostToolUse and UserPromptSubmit deliver regressions once', () => {
    const ss = run(['hook', 'session-start', '--harness', 'claude'], JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }))
    const ctx = JSON.parse(ss.stdout).hookSpecificOutput
    expect(ctx.hookEventName).toBe('SessionStart')
    expect(ctx.additionalContext).toMatch(/bmu prime/)
    appendFileSync(path.join(croot, 'src/core/domains/orders/order.repository.ts'), '\nimport { routes } from "@http/orders.controller"\nexport const n = routes.length\n')
    // edit made outside a tool call: picked up when the user sends the next prompt
    const up = JSON.parse(run(['hook', 'prompt-submit', '--harness', 'claude'], JSON.stringify({ prompt: 'hi' })).stdout).hookSpecificOutput
    expect(up.hookEventName).toBe('UserPromptSubmit')
    expect(up.additionalContext).toMatch(/dependency-rule violation/)
    const post = run(['hook', 'post-tool', '--harness', 'claude'], JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' } }))
    expect(post.stdout).toBe('')
  })

  it('stays silent inside grok when grok has its own bmu hooks', () => {
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(path.join(croot, '.grok/hooks'), { recursive: true })
    writeFileSync(path.join(croot, '.grok/hooks/bmu.json'), '{}')
    appendFileSync(path.join(croot, 'src/core/domains/users/user.entity.ts'), '\nimport { getOrder } from "@http/orders.controller"\nexport const g = getOrder\n')
    const r = run(['hook', 'post-tool', '--harness', 'claude'], JSON.stringify({ tool_name: 'Edit' }), { GROK_HOOK_EVENT: 'post_tool_use' })
    expect(r.stdout).toBe('')
  })
})

describe('claude plugin package', () => {
  it('hooks.json covers the same events as bmu install claude', async () => {
    const { claudeHooks } = await import('../src/cli/install.js')
    const plugin = JSON.parse(readFileSync('plugins/claude/hooks/hooks.json', 'utf8'))
    expect(Object.keys(plugin.hooks).sort()).toEqual(Object.keys(claudeHooks('bmu')).sort())
    for (const [ev, groups] of Object.entries<any>(plugin.hooks)) {
      const local = (claudeHooks('bmu') as any)[ev][0]
      expect(groups[0].matcher).toBe(local.matcher)
      expect(groups[0].hooks[0].args.join(' ')).toBe(local.hooks[0].command.replace(/^bmu /, ''))
    }
    const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'))
    expect(market.plugins[0].source).toBe('./plugins/claude')
  })
})
