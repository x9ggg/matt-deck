// Task kernel: the Tasks of a project, read from its Task Source and put in
// the four groups. Host-agnostic: it knows a workspace directory and nothing
// about who asks.
import { execFile } from 'node:child_process'

// A Task as the Task Source holds it, before it is grouped: whether it is a
// Map, its `parent` and `blockedBy` already read from whichever way the
// source writes them.
export type SourceTask = {
  number: number
  title: string
  isOpen: boolean
  closedAt: string | null
  labels: string[]
  isMap: boolean
  parent: number | null
  blockedBy: number[]
}

// One Task as the Task Source holds it, with what only its detail shows.
export type SourceTaskDetail = {
  number: number
  title: string
  isOpen: boolean
  closedAt: string | null
  updatedAt: string
  labels: string[]
  assignees: string[]
  url: string
  body: string
}

// What a Task Source holds: its identity, which names it the same from every
// Workspace of the project (a GitHub repository's owner and name), and all
// its Tasks, open and closed.
export type SourceRead = { identity: string; tasks: SourceTask[] }

// Every Task Source answers with all its Tasks, or with one of them; or
// throws a TaskSourceError.
export type TaskSource = {
  read: () => Promise<SourceRead>
  readOne: (number: number) => Promise<SourceTaskDetail>
}

export type TaskSourceFailure = 'gh-missing' | 'unauthenticated' | 'offline' | 'no-repository' | 'failed'

export class TaskSourceError extends Error {
  kind: TaskSourceFailure
  constructor(kind: TaskSourceFailure, message: string) {
    super(message)
    this.kind = kind
  }
}

export type Group = 'ready' | 'inProgress' | 'blocked' | 'done'

// A Task as the kernel lists it. `parent` is its Spec or Map, `blockers` the
// open Tasks blocking an open one, `blockedBy` every Task it declares a
// Blocking Edge to, closed ones too, by number. `occupant` is the Session
// whose Occupancy holds it, or null.
export type Task = {
  number: number
  title: string
  isOpen: boolean
  labels: string[]
  parent: number | null
  blockers: number[]
  blockedBy: number[]
  closedAt: string | null
  occupant: string | null
}

// A Spec or a Map: a Task with Child Tasks, or a Map with none yet. `group`
// is where it would stand as a Task; `progress` counts its Child Tasks.
export type Container = Task & {
  kind: 'spec' | 'map'
  group: Group
  children: number[]
  progress: { closed: number; inProgress: number; total: number }
}

export type TaskList = {
  ok: true
  // When the Task Source was read, in milliseconds since the epoch.
  fetchedAt: number
  // Every Spec and Map, open and closed, in no group.
  containers: Container[]
  groups: Record<Group, Task[]>
}

export type TaskListFailure = { ok: false; failure: { kind: TaskSourceFailure; message: string } }

// Labels that keep an open Task out of "ready": it waits on a person.
const WAITING_LABELS = ['needs-triage', 'needs-info']

const groupOf = (task: Task): Group => {
  if (!task.isOpen) {
    return 'done'
  }
  // Execution Status comes from Occupancy alone: an occupied Task is in
  // progress, blocked or not. A Task waiting on triage is no more startable
  // than a blocked one, so it stands with them.
  if (task.occupant !== null) {
    return 'inProgress'
  }
  if (task.blockers.length > 0 || task.labels.some(label => WAITING_LABELS.includes(label))) {
    return 'blocked'
  }

  return 'ready'
}

