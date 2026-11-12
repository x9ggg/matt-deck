// The Mod under the engine's test kit. The hooks registered on `on` stand for
// the engine beneath the Mod: the Deck service (`mcp.*`), panes, the clock,
// turns, tool calls and the session.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = 'matt-deck'
const SERVER = 'plugin:matt-deck:deck'
const WORKSPACE = '/work/shop'

const CONFIGURED = {
  configured: true,
  workspace: WORKSPACE,
  config: {
    taskSource: { type: 'github-issues' },
    skillSource: { type: 'plugin', name: 'mattpocock-skills' },
  },
}

type Answer = { structuredContent?: unknown; isError: boolean; text?: string }

// A Task as `deck_tasks` lists it. Unless told otherwise it declares a
// Blocking Edge to each of its blockers and to nothing else.
const task = (number: number, title: string, more: { blockers?: number[]; [field: string]: unknown } = {}) => ({
  number,
  title,
  isOpen: true,
  labels: [] as string[],
  parent: null as number | null,
  blockers: [] as number[],
  blockedBy: more.blockers ?? ([] as number[]),
  closedAt: null as string | null,
  ...more,
})

const spec = (number: number, title: string, children: number[], progress: object, more: object = {}) => ({
  ...task(number, title),
  kind: 'spec',
  group: 'ready',
  children,
  progress,
  ...more,
})

// 12:00 on 2026-11-12, when the tests read the Task Source.
const NOW = Date.UTC(2026, 10, 12, 12, 0)

const tasks = (lists: { containers?: object[]; ready?: object[]; blocked?: object[]; done?: object[] }) => ({
  isError: false,
  structuredContent: {
    ok: true,
    fetchedAt: NOW,
    containers: lists.containers ?? [],
    groups: { ready: lists.ready ?? [], inProgress: [], blocked: lists.blocked ?? [], done: lists.done ?? [] },
  },
})

// The project of the examples in `docs/pane-layout.md`, cut short.
const PROJECT = tasks({
  containers: [
    spec(1, '规格：里程碑一，Claude Code 上的 Matt Deck 闭环', [2, 3, 5, 7], { closed: 1, inProgress: 0, total: 4 }),
    spec(30, '已经关闭的规格', [], { closed: 0, inProgress: 0, total: 0 }, { isOpen: false }),
  ],
  ready: [task(3, 'Pane 布局设计', { labels: ['ready-for-human'], parent: 1 })],
  blocked: [
    task(5, '任务列表：按分组展示 Task', { labels: ['ready-for-agent'], parent: 1, blockers: [3] }),
    task(7, 'Map View', { labels: ['ready-for-agent'], parent: 1, blockers: [3, 5] }),
  ],
  done: [
    task(15, '配置技能', { isOpen: false, labels: ['ready-for-agent'], closedAt: '2026-11-11T14:07:00Z' }),
    task(2, '骨架：Configured Project 里出现 Pane', { isOpen: false, parent: 1, closedAt: '2026-11-11T05:40:00Z' }),
  ],
})

// A Task as `deck_task` reads it, after the examples in `docs/pane-layout.md`.
const DETAILS: Record<number, object> = {
  7: {
    number: 7,
    title: 'Map View',
    isOpen: true,
    closedAt: null,
    updatedAt: '2026-11-11T09:00:00Z',
    labels: ['ready-for-agent'],
    assignees: [],
    url: 'https://github.com/acme/shop/issues/7',
    description: '在 Pane 里展示一个 Spec 的 Child Task 和它们的阻塞关系。',
    acceptance: [
      { text: '树按 Blocking Edge 缩进', isChecked: true },
      { text: '可以从树钻进 Task 详情', isChecked: false },
    ],
  },
  15: {
    number: 15,
    title: '配置技能',
    isOpen: false,
    closedAt: '2026-11-11T14:07:00Z',
    updatedAt: '2026-11-11T14:07:00Z',
    labels: ['ready-for-agent'],
    assignees: ['octocat'],
    url: 'https://github.com/acme/shop/issues/15',
    description: '首次配置一个项目。',
    acceptance: [],
  },
}

const detailOf = (number: number): Answer => ({
  isError: false,
  structuredContent: {
    ok: true,
    task: DETAILS[number] ?? {
      number,
      title: `Task ${number}`,
      isOpen: true,
      closedAt: null,
      updatedAt: '2026-11-11T09:00:00Z',
      labels: [],
      assignees: [],
      url: `https://github.com/acme/shop/issues/${number}`,
      description: '',
      acceptance: [],
    },
  },
})

// The skills of the examples in `docs/pane-layout.md`, in a directory Skill
// Source.
const SKILL = (name: string, description: string) => ({
  name,
  call: `/${name}`,
  description,
  path: `~/.claude/skills/${name}/SKILL.md`,
})
const SKILLS: Answer = {
  isError: false,
  structuredContent: {
    ok: true,
    source: { type: 'directory', path: '~/.claude/skills' },
    skills: [
      SKILL('implement', '开始做一个 Task。'),
      SKILL('ask-matt', '问下一步该做什么。'),
      SKILL('tdd', '先写测试，再写实现。'),
      SKILL('wayfinder', '为不清晰的大工作建立 Map。'),
    ],
  },
}
const DIRECTORY = {
  ...CONFIGURED,
  config: { ...CONFIGURED.config, skillSource: { type: 'directory', path: '~/.claude/skills' } },
}

// A skill as `deck_skill` reads it, from what `deck_skills` lists.
const skillTextOf = (skills: Answer, name: string): Answer => ({
  isError: false,
  structuredContent: {
    ok: true,
    skill: {
      ...(skills.structuredContent as { skills: { name: string }[] }).skills.find(skill => skill.name === name),
      text: `# ${name}\n\n原文。\n`,
    },
  },
})

// What `deck_ask` answers for the `count`th Recommendation Request.
const asked = (count: number): Answer => ({
  isError: false,
  structuredContent: {
    ok: true,
    requestId: `request-${count}`,
    command: 'mattpocock-skills:ask-matt',
    args: `Matt Deck Recommendation Request request-${count}. 快照 ${count}`,
  },
})

// The Recommendation of the examples in `docs/pane-layout.md`, as
// `deck_recommendation` reads it.
const RECOMMENDED: Answer = {
  isError: false,
  structuredContent: {
    found: true,
    recommendation: {
      task: 3,
      nextStep: '先画停靠在侧边的线框图，再画输入框上方的。',
      skill: '/prototype',
      reason: '它挡着 #5、#7、#8，放开 10 个 Task。',
      blockers: '',
    },
  },
}

// A turn of the main loop starting with `text`, and ending with `answer`.
const turnStart = ($: Engine, turnId: string, text = '你好') => $.turn.start({ text, turnId })
const turnEnd = ($: Engine, turnId: string, answer = '') =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' })

// A fake engine: the Deck service answering `deck_config` with `config`, or
// out of reach when there is none, and `deck_tasks` with what `tasks` gives
// at each call; a clock that moves only when the test moves it; and a pane
// list kept the way the engine keeps it. On a narrow terminal the first,
// unasked open leaves the pane open but undrawn. Returns what the Mod did.
const engine = (
  on: On,
  {
    config,
    tasks = () => PROJECT,
    detail = number => detailOf(number),
    isNarrow = false,
    skills = () => SKILLS,
    skillText = name => skillTextOf(skills(), name),
    draft = '',
    canFill = true,
    waitFor = () => undefined,
    ask = asked,
    recommendation = () => ({ isError: false, structuredContent: { found: false } }),
  }: {
    config: Answer | undefined
    tasks?: () => Answer
    detail?: (number: number) => Answer
    isNarrow?: boolean
    skills?: () => Answer
    skillText?: (name: string) => Answer
    // What the prompt box holds, and whether the host lets it be filled.
    draft?: string
    canFill?: boolean
    // What a call of a tool waits on before it answers, as a call does that
    // a permission hook keeps waiting.
    waitFor?: (tool: string) => Promise<void> | undefined
    // What `deck_ask` answers at its `count`th call, and `deck_recommendation`
    // for a request.
    ask?: (count: number) => Answer
    recommendation?: (requestId: string) => Answer
  },
) => {
  const seen = {
    opened: [] as string[],
    // The rows each open asked for, `undefined` where it asked for none.
    openedRows: [] as (number | undefined)[],
    closed: [] as string[],
    calls: [] as { server: string; tool: string; args?: Record<string, unknown> }[],
    clock: undefined as unknown as MockClock,
    filled: [] as { text: string; mode: string }[],
    copied: [] as string[],
    toasts: [] as string[],
    // The commands the Mod ran, as the person typing them.
    ran: [] as { command: string; args: string }[],
  }
  let asks = 0
  let panes: { id: string; isPlaced: boolean }[] = []

  seen.clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'a1b2c3d4-session' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('mcp.connect', () => ({
    value:
      config === undefined
        ? { isConnected: false, reason: 'failed', message: 'The deck server failed to start.' }
        : { isConnected: true, server: SERVER },
  }))
  on('mcp.call', async (_, e) => {
    seen.calls.push(e)
    await waitFor(e.tool)
    const answer =
      e.tool === 'deck_tasks'
        ? tasks()
        : e.tool === 'deck_task'
          ? detail(e.args!.number as number)
          : e.tool === 'deck_skills'
            ? skills()
            : e.tool === 'deck_skill'
              ? skillText(e.args!.name as string)
              : e.tool === 'deck_ask'
                ? ask(++asks)
                : e.tool === 'deck_recommendation'
                  ? recommendation(e.args!.requestId as string)
                  : config!

    return {
      value: {
        // As the host relays it: the result as text, no structuredContent.
        content: [{ type: 'text', text: answer.text ?? JSON.stringify(answer.structuredContent) }],
        isError: answer.isError,
      },
    }
  })
  on('ui.open', (_, e) => {
    const isPlaced = !(isNarrow && seen.opened.length === 0)
    seen.opened.push(e.id)
    seen.openedRows.push(e.rows)
    panes = [...panes.filter(pane => pane.id !== e.id), { id: e.id, isPlaced }]

    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: 'narrow' } }
  })
  on('ui.close', (_, e) => {
    seen.closed.push(e.id)
    panes = panes.filter(pane => pane.id !== e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: panes.map(({ id, isPlaced }) => ({ id, title: id, isShown: isPlaced, isFocused: false, isPlaced })),
  }))
  on('ui.focus', () => ({}))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', (_, e) => {
    if (!canFill) {
      return { isFilled: false, refusal: 'no_composer' }
    }
    seen.filled.push({ text: e.text, mode: e.mode })

    return { isFilled: true }
  })
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', (_, e) => {
    seen.ran.push({ command: e.command, args: e.args })

    return { text: '' }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  return seen
}

