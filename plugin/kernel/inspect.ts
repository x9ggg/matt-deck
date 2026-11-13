// One read-only diagnostic snapshot, shared by the CLI and Deck service.
import { readProjectConfig } from './config.ts'
import { readOccupancies } from './occupancy.ts'
import { evidencedTasks } from './reports.ts'
import { statePath } from './state.ts'
import { githubIssues, listTasks, TaskSourceError } from './tasks.ts'

const inspectTasks = async (workspace: string, home: string) => {
  const fetchedAt = Date.now()
  const source = await githubIssues(workspace).read()
  const occupants = readOccupancies(home, source.identity, Date.now())
  const open = new Set(source.tasks.filter(task => task.isOpen).map(task => task.number))
  const occupancies = [...occupants]
    .filter(([task]) => open.has(task))
    .map(([task, occupancy]) => ({ task, ...occupancy }))

  return {
    tasks: listTasks(source, fetchedAt, occupants, evidencedTasks(home, source.identity)),
    occupancies,
  }
}

export const inspectProject = async (workspace: string, home: string) => {
  const project = await readProjectConfig(workspace)
  const context = { ...project, stateFile: statePath(home) }
  if (!project.configured) {
    return {
      ...context,
      ok: false,
      failure: {
        kind: 'not-configured',
        message: 'This workspace is not a Configured Project: .matt-deck/config.json does not exist',
      },
    }
  }
  try {
    return { ...context, ok: true, ...(await inspectTasks(workspace, home)) }
  } catch (error) {
    if (!(error instanceof TaskSourceError)) throw error
    return { ...context, ok: false, failure: { kind: error.kind, message: error.message } }
  }
}
