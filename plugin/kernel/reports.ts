// Task kernel: what the agent reports as it finishes executing a Task, kept
// in the local state (ADR-0005) by the identity of the Task Source, so every
// Workspace of a project reads it. Deck keeps and shows a report; it judges
// no Acceptance Evidence, closes no Task and leaves the Occupancy as it is.
// Host-agnostic: it knows a home directory, a Task Source's identity and
// Sessions by their ids.
import { openState } from './state.ts'

// One Acceptance Evidence: what shows an acceptance criterion is met, and
// where it comes from (a test command and its output, a commit, a PR).
export type Evidence = { text: string; source: string }

// One report of a Task: the Session that reported it, when, its result and
// its Acceptance Evidence.
export type Report = { session: string; reportedAt: number; result: string; evidence: Evidence[] }

// Keeps a report of the Task `task`, beside those reported before.
export const saveReport = (home: string, source: string, task: number, report: Report) => {
  const db = openState(home)
  try {
    db.prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?)').run(
      source,
      task,
      report.session,
      report.reportedAt,
      report.result,
      JSON.stringify(report.evidence),
    )
  } finally {
    db.close()
  }
}

// Every report of the Task `task`, the first first.
export const readReports = (home: string, source: string, task: number): Report[] => {
  const db = openState(home)
  try {
    return db
      .prepare('SELECT session, reported_at, result, evidence FROM reports WHERE source = ? AND task = ? ORDER BY rowid')
      .all(source, task)
      .map(row => ({
        session: row.session as string,
        reportedAt: row.reported_at as number,
        result: row.result as string,
        evidence: JSON.parse(row.evidence as string),
      }))
  } finally {
    db.close()
  }
}

// The Tasks of the Task Source some report gave Acceptance Evidence for.
export const evidencedTasks = (home: string, source: string) => {
  const db = openState(home)
  try {
    const rows = db.prepare("SELECT DISTINCT task FROM reports WHERE source = ? AND evidence <> '[]'").all(source)

    return new Set(rows.map(row => row.task as number))
  } finally {
    db.close()
  }
}