// The Tasks of a read of the Task Source, read at `fetchedAt`, grouped with
// the Occupancies of its open Tasks, `occupants`, by Task number.
export const listTasks = (source: SourceRead, fetchedAt: number, occupants: ReadonlyMap<number, string>): TaskList => {
  const read = [...source.tasks].sort((a, b) => a.number - b.number)
  const isOpen = new Map(read.map(task => [task.number, task.isOpen]))
  const tasks = read.map(({ blockedBy, isMap, ...task }) => ({
    isMap,
    task: {
      ...task,
      // A parent the source does not hold makes no Spec.
      parent: task.parent !== null && isOpen.has(task.parent) ? task.parent : null,
      // A closed Task is blocked by nothing. A blocker the source does not
      // hold (a pull request, another repository's issue) cannot be checked,
      // so it does not block.
      blockers: task.isOpen ? blockedBy.filter(number => isOpen.get(number) === true).sort((a, b) => a - b) : [],
      blockedBy: blockedBy.filter(number => isOpen.has(number)).sort((a, b) => a - b),
      occupant: task.isOpen ? (occupants.get(task.number) ?? null) : null,
    } as Task,
  }))

  const containers: Container[] = []
  const groups: Record<Group, Task[]> = { ready: [], inProgress: [], blocked: [], done: [] }
  for (const { isMap, task } of tasks) {
    const children = tasks.filter(child => child.task.parent === task.number).map(child => child.task)
    if (isMap || children.length > 0) {
      const progress = {
        closed: children.filter(child => !child.isOpen).length,
        inProgress: children.filter(child => groupOf(child) === 'inProgress').length,
        total: children.length,
      }
      const kind = isMap ? 'map' : 'spec'
      containers.push({ ...task, kind, group: groupOf(task), children: children.map(child => child.number), progress })
    } else {
      groups[groupOf(task)].push(task)
    }
  }
  groups.done.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))

  return { ok: true, fetchedAt, containers, groups }
}

// A Task as its detail shows it: the body split into the description and the
// acceptance criteria, which are the body's checklist items.
export type TaskDetail = Omit<SourceTaskDetail, 'body'> & {
  description: string
  acceptance: { text: string; isChecked: boolean }[]
}

const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/

// Sections of a body the detail draws in its own places: what the Task
// belongs to, what blocks it, its acceptance criteria.
const DRAWN_ELSEWHERE = /^\s*#{1,6}\s*\**\s*(parent|blocked by|acceptance criteria)\b/i

export const readTask = async (source: TaskSource, number: number): Promise<TaskDetail> => {
  const { body, ...task } = await source.readOne(number)
  const acceptance: TaskDetail['acceptance'] = []
  const kept: string[] = []
  let isDropping = false
  // The fence that opened the code block a line is in.
  let fence: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    // A code block is taken as it stands: a heading or a checklist item in
    // it is neither.
    const isCode = fence !== undefined || marker !== null
    if (fence === undefined) {
      fence = marker?.[1]
    } else if (marker !== null && marker[1]!.startsWith(fence) && marker[2]!.trim() === '') {
      fence = undefined
    }
    if (!isCode) {
      if (/^\s*#{1,6}\s/.test(line)) {
        isDropping = DRAWN_ELSEWHERE.test(line)
      }
      const item = line.match(CHECKLIST_ITEM)
      if (item !== null) {
        acceptance.push({ text: item[2]!.trim(), isChecked: item[1] !== ' ' })
        continue
      }
      // `Part of #n` and `Blocked by:` say what the Task belongs to and what
      // blocks it only at the top of the body, where the issue tracker doc
      // puts them.
      if (kept.every(line => line.trim() === '') && /^\s*(part of #\d+|blocked by:)/i.test(line)) {
        continue
      }
    }
    if (isDropping) {
      continue
    }
    kept.push(line)
  }
  const description = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { ...task, description, acceptance }
}

