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

// One Task as the Task Source holds it, with what only its detail shows, and
// the identity of the Task Source holding it.
export type SourceTaskDetail = {
  identity: string
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
// whose Occupancy holds it, or null; `isOrphaned` says that Session has
// ended while the Task is open. `hasEvidence` says a report gave Acceptance
// Evidence for it, open or closed.
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
  isOrphaned: boolean
  hasEvidence: boolean
}

// A Spec or a Map: a Task with Child Tasks, or a Map with none yet. `group`
// is where it would stand as a Task; `progress` counts its Child Tasks.
export type Container = Task & {
  kind: 'spec' | 'map'
  // Only an open Spec whose Child Tasks are all closed. This says nothing
  // about acceptance and never changes its Task Status.
  isPendingCloseout: boolean
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
// the Occupancies of its open Tasks, `occupants`, by Task number, and the
// Tasks a report gave Acceptance Evidence for, `evidenced`.
export const listTasks = (
  source: SourceRead,
  fetchedAt: number,
  occupants: ReadonlyMap<number, { session: string; isOrphaned: boolean }>,
  evidenced: ReadonlySet<number>,
): TaskList => {
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
      occupant: task.isOpen ? (occupants.get(task.number)?.session ?? null) : null,
      isOrphaned: task.isOpen && occupants.get(task.number)?.isOrphaned === true,
      hasEvidence: evidenced.has(task.number),
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
      containers.push({
        ...task,
        kind,
        isPendingCloseout: kind === 'spec' && task.isOpen && progress.closed === progress.total,
        group: groupOf(task),
        children: children.map(child => child.number),
        progress,
      })
    } else {
      groups[groupOf(task)].push(task)
    }
  }
  groups.done.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))

  return { ok: true, fetchedAt, containers, groups }
}

// A Task as its detail shows it: the body split into the description and the
// acceptance criteria, which are the body's checklist items.
export type TaskDetail = Omit<SourceTaskDetail, 'identity' | 'body'> & {
  description: string
  acceptance: { text: string; isChecked: boolean }[]
}

const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/

// Sections of a body the detail draws in its own places: what the Task
// belongs to, what blocks it, its acceptance criteria.
const DRAWN_ELSEWHERE = /^\s*#{1,6}\s*\**\s*(parent|blocked by|acceptance criteria)\b/i

