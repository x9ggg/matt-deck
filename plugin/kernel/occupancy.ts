// Task kernel: Occupancy, kept in the local state (ADR-0005) by the identity
// of the Task Source, so every Workspace of a project shares it.
// Host-agnostic: it knows a home directory, a Task Source's identity and
// Sessions by their ids.
import { openState } from './state.ts'

// Records `session`'s Occupancy of the Task `task`, unless another Session
// holds one; answers the Session that holds it now.
export const occupy = (home: string, source: string, task: number, session: string, now: number) => {
  const db = openState(home)
  try {
    db.prepare('INSERT OR IGNORE INTO occupancies VALUES (?, ?, ?, ?)').run(source, task, session, now)
    const row = db.prepare('SELECT session FROM occupancies WHERE source = ? AND task = ?').get(source, task)

    return row!.session as string
  } finally {
    db.close()
  }
}

// The Occupancies of the Task Source's open Tasks, by Task number. Those of
// every other Task are released: a Task closed, or no longer in the source.
export const settleOccupancies = (home: string, source: string, open: number[]) => {
  const db = openState(home)
  try {
    const rows = db.prepare('SELECT task, session FROM occupancies WHERE source = ?').all(source)
    const held = new Map<number, string>()
    const release = db.prepare('DELETE FROM occupancies WHERE source = ? AND task = ?')
    for (const row of rows) {
      const task = row.task as number
      if (open.includes(task)) {
        held.set(task, row.session as string)
      } else {
        release.run(source, task)
      }
    }

    return held
  } finally {
    db.close()
  }
}
