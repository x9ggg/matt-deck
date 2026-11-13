import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The nearest checkout root, including worktrees whose .git is a file.
// Outside a repository, use the starting directory itself.
export const workspaceAt = (cwd: string) => {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dir === dirname(dir)) return cwd
  }
}