// The Task `number`, with the identity of the Task Source holding it.
export const readTask = async (source: TaskSource, number: number): Promise<{ identity: string; task: TaskDetail }> => {
  const { identity, body, ...task } = await source.readOne(number)
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

  return { identity, task: { ...task, description, acceptance } }
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
        parent { number repository { nameWithOwner } }
        blockedBy(first: 50) { nodes { number repository { nameWithOwner } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

// An issue a sub-issue parent or a native dependency points at, which may be
// in another repository.
type IssueRef = { number: number; repository: { nameWithOwner: string } }

type IssueNode = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  closedAt: string | null
  body: string
  labels: { nodes: { name: string }[] }
  parent: IssueRef | null
  blockedBy: { nodes: IssueRef[] }
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

// The issues a text points at: `#12`, `owner/repo#12`, or a link ending in
// `/issues/12` or `owner/repo/issues/12`. One that names a repository other
// than `identity` is null: it is not this repository's issue of the same
// number. A Markdown link `[text](link)` on one line whose link is to an issue
// is that one reference, whatever its text says; any other link leaves its
// text's. Its text may hold brackets nested once, `[#12 [draft]]`, and escaped
// ones, `\[` and `\]`, which neither open nor close a pair.
//
// It reads as a regular expression would, in one pass: a run of the
// characters a repository's name holds, or a link's text or link, is measured
// once and not again from each place inside it, so the time grows with the
// text's length and not with its square.
const references = (text: string, identity: string): (number | null)[] => {
  const reference = (repository: string | undefined, number: string) =>
    repository === undefined || repository.toLowerCase() === identity.toLowerCase() ? Number(number) : null
  const n = text.length
  const isName = (c: string) => /[\w.-]/.test(c)
  // From each place, read right to left: where its run of name characters
  // ends; where the elements of a link's text, and of brackets nested in it,
  // starting there end; the first `)` or line break from there.
  const nameEnd = new Int32Array(n + 2).fill(n)
  const textEnd = new Int32Array(n + 2).fill(n)
  const nestedEnd = new Int32Array(n + 2).fill(n)
  const closeAt = new Int32Array(n + 2).fill(n)
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i]!
    nameEnd[i] = isName(c) ? nameEnd[i + 1]! : i
    closeAt[i] = c === ')' || c === '\n' ? i : closeAt[i + 1]!
    if (c === '\\') {
      // An escape: a backslash and any character but a line break.
      const isEscape = i + 1 < n && !/[\n\r\u2028\u2029]/.test(text[i + 1]!)
      textEnd[i] = isEscape ? textEnd[i + 2]! : i
      nestedEnd[i] = isEscape ? nestedEnd[i + 2]! : i
    } else if (c === '[') {
      const close = nestedEnd[i + 1]!
      textEnd[i] = text[close] === ']' ? textEnd[close + 1]! : i
      nestedEnd[i] = i
    } else if (c === ']' || c === '\n') {
      textEnd[i] = i
      nestedEnd[i] = i
    } else {
      textEnd[i] = textEnd[i + 1]!
      nestedEnd[i] = nestedEnd[i + 1]!
    }
  }
  // An issue reference starting at `at`: `/issues/12` or `#12` after an
  // optional `owner/repo`, tried in that order; only `/issues/12` in a link.
  const issueAt = (at: number, isLink: boolean) => {
    const slash = nameEnd[at]!
    const repositoryEnd = slash > at && text[slash] === '/' && nameEnd[slash + 1]! > slash + 1 ? nameEnd[slash + 1]! : undefined
    for (const marker of isLink ? ['/issues/'] : ['/issues/', '#']) {
      for (const start of repositoryEnd === undefined ? [at] : [repositoryEnd, at]) {
        if (!text.startsWith(marker, start)) continue
        const digits = start + marker.length
        let end = digits
        while (end < n && text[end]! >= '0' && text[end]! <= '9') end++
        if (end > digits) {
          return { repository: start === at ? undefined : text.slice(at, start), number: text.slice(digits, end), end }
        }
      }
    }
    return undefined
  }

  let found: (number | null)[] = []
  let at = 0
  while (at < n) {
    if (text[at] === '[') {
      const textClose = textEnd[at + 1]!
      const linkClose = closeAt[textClose + 2]!
      if (text[textClose] === ']' && text[textClose + 1] === '(' && text[linkClose] === ')') {
        let link: ReturnType<typeof issueAt>
        for (let from = textClose + 2; from < linkClose && link === undefined; from++) link = issueAt(from, true)
        found = found.concat(
          link === undefined ? references(text.slice(at + 1, textClose), identity) : [reference(link.repository, link.number)],
        )
        at = linkClose + 1
        continue
      }
    }
    const issue = issueAt(at, false)
    if (issue !== undefined) {
      found.push(reference(issue.repository, issue.number))
      at = issue.end
      continue
    }
    at++
  }

  return found
}

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
      // The repository's owner and name, as the issue's link names them.
      identity: new URL(issue.url).pathname.split('/').slice(1, 3).join('/'),
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

    const identity = pages[0]!.data.repository.nameWithOwner
    const tasks = pages
      .flatMap(page => page.data.repository.issues.nodes)
      .map(node => {
        // A parent or blocker in another repository is not this
        // repository's issue of the same number; it is taken as if GitHub
        // had not given it.
        const parent = node.parent?.repository.nameWithOwner === identity ? node.parent.number : undefined
        const blockers = node.blockedBy.nodes
          .filter(blocker => blocker.repository.nameWithOwner === identity)
          .map(blocker => blocker.number)

        return {
          number: node.number,
          title: node.title,
          isOpen: node.state === 'OPEN',
          closedAt: node.closedAt,
          labels: node.labels.nodes.map(label => label.name),
          isMap: node.labels.nodes.some(label => label.name === 'wayfinder:map'),
          // A sub-issue first, then the body's `Parent` section, then a `Part
          // of #n` line at its top.
          parent:
            parent ??
            // The section's first reference is its parent; one in another
            // repository gives none, and the `Part of` line is read next.
            references(declared(node.body, 'Parent') ?? '', identity)[0] ??
            references(node.body.trimStart().match(/^Part of #\d+/i)?.[0] ?? '', identity)[0] ??
            null,
          // GitHub's own dependencies first; without any in this repository,
          // the body's, leaving out those in another repository.
          blockedBy:
            blockers.length > 0
              ? blockers
              : references(declared(node.body, 'Blocked by') ?? '', identity).filter(number => number !== null),
        }
      })

    return { identity, tasks }
  },
})
