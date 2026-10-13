#!/usr/bin/env node
// Silence node:sqlite ExperimentalWarning so agent-facing output stays clean.
const emit = process.emitWarning
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : w && w.message
  if (msg && /SQLite/.test(msg)) return
  return emit.call(process, w, ...rest)
}
await import('../dist/cli/main.js')
