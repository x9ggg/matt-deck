// The Pane's drawing, after `docs/pane-layout.md`: the frame every tab shares
// (top, tab row, and in each tab its action bar and pages) and the tasks tab.
// It draws from what it is handed and changes nothing itself: every press
// goes to one of the `actions`.
import type { Elements, RenderChildren, RenderPropsOf, RenderSurface } from 'claude-code'

import type { Container, DetailView, Filter, Group, Nav, Tab, Task, TaskFailure, TaskList, View } from '../types'

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

const pad = (n: number) => String(n).padStart(2, '0')

// A closing time as the list writes it, in the local time zone: `11-11 14:07`.
const closedTime = (closedAt: string) => {
  const date = new Date(closedAt)

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// The status word at a Task row's right end.
const statusOf = (task: Task, group: Group) => {
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
      return ''
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
  actions: Actions,
) => {
  const { Box, Button, Link, Markdown, Text } = el
  const columns = props.bodyColumns
  const isInline = props.placement === 'inline'
  const { config, tasks } = view

  if (config.status === 'loading') {
    return <Text dimColor>正在读取项目配置…</Text>
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
  // with the gap before them.
  const rowActions = (row: Row) => (
    <Button key="open" plain hotkey="o" label="详情" onPress={() => actions.openTask(numberOf(row))} />
  )
  const ACTIONS_WIDTH = 2 + width('o: 详情')

  // What the action bar says of a row before its actions: a Task's triage
  // label, a Spec's or Map's Child Tasks by group.
  const actionBar = (row: Row) => (
    <Box flexDirection="row" justifyContent="space-between">
      {'container' in row ? (
        <Box flexDirection="row">
          <Text>{numbered(row.container.number)}</Text>
          {childCountItems(row.container)}
        </Box>
      ) : (
        <Text>
          {numbered(row.task.number)}
          {row.task.labels.find(label => TRIAGE_LABELS.includes(label)) ?? ''}
        </Text>
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
              {cut(container.title, columns - 2 - width(head) - width(tail) - countsWidth - ACTIONS_WIDTH)}
              {tail}
            </Text>
            {childCountItems(container)}
          </Box>
          {rowActions(row)}
        </Box>
      )
    }
    const { task, group } = row
    const status = statusOf(task, group)
    const label = task.labels.find(label => TRIAGE_LABELS.includes(label)) ?? ''
    const tail = `${status === '' ? '' : `   ${status}`}${label === '' ? '' : `   ${label}`}`

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          {glyph(group, group === 'blocked')}
          <Text dimColor={group === 'blocked'}>
            {' '}
            {numbered(task.number)}
            {cut(task.title, columns - 2 - numberColumns - 1 - width(tail) - ACTIONS_WIDTH)}
            {tail}
          </Text>
        </Box>
        {rowActions(row)}
      </Box>
    )
  }

  // A docked list row, filling the pane's width: glyph, number, title cut to
  // what is left, the status at the right end.
  const docked = (row: Row) => {
    if ('container' in row) {
      const { container } = row
      const head = ` ${container.kind === 'spec' ? 'Spec' : 'Map'} `
      const number = `#${container.number}`
      const progress = progressText(container)
      const room = columns - 1 - width(head) - width(number) - 1 - 1 - width(progress)
      const title = cut(container.title, room)

      return (
        <Button
          key={row.key}
          plain
          autoFocus={row === landing ? true : undefined}
          onPress={() => actions.openTask(container.number)}
        >
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
    const status = statusOf(task, group)
    const room = columns - 2 - (numberColumns + 1) - 1 - width(status)
    const title = cut(task.title, room)

    return (
      <Button
        key={row.key}
        plain
        autoFocus={row === landing ? true : undefined}
        onPress={() => actions.openTask(task.number)}
      >
        {glyph(group, dim)}
        <Text color="inactive" dimColor={dim}>
          {' '}
          {numbered(task.number)}
        </Text>
        <Text dimColor={dim}>
          {title}
          {spaces(room - width(title) + 1)}
        </Text>
        <Text color="inactive" dimColor={dim}>
          {status}
        </Text>
      </Button>
    )
  }

  // A Spec's or Map's progress bar, under its row: closed, in progress, the
  // rest; all of it `warning` once every Child Task is closed.
  const progressBar = (container: Container) => {
    const bar = columns - 2
    const { closed, inProgress, total } = container.progress
    const closedCells = total === 0 ? 0 : Math.round((closed / total) * bar)
    const inProgressCells = total === 0 ? 0 : Math.round(((closed + inProgress) / total) * bar) - closedCells

    return (
      <Box flexDirection="row">
        <Text>{'  '}</Text>
        <Text color={total > 0 && closed === total ? 'warning' : 'suggestion'}>{'━'.repeat(closedCells)}</Text>
        <Text color="suggestion" dimColor>
          {'╍'.repeat(inProgressCells)}
        </Text>
        <Text color="subtle">{'─'.repeat(bar - closedCells - inProgressCells)}</Text>
      </Box>
    )
  }

  // The docked tasks tab: filter, action bar, and the rows in pages that fit
  // under the fixed rows, so the engine never scrolls the pane.
  const dockedTasks = () => {
    if (list === undefined || shown === undefined) {
      return tasks.status === 'failed' ? failureBox(tasks.failure) : <Text color="inactive">正在读取 Task…</Text>
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

    // The list in units that stay together on a page: a Spec or Map with its
    // bar, a group's title with its first row (after a blank line, dropped at
    // the top of a page), each further row, a group's fold.
    type Unit = { lines: RenderChildren[]; keys: string[]; blankFirst: boolean }
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
    const room = Math.max(3, props.scroll.bodyRows - 7 - failureRows)
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
    const pageIndex = Math.min(nav.page, pages.length - 1)
    const page = pages[pageIndex]!
    const itemsOf = (units: Unit[]) => units.reduce((sum, unit) => sum + unit.keys.length, 0)
    const before = itemsOf(pages.slice(0, pageIndex).flat())
    const after = itemsOf(pages.slice(pageIndex + 1).flat())

    return (
      <Box flexDirection="column">
        {head}
        {actionBar(focused!)}
        <Text> </Text>
        {pageIndex > 0 && (
          <Button
            key="page:prev"
            plain
            onPress={() => actions.turnPage(pageIndex - 1, pages[pageIndex - 1]!.flatMap(unit => unit.keys).at(-1))}
          >
            <Text color="inactive">{'  '}前面还有 {before} 个</Text>
          </Button>
        )}
        {page.flatMap((unit, index) => (index === 0 && unit.blankFirst ? unit.lines.slice(1) : unit.lines))}
        {pageIndex < pages.length - 1 && (
          <Button
            key="page:next"
            plain
            onPress={() => actions.turnPage(pageIndex + 1, pages[pageIndex + 1]!.flatMap(unit => unit.keys)[0])}
          >
            <Text color="inactive">{'  '}还有 {after} 个</Text>
          </Button>
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
      return (
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

    const labelOf = (row: Row) =>
      'container' in row
        ? `${GLYPH[row.container.group]} ${row.container.kind === 'spec' ? 'Spec' : 'Map'} #${row.container.number} ${progressText(row.container)}`
        : `${GLYPH[row.group]} #${row.task.number} ${cut(row.task.title, 28)}`
    // Pages by width: each keeps room for the way back and the way on.
    const room = columns - filterWidth - 2
    const moreWidth = width(`还有 ${rows.length} 个`) + 3
    const starts = [0]
    for (let at = 0, used = 0; at < rows.length; at++) {
      const start = starts.at(-1)!
      const backWidth = start > 0 ? width(`前面 ${start} 个`) + 3 : 0
      const itemWidth = width(labelOf(rows[at]!)) + (at === start ? 0 : 3)
      const onWidth = at < rows.length - 1 ? moreWidth : 0
      if (at > start && backWidth + used + itemWidth + onWidth > room) {
        starts.push(at)
        used = width(labelOf(rows[at]!))
      } else {
        used += itemWidth
      }
    }
    const pageIndex = Math.min(nav.page, starts.length - 1)
    const start = starts[pageIndex]!
    const end = starts[pageIndex + 1] ?? rows.length
    const pageRows = rows.slice(start, end)

    return (
      <Box flexDirection="column">
        {inlineActionBar(focused!)}
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            {pageIndex > 0 && (
              <Button key="page:prev" plain onPress={() => actions.turnPage(pageIndex - 1, rows[start - 1]!.key)}>
                <Text color="inactive">前面 {start} 个</Text>
              </Button>
            )}
            {pageRows.map((row, index) => (
              <Box flexDirection="row">
                {(index > 0 || pageIndex > 0) && <Text>{'   '}</Text>}
                <Button
                  key={row.key}
                  plain
                  autoFocus={row === landing ? true : undefined}
                  onPress={() => actions.openTask(numberOf(row))}
                >
                  {'container' in row ? glyph(row.container.group) : glyph(row.group, row.group === 'blocked')}
                  <Text dimColor={'group' in row && row.group === 'blocked'}>{labelOf(row).slice(1)}</Text>
                </Button>
              </Box>
            ))}
            {end < rows.length && (
              <Box flexDirection="row">
                <Text>{'   '}</Text>
                <Button key="page:next" plain onPress={() => actions.turnPage(pageIndex + 1, rows[end]!.key)}>
                  <Text color="inactive">还有 {rows.length - end} 个</Text>
                </Button>
              </Box>
            )}
          </Box>
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
      const { task } = shown
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
                {glyph(entry.group, entry.group === 'blocked')}
                <Text>
                  {' '}
                  {entry.group === 'done' ? '已解锁' : entry.group === 'inProgress' ? '进行中' : statusOf(entry.task, entry.group)}
                </Text>
              </Box>,
            ]),
        <Text>{meta}</Text>,
        ...(parent === undefined
          ? []
          : [
              <Button key={`parent:${parent.number}`} plain onPress={() => actions.openTask(parent.number)}>
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
                  {glyph(blocker.group, blocker.group === 'blocked')}
                  <Text dimColor={blocker.group === 'blocked'}>
                    {' '}
                    {numbered(blocker.number)}
                    {cut(blocker.task.title, columns - 2 - (numberColumns + 1))}
                  </Text>
                </Button>
              )),
            ]),
        <Text> </Text>,
        <Link href={task.url}>
          <Text color="suggestion" underline>
            在 GitHub 打开
          </Text>
        </Link>,
      ]
    })()

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button key="back" plain hotkey="b" label="返回" onPress={actions.back} />
          <Text>
            {'  '}
            {cut(crumbs, columns - width('b: 返回  '))}
          </Text>
        </Box>
        <Text color="subtle">{'─'.repeat(columns)}</Text>
        {body}
      </Box>
    )
  }
  const detail = nav.detail?.from === nav.tab ? nav.detail : undefined

  const skillSource =
    config.config.skillSource.type === 'plugin'
      ? `插件 ${config.config.skillSource.name}`
      : `目录 ${config.config.skillSource.path}`

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
    const fits = (words: boolean, withSession: boolean, withFreshness: boolean) =>
      width(project) + (withSession ? 3 + session.length : 0) + width(countsText(words)) + 1 <=
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
        {tabRow}
        {detail !== undefined ? (
          detailView(detail)
        ) : nav.tab === 'tasks' ? (
          inlineTasks()
        ) : nav.tab === 'skills' ? (
          <Box flexDirection="column">
            <Text>
              Skill Source <Text color="inactive">{skillSource}</Text>
            </Text>
            <Text> </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text> </Text>
            <Text> </Text>
          </Box>
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
        <Text>本 Session 没有在执行 Task</Text>
        <Text color={freshness.color}>{freshness.text}</Text>
      </Box>
      {tabRow}
      <Text color="subtle">{'─'.repeat(columns)}</Text>
      {detail !== undefined && detailView(detail)}
      {detail === undefined && nav.tab === 'tasks' && dockedTasks()}
      {detail === undefined && nav.tab === 'skills' && (
        <Text>
          Skill Source <Text color="inactive">{skillSource}</Text>
        </Text>
      )}
    </Box>
  )
}
