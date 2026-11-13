// The Claude Code host adapter: the Pane and its command. Everything about
// the project comes from the Deck service. The one thing judged here is which
// Tasks closed between two of this Pane's own reads, because only the Pane
// knows what it has already seen.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type {
  Ask,
  ConfigView,
  DeckAskAnswer,
  DeckConfigAnswer,
  DeckOccupyAnswer,
  DeckRecommendationAnswer,
  DeckReleaseAnswer,
  DeckSkillAnswer,
  DeckSkillsAnswer,
  DeckTaskAnswer,
  DeckTasksAnswer,
  DetailView,
  Filter,
  Nav,
  SkillsView,
  SkillTextView,
  Tab,
  TaskList,
  TasksView,
  View,
} from '../types'
import { drawPane } from './pane.tsx'

const PANE = 'matt-deck'
const TITLE = 'Matt Deck'
// Above the prompt the pane is four rows, and as tall as it may be while it
// shows a detail or the map tab.
const LIST_OPEN = { id: PANE, title: TITLE, columns: 42, rows: 4 }
const DETAIL_OPEN = { id: PANE, title: TITLE, columns: 42 }
const COMMAND = 'deck'

// How often the Pane reads the Tasks by itself. The Deck service caches a
// read for less than this, so each timed read reaches the Task Source.
const POLL_MS = 60_000

// How often the Session tells the Deck service it runs. The Deck service
// holds a Session's Occupancies Orphaned after three minutes without one.
const HEARTBEAT_MS = 60_000

// The Deck service's tools as the agent calls them: after any of them the
// Pane reads the Tasks again.
const DECK_TOOL = /^mcp__plugin_matt-deck_deck__deck_/

// The Deck service's tool the agent reports a Task executed with: the agent
// does not know the id of its Session, which the Mod gives it.
const REPORT_TOOL = 'mcp__plugin_matt-deck_deck__deck_report'

const FILTERS: Filter[] = ['all', 'ready', 'inProgress', 'blocked', 'done']

// The skill an Execute Prompt runs, called as the Skill Source calls it.
const IMPLEMENT = 'implement'