// The issues of the workspace's GitHub repository, read with the `gh` command
// line in the workspace, as `docs/agents/issue-tracker.md` has it.
const QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(first: 100, after: $endCursor, states: [OPEN, CLOSED]) {
      nodes {
        number title state closedAt body
        labels(first: 50) { nodes { name } }
        parent { number }
        blockedBy(first: 50) { nodes { number } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

type IssueNode = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  closedAt: string | null
  body: string
  labels: { nodes: { name: string }[] }
  parent: { number: number } | null
  blockedBy: { nodes: { number: number }[] }
}

const gh = (workspace: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('gh', args, { cwd: workspace, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout)
        return
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new TaskSourceError('gh-missing', 'gh is not installed or not on PATH'))
        return
      }
      const message = stderr.trim() || error.message
      // gh exits with 4 when it needs a login.
      if (error.code === 4 || /gh auth login|not logged in/i.test(message)) {
        reject(new TaskSourceError('unauthenticated', message))
      } else if (/error connecting|dial tcp|no such host|network is unreachable|timeout|could not resolve host/i.test(message)) {
        // "Could not resolve host", not "Could not resolve to an issue": that
        // is a Task that is not there.
        reject(new TaskSourceError('offline', message))
      } else if (/could not determine|no git remotes|not a git repository|none of the git remotes/i.test(message)) {
        reject(new TaskSourceError('no-repository', message))
      } else {
        reject(new TaskSourceError('failed', message))
      }
    })
  })

// The text a body gives under `name`: the section a heading of that name
// opens, up to the next heading, or the rest of a line that starts with it.
const declared = (body: string, name: string): string | undefined => {
  const lines = body.split(/\r?\n/)
  const at = lines.findIndex(line => new RegExp(`^\\s*(#{1,6}\\s*)?\\**${name}\\b`, 'i').test(line))
  if (at === -1) {
    return undefined
  }
  const line = lines[at]!
  if (!/^\s*#/.test(line)) {
    return line.slice(line.search(new RegExp(name, 'i')) + name.length)
  }
  const end = lines.findIndex((other, index) => index > at && /^\s*#{1,6}\s/.test(other))

  return lines.slice(at + 1, end === -1 ? undefined : end).join('\n')
}

// The issues a text points at: `#12`, or a link ending in `/issues/12`.
const references = (text: string) => [...text.matchAll(/(?:#|\/issues\/)(\d+)/g)].map(match => Number(match[1]))

type ViewedIssue = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  closedAt: string | null
  updatedAt: string
  url: string
  body: string
  labels: { name: string }[]
  assignees: { login: string }[]
}

export const githubIssues = (workspace: string): TaskSource => ({
  readOne: async number => {
    const stdout = await gh(workspace, [
      'issue',
      'view',
      String(number),
      '--json',
      'number,title,state,closedAt,updatedAt,url,body,labels,assignees',
    ])
    const issue: ViewedIssue = JSON.parse(stdout)

    return {
      number: issue.number,
      title: issue.title,
      isOpen: issue.state === 'OPEN',
      closedAt: issue.closedAt,
      updatedAt: issue.updatedAt,
      labels: issue.labels.map(label => label.name),
      assignees: issue.assignees.map(assignee => assignee.login),
      url: issue.url,
      body: issue.body,
    }
  },
  read: async () => {
    const stdout = await gh(workspace, [
      'api',
      'graphql',
      '--paginate',
      '--slurp',
      '-F',
      'owner={owner}',
      '-F',
      'name={repo}',
      '-f',
      `query=${QUERY}`,
    ])
    const pages: { data: { repository: { nameWithOwner: string; issues: { nodes: IssueNode[] } } } }[] =
      JSON.parse(stdout)

    const tasks = pages
      .flatMap(page => page.data.repository.issues.nodes)
      .map(node => ({
        number: node.number,
        title: node.title,
        isOpen: node.state === 'OPEN',
        closedAt: node.closedAt,
        labels: node.labels.nodes.map(label => label.name),
        isMap: node.labels.nodes.some(label => label.name === 'wayfinder:map'),
        // A sub-issue first, then the body's `Parent` section, then a `Part
        // of #n` line at its top.
        parent:
          node.parent?.number ??
          references(declared(node.body, 'Parent') ?? '')[0] ??
          references(node.body.trimStart().match(/^Part of #\d+/i)?.[0] ?? '')[0] ??
          null,
        // GitHub's own dependencies first; without any, the body's.
        blockedBy:
          node.blockedBy.nodes.length > 0
            ? node.blockedBy.nodes.map(blocker => blocker.number)
            : references(declared(node.body, 'Blocked by') ?? ''),
      }))

    return { identity: pages[0]!.data.repository.nameWithOwner, tasks }
  },
})
