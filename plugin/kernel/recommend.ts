// Task kernel: Recommendation Requests. What a request asks of the agent,
// with the Task Snapshot it carries, and the Recommendations the agent
// reports back, kept by request in the local state (ADR-0005).
// Host-agnostic: it knows a Task list and a home directory.
import { openState } from './state.ts'
import type { Task, TaskList } from './tasks.ts'

// The Tasks in a few lines for the agent: the open ones by group, the
// closed ones counted.
export const snapshotOf = (list: TaskList) => {
  const line = (task: Task) => {
    const labels = task.labels.length > 0 ? ` [${task.labels.join(', ')}]` : ''
    const parent = task.parent !== null ? ` (in #${task.parent})` : ''
    const blockers = task.blockers.length > 0 ? `, blocked by ${task.blockers.map(number => `#${number}`).join(' ')}` : ''
    const orphaned = task.isOrphaned ? ', Orphaned: its Session has ended' : ''

    return `- #${task.number} ${task.title}${labels}${parent}${blockers}${orphaned}`
  }
  const section = (title: string, lines: string[]) => (lines.length > 0 ? [`${title}:`, ...lines] : [`${title}: none`])
  const done = list.groups.done.length

  return [
    ...section(
      'Specs and Maps',
      list.containers
        .filter(container => container.isOpen)
        .map(
          container =>
            `- #${container.number} ${container.title} (${container.kind}, ${container.progress.closed} of ${container.progress.total} Child Tasks closed)`,
        ),
    ),
    ...section('Ready', list.groups.ready.map(line)),
    ...section('In progress', list.groups.inProgress.map(line)),
    ...section('Blocked', list.groups.blocked.map(line)),
    `Done: ${done} ${done === 1 ? 'Task' : 'Tasks'} closed`,
  ].join('\n')
}

// The arguments of the request `requestId`: the request, the snapshot, and
// the ask to report through deck_recommend and to do nothing more.
export const askArgs = (requestId: string, snapshot: string) =>
  `Matt Deck Recommendation Request ${requestId}.\n\n` +
  `Task Snapshot, read from the Task Source as this request was sent:\n${snapshot}\n\n` +
  'Recommend only: do not start the work, change no file and run no other skill. ' +
  `Once you have decided, call the tool deck_recommend with requestId "${requestId}", ` +
  'task (the number of the Task to do next, or null), nextStep, skill (the skill to use, as it is called), ' +
  'reason and blockers. Then answer in a sentence or two.'

// What the agent reports for a request: the Task to do next by number, or
// null for none, and the four texts, each "" where there is nothing to say.
export type Recommendation = { task: number | null; nextStep: string; skill: string; reason: string; blockers: string }

// Keeps the Recommendation for a request; a later report for the same
// request replaces it.
export const saveRecommendation = (home: string, requestId: string, recommendation: Recommendation, now: number) => {
  const db = openState(home)
  try {
    db.prepare('INSERT OR REPLACE INTO recommendations VALUES (?, ?, ?)').run(
      requestId,
      JSON.stringify(recommendation),
      now,
    )
  } finally {
    db.close()
  }
}

export const readRecommendation = (home: string, requestId: string): Recommendation | undefined => {
  const db = openState(home)
  try {
    const row = db.prepare('SELECT recommendation FROM recommendations WHERE request_id = ?').get(requestId)

    return row === undefined ? undefined : JSON.parse(row.recommendation as string)
  } finally {
    db.close()
  }
}
