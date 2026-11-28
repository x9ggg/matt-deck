// Map View kernel: each Spec and Map of a list of Tasks, with what its Map
// View shows, in the order it shows it. Host-agnostic, like the Task kernel:
// the Session asking is an id, nothing more.
import { describedLines } from './tasks.ts'
import type { Container, Group, SourceRead, Task, TaskList } from './tasks.ts'

// A Child Task on a Map View's wall, as the list has it, in the group it
// stands in, with when it was last updated and the open Tasks it blocks,
// in the Spec or Map or not, by number.
export type WallCard = Task & { group: Group; updatedAt: string; blocking: number[] }

// A Spec or Map with its goal, the first sentence of the first paragraph of
// text in its body or null, and its Child Tasks in the order its wall shows
// them; its closeout check as the list has it.
export type MapView = Container & { goal: string | null; wall: WallCard[] }

const GROUPS: Group[] = ['ready', 'inProgress', 'blocked', 'done']

// A table's delimiter row: cells of `-`, with a `:` at either end, between
// `|`, of which there is one at least. No two runs of white space in it can
// share a space, so a long line of them reads in time that grows with its
// length.
const DELIMITER_ROW = /^\s*(?:\|\s*)?:?-+:?\s*(?:\|\s*:?-+:?\s*)*(?:\|\s*)?$/
// A definition of a link, `[name]: address`, with a title after it if any;
// or of a footnote, `[^name]: …`.
const DEFINITION = /^ {0,3}(?:\[\^[^\]\s]+\]:|\[[^\]]+\]:\s*(?:<[^<>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*$)/
// Characters that show nothing: zero-width spaces and joiners, and the byte
// order mark.
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g

// The first sentence of the first paragraph of text in a body's description,
// as text: past headings, code blocks, fenced or indented, lists with the
// paragraphs indented under their items, quotes, tables, details, other HTML
// blocks, definitions of links and footnotes, lines of images alone, rules,
// and paragraphs with nothing but white space or zero-width characters left
// once read as text; all of the paragraph when it ends no sentence, however
// long.
const goalOf = (body: string): string | null => {
  const paragraph: string[] = []
  // The paragraph read as text, which is nothing until it ends.
  let text = ''
  // The fence that opened the code block a line is in.
  let fence: string | undefined
  // In a quote, table or HTML block, until a blank line ends it; in a list,
  // until a line after a blank one that is indented less than two spaces; in
  // details, until the line that closes them; in an HTML comment, until the
  // line that closes it.
  let skipping: 'block' | 'list' | 'details' | 'comment' | undefined
  // Whether a blank line has come since the list began.
  let isPastBlank = false
  const lines = [...describedLines(body).lines, '']
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence !== undefined) {
      if (marker !== null && marker[1]!.startsWith(fence) && marker[2]!.trim() === '') fence = undefined
      continue
    }
    if (skipping === 'comment') {
      if (line.includes('-->')) skipping = undefined
      continue
    }
    if (skipping === 'details') {
      if (/<\/details\s*>/i.test(line)) skipping = undefined
      continue
    }
    if (skipping === 'list' && line.trim() === '') {
      isPastBlank = true
      continue
    }
    if (skipping === 'list' && isPastBlank && !/^(?: {2}|\t)/.test(line)) {
      skipping = undefined
    }
    if ((skipping === 'block' || skipping === 'list') && line.trim() !== '') {
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
    const isDetails = /^\s*<details(?:[\s>]|$)/i.test(line)
    // HTML as CommonMark begins a block of it: a comment, a declaration or
    // instruction, a tag that only begins a block, or a tag alone on its
    // line; an autolink or a tag within a line of text is no block.
    const isHtml =
      isComment ||
      /^\s*<(?:[?!]|\/?(?:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$))/i.test(line) ||
      /^\s*<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>\s*$/.test(line)
    const isList = !isRule && /^\s*(?:[-*+]\s|\d{1,9}[.)]\s)/.test(line)
    // A line with a delimiter row under it heads a table.
    const isTable = /^\s*\|/.test(line) || (line.trim() !== '' && lines[index + 1]!.includes('|') && DELIMITER_ROW.test(lines[index + 1]!))
    const isBlock = !isRule && (isHtml || isList || isTable || /^\s*>/.test(line))
    // Outside a paragraph, a line indented four spaces or a tab is code, and
    // a definition of a link or a footnote, `[name]: …`, shows nothing.
    const isOwnLine = paragraph.length === 0 && line.trim() !== '' && (/^(?: {4}|\t)/.test(line) || DEFINITION.test(line))
    const isLine = isRule || marker !== null || /^\s*#{1,6}(?:\s|$)/.test(line) || /^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)+$/.test(line)
    if (isOwnLine) continue
    if (line.trim() !== '' && !isBlock && !isLine) {
      paragraph.push(line.trim())
      continue
    }
    // The paragraph, if any, ends here.
    if (paragraph.length > 0) {
      text = asText(paragraph.join(' '))
      if (text.replace(ZERO_WIDTH, '').trim() !== '') break
      text = ''
      paragraph.length = 0
    }
    if (line.trim() === '') {
      skipping = undefined
      continue
    }
    fence = marker?.[1]
    if (isComment) skipping = line.includes('-->', line.indexOf('<!--') + 4) ? undefined : 'comment'
    else if (isDetails) skipping = /<\/details\s*>/i.test(line) ? 'block' : 'details'
    else if (isList) {
      skipping = 'list'
      isPastBlank = false
    } else if (isBlock) skipping = 'block'
  }
  if (text === '') return null

  // A full stop before a lower-case letter, as in `e.g. the`, ends no
  // sentence; one before a capital, as in `Dr. Smith`, does.
  return text.match(/^.*?(?:[。！？]|[!?](?=\s|$)|\.(?=$|\s[^\s\p{Ll}]))/u)?.[0] ?? text
}

