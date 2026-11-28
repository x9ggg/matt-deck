// The Deck service: an MCP server over stdio that exposes the task kernel as
// `deck_*` tools. The host starts it on demand; its Workspace comes from the
// working directory it was started in (ADR-0005), never from a path passed by
// a caller. Its host is named by its launch arguments, never guessed.
// Runs on plain Node with no installed packages, so MCP is spoken by hand.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { readProjectConfig, writeProjectConfig } from '../kernel/config.ts'
import { hookReceivedAt, receiveHookCall } from '../kernel/hook.ts'
import { inspectProject } from '../kernel/inspect.ts'
import { mapViews } from '../kernel/maps.ts'
import { beat, endSession, implementedTasks, occupy, release, settleOccupancies, taskReference } from '../kernel/occupancy.ts'
import { askArgs, readRecommendation, saveRecommendation, snapshotOf } from '../kernel/recommend.ts'
import { evidencedTasks, readReports, saveReport } from '../kernel/reports.ts'
import { surveySetup } from '../kernel/setup.ts'
import { listSkills, readSkill, SkillSourceError } from '../kernel/skills.ts'
import { githubIssues, listTasks, readTask, TaskSourceError } from '../kernel/tasks.ts'
import { workspaceAt } from '../kernel/workspace.ts'
import type { ProjectConfig } from '../kernel/config.ts'
import type { SourceRead, TaskListFailure } from '../kernel/tasks.ts'
import { callOf, CODEX_CONFIGURE_SKILL, CODEX_HOOK_TOOL, hostNamed, nameSession, skillDirectories } from './hosts.ts'

const USAGE = `Usage: node <matt-deck>/server/main.ts --host <claude-code|codex>

Deck 服务，由宿主按注册时的启动命令运行，经 stdin 和 stdout 说 MCP。--host 写明宿主。
退出码：2 参数错误。
`
const launch = process.argv.slice(2)
const host = launch.length === 2 && launch[0] === '--host' ? hostNamed(launch[1]) : undefined
if (host === undefined) {
  process.stderr.write(USAGE)
  process.exit(2)
}

// The Workspace is the checkout the service was started in: the nearest
// directory at or above the working directory that holds `.git`. Outside a
// repository it is the working directory itself.
const workspace = workspaceAt(process.cwd())

// The last read of the Task Source, answered again to a read that does not
// ask for a fresh one for this long from the time it ended; it is fetched
// as of the time it began. A read that fails empties it: the read after it
// reaches the Task Source again instead of answering with what was read
// before the failure. Occupancy is not cached: every answer has it as the
// local state holds it then, whichever Session recorded it.
const TASKS_CACHE_MS = 15_000
let cachedRead: { source: SourceRead; fetchedAt: number; endedAt: number } | undefined

// The Task Source's identity as the last read named it. It outlives the
// cache: a report is kept by it while the Task Source cannot be read.
let knownIdentity: string | undefined

// The Task Source as read last, or read now when `refresh` asks for it or
// the cache is too old. Throws a TaskSourceError.
const readSource = async (refresh: boolean) => {
  const now = Date.now()
  if (refresh || cachedRead === undefined || now - cachedRead.endedAt >= TASKS_CACHE_MS) {
    cachedRead = undefined
    const source = await githubIssues(workspace).read()
    cachedRead = { source, fetchedAt: now, endedAt: Date.now() }
    knownIdentity = cachedRead.source.identity
  }

  return cachedRead
}

// The Tasks of a read, with the Occupancies of its open Tasks, Orphaned or
// not as of now; those of the others are released, unless they were recorded
// after the read began. Each says whether a report gave Acceptance Evidence
// for it.
const tasksOf = ({ source, fetchedAt }: { source: SourceRead; fetchedAt: number }) =>
  listTasks(
    source,
    fetchedAt,
    settleOccupancies(
      homedir(),
      source.identity,
      source.tasks.filter(task => task.isOpen).map(task => task.number),
      fetchedAt,
      Date.now(),
    ),
    evidencedTasks(homedir(), source.identity),
    nameSession,
  )

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: object
  isError: boolean
}

// Claude Code puts every call of a tool that no permission rule allows
// through the Session's permission hooks, the Pane's own reads too, and a hook
// that waits for the person keeps the Pane waiting with it. This rule allows every
// tool of the Deck service, as Claude Code names the service of this plugin.
// It goes in the local settings of the directory the Session runs in, which
// is where Claude Code reads them, not at the Workspace's root.
const ALLOW_RULE = 'mcp__plugin_matt-deck_deck'
const LOCAL_SETTINGS = '.claude/settings.local.json'

