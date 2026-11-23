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

// The clock the page writes a closing time by.
process.env.TZ = 'UTC'

// A Task as deck_tasks lists it: open, held by no Session, blocked by none.
const task = (number: number, title: string, more: object = {}) => ({
  number,
  title,
  isOpen: true,
  labels: ['ready-for-agent'],
  parent: 64,
  blockers: [],
  blockedBy: [],
  closedAt: null,
  occupant: null,
  occupantHost: null,
  occupantShort: null,
  isOrphaned: false,
  hasEvidence: false,
  ...more,
})

const OTHER_CODEX = '019a8c3e-1f2b-7c4d-9e0f-0a1b77e0aa15'
const CLAUDE_CODE = '3f9c21d0-5b6a-4c3d-8e2f-1a0b9c8d7e6f'

// The Tasks of the project as the Deck service lists them: Spec #64 over all
// of them, which an Orphaned Child Task marks, and a closed Map no Task is
// under.
const TASKS = {
  ok: true,
  fetchedAt: Date.UTC(2026, 10, 22, 9, 0),
  containers: [
    {
      ...task(64, '规格：里程碑二', { labels: [], parent: null }),
      kind: 'spec',
      isPendingCloseout: false,
      group: 'ready',
      children: [70, 74, 72, 69, 75, 73, 19, 66, 65],
      progress: { closed: 2, inProgress: 4, total: 9 },
    },
    {
      ...task(50, '旧地图', { isOpen: false, closedAt: '2026-11-01T00:00:00Z', labels: [], parent: null }),
      kind: 'map',
      isPendingCloseout: false,
      group: 'done',
      children: [],
      progress: { closed: 0, inProgress: 0, total: 0 },
    },
  ],
  groups: {
    ready: [task(70, 'Task 详情')],
    inProgress: [
      task(74, '执行与 Occupancy 登记', { occupant: SESSION.session, occupantHost: 'codex', occupantShort: '045b96fc' }),
      task(72, 'Matt 技能', { occupant: OTHER_CODEX, occupantHost: 'codex', occupantShort: '77e0aa15' }),
      task(69, '任务列表', { occupant: CLAUDE_CODE, occupantHost: 'claude-code', occupantShort: '3f9c21d0' }),
      task(75, '心跳与 Orphaned', {
        occupant: OTHER_CODEX,
        occupantHost: 'codex',
        occupantShort: '77e0aa15',
        isOrphaned: true,
      }),
    ],
    blocked: [task(73, '推荐：我现在该做什么', { blockers: [72, 70], blockedBy: [70, 72] }), task(19, '等分诊', { labels: ['needs-triage'] })],
    done: [
      task(66, '骨架', { isOpen: false, closedAt: '2026-11-22T01:40:00Z', hasEvidence: true }),
      task(65, '预先重构', { isOpen: false, closedAt: '2026-11-21T22:10:00Z' }),
    ],
  },
}

// The Deck service of a Session started in the Workspace at `workspace`, its
// Task Source holding `tasks`.
const deckAt =
  (workspace: string, configured = true, tasks: object = TASKS) =>
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
    if (name === 'deck_tasks') {
      return answered(tasks)
    }
    throw new Error(`unexpected call of ${name}`)
  }

const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim()

// Whether the person sees an element: it is in the page, and neither it nor
// what holds it is hidden.
const shown = (page: { window: any }, element: Element | null) => {
  if (element === null || !element.isConnected) {
    return false
  }
  for (let each: Element | null = element; each !== null; each = each.parentElement) {
    if (page.window.getComputedStyle(each).display === 'none') {
      return false
    }
  }
  return true
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
    { name: 'deck_tasks', arguments: {} },
  ])

  await page.click(document.querySelector('.dk-head button'))
  assert.equal(calls().length, 6)
  assert.equal(text(document.querySelector('.dk-head__fresh')), '刚刚')
})

test('the head says how fresh the read is, stale after ten minutes, until the Pane reads again', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const fresh = page.document.querySelector('.dk-head__fresh')!
  const shows = () => [text(fresh), fresh.classList.contains('is-stale')]

  assert.deepEqual(shows(), ['刚刚', false])
  // Hidden, the tab is not read again, so the read it shows grows old.
  await page.show(false)
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
    [...document.querySelector('.dk-empty')!.children].map(text),
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
  assert.equal(
    text(document.querySelector('.dk-notice.is-danger .dk-notice__text')),
    'Deck 服务出错：.matt-deck/config.json is not valid JSON。点“刷新”重试。',
  )
})

test('the Pane is dark or light as the Host is, and follows the Host as it changes', async t => {
  const light = await openPage({ answer: deckAt('/work/matt-deck'), hostContext: { theme: 'light' } })
  t.after(light.close)
  const dark = await openPage({ answer: deckAt('/work/matt-deck'), hostContext: { theme: 'dark' } })
  t.after(dark.close)
  // The Pane's theme, the ground the Pane is drawn on, and what the Host wrote
  // on the root element, which the page leaves to it.
  const theme = (page: typeof light) => [
    page.document.body.dataset.theme,
    page.window.getComputedStyle(page.document.querySelector('.dk-pane')!).backgroundColor,
    page.document.documentElement.dataset.theme,
  ]
  const LIGHT_GROUND = 'rgb(244, 246, 248)'
  const DARK_GROUND = 'rgb(19, 26, 34)'

  assert.deepEqual(theme(light), ['deck-light', LIGHT_GROUND, 'light'])
  assert.deepEqual(theme(dark), ['deck', DARK_GROUND, 'dark'])

  await light.notify('ui/notifications/host-context-changed', { theme: 'dark' })
  await dark.notify('ui/notifications/host-context-changed', { theme: 'light' })
  assert.deepEqual(theme(light), ['deck', DARK_GROUND, 'dark'])
  assert.deepEqual(theme(dark), ['deck-light', LIGHT_GROUND, 'light'])

  // A change of something else leaves the theme as it is.
  await dark.notify('ui/notifications/host-context-changed', { containerDimensions: { width: 638 } })
  assert.deepEqual(theme(dark), ['deck-light', LIGHT_GROUND, 'light'])
})

