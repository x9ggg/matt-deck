// The Claude Code host adapter: the Pane and its command. It holds no task
// logic; everything about the project comes from the Deck service.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ConfigView, DeckConfigAnswer, View } from '../types'

const PANE = 'matt-deck'
const TITLE = 'Matt Deck'
const COMMAND = 'deck'

const view = atom({ plugin: 'matt-deck', key: 'view' } as const, { sessionId: '', config: { status: 'loading' } } as View, {
  shape: 'view-1',
})

const loadConfig = async ($: EngineInterface): Promise<ConfigView> => {
  const deck = await $.mcp.connect('deck')
  if (!deck.isConnected) {
    return { status: 'unreachable', message: deck.message }
  }
  const answer = await $.mcp.call(deck.server, 'deck_config', {})
  if (answer.isError) {
    return { status: 'error', message: answer.content.map(block => block.text ?? '').join('\n') }
  }
  // The host relays the tool's result as text, not as structuredContent.
  const result: DeckConfigAnswer = JSON.parse(answer.content[0]!.text!)

  return result.configured
    ? { status: 'configured', workspace: result.workspace, config: result.config }
    : { status: 'unconfigured', workspace: result.workspace }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: '打开或关闭 Matt Deck 的 Pane' })

    const sessionId = await $.session.id()
    const config = await loadConfig($)
    await update($, view, () => ({ sessionId, config }))

    // The Pane opens only where a project config exists; a malformed one
    // opens it to say why.
    if (config.status === 'configured' || config.status === 'error') {
      await $.ui.open({ id: PANE, title: TITLE })
    }

    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    // The Pane appears only where a project config exists: elsewhere the
    // command answers in text.
    const { config } = await read($, view)
    if (config.status === 'unconfigured') {
      return {
        text: `Matt Deck 未配置：${config.workspace}/.matt-deck/config.json 不存在。写好它之后新开一个 Session，Pane 会自动出现。`,
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
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Matt Deck 已打开。' : `Matt Deck 暂未显示：${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { sessionId, config } = await read($, view)

    return (
      <Box flexDirection="column">
        {config.status === 'loading' && <Text dimColor>正在读取项目配置…</Text>}
        {config.status === 'error' && <Text color="red">{config.message}</Text>}
        {config.status === 'configured' && (
          <Box flexDirection="column">
            <Text bold>项目 {config.workspace.slice(config.workspace.lastIndexOf('/') + 1)}</Text>
            <Text dimColor>Session {sessionId.slice(0, 8)}</Text>
            <Text>Task Source：{{ 'github-issues': 'GitHub Issues' }[config.config.taskSource.type]}</Text>
            <Text>
              Skill Source：
              {config.config.skillSource.type === 'plugin'
                ? `插件 ${config.config.skillSource.name}`
                : `目录 ${config.config.skillSource.path}`}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