const PANE_TARGET = {
  plugin: 'matt-deck',
  component: 'Pane',
  requestId: PANE,
  props: {
    title: 'Matt Deck',
    isFocused: false,
    bodyColumns: 42,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const INLINE = {
  ...PANE_TARGET,
  props: { ...PANE_TARGET.props, bodyColumns: 96, placement: 'inline', scroll: { offset: 0, bodyRows: 15 } },
} as const

// The person typing `/deck` in a terminal too narrow for an unasked pane.
const DECK_COMMAND = {
  command: 'deck',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const start = ($: Engine) => $.session.start({ cwd: WORKSPACE, surface: 'terminal', isInteractive: true })

// The person moving the focus onto an element of the pane.
const focus = ($: Engine, element: string) =>
  $.ui.focus({ component: 'Pane', requestId: PANE, plugin: 'matt-deck', element, origin: { kind: 'person' } })

// The text of every element of a type, in document order.
const texts = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }, type = 'Text') =>
  (await ui.findAll({ type })).map(found => found.text)

test('in a Configured Project the pane opens and its top shows the project and the Session', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })

  await start($)

  expect(seen.calls[0]).toEqual({ server: SERVER, tool: 'deck_config', args: {} })
  expect(seen.opened).toEqual([PANE])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE_TARGET, surface })
    expect(await ui.find({ type: 'Text', text: /shop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a1b2c3d4/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '本 Session 没有在执行 Task' })).toBeDefined()
    await ui.unmount()
  }
})

test('without a project config the pane stays closed and reads no Task', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: { configured: false, workspace: WORKSPACE }, isError: false } })

  await start($)

  expect(seen.opened).toEqual([])
  expect(seen.calls.map(call => call.tool)).toEqual(['deck_config'])
})

test('a malformed config opens the pane with the reason', async ($, on) => {
  engine(on, { config: { isError: true, text: '.matt-deck/config.json is malformed: bad' } })

  await start($)

  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /config\.json is malformed/ })).toBeDefined()
  await ui.unmount()
})

// What a call waits on until the test lets it go.
const gate = () => {
  let release = () => {}
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })

  return { waiting, release }
}

const UNANSWERED = ['Deck 服务还没应答，可能在等权限批准。', '运行 /matt-deck:configure 允许它的工具。']

test('a read of the project config not answered after ten seconds says what it may be waiting on and how to allow it', async ($, on) => {
  const { waiting, release } = gate()
  const seen = engine(on, {
    config: { structuredContent: CONFIGURED, isError: false },
    waitFor: tool => (tool === 'deck_config' ? waiting : undefined),
  })
  const starting = start($)
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await seen.clock.advance(9_000)
  expect(await texts(ui)).toEqual(['正在读取项目配置…'])

  await seen.clock.advance(1_000)
  expect(await texts(ui)).toEqual(UNANSWERED)

  release()
  await starting
  await seen.clock.settle()
  const lines = await texts(ui)
  expect(lines).toContain('shop')
  expect(lines).not.toContain(UNANSWERED[0])
  await ui.unmount()
})

test('a read of the Tasks not answered after ten seconds says the same in place of the notice, in both placements', async ($, on) => {
  const { waiting, release } = gate()
  const seen = engine(on, {
    config: { structuredContent: CONFIGURED, isError: false },
    waitFor: tool => (tool === 'deck_tasks' ? waiting : undefined),
  })
  await start($)
  const docked = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await seen.clock.advance(9_000)
  expect(await texts(docked)).toContain('正在读取 Task…')

  await seen.clock.advance(1_000)
  await docked.unmount()
  for (const target of [PANE_TARGET, INLINE]) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    const lines = await texts(ui)
    expect(lines.slice(lines.indexOf(UNANSWERED[0]!))).toEqual(UNANSWERED)
    expect(lines).not.toContain('正在读取 Task…')
    await ui.unmount()
  }

  release()
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  expect(await texts(ui)).not.toContain(UNANSWERED[0])
  expect(await ui.find({ type: 'Text', text: /Pane 布局设计/ })).toBeDefined()
  await ui.unmount()
})

test('the deck command closes an open pane and opens a closed one', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)

  await $.command.run(DECK_COMMAND)
  expect(seen.closed).toEqual([PANE])

  await $.command.run(DECK_COMMAND)
  expect(seen.opened).toEqual([PANE, PANE])
})

test('without a project config the deck command opens no pane and points at the configure skill', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: { configured: false, workspace: WORKSPACE }, isError: false } })
  await start($)

  const answer = await $.command.run(DECK_COMMAND)

  expect(seen.opened).toEqual([])
  expect(answer.text).toMatch(/未配置/)
  expect(answer.text).toContain('/work/shop/.matt-deck/config.json')
  expect(answer.text).toContain('/matt-deck:configure')
})

test('with the Deck service out of reach the pane stays closed and the deck command says why', async ($, on) => {
  const seen = engine(on, { config: undefined })
  await start($)

  const answer = await $.command.run(DECK_COMMAND)

  expect(seen.opened).toEqual([])
  expect(answer.text).toContain('The deck server failed to start.')
})

test('the deck command draws a pane a narrow terminal left undrawn in a Configured Project', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, isNarrow: true })
  await start($)

  await $.command.run(DECK_COMMAND)

  expect(seen.closed).toEqual([])
  expect(seen.opened).toEqual([PANE, PANE])
})

test('the tasks tab lists open Specs and Maps first, then the Tasks by group', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE_TARGET, surface })

    expect(await texts(ui, 'Button')).toEqual([
      '刷新',
      '下一步',
      '任务',
      '地图',
      '技能',
      '全部 5  ◇ 1  ▶ 0  □ 2  ◆ 2',
      // The action bar's action.
      '详情',
      '◇ Spec #1 规格：里程碑一，Claude Code… 1/4',
      '◇ #3  Pane 布局设计                 可执行',
      '□ #5  任务列表：按分组展示 Task 被 #3 阻塞',
      '□ #7  Map View               被 #3 #5 阻塞',
      // Closing times are drawn in the local time zone.
      expect.stringMatching(/^◆ #15 配置技能                 11-1[12] \d\d:\d\d$/),
      expect.stringMatching(/^◆ #2  骨架：Configured Projec… 11-1[01] \d\d:\d\d$/),
    ])
    // The group titles with their counts; an empty group is left out.
    const lines = await texts(ui)
    expect(lines).toContain('可执行 1')
    expect(lines).toContain('阻塞 2')
    expect(lines).toContain('已完成 2')
    expect(lines.some(line => line.startsWith('进行中'))).toBe(false)
    // The closed Spec is not listed.
    expect(lines.some(line => line.includes('已经关闭的规格'))).toBe(false)
    // The focus lands on the first ready Task, and the action bar shows it.
    expect((await ui.find({ key: 'task:3' }))?.props.autoFocus).toBe(true)
    expect(lines).toContain('#3  ready-for-human')
    // A blocked row is dimmed whole.
    expect((await ui.find({ key: 'task:5' }))?.children).toEqual(
      Array(4).fill(expect.objectContaining({ props: expect.objectContaining({ dimColor: true }) })),
    )
    await ui.unmount()
  }
})