test('the Pane asks for no resource outside itself', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)

  assert.deepEqual(page.fetched, [])
  // Nor does it name one where jsdom would not ask: an image, or an address
  // in its style.
  assert.doesNotMatch(page.html, /\b(?:src|srcset|href)\s*=|url\(|@import|@font-face|https?:/)
})

// What the "任务" tab shows: each group's title and count, then its rows, as
// the person reads them.
const groupsShown = (document: Document) =>
  [...document.querySelectorAll('.dk-group')].map(group => [
    text(group.querySelector('.dk-group__head')),
    ...[...group.querySelectorAll('.dk-row')].map(text),
  ])

test('the "任务" tab shows the Tasks in the four groups the Deck service puts them in, under its open Specs and Maps', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page

  assert.deepEqual(groupsShown(document), [
    ['可执行 1', '#70 Task 详情 可执行 ready-for-agent'],
    [
      '进行中 4',
      '#74 执行与 Occupancy 登记 进行中 · 本 Session ready-for-agent',
      '#72 Matt 技能 进行中 · 77e0aa15 ready-for-agent',
      '#69 任务列表 进行中 · Claude Code 3f9c21d0 ready-for-agent',
      '#75 心跳与 Orphaned Orphaned ready-for-agent',
    ],
    ['阻塞 2', '#73 推荐：我现在该做什么 被 #72 #70 阻塞 ready-for-agent', '#19 等分诊 needs-triage'],
    ['已完成 2', '#66 骨架 已解锁 验收证据 ready-for-agent 11-22 01:40', '#65 预先重构 已解锁 ready-for-agent 11-21 22:10'],
  ])
  // The open Spec, with its Child Tasks counted from the same read; the
  // closed Map is not listed.
  assert.deepEqual([...document.querySelectorAll('.dk-row--container')].map(text), [
    'Spec #64 规格：里程碑二 2/9 1 可执行 · 4 进行中 · 2 阻塞',
  ])
  // This Session's Task is drawn apart from another Session's; an Orphaned
  // Child Task marks its Spec.
  const plate = (number: number) => {
    const row = [...document.querySelectorAll('.dk-row')].find(row => text(row.querySelector('.dk-id')) === `#${number}`)
    return row?.querySelector('.dk-plate')?.getAttribute('aria-label')
  }
  assert.deepEqual(
    [74, 72, 69, 75, 64, 73, 66].map(plate),
    ['进行中 · 本 Session', '进行中 · 其他 Session', '进行中 · 其他 Session', 'Orphaned', 'Orphaned', '被阻塞', '已解锁'],
  )
  assert.equal(text(document.querySelector('.dk-row.is-closed .is-pass')), '验收证据')
})

// The filter's five items as the person reads them, and the one chosen.
const filterShown = (document: Document) => [
  [...document.querySelectorAll('.dk-filter__chip')].map(chipText),
  [...document.querySelectorAll('.dk-filter__chip[aria-pressed="true"]')].map(chipText),
]
// A filter item's name and count, apart.
const chipText = (chip: Element) => `${text(chip)!.replace(/\d+$/, '')} ${text(chip.querySelector('.mono'))}`

test('the filter shows one group alone, all of it, and a group past five rows shows five and a button to the rest', async t => {
  const blocked = [80, 81, 82, 83, 84, 85, 86].map(number => task(number, `被挡 ${number}`, { blockers: [70], blockedBy: [70] }))
  const page = await openPage({
    answer: deckAt('/work/matt-deck', true, { ...TASKS, groups: { ...TASKS.groups, blocked } }),
  })
  t.after(page.close)
  const { document } = page
  const chip = (name: string) =>
    [...document.querySelectorAll('.dk-filter__chip')].find(each => text(each)!.startsWith(name))!

  assert.deepEqual(filterShown(document), [['全部 14', '可执行 1', '进行中 4', '阻塞 7', '已完成 2'], ['全部 14']])
  const blockedGroup = document.querySelectorAll('.dk-group')[2]!
  assert.deepEqual(groupsShown(document)[2], ['阻塞 7', ...[80, 81, 82, 83, 84].map(number => `#${number} 被挡 ${number} 被 #70 阻塞 ready-for-agent`)])
  assert.equal(text(blockedGroup.querySelector('button.dk-group__more')), '还有 2 个')

  await page.click(chip('进行中'))
  assert.deepEqual(filterShown(document)[1], ['进行中 4'])
  assert.deepEqual(groupsShown(document), [
    [
      undefined,
      '#74 执行与 Occupancy 登记 进行中 · 本 Session ready-for-agent',
      '#72 Matt 技能 进行中 · 77e0aa15 ready-for-agent',
      '#69 任务列表 进行中 · Claude Code 3f9c21d0 ready-for-agent',
      '#75 心跳与 Orphaned Orphaned ready-for-agent',
    ],
  ])
  assert.equal(document.querySelector('.dk-row--container'), null)

  // "还有 2 个" puts the filter on its group, which then shows all seven.
  await page.click(chip('全部'))
  await page.click(document.querySelectorAll('.dk-group')[2]!.querySelector('button.dk-group__more'))
  assert.deepEqual(filterShown(document)[1], ['阻塞 7'])
  assert.deepEqual(groupsShown(document), [
    [undefined, ...[80, 81, 82, 83, 84, 85, 86].map(number => `#${number} 被挡 ${number} 被 #70 阻塞 ready-for-agent`)],
  ])
  assert.equal(document.querySelector('button.dk-group__more'), null)

  // The filter stays as it is when the Pane reads again.
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(filterShown(document)[1], ['阻塞 7'])
})

