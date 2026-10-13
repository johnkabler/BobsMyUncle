#!/usr/bin/env node
// Silence node:sqlite ExperimentalWarning so agent-facing output stays clean.
const emit = process.emitWarning
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : w && w.message
  if (msg && /SQLite/.test(msg)) return
  return emit.call(process, w, ...rest)
}
const [maj, min] = process.versions.node.split('.').map(Number)
if (maj < 22 || (maj === 22 && min < 5)) {
  process.stderr.write(`bmu needs Node >= 22.5 (built-in node:sqlite); this is ${process.versions.node}\n`)
  process.exit(1)
}
await import('../dist/cli/main.js')
