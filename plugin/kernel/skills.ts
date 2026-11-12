// Task kernel: the skills of a project's Skill Source, read and never
// written. Host-agnostic: it knows a workspace and a home directory.
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import type { ProjectConfig } from './config.ts'

type SkillSource = ProjectConfig['skillSource']

// A skill as the Pane lists it: `call` is how this Session invokes it, a
// plugin's with the plugin's prefix; `path` is its file, `~` for the home.
export type Skill = { name: string; call: string; description: string; path: string }

// Why the Skill Source cannot be read: it is not there, or holds no skill of
// that name.
export class SkillSourceError extends Error {
  kind: 'missing' | 'unknown-skill'
  constructor(kind: SkillSourceError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

const isMissing = (error: any) => error.code === 'ENOENT' || error.code === 'ENOTDIR'

// The frontmatter's `key: value` fields, and the body under it. A value
// written as a block (`>` or `|`, then indented lines) is read as one line:
// the Pane lists a description on one.
const parse = (text: string) => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const fields: Record<string, string> = {}
  let block: string | undefined
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const field = line.match(/^([\w-]+):\s*(.*?)\s*$/)
    if (field !== null) {
      block = /^[>|][+-]?$/.test(field[2]!) ? field[1]! : undefined
      fields[field[1]!] = block === undefined ? field[2]!.replace(/^(["'])(.*)\1$/, '$2') : ''
    } else if (block !== undefined && line.trim() !== '') {
      fields[block] = `${fields[block]} ${line.trim()}`.trimStart()
    }
  }

  return { fields, body: text.slice(match?.[0].length ?? 0).replace(/^\s*\n/, '') }
}

// Where the skill files are: the root they lie under, how a path under it is
// written, the prefix of a call, and the files relative to the root.
const locate = async (source: SkillSource, workspace: string, home: string) => {
  const tilde = (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)
  if (source.type === 'directory') {
    const root = source.path.startsWith('~/')
      ? join(home, source.path.slice(2))
      : isAbsolute(source.path)
        ? source.path
        : join(workspace, source.path)
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (error: any) {
      if (isMissing(error)) {
        throw new SkillSourceError('missing', `the directory ${source.path} does not exist`)
      }
      throw error
    }

    return {
      root,
      shown: (file: string) => `${source.path}/${file}`,
      prefix: '/',
      files: entries.map(entry => `${entry}/SKILL.md`),
    }
  }

  let installed: string | undefined
  try {
    installed = await readFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
  } catch (error: any) {
    if (!isMissing(error)) {
      throw error
    }
  }
  const plugins: Record<string, { scope: string; projectPath?: string; installPath: string }[]> =
    installed === undefined ? {} : JSON.parse(installed).plugins
  const install = Object.entries(plugins)
    .filter(([key]) => key.split('@')[0] === source.name)
    .flatMap(([, installs]) => installs)
    .find(({ scope, projectPath }) => scope === 'user' || projectPath === workspace)
  if (install === undefined) {
    throw new SkillSourceError('missing', `the plugin ${source.name} is not installed`)
  }
  const root = join(install.installPath, 'skills')
  let files: string[]
  try {
    files = await readdir(root, { recursive: true })
  } catch (error: any) {
    if (isMissing(error)) {
      throw new SkillSourceError('missing', `the plugin ${source.name} has no skills directory`)
    }
    throw error
  }

  return {
    root,
    shown: (file: string) => tilde(join(root, file)),
    prefix: `/${source.name}:`,
    files: files.filter(file => file === 'SKILL.md' || file.endsWith('/SKILL.md')),
  }
}

// Every skill of the Skill Source with its text, by name: a Skill Source has
// no order of its own, and a plugin's folders are not shown.
const readAll = async (source: SkillSource, workspace: string, home: string) => {
  const { root, shown, prefix, files } = await locate(source, workspace, home)
  const skills: (Skill & { text: string })[] = []
  for (const file of files) {
    let text: string
    try {
      text = await readFile(join(root, file), 'utf8')
    } catch (error: any) {
      if (isMissing(error)) {
        continue
      }
      throw error
    }
    const { fields, body } = parse(text)
    const name = fields.name || file.split('/').at(-2)!
    skills.push({ name, call: `${prefix}${name}`, description: fields.description ?? '', path: shown(file), text: body })
  }

  return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export const listSkills = async (source: SkillSource, workspace: string, home: string): Promise<Skill[]> =>
  (await readAll(source, workspace, home)).map(({ text, ...skill }) => skill)

// One skill with its text: the skill file under its frontmatter, as written.
export const readSkill = async (source: SkillSource, workspace: string, home: string, name: string) => {
  const skill = (await readAll(source, workspace, home)).find(skill => skill.name === name)
  if (skill === undefined) {
    throw new SkillSourceError('unknown-skill', `the Skill Source has no skill named ${name}`)
  }

  return skill
}
