// Task kernel: what the configure skill needs to know before it asks the
// user anything.
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { readProjectConfig } from './config.ts'
import { hostCopies, readAll } from './skills.ts'
import type { ProjectConfig } from './config.ts'

const ISSUE_TRACKER_DOC = 'docs/agents/issue-tracker.md'

const ifExists = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read()
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

// The tracker named by the Matt issue tracker doc, as its heading writes it
// (`# Issue tracker: GitHub`), and the Task Source type it maps to. `tracker`
// is null when the doc exists but its heading names none; `type` is null when
// there is no Task Source to prefill.
type TaskSourcePrefill = {
  doc: string
  tracker: string | null
  type: ProjectConfig['taskSource']['type'] | null
}

const readTaskSourcePrefill = async (workspace: string): Promise<TaskSourcePrefill | null> => {
  const text = await ifExists(() => readFile(join(workspace, ISSUE_TRACKER_DOC), 'utf8'))
  if (text === undefined) {
    return null
  }
  const tracker = text.match(/^#\s*Issue tracker:\s*(.+?)\s*$/m)?.[1] ?? null

  return { doc: ISSUE_TRACKER_DOC, tracker, type: tracker === 'GitHub' ? 'github-issues' : null }
}

// A config file that exists counts as configured even when it is malformed:
// the skill shows it and asks before replacing it.
type ExistingConfig =
  | { configured: false }
  | { configured: true; config: ProjectConfig }
  | { configured: true; problem: string }

const readExistingConfig = async (workspace: string): Promise<ExistingConfig> => {
  try {
    const result = await readProjectConfig(workspace)

    return result.configured ? { configured: true, config: result.config } : { configured: false }
  } catch (error: any) {
    return { configured: true, problem: error.message }
  }
}

// A copy of Matt skills is a place holding the `ask-matt` skill, which the
// Deck needs for every Recommendation (ADR-0003).
const MARKER = 'ask-matt'

// The skill the Pane calls to execute a Task.
const IMPLEMENT = 'implement'

// The user-level skill directories, in the order they are offered.
const SKILL_DIRECTORIES = ['~/.claude/skills', '~/.agents/skills']

type SkillSource = ProjectConfig['skillSource']

type HostCalls = { hostCallsAskMatt: boolean; hostCallsImplement: boolean }

// Whether the host, calling ask-matt and implement by their names from its
// own skill directories, calls this Skill Source's, judged as deck_skills
// judges it; a Skill Source deck_skills cannot list calls neither. Also the
// files of its ask-matts and of its implements, known by the names their
// files give, each set with links resolved, once each and sorted.
const hostCallsOf = async (
  source: SkillSource,
  workspace: string,
  home: string,
  copyOf: Awaited<ReturnType<typeof hostCopies>>,
): Promise<HostCalls & { files: string }> => {
  let skills: { name: string; file: string }[] = []
  try {
    // Only the files are read here, not how the skills are called.
    skills = await readAll(source, workspace, home, () => '')
  } catch {}
  const calls = async (name: string) => {
    for (const skill of skills.filter(skill => skill.name === name)) {
      if ((await copyOf(skill.file, name)) === 'same') {
        return true
      }
    }
    return false
  }
  const filesOf = async (name: string) =>
    [...new Set(await Promise.all(skills.filter(skill => skill.name === name).map(skill => realpath(skill.file))))].sort()

  return {
    hostCallsAskMatt: await calls(MARKER),
    hostCallsImplement: await calls(IMPLEMENT),
    files: JSON.stringify([await filesOf(MARKER), await filesOf(IMPLEMENT)]),
  }
}

// Every copy of Matt skills found on this machine, each once: a directory
// linking its skills from another one is the same copy, named where it was
// found first. `hostDirectories` are where the host finds skills itself,
// offered after the user-level ones, written as a Skill Source's path is:
// `~/...` under the home, or relative to the Workspace. With
// `markHostCalls`, a copy is the same only when its ask-matt files and its
// implement files, known by the names their files give, are too, as sets
// with links resolved; each copy also says whether the host, calling ask-matt and
// implement by their names from those directories, calls this copy's. The
// copies whose both it calls come first, then those whose ask-matt it calls,
// each in the order found.
const findSkillSources = async (
  workspace: string,
  home: string,
  hostDirectories: string[],
  markHostCalls: boolean,
): Promise<(SkillSource & Partial<HostCalls>)[]> => {
  const found: { source: SkillSource; marker: string }[] = []

  for (const dir of [...SKILL_DIRECTORIES, ...hostDirectories]) {
    const root = dir.startsWith('~/') ? join(home, dir.slice(2)) : join(workspace, dir)
    const marker = await ifExists(() => realpath(join(root, MARKER, 'SKILL.md')))
    if (marker !== undefined) {
      found.push({ source: { type: 'directory', path: dir }, marker })
    }
  }

  const installed = await ifExists(() => readFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'))
  const plugins: Record<string, { scope: string; projectPath?: string; installPath: string }[]> =
    installed === undefined ? {} : JSON.parse(installed).plugins
  for (const [key, installs] of Object.entries(plugins)) {
    // Plugins are recorded by name, never by their versioned cache path.
    const name = key.split('@')[0]!
    for (const { scope, projectPath, installPath } of installs) {
      if (scope !== 'user' && projectPath !== workspace) {
        continue
      }
      const files = (await ifExists(() => readdir(join(installPath, 'skills'), { recursive: true }))) ?? []
      const file = files.find(file => file === `${MARKER}/SKILL.md` || file.endsWith(`/${MARKER}/SKILL.md`))
      if (file !== undefined) {
        found.push({ source: { type: 'plugin', name }, marker: await realpath(join(installPath, 'skills', file)) })
      }
    }
  }

  if (!markHostCalls) {
    return found.filter(({ marker }, index) => found.findIndex(other => other.marker === marker) === index).map(({ source }) => source)
  }
  const copyOf = await hostCopies(hostDirectories, workspace, home)
  const marked: { source: SkillSource & HostCalls; marker: string; files: string }[] = []
  for (const { source, marker } of found) {
    const { files, ...calls } = await hostCallsOf(source, workspace, home, copyOf)
    if (!marked.some(other => other.marker === marker && other.files === files)) {
      marked.push({ source: { ...source, ...calls }, marker, files })
    }
  }
  const rank = (each: HostCalls) => (each.hostCallsAskMatt && each.hostCallsImplement ? 0 : each.hostCallsAskMatt ? 1 : 2)

  return marked.map(({ source }) => source).sort((a, b) => rank(a) - rank(b))
}

// With `markHostCalls`, an existing config also says whether the host calls
// its Skill Source's ask-matt and its implement, judged as deck_skills judges
// it: the copy may be offered under another name, or not found at all.
export const surveySetup = async (workspace: string, home: string, hostDirectories: string[], markHostCalls: boolean) => {
  let existing: ExistingConfig & Partial<HostCalls> = await readExistingConfig(workspace)
  if (markHostCalls && 'config' in existing) {
    const { files, ...calls } = await hostCallsOf(existing.config.skillSource, workspace, home, await hostCopies(hostDirectories, workspace, home))
    existing = { ...existing, ...calls }
  }

  return {
    existing,
    taskSource: await readTaskSourcePrefill(workspace),
    skillSources: await findSkillSources(workspace, home, hostDirectories, markHostCalls),
  }
}
