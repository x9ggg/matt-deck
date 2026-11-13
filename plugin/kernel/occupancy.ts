// Task kernel: Occupancy, kept in the local state (ADR-0005) by the identity
// of the Task Source, so every Workspace of a project shares it.
// Host-agnostic: it knows a home directory, a Task Source's identity and
// Sessions by their ids.
import { openState } from './state.ts'

// Records `session`'s Occupancy of the Task `task`, unless another Session
// holds one and `takeOver` does not move it to `session`; answers the
// Session that holds it now.
export const occupy = (home: string, source: string, task: number, session: string, now: number, takeOver: boolean) => {
  const db = openState(home)
  try {
    db.prepare(`INSERT OR ${takeOver ? 'REPLACE' : 'IGNORE'} INTO occupancies VALUES (?, ?, ?, ?)`).run(
      source,
      task,
      session,
      now,
    )
    const row = db.prepare('SELECT session FROM occupancies WHERE source = ? AND task = ?').get(source, task)

    return row!.session as string
  } finally {
    db.close()
  }
}

// Releases the Occupancy of the Task `task`, whichever Session holds it;
// answers whether there was one.
export const release = (home: string, source: string, task: number) => {
  const db = openState(home)
  try {
    return db.prepare('DELETE FROM occupancies WHERE source = ? AND task = ?').run(source, task).changes > 0
  } finally {
    db.close()
  }
}

// The Occupancies of the Task Source's open Tasks, `open`, by Task number,
// as a read begun at `readAt` found them. Those of every other Task are
// released: a Task closed, or no longer in the source. One recorded after the
// read began stays: it was recorded on a later read, which found its Task
// open.
export const settleOccupancies = (home: string, source: string, open: number[], readAt: number) => {
  const db = openState(home)
  try {
    const rows = db.prepare('SELECT task, session FROM occupancies WHERE source = ?').all(source)
    const held = new Map<number, string>()
    const release = db.prepare('DELETE FROM occupancies WHERE source = ? AND task = ? AND occupied_at <= ?')
    for (const row of rows) {
      const task = row.task as number
      if (open.includes(task)) {
        held.set(task, row.session as string)
      } else {
        release.run(source, task, readAt)
      }
    }

    return held
  } finally {
    db.close()
  }
}
