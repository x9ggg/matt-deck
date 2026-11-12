// What the Deck service answers, as the Mod reads it. Mirrors the kernel's
// types; the Mod runs apart from the kernel and cannot import it.
export type SkillSource = { type: 'directory'; path: string } | { type: 'plugin'; name: string }

export type ProjectConfig = {
  taskSource: { type: 'github-issues' }
  skillSource: SkillSource
}

// What `deck_config` answers when it succeeds.
export type DeckConfigAnswer =
  | { configured: false; workspace: string }
  | { configured: true; workspace: string; config: ProjectConfig }

export type Group = 'ready' | 'inProgress' | 'blocked' | 'done'

// A Task as `deck_tasks` lists it: `blockers` are the open Tasks blocking an
// open one, `blockedBy` every Task it declares a Blocking Edge to, closed
// ones too.
export type Task = {
  number: number
  title: string
  isOpen: boolean
  labels: string[]
  parent: number | null
  blockers: number[]
  blockedBy: number[]
  closedAt: string | null
}

// A Spec or a Map, in no group.
export type Container = Task & {
  kind: 'spec' | 'map'
  group: Group
  children: number[]
  progress: { closed: number; inProgress: number; total: number }
}

export type TaskList = {
  ok: true
  fetchedAt: number
  containers: Container[]
  groups: Record<Group, Task[]>
}

// Why the Tasks could not be read: the kernel's reasons, or the Deck service
// itself failing.
export type TaskFailure = {
  kind: 'gh-missing' | 'unauthenticated' | 'offline' | 'no-repository' | 'failed' | 'unreachable'
  message: string
}

// What `deck_tasks` answers.
export type DeckTasksAnswer = TaskList | { ok: false; failure: TaskFailure }

// A Task as `deck_task` reads it: the body split into the description and
// the acceptance criteria, the body's checklist items.
export type TaskDetail = {
  number: number
  title: string
  isOpen: boolean
  closedAt: string | null
  updatedAt: string
  labels: string[]
  assignees: string[]
  url: string
  description: string
  acceptance: { text: string; isChecked: boolean }[]
}

// What `deck_task` answers.
export type DeckTaskAnswer = { ok: true; task: TaskDetail } | { ok: false; failure: TaskFailure }

// A skill of the Skill Source as `deck_skills` lists it: `call` is how this
// Session invokes it, `path` its file.
export type Skill = { name: string; call: string; description: string; path: string }

// Why the skills could not be read: the kernel's reasons, or the Deck
// service itself failing.
export type SkillFailure = {
  kind: 'missing' | 'unknown-skill' | 'failed' | 'unreachable'
  message: string
}

// What `deck_skills` answers.
export type DeckSkillsAnswer = { ok: true; source: SkillSource; skills: Skill[] } | { ok: false; failure: SkillFailure }

// A skill with the text of its file, as `deck_skill` reads it.
export type SkillText = Skill & { text: string }

// What `deck_skill` answers.
export type DeckSkillAnswer = { ok: true; skill: SkillText } | { ok: false; failure: SkillFailure }

// The skills as last read, and one skill's text as last read.
export type SkillsView =
  | { status: 'loading' }
  | { status: 'loaded'; skills: Skill[] }
  | { status: 'failed'; failure: SkillFailure }

export type SkillTextView =
  | { status: 'loading' }
  | { status: 'loaded'; skill: SkillText }
  | { status: 'failed'; failure: SkillFailure }

// One Task's detail as last read: still asking, read, or why not.
export type DetailView =
  | { status: 'loading' }
  | { status: 'loaded'; task: TaskDetail }
  | { status: 'failed'; failure: TaskFailure }

// What the Mod knows of the project config: still asking, the Deck service
// out of reach, the service's answer, or why the config could not be read.
export type ConfigView =
  | { status: 'loading' }
  | { status: 'unreachable'; message: string }
  | { status: 'unconfigured'; workspace: string }
  | { status: 'configured'; workspace: string; config: ProjectConfig }
  | { status: 'error'; message: string }

// The Tasks as last read. A failed read keeps the list read before it, if
// any, to draw under the reason.
export type TasksView =
  | { status: 'loading' }
  | { status: 'loaded'; list: TaskList }
  | { status: 'failed'; failure: TaskFailure; list?: TaskList }

export type View = {
  sessionId: string
  config: ConfigView
  tasks: TasksView
  // Each Task's detail as last read, by number.
  details: Record<number, DetailView>
  skills: SkillsView
  // Each skill's text as last read, by name.
  skillTexts: Record<string, SkillTextView>
  // When the Tasks were last asked for: how old they are is told from it.
  checkedAt: number
}

export type Tab = 'next' | 'tasks' | 'map' | 'skills'

export type Filter = 'all' | Group

// Where the person is in the pane. `focus` is the key of the row the action
// bar is about, the last one the focus was on. `detail` is the Task the tab
// `from` drilled into, after the Tasks drilled through on the way, the last
// one shown. `page` is the tasks tab's page; `map` the Spec or Map the map
// tab shows, `switching` whether it lists them to switch, `mapPage` the page
// of what it shows. `skill` is the skill the skills tab drilled into, and
// `skillsPage` that tab's page.
export type Nav = {
  tab: Tab
  filter: Filter
  page: number
  focus?: string
  detail?: { from: Tab; path: number[] }
  map?: number
  switching?: boolean
  mapPage?: number
  skill?: string
  skillsPage?: number
}

declare module 'claude-code' {
  interface PluginState {
    'matt-deck': { view: Shaped<View>; nav: Shaped<Nav> }
  }
}
