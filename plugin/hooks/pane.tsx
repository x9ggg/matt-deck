// The Pane's drawing, after `docs/pane-layout.md`: the frame every tab shares
// (top, tab row, and in each tab its action bar and pages) and the tasks tab.
// It draws from what it is handed and changes nothing itself: every press
// goes to one of the `actions`.
import type { Elements, RenderChildren, RenderPropsOf, RenderSurface } from 'claude-code'

import type {
  Ask,
  Container,
  DetailView,
  Filter,
  Group,
  Nav,
  Recommendation,
  RequestStatus,
  Skill,
  SkillFailure,
  SkillTextView,
  Tab,
  Task,
  TaskFailure,
  TaskList,
  View,
} from '../types'

type El = Elements[RenderSurface]

export type Actions = {
  refresh: () => void
  showTab: (tab: Tab) => void
  cycleFilter: () => void
  showGroup: (group: Group) => void
  // Shows another page and moves the focus onto the row `key`.
  turnPage: (page: number, key: string | undefined) => void
  // Drills into the Task `number`, from a row or from the detail shown.
  openTask: (number: number) => void
  // Goes back one step from a detail.
  back: () => void
  // Shows the Map View of the Spec or Map `number`.
  showMap: (number: number) => void
  // Lists the Specs and Maps to switch the Map View to, the focus on the
  // one shown, `current`; and goes back to the Map View without switching.
  openSwitch: (current: number) => void
  closeSwitch: () => void
  // Drills into a skill's text from its row, and goes back to the list.
  openSkill: (name: string) => void
  closeSkill: () => void
  // Puts `text` in the prompt box for the person to send; puts the Execute
  // Prompt of the Task `number` there.
  prefill: (text: string) => void
  execute: (number: number) => void
  // Asks to confirm taking over the Task `number` from the Session holding
  // it; takes it over from `from`, the Session the asking named, and
  // executes it; gives up the asking.
  askTakeOver: (number: number) => void
  takeOver: (number: number, from: string) => void
  cancelTakeOver: () => void
  // Releases the Occupancy `session` holds of the Task `number`: this
  // Session's, or an Orphaned one's.
  release: (number: number, session: string) => void
  // Asks what to do now; cancels the request held; shows the whole answer
  // above the prompt, or goes back from it.
  ask: () => void
  cancelAsk: () => void
  showAnswer: (isShown: boolean) => void
}

// Columns a text takes in the terminal: wide East Asian characters take two,
// everything else one, the status glyphs included (see the layout doc).
const isWide = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)

const width = (text: string) => {
  let columns = 0
  for (const char of text) {
    columns += isWide(char.codePointAt(0)!) ? 2 : 1
  }

  return columns
}

// The text cut to `columns`, ending in `…` where it was cut.
const cut = (text: string, columns: number) => {
  if (width(text) <= columns) {
    return text
  }
  let kept = ''
  for (const char of text) {
    if (width(kept + char) > columns - 1) {
      break
    }
    kept += char
  }

  return columns > 0 ? `${kept}…` : ''
}

const spaces = (columns: number) => ' '.repeat(Math.max(0, columns))

const GROUPS: Group[] = ['ready', 'inProgress', 'blocked', 'done']

// What a Task with Acceptance Evidence is marked with, beside its status.
const EVIDENCE = '✓ 验收证据'

const GLYPH: Record<Group, string> = { ready: '◇', inProgress: '▶', blocked: '□', done: '◆' }
const GLYPH_COLOR: Record<Group, string | undefined> = {
  ready: 'suggestion',
  inProgress: 'suggestion',
  blocked: undefined,
  done: 'warning',
}
const GROUP_TITLE: Record<Group, string> = { ready: '可执行', inProgress: '进行中', blocked: '阻塞', done: '已完成' }

// What an empty group says when the filter shows it alone: a fact and where
// to go.
const EMPTY_GROUP: Record<Group, [string, string]> = {
  ready: ['没有可执行的 Task。', '按 1 再按 n 问下一步。'],
  inProgress: ['没有进行中的 Task。', '按 f 看别的分组。'],
  blocked: ['没有被阻塞的 Task。', '按 f 看别的分组。'],
  done: ['还没有已完成的 Task。', '按 f 看别的分组。'],
}

const TRIAGE_LABELS = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']

const FAILURE: Record<TaskFailure['kind'], (message: string) => string> = {
  unauthenticated: () => 'gh 未登录。运行 gh auth login 后按 r 重试。',
  offline: () => '连不上 GitHub。检查网络后按 r 重试。',
  'gh-missing': () => '找不到 gh 命令。安装 GitHub CLI 后按 r 重试。',
  'no-repository': () => '这个 Workspace 没有指向 GitHub 的 remote，读不到 Issues。',
  failed: message => `gh 出错：${message}。按 r 重试。`,
  unreachable: message => `Deck 服务未连接：${message}`,
}

const SKILL_FAILURE: Record<SkillFailure['kind'], (message: string) => string> = {
  missing: () => 'Skill Source 不存在。运行 /matt-deck:configure 重新选定。',
  'unknown-skill': () => 'Skill Source 里已经没有这个技能。按 r 重新读取。',
  failed: message => `Deck 服务出错：${message}。按 r 重试。`,
  unreachable: message => `Deck 服务未连接：${message}`,
}

// The skill every Recommendation runs (ADR-0003), listed apart.
const ENTRY_SKILL = 'ask-matt'

// A Recommendation Request's stages, as the stage bar names them, and what
// each one waiting says.
const STAGES: [RequestStatus, string][] = [
  ['held', '持有中'],
  ['sent', '已发出'],
  ['running', '运行中'],
  ['answered', '已回答'],
]
// A Recommendation's four texts, as the card labels them.
const RECOMMENDATION_FIELDS = [
  ['下一步', 'nextStep'],
  ['技能', 'skill'],
  ['理由', 'reason'],
  ['阻塞', 'blockers'],
] as const
const STAGE_NOTE: Partial<Record<RequestStatus, string>> = {
  held: 'Session 忙碌，空闲后自动发出。',
  sent: '已交给 Session，等这一回合开始。',
  running: '/ask-matt 运行中，已附带 Task Snapshot。',
}

const pad = (n: number) => String(n).padStart(2, '0')

