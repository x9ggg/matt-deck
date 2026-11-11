// The Deck service's tool interface, called the way the agent or the Pane
// calls it: a real child process speaking MCP over stdio.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SERVER = join(import.meta.dirname, '..', 'plugin', 'server', 'main.ts')

const startDeck = (cwd: string, env: Record<string, string> = {}) => {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: { ...process.env, ...env },
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

test('deck_config started in a subdirectory reads the config at the repository root', async t => {
  const dir = await workspace(
    JSON.stringify({
      taskSource: { type: 'github-issues' },
      skillSource: { type: 'plugin', name: 'mattpocock-skills' },
    }),
  )
  await mkdir(join(dir, '.git'))
  await mkdir(join(dir, 'packages', 'app'), { recursive: true })
  const deck = startDeck(join(dir, 'packages', 'app'))
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

// A home directory holding no skills, so the machine's own skills stay out
// of the tests.
const home = async () => realpath(await mkdtemp(join(tmpdir(), 'deck-home-')))

const issueTrackerDoc = async (dir: string, heading: string) => {
  await mkdir(join(dir, 'docs', 'agents'), { recursive: true })
  await writeFile(join(dir, 'docs', 'agents', 'issue-tracker.md'), `${heading}\n\nIssues live somewhere.\n`)
}

test('deck_setup_survey prefills the Task Source from the Matt issue tracker doc', async t => {
  const dir = await workspace()
  await issueTrackerDoc(dir, '# Issue tracker: GitHub')
  const deck = startDeck(dir, { HOME: await home() })
  t.after(deck.stop)

  const result = await deck.callTool('deck_setup_survey')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent.taskSource, {
    doc: 'docs/agents/issue-tracker.md',
    tracker: 'GitHub',
    type: 'github-issues',
  })
})

test('deck_setup_survey names a tracker this milestone has no Task Source for', async t => {
  const local = await workspace()
  await issueTrackerDoc(local, '# Issue tracker: Local Markdown')
  const bare = await workspace()
  const withLocal = startDeck(local, { HOME: await home() })
  const withoutDoc = startDeck(bare, { HOME: await home() })
  t.after(withLocal.stop)
  t.after(withoutDoc.stop)

  const a = await withLocal.callTool('deck_setup_survey')
  const b = await withoutDoc.callTool('deck_setup_survey')

  assert.deepEqual(a.structuredContent.taskSource, {
    doc: 'docs/agents/issue-tracker.md',
    tracker: 'Local Markdown',
    type: null,
  })
  assert.equal(b.structuredContent.taskSource, null)
})

test('deck_setup_survey tells a doc whose tracker it cannot read from no doc at all', async t => {
  const dir = await workspace()
  await issueTrackerDoc(dir, '# Issue tracker')
  const deck = startDeck(dir, { HOME: await home() })
  t.after(deck.stop)

  const result = await deck.callTool('deck_setup_survey')

  assert.deepEqual(result.structuredContent.taskSource, {
    doc: 'docs/agents/issue-tracker.md',
    tracker: null,
    type: null,
  })
})

test('deck_setup_survey shows the existing config of a Configured Project', async t => {
  const config = {
    taskSource: { type: 'github-issues' },
    skillSource: { type: 'plugin', name: 'mattpocock-skills' },
  }
  const configured = startDeck(await workspace(JSON.stringify(config)), { HOME: await home() })
  const malformed = startDeck(await workspace('{ not json'), { HOME: await home() })
  const unconfigured = startDeck(await workspace(), { HOME: await home() })
  t.after(configured.stop)
  t.after(malformed.stop)
  t.after(unconfigured.stop)

  const [a, b, c] = await Promise.all(
    [configured, malformed, unconfigured].map(deck => deck.callTool('deck_setup_survey')),
  )

  assert.deepEqual(a.structuredContent.existing, { configured: true, config })
  assert.equal(b.structuredContent.existing.configured, true)
  assert.match(b.structuredContent.existing.problem, /\.matt-deck\/config\.json is not valid JSON/)
  assert.deepEqual(c.structuredContent.existing, { configured: false })
})

const skill = async (dir: string, name: string) => {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
}

const installedPlugins = async (home: string, plugins: Record<string, object[]>) => {
  await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
  await writeFile(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }),
  )
}