test('the action bar follows the focus from row to row and keeps the last row', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await focus($, 'task:5')
  expect(await texts(ui)).toContain('#5  ready-for-agent')

  // On a Spec the bar counts its Child Tasks by group, then its action.
  await focus($, 'task:1')
  expect((await ui.find({ type: 'Box', text: /^#1  / }))?.text).toBe('#1  ◇ 1  ▶ 0  □ 2  ◆ 1地图  详情')

  // Off the rows (onto a tab) the bar stays where it was.
  await focus($, 'tab:map')
  expect((await ui.find({ type: 'Box', text: /^#1  / }))?.text).toBe('#1  ◇ 1  ▶ 0  □ 2  ◆ 1地图  详情')
  await ui.unmount()
})

test('the filter goes through all and the four groups, writing every count', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  const rows = async () => (await texts(ui, 'Button')).filter(text => /^[◇▶□◆◈▲◐] /.test(text))

  await ui.press({ key: 'filter' })
  expect(await rows()).toEqual(['◇ #3  Pane 布局设计                 可执行'])
  // One group alone has no title.
  expect(await texts(ui)).not.toContain('可执行 1')

  await ui.press({ key: 'filter' })
  expect(await rows()).toEqual([])
  expect(await texts(ui)).toContain('没有进行中的 Task。')

  await ui.press({ key: 'filter' })
  expect((await rows()).map(row => row.slice(0, 4))).toEqual(['□ #5', '□ #7'])

  await ui.press({ key: 'filter' })
  expect((await rows()).map(row => row.slice(0, 5))).toEqual(['◆ #15', '◆ #2 '])

  await ui.press({ key: 'filter' })
  // The Spec and the five Tasks.
  expect((await rows()).length).toBe(6)
  // Specs and Maps are not counted.
  expect((await ui.find({ key: 'filter' }))?.text).toBe('全部 5  ◇ 1  ▶ 0  □ 2  ◆ 2')
  await ui.unmount()
})

// A project with `count` blocked Tasks, #101 on.
const manyBlocked = (count: number) =>
  tasks({
    ready: [task(3, 'Pane 布局设计')],
    blocked: Array.from({ length: count }, (_, index) =>
      task(101 + index, `被阻塞的 Task ${index + 1}`, { blockers: [3] }),
    ),
  })

test('a group of more than five rows shows five and opens on the row under them', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => manyBlocked(7) })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  expect((await ui.findAll({ type: 'Button', text: /^□ / })).length).toBe(5)
  expect((await ui.find({ key: 'more:blocked' }))?.text).toBe('  还有 2 个')

  await ui.press({ key: 'more:blocked' })

  expect((await ui.findAll({ type: 'Button', text: /^□ / })).length).toBe(7)
  expect((await ui.find({ key: 'filter' }))?.text).toBe('全部 8  ◇ 1  ▶ 0  □ 7  ◆ 0')
  expect((await ui.find({ key: 'more:blocked' }))).toBeUndefined()
  await ui.unmount()
})

test('a list taller than the pane turns pages, keeping the top and the tabs, and moves the focus', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => manyBlocked(11) })
  await start($)
  await seen.clock.settle()
  // Four rows fit under the fixed seven, with one for the way back and one
  // for the way on.
  const ui = await $.ui.mount({
    ...PANE_TARGET,
    props: { ...PANE_TARGET.props, scroll: { offset: 0, bodyRows: 13 } },
    surface: 'terminal',
  })
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  const rows = async () => (await ui.findAll({ type: 'Button', text: /^□ / })).map(row => row.key)

  expect(await rows()).toEqual(['task:101', 'task:102', 'task:103', 'task:104', 'task:105'])
  expect((await ui.find({ key: 'page:next' }))?.text).toBe('  还有 6 个')
  expect(await ui.find({ key: 'page:prev' })).toBeUndefined()

  await ui.press({ key: 'page:next' })

  expect(await rows()).toEqual(['task:106', 'task:107', 'task:108', 'task:109'])
  expect((await ui.find({ key: 'page:prev' }))?.text).toBe('  前面还有 5 个')
  expect((await ui.find({ key: 'page:next' }))?.text).toBe('  还有 2 个')
  // The focus is moved onto the new page's first row, and the action bar
  // with it. (The test kit does not answer the Mod's own `$.ui.focus`, so
  // the move itself is checked in a real Pane: see the layout doc.)
  expect(await texts(ui)).toContain('#106 ')
  // The top and the tabs are still drawn.
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await ui.find({ key: 'tab:tasks' })).toBeDefined()

  await ui.press({ key: 'page:next' })
  expect(await rows()).toEqual(['task:110', 'task:111'])
  expect(await ui.find({ key: 'page:next' })).toBeUndefined()

  // Back, the focus lands on the last row of the page before.
  await ui.press({ key: 'page:prev' })
  expect(await texts(ui)).toContain('#109 ')
  await ui.unmount()
})

test('the pane reads the Tasks again on its timer, after a turn, after a deck tool, and on r', async ($, on) => {
  let answer = PROJECT
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => answer })
  await start($)
  await seen.clock.settle()
  const reads = () => seen.calls.filter(call => call.tool === 'deck_tasks').map(call => call.args)
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  expect(reads()).toEqual([{}])

  // A Task changed on GitHub shows at the next timed read.
  answer = tasks({ done: [task(3, 'Pane 布局设计', { isOpen: false, closedAt: '2026-11-12T12:00:00Z' })] })
  await seen.clock.advance(59_000)
  expect(await ui.find({ type: 'Button', text: /^◆ #3 / })).toBeUndefined()
  await seen.clock.advance(1_000)
  expect(reads()).toEqual([{}, {}])
  expect(await ui.find({ type: 'Button', text: /^◆ #3 / })).toBeDefined()

  // The end of one of this Session's turns: the turn may have changed the
  // Tasks a moment ago, so the read goes past the Deck service's cache.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, { refresh: true }])
  // A subagent's turn is not this Session's.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, { refresh: true }])

  // A deck tool the agent called, past the cache as well; another tool is
  // not one.
  await $.tool.call({ tool: 'mcp__plugin_matt-deck_deck__deck_config' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, { refresh: true }, { refresh: true }])
  await $.tool.call({ tool: 'mcp__github__issue_read' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, { refresh: true }, { refresh: true }])

  // r reads past the Deck service's cache.
  await ui.press({ key: 'refresh' })
  expect(reads()).toEqual([{}, {}, { refresh: true }, { refresh: true }, { refresh: true }])
  await ui.unmount()
})

test('the top says how fresh the Tasks are', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  expect(await texts(ui)).toContain('刚刚')

  // The Deck service answers from what it read at NOW.
  await seen.clock.advance(3 * 60_000)
  expect(await texts(ui)).toContain('3 分钟前')
  expect((await ui.find({ type: 'Text', text: '3 分钟前' }))?.props.color).toBe('inactive')

  await seen.clock.advance(8 * 60_000)
  expect((await ui.find({ type: 'Text', text: '11 分钟前' }))?.props.color).toBe('warning')
  await ui.unmount()
})

const failed = (kind: string, message = '') => ({
  isError: false,
  structuredContent: { ok: false, failure: { kind, message } },
})

const FAILURES = [
  { answer: failed('unauthenticated', 'To get started with GitHub CLI, please run:  gh auth login'), says: 'gh 未登录。运行 gh auth login 后按 r 重试。' },
  { answer: failed('offline', 'error connecting to api.github.com'), says: '连不上 GitHub。检查网络后按 r 重试。' },
  { answer: failed('gh-missing'), says: '找不到 gh 命令。安装 GitHub CLI 后按 r 重试。' },
  { answer: { isError: true, text: 'boom' }, says: 'gh 出错：boom。按 r 重试。' },
]
for (const { answer, says } of FAILURES) {
  test(`a Task Source that cannot be read says why, not an empty list: ${says}`, async ($, on) => {
    const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => answer })
    await start($)
    await seen.clock.settle()

    for (const target of [PANE_TARGET, INLINE]) {
      const ui = await $.ui.mount({ ...target, surface: 'terminal' })
      const lines = await texts(ui)
      expect(lines).toContain('✕ 读取 Task 失败')
      // Docked, the reason is broken at spaces into rows of the box's width.
      expect(lines.join(' ')).toContain(says)
      expect(lines).toContain('读取失败')
      expect(lines).not.toContain('Task Source 里还没有 Task。')
      await ui.unmount()
    }
  })
}

test('a failed read keeps the list read before it, under the reason', async ($, on) => {
  let answer: Answer = PROJECT
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => answer })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  answer = failed('offline', 'error connecting to api.github.com')
  await ui.press({ key: 'refresh' })

  expect(await texts(ui)).toContain('连不上 GitHub。检查网络后按 r 重试。')
  expect(await ui.find({ type: 'Button', text: /^◇ #3 / })).toBeDefined()
  await ui.unmount()
})

test('the reason of a failed read takes its rows from the list under it, which turns pages sooner', async ($, on) => {
  let answer: Answer = manyBlocked(11)
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => answer })
  await start($)
  await seen.clock.settle()
  // Thirteen rows under the fixed seven: the eleven blocked Tasks fit.
  const ui = await $.ui.mount({
    ...PANE_TARGET,
    props: { ...PANE_TARGET.props, scroll: { offset: 0, bodyRows: 20 } },
    surface: 'terminal',
  })
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  const rows = async () => (await ui.findAll({ type: 'Button', text: /^□ / })).length
  expect(await rows()).toBe(11)
  expect(await ui.find({ key: 'page:next' })).toBeUndefined()

  // The reason is two rows in a box 40 columns wide inside, five with its
  // title and border: eight are left, one of them for the way on.
  answer = failed('unauthenticated')
  await ui.press({ key: 'refresh' })

  const lines = await texts(ui)
  expect(lines).toContain('gh 未登录。运行 gh auth login 后按 r')
  expect(lines).toContain('重试。')
  expect(await rows()).toBe(7)
  expect((await ui.find({ key: 'page:next' }))?.text).toBe('  还有 4 个')
  await ui.unmount()
})

