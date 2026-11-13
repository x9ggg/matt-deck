// Task kernel: Occupancy, kept in the local state (ADR-0005) by the identity
// of the Task Source, so every Workspace of a project shares it, and the
// heartbeats of the Sessions holding it.
// Host-agnostic: it knows a home directory, a Task Source's identity and
// Sessions by their ids.
import { openState } from './state.ts'

// How old a Session's last heartbeat may be before its Occupancies are
// Orphaned: a Session that vanished without ending shows within minutes.
// The Sessions beat a few times as often.
const ORPHANED_AFTER_MS = 180_000

// Records a heartbeat of `session` at `now`: the Session runs, and its
// Occupancies are held, an ended one's again too.
export const beat = (home: string, session: string, now: number) => {
  const db = openState(home)
  try {
    db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, 0)').run(session, now)
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
// the Task now.
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
    const row = db.prepare('SELECT session FROM occupancies WHERE source = ? AND task = ?').get(source, task)

    return row!.session as string
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
    const rows = db
      .prepare(
        'SELECT task, occupancies.session AS session, beat_at, is_ended FROM occupancies LEFT JOIN sessions USING (session) WHERE source = ?',
      )
      .all(source)
    const held = new Map<number, { session: string; isOrphaned: boolean }>()
    const release = db.prepare('DELETE FROM occupancies WHERE source = ? AND task = ? AND occupied_at <= ?')
    for (const row of rows) {
      const task = row.task as number
      if (open.includes(task)) {
        held.set(task, {
          session: row.session as string,
          isOrphaned: row.beat_at === null || row.is_ended === 1 || now - (row.beat_at as number) > ORPHANED_AFTER_MS,
        })
      } else {
        release.run(source, task, readAt)
      }
    }

    return held
  } finally {
    db.close()
  }
}