// Throws when the file is there and is not a JSON object.
const readLocalSettings = async (): Promise<Record<string, any>> => {
  let text: string
  try {
    text = await readFile(join(process.cwd(), LOCAL_SETTINGS), 'utf8')
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {}
    }
    throw error
  }
  let settings: unknown
  try {
    settings = JSON.parse(text)
  } catch (error: any) {
    throw new Error(`${LOCAL_SETTINGS} is not valid JSON: ${error.message}`)
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${LOCAL_SETTINGS} is not a JSON object`)
  }

  return settings
}

// Answers from the Skill Source of the project config. A Skill Source that
// cannot be read is an answer the caller shows, not a broken tool.
const skillAnswer = async (read: (source: ProjectConfig['skillSource']) => Promise<object>): Promise<ToolResult> => {
  const project = await readProjectConfig(workspace)
  if (!project.configured) {
    throw new Error('This workspace is not a Configured Project: .matt-deck/config.json does not exist')
  }
  let answer: object
  try {
    answer = { ok: true, ...(await read(project.config.skillSource)) }
  } catch (error: any) {
    if (!(error instanceof SkillSourceError)) {
      throw error
    }
    answer = { ok: false, failure: { kind: error.kind, message: error.message } }
  }

  return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
}

const tools = {
  deck_inspect: {
    description: 'Inspect project config, local state location, grouped Tasks and Occupancy without changing local state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      const result = await inspectProject(workspace, homedir(), nameSession)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
    },
  },
  deck_config: {
    description:
      'Read the Matt Deck project config (.matt-deck/config.json) of the workspace this service was started in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      const result = await readProjectConfig(workspace)

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      }
    },
  },
  deck_tasks: {
    description:
      'List the Tasks of this project from its Task Source, grouped as ready, inProgress, blocked and done. Reads are cached for a short while; refresh reads the Task Source again.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Read the Task Source again instead of answering from the cache.' },
      },
      additionalProperties: false,
    },
    run: async ({ refresh }: any): Promise<ToolResult> => {
      let read
      try {
        read = await readSource(refresh === true)
      } catch (error: any) {
        if (!(error instanceof TaskSourceError)) {
          throw error
        }
        // A Task Source that cannot be read is an answer, not a broken
        // tool: the caller shows why.
        const failed: TaskListFailure = { ok: false, failure: { kind: error.kind, message: error.message } }

        return { content: [{ type: 'text', text: JSON.stringify(failed) }], structuredContent: failed, isError: false }
      }
      const list = tasksOf(read)

      return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: list, isError: false }
    },
  },
  deck_map: {
    description:
      'For the Pane: the Tasks of this project as deck_tasks lists them, and, from the same read, as maps every Spec and Map of this project, open ones first, each with its goal (the first sentence of the first paragraph of text in its body, past code blocks, lists with the paragraphs indented under their items, quotes, tables with or without leading pipes, details, other HTML, definitions of links and footnotes, images and paragraphs of only white space or zero-width characters, its Markdown and inline HTML as plain text, entities as their characters, or null; the Pane shows at most two lines of it) and its Child Tasks in the order its Map View shows them: ready; in progress, the asking Session\'s first, then other Sessions\', then Orphaned; blocked, each blocker before the Tasks it blocks; closed. Each Child Task says when it was last updated and which open Tasks it blocks. A Pending Closeout Spec carries as closeoutPrompt the closeout check the Pane prefills; every other Spec or Map, null. Reads as deck_tasks does, from its cache; refresh reads the Task Source again.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', minLength: 1, description: 'The id of the Session asking.' },
        refresh: { type: 'boolean', description: 'Read the Task Source again instead of answering from the cache.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
    run: async ({ session, refresh }: any): Promise<ToolResult> => {
      if (typeof session !== 'string' || session === '') {
        return { content: [{ type: 'text', text: 'deck_map takes the id of the Session asking' }], isError: true }
      }
      let answer: object
      try {
        const read = await readSource(refresh === true)
        // One list, its Occupancies settled once, for the Tasks and their
        // Map Views alike.
        const list = tasksOf(read)
        answer = { ...list, maps: mapViews(list, read.source, session) }
      } catch (error: any) {
        if (!(error instanceof TaskSourceError)) {
          throw error
        }
        answer = { ok: false, failure: { kind: error.kind, message: error.message } }
      }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_occupy: {
    description:
      'For the Pane: record that a Session executes a Task, as the prompt starting it is sent. The Task is given by its number, or by reference: the arguments of implement as sent, whose first word refers to it (#12, 12, or a link to an issue of github.com), the answer then naming it as task; a reference to none answers so, kind no-reference. A Task held by another Session stays with it unless takeOver names that Session; the answer names the Session holding it and, when it is another, whether that Occupancy is Orphaned.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', minLength: 1, description: 'The id of the Session executing the Task.' },
        task: { type: 'integer', minimum: 1, description: 'The Task\'s number; or reference instead.' },
        reference: { type: 'string', description: 'The arguments of implement as sent, whose first word refers to the Task; or task instead.' },
        takeOver: {
          type: 'string',
          minLength: 1,
          description:
            'The id of the Session to move the Task\'s Occupancy from, to this one; only after the person confirmed taking it over from that Session. Held by a third Session by now, the Task stays with it.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
    run: async ({ session, task: number, reference, takeOver }: any): Promise<ToolResult> => {
      if (
        typeof session !== 'string' ||
        session === '' ||
        (reference === undefined ? !Number.isInteger(number) || number < 1 : typeof reference !== 'string' || number !== undefined) ||
        (takeOver !== undefined && (typeof takeOver !== 'string' || takeOver === ''))
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'deck_occupy takes the id of a Session, the number of a Task or a reference to it, and the id of the Session to take it over from, if any',
            },
          ],
          isError: true,
        }
      }
      const referred = reference === undefined ? { task: number as number } : taskReference(reference)
      if (referred === undefined) {
        const answer = { ok: false, failure: { kind: 'no-reference', message: `${JSON.stringify(reference)} refers to no Task` } }
        return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
      }
      const { task, repository } = referred
      // Given by reference, the answer names the Task it read.
      const named = reference === undefined ? {} : { task }
      let answer: object
      try {
        // Read now, past the cache: a Task closed a moment ago is not occupied.
        const { source } = await readSource(true)
        const found = source.tasks.find(each => each.number === task)
        // GitHub takes a repository's owner and name in any case.
        if (repository !== undefined && repository.toLowerCase() !== source.identity.toLowerCase()) {
          const message = `#${task} of ${repository} is not a Task of the Task Source, ${source.identity}`
          answer = { ok: false, ...named, failure: { kind: 'not-open', message } }
        } else if (found === undefined || !found.isOpen) {
          const message = found === undefined ? `the Task Source has no Task #${task}` : `#${task} is closed`
          answer = { ok: false, ...named, failure: { kind: 'not-open', message } }
        } else {
          const held = occupy(homedir(), source.identity, task, session, Date.now(), takeOver)
          const holder = nameSession(held.session, held.host)
          const occupant = { occupant: held.session, occupantHost: holder.host, occupantShort: holder.short }
          answer =
            held.session === session
              ? { ok: true, ...named, occupied: true, ...occupant }
              : { ok: true, ...named, occupied: false, ...occupant, isOrphaned: held.isOrphaned }
        }
      } catch (error: any) {
        if (!(error instanceof TaskSourceError)) {
          throw error
        }
        answer = { ok: false, ...named, failure: { kind: error.kind, message: error.message } }
      }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_release: {
    description:
      'For the Pane: release the Occupancy a Session holds of a Task, this Session\'s or another\'s, so that another Session can execute it. Held by a different Session by now, the Task stays with it.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'integer', minimum: 1, description: 'The Task\'s number.' },
        session: { type: 'string', minLength: 1, description: 'The id of the Session holding the Task.' },
      },
      required: ['task', 'session'],
      additionalProperties: false,
    },
    run: async ({ task, session }: any): Promise<ToolResult> => {
      if (!Number.isInteger(task) || task < 1 || typeof session !== 'string' || session === '') {
        return {
          content: [
            { type: 'text', text: 'deck_release takes the number of a Task, a whole number from 1, and the id of the Session holding it' },
          ],
          isError: true,
        }
      }
      let answer: object
      try {
        // The Task Source's identity only: a read from the cache names it.
        const { source } = await readSource(false)
        answer = { ok: true, released: release(homedir(), source.identity, task, session) }
      } catch (error: any) {
        if (!(error instanceof TaskSourceError)) {
          throw error
        }
        answer = { ok: false, failure: { kind: error.kind, message: error.message } }
      }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_heartbeat: {
    description:
      'For the Pane: record that a Session is running, every minute or so. A Session that stops beating, or ends, leaves its Occupancies Orphaned.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', minLength: 1, description: 'The id of the Session.' } },
      required: ['session'],
      additionalProperties: false,
    },
    run: async ({ session }: any): Promise<ToolResult> => {
      if (typeof session !== 'string' || session === '') {
        return { content: [{ type: 'text', text: 'deck_heartbeat takes the id of a Session' }], isError: true }
      }
      beat(homedir(), session, Date.now(), host)

      return { content: [{ type: 'text', text: 'Recorded.' }], isError: false }
    },
  },
  deck_end_session: {
    description:
      'For the Pane: record that a Session has ended. Its Occupancies of open Tasks are Orphaned until it beats again, or the person takes them over or releases them.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', minLength: 1, description: 'The id of the Session.' } },
      required: ['session'],
      additionalProperties: false,
    },
    run: async ({ session }: any): Promise<ToolResult> => {
      if (typeof session !== 'string' || session === '') {
        return { content: [{ type: 'text', text: 'deck_end_session takes the id of a Session' }], isError: true }
      }
      endSession(homedir(), session, Date.now())

      return { content: [{ type: 'text', text: 'Recorded.' }], isError: false }
    },
  },
  deck_task: {
    description:
      'Read one Task of this project from its Task Source: its description, acceptance criteria (checked or not), assignees, labels and link; and every report of it deck_report kept.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer', minimum: 1, description: 'The Task\'s number.' } },
      required: ['number'],
      additionalProperties: false,
    },
    run: async ({ number }: any): Promise<ToolResult> => {
      if (!Number.isInteger(number) || number < 1) {
        return { content: [{ type: 'text', text: 'deck_task takes the number of a Task, a whole number from 1' }], isError: true }
      }
      let answer
      try {
        const { identity, task } = await readTask(githubIssues(workspace), number)
        answer = { ok: true, task, reports: readReports(homedir(), identity, number, nameSession) }
      } catch (error: any) {
        if (!(error instanceof TaskSourceError)) {
          throw error
        }
        answer = { ok: false, failure: { kind: error.kind, message: error.message } }
      }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_report: {
    description:
      'Report that you finished executing a Task: the result, and the Acceptance Evidence for each acceptance criterion with where it comes from (a test command and its output, a commit, a PR). Deck keeps and shows it beside the Session and the time; it does not close the Task or release it.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'integer', minimum: 1, description: 'The Task\'s number.' },
        result: { type: 'string', description: 'What you did, and how it ended.' },
        evidence: {
          type: 'array',
          description: 'The Acceptance Evidence; [] where there is none.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', minLength: 1, description: 'What shows an acceptance criterion is met.' },
              source: {
                type: 'string',
                minLength: 1,
                description: 'Where it comes from: the test command and its output, the commit, the PR.',
              },
            },
            required: ['text', 'source'],
            additionalProperties: false,
          },
        },
        session: {
          type: 'string',
          minLength: 1,
          description: 'The id of the Session reporting. Matt Deck fills it in; leave it out.',
        },
      },
      required: ['task', 'result', 'evidence'],
      additionalProperties: false,
    },
    run: async ({ task, result, evidence, session: given }: any, meta: any): Promise<ToolResult> => {
      // Codex names the Session in the call; on Claude Code the Mod passes it.
      const session = given ?? (host === 'codex' ? meta?.threadId : undefined)
      if (
        !Number.isInteger(task) ||
        task < 1 ||
        typeof result !== 'string' ||
        !Array.isArray(evidence) ||
        evidence.some(
          (each: any) =>
            typeof each !== 'object' ||
            each === null ||
            Object.keys(each).some(key => key !== 'text' && key !== 'source') ||
            typeof each.text !== 'string' ||
            each.text === '' ||
            typeof each.source !== 'string' ||
            each.source === '',
        ) ||
        typeof session !== 'string' ||
        session === ''
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'deck_report takes the number of a Task, its result as text, and its Acceptance Evidence as a list of { text, source }, each saying where it comes from; and the id of the Session reporting, which Matt Deck fills in',
            },
          ],
          isError: true,
        }
      }
      let answer: object
      try {
        // The Task Source's identity only: the last read named it, and no
        // read is needed again; a first read names it otherwise.
        const identity = knownIdentity ?? (await readSource(false)).source.identity
        saveReport(homedir(), identity, task, { session, reportedAt: Date.now(), result, evidence })
        answer = { ok: true }
      } catch (error: any) {
        if (!(error instanceof TaskSourceError)) {
          throw error
        }
        answer = { ok: false, failure: { kind: error.kind, message: error.message } }
      }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_skills: {
    description:
      'List the skills of this project\'s Skill Source: each one\'s name, how this Session calls it, its description and its file. Started for Codex, each also has copy: of the skill files Codex finds walking its own skill directories and loads (those valid UTF-8 throughout, with a frontmatter between --- lines, a description that is not blank by Rust\'s whitespace and a name of 64 characters at most; a description is taken for absent or blank only where the whole frontmatter is plain key: value lines, comments and indented lines under them, so frontmatter written otherwise counts as having one), known by their frontmatter name (read with a carriage return, U+0085 and the Unicode line and paragraph separators breaking lines too where the frontmatter so broken is blank lines of spaces, comments indented by spaces or none and unindented plain key: value lines alone, with no key twice, no key over 1024 characters, no block and no character YAML refuses, and otherwise read as before), whether the one file of this name with links resolved is this same file (same), another file is (different), more than one file is, this one among them or not, which Codex calls none of (several), or none is (missing); a name $ cannot call is missing. Reads only; no skill file is changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      // Codex finds skills in its own directories, not in the Skill Source:
      // a call the Pane prefills runs the skill only when they are the same.
      const directories = host === 'codex' ? skillDirectories(host) : undefined
      return skillAnswer(async source => ({
        source,
        skills: await listSkills(source, workspace, homedir(), callOf(host), directories),
      }))
    },
  },
  deck_skill: {
    description: 'Read one skill of this project\'s Skill Source by its name: its call, its file and the text of the file under its frontmatter. Given path, as deck_skills lists it, the skill of that name and that file, for a Skill Source holding more than one of a name; without it, the first of the name. A path holding no skill of the name is answered as a name not held.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'The skill\'s name, as deck_skills lists it.' },
        path: { type: 'string', minLength: 1, description: 'The skill\'s file, as deck_skills lists it.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async ({ name, path }: any): Promise<ToolResult> => {
      if (typeof name !== 'string' || name === '') {
        return { content: [{ type: 'text', text: 'deck_skill takes the name of a skill' }], isError: true }
      }
      if (path !== undefined && (typeof path !== 'string' || path === '')) {
        return { content: [{ type: 'text', text: 'deck_skill takes the path of a skill file, if any' }], isError: true }
      }
      return skillAnswer(async source => ({ skill: await readSkill(source, workspace, homedir(), callOf(host), name, path) }))
    },
  },
  deck_execute: {
    description:
      'For the Pane: the Execute Prompt of a Task, which the Pane prefills: the project\'s implement called on the Task, as its Skill Source calls it on this host, and the ask to report through deck_report. The Occupancy is recorded as it is sent. With no implement in the Skill Source, it answers why.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'integer', minimum: 1, description: 'The Task\'s number.' } },
      required: ['task'],
      additionalProperties: false,
    },
    run: async ({ task }: any): Promise<ToolResult> => {
      if (!Number.isInteger(task) || task < 1) {
        return { content: [{ type: 'text', text: 'deck_execute takes the number of a Task, a whole number from 1' }], isError: true }
      }
      const project = await readProjectConfig(workspace)
      if (!project.configured) {
        throw new Error('This workspace is not a Configured Project: .matt-deck/config.json does not exist')
      }
      let answer: object
      try {
        const { call } = await readSkill(project.config.skillSource, workspace, homedir(), callOf(host), IMPLEMENT)
        answer = {
          ok: true,
          prompt:
            `${call} #${task}\n\n` +
            `When you finish, call the tool deck_report for Task #${task}: what you did, ` +
            'and the Acceptance Evidence for each acceptance criterion with where it comes from.',
        }
      } catch (error: any) {
        if (!(error instanceof SkillSourceError)) {
          throw error
        }
        answer = { ok: false, failure: { kind: error.kind, message: error.message } }
      }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_ask: {
    description:
      'For the Pane: make a Recommendation Request as it is sent. Answers the request\'s id, the call of this project\'s ask-matt as this host writes it, the call without its first character as the command that runs it, and its arguments: the Task Snapshot read from the Task Source now, and the ask to report through deck_recommend; and as prompt the call followed by its arguments, which the Pane in a tab prefills.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      const project = await readProjectConfig(workspace)
      if (!project.configured) {
        throw new Error('This workspace is not a Configured Project: .matt-deck/config.json does not exist')
      }
      let answer: object
      try {
        const { call } = await readSkill(project.config.skillSource, workspace, homedir(), callOf(host), 'ask-matt')
        const list = tasksOf(await readSource(true))
        const requestId = randomUUID()
        const args = askArgs(requestId, snapshotOf(list))
        answer = { ok: true, requestId, call, command: call.slice(1), args, prompt: `${call} ${args}` }
      } catch (error: any) {
        if (!(error instanceof SkillSourceError) && !(error instanceof TaskSourceError)) {
          throw error
        }
        answer = { ok: false, failure: { kind: error.kind, message: error.message } }
      }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_recommend: {
    description:
      'Report the Recommendation for a Matt Deck Recommendation Request, as its arguments ask: what to do next, without starting it. The Pane shows it.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', minLength: 1, description: 'The id of the Recommendation Request answered.' },
        task: {
          type: ['integer', 'null'],
          minimum: 1,
          description: 'The number of the Task to do next, or null when there is none.',
        },
        nextStep: { type: 'string', description: 'The next step on it.' },
        skill: { type: 'string', description: `The skill to use, as it is called (e.g. ${callOf(host)('tdd', undefined)}); "" for none.` },
        reason: { type: 'string', description: 'Why this Task, now.' },
        blockers: { type: 'string', description: 'What stands in the way; "" for nothing.' },
      },
      required: ['requestId', 'task', 'nextStep', 'skill', 'reason', 'blockers'],
      additionalProperties: false,
    },
    run: async ({ requestId, task, nextStep, skill, reason, blockers }: any): Promise<ToolResult> => {
      const texts = [nextStep, skill, reason, blockers]
      if (
        typeof requestId !== 'string' ||
        requestId === '' ||
        !(task === null || (Number.isInteger(task) && task >= 1)) ||
        texts.some(text => typeof text !== 'string')
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'deck_recommend takes requestId, task (a Task number or null), and nextStep, skill, reason and blockers as text',
            },
          ],
          isError: true,
        }
      }
      saveRecommendation(homedir(), requestId, { task, nextStep, skill, reason, blockers }, Date.now())

      return { content: [{ type: 'text', text: 'Recorded; the Matt Deck Pane shows it.' }], isError: false }
    },
  },
  deck_recommendation: {
    description: 'For the Pane: read the Recommendation reported for a Recommendation Request, if any.',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string', minLength: 1, description: 'The id of the Recommendation Request.' } },
      required: ['requestId'],
      additionalProperties: false,
    },
    run: async ({ requestId }: any): Promise<ToolResult> => {
      if (typeof requestId !== 'string' || requestId === '') {
        return { content: [{ type: 'text', text: 'deck_recommendation takes the id of a request' }], isError: true }
      }
      const recommendation = readRecommendation(homedir(), requestId)
      const answer = recommendation === undefined ? { found: false } : { found: true, recommendation }

      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false }
    },
  },
  deck_setup_survey: {
    description:
      'For the configure skill: the host this service runs for, the existing project config, the Task Source prefilled from the Matt issue tracker doc, the Matt skills found on this machine and in the host\'s own skill directories (for Codex, each with hostCallsAskMatt and hostCallsImplement: whether $ask-matt and $implement in Codex call this copy\'s ask-matt and implement, as deck_skills judges them; those whose both it calls first, then those whose ask-matt it calls; the existing config has both too), and, for Claude Code only, whether the local settings allow the Deck service\'s tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      let result: object = { host, ...(await surveySetup(workspace, homedir(), skillDirectories(host), host === 'codex')) }
      // Codex reads no Claude Code permission rule. Local settings that
      // cannot be read allow nothing; deck_allow_service says why when it is
      // asked to write them.
      if (host === 'claude-code') {
        const allowed: unknown = (await readLocalSettings().catch(() => ({}) as Record<string, any>)).permissions?.allow
        result = { ...result, isServiceAllowed: Array.isArray(allowed) && allowed.includes(ALLOW_RULE) }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      }
    },
  },
  deck_write_config: {
    description:
      'For the configure skill: write the project config (.matt-deck/config.json) of this workspace. Of each source only its type, and its path or name, is written; any other key, such as the hostCallsAskMatt and hostCallsImplement deck_setup_survey adds, is left out. Refuses to overwrite an existing config unless replace is true.',
    inputSchema: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description:
            '{ "taskSource": { "type": "github-issues" }, "skillSource": { "type": "directory", "path": "..." } | { "type": "plugin", "name": "..." } }',
        },
        replace: { type: 'boolean', description: 'Overwrite an existing config; only after the user agreed.' },
      },
      required: ['config'],
      additionalProperties: false,
    },
    run: async ({ config, replace }: any): Promise<ToolResult> => {
      const written = await writeProjectConfig(workspace, config, replace === true)

      return {
        content: [{ type: 'text', text: JSON.stringify(written) }],
        structuredContent: written,
        isError: false,
      }
    },
  },
}

