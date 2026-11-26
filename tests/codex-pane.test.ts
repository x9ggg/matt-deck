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

// A Task as deck_tasks reads it, with every report of it: open, blocking
// none, its link one the page could not make itself.
const detail = (number: number, title: string, more: object = {}, reports: object[] = []) => ({
  ok: true,
  task: {
    number,
    title,
    isOpen: true,
    closedAt: null,
    updatedAt: '2026-11-21T08:30:00Z',
    labels: ['ready-for-agent'],
    assignees: [],
    url: `https://tasks.example/as-the-deck-service-says/${number}`,
    description: `#${number} 的描述。`,
    acceptance: [{ text: `#${number} 的验收条件`, isChecked: false }],
    ...more,
  },
  reports,
})

// What deck_task reads of each Task of TASKS the tests open.
const DETAILS: Record<number, object> = {
  70: detail(70, 'Task 详情', {
    description: '从任务列表点开一个 Task。\n\n再返回列表。',
    acceptance: [
      { text: '返回到原来的位置', isChecked: true },
      { text: '来路变长', isChecked: false },
    ],
    // Read since the list was: its triage label is the one the detail shows.
    labels: ['enhancement', 'ready-for-human'],
    assignees: ['x9ggg', 'someone'],
  }),
  // Reported, with no Acceptance Evidence.
  72: detail(72, 'Matt 技能', {}, [
    { session: OTHER_CODEX, sessionHost: 'codex', sessionShort: '77e0aa15', reportedAt: Date.UTC(2026, 10, 22, 7, 0), result: '做了一半。', evidence: [] },
  ]),
  // Its first triage label is not the one it waits on.
  19: detail(19, '等分诊', { labels: ['wontfix', 'needs-triage'] }),
  74: detail(74, '执行与 Occupancy 登记'),
  69: detail(69, '任务列表'),
  75: detail(75, '心跳与 Orphaned'),
  73: detail(73, '推荐：我现在该做什么'),
  64: detail(64, '规格：里程碑二', { labels: [] }),
  66: detail(
    66,
    '骨架',
    { isOpen: false, closedAt: '2026-11-22T01:40:00Z', description: '', acceptance: [] },
    [
      {
        session: SESSION.session,
        sessionHost: 'codex',
        sessionShort: '045b96fc',
        reportedAt: Date.UTC(2026, 10, 22, 1, 38),
        result: '页面在标签页里打开。',
        evidence: [
          { text: 'npm test 全部通过', source: 'npm test' },
          { text: '标签页能切换', source: 'commit edaa839' },
        ],
      },
      {
        session: OTHER_CODEX,
        sessionHost: 'codex',
        sessionShort: '77e0aa15',
        reportedAt: Date.UTC(2026, 10, 21, 23, 5),
        result: '重新跑了一遍测试。',
        evidence: [],
      },
      {
        session: CLAUDE_CODE,
        sessionHost: 'claude-code',
        sessionShort: '3f9c21d0',
        reportedAt: Date.UTC(2026, 10, 21, 22, 0),
        result: '预先重构。',
        evidence: [],
      },
    ],
  ),
}

// A Child Task as deck_map puts it on a wall: as deck_tasks lists it, in its
// group, blocking no Task.
const card = (listed: object, group: string, more: object = {}) => ({
  ...listed,
  group,
  updatedAt: '2026-11-22T08:00:00Z',
  blocking: [],
  ...more,
})
const [READY, MINE, OTHER, CLAUDE, ORPHANED] = [TASKS.groups.ready[0]!, ...TASKS.groups.inProgress]
const [BLOCKED, WAITING] = TASKS.groups.blocked
const [EVIDENCED, CLOSED] = TASKS.groups.done

// The Map Views as the Deck service gives them: Spec #64, its wall in an
// order the page could not have worked out, and the closed Map.
const MAPS = {
  ok: true,
  fetchedAt: TASKS.fetchedAt,
  maps: [
    {
      ...TASKS.containers[0],
      goal: '在 Codex 桌面应用的标签页里放一个 Pane。',
      wall: [
        card(READY, 'ready', { blocking: [73] }),
        card(MINE, 'inProgress'),
        card(CLAUDE, 'inProgress'),
        card(OTHER, 'inProgress'),
        card(ORPHANED, 'inProgress'),
        // Held by a Session and blocking others, a card says what it blocks.
        card(task(76, '接管', { occupant: CLAUDE_CODE, occupantHost: 'claude-code', occupantShort: '3f9c21d0' }), 'inProgress', { blocking: [77] }),
        card(task(78, '失联', { occupant: OTHER_CODEX, occupantHost: 'codex', occupantShort: '77e0aa15', isOrphaned: true }), 'inProgress', { blocking: [79] }),
        card(WAITING, 'blocked'),
        card(BLOCKED, 'blocked', { blocking: [99, 100] }),
        card(EVIDENCED, 'done'),
        card(CLOSED, 'done'),
      ],
    },
    { ...TASKS.containers[1], goal: null, wall: [] },
  ],
}

// The Deck service of a Session started in the Workspace at `workspace`, its
// Task Source holding `tasks`, which its Map Views `maps` show.
const deckAt =
  (workspace: string, configured = true, tasks: object = TASKS, maps: object = MAPS) =>
  (name: string, args: any = {}) => {
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
    // Deck's hook has run: the Pane says nothing of it.
    if (name === 'deck_hook') {
      return answered({ receivedAt: Date.UTC(2026, 10, 22, 8, 0) })
    }
    if (name === 'deck_tasks') {
      return answered(tasks)
    }
    if (name === 'deck_task' && DETAILS[args.number] !== undefined) {
      return answered(DETAILS[args.number]!)
    }
    if (name === 'deck_map') {
      return answered(maps)
    }
    if (name === 'deck_skills') {
      return answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS })
    }
    if (name === 'deck_execute') {
      return answered({ prompt: executePromptOf(args.task) })
    }
    throw new Error(`unexpected call of ${name}`)
  }

// The Execute Prompt of a Task as this fake Deck service writes it: no text
// the page could write itself.
const executePromptOf = (task: number) => `$implement #${task} as the Deck service writes it 7e1d`

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
  const page = await openPage({ answer: deckWithSkills() })
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
    // Whether Deck's hook ever ran, which Codex runs once it is trusted.
    { name: 'deck_hook', arguments: {} },
    { name: 'deck_tasks', arguments: {} },
    { name: 'deck_map', arguments: { session: SESSION.session } },
    // 下一步 reads the skills, to know whether Codex runs this ask-matt.
    { name: 'deck_skills', arguments: {} },
    { name: 'deck_configure', arguments: {} },
  ])

  await page.click(document.querySelector('.dk-head button'))
  assert.equal(calls().length, 14)
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
  [...document.querySelectorAll('#groups .dk-group')].map(group => [
    text(group.querySelector('.dk-group__head')),
    ...[...group.querySelectorAll('.dk-row')].map(text),
  ])

test('the "任务" tab shows the Tasks in the four groups the Deck service puts them in, under its open Specs and Maps', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page

  assert.deepEqual(groupsShown(document), [
    ['可执行 1', '#70 Task 详情 可执行 ready-for-agent 执行'],
    [
      '进行中 4',
      '#74 执行与 Occupancy 登记 进行中 · 本 Session ready-for-agent 释放',
      '#72 Matt 技能 进行中 · 77e0aa15 ready-for-agent 接管',
      '#69 任务列表 进行中 · Claude Code 3f9c21d0 ready-for-agent 接管',
      '#75 心跳与 Orphaned Orphaned ready-for-agent 接管 释放',
    ],
    ['阻塞 2', '#73 推荐：我现在该做什么 被 #72 #70 阻塞 ready-for-agent', '#19 等分诊 needs-triage'],
    ['已完成 2', '#66 骨架 已解锁 验收证据 ready-for-agent 11-22 01:40', '#65 预先重构 已解锁 ready-for-agent 11-21 22:10'],
  ])
  // The open Spec, with its Child Tasks counted from the same read; the
  // closed Map is not listed.
  assert.deepEqual([...document.querySelectorAll('.dk-row--container')].map(text), [
    'Spec #64 规格：里程碑二 2/9 1 可执行 · 4 进行中 · 2 阻塞 地图',
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
      '#74 执行与 Occupancy 登记 进行中 · 本 Session ready-for-agent 释放',
      '#72 Matt 技能 进行中 · 77e0aa15 ready-for-agent 接管',
      '#69 任务列表 进行中 · Claude Code 3f9c21d0 ready-for-agent 接管',
      '#75 心跳与 Orphaned Orphaned ready-for-agent 接管 释放',
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
  assert.deepEqual(groupsShown(page.document)[0], ['可执行 1', '#70 Task 详情 可执行 ready-for-agent 执行'])
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
  assert.deepEqual(groupsShown(document)[0], ['可执行 1', '#70 Task 详情 可执行 ready-for-agent 执行'])

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
    return deckAt('/work/matt-deck')(name, args)
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
  const button = page.document.querySelector<HTMLButtonElement>('#skill-list .dk-notice.is-warn button')!

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

test('"刷新" reads the skills again, on whichever tab it is clicked, and opening 技能 reads none', async t => {
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

  // Away from 技能 too: the "执行" of the 任务 tab goes by them.
  await page.click(tabs[1]!)
  await page.click(refresh)
  assert.equal(reads, 3)
  await page.click(tabs[3]!)
  assert.equal(reads, 3)
  assert.deepEqual(warned(), [])
  // Opening it again without a read in between reads nothing more.
  await page.click(tabs[1]!)
  await page.click(tabs[3]!)
  assert.equal(reads, 3)
})

test('whatever the person clicks, the Pane only puts text in the prompt and never sends a message itself', async t => {
  const configured = await openSkills(deckThatRecommends().answer)
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
  // The 下一步 tab's buttons, each once, as each click draws them anew.
  await configured.click([...configured.document.querySelectorAll('[role="tab"]')].find(tab => text(tab) === '下一步')!)
  await configured.click(button(configured, '我现在该做什么'))
  await configured.click(button(configured, '再问一次'))

  const messages = [...configured.sent, ...unconfigured.sent].filter(message => message.method === 'ui/message')
  // The prefills of the skills, of their texts, "重跑配置", "配置这个项目" and
  // the two Recommendation Requests.
  assert.deepEqual(
    [...new Set(messages.map(({ params }) => params.content[0].text))].sort(),
    [CONFIGURE_CALL, '$ask-matt', IMPLEMENT, promptOf(1), promptOf(2)].sort(),
  )
  assert.deepEqual(
    messages.map(({ params }) => params._meta?.['openai/message']?.send),
    messages.map(() => false),
  )
})

// The Deck service of a Configured Project that makes Recommendation
// Requests: each with an id and a prompt no page could write, so a page that
// prefills one took it from the answer. `reported` holds what the agent has
// reported by request; `reads`, the request of each read of one.
const deckThatRecommends = (skills: object[] = SKILLS) => {
  let made = 0
  const reported = new Map<string, object>()
  const reads: string[] = []
  return {
    reported,
    reads,
    answer: (name: string, args: any) => {
      if (name === 'deck_ask') {
        made++
        return answered({
          ok: true,
          requestId: `request-${made}`,
          call: '$ask-matt',
          command: 'ask-matt',
          args: `the arguments of request ${made}`,
          prompt: promptOf(made),
        })
      }
      if (name === 'deck_recommendation') {
        reads.push(args.requestId)
        const recommendation = reported.get(args.requestId)
        return answered(recommendation === undefined ? { found: false } : { found: true, recommendation })
      }
      return deckWithSkills(skills)(name, args)
    },
  }
}
const promptOf = (request: number) => `$ask-matt as the Deck service writes request ${request} 5c8a`

const openNext = async (deck: { answer: (name: string, args: any) => object }) => {
  const page = await openPage({ answer: deck.answer })
  await page.click([...page.document.querySelectorAll('[role="tab"]')].find(tab => text(tab) === '下一步')!)
  return page
}

// The 下一步 tab as the person reads it: the phases with the one it is at,
// then each line, and each button with whether it is on.
const nextTab = (page: { document: Document; window: any }) => {
  const panel = page.document.querySelector('[data-panel="next"]')!
  const phases = [...panel.querySelectorAll('.dk-phase')].map(phase =>
    phase.classList.contains('is-now') ? `>${text(phase)}` : phase.classList.contains('is-cancelled') ? `-${text(phase)}` : phase.classList.contains('is-done') ? `+${text(phase)}` : text(phase),
  )
  const said = [...panel.querySelectorAll('.dk-next__hint, .dk-next__line > span, .dk-notice__title, .dk-notice__text')].map(text)
  const buttons = [...panel.querySelectorAll('button')].map(button => `${text(button)}${(button as HTMLButtonElement).disabled ? '（停用）' : ''}`)
  return { shown: shown(page, panel), phases, said, buttons }
}
// The Recommendation's fields, each name then what it says.
const fields = (page: { document: Document }) => [...page.document.querySelectorAll('.dk-rec__fields > *')].map(text)
const button = (page: { document: Document }, label: string) =>
  [...page.document.querySelectorAll('[data-panel="next"] button')].find(each => text(each) === label)!

// A Recommendation as the agent reports it, with words no page writes.
const RECOMMENDATION = {
  task: 70,
  nextStep: '先画返回栏，再接钻取 7q4x。',
  skill: '$implement-as-the-agent-reports-2d9b',
  reason: '它挡着 #73 和 #71 3m8v。',
  blockers: '',
}

test('"我现在该做什么" puts the Recommendation Request the Deck service gives in the prompt, unsent, and waits for the report', async t => {
  const deck = deckThatRecommends()
  const page = await openNext(deck)
  t.after(page.close)

  assert.deepEqual(nextTab(page), {
    shown: true,
    phases: [],
    said: ['把 $ask-matt 填进输入框，附带 Task Snapshot。'],
    buttons: ['我现在该做什么'],
  })
  await page.click(button(page, '我现在该做什么'))

  assert.deepEqual(prefills(page), [prefilled(promptOf(1))])
  assert.deepEqual(nextTab(page), {
    shown: true,
    phases: ['+已填入', '>等待回报', '已回答'],
    said: ['已填入输入框，等你发送。'],
    buttons: ['再问一次'],
  })
})

test('the Pane reads the request\'s Recommendation every 2 seconds and shows it as it comes', async t => {
  const deck = deckThatRecommends()
  const page = await openNext(deck)
  t.after(page.close)
  await page.click(button(page, '我现在该做什么'))

  await page.advance(1_999)
  assert.deepEqual(deck.reads, [])
  await page.advance(1)
  assert.deepEqual(deck.reads, ['request-1'])
  await page.advance(4_000)
  assert.deepEqual(deck.reads, ['request-1', 'request-1', 'request-1'])

  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  const { document } = page
  assert.deepEqual(nextTab(page).phases, ['+已填入', '+等待回报', '+已回答'])
  assert.deepEqual(parts(document.querySelector('.dk-rec__head'), 'span'), ['下一个成就', 'Task 详情', '#70'])
  // The glyph is the Task's as the list read has it, at its large size.
  assert.equal(document.querySelector('.dk-rec__head .dk-plate')!.getAttribute('aria-label'), '可执行')
  assert.equal(document.querySelector('.dk-rec__head .dk-plate')!.classList.contains('dk-plate--lg'), true)
  assert.deepEqual(fields(page), [
    '下一步',
    '先画返回栏，再接钻取 7q4x。',
    '技能',
    '$implement-as-the-agent-reports-2d9b',
    '理由',
    '它挡着 #73 和 #71 3m8v。',
    '阻塞',
    '无',
  ])
  assert.equal(document.querySelector('.dk-rec__fields .mono')!.textContent, RECOMMENDATION.skill)
  assert.deepEqual(nextTab(page).buttons, ['执行这个 Task', '再问一次'])
  // Once answered it reads no more.
  await page.advance(60_000)
  assert.equal(deck.reads.length, 4)
})

test('after 10 minutes with no report the Pane stops waiting and says so, and a report after that is not shown', async t => {
  const deck = deckThatRecommends()
  const page = await openNext(deck)
  t.after(page.close)
  await page.click(button(page, '我现在该做什么'))

  await page.advance(599_999)
  assert.equal(nextTab(page).phases[1], '>等待回报')
  assert.equal(deck.reads.length, 299)
  await page.advance(1)

  assert.deepEqual(nextTab(page), {
    shown: true,
    phases: ['+已填入', '-等待回报', '已回答'],
    said: ['等了 10 分钟，没有收到回报，已停止等待。回答在对话里。'],
    buttons: ['我现在该做什么'],
  })
  // Stopped, the tab is not drawn again: the button the person may be on
  // stays where it is.
  const primary = button(page, '我现在该做什么')
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(10_000)
  assert.equal(deck.reads.length, 299)
  assert.equal(page.document.querySelector('.dk-rec'), null)
  assert.equal(primary.isConnected, true)

  // Asked again once stopped, it waits anew.
  await page.click(button(page, '我现在该做什么'))
  assert.deepEqual(prefills(page), [prefilled(promptOf(1)), prefilled(promptOf(2))])
  assert.deepEqual(nextTab(page).said, ['已填入输入框，等你发送。'])
  await page.advance(2_000)
  assert.deepEqual(deck.reads.slice(299), ['request-2'])
})

test('"再问一次" makes a new request and waits for it alone; asked while one waits, it says to delete the copy before', async t => {
  const deck = deckThatRecommends()
  const page = await openNext(deck)
  t.after(page.close)
  await page.click(button(page, '我现在该做什么'))
  await page.advance(2_000)

  await page.click(button(page, '再问一次'))
  assert.deepEqual(prefills(page), [prefilled(promptOf(1)), prefilled(promptOf(2))])
  assert.deepEqual(nextTab(page), {
    shown: true,
    phases: ['+已填入', '>等待回报', '已回答'],
    said: ['已重新填入。输入框里上一份还在的话，先删掉再发送。'],
    buttons: ['再问一次'],
  })

  // The first request's report, come after the second was asked, is not
  // shown; nor is it read again.
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  assert.deepEqual(deck.reads, ['request-1', 'request-2'])
  assert.equal(page.document.querySelector('.dk-rec'), null)
  // Ten minutes count from the second request.
  await page.advance(594_000)
  assert.equal(nextTab(page).phases[1], '>等待回报')

  deck.reported.set('request-2', { ...RECOMMENDATION, task: 74 })
  await page.advance(2_000)
  assert.deepEqual(parts(page.document.querySelector('.dk-rec__head'), 'span'), ['下一个成就', '执行与 Occupancy 登记', '#74'])

  // Asked again once answered, it waits with nothing to delete.
  await page.click(button(page, '再问一次'))
  assert.deepEqual(nextTab(page).said, ['已填入输入框，等你发送。'])
  assert.equal(page.document.querySelector('.dk-rec'), null)
})

test('a report read late, after the request was asked again, is not shown', async t => {
  // The read of the first request answers only once the second is asked.
  let release: () => void = () => {}
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) =>
      name === 'deck_recommendation' && args.requestId === 'request-1'
        ? new Promise(resolve => {
            release = () => resolve(answered({ found: true, recommendation: RECOMMENDATION }))
          })
        : deck.answer(name, args),
  })
  t.after(page.close)
  await page.click(button(page, '我现在该做什么'))
  // While the read is held, the page is never settled: wait a moment.
  const moment = () => new Promise(resolve => setTimeout(resolve, 20))
  const reading = page.advance(2_000)
  await moment()
  ;(button(page, '再问一次') as HTMLElement).click()
  await moment()
  release()
  await reading

  assert.equal(page.document.querySelector('.dk-rec'), null)
  assert.deepEqual(nextTab(page).said, ['已重新填入。输入框里上一份还在的话，先删掉再发送。'])
})

test('a Recommendation\'s fields are shown as the agent wrote them, "无" where empty, and a Task the list does not hold by its number', async t => {
  const deck = deckThatRecommends()
  const page = await openNext(deck)
  t.after(page.close)
  const answer = async (recommendation: object) => {
    await page.click(button(page, page.document.querySelector('.dk-rec') === null ? '我现在该做什么' : '再问一次'))
    deck.reported.set(`request-${prefills(page).length}`, recommendation)
    await page.advance(2_000)
  }

  await answer({ task: null, nextStep: '', skill: '', reason: '', blockers: '' })
  assert.deepEqual(parts(page.document.querySelector('.dk-rec__head'), 'span'), ['下一个成就', '无'])
  assert.equal(page.document.querySelector('.dk-rec__head .dk-plate'), null)
  assert.deepEqual(fields(page), ['下一步', '无', '技能', '无', '理由', '无', '阻塞', '无'])
  assert.equal(page.document.querySelector('.dk-rec__fields .mono'), null)

  await answer({ task: 999, nextStep: '<b>先</b>读 `x`', skill: '<i>$tdd</i>', reason: '**粗**', blockers: '被 <em>#1</em> 挡着' })
  assert.deepEqual(parts(page.document.querySelector('.dk-rec__head'), 'span'), ['下一个成就', '任务列表里没有这个 Task', '#999'])
  assert.deepEqual(fields(page), [
    '下一步',
    '<b>先</b>读 `x`',
    '技能',
    '<i>$tdd</i>',
    '理由',
    '**粗**',
    '阻塞',
    '被 <em>#1</em> 挡着',
  ])
  assert.equal(page.document.querySelectorAll('.dk-rec b, .dk-rec i, .dk-rec em, .dk-rec code').length, 0)

  // A Task's title from the list, as text too; a Task in progress by its state.
  await answer({ ...RECOMMENDATION, task: 72 })
  assert.equal(page.document.querySelector('.dk-rec__head .dk-plate')!.getAttribute('aria-label'), '进行中 · 其他 Session')
  // A Spec the list holds by its title.
  await answer({ ...RECOMMENDATION, task: 64 })
  assert.deepEqual(parts(page.document.querySelector('.dk-rec__head'), 'span'), ['下一个成就', '规格：里程碑二', '#64'])
})

test('a read of the Recommendation that fails leaves the Pane waiting, and the next read shows it', async t => {
  let failing = true
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) =>
      name === 'deck_recommendation' && failing
        ? { content: [{ type: 'text', text: 'the state is locked' }], isError: true }
        : deck.answer(name, args),
  })
  t.after(page.close)
  await page.click(button(page, '我现在该做什么'))
  deck.reported.set('request-1', RECOMMENDATION)

  await page.advance(2_000)
  assert.deepEqual(nextTab(page).phases, ['+已填入', '>等待回报', '已回答'])
  failing = false
  await page.advance(2_000)
  assert.deepEqual(nextTab(page).phases, ['+已填入', '+等待回报', '+已回答'])
})

test('when the skills cannot be read, "我现在该做什么" is on, and the Deck service says why it cannot make the request', async t => {
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) =>
      name === 'deck_skills'
        ? { content: [{ type: 'text', text: 'the Skill Source is gone' }], isError: true }
        : name === 'deck_ask'
          ? answered({ ok: false, failure: { kind: 'missing', message: 'the directory ~/x does not exist' } })
          : deck.answer(name, args),
  })
  t.after(page.close)

  assert.deepEqual(nextTab(page).buttons, ['我现在该做什么'])
  await page.click(button(page, '我现在该做什么'))
  assert.deepEqual(nextTab(page).said.slice(0, 2), ['没有填入推荐请求', '找不到 Skill Source。重跑配置之后恢复。'])
})

test('a Recommendation\'s Task title is shown as text', async t => {
  const tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [task(70, '<b>Task</b> 详情')] } }
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) => (name === 'deck_tasks' ? answered(tasks) : deck.answer(name, args)),
  })
  t.after(page.close)
  await page.click(button(page, '我现在该做什么'))
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)

  assert.equal(page.document.querySelector('.dk-rec__title')!.textContent, '<b>Task</b> 详情')
})

test('the reads every 60 seconds, as the tab is shown again and on "刷新" leave the request waiting and its Recommendation shown', async t => {
  const deck = deckThatRecommends()
  const page = await openNext(deck)
  t.after(page.close)
  const refresh = page.document.querySelector('.dk-head button')!
  await page.click(button(page, '我现在该做什么'))
  await page.click(button(page, '再问一次'))
  const waiting = nextTab(page)

  await page.advance(58_000)
  await page.show(false)
  await page.show(true)
  await page.click(refresh)
  assert.deepEqual(nextTab(page), waiting)

  deck.reported.set('request-2', RECOMMENDATION)
  await page.advance(2_000)
  const answeredTab = nextTab(page)
  const card = text(page.document.querySelector('.dk-rec'))
  await page.advance(60_000)
  await page.show(false)
  await page.show(true)
  await page.click(refresh)
  assert.deepEqual(nextTab(page), answeredTab)
  assert.equal(text(page.document.querySelector('.dk-rec')), card)
})

test('when Codex does not run this ask-matt, "我现在该做什么" is off and says why, with "重跑配置"', async t => {
  for (const [copy, why] of [
    ['different', 'Codex 里的 ask-matt 不是同一份，不能预填。'],
    ['missing', 'Codex 里找不到 ask-matt，不能预填。'],
  ]) {
    const deck = deckThatRecommends(SKILLS.map(skill => (skill.name === 'ask-matt' ? { ...skill, copy } : skill)))
    const page = await openNext(deck)
    t.after(page.close)

    assert.deepEqual(nextTab(page), { shown: true, phases: [], said: [why], buttons: ['我现在该做什么（停用）', '重跑配置'] })
    await page.click(button(page, '我现在该做什么'))
    await page.click(button(page, '重跑配置'))
    assert.deepEqual(prefills(page), [prefilled(CONFIGURE_CALL)])
  }
})

