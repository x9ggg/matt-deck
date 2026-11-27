// Task kernel: Occupancy, kept in the local state (ADR-0005) by the identity
// of the Task Source, so every Workspace of a project shares it, and the
// heartbeats of the Sessions holding it.
// Host-agnostic: it knows a home directory, a Task Source's identity and
// Sessions by their ids.
import type { DatabaseSync } from 'node:sqlite'
import { hasStateTable, openState, readState } from './state.ts'

// How the Deck service names a Session in its answers: its host and its id
// cut short, from the host its heartbeat recorded, null where none did.
export type NameSession = (session: string, host: string | null) => { host: string; short: string }

// An Occupancy as the local state holds it: the Session holding it, the host
// that Session's heartbeat recorded, if any, and whether it is Orphaned.
export type Occupant = { session: string; host: string | null; isOrphaned: boolean }

// How old a Session's last heartbeat may be before its Occupancies are
// Orphaned: a Session that vanished without ending shows within minutes.
// The Sessions beat a few times as often.
const ORPHANED_AFTER_MS = 180_000

const occupantsIn = (db: DatabaseSync, source: string, now: number) => {
  // Older state may predate heartbeats, or hosts. A missing Session has
  // never beat.
  const sessions = hasStateTable(db, 'sessions')
    ? 'sessions'
    : '(SELECT NULL AS session, NULL AS beat_at, NULL AS is_ended)'
  const hosts = hasStateTable(db, 'session_hosts') ? 'session_hosts' : '(SELECT NULL AS session, NULL AS host)'
  const rows = db.prepare(
    `SELECT task, occupancies.session AS session, beat_at, is_ended, host FROM occupancies LEFT JOIN ${sessions} USING (session) LEFT JOIN ${hosts} USING (session) WHERE source = ? ORDER BY task`,
  ).all(source)
  return new Map<number, Occupant>(rows.map(row => [row.task as number, {
    session: row.session as string,
    host: row.host as string | null,
    isOrphaned: row.beat_at === null || row.is_ended === 1 || now - (row.beat_at as number) > ORPHANED_AFTER_MS,
  }]))
}

// Read without releasing closed Tasks or creating a state file.
export const readOccupancies = (home: string, source: string, now: number) => {
  const db = readState(home)
  if (db === undefined) return new Map<number, Occupant>()
  try {
    if (!hasStateTable(db, 'occupancies')) return new Map<number, Occupant>()
    return occupantsIn(db, source, now)
  } finally {
    db.close()
  }
}

// Punctuation that may follow a Task reference without being part of it;
// the full-width kind is never part of a link either, so it ends one even
// where text follows it with no space.
const AFTER_REFERENCE = new Set('.,;:!?。，；：！？')
const FULL_WIDTH = /[。，；：！？]/
// A Task by its number, `#12` or `12`, with punctuation or nothing after
// it; an issue of github.com by its link,
// `https://github.com/owner/name/issues/12`, with a `/`, a query or a
// fragment after it if any. Each is read in a time that grows with its
// length alone: no part of it can match in more than one way.
const BY_NUMBER = /^#?(\d+)(?:[.,;:!?。，；：！？]|$)/
const BY_LINK = /^https:\/\/github\.com\/([^/\s?#]+\/[^/\s?#]+)\/issues\/(\d+)\/?(?:[?#]\S*)?$/

// The Task the first word of `text` refers to, with the repository a link
// names, if any; undefined where it refers to none. Punctuation right after
// the reference is not part of it.
export const taskReference = (text: string): { task: number; repository?: string } | undefined => {
  const first = text.trimStart()
  const word = first.slice(0, first.search(/\s|$/))
  const byNumber = BY_NUMBER.exec(word)
  if (byNumber !== null) return { task: Number(byNumber[1]) }
  const cut = word.search(FULL_WIDTH)
  let end = cut === -1 ? word.length : cut
  while (end > 0 && AFTER_REFERENCE.has(word[end - 1]!)) end--
  const byLink = BY_LINK.exec(word.slice(0, end))
  return byLink === null ? undefined : { task: Number(byLink[2]), repository: byLink[1] }
}

// The Tasks a prompt runs `call`, the host's call of implement, on: each line
// that begins with the call and a Task reference after it. Any line counts:
// the host appends a prompt filled in to the draft before it.
export const implementedTasks = (prompt: string, call: string) =>
  prompt.split('\n').flatMap(line => {
    const rest = line.startsWith(call) ? line.slice(call.length) : ''
    const reference = /^\s/.test(rest) ? taskReference(rest) : undefined
    return reference === undefined ? [] : [reference]
  })

// Records a heartbeat of `session` at `now`, in the host `host`: the Session
// runs, and its Occupancies are held, an ended one's again too.
export const beat = (home: string, session: string, now: number, host: string) => {
  const db = openState(home)
  try {
    db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, 0)').run(session, now)
    db.prepare('INSERT OR REPLACE INTO session_hosts VALUES (?, ?)').run(session, host)
  } finally {
    db.close()
  }
}

// Records that `session` has ended: its Occupancies of open Tasks are
// Orphaned from now.
export const endSession = (home: string, session: string, now: number) => {
  const db = openState(home)
  try {
    db.prepare(
      'INSERT INTO sessions VALUES (?, ?, 1) ON CONFLICT (session) DO UPDATE SET is_ended = 1',
    ).run(session, now)
  } finally {
    db.close()
  }
}

// Records `session`'s Occupancy of the Task `task`, unless another Session
// holds one; the Occupancy `takeOverFrom` holds, the Session the person
// confirmed taking the Task over from, moves to `session`. One that passed
// to a third Session since stays with it. Answers the Session that holds
// the Task now, and whether that Occupancy is Orphaned at `now`.
export const occupy = (
  home: string,
  source: string,
  task: number,
  session: string,
  now: number,
  takeOverFrom: string | undefined,
) => {
  const db = openState(home)
  try {
    if (takeOverFrom !== undefined) {
      db.prepare('UPDATE occupancies SET session = ?, occupied_at = ? WHERE source = ? AND task = ? AND session = ?').run(
        session,
        now,
        source,
        task,
        takeOverFrom,
      )
    }
    db.prepare('INSERT OR IGNORE INTO occupancies VALUES (?, ?, ?, ?)').run(source, task, session, now)

    return occupantsIn(db, source, now).get(task)!
  } finally {
    db.close()
  }
}

// Releases the Occupancy `session` holds of the Task `task`; answers whether
// it held one. One that passed to another Session since stays with it.
export const release = (home: string, source: string, task: number, session: string) => {
  const db = openState(home)
  try {
    return (
      db.prepare('DELETE FROM occupancies WHERE source = ? AND task = ? AND session = ?').run(source, task, session)
        .changes > 0
    )
  } finally {
    db.close()
  }
}

// The Occupancies of the Task Source's open Tasks, `open`, by Task number,
// as a read begun at `readAt` found them, each Orphaned at `now` when its
// Session has ended, has not beaten for too long, or never beat. Those of
// every other Task are released: a Task closed, or no longer in the source.
// One recorded after the read began stays: it was recorded on a later read,
// which found its Task open.
export const settleOccupancies = (home: string, source: string, open: number[], readAt: number, now: number) => {
  const db = openState(home)
  try {
    const held = occupantsIn(db, source, now)
    const release = db.prepare('DELETE FROM occupancies WHERE source = ? AND task = ? AND occupied_at <= ?')
    for (const task of held.keys()) {
      if (!open.includes(task)) {
        held.delete(task)
        release.run(source, task, readAt)
      }
    }

    return held
  } finally {
    db.close()
  }
}
