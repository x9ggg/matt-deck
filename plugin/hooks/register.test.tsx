// The Mod under the engine's test kit. The hooks registered on `on` stand for
// the engine beneath the Mod: the Deck service (`mcp.*`), panes and the session.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
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

// A fake engine: the Deck service answering `deck_config` with `answer`, or
// out of reach when there is none, and a pane list kept the way the engine
// keeps it. On a narrow terminal the first, unasked open leaves the pane open
// but undrawn. Returns what the Mod did.
const engine = (
  on: On,
  answer: { structuredContent?: unknown; isError: boolean; text?: string } | undefined,
  terminal: { isNarrow: boolean } = { isNarrow: false },
) => {
  const seen = { opened: [] as string[], closed: [] as string[], calls: [] as unknown[] }
  let panes: { id: string; isPlaced: boolean }[] = []

  on('session.id', () => ({ value: 'a1b2c3d4-session' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('mcp.connect', () => ({
    value:
      answer === undefined
        ? { isConnected: false, reason: 'failed', message: 'The deck server failed to start.' }
        : { isConnected: true, server: SERVER },
  }))
  on('mcp.call', (_, e) => {
    seen.calls.push(e)

    return {
      value: {
        // As the host relays it: the result as text, no structuredContent.
        content: [{ type: 'text', text: answer!.text ?? JSON.stringify(answer!.structuredContent) }],
        isError: answer!.isError,
      },
    }
  })
  on('ui.open', (_, e) => {
    const isPlaced = !(terminal.isNarrow && seen.opened.length === 0)
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

  return seen
}

const PANE_TARGET = {
  plugin: 'matt-deck',
  component: 'Pane',
  requestId: PANE,
  props: {
    title: 'Matt Deck',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// The person typing `/deck` in a terminal too narrow for an unasked pane.
const DECK_COMMAND = {
  command: 'deck',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const start = ($: Engine) =>
  $.session.start({ cwd: WORKSPACE, surface: 'terminal', isInteractive: true })

test('in a Configured Project the pane opens and its top shows the project', async ($, on) => {
  const seen = engine(on, { structuredContent: CONFIGURED, isError: false })

  await start($)

  expect(seen.calls).toEqual([{ server: SERVER, tool: 'deck_config', args: {} }])
  expect(seen.opened).toEqual([PANE])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE_TARGET, surface })
    expect(await ui.find({ type: 'Text', text: /shop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a1b2c3d4/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /GitHub Issues/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /mattpocock-skills/ })).toBeDefined()
    await ui.unmount()
  }
})

test('without a project config the pane stays closed', async ($, on) => {
  const seen = engine(on, {
    structuredContent: { configured: false, workspace: WORKSPACE },
    isError: false,
  })

  await start($)

  expect(seen.opened).toEqual([])
})

test('a malformed config opens the pane with the reason', async ($, on) => {
  engine(on, { isError: true, text: '.matt-deck/config.json is malformed: bad' })

  await start($)

  const ui = await $.ui.mount({ ...PANE_TARGET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /config\.json is malformed/ })).toBeDefined()
  await ui.unmount()
})

test('the deck command closes an open pane and opens a closed one', async ($, on) => {
  const seen = engine(on, { structuredContent: CONFIGURED, isError: false })
  await start($)

  await $.command.run(DECK_COMMAND)
  expect(seen.closed).toEqual([PANE])

  await $.command.run(DECK_COMMAND)
  expect(seen.opened).toEqual([PANE, PANE])
})

test('without a project config the deck command opens no pane and says what is missing', async ($, on) => {
  const seen = engine(on, {
    structuredContent: { configured: false, workspace: WORKSPACE },
    isError: false,
  })
  await start($)

  const answer = await $.command.run(DECK_COMMAND)

  expect(seen.opened).toEqual([])
  expect(answer.text).toMatch(/未配置/)
  expect(answer.text).toContain('/work/shop/.matt-deck/config.json')
})

test('with the Deck service out of reach the pane stays closed and the deck command says why', async ($, on) => {
  const seen = engine(on, undefined)
  await start($)

  const answer = await $.command.run(DECK_COMMAND)

  expect(seen.opened).toEqual([])
  expect(answer.text).toContain('The deck server failed to start.')
})

test('the deck command draws a pane a narrow terminal left undrawn in a Configured Project', async ($, on) => {
  const seen = engine(on, { structuredContent: CONFIGURED, isError: false }, { isNarrow: true })
  await start($)

  await $.command.run(DECK_COMMAND)

  expect(seen.closed).toEqual([])
  expect(seen.opened).toEqual([PANE, PANE])
})