test('"我现在该做什么" is off until the skills are read, and on again once a read finds ask-matt the same file', async t => {
  let reads = 0
  // The 下一步 tab as the page shows it while the first read of the skills
  // is not answered: the person opens the tab then.
  let whileReading: ReturnType<typeof nextTab> | undefined
  const deck = deckThatRecommends()
  const page = await openPage({
    answer: async (name: string, args: any, document: Document) => {
      if (name !== 'deck_skills') return deck.answer(name, args)
      reads++
      if (reads === 1) {
        ;([...document.querySelectorAll('[role="tab"]')].find(tab => text(tab) === '下一步') as HTMLElement).click()
        await new Promise(resolve => setTimeout(resolve, 20))
        whileReading = nextTab({ document, window: document.defaultView })
      }
      return deckWithSkills(SKILLS.map(skill => (skill.name === 'ask-matt' && reads === 2 ? { ...skill, copy: 'missing' } : skill)))(name, args)
    },
  })
  t.after(page.close)

  assert.deepEqual(whileReading?.buttons, ['我现在该做什么（停用）'])
  assert.equal(reads, 1)
  assert.deepEqual(nextTab(page).buttons, ['我现在该做什么'])
  // "刷新" on this tab reads the skills again.
  await page.click(page.document.querySelector('.dk-head button'))
  assert.equal(reads, 2)
  assert.deepEqual(nextTab(page).buttons, ['我现在该做什么（停用）', '重跑配置'])
  // Shown again without a "刷新" in between, the tab reads no skills.
  const tabs = [...page.document.querySelectorAll('[role="tab"]')]
  await page.click(tabs[1]!)
  await page.click(tabs[0]!)
  assert.equal(reads, 2)
})

test('when the Deck service cannot make the request the 下一步 tab says why in its own words, to click the button again, and nothing is prefilled', async t => {
  let failure: object = {}
  let asks = 0
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) => {
      if (name !== 'deck_ask') return deck.answer(name, args)
      asks++
      return failure
    },
  })
  t.after(page.close)
  const fail = async (answer: object) => {
    failure = answer
    await page.click(button(page, '我现在该做什么'))
    return nextTab(page)
  }
  const failedAs = async (kind: string, message: string) => (await fail(answered({ ok: false, failure: { kind, message } }))).said[1]

  assert.deepEqual(await fail(answered({ ok: false, failure: { kind: 'offline', message: 'dial tcp 9z' } })), {
    shown: true,
    phases: [],
    said: ['没有填入推荐请求', '连不上 GitHub。检查网络后再点“我现在该做什么”重试。', '把 $ask-matt 填进输入框，附带 Task Snapshot。'],
    buttons: ['我现在该做什么'],
  })
  assert.equal(await failedAs('unauthenticated', 'not logged in 4k'), 'gh 未登录。运行 gh auth login 后再点“我现在该做什么”重试。')
  assert.equal(await failedAs('gh-missing', 'no gh 4k'), '找不到 gh 命令。安装 GitHub CLI 后再点“我现在该做什么”重试。')
  assert.equal(await failedAs('no-repository', 'no remote 4k'), '这个 Workspace 没有指向 GitHub 的 remote，读不到 Issues。')
  // The reason the Deck service gives stays as it is, even where it looks
  // like the Pane's own words.
  assert.equal(await failedAs('failed', 'HTTP 502, 点“刷新”重试。'), 'gh 出错：HTTP 502, 点“刷新”重试。。再点“我现在该做什么”重试。')
  assert.equal(await failedAs('unknown-skill', 'the Skill Source has no skill named ask-matt'), 'Skill Source 里已经没有这个技能。再点“我现在该做什么”重试。')
  assert.equal(await failedAs('missing', 'the directory ~/x does not exist'), '找不到 Skill Source。重跑配置之后恢复。')
  assert.deepEqual(
    (await fail({ content: [{ type: 'text', text: 'the state is locked 6w1p' }], isError: true })).said[1],
    'Deck 服务出错：the state is locked 6w1p。再点“我现在该做什么”重试。',
  )
  assert.deepEqual(prefills(page), [])
  // The timed read leaves the notice as it is, drawn again as the tab is.
  await page.advance(60_000)
  await page.click(page.document.querySelectorAll('[role="tab"]')[1]!)
  await page.click(page.document.querySelectorAll('[role="tab"]')[0]!)
  assert.equal(nextTab(page).said[0], '没有填入推荐请求')
  // "刷新" reads the page again, and the notice of a request that was not
  // made goes; it makes no request.
  assert.equal(asks, 8)
  await page.click(page.document.querySelector('.dk-head button'))
  assert.deepEqual(nextTab(page).said, ['把 $ask-matt 填进输入框，附带 Task Snapshot。'])
  assert.equal(asks, 8)
  await fail(answered({ ok: false, failure: { kind: 'offline', message: 'dial tcp 9z' } }))
  // Away on another tab "刷新" takes it away too.
  const tabs = [...page.document.querySelectorAll('[role="tab"]')]
  await page.click(tabs[1]!)
  await page.click(page.document.querySelector('.dk-head button'))
  await page.click(tabs[0]!)
  assert.deepEqual(nextTab(page).said, ['把 $ask-matt 填进输入框，附带 Task Snapshot。'])
  await page.advance(10_000)
  assert.deepEqual(deck.reads, [])

  // A request made after that says nothing of the one that was not.
  failure = deck.answer('deck_ask', {})
  await page.click(button(page, '我现在该做什么'))
  assert.deepEqual(nextTab(page).said, ['已填入输入框，等你发送。'])
})

test('while the Deck service makes the request, the button clicked is off, so a second click makes no second request', async t => {
  let release: () => void = () => {}
  let asks = 0
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) => {
      if (name !== 'deck_ask') return deck.answer(name, args)
      asks++
      const answer = deck.answer(name, args)
      return new Promise(resolve => (release = () => resolve(answer)))
    },
  })
  t.after(page.close)
  const moment = () => new Promise(resolve => setTimeout(resolve, 20))

  const primary = button(page, '我现在该做什么') as HTMLButtonElement
  primary.click()
  await moment()
  assert.equal(primary.disabled, true)
  primary.click()
  await moment()
  release()
  await page.settled()
  assert.equal(asks, 1)
  assert.deepEqual(prefills(page), [prefilled(promptOf(1))])
})

test('"再问一次" that cannot make a request says why and keeps waiting for the request before', async t => {
  let fails = false
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) =>
      name === 'deck_ask' && fails ? answered({ ok: false, failure: { kind: 'offline', message: 'dial tcp 9z' } }) : deck.answer(name, args),
  })
  t.after(page.close)
  await page.click(button(page, '我现在该做什么'))
  fails = true
  await page.click(button(page, '再问一次'))

  assert.deepEqual(nextTab(page), {
    shown: true,
    phases: ['+已填入', '>等待回报', '已回答'],
    said: ['没有填入推荐请求', '连不上 GitHub。检查网络后再点“再问一次”重试。', '已填入输入框，等你发送。'],
    buttons: ['再问一次'],
  })
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  assert.deepEqual(parts(page.document.querySelector('.dk-rec__head'), 'span'), ['下一个成就', 'Task 详情', '#70'])

  // Once answered, the notice is gone; a request that fails then says to
  // click "再问一次" again, over the Recommendation still shown.
  assert.deepEqual(nextTab(page).said, [])
  await page.click(button(page, '再问一次'))
  assert.deepEqual(nextTab(page).said, ['没有填入推荐请求', '连不上 GitHub。检查网络后再点“再问一次”重试。'])
  assert.notEqual(page.document.querySelector('.dk-rec'), null)
})

test('a Recommendation shown follows the list as the timed reads find it: "执行这个 Task" goes with its Task, and "再问一次" stays', async t => {
  let tasks: any = TASKS
  const deck = deckThatRecommends()
  const page = await openNext({ answer: (name: string, args: any) => (name === 'deck_tasks' ? answered(tasks) : deck.answer(name, args)) })
  t.after(page.close)
  const card = () => [
    page.document.querySelector('.dk-rec__head .dk-plate')!.getAttribute('aria-label'),
    text(page.document.querySelector('.dk-rec__title')),
  ]
  await page.click(button(page, '我现在该做什么'))
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  assert.deepEqual(card(), ['可执行', 'Task 详情'])
  const again = button(page, '再问一次')
  const before = nextTab(page)
  assert.deepEqual(before.buttons, ['执行这个 Task', '再问一次'])
  // The card's "执行这个 Task" goes with the Task: kept for a Task another
  // Session holds, to be taken over first; none for a closed one.
  const after = { ...before, buttons: ['再问一次'] }

  // #70, renamed, taken by another Session.
  const taken = task(70, 'Task 详情 9h2c', { occupant: OTHER_CODEX, occupantHost: 'codex', occupantShort: '77e0aa15' })
  tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [], inProgress: [taken, ...TASKS.groups.inProgress] } }
  await page.advance(58_000)
  assert.deepEqual(card(), ['进行中 · 其他 Session', 'Task 详情 9h2c'])
  assert.equal(again.isConnected, true)
  assert.deepEqual(nextTab(page), before)

  // Closed, as the tab is shown again.
  tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [], done: [task(70, 'Task 详情 5r7w', { isOpen: false, closedAt: '2026-11-22T09:01:00Z' }), ...TASKS.groups.done] } }
  await page.show(false)
  await page.show(true)
  assert.deepEqual(card(), ['已解锁', 'Task 详情 5r7w'])
  assert.equal(again.isConnected, true)
  assert.deepEqual(nextTab(page), after)
  assert.equal(deck.reads.length, 1)
})

// A row of the "任务" tab by its Task's number.
const rowOf = (document: Document, number: number) =>
  [...document.querySelectorAll('.dk-row')].find(row => text(row.querySelector('.dk-id')) === `#${number}`)!

// What the detail shows: the way back, then the Task, section by section.
const detailShown = (page: { window: any; document: Document }) => {
  const bar = page.document.querySelector('.dk-bar')!
  if (!shown(page, bar)) return undefined
  // While it is being read, or when its read fails, there is no Task to show.
  const detailOf = page.document.querySelector('.dk-detail')
  return {
    crumbs: text(bar.querySelector('.dk-crumbs')),
    bar: [...bar.querySelectorAll('button')].filter(each => shown(page, each)).map(text),
    title: text(detailOf?.querySelector('.dk-detail__title') ?? null),
    meta: [...(detailOf?.querySelector('.dk-detail__meta')?.children ?? [])].map(text),
    sections: [...(detailOf?.querySelectorAll('.dk-section') ?? [])].map(section => [
      text(section.querySelector('.dk-section__head')),
      ...[...section.querySelector('.dk-section__head')!.parentElement!.children].slice(1).map(text),
    ]),
  }
}

test('a row opens its Task\'s detail in place of the list, and "返回" goes back to the list as it was, filter and scroll', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  const listShown = () => shown(page, document.querySelector('.dk-filter'))

  await page.click(document.querySelectorAll('.dk-filter__chip')[3]!)
  page.scroll(480)
  await page.click(rowOf(document, 73))

  assert.equal(listShown(), false)
  assert.equal(detailShown(page)?.crumbs, '任务 / #73')
  assert.equal(detailShown(page)?.title, '#73 推荐：我现在该做什么')
  assert.deepEqual(page.sent.filter(message => message.params?.name === 'deck_task').map(({ params }) => params.arguments), [{ number: 73 }])
  // The detail starts at its top; the head and the tabs stay.
  assert.equal(page.scrolled(), 0)
  assert.equal(shown(page, document.querySelector('[role="tablist"]')), true)

  await page.click([...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)
  assert.equal(detailShown(page), undefined)
  assert.equal(listShown(), true)
  assert.deepEqual(filterShown(document)[1], ['阻塞 2'])
  assert.equal(page.scrolled(), 480)
})

test('the detail shows the Task\'s state, triage label, assignees and time, its description and acceptance criteria, as the Task Source gives them', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page

  await page.click(rowOf(document, 70))
  assert.deepEqual(detailShown(page), {
    crumbs: '任务 / #70',
    bar: ['返回', '执行', '在 GitHub 打开'],
    title: '#70 Task 详情',
    meta: ['可执行', 'ready-for-human', 'x9ggg, someone', '更新 11-21'],
    sections: [
      ['描述', '从任务列表点开一个 Task。 再返回列表。'],
      ['验收条件', '返回到原来的位置 来路变长'],
      ['执行记录', '还没有 Session 执行过这个 Task。'],
    ],
  })
  // The description keeps its lines; a checked criterion is drawn checked.
  assert.equal(document.querySelector('.dk-detail .dk-prose p')!.textContent, '从任务列表点开一个 Task。\n\n再返回列表。')
  assert.equal(page.window.getComputedStyle(document.querySelector('.dk-detail .dk-prose p')!).whiteSpace, 'pre-wrap')
  assert.deepEqual([...document.querySelectorAll('.dk-detail li')].map(li => li.classList.contains('is-checked')), [true, false])
  // The number in the state's colour, as in its row.
  const colour = (element: Element | null) => page.window.getComputedStyle(element!).color
  assert.equal(colour(document.querySelector('.dk-detail__title .dk-id')), 'rgb(87, 184, 242)')
  assert.equal(colour(document.querySelector('.dk-detail__meta .dk-badge')), 'rgb(87, 184, 242)')
  // The badge's glyph is the one its row shows; the way's last step stands out.
  const glyph = (element: Element | null) => element!.querySelector('svg')!.innerHTML
  assert.equal(glyph(document.querySelector('.dk-detail__meta .dk-badge')), glyph(rowOf(document, 70).querySelector('.dk-plate')))
  assert.equal(text(document.querySelector('.dk-crumbs b')), '#70')
})

test('a Task waiting on a person shows the label it waits on and no state; a report with no Acceptance Evidence marks none', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const back = () => page.click([...page.document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)

  await page.click(rowOf(page.document, 19))
  assert.deepEqual(detailShown(page)!.meta, ['needs-triage', '未指派', '更新 11-21'])
  await back()
  await page.click(rowOf(page.document, 72))
  assert.deepEqual(detailShown(page)!.meta, ['进行中 · 77e0aa15', 'ready-for-agent', '未指派', '更新 11-21'])
  assert.deepEqual(detailShown(page)!.sections.at(-1), ['执行记录', 'Session 77e0aa15 11-22 07:00 做了一半。'])
})

test('a Task with no assignee, no description and no acceptance criteria says so; a closed one says when it closed', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)

  await page.click(rowOf(page.document, 66))
  const shownDetail = detailShown(page)!
  assert.deepEqual(shownDetail.meta, ['已解锁', '验收证据', 'ready-for-agent', '未指派', '关闭 11-22 01:40'])
  assert.deepEqual(shownDetail.sections.slice(0, 2), [
    ['描述', '没有描述。'],
    ['验收条件', '正文里没有验收条件。'],
  ])
})

test('the execution record shows each report: its Session as the Pane names it, when, the result, and its Acceptance Evidence with where it comes from', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)

  await page.click(rowOf(page.document, 66))
  const items = [...page.document.querySelectorAll('.dk-log__item')]
  assert.deepEqual(
    items.map(item => [...item.children].map(text)),
    [
      [
        'Session 045b96fc 11-22 01:38',
        '页面在标签页里打开。',
        '验收证据：npm test 全部通过（来自 npm test）',
        '验收证据：标签页能切换（来自 commit edaa839）',
      ],
      ['Session 77e0aa15 11-21 23:05', '重新跑了一遍测试。'],
      ['Claude Code 3f9c21d0 11-21 22:00', '预先重构。'],
    ],
  )
  // Each Acceptance Evidence, the detail's badge and the row's mark carry the check.
  const check = (element: Element | null) => element!.querySelector('svg')!.innerHTML
  const glyphs = [...items[0]!.querySelectorAll('.is-pass'), page.document.querySelector('.dk-detail__meta .is-evidence')]
  assert.deepEqual(new Set(glyphs.map(check)).size, 1)
  assert.equal(check(rowOf(page.document, 66).querySelector('.is-pass')), check(glyphs[0]!))
})

test('"被阻塞" lists each blocker by its own state; clicked, the way grows, and "返回" goes back one step at a time', async t => {
  // Each scroll of the page and the title shown as it scrolls: a step's
  // content must be there before the page scrolls to where it was.
  const scrolls: [number, string | undefined][] = []
  const page = await openPage({
    answer: deckAt('/work/matt-deck'),
    onScroll: (y, document) => scrolls.push([y, text(document.querySelector('#into:not([hidden]) .dk-detail__title'))]),
  })
  t.after(page.close)
  const { document } = page
  const back = () => page.click([...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)
  const edges = () =>
    [...document.querySelectorAll('.dk-detail .dk-edge')].map(edge => [edge.querySelector('[role="img"]')!.getAttribute('aria-label'), text(edge)])

  page.scroll(300)
  await page.click(rowOf(document, 73))
  assert.deepEqual(detailShown(page)!.sections[2], ['被阻塞 2', '#72 Matt 技能', '#70 Task 详情'])
  assert.deepEqual(edges(), [
    ['进行中 · 其他 Session', '#72 Matt 技能'],
    ['可执行', '#70 Task 详情'],
  ])
  assert.equal(page.window.getComputedStyle(document.querySelector('.dk-detail .dk-edge')!).cursor, 'pointer')
  // Each blocker's glyph, and the colours of its glyph and number, are those
  // of its row in the list.
  const colour = (element: Element) => page.window.getComputedStyle(element).color
  const drawn = (glyph: Element, id: Element) => [glyph.querySelector('svg')!.innerHTML, colour(glyph.querySelector('svg')!), colour(id)]
  for (const edge of document.querySelectorAll('.dk-detail .dk-edge')) {
    const row = rowOf(document, Number(text(edge.querySelector('.dk-id'))!.slice(1)))
    assert.deepEqual(
      drawn(edge.querySelector('[role="img"]')!, edge.querySelector('.dk-id')!),
      drawn(row.querySelector('.dk-plate')!, row.querySelector('.dk-id')!),
    )
  }

  page.scroll(120)
  await page.click(document.querySelector('.dk-detail .dk-edge'))
  assert.equal(detailShown(page)!.crumbs, '任务 / #73 / #72')
  assert.equal(detailShown(page)!.title, '#72 Matt 技能')
  assert.equal(page.scrolled(), 0)
  // A Task blocked by none draws no "被阻塞".
  assert.deepEqual(detailShown(page)!.sections.map(([head]) => head), ['描述', '验收条件', '执行记录'])

  await back()
  assert.equal(detailShown(page)!.crumbs, '任务 / #73')
  assert.equal(detailShown(page)!.title, '#73 推荐：我现在该做什么')
  assert.equal(page.scrolled(), 120)
  assert.deepEqual(scrolls.at(-1), [120, '#73 推荐：我现在该做什么'])
  await back()
  assert.equal(detailShown(page), undefined)
  assert.equal(page.scrolled(), 300)
})

test('"在 GitHub 打开" asks the Host to open the Task\'s page at the address the Deck service gives', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)

  await page.click(rowOf(page.document, 70))
  await page.click([...page.document.querySelectorAll('.dk-bar button')].find(each => text(each) === '在 GitHub 打开')!)
  assert.deepEqual(
    page.sent.filter(message => message.method === 'ui/open-link').map(({ params }) => params),
    [{ url: 'https://tasks.example/as-the-deck-service-says/70' }],
  )
})

test('a Spec\'s row opens its detail too', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)

  await page.click(page.document.querySelector('.dk-row--container'))
  assert.equal(detailShown(page)!.crumbs, '任务 / #64')
  assert.equal(detailShown(page)!.title, '#64 规格：里程碑二')
  // Its row is marked by its Orphaned Child Task; its detail says its own
  // state as a Task.
  assert.equal(rowOf(page.document, 64).querySelector('.dk-plate')!.getAttribute('aria-label'), 'Orphaned')
  assert.deepEqual(detailShown(page)!.meta, ['可执行', '未指派', '更新 11-21'])
})

test('another tab leaves the detail: back on "任务" the list is shown', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const tab = (name: string) => [...page.document.querySelectorAll('[role="tab"]')].find(each => text(each) === name)!

  await page.click(rowOf(page.document, 70))
  await page.click(tab('地图'))
  assert.equal(detailShown(page), undefined)
  assert.equal(shown(page, page.document.querySelector('.dk-filter')), false)
  await page.click(tab('任务'))
  assert.equal(detailShown(page), undefined)
  assert.equal(shown(page, page.document.querySelector('.dk-filter')), true)
})

test('until deck_task answers the detail says it is reading the Task; when it fails, why', async t => {
  const answer = deckAt('/work/matt-deck')
  let failure: object | undefined
  let whileReading: unknown
  const page = await openPage({
    answer: (name, args: any, document) => {
      if (name !== 'deck_task') return answer(name, args)
      whileReading = [...document.querySelectorAll('.dk-why')].filter(each => !each.closest('[hidden]')).map(text)
      return failure ?? answer(name, args)
    },
  })
  t.after(page.close)
  const notice = () => {
    const shownNotice = [...page.document.querySelectorAll('.dk-notice.is-danger')].find(each => shown(page, each))
    return shownNotice && [text(shownNotice.querySelector('.dk-notice__title')), text(shownNotice.querySelector('.dk-notice__text'))]
  }

  failure = answered({ ok: false, failure: { kind: 'offline', message: 'dial tcp' } })
  await page.click(rowOf(page.document, 70))
  assert.deepEqual(whileReading, ['正在读取 #70…'])
  assert.deepEqual(notice(), ['读取 #70 失败', '连不上 GitHub。检查网络后点“刷新”重试。'])
  // Nothing read, nothing to open.
  assert.deepEqual(detailShown(page)!.bar, ['返回'])

  failure = { content: [{ type: 'text', text: 'database is locked' }], isError: true }
  await page.click(page.document.querySelector('.dk-head button'))
  assert.deepEqual(notice(), ['读取 #70 失败', 'Deck 服务出错：database is locked。点“刷新”重试。'])

  failure = undefined
  await page.click(page.document.querySelector('.dk-head button'))
  assert.equal(notice(), undefined)
  assert.equal(detailShown(page)!.title, '#70 Task 详情')
})

test('each read of the Pane reads the detail shown again, which stays shown, and shows what it read before until the new read answers', async t => {
  const answer = deckAt('/work/matt-deck')
  let title = 'Task 详情'
  let whileReading: unknown
  const page = await openPage({
    answer: (name, args: any, document) => {
      if (name !== 'deck_task') return answer(name, args)
      whileReading = text(document.querySelector('.dk-detail__title'))
      const read: any = answer(name, args)
      return answered({ ...read.structuredContent, task: { ...read.structuredContent.task, title } })
    },
  })
  t.after(page.close)
  const reads = () => page.sent.filter(message => message.params?.name === 'deck_task').length

  await page.click(rowOf(page.document, 70))
  assert.equal(reads(), 1)
  title = 'Task 详情，改过'
  await page.advance(60_000)
  assert.equal(reads(), 2)
  assert.equal(whileReading, '#70 Task 详情')
  assert.equal(detailShown(page)!.title, '#70 Task 详情，改过')
  assert.equal(shown(page, page.document.querySelector('.dk-filter')), false)
})

test('a Task the list no longer holds still shows what deck_task reads, with no state', async t => {
  let tasks: object = TASKS
  const page = await openPage({ answer: (name, args) => deckAt('/work/matt-deck', true, tasks)(name, args) })
  t.after(page.close)

  await page.click(rowOf(page.document, 70))
  tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [] } }
  await page.click(page.document.querySelector('.dk-head button'))
  assert.equal(detailShown(page)!.title, '#70 Task 详情')
  assert.deepEqual(detailShown(page)!.meta, ['ready-for-human', 'x9ggg, someone', '更新 11-21'])
  assert.equal(page.document.querySelector('.dk-detail__title .dk-id')!.className, 'dk-id')
})

test('what the Task Source and the reports say is shown as text, never read as the page\'s own markup', async t => {
  const answer = deckAt('/work/matt-deck')
  const markup = '<b>粗</b> <img src=x onerror="window.ran=1">'
  const page = await openPage({
    answer: (name, args: any) =>
      name === 'deck_task'
        ? answered({
            ...(DETAILS[66] as any),
            task: { ...(DETAILS[66] as any).task, title: markup, description: markup, acceptance: [{ text: markup, isChecked: false }] },
            reports: [{ ...(DETAILS[66] as any).reports[0], result: markup, evidence: [{ text: markup, source: markup }] }],
          })
        : answer(name, args),
  })
  t.after(page.close)

  await page.click(rowOf(page.document, 66))
  const detailOf = page.document.querySelector('.dk-detail')!
  assert.equal(detailOf.querySelector('b, img'), null)
  assert.equal(text(detailOf.querySelector('.dk-detail__title')), `#66 ${markup}`)
  assert.equal(text(detailOf.querySelector('.dk-log__text')), markup)
})