// A Task reference as the first word of /implement's arguments: `#12`, `12`,
// or a link ending in `owner/name/issues/12`, which names its repository.
const TASK_REFERENCE = /^(?:#?(\d+)|\S*?([^/\s]+\/[^/\s]+)\/issues\/(\d+))$/

const view = atom(
  { plugin: 'matt-deck', key: 'view' } as const,
  {
    sessionId: '',
    config: { status: 'loading' },
    tasks: { status: 'loading' },
    details: {},
    skills: { status: 'loading' },
    skillTexts: {},
    checkedAt: 0,
    isUnanswered: false,
  } as View,
  { shape: 'view-6' },
)

const nav = atom({ plugin: 'matt-deck', key: 'nav' } as const, { tab: 'tasks', filter: 'all', page: 0 } as Nav, {
  shape: 'nav-2',
})

const ask = atom({ plugin: 'matt-deck', key: 'ask' } as const, { isBusy: false, status: 'none' } as Ask, {
  shape: 'ask-1',
})

// How long after the end of a turn a held request is sent. The engine refuses
// a command run from the hook of a turn's end, so the request goes after it
// (sent 0.1 s on, it ran 0.2 s after the turn in the prototype).
const HELD_SEND_MS = 100

// How long a read may go unanswered before the Pane says what it may be
// waiting on.
const UNANSWERED_MS = 10_000

// Calls a tool of the Deck service to read the project config or the Tasks.
// The host puts a call no permission rule allows through the Session's
// permission hooks first, and a hook waiting for the person keeps the call
// waiting with it: the Pane is told of a call not answered after
// UNANSWERED_MS, until it answers.
const callWatched = async ($: EngineInterface, server: string, tool: string, args: Record<string, unknown>) => {
  const overdue = $.clock.after(
    UNANSWERED_MS,
    () => void update($, view, current => ({ ...current, isUnanswered: true })),
  )
  try {
    return await $.mcp.call(server, tool, args)
  } finally {
    overdue.cancel()
    await update($, view, current => (current.isUnanswered ? { ...current, isUnanswered: false } : current))
  }
}

const textOf = (answer: { content: { text?: string }[] }) => answer.content.map(block => block.text ?? '').join('\n')

// Only this Pane's current lifetime remembers its reads and announcements.
// Kept out of reactive/persisted state so a restored Session never replays
// closures. Replacing the object also retires reads still in flight.
const freshUnlocks = () => ({
  previous: undefined as TaskList | undefined,
  announced: new Set<number>(),
  started: 0,
  applied: 0,
})
let unlocks = freshUnlocks()
let isPaneOpen = false

const allTasks = (list: TaskList) => [...list.containers, ...Object.values(list.groups).flat()]

const announceClosed = async ($: EngineInterface, list: TaskList, watching: typeof unlocks, order: number) => {
  // An unasked open on a narrow terminal stays undrawn until it widens,
  // without another ui.open event. Start observing only when it is placed.
  const isPlaced = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  if (watching !== unlocks || !isPaneOpen || order <= watching.applied) {
    return
  }
  watching.applied = order
  // Undrawn before any baseline: keep waiting for the first placed read.
  if (!isPlaced && watching.previous === undefined) {
    return
  }
  const before = watching.previous
  watching.previous = list
  // A closure read while the Pane is undrawn is recorded, never announced later.
  if (before === undefined || !isPlaced) {
    return
  }
  const wasOpen = new Set(allTasks(before).filter(task => task.isOpen).map(task => task.number))
  const closed = allTasks(list)
    .filter(task => !task.isOpen && wasOpen.has(task.number) && !watching.announced.has(task.number))
    .sort((a, b) => a.number - b.number)
  if (closed.length === 0) {
    return
  }
  for (const task of closed) {
    watching.announced.add(task.number)
  }
  // A newer toast can replace this Mod's previous one: one read, one toast.
  if (closed.length > 1) {
    $.ui.toast(`◆ 成就已解锁  ${closed.map(task => `#${task.number}`).join(' ')}`)
    return
  }
  const task = closed[0]!
  const parent = list.containers.find(container => container.number === task.parent)
  const progress = parent === undefined ? '' : `  ·  ${parent.progress.closed} / ${parent.progress.total}`
  $.ui.toast(`◆ 成就已解锁  #${task.number} ${task.title}${progress}`)
}

const loadConfig = async ($: EngineInterface): Promise<ConfigView> => {
  const deck = await $.mcp.connect('deck')
  if (!deck.isConnected) {
    return { status: 'unreachable', message: deck.message }
  }
  const answer = await callWatched($, deck.server, 'deck_config', {})
  if (answer.isError) {
    return { status: 'error', message: textOf(answer) }
  }
  // The host relays the tool's result as text, not as structuredContent.
  const result: DeckConfigAnswer = JSON.parse(answer.content[0]!.text!)

  return result.configured
    ? { status: 'configured', workspace: result.workspace, config: result.config }
    : { status: 'unconfigured', workspace: result.workspace }
}

// Reads the Tasks from the Deck service; `refresh` reads past its cache. A
// failed read keeps the Tasks read before it.
const loadTasks = async ($: EngineInterface, refresh: boolean) => {
  const watching = unlocks
  const order = ++watching.started
  const deck = await $.mcp.connect('deck')
  let answer: DeckTasksAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await callWatched($, deck.server, 'deck_tasks', refresh ? { refresh: true } : {})
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }
  const checkedAt = await $.clock.now()

  await update($, view, current => {
    const before = current.tasks.status === 'loading' ? undefined : current.tasks.list
    const tasks: TasksView = answer.ok
      ? { status: 'loaded', list: answer }
      : { status: 'failed', failure: answer.failure, ...(before === undefined ? {} : { list: before }) }

    return { ...current, tasks, checkedAt }
  })
  if (answer.ok && (await $.session.id()) !== endedSession) {
    await announceClosed($, answer, watching, order)
  }
}

// Reads one Task's detail from the Deck service. A detail read before stays
// in sight until the new read answers.
const loadTask = async ($: EngineInterface, number: number) => {
  await update($, view, current =>
    current.details[number] === undefined
      ? { ...current, details: { ...current.details, [number]: { status: 'loading' } as DetailView } }
      : current,
  )
  const deck = await $.mcp.connect('deck')
  let answer: DeckTaskAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_task', { number })
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }

  const detail: DetailView = answer.ok
    ? { status: 'loaded', task: answer.task, reports: answer.reports }
    : { status: 'failed', failure: answer.failure }
  await update($, view, current => ({ ...current, details: { ...current.details, [number]: detail } }))
}

