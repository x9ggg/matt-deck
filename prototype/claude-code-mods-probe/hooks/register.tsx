// PROTOTYPE, throwaway. It answers one question: can a Claude Code mod close
// the loop "pane button -> /ask-matt -> held while busy / cancel -> structured
// answer back in the pane"? The task snapshot below is fake data.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Recommendation, View } from '../types'

const PANE = 'matt-deck-probe'
const TOOL = 'mcp__matt-deck-probe__recommend'
const MARK = 'deck-probe-request'
const LOG_FILE = '/tmp/matt-deck-probe/deck-probe.log'

const ARGS =
  `[${MARK}] 这是 matt-deck 原型面板的按钮发来的测试请求。` +
  '任务快照（假数据）：#12 实现 GitHub 任务后端（可执行）；' +
  '#13 面板任务列表（阻塞于 #12）；#14 推荐按钮（进行中）。' +
  `请判断现在该做哪一项，然后调用工具 ${TOOL} 回报 task、nextStep、skill、` +
  'reason、blockers，最后用一句话作答。'

const EMPTY: View = {
  sessionId: '',
  cwd: '',
  hasAskMatt: false,
  isBusy: false,
  request: 'none',
  requestTurnId: null,
  recommendation: null,
  rawAnswer: null,
  startedAt: 0,
  log: [],
}

const view = atom({ plugin: 'matt-deck-probe', key: 'view' } as const, EMPTY, {
  shape: 'view-1',
})

const REQUEST_LABEL: Record<View['request'], string> = {
  none: '无',
  held: '面板持有中（等宿主空闲）',
  sent: '已交给宿主',
  running: '回合运行中',
  answered: '已回答',
  cancelled: '已取消',
}

const note = async ($: EngineInterface, line: string) => {
  const now = await $.clock.now()
  await update($, view, v => {
    const startedAt = v.startedAt === 0 ? now : v.startedAt
    const at = ((now - startedAt) / 1000).toFixed(1)

    return { ...v, startedAt, log: [...v.log, `+${at}s ${line}`].slice(-40) }
  })
  // The same lines on disk, so the result can be read without the pane.
  const { log } = await read($, view)
  await $.fs.write(LOG_FILE, `${log.join('\n')}\n`).catch(() => undefined)
}

