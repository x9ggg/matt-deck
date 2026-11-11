// Task kernel: what the configure skill needs to know before it asks the
// user anything.
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { readProjectConfig } from './config.ts'
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
// (`# Issue tracker: GitHub`), and the Task Source type it maps to. `type` is
// null when this milestone has no Task Source for that tracker.
type TaskSourcePrefill = { doc: string; tracker: string; type: 'github-issues' | null }

const readTaskSourcePrefill = async (workspace: string): Promise<TaskSourcePrefill | null> => {
  const text = await ifExists(() => readFile(join(workspace, ISSUE_TRACKER_DOC), 'utf8'))
  const tracker = text?.match(/^#\s*Issue tracker:\s*(.+?)\s*$/m)?.[1]
  if (tracker === undefined) {
    return null
  }

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
const SKILL_DIRECTORIES = ['.claude/skills', '.agents/skills']

type SkillSource = ProjectConfig['skillSource']

// Every copy of Matt skills found on this machine, each once: a directory
// linking its skills from another one is the same copy.
const findSkillSources = async (workspace: string, home: string): Promise<SkillSource[]> => {
  const found: { source: SkillSource; marker: string }[] = []

  for (const dir of SKILL_DIRECTORIES) {
    const marker = await ifExists(() => realpath(join(home, dir, MARKER, 'SKILL.md')))
    if (marker !== undefined) {
      found.push({ source: { type: 'directory', path: `~/${dir}` }, marker })
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

  return found
    .filter(({ marker }, index) => found.findIndex(other => other.marker === marker) === index)
    .map(({ source }) => source)
}

export const surveySetup = async (workspace: string, home: string) => ({
  existing: await readExistingConfig(workspace),
  taskSource: await readTaskSourcePrefill(workspace),
  skillSources: await findSkillSources(workspace, home),
})