// Only Claude Code reads its permission rules.
const claudeCodeTools = {
  deck_allow_service: {
    description:
      'For the configure skill: add the permission rule allowing every tool of the Deck service to this project\'s local settings (.claude/settings.local.json), keeping what they hold. Only after the user agreed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      const settings = await readLocalSettings()
      const permissions = settings.permissions ?? {}
      const allowed = permissions.allow ?? []
      if (typeof permissions !== 'object' || Array.isArray(permissions) || !Array.isArray(allowed)) {
        throw new Error(`Not written, ${LOCAL_SETTINGS} holds its permissions in a shape no rule can be added to`)
      }
      const added = !allowed.includes(ALLOW_RULE)
      if (added) {
        const path = join(process.cwd(), LOCAL_SETTINGS)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(
          path,
          `${JSON.stringify({ ...settings, permissions: { ...permissions, allow: [...allowed, ALLOW_RULE] } }, null, 2)}\n`,
        )
      }
      const result = { path: LOCAL_SETTINGS, rule: ALLOW_RULE, added }

      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
    },
  },
}

// The Pane in a Codex tab (ADR-0006): a page this service serves, which the
// Host opens from the tab menu of a Session through a tool with a tab entry.
const PANE = { uri: 'ui://matt-deck/pane.html', name: 'pane', mimeType: 'text/html;profile=mcp-app' }