test('deck_setup_survey finds the copies of Matt skills on this machine', async t => {
  const dir = await workspace()
  const user = await home()
  // One copy in ~/.agents/skills, linked into ~/.claude/skills.
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  await mkdir(join(user, '.claude', 'skills'), { recursive: true })
  await symlink(join(user, '.agents', 'skills', 'ask-matt'), join(user, '.claude', 'skills', 'ask-matt'))
  // Another copy in a plugin, beside plugins that hold no Matt skills or
  // belong to another project.
  const matt = join(user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skill(join(matt, 'skills', 'engineering'), 'ask-matt')
  const other = join(user, '.claude', 'plugins', 'cache', 'official', 'swift-lsp', '1.0.0')
  await skill(join(other, 'skills'), 'swift')
  const elsewhere = join(user, '.claude', 'plugins', 'cache', 'acme', 'acme-skills', '2.0.0')
  await skill(join(elsewhere, 'skills'), 'ask-matt')
  await installedPlugins(user, {
    'mattpocock-skills@official': [{ scope: 'user', installPath: matt }],
    'swift-lsp@official': [{ scope: 'user', installPath: other }],
    'acme-skills@acme': [{ scope: 'project', projectPath: '/somewhere/else', installPath: elsewhere }],
  })
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_setup_survey')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent.skillSources, [
    { type: 'directory', path: '~/.claude/skills' },
    { type: 'plugin', name: 'mattpocock-skills' },
  ])
})

test('deck_setup_survey finds no Matt skills on a machine without them', async t => {
  const deck = startDeck(await workspace(), { HOME: await home() })
  t.after(deck.stop)

  const result = await deck.callTool('deck_setup_survey')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent.skillSources, [])
})

const CONFIG = {
  taskSource: { type: 'github-issues' },
  skillSource: { type: 'directory', path: '~/.claude/skills' },
}

test('deck_write_config makes the workspace a Configured Project', async t => {
  const dir = await workspace()
  const deck = startDeck(dir)
  t.after(deck.stop)

  const written = await deck.callTool('deck_write_config', { config: CONFIG })
  const read = await deck.callTool('deck_config')

  assert.equal(written.isError, false)
  assert.deepEqual(read.structuredContent, { configured: true, workspace: dir, config: CONFIG })
})

test('deck_write_config replaces an existing config only when told to', async t => {
  const old = { taskSource: { type: 'github-issues' }, skillSource: { type: 'plugin', name: 'mattpocock-skills' } }
  const dir = await workspace(JSON.stringify(old))
  const deck = startDeck(dir)
  t.after(deck.stop)

  const refused = await deck.callTool('deck_write_config', { config: CONFIG })
  const kept = await deck.callTool('deck_config')
  const replaced = await deck.callTool('deck_write_config', { config: CONFIG, replace: true })
  const now = await deck.callTool('deck_config')

  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /already exists/)
  assert.deepEqual(kept.structuredContent.config, old)
  assert.equal(replaced.isError, false)
  assert.deepEqual(now.structuredContent.config, CONFIG)
})

test('deck_write_config writes nothing when the config is malformed', async t => {
  const dir = await workspace()
  const deck = startDeck(dir)
  t.after(deck.stop)

  const malformed = [
    {},
    { config: { ...CONFIG, taskSource: { type: 'local-markdown' } } },
    { config: { taskSource: CONFIG.taskSource } },
    { config: CONFIG, workspace: await workspace() },
  ]
  for (const args of malformed) {
    const result = await deck.callTool('deck_write_config', args)
    assert.equal(result.isError, true, JSON.stringify(args))
  }
  const read = await deck.callTool('deck_config')

  assert.deepEqual(read.structuredContent, { configured: false, workspace: dir })
})