test('an empty list says it is empty and where to go, and so does a group the filter finds empty', async t => {
  const empty = { ok: true, fetchedAt: TASKS.fetchedAt, containers: [], groups: { ready: [], inProgress: [], blocked: [], done: [] } }
  const none = await openPage({ answer: deckAt('/work/matt-deck', true, empty) })
  t.after(none.close)
  const said = (page: typeof none) =>
    shown(page, page.document.querySelector('#tasks .dk-empty'))
      ? [...page.document.querySelector('#tasks .dk-empty')!.children].map(text)
      : []

  assert.deepEqual(filterShown(none.document)[0], ['全部 0', '可执行 0', '进行中 0', '阻塞 0', '已完成 0'])
  assert.deepEqual(said(none), ['Task Source 里还没有 Task。', '在 Session 里用 Matt skills 建立。'])

  const someReady = await openPage({
    answer: deckAt('/work/matt-deck', true, { ...TASKS, groups: { ...TASKS.groups, ready: [] } }),
  })
  t.after(someReady.close)
  assert.deepEqual(said(someReady), [])
  await someReady.click(someReady.document.querySelectorAll('.dk-filter__chip')[1]!)
  assert.deepEqual(said(someReady), ['没有可执行的 Task。', '到“下一步”问该做什么。'])
  await someReady.click(someReady.document.querySelectorAll('.dk-filter__chip')[0]!)
  assert.deepEqual(said(someReady), [])
})

test('while the Pane reads again, the head still says how fresh the list it shows is', async t => {
  const answer = deckAt('/work/matt-deck')
  // The freshness the head shows each time deck_tasks is called, before it answers.
  const whileReading: (string | undefined)[] = []
  const page = await openPage({
    answer: (name, _args, document) => {
      if (name === 'deck_tasks') whileReading.push(text(document.querySelector('.dk-head__fresh')))
      return answer(name)
    },
  })
  t.after(page.close)

  await page.advance(60_000)
  await page.advance(60_000)
  await page.click(page.document.querySelector('.dk-head button'))
  assert.deepEqual(whileReading, ['', '1 分钟前', '1 分钟前', '刚刚'])
})

test('the Pane reads the Tasks every 60 seconds while its tab is shown, not while it is hidden, and once as it is shown again', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const reads = () => page.sent.filter(message => message.params?.name === 'deck_tasks').length

  assert.equal(reads(), 1)
  await page.advance(59_999)
  assert.equal(reads(), 1)
  await page.advance(1)
  assert.equal(reads(), 2)
  await page.advance(60_000)
  await page.advance(60_000)
  assert.equal(reads(), 4)

  await page.show(false)
  await page.advance(5 * 60_000)
  assert.equal(reads(), 4)

  await page.show(true)
  assert.equal(reads(), 5)
})

test('"刷新" reads the Task Source again past the Deck service\'s cache; the other reads take what it has', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const reads = () => page.sent.filter(message => message.params?.name === 'deck_tasks').map(({ params }) => params.arguments)

  await page.advance(60_000)
  await page.show(false)
  await page.show(true)
  await page.click(page.document.querySelector('.dk-head button'))
  assert.deepEqual(reads(), [{}, {}, {}, { refresh: true }])
})

test('until the first read of the Tasks comes back, the "任务" tab says it is reading them', async t => {
  const answer = deckAt('/work/matt-deck')
  // What the Pane shows while the Deck service has not answered deck_tasks.
  let whileReading: unknown[] | undefined
  const page = await openPage({
    answer: (name, _args, document) => {
      if (name === 'deck_tasks' && whileReading === undefined) {
        whileReading = [
          [...document.querySelectorAll('.dk-why')].filter(each => !each.closest('[hidden]')).map(text),
          document.querySelector('.dk-filter')!.closest('[hidden]') !== null,
        ]
      }
      return answer(name)
    },
  })
  t.after(page.close)

  assert.deepEqual(whileReading, [['正在读取 Task…'], true])
  assert.deepEqual([...page.document.querySelectorAll('.dk-why')].filter(each => shown(page, each)).map(text), [])
  assert.deepEqual(groupsShown(page.document)[0], ['可执行 1', '#70 Task 详情 可执行 ready-for-agent'])
})

test('when the Task Source cannot be read the Pane says why, over the list it read before', async t => {
  let failure: object | undefined = { kind: 'unauthenticated', message: 'gh auth status: not logged in' }
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({
    answer: name => (name === 'deck_tasks' && failure !== undefined ? answered({ ok: false, failure }) : answer(name)),
  })
  t.after(page.close)
  const { document } = page
  const notice = () => {
    const shownNotice = [...document.querySelectorAll('.dk-notice.is-danger')].find(each => shown(page, each))
    return shownNotice === undefined
      ? undefined
      : [text(shownNotice.querySelector('.dk-notice__title')), text(shownNotice.querySelector('.dk-notice__text')), [...shownNotice.querySelectorAll('code')].map(text)]
  }

  // Never read: the reason, and no list that would read as empty.
  assert.deepEqual(notice(), ['读取 Task 失败', 'gh 未登录。运行 gh auth login 后点“刷新”重试。', ['gh', 'gh auth login']])
  assert.equal(text(document.querySelector('.dk-head__fresh')), '读取失败')
  assert.equal(shown(page, document.querySelector('.dk-filter')), false)
  assert.equal(shown(page, document.querySelector('#tasks .dk-empty')), false)

  failure = undefined
  await page.click(document.querySelector('.dk-head button'))
  assert.equal(notice(), undefined)
  assert.equal(text(document.querySelector('.dk-head__fresh')), '刚刚')

  // Read before: the list stays under the reason.
  failure = { kind: 'no-repository', message: 'no git remote' }
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(notice(), ['读取 Task 失败', '这个 Workspace 没有指向 GitHub 的 remote，读不到 Issues。', []])
  assert.equal(text(document.querySelector('.dk-head__fresh')), '读取失败')
  assert.deepEqual(groupsShown(document)[0], ['可执行 1', '#70 Task 详情 可执行 ready-for-agent'])

  failure = { kind: 'failed', message: 'HTTP 502' }
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(notice()?.[1], 'gh 出错：HTTP 502。点“刷新”重试。')
  failure = { kind: 'offline', message: 'dial tcp' }
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(notice()?.[1], '连不上 GitHub。检查网络后点“刷新”重试。')
  failure = { kind: 'gh-missing', message: 'spawn gh ENOENT' }
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(notice()?.[1], '找不到 gh 命令。安装 GitHub CLI 后点“刷新”重试。')

  // Read again, the head says how fresh the list is, no longer that it failed.
  failure = undefined
  await page.click(document.querySelector('.dk-head button'))
  assert.equal(notice(), undefined)
  assert.equal(text(document.querySelector('.dk-head__fresh')), '刚刚')
  assert.equal(document.querySelector('.dk-head__fresh')!.classList.contains('is-failed'), false)
})