// The skill an Execute Prompt runs.
const IMPLEMENT = 'implement'

// What the hook's tool answers to any prompt: no text, so there is none for
// Codex to put in the conversation.
const SILENT: ToolResult = { content: [], isError: false }

// When this Deck service last received a call from Deck's hook while its
// project was not configured. Kept in this process alone, no local state
// being written outside a Configured Project; in Codex the Session's own
// Deck service serves both its hook and its Pane, so the Session that
// configures its project with its hook running sees no notice after.
let unconfiguredHookCallAt: number | undefined

// The tools only Codex is served: the Pane in a tab's, and the hook's.
const codexTools = {
  deck_pane: {
    title: 'Matt Deck',
    description:
      'The Matt Deck Pane, for the person to open from the tab menu of a Session; not for the agent to call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: {
      ui: { resourceUri: PANE.uri },
      'openai/ui': { entrypoints: [{ type: 'thread' }], preferredModelDisplayMode: 'fullscreen' },
    },
    run: async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'The Matt Deck Pane.' }], isError: false }),
  },
  deck_session: {
    description: 'For the Pane in a tab: name the Session this call comes from.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ['app'] } },
    // Codex names the Session in every call's _meta.threadId, the page's, the
    // agent's and a hook's alike; the page itself cannot read it.
    run: async (_args: object, meta: any): Promise<ToolResult> => {
      const session = meta?.threadId
      if (typeof session !== 'string' || session === '') {
        return {
          content: [{ type: 'text', text: 'deck_session needs the id of the Session, which Codex sends as _meta.threadId; this call has none' }],
          isError: true,
        }
      }
      const named = nameSession(session, host)
      const result = { session, sessionHost: named.host, sessionShort: named.short }

      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
    },
  },
  [CODEX_HOOK_TOOL]: {
    description:
      'For the Matt Deck hook on UserPromptSubmit, with the prompt sent; not for the agent to call. Records the Occupancy of each open Task a line of the prompt begins calling implement on, for the Session the call comes from. Answers nothing.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The prompt sent, as written.' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['app'] } },
    run: async ({ prompt }: any, meta: any): Promise<ToolResult> => {
      const session = meta?.threadId
      try {
        // Outside a Configured Project, Codex's own Sessions included, the call
        // is noted in this process alone, and the tool returns at once.
        if (!(await readProjectConfig(workspace)).configured) {
          unconfiguredHookCallAt = Math.max(unconfiguredHookCallAt ?? 0, Date.now())
          return SILENT
        }
        // The time this tool was called, which the Pane in a tab reads to
        // tell whether Deck's hook runs. The tool is for the page only, which
        // Codex hides from the model (seen of codex-cli 0.172.0, not yet of
        // the desktop app), so the time says Deck's hook called it. One that
        // fails to be written stops nothing after it.
        try {
          receiveHookCall(homedir(), Date.now())
        } catch {}
        if (typeof prompt !== 'string' || typeof session !== 'string' || session === '') {
          return SILENT
        }
        const called = implementedTasks(prompt, callOf(host)(IMPLEMENT, undefined))
        if (called.length === 0) {
          return SILENT
        }
        // The read cached last, by whichever call made it, will do while it
        // is under 15 seconds old; an older one is read again. A Task closed
        // since is released by the next read past it.
        const { source } = await readSource(false)
        for (const { task, repository } of called) {
          // GitHub takes a repository's owner and name in any case.
          const isOurs = repository === undefined || repository.toLowerCase() === source.identity.toLowerCase()
          if (isOurs && source.tasks.some(each => each.number === task && each.isOpen)) {
            // One that fails to be written stops none after it.
            try {
              occupy(homedir(), source.identity, task, session, Date.now(), undefined)
            } catch {}
          }
        }
      } catch {
        // A failure is shown nowhere: the hook's answer is no text.
      }

      return SILENT
    },
  },
  deck_hook: {
    description:
      'For the Pane in a tab: when a Deck service of this machine last received a call from Deck\'s hook on UserPromptSubmit in a Configured Project, or this Deck service did before its project was configured, as receivedAt in milliseconds since the epoch; null where none ever did. Codex runs the hook only once the person trusted it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ['app'] } },
    run: async (): Promise<ToolResult> => {
      // The later of the local state's time and this process's own.
      const times = [hookReceivedAt(homedir()), unconfiguredHookCallAt].filter(time => typeof time === 'number')
      const result = { receivedAt: times.length === 0 ? null : Math.max(...times) }

      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
    },
  },
  deck_configure: {
    description: 'For the Pane in a tab: the call of the configure skill, which the Pane prefills.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ['app'] } },
    run: async (): Promise<ToolResult> => {
      const result = { call: callOf(host)(CODEX_CONFIGURE_SKILL, undefined) }

      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
    },
  },
}