// The characters the HTML entities a goal reads as text stand for; `&nbsp;`
// as a space.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

// A paragraph as text: a code span as what it holds, and outside code spans,
// an HTML comment as nothing, an HTML tag as nothing but `<br>` as a space,
// an autolink as its address, a link, inline or by reference, as its text,
// emphasis and strikethrough as what they mark, an image or a footnote's
// mark as nothing, and an entity as the character it stands for, once the
// tags are gone. An underscore within a word stresses nothing. None of them
// reaches past a mark of its own kind, so a long line of unclosed ones reads
// in time that grows with its length, not with its square.
const asText = (paragraph: string) => {
  // A run of backticks opens a code span the next run as long closes; one no
  // run closes is a backtick or more as they are. Each code span stands as a
  // mark of its number while links and emphasis are read, so a link whose
  // text is code reads as that code.
  const marked = paragraph.replace(/[\uE000\uE001]/g, '')
  const runs = [...marked.matchAll(/`+/g)].map(run => ({ at: run.index, length: run[0].length }))
  const closing: (number | undefined)[] = []
  const nextOfLength = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index--) {
    closing[index] = nextOfLength.get(runs[index]!.length)
    nextOfLength.set(runs[index]!.length, index)
  }
  const spans: string[] = []
  let withMarks = ''
  let from = 0
  for (let index = 0; index < runs.length; index++) {
    const close = closing[index]
    if (close === undefined) continue
    const { at, length } = runs[index]!
    withMarks += `${marked.slice(from, at)}\uE000${spans.length}\uE001`
    spans.push(marked.slice(at + length, runs[close]!.at).trim())
    from = runs[close]!.at + length
    index = close
  }
  withMarks += marked.slice(from)
  // An HTML comment ends at the first `-->` after it; once one is left
  // open, none after it closes either.
  let uncommented = ''
  let at = 0
  for (let open = withMarks.indexOf('<!--'); open !== -1; open = withMarks.indexOf('<!--', at)) {
    const close = withMarks.indexOf('-->', open + 4)
    if (close === -1) break
    uncommented += withMarks.slice(at, open)
    at = close + 3
  }
  uncommented += withMarks.slice(at)

  return uncommented
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '')
    .replace(/\[\^[^[\]\s]+\]/g, '')
    .replace(/!\[[^[\]]*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^[\]]*\])/g, '')
    .replace(/\[([^[\]]*)\](?:\((?:[^()]|\([^()]*\))*\)|\[[^[\]]*\])/g, '$1')
    .replace(/\*\*(?=[^\s*])([^*]*?)(?<=[^\s*])\*\*/g, '$1')
    .replace(/__(?=[^\s_])([^_]*?)(?<=[^\s_])__/g, '$1')
    .replace(/\*(?=[^\s*])([^*]*?)(?<=[^\s*])\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/~~(?=[^\s~])([^~]*?)(?<=[^\s~])~~/g, '$1')
    .replace(/&(?:([a-z]+)|#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6}));/g, (entity, name, decimal, hexadecimal) => {
      if (name !== undefined) return ENTITIES[name] ?? entity
      const code = decimal !== undefined ? Number(decimal) : parseInt(hexadecimal, 16)
      // As CommonMark has it, an entity of no character, or of a code point
      // that is none, stands for U+FFFD; so does one of the marks above.
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0xe000 || code === 0xe001
        ? '�'
        : String.fromCodePoint(code)
    })
    .replace(/\uE000(\d+)\uE001/g, (_, number) => spans[Number(number)]!)
    .replace(/\s+/g, ' ')
    .trim()
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
    }
  }

  return [...list.containers].sort((a, b) => Number(b.isOpen) - Number(a.isOpen)).map(viewOf)
}