test('above the prompt a failed read leaves the first row without counts, even with a list read before', async ($, on) => {
  let answer: Answer = PROJECT
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => answer })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })

  answer = failed('offline', 'error connecting to api.github.com')
  await ui.press({ key: 'refresh' })

  expect(await texts(ui, 'Box')).toContain('shop · a1b2c3d4读取失败  刷新')
  await ui.unmount()
})

test('above the prompt the pane is four rows while the Tasks are being read', async ($, on) => {
  engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })

  // Under the top and the tabs: the notice, then a blank row.
  const lines = await texts(ui)
  expect(lines.slice(lines.indexOf('正在读取 Task…'))).toEqual(['正在读取 Task…', ' '])
  await ui.unmount()
})

test('above the prompt the action bar names a Spec once, then its progress and its Child Tasks by group', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })

  await focus($, 'task:1')

  expect(await texts(ui, 'Box')).toContain(
    '◇ Spec #1 规格：里程碑一，Claude Code 上的 Matt De…   1/4   ◇ 1  ▶ 0  □ 2  ◆ 1',
  )
  await ui.unmount()
})

test('a Task Source with no Task says so, apart from a failed read', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => tasks({}) })
  await start($)
  await seen.clock.settle()

  for (const target of [PANE_TARGET, INLINE]) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    const lines = await texts(ui)
    expect(lines).toContain('Task Source 里还没有 Task。')
    expect(lines).toContain('在 Session 里用 Matt skills 建立。')
    expect(lines).not.toContain('✕ 读取 Task 失败')
    expect(lines).toContain('刚刚')
    expect((await ui.find({ key: 'filter' }))?.text).toBe(target === INLINE ? '全部 0' : '全部 0  ◇ 0  ▶ 0  □ 0  ◆ 0')
    await ui.unmount()
  }
})

const inline = (bodyColumns: number) => ({ ...INLINE, props: { ...INLINE.props, bodyColumns } })

test('above the prompt the pane is four rows: top with counts, tabs, action bar, the list in one row', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...inline(96), surface: 'terminal' })
  const boxes = await texts(ui, 'Box')

  expect(boxes).toContain('shop · a1b2c3d4   ◇ 1 可执行  ▶ 0 进行中  □ 2 阻塞  ◆ 2/5刚刚  刷新')
  // The tabs, and at their right end the primary button, in every tab.
  expect(boxes).toContain('下一步  任务  地图  技能我现在该做什么 n')
  expect(boxes).toContain('◇ #3  Pane 布局设计   可执行   ready-for-human')
  // The list's row: Specs and Maps first, then the groups in order, as many
  // as fit, and the chosen filter at its end.
  const items = (await ui.findAll({ type: 'Button' })).map(button => button.text)
  expect(items.slice(5)).toEqual(['我现在该做什么', '详情', '◇ Spec #1 1/4', '◇ #3 Pane 布局设计', '□ #5 任务列表：按分组展示 Task', '还有 3 个', '全部 5'])
  await ui.unmount()

  // Narrower, the top gives up the words after the counts, then the Session
  // and the freshness.
  const narrow = await $.ui.mount({ ...inline(60), surface: 'terminal' })
  expect(await texts(narrow, 'Box')).toContain('shop · a1b2c3d4   ◇ 1  ▶ 0  □ 2  ◆ 2/5刚刚  刷新')
  await narrow.unmount()
  const narrower = await $.ui.mount({ ...inline(40), surface: 'terminal' })
  expect(await texts(narrower, 'Box')).toContain('shop   ◇ 1  ▶ 0  □ 2  ◆ 2/5  刷新')
  await narrower.unmount()
})

test('above the prompt the list row turns pages by width', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...inline(60), surface: 'terminal' })
  const keys = async () =>
    (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('task:'))

  expect(await keys()).toEqual(['task:1', 'task:3'])
  expect((await ui.find({ key: 'page:next' }))?.text).toBe('还有 4 个')

  await ui.press({ key: 'page:next' })

  expect((await ui.find({ key: 'page:prev' }))?.text).toBe('前面 2 个')
  expect(await keys()).toEqual(['task:5'])
  // The action bar is on the new page's first row, its title cut to fit.
  expect(await texts(ui, 'Box')).toContain('□ #5  任务列表：按…   被 #3 阻塞   ready-for-agent')

  await ui.press({ key: 'page:prev' })
  expect(await keys()).toEqual(['task:1', 'task:3'])
  await ui.unmount()
})

test('the tabs switch the content under the top, which stays', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'tab:next' })
  expect(await ui.find({ key: 'filter' })).toBeUndefined()
  expect((await ui.find({ key: 'tab:next' }))?.children).toEqual([
    expect.objectContaining({ props: expect.objectContaining({ bold: true, underline: true }) }),
  ])
  expect(await ui.find({ key: 'refresh' })).toBeDefined()

  await ui.press({ key: 'tab:skills' })
  expect(await texts(ui)).toContain('Skill Source  插件 mattpocock-skills')

  await ui.press({ key: 'tab:tasks' })
  expect(await ui.find({ key: 'filter' })).toBeDefined()
  await ui.unmount()
})

test('a Task opened from its row shows its status, description, acceptance criteria and blockers', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'task:7' })
  await seen.clock.settle()

  expect(seen.calls.at(-1)).toEqual({ server: SERVER, tool: 'deck_task', args: { number: 7 } })
  // The list gives way to the detail; the top and the tabs stay.
  expect(await ui.find({ key: 'filter' })).toBeUndefined()
  expect(await ui.find({ key: 'tab:tasks' })).toBeDefined()
  const boxes = await texts(ui, 'Box')
  expect(boxes).toContain('返回  任务 / #1 / #7')
  expect(boxes).toContain('#7 Map View')
  expect(boxes).toContain('□ 被 #3 #5 阻塞')
  expect(await texts(ui)).toContain('ready-for-agent · 未指派 · 更新 11-11')
  // The title is bold, its number in the colour of its status.
  expect((await ui.find({ type: 'Text', text: 'Map View' }))?.props.bold).toBe(true)
  expect((await ui.find({ key: 'parent:1' }))?.text).toBe('属于 Spec #1 规格：里程碑一，Claude Code …')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('在 Pane 里展示一个 Spec 的 Child Task 和它们的阻塞关系。')
  expect(boxes).toContain('[x] 树按 Blocking Edge 缩进')
  expect(boxes).toContain('[ ] 可以从树钻进 Task 详情')
  expect(await texts(ui)).toContain('被阻塞 2')
  expect((await ui.find({ key: 'blocker:3' }))?.text).toBe('◇ #3  Pane 布局设计')
  expect((await ui.find({ key: 'blocker:5' }))?.text).toBe('□ #5  任务列表：按分组展示 Task')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/acme/shop/issues/7')
  await ui.unmount()
})

test('from a detail b goes back one step at a time, to the row it came from, with the filter kept', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  await focus($, 'task:7')

  // o drills into the row the action bar is about.
  await ui.press({ key: 'open' })
  await seen.clock.settle()
  expect(await texts(ui, 'Box')).toContain('返回  任务 / #1 / #7')

  // On into a blocker, and on into the one blocking that.
  await ui.press({ key: 'blocker:5' })
  await seen.clock.settle()
  expect(await texts(ui, 'Box')).toContain('返回  任务 / #1 / #7 / #5')
  expect(await texts(ui, 'Box')).toContain('#5 Task 5')
  await ui.press({ key: 'blocker:3' })
  await seen.clock.settle()
  expect(await texts(ui, 'Box')).toContain('返回  任务 / #1 / #7 / #5 / #3')

  await ui.press({ key: 'back' })
  expect(await texts(ui, 'Box')).toContain('返回  任务 / #1 / #7 / #5')
  await ui.press({ key: 'back' })
  expect(await texts(ui, 'Box')).toContain('返回  任务 / #1 / #7')
  await ui.press({ key: 'back' })

  // The list, still filtered to the blocked group, the action bar on the row.
  expect((await ui.findAll({ type: 'Button', text: /^□ #/ })).map(row => row.key)).toEqual(['task:5', 'task:7'])
  expect(await texts(ui)).toContain('#7  ready-for-agent')
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  await ui.unmount()
})

test('a tab left from a detail shows its list when it is shown again', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'task:3' })
  await seen.clock.settle()
  await ui.press({ key: 'tab:skills' })
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(await texts(ui)).toContain('Skill Source  插件 mattpocock-skills')
  await ui.press({ key: 'tab:tasks' })

  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(await ui.find({ key: 'filter' })).toBeDefined()
  await ui.unmount()
})

