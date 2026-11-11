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

// A Task as `deck_tasks` lists it.
const task = (number: number, title: string, more: object = {}) => ({
  number,
  title,
  isOpen: true,
  labels: [] as string[],
  parent: null as number | null,
  blockers: [] as number[],
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
    isNarrow = false,
  }: { config: Answer | undefined; tasks?: () => Answer; isNarrow?: boolean },
) => {
  const seen = {
    opened: [] as string[],
    closed: [] as string[],
    calls: [] as { server: string; tool: string; args?: Record<string, unknown> }[],
    clock: undefined as unknown as MockClock,
  }
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
  on('mcp.call', (_, e) => {
    seen.calls.push(e)
    const answer = e.tool === 'deck_tasks' ? tasks() : config!

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
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))

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

  // On a Spec the bar counts its Child Tasks by group.
  await focus($, 'task:1')
  expect((await ui.find({ type: 'Box', text: /^#1  / }))?.text).toBe('#1  ◇ 1  ▶ 0  □ 2  ◆ 1')

  // Off the rows (onto a tab) the bar stays where it was.
  await focus($, 'tab:map')
  expect((await ui.find({ type: 'Box', text: /^#1  / }))?.text).toBe('#1  ◇ 1  ▶ 0  □ 2  ◆ 1')
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

  // The end of one of this Session's turns.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, {}])
  // A subagent's turn is not this Session's.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, {}])

  // A deck tool the agent called; another tool is not one.
  await $.tool.call({ tool: 'mcp__plugin_matt-deck_deck__deck_config' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, {}, {}])
  await $.tool.call({ tool: 'mcp__github__issue_read' })
  await seen.clock.settle()
  expect(reads()).toEqual([{}, {}, {}, {}])

  // r reads past the Deck service's cache.
  await ui.press({ key: 'refresh' })
  expect(reads()).toEqual([{}, {}, {}, {}, { refresh: true }])
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
      expect(lines).toContain(says)
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
  expect(boxes).toContain('下一步  任务  地图  技能')
  expect(boxes).toContain('◇ #3  Pane 布局设计   可执行   ready-for-human')
  // The list's row: Specs and Maps first, then the groups in order, as many
  // as fit, and the chosen filter at its end.
  const items = (await ui.findAll({ type: 'Button' })).map(button => button.text)
  expect(items.slice(5)).toEqual(['◇ Spec #1 1/4', '◇ #3 Pane 布局设计', '□ #5 任务列表：按分组展示 Task', '还有 3 个', '全部 5'])
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
  expect(await texts(ui, 'Box')).toContain('□ #5  任务列表：按分组展示 T…   被 #3 阻塞   ready-for-agent')

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

  // The skills tab names the Skill Source until it lists the skills (#8).
  await ui.press({ key: 'tab:skills' })
  expect(await texts(ui)).toContain('Skill Source 插件 mattpocock-skills')

  await ui.press({ key: 'tab:tasks' })
  expect(await ui.find({ key: 'filter' })).toBeDefined()
  await ui.unmount()
})