const dispatch = async ($: EngineInterface, via: string) => {
  await update($, view, v => ({
    ...v,
    request: 'sent',
    requestTurnId: null,
    recommendation: null,
    rawAnswer: null,
  }))
  await note($, `${via}：$.command.run(ask-matt) 调用`)

  try {
    const ran = await $.command.run({ command: 'ask-matt', args: ARGS })
    await note($, `$.command.run 返回（text: ${ran.text ? '有' : '无'}）`)
  } catch (error) {
    await note($, `$.command.run 被拒绝：${String(error)}`)
    await update($, view, v => ({ ...v, request: 'none' }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck-probe',
      description: 'Open the matt-deck prototype pane',
    })
    await $.tool.register({
      name: 'recommend',
      description:
        'Report the recommended next task to the matt-deck prototype pane.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          nextStep: { type: 'string' },
          skill: { type: 'string' },
          reason: { type: 'string' },
          blockers: { type: 'string' },
        },
        required: ['task', 'nextStep', 'skill', 'reason', 'blockers'],
      },
      isDeferred: false,
    })

    const sessionId = await $.session.id()
    const cwd = await $.session.cwd()
    const commands = await $.command.list()
    const hasAskMatt = commands.some(command => command.name === 'ask-matt')
    await update($, view, v => ({ ...v, sessionId, cwd, hasAskMatt }))

    const opened = await $.ui.open({ id: PANE, title: 'Matt Deck 原型' })
    await note(
      $,
      `加载：会话 ${sessionId.slice(0, 8)}，面板 ${
        opened.isPlaced ? '已放置' : `未放置（${opened.reason}）`
      }，/ask-matt ${hasAskMatt ? '存在' : '不存在'}`,
    )

    return next(e)
  })

  on('command.run', { command: 'deck-probe' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Matt Deck 原型' })

    return {
      text: opened.isPlaced
        ? 'Matt Deck 原型面板已打开。'
        : `面板未放置：${opened.reason}`,
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const current = await read($, view)
    const isOurs = current.request === 'sent'
    await update($, view, v => ({
      ...v,
      isBusy: true,
      request: isOurs ? 'running' : v.request,
      requestTurnId: isOurs ? e.turnId : v.requestTurnId,
    }))
    await note(
      $,
      `turn.start ${e.turnId.slice(0, 8)}${
        isOurs ? `（推荐请求；文本含标记：${e.text.includes(MARK)}）` : ''
      }`,
    )

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) {
      return done
    }

    const current = await read($, view)
    const isOurs = current.requestTurnId === e.turnId
    await update($, view, v => ({
      ...v,
      isBusy: false,
      request: isOurs ? 'answered' : v.request,
      rawAnswer: isOurs ? done.text.slice(0, 400) : v.rawAnswer,
    }))
    await note(
      $,
      `turn.complete ${e.turnId.slice(0, 8)}（${e.reason}）${
        isOurs ? '← 推荐请求的回合' : ''
      }`,
    )

    if (current.request === 'held') {
      // command.run is refused inside a hook the turn waits on, so leave it.
      $.clock.after(100, () => void dispatch($, '空闲后发出'))
    }

    return done
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Record<keyof Recommendation, unknown>
    const recommendation: Recommendation = {
      task: String(input.task),
      nextStep: String(input.nextStep),
      skill: String(input.skill),
      reason: String(input.reason),
      blockers: String(input.blockers),
    }
    await update($, view, v => ({ ...v, recommendation }))
    await note($, '工具回报已收到')

    return { result: 'Recorded in the matt-deck prototype pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 18)
    const isPending =
      v.request === 'held' || v.request === 'sent' || v.request === 'running'

    const ask = async () => {
      const now = await read($, view)

      if (
        now.request === 'held' ||
        now.request === 'sent' ||
        now.request === 'running'
      ) {
        await note($, '重复点击：已有请求，合并')

        return
      }

      if (now.isBusy) {
        await update($, view, x => ({ ...x, request: 'held' }))
        await note($, '宿主忙：请求由面板持有')

        return
      }

      await dispatch($, '空闲直发')
    }

    const cancel = async () => {
      const now = await read($, view)

      if (now.request === 'held') {
        await update($, view, x => ({ ...x, request: 'cancelled' }))
        await note($, '已取消面板持有的请求')

        return
      }

      await note($, `无法取消：当前状态为「${REQUEST_LABEL[now.request]}」`)
    }

    return (
      <Box flexDirection="column">
        <Text bold>Matt Deck 原型（一次性，假数据）</Text>
        <Text dimColor>
          会话 {v.sessionId.slice(0, 8)} · {e.surface} · {e.props.placement}
        </Text>
        <Text dimColor>{v.cwd}</Text>
        <Text>
          宿主：{v.isBusy ? '忙碌' : '空闲'}　请求：{REQUEST_LABEL[v.request]}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Button key="ask" label="我现在该做什么" hotkey="w" onPress={ask} />
          <Button key="cancel" label="取消排队" hotkey="c" onPress={cancel} />
          <Button
            key="engine"
            label="对照：忙时也直接交给宿主排队"
            hotkey="e"
            // Not awaited: while busy the call resolves only once the session
            // is idle, which outlasts a press hook's 10s budget.
            onPress={() => {
              void dispatch($, '直接交给宿主')
            }}
          />
        </Box>
        {v.recommendation !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>推荐（工具回报）</Text>
            <Text>任务：{v.recommendation.task}</Text>
            <Text>下一步：{v.recommendation.nextStep}</Text>
            <Text>技能：{v.recommendation.skill}</Text>
            <Text>理由：{v.recommendation.reason}</Text>
            <Text>阻塞：{v.recommendation.blockers}</Text>
          </Box>
        )}
        {v.rawAnswer !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>回答原文（turn.complete）</Text>
            <Text dimColor>{v.rawAnswer}</Text>
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>事件{isPending ? '（请求进行中）' : ''}</Text>
          {v.log.slice(-room).map(line => (
            <Text dimColor>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  })
}