test('the head\'s freshness says what the last read came to, and keeps saying it while the next read is open', async t => {
  // What the project's Deck service answers, as the test sets it.
  let config: 'configured' | 'unconfigured' | 'failing' = 'configured'
  let tasksFail = false
  const configured = deckAt('/work/matt-deck')
  const unconfigured = deckAt('/work/matt-deck', false)
  // The head's freshness: its text, and whether it is drawn failed or stale.
  const freshness = (document: Document) => {
    const fresh = document.querySelector('.dk-head__fresh')!
    return [text(fresh), fresh.classList.contains('is-failed'), fresh.classList.contains('is-stale')]
  }
  // The freshness each time deck_tasks is called, before it answers.
  const whileReading: unknown[] = []
  const page = await openPage({
    answer: (name, _args, document) => {
      if (config === 'failing' && name === 'deck_config') {
        return { content: [{ type: 'text', text: 'config.json is not valid JSON' }], isError: true }
      }
      if (name === 'deck_tasks') {
        whileReading.push(freshness(document))
        if (tasksFail) return answered({ ok: false, failure: { kind: 'offline', message: 'dial tcp' } })
      }
      return (config === 'unconfigured' ? unconfigured : configured)(name)
    },
  })
  t.after(page.close)
  const shows = () => freshness(page.document)
  const refresh = async () => {
    whileReading.length = 0
    await page.click(page.document.querySelector('.dk-head button'))
  }

  // The first read: nothing to say until it answers.
  assert.deepEqual(whileReading, [['', false, false]])
  assert.deepEqual(shows(), ['刚刚', false, false])

  // A list grown stale stays as it is while the next read is open.
  await page.show(false)
  await page.advance(11 * 60_000)
  assert.deepEqual(shows(), ['11 分钟前', false, true])
  await refresh()
  assert.deepEqual(whileReading, [['11 分钟前', false, true]])
  assert.deepEqual(shows(), ['刚刚', false, false])

  // Read, then the Task Source cannot be read; stale, then failed.
  await page.advance(11 * 60_000)
  tasksFail = true
  await refresh()
  assert.deepEqual(shows(), ['读取失败', true, false])
  // Failed, then read: while it is open it still says it failed.
  tasksFail = false
  await refresh()
  assert.deepEqual(whileReading, [['读取失败', true, false]])
  assert.deepEqual(shows(), ['刚刚', false, false])
  // And a timed read later it is fresh still, not failed.
  await page.show(true)
  assert.deepEqual(shows(), ['刚刚', false, false])

  // Read, then the project config cannot be read; then read again.
  config = 'failing'
  await refresh()
  assert.deepEqual(shows(), ['读取失败', true, false])
  config = 'configured'
  await refresh()
  assert.deepEqual(shows(), ['刚刚', false, false])

  // Configured, then not: no Tasks to be fresh, nor failed.
  config = 'unconfigured'
  await refresh()
  assert.deepEqual(shows(), ['', false, false])
  await page.advance(11 * 60_000)
  assert.deepEqual(shows(), ['', false, false])
  // Not configured, then configured: nothing until the Tasks are read.
  config = 'configured'
  await refresh()
  assert.deepEqual(whileReading, [['', false, false]])
  assert.deepEqual(shows(), ['刚刚', false, false])
})

test('when the Deck service fails to list the Tasks the Pane says so in the "任务" tab', async t => {
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({
    answer: name =>
      name === 'deck_tasks' ? { content: [{ type: 'text', text: 'database is locked' }], isError: true } : answer(name),
  })
  t.after(page.close)
  const notice = [...page.document.querySelectorAll('.dk-notice.is-danger')].find(each => shown(page, each))

  assert.deepEqual(
    [text(notice!.querySelector('.dk-notice__title')), text(notice!.querySelector('.dk-notice__text'))],
    ['读取 Task 失败', 'Deck 服务出错：database is locked。点“刷新”重试。'],
  )
  // The head and the tabs are there, the project config having been read.
  assert.equal(shown(page, page.document.querySelector('[role="tablist"]')), true)
})

test('the "任务" tab\'s content is shown only while that tab is chosen', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const tab = (name: string) => [...page.document.querySelectorAll('[role="tab"]')].find(each => text(each) === name)!
  const listShown = () => shown(page, page.document.querySelector('.dk-filter'))

  assert.equal(listShown(), true)
  await page.click(tab('地图'))
  assert.equal(listShown(), false)
  await page.click(tab('任务'))
  assert.equal(listShown(), true)
})