// Reads the skills of the Skill Source from the Deck service.
const loadSkills = async ($: EngineInterface) => {
  const deck = await $.mcp.connect('deck')
  let answer: DeckSkillsAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_skills', {})
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }
  const skills: SkillsView = answer.ok
    ? { status: 'loaded', skills: answer.skills }
    : { status: 'failed', failure: answer.failure }
  await update($, view, current => ({ ...current, skills }))
}

// Reads one skill's text from the Deck service. A text read before stays in
// sight until the new read answers.
const loadSkillText = async ($: EngineInterface, name: string) => {
  await update($, view, current =>
    current.skillTexts[name] === undefined
      ? { ...current, skillTexts: { ...current.skillTexts, [name]: { status: 'loading' } as SkillTextView } }
      : current,
  )
  const deck = await $.mcp.connect('deck')
  let answer: DeckSkillAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_skill', { name })
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }
  const text: SkillTextView = answer.ok
    ? { status: 'loaded', skill: answer.skill }
    : { status: 'failed', failure: answer.failure }
  await update($, view, current => ({ ...current, skillTexts: { ...current.skillTexts, [name]: text } }))
}

// Puts `text` in the prompt box for the person to send. A draft there is
// never overwritten: the person is told instead. Where the host cannot fill
// the box, the text goes on the clipboard.
const prefill = async ($: EngineInterface, text: string, surface: RenderSurface, key = 'e') => {
  if ((await $.prompt.read()).text.trim() !== '') {
    $.ui.toast(`输入框里已有草稿，没有覆盖。清空后再按 ${key}：${text}`)
    return
  }
  if ((await $.prompt.fill({ text: `${text} ` })).isFilled) {
    return
  }
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `不能预填输入框，已复制到剪贴板：${text}` : `不能预填输入框，也没能复制：${text}`)
}

// The call of the Skill Source's /implement, as last read, if it holds one.
const implementCall = async ($: EngineInterface) => {
  const { skills } = await read($, view)

  return skills.status === 'loaded' ? skills.skills.find(skill => skill.name === IMPLEMENT)?.call : undefined
}

// Puts the Execute Prompt of the Task `number` in the prompt box: the Skill
// Source's /implement on the Task, and the ask to report the result and its
// Acceptance Evidence through deck_report.
const executeTask = async ($: EngineInterface, number: number, surface: RenderSurface) => {
  const call = await implementCall($)
  if (call === undefined) {
    $.ui.toast(`Skill Source 里没有 ${IMPLEMENT} 技能，不能预填执行 #${number}。`)
    return
  }
  const text =
    `${call} #${number}\n\n` +
    `When you finish, call the tool deck_report for Task #${number}: what you did, ` +
    'and the Acceptance Evidence for each acceptance criterion with where it comes from.'
  await prefill($, text, surface)
}

// Adapted from the reference project's specComplete template, pinned by
// Spec #1 at 5d90182 (config/prompts/map-advancement.yaml). Here the output
// is a check for the user to decide on, never a request to close the Spec.
const closeoutSpec = async ($: EngineInterface, number: number, surface: RenderSurface) => {
  const { tasks } = await read($, view)
  const spec = tasks.status === 'loading' ? undefined : tasks.list?.containers.find(task => task.number === number)
  if (spec?.isPendingCloseout !== true) {
    $.ui.toast(`#${number} 当前不处于待收尾核对状态。`)
    return
  }
  const text =
    `请对当前项目的 Spec #${number} 做收尾核对。Pane 显示 Child Task 已全部关闭` +
    `（${spec.progress.closed}/${spec.progress.total}），这只是触发条件，不是完成或验收通过的证据。\n\n` +
    '先重新读取 Spec 及其全部 Child Task 的正文、评论和当前状态。对照 Spec 的每条用户故事与验收条件，' +
    '逐条核对 Child Task 的交付、最终代码、测试或运行结果，并列出可复核的 Acceptance Evidence 及出处；' +
    '不要只依赖关闭状态或任务自述。说明改动所在的分支、提交或工作区及仓库检查结果，' +
    '区分已验证、未验证和不满足的条目。以“不做”或“重复”关闭的 Child Task，说明原承诺如何满足以及是否有用户确认。\n\n' +
    '在本 Session 中说明核对结论、剩余缺口、对应的 Spec 条目和建议下一步。' +
    '本次只核对并报告，不关闭 Spec，也不自动重开或修改任何 Task；是否关闭 Spec 由用户决定。'
  await prefill($, text, surface, 'k')
}

