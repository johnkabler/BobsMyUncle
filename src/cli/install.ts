import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const bmuBin = path.join(pkgRoot, 'bin', 'bmu.js')

/** Command used inside hooks: prefer `bmu` on PATH, fall back to this install's absolute path. */
export function bmuCommand(): string {
  try {
    const p = execFileSync('sh', ['-c', 'command -v bmu'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (p) return 'bmu'
  } catch {
    /* not on PATH */
  }
  return `node ${JSON.stringify(bmuBin).slice(1, -1).replace(/ /g, '\\ ')}`
}

const AGENTS_MARKER = '<!-- bmu:begin -->'
export const AGENTS_SNIPPET = `${AGENTS_MARKER}
## bmu (BobsMyUncle) code-quality monitor

This repo is watched by \`bmu\`. It reports **regressions you introduce** (CRAP/complexity spikes, newly uncovered lines,
import cycles, dependency-rule violations) right after your edits. It never blocks you.

- At the start of a task run \`bmu prime\` (or the \`bmu_prime\` MCP tool) to see the architecture brief and current findings.
- When a bmu note appears after an edit: fix it if it is in scope, otherwise run \`bmu ack <id> "<reason>"\`.
- \`bmu explain <id|file|Element>\` for details, \`bmu diagram <dir>\` for a Mermaid UML slice, \`bmu findings --new\` for the list.
- Pre-existing debt is listed separately; don't fix it unless asked.
<!-- bmu:end -->
`

function addAgentsSnippet(root: string, order: string[] = ['AGENTS.md', 'CLAUDE.md']): string | null {
  for (const name of order) {
    const p = path.join(root, name)
    if (existsSync(p)) {
      const txt = readFileSync(p, 'utf8')
      if (txt.includes(AGENTS_MARKER)) return null
      appendFileSync(p, (txt.endsWith('\n') ? '\n' : '\n\n') + AGENTS_SNIPPET)
      return name
    }
  }
  writeFileSync(path.join(root, order[0]), AGENTS_SNIPPET)
  return order[0]
}

function isTracked(root: string, rel: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Keep files out of git without touching the shared .gitignore. */
export function excludeLocally(root: string, entries: string[]) {
  let gitDir: string
  try {
    gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return
  }
  const p = path.resolve(root, gitDir, 'info', 'exclude')
  mkdirSync(path.dirname(p), { recursive: true })
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const missing = entries.filter((e) => !cur.split('\n').includes(e))
  if (missing.length) appendFileSync(p, (cur.endsWith('\n') || !cur ? '' : '\n') + '# bmu (local install)\n' + missing.join('\n') + '\n')
}

export function grokHooksJson(cmd: string) {
  return {
    hooks: {
      SessionStart: [{ matcher: 'startup|clear', hooks: [{ type: 'command', command: `${cmd} hook session-start --harness grok`, timeout: 30 }] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|Bash|write|edit|search_replace|run_terminal_command', hooks: [{ type: 'command', command: `${cmd} hook post-tool --harness grok`, timeout: 60 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${cmd} hook turn-end --harness grok`, timeout: 10 }] }],
    },
  }
}

export function installGrok(root: string, opts: { local: boolean }): string[] {
  const cmd = bmuCommand()
  const dir = path.join(root, '.grok', 'hooks')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'bmu.json')
  writeFileSync(file, JSON.stringify(grokHooksJson(cmd), null, 2) + '\n')
  const done = [`wrote .grok/hooks/bmu.json`]
  // project-scoped MCP server so grok gets native bmu_* tools
  const cfg = path.join(root, '.grok', 'config.toml')
  const cur = existsSync(cfg) ? readFileSync(cfg, 'utf8') : ''
  const tracked = isTracked(root, '.grok/config.toml')
  if (tracked && opts.local) {
    done.push('skipped MCP registration: .grok/config.toml is tracked by git (local install never edits team files); hooks + rules still work. Use --shared to add it.')
  } else if (!cur.includes('[mcp_servers.bmu]')) {
    const [exe, ...rest] = cmd === 'bmu' ? ['bmu'] : [process.execPath, bmuBin]
    appendFileSync(cfg, `${cur && !cur.endsWith('\n') ? '\n' : ''}\n[mcp_servers.bmu]\ncommand = ${JSON.stringify(exe)}\nargs = ${JSON.stringify([...rest, 'mcp'])}\nstartup_timeout_sec = 30\n`)
    done.push('registered the bmu MCP server in .grok/config.toml (native bmu_* tools)')
  }
  const agents = opts.local ? null : addAgentsSnippet(root)
  if (agents) done.push(`added bmu section to ${agents}`)
  // local mode: write instructions into a local-only rules file grok reads, and hide everything from git
  if (opts.local) {
    const rules = path.join(root, '.grok', 'rules')
    mkdirSync(rules, { recursive: true })
    writeFileSync(path.join(rules, 'bmu.md'), AGENTS_SNIPPET)
    done.push('wrote .grok/rules/bmu.md (agent instructions)')
    excludeLocally(root, ['.grok/hooks/bmu.json', '.grok/rules/bmu.md', ...(isTracked(root, '.grok/config.toml') ? [] : ['.grok/config.toml']), '.bmu/'])
    done.push('added them to .git/info/exclude (local only; teammates unaffected)')
  }
  excludeLocally(root, ['.bmu/'])
  done.push('next: start grok here and run /hooks-trust once (project hooks need folder trust)')
  done.push('optional status bar: add to ~/.grok/config.toml →  [ui.status_line] type = "command"  command = "bmu statusline"')
  done.push('optional live events: ask grok to run `bmu watch` with its monitor tool (persistent)')
  return done
}

export function opencodePluginSource(nodePath: string, bin: string): string {
  return `// bmu (BobsMyUncle) OpenCode V2 plugin — generated by \`bmu install opencode\`.
// Reports code-quality regressions in-band after edits and exposes bmu tools. Never blocks.
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const NODE = ${JSON.stringify(nodePath)}
const BIN = ${JSON.stringify(bin)}
const EDIT_TOOLS = /(^|_)(edit|write|patch|apply_patch|multiedit|bash|shell)$/i

function bmu(args, cwd, input) {
  return new Promise((resolve) => {
    const child = execFile(NODE, [BIN, ...args], { cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err ? err.message : "")) })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function appendToResult(result, note) {
  if (!result) return { content: note }
  const c = result.content
  if (typeof c === "string") return { ...result, content: c + "\\n\\n" + note }
  if (Array.isArray(c)) return { ...result, content: [...c, { type: "text", text: note }] }
  return { ...result, content: note }
}

const text = (s) => ({ content: (typeof s === "string" ? s : (s.out || s.err || "")).trim() || "(no output)" })

export default {
  id: "bmu",
  async setup(ctx) {
    const cwd = ctx.location.directory
    const contextFile = path.join(cwd, ".bmu", "context.md")
    // establish the baseline (existing debt is not reported as new) on load and for every new session here
    void bmu(["hook", "session-start", "--harness", "opencode"], cwd, "{}")
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          const dir = ev?.location?.directory ?? ev?.data?.location?.directory
          if (dir && path.resolve(dir) !== path.resolve(cwd)) continue
          // subagent (child) sessions must not reset the parent's baseline
          if (ev.type === "session.created" && !ev?.data?.parentID) void bmu(["hook", "session-start", "--harness", "opencode"], cwd, "{}")
          else if (ev.type === "session.execution.succeeded") void bmu(["hook", "turn-end", "--harness", "opencode"], cwd, "{}")
        }
      } catch {}
    })()

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || !EDIT_TOOLS.test(event.tool)) return
      const r = await bmu(["hook", "post-tool", "--harness", "opencode"], cwd, JSON.stringify({ tool: event.tool, input: event.input }))
      const note = r.out.trim()
      if (note) event.result = appendToResult(event.result, note)
    })

    await ctx.session.hook("context", (event) => {
      try {
        const s = readFileSync(contextFile, "utf8").trim()
        if (s) event.system.push({ type: "text", text: s })
      } catch {}
    })

    const obj = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false })
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "bmu", description: "bmu code-quality monitor: UML structure, complexity, coverage, CRAP, cycles and dependency rules for this repo." })
      const add = (name, description, input, run) =>
        editor.add({ name, description, input, options: { namespace: "bmu" }, execute: async (args) => text(await run(args || {})) })
      add("prime", "Architecture brief + current findings for this repo. Call at the start of a task.", obj({}), async () => await bmu(["prime"], cwd))
      add("status", "One-line health summary (coverage, cycles, findings).", obj({}), async () => await bmu(["status"], cwd))
      add("findings", "List findings. new=true: only regressions since the session baseline.", obj({ new: { type: "boolean" } }), async (a) => await bmu(["findings", ...(a.new ? ["--new"] : [])], cwd))
      add("explain", "Explain a finding id (bmu-xxxxx), file path, or element name: members, metrics, dependencies.", obj({ target: { type: "string" } }, ["target"]), async (a) => await bmu(["explain", a.target], cwd))
      add("diagram", "Mermaid UML slice for a directory or file (classes or components view).", obj({ path: { type: "string" }, view: { type: "string", enum: ["auto", "classes", "components"] } }), async (a) => await bmu(["diagram", a.path || ".", "--view", a.view || "auto"], cwd))
      add("ack", "Acknowledge a finding as intentional so it is not reported again.", obj({ id: { type: "string" }, reason: { type: "string" } }, ["id", "reason"]), async (a) => await bmu(["ack", a.id, a.reason], cwd))
      add("diff", "Structural regressions (cycles, dependency-rule violations, complexity) vs a git ref; default merge-base with main.", obj({ ref: { type: "string" } }), async (a) => await bmu(["diff", ...(a.ref ? [a.ref] : [])], cwd))
      add("propose", "Evaluate a what-if component grouping without changing code. components: ['Core=src/a,src/b', 'Web=src/web'] (inner/stable first).", obj({ name: { type: "string" }, components: { type: "array", items: { type: "string" } } }, ["name", "components"]), async (a) => await bmu(["propose", "add", a.name, ...(a.components || [])], cwd))
      add("hotspots", "Files where git churn x complexity is highest.", obj({ since: { type: "string" } }), async (a) => await bmu(["hotspots", ...(a.since ? ["--since", a.since] : [])], cwd))
      add("coverage_run", "Run tests affected by recent changes with coverage, then report.", obj({ all: { type: "boolean" } }), async (a) => { const r = await bmu(["coverage", "run", ...(a.all ? ["--all"] : [])], cwd); return r.out + r.err })
    })
    return () => controller.abort()
  },
}
`
}

export function installOpencode(root: string, opts: { local: boolean }): string[] {
  const dir = path.join(root, '.opencode', 'plugins', 'bmu')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'index.js'), opencodePluginSource(process.execPath, bmuBin))
  const done = ['wrote .opencode/plugins/bmu/index.js (auto-loaded by OpenCode V2)']
  if (opts.local) {
    excludeLocally(root, ['.opencode/plugins/bmu/', '.bmu/'])
    done.push('added it to .git/info/exclude (local only; teammates unaffected)')
  } else {
    const agents = addAgentsSnippet(root)
    if (agents) done.push(`added bmu section to ${agents}`)
  }
  excludeLocally(root, ['.bmu/'])
  done.push('restart OpenCode in this directory to load the plugin')
  return done
}

// ---------------- Claude Code ----------------

const isBmuHook = (h: any) => typeof h?.command === 'string' && /(^|[\s/])bmu(\.js)?['"]?\s+hook\s/.test(h.command)

export function claudeHooks(cmd: string) {
  const h = (event: string, timeout: number) => ({ type: 'command', command: `${cmd} hook ${event} --harness claude`, timeout })
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [h('session-start', 60)] }],
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [h('post-tool', 60)] }],
    UserPromptSubmit: [{ hooks: [h('prompt-submit', 20)] }],
    Stop: [{ hooks: [h('turn-end', 10)] }],
  }
}

