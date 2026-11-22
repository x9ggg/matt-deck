// The Pane in a Codex tab, under a fake Host: what the page shows, and what it
// asks the Host for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answered, openPage } from './fake-host.ts'

const SESSION = { session: '019a8c3e-1f2b-7c4d-9e0f-0a1b045b96fc', sessionHost: 'codex', sessionShort: '045b96fc' }

// The call of the configure skill as this fake Deck service gives it: no
// call the page could write itself, so a page that prefills it took it from
// the answer.
const CONFIGURE_CALL = '$configure-as-the-deck-service-says-9f3c'

// The Deck service of a Session started in the Workspace at `workspace`.
const deckAt =
  (workspace: string, configured = true) =>
  (name: string) => {
    if (name === 'deck_config') {
      return answered(
        configured
          ? {
              configured: true,
              workspace,
              config: { taskSource: { type: 'github-issues' }, skillSource: { type: 'plugin', name: 'mattpocock-skills' } },
            }
          : { configured: false, workspace },
      )
    }
    if (name === 'deck_session') {
      return answered(SESSION)
    }
    if (name === 'deck_configure') {
      return answered({ call: CONFIGURE_CALL })
    }
    throw new Error(`unexpected call of ${name}`)
  }

const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim()

// Whether the person sees an element: neither it nor what holds it is hidden.
const shown = (page: { window: any }, element: Element | null) => {
  for (let each = element; each !== null; each = each.parentElement) {
    if (page.window.getComputedStyle(each).display === 'none') {
      return false
    }
  }
  return element !== null
}

test('in a Configured Project the Pane heads its four tabs with the project and the Session, which it asks only the Host for', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  const tabs = () => [...document.querySelectorAll('[role="tab"]')]
  const selected = () => tabs().filter(tab => tab.getAttribute('aria-selected') === 'true').map(text)

  assert.equal(text(document.querySelector('.dk-chip--project')), 'matt-deck')
  assert.equal(text(document.querySelector('.dk-head .dk-chip:not(.dk-chip--project)')), 'Session 045b96fc')
  assert.equal(text(document.querySelector('.dk-head__fresh')), '刚刚')
  assert.deepEqual(tabs().map(text), ['下一步', '任务', '地图', '技能'])
  assert.deepEqual(selected(), ['任务'])
  assert.equal(shown(page, document.querySelector('.dk-empty')), false)

  await page.click(tabs()[2]!)
  assert.deepEqual(selected(), ['地图'])
  await page.click(tabs()[0]!)
  assert.deepEqual(selected(), ['下一步'])

  // The handshake, then the tools of the Deck service through the Host. The
  // page passes no Session: the Deck service reads it from the call.
  const calls = () => page.sent.filter(message => message.method === 'tools/call').map(({ params }) => params)
  assert.deepEqual(
    page.sent.slice(0, 2).map(message => message.method),
    ['ui/initialize', 'ui/notifications/initialized'],
  )
  assert.deepEqual(calls(), [
    { name: 'deck_config', arguments: {} },
    { name: 'deck_session', arguments: {} },
  ])

  await page.click(document.querySelector('.dk-head button'))
  assert.equal(calls().length, 4)
  assert.equal(text(document.querySelector('.dk-head__fresh')), '刚刚')
})

test('the head says how fresh the read is, stale after ten minutes, until the Pane reads again', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const fresh = page.document.querySelector('.dk-head__fresh')!
  const shows = () => [text(fresh), fresh.classList.contains('is-stale')]

  assert.deepEqual(shows(), ['刚刚', false])
  await page.advance(3 * 60_000)
  assert.deepEqual(shows(), ['3 分钟前', false])
  await page.advance(8 * 60_000)
  assert.deepEqual(shows(), ['11 分钟前', true])
  await page.advance(49 * 60_000)
  assert.deepEqual(shows(), ['1 小时前', true])

  await page.click(page.document.querySelector('.dk-head button'))
  assert.deepEqual(shows(), ['刚刚', false])
})

test('"刷新" is off while the Pane reads', async t => {
  const answer = deckAt('/work/matt-deck')
  let hold: Promise<void> | undefined
  const page = await openPage({
    answer: async name => {
      await hold
      return answer(name)
    },
  })
  t.after(page.close)
  const refresh = page.document.querySelector<HTMLButtonElement>('.dk-head button')!
  assert.equal(refresh.disabled, false)

  let release!: () => void
  hold = new Promise(resolve => (release = resolve))
  refresh.click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(refresh.disabled, true)

  release()
  await page.settled()
  assert.equal(refresh.disabled, false)
})

