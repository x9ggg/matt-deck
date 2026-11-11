// Task kernel: reading and writing the project config. Host-agnostic: it knows a
// workspace directory and nothing about who asks.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type ProjectConfig = {
  taskSource: { type: 'github-issues' }
  skillSource: { type: 'directory'; path: string } | { type: 'plugin'; name: string }
}

export type ProjectConfigResult =
  | { configured: false; workspace: string }
  | { configured: true; workspace: string; config: ProjectConfig }

const CONFIG_PATH = '.matt-deck/config.json'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== ''

// Why the config is malformed, or undefined when it is well formed.
const problemOf = (value: unknown): string | undefined => {
  if (!isObject(value)) {
    return 'it must be a JSON object'
  }
  const { taskSource, skillSource } = value
  if (!isObject(taskSource) || taskSource.type !== 'github-issues') {
    return 'taskSource.type must be "github-issues"'
  }
  if (isObject(skillSource) && skillSource.type === 'directory' && isNonEmptyString(skillSource.path)) {
    return undefined
  }
  if (isObject(skillSource) && skillSource.type === 'plugin' && isNonEmptyString(skillSource.name)) {
    return undefined
  }

  return 'skillSource must be { "type": "directory", "path": "..." } or { "type": "plugin", "name": "..." }'
}

// Throws when the config exists but is malformed.
export const readProjectConfig = async (workspace: string): Promise<ProjectConfigResult> => {
  let text: string
  try {
    text = await readFile(join(workspace, CONFIG_PATH), 'utf8')
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return { configured: false, workspace }
    }
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: any) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${error.message}`)
  }
  const problem = problemOf(value)
  if (problem !== undefined) {
    throw new Error(`${CONFIG_PATH} is malformed: ${problem}`)
  }

  return { configured: true, workspace, config: value as ProjectConfig }
}

// Writes the project config, making the workspace a Configured Project.
// Throws when the config is malformed, or when one exists and `replace` is
// not set: an existing config is never overwritten silently.
export const writeProjectConfig = async (workspace: string, config: unknown, replace: boolean) => {
  const problem = problemOf(config)
  if (problem !== undefined) {
    throw new Error(`Not written, the config is malformed: ${problem}`)
  }
  const path = join(workspace, CONFIG_PATH)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: replace ? 'w' : 'wx' })
  } catch (error: any) {
    if (error.code === 'EEXIST') {
      throw new Error(`Not written, ${CONFIG_PATH} already exists: pass replace to overwrite it`)
    }
    throw error
  }

  return config as ProjectConfig
}