test('a Spec or Map is marked by its Child Tasks in progress, else as a Task is, and a Pending Closeout Spec says so', async t => {
  const spec = (number: number, more: object) => ({
    ...task(number, `Spec ${number}`, { labels: [], parent: null }),
    kind: 'spec',
    isPendingCloseout: false,
    group: 'ready',
    children: [],
    progress: { closed: 0, inProgress: 0, total: 1 },
    ...more,
  })
  const tasks = {
    ...TASKS,
    containers: [
      spec(1, {}),
      spec(2, {}),
      spec(3, { group: 'blocked', blockers: [9] }),
      spec(4, { isPendingCloseout: true, progress: { closed: 1, inProgress: 0, total: 1 } }),
      // A Map held by another Session, itself a Child Task of Spec 6.
      { ...spec(5, { group: 'inProgress', parent: 6 }), kind: 'map', occupant: OTHER_CODEX, occupantHost: 'codex', occupantShort: '77e0aa15' },
      spec(6, {}),
    ],
    groups: {
      ready: [task(9, 'ready', { parent: 3 })],
      inProgress: [
        task(10, 'mine', { parent: 1, occupant: SESSION.session, occupantHost: 'codex', occupantShort: '045b96fc' }),
        task(11, 'theirs', { parent: 2, occupant: CLAUDE_CODE, occupantHost: 'claude-code', occupantShort: '3f9c21d0' }),
      ],
      blocked: [],
      done: [task(12, 'closed', { parent: 4, isOpen: false, closedAt: '2026-11-22T01:40:00Z' })],
    },
  }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks) })
  t.after(page.close)
  const rows = [...page.document.querySelectorAll('.dk-row--container')]

  assert.deepEqual(
    rows.map(row => [row.querySelector('.dk-plate')!.getAttribute('aria-label'), text(row.querySelector('.dk-row__meta'))]),
    [
      ['进行中 · 本 Session', '0 可执行 · 1 进行中 · 0 阻塞'],
      ['进行中 · 其他 Session', '0 可执行 · 1 进行中 · 0 阻塞'],
      ['被阻塞', '1 可执行 · 0 进行中 · 0 阻塞'],
      ['Pending Closeout', '待收尾核对'],
      ['进行中 · 其他 Session', '0 可执行 · 0 进行中 · 0 阻塞'],
      // A Child Task that is a Map counts, and marks it, where it stands as a Task.
      ['进行中 · 其他 Session', '0 可执行 · 1 进行中 · 0 阻塞'],
    ],
  )
  assert.equal(text(rows[4]!.querySelector('.dk-kind')), 'Map')
  assert.equal(text(rows[3]!.querySelector('.dk-ring')), '1/1')
})

test('a Task waiting on a person, blocked by no Task, shows the label it waits on, whichever triage label comes first', async t => {
  const waiting = [
    task(5, 'waits', { labels: ['ready-for-agent', 'needs-info'] }),
    task(6, 'triage', { labels: ['wontfix', 'needs-triage'] }),
    task(7, 'blocked too', { labels: ['ready-for-agent', 'needs-info'], blockers: [70], blockedBy: [70] }),
  ]
  const page = await openPage({
    answer: deckAt('/work/matt-deck', true, { ...TASKS, groups: { ...TASKS.groups, blocked: waiting } }),
  })
  t.after(page.close)

  assert.deepEqual(groupsShown(page.document)[2], [
    '阻塞 3',
    '#5 waits needs-info',
    '#6 triage needs-triage',
    // Blocked by a Task, it says so, beside its first triage label.
    '#7 blocked too 被 #70 阻塞 ready-for-agent',
  ])
})

test('a reason the Task Source or the Deck service gives is shown as it is, backticks too; only the Pane\'s own words are code', async t => {
  let answerOf: (name: string) => object = () => ({})
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({ answer: name => (name === 'deck_tasks' ? answerOf(name) : answer(name)) })
  t.after(page.close)
  const notice = () => {
    const shownText = [...page.document.querySelectorAll('.dk-notice.is-danger .dk-notice__text')].find(each => shown(page, each))!
    return [shownText.textContent, [...shownText.querySelectorAll('code')].map(each => each.textContent)]
  }
  const fail = async (failure: object) => {
    answerOf = () => failure
    await page.click(page.document.querySelector('.dk-head button'))
  }

  await fail(answered({ ok: false, failure: { kind: 'failed', message: 'run `gh auth refresh' } }))
  assert.deepEqual(notice(), ['gh 出错：run `gh auth refresh。点“刷新”重试。', ['gh']])
  await fail(answered({ ok: false, failure: { kind: 'failed', message: 'run `gh auth refresh` first' } }))
  assert.deepEqual(notice(), ['gh 出错：run `gh auth refresh` first。点“刷新”重试。', ['gh']])
  await fail({ content: [{ type: 'text', text: 'the `tasks` table is `locked`' }], isError: true })
  assert.deepEqual(notice(), ['Deck 服务出错：the `tasks` table is `locked`。点“刷新”重试。', []])
  await fail(answered({ ok: false, failure: { kind: 'unauthenticated', message: 'not `logged` in' } }))
  assert.deepEqual(notice(), ['gh 未登录。运行 gh auth login 后点“刷新”重试。', ['gh', 'gh auth login']])
})

// implement's call as this fake Deck service writes it: no call the page
// could write itself from the name, so a page that shows or prefills it took
// it from the answer.
const IMPLEMENT = '$implement-as-the-deck-service-says-4b2e'