// Takes the Task `number` over from the Session `from`, as the person
// confirmed, and puts its Execute Prompt in the prompt box. Where the prompt
// could not follow, no /implement to call or a draft in the box, the
// Occupancy stays where it is; so does one a third Session holds by now.
const takeOverTask = async ($: EngineInterface, number: number, from: string, surface: RenderSurface) => {
  if ((await implementCall($)) === undefined) {
    $.ui.toast(`Skill Source 里没有 ${IMPLEMENT} 技能，没有接管 #${number}。`)
    return
  }
  if ((await $.prompt.read()).text.trim() !== '') {
    $.ui.toast(`输入框里已有草稿，没有接管 #${number}。清空后再接管。`)
    return
  }
  const deck = await $.mcp.connect('deck')
  let answer: DeckOccupyAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_occupy', {
      session: (await read($, view)).sessionId,
      task: number,
      takeOver: from,
    })
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }
  if (!answer.ok) {
    $.ui.toast(`#${number} 没有接管：${answer.failure.message}`)
  } else if (!answer.occupied) {
    $.ui.toast(`#${number} 已改由 Session ${answer.occupant.slice(0, 8)} 执行，没有接管。`)
  } else {
    await executeTask($, number, surface)
  }
  await loadTasks($, false)
}

// Releases the Occupancy `session` holds of the Task `number`, this
// Session's or an Orphaned one's, so that another Session can take it. One
// that passed to another Session since stays.
const releaseTask = async ($: EngineInterface, number: number, session: string) => {
  const deck = await $.mcp.connect('deck')
  let answer: DeckReleaseAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_release', { task: number, session })
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }
  if (!answer.ok) {
    $.ui.toast(`#${number} 的 Occupancy 没有释放：${answer.failure.message}`)
  } else if (!answer.released) {
    $.ui.toast(`#${number} 的 Occupancy 已转给别的 Session，没有释放。`)
  }
  await loadTasks($, false)
}

// Records this Session's Occupancy of the Task `number`, as a prompt
// executing it is sent, and shows it. `repository` is the one a link to the
// Task named: the Deck service occupies nothing in a repository that is not
// the Task Source's. A Task another Session holds stays with it: the person
// is told.
const occupyTask = async ($: EngineInterface, number: number, repository: string | undefined) => {
  const deck = await $.mcp.connect('deck')
  let answer: DeckOccupyAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_occupy', {
      session: (await read($, view)).sessionId,
      task: number,
      repository,
    })
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }
  if (!answer.ok) {
    $.ui.toast(`#${number} 没有登记 Occupancy：${answer.failure.message}`)
  } else if (!answer.occupied) {
    $.ui.toast(`#${number} 正由 Session ${answer.occupant.slice(0, 8)} 执行，本 Session 没有登记 Occupancy。`)
  }
  await loadTasks($, false)
}

// Sends the Recommendation Request the Pane marked as sent: the Deck service
// makes it now, with the Task Snapshot as it is now, and the Session runs it.
// A turn begun while it was being made holds it again, to be made anew.
const sendRequest = async ($: EngineInterface) => {
  const deck = await $.mcp.connect('deck')
  let answer: DeckAskAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_ask', {})
    answer = result.isError
      ? { ok: false, failure: { kind: 'failed', message: textOf(result) } }
      : JSON.parse(result.content[0]!.text!)
  }
  const notSent = async (message: string) => {
    await update($, ask, current => ({ ...current, status: 'none' as const }))
    $.ui.toast(`“我现在该做什么”没有发出：${message}`)
  }
  if (!answer.ok) {
    await notSent(answer.failure.message)
    return
  }
  const { requestId, command, args } = answer
  const now = await update($, ask, current =>
    current.isBusy ? { ...current, status: 'held' as const, wasHeld: true } : { ...current, requestId },
  )
  if (now.status === 'held') {
    return
  }
  try {
    await $.command.run({ command, args })
  } catch (error) {
    await notSent(String(error))
  }
}

