// Map View kernel: each Spec and Map of a list of Tasks, with what its Map
// View shows, in the order it shows it. Host-agnostic, like the Task kernel:
// the Session asking is an id, nothing more.
import { describe } from './tasks.ts'
import type { Container, Group, SourceRead, Task, TaskList } from './tasks.ts'

// A Child Task on a Map View's wall, as the list has it, in the group it
// stands in, with when it was last updated and the open Tasks it blocks,
// in the Spec or Map or not, by number.
export type WallCard = Task & { group: Group; updatedAt: string; blocking: number[] }

// A Spec or Map with its goal, the first sentence of the first paragraph of
// text in its body or null, its Child Tasks in the order its wall shows
// them, and, Pending Closeout, the closeout check the Pane prefills, else
// null.
export type MapView = Container & { goal: string | null; wall: WallCard[]; closeoutPrompt: string | null }

const GROUPS: Group[] = ['ready', 'inProgress', 'blocked', 'done']

// The closeout check of a Pending Closeout Spec, as Claude Code's Pane words
// it (plugin/hooks/register.tsx): a check for the person to decide on, never
// a request to close the Spec.
const closeoutPrompt = ({ number, progress }: Container) =>
  `请对当前项目的 Spec #${number} 做收尾核对。Pane 显示 Child Task 已全部关闭` +
  `（${progress.closed}/${progress.total}），这只是触发条件，不是完成或验收通过的证据。\n\n` +
  '先重新读取 Spec 及其全部 Child Task 的正文、评论和当前状态。对照 Spec 的每条用户故事与验收条件，' +
  '逐条核对 Child Task 的交付、最终代码、测试或运行结果，并列出可复核的 Acceptance Evidence 及出处；' +
  '不要只依赖关闭状态或任务自述。说明改动所在的分支、提交或工作区及仓库检查结果，' +
  '区分已验证、未验证和不满足的条目。以“不做”或“重复”关闭的 Child Task，说明原承诺如何满足以及是否有用户确认。\n\n' +
  '在本 Session 中说明核对结论、剩余缺口、对应的 Spec 条目和建议下一步。' +
  '本次只核对并报告，不关闭 Spec，也不自动重开或修改任何 Task；是否关闭 Spec 由用户决定。'