// A closing time as the list writes it, in the local time zone: `11-11 14:07`;
// a report's time the same.
const closedTime = (closedAt: string | number) => {
  const date = new Date(closedAt)

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// The status word at a Task row's right end; in progress, the Session
// occupying it: this one, `session`, or another by its id's start; or that
// it is Orphaned.
const statusOf = (task: Task, group: Group, session: string) => {
  switch (group) {
    case 'ready':
      return '可执行'
    case 'blocked':
      return task.blockers.length > 0
        ? `被 ${task.blockers.map(number => `#${number}`).join(' ')} 阻塞`
        : (task.labels.find(label => label === 'needs-triage' || label === 'needs-info') ?? '')
    case 'done':
      return task.closedAt === null ? '已解锁' : closedTime(task.closedAt)
    case 'inProgress':
      return task.isOrphaned ? 'Orphaned' : task.occupant === session ? '本 Session' : task.occupant!.slice(0, 8)
  }
}

// One focusable row of the list: a Spec or Map, or a Task in its group.
type Row = { key: string } & ({ container: Container } | { task: Task; group: Group })

const keyOf = (number: number) => `task:${number}`

// The list the filter shows: open Specs and Maps first under "all", then each
// group with its rows.
const listOf = (list: TaskList, filter: Filter) => ({
  containers: filter === 'all' ? list.containers.filter(container => container.isOpen) : [],
  groups: (filter === 'all' ? GROUPS : [filter]).map(group => ({
    group,
    rows: list.groups[group].map((task): Row => ({ key: keyOf(task.number), task, group })),
  })),
})

const containerRow = (container: Container): Row => ({ key: keyOf(container.number), container })

const numberOf = (row: Row) => ('container' in row ? row.container.number : row.task.number)

// How each of a Spec's or Map's Child Tasks stands, by group.
const childCounts = (list: TaskList, container: Container) =>
  GROUPS.map(group => ({
    group,
    count: list.groups[group].filter(task => task.parent === container.number).length,
  }))

const progressText = (container: Container) => `${container.progress.closed}/${container.progress.total}`

export const drawPane = (
  el: El,
  props: RenderPropsOf['Pane'],
  view: View,
  nav: Nav,
  ask: Ask,
  actions: Actions,
) => {
  const { Box, Button, Link, Markdown, Text } = el
  const columns = props.bodyColumns
  const isInline = props.placement === 'inline'
  const { config, tasks } = view

  // In place of a read that has gone unanswered for a while: what it may be
  // waiting on, and how to stop it waiting. Two rows of the docked width.
  const unanswered = (
    <Box flexDirection="column">
      <Text color="warning">Deck 服务还没应答，可能在等权限批准。</Text>
      <Text color="warning">运行 /matt-deck:configure 允许它的工具。</Text>
    </Box>
  )

  if (config.status === 'loading') {
    return view.isUnanswered ? unanswered : <Text dimColor>正在读取项目配置…</Text>
  }
  if (config.status !== 'configured') {
    return <Text color="error">{'message' in config ? config.message : ''}</Text>
  }

  const project = config.workspace.slice(config.workspace.lastIndexOf('/') + 1)
  const session = view.sessionId.slice(0, 8)
  const list = tasks.status === 'loaded' ? tasks.list : tasks.status === 'failed' ? tasks.list : undefined
  const counts = Object.fromEntries(GROUPS.map(group => [group, list?.groups[group].length ?? 0])) as Record<
    Group,
    number
  >
  const total = GROUPS.reduce((sum, group) => sum + counts[group], 0)
  // Every number in a row is padded to the widest one, so titles line up.
  const numberColumns =
    list === undefined
      ? 0
      : Math.max(
          0,
          ...list.containers.map(container => width(`#${container.number}`)),
          ...GROUPS.flatMap(group => list.groups[group].map(task => width(`#${task.number}`))),
        )
  const numbered = (number: number) => `#${number}`.padEnd(numberColumns + 1)

  // How fresh the Tasks are, at the top's right end.
  const freshness = (() => {
    if (tasks.status === 'failed') {
      return { text: '读取失败', color: 'error' }
    }
    if (tasks.status === 'loading') {
      return { text: '读取中…', color: 'inactive' }
    }
    const minutes = Math.floor(Math.max(0, view.checkedAt - tasks.list.fetchedAt) / 60_000)
    const text = minutes === 0 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`

    return { text, color: minutes > 10 ? 'warning' : 'inactive' }
  })()

  const refresh = <Button key="refresh" plain hotkey="r" label="刷新" onPress={actions.refresh} />

  const TABS: { tab: Tab; label: string }[] = [
    { tab: 'next', label: '下一步' },
    { tab: 'tasks', label: '任务' },
    { tab: 'map', label: '地图' },
    { tab: 'skills', label: '技能' },
  ]
  const tabRow = (
    <Box flexDirection="row">
      {TABS.map(({ tab, label }, index) => (
        <Box flexDirection="row">
          {index > 0 && <Text>{'  '}</Text>}
          <Button key={`tab:${tab}`} plain hotkey={String(index + 1)} onPress={() => actions.showTab(tab)}>
            {nav.tab === tab ? (
              <Text bold underline>
                {label}
              </Text>
            ) : (
              <Text color="inactive">{label}</Text>
            )}
          </Button>
        </Box>
      ))}
    </Box>
  )

  const glyph = (group: Group, dim = false) => (
    <Text color={GLYPH_COLOR[group]} dimColor={dim}>
      {GLYPH[group]}
    </Text>
  )
  // A Task's glyph: its group's, but in progress ▲ when Orphaned and ◐ for
  // another Session.
  const isOrphaned = (task: Task, group: Group) => group === 'inProgress' && task.isOrphaned
  const isOthers = (task: Task, group: Group) =>
    group === 'inProgress' && !task.isOrphaned && task.occupant !== view.sessionId
  const glyphText = (task: Task, group: Group) =>
    isOrphaned(task, group) ? '▲' : isOthers(task, group) ? '◐' : GLYPH[group]
  const taskGlyph = (task: Task, group: Group, dim = false) =>
    isOrphaned(task, group) ? (
      <Text color="warning">▲</Text>
    ) : isOthers(task, group) ? (
      <Text color="inactive">◐</Text>
    ) : (
      glyph(group, dim)
    )
  const status = (task: Task, group: Group) => statusOf(task, group, view.sessionId)
  // This Session's Task in progress, for the top.
  const executing = list?.groups.inProgress.find(task => task.occupant === view.sessionId)

  // The filter's five items, the chosen one bold and underlined.
  const filterItems = (only?: Filter) =>
    (['all', ...GROUPS] as Filter[])
      .filter(filter => only === undefined || filter === only)
      .flatMap((filter, index) => {
        const isChosen = only === undefined && filter === nav.filter
        const gap = index > 0 ? [<Text>{'  '}</Text>] : []
        if (filter === 'all') {
          return [
            ...gap,
            <Text bold={isChosen} underline={isChosen}>
              全部 {total}
            </Text>,
          ]
        }

        return [
          ...gap,
          <Text color={GLYPH_COLOR[filter]} bold={isChosen} underline={isChosen}>
            {GLYPH[filter]}
          </Text>,
          <Text bold={isChosen} underline={isChosen}>
            {' '}
            {counts[filter]}
          </Text>,
        ]
      })
  const filterButton = (only?: Filter) => (
    <Button key="filter" plain hotkey="f" onPress={actions.cycleFilter}>
      {filterItems(only)}
    </Button>
  )

  // The reason of a failed read in rows of the docked box's inner width,
  // broken at spaces here and not by the engine, so that the pages under the
  // box know its height. A word wider than the box is cut where it is drawn.
  const reasonRows = (failure: TaskFailure) => {
    const reason: string[] = []
    for (const word of FAILURE[failure.kind](failure.message).split(/\s+/)) {
      const row = reason.at(-1)
      if (row !== undefined && width(row) + 1 + width(word) <= columns - 2) {
        reason[reason.length - 1] = `${row} ${word}`
      } else {
        reason.push(word)
      }
    }

    return reason
  }

  // In place of the Tasks while they are first read.
  const readingTasks = view.isUnanswered ? unanswered : <Text color="inactive">正在读取 Task…</Text>

  const failureBox = (failure: TaskFailure) =>
    isInline ? (
      <Box flexDirection="column">
        <Text color="error">✕ 读取 Task 失败</Text>
        <Text wrap="truncate-end">{FAILURE[failure.kind](failure.message)}</Text>
      </Box>
    ) : (
      <Box borderStyle="single" borderColor="error" flexDirection="column">
        <Text color="error">✕ 读取 Task 失败</Text>
        {reasonRows(failure).map(row => (
          <Text wrap="truncate-end">{row}</Text>
        ))}
      </Box>
    )

  const shown = list === undefined ? undefined : listOf(list, nav.filter)
  const rows: Row[] =
    shown === undefined ? [] : [...shown.containers.map(containerRow), ...shown.groups.flatMap(({ rows }) => rows)]
  // Where the focus lands when the pane takes the keyboard: the first ready
  // Task, else the first row.
  const landing = rows.find(row => 'group' in row && row.group === 'ready') ?? rows[0]
  // The row the action bar is about: the last one the focus was on, while it
  // is listed.
  const focused = rows.find(row => row.key === nav.focus) ?? landing

  // A Spec's or Map's Child Tasks by group, as the action bar writes them
  // where a Task has its triage label.
  const childCountItems = (container: Container) =>
    childCounts(list!, container).flatMap(({ group, count }, index) => [
      ...(index > 0 ? [<Text>{'  '}</Text>] : []),
      glyph(group),
      <Text> {count}</Text>,
    ])

  // The action bar's actions, at its right end, and the columns they take
  // with the gap before them: a ready Task is executed, one in progress
  // released, this Session's, or taken over, another's, and an Orphaned one
  // either; a Spec or Map opens its Map View as well. Docked, a row with two
  // actions leaves out o, which enter does all the same.
  const executeButton = (number: number) => (
    <Button key="execute" plain hotkey="e" label="执行" onPress={() => actions.execute(number)} />
  )
  const releaseButton = (task: Task) => (
    <Button key="release" plain hotkey="x" label="释放" onPress={() => actions.release(task.number, task.occupant!)} />
  )
  const takeOverButton = (task: Task) => (
    <Button key="takeover" plain hotkey="t" label="接管" onPress={() => actions.askTakeOver(task.number)} />
  )
  const taskAction = (task: Task, group: Group) =>
    group === 'ready'
      ? { text: 'e: 执行', button: executeButton(task.number) }
      : group !== 'inProgress'
        ? undefined
        : task.isOrphaned
          ? {
              text: 't: 接管  x: 释放',
              isTwo: true,
              button: (
                <Box flexDirection="row">
                  {takeOverButton(task)}
                  <Text>{'  '}</Text>
                  {releaseButton(task)}
                </Box>
              ),
            }
          : task.occupant === view.sessionId
            ? { text: 'x: 释放', button: releaseButton(task) }
            : { text: 't: 接管', button: takeOverButton(task) }
  const rowAction = (row: Row) => ('group' in row ? taskAction(row.task, row.group) : undefined)
  const isOpenShown = (row: Row) => isInline || rowAction(row)?.isTwo !== true
  const rowActions = (row: Row) => (
    <Box flexDirection="row">
      {rowAction(row) !== undefined && (
        <Box flexDirection="row">
          {rowAction(row)!.button}
          <Text>{'  '}</Text>
        </Box>
      )}
      {'container' in row && (
        <Box flexDirection="row">
          <Button key="map" plain hotkey="m" label="地图" onPress={() => actions.showMap(row.container.number)} />
          <Text>{'  '}</Text>
        </Box>
      )}
      {isOpenShown(row) && (
        <Button key="open" plain hotkey="o" label="详情" onPress={() => actions.openTask(numberOf(row))} />
      )}
    </Box>
  )
  const actionsWidth = (row: Row) =>
    2 +
    width(
      'container' in row
        ? 'm: 地图  o: 详情'
        : [rowAction(row)?.text, isOpenShown(row) ? 'o: 详情' : undefined].filter(text => text !== undefined).join('  '),
    )

  // The Task another Session holds, or an Orphaned one, that the person is
  // asked to take over, while it still is; and the asking, in the action
  // bar's place: docked a box, above the prompt the title with the keys and
  // a row saying what taking over does.
  const takingOver =
    nav.takeover === undefined
      ? undefined
      : list?.groups.inProgress.find(
          task => task.number === nav.takeover && (task.isOrphaned || task.occupant !== view.sessionId),
        )
  const takeOverConfirm = (task: Task) => {
    const title = (
      <Text color="warning">
        {task.isOrphaned
          ? `▲ #${task.number} 的 Session 已结束`
          : `◐ #${task.number} 正由 Session ${task.occupant!.slice(0, 8)} 执行`}
      </Text>
    )
    const note = <Text>接管会把 Occupancy 转给本 Session。</Text>
    const keys = (
      <Box flexDirection="row">
        <Button key="takeover:confirm" plain hotkey="t" label="接管" onPress={() => actions.takeOver(task.number, task.occupant!)} />
        <Text>{'  '}</Text>
        <Button key="takeover:cancel" plain hotkey="c" label="取消" onPress={actions.cancelTakeOver} />
      </Box>
    )

    return isInline ? (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          {title}
          {keys}
        </Box>
        {note}
      </Box>
    ) : (
      <Box borderStyle="single" borderColor="warning" flexDirection="column">
        {title}
        {note}
        {keys}
      </Box>
    )
  }
  // The rows the asking takes beyond the action bar's one.
  const takeOverRows = takingOver === undefined ? 0 : isInline ? 1 : 4

  // A closed Task's action bar says it has Acceptance Evidence, where its
  // action would be.
  const isEvidenced = (task: Task) => !task.isOpen && task.hasEvidence
  const evidenceMark = (
    <Box flexDirection="row">
      <Text>{'  '}</Text>
      <Text color="success">{EVIDENCE}</Text>
    </Box>
  )

  // What the action bar says of a row before its actions: a Task's triage
  // label, or what is given in its place, and a closed Task's Acceptance
  // Evidence; a Spec's or Map's Child Tasks by group.
  const actionBar = (row: Row, label?: string) => (
    <Box flexDirection="row" justifyContent="space-between">
      {'container' in row ? (
        <Box flexDirection="row">
          <Text>{numbered(row.container.number)}</Text>
          {childCountItems(row.container)}
        </Box>
      ) : (
        <Box flexDirection="row">
          <Text>
            {numbered(row.task.number)}
            {cut(
              label ?? row.task.labels.find(label => TRIAGE_LABELS.includes(label)) ?? '',
              columns - numberColumns - 1 - actionsWidth(row) - (isEvidenced(row.task) ? width(`  ${EVIDENCE}`) : 0),
            )}
          </Text>
          {isEvidenced(row.task) && evidenceMark}
        </Box>
      )}
      {rowActions(row)}
    </Box>
  )

  // Inline, the action bar names the row as well: glyph, number, title,
  // status, then what the docked one says after the number.
  const inlineActionBar = (row: Row) => {
    if ('container' in row) {
      const { container } = row
      const head = `${container.kind === 'spec' ? 'Spec' : 'Map'} #${container.number} `
      const tail = `   ${progressText(container)}   `
      const countsWidth = width(
        childCounts(list!, container)
          .map(({ group, count }) => `${GLYPH[group]} ${count}`)
          .join('  '),
      )

      return (
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            {glyph(container.group)}
            <Text>
              {' '}
              {head}
              {cut(container.title, columns - 2 - width(head) - width(tail) - countsWidth - actionsWidth(row))}
              {tail}
            </Text>
            {childCountItems(container)}
          </Box>
          {rowActions(row)}
        </Box>
      )
    }
    const { task, group } = row
    const said = status(task, group)
    const label = task.labels.find(label => TRIAGE_LABELS.includes(label)) ?? ''
    const tail = `${said === '' ? '' : `   ${said}`}${label === '' ? '' : `   ${label}`}`
    const evidenceWidth = isEvidenced(task) ? width(`  ${EVIDENCE}`) : 0

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          {taskGlyph(task, group, group === 'blocked')}
          <Text dimColor={group === 'blocked'}>
            {' '}
            {numbered(task.number)}
            {cut(task.title, columns - 2 - numberColumns - 1 - width(tail) - evidenceWidth - actionsWidth(row))}
            {tail}
          </Text>
          {isEvidenced(task) && evidenceMark}
        </Box>
        {rowActions(row)}
      </Box>
    )
  }

  // A docked list row, filling the pane's width: glyph, number, title cut to
  // what is left, the status at the right end. It takes the focus when the
  // pane takes the keyboard if it is where the focus lands, and opens its
  // Task when pressed, unless told otherwise.
  const docked = (
    row: Row,
    { isLanding = row === landing, onPress = () => actions.openTask(numberOf(row)) } = {},
  ) => {
    if ('container' in row) {
      const { container } = row
      const head = ` ${container.kind === 'spec' ? 'Spec' : 'Map'} `
      const number = `#${container.number}`
      const progress = progressText(container)
      const room = columns - 1 - width(head) - width(number) - 1 - 1 - width(progress)
      const title = cut(container.title, room)

      return (
        <Button key={row.key} plain autoFocus={isLanding ? true : undefined} onPress={onPress}>
          {glyph(container.group)}
          <Text>{head}</Text>
          <Text color="inactive">{number}</Text>
          <Text>
            {' '}
            {title}
            {spaces(room - width(title) + 1)}
          </Text>
          <Text color="inactive">{progress}</Text>
        </Button>
      )
    }
    const { task, group } = row
    const dim = group === 'blocked'
    const said = status(task, group)
    const room = columns - 2 - (numberColumns + 1) - 1 - width(said)
    const title = cut(task.title, room)

    return (
      <Button key={row.key} plain autoFocus={isLanding ? true : undefined} onPress={onPress}>
        {taskGlyph(task, group, dim)}
        <Text color="inactive" dimColor={dim}>
          {' '}
          {numbered(task.number)}
        </Text>
        <Text dimColor={dim}>
          {title}
          {spaces(room - width(title) + 1)}
        </Text>
        <Text color="inactive" dimColor={dim}>
          {said}
        </Text>
      </Button>
    )
  }

  // A Spec's or Map's progress bar: closed, in progress, the rest; all of it
  // `warning` once every Child Task is closed. Under its row it is indented
  // two columns; in the Map View's card it fills the box.
  const progressBar = (container: Container, bar = columns - 2, indent = '  ') => {
    const { closed, inProgress, total } = container.progress
    const closedCells = total === 0 ? 0 : Math.round((closed / total) * bar)
    const inProgressCells = total === 0 ? 0 : Math.round(((closed + inProgress) / total) * bar) - closedCells

    return (
      <Box flexDirection="row">
        <Text>{indent}</Text>
        <Text color={total > 0 && closed === total ? 'warning' : 'suggestion'}>{'━'.repeat(closedCells)}</Text>
        <Text color="suggestion" dimColor>
          {'╍'.repeat(inProgressCells)}
        </Text>
        <Text color="subtle">{'─'.repeat(bar - closedCells - inProgressCells)}</Text>
      </Box>
    )
  }

  // Lines that stay together on a page, the keys of the rows among them, and
  // whether the first is a blank line, dropped at the top of a page.
  type Unit = { lines: RenderChildren[]; keys: string[]; blankFirst: boolean }

  // The units in pages of `room` rows, so the engine never scrolls the pane:
  // the page `at` with a row for the way back and one for the way on.
  const paged = (units: Unit[], room: number, at: number) => {
    const heightOf = (unit: Unit, isFirst: boolean) => unit.lines.length - (isFirst && unit.blankFirst ? 1 : 0)
    const pages: Unit[][] = [[]]
    const allHeight = units.reduce((sum, unit, index) => sum + heightOf(unit, index === 0), 0)
    if (allHeight <= room) {
      pages[0] = units
    } else {
      let used = 0
      for (const unit of units) {
        const page = pages.at(-1)!
        // Each page keeps a row for the way back and one for the way on.
        const fits = room - (pages.length > 1 ? 1 : 0) - 1
        if (page.length > 0 && used + heightOf(unit, false) > fits) {
          pages.push([unit])
          used = heightOf(unit, true)
        } else {
          used += heightOf(unit, page.length === 0)
          page.push(unit)
        }
      }
    }
    const pageIndex = Math.min(at, pages.length - 1)
    const page = pages[pageIndex]!
    const itemsOf = (units: Unit[]) => units.reduce((sum, unit) => sum + unit.keys.length, 0)
    const before = itemsOf(pages.slice(0, pageIndex).flat())
    const after = itemsOf(pages.slice(pageIndex + 1).flat())

    return [
      pageIndex > 0 && (
        <Button
          key="page:prev"
          plain
          onPress={() => actions.turnPage(pageIndex - 1, pages[pageIndex - 1]!.flatMap(unit => unit.keys).at(-1))}
        >
          <Text color="inactive">{'  '}前面还有 {before} 个</Text>
        </Button>
      ),
      ...page.flatMap((unit, index) => (index === 0 && unit.blankFirst ? unit.lines.slice(1) : unit.lines)),
      pageIndex < pages.length - 1 && (
        <Button
          key="page:next"
          plain
          onPress={() => actions.turnPage(pageIndex + 1, pages[pageIndex + 1]!.flatMap(unit => unit.keys)[0])}
        >
          <Text color="inactive">{'  '}还有 {after} 个</Text>
        </Button>
      ),
    ]
  }

  // The docked tasks tab: filter, action bar, and the rows in pages that fit
  // under the fixed rows.
  const dockedTasks = () => {
    if (list === undefined || shown === undefined) {
      return tasks.status === 'failed' ? failureBox(tasks.failure) : readingTasks
    }
    const failure = tasks.status === 'failed' ? failureBox(tasks.failure) : undefined
    const head = (
      <Box flexDirection="column">
        {failure}
        <Box flexDirection="row">{filterButton()}</Box>
      </Box>
    )
    if (rows.length === 0) {
      const [fact, where] =
        nav.filter === 'all' ? ['Task Source 里还没有 Task。', '在 Session 里用 Matt skills 建立。'] : EMPTY_GROUP[nav.filter]

      return (
        <Box flexDirection="column">
          {head}
          <Text> </Text>
          <Text>{fact}</Text>
          <Text color="inactive">{where}</Text>
        </Box>
      )
    }

    // The list in units: a Spec or Map with its bar, a group's title with
    // its first row after a blank line, each further row, a group's fold.
    const units: Unit[] = shown.containers.map(container => ({
      lines: [docked(containerRow(container)), progressBar(container)],
      keys: [keyOf(container.number)],
      blankFirst: false,
    }))
    for (const { group, rows: groupRows } of shown.groups) {
      if (nav.filter !== 'all') {
        units.push(...groupRows.map(row => ({ lines: [docked(row)], keys: [row.key], blankFirst: false })))
        continue
      }
      if (groupRows.length === 0) {
        continue
      }
      // Past five rows a group shows the first five and a row that opens it.
      const folded = groupRows.slice(0, 5)
      units.push({
        lines: [
          <Text> </Text>,
          <Text color="inactive">
            {GROUP_TITLE[group]} {groupRows.length}
          </Text>,
          docked(folded[0]!),
        ],
        keys: [folded[0]!.key],
        blankFirst: units.length > 0,
      })
      units.push(...folded.slice(1).map(row => ({ lines: [docked(row)], keys: [row.key], blankFirst: false })))
      if (groupRows.length > 5) {
        units.push({
          lines: [
            <Button key={`more:${group}`} plain onPress={() => actions.showGroup(group)}>
              <Text color="inactive">
                {'  '}还有 {groupRows.length - 5} 个
              </Text>
            </Button>,
          ],
          keys: [],
          blankFirst: false,
        })
      }
    }
    // Room under the fixed rows: top two, tabs, rule, filter, action bar and
    // the blank line under it; and under the reason of a failed read, which
    // is its rows, its title and its border.
    const failureRows = tasks.status === 'failed' ? reasonRows(tasks.failure).length + 3 : 0
    const room = Math.max(3, props.scroll.bodyRows - 7 - failureRows - takeOverRows)

    return (
      <Box flexDirection="column">
        {head}
        {takingOver === undefined ? actionBar(focused!) : takeOverConfirm(takingOver)}
        <Text> </Text>
        {paged(units, room, nav.page)}
      </Box>
    )
  }

  // A list laid out in one row above the prompt, as many items as fit in
  // `room` columns, in pages by width: each keeps room for the way back and
  // the way on, which move the focus onto the item before or after the page.
  type InlineItem = { key: string; label: string; draw: RenderChildren; isLanding: boolean; onPress: () => void }
  const inlineRow = (items: InlineItem[], room: number, at: number) => {
    const moreWidth = width(`还有 ${items.length} 个`) + 3
    const starts = [0]
    for (let index = 0, used = 0; index < items.length; index++) {
      const start = starts.at(-1)!
      const backWidth = start > 0 ? width(`前面 ${start} 个`) + 3 : 0
      const itemWidth = width(items[index]!.label) + (index === start ? 0 : 3)
      const onWidth = index < items.length - 1 ? moreWidth : 0
      if (index > start && backWidth + used + itemWidth + onWidth > room) {
        starts.push(index)
        used = width(items[index]!.label)
      } else {
        used += itemWidth
      }
    }
    const pageIndex = Math.min(at, starts.length - 1)
    const start = starts[pageIndex]!
    const end = starts[pageIndex + 1] ?? items.length

    return (
      <Box flexDirection="row">
        {pageIndex > 0 && (
          <Button key="page:prev" plain onPress={() => actions.turnPage(pageIndex - 1, items[start - 1]!.key)}>
            <Text color="inactive">前面 {start} 个</Text>
          </Button>
        )}
        {items.slice(start, end).map((item, index) => (
          <Box flexDirection="row">
            {(index > 0 || pageIndex > 0) && <Text>{'   '}</Text>}
            <Button key={item.key} plain autoFocus={item.isLanding ? true : undefined} onPress={item.onPress}>
              {item.draw}
            </Button>
          </Box>
        ))}
        {end < items.length && (
          <Box flexDirection="row">
            <Text>{'   '}</Text>
            <Button key="page:next" plain onPress={() => actions.turnPage(pageIndex + 1, items[end]!.key)}>
              <Text color="inactive">还有 {items.length - end} 个</Text>
            </Button>
          </Box>
        )}
      </Box>
    )
  }

  // The inline tasks tab: the action bar on the third row, the list laid out
  // in one row on the fourth, as many items as fit, the filter at its end.
  const inlineTasks = () => {
    if (tasks.status === 'failed') {
      return failureBox(tasks.failure)
    }
    if (list === undefined) {
      return view.isUnanswered ? (
        unanswered
      ) : (
        <Box flexDirection="column">
          <Text color="inactive">正在读取 Task…</Text>
          <Text> </Text>
        </Box>
      )
    }
    const filterWidth = 3 + (nav.filter === 'all' ? width(`全部 ${total}`) : 2 + String(counts[nav.filter]).length)
    if (rows.length === 0) {
      const [fact, where] =
        nav.filter === 'all' ? ['Task Source 里还没有 Task。', '在 Session 里用 Matt skills 建立。'] : EMPTY_GROUP[nav.filter]

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text>{fact}</Text>
            {filterButton(nav.filter)}
          </Box>
          <Text color="inactive">{where}</Text>
        </Box>
      )
    }

    if (takingOver !== undefined) {
      return takeOverConfirm(takingOver)
    }
    const labelOf = (row: Row) =>
      'container' in row
        ? `${GLYPH[row.container.group]} ${row.container.kind === 'spec' ? 'Spec' : 'Map'} #${row.container.number} ${progressText(row.container)}`
        : `${glyphText(row.task, row.group)} #${row.task.number} ${cut(row.task.title, 28)}`

    return (
      <Box flexDirection="column">
        {inlineActionBar(focused!)}
        <Box flexDirection="row" justifyContent="space-between">
          {inlineRow(
            rows.map(row => ({
              key: row.key,
              label: labelOf(row),
              draw: [
                'container' in row ? glyph(row.container.group) : taskGlyph(row.task, row.group, row.group === 'blocked'),
                <Text dimColor={'group' in row && row.group === 'blocked'}>{labelOf(row).slice(1)}</Text>,
              ],
              isLanding: row === landing,
              onPress: () => actions.openTask(numberOf(row)),
            })),
            columns - filterWidth - 2,
            nav.page,
          )}
          {filterButton(nav.filter)}
        </Box>
      </Box>
    )
  }

  // A Task the list holds, a Spec or Map among them, with where it stands.
  const entryOf = (number: number): { task: Task; group: Group; kind?: Container['kind'] } | undefined => {
    const container = list?.containers.find(container => container.number === number)
    if (container !== undefined) {
      return { task: container, group: container.group, kind: container.kind }
    }
    for (const group of GROUPS) {
      const task = list?.groups[group].find(task => task.number === number)
      if (task !== undefined) {
        return { task, group }
      }
    }

    return undefined
  }

  const refs = (numbers: number[]) => numbers.map(number => `#${number}`).join(' ')
  const listed = list === undefined ? [] : [...list.containers, ...GROUPS.flatMap(group => list.groups[group])]

  // A Spec's or Map's Child Tasks as a tree of Blocking Edges: a Task hangs
  // under the lowest-numbered of its fellow Child Tasks it declares one to,
  // closed or not, so the tree keeps its shape as they close. The top level
  // is ready, in progress, blocked, closed; Tasks under one go by number. A
  // loop of Blocking Edges, which the Task Source does not forbid, is cut
  // where it is first reached. `line` is what a node's row starts with,
  // `more` the start of the row under it.
  type TreeNode = { number: number; task: Task; group: Group; under?: number; line: string; more: string }
  const treeOf = (container: Container) => {
    const members = container.children.flatMap(number => {
      const entry = entryOf(number)

      return entry === undefined ? [] : [{ number, ...entry }]
    })
    const hangsUnder = new Map(
      members.map(member => [
        member.number,
        member.task.blockedBy.find(number => number !== member.number && container.children.includes(number)),
      ]),
    )
    const drawn = new Set<number>()
    const nodes: TreeNode[] = []
    const visit = (member: (typeof members)[number], under: number | undefined, prefix: string, isLast: boolean) => {
      drawn.add(member.number)
      const below = members.filter(other => hangsUnder.get(other.number) === member.number && !drawn.has(other.number))
      const own = under === undefined ? '' : `${prefix}${isLast ? '   ' : '│  '}`
      nodes.push({
        number: member.number,
        task: member.task,
        group: member.group,
        under,
        line: under === undefined ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`,
        more: `${own}${below.length > 0 ? '│ ' : '  '}`,
      })
      below.forEach((other, index) => visit(other, member.number, own, index === below.length - 1))
    }
    // In the order the tasks tab lists them: by group, then as in the group.
    const listOrder = GROUPS.flatMap(group => list!.groups[group].map(task => task.number))
    const inOrder = [...members].sort(
      (a, b) =>
        GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || listOrder.indexOf(a.number) - listOrder.indexOf(b.number),
    )
    for (const member of inOrder.filter(member => hangsUnder.get(member.number) === undefined)) {
      visit(member, undefined, '', true)
    }
    // What is left hangs on a loop: walked up to the loop, which is cut
    // there, so a Task under the loop stays under it.
    for (const member of inOrder) {
      if (drawn.has(member.number)) {
        continue
      }
      const walked = new Set<number>()
      let at = member.number
      while (!walked.has(at)) {
        walked.add(at)
        at = hangsUnder.get(at)!
      }
      visit(members.find(other => other.number === at)!, undefined, '', true)
    }

    return nodes
  }

  // What the Map View's action bar says of a Task where the tasks tab has
  // its triage label: every open Task blocking it, else the open ones it
  // blocks.
  const relationOf = (task: Task) => {
    if (task.blockers.length > 0) {
      return `被 ${refs(task.blockers)} 阻塞`
    }
    const blocking = listed.filter(other => other.blockers.includes(task.number)).map(other => other.number)

    return blocking.length > 0 ? `挡着 ${refs(blocking.sort((a, b) => a - b))}` : undefined
  }

  // The Specs and Maps to choose from, open ones first, and the one the map
  // tab shows: the one chosen, else the first.
  const choices = [...(list?.containers ?? [])].sort((a, b) => Number(b.isOpen) - Number(a.isOpen))
  const mapped = choices.find(container => container.number === nav.map) ?? choices[0]

  // A node of the tree: at the top a row as the tasks tab draws it; under
  // another, the tree's lines, its glyph, number and title. A blocked node is
  // dimmed whole.
  const nodeRow = (node: TreeNode, isLanding: boolean) => {
    const container = list!.containers.find(container => container.number === node.number)
    const row: Row =
      container === undefined ? { key: keyOf(node.number), task: node.task, group: node.group } : containerRow(container)
    if (node.under === undefined) {
      return docked(row, { isLanding })
    }
    const dim = node.group === 'blocked'
    const number = `#${node.number} `

    return (
      <Button
        key={row.key}
        plain
        autoFocus={isLanding ? true : undefined}
        onPress={() => actions.openTask(node.number)}
      >
        <Text color="inactive" dimColor={dim}>
          {node.line}
        </Text>
        {taskGlyph(node.task, node.group, dim)}
        <Text color="inactive" dimColor={dim}>
          {' '}
          {number}
        </Text>
        <Text dimColor={dim}>{cut(node.task.title, columns - width(node.line) - 2 - width(number))}</Text>
      </Button>
    )
  }

  // The Map View: the card naming the Spec or Map with its progress, the
  // action bar, and the tree in pages that fit under them. Above the prompt
  // the card is one row and the bar under it.
  const mapView = () => {
    if (list === undefined) {
      return tasks.status === 'failed' ? failureBox(tasks.failure) : readingTasks
    }
    const failure = tasks.status === 'failed' ? failureBox(tasks.failure) : undefined
    if (mapped === undefined) {
      return (
        <Box flexDirection="column">
          {failure}
          <Text>还没有 Spec 或 Map。</Text>
          <Text color="inactive">带 Child Task 的 Task 会出现在这里。</Text>
        </Box>
      )
    }
    if (nav.switching === true) {
      // The Specs and Maps drawn as the tasks tab draws them, the one shown
      // where the focus is; enter shows the one pressed.
      const units: Unit[] = choices.map(container => ({
        lines: [
          docked(
            { key: `switch:${container.number}`, container },
            { isLanding: container === mapped, onPress: () => actions.showMap(container.number) },
          ),
          progressBar(container),
        ],
        keys: [`switch:${container.number}`],
        blankFirst: false,
      }))

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="back" plain hotkey="b" label="返回" onPress={actions.closeSwitch} />
            <Text>{'  '}地图 / 切换</Text>
          </Box>
          <Text color="subtle">{'─'.repeat(columns)}</Text>
          {paged(units, Math.max(3, props.scroll.bodyRows - (isInline ? 4 : 6)), nav.mapPage ?? 0)}
        </Box>
      )
    }
    const kind = mapped.kind === 'spec' ? 'Spec' : 'Map'
    const { closed, total } = mapped.progress
    const progress = `${closed} / ${total} · ${total === 0 ? 0 : Math.round((closed / total) * 100)}%`
    const switcher = choices.length > 1 && (
      <Button key="switch" plain hotkey="s" label="切换" onPress={() => actions.openSwitch(mapped.number)} />
    )
    const card = isInline ? (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            {kind} #{mapped.number}{' '}
            {cut(mapped.title, columns - width(`${kind} #${mapped.number} `) - width(progress) - 2 - (switcher ? width('  s: 切换') : 0))}
          </Text>
          <Box flexDirection="row">
            <Text>{progress}</Text>
            {switcher && <Text>{'  '}</Text>}
            {switcher}
          </Box>
        </Box>
        {progressBar(mapped, columns, '')}
      </Box>
    ) : (
      <Box borderStyle="single" borderColor="subtle" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            {kind} #{mapped.number}
          </Text>
          {switcher}
        </Box>
        <Text>{cut(mapped.title, columns - 2)}</Text>
        <Box flexDirection="row">{childCountItems(mapped)}</Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>解锁进度</Text>
          <Text>{progress}</Text>
        </Box>
        {progressBar(mapped, columns - 2, '')}
      </Box>
    )
    const nodes = treeOf(mapped)
    if (nodes.length === 0) {
      return (
        <Box flexDirection="column">
          {failure}
          {card}
          <Text color="inactive">还没有 Child Task。</Text>
        </Box>
      )
    }
    // Where the focus lands, and the node the action bar is about.
    const landingNode = nodes.find(node => node.group === 'ready') ?? nodes[0]!
    const focusedNode = nodes.find(node => keyOf(node.number) === nav.focus) ?? landingNode
    const units: Unit[] = nodes.map(node => {
      const others = node.task.blockers.filter(number => number !== node.under)
      const more =
        node.under !== undefined && others.length > 0
          ? [
              <Text color="inactive" dimColor={node.group === 'blocked'}>
                {`${node.more}还被 ${refs(others)} 阻塞`}
              </Text>,
            ]
          : []

      return { lines: [nodeRow(node, node === landingNode), ...more], keys: [keyOf(node.number)], blankFirst: false }
    })
    const focusedContainer = list.containers.find(container => container.number === focusedNode.number)
    const bar =
      focusedContainer === undefined
        ? actionBar(
            { key: keyOf(focusedNode.number), task: focusedNode.task, group: focusedNode.group },
            relationOf(focusedNode.task),
          )
        : actionBar(containerRow(focusedContainer))
    // Room under the fixed rows: docked, the top four and the card's seven;
    // above the prompt, the top two and the card's two; and the action bar,
    // and the reason of a failed read.
    const failureRows =
      tasks.status === 'failed' ? (isInline ? 2 : reasonRows(tasks.failure).length + 3) : 0
    const room = Math.max(3, props.scroll.bodyRows - (isInline ? 5 : 12) - failureRows - takeOverRows)

    return (
      <Box flexDirection="column">
        {failure}
        {card}
        {takingOver === undefined ? bar : takeOverConfirm(takingOver)}
        {paged(units, room, nav.mapPage ?? 0)}
      </Box>
    )
  }

  const sectionTitle = (title: string) => (
    <Text color="inactive" bold>
      {title}
    </Text>
  )

  // A Task drilled into: the way back and the way here, then the Task. What
  // the list knows of it (its status, what it belongs to, what blocks it)
  // comes from the list, the rest from its own read.
  const detailView = ({ from, path }: NonNullable<Nav['detail']>) => {
    const number = path.at(-1)!
    const entry = entryOf(number)
    const firstParent = entryOf(path[0]!)?.task.parent ?? null
    const crumbs = [
      TABS.find(({ tab }) => tab === from)!.label,
      ...(firstParent === null ? [] : [`#${firstParent}`]),
      ...path.map(number => `#${number}`),
    ].join(' / ')
    const shown: DetailView = view.details[number] ?? { status: 'loading' }

    const body = (() => {
      if (shown.status === 'loading') {
        return [<Text color="inactive">正在读取 #{number}…</Text>]
      }
      if (shown.status === 'failed') {
        return [
          <Text color="error">✕ 读取 #{number} 失败</Text>,
          <Text>{FAILURE[shown.failure.kind](shown.failure.message)}</Text>,
        ]
      }
      const { task, reports } = shown
      const hasEvidence = reports.some(report => report.evidence.length > 0)
      const label = task.labels.find(label => TRIAGE_LABELS.includes(label))
      const updated = new Date(task.updatedAt)
      const time =
        task.closedAt === null
          ? `更新 ${pad(updated.getMonth() + 1)}-${pad(updated.getDate())}`
          : closedTime(task.closedAt)
      const meta = [...(label === undefined ? [] : [label]), task.assignees.join(', ') || '未指派', time].join(' · ')
      const parent = entry?.task.parent == null ? undefined : list?.containers.find(c => c.number === entry.task.parent)
      const blockers = (entry?.task.blockers ?? []).flatMap(blocker => {
        const found = entryOf(blocker)

        return found === undefined ? [] : [{ ...found, number: blocker }]
      })

      return [
        <Box flexDirection="row">
          <Text color={entry === undefined ? undefined : GLYPH_COLOR[entry.group]}>#{task.number}</Text>
          <Text> </Text>
          <Text bold>{task.title}</Text>
        </Box>,
        ...(entry === undefined
          ? []
          : [
              <Box flexDirection="row">
                {taskGlyph(entry.task, entry.group, entry.group === 'blocked')}
                <Text>
                  {' '}
                  {entry.group === 'done'
                    ? '已解锁'
                    : entry.group === 'inProgress'
                      ? `进行中 · ${status(entry.task, entry.group)}`
                      : status(entry.task, entry.group)}
                </Text>
                {hasEvidence && evidenceMark}
              </Box>,
            ]),
        <Text>{meta}</Text>,
        ...(parent === undefined
          ? []
          : [
              <Button key={`parent:${parent.number}`} plain onPress={() => actions.showMap(parent.number)}>
                <Text>
                  {cut(`属于 ${parent.kind === 'spec' ? 'Spec' : 'Map'} #${parent.number} ${parent.title}`, columns)}
                </Text>
              </Button>,
            ]),
        <Text> </Text>,
        sectionTitle('描述'),
        task.description === '' ? <Text color="inactive">没有描述。</Text> : <Markdown text={task.description} />,
        <Text> </Text>,
        sectionTitle('验收条件'),
        ...(task.acceptance.length === 0
          ? [<Text color="inactive">正文里没有验收条件。</Text>]
          : task.acceptance.map(item => (
              <Box flexDirection="row">
                <Text>{item.isChecked ? '[x] ' : '[ ] '}</Text>
                <Markdown text={item.text} />
              </Box>
            ))),
        ...(blockers.length === 0
          ? []
          : [
              <Text> </Text>,
              sectionTitle(`被阻塞 ${blockers.length}`),
              ...blockers.map(blocker => (
                <Button key={`blocker:${blocker.number}`} plain onPress={() => actions.openTask(blocker.number)}>
                  {taskGlyph(blocker.task, blocker.group, blocker.group === 'blocked')}
                  <Text dimColor={blocker.group === 'blocked'}>
                    {' '}
                    {numbered(blocker.number)}
                    {cut(blocker.task.title, columns - 2 - (numberColumns + 1))}
                  </Text>
                </Button>
              )),
            ]),
        // One record a report, the first first: the Session and when, the
        // result, and each Acceptance Evidence with where it comes from.
        <Text> </Text>,
        sectionTitle(reports.length === 0 ? '执行记录' : `执行记录 ${reports.length}`),
        ...(reports.length === 0
          ? [<Text color="inactive">还没有 Session 执行过这个 Task。</Text>]
          : reports.flatMap((report, index) => [
              ...(index === 0 ? [] : [<Text> </Text>]),
              <Box flexDirection="row" justifyContent="space-between">
                <Text>Session {report.session.slice(0, 8)}</Text>
                <Text>{closedTime(report.reportedAt)}</Text>
              </Box>,
              <Text>{report.result}</Text>,
              ...report.evidence.map(evidence => (
                <Box flexDirection="row">
                  <Text color="success">✓ </Text>
                  <Text color="success">
                    {evidence.text}（{evidence.source}）
                  </Text>
                </Box>
              )),
            ])),
        <Text> </Text>,
        <Link href={task.url}>
          <Text color="suggestion" underline>
            在 GitHub 打开
          </Text>
        </Link>,
      ]
    })()

    // The Task's action, as in the action bar; asked to take it over, the
    // asking under the way back.
    // The way back keeps no t of its own beside the asking's.
    const action =
      entry === undefined || entry.kind !== undefined || takingOver?.number === number
        ? undefined
        : taskAction(entry.task, entry.group)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Button key="back" plain hotkey="b" label="返回" onPress={actions.back} />
            <Text>
              {'  '}
              {cut(crumbs, columns - width('b: 返回  ') - (action === undefined ? 0 : 2 + width(action.text)))}
            </Text>
          </Box>
          {action?.button}
        </Box>
        <Text color="subtle">{'─'.repeat(columns)}</Text>
        {takingOver?.number === number && takeOverConfirm(takingOver)}
        {body}
      </Box>
    )
  }
  const detail = nav.detail?.from === nav.tab ? nav.detail : undefined

  const skillSource =
    config.config.skillSource.type === 'plugin'
      ? `插件 ${config.config.skillSource.name}`
      : `目录 ${config.config.skillSource.path}`
  const sourceLine = (gap: string) => (
    <Text>
      Skill Source{gap}
      <Text color="inactive">{skillSource}</Text>
    </Text>
  )

  // The skills, /ask-matt first and the rest by name, as the kernel lists them,
  // and the one the action bar is about: the last one the focus was on.
  const skills = view.skills.status === 'loaded' ? view.skills.skills : []
  const entrySkills = skills.filter(skill => skill.name === ENTRY_SKILL)
  const otherSkills = skills.filter(skill => skill.name !== ENTRY_SKILL)
  const orderedSkills = [...entrySkills, ...otherSkills]
  const skillKey = (skill: Skill) => `skill:${skill.name}`
  const focusedSkill = orderedSkills.find(skill => skillKey(skill) === nav.focus) ?? orderedSkills[0]

  const skillActions = (skill: Skill) => (
    <Box flexDirection="row">
      <Button key="prefill" plain hotkey="e" label="预填" onPress={() => actions.prefill(skill.call)} />
      <Text>{'  '}</Text>
      <Button key="open" plain hotkey="o" label="原文" onPress={() => actions.openSkill(skill.name)} />
    </Box>
  )
  const skillActionsWidth = 2 + width('e: 预填  o: 原文')

  // Why the skills are not listed, as a title and a line saying why, or
  // undefined while they are.
  const skillsNotice = (): [RenderChildren, RenderChildren] | undefined => {
    if (view.skills.status === 'loading') {
      return [<Text color="inactive">正在读取技能…</Text>, <Text> </Text>]
    }
    if (view.skills.status === 'failed') {
      const { kind, message } = view.skills.failure

      return [<Text color="error">✕ 读取技能失败</Text>, <Text wrap="truncate-end">{SKILL_FAILURE[kind](message)}</Text>]
    }
    if (orderedSkills.length === 0) {
      return [
        <Text>Skill Source 里没有技能。</Text>,
        <Text color="inactive" wrap="truncate-end">
          确认它是 Matt skills 所在的位置，或运行 /matt-deck:configure 重新选定。
        </Text>,
      ]
    }

    return undefined
  }

  // The docked skills tab: the Skill Source, the action bar, /ask-matt apart
  // and the rest, in pages that fit under the fixed rows.
  const dockedSkills = () => {
    const notice = skillsNotice()
    if (notice !== undefined) {
      return (
        <Box flexDirection="column">
          {sourceLine('  ')}
          <Text> </Text>
          {notice}
        </Box>
      )
    }
    // A row: the command name, its description at the right end, cut to fit.
    const skillRow = (skill: Skill) => {
      const call = cut(skill.call, columns)
      const room = columns - width(call) - 1
      const description = cut(skill.description, room)

      return (
        <Button
          key={skillKey(skill)}
          plain
          autoFocus={skill === orderedSkills[0] ? true : undefined}
          onPress={() => actions.openSkill(skill.name)}
        >
          <Text color="suggestion">{call}</Text>
          <Text color="inactive">
            {spaces(room - width(description) + 1)}
            {description}
          </Text>
        </Button>
      )
    }
    const units: Unit[] = []
    for (const [title, group] of [
      ['通用入口', entrySkills],
      [`技能 ${otherSkills.length}`, otherSkills],
    ] as const) {
      if (group.length === 0) {
        continue
      }
      units.push({
        lines: [
          ...(units.length > 0 ? [<Text> </Text>] : []),
          <Text color="inactive">{title}</Text>,
          skillRow(group[0]!),
        ],
        keys: [skillKey(group[0]!)],
        blankFirst: units.length > 0,
      })
      units.push(...group.slice(1).map(skill => ({ lines: [skillRow(skill)], keys: [skillKey(skill)], blankFirst: false })))
    }
    // Room under the fixed rows: top four, the Skill Source, the action bar
    // and the blank line under it.
    const room = Math.max(3, props.scroll.bodyRows - 7)

    return (
      <Box flexDirection="column">
        {sourceLine('  ')}
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="suggestion">{cut(focusedSkill!.call, columns - skillActionsWidth)}</Text>
          {skillActions(focusedSkill!)}
        </Box>
        <Text> </Text>
        {paged(units, room, nav.skillsPage ?? 0)}
      </Box>
    )
  }

  // The inline skills tab: the action bar with the description on the third
  // row, the command names in one row on the fourth, the Skill Source at its
  // end.
  const inlineSkills = () => {
    const notice = skillsNotice()
    if (notice !== undefined) {
      return (
        <Box flexDirection="column">
          {notice[0]}
          <Box flexDirection="row" justifyContent="space-between">
            {notice[1]}
            {sourceLine(' ')}
          </Box>
        </Box>
      )
    }
    const skill = focusedSkill!
    const room = columns - width(skill.call) - 2 - skillActionsWidth

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color="suggestion">{skill.call}</Text>
            {'  '}
            {cut(skill.description, room)}
          </Text>
          {skillActions(skill)}
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          {inlineRow(
            orderedSkills.map(skill => {
              const label = cut(skill.call, 28)

              return {
                key: skillKey(skill),
                label,
                draw: <Text color="suggestion">{label}</Text>,
                isLanding: skill === orderedSkills[0],
                onPress: () => actions.openSkill(skill.name),
              }
            }),
            columns - width(`Skill Source ${skillSource}`) - 2,
            nav.skillsPage ?? 0,
          )}
          {sourceLine(' ')}
        </Box>
      </Box>
    )
  }

  // A skill drilled into: the way back, then its command name, its file and
  // its text as written.
  const skillView = (name: string) => {
    const listed = skills.find(skill => skill.name === name)
    const shown: SkillTextView = view.skillTexts[name] ?? { status: 'loading' }
    // The call as read, else as listed: a skill no longer listed has no call
    // to prefill until its text is read.
    const call = shown.status === 'loaded' ? shown.skill.call : listed?.call
    const title = call ?? name
    const body =
      shown.status === 'loading'
        ? [<Text color="inactive">正在读取 {title}…</Text>]
        : shown.status === 'failed'
          ? [
              <Text color="error">✕ 读取 {title} 失败</Text>,
              <Text>{SKILL_FAILURE[shown.failure.kind](shown.failure.message)}</Text>,
            ]
          : [
              <Text color="suggestion" bold>
                {call}
              </Text>,
              <Text color="inactive">{shown.skill.path}</Text>,
              <Text> </Text>,
              <Markdown text={shown.skill.text} />,
            ]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Button key="back" plain hotkey="b" label="返回" onPress={actions.closeSkill} />
            <Text>
              {'  '}
              {cut(`技能 / ${title}`, columns - width('b: 返回  ') - 2 - width('e: 预填'))}
            </Text>
          </Box>
          {call !== undefined && <Button key="prefill" plain hotkey="e" label="预填" onPress={() => actions.prefill(call)} />}
        </Box>
        <Text color="subtle">{'─'.repeat(columns)}</Text>
        {body}
      </Box>
    )
  }
  // The next tab: the request's stages, and the Recommendation its turn
  // left, or the turn's answer.
  const isPending = ask.status === 'held' || ask.status === 'sent' || ask.status === 'running'
  const askButton =
    ask.status === 'answered' ? (
      <Button key="ask" plain hotkey="n" label="再问一次" onPress={actions.ask} />
    ) : (
      <Box flexDirection="row">
        <Button key="ask" variant="primary" hotkey="n" label="我现在该做什么" onPress={actions.ask} />
        <Text color="inactive"> n</Text>
      </Box>
    )
  // The stages gone through, the one the request is at in bold, and those
  // to come. A request sent at once was never held: that stage is drawn as
  // one it did not get to.
  const stageBar = () => {
    const at = STAGES.findIndex(([status]) => status === ask.status)

    return (
      <Box flexDirection="row">
        {STAGES.flatMap(([status, label], index) => [
          ...(index > 0 ? [<Text dimColor={index > at}> › </Text>] : []),
          index < at && (status !== 'held' || ask.wasHeld === true) ? (
            <Text color="suggestion">{label}</Text>
          ) : index === at ? (
            <Text bold>{label}</Text>
          ) : (
            <Text dimColor>{label}</Text>
          ),
        ])}
      </Box>
    )
  }
  const cancel = <Button key="cancel" plain hotkey="c" label="取消" onPress={actions.cancelAsk} />
  const recommendation = ask.answer !== undefined && 'recommendation' in ask.answer ? ask.answer.recommendation : undefined
  const answerText = ask.answer !== undefined && 'text' in ask.answer ? ask.answer.text : ''
  // The recommended Task with its glyph and title, as the list knows it.
  const recommendedTask = () => {
    if (recommendation?.task == null) {
      return <Text>无</Text>
    }
    const number = recommendation.task
    const found =
      list === undefined
        ? undefined
        : [
            ...list.containers.map(container => ({ group: container.group, task: container as Task })),
            ...GROUPS.flatMap(group => list.groups[group].map(task => ({ group, task }))),
          ].find(({ task }) => task.number === number)

    return found === undefined ? (
      <Text>#{number}</Text>
    ) : (
      <Text>
        {taskGlyph(found.task, found.group)} #{number} {found.task.title}
      </Text>
    )
  }
  // The Recommendation's five fields: the Task, then the four texts, each
  // label in a column of its own. A field with nothing in it says so.
  const recommendationRows = (fields: Recommendation) => [
    <Text>下一个成就</Text>,
    recommendedTask(),
    ...RECOMMENDATION_FIELDS.map(([label, field]) => (
      <Box flexDirection="row">
        <Text>{label + spaces(8 - width(label))}</Text>
        <Text>{fields[field] === '' ? '无' : fields[field]}</Text>
      </Box>
    )),
  ]
  const unreported = ['没有收到 deck_recommend 的回报。', '下面是这一回合的回答原文。']
  // The screen's primary button once an open Task is recommended: execute
  // it, after taking it over when another Session holds it.
  const isRecommendedClosed = listed.some(task => task.number === recommendation?.task && !task.isOpen)
  const isRecommendedOthers =
    list?.groups.inProgress.some(
      task => task.number === recommendation?.task && (task.isOrphaned || task.occupant !== view.sessionId),
    ) === true
  const recommendedTakeOver = takingOver !== undefined && takingOver.number === recommendation?.task ? takingOver : undefined
  const executeRecommended =
    recommendation?.task == null || isRecommendedClosed ? undefined : (
      <Box flexDirection="row">
        <Button
          key="execute"
          variant="primary"
          hotkey="e"
          label="执行这个 Task"
          onPress={() =>
            isRecommendedOthers ? actions.askTakeOver(recommendation.task!) : actions.execute(recommendation.task!)
          }
        />
        <Text color="inactive"> e</Text>
      </Box>
    )

  const dockedNext = () => {
    if (ask.status === 'none' || ask.status === 'cancelled') {
      return (
        <Box flexDirection="column">
          {askButton}
          <Text>{ask.status === 'none' ? '在本 Session 运行 /ask-matt。' : '已取消。请求没有发出。'}</Text>
        </Box>
      )
    }
    if (isPending) {
      return (
        <Box flexDirection="column">
          {stageBar()}
          <Box flexDirection="row" justifyContent="space-between">
            <Text>{STAGE_NOTE[ask.status]}</Text>
            {ask.status === 'held' && cancel}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {stageBar()}
        {ask.answer !== undefined && 'recommendation' in ask.answer ? (
          <Box borderStyle="single" borderColor="inactive" flexDirection="column">
            {recommendationRows(ask.answer.recommendation)}
            {recommendedTakeOver === undefined && executeRecommended}
          </Box>
        ) : (
          <Box flexDirection="column">
            {unreported.map(line => (
              <Text>{line}</Text>
            ))}
            <Text> </Text>
            <Markdown text={answerText} />
            <Text> </Text>
          </Box>
        )}
        {recommendedTakeOver === undefined ? askButton : takeOverConfirm(recommendedTakeOver)}
      </Box>
    )
  }

  // Above the prompt: the two rows under the tabs, or the whole answer
  // under the way back.
  const inlineNext = () => {
    if (ask.status === 'answered' && nav.isAnswerShown === true) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">
              <Button key="back" plain hotkey="b" label="返回" onPress={() => actions.showAnswer(false)} />
              <Text color="inactive">
                {'  '}下一步 / {recommendation !== undefined ? 'Recommendation' : '回答原文'}
              </Text>
            </Box>
            {recommendedTakeOver === undefined && executeRecommended}
          </Box>
          <Text color="subtle">{'─'.repeat(columns)}</Text>
          {recommendedTakeOver !== undefined && takeOverConfirm(recommendedTakeOver)}
          {ask.answer !== undefined && 'recommendation' in ask.answer ? (
            recommendationRows(ask.answer.recommendation)
          ) : (
            <Markdown text={answerText} />
          )}
        </Box>
      )
    }
    if (recommendedTakeOver !== undefined) {
      return takeOverConfirm(recommendedTakeOver)
    }
    const showAll = <Button key="answer" plain hotkey="o" label="全文" onPress={() => actions.showAnswer(true)} />
    const [actionRow, listRow] =
      ask.status === 'none'
        ? [<Text>在本 Session 运行 /ask-matt，自动带上 Task Snapshot。</Text>, <Text> </Text>]
        : ask.status === 'cancelled'
          ? [<Text>已取消。请求没有发出。</Text>, <Text> </Text>]
          : isPending
            ? [
                <Box flexDirection="row" justifyContent="space-between">
                  <Text>{STAGE_NOTE[ask.status]}</Text>
                  {ask.status === 'held' && cancel}
                </Box>,
                <Text> </Text>,
              ]
            : recommendation !== undefined
              ? [
                  <Box flexDirection="row" justifyContent="space-between">
                    <Box flexDirection="row" flexShrink={1}>
                      <Text>下一个成就  </Text>
                      {recommendedTask()}
                      <Text wrap="truncate-end">
                        {'   '}技能 {recommendation.skill || '无'}   阻塞 {recommendation.blockers || '无'}
                      </Text>
                    </Box>
                    <Box flexDirection="row">
                      {executeRecommended}
                      {executeRecommended !== undefined && <Text>{'  '}</Text>}
                      {showAll}
                    </Box>
                  </Box>,
                  <Text wrap="truncate-end">
                    下一步 {recommendation.nextStep || '无'}  理由 {recommendation.reason || '无'}
                  </Text>,
                ]
              : [
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text>没有收到 deck_recommend 的回报，下面是这一回合的回答原文。</Text>
                    {showAll}
                  </Box>,
                  <Text wrap="truncate-end">{answerText.split('\n').find(line => line.trim() !== '') ?? ''}</Text>,
                ]

    return (
      <Box flexDirection="column">
        {actionRow}
        {listRow}
      </Box>
    )
  }

  const skillShown = nav.tab === 'skills' ? nav.skill : undefined

  if (isInline) {
    // The top and the counts in one row, giving up what does not fit: the
    // words after the counts, the Session, the freshness. A failed read
    // leaves the row without counts, with a list read before it or not.
    const hasCounts = list !== undefined && tasks.status !== 'failed'
    const right = width(freshness.text) + 2 + 7
    const countsText = (words: boolean) =>
      !hasCounts
        ? ''
        : `   ${GROUPS.slice(0, 3)
            .map(group => `${GLYPH[group]} ${counts[group]}${words ? ` ${GROUP_TITLE[group]}` : ''}`)
            .join('  ')}  ◆ ${counts.done}/${total}`
    const executingText = executing === undefined ? '' : `  ▶ #${executing.number}`
    const fits = (words: boolean, withSession: boolean, withFreshness: boolean) =>
      width(project) + (withSession ? 3 + session.length : 0) + width(executingText) + width(countsText(words)) + 1 <=
      columns - (withFreshness ? right : 9)
    const [words, withSession, withFreshness] = (
      [
        [true, true, true],
        [false, true, true],
        [false, false, true],
        [false, false, false],
      ] as const
    ).find(([words, withSession, withFreshness]) => fits(words, withSession, withFreshness)) ?? [false, false, false]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color="suggestion" bold>
              {project}
            </Text>
            {withSession && <Text> · {session}</Text>}
            {executing !== undefined && (
              <Box flexDirection="row">
                <Text>{'  '}</Text>
                {glyph('inProgress')}
                <Text> #{executing.number}</Text>
              </Box>
            )}
            {hasCounts &&
              GROUPS.map(group => (
                <Box flexDirection="row">
                  <Text>{group === 'ready' ? '   ' : '  '}</Text>
                  {glyph(group)}
                  <Text>
                    {' '}
                    {group === 'done' ? `${counts.done}/${total}` : counts[group]}
                    {words && group !== 'done' ? ` ${GROUP_TITLE[group]}` : ''}
                  </Text>
                </Box>
              ))}
          </Box>
          <Box flexDirection="row">
            {withFreshness && <Text color={freshness.color}>{freshness.text}</Text>}
            <Text>{'  '}</Text>
            {refresh}
          </Box>
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          {tabRow}
          {isPending ? stageBar() : askButton}
        </Box>
        {detail !== undefined ? (
          detailView(detail)
        ) : skillShown !== undefined ? (
          skillView(skillShown)
        ) : nav.tab === 'tasks' ? (
          inlineTasks()
        ) : nav.tab === 'map' ? (
          mapView()
        ) : nav.tab === 'skills' ? (
          inlineSkills()
        ) : (
          inlineNext()
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color="suggestion" bold>
            {cut(project, columns - 3 - session.length - 8)}
          </Text>{' '}
          · {session}
        </Text>
        {refresh}
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        {executing === undefined ? (
          <Text>本 Session 没有在执行 Task</Text>
        ) : (
          <Box flexDirection="row">
            <Text>本 Session </Text>
            {glyph('inProgress')}
            <Text>
              {' '}#{executing.number}{' '}
              {cut(executing.title, columns - width(`本 Session ▶ #${executing.number} `) - 2 - width(freshness.text))}
            </Text>
          </Box>
        )}
        <Text color={freshness.color}>{freshness.text}</Text>
      </Box>
      {tabRow}
      <Text color="subtle">{'─'.repeat(columns)}</Text>
      {detail !== undefined && detailView(detail)}
      {detail === undefined && nav.tab === 'next' && dockedNext()}
      {detail === undefined && nav.tab === 'tasks' && dockedTasks()}
      {detail === undefined && nav.tab === 'map' && mapView()}
      {detail === undefined && nav.tab === 'skills' && (skillShown === undefined ? dockedSkills() : skillView(skillShown))}
    </Box>
  )
}
