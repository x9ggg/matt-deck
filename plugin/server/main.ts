// The Deck service: an MCP server over stdio that exposes the task kernel as
// `deck_*` tools. The host starts it on demand; its Workspace comes from the
// working directory it was started in (ADR-0005), never from a path passed by
// a caller.
// Runs on plain Node with no installed packages, so MCP is spoken by hand.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { readProjectConfig, writeProjectConfig } from '../kernel/config.ts'
import { beat, endSession, occupy, release, settleOccupancies } from '../kernel/occupancy.ts'
import { askArgs, readRecommendation, saveRecommendation, snapshotOf } from '../kernel/recommend.ts'
import { evidencedTasks, readReports, saveReport } from '../kernel/reports.ts'
import { surveySetup } from '../kernel/setup.ts'
import { listSkills, readSkill, SkillSourceError } from '../kernel/skills.ts'
import { githubIssues, listTasks, readTask, TaskSourceError } from '../kernel/tasks.ts'
import type { ProjectConfig } from '../kernel/config.ts'
import type { SourceRead, TaskListFailure } from '../kernel/tasks.ts'

// The Workspace is the checkout the service was started in: the nearest
// directory at or above the working directory that holds `.git`. Outside a
// repository it is the working directory itself.
let workspace = process.cwd()
for (let dir = workspace; ; dir = dirname(dir)) {
  if (existsSync(join(dir, '.git'))) {
    workspace = dir
    break
  }
  if (dir === dirname(dir)) {
    break
  }
}

// The last read of the Task Source, answered again for this long to a read
// that does not ask for a fresh one. A read that fails empties it: the read
// after it reaches the Task Source again instead of answering with what was
// read before the failure. Occupancy is not cached: every answer has it as
// the local state holds it then, whichever Session recorded it.
const TASKS_CACHE_MS = 15_000
let cachedRead: { source: SourceRead; fetchedAt: number } | undefined