// The first sentence of the first paragraph of text in a body's description,
// as text: past headings, code blocks, lists, quotes, tables, HTML blocks,
// lines of images alone and rules; all of the paragraph when it ends no
// sentence, however long.
const goalOf = (body: string): string | null => {
  const paragraph: string[] = []
  // The fence that opened the code block a line is in.
  let fence: string | undefined
  // In a list, quote, table or HTML block, until a blank line ends it; in an
  // HTML comment, until the line that closes it.
  let skipping: 'block' | 'comment' | undefined
  for (const line of describe(body).description.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence !== undefined) {
      if (marker !== null && marker[1]!.startsWith(fence) && marker[2]!.trim() === '') fence = undefined
      continue
    }
    if (skipping === 'comment') {
      if (line.includes('-->')) skipping = undefined
      continue
    }
    if (line.trim() === '') {
      if (paragraph.length > 0) break
      skipping = undefined
      continue
    }
    if (skipping === 'block') {
      // A code block in a list item goes on past blank lines.
      fence = marker?.[1]
      continue
    }
    // A line of `=` or `-` under a paragraph makes it a heading.
    if (paragraph.length > 0 && /^\s*(?:=+|-+)\s*$/.test(line)) {
      paragraph.length = 0
      continue
    }
    // A rule, `- - -` too, is no list.
    const isRule = /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)
    const isComment = /^\s*<!--/.test(line)
    // HTML as CommonMark begins a block of it: a comment, a declaration or
    // instruction, a tag that only begins a block, or a tag alone on its
    // line; an autolink or a tag within a line of text is no block.
    const isHtml =
      isComment ||
      /^\s*<(?:[?!]|\/?(?:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$))/i.test(line) ||
      /^\s*<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>\s*$/.test(line)
    const isBlock = !isRule && (isHtml || /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|>|\|)/.test(line))
    const isLine = isRule || marker !== null || /^\s*#{1,6}(?:\s|$)/.test(line) || /^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)+$/.test(line)
    if (isBlock || isLine) {
      if (paragraph.length > 0) break
      fence = marker?.[1]
      if (isComment) skipping = line.includes('-->', line.indexOf('<!--') + 4) ? undefined : 'comment'
      else if (isBlock) skipping = 'block'
      continue
    }
    paragraph.push(line.trim())
  }
  if (paragraph.length === 0) return null
  // As text: a code span as what it holds, and outside code spans, a link
  // as its text, emphasis as what it stresses, an image as nothing. An
  // underscore within a word stresses nothing. None of them reaches past a
  // mark of its own kind, so a long line of unclosed ones reads in time
  // that grows with its length, not with its square.
  const asText = (part: string) =>
    part
      .replace(/!\[[^[\]]*\]\([^()]*\)/g, '')
      .replace(/\[([^[\]]*)\]\([^()]*\)/g, '$1')
      .replace(/\*\*(?=[^\s*])([^*]*?)(?<=[^\s*])\*\*/g, '$1')
      .replace(/__(?=[^\s_])([^_]*?)(?<=[^\s_])__/g, '$1')
      .replace(/\*(?=[^\s*])([^*]*?)(?<=[^\s*])\*/g, '$1')
      .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, '$1')
  // A run of backticks opens a code span the next run as long closes; one
  // no run closes is a backtick or more as they are.
  const joined = paragraph.join(' ')
  const runs = [...joined.matchAll(/`+/g)].map(run => ({ at: run.index, length: run[0].length }))
  const closing: (number | undefined)[] = []
  const nextOfLength = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index--) {
    closing[index] = nextOfLength.get(runs[index]!.length)
    nextOfLength.set(runs[index]!.length, index)
  }
  let text = ''
  let from = 0
  for (let index = 0; index < runs.length; index++) {
    const close = closing[index]
    if (close === undefined) continue
    const { at, length } = runs[index]!
    text += asText(joined.slice(from, at)) + joined.slice(at + length, runs[close]!.at).trim()
    from = runs[close]!.at + length
    index = close
  }
  text = (text + asText(joined.slice(from))).replace(/\s+/g, ' ').trim()

  // A full stop before a lower-case letter, as in `e.g. the`, ends no
  // sentence; one before a capital, as in `Dr. Smith`, does.
  return text.match(/^.*?(?:[。！？]|[!?](?=\s|$)|\.(?=$|\s[^\s\p{Ll}]))/u)?.[0] ?? text
}

// Every Spec and Map of `list`, a read of `source`, open ones first, as the
// Session `session` sees them.
export const mapViews = (list: TaskList, source: SourceRead, session: string): MapView[] => {
  const read = new Map(source.tasks.map(task => [task.number, task]))
  // Every Task where it stands, a Spec or Map too.
  const placed: { task: Task; group: Group }[] = [
    ...list.containers.map(container => ({ task: container, group: container.group })),
    ...GROUPS.flatMap(group => list.groups[group].map(task => ({ task, group }))),
  ]
  // In progress, the Session's own Tasks first, then other Sessions', then
  // the Orphaned ones; a Task in no other group is held by a Session.
  const rank = (card: WallCard) => (card.isOrphaned ? 2 : card.occupant === session ? 0 : 1)

  const viewOf = (container: Container): MapView => {
    const cards = placed
      .filter(({ task }) => task.parent === container.number)
      .map(({ task, group }): WallCard => ({
        ...task,
        group,
        updatedAt: read.get(task.number)!.updatedAt,
        // A closed Task blocks nothing, so only open Tasks name it a blocker.
        blocking: placed
          .filter(other => other.task.blockers.includes(task.number))
          .map(other => other.task.number)
          .sort((a, b) => a - b),
      }))
      // In a group as the list has them, closed ones by when, the last first.
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (b.closedAt ?? '').localeCompare(a.closedAt ?? '') ||
          a.number - b.number,
      )
    // Blocked, each blocker on the wall before the Tasks it blocks. A loop
    // of Blocking Edges, which the Task Source does not forbid, is cut where
    // it is first reached.
    const blocked = cards.filter(card => card.group === 'blocked')
    const ordered: WallCard[] = []
    const reached = new Set<number>()
    const place = (card: WallCard) => {
      if (reached.has(card.number)) return
      reached.add(card.number)
      blocked.filter(other => card.blockers.includes(other.number)).forEach(place)
      ordered.push(card)
    }
    blocked.forEach(place)

    return {
      ...container,
      goal: goalOf(read.get(container.number)!.body),
      wall: GROUPS.flatMap(group => (group === 'blocked' ? ordered : cards.filter(card => card.group === group))),
      closeoutPrompt: container.isPendingCloseout ? closeoutPrompt(container) : null,
    }
  }

  return [...list.containers].sort((a, b) => Number(b.isOpen) - Number(a.isOpen)).map(viewOf)
}
