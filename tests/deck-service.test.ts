// The Deck service's tool interface, called the way the agent or the Pane
// calls it: a real child process speaking MCP over stdio.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SERVER = join(import.meta.dirname, '..', 'plugin', 'server', 'main.ts')

const startDeck = (cwd: string) => {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map<number, (message: any) => void>()
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  })
  const exited = new Promise<never>((_, reject) =>
    child.on('exit', code => reject(new Error(`Deck service exited (${code})`))),
  )
  exited.catch(() => undefined)
  let nextId = 1
  const request = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, resolve)
      exited.catch(reject)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  return {
    request,
    callTool: (name: string, args: object = {}) =>
      request('tools/call', { name, arguments: args }).then(reply => reply.result),
    stop: () => child.kill(),
  }
}

const workspace = async (config?: string) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'deck-')))
  if (config !== undefined) {
    await mkdir(join(dir, '.matt-deck'))
    await writeFile(join(dir, '.matt-deck', 'config.json'), config)
  }

  return dir
}

test('deck_config returns the project config of a Configured Project', async t => {
  const dir = await workspace(
    JSON.stringify({
      taskSource: { type: 'github-issues' },
      skillSource: { type: 'plugin', name: 'mattpocock-skills' },
    }),
  )
  const deck = startDeck(dir)
  t.after(deck.stop)

  const result = await deck.callTool('deck_config')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    configured: true,
    workspace: dir,
    config: {
      taskSource: { type: 'github-issues' },
      skillSource: { type: 'plugin', name: 'mattpocock-skills' },
    },
  })
})

test('deck_config says not configured when the workspace has no config', async t => {
  const dir = await workspace()
  const deck = startDeck(dir)
  t.after(deck.stop)

  const result = await deck.callTool('deck_config')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { configured: false, workspace: dir })
})

test('deck_config reports an error when the config is malformed', async t => {
  const malformed = [
    '{ not json',
    '[]',
    JSON.stringify({ skillSource: { type: 'plugin', name: 'mattpocock-skills' } }),
    JSON.stringify({
      taskSource: { type: 'jira' },
      skillSource: { type: 'plugin', name: 'mattpocock-skills' },
    }),
    JSON.stringify({ taskSource: { type: 'github-issues' } }),
    JSON.stringify({
      taskSource: { type: 'github-issues' },
      skillSource: { type: 'directory' },
    }),
    JSON.stringify({
      taskSource: { type: 'github-issues' },
      skillSource: { type: 'plugin', name: '' },
    }),
  ]

  for (const config of malformed) {
    const deck = startDeck(await workspace(config))
    t.after(deck.stop)

    const result = await deck.callTool('deck_config')

    assert.equal(result.isError, true, config)
    assert.match(result.content[0].text, /\.matt-deck\/config\.json/, config)
  }
})

test('deck_config refuses a path passed as an argument and keeps its own workspace', async t => {
  const elsewhere = await workspace(
    JSON.stringify({
      taskSource: { type: 'github-issues' },
      skillSource: { type: 'plugin', name: 'mattpocock-skills' },
    }),
  )
  const dir = await workspace()
  const deck = startDeck(dir)
  t.after(deck.stop)

  const refused = await deck.callTool('deck_config', { workspace: elsewhere })
  const own = await deck.callTool('deck_config')

  assert.equal(refused.isError, true)
  assert.deepEqual(own.structuredContent, { configured: false, workspace: dir })
})