test('a detail read that answers after the way has gone back from it does not take the place of what is shown', async t => {
  const answer = deckAt('/work/matt-deck')
  let hold: Promise<void> | undefined
  const page = await openPage({
    answer: async (name, args: any) => {
      if (name === 'deck_task' && args.number === 72) await hold
      return answer(name, args)
    },
  })
  t.after(page.close)
  const { document } = page

  await page.click(rowOf(document, 73))
  let release!: () => void
  hold = new Promise(resolve => (release = resolve))
  ;(document.querySelector('.dk-detail .dk-edge') as HTMLElement).click()
  await new Promise(resolve => setTimeout(resolve, 20))
  // Clicked while #72's read is open, so not waiting for every answer.
  ;([...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回') as HTMLElement).click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(detailShown(page)!.title, '#73 推荐：我现在该做什么')
  release()
  await page.settled()
  assert.equal(detailShown(page)!.crumbs, '任务 / #73')
  assert.equal(detailShown(page)!.title, '#73 推荐：我现在该做什么')
})

test('a project no longer configured shows no detail', async t => {
  let configured = true
  const page = await openPage({ answer: (name, args) => deckAt('/work/matt-deck', configured)(name, args) })
  t.after(page.close)

  await page.click(rowOf(page.document, 70))
  configured = false
  await page.click(page.document.querySelector('.dk-head button'))
  assert.equal(detailShown(page), undefined)
  assert.equal(shown(page, page.document.querySelector('#unconfigured')), true)
})

test('a skill\'s text goes the way a Task\'s detail goes: "刷新" reads it and the list under it again, and "返回" goes back to where the list was scrolled', async t => {
  const page = await openSkills()
  t.after(page.close)
  const { document } = page
  const row = (call: string) => [...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === call)!
  const called = (name: string) => page.sent.filter(message => message.params?.name === name).length

  page.scroll(260)
  await page.click(row(IMPLEMENT))
  assert.equal(page.scrolled(), 0)
  assert.equal(text(document.querySelector('.dk-crumbs b')), IMPLEMENT)
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual([called('deck_skills'), called('deck_skill')], [2, 2])
  assert.equal(text(document.querySelector('.dk-detail .dk-skill__name')), IMPLEMENT)

  await page.click([...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)
  assert.equal(shown(page, row(IMPLEMENT)), true)
  assert.equal(page.scrolled(), 260)
})

test('"刷新" with a skill\'s text open draws its "预填" by what the new read of the skills says of it: off when Codex no longer finds the same file, or the skill is gone; on again when it does', async t => {
  // What the Deck service lists as the test sets it; the text is read the same.
  let listed: object[] = SKILLS
  const page = await openSkills((name: string, args: any) =>
    name === 'deck_skill' ? deckWithSkills()(name, args) : deckWithSkills(listed)(name, args),
  )
  t.after(page.close)
  const { document } = page
  const prefillShown = () => [...document.querySelectorAll<HTMLButtonElement>('.dk-bar button')].find(each => text(each) === '预填')!
  const refresh = () => page.click(document.querySelector('.dk-head button'))
  const implement = (more: object) => SKILLS.map((skill: any) => (skill.name === 'implement' ? { ...skill, ...more } : skill))

  await page.click([...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === IMPLEMENT)!)
  assert.equal(prefillShown().disabled, false)

  listed = implement({ copy: 'different' })
  await refresh()
  assert.equal(prefillShown().disabled, true)
  await page.click(prefillShown())
  assert.deepEqual(prefills(page), [])

  listed = SKILLS.filter((skill: any) => skill.name !== 'implement')
  await refresh()
  assert.equal(prefillShown().disabled, true)

  listed = SKILLS
  await refresh()
  assert.equal(prefillShown().disabled, false)
  await page.click(prefillShown())
  assert.deepEqual(prefills(page), [prefilled(IMPLEMENT)])
})

test('the detail\'s state badge is drawn in its state\'s pair of colours, its words readable on it, dark and light', async t => {
  // Each state's badge as the layout draws it: the colour of its words, and
  // its ground ('transparent' where it has none).
  const PAIRS = {
    dark: {
      70: ['rgb(87, 184, 242)', 'transparent'],
      74: ['rgb(87, 184, 242)', 'transparent'],
      72: ['rgb(163, 181, 199)', 'transparent'],
      69: ['rgb(163, 181, 199)', 'transparent'],
      75: ['rgb(245, 154, 74)', 'transparent'],
      73: ['rgb(129, 149, 169)', 'transparent'],
      66: ['rgb(28, 19, 0)', 'rgb(242, 193, 78)'],
    },
    light: {
      70: ['rgb(20, 99, 159)', 'transparent'],
      74: ['rgb(20, 99, 159)', 'transparent'],
      72: ['rgb(70, 87, 104)', 'transparent'],
      69: ['rgb(70, 87, 104)', 'transparent'],
      75: ['rgb(168, 74, 6)', 'transparent'],
      73: ['rgb(90, 107, 125)', 'transparent'],
      66: ['rgb(255, 255, 255)', 'rgb(130, 91, 0)'],
    },
  }
  for (const theme of ['dark', 'light'] as const) {
    const page = await openPage({ answer: deckAt('/work/matt-deck'), hostContext: { theme } })
    t.after(page.close)
    const style = (element: Element) => page.window.getComputedStyle(element)
    const seen: Record<string, string[]> = {}
    for (const number of Object.keys(PAIRS[theme])) {
      await page.click(rowOf(page.document, Number(number)))
      const badge = page.document.querySelector('.dk-detail__meta .dk-badge')!
      // Every element of the badge that holds words of its own.
      const words = [badge, ...badge.querySelectorAll('*')].filter(each =>
        [...each.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim() !== ''),
      )
      const colours = [...new Set(words.map(each => style(each).color))]
      const ground = style(badge).backgroundColor
      seen[number] = [colours.join(' '), ground === 'rgba(0, 0, 0, 0)' ? 'transparent' : ground]
      await page.click([...page.document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)
    }
    assert.deepEqual(seen, PAIRS[theme], theme)
  }
})

test('"刷新" with a skill\'s text open turns its "预填" off when the Skill Source cannot be read, and on again once it is read', async t => {
  // How the Deck service answers deck_skills, as the test sets it; the text is read as usual.
  let skillsAnswer: (() => object) | undefined
  const page = await openSkills((name: string, args: any) =>
    name === 'deck_skills' && skillsAnswer !== undefined ? skillsAnswer() : deckWithSkills()(name, args),
  )
  t.after(page.close)
  const { document } = page
  const prefillShown = () => [...document.querySelectorAll<HTMLButtonElement>('.dk-bar button')].find(each => text(each) === '预填')!
  const refresh = () => page.click(document.querySelector('.dk-head button'))

  await page.click([...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === IMPLEMENT)!)
  assert.equal(prefillShown().disabled, false)

  for (const failing of [
    () => answered({ ok: false, failure: { kind: 'missing', message: 'the directory ~/.claude/skills does not exist' } }),
    () => ({ content: [{ type: 'text', text: 'installed_plugins.json is not valid JSON' }], isError: true }),
  ]) {
    skillsAnswer = failing
    await refresh()
    assert.equal(prefillShown().disabled, true)
    await page.click(prefillShown())
    assert.deepEqual(prefills(page), [])

    skillsAnswer = undefined
    await refresh()
    assert.equal(prefillShown().disabled, false)
  }
  await page.click(prefillShown())
  assert.deepEqual(prefills(page), [prefilled(IMPLEMENT)])
})

test('the detail\'s parts are drawn as the layout draws them: section heads, the record\'s Session line, its Acceptance Evidence, the triage label and a quiet "在 GitHub 打开"', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  const style = (selector: string) => page.window.getComputedStyle(document.querySelector(selector)!)

  await page.click(rowOf(document, 66))
  // The layout's display face for heads, its mono face for ids and labels.
  assert.match(style('.dk-detail .dk-section__head').fontFamily, /^"?Barlow Condensed/)
  assert.match(style('.dk-detail .dk-log__who').fontFamily, /^"?JetBrains Mono/)
  assert.match(style('.dk-detail__meta .dk-tag').fontFamily, /^"?JetBrains Mono/)
  // Acceptance Evidence in the colour that says it passed.
  assert.equal(style('.dk-log__item .is-pass').color, 'rgb(111, 214, 192)')
  const open = [...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '在 GitHub 打开')!
  assert.equal(page.window.getComputedStyle(open).backgroundColor, 'rgba(0, 0, 0, 0)')
  // The title in the title size; the state line and its badge in the caption size.
  assert.equal(style('.dk-detail__title').fontSize, '18px')
  assert.equal(style('.dk-detail__meta').fontSize, '12px')
  assert.equal(style('.dk-detail__meta .dk-badge').fontSize, '12px')
  // What it says of a part with nothing in it is muted; the reports stack.
  const said = [...document.querySelectorAll('.dk-detail .dk-section > span')].find(each => text(each) === '没有描述。')!
  assert.equal(page.window.getComputedStyle(said).color, 'rgb(163, 181, 199)')
  assert.equal(style('.dk-detail .dk-log').display, 'flex')

  // Each acceptance criterion has its box before it.
  await page.click([...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)
  await page.click(rowOf(document, 70))
  assert.equal(style('.dk-detail li').paddingLeft, '24px')
})

const tabNamed = (document: Document, name: string) =>
  [...document.querySelectorAll('[role="tab"]')].find(each => text(each) === name)!
// What the "地图" tab shows as the person reads it: the card, the wall's
// cards, and the button under the wall.
const mapShown = (page: { window: any; document: Document }) => ({
  card: [...page.document.querySelectorAll('#map .dk-spec')].filter(each => shown(page, each)).map(text),
  wall: [...page.document.querySelectorAll('#map .dk-card')].filter(each => shown(page, each)).map(text),
  more: [...page.document.querySelectorAll('#map button.dk-group__more')].filter(each => shown(page, each)).map(text),
})

test('the "地图" tab shows the Map View of a Spec: its card, then its Child Tasks in the order the Deck service gives, each saying what blocks it and what it blocks', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))

  assert.deepEqual(mapShown(page), {
    card: ['Spec #64 切换 规格：里程碑二 在 Codex 桌面应用的标签页里放一个 Pane。 可执行 1 进行中 6 阻塞 2 已解锁 2 解锁进度 2 / 9 22%'],
    wall: [
      '#70 可执行 Task 详情 挡着 #73 更新 11-22 执行',
      '#74 进行中 执行与 Occupancy 登记 更新 11-22 释放',
      '#69 进行中 任务列表 Claude Code 3f9c21d0 更新 11-22 接管',
      '#72 进行中 Matt 技能 77e0aa15 更新 11-22 接管',
      '#75 Orphaned 心跳与 Orphaned Session 已结束 更新 11-22 接管',
      '#76 进行中 接管 挡着 #77 更新 11-22 接管',
      '#78 Orphaned 失联 挡着 #79 更新 11-22 接管',
      '#19 阻塞 等分诊 更新 11-22',
      '#73 阻塞 推荐：我现在该做什么 被 #72 #70 阻塞 · 挡着 #99 #100 更新 11-22',
      '#66 已解锁 骨架 验收证据 11-22 01:40',
      '#65 已解锁 预先重构 没有验收证据 11-21 22:10',
    ],
    more: [],
  })
  // The Spec is marked as its row in "任务" is; each card as its Task's row.
  assert.ok(document.querySelector('#map .dk-spec .dk-id')!.classList.contains('is-orphaned'))
  assert.deepEqual(
    [...document.querySelectorAll('#map .dk-card .dk-plate')].map(each => each.getAttribute('aria-label')),
    ['可执行', '进行中 · 本 Session', '进行中 · 其他 Session', '进行中 · 其他 Session', 'Orphaned', '进行中 · 其他 Session', 'Orphaned', '被阻塞', '被阻塞', '已解锁', '已解锁'],
  )
  // Closed and in progress, of the Child Tasks.
  const bars = [...document.querySelectorAll<HTMLElement>('#map .dk-progress__track i')].map(each => each.style.width)
  assert.deepEqual(bars, ['22.22%', '44.44%'])
  assert.equal(shown(page, document.querySelector('#map .dk-empty')), false)
  // The card and the wall are laid out as the Pane's own, a gap between them.
  assert.equal(page.window.getComputedStyle(document.querySelector('#map-view')!).display, 'contents')
})

test('a Map View with no Blocking Edge says nothing of blocking, and shows what the Deck service gives as text', async t => {
  const map = {
    ...task(90, '<i>示例</i>', { labels: [], parent: null }),
    kind: 'map',
    isPendingCloseout: false,
    group: 'ready',
    children: [91, 92],
    progress: { closed: 1, inProgress: 0, total: 2 },
  }
  const ready = task(91, '<b>一个</b>', { parent: 90 })
  const closed = task(92, '关了', { parent: 90, isOpen: false, closedAt: '2026-11-20T10:00:00Z' })
  const tasks = { ...TASKS, containers: [map], groups: { ready: [ready], inProgress: [], blocked: [], done: [closed] } }
  const maps = { ...MAPS, maps: [{ ...map, goal: null, wall: [card(ready, 'ready', { updatedAt: '2026-11-21T23:00:00Z' }), card(closed, 'done')] }] }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks, maps) })
  t.after(page.close)
  await page.click(tabNamed(page.document, '地图'))

  // One Map only: nothing to switch to. No goal: none is drawn.
  assert.deepEqual(mapShown(page), {
    card: ['Map #90 <i>示例</i> 可执行 1 进行中 0 阻塞 0 已解锁 1 解锁进度 1 / 2 50%'],
    wall: ['#91 可执行 <b>一个</b> 更新 11-21 执行', '#92 已解锁 关了 没有验收证据 11-20 10:00'],
    more: [],
  })
  assert.equal(page.document.querySelector('#map .dk-spec__goal'), null)
  assert.equal(page.document.querySelector('#map .dk-spec__title *, #map .dk-card__title *'), null)
})

test('the title, goal, Session and Blocking Edges the Deck service gives are put in the Map View as text, and the titles in the list to switch to too', async t => {
  const goal = '<u>目标</u><script>window.injected = true</script>'
  const other = task(93, '<em>占着</em>', { parent: 90, occupant: OTHER_CODEX, occupantHost: 'codex', occupantShort: '<b>77e0aa15</b>' })
  const blocked = task(94, '被挡', { parent: 90, blockers: ['<s>93</s>'], blockedBy: [93] })
  const maps = {
    ...MAPS,
    maps: [
      { ...MAPS.maps[0], title: '<i>规格</i>', goal, wall: [card(other, 'inProgress'), card(blocked, 'blocked', { blocking: ['<q>95</q>'] })] },
      { ...MAPS.maps[1], title: '<i>旧地图</i>' },
    ],
  }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, TASKS, maps) })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))

  assert.equal(text(document.querySelector('#map .dk-spec__title')), '<i>规格</i>')
  assert.equal(document.querySelector('#map .dk-spec__goal')!.textContent, goal)
  assert.deepEqual(mapShown(page).wall, [
    '#93 进行中 <em>占着</em> <b>77e0aa15</b> 更新 11-22 接管',
    '#94 阻塞 被挡 被 #<s>93</s> 阻塞 · 挡着 #<q>95</q> 更新 11-22',
  ])
  assert.equal(
    document.querySelector('#map .dk-spec__title *, #map .dk-spec__goal *, #map .dk-card__title *, #map .dk-card__meta .mono *'),
    null,
  )
  // The relation line holds no element but the Session's id.
  assert.deepEqual([...document.querySelectorAll('#map .dk-card__meta *')].map(each => each.className), ['mono'])
  assert.equal((page.window as any).injected, undefined)

  await page.click(document.querySelector('#map .dk-spec__head button'))
  assert.deepEqual([...document.querySelectorAll('#map .dk-row__title')].map(text), ['<i>规格</i>', '<i>旧地图</i>'])
  assert.equal(document.querySelector('#map .dk-row__title *'), null)
})

test('a wall shows three blocked Child Tasks and puts the rest behind "还有 N 个被阻塞", which shows them all, read again or not', async t => {
  const blocked = [80, 81, 82, 83, 84].map(number => task(number, `被挡 ${number}`, { blockers: [70], blockedBy: [70] }))
  const wallOf = (cards: object[]) => ({
    ...MAPS,
    maps: [{ ...MAPS.maps[0], wall: [card(READY, 'ready'), ...cards, card(CLOSED, 'done')] }, { ...MAPS.maps[1], wall: cards }],
  })
  let maps = wallOf(blocked.map(each => card(each, 'blocked')))
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({ answer: name => (name === 'deck_map' ? answered(maps) : answer(name)) })
  t.after(page.close)
  const { document } = page
  const numbersShown = () => mapShown(page).wall.map(each => Number(each!.split(' ')[0]!.slice(1)))
  await page.click(tabNamed(document, '地图'))

  // The closed Child Tasks after them all the same.
  assert.deepEqual(numbersShown(), [70, 80, 81, 82, 65])
  assert.deepEqual(mapShown(page).more, ['还有 2 个被阻塞'])
  // Blocked by one Task, a card names it.
  assert.equal(mapShown(page).wall[1], '#80 阻塞 被挡 80 被 #70 阻塞 更新 11-22')

  await page.click(document.querySelector('#map button.dk-group__more'))
  assert.deepEqual(numbersShown(), [70, 80, 81, 82, 83, 84, 65])
  assert.deepEqual(mapShown(page).more, [])
  // Read again, the wall stays open.
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(numbersShown(), [70, 80, 81, 82, 83, 84, 65])
  // Another Map View's wall is not.
  await page.click(document.querySelector('#map .dk-spec__head button'))
  await page.click([...document.querySelectorAll('#map .dk-row')][1]!)
  assert.deepEqual(numbersShown(), [80, 81, 82])
  assert.deepEqual(mapShown(page).more, ['还有 2 个被阻塞'])

  // Three are all shown, with no button.
  maps = wallOf(blocked.slice(0, 3).map(each => card(each, 'blocked')))
  const three = await openPage({ answer: name => (name === 'deck_map' ? answered(maps) : answer(name)) })
  t.after(three.close)
  await three.click(tabNamed(three.document, '地图'))
  assert.equal(mapShown(three).wall.length, 5)
  assert.deepEqual(mapShown(three).more, [])
})

test('with more than one Spec or Map, "切换" lists them all to choose the Map View from, and "返回" goes back to it unchanged', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  const switchButton = () => document.querySelector('#map .dk-spec__head button')
  const choicesShown = () => [...document.querySelectorAll('#map .dk-row')].filter(each => shown(page, each)).map(text)
  await page.click(tabNamed(document, '地图'))

  await page.click(switchButton())
  assert.equal(text(document.querySelector('#map .dk-bar')), '返回 地图 / 切换')
  // As "任务" draws them, without its action; the one shown is marked.
  assert.deepEqual(choicesShown(), ['Spec #64 规格：里程碑二 2/9 1 可执行 · 4 进行中 · 2 阻塞', 'Map #50 旧地图 0/0 0 可执行 · 0 进行中 · 0 阻塞'])
  assert.deepEqual([...document.querySelectorAll('#map .dk-row.is-selected')].map(each => text(each.querySelector('.dk-id'))), ['#64'])
  assert.deepEqual(mapShown(page).card, [])

  // "返回" chooses none.
  await page.click(document.querySelector('#map .dk-bar button'))
  assert.equal(mapShown(page).card[0]!.startsWith('Spec #64'), true)
  assert.deepEqual(choicesShown(), [])

  // A row chooses its Map View, which stays chosen as the Pane reads again.
  await page.click(switchButton())
  await page.click([...document.querySelectorAll('#map .dk-row')][1]!)
  assert.deepEqual(mapShown(page), { card: ['Map #50 切换 旧地图 可执行 0 进行中 0 阻塞 0 已解锁 0 解锁进度 0 / 0 0%'], wall: [], more: [] })
  await page.click(document.querySelector('.dk-head button'))
  assert.equal(mapShown(page).card[0]!.startsWith('Map #50'), true)

  // Another tab leaves the list to switch to: back in "地图" is the Map View.
  await page.click(switchButton())
  await page.click(tabNamed(document, '任务'))
  await page.click(tabNamed(document, '地图'))
  assert.deepEqual(choicesShown(), [])
  assert.equal(mapShown(page).card[0]!.startsWith('Map #50'), true)
})

test('"地图" on a Spec\'s or Map\'s row in "任务" opens its Map View, and "任务" goes back to the list as it was', async t => {
  const second = {
    ...TASKS.containers[0],
    ...task(90, '另一张地图', { labels: [], parent: null }),
    kind: 'map',
    children: [],
    progress: { closed: 0, inProgress: 0, total: 0 },
  }
  const tasks = { ...TASKS, containers: [TASKS.containers[0], second] }
  const maps = { ...MAPS, maps: [...MAPS.maps, { ...second, goal: null, wall: [] }] }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks, maps) })
  t.after(page.close)
  const { document } = page
  const selected = () => [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(text)
  const listBefore = groupsShown(document)

  const mapButton = (row: number) => [...document.querySelectorAll('#tasks .dk-row--container')][row]!.querySelector('button')
  await page.click(mapButton(1))
  assert.deepEqual(selected(), ['地图'])
  assert.deepEqual(mapShown(page).card, ['Map #90 切换 另一张地图 可执行 0 进行中 0 阻塞 0 已解锁 0 解锁进度 0 / 0 0%'])

  await page.click(tabNamed(document, '任务'))
  assert.deepEqual(selected(), ['任务'])
  assert.deepEqual(groupsShown(document), listBefore)
  assert.equal(shown(page, document.querySelector('.dk-filter')), true)
  await page.click(mapButton(0))
  assert.equal(mapShown(page).card[0]!.startsWith('Spec #64'), true)
})

test('a card on the wall opens its Child Task\'s detail, the way going through the Spec; "返回" goes back to the Map View where it was scrolled, one step at a time', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  const cardOf = (number: number) => [...document.querySelectorAll('#map .dk-card')].find(each => text(each.querySelector('.dk-id')) === `#${number}`)!
  await page.click(tabNamed(document, '地图'))

  // A button on a card is no click on the card.
  await page.click(cardOf(70).querySelector('button'))
  assert.equal(shown(page, document.querySelector('#into')), false)

  page.scroll(360)
  await page.click(cardOf(73))
  assert.equal(detailShown(page)?.crumbs, '地图 / #64 / #73')
  assert.equal(detailShown(page)?.title, '#73 推荐：我现在该做什么')
  assert.equal(page.scrolled(), 0)
  assert.deepEqual([...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(text), ['地图'])

  // On into what blocks it, and back one step at a time.
  await page.click([...document.querySelectorAll('.dk-detail .dk-edge')].find(edge => text(edge)!.includes('#72'))!)
  assert.equal(detailShown(page)?.crumbs, '地图 / #64 / #73 / #72')
  await page.click(document.querySelector('#back'))
  assert.equal(detailShown(page)?.crumbs, '地图 / #64 / #73')
  await page.click(document.querySelector('#back'))
  assert.equal(shown(page, document.querySelector('#into')), false)
  assert.equal(mapShown(page).card[0]!.startsWith('Spec #64'), true)
  assert.equal(page.scrolled(), 360)
})

test('a Child Task\'s detail says the Spec or Map it belongs to, which opens that Map View; a Task under none says nothing of it', async t => {
  const second = {
    ...TASKS.containers[0],
    ...task(90, '另一张地图', { labels: [], parent: null }),
    kind: 'map',
    children: [],
    progress: { closed: 0, inProgress: 0, total: 0 },
  }
  const tasks = { ...TASKS, containers: [TASKS.containers[0], second] }
  const maps = { ...MAPS, maps: [...MAPS.maps, { ...second, goal: null, wall: [] }] }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks, maps) })
  t.after(page.close)
  const { document } = page
  const belongs = () => document.querySelector('.dk-detail .dk-parent')
  // The Map View shown before is another one.
  await page.click([...document.querySelectorAll('#tasks .dk-row--container')][1]!.querySelector('button'))
  await page.click(tabNamed(document, '任务'))

  await page.click(rowOf(document, 64))
  assert.equal(belongs(), null)
  await page.click(document.querySelector('#back'))

  await page.click(rowOf(document, 70))
  assert.equal(text(belongs()), '属于 Spec #64 规格：里程碑二')
  // Drawn between the state's line and the first section, as the layout has it.
  assert.equal(belongs()!.previousElementSibling!.classList.contains('dk-detail__meta'), true)
  assert.equal(page.window.getComputedStyle(belongs()!.querySelector('button')!).cursor, 'pointer')

  await page.click(belongs()!.querySelector('button'))
  assert.deepEqual([...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(text), ['地图'])
  assert.equal(shown(page, document.querySelector('#into')), false)
  assert.equal(mapShown(page).card[0]!.startsWith('Spec #64'), true)
})

test('with no Spec and no Map the "地图" tab says so and what would be there', async t => {
  const tasks = { ...TASKS, containers: [] }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks, { ...MAPS, maps: [] }) })
  t.after(page.close)
  await page.click(tabNamed(page.document, '地图'))

  assert.deepEqual([...page.document.querySelector('#map .dk-empty')!.children].map(text), ['还没有 Spec 或 Map。', '带 Child Task 的 Task 会出现在这里。'])
  assert.equal(shown(page, page.document.querySelector('#map .dk-empty')), true)
  assert.deepEqual(mapShown(page), { card: [], wall: [], more: [] })
})