test('a closed Task with no acceptance criteria shows when it was closed and says it has none', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'task:15' })
  await seen.clock.settle()

  const lines = await texts(ui)
  expect(await texts(ui, 'Box')).toContain('◆ 已解锁')
  // Closing times are drawn in the local time zone.
  expect(lines).toContainEqual(expect.stringMatching(/^ready-for-agent · octocat · 11-1[12] \d\d:\d\d$/))
  expect(lines).toContain('正文里没有验收条件。')
  // Nothing blocks it, and it belongs to nothing.
  expect(lines.some(line => line.startsWith('被阻塞'))).toBe(false)
  expect(await ui.find({ type: 'Button', text: /^属于/ })).toBeUndefined()
  await ui.unmount()
})

test('above the prompt a detail grows the pane under the top and the tabs, and b gives back the four rows', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  await focus($, 'task:7')

  await ui.press({ key: 'open' })
  await seen.clock.settle()

  expect(seen.openedRows).toEqual([4, undefined])
  expect(await texts(ui, 'Box')).toContain('下一步  任务  地图  技能')
  expect(await texts(ui, 'Box')).toContain('返回  任务 / #1 / #7')
  expect(await texts(ui, 'Box')).toContain('#7 Map View')

  await ui.press({ key: 'back' })
  expect(seen.openedRows).toEqual([4, undefined, 4])
  expect(await texts(ui, 'Box')).toContain('□ #7  Map View   被 #3 #5 阻塞   ready-for-agent')
  await ui.unmount()
})

test('a Task that cannot be read says why under the way back', async ($, on) => {
  const seen = engine(on, {
    config: { structuredContent: CONFIGURED, isError: false },
    detail: () => failed('offline', 'error connecting to api.github.com'),
  })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'task:3' })
  await seen.clock.settle()

  const lines = await texts(ui)
  expect(lines).toContain('✕ 读取 #3 失败')
  expect(lines).toContain('连不上 GitHub。检查网络后按 r 重试。')
  expect(await ui.find({ key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('the map tab shows the first open Spec: its card, the action bar, and its Child Tasks in a tree of Blocking Edges', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'tab:map' })

  const boxes = await texts(ui, 'Box')
  // The card: which Spec, its title cut to the box, its Child Tasks by group,
  // its progress. The project has another Spec to switch to.
  expect(boxes).toContain('Spec #1切换')
  expect(await texts(ui)).toContain('规格：里程碑一，Claude Code 上的 Matt D…')
  expect(boxes).toContain('◇ 1  ▶ 0  □ 2  ◆ 1')
  expect(boxes).toContain('解锁进度1 / 4 · 25%')
  // The action bar is on the first ready Task, which blocks two others.
  expect(boxes).toContain('#3  挡着 #5 #7详情')
  // A Task hangs under the lowest-numbered Task blocking it, and says what
  // else blocks it; the top level is ready, then closed.
  expect((await texts(ui, 'Button')).filter(text => /^[◇▶□◆├└│ ]/.test(text))).toEqual([
    '◇ #3  Pane 布局设计                 可执行',
    '├─ □ #5 任务列表：按分组展示 Task',
    '└─ □ #7 Map View',
    expect.stringMatching(/^◆ #2  骨架：Configured Projec… 11-1[01] \d\d:\d\d$/),
  ])
  expect(await texts(ui)).toContain('     还被 #5 阻塞')
  expect((await ui.find({ key: 'task:3' }))?.props.autoFocus).toBe(true)
  // A blocked node is dimmed whole: the tree's lines, and the row under it.
  expect((await ui.find({ key: 'task:5' }))?.children).toEqual(
    Array(4).fill(expect.objectContaining({ props: expect.objectContaining({ dimColor: true }) })),
  )
  expect((await ui.find({ type: 'Text', text: '     还被 #5 阻塞' }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('the tree keeps its shape as blockers close, and names a blocker outside the Spec', async ($, on) => {
  const seen = engine(on, {
    config: { structuredContent: CONFIGURED, isError: false },
    tasks: () =>
      tasks({
        containers: [
          spec(1, '规格一', [3, 4, 5, 6, 7, 8, 9], { closed: 2, inProgress: 0, total: 7 }),
          spec(40, '另一个规格', [41], { closed: 0, inProgress: 0, total: 1 }),
        ],
        // #5 is blocked by #3, which has closed: it is ready, still under #3.
        ready: [task(5, '跟在 #3 后面', { parent: 1, blockedBy: [3] }), task(41, '别处的 Task', { parent: 40 })],
        blocked: [
          // Blocked only from outside the Spec: at the top, saying by what.
          task(6, '等别处', { parent: 1, blockers: [41] }),
          // Blocking each other: drawn once each, not forever.
          task(8, '环一', { parent: 1, blockers: [9] }),
          task(9, '环二', { parent: 1, blockers: [8] }),
          // Under a Task on the loop, though its number is lower.
          task(7, '跟在环后面', { parent: 1, blockers: [8] }),
        ],
        // The latest closed first, as the tasks tab has them.
        done: [
          task(4, '后关闭的', { isOpen: false, parent: 1, closedAt: '2026-11-11T09:00:00Z' }),
          task(3, '已经关闭', { isOpen: false, parent: 1, closedAt: '2026-11-11T05:40:00Z' }),
        ],
      }),
  })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'tab:map' })

  expect((await texts(ui, 'Button')).filter(text => /^[◇▶□◆├└│ ]/.test(text))).toEqual([
    '□ #6  等别处                   被 #41 阻塞',
    expect.stringMatching(/^◆ #4  后关闭的 +11-1[12] \d\d:\d\d$/),
    expect.stringMatching(/^◆ #3  已经关闭                 11-1[01] \d\d:\d\d$/),
    '└─ ◇ #5 跟在 #3 后面',
    // A loop is cut where it is reached, after the top level.
    '□ #8  环一                      被 #9 阻塞',
    '├─ □ #7 跟在环后面',
    '└─ □ #9 环二',
  ])
  await focus($, 'task:6')
  expect(await texts(ui, 'Box')).toContain('#6  被 #41 阻塞详情')
  await ui.unmount()
})

// A project with a Spec, a Map and a closed Spec.
const SPECS_AND_MAPS = tasks({
  containers: [
    spec(1, '规格：里程碑一', [3], { closed: 0, inProgress: 0, total: 1 }),
    { ...spec(21, 'Codex 适配走哪条路', [22], { closed: 0, inProgress: 0, total: 1 }), kind: 'map' },
    spec(30, '里程碑零', [31], { closed: 1, inProgress: 0, total: 1 }, { isOpen: false, group: 'done' }),
  ],
  ready: [task(3, '规格一的 Task', { parent: 1 }), task(22, '要定的事', { parent: 21 })],
  done: [task(31, '里程碑零的 Task', { isOpen: false, parent: 30, closedAt: '2026-11-10T05:40:00Z' })],
})

test('s lists only the Specs and Maps, the closed last, and enter shows the one chosen', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => SPECS_AND_MAPS })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:map' })

  await ui.press({ key: 'switch' })

  expect(await texts(ui, 'Box')).toContain('返回  地图 / 切换')
  expect((await ui.findAll({ type: 'Button', text: /^[◇◆] / })).map(button => button.text)).toEqual([
    '◇ Spec #1 规格：里程碑一               0/1',
    '◇ Map #21 Codex 适配走哪条路           0/1',
    '◆ Spec #30 里程碑零                    1/1',
  ])
  // The one shown is where the focus is.
  expect((await ui.find({ key: 'switch:1' }))?.props.autoFocus).toBe(true)

  await ui.press({ key: 'switch:21' })
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(await texts(ui, 'Box')).toContain('Map #21切换')
  expect((await ui.find({ key: 'task:22' }))?.text).toMatch(/^◇ #22 要定的事/)

  // b goes back without switching; a closed Spec can be chosen too.
  await ui.press({ key: 'switch' })
  await ui.press({ key: 'back' })
  expect(await texts(ui, 'Box')).toContain('Map #21切换')
  await ui.press({ key: 'switch' })
  await ui.press({ key: 'switch:30' })
  expect(await texts(ui, 'Box')).toContain('Spec #30切换')
  await ui.unmount()
})

test('m on a Spec in the tasks tab opens its Map View', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => SPECS_AND_MAPS })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await focus($, 'task:21')

  await ui.press({ key: 'map' })

  expect((await ui.find({ key: 'tab:map' }))?.children).toEqual([
    expect.objectContaining({ props: expect.objectContaining({ bold: true, underline: true }) }),
  ])
  expect(await texts(ui, 'Box')).toContain('Map #21切换')
  await ui.unmount()
})

test('the row saying what a Task belongs to opens that Spec\'s Map View', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'task:7' })
  await seen.clock.settle()

  await ui.press({ key: 'parent:1' })

  expect((await ui.find({ key: 'tab:map' }))?.children).toEqual([
    expect.objectContaining({ props: expect.objectContaining({ bold: true, underline: true }) }),
  ])
  expect(await texts(ui, 'Box')).toContain('Spec #1切换')
  // The detail is left behind, as when a tab is left from one.
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  await ui.unmount()
})

