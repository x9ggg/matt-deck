// Task kernel: what the configure skill needs to know before it asks the
// user anything.
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { readProjectConfig } from './config.ts'
import { hostCopies } from './skills.ts'
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

// The user-level skill directories, in the order they are offered.
const SKILL_DIRECTORIES = ['~/.claude/skills', '~/.agents/skills']

type SkillSource = ProjectConfig['skillSource']

// Every copy of Matt skills found on this machine, each once: a directory
// linking its skills from another one is the same copy, named where it was
// found first. `hostDirectories` are where the host finds skills itself,
// offered after the user-level ones, written as a Skill Source's path is:
// `~/...` under the home, or relative to the Workspace. With
// `markHostCalls`, each copy also says whether the host, calling ask-matt by
// its name from those directories, calls this copy's, and the copies it
// calls come first.
const findSkillSources = async (
  workspace: string,
  home: string,
  hostDirectories: string[],
  markHostCalls: boolean,
): Promise<(SkillSource & { hostCallsAskMatt?: boolean })[]> => {
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

  const copies = found.filter(({ marker }, index) => found.findIndex(other => other.marker === marker) === index)
  if (!markHostCalls) {
    return copies.map(({ source }) => source)
  }
  const copyOf = await hostCopies(hostDirectories, workspace, home)
  const marked = []
  for (const { source, marker } of copies) {
    marked.push({ ...source, hostCallsAskMatt: (await copyOf(marker, MARKER)) === 'same' })
  }

  return [...marked.filter(each => each.hostCallsAskMatt), ...marked.filter(each => !each.hostCallsAskMatt)]
}

export const surveySetup = async (workspace: string, home: string, hostDirectories: string[], markHostCalls: boolean) => ({
  existing: await readExistingConfig(workspace),
  taskSource: await readTaskSourcePrefill(workspace),
  skillSources: await findSkillSources(workspace, home, hostDirectories, markHostCalls),
})
