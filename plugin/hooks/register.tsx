// The Claude Code host adapter: the Pane and its command. It holds no task
// logic; everything about the project comes from the Deck service.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ConfigView, DeckConfigAnswer, DeckTasksAnswer, Filter, Nav, TasksView, View } from '../types'
import { drawPane } from './pane.tsx'

const PANE = 'matt-deck'
const TITLE = 'Matt Deck'
const COMMAND = 'deck'

// How often the Pane reads the Tasks by itself. The Deck service caches a
// read for less than this, so each timed read reaches the Task Source.
const POLL_MS = 60_000

// The Deck service's tools as the agent calls them: after any of them the
// Pane reads the Tasks again.
const DECK_TOOL = /^mcp__plugin_matt-deck_deck__deck_/

const FILTERS: Filter[] = ['all', 'ready', 'inProgress', 'blocked', 'done']

const view = atom(
  { plugin: 'matt-deck', key: 'view' } as const,
  { sessionId: '', config: { status: 'loading' }, tasks: { status: 'loading' }, checkedAt: 0 } as View,
  { shape: 'view-2' },
)

const nav = atom({ plugin: 'matt-deck', key: 'nav' } as const, { tab: 'tasks', filter: 'all', page: 0 } as Nav, {
  shape: 'nav-1',
})

const textOf = (answer: { content: { text?: string }[] }) => answer.content.map(block => block.text ?? '').join('\n')

const loadConfig = async ($: EngineInterface): Promise<ConfigView> => {
  const deck = await $.mcp.connect('deck')
  if (!deck.isConnected) {
    return { status: 'unreachable', message: deck.message }
  }
  const answer = await $.mcp.call(deck.server, 'deck_config', {})
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
  const deck = await $.mcp.connect('deck')
  let answer: DeckTasksAnswer
  if (!deck.isConnected) {
    answer = { ok: false, failure: { kind: 'unreachable', message: deck.message } }
  } else {
    const result = await $.mcp.call(deck.server, 'deck_tasks', refresh ? { refresh: true } : {})
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
}

const isConfigured = async ($: EngineInterface) => (await read($, view)).config.status === 'configured'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: '打开或关闭 Matt Deck 的 Pane' })

    const sessionId = await $.session.id()
    const config = await loadConfig($)
    await update($, view, current => ({ ...current, sessionId, config }))

    // The Pane opens only where a project config exists; a malformed one
    // opens it to say why.
    if (config.status === 'configured' || config.status === 'error') {
      await $.ui.open({ id: PANE, title: TITLE, columns: 42, rows: 4 })
    }
    // The Tasks are read off the session's start, so it does not wait on gh.
    if (config.status === 'configured') {
      $.clock.after(0, () => void loadTasks($, false))
      $.clock.every(POLL_MS, () => void loadTasks($, false))
    }

    return started
  })

  // The end of a turn of this Session, and every call of a Deck tool, may
  // have changed the Tasks a moment ago: read them again, off the event and
  // past the Deck service's cache.
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined && (await isConfigured($))) {
      $.clock.after(0, () => void loadTasks($, true))
    }

    return completed
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
    // command answers in text.
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
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: 42, rows: 4 })

    return { text: opened.isPlaced ? 'Matt Deck 已打开。' : `Matt Deck 暂未显示：${opened.reason}` }
  })

  // The action bar is about the row the focus is on; it keeps the last row
  // while the focus is elsewhere.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny === undefined && e.element?.startsWith('task:')) {
      await update($, nav, current => ({ ...current, focus: e.element }))
    }

    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawPane($.ui.resolve(e), e.props, await read($, view), await read($, nav), {
      refresh: () => void loadTasks($, true),
      showTab: tab => void update($, nav, current => ({ ...current, tab })),
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
          await update($, nav, current => ({ ...current, page, ...(key === undefined ? {} : { focus: key }) }))
          if (key !== undefined) {
            await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
          }
        })(),
    }),
  )
}