test('the head and the tabs stay at the top while the content scrolls', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const top = page.document.querySelector('.dk-top')!

  assert.equal(page.window.getComputedStyle(top).position, 'sticky')
  assert.equal(page.window.getComputedStyle(top).top, '0px')
  assert.ok(top.querySelector('.dk-head'))
  assert.ok(top.querySelector('[role="tablist"]'))
})

test('in a project that is not configured the Pane says so and how to configure it, with no tabs', async t => {
  const page = await openPage({ answer: deckAt('/work/elsewhere', false) })
  t.after(page.close)
  const { document } = page

  assert.equal(text(document.querySelector('.dk-chip--project')), 'elsewhere')
  assert.equal(text(document.querySelector('.dk-head .dk-chip:not(.dk-chip--project)')), 'Session 045b96fc')
  assert.equal(text(document.querySelector('.dk-head__fresh')), '')
  assert.deepEqual(
    [...document.querySelectorAll('.dk-empty > *')].map(text),
    ['此项目未配置。', '配置之后，这里显示这个项目的 Task。', '配置这个项目'],
  )
  assert.equal(shown(page, document.querySelector('.dk-empty')), true)
  assert.equal(shown(page, document.querySelector('[role="tablist"]')), false)
})

test('"配置这个项目" puts the call of the configure skill the Deck service gives in the prompt, unsent, then is off for 5 seconds', async t => {
  const page = await openPage({ answer: deckAt('/work/elsewhere', false) })
  t.after(page.close)
  const button = page.document.querySelector<HTMLButtonElement>('.dk-empty button')!
  const prefills = () => page.sent.filter(message => message.method === 'ui/message').map(({ params }) => params)

  await page.click(button)

  assert.deepEqual(prefills(), [
    {
      role: 'user',
      content: [{ type: 'text', text: CONFIGURE_CALL }],
      _meta: { 'openai/message': { target: 'active', send: false } },
    },
  ])
  assert.deepEqual([text(button), button.disabled], ['已填入', true])

  // A second click while it is off fills in nothing more.
  await page.click(button)
  assert.equal(prefills().length, 1)

  await page.advance(4_999)
  assert.deepEqual([text(button), button.disabled], ['已填入', true])
  await page.advance(1)
  assert.deepEqual([text(button), button.disabled], ['配置这个项目', false])
})

test('the Pane says the read failed, and why, when the Deck service cannot read the project config', async t => {
  const page = await openPage({
    answer: name =>
      name === 'deck_config'
        ? { content: [{ type: 'text', text: '.matt-deck/config.json is not valid JSON' }], isError: true }
        : answered(SESSION),
  })
  t.after(page.close)
  const { document } = page

  assert.equal(text(document.querySelector('.dk-head__fresh')), '读取失败')
  assert.ok(document.querySelector('.dk-head__fresh')!.classList.contains('is-failed'))
  assert.equal(text(document.querySelector('.dk-notice.is-danger .dk-notice__text')), '.matt-deck/config.json is not valid JSON')
})

test('the Pane is dark or light as the Host is, and follows the Host as it changes', async t => {
  const light = await openPage({ answer: deckAt('/work/matt-deck'), hostContext: { theme: 'light' } })
  t.after(light.close)
  const dark = await openPage({ answer: deckAt('/work/matt-deck'), hostContext: { theme: 'dark' } })
  t.after(dark.close)
  const theme = (page: typeof light) => page.document.documentElement.dataset.theme

  assert.equal(theme(light), 'deck-light')
  assert.equal(theme(dark), 'deck')

  await light.notify('ui/notifications/host-context-changed', { theme: 'dark' })
  await dark.notify('ui/notifications/host-context-changed', { theme: 'light' })
  assert.equal(theme(light), 'deck')
  assert.equal(theme(dark), 'deck-light')

  // A change of something else leaves the theme as it is.
  await dark.notify('ui/notifications/host-context-changed', { containerDimensions: { width: 638 } })
  assert.equal(theme(dark), 'deck-light')
})

test('the Pane asks for no resource outside itself', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)

  assert.deepEqual(page.fetched, [])
  // Nor does it name one where jsdom would not ask: an image, or an address
  // in its style.
  assert.doesNotMatch(page.html, /\b(?:src|srcset|href)\s*=|url\(|@import|@font-face|https?:/)
})