test('the "地图" tab says it is reading until the first read comes back, and why a read failed, over the Map View read before', async t => {
  let failure: object | undefined
  const answer = deckAt('/work/matt-deck')
  let whileReading: unknown
  const page = await openPage({
    answer: (name, _args, document) => {
      if (name === 'deck_tasks' && whileReading === undefined) {
        whileReading = [...document.querySelectorAll('#map .dk-why')].filter(each => !each.hasAttribute('hidden')).map(text)
      }
      return name === 'deck_map' && failure !== undefined ? answered({ ok: false, failure }) : answer(name)
    },
  })
  t.after(page.close)
  const { document } = page
  const notice = () =>
    [...document.querySelectorAll('#map .dk-notice.is-danger')].filter(each => shown(page, each)).map(each => [
      text(each.querySelector('.dk-notice__title')),
      text(each.querySelector('.dk-notice__text')),
      [...each.querySelectorAll('code')].map(text),
    ])
  await page.click(tabNamed(document, '地图'))

  assert.deepEqual(whileReading, ['正在读取 Task…'])
  assert.deepEqual([...document.querySelectorAll('#map .dk-why')].filter(each => shown(page, each)), [])
  assert.deepEqual(notice(), [])

  failure = { kind: 'unauthenticated', message: 'not logged in' }
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(notice(), [['读取 Task 失败', 'gh 未登录。运行 gh auth login 后点“刷新”重试。', ['gh', 'gh auth login']]])
  assert.equal(text(document.querySelector('.dk-head__fresh')), '读取失败')
  assert.equal(mapShown(page).card[0]!.startsWith('Spec #64'), true)
  // And so does "任务", its words its own.
  await page.click(tabNamed(document, '任务'))
  assert.equal(text([...document.querySelectorAll('#tasks .dk-notice.is-danger')].find(each => shown(page, each))!.querySelector('.dk-notice__text')), 'gh 未登录。运行 gh auth login 后点“刷新”重试。')

  failure = undefined
  await page.click(document.querySelector('.dk-head button'))
  await page.click(tabNamed(document, '地图'))
  assert.deepEqual(notice(), [])
})

test('the timed reads and the read as the tab is shown again read the Map Views anew and keep what the person looks at: the Map View chosen, its open wall, the list to switch to', async t => {
  const blocked = [80, 81, 82, 83, 84].map(number => card(task(number, `被挡 ${number}`, { blockers: [70], blockedBy: [70] }), 'blocked'))
  let maps = { ...MAPS, maps: [MAPS.maps[0], { ...MAPS.maps[1], wall: blocked }] }
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({ answer: name => (name === 'deck_map' ? answered(maps) : answer(name)) })
  t.after(page.close)
  const { document } = page
  const mapReads = () => page.sent.filter(message => message.params?.name === 'deck_map').map(({ params }) => params.arguments)
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map .dk-spec__head button'))
  await page.click([...document.querySelectorAll('#map .dk-row')][1]!)
  await page.click(document.querySelector('#map button.dk-group__more'))
  assert.equal(mapShown(page).wall.length, 5)

  // What the Deck service gives next is drawn: a Child Task closed since.
  maps = { ...MAPS, maps: [MAPS.maps[0], { ...MAPS.maps[1], wall: [...blocked, card(CLOSED, 'done')] }] }
  await page.advance(60_000)
  assert.equal(mapShown(page).card[0]!.startsWith('Map #50'), true)
  assert.equal(mapShown(page).wall.length, 6)
  assert.deepEqual(mapShown(page).more, [])

  await page.show(false)
  await page.show(true)
  assert.equal(mapShown(page).wall.length, 6)

  // The list to switch to stays open through a timed read too.
  await page.click(document.querySelector('#map .dk-spec__head button'))
  await page.advance(60_000)
  assert.equal(text(document.querySelector('#map .dk-bar')), '返回 地图 / 切换')

  // Each of them read the Map Views as this Session sees them, past no cache.
  assert.deepEqual(mapReads(), [1, 2, 3, 4].map(() => ({ session: SESSION.session })))
})

test('the Tasks and their Map Views are one read: when deck_map fails after deck_tasks answered, both tabs say why over what they showed before', async t => {
  let tasks: object = TASKS
  let mapAnswer: () => object = () => answered(MAPS)
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({
    answer: name => (name === 'deck_tasks' ? answered(tasks) : name === 'deck_map' ? mapAnswer() : answer(name)),
  })
  t.after(page.close)
  const { document } = page
  const noticeIn = (tab: string) =>
    [...document.querySelectorAll(`#${tab} .dk-notice.is-danger`)].filter(each => shown(page, each)).map(each => text(each.querySelector('.dk-notice__text')))
  const before = groupsShown(document)

  // The Task Source has changed, and deck_map cannot read it.
  tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [] } }
  mapAnswer = () => answered({ ok: false, failure: { kind: 'offline', message: 'dial tcp' } })
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(noticeIn('tasks'), ['连不上 GitHub。检查网络后点“刷新”重试。'])
  assert.deepEqual(groupsShown(document), before)
  assert.equal(text(document.querySelector('.dk-head__fresh')), '读取失败')
  await page.click(tabNamed(document, '地图'))
  assert.deepEqual(noticeIn('map'), ['连不上 GitHub。检查网络后点“刷新”重试。'])
  assert.equal(mapShown(page).wall.length, MAPS.maps[0]!.wall.length)

  // A tool error of deck_map says so in both, the same way.
  mapAnswer = () => ({ content: [{ type: 'text', text: 'database is locked' }], isError: true })
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(noticeIn('map'), ['Deck 服务出错：database is locked。点“刷新”重试。'])
  await page.click(tabNamed(document, '任务'))
  assert.deepEqual(noticeIn('tasks'), ['Deck 服务出错：database is locked。点“刷新”重试。'])
  assert.deepEqual(groupsShown(document), before)

  // Read again, both are what the Deck service now gives.
  mapAnswer = () => answered(MAPS)
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(noticeIn('tasks'), [])
  assert.notDeepEqual(groupsShown(document), before)
})

// A Spec or Map as deck_map gives it, its wall five blocked Child Tasks.
const blockedWall = [80, 81, 82, 83, 84].map(number => card(task(number, `被挡 ${number}`, { blockers: [70], blockedBy: [70] }), 'blocked'))
const viewOf = (number: number, title: string, more: object = {}) => ({
  ...TASKS.containers[0],
  ...task(number, title, { labels: [], parent: null }),
  kind: 'spec',
  children: [],
  goal: null,
  wall: blockedWall,
  ...more,
})
// A page whose deck_map answers what `maps()` gives at each call.
const openWithMaps = async (maps: () => object[]) => {
  const answer = deckAt('/work/matt-deck')
  return openPage({ answer: (name, args) => (name === 'deck_map' ? answered({ ...MAPS, maps: maps() }) : answer(name, args)) })
}
const cardTitle = (page: { window: any; document: Document }) => text(page.document.querySelector('#map .dk-spec__title'))

test('the Map View shown without being chosen stays the one shown, its wall open, as the order the Deck service gives changes', async t => {
  let maps = [viewOf(64, '规格'), viewOf(90, '另一张')]
  const page = await openWithMaps(() => maps)
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map button.dk-group__more'))
  assert.equal(cardTitle(page), '规格')

  // One with a lower number comes in front of it.
  maps = [viewOf(10, '新来的'), ...maps]
  await page.advance(60_000)
  assert.equal(cardTitle(page), '规格')
  assert.equal(mapShown(page).wall.length, 5)

  // It closes, and goes after the open ones.
  maps = [maps[0]!, maps[2]!, viewOf(64, '规格', { isOpen: false })]
  await page.advance(60_000)
  assert.equal(cardTitle(page), '规格')
  assert.equal(mapShown(page).wall.length, 5)
  assert.deepEqual(mapShown(page).more, [])
})

test('choosing the Map View already shown through "切换" keeps its wall open; choosing another closes it', async t => {
  const page = await openWithMaps(() => [viewOf(64, '规格'), viewOf(90, '另一张')])
  t.after(page.close)
  const { document } = page
  const choose = async (row: number) => {
    await page.click(document.querySelector('#map .dk-spec__head button'))
    await page.click([...document.querySelectorAll('#map .dk-row')][row]!)
  }
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map button.dk-group__more'))

  await choose(0)
  assert.equal(cardTitle(page), '规格')
  assert.equal(mapShown(page).wall.length, 5)

  await choose(1)
  assert.equal(cardTitle(page), '另一张')
  assert.deepEqual(mapShown(page).more, ['还有 2 个被阻塞'])
})

test('when the Map View shown is gone from what the Deck service gives, the first one is shown, its wall closed, and stays shown', async t => {
  let maps = [viewOf(64, '规格'), viewOf(90, '另一张')]
  const page = await openWithMaps(() => maps)
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map .dk-spec__head button'))
  await page.click([...document.querySelectorAll('#map .dk-row')][1]!)
  await page.click(document.querySelector('#map button.dk-group__more'))

  maps = [viewOf(64, '规格')]
  await page.advance(60_000)
  assert.equal(cardTitle(page), '规格')
  assert.deepEqual(mapShown(page).more, ['还有 2 个被阻塞'])

  // Back again, it is not shown in place of the one shown since.
  maps = [viewOf(64, '规格'), viewOf(90, '另一张')]
  await page.advance(60_000)
  assert.equal(cardTitle(page), '规格')
})

test('when every Spec and Map is gone while the list to switch to is open, the tab says there is none, and shows a Map View when they are back', async t => {
  let maps: object[] = [viewOf(64, '规格'), viewOf(90, '另一张')]
  const page = await openWithMaps(() => maps)
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map .dk-spec__head button'))

  maps = []
  await page.advance(60_000)
  assert.equal(shown(page, document.querySelector('#map .dk-empty')), true)
  assert.equal(document.querySelector('#map .dk-bar'), null)

  maps = [viewOf(64, '规格'), viewOf(90, '另一张')]
  await page.advance(60_000)
  assert.equal(document.querySelector('#map .dk-bar'), null)
  assert.equal(cardTitle(page), '规格')
})

test('the Map View chosen and its open wall stay through a read that fails and through the project being not configured for a while', async t => {
  let failing = false
  let configured = true
  const maps = [viewOf(64, '规格'), viewOf(90, '另一张')]
  const yes = deckAt('/work/matt-deck')
  const no = deckAt('/work/matt-deck', false)
  const page = await openPage({
    answer: name =>
      name === 'deck_map'
        ? answered(failing ? { ok: false, failure: { kind: 'offline', message: 'dial tcp' } } : { ...MAPS, maps })
        : (configured ? yes : no)(name),
  })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map .dk-spec__head button'))
  await page.click([...document.querySelectorAll('#map .dk-row')][1]!)
  await page.click(document.querySelector('#map button.dk-group__more'))

  failing = true
  await page.advance(60_000)
  failing = false
  await page.advance(60_000)
  assert.equal(cardTitle(page), '另一张')
  assert.equal(mapShown(page).wall.length, 5)

  configured = false
  await page.advance(60_000)
  configured = true
  await page.advance(60_000)
  assert.equal(cardTitle(page), '另一张')
  assert.equal(mapShown(page).wall.length, 5)
})

test('a Recommendation shown keeps the Task as the list read before has it while deck_map fails, and follows the list once both read', async t => {
  let tasks: any = TASKS
  let mapFails = false
  const deck = deckThatRecommends()
  const page = await openNext({
    answer: (name: string, args: any) =>
      name === 'deck_tasks'
        ? answered(tasks)
        : name === 'deck_map' && mapFails
          ? answered({ ok: false, failure: { kind: 'offline', message: 'dial tcp' } })
          : deck.answer(name, args),
  })
  t.after(page.close)
  const title = () => text(page.document.querySelector('.dk-rec__title'))
  await page.click(button(page, '我现在该做什么'))
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  assert.equal(title(), 'Task 详情')

  // #70 renamed, and deck_map cannot read: the list and the card are as before.
  tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [task(70, 'Task 详情 3k8d')] } }
  mapFails = true
  await page.advance(58_000)
  assert.equal(title(), 'Task 详情')
  assert.equal(text(page.document.querySelector('.dk-head__fresh')), '读取失败')

  mapFails = false
  await page.advance(60_000)
  assert.equal(title(), 'Task 详情 3k8d')
})

test('"地图" on a Spec\'s row opens its Map View and not its detail; a click elsewhere on the row opens the detail', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  const detailReads = () => page.sent.filter(message => message.params?.name === 'deck_task').length
  const selected = () => [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(text)
  const spec = () => document.querySelector('#tasks .dk-row--container')!

  await page.click(spec().querySelector('button'))
  assert.deepEqual(selected(), ['地图'])
  assert.equal(cardTitle(page), '规格：里程碑二')
  assert.equal(detailReads(), 0)
  assert.equal(shown(page, document.querySelector('.dk-detail')), false)

  await page.click(tabNamed(document, '任务'))
  await page.click(spec().querySelector('.dk-row__title'))
  assert.deepEqual(selected(), ['任务'])
  assert.equal(detailReads(), 1)
  assert.equal(text(document.querySelector('#crumbs')), '任务 / #64')
  assert.equal(shown(page, document.querySelector('.dk-detail')), true)
})

test('a Task\'s detail open, the Map View shown, its open wall and the list to switch to are kept through the timed reads, and the "地图" tab leaves the detail', async t => {
  const maps = [viewOf(64, '规格'), viewOf(90, '另一张')]
  const page = await openWithMaps(() => maps)
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map .dk-spec__head button'))
  await page.click([...document.querySelectorAll('#map .dk-row')][1]!)
  await page.click(document.querySelector('#map button.dk-group__more'))

  // Into #70's detail from "任务", through a timed read.
  await page.click(tabNamed(document, '任务'))
  await page.click(rowOf(document, 70))
  await page.advance(60_000)
  assert.equal(text(document.querySelector('#crumbs')), '任务 / #70')

  // Back from it, then on "地图": as it was.
  await page.click(document.querySelector('#back'))
  assert.equal(shown(page, document.querySelector('.dk-filter')), true)
  await page.click(tabNamed(document, '地图'))
  assert.equal(cardTitle(page), '另一张')
  assert.equal(mapShown(page).wall.length, 5)

  // "地图" from a detail leaves it; back on "任务" is the list.
  await page.click(tabNamed(document, '任务'))
  await page.click(rowOf(document, 70))
  await page.click(tabNamed(document, '地图'))
  assert.equal(shown(page, document.querySelector('#into')), false)
  assert.equal(cardTitle(page), '另一张')
  assert.equal(mapShown(page).wall.length, 5)
  await page.click(tabNamed(document, '任务'))
  assert.equal(shown(page, document.querySelector('#into')), false)
  assert.equal(shown(page, document.querySelector('.dk-filter')), true)
  await page.click(tabNamed(document, '地图'))

  // The list to switch to stays open through a timed read.
  await page.click(document.querySelector('#map .dk-spec__head button'))
  await page.advance(60_000)
  assert.equal(text(document.querySelector('#map .dk-bar')), '返回 地图 / 切换')
})

// A project with two Specs: #64, every Child Task of it closed, Pending
// Closeout while `pending` says so, and #80, a Child Task of it still open.
// Each closeout check the Deck service gives is one the page could not write.
const closeoutPromptOf = (read: number) => `收尾核对 #64 as the Deck service words it, read ${read} 7d1e`
const closeoutProject = (pending: boolean, read = 1) => {
  const spec = (number: number, title: string, children: number[], closed: number, isPendingCloseout: boolean) => ({
    ...task(number, title, { labels: [], parent: null }),
    kind: 'spec',
    isPendingCloseout,
    group: 'ready',
    children,
    progress: { closed, inProgress: 0, total: children.length },
  })
  const [pendingSpec, openSpec] = [spec(64, '规格：里程碑二', [66, 65], pending ? 2 : 1, pending), spec(80, '规格：里程碑三', [81, 82], 1, false)]
  const [ready, reopened] = [task(81, '还开着', { parent: 80 }), task(65, '预先重构', { parent: 64 })]
  const done = [
    task(66, '骨架', { isOpen: false, closedAt: '2026-11-22T01:40:00Z', parent: 64 }),
    ...(pending ? [task(65, '预先重构', { isOpen: false, closedAt: '2026-11-21T22:10:00Z', parent: 64 })] : []),
    task(82, '关了', { isOpen: false, closedAt: '2026-11-20T10:00:00Z', parent: 80 }),
  ]
  const tasks = { ...TASKS, containers: [pendingSpec, openSpec], groups: { ready: pending ? [ready] : [ready, reopened], inProgress: [], blocked: [], done } }
  const wallOf = (number: number) => [
    ...tasks.groups.ready.filter(each => each.parent === number).map(each => card(each, 'ready')),
    ...done.filter(each => each.parent === number).map(each => card(each, 'done')),
  ]
  const maps = {
    ...MAPS,
    maps: [
      { ...pendingSpec, goal: null, wall: wallOf(64), closeoutPrompt: pending ? closeoutPromptOf(read) : null },
      { ...openSpec, goal: null, wall: wallOf(80), closeoutPrompt: null },
    ],
  }
  return { tasks, maps }
}
// The Deck service of that project, read after read as `project` says.
const deckOfCloseout = (project: () => { tasks: object; maps: object }) => (name: string, args: any = {}) =>
  name === 'deck_tasks' ? answered(project().tasks)
  : name === 'deck_map' ? answered(project().maps)
  : name === 'deck_task' && args.number === 80 ? answered(detail(80, '规格：里程碑三', { labels: [] }))
  : deckAt('/work/matt-deck')(name, args)

const buttonsOf = (element: Element) => [...element.querySelectorAll('button')].map(each => [text(each), each.className])

test('a Pending Closeout Spec\'s row offers a gold "收尾核对" before "地图"; a Spec with a Child Task open offers "地图" alone and is not Pending Closeout', async t => {
  const page = await openPage({ answer: deckOfCloseout(() => closeoutProject(true)) })
  t.after(page.close)
  const [pending, open] = [rowOf(page.document, 64), rowOf(page.document, 80)]

  assert.deepEqual(buttonsOf(pending), [['收尾核对', 'dk-btn dk-btn--sm dk-btn--unlock'], ['地图', 'dk-btn dk-btn--sm']])
  assert.ok(pending.classList.contains('is-closeout'))
  assert.equal(text(pending.querySelector('.dk-row__meta')), '待收尾核对')
  assert.deepEqual(buttonsOf(open), [['地图', 'dk-btn dk-btn--sm']])
  assert.equal(open.classList.contains('is-closeout'), false)
  assert.equal(text(open.querySelector('.dk-row__meta')), '1 可执行 · 0 进行中 · 0 阻塞')
  assert.doesNotMatch(text(page.document.querySelector('#tasks'))!, /已完成 · |验收通过/)
})

test('"收尾核对" on a row puts the closeout check the Deck service gives in the prompt, unsent, opens no detail, and is off for 5 seconds', async t => {
  const page = await openPage({ answer: deckOfCloseout(() => closeoutProject(true)) })
  t.after(page.close)
  const button = () => rowOf(page.document, 64).querySelector('button')!

  await page.click(button())
  assert.deepEqual(prefills(page), [prefilled(closeoutPromptOf(1))])
  assert.equal(detailShown(page), undefined)
  assert.deepEqual([text(button()), button().disabled], ['已填入', true])
  await page.click(button())
  assert.equal(prefills(page).length, 1)

  await page.advance(4_999)
  assert.deepEqual([text(button()), button().disabled], ['已填入', true])
  await page.advance(1)
  assert.deepEqual([text(button()), button().disabled], ['收尾核对', false])
})

test('a Pending Closeout Spec\'s Map View card is drawn for its closeout, and its gold "收尾核对" prefills the closeout check, unsent', async t => {
  const page = await openPage({ answer: deckOfCloseout(() => closeoutProject(true)) })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  const plate = () => document.querySelector('#map .dk-spec')!

  assert.deepEqual(mapShown(page).card, ['Spec #64 待收尾核对 切换 规格：里程碑二 可执行 0 进行中 0 阻塞 0 已解锁 2 解锁进度 2 / 2 100% Child Task 已全部解锁，Spec 还没关闭。 收尾核对'])
  assert.ok(plate().classList.contains('is-closeout'))
  assert.ok(plate().querySelector('.dk-id')!.classList.contains('is-closeout'))
  assert.equal(plate().querySelector('.dk-spec__head .is-unlock')?.textContent, '待收尾核对')
  assert.ok(plate().querySelector('.dk-progress')!.classList.contains('is-complete'))
  assert.deepEqual(buttonsOf(plate().querySelector('.dk-spec__foot')!), [['收尾核对', 'dk-btn dk-btn--unlock']])

  const button = plate().querySelector<HTMLButtonElement>('.dk-spec__foot button')!
  await page.click(button)
  assert.deepEqual(prefills(page), [prefilled(closeoutPromptOf(1))])
  assert.deepEqual([text(button), button.disabled], ['已填入', true])
  await page.advance(5_000)
  assert.deepEqual([text(button), button.disabled], ['收尾核对', false])
})

test('the Map View of a Spec with a Child Task open is not drawn for a closeout and offers none', async t => {
  const page = await openPage({ answer: deckOfCloseout(() => closeoutProject(true)) })
  t.after(page.close)
  const { document } = page
  await page.click(rowOf(document, 80).querySelector('button'))
  const plate = document.querySelector('#map .dk-spec')!

  assert.deepEqual(mapShown(page).card, ['Spec #80 切换 规格：里程碑三 可执行 1 进行中 0 阻塞 0 已解锁 1 解锁进度 1 / 2 50%'])
  assert.equal(plate.classList.contains('is-closeout'), false)
  assert.equal(plate.querySelector('.dk-progress')!.classList.contains('is-complete'), false)
  assert.equal(plate.querySelector('.dk-spec__foot'), null)
})

test('a Pending Closeout Spec\'s detail says its state as a Task and has "收尾核对" in the way back, before "在 GitHub 打开"; another Spec\'s has none', async t => {
  const page = await openPage({ answer: deckOfCloseout(() => closeoutProject(true)) })
  t.after(page.close)
  const { document } = page

  await page.click(rowOf(document, 64))
  assert.deepEqual(detailShown(page)!.bar, ['返回', '收尾核对', '在 GitHub 打开'])
  assert.deepEqual(detailShown(page)!.meta, ['可执行', '未指派', '更新 11-21'])
  const button = [...document.querySelectorAll<HTMLButtonElement>('#into-end button')].find(each => text(each) === '收尾核对')!
  assert.equal(button.className, 'dk-btn dk-btn--sm dk-btn--unlock')
  await page.click(button)
  assert.deepEqual(prefills(page), [prefilled(closeoutPromptOf(1))])
  assert.deepEqual([text(button), button.disabled], ['已填入', true])

  await page.click(document.querySelector('#back'))
  await page.click(rowOf(document, 80))
  assert.deepEqual(detailShown(page)!.bar, ['返回', '在 GitHub 打开'])
})

test('each read draws the closeout anew: a Child Task reopened takes "收尾核对" away from the row, the card and the detail, and closed again brings it back with the check read last', async t => {
  let project = closeoutProject(true, 1)
  const page = await openPage({ answer: deckOfCloseout(() => project) })
  t.after(page.close)
  const { document } = page
  const offered = () => ({
    row: buttonsOf(rowOf(document, 64)).map(([label]) => label),
    card: [...document.querySelectorAll('#map .dk-spec__foot button')].map(text),
    detail: detailShown(page)?.bar,
  })
  await page.click(rowOf(document, 64))

  project = closeoutProject(false)
  await page.advance(60_000)
  assert.deepEqual(offered(), { row: ['地图'], card: [], detail: ['返回', '在 GitHub 打开'] })
  assert.equal(document.querySelector('#map .dk-spec')!.classList.contains('is-closeout'), false)

  project = closeoutProject(true, 2)
  await page.show(false)
  await page.show(true)
  assert.deepEqual(offered(), { row: ['收尾核对', '地图'], card: ['收尾核对'], detail: ['返回', '收尾核对', '在 GitHub 打开'] })
  await page.click([...document.querySelectorAll('#into-end button')].find(each => text(each) === '收尾核对')!)
  await page.advance(5_000)
  await page.click(document.querySelector('#back'))
  await page.click(rowOf(document, 64).querySelector('button'))
  await page.advance(5_000)
  await page.click(tabNamed(document, '地图'))
  await page.click(document.querySelector('#map .dk-spec__foot button'))
  assert.deepEqual(prefills(page), [1, 2, 3].map(() => prefilled(closeoutPromptOf(2))))
})

test('a Spec deck_tasks finds Pending Closeout while deck_map, answering from another read, does not or has no Map View of it, has "收尾核对" off', async t => {
  const { tasks } = closeoutProject(true)
  const { maps } = closeoutProject(false)
  for (const viewed of [maps, { ...maps, maps: maps.maps.slice(1) }]) {
    const page = await openPage({ answer: deckOfCloseout(() => ({ tasks, maps: viewed })) })
    t.after(page.close)

    const button = rowOf(page.document, 64).querySelector('button')!
    assert.deepEqual([text(button), button.disabled], ['收尾核对', true])
    await page.click(rowOf(page.document, 64))
    assert.deepEqual(detailShown(page)!.bar, ['返回', '收尾核对', '在 GitHub 打开'])
    assert.equal(page.document.querySelector<HTMLButtonElement>('#into-end button')!.disabled, true)
    await page.click(page.document.querySelector('#into-end button'))
    assert.deepEqual(prefills(page), [])
  }
})

