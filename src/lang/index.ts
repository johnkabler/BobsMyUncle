import type { FileFacts, Lang } from '../core/model.js'
import { extractTypeScript } from './typescript.js'
import { extractPython } from './python.js'
import { extractElixir } from './elixir.js'

export function langOf(file: string): Lang | null {
  if (/\.d\.[cm]?ts$/.test(file)) return null
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) return 'typescript'
  if (/\.py$/.test(file)) return 'python'
  if (/\.(ex|exs)$/.test(file)) return 'elixir'
  return null
}

/** Paths that are never analysed (build output, deps, generated code). */
export const DEFAULT_EXCLUDES: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist|build|out|coverage|\.next|\.turbo|\.cache|storybook-static)\//,
  /(^|\/)(deps|_build|\.elixir_ls|cover)\//,
  /(^|\/)(\.venv|venv|__pycache__|\.mypy_cache|\.pytest_cache|\.tox|site-packages)\//,
  /(^|\/)\.(bmu|git|claude|cursor|grok|opencode|conductor|worktrees|agents)\//,
  /(^|\/)styled-system\//,
  /\.gen\.[cm]?[jt]sx?$/,
  /\.min\.js$/,
  /(^|\/)(vite|vitest|jest|webpack|rollup|babel|postcss|tailwind|eslint|prettier|panda|playwright|lint-staged|oxlint)\.config\.[cm]?[jt]s$/,
  /(^|\/)priv\/static\//,
  /(^|\/)assets\/vendor\//,
]

export async function extract(file: string, source: string, hash: string): Promise<FileFacts | null> {
  const lang = langOf(file)
  if (lang === 'typescript') return extractTypeScript(file, source, hash)
  if (lang === 'python') return extractPython(file, source, hash)
  if (lang === 'elixir') return extractElixir(file, source, hash)
  return null
}