type Tool = {
  title?: string
  description: string
  inputSchema: { properties: object }
  _meta?: object
  run: (args: any, meta: unknown) => Promise<ToolResult>
}

// The tools both hosts serve that only the Pane calls. Codex hides a tool
// marked for the page only from the model, and its hooks still call it; the
// mark decides who sees a tool, and the tool answers whoever calls it. Claude
// Code's are unmarked: whether it hides them is not known, and its Mod calls
// them through this same service.
const FOR_THE_PANE = ['deck_map', 'deck_occupy', 'deck_release', 'deck_heartbeat', 'deck_end_session', 'deck_ask', 'deck_recommendation', 'deck_execute']

// Only Codex opens the Pane in a tab and runs Deck's hook; Claude Code's
// Pane is the Mod, and only Claude Code has permission rules to write.
const served: { tools: Record<string, Tool>; resources: (typeof PANE)[] } =
  host === 'codex'
    ? {
        tools: {
          ...Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => [
              name,
              FOR_THE_PANE.includes(name) ? { ...tool, _meta: { ui: { visibility: ['app'] } } } : tool,
            ]),
          ),
          ...codexTools,
        },
        resources: [PANE],
      }
    : { tools: { ...tools, ...claudeCodeTools }, resources: [] }

// The Session this Deck service beats for. In Claude Code the Mod beats; in
// Codex each Session has a Deck service of its own (ADR-0006), which beats
// for the Session the first call naming one comes from, at once and every
// minute after. Codex also starts Deck services no call ever reaches: one
// no call has named a Session to beats for none. As the Mod's, the beat is
// only in a Configured Project, where an Occupancy can be: Deck is offered
// in every project of the user, and Codex's own Sessions trigger its hooks.
const HEARTBEAT_MS = 60_000
let beating: string | undefined