test('"待收尾核对" and the gold "收尾核对" are drawn in the closeout\'s pair of colours, dark and light: its words gold, the button\'s words on gold', async t => {
  const PAIRS = {
    dark: { words: 'rgb(242, 193, 78)', button: ['rgb(28, 19, 0)', 'rgb(242, 193, 78)'] },
    light: { words: 'rgb(130, 91, 0)', button: ['rgb(255, 255, 255)', 'rgb(130, 91, 0)'] },
  }
  for (const theme of ['dark', 'light'] as const) {
    const page = await openPage({ answer: deckOfCloseout(() => closeoutProject(true)), hostContext: { theme } })
    t.after(page.close)
    const { document } = page
    const style = (element: Element) => page.window.getComputedStyle(element)
    const pair = (button: Element) => [style(button).color, style(button).backgroundColor]

    assert.equal(style(rowOf(document, 64).querySelector('.dk-row__meta .is-unlock')!).color, PAIRS[theme].words, theme)
    assert.deepEqual(pair(rowOf(document, 64).querySelector('button')!), PAIRS[theme].button, theme)
    await page.click(tabNamed(document, '地图'))
    assert.equal(style(document.querySelector('#map .dk-spec__head .is-unlock')!).color, PAIRS[theme].words, theme)
    assert.deepEqual(pair(document.querySelector('#map .dk-spec__foot button')!), PAIRS[theme].button, theme)
    await page.click(tabNamed(document, '任务'))
    await page.click(rowOf(document, 64))
    assert.deepEqual(pair([...document.querySelectorAll('#into-end button')].find(each => text(each) === '收尾核对')!), PAIRS[theme].button, theme)
  }
})

// "执行" as the person sees it: its words, and whether it is on.
const executeShown = (element: Element | null | undefined) =>
  element === null || element === undefined ? undefined : [text(element), !(element as HTMLButtonElement).disabled]
const rowExecute = (document: Document, number: number) => rowOf(document, number).querySelector('[data-execute]')
const barExecute = (document: Document) => [...document.querySelectorAll('.dk-bar button')].find(each => ['执行', '已填入'].includes(text(each)!))
const calledWith = (page: { sent: any[] }, name: string) =>
  page.sent.filter(message => message.method === 'tools/call' && message.params.name === name).map(({ params }) => params.arguments)

test('a ready Task\'s "执行" puts the Execute Prompt the Deck service gives in the prompt, unsent, and occupies nothing; it says 已填入 for 5 seconds, the reads in between too', async t => {
  const answer = deckAt('/work/matt-deck')
  // "执行" while the Deck service has not given the prompt yet.
  let whileAsking: unknown
  const page = await openPage({
    answer: (name, args, document) => {
      if (name === 'deck_execute') whileAsking = executeShown(rowExecute(document, 70))
      return answer(name, args)
    },
  })
  t.after(page.close)
  const { document } = page

  // Only the ready Task has it, as a "go" button; one another Session
  // holds, or Orphaned, has "接管" instead, drawn as "执行" stands.
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['执行', true])
  assert.deepEqual([...rowExecute(document, 70)!.classList], ['dk-btn', 'dk-btn--sm', 'dk-btn--go'])
  assert.deepEqual(
    [74, 72, 69, 75, 73, 19, 66, 65, 64].map(number => text(rowExecute(document, number))),
    [undefined, '接管', '接管', '接管', undefined, undefined, undefined, undefined, undefined],
  )

  await page.click(rowExecute(document, 70))

  // Off at once, and 已填入 once the Host has taken it.
  assert.deepEqual(whileAsking, ['执行', false])
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(70))])
  assert.deepEqual(calledWith(page, 'deck_execute'), [{ task: 70 }])
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
  // A click on the button is not one on its row.
  assert.equal(detailShown(page), undefined)
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['已填入', false])
  // "刷新" and the timed read draw the row again, its "执行" as it stands.
  await page.click(document.querySelector('.dk-head button'))
  await page.show(false)
  await page.show(true)
  await page.advance(4_999)
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['已填入', false])
  await page.advance(1)
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['执行', true])
  assert.equal(prefills(page).length, 1)
})

test('a ready Task\'s detail has "执行" in its bar before "在 GitHub 打开", which is off with its row\'s; another Task\'s has none', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  const back = () => page.click([...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)

  await page.click(rowOf(document, 73))
  assert.deepEqual(detailShown(page)?.bar, ['返回', '在 GitHub 打开'])
  await back()

  await page.click(rowOf(document, 70))
  assert.deepEqual(detailShown(page)?.bar, ['返回', '执行', '在 GitHub 打开'])
  assert.deepEqual([...barExecute(document)!.classList], ['dk-btn', 'dk-btn--sm', 'dk-btn--go'])
  await page.click(barExecute(document)!)
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(70))])
  assert.deepEqual(executeShown(barExecute(document)), ['已填入', false])
  // The detail read again within the 5 seconds says so too, and so does the row.
  await page.advance(60_000 - 55_001)
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(executeShown(barExecute(document)), ['已填入', false])
  await back()
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['已填入', false])
  await page.advance(5_000)
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['执行', true])
})

test('"执行" clicked on one Task leaves another Task\'s "执行" on, which fills in that Task\'s Execute Prompt', async t => {
  const tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [READY, task(71, '另一个就绪的')] } }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks) })
  t.after(page.close)
  const { document } = page

  await page.click(rowExecute(document, 70))

  assert.deepEqual(executeShown(rowExecute(document, 70)), ['已填入', false])
  assert.deepEqual(executeShown(rowExecute(document, 71)), ['执行', true])
  await page.click(rowExecute(document, 71))
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(70)), prefilled(executePromptOf(71))])
  assert.deepEqual(executeShown(rowExecute(document, 71)), ['已填入', false])
})

test('each Task\'s "执行" is on again at its own 5 seconds: one clicked later stays off when the earlier one\'s ends', async t => {
  const tasks = { ...TASKS, groups: { ...TASKS.groups, ready: [READY, task(71, '另一个就绪的')] } }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks) })
  t.after(page.close)
  const { document } = page

  await page.click(rowExecute(document, 70))
  await page.advance(2_000)
  await page.click(rowExecute(document, 71))
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['已填入', false])
  await page.advance(3_000)

  assert.deepEqual(executeShown(rowExecute(document, 70)), ['执行', true])
  assert.deepEqual(executeShown(rowExecute(document, 71)), ['已填入', false])
  await page.advance(2_000)
  assert.deepEqual(executeShown(rowExecute(document, 71)), ['执行', true])
})

test('"执行" fills in nothing when the Deck service fails to give the Execute Prompt, and is on again', async t => {
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({
    answer: (name, args) => (name === 'deck_execute' ? { content: [{ type: 'text', text: 'no prompt' }], isError: true } : answer(name, args)),
  })
  t.after(page.close)

  await page.click(rowExecute(page.document, 70))

  assert.deepEqual(prefills(page), [])
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', true])
})

test('the Recommendation\'s "执行这个 Task" puts the Execute Prompt of its Task in the prompt; none for a Task closed or for no Task', async t => {
  const deck = deckThatRecommends()
  const page = await openNext(deck)
  t.after(page.close)
  const recommended = async (task: number | null, request: number) => {
    await page.click(button(page, request === 1 ? '我现在该做什么' : '再问一次'))
    deck.reported.set(`request-${request}`, { ...RECOMMENDATION, task })
    await page.advance(2_000)
    return executeShown(page.document.querySelector('.dk-rec [data-execute]'))
  }

  assert.deepEqual(
    [await recommended(66, 1), await recommended(null, 2)],
    [undefined, undefined],
  )
  // This Session's, a blocked one, and one the list does not hold have it;
  // one another Session holds, or Orphaned, too, to be taken over first.
  assert.deepEqual([await recommended(72, 3), await recommended(75, 4)], Array(2).fill(['执行这个 Task', true]))
  assert.deepEqual([await recommended(74, 5), await recommended(73, 6), await recommended(999, 7)], Array(3).fill(['执行这个 Task', true]))
  assert.deepEqual(await recommended(70, 8), ['执行这个 Task', true])
  // The card's primary button, across it.
  assert.deepEqual([...page.document.querySelector('.dk-rec [data-execute]')!.classList], ['dk-btn', 'dk-btn--primary', 'dk-btn--block'])

  await page.click(page.document.querySelector('.dk-rec [data-execute]'))

  assert.deepEqual(prefills(page).at(-1), prefilled(executePromptOf(70)))
  assert.deepEqual(calledWith(page, 'deck_execute'), [{ task: 70 }])
  // The timed read draws the card again: its "执行这个 Task" is off still.
  await page.show(false)
  await page.show(true)
  assert.deepEqual(executeShown(page.document.querySelector('.dk-rec [data-execute]')), ['已填入', false])
  await page.advance(5_000)
  assert.deepEqual(executeShown(page.document.querySelector('.dk-rec [data-execute]')), ['执行这个 Task', true])
})

// The notice at the top of the 任务 tab, as the person reads it, if shown.
const noExecute = (page: { window: any; document: Document }) => {
  const notice = page.document.querySelector('#tasks .dk-notice.is-warn')
  return shown(page, notice) ? [text(notice!.querySelector('.dk-notice__title')), text(notice!.querySelector('.dk-notice__text'))] : undefined
}

test('when Codex does not run this implement, every "执行" is off and the top of the 任务 tab says why once, with "重跑配置"', async t => {
  for (const [copy, said] of [
    ['different', 'Codex 里的 implement 不是同一份，不能预填执行。'],
    ['missing', 'Codex 里找不到 implement，不能预填执行。'],
  ] as const) {
    const deck = deckThatRecommends(SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)))
    const page = await openPage({ answer: deck.answer })
    t.after(page.close)
    const { document } = page

    assert.deepEqual(noExecute(page), [said, '所有 Task 的“执行”先停用，重跑配置之后恢复。'], copy)
    // At the top of the tab's content.
    assert.equal(document.querySelector('#tasks')!.firstElementChild, document.querySelector('#tasks .dk-notice.is-warn'))
    // Read out as it shows.
    assert.equal(document.querySelector('#tasks .dk-notice.is-warn')!.getAttribute('role'), 'status')
    assert.deepEqual(executeShown(rowExecute(document, 70)), ['执行', false])
    assert.equal(document.querySelectorAll('#groups .dk-why').length, 0)
    const rerun = document.querySelector('#tasks .dk-notice.is-warn button')!
    assert.equal(text(rerun), '重跑配置')
    await page.click(rerun)
    assert.deepEqual(prefills(page), [prefilled(CONFIGURE_CALL)])

    await page.click(rowOf(document, 70))
    assert.deepEqual(executeShown(barExecute(document)), ['执行', false])
    assert.equal(noExecute(page), undefined)
    await page.click([...document.querySelectorAll('[role="tab"]')].find(tab => text(tab) === '下一步')!)
    await page.click(button(page, '我现在该做什么'))
    deck.reported.set('request-1', RECOMMENDATION)
    await page.advance(2_000)
    assert.deepEqual(executeShown(page.document.querySelector('.dk-rec [data-execute]')), ['执行这个 Task', false])
    assert.deepEqual(calledWith(page, 'deck_execute'), [])
  }
})

test('"执行" is off, and the 任务 tab says why in its own words, when the Skill Source holds no implement or cannot be read; "刷新" turns it on again once implement is read the same', async t => {
  let skillsAnswer: () => object = () => answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.filter(skill => skill.name !== 'implement') })
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({ answer: (name, args) => (name === 'deck_skills' ? skillsAnswer() : answer(name, args)) })
  t.after(page.close)
  const refresh = () => page.click(page.document.querySelector('.dk-head button'))

  assert.deepEqual(noExecute(page), ['Skill Source 里没有 implement，不能预填执行。', '所有 Task 的“执行”先停用，重跑配置之后恢复。'])
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', false])

  skillsAnswer = () => answered({ ok: false, failure: { kind: 'missing', message: 'no such directory 3k8p' } })
  await refresh()
  assert.deepEqual(noExecute(page), ['读取 Skill Source 失败，不能预填执行。', '找不到 Skill Source。重跑配置之后恢复。'])

  skillsAnswer = () => ({ content: [{ type: 'text', text: 'the skills table is locked 6t1w' }], isError: true })
  await refresh()
  assert.deepEqual(noExecute(page), ['读取 Skill Source 失败，不能预填执行。', 'Deck 服务出错：the skills table is locked 6t1w。点“刷新”重试。'])
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', false])

  skillsAnswer = () => answer('deck_skills', {})
  await refresh()
  assert.equal(noExecute(page), undefined)
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', true])
})

test('"执行" is off until the skills are read, and neither 任务 nor 地图 shows a notice of why', async t => {
  let whileReading: unknown
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({
    answer: async (name, args, document) => {
      if (name === 'deck_skills' && whileReading === undefined) {
        const isShown = (selector: string) => shown({ window: document.defaultView }, document.querySelector(selector))
        const inTasks = isShown('#tasks .dk-notice.is-warn')
        ;(tabNamed(document, '地图') as HTMLElement).click()
        whileReading = [executeShown(rowExecute(document, 70)), inTasks, isShown('#map .dk-notice.is-warn')]
      }
      return answer(name, args)
    },
  })
  t.after(page.close)

  assert.deepEqual(whileReading, [['执行', false], false, false])
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', true])
})

test('a project configured again has its skills read again, by the timed reads too', async t => {
  let configured = true
  let copy = 'different'
  const page = await openPage({
    answer: (name, args) =>
      name === 'deck_skills'
        ? answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)) })
        : deckAt('/work/matt-deck', configured)(name, args),
  })
  t.after(page.close)
  assert.equal(noExecute(page)?.[0], 'Codex 里的 implement 不是同一份，不能预填执行。')

  configured = false
  copy = 'same'
  await page.advance(60_000)
  configured = true
  await page.advance(60_000)

  assert.equal(noExecute(page), undefined)
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', true])
})

test('a project configured again has "执行" off until the new read of its skills answers: clicked before, it fills in nothing', async t => {
  let configured = true
  let copy = 'same'
  let clicked = false
  const page = await openPage({
    answer: (name, args, document) => {
      if (name === 'deck_skills' && copy === 'different' && !clicked) {
        clicked = true
        ;(rowExecute(document, 70) as HTMLElement).click()
      }
      return name === 'deck_skills'
        ? answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)) })
        : deckAt('/work/matt-deck', configured)(name, args)
    },
  })
  t.after(page.close)
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', true])

  configured = false
  await page.advance(60_000)
  configured = true
  copy = 'different'
  await page.advance(60_000)

  assert.equal(clicked, true)
  assert.deepEqual(calledWith(page, 'deck_execute'), [])
  assert.deepEqual(prefills(page), [])
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', false])
  assert.equal(noExecute(page)?.[0], 'Codex 里的 implement 不是同一份，不能预填执行。')
})

test('a project found not configured has "执行" off and its skills read again once configured, though the Deck service fails to give the configure skill\'s call', async t => {
  let configured = true
  let copy = 'same'
  const page = await openPage({
    answer: (name, args) =>
      name === 'deck_configure' && !configured
        ? { content: [{ type: 'text', text: 'the configure skill is locked 2h7q' }], isError: true }
        : name === 'deck_skills'
          ? answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)) })
          : deckAt('/work/matt-deck', configured)(name, args),
  })
  t.after(page.close)
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', true])

  configured = false
  await page.advance(60_000)
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', false])

  configured = true
  copy = 'different'
  await page.advance(60_000)
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', false])
  assert.equal(noExecute(page)?.[0], 'Codex 里的 implement 不是同一份，不能预填执行。')
  assert.equal(calledWith(page, 'deck_skills').length, 2)
})

test('"执行" whose 5 seconds end after the project is configured again, before its skills are read, says 执行 again and stays off', async t => {
  let configured = true
  let hold: Promise<void> | undefined
  let release!: () => void
  const page = await openPage({
    answer: async (name, args) => {
      if (name === 'deck_skills') await hold
      return deckAt('/work/matt-deck', configured)(name, args)
    },
  })
  t.after(page.close)
  await page.click(rowExecute(page.document, 70))
  configured = false
  await page.show(false)
  await page.show(true)

  configured = true
  hold = new Promise(resolve => (release = resolve))
  const shownAgain = page.show(false).then(() => page.show(true))
  while (calledWith(page, 'deck_skills').length < 2) await new Promise(resolve => setTimeout(resolve, 5))
  const advanced = page.advance(5_000)
  await new Promise(resolve => setTimeout(resolve, 20))

  const whileReading = executeShown(rowExecute(page.document, 70))
  release()
  await Promise.all([shownAgain, advanced])

  assert.deepEqual(whileReading, ['执行', false])
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', true])
})

test('configured again, the detail\'s "执行" and the rows\' drawn before are off while the Tasks are read, and clicked fill in nothing', async t => {
  let configured = true
  let copy = 'same'
  let hold = false
  let whileReading: unknown
  const page = await openPage({
    answer: async (name, args, document) => {
      if (name === 'deck_tasks' && hold) {
        hold = false
        const bar = [...document.querySelectorAll('#into-end button')].find(each => text(each) === '执行')
        whileReading = [executeShown(bar), executeShown(rowExecute(document, 70))]
        ;(bar as HTMLElement | undefined)?.click()
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return name === 'deck_skills'
        ? answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)) })
        : deckAt('/work/matt-deck', configured)(name, args)
    },
  })
  t.after(page.close)
  await page.click(rowOf(page.document, 70))
  assert.deepEqual(executeShown(barExecute(page.document)), ['执行', true])

  configured = false
  await page.advance(60_000)
  configured = true
  copy = 'different'
  hold = true
  await page.advance(60_000)

  assert.deepEqual(whileReading, [['执行', false], ['执行', false]])
  assert.deepEqual(calledWith(page, 'deck_execute'), [])
  assert.deepEqual(prefills(page), [])
})

test('a detail drawn again while another step is shown over it has its "执行" drawn by the skills read since as the way goes back to it: off, it fills in nothing', async t => {
  const withBlocked = (blocked: object) => ({ ...TASKS, groups: { ...TASKS.groups, blocked: [blocked, WAITING] } })
  const blockedBy70 = withBlocked(task(73, '推荐：我现在该做什么', { blockers: [70], blockedBy: [70] }))
  const ready73 = { ...TASKS, groups: { ...TASKS.groups, ready: [READY, task(73, '推荐：我现在该做什么')], blocked: [WAITING] } }
  let tasks: object = blockedBy70
  let copy = 'same'
  let hold: Promise<void> | undefined
  let goingBack = false
  let whileBack: unknown
  const page = await openPage({
    answer: async (name, args: any, document) => {
      if (name === 'deck_task' && args.number === 73) {
        await hold
        if (goingBack) {
          goingBack = false
          const bar = [...document.querySelectorAll('#into-end button')].find(each => text(each) === '执行')
          whileBack = executeShown(bar)
          ;(bar as HTMLElement | undefined)?.click()
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      return name === 'deck_skills'
        ? answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)) })
        : deckAt('/work/matt-deck', true, tasks)(name, args)
    },
  })
  t.after(page.close)
  const { document } = page

  await page.click(rowOf(document, 73))
  assert.deepEqual(detailShown(page)?.bar, ['返回', '在 GitHub 打开'])

  // The timed read finds #73 ready and draws its detail again; while that
  // drawing waits, the person goes on to #70 from what is shown.
  tasks = ready73
  let release!: () => void
  hold = new Promise(resolve => (release = resolve))
  const timed = page.advance(60_000)
  while (calledWith(page, 'deck_task').filter(each => each.number === 73).length < 2) await new Promise(resolve => setTimeout(resolve, 5))
  ;([...document.querySelectorAll('.dk-detail .dk-edge')].find(edge => text(edge)!.includes('#70')) as HTMLElement).click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(detailShown(page)?.crumbs, '任务 / #73 / #70')
  release()
  await timed

  copy = 'different'
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(executeShown(barExecute(document)), ['执行', false])

  goingBack = true
  await page.click([...document.querySelectorAll('.dk-bar button')].find(each => text(each) === '返回')!)

  assert.deepEqual(whileBack, ['执行', false])
  assert.deepEqual(calledWith(page, 'deck_execute'), [])
  assert.deepEqual(prefills(page), [])
})

test('a read of the skills asked before a read finds the project not configured, answering after it, is dropped: configured again, "执行" is off with no notice in 任务 or 地图 until the next read of the skills answers', async t => {
  let configured = true
  let copy = 'same'
  let reads = 0
  let release!: () => void
  const wait = () => new Promise(resolve => setTimeout(resolve, 5))
  const page = await openPage({
    answer: async (name, args, document) => {
      // 下一步 opened while the first read of the Tasks is out reads the
      // skills itself.
      if (name === 'deck_tasks' && reads === 0) (tabNamed(document, '下一步') as HTMLElement).click()
      if (name !== 'deck_skills') return deckAt('/work/matt-deck', configured)(name, args)
      reads++
      const at = copy
      if (reads === 1) {
        // The first read of the Pane ends, then a read finds the project not
        // configured, before this read of the skills answers.
        const refresh = document.querySelector<HTMLButtonElement>('.dk-head button')!
        while (refresh.disabled) await wait()
        configured = false
        document.dispatchEvent(new document.defaultView!.Event('visibilitychange'))
        await wait()
        while (refresh.disabled) await wait()
      } else if (reads === 2) {
        await new Promise<void>(resolve => (release = resolve))
      }
      return answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy: at } : skill)) })
    },
  })
  t.after(page.close)
  assert.equal(reads, 1)

  // Configured again, with an implement Codex does not run.
  configured = true
  copy = 'different'
  page.document.dispatchEvent(new page.window.Event('visibilitychange'))
  while (reads < 2) await wait()
  await new Promise(resolve => setTimeout(resolve, 20))

  // Clicked meanwhile; the read of the skills still out, nothing settles.
  const click = async (element: Element | null) => {
    ;(element as HTMLElement).click()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await click(tabNamed(page.document, '任务'))
  const inTasks = noExecute(page)
  const row = executeShown(rowExecute(page.document, 70))
  await click(rowExecute(page.document, 70))
  await click(tabNamed(page.document, '地图'))
  const inMap = shown(page, page.document.querySelector('#map .dk-notice.is-warn'))
  release()
  await page.settled()

  assert.deepEqual([row, inTasks, inMap], [['执行', false], undefined, false])
  assert.deepEqual(calledWith(page, 'deck_execute'), [])
  assert.deepEqual(prefills(page), [])
  await page.click(tabNamed(page.document, '任务'))
  assert.equal(noExecute(page)?.[0], 'Codex 里的 implement 不是同一份，不能预填执行。')
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', false])
})

test('a read of the skills answered after a later one is dropped: "执行" goes by the later', async t => {
  let reads = 0
  let laterAnswered = false
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({
    answer: async (name, args, document) => {
      // The 技能 tab opened while the Tasks are read reads the skills first.
      if (name === 'deck_tasks' && reads === 0) (tabNamed(document, '技能') as HTMLElement).click()
      if (name !== 'deck_skills') return answer(name, args)
      reads++
      const copy = reads === 1 ? 'same' : 'different'
      if (reads === 1) {
        // "刷新" once the read it was off for ends, before this read answers.
        const refresh = document.querySelector<HTMLButtonElement>('.dk-head button')!
        while (refresh.disabled) await new Promise(resolve => setTimeout(resolve, 5))
        refresh.click()
        while (!laterAnswered) await new Promise(resolve => setTimeout(resolve, 5))
        await new Promise(resolve => setTimeout(resolve, 20))
      } else {
        laterAnswered = true
      }
      return answered({ ok: true, source: { type: 'plugin', name: 'mattpocock-skills' }, skills: SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)) })
    },
  })
  t.after(page.close)
  await page.click(tabNamed(page.document, '任务'))

  assert.equal(reads, 2)
  assert.deepEqual(executeShown(rowExecute(page.document, 70)), ['执行', false])
  assert.equal(noExecute(page)?.[0], 'Codex 里的 implement 不是同一份，不能预填执行。')
})

// A card of the Map View's wall by its Task's number.
const cardExecute = (document: Document, number: number) =>
  [...document.querySelectorAll('#map .dk-card')].find(card => text(card.querySelector('.dk-id')) === `#${number}`)!.querySelector('[data-execute]')

test('a ready Child Task\'s card on the wall has "执行", which fills in its Execute Prompt and stays in the Map View; it says 已填入 for 5 seconds, the timed reads in between too', async t => {
  const page = await openPage({ answer: deckAt('/work/matt-deck') })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))

  assert.deepEqual(executeShown(cardExecute(document, 70)), ['执行', true])
  assert.deepEqual([...cardExecute(document, 70)!.classList], ['dk-btn', 'dk-btn--sm', 'dk-btn--go'])
  assert.deepEqual(
    [74, 69, 72, 75, 76, 78, 19, 73, 66, 65].map(number => text(cardExecute(document, number))),
    [undefined, '接管', '接管', '接管', '接管', '接管', undefined, undefined, undefined, undefined],
  )

  await page.click(cardExecute(document, 70))

  assert.deepEqual(prefills(page), [prefilled(executePromptOf(70))])
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
  assert.equal(shown(page, document.querySelector('#map .dk-spec')), true)
  assert.equal(detailShown(page), undefined)
  await page.show(false)
  await page.show(true)
  assert.deepEqual(executeShown(cardExecute(document, 70)), ['已填入', false])
  // The row in "任务" says so too.
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['已填入', false])
  await page.advance(5_000)
  assert.deepEqual(executeShown(cardExecute(document, 70)), ['执行', true])
})

test('when Codex does not run this implement, the top of the 地图 tab says why too, with "重跑配置", and the wall\'s "执行" is off', async t => {
  const deck = deckThatRecommends(SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy: 'different' } : skill)))
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  const notice = document.querySelector('#map .dk-notice.is-warn')!

  assert.equal(shown(page, notice), true)
  assert.equal(document.querySelector('#map')!.firstElementChild, notice)
  assert.equal(notice.getAttribute('role'), 'status')
  assert.deepEqual([text(notice.querySelector('.dk-notice__title')), text(notice.querySelector('.dk-notice__text'))], [
    'Codex 里的 implement 不是同一份，不能预填执行。',
    '所有 Task 的“执行”先停用，重跑配置之后恢复。',
  ])
  // Said once, in the tab shown.
  assert.equal([...document.querySelectorAll('.dk-notice.is-warn')].filter(each => shown(page, each)).length, 1)
  assert.deepEqual(executeShown(cardExecute(document, 70)), ['执行', false])
  await page.click(notice.querySelector('button'))
  assert.deepEqual(prefills(page), [prefilled(CONFIGURE_CALL)])
})

