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
// ones too; `occupant` the Session whose Occupancy holds it, or null, and
// `isOrphaned` whether that Session has ended while the Task is open;
// `hasEvidence` whether a report gave Acceptance Evidence for it.
export type Task = {
  number: number
  title: string
  isOpen: boolean
  labels: string[]
  parent: number | null
  blockers: number[]
  blockedBy: number[]
  closedAt: string | null
  occupant: string | null
  isOrphaned: boolean
  hasEvidence: boolean
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

// One report `deck_report` kept of a Task: the Session reporting it, when, in
// milliseconds since the epoch, its result and its Acceptance Evidence, each
// with where it comes from.
export type Report = {
  session: string
  reportedAt: number
  result: string
  evidence: { text: string; source: string }[]
}

// What `deck_task` answers, with the Task's reports, the first first.
export type DeckTaskAnswer = { ok: true; task: TaskDetail; reports: Report[] } | { ok: false; failure: TaskFailure }

// What `deck_occupy` answers: whether the Session's Occupancy was recorded,
// and the Session holding the Task now; or why the Task cannot be occupied.
export type DeckOccupyAnswer =
  | { ok: true; occupied: boolean; occupant: string }
  | { ok: false; failure: { kind: TaskFailure['kind'] | 'not-open'; message: string } }

// What `deck_release` answers: whether the Session held an Occupancy of the
// Task to release.
export type DeckReleaseAnswer = { ok: true; released: boolean } | { ok: false; failure: TaskFailure }

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

// What `deck_ask` answers: a Recommendation Request made as it is sent, the
// command that runs /ask-matt and its arguments; or why none could be made.
export type DeckAskAnswer =
  | { ok: true; requestId: string; command: string; args: string }
  | { ok: false; failure: TaskFailure | SkillFailure }

// What the agent reported through `deck_recommend`: the Task to do next by
// number, or null; each text "" where there was nothing to say.
export type Recommendation = { task: number | null; nextStep: string; skill: string; reason: string; blockers: string }

// What `deck_recommendation` answers for a request.
export type DeckRecommendationAnswer = { found: true; recommendation: Recommendation } | { found: false }

// Where this Session's Recommendation Request is. held: pressed while the
// Session was busy, kept by the Pane and not sent yet; sent: handed to the
// Session; running: its turn has started; answered: its turn has ended;
// cancelled: given up while held.
export type RequestStatus = 'none' | 'held' | 'sent' | 'running' | 'answered' | 'cancelled'

// The Session's one Recommendation Request, and whether a turn of its main
// loop is running. `requestId` is the request's once it is sent, `turnId`
// its turn once it runs; `answer` what its turn left: the Recommendation, or
// the turn's answer where none was reported. `wasHeld` says the Pane held it
// before it was sent.
export type Ask = {
  isBusy: boolean
  status: RequestStatus
  wasHeld?: boolean
  requestId?: string
  turnId?: string
  answer?: { recommendation: Recommendation } | { text: string }
}

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
  | { status: 'loaded'; task: TaskDetail; reports: Report[] }
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
  // A read of the project config or the Tasks has gone unanswered for a
  // while, and still is.
  isUnanswered: boolean
}

export type Tab = 'next' | 'tasks' | 'map' | 'skills'

export type Filter = 'all' | Group

// Where the person is in the pane. `focus` is the key of the row the action
// bar is about, the last one the focus was on. `detail` is the Task the tab
// `from` drilled into, after the Tasks drilled through on the way, the last
// one shown. `page` is the tasks tab's page; `map` the Spec or Map the map
// tab shows, `switching` whether it lists them to switch, `mapPage` the page
// of what it shows. `skill` is the skill the skills tab drilled into, and
// `skillsPage` that tab's page. `isAnswerShown`: above the prompt, the
// next tab shows the whole answer of the request. `takeover` is the Task
// another Session holds that the person is asked to confirm taking over.
export type Nav = {
  takeover?: number
  isAnswerShown?: boolean
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
    'matt-deck': { view: Shaped<View>; nav: Shaped<Nav>; ask: Shaped<Ask> }
  }
}