// The Task Source as read last, or read now when `refresh` asks for it or
// the cache is too old. Throws a TaskSourceError.
const readSource = async (refresh: boolean) => {
  const now = Date.now()
  if (refresh || cachedRead === undefined || now - cachedRead.fetchedAt >= TASKS_CACHE_MS) {
    cachedRead = undefined
    cachedRead = { source: await githubIssues(workspace).read(), fetchedAt: now }
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
  deck_occupy: {
    description:
      'For the Pane: record that a Session executes a Task, as the prompt starting it is sent. A Task held by another Session stays with it unless takeOver names that Session; the answer names the Session holding it.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', minLength: 1, description: 'The id of the Session executing the Task.' },
        task: { type: 'integer', minimum: 1, description: 'The Task\'s number.' },
        repository: {
          type: 'string',
          description: 'The repository a link to the Task named, as owner/name, when the Task was referred to by a link.',
        },
        takeOver: {
          type: 'string',
          minLength: 1,
          description:
            'The id of the Session to move the Task\'s Occupancy from, to this one; only after the person confirmed taking it over from that Session. Held by a third Session by now, the Task stays with it.',
        },
      },
      required: ['session', 'task'],
      additionalProperties: false,
    },
    run: async ({ session, task, repository, takeOver }: any): Promise<ToolResult> => {
      if (
        typeof session !== 'string' ||
        session === '' ||
        !Number.isInteger(task) ||
        task < 1 ||
        (repository !== undefined && typeof repository !== 'string') ||
        (takeOver !== undefined && (typeof takeOver !== 'string' || takeOver === ''))
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'deck_occupy takes the id of a Session, the number of a Task, the repository a link to it named, if any, and the id of the Session to take it over from, if any',
            },
          ],
          isError: true,
        }
      }
      let answer: object
      try {
        // Read now, past the cache: a Task closed a moment ago is not occupied.
        const { source } = await readSource(true)
        const found = source.tasks.find(each => each.number === task)
        // GitHub takes a repository's owner and name in any case.
        if (repository !== undefined && repository.toLowerCase() !== source.identity.toLowerCase()) {
          const message = `#${task} of ${repository} is not a Task of the Task Source, ${source.identity}`
          answer = { ok: false, failure: { kind: 'not-open', message } }
        } else if (found === undefined || !found.isOpen) {
          const message = found === undefined ? `the Task Source has no Task #${task}` : `#${task} is closed`
          answer = { ok: false, failure: { kind: 'not-open', message } }
        } else {
          const occupant = occupy(homedir(), source.identity, task, session, Date.now(), takeOver)
          answer = { ok: true, occupied: occupant === session, occupant }
        }
      } catch (error: any) {
        if (!(error instanceof TaskSourceError)) {
          throw error
        }
        answer = { ok: false, failure: { kind: error.kind, message: error.message } }
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
      beat(homedir(), session, Date.now())

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
        answer = { ok: true, task, reports: readReports(homedir(), identity, number) }
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
          description: 'The id of the Session reporting. The Matt Deck Pane fills it in; leave it out.',
        },
      },
      required: ['task', 'result', 'evidence'],
      additionalProperties: false,
    },
    run: async ({ task, result, evidence, session }: any): Promise<ToolResult> => {
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
              text: 'deck_report takes the number of a Task, its result as text, and its Acceptance Evidence as a list of { text, source }, each saying where it comes from; and the id of the Session reporting, which the Matt Deck Pane fills in',
            },
          ],
          isError: true,
        }
      }
      let answer: object
      try {
        // The Task Source's identity only: a read from the cache names it.
        const { source } = await readSource(false)
        saveReport(homedir(), source.identity, task, { session, reportedAt: Date.now(), result, evidence })
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
      'List the skills of this project\'s Skill Source: each one\'s name, how this Session calls it, its description and its file. Reads only; no skill file is changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      return skillAnswer(async source => ({ source, skills: await listSkills(source, workspace, homedir()) }))
    },
  },
  deck_skill: {
    description: 'Read one skill of this project\'s Skill Source by its name: its call, its file and the text of the file under its frontmatter.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, description: 'The skill\'s name, as deck_skills lists it.' } },
      required: ['name'],
      additionalProperties: false,
    },
    run: async ({ name }: any): Promise<ToolResult> => {
      if (typeof name !== 'string' || name === '') {
        return { content: [{ type: 'text', text: 'deck_skill takes the name of a skill' }], isError: true }
      }
      return skillAnswer(async source => ({ skill: await readSkill(source, workspace, homedir(), name) }))
    },
  },
  deck_ask: {
    description:
      'For the Pane: make a Recommendation Request as it is sent. Answers the request\'s id, the command that runs this project\'s /ask-matt, and its arguments: the Task Snapshot read from the Task Source now, and the ask to report through deck_recommend.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      const project = await readProjectConfig(workspace)
      if (!project.configured) {
        throw new Error('This workspace is not a Configured Project: .matt-deck/config.json does not exist')
      }
      let answer: object
      try {
        const { call } = await readSkill(project.config.skillSource, workspace, homedir(), 'ask-matt')
        const list = tasksOf(await readSource(true))
        const requestId = randomUUID()
        answer = { ok: true, requestId, command: call.slice(1), args: askArgs(requestId, snapshotOf(list)) }
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
        skill: { type: 'string', description: 'The skill to use, as it is called (e.g. /tdd); "" for none.' },
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
      'For the configure skill: the existing project config, the Task Source prefilled from the Matt issue tracker doc, the Matt skills found on this machine, and whether the local settings allow the Deck service\'s tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      // Local settings that cannot be read allow nothing; deck_allow_service
      // says why when it is asked to write them.
      const allowed: unknown = (await readLocalSettings().catch(() => ({}) as Record<string, any>)).permissions?.allow
      const result = {
        ...(await surveySetup(workspace, homedir())),
        isServiceAllowed: Array.isArray(allowed) && allowed.includes(ALLOW_RULE),
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
      'For the configure skill: write the project config (.matt-deck/config.json) of this workspace. Refuses to overwrite an existing config unless replace is true.',
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

const handle = async (method: string, params: any): Promise<object> => {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'matt-deck', version: '0.1.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: Object.entries(tools).map(([name, { description, inputSchema }]) => ({
          name,
          description,
          inputSchema,
        })),
      }
    case 'tools/call': {
      const tool = tools[params?.name as keyof typeof tools]
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
      return tool.run(args).catch(
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