test('a Spec or Map, ready as a Task, is not executed: its detail and its card on a wall have no "执行"', async t => {
  // Spec #81 under #64, ready as a Task, beside the ready #70.
  const child = { ...task(81, '子规格'), kind: 'spec', isPendingCloseout: false, group: 'ready', children: [], progress: { closed: 0, inProgress: 0, total: 0 } }
  const tasks = { ...TASKS, containers: [...TASKS.containers, child] }
  const maps = { ...MAPS, maps: [{ ...MAPS.maps[0], wall: [card(READY, 'ready'), card(child, 'ready')] }, ...MAPS.maps.slice(1)] }
  const page = await openPage({ answer: deckAt('/work/matt-deck', true, tasks, maps) })
  t.after(page.close)
  const { document } = page

  await page.click(rowOf(document, 64))
  assert.deepEqual(detailShown(page)?.bar, ['返回', '在 GitHub 打开'])

  await page.click(tabNamed(document, '地图'))
  assert.deepEqual(executeShown(cardExecute(document, 70)), ['执行', true])
  assert.equal(cardExecute(document, 81), null)
})

// Every "重跑配置" the page draws, as the person sees it, by where it is.
const reruns = (page: { window: any; document: Document }) =>
  Object.fromEntries(
    [
      ['tasks', '#tasks .dk-notice.is-warn button'],
      ['map', '#map .dk-notice.is-warn button'],
      ['skills', '#skill-list .dk-notice.is-warn button'],
      ['next', '#next button'],
    ].map(([where, selector]) => [
      where,
      [...page.document.querySelectorAll(selector!)].filter(each => text(each) === '重跑配置').map(each => !(each as HTMLButtonElement).disabled),
    ]),
  )

test('when the first read of the skills fails as a tool, "重跑配置" at the top of 任务 and 地图 still fills in the configure skill\'s call the Deck service gives', async t => {
  const answer = deckAt('/work/matt-deck')
  const page = await openPage({
    answer: (name, args) => (name === 'deck_skills' ? { content: [{ type: 'text', text: 'boom' }], isError: true } : answer(name, args)),
  })
  t.after(page.close)

  assert.deepEqual(noExecute(page), ['读取 Skill Source 失败，不能预填执行。', 'Deck 服务出错：boom。点“刷新”重试。'])
  await page.click(page.document.querySelector('#tasks .dk-notice.is-warn button'))
  await page.advance(5_000)
  await page.click(page.document.querySelector('#map .dk-notice.is-warn button'))

  assert.deepEqual(prefills(page), [prefilled(CONFIGURE_CALL), prefilled(CONFIGURE_CALL)])
})

test('when the Deck service does not give the configure skill\'s call, every "重跑配置" is off and fills in nothing; given on "刷新", each is on, and a later read that gives none keeps the one given', async t => {
  let isConfigureGiven = false
  // implement, ask-matt and tdd are not the files Codex finds.
  const deck = deckThatRecommends(SKILLS.map(skill => (['implement', 'ask-matt'].includes(skill.name) ? { ...skill, copy: 'different' } : skill)))
  const page = await openPage({
    answer: (name, args) =>
      name === 'deck_configure' && !isConfigureGiven ? { content: [{ type: 'text', text: 'no call' }], isError: true } : deck.answer(name, args),
  })
  t.after(page.close)
  // The skills are read all the same.
  assert.equal(noExecute(page)?.[0], 'Codex 里的 implement 不是同一份，不能预填执行。')
  await page.click(tabNamed(page.document, '下一步'))
  assert.deepEqual(reruns(page), { tasks: [false], map: [false], skills: [false], next: [false] })
  for (const each of page.document.querySelectorAll('button')) {
    if (text(each) === '重跑配置') await page.click(each)
  }
  assert.deepEqual(prefills(page), [])

  isConfigureGiven = true
  await page.click(page.document.querySelector('.dk-head button'))
  assert.deepEqual(reruns(page), { tasks: [true], map: [true], skills: [true], next: [true] })

  isConfigureGiven = false
  await page.click(page.document.querySelector('.dk-head button'))
  assert.deepEqual(reruns(page), { tasks: [true], map: [true], skills: [true], next: [true] })
  await page.click(page.document.querySelector('#tasks .dk-notice.is-warn button'))
  assert.deepEqual(prefills(page), [prefilled(CONFIGURE_CALL)])
})

// The notice that Deck's hook never ran, as the person sees it: its title,
// its button, and the steps under them, if shown; undefined while it is not.
const hookNotice = (page: { window: any; document: Document }) => {
  const notice = [...page.document.querySelectorAll('.dk-notice')].find(each => text(each.querySelector('.dk-notice__title'))?.startsWith('钩子'))
  if (!shown(page, notice ?? null)) return undefined
  const steps = [...notice!.querySelectorAll('li')].filter(step => shown(page, step)).map(text)
  return [text(notice!.querySelector('.dk-notice__title')), text(notice!.querySelector('button')), steps]
}
const HOOK_TITLE = '钩子未生效，开始执行不会登记占用。'
const HOOK_STEPS = ['在终端里运行一次 codex。', '在钩子审查里信任 Deck 的钩子。', '重启桌面应用。']

// A Deck service whose hook's tool has received a call when `receivedAt`
// says it has.
const deckWithHook = (hook: { receivedAt: number | null }, answer = deckWithSkills()) => (name: string, args: any) =>
  name === 'deck_hook' ? answered(hook) : answer(name, args)

test('where Deck\'s hook never ran, the Pane says so in an orange notice between the head and the tabs, in every tab and in a Task\'s detail, one line until "怎么做" shows the three steps and "收起" hides them', async t => {
  const page = await openPage({ answer: deckWithHook({ receivedAt: null }) })
  t.after(page.close)
  const { document } = page
  const notice = [...document.querySelectorAll('.dk-notice')].find(each => text(each.querySelector('.dk-notice__title')) === HOOK_TITLE)!

  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '怎么做', []])
  assert.ok(notice.classList.contains('is-warn'))
  assert.equal(notice.getAttribute('role'), 'status')
  // Between the head and the tabs, which stay at the top as the page scrolls.
  assert.equal(notice.previousElementSibling, document.querySelector('.dk-head'))
  assert.equal(notice.nextElementSibling, document.querySelector('[role="tablist"]'))
  assert.equal(notice.querySelector('code')?.textContent, 'codex')

  await page.click(notice.querySelector('button'))
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '收起', HOOK_STEPS])
  // Shown in every tab, and in a Task's detail, as the person left it.
  for (const tab of ['下一步', '地图', '技能', '任务']) {
    await page.click(tabNamed(document, tab))
    assert.deepEqual(hookNotice(page), [HOOK_TITLE, '收起', HOOK_STEPS], tab)
  }
  await page.click(rowOf(document, 70))
  assert.equal(text(document.querySelector('#crumbs')), '任务 / #70')
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '收起', HOOK_STEPS])
  // Read again, it is as the person left it.
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '收起', HOOK_STEPS])

  await page.click(notice.querySelector('button'))
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '怎么做', []])
  // Nothing closes it.
  assert.equal(notice.querySelectorAll('button').length, 1)
})

test('the notice that Deck\'s hook never ran goes with the first read that finds a call from it received, and comes back with one that finds none', async t => {
  const hook: { receivedAt: number | null } = { receivedAt: null }
  const page = await openPage({ answer: deckWithHook(hook) })
  t.after(page.close)
  const hooks = () => page.sent.filter(message => message.method === 'tools/call' && message.params.name === 'deck_hook').length

  assert.equal(hookNotice(page)?.[0], HOOK_TITLE)
  assert.equal(hooks(), 1)
  hook.receivedAt = Date.UTC(2026, 10, 26, 9, 0)
  // The read every 60 seconds while the tab is shown.
  await page.advance(60_000)
  assert.equal(hooks(), 2)
  assert.equal(hookNotice(page), undefined)

  hook.receivedAt = null
  await page.click(page.document.querySelector('.dk-head button'))
  assert.equal(hookNotice(page)?.[0], HOOK_TITLE)
})

test('in a project that is not configured the Pane asks nothing of Deck\'s hook and says nothing of it; configured, it does', async t => {
  let isConfigured = false
  const configured = deckWithHook({ receivedAt: null })
  const unconfigured = deckAt('/work/matt-deck', false)
  const page = await openPage({ answer: (name, args) => (isConfigured ? configured : unconfigured)(name, args) })
  t.after(page.close)
  const hooks = () => page.sent.filter(message => message.method === 'tools/call' && message.params.name === 'deck_hook').length

  assert.equal(text(page.document.querySelector('.dk-empty__title')), '此项目未配置。')
  assert.equal(hookNotice(page), undefined)
  assert.equal(hooks(), 0)

  isConfigured = true
  await page.click(page.document.querySelector('.dk-head button'))
  assert.equal(hookNotice(page)?.[0], HOOK_TITLE)
  assert.equal(hooks(), 1)

  isConfigured = false
  await page.click(page.document.querySelector('.dk-head button'))
  assert.equal(hookNotice(page), undefined)
  assert.equal(hooks(), 1)
})

// A Deck service that cannot say when its hook's tool last received a call,
// as when the local state is not a database, while the project config and
// the Session read as usual.
const HOOK_FAILED = { content: [{ type: 'text', text: 'file is not a database' }], isError: true }

test('where the Deck service cannot say whether Deck\'s hook ever ran, the first read shows no notice of it and reads the rest as usual', async t => {
  const page = await openPage({ answer: (name, args) => (name === 'deck_hook' ? HOOK_FAILED : deckWithSkills()(name, args)) })
  t.after(page.close)
  const { document } = page
  const called = (tool: string) => page.sent.filter(message => message.method === 'tools/call' && message.params.name === tool).length
  const configFailed = [...document.querySelectorAll('.dk-notice__title')].find(title => text(title) === '读取项目配置失败')!

  assert.equal(hookNotice(page), undefined)
  assert.equal(shown(page, configFailed), false)
  assert.equal(shown(page, document.querySelector('[role="tablist"]')), true)
  assert.deepEqual([called('deck_tasks'), called('deck_skills')], [1, 1])
  assert.ok(shown(page, rowOf(document, 70)))
})

test('where the Deck service can no longer say whether Deck\'s hook ever ran, a later read hides the notice of it and reads the rest as usual', async t => {
  let hookFails = false
  const answer = deckWithHook({ receivedAt: null })
  const page = await openPage({ answer: (name, args) => (name === 'deck_hook' && hookFails ? HOOK_FAILED : answer(name, args)) })
  t.after(page.close)
  const { document } = page
  const called = (tool: string) => page.sent.filter(message => message.method === 'tools/call' && message.params.name === tool).length
  const configFailed = [...document.querySelectorAll('.dk-notice__title')].find(title => text(title) === '读取项目配置失败')!

  assert.equal(hookNotice(page)?.[0], HOOK_TITLE)
  hookFails = true
  await page.click(document.querySelector('.dk-head button'))

  assert.equal(hookNotice(page), undefined)
  assert.equal(shown(page, configFailed), false)
  assert.equal(shown(page, document.querySelector('[role="tablist"]')), true)
  assert.deepEqual([called('deck_tasks'), called('deck_skills')], [2, 2])
  assert.equal(text(document.querySelector('.dk-head__fresh')), '刚刚')
  assert.ok(shown(page, rowOf(document, 70)))
})

// A Deck service whose Occupancies deck_occupy and deck_release move, as its
// deck_tasks and deck_map then list them: taken over, a Task is this
// Session's; released, it is ready. `occupy` answers deck_occupy instead,
// where a test has it answer otherwise.
type Held = Omit<ReturnType<typeof task>, 'occupant' | 'occupantHost' | 'occupantShort'> & {
  occupant: string | null
  occupantHost: string | null
  occupantShort: string | null
}
const deckThatOccupies = (inProgress: Held[] = TASKS.groups.inProgress, occupy?: (args: any) => object | Promise<object>) => {
  const groups = { ...TASKS.groups, ready: [...TASKS.groups.ready] as Held[], inProgress: [...inProgress] }
  const answer = (name: string, args: any) => {
    if (name === 'deck_tasks') return answered({ ...TASKS, groups: { ...groups, ready: [...groups.ready], inProgress: [...groups.inProgress] } })
    if (name === 'deck_map') {
      const now = (listed: any) =>
        [...groups.ready.map(each => [each, 'ready']), ...groups.inProgress.map(each => [each, 'inProgress'])].find(([each]) => (each as any).number === listed.number)
      const wall = MAPS.maps[0]!.wall.map((each: any) => {
        const found = now(each)
        return found === undefined ? each : card(found[0] as object, found[1] as string, { blocking: each.blocking })
      })
      return answered({ ...MAPS, maps: [{ ...MAPS.maps[0], wall }, MAPS.maps[1]] })
    }
    if (name === 'deck_occupy') {
      const held = groups.inProgress.findIndex(each => each.number === args.task)
      if (held !== -1 && groups.inProgress[held]!.occupant === args.takeOver) {
        groups.inProgress[held] = { ...groups.inProgress[held]!, occupant: SESSION.session, occupantHost: 'codex', occupantShort: '045b96fc', isOrphaned: false }
      }
      const now = groups.inProgress[held]!
      return answered(
        now.occupant === args.session
          ? { ok: true, occupied: true, occupant: now.occupant, occupantHost: now.occupantHost, occupantShort: now.occupantShort }
          : { ok: true, occupied: false, occupant: now.occupant, occupantHost: now.occupantHost, occupantShort: now.occupantShort, isOrphaned: now.isOrphaned },
      )
    }
    if (name === 'deck_release') {
      const held = groups.inProgress.findIndex(each => each.number === args.task && each.occupant === args.session)
      if (held !== -1) {
        const [released] = groups.inProgress.splice(held, 1)
        groups.ready.push({ ...released!, occupant: null, occupantHost: null, occupantShort: null, isOrphaned: false })
      }
      return answered({ ok: true, released: held !== -1 })
    }
    return deckAt('/work/matt-deck')(name, args)
  }
  return {
    groups,
    answer: (name: string, args: any) => (name === 'deck_occupy' && occupy !== undefined ? occupy(args) : answer(name, args)),
    occupyAsIs: (args: any) => answer('deck_occupy', args),
  }
}

// The labels of the buttons in an element, each with whether it is on.
const buttonsIn = (element: Element | null | undefined) =>
  element === null || element === undefined
    ? undefined
    : [...element.querySelectorAll('button')].map(each => `${text(each)}${(each as HTMLButtonElement).disabled ? '（停用）' : ''}`)
const rowButton = (document: Document, number: number, label: string) =>
  [...rowOf(document, number).querySelectorAll('button')].find(each => text(each) === label)!
const wallCard = (document: Document, number: number) =>
  [...document.querySelectorAll('#map .dk-card')].find(each => text(each.querySelector('.dk-id')) === `#${number}`)
const barButton = (document: Document, label: string) => [...document.querySelectorAll('.dk-bar button')].find(each => text(each) === label)!
// The confirmation of a takeover, as the person reads it, if one is shown:
// its glyph, title and words, and its buttons.
const askShown = (page: { window: any; document: Document }) => {
  const asks = [...page.document.querySelectorAll('.dk-notice')].filter(
    each => shown(page, each) && [...each.querySelectorAll('button')].some(button => text(button) === '取消'),
  )
  assert.ok(asks.length <= 1, 'one confirmation at most')
  const ask = asks[0]
  if (ask !== undefined) {
    assert.deepEqual([...ask.classList], ['dk-notice', 'is-warn'])
    assert.deepEqual([...ask.querySelector('.dk-notice__title')!.classList], ['dk-notice__title', 'heading'])
    assert.deepEqual([...ask.querySelector('button')!.parentElement!.classList], ['dk-notice__actions'])
  }
  return ask === undefined
    ? undefined
    : {
        role: ask.getAttribute('role'),
        glyph: ask.querySelector('.dk-plate')?.getAttribute('aria-label'),
        title: text(ask.querySelector('.dk-notice__title')),
        said: text(ask.querySelector('.dk-notice__text')),
        buttons: buttonsIn(ask),
      }
}
const askButton = (document: Document, label: string) =>
  [...document.querySelectorAll('.dk-notice button')].find(each => text(each) === label)!
// The rows of the "进行中" group, a confirmation where it stands.
const inProgressRows = (document: Document) =>
  [...[...document.querySelectorAll('#groups .dk-group')].find(group => text(group.querySelector('.dk-group__head'))?.startsWith('进行中'))!.querySelector('.dk-list')!.children].map(
    each => (each.matches('.dk-row') ? text(each.querySelector('.dk-id')) : each.querySelector('.dk-notice') !== null ? '确认' : text(each)),
  )
// Where the person's focus is: the button's label, and whether it is in the
// confirmation.
const focused = (document: Document) => [text(document.activeElement), document.activeElement?.closest('.dk-notice') !== null]
const ASK_SAID = '接管会把 Occupancy 转给本 Session。'

test('a Task another Session holds has "接管" on its row, an Orphaned one "接管" and "释放", this Session\'s "释放"; its detail has the same, and on the wall an Orphaned card has "接管" alone', async t => {
  const page = await openPage({ answer: deckThatOccupies().answer })
  t.after(page.close)
  const { document } = page

  assert.deepEqual(
    [74, 72, 69, 75].map(number => buttonsIn(rowOf(document, number).querySelector('.dk-row__actions'))),
    [['释放'], ['接管'], ['接管'], ['接管', '释放']],
  )
  for (const each of rowOf(document, 75).querySelectorAll('button')) assert.deepEqual([...each.classList], ['dk-btn', 'dk-btn--sm'])

  for (const [number, bar] of [
    [74, ['返回', '释放', '在 GitHub 打开']],
    [72, ['返回', '接管', '在 GitHub 打开']],
    [69, ['返回', '接管', '在 GitHub 打开']],
    [75, ['返回', '接管', '释放', '在 GitHub 打开']],
  ] as const) {
    await page.click(rowOf(document, number))
    assert.deepEqual(detailShown(page)?.bar, bar)
    await page.click(barButton(document, '返回'))
  }

  await page.click(tabNamed(document, '地图'))
  assert.deepEqual(
    [74, 69, 72, 75, 76, 78].map(number => buttonsIn(wallCard(document, number)!.querySelector('.dk-card__foot'))),
    [['释放'], ['接管'], ['接管'], ['接管'], ['接管'], ['接管']],
  )
  assert.deepEqual([...wallCard(document, 75)!.querySelector('button')!.classList], ['dk-btn', 'dk-btn--sm'])
})

test('"接管" on a row asks in the row\'s place, the rest of the list as it was, the focus on "取消": who executes the Task, of the other Host by its name, or that its Session ended', async t => {
  const deck = deckThatOccupies()
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page

  for (const [number, glyph, title, rows] of [
    [72, '进行中 · 其他 Session', '#72 正由 Session 77e0aa15 执行', ['#74', '确认', '#69', '#75']],
    [69, '进行中 · 其他 Session', '#69 正由 Claude Code 3f9c21d0 执行', ['#74', '#72', '确认', '#75']],
    [75, 'Orphaned', '#75 的 Session 已结束', ['#74', '#72', '#69', '确认']],
  ] as const) {
    await page.click(rowButton(document, number, '接管'))

    assert.deepEqual(askShown(page), { role: 'status', glyph, title, said: ASK_SAID, buttons: ['接管', '取消'] })
    assert.deepEqual(inProgressRows(document), rows)
    assert.deepEqual(focused(document), ['取消', true])
    assert.deepEqual([...askButton(document, '接管').classList], ['dk-btn'])
    assert.deepEqual([...askButton(document, '取消').classList], ['dk-btn', 'dk-btn--quiet'])
    // Asked, nothing moves and nothing is filled in; no detail opens.
    assert.equal(detailShown(page), undefined)
    assert.deepEqual(calledWith(page, 'deck_occupy'), [])
    assert.deepEqual(prefills(page), [])

    await page.click(askButton(document, '取消'))

    assert.equal(askShown(page), undefined)
    assert.deepEqual(inProgressRows(document), ['#74', '#72', '#69', '#75'])
    assert.equal(detailShown(page), undefined)
  }
  // Cancelled, nothing moved, read again or not.
  await page.advance(60_000)
  assert.equal(askShown(page), undefined)
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
  assert.deepEqual(prefills(page), [])
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 77e0aa15 ready-for-agent')
})

test('"接管" in the confirmation moves the Occupancy to this Session, from the Session holding it, then fills in the Execute Prompt, unsent; the row is this Session\'s', async t => {
  for (const [number, from] of [
    [72, OTHER_CODEX],
    [69, CLAUDE_CODE],
    [75, OTHER_CODEX],
  ] as const) {
    const deck = deckThatOccupies()
    // The confirmation while the Deck service moves the Occupancy.
    let whileMoving: unknown
    const page = await openPage({
      answer: (name, args, document) => {
        if (name === 'deck_occupy') whileMoving = [askShown({ window: page.window, document }), prefills(page).length]
        return deck.answer(name, args)
      },
    })
    t.after(page.close)
    const { document } = page
    await page.click(rowButton(document, number, '接管'))
    const readBefore = calledWith(page, 'deck_tasks').length

    await page.click(askButton(document, '接管'))

    // Off from the click, so a second click moves nothing twice; "取消"
    // with it, as closing the asking would not stop the move.
    assert.deepEqual((whileMoving as any)[0].buttons, ['接管（停用）', '取消（停用）'])
    assert.equal((whileMoving as any)[1], 0)
    assert.deepEqual(calledWith(page, 'deck_occupy'), [{ session: SESSION.session, task: number, takeOver: from }])
    assert.deepEqual(prefills(page), [prefilled(executePromptOf(number))])
    assert.deepEqual(calledWith(page, 'deck_execute'), [{ task: number }])
    // Moved first, then read again, then filled in.
    const order = page.sent.filter(each => each.method === 'ui/message' || ['deck_occupy', 'deck_execute'].includes(each.params?.name)).map(each => each.params.name ?? 'prefill')
    assert.deepEqual(order, ['deck_occupy', 'deck_execute', 'prefill'])
    assert.equal(calledWith(page, 'deck_tasks').length, readBefore + 1)
    assert.equal(askShown(page), undefined)
    assert.equal(text(rowOf(document, number).querySelector('.dk-row__meta')), '进行中 · 本 Session ready-for-agent')
    assert.deepEqual(buttonsIn(rowOf(document, number).querySelector('.dk-row__actions')), ['释放'])
  }
})

test('the confirmation stays where it was asked, the focus on it, through the timed reads, the read as the tab is shown again and "刷新"; a focus the person moved elsewhere stays there', async t => {
  const page = await openPage({ answer: deckThatOccupies().answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))
  const asked = askShown(page)

  await page.advance(60_000)
  assert.deepEqual(askShown(page), asked)
  assert.deepEqual(inProgressRows(document), ['#74', '确认', '#69', '#75'])
  assert.deepEqual(focused(document), ['取消', true])

  ;(askButton(document, '接管') as HTMLElement).focus()
  await page.show(false)
  await page.show(true)
  assert.deepEqual(askShown(page), asked)
  assert.deepEqual(focused(document), ['接管', true])

  // Drawn anew, the first time it was shown is not again.
  ;(document.querySelector('#filter button') as HTMLElement).focus()
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(askShown(page), asked)
  assert.deepEqual(focused(document), [text(document.querySelector('#filter button')), false])

  // Moved onto nothing in the page: a click on its blank, or back into Codex.
  ;(askButton(document, '取消') as HTMLElement).focus()
  ;(document.activeElement as HTMLElement).blur()
  await page.advance(60_000)
  assert.deepEqual(askShown(page), asked)
  assert.equal(focused(document)[1], false)
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
})

test('"释放" releases the Occupancy without asking, this Session\'s or an Orphaned one\'s, and the Task goes back to "可执行"', async t => {
  const deck = deckThatOccupies()
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page

  await page.click(rowButton(document, 74, '释放'))

  assert.deepEqual(calledWith(page, 'deck_release'), [{ task: 74, session: SESSION.session }])
  assert.equal(askShown(page), undefined)
  assert.equal(detailShown(page), undefined)
  assert.deepEqual(inProgressRows(document), ['#72', '#69', '#75'])
  assert.deepEqual(groupsShown(document)[0]!.slice(0, 1), ['可执行 2'])
  assert.deepEqual(buttonsIn(rowOf(document, 74).querySelector('.dk-row__actions')), ['执行'])

  await page.click(rowButton(document, 75, '释放'))

  assert.deepEqual(calledWith(page, 'deck_release').at(-1), { task: 75, session: OTHER_CODEX })
  assert.deepEqual(inProgressRows(document), ['#72', '#69'])
  assert.equal(text(rowOf(document, 75).querySelector('.dk-row__meta')), '可执行 ready-for-agent')
  assert.deepEqual(prefills(page), [])
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
})