// The skills of a Skill Source as the Deck service started for Codex lists
// them: `copy` says whether Codex finds this same file by the skill's name.
const SKILLS = [
  { name: 'ask-matt', call: '$ask-matt', description: '问下一步该做什么。', path: '~/.claude/skills/ask-matt/SKILL.md', copy: 'same' },
  { name: 'implement', call: IMPLEMENT, description: '开始做一个 Task。', path: '~/.claude/skills/implement/SKILL.md', copy: 'same' },
  { name: 'tdd', call: '$tdd', description: '先写测试，再写实现。', path: '~/.claude/skills/tdd/SKILL.md', copy: 'different' },
  { name: 'wayfinder', call: '$wayfinder', description: '为不清晰的大工作建立 Map。', path: '~/.claude/skills/wayfinder/SKILL.md', copy: 'missing' },
]
const TEXT = '# 开始做\n\n读 Task，先写测试。\n\n```sh\nnpm test\n```\n'

// The Deck service of a Configured Project whose Skill Source holds `skills`.
const deckWithSkills =
  (skills: object[] = SKILLS, source: object = { type: 'directory', path: '~/.claude/skills' }) =>
  (name: string, args: any) => {
    if (name === 'deck_skills') {
      return answered({ ok: true, source, skills })
    }
    if (name === 'deck_skill') {
      const skill: any = skills.find((each: any) => each.name === args.name)
      const { copy, ...read } = skill
      return answered({ ok: true, skill: { ...read, text: TEXT } })
    }
    return deckAt('/work/matt-deck')(name)
  }

// The texts of an element's parts: its children, or what `parts` selects.
const parts = (element: Element | null, selector?: string) =>
  [...(selector === undefined ? element!.children : element!.querySelectorAll(`:scope ${selector}`))]
    .filter(part => part.children.length === 0)
    .map(text)

const prefills = (page: { sent: any[] }) => page.sent.filter(message => message.method === 'ui/message').map(({ params }) => params)
const prefilled = (text: string) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  _meta: { 'openai/message': { target: 'active', send: false } },
})

const openSkills = async (answer: (name: string, args: any) => object = deckWithSkills()) => {
  const page = await openPage({ answer })
  await page.click([...page.document.querySelectorAll('[role="tab"]')].find(tab => text(tab) === '技能')!)
  return page
}

// Each skill row as the person reads it: the call, the description, the
// reason it cannot be prefilled if it cannot, and whether "预填" is on.
const rows = (page: { document: Document }, group: Element) =>
  [...group.querySelectorAll('.dk-skill')].map(row => [
    ...[...row.querySelector('.dk-skill__main')!.children].map(text),
    row.querySelector<HTMLButtonElement>('button')!.disabled ? '预填停用' : '预填',
  ])

test('the 技能 tab names the Skill Source, lists $ask-matt as the general entry and the other skills by name, and says which Codex cannot prefill and why', async t => {
  const page = await openSkills()
  t.after(page.close)
  const { document } = page
  const groups = [...document.querySelectorAll('.dk-group')].filter(group => shown(page, group))

  assert.deepEqual(parts(document.querySelector('.dk-source')), ['Skill Source', '目录 ~/.claude/skills'])
  assert.deepEqual(
    [...document.querySelectorAll('.dk-notice.is-warn[role="status"]')].filter(notice => shown(page, notice)).map(notice => parts(notice, 'span, button')),
    [['2 个技能在 Codex 里不能预填。', '重跑配置', '原因写在各自那一行，重跑配置之后恢复。']],
  )
  assert.deepEqual(groups.map(group => parts(group.querySelector('.dk-group__head'))), [['通用入口'], ['技能', '3']])
  assert.deepEqual(rows(page, groups[0]!), [['$ask-matt', '问下一步该做什么。', '预填']])
  assert.deepEqual(rows(page, groups[1]!), [
    [IMPLEMENT, '开始做一个 Task。', '预填'],
    ['$tdd', '先写测试，再写实现。', 'Codex 里的不是同一份，不能预填。', '预填停用'],
    ['$wayfinder', '为不清晰的大工作建立 Map。', 'Codex 里找不到，不能预填。', '预填停用'],
  ])
  // "原文" stays on for every skill.
  assert.deepEqual(
    [...document.querySelectorAll('.dk-skill')].map(row => row.querySelectorAll('button')[1]!.disabled),
    [false, false, false, false],
  )
})

test('with every skill prefillable the 技能 tab has no notice, and a plugin Skill Source is named as one', async t => {
  const same = SKILLS.map(skill => ({ ...skill, copy: 'same' }))
  const page = await openSkills(deckWithSkills(same, { type: 'plugin', name: 'mattpocock-skills' }))
  t.after(page.close)

  assert.deepEqual(parts(page.document.querySelector('.dk-source')), ['Skill Source', '插件 mattpocock-skills'])
  assert.equal([...page.document.querySelectorAll('.dk-notice.is-warn')].some(notice => shown(page, notice)), false)
  assert.equal([...page.document.querySelectorAll('.dk-skill button')].some(button => (button as HTMLButtonElement).disabled), false)
})

test('"预填" puts the skill\'s call in the prompt, unsent, then is off for 5 seconds and says 已填入; a skill Codex cannot prefill fills in nothing', async t => {
  const page = await openSkills()
  t.after(page.close)
  const row = (call: string) => [...page.document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === call)!
  const button = row(IMPLEMENT).querySelector('button')!

  await page.click(button)
  assert.deepEqual(prefills(page), [prefilled(IMPLEMENT)])
  assert.deepEqual([text(button), button.disabled], ['已填入', true])
  // Clicking the button opens no skill text.
  assert.equal(shown(page, page.document.querySelector('.dk-bar')), false)

  await page.click(button)
  await page.click(row('$tdd').querySelector('button'))
  await page.click(row('$wayfinder').querySelector('button'))
  assert.equal(prefills(page).length, 1)

  await page.advance(4_999)
  assert.deepEqual([text(button), button.disabled], ['已填入', true])
  await page.advance(1)
  assert.deepEqual([text(button), button.disabled], ['预填', false])
})

