import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { findRoot, loadConfig } from '../engine/files.js'
import { Store } from '../store/db.js'
import { analyze, reconcile, fingerprint, type Analysis } from '../engine/analyze.js'
import { runCoverage, queueCoverage, spawnBackgroundCoverage } from '../engine/background.js'
import { affectedTests } from '../engine/build.js'
import { diagram } from '../report/mermaid.js'
import { hookMessage, prime, statusSummary, statusLine, findingLine, deltaLines, budget } from '../report/format.js'
import { bySeverity } from '../core/findings.js'
import { installGrok, installOpencode, installClaude, excludeLocally } from './install.js'
import { explain } from '../report/explain.js'
import { doctor } from '../report/doctor.js'
import { hotspots } from '../report/hotspots.js'
import { proposalDiagram, proposalReport } from '../report/proposal.js'
import YAML from 'yaml'
import { startServer } from '../server/http.js'
import { watch } from '../engine/watch.js'
import { initConfig } from '../engine/init.js'
import { serveMcp } from '../mcp/server.js'
import { findingsAt, defaultBase, structuralFindings, diffFindings } from '../engine/baseline.js'
import { existsSync } from 'node:fs'

const HELP = `bmu — live UML + code-quality monitor for coding agents

Usage: bmu <command> [options]

  prime                      architecture brief + current findings (for agents at task start)
  status [--json]            one-line health summary
  scan [--json]              analyse the repo (incremental) and update findings
  findings [--new|--all] [--json]
  explain <id|file|Element>  members, metrics, dependencies
  diagram [path] [--view auto|classes|components] [--max N]   Mermaid UML
  diff [ref]                 structural changes vs a git ref (default: merge-base with main): new cycles, rule violations, complexity
  ack <id> <reason>          acknowledge a finding (not reported again unless worse)
  baseline                   accept current findings as the baseline
  coverage run [--all] [files...]   run affected tests with coverage
  check [--new]              exit 1 if (new) high/medium findings exist (CI)
  remember <note>            durable team/architecture note shown in prime
  init [--shared] [--force]  write a config with inferred layers/runners (.bmu/config.yaml, or bmu.config.yaml with --shared)
  install claude|grok|opencode [--local|--shared]
  hook <session-start|post-tool|prompt-submit|turn-end> --harness claude|grok|opencode   (reads JSON on stdin)
  propose list|add|show|rm  what-if component groupings (e.g. by Common Closure Principle), evaluated without changing code
  mutate [files...]          run Stryker on changed files (TS/JS) and report surviving mutants
  hotspots [--since '3 months ago'] [--top N]   churn × complexity
  doctor                     diagnose parsing/resolution/coverage/runner setup
  statusline                 one line for a status bar (Grok [ui.status_line])
  watch                      watch files; print regressions as they happen (also for Grok's monitor tool)
  serve [--port N]           live browser viewer
  mcp                        MCP server over stdio (tools: bmu_prime, bmu_findings, bmu_explain, bmu_diagram, …)
  version
`

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i >= 0) {
    args.splice(i, 1)
    return true
  }
  return false
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i >= 0 && i + 1 < args.length) {
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  return undefined
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 2000)
    process.stdin.on('data', (c) => chunks.push(Buffer.from(c)))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', () => resolve(''))
  })
}