test('an Orphaned Occupancy a Claude Code Session holds is taken over and released as one of Codex\'s is', async t => {
  const orphaned = task(81, '失联的 Claude Code', { occupant: CLAUDE_CODE, occupantHost: 'claude-code', occupantShort: '3f9c21d0', isOrphaned: true })
  for (const label of ['接管', '释放']) {
    const deck = deckThatOccupies([...TASKS.groups.inProgress, orphaned])
    const page = await openPage({ answer: deck.answer })
    t.after(page.close)
    const { document } = page
    assert.deepEqual(buttonsIn(rowOf(document, 81).querySelector('.dk-row__actions')), ['接管', '释放'])

    await page.click(rowButton(document, 81, label))
    if (label === '接管') {
      assert.equal(askShown(page)?.title, '#81 的 Session 已结束')
      await page.click(askButton(document, '接管'))
      assert.deepEqual(calledWith(page, 'deck_occupy'), [{ session: SESSION.session, task: 81, takeOver: CLAUDE_CODE }])
      assert.deepEqual(prefills(page), [prefilled(executePromptOf(81))])
      assert.equal(text(rowOf(document, 81).querySelector('.dk-row__meta')), '进行中 · 本 Session ready-for-agent')
    } else {
      assert.deepEqual(calledWith(page, 'deck_release'), [{ task: 81, session: CLAUDE_CODE }])
      assert.equal(text(rowOf(document, 81).querySelector('.dk-row__meta')), '可执行 ready-for-agent')
    }
  }
})

test('on the wall, "接管" asks in the card\'s place and "释放" releases; taken over, the Execute Prompt is filled in and the Map View stays', async t => {
  const deck = deckThatOccupies()
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  const wall = () => [...document.querySelector('#map .dk-wall')!.children].map(each => (each.matches('.dk-card') ? text(each.querySelector('.dk-id')) : '确认'))
  const before = wall()

  await page.click(wallCard(document, 72)!.querySelector('button'))

  assert.deepEqual(askShown(page), { role: 'status', glyph: '进行中 · 其他 Session', title: '#72 正由 Session 77e0aa15 执行', said: ASK_SAID, buttons: ['接管', '取消'] })
  assert.deepEqual(wall(), before.map(each => (each === '#72' ? '确认' : each)))
  assert.deepEqual(focused(document), ['取消', true])
  assert.equal(detailShown(page), undefined)
  await page.advance(60_000)
  assert.deepEqual(wall(), before.map(each => (each === '#72' ? '确认' : each)))

  await page.click(askButton(document, '接管'))

  assert.deepEqual(calledWith(page, 'deck_occupy'), [{ session: SESSION.session, task: 72, takeOver: OTHER_CODEX }])
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(72))])
  assert.equal(askShown(page), undefined)
  assert.ok(shown(page, document.querySelector('#map .dk-wall')))
  assert.deepEqual(buttonsIn(wallCard(document, 72)!.querySelector('.dk-card__foot')), ['释放'])

  await page.click(wallCard(document, 72)!.querySelector('button'))
  assert.deepEqual(calledWith(page, 'deck_release'), [{ task: 72, session: SESSION.session }])
  // Its Execute Prompt filled in 5 seconds ago at most, its "执行" is off.
  assert.deepEqual(buttonsIn(wallCard(document, 72)!.querySelector('.dk-card__foot')), ['已填入（停用）'])
  await page.advance(5_000)
  assert.deepEqual(buttonsIn(wallCard(document, 72)!.querySelector('.dk-card__foot')), ['执行'])

  // An Orphaned card asks in its own place too, its glyph the small one.
  await page.click(wallCard(document, 75)!.querySelector('button'))
  assert.equal(askShown(page)?.title, '#75 的 Session 已结束')
  assert.equal(document.querySelector('#map .dk-wall .dk-notice .dk-plate')!.classList.contains('dk-plate--sm'), true)
})

test('a card the Map View, read just after the Tasks, finds this Session\'s is drawn as this Session\'s, not asking, though the Tasks said another Session held it', async t => {
  const deck = deckThatOccupies()
  let isMoving = false
  const page = await openPage({
    answer: (name: string, args: any) => {
      const answered = deck.answer(name, args)
      if (name === 'deck_tasks' && isMoving) {
        isMoving = false
        const held = deck.groups.inProgress.findIndex(each => each.number === 72)
        deck.groups.inProgress[held] = { ...deck.groups.inProgress[held]!, occupant: SESSION.session, occupantHost: 'codex', occupantShort: '045b96fc', isOrphaned: false }
      }
      return answered
    },
  })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '地图'))
  await page.click(wallCard(document, 72)!.querySelector('button'))
  assert.equal(askShown(page)?.title, '#72 正由 Session 77e0aa15 执行')

  isMoving = true
  await page.advance(60_000)

  assert.equal(askShown(page), undefined)
  assert.deepEqual(buttonsIn(wallCard(document, 72)!.querySelector('.dk-card__foot')), ['释放'])
})

test('in a Task\'s detail, "接管" asks under the way back, and taken over the bar has "释放"; "释放" there releases and the bar has "执行"', async t => {
  const deck = deckThatOccupies()
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowOf(document, 75))

  await page.click(barButton(document, '接管'))

  assert.deepEqual(askShown(page), { role: 'status', glyph: 'Orphaned', title: '#75 的 Session 已结束', said: ASK_SAID, buttons: ['接管', '取消'] })
  assert.equal(document.querySelector('#into-body')!.firstElementChild!.matches('.dk-notice'), true)
  assert.equal(detailShown(page)?.title, '#75 心跳与 Orphaned')
  assert.deepEqual(focused(document), ['取消', true])
  // The detail read again with the Tasks keeps it.
  await page.advance(60_000)
  assert.equal(askShown(page)?.title, '#75 的 Session 已结束')
  assert.deepEqual(focused(document), ['取消', true])

  await page.click(askButton(document, '接管'))

  assert.deepEqual(calledWith(page, 'deck_occupy'), [{ session: SESSION.session, task: 75, takeOver: OTHER_CODEX }])
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(75))])
  assert.equal(askShown(page), undefined)
  assert.deepEqual(detailShown(page)?.bar, ['返回', '释放', '在 GitHub 打开'])

  await page.click(barButton(document, '释放'))
  assert.deepEqual(calledWith(page, 'deck_release'), [{ task: 75, session: SESSION.session }])
  assert.deepEqual(detailShown(page)?.bar, ['返回', '已填入', '在 GitHub 打开'])
  await page.advance(5_000)
  assert.deepEqual(detailShown(page)?.bar, ['返回', '执行', '在 GitHub 打开'])
})

test('the Recommendation\'s "执行这个 Task" for a Task another Session holds asks in the button\'s place; taken over, it fills in the Execute Prompt and says 已填入 for 5 seconds', async t => {
  const deck = deckThatOccupies()
  const recommending = deckThatRecommends()
  const page = await openNext({ answer: (name, args) => (['deck_ask', 'deck_recommendation'].includes(name) ? recommending.answer(name, args) : deck.answer(name, args)) })
  t.after(page.close)
  const { document } = page
  await page.click(button(page, '我现在该做什么'))
  recommending.reported.set('request-1', { ...RECOMMENDATION, task: 69 })
  await page.advance(2_000)
  const card = () => document.querySelector('.dk-rec')!
  assert.deepEqual(buttonsIn(card()), ['执行这个 Task'])

  await page.click(card().querySelector('button'))

  assert.deepEqual(askShown(page), { role: 'status', glyph: '进行中 · 其他 Session', title: '#69 正由 Claude Code 3f9c21d0 执行', said: ASK_SAID, buttons: ['接管', '取消'] })
  assert.equal(card().lastElementChild!.matches('.dk-notice'), true)
  assert.deepEqual(fields(page).slice(0, 2), ['下一步', RECOMMENDATION.nextStep])
  assert.deepEqual(focused(document), ['取消', true])
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
  await page.advance(60_000)
  assert.equal(askShown(page)?.title, '#69 正由 Claude Code 3f9c21d0 执行')
  assert.deepEqual(focused(document), ['取消', true])

  await page.click(askButton(document, '接管'))

  assert.deepEqual(calledWith(page, 'deck_occupy'), [{ session: SESSION.session, task: 69, takeOver: CLAUDE_CODE }])
  assert.deepEqual(prefills(page).at(-1), prefilled(executePromptOf(69)))
  assert.equal(askShown(page), undefined)
  assert.deepEqual(buttonsIn(card()), ['已填入（停用）'])
  await page.advance(5_000)
  assert.deepEqual(buttonsIn(card()), ['执行这个 Task'])

  // Orphaned, it asks so.
  await page.click(button(page, '再问一次'))
  recommending.reported.set('request-2', { ...RECOMMENDATION, task: 75 })
  await page.advance(2_000)
  await page.click(card().querySelector('button'))
  assert.equal(askShown(page)?.title, '#75 的 Session 已结束')
  await page.click(askButton(document, '取消'))
  assert.equal(askShown(page), undefined)
  assert.deepEqual(buttonsIn(card()), ['执行这个 Task'])
  assert.equal(calledWith(page, 'deck_occupy').length, 1)
})

test('when Codex does not run this implement, every "接管" is off, the confirmation\'s too, and "释放" is on', async t => {
  const skills = SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy: 'different' } : skill))
  const deck = deckThatOccupies()
  const page = await openPage({ answer: (name, args) => (name === 'deck_skills' ? deckWithSkills(skills)(name, args) : deck.answer(name, args)) })
  t.after(page.close)
  const { document } = page

  assert.deepEqual(
    [74, 72, 75].map(number => buttonsIn(rowOf(document, number).querySelector('.dk-row__actions'))),
    [['释放'], ['接管（停用）'], ['接管（停用）', '释放']],
  )
  await page.click(rowOf(document, 72))
  assert.deepEqual(buttonsIn(document.querySelector('.dk-bar')), ['返回', '接管（停用）', '在 GitHub 打开'])
  await page.click(barButton(document, '返回'))
  await page.click(tabNamed(document, '地图'))
  assert.deepEqual(buttonsIn(wallCard(document, 75)!.querySelector('.dk-card__foot')), ['接管（停用）'])
})

test('a confirmation asked as implement is read the same has "接管" off once a read finds it is not, and on again once it is', async t => {
  let copy = 'same'
  const deck = deckThatOccupies()
  const page = await openPage({
    answer: (name, args) =>
      name === 'deck_skills' ? deckWithSkills(SKILLS.map(skill => (skill.name === 'implement' ? { ...skill, copy } : skill)))(name, args) : deck.answer(name, args),
  })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  copy = 'missing'
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(askShown(page)?.buttons, ['接管（停用）', '取消'])
  await page.click(askButton(document, '接管'))
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])

  copy = 'same'
  await page.click(document.querySelector('.dk-head button'))
  assert.deepEqual(askShown(page)?.buttons, ['接管', '取消'])
})

test('when the Occupancy cannot be moved the confirmation stays and says why in the Pane\'s own words, to click "接管" again; nothing is filled in', async t => {
  let failing: object | undefined = answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } })
  const deck = deckThatOccupies(TASKS.groups.inProgress, args => failing ?? deck.occupyAsIs(args))
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  for (const [answer, said] of [
    [answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } }), '连不上 GitHub。检查网络后再点“接管”重试。'],
    [answered({ ok: false, failure: { kind: 'unauthenticated', message: 'not logged in 3w8e' } }), 'gh 未登录。运行 gh auth login 后再点“接管”重试。'],
    [answered({ ok: false, failure: { kind: 'failed', message: 'exit 1 <b>4k2m</b>' } }), 'gh 出错：exit 1 <b>4k2m</b>。再点“接管”重试。'],
    [{ content: [{ type: 'text', text: 'deck_occupy broke 8p0z' }], isError: true }, 'Deck 服务出错：deck_occupy broke 8p0z。再点“接管”重试。'],
  ] as const) {
    failing = answer
    await page.click(askButton(document, '接管'))

    assert.deepEqual(askShown(page), { role: 'status', glyph: '进行中 · 其他 Session', title: '#72 正由 Session 77e0aa15 执行', said, buttons: ['接管', '取消'] })
    assert.deepEqual(inProgressRows(document), ['#74', '确认', '#69', '#75'])
    assert.deepEqual(prefills(page), [])
    assert.deepEqual(calledWith(page, 'deck_execute'), [])
    // The reason as text, the Pane's own code as code.
    assert.equal(document.querySelector('.dk-notice__text b'), null)
    assert.equal(document.querySelectorAll('.dk-notice__text code').length, said.startsWith('gh ') ? 1 + Number(said.includes('gh auth login')) : 0)
    // Read again, it still says why.
    await page.advance(60_000)
    assert.equal(askShown(page)?.said, said)
  }

  failing = undefined
  await page.click(askButton(document, '接管'))
  assert.equal(askShown(page), undefined)
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(72))])

  // Asked anew, it says what taking over does again.
  failing = answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } })
  await page.click(rowButton(document, 69, '接管'))
  await page.click(askButton(document, '接管'))
  await page.click(askButton(document, '取消'))
  await page.click(rowButton(document, 69, '接管'))
  assert.equal(askShown(page)?.said, ASK_SAID)
})

test('a takeover that moved nothing leaves the focus on the confirmation\'s "接管" it was on, there still as the timed reads draw it anew', async t => {
  let failing: object = {}
  const deck = deckThatOccupies(TASKS.groups.inProgress, () => failing)
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  for (const answer of [
    answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } }),
    answered({ ok: false, failure: { kind: 'unauthenticated', message: 'not logged in 3w8e' } }),
    answered({ ok: false, failure: { kind: 'failed', message: 'exit 1 4k2m' } }),
    { content: [{ type: 'text', text: 'deck_occupy broke 8p0z' }], isError: true },
  ]) {
    failing = answer
    ;(askButton(document, '接管') as HTMLElement).focus()
    await page.click(askButton(document, '接管'))

    assert.deepEqual(askShown(page)?.buttons, ['接管', '取消'])
    assert.deepEqual(focused(document), ['接管', true])
    await page.advance(60_000)
    assert.deepEqual(focused(document), ['接管', true])
  }

  // Moved onto nothing in the page, it is not put back.
  ;(document.activeElement as HTMLElement).blur()
  await page.advance(60_000)
  assert.deepEqual(askShown(page)?.buttons, ['接管', '取消'])
  assert.equal(focused(document)[1], false)
})

test('while the Occupancy is being moved "取消" is off with "接管", and a click on it does nothing; not moved, "取消" is on again and closes the confirmation, nothing changed', async t => {
  // The confirmation while the Deck service moves the Occupancy, and once
  // "取消" in it was clicked.
  let whileMoving: unknown
  let clicked: unknown
  const deck = deckThatOccupies(TASKS.groups.inProgress, async () => {
    whileMoving = askShown(page)?.buttons
    ;(askButton(page.document, '取消') as HTMLElement).click()
    await new Promise(resolve => setTimeout(resolve, 30))
    clicked = askShown(page)?.buttons
    return answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } })
  })
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))

  assert.deepEqual(whileMoving, ['接管（停用）', '取消（停用）'])
  assert.deepEqual(clicked, ['接管（停用）', '取消（停用）'])
  assert.deepEqual(askShown(page)?.buttons, ['接管', '取消'])
  assert.equal(askShown(page)?.said, '连不上 GitHub。检查网络后再点“接管”重试。')

  await page.click(askButton(document, '取消'))

  assert.equal(askShown(page), undefined)
  assert.deepEqual(inProgressRows(document), ['#74', '#72', '#69', '#75'])
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 77e0aa15 ready-for-agent')
  assert.deepEqual(calledWith(page, 'deck_occupy').length, 1)
  assert.deepEqual(calledWith(page, 'deck_execute'), [])
  assert.deepEqual(prefills(page), [])
})

test('a takeover whose read again finds the project not configured fills in nothing', async t => {
  let configured = true
  const deck = deckThatOccupies(TASKS.groups.inProgress, args => {
    configured = false
    return deck.occupyAsIs(args)
  })
  const page = await openPage({ answer: (name, args) => (name === 'deck_config' && !configured ? deckAt('/work/matt-deck', false)(name, args) : deck.answer(name, args)) })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))

  assert.equal(shown(page, document.querySelector('[role="tablist"]')), false)
  assert.deepEqual(prefills(page), [])
  assert.deepEqual(calledWith(page, 'deck_execute'), [])
})

// The Deck service failing deck_config from the call on, as a read sees it.
const configBreaking = (deck: ReturnType<typeof deckThatOccupies>) => {
  const state = { broken: false }
  return {
    state,
    answer: (name: string, args: any) =>
      name === 'deck_config' && state.broken ? { content: [{ type: 'text', text: 'deck_config broke 2r5v' }], isError: true } : deck.answer(name, args),
  }
}

test('a takeover that moved nothing, read again as the Deck service fails, says why at once and has "取消" on, which closes the confirmation; its "接管" clicked as it was left does nothing', async t => {
  const deck = deckThatOccupies(TASKS.groups.inProgress, () => {
    breaking.state.broken = true
    return answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } })
  })
  const breaking = configBreaking(deck)
  const page = await openPage({ answer: breaking.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))

  assert.equal(text(document.getElementById('failed')!.querySelector('.dk-notice__text')), 'Deck 服务出错：deck_config broke 2r5v。点“刷新”重试。')
  assert.deepEqual(askShown(page), {
    role: 'status',
    glyph: '进行中 · 其他 Session',
    title: '#72 正由 Session 77e0aa15 执行',
    said: '连不上 GitHub。检查网络后再点“接管”重试。',
    buttons: ['接管', '取消'],
  })
  const confirm = askButton(document, '接管') as HTMLElement

  await page.click(askButton(document, '取消'))

  assert.equal(askShown(page), undefined)
  assert.deepEqual(prefills(page), [])

  // The button the confirmation had, clicked as it was left: nothing is
  // asked, moved or filled in, and the row's "接管" stays on.
  confirm.click()
  assert.deepEqual(buttonsIn(rowOf(document, 72)), ['接管'])
  await page.advance(0)
  assert.equal(askShown(page), undefined)
  assert.equal(calledWith(page, 'deck_occupy').length, 1)
  assert.deepEqual(prefills(page), [])
})

test('a takeover that moved the Occupancy, read again as the Deck service fails, closes the confirmation and fills in nothing; read once more, the row is this Session\'s', async t => {
  const deck = deckThatOccupies(TASKS.groups.inProgress, args => {
    breaking.state.broken = true
    return deck.occupyAsIs(args)
  })
  const breaking = configBreaking(deck)
  const page = await openPage({ answer: breaking.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))

  assert.equal(text(document.getElementById('failed')!.querySelector('.dk-notice__text')), 'Deck 服务出错：deck_config broke 2r5v。点“刷新”重试。')
  assert.equal(askShown(page), undefined)
  assert.deepEqual(prefills(page), [])
  assert.deepEqual(calledWith(page, 'deck_execute'), [])

  // Read again, the row is this Session's.
  breaking.state.broken = false
  await page.advance(60_000)
  assert.deepEqual(buttonsIn(rowOf(document, 72)), ['释放'])
})

test('a takeover that moved nothing has "接管" on again, the focus on it, before the Tasks read again have answered; behind a timed read under way too', async t => {
  for (const timed of [false, true]) {
    const offline = answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } })
    const deck = deckThatOccupies(TASKS.groups.inProgress, () => offline)
    // The confirmation and the focus as each read of the Tasks after the
    // click is asked for, and, behind a timed read, while it is held.
    const seen: unknown[] = []
    let clicked = false
    let isHeld = false
    const shownIn = (document: Document) => {
      const ask = [...document.querySelectorAll('.dk-notice')].find(each => [...each.querySelectorAll('button')].some(button => text(button) === '取消'))
      return [text(ask?.querySelector('.dk-notice__text') ?? null), buttonsIn(ask), focused(document)]
    }
    const page = await openPage({
      answer: async (name, args, document) => {
        if (name === 'deck_tasks' && clicked) seen.push(shownIn(document))
        if (name === 'deck_tasks' && isHeld) {
          isHeld = false
          const confirm = askButton(document, '接管') as HTMLElement
          confirm.focus()
          confirm.click()
          clicked = true
          await new Promise(resolve => setTimeout(resolve, 30))
          seen.push(shownIn(document))
        }
        return deck.answer(name, args)
      },
    })
    t.after(page.close)
    const { document } = page
    await page.click(rowButton(document, 72, '接管'))

    if (timed) {
      isHeld = true
      await page.advance(60_000)
    } else {
      ;(askButton(document, '接管') as HTMLElement).focus()
      clicked = true
      await page.click(askButton(document, '接管'))
    }

    const said = '连不上 GitHub。检查网络后再点“接管”重试。'
    assert.deepEqual(seen, Array(timed ? 2 : 1).fill([said, ['接管', '取消'], ['接管', true]]), String(timed))
    assert.deepEqual(askShown(page)?.buttons, ['接管', '取消'])
    assert.deepEqual(focused(document), ['接管', true])
    assert.deepEqual(prefills(page), [])
  }
})

test('a takeover that moved the Occupancy, read again as the Task list cannot be read, fills in nothing; read once more, the row is this Session\'s', async t => {
  const deck = deckThatOccupies()
  let failing = false
  const page = await openPage({
    answer: (name, args) => {
      if (name === 'deck_occupy') failing = true
      return name === 'deck_tasks' && failing ? answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } }) : deck.answer(name, args)
    },
  })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))

  assert.equal(text(document.querySelector('.dk-head__fresh')), '读取失败')
  assert.equal(askShown(page), undefined)
  assert.deepEqual(prefills(page), [])
  assert.deepEqual(calledWith(page, 'deck_execute'), [])
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 77e0aa15 ready-for-agent')
  assert.deepEqual(buttonsIn(rowOf(document, 72).querySelector('.dk-row__actions')), ['接管'])

  // Read once more, the row is this Session's.
  failing = false
  await page.advance(60_000)
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 本 Session ready-for-agent')
  assert.deepEqual(buttonsIn(rowOf(document, 72).querySelector('.dk-row__actions')), ['释放'])
  assert.deepEqual(prefills(page), [])
})

test('the Recommendation\'s "执行这个 Task" for a Task this Session holds fills in the Execute Prompt at once, asking nothing', async t => {
  const deck = deckThatOccupies()
  const recommending = deckThatRecommends()
  const page = await openNext({ answer: (name, args) => (['deck_ask', 'deck_recommendation'].includes(name) ? recommending.answer(name, args) : deck.answer(name, args)) })
  t.after(page.close)
  const { document } = page
  await page.click(button(page, '我现在该做什么'))
  recommending.reported.set('request-1', { ...RECOMMENDATION, task: 74 })
  await page.advance(2_000)

  await page.click(document.querySelector('.dk-rec button'))

  assert.equal(askShown(page), undefined)
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
  assert.deepEqual(calledWith(page, 'deck_execute'), [{ task: 74 }])
  assert.deepEqual(prefills(page).at(-1), prefilled(executePromptOf(74)))
  assert.deepEqual(buttonsIn(document.querySelector('.dk-rec')), ['已填入（停用）'])
})

test('a takeover or a release while a timed read is under way reads once that read has answered; "刷新" is off until both have', async t => {
  for (const act of ['接管', '释放'] as const) {
    const deck = deckThatOccupies()
    // Each call as it comes, and where the held read of the Tasks answers;
    // whether "刷新" was off at each call of a read and once the takeover or
    // release was clicked.
    const calls: string[] = []
    const off: boolean[] = []
    let isHeld = false
    const page = await openPage({
      answer: async (name, args, document) => {
        calls.push(name)
        if (name !== 'deck_occupy' && name !== 'deck_execute' && name !== 'deck_release') off.push((document.querySelector('.dk-head button') as HTMLButtonElement).disabled)
        if (name === 'deck_tasks' && isHeld) {
          isHeld = false
          ;((act === '接管' ? askButton(document, '接管') : rowButton(document, 74, '释放')) as HTMLElement).click()
          await new Promise(resolve => setTimeout(resolve, 30))
          off.push((document.querySelector('.dk-head button') as HTMLButtonElement).disabled)
          calls.push('held answered')
        }
        return deck.answer(name, args)
      },
    })
    t.after(page.close)
    const { document } = page
    if (act === '接管') await page.click(rowButton(document, 72, '接管'))
    calls.length = off.length = 0

    isHeld = true
    await page.advance(60_000)

    const held = calls.indexOf('deck_tasks')
    const answeredAt = calls.indexOf('held answered')
    assert.deepEqual(calls.slice(held + 1, answeredAt).filter(each => ['deck_config', 'deck_tasks'].includes(each)), [], act)
    assert.ok(calls.indexOf('deck_config', answeredAt) > answeredAt, act)
    assert.ok(off.every(Boolean), act)
    assert.equal((document.querySelector('.dk-head button') as HTMLButtonElement).disabled, false, act)
    assert.deepEqual(buttonsIn(rowOf(document, act === '接管' ? 72 : 74).querySelector('.dk-row__actions')), act === '接管' ? ['释放'] : ['执行'], act)
  }
})

test('a release the Deck service does not make, or fails at, reads the Tasks again all the same and draws the row as they are; "刷新" is on again', async t => {
  const errors: unknown[] = []
  const onError = (error: unknown) => errors.push(error)
  process.on('unhandledRejection', onError)
  t.after(() => process.off('unhandledRejection', onError))
  for (const failing of [
    answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } }),
    { content: [{ type: 'text', text: 'deck_release broke 2r5v' }], isError: true },
  ]) {
    const deck = deckThatOccupies()
    const page = await openPage({ answer: (name, args) => (name === 'deck_release' ? failing : deck.answer(name, args)) })
    t.after(page.close)
    const { document } = page
    const readBefore = calledWith(page, 'deck_tasks').length

    await page.click(rowButton(document, 74, '释放'))

    assert.deepEqual(errors, [])
    assert.equal(calledWith(page, 'deck_tasks').length, readBefore + 1)
    assert.equal(text(rowOf(document, 74).querySelector('.dk-row__meta')), '进行中 · 本 Session ready-for-agent')
    assert.deepEqual(buttonsIn(rowOf(document, 74).querySelector('.dk-row__actions')), ['释放'])
    assert.equal((document.querySelector('.dk-head button') as HTMLButtonElement).disabled, false)
  }
})