test('"重跑配置" puts the call of the configure skill the Deck service gives in the prompt, unsent', async t => {
  const page = await openSkills()
  t.after(page.close)
  const button = page.document.querySelector<HTMLButtonElement>('.dk-notice.is-warn button')!

  await page.click(button)

  assert.deepEqual(prefills(page), [prefilled(CONFIGURE_CALL)])
  assert.deepEqual([text(button), button.disabled], ['已填入', true])
  await page.advance(5_000)
  assert.deepEqual([text(button), button.disabled], ['重跑配置', false])
})

test('"原文" shows the skill\'s call, its file and its text as written, with "预填" in the bar, and 返回 goes back to the list', async t => {
  const page = await openSkills()
  t.after(page.close)
  const { document } = page
  const row = (call: string) => [...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === call)!
  const bar = () => document.querySelector('.dk-bar')!
  const barButtons = () => [...bar().querySelectorAll('button')] as HTMLButtonElement[]

  await page.click(row(IMPLEMENT).querySelectorAll('button')[1]!)

  assert.equal(shown(page, row(IMPLEMENT)), false)
  assert.equal(text(bar().querySelector('.dk-crumbs')), `技能 / ${IMPLEMENT}`)
  assert.deepEqual(barButtons().map(text), ['返回', '预填'])
  assert.equal(text(document.querySelector('.dk-detail .dk-skill__name')), IMPLEMENT)
  assert.equal(text(document.querySelector('.dk-detail .dk-why')), '~/.claude/skills/implement/SKILL.md')
  assert.equal(document.querySelector('.dk-detail .dk-prose')!.textContent, TEXT)
  assert.deepEqual(
    page.sent.filter(message => message.params?.name === 'deck_skill').map(({ params }) => params.arguments),
    [{ name: 'implement' }],
  )

  await page.click(barButtons()[1]!)
  assert.deepEqual(prefills(page), [prefilled(IMPLEMENT)])
  assert.deepEqual([text(barButtons()[1]!), barButtons()[1]!.disabled], ['已填入', true])

  await page.click(barButtons()[0]!)
  assert.equal(shown(page, bar()), false)
  assert.equal(shown(page, row(IMPLEMENT)), true)

  // A click on the row itself opens the text too; the text of a skill Codex
  // cannot prefill has "预填" off.
  await page.click(row('$tdd'))
  assert.equal(text(bar().querySelector('.dk-crumbs')), '技能 / $tdd')
  assert.equal(barButtons()[1]!.disabled, true)

  // Another tab leaves the text: back on 技能 the list is shown.
  const tabs = [...document.querySelectorAll('[role="tab"]')]
  await page.click(tabs[1]!)
  assert.equal(shown(page, row('$tdd')), false)
  await page.click(tabs[3]!)
  assert.equal(shown(page, bar()), false)
  assert.equal(shown(page, row('$tdd')), true)
})

// The danger notices the person sees: each one's title and text.
const failures = (page: { window: any; document: Document }) =>
  [...page.document.querySelectorAll('.dk-notice.is-danger[role="status"]')]
    .filter(notice => shown(page, notice))
    .map(notice => parts(notice, '.dk-notice__body > *'))

test('the 技能 tab says in its own words that the Skill Source cannot be read, and the reason only when it has no words of its own', async t => {
  const missing = await openSkills((name: string, args: any) =>
    name === 'deck_skills'
      ? answered({ ok: false, failure: { kind: 'missing', message: 'the directory ~/.claude/skills does not exist' } })
      : deckWithSkills()(name, args),
  )
  t.after(missing.close)
  const broken = await openSkills((name: string, args: any) =>
    name === 'deck_skills'
      ? { content: [{ type: 'text', text: 'installed_plugins.json is not valid JSON' }], isError: true }
      : deckWithSkills()(name, args),
  )
  t.after(broken.close)

  assert.deepEqual(failures(missing), [['读取 Skill Source 失败', '找不到 Skill Source。重跑配置之后恢复。']])
  assert.equal(missing.document.querySelectorAll('.dk-skill').length, 0)
  assert.deepEqual(failures(broken), [
    ['读取 Skill Source 失败', 'Deck 服务出错：installed_plugins.json is not valid JSON。点“刷新”重试。'],
  ])
  assert.equal(broken.document.querySelectorAll('.dk-skill').length, 0)
})

test('a skill\'s text that cannot be read says so under the bar, in the Pane\'s own words when it has them', async t => {
  const answerWith = (skill: object) => (name: string, args: any) => (name === 'deck_skill' ? skill : deckWithSkills()(name, args))
  const gone = await openSkills(
    answerWith(answered({ ok: false, failure: { kind: 'unknown-skill', message: 'the Skill Source has no skill named implement' } })),
  )
  t.after(gone.close)
  const broken = await openSkills(answerWith({ content: [{ type: 'text', text: 'EACCES: permission denied' }], isError: true }))
  t.after(broken.close)
  const open = async (page: typeof gone) => {
    await page.click([...page.document.querySelectorAll('.dk-skill')].find(row => text(row.querySelector('.dk-skill__name')) === IMPLEMENT)!)
  }
  await open(gone)
  await open(broken)

  for (const page of [gone, broken]) {
    assert.equal(text(page.document.querySelector('.dk-bar .dk-crumbs')), `技能 / ${IMPLEMENT}`)
    assert.equal(page.document.querySelector('.dk-detail'), null)
  }
  assert.deepEqual(failures(gone), [['读取技能失败', 'Skill Source 里已经没有这个技能。点“刷新”重新读取。']])
  assert.deepEqual(failures(broken), [['读取技能失败', 'Deck 服务出错：EACCES: permission denied。点“刷新”重试。']])
})

