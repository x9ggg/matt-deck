// This repository as a plugin source: what an install copies out of it must
// run as copied, with no `npm install` or build step.
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = join(import.meta.dirname, '..')

test('the marketplace publishes the plugin directory as matt-deck', async () => {
  const marketplace = JSON.parse(await readFile(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'))

  assert.deepEqual(
    marketplace.plugins.map(({ name, source }: { name: string; source: string }) => ({ name, source })),
    [{ name: 'matt-deck', source: './plugin' }],
  )
})

test('the published plugin declares no packages to install', async () => {
  const manifest = JSON.parse(await readFile(join(REPO, 'plugin', 'package.json'), 'utf8'))

  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.scripts, undefined)
})

test('the Deck service answers from a bare copy of the published plugin', async t => {
  // A copy holding only the plugin directory, as an install leaves it: no
  // node_modules beside it or above it.
  const installed = join(await realpath(await mkdtemp(join(tmpdir(), 'deck-install-'))), 'matt-deck')
  await cp(join(REPO, 'plugin'), installed, { recursive: true })
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'deck-')))

  const child = spawn(process.execPath, [join(installed, 'server', 'main.ts')], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  t.after(() => child.kill())
  const reply = new Promise<any>((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', line => resolve(JSON.parse(line)))
    child.on('exit', code => reject(new Error(`Deck service exited (${code})`)))
  })
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deck_config', arguments: {} } })}\n`,
  )

  assert.deepEqual((await reply).result.structuredContent, { configured: false, workspace })
})