test('a Task closed or gone as it is taken over closes the confirmation and fills in nothing; held by a third Session by now, the row says by which, and "接管" asks to take it from that one', async t => {
  const THIRD = '019a8c3e-1f2b-7c4d-9e0f-0a1b3e3e3e3e'
  let answer: ((args: any) => object) | undefined = () => answered({ ok: false, failure: { kind: 'not-open', message: '#72 is closed' } })
  const deck = deckThatOccupies(TASKS.groups.inProgress, args => answer?.(args) ?? deck.occupyAsIs(args))
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))
  assert.equal(askShown(page), undefined)
  assert.deepEqual(prefills(page), [])

  answer = args => {
    const at = deck.groups.inProgress.findIndex(each => each.number === 72)
    deck.groups.inProgress[at] = { ...deck.groups.inProgress[at]!, occupant: THIRD, occupantShort: '3e3e3e3e' }
    return deck.occupyAsIs(args)
  }
  await page.click(rowButton(document, 72, '接管'))
  await page.click(askButton(document, '接管'))

  assert.equal(askShown(page), undefined)
  assert.deepEqual(prefills(page), [])
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 3e3e3e3e ready-for-agent')

  answer = undefined
  await page.click(rowButton(document, 72, '接管'))
  assert.equal(askShown(page)?.title, '#72 正由 Session 3e3e3e3e 执行')
  await page.click(askButton(document, '接管'))
  assert.deepEqual(calledWith(page, 'deck_occupy').at(-1), { session: SESSION.session, task: 72, takeOver: THIRD })
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(72))])
})

test('the confirmation closes as the person goes elsewhere: another tab, a detail, back from one; and once the Task is no longer another Session\'s, held again or not', async t => {
  const deck = deckThatOccupies()
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page

  await page.click(rowButton(document, 72, '接管'))
  await page.click(tabNamed(document, '技能'))
  await page.click(tabNamed(document, '任务'))
  assert.equal(askShown(page), undefined)

  await page.click(rowButton(document, 72, '接管'))
  await page.click(rowOf(document, 69))
  assert.equal(askShown(page), undefined)
  await page.click(barButton(document, '返回'))
  assert.equal(askShown(page), undefined)
  await page.click(rowOf(document, 69))
  await page.click(barButton(document, '接管'))
  assert.equal(askShown(page)?.title, '#69 正由 Claude Code 3f9c21d0 执行')
  await page.click(barButton(document, '返回'))
  assert.equal(askShown(page), undefined)
  await page.click(rowOf(document, 69))
  assert.equal(askShown(page), undefined)
  await page.click(barButton(document, '返回'))

  // Back from a detail entered from another one's blocking edge: not drawn
  // in the detail it goes back to.
  await page.click(rowOf(document, 73))
  await page.click([...document.querySelectorAll('.dk-detail .dk-edge')].find(edge => text(edge)!.includes('#72'))!)
  await page.click(barButton(document, '接管'))
  assert.equal(askShown(page)?.title, '#72 正由 Session 77e0aa15 执行')
  await page.click(barButton(document, '返回'))
  assert.equal(askShown(page), undefined)
  await page.click(barButton(document, '返回'))

  // Released by another Session's Pane, then held again.
  await page.click(rowButton(document, 72, '接管'))
  const [held] = deck.groups.inProgress.splice(1, 1)
  await page.advance(60_000)
  assert.equal(askShown(page), undefined)
  deck.groups.inProgress.splice(1, 0, held!)
  await page.advance(60_000)
  assert.equal(askShown(page), undefined)
  assert.deepEqual(inProgressRows(document), ['#74', '#72', '#69', '#75'])

  // Back in "可执行", then held by another Session again.
  await page.click(rowButton(document, 72, '接管'))
  deck.groups.inProgress.splice(1, 1)
  deck.groups.ready.push({ ...held!, occupant: null, occupantHost: null, occupantShort: null, isOrphaned: false })
  await page.advance(60_000)
  assert.equal(askShown(page), undefined)
  deck.groups.ready.pop()
  deck.groups.inProgress.splice(1, 0, held!)
  await page.advance(60_000)
  assert.equal(askShown(page), undefined)
  assert.deepEqual(inProgressRows(document), ['#74', '#72', '#69', '#75'])
})

test('a read of the Tasks begun before a takeover, answering with the Tasks as they were, answers before the takeover reads them again: the row is this Session\'s', async t => {
  const deck = deckThatOccupies()
  let isLate = false
  const page = await openPage({
    answer: async (name, args, document) => {
      if (name === 'deck_tasks' && isLate) {
        isLate = false
        // The timed read, answered with the Tasks as they were.
        const before = deck.answer(name, args)
        ;(askButton(document, '接管') as HTMLElement).click()
        while (calledWith(page, 'deck_occupy').length === 0) await new Promise(resolve => setTimeout(resolve, 5))
        await new Promise(resolve => setTimeout(resolve, 20))
        return before
      }
      return deck.answer(name, args)
    },
  })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  isLate = true
  await page.advance(60_000)

  assert.deepEqual(prefills(page), [prefilled(executePromptOf(72))])
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 本 Session ready-for-agent')
  assert.deepEqual(buttonsIn(rowOf(document, 72).querySelector('.dk-row__actions')), ['释放'])
})

test('the Session the Deck service names in a confirmation is put in it as text', async t => {
  const named = task(72, 'Matt 技能', { occupant: OTHER_CODEX, occupantHost: 'codex', occupantShort: '<i>77e0</i>' })
  const page = await openPage({ answer: deckThatOccupies([named]).answer })
  t.after(page.close)
  const { document } = page

  await page.click(rowButton(document, 72, '接管'))

  assert.equal(askShown(page)?.title, '#72 正由 Session <i>77e0</i> 执行')
  assert.equal(document.querySelector('.dk-notice i'), null)
  // The title holds no element but the Session's id.
  assert.deepEqual([...document.querySelectorAll('.dk-notice .dk-notice__title *')].map(each => each.className), ['mono'])
})

test('a takeover that fails after the person asked to take over another Task leaves that asking as it was', async t => {
  const deck = deckThatOccupies(TASKS.groups.inProgress, async () => {
    // Asked of #69 while #72's is being moved.
    ;(rowButton(page.document, 69, '接管') as HTMLElement).click()
    return answered({ ok: false, failure: { kind: 'offline', message: 'fetch failed 6t1q' } })
  })
  const page = await openPage({ answer: deck.answer })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))

  assert.deepEqual(askShown(page), { role: 'status', glyph: '进行中 · 其他 Session', title: '#69 正由 Claude Code 3f9c21d0 执行', said: ASK_SAID, buttons: ['接管', '取消'] })
  assert.deepEqual(inProgressRows(document), ['#74', '#72', '确认', '#75'])
  assert.deepEqual(prefills(page), [])
})

test('the notice that Deck\'s hook never ran stays where it is over an asking to take over; "怎么做" and "收起" leave the asking as it was, the focus where the person put it, and one asked as the steps are shown has the focus on "取消"', async t => {
  const deck = deckThatOccupies()
  const page = await openPage({ answer: (name, args) => (name === 'deck_hook' ? answered({ receivedAt: null }) : deck.answer(name, args)) })
  t.after(page.close)
  const { document } = page
  const hook = document.querySelector('#hook')!
  const how = hook.querySelector('button') as HTMLElement
  const top = () => [...document.querySelector('.dk-top')!.children].map(each => each.id || each.tagName)
  const before = top()
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '怎么做', []])

  await page.click(rowButton(document, 72, '接管'))

  assert.equal(askShown(page)?.title, '#72 正由 Session 77e0aa15 执行')
  assert.deepEqual(inProgressRows(document), ['#74', '确认', '#69', '#75'])
  assert.deepEqual(focused(document), ['取消', true])
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '怎么做', []])
  assert.deepEqual(top(), before)

  how.focus()
  await page.click(how)

  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '收起', HOOK_STEPS])
  assert.equal(askShown(page)?.title, '#72 正由 Session 77e0aa15 执行')
  assert.equal(document.activeElement, how)
  // Read again, the asking is drawn anew and leaves the focus on "收起".
  await page.advance(60_000)
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '收起', HOOK_STEPS])
  assert.equal(askShown(page)?.title, '#72 正由 Session 77e0aa15 执行')
  assert.equal(document.activeElement, how)

  // Another asking, the steps shown: the focus goes onto its "取消".
  await page.click(askButton(document, '取消'))
  await page.click(rowButton(document, 75, '接管'))
  assert.equal(askShown(page)?.title, '#75 的 Session 已结束')
  assert.deepEqual(focused(document), ['取消', true])
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '收起', HOOK_STEPS])

  await page.click(how)
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '怎么做', []])
  assert.equal(askShown(page)?.title, '#75 的 Session 已结束')

  // Taken over, the Tasks read again, the notice is still there.
  await page.click(askButton(document, '接管'))
  assert.equal(askShown(page), undefined)
  assert.deepEqual(prefills(page), [prefilled(executePromptOf(75))])
  assert.deepEqual(hookNotice(page), [HOOK_TITLE, '怎么做', []])
  assert.deepEqual(top(), before)
})

// A prefill the Host refuses, with a reason no page writes.
const REFUSAL = 'the composer is <b>locked</b> 8h2k'
const refuses = (message = REFUSAL) => () => ({ error: { code: -32000, message } })
// The result notice as the person reads it, if one is shown: where it stands
// in the block that stays at the top, how it is drawn, its title and words.
const resultShown = (page: { window: any; document: Document }) => {
  const notices = [...page.document.querySelectorAll('.dk-notice.is-danger')].filter(each => shown(page, each) && each.closest('.dk-top') !== null)
  assert.ok(notices.length <= 1, 'one result notice at most')
  const notice = notices[0]
  if (notice === undefined) return undefined
  const top = page.document.querySelector('.dk-top')!
  // The parts of the block shown, in order: the result notice is the last.
  const order = [...top.children]
    .filter(each => shown(page, each))
    .map(each => (each.contains(notice) ? '结果提示' : each.matches('.dk-head') ? '抬头' : each.matches('[role="tablist"]') ? '标签页' : each.id))
  return {
    order,
    role: notice.getAttribute('role'),
    glyph: notice.querySelector('.dk-plate.is-error svg') !== null,
    title: text(notice.querySelector('.dk-notice__title')),
    said: text(notice.querySelector('.dk-notice__text')),
  }
}

test('"配置这个项目" the Host refuses says so in a result notice under the head, with the Host\'s reason and to click it again; the button is on at once', async t => {
  const page = await openPage({ answer: deckAt('/work/elsewhere', false), answerMessage: refuses() })
  t.after(page.close)
  const button = page.document.querySelector<HTMLButtonElement>('.dk-empty button')!
  assert.equal(resultShown(page), undefined)

  await page.click(button)

  assert.deepEqual(prefills(page), [prefilled(CONFIGURE_CALL)])
  assert.deepEqual(resultShown(page), {
    order: ['抬头', '结果提示'],
    role: 'status',
    glyph: true,
    title: '没有填入输入框',
    said: `宿主拒绝了这次预填：${REFUSAL}。再点“配置这个项目”重试。`,
  })
  // The reason is put in as text.
  assert.equal(page.document.querySelector('.dk-top .dk-notice.is-danger b'), null)
  assert.deepEqual([text(button), button.disabled], ['配置这个项目', false])
  assert.equal(shown(page, page.document.querySelector('.dk-empty')), true)
})

// The result notice of a prefill refused from the button `label`, under the
// tabs.
const notFilled = (label: string, reason = `：${REFUSAL}`) => ({
  order: ['抬头', '标签页', '结果提示'],
  role: 'status',
  glyph: true,
  title: '没有填入输入框',
  said: `宿主拒绝了这次预填${reason}。再点“${label}”重试。`,
})

test('"预填" and "重跑配置" the Host refuses say so under the tabs, in 技能 and over a skill\'s text; a refusal that gives no reason says none', async t => {
  let reason = REFUSAL
  const page = await openPage({ answer: deckWithSkills(), answerMessage: () => ({ error: { code: -32000, message: reason } }) })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '技能'))
  const row = [...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === IMPLEMENT)!
  const prefill = row.querySelector('button')!

  await page.click(prefill)
  assert.deepEqual(resultShown(page), notFilled('预填'))
  assert.deepEqual([text(prefill), prefill.disabled], ['预填', false])

  reason = ''
  const rerun = document.querySelector<HTMLButtonElement>('#skill-list .dk-notice.is-warn button')!
  await page.click(rerun)
  assert.deepEqual(resultShown(page), notFilled('重跑配置', ''))
  assert.deepEqual([text(rerun), rerun.disabled], ['重跑配置', false])

  reason = REFUSAL
  await page.click(row)
  await page.click(barButton(document, '预填'))
  assert.deepEqual(resultShown(page), notFilled('预填'))
  assert.equal(detailShown(page)?.crumbs, `技能 / ${IMPLEMENT}`)
  assert.deepEqual(buttonsIn(document.querySelector('.dk-bar')), ['返回', '预填'])
  assert.deepEqual(prefills(page), [prefilled(IMPLEMENT), prefilled(CONFIGURE_CALL), prefilled(IMPLEMENT)])
})

test('"收尾核对" the Host refuses says so under the tabs, in 任务 and in 地图, and is on at once', async t => {
  const page = await openPage({ answer: deckOfCloseout(() => closeoutProject(true)), answerMessage: refuses() })
  t.after(page.close)
  const { document } = page
  const onRow = rowOf(document, 64).querySelector('button')!

  await page.click(onRow)
  assert.deepEqual(resultShown(page), notFilled('收尾核对'))
  assert.deepEqual([text(onRow), onRow.disabled], ['收尾核对', false])
  assert.equal(detailShown(page), undefined)

  await page.click(tabNamed(document, '地图'))
  const onCard = document.querySelector<HTMLButtonElement>('#map .dk-spec__foot button')!
  await page.click(onCard)
  assert.deepEqual(resultShown(page), notFilled('收尾核对'))
  assert.deepEqual([text(onCard), onCard.disabled], ['收尾核对', false])
  assert.deepEqual(prefills(page), [prefilled(closeoutPromptOf(1)), prefilled(closeoutPromptOf(1))])
})

test('"执行" the Host refuses says so under the tabs, in 任务, in a detail, in 地图 and in 下一步, and is on at once with its own words', async t => {
  const deck = deckThatRecommends()
  let refusing = false
  const page = await openPage({ answer: deck.answer, answerMessage: () => (refusing ? refuses()() : { result: {} }) })
  t.after(page.close)
  const { document } = page
  await page.click(tabNamed(document, '下一步'))
  await page.click(button(page, '我现在该做什么'))
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  refusing = true

  const recommended = () => document.querySelector('.dk-rec [data-execute]')
  await page.click(recommended())
  assert.deepEqual(resultShown(page), notFilled('执行这个 Task'))
  assert.deepEqual(executeShown(recommended()), ['执行这个 Task', true])

  await page.click(tabNamed(document, '任务'))
  await page.click(rowExecute(document, 70))
  assert.deepEqual(resultShown(page), notFilled('执行'))
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['执行', true])
  assert.equal(detailShown(page), undefined)

  await page.click(rowOf(document, 70))
  await page.click(barExecute(document)!)
  assert.deepEqual(resultShown(page), notFilled('执行'))
  assert.deepEqual(executeShown(barExecute(document)), ['执行', true])
  assert.equal(detailShown(page)?.crumbs, '任务 / #70')

  await page.click(tabNamed(document, '地图'))
  const onCard = () => wallCard(document, 70)!.querySelector('[data-execute]')
  await page.click(onCard())
  assert.deepEqual(resultShown(page), notFilled('执行'))
  assert.deepEqual(executeShown(onCard()), ['执行', true])

  assert.deepEqual(prefills(page).slice(1), Array(4).fill(prefilled(executePromptOf(70))))
  assert.deepEqual(calledWith(page, 'deck_occupy'), [])
})

test('a takeover that moved the Occupancy, its Execute Prompt refused by the Host, says the Task is this Session\'s and nothing was filled in, how to go on, and the Execute Prompt as the Deck service gives it', async t => {
  const deck = deckThatOccupies()
  // An Execute Prompt of more than one line, as the Deck service may give it.
  const prompt = `${executePromptOf(72)}\n\n  第二段 <i>as given</i> 3v9c`
  const page = await openPage({
    answer: (name, args: any) => (name === 'deck_execute' ? answered({ prompt }) : deck.answer(name, args)),
    answerMessage: refuses(),
  })
  t.after(page.close)
  const { document } = page
  await page.click(rowButton(document, 72, '接管'))

  await page.click(askButton(document, '接管'))

  assert.deepEqual(calledWith(page, 'deck_occupy'), [{ session: SESSION.session, task: 72, takeOver: OTHER_CODEX }])
  assert.deepEqual(prefills(page), [prefilled(prompt)])
  assert.equal(askShown(page), undefined)
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 本 Session ready-for-agent')
  assert.deepEqual(buttonsIn(rowOf(document, 72).querySelector('.dk-row__actions')), ['释放'])
  assert.deepEqual(resultShown(page), {
    order: ['抬头', '标签页', '结果提示'],
    role: 'status',
    glyph: true,
    title: '#72 已转给本 Session，Execute Prompt 没有填入',
    said: `宿主拒绝了这次预填：${REFUSAL}。点“释放”之后再点“执行”，或者把下面这段 Execute Prompt 填进输入框自己发送。`,
  })
  // The Execute Prompt as given, its lines kept, in the monospace face.
  const given = document.querySelector('.dk-top .dk-notice.is-danger .dk-notice__body')!.lastElementChild!
  assert.equal(given.textContent, prompt)
  assert.equal(given.children.length, 0)
  assert.ok(given.classList.contains('mono'))
  assert.equal(page.window.getComputedStyle(given).whiteSpace, 'pre-wrap')
  // The page moves nothing more by itself, and offers no button to.
  assert.deepEqual(buttonsIn(document.querySelector('.dk-top .dk-notice.is-danger')), [])
  assert.deepEqual(calledWith(page, 'deck_release'), [])
  assert.equal(prefills(page).length, 1)
})

test('the result notice stays through the timed reads, the read as the tab is shown again and "刷新"; it goes with another tab, into a detail and back from one, and as the next prefill, takeover or release begins', async t => {
  const occupies = deckThatOccupies()
  const recommends = deckThatRecommends()
  const deck = { answer: (name: string, args: any) => (['deck_ask', 'deck_recommendation'].includes(name) ? recommends.answer(name, args) : occupies.answer(name, args)) }
  let refusing = true
  // Whether the result notice is shown as the Host is asked to fill in, and
  // as the Deck service is asked to move or release an Occupancy.
  const shownAt: Record<string, boolean> = {}
  const page = await openPage({
    answer: (name, args: any, document) => {
      shownAt[name] = resultShown({ window: document.defaultView, document }) !== undefined
      return deck.answer(name, args)
    },
    answerMessage: (_params, document) => {
      shownAt.prefill = resultShown({ window: document.defaultView, document }) !== undefined
      return refusing ? refuses()() : { result: {} }
    },
  })
  t.after(page.close)
  const { document } = page
  // A prefill refused, from the "任务" tab: the result notice is shown.
  const refused = async () => {
    refusing = true
    await page.click(rowExecute(document, 70))
    assert.equal(resultShown(page)?.title, '没有填入输入框')
    refusing = false
  }

  await refused()
  const reads = () => calledWith(page, 'deck_tasks').length
  const readBefore = reads()
  await page.advance(60_000)
  await page.show(false)
  await page.show(true)
  await page.click(document.querySelector('.dk-head button'))
  assert.equal(reads(), readBefore + 3)
  assert.equal(resultShown(page)?.title, '没有填入输入框')

  await page.click(tabNamed(document, '地图'))
  assert.equal(resultShown(page), undefined)
  await page.click(tabNamed(document, '任务'))
  assert.equal(resultShown(page), undefined)

  await refused()
  await page.click(rowOf(document, 70))
  assert.equal(detailShown(page)?.crumbs, '任务 / #70')
  assert.equal(resultShown(page), undefined)
  refusing = true
  await page.click(barExecute(document)!)
  assert.equal(resultShown(page)?.title, '没有填入输入框')
  await page.click(barButton(document, '返回'))
  assert.equal(detailShown(page), undefined)
  assert.equal(resultShown(page), undefined)

  // The next prefill, filled in or not: gone before the Host is asked.
  await refused()
  await page.click(rowExecute(document, 70))
  assert.equal(shownAt.prefill, false)
  assert.equal(resultShown(page), undefined)
  assert.deepEqual(executeShown(rowExecute(document, 70)), ['已填入', false])
  await page.advance(5_000)

  await refused()
  await page.click(rowButton(document, 72, '接管'))
  await page.click(askButton(document, '接管'))
  assert.equal(shownAt.deck_occupy, false)
  assert.equal(resultShown(page), undefined)
  assert.equal(text(rowOf(document, 72).querySelector('.dk-row__meta')), '进行中 · 本 Session ready-for-agent')

  await refused()
  await page.click(rowButton(document, 74, '释放'))
  assert.equal(shownAt.deck_release, false)
  assert.equal(resultShown(page), undefined)
  assert.deepEqual(calledWith(page, 'deck_release'), [{ task: 74, session: SESSION.session }])

  // A prefill from a button the Host takes: gone before the Host is asked.
  await page.click(tabNamed(document, '技能'))
  const skill = [...document.querySelectorAll('.dk-skill')].find(each => text(each.querySelector('.dk-skill__name')) === IMPLEMENT)!.querySelector('button')!
  refusing = true
  await page.click(skill)
  assert.equal(resultShown(page)?.title, '没有填入输入框')
  refusing = false
  await page.click(skill)
  assert.equal(shownAt.prefill, false)
  assert.equal(resultShown(page), undefined)
  assert.deepEqual([text(skill), skill.disabled], ['已填入', true])
  await page.advance(5_000)

  // "再问一次": gone before the Deck service is asked for the request.
  await page.click(tabNamed(document, '下一步'))
  await page.click(button(page, '我现在该做什么'))
  recommends.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  refusing = true
  await page.click(document.querySelector('.dk-rec [data-execute]'))
  assert.equal(resultShown(page)?.title, '没有填入输入框')
  refusing = false
  await page.click(button(page, '再问一次'))
  assert.equal(shownAt.deck_ask, false)
  assert.equal(resultShown(page), undefined)
})

test('"我现在该做什么" the Host refuses does not wait: the 下一步 tab says why in its notice of a request not filled in, and no report is read', async t => {
  let refusing = true
  const deck = deckThatRecommends()
  const page = await openPage({ answer: deck.answer, answerMessage: () => (refusing ? refuses()() : { result: {} }) })
  t.after(page.close)
  await page.click(tabNamed(page.document, '下一步'))

  await page.click(button(page, '我现在该做什么'))

  assert.deepEqual(prefills(page), [prefilled(promptOf(1))])
  assert.deepEqual(nextTab(page), {
    shown: true,
    phases: [],
    said: ['没有填入推荐请求', `宿主拒绝了这次预填：${REFUSAL}。再点“我现在该做什么”重试。`, '把 $ask-matt 填进输入框，附带 Task Snapshot。'],
    buttons: ['我现在该做什么'],
  })
  // In the tab's own notice, not in the result notice.
  assert.equal(resultShown(page), undefined)
  await page.advance(10_000)
  assert.deepEqual(deck.reads, [])

  refusing = false
  await page.click(button(page, '我现在该做什么'))
  assert.deepEqual(nextTab(page).phases, ['+已填入', '>等待回报', '已回答'])
  assert.deepEqual(nextTab(page).said, ['已填入输入框，等你发送。'])
  await page.advance(2_000)
  assert.deepEqual(deck.reads, ['request-2'])
})

test('"再问一次" the Host refuses keeps waiting for the request before, and says why', async t => {
  let refusing = false
  const deck = deckThatRecommends()
  const page = await openPage({ answer: deck.answer, answerMessage: () => (refusing ? refuses()() : { result: {} }) })
  t.after(page.close)
  await page.click(tabNamed(page.document, '下一步'))
  await page.click(button(page, '我现在该做什么'))
  refusing = true

  await page.click(button(page, '再问一次'))

  assert.deepEqual(prefills(page), [prefilled(promptOf(1)), prefilled(promptOf(2))])
  assert.deepEqual(nextTab(page), {
    shown: true,
    phases: ['+已填入', '>等待回报', '已回答'],
    said: ['没有填入推荐请求', `宿主拒绝了这次预填：${REFUSAL}。再点“再问一次”重试。`, '已填入输入框，等你发送。'],
    buttons: ['再问一次'],
  })
  assert.equal(resultShown(page), undefined)
  await page.advance(2_000)
  assert.deepEqual(deck.reads, ['request-1'])
  deck.reported.set('request-1', RECOMMENDATION)
  await page.advance(2_000)
  assert.deepEqual(parts(page.document.querySelector('.dk-rec__head'), 'span'), ['下一个成就', 'Task 详情', '#70'])
  assert.deepEqual(deck.reads, ['request-1', 'request-1'])
})
