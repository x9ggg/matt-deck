// Task kernel: the local state (ADR-0005), one SQLite file under the user's
// home shared by every Deck service of this machine: the one the agent calls
// and the one the Pane reads may be different processes.
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const statePath = (home: string) => join(home, '.matt-deck', 'deck.sqlite')

export const hasStateTable = (db: DatabaseSync, table: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined

// A diagnostic read must neither create state nor run schema migrations.
export const readState = (home: string) =>
  statSync(statePath(home), { throwIfNoEntry: false }) === undefined
    ? undefined
    : new DatabaseSync(statePath(home), { readOnly: true })

// Opens the local state under `home`, with every table it holds. The caller
// closes it. A write waits up to 2 seconds for another Deck service's to
// end: Codex starts one for each Session. The wait is kept shorter than the
// `timeout: 10` Deck writes into its hook.
export const openState = (home: string) => {
  mkdirSync(join(home, '.matt-deck'), { recursive: true })
  const db = new DatabaseSync(statePath(home), { timeout: 2_000 })
  db.exec(
    'CREATE TABLE IF NOT EXISTS recommendations (request_id TEXT PRIMARY KEY, recommendation TEXT NOT NULL, reported_at INTEGER NOT NULL)',
  )
  // A Task is held by one Occupancy at most: its Task Source's identity and
  // its number are the key.
  db.exec(
    'CREATE TABLE IF NOT EXISTS occupancies (source TEXT NOT NULL, task INTEGER NOT NULL, session TEXT NOT NULL, occupied_at INTEGER NOT NULL, PRIMARY KEY (source, task))',
  )
  // Each Session's last heartbeat, and whether it has ended since: what
  // tells an Occupancy held from one that is Orphaned. A Deck service from
  // before hosts were writes its three columns by position, so it stays as
  // it is.
  db.exec(
    'CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY, beat_at INTEGER NOT NULL, is_ended INTEGER NOT NULL)',
  )
  // The host each Session runs in, as its heartbeat recorded it. A Session
  // with no row here was recorded before hosts were, or never beat.
  db.exec('CREATE TABLE IF NOT EXISTS session_hosts (session TEXT PRIMARY KEY, host TEXT NOT NULL)')
  // Every report of a Task, one row each, its Acceptance Evidence as JSON.
  db.exec(
    'CREATE TABLE IF NOT EXISTS reports (source TEXT NOT NULL, task INTEGER NOT NULL, session TEXT NOT NULL, reported_at INTEGER NOT NULL, result TEXT NOT NULL, evidence TEXT NOT NULL)',
  )
  // When a Deck service last received a call from Deck's hook, in one row:
  // the hook runs only once the person trusted it.
  db.exec('CREATE TABLE IF NOT EXISTS hook_calls (id INTEGER PRIMARY KEY CHECK (id = 0), received_at INTEGER NOT NULL)')

  return db
}
