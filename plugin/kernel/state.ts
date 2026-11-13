// Task kernel: the local state (ADR-0005), one SQLite file under the user's
// home shared by every Deck service of this machine: the one the agent calls
// and the one the Pane reads may be different processes.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Opens the local state under `home`, with every table it holds. The caller
// closes it.
export const openState = (home: string) => {
  mkdirSync(join(home, '.matt-deck'), { recursive: true })
  const db = new DatabaseSync(join(home, '.matt-deck', 'deck.sqlite'))
  db.exec(
    'CREATE TABLE IF NOT EXISTS recommendations (request_id TEXT PRIMARY KEY, recommendation TEXT NOT NULL, reported_at INTEGER NOT NULL)',
  )
  // A Task is held by one Occupancy at most: its Task Source's identity and
  // its number are the key.
  db.exec(
    'CREATE TABLE IF NOT EXISTS occupancies (source TEXT NOT NULL, task INTEGER NOT NULL, session TEXT NOT NULL, occupied_at INTEGER NOT NULL, PRIMARY KEY (source, task))',
  )
  // Each Session's last heartbeat, and whether it has ended since: what
  // tells an Occupancy held from one that is Orphaned.
  db.exec(
    'CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY, beat_at INTEGER NOT NULL, is_ended INTEGER NOT NULL)',
  )

  return db
}