// A beat that fails to be written is shown nowhere; the next one may be.
const beatOnce = (session: string) => {
  try {
    beat(homedir(), session, Date.now(), host)
  } catch {}
}

const beatFor = async (session: unknown) => {
  if (host !== 'codex' || beating !== undefined || typeof session !== 'string' || session === '') {
    return
  }
  const isConfigured = await readProjectConfig(workspace).then(
    read => read.configured,
    () => false,
  )
  // A call that came in meanwhile may have begun the beat.
  if (!isConfigured || beating !== undefined) {
    return
  }
  beating = session
  beatOnce(session)
  // The beat alone keeps no Deck service running: one whose input closes
  // exits as before, and its Session's Occupancies are Orphaned once the
  // last beat is three minutes old.
  setInterval(() => beatOnce(session), HEARTBEAT_MS).unref()
}

// Codex was seen ending Deck services by SIGTERM: those it starts for a few
// seconds, and every one as the desktop app quits. Ended so, the service
// records its Session's end, and the Session's Occupancies of open Tasks
// are Orphaned until it beats again. The service then ends by that signal,
// as it did before it recorded anything.
process.once('SIGTERM', () => {
  if (beating !== undefined) {
    try {
      endSession(homedir(), beating, Date.now())
    } catch {}
  }
  process.kill(process.pid, 'SIGTERM')
})

