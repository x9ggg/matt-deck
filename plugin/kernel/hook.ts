// Task kernel: when a Deck service of this machine last received a call from
// Deck's hook, kept in the local state (ADR-0005) for every Session's Deck
// service to read. A host runs the hook only once the person trusted it, so
// a hook never received is one that may not run.
import { statSync } from 'node:fs'

import { openState, statePath } from './state.ts'

// Records a call from the hook received at `now`. Two Deck services writing
// at once keep the later time.
export const receiveHookCall = (home: string, now: number) => {
  const db = openState(home)
  try {
    db.prepare(
      'INSERT INTO hook_calls VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET received_at = max(received_at, excluded.received_at)',
    ).run(now)
  } finally {
    db.close()
  }
}

// Forgets every call from the hook received so far, for when the hook is
// written into a host's hooks anew and may need trust again. Without a local
// state there is nothing to forget, and none is made for it.
export const forgetHookCalls = (home: string) => {
  if (statSync(statePath(home), { throwIfNoEntry: false }) === undefined) {
    return
  }
  const db = openState(home)
  try {
    db.exec('DELETE FROM hook_calls')
  } finally {
    db.close()
  }
}

// When the last call from the hook was received, or null if none ever was.
export const hookReceivedAt = (home: string) => {
  const db = openState(home)
  try {
    const row = db.prepare('SELECT received_at FROM hook_calls').get()
    return row === undefined ? null : (row.received_at as number)
  } finally {
    db.close()
  }
}