/** Merge bmu hooks into a Claude settings object, replacing any previous bmu entries and keeping everything else. */
export function mergeClaudeSettings(settings: any, cmd: string, statusline: boolean): any {
  const out = settings && typeof settings === 'object' ? structuredClone(settings) : {}
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {}
  for (const [event, groups] of Object.entries<any[]>(out.hooks)) {
    if (!Array.isArray(groups)) continue
    out.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isBmuHook(h)) }))
      .filter((g) => g.hooks.length)
    if (!out.hooks[event].length) delete out.hooks[event]
  }
  for (const [event, groups] of Object.entries(claudeHooks(cmd))) out.hooks[event] = [...(out.hooks[event] ?? []), ...groups]
  if (statusline) out.statusLine = { type: 'command', command: `${cmd} statusline`, padding: 0 }
  return out
}

function readJsonFile(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

function hasCli(name: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function installClaude(root: string, opts: { local: boolean; statusline?: boolean }): string[] {
  const cmd = bmuCommand()
  const done: string[] = []
  const rel = opts.local ? '.claude/settings.local.json' : '.claude/settings.json'
  if (opts.local && isTracked(root, rel)) {
    return [`${rel} is tracked by git; a local install never edits team files. Re-run with --shared to add bmu to .claude/settings.json.`]
  }
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(mergeClaudeSettings(readJsonFile(file), cmd, !!opts.statusline), null, 2) + '\n')
  done.push(`wrote bmu hooks to ${rel} (SessionStart context, PostToolUse notes, UserPromptSubmit catch-up, Stop snapshot)`)
  if (opts.statusline) done.push('set statusLine → bmu statusline (overrides your user-level status line in this project)')

  // MCP server: local scope via the claude CLI (no approval prompt, nothing in the repo); shared via .mcp.json
  const [exe, ...rest] = cmd === 'bmu' ? ['bmu'] : [process.execPath, bmuBin]
  if (opts.local && hasCli('claude') && !process.env.BMU_SKIP_MCP_REGISTER) {
    try {
      execFileSync('claude', ['mcp', 'remove', 'bmu', '-s', 'local'], { cwd: root, stdio: 'ignore' })
    } catch {
      /* not registered yet */
    }
    try {
      execFileSync('claude', ['mcp', 'add', '-s', 'local', 'bmu', '--', exe, ...rest, 'mcp'], { cwd: root, stdio: 'ignore' })
      done.push('registered the bmu MCP server for this project (claude mcp add -s local)')
    } catch {
      done.push('could not register the MCP server automatically; run: claude mcp add -s local bmu -- bmu mcp')
    }
  } else if (!opts.local) {
    const mcpFile = path.join(root, '.mcp.json')
    const mcp = readJsonFile(mcpFile)
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), bmu: { command: exe, args: [...rest, 'mcp'] } }
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + '\n')
    done.push('added the bmu MCP server to .mcp.json (teammates approve it once)')
  }

  if (opts.local) {
    const rules = path.join(root, '.claude', 'rules')
    mkdirSync(rules, { recursive: true })
    writeFileSync(path.join(rules, 'bmu.md'), AGENTS_SNIPPET)
    done.push('wrote .claude/rules/bmu.md (agent instructions)')
    excludeLocally(root, ['.claude/settings.local.json', '.claude/rules/bmu.md', '.bmu/'])
    done.push('added them to .git/info/exclude (local only; teammates unaffected)')
  } else {
    const agents = addAgentsSnippet(root, ['CLAUDE.md', 'AGENTS.md'])
    if (agents) done.push(`added bmu section to ${agents}`)
  }
  excludeLocally(root, ['.bmu/'])
  done.push('start (or restart) claude in this directory; accept the workspace trust prompt so hooks can run')
  if (existsSync(path.join(root, '.grok', 'hooks', 'bmu.json'))) done.push('note: grok also reads .claude/settings*.json; bmu skips the claude copy inside grok, so nothing runs twice')
  return done
}