// The press of n: a request, unless one is held, sent or running. While the
// Session is busy the Pane holds it, rather than the host queueing it.
const askNow = async ($: EngineInterface) => {
  let isNew = false
  const after = await update($, ask, current => {
    // `update` runs this again when another write got in first: a second
    // press then finds the first one's request, and is not a new one.
    isNew = current.status !== 'held' && current.status !== 'sent' && current.status !== 'running'
    if (!isNew) {
      return current
    }

    return {
      isBusy: current.isBusy,
      status: current.isBusy ? ('held' as const) : ('sent' as const),
      wasHeld: current.isBusy,
    }
  })
  if (isNew && after.status === 'sent') {
    await sendRequest($)
  }
}

// The end of the request's turn: the Recommendation the agent reported for
// it, or else the turn's answer.
const answerRequest = async ($: EngineInterface, requestId: string, text: string) => {
  const deck = await $.mcp.connect('deck')
  let answer: DeckRecommendationAnswer = { found: false }
  if (deck.isConnected) {
    const result = await $.mcp.call(deck.server, 'deck_recommendation', { requestId })
    if (!result.isError) {
      answer = JSON.parse(result.content[0]!.text!)
    }
  }
  await update($, ask, current =>
    current.requestId === requestId
      ? {
          ...current,
          status: 'answered' as const,
          answer: answer.found ? { recommendation: answer.recommendation } : { text },
        }
      : current,
  )
}

const isConfigured = async ($: EngineInterface) => (await read($, view)).config.status === 'configured'

// The Session's heartbeat, from the start of a Session in a Configured
// Project; kept here, not in the Session's state, which a /clear starts
// over. Each beat names the Session's id as it is then, but never
// `endedSession`, the id the Session last ended under: a beat would hold its
// Occupancies again. A beat asks that last, once the Deck service is
// connected: one that waited for it while the Session ended is not sent
// after the end.
let heartbeat: { cancel: () => void } | undefined
let endedSession: string | undefined
const startHeartbeat = ($: EngineInterface) => {
  heartbeat?.cancel()
  const beat = () =>
    void (async () => {
      const session = await $.session.id()
      const deck = await $.mcp.connect('deck')
      if (deck.isConnected && session !== endedSession) {
        await $.mcp.call(deck.server, 'deck_heartbeat', { session })
      }
    })()
  $.clock.after(0, beat)
  heartbeat = $.clock.every(HEARTBEAT_MS, beat)
}

// The Session whose project config is being read, and the timer of the timed
// reads; kept here, not in the Session's state, which a /clear starts over.
let reading: string | undefined
let poll: { cancel: () => void } | undefined

// Reads the project config for the Session `sessionId`, then, in a Configured
// Project, the Tasks and the skills, off the caller so it does not wait on
// gh. The timed reads start once and go on across a /clear. At the start of
// a Session the Pane opens where a project config exists, a malformed one to
// say why, before the Tasks are read: the first read is the baseline of the
// unlocks.
const readSession = async ($: EngineInterface, sessionId: string, isStart = false) => {
  unlocks = freshUnlocks()
  reading = sessionId
  try {
    const config = await loadConfig($)
    await update($, view, current => ({ ...current, sessionId, config }))
    if (isStart && (config.status === 'configured' || config.status === 'error')) {
      await $.ui.open(LIST_OPEN)
      // The engine does not pass this Mod's own open through its ui.open.
      isPaneOpen = true
    }
    if (config.status === 'configured') {
      $.clock.after(0, () => void loadTasks($, false))
      $.clock.after(0, () => void loadSkills($))
      poll ??= $.clock.every(POLL_MS, () => void loadTasks($, false))
      if (isStart) {
        startHeartbeat($)
      }
    }
  } finally {
    reading = undefined
  }
}

// After a /clear or a resume the process goes on under another id, with no
// session.start, and its state starts over, the id and the state each at a
// moment of their own: the project config and the Tasks are read again
// wherever the state names another Session than the one running, and not
// while a read is under way.
const ensureSession = async ($: EngineInterface) => {
  const sessionId = await $.session.id()
  if (reading === sessionId) {
    return
  }
  const { sessionId: shown } = await read($, view)
  if (reading === sessionId || shown === sessionId) {
    return
  }
  await readSession($, sessionId)
}

