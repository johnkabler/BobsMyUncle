import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { findRoot, loadConfig } from '../engine/files.js'
import { Store } from '../store/db.js'
import { analyze, reconcile, type Analysis } from '../engine/analyze.js'
import { runCoverage, queueCoverage, spawnBackgroundCoverage } from '../engine/background.js'
import { affectedTests } from '../engine/build.js'
import { diagram } from '../report/mermaid.js'
import { hookMessage, prime, statusSummary, statusLine, findingLine, deltaLines, budget } from '../report/format.js'
import { bySeverity } from '../core/findings.js'
import { installGrok, installOpencode } from './install.js'
import { explain } from '../report/explain.js'
import { startServer } from '../server/http.js'
import { watch } from '../engine/watch.js'
import { initConfig } from '../engine/init.js'
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
  install grok|opencode [--local|--shared]
  hook <session-start|post-tool|turn-end> --harness grok|opencode   (reads JSON on stdin)
  statusline                 one line for a status bar (Grok [ui.status_line])
  watch                      watch files; print regressions as they happen (also for Grok's monitor tool)
  serve [--port N]           live browser viewer
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
    const lines = target === 'grok' ? installGrok(root, { local }) : target === 'opencode' ? installOpencode(root, { local }) : null
    if (!lines) throw new Error('usage: bmu install grok|opencode [--local|--shared]')
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

async function handleHook(root: string, store: Store, config: ReturnType<typeof loadConfig>, event: string, harness: string, payload: any, out: (s: string) => void) {
  // Hooks must never break the agent: swallow errors, always exit 0.
  try {
    if (event === 'session-start') {
      const a = await analyze(root, store, config)
      reconcile(store, a.findings, { mark: false })
      store.resetBaseline()
      writeContextFile(a, store)
      store.event('session.start', { harness })
      return
    }
    if (event === 'post-tool') {
      const tool = String(payload.toolName ?? payload.tool_name ?? payload.tool ?? '')
      if (tool && !/edit|write|patch|replace|bash|shell|terminal|command|multiedit/i.test(tool)) return
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
      const msg = hookMessage(d, config.report.hookMaxLines)
      if (!msg) return
      if (harness === 'grok' || harness === 'claude') {
        out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }))
      } else out(msg)
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