test('with one Spec there is nothing to switch to, and with none the map tab says so', async ($, on) => {
  let answer = tasks({ containers: [spec(1, '唯一的规格', [3], { closed: 0, inProgress: 0, total: 1 })], ready: [task(3, 'T', { parent: 1 })] })
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, tasks: () => answer })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:map' })
  expect(await ui.find({ key: 'switch' })).toBeUndefined()
  expect(await texts(ui, 'Box')).toContain('Spec #1')

  answer = tasks({ ready: [task(3, 'T')] })
  await ui.press({ key: 'refresh' })
  await seen.clock.settle()

  const lines = await texts(ui)
  expect(lines).toContain('还没有 Spec 或 Map。')
  expect(lines).toContain('带 Child Task 的 Task 会出现在这里。')
  await ui.unmount()
})

test('above the prompt the map tab grows the pane, the card in one row, and gives the four rows back', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })

  await ui.press({ key: 'tab:map' })

  expect(seen.openedRows).toEqual([4, undefined])
  const boxes = await texts(ui, 'Box')
  expect(boxes).toContain('Spec #1 规格：里程碑一，Claude Code 上的 Matt Deck 闭环1 / 4 · 25%  切换')
  expect(boxes).toContain('#3  挡着 #5 #7详情')
  expect((await ui.find({ key: 'task:5' }))?.text).toBe('├─ □ #5 任务列表：按分组展示 Task')

  // Into a node's detail and back, the pane stays tall.
  await ui.press({ key: 'task:5' })
  await seen.clock.settle()
  expect(await texts(ui, 'Box')).toContain('返回  地图 / #1 / #5')
  await ui.press({ key: 'back' })
  expect(seen.openedRows).toEqual([4, undefined, undefined])
  expect(await texts(ui, 'Box')).toContain('#5  被 #3 阻塞详情')

  await ui.press({ key: 'tab:tasks' })
  expect(seen.openedRows).toEqual([4, undefined, undefined, 4])
  await ui.unmount()
})

test('a tree taller than the pane turns pages under the card', async ($, on) => {
  const seen = engine(on, {
    config: { structuredContent: CONFIGURED, isError: false },
    tasks: () =>
      tasks({
        containers: [spec(1, '大规格', [3, ...Array.from({ length: 8 }, (_, i) => 101 + i)], { closed: 0, inProgress: 0, total: 9 })],
        ready: [task(3, '起点', { parent: 1 })],
        blocked: Array.from({ length: 8 }, (_, i) => task(101 + i, `第 ${i + 1} 个`, { parent: 1, blockers: [3] })),
      }),
  })
  await start($)
  await seen.clock.settle()
  // Five rows fit under the fixed twelve.
  const ui = await $.ui.mount({
    ...PANE_TARGET,
    props: { ...PANE_TARGET.props, scroll: { offset: 0, bodyRows: 17 } },
    surface: 'terminal',
  })
  await ui.press({ key: 'tab:map' })
  const nodes = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(key => key?.startsWith('task:'))

  expect(await nodes()).toEqual(['task:3', 'task:101', 'task:102', 'task:103'])
  expect((await ui.find({ key: 'page:next' }))?.text).toBe('  还有 5 个')

  await ui.press({ key: 'page:next' })
  expect(await nodes()).toEqual(['task:104', 'task:105', 'task:106'])
  expect((await ui.find({ key: 'page:prev' }))?.text).toBe('  前面还有 4 个')

  // The tasks tab keeps its own page.
  await ui.press({ key: 'tab:tasks' })
  expect(await ui.find({ key: 'page:prev' })).toBeUndefined()
  await ui.unmount()
})

test('the skills tab names the Skill Source and lists /ask-matt apart, then the rest, each with its description', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: DIRECTORY, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })

  await ui.press({ key: 'tab:skills' })

  expect(seen.calls.filter(call => call.tool === 'deck_skills')).toEqual([{ server: SERVER, tool: 'deck_skills', args: {} }])
  const lines = await texts(ui)
  expect(lines).toContain('Skill Source  目录 ~/.claude/skills')
  expect(lines).toContain('通用入口')
  expect(lines).toContain('技能 3')
  expect((await ui.findAll({ type: 'Button', text: /^\// })).map(row => [row.key, row.text])).toEqual([
    ['skill:ask-matt', '/ask-matt               问下一步该做什么。'],
    ['skill:implement', '/implement               开始做一个 Task。'],
    ['skill:tdd', '/tdd                  先写测试，再写实现。'],
    ['skill:wayfinder', '/wayfinder      为不清晰的大工作建立 Map。'],
  ])
  // The command name in the colour of commands; the focus lands on the first.
  expect((await ui.find({ type: 'Text', text: '/implement' }))?.props.color).toBe('suggestion')
  expect((await ui.find({ key: 'skill:ask-matt' }))?.props.autoFocus).toBe(true)
  // The action bar is about /ask-matt.
  expect(await texts(ui, 'Box')).toContain('/ask-matt预填  原文')
  await ui.unmount()
})

test('o shows a skill\'s file as written under the way back, and b goes back to its row', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: DIRECTORY, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:skills' })
  await focus($, 'skill:tdd')

  await ui.press({ key: 'open' })
  await seen.clock.settle()

  expect(seen.calls.at(-1)).toEqual({ server: SERVER, tool: 'deck_skill', args: { name: 'tdd' } })
  expect(await ui.find({ key: 'skill:tdd' })).toBeUndefined()
  expect(await ui.find({ key: 'tab:skills' })).toBeDefined()
  expect(await texts(ui, 'Box')).toContain('返回  技能 / /tdd预填')
  // The command name bold, in the colour of commands.
  const title = (await ui.findAll({ type: 'Text', text: '/tdd' })).find(found => found.text === '/tdd' && found.props.bold)
  expect(title?.props.color).toBe('suggestion')
  expect(await texts(ui)).toContain('~/.claude/skills/tdd/SKILL.md')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('# tdd\n\n原文。\n')

  await ui.press({ key: 'back' })

  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(await ui.find({ key: 'skill:tdd' })).toBeDefined()
  expect(await texts(ui, 'Box')).toContain('/tdd预填  原文')
  await ui.unmount()
})

test('above the prompt the skills tab is four rows, and a skill\'s text grows the pane and gives the rows back', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: DIRECTORY, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  await ui.press({ key: 'tab:skills' })

  const boxes = await texts(ui, 'Box')
  expect(boxes).toContain('/ask-matt  问下一步该做什么。预填  原文')
  expect(boxes).toContain('/ask-matt   /implement   /tdd   /wayfinderSkill Source 目录 ~/.claude/skills')
  expect(seen.openedRows).toEqual([4])

  await focus($, 'skill:implement')
  await ui.press({ key: 'open' })
  await seen.clock.settle()
  expect(seen.openedRows).toEqual([4, undefined])
  expect(await texts(ui, 'Box')).toContain('返回  技能 / /implement预填')

  await ui.press({ key: 'back' })
  expect(seen.openedRows).toEqual([4, undefined, 4])
  expect(await texts(ui, 'Box')).toContain('/implement  开始做一个 Task。预填  原文')
  await ui.unmount()
})

// A plugin Skill Source: its skills are called with the plugin's prefix.
const PLUGIN_SKILLS: Answer = {
  isError: false,
  structuredContent: {
    ok: true,
    source: { type: 'plugin', name: 'mattpocock-skills' },
    skills: [
      { ...SKILL('tdd', '先写测试，再写实现。'), call: '/mattpocock-skills:tdd' },
      { ...SKILL('ask-matt', '问下一步该做什么。'), call: '/mattpocock-skills:ask-matt' },
    ],
  },
}