const handle = async (method: string, params: any): Promise<object> => {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: served.resources.length > 0 ? { tools: {}, resources: {} } : { tools: {} },
        serverInfo: { name: 'matt-deck', title: 'Matt Deck', version: '0.1.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: Object.entries(served.tools).map(([name, tool]) => ({
          name,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
        })),
      }
    case 'resources/list':
      return { resources: served.resources }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'resources/read': {
      const resource = served.resources.find(each => each.uri === params?.uri)
      if (resource === undefined) {
        throw Object.assign(new Error(`Unknown resource: ${params?.uri}`), { code: -32602 })
      }
      const text = await readFile(join(import.meta.dirname, '..', 'codex', 'pane.html'), 'utf8')

      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }] }
    }
    case 'tools/call': {
      await beatFor(params?._meta?.threadId)
      const tool = served.tools[params?.name]
      if (tool === undefined) {
        throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 })
      }
      // Only the arguments a tool declares are accepted; in particular none
      // takes a workspace path.
      const args = params?.arguments ?? {}
      const unknown = Object.keys(args).filter(key => !(key in tool.inputSchema.properties))
      if (unknown.length > 0) {
        return {
          content: [{ type: 'text', text: `${params.name} does not take: ${unknown.join(', ')}` }],
          isError: true,
        }
      }

      // A failing tool answers as a tool error the caller can show, not a
      // protocol error.
      return tool.run(args, params?._meta).catch(
        (error: Error): ToolResult => ({
          content: [{ type: 'text', text: error.message }],
          isError: true,
        }),
      )
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin }).on('line', async line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  // Notifications (no id) need no answer.
  if (message.id === undefined) {
    return
  }
  try {
    send({ id: message.id, result: await handle(message.method, message.params) })
  } catch (error: any) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } })
  }
})