export const register: Register = on => {
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const opened = await next(e)
    if (opened.value !== undefined) {
      if (!isPaneOpen) {
        unlocks = freshUnlocks()
      }
      isPaneOpen = true
    }

    return opened
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (closed.deny === undefined) {
      isPaneOpen = false
      unlocks = freshUnlocks()
    }

    return closed
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: '打开或关闭 Matt Deck 的 Pane' })

    // Read off the event: a permission hook waiting for the person keeps the
    // read waiting with it, and the Session's prompts wait on this event.
    const sessionId = await $.session.id()
    $.clock.after(0, () => void readSession($, sessionId, true))

    return started
  })

  // A turn of this Session's main loop: the Session is busy, and the turn of
  // a request sent is the one whose prompt carries the request.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      $.clock.after(0, () => void ensureSession($))
      await update($, ask, current =>
        current.status === 'sent' && current.requestId !== undefined && e.text.includes(current.requestId)
          ? { ...current, isBusy: true, status: 'running' as const, turnId: e.turnId }
          : { ...current, isBusy: true },
      )
    }

    return next(e)
  })

  // The end of a turn of this Session's main loop: the Session is idle, the
  // request's turn has its answer, and a held request goes. The turn, and
  // every call of a Deck tool, may also have changed the Tasks a moment ago:
  // they are read again, off the event and past the Deck service's cache.
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) {
      return completed
    }
    const ended = await update($, ask, current => ({ ...current, isBusy: false }))
    if (ended.status === 'running' && ended.turnId === e.turnId) {
      $.clock.after(0, () => void answerRequest($, ended.requestId!, e.answer))
    }
    if (ended.status === 'held') {
      $.clock.after(HELD_SEND_MS, () =>
        void (async () => {
          let isSent = false
          await update($, ask, current => {
            // As in `askNow`: run again, this may find the request cancelled.
            isSent = current.status === 'held' && !current.isBusy

            return isSent ? { ...current, status: 'sent' as const } : current
          })
          if (isSent) {
            await sendRequest($)
          }
        })(),
      )
    }
    if (await isConfigured($)) {
      $.clock.after(0, () => void loadTasks($, true))
    }

    return completed
  })

  // A prompt sent that runs /implement on a Task starts executing it: the
  // Execute Prompt, or the same typed by hand. The Occupancy is recorded
  // once the prompt has entered, never for one stopped on the way. The
  // first prompt after a /clear is sent before its turn starts, so the state
  // may still be the one started over: the project config and the skills
  // are read for the Session running before /implement is looked up.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop !== undefined || e.command === undefined) {
      return entered
    }
    const reference = (e.command.args.trim().split(/\s+/)[0] ?? '').match(TASK_REFERENCE)
    if (reference !== null) {
      const sent = `/${e.command.name}`
      $.clock.after(
        0,
        () =>
          void (async () => {
            const sessionId = await $.session.id()
            if ((await read($, view)).sessionId !== sessionId) {
              await readSession($, sessionId)
            }
            const { config, skills } = await read($, view)
            if (config.status === 'configured' && skills.status === 'loading') {
              await loadSkills($)
            }
            if ((await implementCall($)) === sent) {
              await occupyTask($, Number(reference[1] ?? reference[3]), reference[2])
            }
          })(),
      )
    }

    return entered
  })

  // The Session ends: no beat names it from here on, said before anything
  // waits, as the heartbeat may be due while the Deck service is told. Told,
  // the Deck service holds its Occupancies Orphaned; not heard, once its
  // last heartbeat is too old. A /clear ends the conversation the held
  // request was for: it is dropped. After a /clear or a resume the process
  // goes on under another id, with no session.start: the heartbeat starts
  // again, under that one.
  on('session.end', async ($, e, next) => {
    endedSession = e.sessionId
    unlocks = freshUnlocks()
    if (e.reason === 'clear') {
      await update($, ask, current => (current.status === 'held' ? { ...current, status: 'none' as const } : current))
    }
    if (heartbeat !== undefined) {
      const deck = await $.mcp.connect('deck')
      if (deck.isConnected) {
        await $.mcp.call(deck.server, 'deck_end_session', { session: e.sessionId })
      }
    }
    const ended = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      if (heartbeat !== undefined) {
        startHeartbeat($)
      }
      $.clock.after(0, () => void ensureSession($))
    }

    return ended
  })

  // A report names the Session that made it: this one, under its id as it is
  // now, whatever the agent gave. A Task whose detail was read shows it at
  // once: its detail is read again, off the event.
  on('tool.call', { tool: REPORT_TOOL }, async ($, e, next) => {
    const called = await next({ ...e, session: await $.session.id() })
    if ((await read($, view)).details[e.task as number] !== undefined) {
      $.clock.after(0, () => void loadTask($, e.task as number))
    }

    return called
  })

  on('tool.call', { tool: DECK_TOOL }, async ($, e, next) => {
    const called = await next(e)
    if (await isConfigured($)) {
      $.clock.after(0, () => void loadTasks($, true))
    }

    return called
  })

  on('command.run', { command: COMMAND }, async $ => {
    // The Pane appears only where a project config exists: elsewhere the
    // command answers in text. After a /clear it is read first.
    await ensureSession($)
    const { config } = await read($, view)
    if (config.status === 'unconfigured') {
      return {
        text: `Matt Deck 未配置：${config.workspace}/.matt-deck/config.json 不存在。运行 /matt-deck:configure 配置之后新开一个 Session，Pane 会自动出现。`,
      }
    }
    if (config.status === 'unreachable') {
      return { text: `Matt Deck 不可用，Deck 服务未连接：${config.message}` }
    }

    // A pane opened unasked on a narrow terminal is open but undrawn: the
    // command draws it rather than closing it.
    const isDrawn = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if (isDrawn) {
      await $.ui.close({ id: PANE })

      return { text: 'Matt Deck 已关闭。' }
    }
    const opened = await $.ui.open(LIST_OPEN)

    return { text: opened.isPlaced ? 'Matt Deck 已打开。' : `Matt Deck 暂未显示：${opened.reason}` }
  })

  // The action bar is about the row the focus is on; it keeps the last row
  // while the focus is elsewhere.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny === undefined && (e.element?.startsWith('task:') || e.element?.startsWith('skill:'))) {
      await update($, nav, current => ({ ...current, focus: e.element }))
    }

    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // A drawing may not write the state: the check goes after it.
    $.clock.after(0, () => void ensureSession($))
    const isInline = e.props.placement === 'inline'
    const moveFocus = async (key: string | undefined) => {
      if (key !== undefined) {
        await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
      }
    }
    // Leaving a detail for the list: above the prompt the pane goes back to
    // four rows, unless the list is the map tab's, and the focus back onto
    // the row it was on.
    const toList = async (tab: Tab, focus: string | undefined) => {
      if (isInline && tab !== 'map') {
        await $.ui.open(LIST_OPEN)
      }
      await moveFocus(focus)
    }
    // Back onto the row of the tasks tab's or the Map View's list the focus
    // was on; in a detail onto the way back, and on the Recommendation onto
    // executing it.
    const backToRow = async (at: Nav) => {
      await moveFocus(at.detail?.from === at.tab ? 'back' : at.tab === 'next' ? 'execute' : at.focus)
    }
    const showTab = async (tab: Tab) => {
      const before = await read($, nav)
      // A tab left from a detail, or from the list to switch the Map View,
      // shows its list when it is shown again.
      const left = await update($, nav, current => ({
        ...current,
        tab,
        detail: undefined,
        skill: undefined,
        switching: false,
        mapPage: 0,
        isAnswerShown: false,
        takeover: undefined,
      }))
      // Above the prompt the map tab is as tall as a detail.
      const wasTall =
        before.detail !== undefined || before.skill !== undefined || before.tab === 'map' || before.isAnswerShown === true
      if (isInline && wasTall !== (tab === 'map')) {
        await $.ui.open(tab === 'map' ? DETAIL_OPEN : LIST_OPEN)
      }
      if ((before.detail !== undefined && tab === before.detail.from) || (before.skill !== undefined && tab === 'skills')) {
        await moveFocus(left.focus)
      }
    }

    return drawPane($.ui.resolve(e), e.props, await read($, view), await read($, nav), await read($, ask), {
      // A new request leaves the whole answer shown before it.
      ask: () =>
        void (async () => {
          if ((await read($, nav)).isAnswerShown === true) {
            await update($, nav, current => ({ ...current, isAnswerShown: false }))
            await $.ui.open(LIST_OPEN)
          }
          await askNow($)
        })(),
      cancelAsk: () =>
        void update($, ask, current => (current.status === 'held' ? { ...current, status: 'cancelled' as const } : current)),
      // Above the prompt: the whole answer grows the pane, and b gives back
      // the four rows.
      showAnswer: isShown =>
        void (async () => {
          await update($, nav, current => ({ ...current, isAnswerShown: isShown }))
          await $.ui.open(isShown ? DETAIL_OPEN : LIST_OPEN)
        })(),
      refresh: () => {
        void loadTasks($, true)
        void loadSkills($)
      },
      showTab: tab => void showTab(tab),
      // Drills into a Task: from the list's row, which the focus goes back
      // to, or on from the detail shown.
      openTask: number =>
        void (async () => {
          await update($, nav, current => ({
            ...current,
            ...(current.detail === undefined ? { focus: `task:${number}` } : {}),
            detail: { from: current.detail?.from ?? current.tab, path: [...(current.detail?.path ?? []), number] },
          }))
          if (isInline) {
            await $.ui.open(DETAIL_OPEN)
          }
          await loadTask($, number)
        })(),
      // One step back: to the Task drilled through before, or to the list.
      back: () =>
        void (async () => {
          const after = await update($, nav, current => {
            const path = current.detail?.path.slice(0, -1) ?? []

            return { ...current, takeover: undefined, detail: path.length === 0 ? undefined : { from: current.detail!.from, path } }
          })
          if (after.detail === undefined) {
            await toList(after.tab, after.focus)
          }
        })(),
      // Drills into a skill's text from its row, which the focus goes back to.
      openSkill: name =>
        void (async () => {
          await update($, nav, current => ({ ...current, focus: `skill:${name}`, skill: name }))
          if (isInline) {
            await $.ui.open(DETAIL_OPEN)
          }
          await loadSkillText($, name)
        })(),
      closeSkill: () =>
        void (async () => {
          const after = await update($, nav, current => ({ ...current, skill: undefined }))
          await toList('skills', after.focus)
        })(),
      prefill: text => void prefill($, text, e.surface),
      execute: number => void executeTask($, number, e.surface),
      closeout: number => void closeoutSpec($, number, e.surface),
      // Asking to take over, the focus goes onto cancelling, so that enter
      // does not take it over; once it is answered, back onto the list's row.
      askTakeOver: number =>
        void (async () => {
          await update($, nav, current => ({ ...current, takeover: number }))
          await moveFocus('takeover:cancel')
        })(),
      takeOver: (number, from) =>
        void (async () => {
          const after = await update($, nav, current => ({ ...current, takeover: undefined }))
          await takeOverTask($, number, from, e.surface)
          await backToRow(after)
        })(),
      cancelTakeOver: () =>
        void (async () => {
          await backToRow(await update($, nav, current => ({ ...current, takeover: undefined })))
        })(),
      release: (number, session) => void releaseTask($, number, session),
      cycleFilter: () =>
        void update($, nav, current => ({
          ...current,
          filter: FILTERS[(FILTERS.indexOf(current.filter) + 1) % FILTERS.length]!,
          page: 0,
        })),
      showGroup: group => void update($, nav, current => ({ ...current, filter: group, page: 0 })),
      // The engine leaves the focus on the page button; it is moved onto a
      // row of the new page, which the Mod's own `ui.focus` hook does not see,
      // so the action bar is told here. A focus that cannot be moved leaves
      // the page turned all the same.
      turnPage: (page, key) =>
        void (async () => {
          await update($, nav, current => ({
            ...current,
            ...(current.tab === 'map' ? { mapPage: page } : current.tab === 'skills' ? { skillsPage: page } : { page }),
            ...(key === undefined || key.startsWith('switch:') ? {} : { focus: key }),
          }))
          await moveFocus(key)
        })(),
      showMap: number =>
        void (async () => {
          const before = await read($, nav)
          await update($, nav, current => ({
            ...current,
            tab: 'map' as const,
            map: number,
            switching: false,
            mapPage: 0,
            detail: undefined,
          }))
          if (isInline && before.tab !== 'map') {
            await $.ui.open(DETAIL_OPEN)
          }
        })(),
      // The focus goes onto the Spec or Map shown, and back onto the node it
      // was on.
      openSwitch: current =>
        void (async () => {
          await update($, nav, now => ({ ...now, switching: true, mapPage: 0 }))
          await moveFocus(`switch:${current}`)
        })(),
      closeSwitch: () =>
        void (async () => {
          const after = await update($, nav, current => ({ ...current, switching: false, mapPage: 0 }))
          await moveFocus(after.focus)
        })(),
    })
  })
}
