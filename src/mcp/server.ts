import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'bmu.js')

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  args: (a: Record<string, any>) => string[]
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const TOOLS: ToolDef[] = [
  { name: 'bmu_prime', description: 'Architecture brief + current code-quality findings for this repo. Call at the start of a task.', inputSchema: obj(), args: () => ['prime'] },
  { name: 'bmu_status', description: 'One-line health summary: modules, coverage, cycles, open findings.', inputSchema: obj(), args: () => ['status'] },
  {
    name: 'bmu_findings',
    description: 'List open findings (CRAP, complexity, uncovered lines, cycles, dependency-rule violations). new=true: only regressions since the session baseline.',
    inputSchema: obj({ new: { type: 'boolean' } }),
    args: (a) => ['findings', ...(a.new ? ['--new'] : [])],
  },
  {
    name: 'bmu_explain',
    description: 'Explain a finding id (bmu-xxxxx), a file path, a directory, or an element name: members, metrics, dependencies, how to fix.',
    inputSchema: obj({ target: { type: 'string' } }, ['target']),
    args: (a) => ['explain', String(a.target)],
  },
  {
    name: 'bmu_diagram',
    description: 'Mermaid UML for a directory or file: component view (dependencies between sub-directories, red = dependency-rule violation) or class view.',
    inputSchema: obj({ path: { type: 'string' }, view: { type: 'string', enum: ['auto', 'classes', 'components'] } }),
    args: (a) => ['diagram', a.path || '.', '--view', a.view || 'auto'],
  },
  {
    name: 'bmu_ack',
    description: 'Acknowledge a finding as intentional so it is not reported again (unless it gets worse).',
    inputSchema: obj({ id: { type: 'string' }, reason: { type: 'string' } }, ['id', 'reason']),
    args: (a) => ['ack', String(a.id), String(a.reason)],
  },
  {
    name: 'bmu_diff',
    description: 'Structural regressions (new cycles, dependency-rule violations, complexity hotspots) vs a git ref; default: merge-base with main.',
    inputSchema: obj({ ref: { type: 'string' } }),
    args: (a) => ['diff', ...(a.ref ? [String(a.ref)] : [])],
  },
  {
    name: 'bmu_coverage_run',
    description: 'Run the tests affected by recent changes with coverage, ingest the results, and report new gaps.',
    inputSchema: obj({ all: { type: 'boolean' } }),
    args: (a) => ['coverage', 'run', ...(a.all ? ['--all'] : [])],
  },
]

function runBmu(args: string[], cwd: string): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = (String(stdout || '') + (err ? '\n' + String(stderr || err.message) : '')).trim()
      resolve({ text: text || '(no output)', isError: !!err && !stdout })
    })
  })
}

/** Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). */
export async function serveMcp(cwd: string) {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    let req: any
    try {
      req = JSON.parse(line)
    } catch {
      return
    }
    const { id, method, params } = req
    const reply = (result: unknown) => id !== undefined && send({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } })
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'bmu', version: '0.1.0' },
          instructions: 'bmu reports code-quality regressions (CRAP, complexity, uncovered lines, cycles, dependency-rule violations) in this repo. Call bmu_prime at task start; fix or bmu_ack reported findings.',
        })
      case 'notifications/initialized':
      case 'initialized':
        return
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name)
        if (!tool) return fail(-32602, `unknown tool ${params?.name}`)
        const r = await runBmu(tool.args(params?.arguments ?? {}), cwd)
        return reply({ content: [{ type: 'text', text: r.text }], isError: r.isError })
      }
      default:
        if (id !== undefined) fail(-32601, `method not found: ${method}`)
    }
  })
  await new Promise<void>((resolve) => rl.on('close', () => resolve()))
}
