import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import type { FileFacts } from '../core/model.js'
import type { Finding } from '../core/findings.js'
import type { LineHits } from '../ingest/coverage.js'

const SCHEMA_VERSION = 1

export interface FindingRow extends Finding {
  status: 'open' | 'resolved' | 'acked'
  first_seen: number
  last_seen: number
  baseline_value: number | null
  reported_value: number | null
  ack_reason: string | null
}

export interface CoverageRow {
  path: string
  hash: string
  hits: LineHits
  source: string
  measured_at: number
}

export class Store {
  readonly db: DatabaseSync
  readonly dir: string
  constructor(root: string) {
    this.dir = path.join(root, '.bmu')
    mkdirSync(this.dir, { recursive: true })
    this.db = new DatabaseSync(path.join(this.dir, 'bmu.db'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime REAL, size INTEGER, facts TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coverage (path TEXT PRIMARY KEY, hash TEXT NOT NULL, hits TEXT NOT NULL, source TEXT, measured_at INTEGER);
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY, rule TEXT, subject TEXT, file TEXT, line INTEGER, value REAL, severity TEXT, message TEXT,
        status TEXT NOT NULL DEFAULT 'open', first_seen INTEGER, last_seen INTEGER,
        baseline_value REAL, reported_value REAL, ack_reason TEXT);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, commit_sha TEXT, summary TEXT);
      CREATE TABLE IF NOT EXISTS commit_summaries (sha TEXT PRIMARY KEY, at INTEGER, summary TEXT);
      CREATE TABLE IF NOT EXISTS changed_files (path TEXT PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, text TEXT);
    `)
    const v = this.getMeta('schema')
    if (!v) this.setMeta('schema', String(SCHEMA_VERSION))
  }

  close() {
    this.db.close()
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  // ---- fact cache ----
  fileIndex(): Map<string, { hash: string; mtime: number; size: number }> {
    const rows = this.db.prepare('SELECT path, hash, mtime, size FROM files').all() as any[]
    return new Map(rows.map((r) => [r.path, { hash: r.hash, mtime: r.mtime, size: r.size }]))
  }
  getFacts(p: string): FileFacts | null {
    const r = this.db.prepare('SELECT facts FROM files WHERE path=?').get(p) as { facts: string } | undefined
    return r ? JSON.parse(r.facts) : null
  }
  allFacts(): FileFacts[] {
    return (this.db.prepare('SELECT facts FROM files').all() as any[]).map((r) => JSON.parse(r.facts))
  }
  putFacts(f: FileFacts, mtime: number, size: number) {
    this.db
      .prepare('INSERT INTO files(path,hash,mtime,size,facts) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, size=excluded.size, facts=excluded.facts')
      .run(f.path, f.hash, mtime, size, JSON.stringify(f))
  }
  touchFile(p: string, mtime: number, size: number) {
    this.db.prepare('UPDATE files SET mtime=?, size=? WHERE path=?').run(mtime, size, p)
  }
  deleteFiles(paths: string[]) {
    const st = this.db.prepare('DELETE FROM files WHERE path=?')
    for (const p of paths) st.run(p)
  }

  // ---- coverage ----
  putCoverage(p: string, hash: string, hits: LineHits, source: string) {
    this.db
      .prepare('INSERT INTO coverage(path,hash,hits,source,measured_at) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, hits=excluded.hits, source=excluded.source, measured_at=excluded.measured_at')
      .run(p, hash, JSON.stringify([...hits]), source, Date.now())
  }
  allCoverage(): Map<string, CoverageRow> {
    const rows = this.db.prepare('SELECT * FROM coverage').all() as any[]
    return new Map(rows.map((r) => [r.path, { path: r.path, hash: r.hash, hits: new Map(JSON.parse(r.hits)), source: r.source, measured_at: r.measured_at }]))
  }

  // ---- findings ----
  allFindings(): FindingRow[] {
    return this.db.prepare('SELECT * FROM findings').all() as any[]
  }
  getFinding(id: string): FindingRow | null {
    return (this.db.prepare('SELECT * FROM findings WHERE id=?').get(id) as any) ?? null
  }
  upsertFinding(f: Finding, now: number, baselineValue: number | null) {
    const prev = this.getFinding(f.id)
    if (!prev) {
      this.db
        .prepare(
          `INSERT INTO findings(id,rule,subject,file,line,value,severity,message,status,first_seen,last_seen,baseline_value,reported_value,ack_reason)
           VALUES(?,?,?,?,?,?,?,?,'open',?,?,?,NULL,NULL)`,
        )
        .run(f.id, f.rule, f.subject, f.file, f.line ?? null, f.value, f.severity, f.message, now, now, baselineValue)
      return
    }
    const status = prev.status === 'resolved' ? 'open' : prev.status
    // a finding that comes back after being resolved is treated as new relative to its baseline
    const baseline = prev.status === 'resolved' ? null : prev.baseline_value
    const reported = prev.status === 'resolved' ? null : prev.reported_value
    this.db
      .prepare('UPDATE findings SET rule=?, subject=?, file=?, line=?, value=?, severity=?, message=?, status=?, last_seen=?, baseline_value=?, reported_value=? WHERE id=?')
      .run(f.rule, f.subject, f.file, f.line ?? null, f.value, f.severity, f.message, status, now, baseline, reported, f.id)
  }
  resolveFinding(id: string) {
    this.db.prepare("UPDATE findings SET status='resolved' WHERE id=?").run(id)
  }
  markReported(id: string, value: number) {
    this.db.prepare('UPDATE findings SET reported_value=? WHERE id=?').run(value, id)
  }
  ack(id: string, reason: string): boolean {
    const r = this.db.prepare("UPDATE findings SET status='acked', ack_reason=?, reported_value=value WHERE id=?").run(reason, id)
    return Number(r.changes) > 0
  }
  /** Make every currently open finding part of the baseline (not reported unless it gets worse). */
  resetBaseline() {
    this.db.exec("UPDATE findings SET baseline_value=value, reported_value=NULL WHERE status IN ('open','acked')")
    this.db.exec("DELETE FROM findings WHERE status='resolved'")
    this.db.exec('DELETE FROM changed_files')
    this.setMeta('baseline_at', String(Date.now()))
  }

  // ---- files changed since the baseline ----
  markChanged(paths: string[]) {
    const st = this.db.prepare('INSERT OR IGNORE INTO changed_files(path, at) VALUES(?, ?)')
    for (const p of paths) st.run(p, Date.now())
  }
  changedSinceBaseline(): Set<string> {
    return new Set((this.db.prepare('SELECT path FROM changed_files').all() as any[]).map((r) => r.path))
  }

  // ---- snapshots & notes ----
  addSnapshot(summary: unknown, commit: string | null) {
    this.db.prepare('INSERT INTO snapshots(at,commit_sha,summary) VALUES(?,?,?)').run(Date.now(), commit, JSON.stringify(summary))
    this.db.exec('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 500)')
  }
  recentSnapshots(limit = 20): { at: number; commit_sha: string | null; summary: any }[] {
    return (this.db.prepare('SELECT at, commit_sha, summary FROM snapshots ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({ ...r, summary: JSON.parse(r.summary) }))
  }
  putCommitSummary(sha: string, summary: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO commit_summaries(sha,at,summary) VALUES(?,?,?)').run(sha, Date.now(), JSON.stringify(summary))
  }
  getCommitSummary(sha: string): any | null {
    const r = this.db.prepare('SELECT summary FROM commit_summaries WHERE sha=?').get(sha) as any
    return r ? JSON.parse(r.summary) : null
  }
  addNote(text: string) {
    this.db.prepare('INSERT INTO notes(at,text) VALUES(?,?)').run(Date.now(), text)
  }
  notes(): { at: number; text: string }[] {
    return this.db.prepare('SELECT at, text FROM notes ORDER BY id').all() as any[]
  }

  event(type: string, data: Record<string, unknown> = {}) {
    try {
      appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n')
    } catch {
      /* best effort */
    }
  }
}
