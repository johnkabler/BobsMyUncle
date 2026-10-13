import { createServer, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { BmuConfig } from '../core/config.js'
import type { Store } from '../store/db.js'
import type { Analysis } from '../engine/analyze.js'
import { watch } from '../engine/watch.js'
import { diagram } from '../report/mermaid.js'
import { explain } from '../report/explain.js'
import { statusSummary } from '../report/format.js'
import { bySeverity } from '../core/findings.js'
import { UI_HTML } from './ui.js'

/** Stable per-worktree port in 47000-47999 unless overridden. */
export function defaultPort(root: string): number {
  const h = createHash('sha1').update(root).digest()
  return 47000 + (h.readUInt16BE(0) % 1000)
}

export async function startServer(root: string, store: Store, config: BmuConfig, port?: number) {
  let latest: Analysis | null = null
  const clients = new Set<ServerResponse>()
  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of clients) c.write(msg)
  }
  const state = () => {
    if (!latest) return { ready: false }
    const findings = store
      .allFindings()
      .filter((r) => r.status !== 'resolved')
      .sort(bySeverity as any)
    return {
      ready: true,
      root,
      summary: statusSummary(latest, store),
      stats: latest.stats,
      cycles: latest.cycles,
      components: latest.components,
      findings: findings.map((f) => ({ ...f, isNew: f.baseline_value === null || f.value > f.baseline_value })),
    }
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (o: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(UI_HTML)
    } else if (url.pathname === '/mermaid.min.js') {
      try {
        const file = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=86400' })
        createReadStream(file).pipe(res)
      } catch {
        res.writeHead(404)
        res.end()
      }
    } else if (url.pathname === '/api/state') json(state())
    else if (url.pathname === '/api/diagram') {
      if (!latest) return json({ mermaid: '' })
      const view = (url.searchParams.get('view') ?? 'auto') as 'auto' | 'classes' | 'components'
      json({ mermaid: diagram(latest, { level: url.searchParams.get('level') ?? '', view, maxNodes: Number(url.searchParams.get('max') ?? 60), interactive: true }) })
    } else if (url.pathname === '/api/explain') {
      json({ text: latest ? explain(latest, store, url.searchParams.get('target') ?? '') : '' })
    } else if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  const p = port ?? (Number(process.env.BMU_PORT) || defaultPort(root))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(p, '127.0.0.1', () => resolve())
  })
  process.stdout.write(`bmu viewer: http://127.0.0.1:${p}\n`)
  await watch(root, store, config, (s) => process.stdout.write(s + '\n'), (a, lines) => {
    latest = a
    send('update', { summary: statusSummary(a, store), lines })
  })
}
