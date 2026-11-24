// Map View kernel: each Spec and Map of a list of Tasks, with what its Map
// View shows, in the order it shows it. Host-agnostic, like the Task kernel:
// the Session asking is an id, nothing more.
import { describe } from './tasks.ts'
import type { Container, Group, SourceRead, Task, TaskList } from './tasks.ts'

// A Child Task on a Map View's wall, as the list has it, in the group it
// stands in, with when it was last updated and the open Tasks it blocks,
// in the Spec or Map or not, by number.
export type WallCard = Task & { group: Group; updatedAt: string; blocking: number[] }

// A Spec or Map with its goal, the first sentence of its body or null, and
// its Child Tasks in the order its wall shows them.
export type MapView = Container & { goal: string | null; wall: WallCard[] }

const GROUPS: Group[] = ['ready', 'inProgress', 'blocked', 'done']

// The first sentence of the first paragraph of a body's description that is
// no heading and no code block; all of the paragraph when it ends no sentence.
const goalOf = (body: string): string | null => {
  const paragraph: string[] = []
  // The fence that opened the code block a line is in.
  let fence: string | undefined
  for (const line of describe(body).description.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence !== undefined) {
      if (marker !== null && marker[1]!.startsWith(fence) && marker[2]!.trim() === '') fence = undefined
      continue
    }
    if (marker !== null || line.trim() === '' || /^\s*#{1,6}\s/.test(line)) {
      if (paragraph.length > 0) break
      fence = marker?.[1]
      continue
    }
    paragraph.push(line.trim())
  }
  if (paragraph.length === 0) return null
  const text = paragraph.join(' ')

  return text.match(/^.*?(?:[。！？]|[.!?](?=\s|$))/)?.[0] ?? text
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