test('e puts the skill\'s call in an empty prompt box for the person to send', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, skills: () => PLUGIN_SKILLS })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:skills' })

  // From the list, on the row the action bar is about.
  await focus($, 'skill:tdd')
  await ui.press({ key: 'prefill' })
  await seen.clock.settle()
  // And from a skill's text.
  await ui.press({ key: 'skill:ask-matt' })
  await seen.clock.settle()
  await ui.press({ key: 'prefill' })
  await seen.clock.settle()

  expect(seen.filled).toEqual([
    { text: '/mattpocock-skills:tdd ', mode: 'replace' },
    { text: '/mattpocock-skills:ask-matt ', mode: 'replace' },
  ])
  expect(seen.toasts).toEqual([])
  await ui.unmount()
})

test('e leaves a draft in the prompt box as it is and says so', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: DIRECTORY, isError: false }, draft: '先看一下 #7 的' })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:skills' })

  await ui.press({ key: 'prefill' })
  await seen.clock.settle()

  expect(seen.filled).toEqual([])
  expect(seen.copied).toEqual([])
  expect(seen.toasts).toEqual(['输入框里已有草稿，没有覆盖。清空后再按 e：/ask-matt'])
  await ui.unmount()
})

test('where the host cannot fill the prompt box, e copies the call to the clipboard and says so', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: DIRECTORY, isError: false }, canFill: false })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:skills' })

  await ui.press({ key: 'prefill' })
  await seen.clock.settle()

  expect(seen.copied).toEqual(['/ask-matt'])
  expect(seen.toasts).toEqual(['不能预填输入框，已复制到剪贴板：/ask-matt'])
  await ui.unmount()
})

test('a Skill Source that is not there, or holds no skill, says why in place of the list', async ($, on) => {
  const answers: Answer[] = [
    {
      isError: false,
      structuredContent: { ok: false, failure: { kind: 'missing', message: 'the directory ~/.claude/skills does not exist' } },
    },
    { isError: false, structuredContent: { ok: true, source: { type: 'directory', path: '~/.claude/skills' }, skills: [] } },
  ]
  let answer = answers[0]!
  const seen = engine(on, { config: { structuredContent: DIRECTORY, isError: false }, skills: () => answer })
  await start($)
  await seen.clock.settle()

  for (const target of [PANE_TARGET, INLINE]) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    await ui.press({ key: 'tab:skills' })
    expect(await texts(ui)).toContain('✕ 读取技能失败')
    expect(await texts(ui)).toContain('Skill Source 不存在。运行 /matt-deck:configure 重新选定。')
    expect(await ui.find({ key: 'prefill' })).toBeUndefined()
    await ui.unmount()
  }

  // r reads the skills again.
  answer = answers[1]!
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await seen.clock.settle()
  expect(await texts(ui)).toContain('Skill Source  目录 ~/.claude/skills')
  expect(await texts(ui)).toContain('Skill Source 里没有技能。')
  await ui.unmount()
})

test('skills more than the pane holds turn pages of their own, apart from the tasks tab\'s', async ($, on) => {
  const many: Answer = {
    isError: false,
    structuredContent: {
      ok: true,
      source: { type: 'directory', path: '~/.claude/skills' },
      skills: [SKILL('ask-matt', '问下一步该做什么。'), ...Array.from({ length: 12 }, (_, i) => SKILL(`skill-${i + 10}`, `第 ${i + 10} 个。`))],
    },
  }
  const seen = engine(on, { config: { structuredContent: DIRECTORY, isError: false }, skills: () => many })
  await start($)
  await seen.clock.settle()
  const short = { ...PANE_TARGET, props: { ...PANE_TARGET.props, scroll: { offset: 0, bodyRows: 14 } } }
  const ui = await $.ui.mount({ ...short, surface: 'terminal' })
  await ui.press({ key: 'tab:skills' })

  const rowsShown = async () => (await ui.findAll({ type: 'Button', text: /^\// })).map(row => row.key)
  expect(await rowsShown()).toEqual(['skill:ask-matt', 'skill:skill-10', 'skill:skill-11'])
  await ui.press({ key: 'page:next' })
  expect((await rowsShown())[0]).toBe('skill:skill-12')
  expect(await texts(ui, 'Box')).toContain('/skill-12预填  原文')

  await ui.press({ key: 'tab:tasks' })
  expect(await ui.find({ key: 'page:prev' })).toBeUndefined()
  await ui.press({ key: 'tab:skills' })
  expect(await ui.find({ key: 'page:prev' })).toBeDefined()
  await ui.unmount()
})

test('n while the Session is idle runs /ask-matt with the request at once, and the stages follow its turn to the Recommendation', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, recommendation: () => RECOMMENDED })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })
  expect(await texts(ui)).toContain('在本 Session 运行 /ask-matt。')

  await ui.press({ key: 'ask' })

  expect(seen.ran).toEqual([
    { command: 'mattpocock-skills:ask-matt', args: 'Matt Deck Recommendation Request request-1. 快照 1' },
  ])
  expect(await texts(ui)).toContain('已交给 Session，等这一回合开始。')
  expect((await ui.find({ type: 'Text', text: '已发出' }))?.props).toEqual(expect.objectContaining({ bold: true }))
  // Sent at once, it was never held: that stage is not one gone through.
  expect((await ui.find({ type: 'Text', text: '持有中' }))?.props).toEqual(expect.objectContaining({ dimColor: true }))

  await turnStart($, 't1', '/mattpocock-skills:ask-matt Matt Deck Recommendation Request request-1. 快照 1')
  expect(await texts(ui)).toContain('/ask-matt 运行中，已附带 Task Snapshot。')
  expect((await ui.find({ type: 'Text', text: '运行中' }))?.props).toEqual(expect.objectContaining({ bold: true }))
  expect((await ui.find({ type: 'Text', text: '已发出' }))?.props).toEqual(expect.objectContaining({ color: 'suggestion' }))

  await turnEnd($, 't1', '先做 #3。')
  await seen.clock.settle()

  expect(seen.calls.filter(call => call.tool === 'deck_recommendation').map(call => call.args)).toEqual([
    { requestId: 'request-1' },
  ])
  expect((await ui.find({ type: 'Text', text: '已回答' }))?.props).toEqual(expect.objectContaining({ bold: true }))
  const shown = await texts(ui)
  for (const line of [
    '下一个成就',
    '#3 Pane 布局设计',
    '先画停靠在侧边的线框图，再画输入框上方的。',
    '/prototype',
    '它挡着 #5、#7、#8，放开 10 个 Task。',
  ]) {
    expect(shown.some(text => text.includes(line))).toBe(true)
  }
  // A field with nothing in it says so.
  expect(shown).toContain('无')
  expect((await ui.find({ key: 'ask' }))?.text).toBe('再问一次')
  await ui.unmount()
})

test('n while the Session is busy holds the request, which goes once the turn has ended, with the Task Snapshot of then', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })
  await turnStart($, 't1')

  await ui.press({ key: 'ask' })

  expect(await texts(ui)).toContain('Session 忙碌，空闲后自动发出。')
  // While held, sent or running there is no n to make another request.
  expect(await ui.find({ key: 'ask' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '持有中' }))?.props).toEqual(expect.objectContaining({ bold: true }))
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  // Nothing is made or run while the turn goes on: the Task Snapshot is the
  // one of when the request goes.
  const asks = () => seen.calls.filter(call => call.tool === 'deck_ask').length
  expect(asks()).toBe(0)
  expect(seen.ran).toEqual([])

  // Not from within the turn's end, which the engine would refuse, but just
  // after it.
  await turnEnd($, 't1')
  expect(seen.ran).toEqual([])
  await seen.clock.advance(100)
  expect(asks()).toBe(1)
  expect(seen.ran).toEqual([
    { command: 'mattpocock-skills:ask-matt', args: 'Matt Deck Recommendation Request request-1. 快照 1' },
  ])
  expect(await texts(ui)).toContain('已交给 Session，等这一回合开始。')
  expect(await ui.find({ key: 'cancel' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '持有中' }))?.props).toEqual(expect.objectContaining({ color: 'suggestion' }))

  expect(await ui.find({ key: 'ask' })).toBeUndefined()
  await turnStart($, 't2', '/mattpocock-skills:ask-matt Matt Deck Recommendation Request request-1. 快照 1')
  expect(await ui.find({ key: 'ask' })).toBeUndefined()
  expect(asks()).toBe(1)
  await ui.unmount()
})

test('a held request can be cancelled, and is not sent when the turn ends', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })
  await turnStart($, 't1')
  await ui.press({ key: 'ask' })

  await ui.press({ key: 'cancel' })
  await turnEnd($, 't1')
  await seen.clock.advance(1_000)

  expect(seen.calls.filter(call => call.tool === 'deck_ask')).toEqual([])
  expect(seen.ran).toEqual([])
  expect(await texts(ui)).toContain('已取消。请求没有发出。')
  expect((await ui.find({ key: 'ask' }))?.text).toBe('我现在该做什么')

  // Asked again, it goes.
  await ui.press({ key: 'ask' })
  expect(seen.ran).toHaveLength(1)
  await ui.unmount()
})