test('a skill\'s text answered late shows only while it is the text opened', async t => {
  // The Deck service answers implement's text only once released.
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const answer = deckWithSkills()
  const page = await openSkills(async (name: string, args: any) => {
    if (name === 'deck_skill' && args.name === 'implement') await held
    return answer(name, args)
  })
  t.after(page.close)
  const { document } = page
  const row = (call: string) => [...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === call)!

  // While implement's text is held, the page is never settled: wait a moment.
  const moment = () => new Promise(resolve => setTimeout(resolve, 20))
  ;(row(IMPLEMENT) as HTMLElement).click()
  await moment()
  assert.equal(text(document.querySelector('.dk-bar .dk-crumbs')), `技能 / ${IMPLEMENT}`)
  document.querySelector<HTMLButtonElement>('.dk-bar button')!.click()
  ;(row('$ask-matt') as HTMLElement).click()
  await moment()
  assert.equal(text(document.querySelector('.dk-detail .dk-skill__name')), '$ask-matt')

  release()
  await page.settled()
  assert.equal(text(document.querySelector('.dk-bar .dk-crumbs')), '技能 / $ask-matt')
  assert.equal(text(document.querySelector('.dk-detail .dk-skill__name')), '$ask-matt')
})

test('the reads every 60 seconds and as the tab is shown again leave a skill\'s text open and read no skills', async t => {
  const page = await openSkills()
  t.after(page.close)
  const { document } = page
  const row = (call: string) => [...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === call)!
  const called = (name: string) => page.sent.filter(message => message.params?.name === name).length
  await page.click(row(IMPLEMENT))
  const textShown = () => [
    shown(page, document.querySelector('.dk-bar')),
    text(document.querySelector('.dk-detail .dk-skill__name')),
    shown(page, row(IMPLEMENT)),
  ]
  const tasksRead = called('deck_tasks')

  await page.advance(60_000)
  await page.show(false)
  await page.show(true)

  // The page did read again: the Tasks, twice.
  assert.equal(called('deck_tasks'), tasksRead + 2)
  assert.deepEqual(textShown(), [true, IMPLEMENT, false])
  assert.deepEqual([called('deck_skills'), called('deck_skill')], [1, 1])
})

test('"刷新" reads the skills again, on the 技能 tab at once and on another tab once 技能 is opened again', async t => {
  // The first read finds tdd and wayfinder not the same, the second only
  // wayfinder, the third none.
  let reads = 0
  const page = await openSkills((name: string, args: any) => {
    if (name === 'deck_skills') reads++
    const fixed = reads === 1 ? [] : reads === 2 ? ['tdd'] : ['tdd', 'wayfinder']
    return deckWithSkills(SKILLS.map(skill => (fixed.includes(skill.name) ? { ...skill, copy: 'same' } : skill)))(name, args)
  })
  t.after(page.close)
  const { document } = page
  const refresh = document.querySelector('.dk-head button')!
  const tabs = [...document.querySelectorAll('[role="tab"]')]
  const warned = () =>
    [...document.querySelectorAll('.dk-notice.is-warn[role="status"]')].filter(notice => shown(page, notice)).map(notice => text(notice.querySelector('.dk-notice__title')))

  assert.deepEqual(warned(), ['2 个技能在 Codex 里不能预填。'])
  await page.click(refresh)
  assert.equal(reads, 2)
  assert.deepEqual(warned(), ['1 个技能在 Codex 里不能预填。'])

  // Away from 技能, "刷新" leaves the skills for when the tab opens again.
  await page.click(tabs[1]!)
  await page.click(refresh)
  assert.equal(reads, 2)
  await page.click(tabs[3]!)
  assert.equal(reads, 3)
  assert.deepEqual(warned(), [])
  // Opening it again without a read in between reads nothing more.
  await page.click(tabs[1]!)
  await page.click(tabs[3]!)
  assert.equal(reads, 3)
})

test('whatever the person clicks, the Pane only puts text in the prompt and never sends a message itself', async t => {
  const configured = await openSkills()
  t.after(configured.close)
  const unconfigured = await openPage({ answer: deckAt('/work/elsewhere', false) })
  t.after(unconfigured.close)
  // Every button the person sees on every view the 技能 tab has, and the
  // unconfigured Pane's: each time the last one the page shows now and that
  // was not clicked yet, so a text's "预填" comes before its "返回", and
  // "刷新" at the end, as it draws the list again.
  const clickAll = async (page: typeof configured) => {
    const clicked = new Set<Element>()
    const refresh = page.document.querySelector('.dk-head button')!
    for (;;) {
      const button = [...page.document.querySelectorAll<HTMLButtonElement>('.dk-pane button:not([role="tab"])')].findLast(
        each => each !== refresh && !clicked.has(each) && shown(page, each) && !each.disabled,
      )
      if (button === undefined) {
        break
      }
      clicked.add(button)
      assert.ok(button.isConnected)
      await page.click(button)
    }
    await page.click(refresh)
  }
  await clickAll(configured)
  for (const row of [...configured.document.querySelectorAll('.dk-skill')]) {
    await configured.click(row)
    await clickAll(configured)
  }
  await clickAll(unconfigured)

  const messages = [...configured.sent, ...unconfigured.sent].filter(message => message.method === 'ui/message')
  // The prefills of the skills, of their texts, "重跑配置" and "配置这个项目".
  assert.deepEqual(
    [...new Set(messages.map(({ params }) => params.content[0].text))].sort(),
    [CONFIGURE_CALL, '$ask-matt', IMPLEMENT].sort(),
  )
  assert.deepEqual(
    messages.map(({ params }) => params._meta?.['openai/message']?.send),
    messages.map(() => false),
  )
})