/** Small always-current context block for harnesses that inject it into every model call. */
function writeContextFile(a: Analysis, store: Store) {
  const rows = store
    .allFindings()
    .filter((r) => r.status === 'open' && (r.baseline_value === null || r.value > r.baseline_value))
    .sort(bySeverity as any)
  const lines = [`bmu (report-only code-quality monitor): ${statusLine(a, store)}`]
  if (rows.length) {
    lines.push('Open regressions from this session (fix if in scope, or ack with bmu_ack):')
    for (const r of rows.slice(0, 5)) lines.push(`- ${r.id} ${r.message}`)
    if (rows.length > 5) lines.push(`- … +${rows.length - 5} more (bmu_findings new=true)`)
  }
  writeFileSync(path.join(a.root, '.bmu', 'context.md'), budget(lines, a.config.report.contextMaxTokens).join('\n') + '\n')
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args.shift() ?? 'help'
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP)
    return
  }
  if (cmd === 'version' || cmd === '--version') {
    const pj = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    process.stdout.write(pj.version + '\n')
    return
  }
  const root = findRoot(opt(args, '--root') ?? process.cwd())
  const config = loadConfig(root)
  const json = flag(args, '--json')
  const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n')

  if (cmd === 'mcp') {
    await serveMcp(root)
    return
  }

  if (cmd === 'init') {
    const r = initConfig(root, { shared: flag(args, '--shared'), force: flag(args, '--force') })
    out([`✓ ${path.relative(root, r.file)}`, ...r.notes.map((n) => '  ' + n)].join('\n'))
    return
  }

  if (cmd === 'install') {
    const target = args.shift()
    const shared = flag(args, '--shared')
    flag(args, '--local')
    const local = !shared
    const statusline = flag(args, '--statusline')
    const lines =
      target === 'claude' ? installClaude(root, { local, statusline }) : target === 'grok' ? installGrok(root, { local }) : target === 'opencode' ? installOpencode(root, { local }) : null
    if (!lines) throw new Error('usage: bmu install claude|grok|opencode [--local|--shared] [--statusline (claude)]')
    if (!['bmu.config.yaml', 'bmu.config.yml', '.bmu/config.yaml'].some((f) => existsSync(path.join(root, f)))) {
      const r = initConfig(root, { shared: shared })
      lines.push(`wrote ${path.relative(root, r.file)}`, ...r.notes.map((n) => '  ' + n))
    }
    out(lines.map((l) => '✓ ' + l).join('\n'))
    return
  }

  const store = new Store(root)
  try {
    switch (cmd) {
      case 'scan': {
        const a = await analyze(root, store, config)
        const d = reconcile(store, a.findings, { mark: false })
        writeContextFile(a, store)
        store.addSnapshot({ stats: a.stats, findings: a.findings.length }, null)
        if (json) out(JSON.stringify({ stats: a.stats, findings: a.findings, delta: { fresh: d.fresh.map((r) => r.id), worse: d.worse.map((r) => r.id), resolved: d.resolved.map((r) => r.id) } }, null, 2))
        else {
          out(`${statusSummary(a, store)}\nscanned ${a.stats.files} files (${a.stats.parsed} parsed) in ${a.stats.ms}ms`)
          const lines = deltaLines(d)
          if (lines.length) out(lines.join('\n'))
        }
        break
      }
      case 'status': {
        const a = await analyze(root, store, config)
        reconcile(store, a.findings, { mark: false })
        if (json) out(JSON.stringify({ stats: a.stats, cycles: a.cycles.length, open: store.allFindings().filter((r) => r.status === 'open').length }))
        else out(statusSummary(a, store))
        break
      }
      case 'statusline': {
        await readStdin().catch(() => '')
        const a = await analyze(root, store, config)
        reconcile(store, a.findings, { mark: false })
        out(statusLine(a, store))
        break
      }
      case 'prime': {
        const a = await analyze(root, store, config)
        reconcile(store, a.findings, { mark: false })
        writeContextFile(a, store)
        out(prime(a, store))
        break
      }
      case 'findings': {
        const onlyNew = flag(args, '--new')
        const all = flag(args, '--all')
        const a = await analyze(root, store, config)
        reconcile(store, a.findings, { mark: false })
        let rows = store.allFindings().filter((r) => all || r.status === 'open')
        if (onlyNew) rows = rows.filter((r) => r.baseline_value === null || r.value > r.baseline_value)
        rows.sort(bySeverity as any)
        if (json) out(JSON.stringify(rows, null, 2))
        else out(rows.length ? rows.map(findingLine).join('\n') : onlyNew ? 'no new findings since baseline ✓' : 'no findings ✓')
        break
      }
      case 'explain': {
        const target = args.join(' ')
        if (!target) throw new Error('usage: bmu explain <id|file|Element>')
        const a = await analyze(root, store, config)
        reconcile(store, a.findings, { mark: false })
        out(explain(a, store, target))
        break
      }
      case 'diagram': {
        const view = (opt(args, '--view') ?? 'auto') as 'auto' | 'classes' | 'components'
        const max = Number(opt(args, '--max') ?? 40)
        const a = await analyze(root, store, config)
        const level = args[0] && args[0] !== '.' ? path.relative(root, path.resolve(process.cwd(), args[0])).split(path.sep).join('/') : ''
        out(diagram(a, { level, view, maxNodes: max }))
        break
      }
      case 'mutate': {
        const files = args.length ? args.map((f) => path.relative(root, path.resolve(process.cwd(), f)).split(path.sep).join('/')) : [...store.changedSinceBaseline()]
        const ts = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f))
        const pj = existsSync(path.join(root, 'package.json')) ? readFileSync(path.join(root, 'package.json'), 'utf8') : ''
        if (!ts.length) {
          out('bmu mutate: no TypeScript/JavaScript files to mutate (Python/Elixir: run mutmut/muex yourself and point mutation.reports at a JSON report)')
          break
        }
        if (!/@stryker-mutator\/core/.test(pj)) {
          out('bmu mutate: Stryker is not installed. Add it with: npm i -D @stryker-mutator/core (plus the jest/vitest runner plugin)')
          break
        }
        const { spawnSync } = await import('node:child_process')
        process.stderr.write(`bmu: stryker on ${ts.length} file(s)…\n`)
        spawnSync('npx', ['--no-install', 'stryker', 'run', '--mutate', ts.join(','), '--reporters', 'json,progress'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
        const a = await analyze(root, store, config)
        const d = reconcile(store, a.findings, { mark: true })
        out(hookMessage(d, 10) || 'bmu mutate: no new surviving mutants')
        break
      }
      case 'propose': {
        const sub = args.shift() ?? 'list'
        const local = path.join(root, '.bmu', 'config.yaml')
        const readLocal = () => (existsSync(local) ? YAML.parse(readFileSync(local, 'utf8')) ?? {} : {})
        if (sub === 'list') {
          out(config.proposals.length ? config.proposals.map((p) => `${p.name}: ${p.components.map((c) => c.name).join(' ← ')}`).join('\n') : 'no proposals (bmu propose add <name> "Core=src/a,src/b" "Web=src/web")')
        } else if (sub === 'add') {
          const name = args.shift()
          if (!name || !args.length) throw new Error('usage: bmu propose add <name> "Comp=path,path" ... (inner/stable components first)')
          const components = args.map((spec) => {
            const [cname, paths] = spec.split('=')
            return { name: cname.trim(), paths: (paths ?? '').split(',').map((x) => x.trim()).filter(Boolean) }
          })
          const doc = readLocal()
          doc.proposals = [...(doc.proposals ?? []).filter((p: any) => p.name !== name), { name, components }]
          mkdirSync(path.dirname(local), { recursive: true })
          writeFileSync(local, YAML.stringify(doc))
          const a = await analyze(root, store, loadConfig(root))
          out(proposalReport(a, { name, components }))
        } else if (sub === 'rm') {
          const name = args.shift()
          const doc = readLocal()
          doc.proposals = (doc.proposals ?? []).filter((p: any) => p.name !== name)
          writeFileSync(local, YAML.stringify(doc))
          out(`removed proposal ${name}`)
        } else if (sub === 'show') {
          const name = args.shift()
          const p = config.proposals.find((x) => x.name === name)
          if (!p) throw new Error(`unknown proposal ${name}`)
          const a = await analyze(root, store, config)
          out(proposalReport(a, p) + '\n\n' + proposalDiagram(a, p))
        } else throw new Error('usage: bmu propose list|add|show|rm')
        break
      }
      case 'hotspots': {
        const since = opt(args, '--since')
        const top = Number(opt(args, '--top') ?? 15)
        const a = await analyze(root, store, config)
        out(hotspots(a, { since, top }))
        break
      }
      case 'doctor': {
        const a = await analyze(root, store, config)
        out(doctor(a, store))
        break
      }
      case 'diff': {
        const ref = args[0] ?? defaultBase(root)
        const base = await findingsAt(root, store, config, ref, (s) => process.stderr.write(s + '\n'))
        const a = await analyze(root, store, config)
        const d = diffFindings(base.findings, structuralFindings(a), base.sha)
        if (json) {
          out(JSON.stringify(d, null, 2))
          break
        }
        const lines = [`bmu diff vs ${args[0] ?? 'merge-base'} (${base.sha.slice(0, 8)}): ${d.added.length} new, ${d.worse.length} worse, ${d.fixed.length} fixed`]
        for (const f of d.added) lines.push(`  + ${f.id} ${f.message}`)
        for (const w of d.worse) lines.push(`  ▲ ${w.f.id} ${w.f.message} (was ${w.was})`)
        for (const f of d.fixed.slice(0, 20)) lines.push(`  ✓ ${f.id} ${f.message}`)
        out(lines.join('\n'))
        break
      }
      case 'ack': {
        const [id, ...reason] = args
        if (!id || !reason.length) throw new Error('usage: bmu ack <id> <reason>')
        if (!store.ack(id, reason.join(' '))) throw new Error(`unknown finding ${id}`)
        store.event('finding.acked', { id, reason: reason.join(' ') })
        out(`acknowledged ${id}`)
        break
      }
      case 'baseline': {
        const a = await analyze(root, store, config)
        reconcile(store, a.findings, { mark: false })
        store.resetBaseline()
        writeContextFile(a, store)
        out(`baseline set: ${a.findings.length} current findings accepted`)
        break
      }
      case 'remember': {
        const text = args.join(' ').trim()
        if (!text) throw new Error('usage: bmu remember <note>')
        store.addNote(text)
        out('noted')
        break
      }
      case 'check': {
        const onlyNew = flag(args, '--new')
        const a = await analyze(root, store, config)
        reconcile(store, a.findings, { mark: false })
        let rows = store.allFindings().filter((r) => r.status === 'open' && r.severity !== 'low')
        if (onlyNew) rows = rows.filter((r) => r.baseline_value === null || r.value > r.baseline_value)
        rows.sort(bySeverity as any)
        out(rows.length ? rows.map(findingLine).join('\n') : 'bmu check passed ✓')
        process.exitCode = rows.length ? 1 : 0
        break
      }
      case 'coverage': {
        const sub = args.shift()
        if (sub !== 'run') throw new Error('usage: bmu coverage run [--all] [files...]')
        const all = flag(args, '--all')
        const pending = flag(args, '--pending')
        const files = args.map((f) => path.relative(root, path.resolve(process.cwd(), f)).split(path.sep).join('/'))
        const r = await runCoverage(root, store, config, { all, pending, files, log: (s) => process.stderr.write(s + '\n') })
        if (r.skipped) out(`bmu: coverage skipped (${r.skipped})`)
        else if (r.analysis) {
          writeContextFile(r.analysis, store)
          out(`bmu: ran ${r.tests.length} test file(s); ${statusSummary(r.analysis, store)}`)
          const d = reconcile(store, r.analysis.findings, { mark: !pending })
          const msg = hookMessage(d, 10)
          if (msg) out(msg)
        }
        break
      }
      case 'hook': {
        const event = args.shift()
        const harness = opt(args, '--harness') ?? 'grok'
        const raw = await readStdin()
        let payload: any = {}
        try {
          payload = raw ? JSON.parse(raw) : {}
        } catch {
          payload = {}
        }
        await handleHook(root, store, config, event ?? '', harness, payload, out)
        break
      }
      case 'watch': {
        await watch(root, store, config, out)
        break
      }
      case 'serve': {
        const port = Number(opt(args, '--port') ?? 0) || undefined
        await startServer(root, store, config, port)
        break
      }
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`)
        process.exitCode = 2
    }
  } finally {
    if (cmd !== 'watch' && cmd !== 'serve') store.close()
  }
}

/** Hook output: JSON `hookSpecificOutput.additionalContext` for Claude/Grok, plain text for OpenCode. */
function emitContext(out: (s: string) => void, harness: string, eventName: string, msg: string) {
  if (!msg) return
  if (harness === 'opencode') out(msg)
  else out(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: msg } }))
}

/**
 * Analyse, reconcile and build the note for regressions not yet reported (shared by post-tool and
 * prompt-submit). Returns '' when nothing changed since the last hook.
 */
async function pendingNote(root: string, store: Store, config: ReturnType<typeof loadConfig>): Promise<string> {
  // fast path: nothing relevant changed since the last hook (e.g. a read-only bash command)
  const fp = fingerprint(root, config)
  if (store.getMeta('hook_fp') === fp && store.getMeta('hook_pending_report') !== '1') return ''
  const a = await analyze(root, store, config)
  const d = reconcile(store, a.findings, { mark: true })
  writeContextFile(a, store)
  if (a.changed.length) {
    store.event('files.changed', { files: a.changed })
    if (config.coverage.background && affectedTests(a.model, a.changed).length) {
      queueCoverage(root, a.changed)
      spawnBackgroundCoverage(root)
    }
  }
  store.setMeta('hook_fp', fingerprint(root, config))
  store.setMeta('hook_pending_report', '0')
  let msg = hookMessage(d, config.report.hookMaxLines)
  const covErr = store.getMeta('coverage_error')
  if (covErr) {
    msg = (msg ? msg + '\n' : '') + `bmu: background test run could not run tests (${covErr}). Coverage findings may be missing; run the tests your usual way (bmu ingests coverage/lcov.info), or configure runners in .bmu/config.yaml.`
    store.setMeta('coverage_error', '')
  }
  return msg
}

async function handleHook(root: string, store: Store, config: ReturnType<typeof loadConfig>, event: string, harness: string, payload: any, out: (s: string) => void) {
  // Grok also loads .claude/settings*.json hooks; when grok's own bmu hooks exist, let those handle it.
  if (harness === 'claude' && process.env.GROK_HOOK_EVENT && existsSync(path.join(root, '.grok', 'hooks', 'bmu.json'))) return
  // Hooks must never break the agent: swallow errors, always exit 0.
  try {
    if (event === 'session-start') {
      const source = String(payload.source ?? 'startup')
      // plugin installs skip `bmu install`: keep .bmu/ out of git and infer layers on first use
      excludeLocally(root, ['.bmu/'])
      if (!['bmu.config.yaml', 'bmu.config.yml', '.bmu/config.yaml'].some((f) => existsSync(path.join(root, f)))) {
        initConfig(root, {})
        config = loadConfig(root)
      }
      const a = await analyze(root, store, config)
      reconcile(store, a.findings, { mark: false })
      // a resumed/compacted session keeps its baseline; new and cleared sessions start fresh
      if (source === 'startup' || source === 'clear' || harness !== 'claude') store.resetBaseline()
      writeContextFile(a, store)
      store.setMeta('hook_fp', fingerprint(root, config))
      store.event('session.start', { harness, source })
      // Claude Code adds SessionStart context before the first prompt (Grok ignores SessionStart stdout)
      if (harness === 'claude') emitContext(out, harness, 'SessionStart', prime(a, store, 900))
      return
    }
    if (event === 'post-tool') {
      const tool = String(payload.toolName ?? payload.tool_name ?? payload.tool ?? '')
      if (tool && !/edit|write|patch|replace|bash|shell|terminal|command|multiedit|notebook/i.test(tool)) return
      emitContext(out, harness, 'PostToolUse', await pendingNote(root, store, config))
      return
    }
    if (event === 'prompt-submit') {
      // between turns: deliver what arrived since (background coverage results, edits made outside the agent)
      emitContext(out, harness, 'UserPromptSubmit', await pendingNote(root, store, config))
      return
    }
    if (event === 'turn-end') {
      // Never prints a decision: grok/claude would keep the agent working. Just snapshot.
      const a = await analyze(root, store, config)
      reconcile(store, a.findings, { mark: false })
      writeContextFile(a, store)
      store.addSnapshot({ stats: a.stats, findings: a.findings.length }, null)
      return
    }
  } catch (e) {
    try {
      mkdirSync(path.join(root, '.bmu'), { recursive: true })
      writeFileSync(path.join(root, '.bmu', 'hook-error.log'), `${new Date().toISOString()} ${event}: ${(e as Error).stack}\n`, { flag: 'a' })
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  process.stderr.write(`bmu: ${(e as Error).message}\n`)
  process.exitCode = 1
})