test('a held request cancelled just as it is about to go is not sent', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  // The write that sends the request says it is on its way, then waits for
  // the one that cancels it, and so comes too late: it is made again, of a
  // request now cancelled.
  let sending = () => undefined as void
  const isSending = new Promise<void>(go => (sending = go))
  let cancelled = () => undefined as void
  const isCancelled = new Promise<void>(go => (cancelled = go))
  on('state.set', { plugin: 'matt-deck', key: 'ask' }, async (_, e, next) => {
    if (e.value.value.status === 'sent') {
      sending()
      await isCancelled
    }
    const set = await next(e)
    if (e.value.value.status === 'cancelled') {
      cancelled()
    }

    return set
  })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })
  await turnStart($, 't1')
  await ui.press({ key: 'ask' })
  await turnEnd($, 't1')

  const advanced = seen.clock.advance(100)
  await isSending
  await Promise.all([advanced, ui.press({ key: 'cancel' })])

  expect(seen.calls.filter(call => call.tool === 'deck_ask')).toEqual([])
  expect(seen.ran).toEqual([])
  expect(await texts(ui)).toContain('已取消。请求没有发出。')
  await ui.unmount()
})

test('a /clear drops the held request', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })
  await turnStart($, 't1')
  await ui.press({ key: 'ask' })

  await $.session.end({ reason: 'clear', sessionId: 'a1b2c3d4-session', resume: { id: 'a1b2c3d4-session' } } as never)
  await turnEnd($, 't1')
  await seen.clock.advance(1_000)

  expect(seen.ran).toEqual([])
  expect(await texts(ui)).toContain('在本 Session 运行 /ask-matt。')
  await ui.unmount()
})

test('a turn that ends without deck_recommend shows its answer as written', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })
  await ui.press({ key: 'ask' })
  await turnStart($, 't1', '/mattpocock-skills:ask-matt Matt Deck Recommendation Request request-1. 快照 1')

  // Another turn's end is not the request's.
  await turnEnd($, 't0', '别的回合。')
  await seen.clock.settle()
  expect(await texts(ui)).toContain('/ask-matt 运行中，已附带 Task Snapshot。')

  await turnEnd($, 't1', '先做 #3。它挡着 #5、#7、#8。')
  await seen.clock.settle()

  expect(await texts(ui)).toContain('没有收到 deck_recommend 的回报。')
  expect((await ui.find({ type: 'Markdown' }))?.props).toEqual(expect.objectContaining({ text: '先做 #3。它挡着 #5、#7、#8。' }))
  expect((await ui.find({ key: 'ask' }))?.text).toBe('再问一次')

  // Asked again: a new request, its own id.
  await ui.press({ key: 'ask' })
  expect(seen.ran.map(run => run.args)).toEqual([
    'Matt Deck Recommendation Request request-1. 快照 1',
    'Matt Deck Recommendation Request request-2. 快照 2',
  ])
  expect(await texts(ui)).toContain('已交给 Session，等这一回合开始。')
  await ui.unmount()
})

test('a turn begun while the request is being made holds it, to be made anew when the turn ends', async ($, on) => {
  // The first deck_ask answers only when the test lets it, and says when it
  // has been asked.
  let asked = () => undefined as void
  const isAsked = new Promise<void>(go => (asked = go))
  let release = () => undefined as void
  const released = new Promise<void>(go => (release = go))
  let count = 0
  const seen = engine(on, {
    config: { structuredContent: CONFIGURED, isError: false },
    waitFor: tool => {
      if (tool !== 'deck_ask' || ++count > 1) {
        return undefined
      }
      asked()

      return released
    },
  })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })

  const pressed = ui.press({ key: 'ask' })
  await isAsked
  await turnStart($, 't1')
  release()
  await pressed

  expect(seen.ran).toEqual([])
  expect(await texts(ui)).toContain('Session 忙碌，空闲后自动发出。')
  await turnEnd($, 't1')
  await seen.clock.advance(100)
  expect(seen.ran.map(run => run.args)).toEqual(['Matt Deck Recommendation Request request-2. 快照 2'])
  expect((await ui.find({ type: 'Text', text: '持有中' }))?.props).toEqual(expect.objectContaining({ color: 'suggestion' }))
  await ui.unmount()
})

test('n pressed twice before the Pane is drawn again makes one request', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })

  await Promise.all([ui.press({ key: 'ask' }), ui.press({ key: 'ask' })])

  expect(seen.calls.filter(call => call.tool === 'deck_ask')).toHaveLength(1)
  expect(seen.ran.map(run => run.args)).toEqual(['Matt Deck Recommendation Request request-1. 快照 1'])
  expect(await texts(ui)).toContain('已交给 Session，等这一回合开始。')
  await ui.unmount()
})

test('n pressed twice while the Session is busy holds one request, sent once when the turn has ended', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })
  await turnStart($, 't1')

  await Promise.all([ui.press({ key: 'ask' }), ui.press({ key: 'ask' })])

  expect(await texts(ui)).toContain('Session 忙碌，空闲后自动发出。')
  expect(seen.ran).toEqual([])
  await turnEnd($, 't1')
  await seen.clock.advance(1_000)
  expect(seen.ran.map(run => run.args)).toEqual(['Matt Deck Recommendation Request request-1. 快照 1'])
  await ui.unmount()
})

test('n that reaches the Mod once the request is running makes no new request', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false } })
  // The second press of n waits until the test lets it through: a press on a
  // Pane drawn before the request it then finds.
  let letThrough = () => undefined as void
  const isLetThrough = new Promise<void>(go => (letThrough = go))
  let presses = 0
  on('ui.press', async (_, e, next) => {
    if (e.element === 'ask' && ++presses === 2) {
      await isLetThrough
    }

    return next(e)
  })
  // The first press settles only with the second, so the test waits on the
  // request it sends.
  let sent = () => undefined as void
  const isSent = new Promise<void>(go => (sent = go))
  on('state.set', { plugin: 'matt-deck', key: 'ask' }, (_, e, next) => {
    if (e.value.value.requestId !== undefined) {
      sent()
    }

    return next(e)
  })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })

  const pressed = [ui.press({ key: 'ask' }), ui.press({ key: 'ask' })]
  await isSent
  await turnStart($, 't1', '/mattpocock-skills:ask-matt Matt Deck Recommendation Request request-1. 快照 1')
  letThrough()
  await Promise.all(pressed)

  expect(await texts(ui)).toContain('/ask-matt 运行中，已附带 Task Snapshot。')
  expect(seen.calls.filter(call => call.tool === 'deck_ask')).toHaveLength(1)
  expect(seen.ran.map(run => run.args)).toEqual(['Matt Deck Recommendation Request request-1. 快照 1'])
  await ui.unmount()
})

test('a request the Deck service cannot make is not sent, and says why', async ($, on) => {
  const seen = engine(on, {
    config: { structuredContent: CONFIGURED, isError: false },
    ask: () => ({
      isError: false,
      structuredContent: { ok: false, failure: { kind: 'unknown-skill', message: 'the Skill Source has no skill named ask-matt' } },
    }),
  })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  await ui.press({ key: 'tab:next' })

  await ui.press({ key: 'ask' })

  expect(seen.ran).toEqual([])
  expect(seen.toasts).toEqual(['“我现在该做什么”没有发出：the Skill Source has no skill named ask-matt'])
  expect((await ui.find({ key: 'ask' }))?.text).toBe('我现在该做什么')
  await ui.unmount()
})

test('above the prompt the stages take the primary button\'s place in every tab, and the answer is two rows, o showing it all', async ($, on) => {
  const seen = engine(on, { config: { structuredContent: CONFIGURED, isError: false }, recommendation: () => RECOMMENDED })
  await start($)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...inline(96), surface: 'terminal' })
  expect(await ui.find({ key: 'ask' })).toBeDefined()

  await ui.press({ key: 'ask' })
  await turnStart($, 't1', '/mattpocock-skills:ask-matt Matt Deck Recommendation Request request-1. 快照 1')
  // In the tasks tab too, the stages stand where the button was.
  expect(await ui.find({ key: 'ask' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '运行中' }))?.props).toEqual(expect.objectContaining({ bold: true }))

  await turnEnd($, 't1', '先做 #3。')
  await seen.clock.settle()
  await ui.press({ key: 'tab:next' })
  const boxes = await texts(ui, 'Box')
  expect(boxes).toContain('下一步  任务  地图  技能再问一次')
  expect(boxes).toContain('下一个成就  ◇ #3 Pane 布局设计   技能 /prototype   阻塞 无全文')
  expect(await texts(ui)).toContain('下一步 先画停靠在侧边的线框图，再画输入框上方的。  理由 它挡着 #5、#7、#8，放开 10 个 Task。')

  const rows = seen.openedRows.length
  await ui.press({ key: 'answer' })
  expect(seen.openedRows.slice(rows)).toEqual([undefined])
  expect(await texts(ui)).toContain('它挡着 #5、#7、#8，放开 10 个 Task。')
  await ui.press({ key: 'back' })
  expect(seen.openedRows.slice(rows)).toEqual([undefined, 4])
  await ui.unmount()
})
