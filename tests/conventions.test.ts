// Rules of this repository that a mistake would break without another test
// noticing.
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = join(import.meta.dirname, '..')

// The repository is public. `.githooks/pre-push` reads the same paths.
test('no tracked file holds a path of the machine it was written on', async () => {
  const found = await promisify(execFile)('git', ['grep', '-nIE', '-f', '.githooks/private-paths', '--', '.'], {
    cwd: REPO,
  }).then(
    ({ stdout }) => stdout,
    // git grep exits 1 when nothing matches.
    (error: any) => {
      if (error.code !== 1) throw error
      return ''
    },
  )

  assert.equal(found, '')
})

// The Mod runs in the Host and the kernel in the Deck service, on Node: all
// the Mod shares with the rest of the plugin is the shape of the answers.
test('the Mod takes only types from outside plugin/hooks', async () => {
  const hooks = join(REPO, 'plugin', 'hooks')

  for (const file of (await readdir(hooks)).filter(name => /\.tsx?$/.test(name))) {
    const imports = (await readFile(join(hooks, file), 'utf8')).match(/^import\s(?:[^'"]*?from\s+)?'\.\.\/[^']*'/gm) ?? []

    assert.deepEqual(imports.filter(statement => !statement.startsWith('import type ')), [], file)
  }
})
