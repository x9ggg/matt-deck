// The Deck service's tool interface, called the way the agent or the Pane
// calls it: a real child process speaking MCP over stdio.
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SERVER = join(import.meta.dirname, '..', 'plugin', 'server', 'main.ts')
const FAKE_CLOCK = join(import.meta.dirname, 'fake-clock.ts')
const CLI = join(import.meta.dirname, '..', 'plugin', 'cli', 'main.ts')
const END_SESSION = join(import.meta.dirname, '..', 'plugin', 'cli', 'end-session.ts')
const exec = promisify(execFile)

// Unless a test gives it a HOME of its own, each Deck service keeps its local
// state in a temporary home, never the user's. Unless a test names another,
// its host is Claude Code, as the plugin starts it.
const startDeck = (cwd: string, env: Record<string, string> = {}, host = 'claude-code') => {
  const child = spawn(process.execPath, ['--import', FAKE_CLOCK, SERVER, '--host', host], {
    cwd,
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'deck-home-')), ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map<number, (message: any) => void>()
  // Messages are split at newlines only, as the stdio transport writes them:
  // a description may hold a Unicode line separator, which readline would
  // also split at.
  let unread = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (unread + chunk).split('\n')
    unread = lines.pop()!
    for (const line of lines.filter(line => line !== '')) {
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
  })
  const exited = new Promise<never>((_, reject) =>
    child.on('exit', (code, signal) => reject(new Error(`Deck service exited (${code}${signal ? `, ${signal}` : ''})`))),
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
    // Ends the Deck service by SIGKILL, so one stuck in synchronous code,
    // where its SIGTERM handler never gets a turn, does not outlive its test.
    stop: () => child.kill('SIGKILL'),
    // The CPU time the Deck service's own process has spent so far, in
    // milliseconds, as ps reads it to a hundredth of a second. A test times
    // the service by this rather than by the clock on the wall, which also
    // counts the turns a busy machine gives to other processes.
    cpuMs: async () => {
      const { stdout } = await exec('ps', ['-o', 'time=', '-p', String(child.pid)])
      return Math.round(stdout.trim().split(':').reduce((ms, part) => ms * 60 + Number(part) * 1000, 0))
    },
    // Closes the Deck service's input; answers the code it exited with.
    close: () =>
      new Promise<number | null>(resolve => {
        child.once('exit', code => resolve(code))
        child.stdin.end()
      }),
    // Ends the Deck service as the host does, by SIGTERM, or with no chance
    // to record anything, by SIGKILL; answers the signal it exited by.
    end: (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') =>
      new Promise<NodeJS.Signals | null>(resolve => {
        child.once('exit', (_code, exitedBy) => resolve(exitedBy))
        child.kill(signal)
      }),
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

// A skill file Codex loads: named, with a description.
const skill = async (dir: string, name: string) => {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的说明。\n---\n`)
}

// A skill file in a folder named `folder` under `dir`, as written.
const rawSkill = async (dir: string, folder: string, text: string) => {
  await mkdir(join(dir, folder), { recursive: true })
  await writeFile(join(dir, folder, 'SKILL.md'), text)
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

test('started for Codex, deck_setup_survey also finds the copies of Matt skills in the Workspace\'s Codex skill directories', async t => {
  const dir = await workspace()
  const user = await home()
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  await skill(join(dir, '.agents', 'skills'), 'ask-matt')
  await skill(join(dir, '.codex', 'skills'), 'ask-matt')
  const codex = startDeck(dir, { HOME: user }, 'codex')
  const claudeCode = startDeck(dir, { HOME: user })
  t.after(codex.stop)
  t.after(claudeCode.stop)

  const [forCodex, forClaudeCode] = await Promise.all([codex, claudeCode].map(deck => deck.callTool('deck_setup_survey')))

  assert.equal(forCodex.isError, false)
  // Three files named ask-matt: $ask-matt in Codex calls none of them.
  assert.deepEqual(forCodex.structuredContent.skillSources, [
    { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: false, hostCallsImplement: false },
    { type: 'directory', path: '.agents/skills', hostCallsAskMatt: false, hostCallsImplement: false },
    { type: 'directory', path: '.codex/skills', hostCallsAskMatt: false, hostCallsImplement: false },
  ])
  assert.deepEqual(forClaudeCode.structuredContent.skillSources, [{ type: 'directory', path: '~/.agents/skills' }])
})

test('started for Codex, deck_setup_survey finds the copy of Matt skills only in the user\'s ~/.codex/skills', async t => {
  const dir = await workspace()
  const user = await home()
  await skill(join(user, '.codex', 'skills'), 'ask-matt')
  const codex = startDeck(dir, { HOME: user }, 'codex')
  const claudeCode = startDeck(dir, { HOME: user })
  t.after(codex.stop)
  t.after(claudeCode.stop)

  const [forCodex, forClaudeCode] = await Promise.all([codex, claudeCode].map(deck => deck.callTool('deck_setup_survey')))

  assert.deepEqual(forCodex.structuredContent.skillSources, [
    { type: 'directory', path: '~/.codex/skills', hostCallsAskMatt: true, hostCallsImplement: false },
  ])
  assert.deepEqual(forClaudeCode.structuredContent.skillSources, [])
})

test('started for Codex, deck_setup_survey says of each copy of Matt skills whether $ask-matt in Codex calls its ask-matt, one linked from Codex\'s skill directory among them', async t => {
  const dir = await workspace()
  const user = await home()
  // The skills installer's layout: ~/.claude/skills links the copy in
  // ~/.agents/skills, and the copy is named after the first.
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  await mkdir(join(user, '.claude', 'skills'), { recursive: true })
  await symlink(join(user, '.agents', 'skills', 'ask-matt'), join(user, '.claude', 'skills', 'ask-matt'))
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_setup_survey')

  assert.deepEqual(result.structuredContent.skillSources, [
    { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: false },
  ])
})

test('started for Codex, deck_setup_survey says of the existing Skill Source too whether $ask-matt in Codex calls its ask-matt, offered under another name or not', async t => {
  const configured = async (skillSource: object) => {
    const user = await home()
    const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource }))

    return { dir, user }
  }
  // A plugin, whose ask-matt the user's Codex skills link: offered as
  // ~/.agents/skills.
  const plugin = await configured({ type: 'plugin', name: 'mattpocock-skills' })
  const matt = join(plugin.user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skill(join(matt, 'skills', 'engineering'), 'ask-matt')
  await installedPlugins(plugin.user, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  await mkdir(join(plugin.user, '.agents', 'skills'), { recursive: true })
  await symlink(join(matt, 'skills', 'engineering', 'ask-matt'), join(plugin.user, '.agents', 'skills', 'ask-matt'))
  // ~/.agents/skills, which ~/.claude/skills links: offered as
  // ~/.claude/skills.
  const agents = await configured({ type: 'directory', path: '~/.agents/skills' })
  await skill(join(agents.user, '.agents', 'skills'), 'ask-matt')
  await mkdir(join(agents.user, '.claude', 'skills'), { recursive: true })
  await symlink(join(agents.user, '.agents', 'skills', 'ask-matt'), join(agents.user, '.claude', 'skills', 'ask-matt'))
  // A directory of the user's own, which the user's Codex skills link.
  const own = await configured({ type: 'directory', path: '~/my-skills' })
  await skill(join(own.user, 'my-skills'), 'ask-matt')
  await mkdir(join(own.user, '.agents', 'skills'), { recursive: true })
  await symlink(join(own.user, 'my-skills', 'ask-matt'), join(own.user, '.agents', 'skills', 'ask-matt'))
  // ~/.claude/skills, apart from the copy Codex calls.
  const apart = await configured({ type: 'directory', path: '~/.claude/skills' })
  await skill(join(apart.user, '.claude', 'skills'), 'ask-matt')
  await skill(join(apart.user, '.agents', 'skills'), 'ask-matt')
  const decks = [plugin, agents, own, apart].map(({ dir, user }) => startDeck(dir, { HOME: user }, 'codex'))
  const claudeCode = startDeck(plugin.dir, { HOME: plugin.user })
  for (const deck of [...decks, claudeCode]) {
    t.after(deck.stop)
  }

  const results = await Promise.all(decks.map(deck => deck.callTool('deck_setup_survey')))
  const forClaudeCode = await claudeCode.callTool('deck_setup_survey')

  assert.deepEqual(
    results.map(result => result.structuredContent.existing.hostCallsAskMatt),
    [true, true, true, false],
  )
  assert.equal('hostCallsAskMatt' in forClaudeCode.structuredContent.existing, false)
  assert.equal('hostCallsImplement' in forClaudeCode.structuredContent.existing, false)
})

test('started for Codex, deck_setup_survey says $ask-matt in Codex calls no ask-matt whose file has no description, offered or existing', async t => {
  const user = await home()
  const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: '~/.agents/skills' } }))
  await rawSkill(join(user, '.agents', 'skills'), 'ask-matt', '---\nname: ask-matt\n---\n')
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_setup_survey')

  assert.deepEqual(result.structuredContent.skillSources, [{ type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: false, hostCallsImplement: false }])
  assert.equal(result.structuredContent.existing.hostCallsAskMatt, false)
})

test('started for Codex, deck_setup_survey says $ask-matt in Codex calls an ask-matt whose description is written on the lines below its key, offered or existing', async t => {
  for (const below of ['  "Ask what to do next."\n', '\n  Ask what to do next.\n', '   \n  Ask what to do next.\n']) {
    const user = await home()
    const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: '~/.agents/skills' } }))
    await rawSkill(join(user, '.agents', 'skills'), 'ask-matt', `---\nname: ask-matt\ndescription:\n${below}---\n`)
    const codex = startDeck(dir, { HOME: user }, 'codex')
    t.after(codex.stop)

    const result = await codex.callTool('deck_setup_survey')

    assert.deepEqual(result.structuredContent.skillSources, [{ type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: false }], below)
    assert.equal(result.structuredContent.existing.hostCallsAskMatt, true, below)
  }
})

test('started for Codex, deck_setup_survey says $ask-matt calls no ask-matt whose file holds invalid UTF-8 bytes while other skills in the same directory still scan', async t => {
  const user = await home()
  const dir = await workspace(
    JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: '~/.agents/skills' } }),
  )
  const source = join(user, '.agents', 'skills')
  await mkdir(join(source, 'ask-matt'), { recursive: true })
  await writeFile(
    join(source, 'ask-matt', 'SKILL.md'),
    Buffer.concat([Buffer.from('---\nname: ask-matt\ndescription: Ask what to do next.\n---\n\nBody '), Buffer.from([0xff])]),
  )
  await skill(source, 'tdd')
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const surveyed = await codex.callTool('deck_setup_survey')
  const listed = await codex.callTool('deck_skills')

  assert.deepEqual(surveyed.structuredContent.skillSources, [{ type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: false, hostCallsImplement: false }])
  assert.equal(surveyed.structuredContent.existing.hostCallsAskMatt, false)
  assert.deepEqual(copies(listed), [
    ['ask-matt', 'missing'],
    ['tdd', 'same'],
  ])
})

test('started for Codex, deck_setup_survey offers first the copy of Matt skills whose ask-matt $ask-matt in Codex calls, the others after it in their order', async t => {
  const dir = await workspace()
  const user = await home()
  // Two copies apart, and a Claude Code plugin holding a third.
  await skill(join(user, '.claude', 'skills'), 'ask-matt')
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  const matt = join(user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skill(join(matt, 'skills', 'engineering'), 'ask-matt')
  await installedPlugins(user, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  const codex = startDeck(dir, { HOME: user }, 'codex')
  const claudeCode = startDeck(dir, { HOME: user })
  t.after(codex.stop)
  t.after(claudeCode.stop)

  const [forCodex, forClaudeCode] = await Promise.all([codex, claudeCode].map(deck => deck.callTool('deck_setup_survey')))

  assert.deepEqual(forCodex.structuredContent.skillSources, [
    { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: false },
    { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: false, hostCallsImplement: false },
    { type: 'plugin', name: 'mattpocock-skills', hostCallsAskMatt: false, hostCallsImplement: false },
  ])
  // Claude Code's survey is as it was: no mark, in the order found.
  assert.deepEqual(forClaudeCode.structuredContent.skillSources, [
    { type: 'directory', path: '~/.claude/skills' },
    { type: 'directory', path: '~/.agents/skills' },
    { type: 'plugin', name: 'mattpocock-skills' },
  ])
})

test('started for Codex, deck_setup_survey says of each copy of Matt skills and of the existing Skill Source whether Codex calls its ask-matt and its implement, offering first a copy whose both it calls', async t => {
  // The existing ~/.claude/skills links only ask-matt from ~/.agents/skills,
  // which holds implement too.
  const user = await home()
  const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: '~/.claude/skills' } }))
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  await skill(join(user, '.agents', 'skills'), 'implement')
  await mkdir(join(user, '.claude', 'skills'), { recursive: true })
  await symlink(join(user, '.agents', 'skills', 'ask-matt'), join(user, '.claude', 'skills', 'ask-matt'))
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_setup_survey')

  assert.deepEqual(result.structuredContent.skillSources, [
    { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: true },
    { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: false },
  ])
  assert.deepEqual(
    [result.structuredContent.existing.hostCallsAskMatt, result.structuredContent.existing.hostCallsImplement],
    [true, false],
  )
})

test('started for Codex, deck_setup_survey offers once a copy whose ask-matt and implement both link another, and twice copies sharing ask-matt with implement files apart, judging each by the copy Codex calls', async t => {
  const linked = await home()
  for (const name of ['ask-matt', 'implement']) {
    await skill(join(linked, '.agents', 'skills'), name)
    await mkdir(join(linked, '.claude', 'skills'), { recursive: true })
    await symlink(join(linked, '.agents', 'skills', name), join(linked, '.claude', 'skills', name))
  }
  const apart = await home()
  await skill(join(apart, '.agents', 'skills'), 'ask-matt')
  await skill(join(apart, '.agents', 'skills'), 'implement')
  await mkdir(join(apart, '.claude', 'skills'), { recursive: true })
  await symlink(join(apart, '.agents', 'skills', 'ask-matt'), join(apart, '.claude', 'skills', 'ask-matt'))
  await skill(join(apart, '.claude', 'skills'), 'implement')
  const decks = [linked, apart].map(async user => startDeck(await workspace(), { HOME: user }, 'codex'))
  const [forLinked, forApart] = await Promise.all(decks)
  const claudeCode = startDeck(await workspace(), { HOME: apart })
  t.after(forLinked.stop)
  t.after(forApart.stop)
  t.after(claudeCode.stop)

  const results = await Promise.all([forLinked, forApart].map(deck => deck.callTool('deck_setup_survey')))
  const forClaudeCode = await claudeCode.callTool('deck_setup_survey')

  assert.deepEqual(results.map(result => result.structuredContent.skillSources), [
    [{ type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: true }],
    [
      { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: true },
      { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: false },
    ],
  ])
  // Claude Code's survey is as it was: one copy per ask-matt, no mark.
  assert.deepEqual(forClaudeCode.structuredContent.skillSources, [{ type: 'directory', path: '~/.claude/skills' }])
})

test('started for Codex, deck_setup_survey keeps apart copies sharing ask-matt and their first implement where only one holds a second implement, the one Codex calls; and offers once copies whose every ask-matt and implement link the same files', async t => {
  // A plugin holds ask-matt and an implement; ~/.claude/skills links both and
  // a second implement, which ~/.agents/skills, where Codex looks, links too.
  const apart = await home()
  const matt = join(apart, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skill(join(matt, 'skills'), 'ask-matt')
  await skill(join(matt, 'skills'), 'implement')
  await rawSkill(join(apart, 'other'), 'implement-again', '---\nname: implement\ndescription: Start a Task again.\n---\n')
  await installedPlugins(apart, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  await mkdir(join(apart, '.claude', 'skills'), { recursive: true })
  await symlink(join(matt, 'skills', 'ask-matt'), join(apart, '.claude', 'skills', 'ask-matt'))
  await symlink(join(matt, 'skills', 'implement'), join(apart, '.claude', 'skills', 'implement'))
  await symlink(join(apart, 'other', 'implement-again'), join(apart, '.claude', 'skills', 'implement-again'))
  await mkdir(join(apart, '.agents', 'skills'), { recursive: true })
  await symlink(join(matt, 'skills', 'ask-matt'), join(apart, '.agents', 'skills', 'ask-matt'))
  await symlink(join(apart, 'other', 'implement-again'), join(apart, '.agents', 'skills', 'implement'))
  // The same, but the plugin holds the second implement too, which
  // ~/.claude/skills links as well.
  const linked = await home()
  const its = join(linked, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skill(join(its, 'skills'), 'ask-matt')
  await skill(join(its, 'skills'), 'implement')
  await rawSkill(join(its, 'skills'), 'implement-again', '---\nname: implement\ndescription: Start a Task again.\n---\n')
  await installedPlugins(linked, { 'mattpocock-skills@official': [{ scope: 'user', installPath: its }] })
  await mkdir(join(linked, '.claude', 'skills'), { recursive: true })
  for (const folder of ['ask-matt', 'implement', 'implement-again']) {
    await symlink(join(its, 'skills', folder), join(linked, '.claude', 'skills', folder))
  }
  await mkdir(join(linked, '.agents', 'skills'), { recursive: true })
  await symlink(join(its, 'skills', 'ask-matt'), join(linked, '.agents', 'skills', 'ask-matt'))
  await symlink(join(its, 'skills', 'implement-again'), join(linked, '.agents', 'skills', 'implement'))
  const decks = await Promise.all([apart, linked].map(async user => startDeck(await workspace(), { HOME: user }, 'codex')))
  for (const deck of decks) {
    t.after(deck.stop)
  }

  const results = await Promise.all(decks.map(deck => deck.callTool('deck_setup_survey')))

  assert.deepEqual(results.map(result => result.structuredContent.skillSources), [
    [
      { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: true },
      { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: true },
      { type: 'plugin', name: 'mattpocock-skills', hostCallsAskMatt: true, hostCallsImplement: false },
    ],
    [
      { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: true },
      { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: true },
    ],
  ])
})

test('started for Codex, deck_setup_survey keeps apart copies sharing their ask-matt folder\'s file and their implement where only one holds a second ask-matt, the one Codex calls', async t => {
  // A plugin holds ask-matt and implement; ~/.claude/skills links both and
  // a second ask-matt, which ~/.agents/skills, where Codex looks, links as
  // ask-matt, beside the implement.
  const user = await home()
  const matt = join(user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skill(join(matt, 'skills'), 'ask-matt')
  await skill(join(matt, 'skills'), 'implement')
  await rawSkill(join(user, 'other'), 'ask-matt-again', '---\nname: ask-matt\ndescription: Ask again.\n---\n')
  await installedPlugins(user, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  await mkdir(join(user, '.claude', 'skills'), { recursive: true })
  await symlink(join(matt, 'skills', 'ask-matt'), join(user, '.claude', 'skills', 'ask-matt'))
  await symlink(join(matt, 'skills', 'implement'), join(user, '.claude', 'skills', 'implement'))
  await symlink(join(user, 'other', 'ask-matt-again'), join(user, '.claude', 'skills', 'ask-matt-again'))
  await mkdir(join(user, '.agents', 'skills'), { recursive: true })
  await symlink(join(user, 'other', 'ask-matt-again'), join(user, '.agents', 'skills', 'ask-matt'))
  await symlink(join(matt, 'skills', 'implement'), join(user, '.agents', 'skills', 'implement'))
  const codex = startDeck(await workspace(), { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_setup_survey')

  assert.deepEqual(result.structuredContent.skillSources, [
    { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: true },
    { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: true },
    { type: 'plugin', name: 'mattpocock-skills', hostCallsAskMatt: false, hostCallsImplement: true },
  ])
})

test('started for Codex, in one home a Skill Source holding two implements and two ask-matts is called by Codex, by deck_setup_survey and by deck_skills alike, where Codex links only the second of each, and not where it links both', async t => {
  const user = await home()
  const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: '~/my-skills' } }))
  const source = join(user, 'my-skills')
  for (const name of ['ask-matt', 'implement']) {
    await skill(source, name)
    await rawSkill(source, `${name}-again`, `---\nname: ${name}\ndescription: ${name} again.\n---\n`)
  }
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)
  const host = join(user, '.agents', 'skills')
  await mkdir(host, { recursive: true })
  const read = async () => {
    const [surveyed, listed] = [await deck.callTool('deck_setup_survey'), await deck.callTool('deck_skills')]
    return [surveyed.structuredContent.existing.hostCallsAskMatt, surveyed.structuredContent.existing.hostCallsImplement, copies(listed)]
  }

  for (const name of ['ask-matt', 'implement']) {
    await symlink(join(source, `${name}-again`), join(host, `${name}-again`))
  }
  const second = await read()
  for (const name of ['ask-matt', 'implement']) {
    await symlink(join(source, name), join(host, name))
  }
  const both = await read()

  const listing = (first: string, again: string) => [['ask-matt', first], ['ask-matt', again], ['implement', first], ['implement', again]]
  assert.deepEqual(second, [true, true, listing('different', 'same')])
  assert.deepEqual(both, [false, false, listing('several', 'several')])
})

test('started for Codex, deck_setup_survey says whether Codex calls ask-matt and implement as deck_skills says of the same Skill Source, for one missing a skill, one beside another file of the name, one not offered and one not there', async t => {
  const configured = async (path: string) => {
    const user = await home()
    const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path } }))

    return { dir, user }
  }
  // ask-matt alone.
  const missing = await configured('~/.agents/skills')
  await skill(join(missing.user, '.agents', 'skills'), 'ask-matt')
  // implement beside another implement file in ~/.codex/skills.
  const beside = await configured('~/.agents/skills')
  await skill(join(beside.user, '.agents', 'skills'), 'ask-matt')
  await skill(join(beside.user, '.agents', 'skills'), 'implement')
  await skillFile(join(beside.user, '.codex', 'skills'), 'implement', 'Another implement.')
  // implement alone, which Codex's skills link: no copy of Matt skills.
  const notOffered = await configured('~/my-skills')
  await skill(join(notOffered.user, 'my-skills'), 'implement')
  await mkdir(join(notOffered.user, '.agents', 'skills'), { recursive: true })
  await symlink(join(notOffered.user, 'my-skills', 'implement'), join(notOffered.user, '.agents', 'skills', 'implement'))
  // A directory that is not there.
  const gone = await configured('~/gone')
  const cases = [missing, beside, notOffered, gone]
  const decks = cases.map(({ dir, user }) => startDeck(dir, { HOME: user }, 'codex'))
  for (const deck of decks) {
    t.after(deck.stop)
  }

  const surveyed = await Promise.all(decks.map(deck => deck.callTool('deck_setup_survey')))
  const listed = await Promise.all(decks.map(deck => deck.callTool('deck_skills')))

  assert.deepEqual(
    surveyed.map(result => [result.isError, result.structuredContent.existing.hostCallsAskMatt, result.structuredContent.existing.hostCallsImplement]),
    [
      [false, true, false],
      [false, true, false],
      [false, false, true],
      [false, false, false],
    ],
  )
  assert.deepEqual(surveyed.map(result => result.structuredContent.skillSources), [
    [{ type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: false }],
    [{ type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: false }],
    [],
    [],
  ])
  const same = (result: any, name: string) => result.structuredContent.skills?.some((skill: any) => skill.name === name && skill.copy === 'same') ?? false
  assert.deepEqual(
    listed.map(result => [same(result, 'ask-matt'), same(result, 'implement')]),
    surveyed.map(result => [result.structuredContent.existing.hostCallsAskMatt, result.structuredContent.existing.hostCallsImplement]),
  )
})

test('started for Codex, deck_setup_survey knows an implement by the name its file gives, as deck_skills does, keeping apart copies that share ask-matt with an implement in another folder', async t => {
  const user = await home()
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  await rawSkill(join(user, '.agents', 'skills'), 'impl2', '---\nname: implement\ndescription: Start a Task.\n---\n')
  await mkdir(join(user, '.claude', 'skills'), { recursive: true })
  await symlink(join(user, '.agents', 'skills', 'ask-matt'), join(user, '.claude', 'skills', 'ask-matt'))
  const codex = startDeck(await workspace(), { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_setup_survey')

  assert.deepEqual(result.structuredContent.skillSources, [
    { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: true, hostCallsImplement: true },
    { type: 'directory', path: '~/.claude/skills', hostCallsAskMatt: true, hostCallsImplement: false },
  ])
})

test('deck_setup_survey still answers for a copy of Matt skills holding a skill file it cannot read or a link to an implement that is gone, on either host', { skip: process.getuid?.() === 0 }, async t => {
  const user = await home()
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  await skill(join(user, '.agents', 'skills'), 'implement')
  await skill(join(user, '.agents', 'skills'), 'locked')
  await chmod(join(user, '.agents', 'skills', 'locked', 'SKILL.md'), 0)
  t.after(() => chmod(join(user, '.agents', 'skills', 'locked', 'SKILL.md'), 0o644))
  const matt = join(user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skill(join(matt, 'skills'), 'ask-matt')
  await mkdir(join(matt, 'skills', 'implement'), { recursive: true })
  await symlink(join(user, 'gone', 'SKILL.md'), join(matt, 'skills', 'implement', 'SKILL.md'))
  await installedPlugins(user, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  const dir = await workspace()
  const codex = startDeck(dir, { HOME: user }, 'codex')
  const claudeCode = startDeck(dir, { HOME: user })
  t.after(codex.stop)
  t.after(claudeCode.stop)

  const [forCodex, forClaudeCode] = await Promise.all([codex, claudeCode].map(deck => deck.callTool('deck_setup_survey')))

  // Neither copy can be listed whole, as deck_skills cannot list it.
  assert.deepEqual(forCodex.structuredContent.skillSources, [
    { type: 'directory', path: '~/.agents/skills', hostCallsAskMatt: false, hostCallsImplement: false },
    { type: 'plugin', name: 'mattpocock-skills', hostCallsAskMatt: false, hostCallsImplement: false },
  ])
  assert.deepEqual(forClaudeCode.structuredContent.skillSources, [
    { type: 'directory', path: '~/.agents/skills' },
    { type: 'plugin', name: 'mattpocock-skills' },
  ])
})

test('started for Codex, the configure skill has no permission rule to write: the survey names the host and asks no settings, and deck_allow_service is not offered', async t => {
  const dir = await workspace()
  const codex = startDeck(dir, { HOME: await home() }, 'codex')
  const claudeCode = startDeck(dir, { HOME: await home() })
  t.after(codex.stop)
  t.after(claudeCode.stop)

  const surveyed = await codex.callTool('deck_setup_survey')
  const { result: listed } = await codex.request('tools/list')
  const refused = await codex.request('tools/call', { name: 'deck_allow_service', arguments: {} })
  const forClaudeCode = await claudeCode.callTool('deck_setup_survey')

  assert.equal(surveyed.structuredContent.host, 'codex')
  assert.equal('isServiceAllowed' in surveyed.structuredContent, false)
  assert.equal(listed.tools.some((tool: any) => tool.name === 'deck_allow_service'), false)
  assert.equal(refused.error.code, -32602)
  assert.deepEqual(await readdir(dir), [])
  assert.equal(forClaudeCode.structuredContent.host, 'claude-code')
  assert.equal(forClaudeCode.structuredContent.isServiceAllowed, false)
})

test('a project configured from Claude Code is a Configured Project for Codex, its skills called as Codex writes them', async t => {
  const dir = await workspace()
  const user = await home()
  await skill(join(user, '.agents', 'skills'), 'ask-matt')
  const claudeCode = startDeck(dir, { HOME: user })
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(claudeCode.stop)
  t.after(codex.stop)
  const config = { taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: '~/.agents/skills' } }

  await claudeCode.callTool('deck_write_config', { config })
  const read = await codex.callTool('deck_config')
  const skills = await codex.callTool('deck_skills')

  assert.deepEqual(read.structuredContent, { configured: true, workspace: dir, config })
  assert.deepEqual(
    skills.structuredContent.skills.map(({ call }: any) => call),
    ['$ask-matt'],
  )
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

test('deck_write_config writes of each source only its type and its path or name, leaving out what a survey added', async t => {
  const dir = await workspace()
  const plugin = await workspace()
  const deck = startDeck(dir, {}, 'codex')
  const forPlugin = startDeck(plugin, {}, 'codex')
  t.after(deck.stop)
  t.after(forPlugin.stop)

  await deck.callTool('deck_write_config', {
    config: { ...CONFIG, skillSource: { ...CONFIG.skillSource, hostCallsAskMatt: true, hostCallsImplement: true } },
  })
  await forPlugin.callTool('deck_write_config', {
    config: {
      taskSource: { type: 'github-issues', tracker: 'GitHub' },
      skillSource: { type: 'plugin', name: 'mattpocock-skills', path: '~/.claude/skills', hostCallsAskMatt: false, hostCallsImplement: true },
    },
  })

  assert.deepEqual(JSON.parse(await readFile(join(dir, '.matt-deck', 'config.json'), 'utf8')), CONFIG)
  assert.deepEqual(JSON.parse(await readFile(join(plugin, '.matt-deck', 'config.json'), 'utf8')), {
    taskSource: { type: 'github-issues' },
    skillSource: { type: 'plugin', name: 'mattpocock-skills' },
  })
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

const ALLOW_RULE = 'mcp__plugin_matt-deck_deck'

test('deck_allow_service adds the rule allowing the Deck service to the project\'s local settings, once', async t => {
  const dir = await workspace()
  const deck = startDeck(dir, { HOME: await home() })
  t.after(deck.stop)
  const settings = () => readFile(join(dir, '.claude', 'settings.local.json'), 'utf8')

  const before = await deck.callTool('deck_setup_survey')
  const added = await deck.callTool('deck_allow_service')
  const written = await settings()
  const again = await deck.callTool('deck_allow_service')
  const after = await deck.callTool('deck_setup_survey')

  assert.equal(before.structuredContent.isServiceAllowed, false)
  assert.deepEqual(added.structuredContent, { path: '.claude/settings.local.json', rule: ALLOW_RULE, added: true })
  assert.deepEqual(JSON.parse(written), { permissions: { allow: [ALLOW_RULE] } })
  assert.deepEqual(again.structuredContent, { path: '.claude/settings.local.json', rule: ALLOW_RULE, added: false })
  assert.equal(await settings(), written)
  assert.equal(after.structuredContent.isServiceAllowed, true)
})

test('deck_allow_service keeps what the local settings hold, and leaves a file it cannot read as it is', async t => {
  const kept = await workspace()
  await mkdir(join(kept, '.claude'))
  await writeFile(
    join(kept, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(gh issue list:*)'], deny: ['WebFetch'] }, outputStyle: 'Explanatory' }),
  )
  // Not JSON, or permissions in a shape no rule can be added to.
  const unreadable = ['{ not json', '{"permissions":"ab"}', '{"permissions":{"allow":"xy"}}', '{"permissions":{"allow":{}}}']
  const broken = await Promise.all(
    unreadable.map(async text => {
      const dir = await workspace()
      await mkdir(join(dir, '.claude'))
      await writeFile(join(dir, '.claude', 'settings.local.json'), text)

      return dir
    }),
  )
  const decks = [kept, ...broken].map(dir => startDeck(dir))
  for (const deck of decks) {
    t.after(deck.stop)
  }

  const [a, ...refused] = await Promise.all(decks.map(deck => deck.callTool('deck_allow_service')))

  assert.equal(a.isError, false)
  assert.deepEqual(JSON.parse(await readFile(join(kept, '.claude', 'settings.local.json'), 'utf8')), {
    permissions: { allow: ['Bash(gh issue list:*)', ALLOW_RULE], deny: ['WebFetch'] },
    outputStyle: 'Explanatory',
  })
  assert.deepEqual(
    refused.map(result => result.isError),
    [true, true, true, true],
  )
  assert.match(refused[0].content[0].text, /settings\.local\.json is not valid JSON/)
  assert.match(refused[1].content[0].text, /settings\.local\.json.*permissions/)
  for (const [index, dir] of broken.entries()) {
    assert.equal(await readFile(join(dir, '.claude', 'settings.local.json'), 'utf8'), unreadable[index])
  }
})

test('deck_allow_service writes where the Session runs, which is where Claude Code reads local settings', async t => {
  const dir = await workspace()
  await mkdir(join(dir, '.git'))
  await mkdir(join(dir, 'packages', 'app'), { recursive: true })
  const deck = startDeck(join(dir, 'packages', 'app'))
  t.after(deck.stop)

  await deck.callTool('deck_allow_service')

  assert.deepEqual(JSON.parse(await readFile(join(dir, 'packages', 'app', '.claude', 'settings.local.json'), 'utf8')), {
    permissions: { allow: [ALLOW_RULE] },
  })
})

// The repository the fake `gh` answers for unless a test names another.
const thisRepository = 'acme/shop'

// A `gh` on the Deck service's PATH that answers with prepared JSON (see
// fake-gh.ts). `answer` sets what every later call gets; `calls` lists the
// calls made so far.
const fakeGh = async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'deck-gh-')))
  const script = join(import.meta.dirname, 'fake-gh.ts')
  await writeFile(join(dir, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  await writeFile(join(dir, 'calls.log'), '')
  const answer = (value: { stdout?: unknown; stderr?: string; exitCode?: number }) =>
    writeFile(join(dir, 'answer.json'), JSON.stringify(value))

  return {
    env: { PATH: dir, FAKE_GH_DIR: dir },
    answer,
    // The issues GitHub's GraphQL API answers, as `gh api graphql --paginate
    // --slurp` prints them: one page, of the repository `repository`.
    issues: (nodes: object[], repository = thisRepository) =>
      answer({
        stdout: [
          {
            data: {
              repository: { nameWithOwner: repository, issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          },
        ],
      }),
    calls: async (): Promise<{ args: string[]; cwd: string }[]> =>
      (await readFile(join(dir, 'calls.log'), 'utf8'))
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line)),
  }
}

// One issue as the GraphQL query reads it. A parent or blocker given by its
// number is in `thisRepository`, the one `issues` answers for by default.
type IssueGiven = number | { number: number; repository: string }
const ref = (value: IssueGiven) =>
  typeof value === 'number'
    ? { number: value, repository: { nameWithOwner: thisRepository } }
    : { number: value.number, repository: { nameWithOwner: value.repository } }
const issue = ({
  number,
  title = `Task ${number}`,
  state = 'OPEN',
  closedAt = null,
  updatedAt = '2026-11-11T09:00:00Z',
  labels = [],
  body = '',
  parent = null,
  blockedBy = [],
}: {
  number: number
  title?: string
  state?: 'OPEN' | 'CLOSED'
  closedAt?: string | null
  updatedAt?: string
  labels?: string[]
  body?: string
  parent?: IssueGiven | null
  blockedBy?: IssueGiven[]
}) => ({
  number,
  title,
  state,
  closedAt,
  updatedAt,
  body,
  labels: { nodes: labels.map(name => ({ name })) },
  parent: parent === null ? null : ref(parent),
  blockedBy: { nodes: blockedBy.map(ref) },
})

const configured = () =>
  workspace(
    JSON.stringify({
      taskSource: { type: 'github-issues' },
      skillSource: { type: 'plugin', name: 'mattpocock-skills' },
    }),
  )

// What deck_tasks says of each Task, without the fields a test does not look at.
const numbers = (tasks: { number: number }[]) => tasks.map(task => task.number)

test('deck_inspect reads grouped Tasks and config without creating local state', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1, title: '规格' }),
    issue({ number: 3, parent: 1 }),
    issue({ number: 5, blockedBy: [3] }),
    issue({ number: 7, state: 'CLOSED', closedAt: '2026-11-13T09:00:00Z' }),
  ])
  const deck = startDeck(dir, { ...gh.env, HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_inspect')

  assert.equal(result?.isError, false)
  const inspection = result.structuredContent
  assert.equal(inspection.ok, true)
  assert.equal(inspection.configured, true)
  assert.equal(inspection.workspace, dir)
  assert.equal(inspection.stateFile, join(user, '.matt-deck', 'deck.sqlite'))
  assert.deepEqual(inspection.config, JSON.parse(await readFile(join(dir, '.matt-deck', 'config.json'), 'utf8')))
  assert.deepEqual(numbers(inspection.tasks.containers), [1])
  assert.deepEqual(numbers(inspection.tasks.groups.ready), [3])
  assert.deepEqual(numbers(inspection.tasks.groups.blocked), [5])
  assert.deepEqual(numbers(inspection.tasks.groups.done), [7])
  assert.deepEqual(inspection.tasks.groups.inProgress, [])
  assert.deepEqual(inspection.occupancies, [])
  assert.deepEqual(await readdir(user), [])
})

test('deck_inspect reads older local state without adding missing tables', async t => {
  const user = await home()
  await mkdir(join(user, '.matt-deck'))
  const stateFile = join(user, '.matt-deck', 'deck.sqlite')
  const db = new DatabaseSync(stateFile)
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)
  t.after(() => db.close())

  // Before Occupancy existed, local state held only Recommendations.
  db.exec('CREATE TABLE recommendations (request_id TEXT PRIMARY KEY, recommendation TEXT NOT NULL, reported_at INTEGER NOT NULL)')
  const beforeOccupancy = await readFile(stateFile)
  const empty = await deck.callTool('deck_inspect')
  assert.equal(empty.isError, false)
  assert.deepEqual(empty.structuredContent.occupancies, [])
  assert.deepEqual(numbers(empty.structuredContent.tasks.groups.ready), [3])
  assert.deepEqual(await readFile(stateFile), beforeOccupancy)

  // Occupancy predates heartbeat and execution reports. A Session with no
  // heartbeat is Orphaned; no report means no Acceptance Evidence.
  db.exec('CREATE TABLE occupancies (source TEXT NOT NULL, task INTEGER NOT NULL, session TEXT NOT NULL, occupied_at INTEGER NOT NULL, PRIMARY KEY (source, task))')
  db.prepare('INSERT INTO occupancies VALUES (?, ?, ?, ?)').run('acme/shop', 3, 'old-session', 1)
  const beforeHeartbeat = await readFile(stateFile)
  const occupied = await deck.callTool('deck_inspect')
  assert.equal(occupied.isError, false)
  assert.deepEqual(occupied.structuredContent.occupancies, [{ task: 3, session: 'old-session', sessionHost: 'claude-code', sessionShort: 'old-sess', isOrphaned: true }])
  assert.equal(occupied.structuredContent.tasks.groups.inProgress[0].hasEvidence, false)
  assert.deepEqual(await readFile(stateFile), beforeHeartbeat)
})

test('deck_inspect explains an unconfigured workspace without reaching the Task Source', async t => {
  const dir = await workspace()
  const user = await home()
  const gh = await fakeGh()
  const deck = startDeck(dir, { ...gh.env, HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_inspect')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    configured: false,
    workspace: dir,
    stateFile: join(user, '.matt-deck', 'deck.sqlite'),
    ok: false,
    failure: {
      kind: 'not-configured',
      message: 'This workspace is not a Configured Project: .matt-deck/config.json does not exist',
    },
  })
  assert.deepEqual(await gh.calls(), [])
  assert.deepEqual(await readdir(user), [])
})

test('deck_inspect preserves config and the Pane failure when the Task Source cannot be read', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  const deck = startDeck(dir, { ...gh.env, HOME: user })
  t.after(deck.stop)

  for (const answer of [
    { exitCode: 4, stderr: 'Please run gh auth login\n' },
    { exitCode: 1, stderr: 'error connecting to api.github.com\n' },
  ]) {
    await gh.answer(answer)
    const inspection = await deck.callTool('deck_inspect')
    const pane = await deck.callTool('deck_tasks')
    assert.equal(inspection.isError, false)
    assert.equal(inspection.structuredContent.ok, false)
    assert.deepEqual(inspection.structuredContent.failure, pane.structuredContent.failure)
    assert.equal(inspection.structuredContent.configured, true)
    assert.equal(inspection.structuredContent.config.taskSource.type, 'github-issues')
    assert.equal(inspection.structuredContent.stateFile, join(user, '.matt-deck', 'deck.sqlite'))
    assert.equal(inspection.structuredContent.tasks, undefined)
  }
  assert.deepEqual(await readdir(user), [])
})

test('the CLI prints the same inspection from a repository subdirectory and reports failures by exit status', async t => {
  const dir = await configured()
  // A worktree has a .git file, rather than a directory.
  await writeFile(join(dir, '.git'), 'gitdir: /unused/worktree\n')
  const nested = join(dir, 'packages', 'app')
  await mkdir(nested, { recursive: true })
  const gh = await fakeGh()
  const clock = await fakeClock(Date.UTC(2026, 10, 13, 9, 0))
  const env = { ...process.env, ...gh.env, ...clock.env, HOME: await home() }
  const deck = startDeck(nested, env)
  t.after(deck.stop)
  await gh.issues([issue({ number: 16, title: '命令行' })])
  await deck.callTool('deck_occupy', { task: 16, session: 'session-a' })
  const expected = (await deck.callTool('deck_inspect')).structuredContent

  const result = await exec(process.execPath, ['--import', FAKE_CLOCK, CLI], { cwd: nested, env })

  assert.deepEqual(JSON.parse(result.stdout), expected)
  assert.equal(expected.workspace, dir)
  await gh.answer({ exitCode: 4, stderr: 'Please run gh auth login\n' })
  const failed = (await deck.callTool('deck_inspect')).structuredContent
  await assert.rejects(exec(process.execPath, [CLI], { cwd: nested, env }), (error: any) => {
    assert.equal(error.code, 1)
    assert.deepEqual(JSON.parse(error.stdout), failed)
    return true
  })
})

test('the one-shot run a Session exits with records its end: its Occupancies show Orphaned at once', async t => {
  const user = await home()
  const gh = await fakeGh()
  const env = { ...process.env, ...gh.env, HOME: user }
  const deck = startDeck(await configured(), env)
  t.after(deck.stop)
  await gh.issues([issue({ number: 3 })])
  await deck.callTool('deck_occupy', { task: 3, session: 'exiting' })
  await deck.callTool('deck_heartbeat', { session: 'exiting' })
  assert.deepEqual((await deck.callTool('deck_inspect')).structuredContent.occupancies, [
    { task: 3, session: 'exiting', sessionHost: 'claude-code', sessionShort: 'exiting', isOrphaned: false },
  ])

  const ran = await exec(process.execPath, [END_SESSION, 'exiting'], { env })

  assert.deepEqual([ran.stdout, ran.stderr], ['', ''])
  assert.deepEqual((await deck.callTool('deck_inspect')).structuredContent.occupancies, [
    { task: 3, session: 'exiting', sessionHost: 'claude-code', sessionShort: 'exiting', isOrphaned: true },
  ])
})

test('the one-shot end of a Session takes exactly its id', async () => {
  const env = { ...process.env, HOME: await home() }
  for (const args of [[], [''], ['a', 'b']]) {
    await assert.rejects(exec(process.execPath, [END_SESSION, ...args], { env }), (error: any) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /Usage:/)
      return true
    })
  }
})

test('the CLI explains unconfigured and malformed projects and validates arguments before reading', async () => {
  const dir = await workspace()
  const gh = await fakeGh()
  const env = { ...process.env, ...gh.env, HOME: await home() }
  const run = (args: string[] = []) => exec(process.execPath, [CLI, ...args], { cwd: dir, env })

  assert.match((await run(['--help'])).stdout, /Usage:.*main\.ts/)
  for (const args of [['release'], ['--help', 'extra']]) {
    await assert.rejects(run(args), (error: any) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /Usage:/)
      assert.equal(error.stdout, '')
      return true
    })
  }
  await assert.rejects(run(), (error: any) => {
    assert.equal(error.code, 1)
    assert.match(JSON.parse(error.stdout).failure.message, /not a Configured Project.*config\.json/)
    return true
  })
  await mkdir(join(dir, '.matt-deck'))
  await writeFile(join(dir, '.matt-deck', 'config.json'), '{ broken')
  await assert.rejects(run(), (error: any) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /\.matt-deck\/config\.json is not valid JSON/)
    assert.equal(error.stdout, '')
    return true
  })
  assert.deepEqual(await gh.calls(), [])
})

test('deck_inspect reports corrupt local state instead of showing an empty Occupancy list', async t => {
  const user = await home()
  await mkdir(join(user, '.matt-deck'))
  const stateFile = join(user, '.matt-deck', 'deck.sqlite')
  await writeFile(stateFile, 'not a SQLite database')
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_inspect')

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /not a database/)
  assert.equal(await readFile(stateFile, 'utf8'), 'not a SQLite database')
})

test('deck_tasks groups the Tasks of the Task Source', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3, labels: ['ready-for-human'] }),
    issue({ number: 5, labels: ['ready-for-agent'], blockedBy: [3] }),
    issue({ number: 7, blockedBy: [2] }),
    issue({ number: 8, labels: ['needs-triage'] }),
    issue({ number: 9, labels: ['needs-info'] }),
    issue({ number: 2, state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z' }),
    issue({ number: 15, state: 'CLOSED', closedAt: '2026-11-11T14:07:00Z', blockedBy: [3] }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const result = await deck.callTool('deck_tasks')

  assert.equal(result.isError, false)
  const { ok, groups } = result.structuredContent
  assert.equal(ok, true)
  assert.deepEqual(numbers(groups.ready), [3, 7])
  // No Session occupies any of them.
  assert.deepEqual(groups.inProgress, [])
  assert.deepEqual(numbers(groups.blocked), [5, 8, 9])
  // The latest closed first.
  assert.deepEqual(numbers(groups.done), [15, 2])
  assert.deepEqual(groups.blocked[0], {
    number: 5,
    title: 'Task 5',
    isOpen: true,
    labels: ['ready-for-agent'],
    parent: null,
    blockers: [3],
    blockedBy: [3],
    closedAt: null,
    occupant: null,
    occupantHost: null,
    occupantShort: null,
    isOrphaned: false,
    hasEvidence: false,
    isExecutable: false,
  })
  assert.deepEqual(groups.done[0].blockers, [])
})

test('deck_tasks lists a Task waiting on triage or information in progress while a Session occupies it', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 8, labels: ['needs-triage'] }), issue({ number: 9, labels: ['needs-info'] })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: await home() })
  t.after(deck.stop)

  await deck.callTool('deck_occupy', { session: 'session-a', task: 8 })
  await deck.callTool('deck_occupy', { session: 'session-b', task: 9 })

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent
  assert.deepEqual(occupants(groups.inProgress), { 8: 'session-a', 9: 'session-b' })
  assert.deepEqual(groups.blocked, [])
})

test('deck_tasks reads Blocking Edges from the body when GitHub has no native dependency', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 4, state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z' }),
    issue({ number: 9 }),
    // A `Blocked by` section, as /to-tickets writes it.
    issue({ number: 5, body: '## Parent\n\n#1\n\n## Blocked by\n\n- #3\n- #4\n\n## What to build\n\nSee #9.\n' }),
    // A `Blocked by` line at the top, as the issue tracker doc writes it.
    issue({ number: 6, body: 'Blocked by: #9, #3\n\nThe rest of the body.\n' }),
    // Native dependencies win over the body.
    issue({ number: 7, blockedBy: [4], body: 'Blocked by: #3\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(numbers(groups.ready), [3, 7, 9])
  assert.deepEqual(
    groups.blocked.map(({ number, blockers }: { number: number; blockers: number[] }) => ({ number, blockers })),
    [
      { number: 5, blockers: [3] },
      { number: 6, blockers: [3, 9] },
    ],
  )
})

test('deck_tasks takes no native Blocking Edge to another repository\'s issue for the Task of the same number', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 4 }),
    // Blocked by acme/web#3, not this repository's open #3.
    issue({ number: 5, blockedBy: [{ number: 3, repository: 'acme/web' }] }),
    // Blocked here by #4 and elsewhere by other/lib#3: only #4 counts, and
    // the body is not read.
    issue({ number: 6, blockedBy: [4, { number: 3, repository: 'other/lib' }], body: 'Blocked by: #3\n' }),
    // Blocked only elsewhere: the body's `Blocked by` is read.
    issue({ number: 7, blockedBy: [{ number: 3, repository: 'acme/web' }], body: 'Blocked by: #4\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent
  const edges = [...groups.ready, ...groups.blocked].map(
    ({ number, blockers, blockedBy }: { number: number; blockers: number[]; blockedBy: number[] }) => ({
      number,
      blockers,
      blockedBy,
    }),
  )

  assert.deepEqual(edges, [
    { number: 3, blockers: [], blockedBy: [] },
    { number: 4, blockers: [], blockedBy: [] },
    { number: 5, blockers: [], blockedBy: [] },
    { number: 6, blockers: [4], blockedBy: [4] },
    { number: 7, blockers: [4], blockedBy: [4] },
  ])
})

test('deck_tasks takes no Blocking Edge from a body\'s Blocked by to another repository\'s issue', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 4 }),
    // Blocked by acme/web#3, not this repository's open #3.
    issue({ number: 5, body: 'Blocked by: acme/web#3\n' }),
    issue({ number: 6, body: '## Blocked by\n\n- https://github.com/acme/web/issues/3\n' }),
    // Beside it, a reference to this repository still counts.
    issue({ number: 7, body: '## Blocked by\n\n- https://github.com/acme/web/issues/3\n- #4\n' }),
    issue({ number: 8, body: 'Blocked by: acme/web#3, #4\n' }),
    issue({ number: 11, body: 'Blocked by: https://github.com/acme/web/issues/3\n' }),
    issue({ number: 12, body: '## Blocked by\n\n- acme/web#3\n' }),
    // This repository named in full, in any case, is this repository.
    issue({ number: 9, body: 'Blocked by: ACME/Shop#3\n' }),
    issue({ number: 10, body: '## Blocked by\n\n- https://github.com/Acme/SHOP/issues/4\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent
  const edges = [...groups.ready, ...groups.blocked].map(
    ({ number, blockers, blockedBy }: { number: number; blockers: number[]; blockedBy: number[] }) => ({
      number,
      blockers,
      blockedBy,
    }),
  )

  assert.deepEqual(edges, [
    { number: 3, blockers: [], blockedBy: [] },
    { number: 4, blockers: [], blockedBy: [] },
    { number: 5, blockers: [], blockedBy: [] },
    { number: 6, blockers: [], blockedBy: [] },
    { number: 11, blockers: [], blockedBy: [] },
    { number: 12, blockers: [], blockedBy: [] },
    { number: 7, blockers: [4], blockedBy: [4] },
    { number: 8, blockers: [4], blockedBy: [4] },
    { number: 9, blockers: [3], blockedBy: [3] },
    { number: 10, blockers: [4], blockedBy: [4] },
  ])
})

test('deck_tasks reads a Markdown link to an issue in a body\'s Blocked by as the one reference its link names', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 4 }),
    // The link names acme/web#3, whatever its text says.
    issue({ number: 5, body: 'Blocked by: [#3](https://github.com/acme/web/issues/3)\n' }),
    issue({ number: 12, body: '## Blocked by\n\n- [#3](https://github.com/acme/web/issues/3#issuecomment-1)\n' }),
    issue({ number: 11, body: 'Blocked by: [上游](https://github.com/acme/web/issues/3)\n' }),
    // Beside it, a reference to this repository still counts.
    issue({ number: 6, body: '## Blocked by\n\n- [#3](https://github.com/acme/web/issues/3)\n- #4\n' }),
    issue({ number: 14, body: 'Blocked by: [#3](https://github.com/acme/web/issues/3), #4\n' }),
    // A link to this repository is its issue, once, whatever its text says.
    issue({ number: 7, body: 'Blocked by: [acme/web#4](https://github.com/acme/shop/issues/4)\n' }),
    issue({ number: 8, body: '## Blocked by\n\n- [#3](https://github.com/acme/shop/issues/3?x=1)\n' }),
    // A link that is not to an issue leaves its text's reference.
    issue({ number: 9, body: '## Blocked by\n\n- [see #3](https://example.com/doc)\n' }),
    issue({ number: 13, body: 'Blocked by: [#4](https://github.com/acme/web/pull/4)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent
  const edges = [...groups.ready, ...groups.blocked].map(
    ({ number, blockers, blockedBy }: { number: number; blockers: number[]; blockedBy: number[] }) => ({
      number,
      blockers,
      blockedBy,
    }),
  )

  assert.deepEqual(edges, [
    { number: 3, blockers: [], blockedBy: [] },
    { number: 4, blockers: [], blockedBy: [] },
    { number: 5, blockers: [], blockedBy: [] },
    { number: 11, blockers: [], blockedBy: [] },
    { number: 12, blockers: [], blockedBy: [] },
    { number: 6, blockers: [4], blockedBy: [4] },
    { number: 7, blockers: [4], blockedBy: [4] },
    { number: 8, blockers: [3], blockedBy: [3] },
    { number: 9, blockers: [3], blockedBy: [3] },
    { number: 13, blockers: [4], blockedBy: [4] },
    { number: 14, blockers: [4], blockedBy: [4] },
  ])
})

test('deck_tasks reads a Markdown link within one line, keeping a reference beside a bracket left open on another', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 4 }),
    // The `[` before #3 is not the start of the next line's link.
    issue({ number: 5, body: '## Blocked by\n\n- see [notes #3\n- [#4](https://github.com/acme/web/issues/4)\n' }),
    // Nor does a `(` left open take the next line's #3 into its link.
    issue({ number: 6, body: '## Blocked by\n\n- [notes](https://example.com/doc\n- #3 (later)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    [...groups.ready, ...groups.blocked].map(({ number, blockers }: any) => ({ number, blockers })),
    [
      { number: 3, blockers: [] },
      { number: 4, blockers: [] },
      { number: 5, blockers: [3] },
      { number: 6, blockers: [3] },
    ],
  )
})

test('deck_tasks reads a Markdown link whose text holds brackets in a body\'s Blocked by as the one reference its link names', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 4 }),
    // Brackets nested once, or escaped, are part of the link's text.
    issue({ number: 5, body: 'Blocked by: [#3 [草稿]](https://github.com/acme/web/issues/3)\n' }),
    issue({ number: 9, body: '## Blocked by\n\n- [[草稿] #3](https://github.com/acme/web/issues/3)\n' }),
    issue({ number: 11, body: '## Blocked by\n\n- [#3 \\[草稿\\]](https://github.com/acme/web/issues/3)\n' }),
    issue({ number: 15, body: 'Blocked by: [上游 [草稿]](https://github.com/acme/web/issues/3)\n' }),
    // Beside it, a reference to this repository still counts.
    issue({ number: 6, body: '## Blocked by\n\n- [#3 [草稿]](https://github.com/acme/web/issues/3)\n- #4\n' }),
    // A link to this repository is its issue, once.
    issue({ number: 7, body: 'Blocked by: [acme/web#4 [草稿]](https://github.com/acme/shop/issues/4)\n' }),
    issue({ number: 8, body: '## Blocked by\n\n- [#3 [草稿]](https://github.com/acme/shop/issues/3)\n' }),
    // A link that is not to an issue leaves its text's reference.
    issue({ number: 12, body: 'Blocked by: [see #3 [草稿]](https://example.com/doc)\n' }),
    // A task list's checkbox is not a link's text.
    issue({ number: 13, body: '## Blocked by\n\n- [ ] #3\n- [x] [#4](https://github.com/acme/web/issues/4)\n' }),
    // A bracket left open does not take in the link after it.
    issue({ number: 14, body: '## Blocked by\n\n- see [notes [#3](https://github.com/acme/web/issues/3), #4\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    [...groups.ready, ...groups.blocked].map(({ number, blockers, blockedBy }: any) => ({ number, blockers, blockedBy })),
    [
      { number: 3, blockers: [], blockedBy: [] },
      { number: 4, blockers: [], blockedBy: [] },
      { number: 5, blockers: [], blockedBy: [] },
      { number: 9, blockers: [], blockedBy: [] },
      { number: 11, blockers: [], blockedBy: [] },
      { number: 15, blockers: [], blockedBy: [] },
      { number: 6, blockers: [4], blockedBy: [4] },
      { number: 7, blockers: [4], blockedBy: [4] },
      { number: 8, blockers: [3], blockedBy: [3] },
      { number: 12, blockers: [3], blockedBy: [3] },
      { number: 13, blockers: [3], blockedBy: [3] },
      { number: 14, blockers: [4], blockedBy: [4] },
    ],
  )
})

test('deck_tasks reads a Markdown link inside another link\'s text in a body\'s Blocked by as GitHub renders it', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 5 }),
    issue({ number: 9 }),
    // The inner link is the link; the outer brackets and `](link)` after it
    // are text, so that link is a bare one.
    issue({ number: 20, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 21, body: 'Blocked by: [见 [#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 22, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/web/issues/9)\n' }),
    issue({ number: 23, body: 'Blocked by: [见 [#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/web/issues/9)\n' }),
    // A reference in the outer brackets' own text counts.
    issue({ number: 24, body: '## Blocked by\n\n- [#3 见 [#5](https://github.com/acme/web/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 25, body: 'Blocked by: [#3 见 [#5](https://github.com/acme/web/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    // The inner link's text may hold brackets; a link to no issue leaves its text's reference.
    issue({ number: 26, body: '## Blocked by\n\n- [见 [#5 [草稿]](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 27, body: '## Blocked by\n\n- [见 [#5](https://example.com/doc)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 28, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5)](https://example.com/doc)\n' }),
    issue({ number: 29, body: '## Blocked by\n\n- [见 [文档](https://example.com/doc)](https://github.com/acme/shop/issues/9)\n' }),
    // An image in a link's text is not a link: the outer link decides.
    issue({ number: 30, body: '## Blocked by\n\n- [![#5](https://example.com/badge.svg)](https://github.com/acme/shop/issues/9)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    [...groups.ready, ...groups.blocked].map(({ number, blockers, blockedBy }: any) => ({ number, blockers, blockedBy })),
    [
      { number: 3, blockers: [], blockedBy: [] },
      { number: 5, blockers: [], blockedBy: [] },
      { number: 9, blockers: [], blockedBy: [] },
      { number: 20, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 21, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 22, blockers: [5], blockedBy: [5] },
      { number: 23, blockers: [5], blockedBy: [5] },
      { number: 24, blockers: [3, 9], blockedBy: [3, 9] },
      { number: 25, blockers: [3, 9], blockedBy: [3, 9] },
      { number: 26, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 27, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 28, blockers: [5], blockedBy: [5] },
      { number: 29, blockers: [9], blockedBy: [9] },
      { number: 30, blockers: [9], blockedBy: [9] },
    ],
  )
})

test('deck_tasks reads `[text](…)` in a body\'s Blocked by as a Markdown link only when its parentheses hold a link and at most a title, as GitHub renders it', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3 }),
    issue({ number: 5 }),
    issue({ number: 9 }),
    // The inner parentheses hold no link: the whole is one link, to the outer one.
    issue({ number: 20, body: '## Blocked by\n\n- [见 [#5](see notes)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 21, body: 'Blocked by: [见 [#5](see notes)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 22, body: '## Blocked by\n\n- [see [#5](https://github.com/acme/shop/issues/5 ](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 23, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5 "标题" x)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 24, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5 "标)](https://github.com/acme/shop/issues/9)\n' }),
    // A link with a title, in angle brackets, with spaces around it, or empty is a link, and the inner link is the link.
    issue({ number: 25, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5 "标题")](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 26, body: 'Blocked by: [见 [#5](https://github.com/acme/shop/issues/5 \'标题\')](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 27, body: '## Blocked by\n\n- [见 [#5](<see notes>)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 28, body: '## Blocked by\n\n- [见 [#5]( https://github.com/acme/shop/issues/5 )](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 29, body: '## Blocked by\n\n- [见 [#5]()](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 30, body: '## Blocked by\n\n- [见 [#5](<https://github.com/acme/shop/issues/5>\t"标题")](https://github.com/acme/shop/issues/9)\n' }),
    // Not nested: parentheses that hold no link leave the brackets and the parentheses text.
    issue({ number: 31, body: '## Blocked by\n\n- [#3](see https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 32, body: '## Blocked by\n\n- [#3](https://github.com/acme/shop/issues/5 https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 33, body: '## Blocked by\n\n- [#5](see notes)\n' }),
    // A title is not the link: only the link's number counts.
    issue({ number: 34, body: '## Blocked by\n\n- [#3](https://github.com/acme/shop/issues/5 "见 https://github.com/acme/shop/issues/9")\n' }),
    issue({ number: 35, body: '## Blocked by\n\n- [#3](<https://github.com/acme/shop/issues/5>)\n' }),
    // A title may be in parentheses that hold none; unclosed, the parentheses hold no link.
    issue({ number: 36, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5 (标题))](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 37, body: 'Blocked by: [#3](https://github.com/acme/shop/issues/5 (见 https://github.com/acme/shop/issues/9))\n' }),
    issue({ number: 38, body: '## Blocked by\n\n- [#3](https://github.com/acme/shop/issues/5 (标题)\n' }),
    issue({ number: 39, body: '## Blocked by\n\n- [见 [#5](https://github.com/acme/shop/issues/5 (标题)](https://github.com/acme/shop/issues/9)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    [...groups.ready, ...groups.blocked].map(({ number, blockers, blockedBy }: any) => ({ number, blockers, blockedBy })),
    [
      { number: 3, blockers: [], blockedBy: [] },
      { number: 5, blockers: [], blockedBy: [] },
      { number: 9, blockers: [], blockedBy: [] },
      { number: 20, blockers: [9], blockedBy: [9] },
      { number: 21, blockers: [9], blockedBy: [9] },
      { number: 22, blockers: [9], blockedBy: [9] },
      { number: 23, blockers: [9], blockedBy: [9] },
      { number: 24, blockers: [9], blockedBy: [9] },
      { number: 25, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 26, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 27, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 28, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 29, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 30, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 31, blockers: [3, 9], blockedBy: [3, 9] },
      { number: 32, blockers: [3, 5, 9], blockedBy: [3, 5, 9] },
      { number: 33, blockers: [5], blockedBy: [5] },
      { number: 34, blockers: [5], blockedBy: [5] },
      { number: 35, blockers: [5], blockedBy: [5] },
      { number: 36, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 37, blockers: [5], blockedBy: [5] },
      { number: 38, blockers: [3, 5], blockedBy: [3, 5] },
      { number: 39, blockers: [9], blockedBy: [9] },
    ],
  )
})

test('deck_tasks reads `\\![…](…)` in a link\'s text in a body\'s Blocked by as `!` and a link, as GitHub renders it', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 5 }),
    issue({ number: 9 }),
    // An escaped `!` opens no image: the inner link is the link.
    issue({ number: 20, body: '## Blocked by\n\n- [见 \\![#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 21, body: 'Blocked by: [见 \\![#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 22, body: '## Blocked by\n\n- [\\![#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    // An escaped backslash leaves `!` an image's start: the outer link decides.
    issue({ number: 23, body: '## Blocked by\n\n- [见 \\\\![#5](https://example.com/badge.svg)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 24, body: 'Blocked by: [![#5](https://example.com/badge.svg)](https://github.com/acme/shop/issues/9)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    [...groups.ready, ...groups.blocked].map(({ number, blockers, blockedBy }: any) => ({ number, blockers, blockedBy })),
    [
      { number: 5, blockers: [], blockedBy: [] },
      { number: 9, blockers: [], blockedBy: [] },
      { number: 20, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 21, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 22, blockers: [5, 9], blockedBy: [5, 9] },
      { number: 23, blockers: [9], blockedBy: [9] },
      { number: 24, blockers: [9], blockedBy: [9] },
    ],
  )
})

test('deck_tasks keeps every Blocking Edge a Task declares, to closed Tasks and from closed ones too', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 3, state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z' }),
    issue({ number: 4 }),
    // Blocked by a closed Task, an open one, and an issue the source does not hold.
    issue({ number: 5, blockedBy: [4, 3, 99] }),
    issue({ number: 6, state: 'CLOSED', closedAt: '2026-11-11T06:00:00Z', blockedBy: [3] }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent
  const edges = [...groups.ready, ...groups.blocked, ...groups.done].map(
    ({ number, blockers, blockedBy }: { number: number; blockers: number[]; blockedBy: number[] }) => ({
      number,
      blockers,
      blockedBy,
    }),
  )

  assert.deepEqual(edges, [
    { number: 4, blockers: [], blockedBy: [] },
    { number: 5, blockers: [4], blockedBy: [3, 4] },
    { number: 6, blockers: [], blockedBy: [3] },
    { number: 3, blockers: [], blockedBy: [] },
  ])
})

test('deck_tasks lists Specs and Maps apart from the groups, each with its Child Tasks', async t => {
  const gh = await fakeGh()
  await gh.issues([
    // A Spec whose Child Tasks are GitHub sub-issues.
    issue({ number: 1, title: '规格：里程碑一', labels: ['ready-for-agent'] }),
    issue({ number: 2, parent: 1, state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z' }),
    issue({ number: 3, parent: 1 }),
    // A sub-issue wins over what the body says.
    issue({ number: 13, parent: 1, body: 'Part of #10\n' }),
    // A Map whose Child Tasks say so in the body.
    issue({ number: 10, title: 'Codex 适配走哪条路', labels: ['wayfinder:map'] }),
    issue({ number: 11, body: '## Parent\n\n#10\n\n## What to build\n\nLike #3.\n' }),
    issue({ number: 12, body: 'Part of #10\n\nThe rest.\n' }),
    // A Parent section wins over a `Part of` line.
    issue({ number: 14, body: 'Part of #1\n\n## Parent\n\n#10\n' }),
    // A sub-issue wins over a Parent section.
    issue({ number: 15, parent: 1, body: '## Parent\n\n#10\n' }),
    // A Map with no Child Task yet is still a Map.
    issue({ number: 20, labels: ['wayfinder:map'] }),
    // A closed Spec is still a Spec.
    issue({ number: 30, state: 'CLOSED', closedAt: '2026-11-12T08:00:00Z' }),
    issue({ number: 31, parent: 30, state: 'CLOSED', closedAt: '2026-11-12T07:00:00Z' }),
    // A parent that is no issue makes no Spec.
    issue({ number: 40, body: 'Part of #99\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    containers.map(({ kind, number, isOpen, children, progress }: any) => ({ kind, number, isOpen, children, progress })),
    [
      { kind: 'spec', number: 1, isOpen: true, children: [2, 3, 13, 15], progress: { closed: 1, inProgress: 0, total: 4 } },
      { kind: 'map', number: 10, isOpen: true, children: [11, 12, 14], progress: { closed: 0, inProgress: 0, total: 3 } },
      { kind: 'map', number: 20, isOpen: true, children: [], progress: { closed: 0, inProgress: 0, total: 0 } },
      { kind: 'spec', number: 30, isOpen: false, children: [31], progress: { closed: 1, inProgress: 0, total: 1 } },
    ],
  )
  assert.equal(containers[0].title, '规格：里程碑一')
  assert.equal(containers[0].group, 'ready')
  assert.deepEqual(containers[0].labels, ['ready-for-agent'])
  // Specs and Maps are in no group.
  assert.deepEqual(numbers(groups.ready), [3, 11, 12, 13, 14, 15, 40])
  assert.deepEqual(numbers(groups.done), [31, 2])
  assert.equal(groups.ready.find((task: any) => task.number === 12).parent, 10)
  assert.equal(groups.ready.find((task: any) => task.number === 40).parent, null)
})

test('deck_tasks takes no sub-issue parent from another repository for the Task of the same number', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 10, labels: ['wayfinder:map'] }),
    issue({ number: 12 }),
    // GitHub's parent is acme/web#12, not this repository's #12.
    issue({ number: 5, parent: { number: 12, repository: 'acme/web' } }),
    // Without a parent here, the body's Parent section stands.
    issue({ number: 6, parent: { number: 12, repository: 'acme/web' }, body: '## Parent\n\n#10\n' }),
    // And so does a `Part of` line.
    issue({ number: 7, parent: { number: 12, repository: 'acme/web' }, body: 'Part of #10\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    containers.map(({ kind, number, children }: any) => ({ kind, number, children })),
    [{ kind: 'map', number: 10, children: [6, 7] }],
  )
  assert.deepEqual(numbers(groups.ready), [5, 6, 7, 12])
  assert.equal(groups.ready.find((task: any) => task.number === 5).parent, null)
  assert.equal(groups.ready.find((task: any) => task.number === 6).parent, 10)
  assert.equal(groups.ready.find((task: any) => task.number === 7).parent, 10)
})

test('deck_tasks takes no parent from a Parent section that first names another repository\'s issue', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 10, labels: ['wayfinder:map'] }),
    issue({ number: 12 }),
    // The section names acme/web#12, not this repository's #12.
    issue({ number: 5, body: '## Parent\n\nacme/web#12\n' }),
    issue({ number: 6, body: '## Parent\n\nhttps://github.com/acme/web/issues/12\n' }),
    // A later reference to this repository is not the parent either.
    issue({ number: 7, body: '## Parent\n\nacme/web#12, like #10.\n' }),
    issue({ number: 13, body: '## Parent\n\nhttps://github.com/acme/web/issues/12, like #10.\n' }),
    // A `Part of` line still stands.
    issue({ number: 8, body: 'Part of #10\n\n## Parent\n\nhttps://github.com/acme/web/issues/12\n' }),
    issue({ number: 14, body: 'Part of #10\n\n## Parent\n\nacme/web#12\n' }),
    // This repository named in full, in any case, is this repository.
    issue({ number: 9, body: '## Parent\n\nACME/Shop#10\n' }),
    issue({ number: 11, body: '## Parent\n\nhttps://github.com/Acme/SHOP/issues/10\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    containers.map(({ kind, number, children }: any) => ({ kind, number, children })),
    [{ kind: 'map', number: 10, children: [8, 9, 11, 14] }],
  )
  assert.deepEqual(
    groups.ready.map(({ number, parent }: any) => ({ number, parent })),
    [
      { number: 5, parent: null },
      { number: 6, parent: null },
      { number: 7, parent: null },
      { number: 8, parent: 10 },
      { number: 9, parent: 10 },
      { number: 11, parent: 10 },
      { number: 12, parent: null },
      { number: 13, parent: null },
      { number: 14, parent: 10 },
    ],
  )
})

test('deck_tasks reads a Markdown link to an issue in a Parent section as the one reference its link names', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 10, labels: ['wayfinder:map'] }),
    issue({ number: 12 }),
    // The link names acme/web#12, not this repository's #12, whatever its text says.
    issue({ number: 5, body: '## Parent\n\n[#12](https://github.com/acme/web/issues/12)\n' }),
    issue({ number: 6, body: '## Parent\n\n[#12](https://github.com/acme/web/issues/12), like #10.\n' }),
    issue({ number: 7, body: '## Parent\n\n[上游](https://github.com/acme/web/issues/12)\n' }),
    // A `Part of` line still stands.
    issue({ number: 8, body: 'Part of #10\n\n## Parent\n\n[#12](https://github.com/acme/web/issues/12)\n' }),
    // A link to this repository is its issue, whatever its text says.
    issue({ number: 9, body: '## Parent\n\n[acme/web#12](https://github.com/acme/shop/issues/10)\n' }),
    // A link that is not to an issue leaves its text's reference.
    issue({ number: 11, body: '## Parent\n\n[see #10](https://example.com/doc)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    containers.map(({ kind, number, children }: any) => ({ kind, number, children })),
    [{ kind: 'map', number: 10, children: [8, 9, 11] }],
  )
  assert.deepEqual(
    groups.ready.map(({ number, parent }: any) => ({ number, parent })),
    [
      { number: 5, parent: null },
      { number: 6, parent: null },
      { number: 7, parent: null },
      { number: 8, parent: 10 },
      { number: 9, parent: 10 },
      { number: 11, parent: 10 },
      { number: 12, parent: null },
    ],
  )
})

test('deck_tasks reads a Markdown link whose text holds brackets in a Parent section as the one reference its link names', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 10, labels: ['wayfinder:map'] }),
    issue({ number: 12 }),
    // The link names acme/web#12, not this repository's #12.
    issue({ number: 5, body: '## Parent\n\n[#12 [草稿]](https://github.com/acme/web/issues/12)\n' }),
    issue({ number: 6, body: '## Parent\n\n[[草稿] #12](https://github.com/acme/web/issues/12)\n' }),
    issue({ number: 7, body: '## Parent\n\n[#12 \\[草稿\\]](https://github.com/acme/web/issues/12)\n' }),
    issue({ number: 8, body: '## Parent\n\n[上游 [草稿]](https://github.com/acme/web/issues/12)\n' }),
    // A link to this repository is its issue.
    issue({ number: 9, body: '## Parent\n\n[acme/web#12 [草稿]](https://github.com/acme/shop/issues/10)\n' }),
    // A link that is not to an issue leaves its text's reference.
    issue({ number: 11, body: '## Parent\n\n[see #10 [草稿]](https://example.com/doc)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    containers.map(({ kind, number, children }: any) => ({ kind, number, children })),
    [{ kind: 'map', number: 10, children: [9, 11] }],
  )
  assert.deepEqual(
    groups.ready.map(({ number, parent }: any) => ({ number, parent })),
    [
      { number: 5, parent: null },
      { number: 6, parent: null },
      { number: 7, parent: null },
      { number: 8, parent: null },
      { number: 9, parent: 10 },
      { number: 11, parent: 10 },
      { number: 12, parent: null },
    ],
  )
})

test('deck_tasks reads a Markdown link inside another link\'s text in a Parent section as GitHub renders it', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 5 }),
    issue({ number: 9 }),
    // The inner link comes first: in another repository, the section gives no parent.
    issue({ number: 20, body: '## Parent\n\n[见 [#5](https://github.com/acme/web/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    // In this repository, it is the parent.
    issue({ number: 21, body: '## Parent\n\n[见 [#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 22, body: '## Parent\n\n[见 [#5 [草稿]](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 23, body: '## Parent\n\n[见 [#5](https://example.com/doc)](https://github.com/acme/shop/issues/9)\n' }),
    // An image in a link's text is not a link: the outer link decides.
    issue({ number: 24, body: '## Parent\n\n[![#9](https://example.com/badge.svg)](https://github.com/acme/shop/issues/5)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    containers.map(({ kind, number, children }: any) => ({ kind, number, children })),
    [{ kind: 'spec', number: 5, children: [21, 22, 23, 24] }],
  )
  assert.deepEqual(
    groups.ready.map(({ number, parent }: any) => ({ number, parent })),
    [
      { number: 9, parent: null },
      { number: 20, parent: null },
      { number: 21, parent: 5 },
      { number: 22, parent: 5 },
      { number: 23, parent: 5 },
      { number: 24, parent: 5 },
    ],
  )
})

test('deck_tasks reads `[text](…)` in a Parent section as a Markdown link only when its parentheses hold a link and at most a title, and an escaped `!` as no image, as GitHub renders it', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 5 }),
    issue({ number: 9 }),
    // The inner parentheses hold no link: the outer link is the parent, and #5 no Spec for it.
    issue({ number: 20, body: '## Parent\n\n[见 [#5](see notes)](https://github.com/acme/shop/issues/9)\n' }),
    issue({ number: 21, body: '## Parent\n\n[see [#5](https://github.com/acme/shop/issues/5 ](https://github.com/acme/shop/issues/9)\n' }),
    // The inner link has a title: it is the link.
    issue({ number: 22, body: '## Parent\n\n[见 [#9](https://github.com/acme/shop/issues/9 "标题")](https://github.com/acme/shop/issues/5)\n' }),
    // An escaped `!` opens no image: the inner link comes first.
    issue({ number: 23, body: '## Parent\n\n[见 \\![#5](https://github.com/acme/shop/issues/5)](https://github.com/acme/shop/issues/9)\n' }),
    // An escaped backslash leaves `!` an image's start: the outer link decides.
    issue({ number: 24, body: '## Parent\n\n[见 \\\\![#5](https://example.com/badge.svg)](https://github.com/acme/shop/issues/9)\n' }),
    // The inner link has a title in parentheses: it is the link.
    issue({ number: 25, body: '## Parent\n\n[见 [#5](https://github.com/acme/shop/issues/5 (标题))](https://github.com/acme/shop/issues/9)\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    containers.map(({ kind, number, children }: any) => ({ kind, number, children })),
    [
      { kind: 'spec', number: 5, children: [23, 25] },
      { kind: 'spec', number: 9, children: [20, 21, 22, 24] },
    ],
  )
  assert.deepEqual(
    groups.ready.map(({ number, parent }: any) => ({ number, parent })),
    [
      { number: 20, parent: 9 },
      { number: 21, parent: 9 },
      { number: 22, parent: 9 },
      { number: 23, parent: 5 },
      { number: 24, parent: 9 },
      { number: 25, parent: 5 },
    ],
  )
})

// The CPU time the Deck service spends on deck_tasks, in milliseconds, when
// a body's Blocked by section, its top Blocked by line and its Parent section
// each hold `line` beside a reference, and when they hold as many characters
// of plain words instead; and what it reads with `line`.
const timedWithLine = async (t: { after: (fn: () => void) => void }, line: string) => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const timed = async (text: string) => {
    await gh.issues([
      issue({ number: 3 }),
      issue({ number: 10, labels: ['wayfinder:map'] }),
      issue({ number: 5, body: `## Blocked by\n\n- #3\n- ${text}\n` }),
      issue({ number: 6, body: `Blocked by: #3 ${text}\n` }),
      issue({ number: 7, body: `## Parent\n\n#10 ${text}\n` }),
    ])
    const start = await deck.cpuMs()
    const { structuredContent } = await deck.callTool('deck_tasks', { refresh: true })
    return { ms: (await deck.cpuMs()) - start, structuredContent }
  }
  const plain = 'ab '.repeat(Math.ceil(line.length / 3)).slice(0, line.length)
  // The first read warms the Deck service up.
  await timed(plain)
  const plainMs = (await timed(plain)).ms
  const withLine = await timed(line)

  return { plainMs, lineMs: withLine.ms, read: withLine.structuredContent }
}

const assertReadAsBefore = (read: any) => {
  assert.deepEqual(
    read.groups.blocked.map(({ number, blockers, blockedBy }: any) => ({ number, blockers, blockedBy })),
    [
      { number: 5, blockers: [3], blockedBy: [3] },
      { number: 6, blockers: [3], blockedBy: [3] },
    ],
  )
  assert.deepEqual(
    read.containers.map(({ number, children }: any) => ({ number, children })),
    [{ number: 10, children: [7] }],
  )
}

// A line sixteen times as long as GitHub lets a body be, 65536 characters,
// which the fake gh does not mind. A read that grows with the line's length
// takes some tens of milliseconds more; one that grows with its square takes
// half a minute more or far longer, so seconds more on a much faster machine
// too.
const LONG = 16 * 65000

test('deck_tasks reads a long run of letters and digits in a Parent section or Blocked by about as fast as plain words', async t => {
  const { plainMs, lineMs, read } = await timedWithLine(t, 'a'.repeat(LONG - 6) + 'a.b-c_')

  assertReadAsBefore(read)
  assert.ok(lineMs - plainMs < 1000, `${lineMs} ms with the line, ${plainMs} ms without`)
})

test('deck_tasks reads a long line of open brackets and escapes in a Parent section or Blocked by about as fast as plain words', async t => {
  const { plainMs, lineMs, read } = await timedWithLine(t, '[\\'.repeat(LONG / 2))

  assertReadAsBefore(read)
  assert.ok(lineMs - plainMs < 1000, `${lineMs} ms with the line, ${plainMs} ms without`)
})

test('deck_tasks reads a long line of unclosed Markdown links in a Parent section or Blocked by about as fast as plain words', async t => {
  const { plainMs, lineMs, read } = await timedWithLine(t, '[x]('.repeat(LONG / 4))

  assertReadAsBefore(read)
  assert.ok(lineMs - plainMs < 1000, `${lineMs} ms with the line, ${plainMs} ms without`)
})

test('deck_tasks reads a long line of Markdown links in a Parent section or Blocked by about as fast as plain words', async t => {
  // No issue here is #99, so the links block nothing.
  const { plainMs, lineMs, read } = await timedWithLine(t, '[#99](x) '.repeat(LONG / 9))

  assertReadAsBefore(read)
  assert.ok(lineMs - plainMs < 1000, `${lineMs} ms with the line, ${plainMs} ms without`)
})

test('deck_tasks reads a long line of Markdown links with unclosed titles and angle brackets in a Parent section or Blocked by about as fast as plain words', async t => {
  const { plainMs, lineMs, read } = await timedWithLine(t, '[x](a "[y](<b [z](c ('.repeat(LONG / 21))

  assertReadAsBefore(read)
  assert.ok(lineMs - plainMs < 1000, `${lineMs} ms with the line, ${plainMs} ms without`)
})

test('deck_tasks marks only open Specs with every Child Task closed as Pending Closeout, without closing them', async t => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const read = async (specState: 'OPEN' | 'CLOSED', childState: 'OPEN' | 'CLOSED') => {
    await gh.issues([
      issue({ number: 1, state: specState }),
      issue({ number: 2, parent: 1, state: 'CLOSED' }),
      issue({ number: 3, parent: 1, state: childState }),
      issue({ number: 10, labels: ['wayfinder:map'] }),
      issue({ number: 11, parent: 10, state: 'CLOSED' }),
      issue({ number: 20, labels: ['wayfinder:map'] }),
      issue({ number: 30 }),
    ])
    const result = await deck.callTool('deck_tasks', { refresh: true })
    assert.equal(result.isError, false)
    assert.equal(result.structuredContent.ok, true)

    return result.structuredContent
  }

  const open = await read('OPEN', 'OPEN')
  assert.equal(open.containers[0].isPendingCloseout, false)
  const pending = await read('OPEN', 'CLOSED')
  assert.deepEqual(
    pending.containers.map(({ number, isOpen, isPendingCloseout }: any) => ({ number, isOpen, isPendingCloseout })),
    [
      { number: 1, isOpen: true, isPendingCloseout: true },
      { number: 10, isOpen: true, isPendingCloseout: false },
      { number: 20, isOpen: true, isPendingCloseout: false },
    ],
  )
  assert.deepEqual(pending.containers[0].progress, { closed: 2, inProgress: 0, total: 2 })
  // Containers stay outside every group; a Task without children is no Spec.
  assert.deepEqual(numbers(pending.groups.ready), [30])
  assert.deepEqual(numbers(pending.groups.done), [2, 3, 11])
  assert.deepEqual(pending.groups.inProgress, [])
  assert.deepEqual(pending.groups.blocked, [])
  assert.equal((await deck.callTool('deck_tasks')).structuredContent.containers[0].isOpen, true)

  const reopened = await read('OPEN', 'OPEN')
  assert.equal(reopened.containers[0].isPendingCloseout, false)
  const closed = await read('CLOSED', 'CLOSED')
  assert.equal(closed.containers[0].isPendingCloseout, false)
  assert.equal(closed.containers[0].isOpen, false)
  // All source access is read-only, including after entering Pending Closeout.
  assert.ok((await gh.calls()).every(call => call.args[0] === 'api' && call.args[1] === 'graphql' &&
    call.args.some(arg => arg.startsWith('query=query('))))
})

// The Child Tasks on a Map View's wall, by number, as deck_map orders them.
const wallOf = (map: { wall: { number: number }[] }) => numbers(map.wall)

test('deck_map orders a Spec\'s Child Tasks as its Map View shows them: ready, in progress by Session, blocked with each blocker first, closed', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1, title: '规格' }),
    // Ready, a Child Task that is a Map among them where it stands as a Task.
    issue({ number: 9, parent: 1 }),
    issue({ number: 4, parent: 1, updatedAt: '2026-11-20T10:00:00Z' }),
    issue({ number: 30, parent: 1, labels: ['wayfinder:map'] }),
    // In progress: another Session's, this Session's, another Session's, an
    // Orphaned one with the lowest number.
    issue({ number: 5, parent: 1 }),
    issue({ number: 6, parent: 1 }),
    issue({ number: 7, parent: 1 }),
    issue({ number: 3, parent: 1 }),
    // Blocked: a chain whose blockers have the higher numbers, a Task
    // waiting on triage, and one blocked from outside the Spec. A closed
    // Task blocks nothing.
    issue({ number: 20, parent: 1, blockedBy: [21, 2] }),
    issue({ number: 21, parent: 1, blockedBy: [22] }),
    issue({ number: 22, parent: 1, blockedBy: [4] }),
    issue({ number: 23, parent: 1, labels: ['needs-triage'] }),
    issue({ number: 24, parent: 1, blockedBy: [40] }),
    // Closed, the last closed first.
    issue({ number: 2, parent: 1, state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z' }),
    issue({ number: 8, parent: 1, state: 'CLOSED', closedAt: '2026-11-12T05:40:00Z', blockedBy: [9] }),
    // Outside the Spec: one blocking a Child Task, one a Child Task blocks.
    issue({ number: 40 }),
    issue({ number: 41, blockedBy: [9] }),
    // A Map a Child Task blocks, listed apart from the groups.
    issue({ number: 45, labels: ['wayfinder:map'], blockedBy: [4] }),
  ])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)
  for (const [task, session] of [[5, 'other-b'], [6, 'this-session'], [7, 'other-a'], [3, 'ended']] as const) {
    await deck.callTool('deck_occupy', { task, session })
    await deck.callTool('deck_heartbeat', { session })
  }
  await deck.callTool('deck_end_session', { session: 'ended' })

  const result = await deck.callTool('deck_map', { session: 'this-session' })
  assert.equal(result.isError, false)
  const [spec, map] = result.structuredContent.maps

  assert.equal(result.structuredContent.ok, true)
  assert.equal(spec.number, 1)
  assert.equal(spec.title, '规格')
  assert.deepEqual(wallOf(spec), [4, 9, 30, 6, 5, 7, 3, 22, 21, 20, 23, 24, 8, 2])
  assert.deepEqual(
    spec.wall.map((card: any) => card.group),
    ['ready', 'ready', 'ready', 'inProgress', 'inProgress', 'inProgress', 'inProgress', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'done', 'done'],
  )
  // Each with the open Tasks it blocks, in the Spec or not.
  assert.deepEqual(
    Object.fromEntries(spec.wall.filter((card: any) => card.blocking.length > 0).map((card: any) => [card.number, card.blocking])),
    { 4: [22, 45], 9: [41], 21: [20], 22: [21] },
  )
  // As deck_tasks lists it, with when it was last updated.
  const four = spec.wall[0]
  assert.equal(four.updatedAt, '2026-11-20T10:00:00Z')
  assert.equal(four.title, 'Task 4')
  assert.deepEqual(spec.wall.find((card: any) => card.number === 20).blockers, [21])
  assert.equal(spec.wall.find((card: any) => card.number === 3).isOrphaned, true)
  assert.equal(map.number, 30)
  assert.deepEqual(wallOf(map), [])

  // Asked by another Session, its Tasks in progress come first.
  const other = (await deck.callTool('deck_map', { session: 'other-b' })).structuredContent.maps[0]
  assert.deepEqual(wallOf(other).slice(3, 7), [5, 6, 7, 3])
  // Asked by the Session that ended, its own Orphaned Task stands with the
  // Orphaned ones, after every other Session's.
  const ended = (await deck.callTool('deck_map', { session: 'ended' })).structuredContent.maps[0]
  assert.deepEqual(wallOf(ended).slice(3, 7), [5, 6, 7, 3])
})

test('deck_map still orders the Child Tasks when Blocking Edges loop', { timeout: 20_000 }, async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1 }),
    issue({ number: 2, parent: 1, blockedBy: [3] }),
    issue({ number: 3, parent: 1, blockedBy: [2] }),
    issue({ number: 4, parent: 1, blockedBy: [3] }),
    issue({ number: 5, parent: 1, blockedBy: [5] }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const [spec] = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent.maps

  // The loop is cut where it is first reached; each Child Task is there once.
  assert.deepEqual(wallOf(spec), [3, 2, 4, 5])
  assert.deepEqual(
    spec.wall.map((card: any) => [card.number, card.blocking]),
    [[3, [2, 4]], [2, [3]], [4, []], [5, [5]]],
  )
})

test('deck_map lists every Spec and Map, open ones first, each with the first sentence of its body as its goal', async t => {
  const gh = await fakeGh()
  await gh.issues([
    // What the detail draws elsewhere, a heading, a code block and a
    // checklist item are no goal; a paragraph over two lines is one.
    issue({
      number: 1,
      state: 'CLOSED',
      closedAt: '2026-11-12T05:40:00Z',
      body: 'Part of #99\n\n## Problem Statement\n\n```\nnot. this\n```\n\n- [ ] Not this.\n\nThe first line\nruns on。Then more.\n\nAnother paragraph.\n',
    }),
    issue({ number: 2, parent: 1, state: 'CLOSED', closedAt: '2026-11-12T05:40:00Z' }),
    issue({ number: 3, labels: ['wayfinder:map'], body: 'Version 1.2 ships. Then the rest!\n' }),
    issue({ number: 4, labels: ['wayfinder:map'], body: '## What to build\nNo end to it\n\nThe next paragraph.\n' }),
    issue({ number: 5, labels: ['wayfinder:map'], body: '## Parent\n\n#3\n\n## Acceptance criteria\n\n- [ ] Done.\n' }),
    issue({ number: 6, labels: ['wayfinder:map'] }),
    issue({ number: 7, labels: ['wayfinder:map'], body: '真的吗？还有。\n' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  // Read just after the Tasks, it answers from the same read of the Task Source.
  await deck.callTool('deck_tasks')
  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent
  assert.equal((await gh.calls()).length, 1)

  assert.deepEqual(
    maps.map(({ number, kind, isOpen, goal }: any) => ({ number, kind, isOpen, goal })),
    [
      { number: 3, kind: 'map', isOpen: true, goal: 'Version 1.2 ships.' },
      { number: 4, kind: 'map', isOpen: true, goal: 'No end to it' },
      { number: 5, kind: 'map', isOpen: true, goal: null },
      { number: 6, kind: 'map', isOpen: true, goal: null },
      { number: 7, kind: 'map', isOpen: true, goal: '真的吗？' },
      { number: 1, kind: 'spec', isOpen: false, goal: 'The first line runs on。' },
    ],
  )
  assert.deepEqual(maps[5].progress, { closed: 1, inProgress: 0, total: 1 })
})

test('deck_map takes a goal from the first paragraph of text, past lists, quotes, tables, HTML, lines of images and rules, and none from a body with no such paragraph', async t => {
  const map = (number: number, body: string) => issue({ number, labels: ['wayfinder:map'], body })
  const gh = await fakeGh()
  await gh.issues([
    map(1, '1. First step. Second.\n2. Next.\n\nThe goal after a list.\n'),
    map(2, '- one\n- two\n'),
    map(3, '<!-- note -->\nReal goal here.\n'),
    map(4, '<!--\nnot. this\n\nnor this.\n-->\nThe goal after a comment.\n'),
    map(5, '<details>\n<summary>Not this.</summary>\n</details>\n\nThe goal after HTML.\n'),
    map(6, '![alt](x.png)\nGoal.\n'),
    map(7, '| a | b |\n|---|---|\n| 1 | 2 |\n'),
    map(8, '| a | b |\n|---|---|\n| 1 | 2 |\n\nThe goal after a table.\n'),
    map(9, '> quoted. more\n'),
    map(10, '> quoted.\nlazily too.\n\n- - -\nThe goal after a quote and a rule.\n'),
    map(11, `${'x '.repeat(400)}\n`),
    map(12, '1. First step. Second.\n'),
    map(13, '<https://example.com> says it. Then.\n'),
    map(14, '<kbd>K</kbd> opens it. Then.\n'),
    map(15, '<div class="note">\nNot this.\n\n<img src="x.png">\n\nThe goal after a tag alone.\n'),
    map(16, 'A heading\n===\n\nAnother heading\n---\n\nThe goal after headings.\n'),
    map(17, '- an item\n  ```\n  not. this\n\n  nor this.\n  ```\n\nThe goal after a list with code.\n'),
    // A paragraph with no text left once read as text is none.
    map(18, '[![CI](https://x/badge.svg)](https://x/actions)\n\nGoal after one badge. More.\n'),
    map(19, '[![a](a.svg)](https://x) [![b](b.svg)](https://y)\n\nGoal after badges. More.\n'),
    map(20, '[](https://x)\n'),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.deepEqual(
    maps.map(({ number, goal }: any) => [number, goal]),
    [
      [1, 'The goal after a list.'],
      [2, null],
      [3, 'Real goal here.'],
      [4, 'The goal after a comment.'],
      [5, 'The goal after HTML.'],
      [6, 'Goal.'],
      [7, null],
      [8, 'The goal after a table.'],
      [9, null],
      [10, 'The goal after a quote and a rule.'],
      [11, 'x '.repeat(400).trim()],
      [12, null],
      [13, 'https://example.com says it.'],
      [14, 'K opens it.'],
      [15, 'The goal after a tag alone.'],
      [16, 'The goal after headings.'],
      [17, 'The goal after a list with code.'],
      [18, 'Goal after one badge.'],
      [19, 'Goal after badges.'],
      [20, null],
    ],
  )
})

test('deck_map takes no goal from a table without leading pipes, an item\'s paragraph after a blank line, indented code, details, a definition of a link or footnote, or a paragraph of zero-width characters', async t => {
  const map = (number: number, body: string) => issue({ number, labels: ['wayfinder:map'], body })
  const gh = await fakeGh()
  await gh.issues([
    map(1, 'a | b\n--- | ---\n1 | 2\n\nReal goal.\n'),
    map(2, '- item\n\n  continued in the item.\n\nReal goal.\n'),
    map(3, '1. item\n\n   continued.\n\nReal goal.\n'),
    map(4, '    code here\n\nReal goal.\n'),
    map(5, '\tcode here\n\nReal goal.\n'),
    map(6, '<details>\n<summary>s</summary>\n\nhidden text.\n\n</details>\n\nReal goal.\n'),
    map(7, '<details>\n\nhidden text.\n\nMore hidden.\n'),
    map(8, '[doc]: https://x.y\n\nReal goal.\n'),
    map(9, '[^1]: note\n\nReal goal.\n'),
    map(10, '\u200B\n\nReal goal.\n'),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.deepEqual(
    maps.map(({ number, goal }: any) => [number, goal]),
    [
      [1, 'Real goal.'],
      [2, 'Real goal.'],
      [3, 'Real goal.'],
      [4, 'Real goal.'],
      [5, 'Real goal.'],
      [6, 'Real goal.'],
      [7, null],
      [8, 'Real goal.'],
      [9, 'Real goal.'],
      [10, 'Real goal.'],
    ],
  )
})

test('deck_map gives a goal as text: inline HTML, autolinks, strikethrough, reference links and images, footnotes, entities and links with parentheses as what they show', async t => {
  const map = (number: number, body: string) => issue({ number, labels: ['wayfinder:map'], body })
  const gh = await fakeGh()
  await gh.issues([
    map(1, 'First<br>second line. Next.\n'),
    map(2, 'See <a href="https://x.y">the doc</a> now. Next.\n'),
    map(3, 'Press <kbd>Ctrl</kbd> now. Next.\n'),
    map(4, 'Keep <!-- x --> going. Next.\n'),
    map(5, 'See <https://x.y/z> now. Next.\n'),
    map(6, '~~old~~ new goal. Next.\n'),
    map(7, 'See [the doc][doc] now. Next.\n'),
    map(8, 'See [the doc][] now. Next.\n'),
    map(9, '![alt][img] goal here. Next.\n'),
    map(10, 'Goal here[^1]. Next.\n'),
    map(11, 'A &amp; B &nbsp; C. Next.\n'),
    map(12, 'A &#38; B &#x26; C. Next.\n'),
    map(13, 'Write &lt;br&gt; here. Next.\n'),
    map(14, 'See [wiki](https://en.wikipedia.org/wiki/A_(b)) now. Next.\n'),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.deepEqual(
    maps.map(({ number, goal }: any) => [number, goal]),
    [
      [1, 'First second line.'],
      [2, 'See the doc now.'],
      [3, 'Press Ctrl now.'],
      [4, 'Keep going.'],
      [5, 'See https://x.y/z now.'],
      [6, 'old new goal.'],
      [7, 'See the doc now.'],
      [8, 'See the doc now.'],
      [9, 'goal here.'],
      [10, 'Goal here.'],
      [11, 'A & B C.'],
      [12, 'A & B & C.'],
      [13, 'Write <br> here.'],
      [14, 'See wiki now.'],
    ],
  )
})

test('deck_map still takes a goal from an indented line within a paragraph, a pipe with no delimiter row under it, a lone < or ~~, details closed on its line, text in another HTML block, past a block a line of white space ends, and from a line like a definition with no address', async t => {
  const map = (number: number, body: string) => issue({ number, labels: ['wayfinder:map'], body })
  const gh = await fakeGh()
  await gh.issues([
    map(1, 'Text line\n    indented continuation. Next.\n'),
    map(2, 'Use a | b here. Next.\n'),
    map(3, 'When a < b and c > d holds. Next.\n'),
    map(4, 'About ~5 items and ~~ nothing. Next.\n'),
    map(5, '<details><summary>s</summary>x</details>\n\nReal goal.\n'),
    map(6, '<div align="center">\n\nShown text.\n\n</div>\n'),
    map(7, '> quoted.\n    \nReal goal.\n'),
    map(8, '<div>\n\t\nShown text.\n'),
    map(9, '[Note]: this matters? Next.\n'),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.deepEqual(
    maps.map(({ number, goal }: any) => [number, goal]),
    [
      [1, 'Text line indented continuation.'],
      [2, 'Use a | b here.'],
      [3, 'When a < b and c > d holds.'],
      [4, 'About ~5 items and ~~ nothing.'],
      [5, 'Real goal.'],
      [6, 'Shown text.'],
      [7, 'Real goal.'],
      [8, 'Shown text.'],
      [9, '[Note]: this matters?'],
    ],
  )
})

test('deck_map gives a goal as text: emphasis, code and links as what they say, images dropped', async t => {
  const map = (number: number, body: string) => issue({ number, labels: ['wayfinder:map'], body })
  const gh = await fakeGh()
  await gh.issues([
    map(1, '**Goal** is this. Then.\n'),
    map(2, 'See [the doc](https://example.com) and `x`. More.\n'),
    map(3, 'An ![icon](i.png) image goes. More.\n'),
    map(4, '*One*, __two__ and _three_ stay, as does `a*b*c` and snake_case_name. More.\n'),
    map(5, 'Code ``a`b`` and `a``b` and ` lone. More.\n'),
    map(6, 'See [`deck_map`](https://x/y) for the tool.\n'),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.deepEqual(
    maps.map(({ number, goal }: any) => [number, goal]),
    [
      [1, 'Goal is this.'],
      [2, 'See the doc and x.'],
      [3, 'An image goes.'],
      [4, 'One, two and three stay, as does a*b*c and snake_case_name.'],
      [5, 'Code a`b and a``b and ` lone.'],
      [6, 'See deck_map for the tool.'],
    ],
  )
})

test('deck_map reads a goal from a long line of unclosed code, emphasis, links and images about as fast as from plain words', async t => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const timed = async (text: string) => {
    await gh.issues([issue({ number: 10, labels: ['wayfinder:map'], body: `${text}\n` })])
    await deck.callTool('deck_tasks', { refresh: true })
    const start = await deck.cpuMs()
    const { structuredContent } = await deck.callTool('deck_map', { session: 'this-session' })
    return { ms: (await deck.cpuMs()) - start, goal: structuredContent.maps[0].goal }
  }
  const unit = '*a _a **a __a [a ![a '
  // A run of backticks no other run as long closes, then the rest.
  const line = `a ${'`'.repeat(LONG / 2)} ${unit.repeat(Math.floor(LONG / 2 / unit.length)).trim()}`
  const plain = 'ab '.repeat(Math.ceil(line.length / 3)).slice(0, line.length).trim()
  // The first read warms the Deck service up.
  await timed(plain)
  const plainMs = (await timed(plain)).ms
  const withLine = await timed(line)

  assert.equal(withLine.goal, line)
  assert.ok(withLine.ms - plainMs < 1000, `${withLine.ms} ms with the line, ${plainMs} ms without`)
})

test('deck_map reads a goal from a long line of unclosed tags, comments, strikethrough, entities, reference links, footnotes and links with parentheses about as fast as from plain words', async t => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const timed = async (text: string) => {
    await gh.issues([issue({ number: 10, labels: ['wayfinder:map'], body: `${text}\n` })])
    await deck.callTool('deck_tasks', { refresh: true })
    const start = await deck.cpuMs()
    const { structuredContent } = await deck.callTool('deck_map', { session: 'this-session' })
    return { ms: (await deck.cpuMs()) - start, goal: structuredContent.maps[0].goal }
  }
  const unit = '<a <!-- ~~a &a &#1 [x][ [^ [x](a( '
  const line = unit.repeat(Math.floor(LONG / unit.length)).trim()
  const plain = 'ab '.repeat(Math.ceil(line.length / 3)).slice(0, line.length).trim()
  // The first read warms the Deck service up.
  await timed(plain)
  const plainMs = (await timed(plain)).ms
  const withLine = await timed(line)
  // A line under a paragraph that a run of spaces as long as GitHub lets a
  // body be leaves no delimiter row.
  const spaces = await timed(`a\n${' '.repeat(65536)}|x`)

  assert.equal(withLine.goal, line)
  assert.ok(withLine.ms - plainMs < 1000, `${withLine.ms} ms with the line, ${plainMs} ms without`)
  assert.equal(spaces.goal, 'a')
  assert.ok(spaces.ms - plainMs < 1000, `${spaces.ms} ms with the spaces, ${plainMs} ms without`)
})

test('deck_map ends a goal\'s sentence at a full stop only before the end or a space and no lower-case letter', async t => {
  const map = (number: number, body: string) => issue({ number, labels: ['wayfinder:map'], body })
  const gh = await fakeGh()
  await gh.issues([
    map(1, 'See e.g. the doc.\n'),
    map(2, 'Ask i.e. the owner. Then go.\n'),
    map(3, 'Fix it. 然后再说。\n'),
    map(4, 'Done? yes. Then.\n'),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.deepEqual(
    maps.map(({ number, goal }: any) => [number, goal]),
    [
      [1, 'See e.g. the doc.'],
      [2, 'Ask i.e. the owner.'],
      [3, 'Fix it.'],
      [4, 'Done?'],
    ],
  )
})

test('deck_map gives a Pending Closeout Spec the closeout check to prefill, the one Claude Code\'s Pane prefills, and no other Spec or Map one', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1 }),
    issue({ number: 2, parent: 1, state: 'CLOSED' }),
    issue({ number: 3, parent: 1, state: 'CLOSED' }),
    // A Child Task still open.
    issue({ number: 10 }),
    issue({ number: 11, parent: 10, state: 'CLOSED' }),
    issue({ number: 12, parent: 10 }),
    // A Map, and a closed Spec, with every Child Task closed.
    issue({ number: 20, labels: ['wayfinder:map'] }),
    issue({ number: 21, parent: 20, state: 'CLOSED' }),
    issue({ number: 30, state: 'CLOSED' }),
    issue({ number: 31, parent: 30, state: 'CLOSED' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.deepEqual(
    maps.map(({ number, isPendingCloseout, closeoutPrompt }: any) => ({ number, isPendingCloseout, closeoutPrompt })),
    [
      {
        number: 1,
        isPendingCloseout: true,
        closeoutPrompt:
          '请对当前项目的 Spec #1 做收尾核对。Pane 显示 Child Task 已全部关闭（2/2），这只是触发条件，不是完成或验收通过的证据。\n\n' +
          '先重新读取 Spec 及其全部 Child Task 的正文、评论和当前状态。对照 Spec 的每条用户故事与验收条件，' +
          '逐条核对 Child Task 的交付、最终代码、测试或运行结果，并列出可复核的 Acceptance Evidence 及出处；' +
          '不要只依赖关闭状态或任务自述。说明改动所在的分支、提交或工作区及仓库检查结果，' +
          '区分已验证、未验证和不满足的条目。以“不做”或“重复”关闭的 Child Task，说明原承诺如何满足以及是否有用户确认。\n\n' +
          '在本 Session 中说明核对结论、剩余缺口、对应的 Spec 条目和建议下一步。' +
          '本次只核对并报告，不关闭 Spec，也不自动重开或修改任何 Task；是否关闭 Spec 由用户决定。',
      },
      { number: 10, isPendingCloseout: false, closeoutPrompt: null },
      { number: 20, isPendingCloseout: false, closeoutPrompt: null },
      { number: 30, isPendingCloseout: false, closeoutPrompt: null },
    ],
  )
})

test('deck_map says why the Task Source cannot be read, and takes the id of the Session asking', async t => {
  const gh = await fakeGh()
  await gh.answer({ exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' })
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const failed = await deck.callTool('deck_map', { session: 'this-session' })
  assert.equal(failed.isError, false)
  assert.equal(failed.structuredContent.ok, false)
  assert.equal(failed.structuredContent.failure.kind, 'unauthenticated')

  for (const args of [{}, { session: '' }, { session: 3 }]) {
    const refused = await deck.callTool('deck_map', args)
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /deck_map takes the id of the Session/)
  }
})

test('deck_tasks says why the Task Source cannot be read', async t => {
  const cases = [
    {
      answer: { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' },
      kind: 'unauthenticated',
    },
    {
      answer: { exitCode: 1, stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n' },
      kind: 'offline',
    },
    {
      answer: { exitCode: 1, stderr: 'none of the git remotes configured for this repository point to a known GitHub host.\n' },
      kind: 'no-repository',
    },
    { answer: { exitCode: 1, stderr: 'HTTP 502: Bad Gateway\n' }, kind: 'failed' },
  ]
  for (const { answer, kind } of cases) {
    const gh = await fakeGh()
    await gh.answer(answer)
    const deck = startDeck(await configured(), gh.env)
    t.after(deck.stop)

    const result = await deck.callTool('deck_tasks')

    assert.equal(result.isError, false, kind)
    assert.equal(result.structuredContent.ok, false, kind)
    assert.equal(result.structuredContent.failure.kind, kind)
    assert.equal(result.structuredContent.failure.message, answer.stderr.trim())
  }
})

test('deck_tasks says so when gh is not installed', async t => {
  const empty = await realpath(await mkdtemp(join(tmpdir(), 'deck-path-')))
  const deck = startDeck(await configured(), { PATH: empty })
  t.after(deck.stop)

  const result = await deck.callTool('deck_tasks')

  assert.equal(result.structuredContent.ok, false)
  assert.equal(result.structuredContent.failure.kind, 'gh-missing')
})

test('deck_tasks reads the Task Source once for a burst of reads, and again when told to refresh', async t => {
  const dir = await configured()
  await mkdir(join(dir, '.git'))
  await mkdir(join(dir, 'app'))
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(join(dir, 'app'), gh.env)
  t.after(deck.stop)

  const first = await deck.callTool('deck_tasks')
  await gh.issues([issue({ number: 3, state: 'CLOSED', closedAt: '2026-11-12T09:00:00Z' })])
  const cached = await deck.callTool('deck_tasks')
  const refreshed = await deck.callTool('deck_tasks', { refresh: true })

  assert.deepEqual(numbers(first.structuredContent.groups.ready), [3])
  assert.deepEqual(cached.structuredContent, first.structuredContent)
  assert.deepEqual(numbers(refreshed.structuredContent.groups.done), [3])
  assert.ok(refreshed.structuredContent.fetchedAt >= first.structuredContent.fetchedAt)
  const calls = await gh.calls()
  assert.equal(calls.length, 2)
  // gh runs in the Workspace, where it finds the repository.
  assert.deepEqual(
    calls.map(call => call.cwd),
    [dir, dir],
  )
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['api', 'graphql'])
})

test('deck_tasks does not answer from its cache after a read that failed', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  await deck.callTool('deck_tasks')
  await gh.answer({ exitCode: 1, stderr: 'error connecting to api.github.com\n' })
  const refreshed = await deck.callTool('deck_tasks', { refresh: true })
  const after = await deck.callTool('deck_tasks')

  assert.equal(refreshed.structuredContent.ok, false)
  assert.equal(after.structuredContent.ok, false)
  assert.equal(after.structuredContent.failure.kind, 'offline')
})

test('deck_tasks reads every page of issues', async t => {
  const gh = await fakeGh()
  const page = (nodes: object[], hasNextPage: boolean) => ({
    data: {
      repository: {
        nameWithOwner: 'acme/shop',
        issues: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null } },
      },
    },
  })
  await gh.answer({ stdout: [page([issue({ number: 1 })], true), page([issue({ number: 2 })], false)] })
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(numbers(groups.ready), [1, 2])
  assert.ok((await gh.calls())[0]!.args.includes('--paginate'))
})

// One issue as `gh issue view --json` prints it.
const viewed = ({
  number,
  title = `Task ${number}`,
  state = 'OPEN',
  closedAt = null,
  updatedAt = '2026-11-11T09:00:00Z',
  labels = [],
  assignees = [],
  body = '',
}: {
  number: number
  title?: string
  state?: 'OPEN' | 'CLOSED'
  closedAt?: string | null
  updatedAt?: string
  labels?: string[]
  assignees?: string[]
  body?: string
}) => ({
  number,
  title,
  state,
  closedAt,
  updatedAt,
  url: `https://github.com/acme/shop/issues/${number}`,
  labels: labels.map(name => ({ id: name, name, description: '', color: '000000' })),
  assignees: assignees.map(login => ({ id: login, login, name: '' })),
  body,
})

test('deck_task reads one Task with its description and its acceptance criteria as checked or not', async t => {
  const gh = await fakeGh()
  await gh.answer({
    stdout: viewed({
      number: 9,
      title: '推荐：我现在该做什么',
      labels: ['ready-for-agent'],
      assignees: ['octocat', 'hubot'],
      body: [
        '## Parent',
        '',
        '#1',
        '',
        '## What to build',
        '',
        '点一次按钮，在当前 Session 里运行 `/ask-matt`。',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] 忙碌时请求先被持有，空闲后自动发出',
        '- [x] 持有期间可以取消',
        '',
        '## Blocked by',
        '',
        '- #5',
        '- #8',
        '',
      ].join('\n'),
    }),
  })
  const dir = await configured()
  const deck = startDeck(dir, gh.env)
  t.after(deck.stop)

  const result = await deck.callTool('deck_task', { number: 9 })

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    ok: true,
    task: {
      number: 9,
      title: '推荐：我现在该做什么',
      isOpen: true,
      closedAt: null,
      updatedAt: '2026-11-11T09:00:00Z',
      labels: ['ready-for-agent'],
      assignees: ['octocat', 'hubot'],
      url: 'https://github.com/acme/shop/issues/9',
      // The sections the detail draws elsewhere are not in the description.
      description: '## What to build\n\n点一次按钮，在当前 Session 里运行 `/ask-matt`。',
      acceptance: [
        { text: '忙碌时请求先被持有，空闲后自动发出', isChecked: false },
        { text: '持有期间可以取消', isChecked: true },
      ],
    },
    // No Session has reported on it.
    reports: [],
  })
  const [call] = await gh.calls()
  assert.deepEqual(call!.args.slice(0, 3), ['issue', 'view', '9'])
  assert.equal(call!.cwd, dir)
})

test('deck_task reads a Task whose body has no acceptance criteria', async t => {
  const gh = await fakeGh()
  await gh.answer({
    stdout: viewed({
      number: 15,
      state: 'CLOSED',
      closedAt: '2026-11-11T14:07:00Z',
      body: 'Part of #1\n\n首次配置一个项目。\n\n- 选定 Task Source\n- 选定 Skill Source\n',
    }),
  })
  const empty = await fakeGh()
  await empty.answer({ stdout: viewed({ number: 16 }) })
  const deck = startDeck(await configured(), gh.env)
  const bare = startDeck(await configured(), empty.env)
  t.after(deck.stop)
  t.after(bare.stop)

  const { task } = (await deck.callTool('deck_task', { number: 15 })).structuredContent
  const { task: blank } = (await bare.callTool('deck_task', { number: 16 })).structuredContent

  assert.equal(task.isOpen, false)
  assert.equal(task.closedAt, '2026-11-11T14:07:00Z')
  // A plain list is description, not acceptance criteria.
  assert.equal(task.description, '首次配置一个项目。\n\n- 选定 Task Source\n- 选定 Skill Source')
  assert.deepEqual(task.acceptance, [])
  assert.equal(blank.description, '')
  assert.deepEqual(blank.acceptance, [])
})

test('deck_task leaves a code block of the body as it is', async t => {
  const gh = await fakeGh()
  await gh.answer({
    stdout: viewed({
      number: 17,
      body: ['正文写成这样：', '', '```md', '## Parent', '- [ ] 示例', '```', '', '之后的话。', '', '- [x] 真的一项', ''].join('\n'),
    }),
  })
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { task } = (await deck.callTool('deck_task', { number: 17 })).structuredContent

  // Neither a heading nor a checklist item in a code block is one.
  assert.equal(task.description, '正文写成这样：\n\n```md\n## Parent\n- [ ] 示例\n```\n\n之后的话。')
  assert.deepEqual(task.acceptance, [{ text: '真的一项', isChecked: true }])
})

test('deck_task drops a `Part of` or `Blocked by:` line only at the top of the body', async t => {
  const gh = await fakeGh()
  await gh.answer({
    stdout: viewed({
      number: 18,
      body: 'Part of #1\nBlocked by: #3, #4\n\n登录的一部分。\n\nPart of #2 的做法不适用。\nBlocked by: 上游还没定。\n',
    }),
  })
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { task } = (await deck.callTool('deck_task', { number: 18 })).structuredContent

  assert.equal(task.description, '登录的一部分。\n\nPart of #2 的做法不适用。\nBlocked by: 上游还没定。')
})

test('deck_task drops Parent, Blocked by and Acceptance criteria headings regardless of case or emphasis, while keeping look-alike and ordinary headings after them', async t => {
  const gh = await fakeGh()
  await gh.answer({
    stdout: viewed({
      number: 19,
      body: [
        '# parent',
        '',
        '#1',
        '',
        '## Parenthood',
        '',
        'Parenting note stays.',
        '',
        '## **Parent**',
        '',
        '#2',
        '',
        '## Blocked byline',
        '',
        'Byline stays.',
        '',
        '### *Blocked by*',
        '',
        '- #5',
        '',
        '### BLOCKED BY',
        '',
        '- #6',
        '',
        '## User guide',
        '',
        'Open the guide.',
        '- [x] First item',
        '',
        '## ACCEPTANCE CRITERIA',
        '',
        'Plain text in this section is dropped.',
        '- [ ] Second item',
        '- [X] Third item',
        '',
        '## Acceptance criteria2',
        '',
        'Look-alike stays.',
        '',
        '## ***Acceptance Criteria***',
        '',
        '- [ ] Fourth item',
        '',
        '## ** Parent **',
        '',
        '#3',
        '',
        '## After',
        '',
        'End stays.',
      ].join('\n'),
    }),
  })
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { task } = (await deck.callTool('deck_task', { number: 19 })).structuredContent

  assert.equal(
    task.description,
    [
      '## Parenthood',
      '',
      'Parenting note stays.',
      '',
      '## Blocked byline',
      '',
      'Byline stays.',
      '',
      '## User guide',
      '',
      'Open the guide.',
      '',
      '## Acceptance criteria2',
      '',
      'Look-alike stays.',
      '',
      '## After',
      '',
      'End stays.',
    ].join('\n'),
  )
  assert.deepEqual(task.acceptance, [
    { text: 'First item', isChecked: true },
    { text: 'Second item', isChecked: false },
    { text: 'Third item', isChecked: true },
    { text: 'Fourth item', isChecked: false },
  ])
})

test('deck_task and deck_map keep fenced headings and checklists verbatim and agree on goal past emphasized or cased dropped sections', async t => {
  const gh = await fakeGh()
  const taskBody = [
    '## User guide',
    '',
    '~~~md',
    '## **Parent**',
    '## ACCEPTANCE CRITERIA',
    '- [x] Fenced item',
    '~~~',
    '',
    'After fence.',
    '- [x] Real item',
  ].join('\n')
  await gh.answer({ stdout: viewed({ number: 20, body: taskBody }) })
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { task } = (await deck.callTool('deck_task', { number: 20 })).structuredContent
  await gh.issues([
    issue({
      number: 1,
      labels: ['wayfinder:map'],
      body: '## **Parent**\n#1\n\n## *Blocked by*\n#2\n\n## ACCEPTANCE CRITERIA\n- [ ] Ready.\n\n## Parenthood\nGoal after look-alike. More.\n',
    }),
    issue({
      number: 2,
      labels: ['wayfinder:map'],
      body: '## **Parent**\n#1\n\n## User guide\n~~~md\n## BLOCKED BY\nFake goal.\n~~~\n\nReal goal here. Then.\n',
    }),
    issue({
      number: 3,
      labels: ['wayfinder:map'],
      body: '## Parent\n#1\n\n## BLOCKED BY\n#2\n\n## ACCEPTANCE CRITERIA\n- [x] Done.\n',
    }),
    issue({
      number: 4,
      labels: ['wayfinder:map'],
      body: '```\nInside fence.\n```\n\n## ACCEPTANCE CRITERIA\nNot a goal.\n',
    }),
  ])
  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  assert.equal(task.description, '## User guide\n\n~~~md\n## **Parent**\n## ACCEPTANCE CRITERIA\n- [x] Fenced item\n~~~\n\nAfter fence.')
  assert.deepEqual(task.acceptance, [{ text: 'Real item', isChecked: true }])
  assert.deepEqual(
    maps.map(({ number, goal }: any) => [number, goal]),
    [
      [1, 'Goal after look-alike.'],
      [2, 'Real goal here.'],
      [3, null],
      [4, null],
    ],
  )
})

// Bodies as long as GitHub lets one be, 65536 characters, whose lines are
// blank or only white space until their end or until text, each with the
// description and the goal read from it. A read whose time grows with the
// body's length takes some milliseconds more on one; one whose time grows
// with its square, seconds more.
const BLANK_TOP = 65536
const SENTENCE = 'Goal is this one.'
const PART_OF = 'Part of #1\n'
// Half the body blank lines, then as many `Part of` lines as fill the rest.
const PARTS_OF = PART_OF.repeat(Math.floor(BLANK_TOP / 2 / PART_OF.length))
const BLANK_TOPS = [
  { body: '\n'.repeat(BLANK_TOP), description: '', goal: null },
  { body: `${'\n'.repeat(BLANK_TOP - SENTENCE.length)}${SENTENCE}`, description: SENTENCE, goal: SENTENCE },
  { body: '\r\n'.repeat(BLANK_TOP / 2), description: '', goal: null },
  { body: ' \n'.repeat(BLANK_TOP / 2), description: '', goal: null },
  { body: `${'\n'.repeat(BLANK_TOP - PARTS_OF.length)}${PARTS_OF}`, description: '', goal: null },
]
const PLAIN_BODY = 'ab '.repeat(BLANK_TOP / 2).slice(0, BLANK_TOP)

test('deck_task reads a body whose top is a long run of blank lines about as fast as plain words, and as before', async t => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const timed = async (body: string) => {
    await gh.answer({ stdout: viewed({ number: 9, body }) })
    const start = await deck.cpuMs()
    const { task } = (await deck.callTool('deck_task', { number: 9 })).structuredContent
    return { ms: (await deck.cpuMs()) - start, task }
  }
  // The first read warms the Deck service up.
  await timed(PLAIN_BODY)
  const plainMs = (await timed(PLAIN_BODY)).ms

  for (const [index, { body, description }] of BLANK_TOPS.entries()) {
    const { ms, task } = await timed(body)
    assert.deepEqual([task.description, task.acceptance], [description, []], `body ${index}`)
    assert.ok(ms - plainMs < 1000, `body ${index}: ${ms} ms, ${plainMs} ms with plain words`)
  }
})

test('deck_map reads the goal of a Map whose body\'s top is a long run of blank lines about as fast as from plain words, and as before', async t => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const timed = async (body: string) => {
    await gh.issues([issue({ number: 10, labels: ['wayfinder:map'], body })])
    await deck.callTool('deck_tasks', { refresh: true })
    const start = await deck.cpuMs()
    const { structuredContent } = await deck.callTool('deck_map', { session: 'this-session' })
    return { ms: (await deck.cpuMs()) - start, goal: structuredContent.maps[0].goal }
  }
  // The first read warms the Deck service up.
  await timed(PLAIN_BODY)
  const plainMs = (await timed(PLAIN_BODY)).ms

  for (const [index, { body, goal }] of BLANK_TOPS.entries()) {
    const read = await timed(body)
    assert.equal(read.goal, goal, `body ${index}`)
    assert.ok(read.ms - plainMs < 1000, `body ${index}: ${read.ms} ms, ${plainMs} ms with plain words`)
  }
})

// Heading lines at GitHub's 65,536-character limit (and a shorter 16,384-char
// one) whose prefix spaces and stars do not match a section drawn elsewhere
// must be checked in time linear in the line's length.
const SHORT_HEADING_LENGTH = 16384
const MAX_HEADING_LENGTH = BLANK_TOP
const LONG_HEADINGS: { name: string; body: string; description?: string; plain: string }[] = [
  {
    name: 'short heading with spaces',
    body: `# ${' '.repeat(SHORT_HEADING_LENGTH - 3)}x`,
    plain: PLAIN_BODY.slice(0, SHORT_HEADING_LENGTH),
  },
  {
    name: '65536 heading with spaces',
    body: `# ${' '.repeat(MAX_HEADING_LENGTH - 3)}x`,
    plain: PLAIN_BODY,
  },
  {
    name: '65536 heading with spaces and stars',
    body: `## ${' '.repeat(32765)}${'*'.repeat(32766)} x`,
    plain: PLAIN_BODY,
  },
  {
    name: '65536 heading with stars then spaces',
    body: `## ${'*'.repeat(32766)}${' '.repeat(32765)} x`,
    plain: PLAIN_BODY,
  },
  {
    name: '65536 leading spaces before heading',
    body: `${' '.repeat(MAX_HEADING_LENGTH - 4)}## x`,
    description: '## x',
    plain: PLAIN_BODY,
  },
  {
    name: '65536 heading with spaces before Parent',
    body: `## ${' '.repeat(MAX_HEADING_LENGTH - 32)}Parent\n#1\n\n## User guide\nkept`,
    description: '## User guide\nkept',
    plain: PLAIN_BODY,
  },
]

test('deck_task reads long heading lines of spaces and stars about as fast as equal-length plain words', async t => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const timed = async (body: string) => {
    await gh.answer({ stdout: viewed({ number: 9, body }) })
    const start = await deck.cpuMs()
    const { task } = (await deck.callTool('deck_task', { number: 9 })).structuredContent
    return { ms: (await deck.cpuMs()) - start, task }
  }
  // Warm up the Deck service and measure plain-word baselines once per length.
  await timed(PLAIN_BODY)
  const plainTimes = new Map<number, number>()
  for (const { plain } of LONG_HEADINGS) {
    if (!plainTimes.has(plain.length)) {
      plainTimes.set(plain.length, (await timed(plain)).ms)
    }
  }

  for (const { name, body, description = body, plain } of LONG_HEADINGS) {
    const plainMs = plainTimes.get(plain.length)!
    const { ms, task } = await timed(body)
    assert.deepEqual([task.description, task.acceptance], [description, []], name)
    assert.ok(ms - plainMs < 1000, `${name}: ${ms} ms, ${plainMs} ms with plain words`)
  }
})

test('deck_map reads the goal past a 65536-character heading line about as fast as from plain words', async t => {
  const gh = await fakeGh()
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const timed = async (body: string) => {
    await gh.issues([issue({ number: 10, labels: ['wayfinder:map'], body })])
    await deck.callTool('deck_tasks', { refresh: true })
    const start = await deck.cpuMs()
    const { structuredContent } = await deck.callTool('deck_map', { session: 'this-session' })
    return { ms: (await deck.cpuMs()) - start, goal: structuredContent.maps[0].goal }
  }
  await timed(PLAIN_BODY)
  const plainMs = (await timed(PLAIN_BODY)).ms
  const headingBody = `# ${' '.repeat(MAX_HEADING_LENGTH - SENTENCE.length - 6)}x\n\n${SENTENCE}`

  const read = await timed(headingBody)

  assert.equal(read.goal, SENTENCE)
  assert.ok(read.ms - plainMs < 1000, `${read.ms} ms with the heading, ${plainMs} ms without`)
})

test('deck_task says why the Task cannot be read, and takes only a Task number', async t => {
  const gh = await fakeGh()
  await gh.answer({ exitCode: 1, stderr: 'GraphQL: Could not resolve to an issue or pull request with the number of 999.\n' })
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const missing = await deck.callTool('deck_task', { number: 999 })
  const malformed = await Promise.all([{}, { number: '9' }, { number: 0 }, { number: 1.5 }].map(args => deck.callTool('deck_task', args)))

  assert.equal(missing.isError, false)
  assert.deepEqual(missing.structuredContent, {
    ok: false,
    failure: { kind: 'failed', message: 'GraphQL: Could not resolve to an issue or pull request with the number of 999.' },
  })
  assert.deepEqual(
    malformed.map(result => result.isError),
    [true, true, true, true],
  )
  // Only the one read reached gh.
  assert.equal((await gh.calls()).length, 1)
})

// A skill file with the frontmatter Matt skills carry, and a body.
const skillFile = async (dir: string, name: string, description: string, body = `# ${name}\n`) => {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`)
}

// A workspace configured with `skillSource`, and a home to hold it.
const withSkillSource = async (skillSource: object) => {
  const user = await home()
  const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource }))

  return { dir, user }
}

test('deck_skills lists the skills of a directory Skill Source, each with its call and description', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const skills = join(user, '.claude', 'skills')
  await skillFile(skills, 'tdd', '先写测试，再写实现。')
  await skillFile(skills, 'ask-matt', '问下一步该做什么。')
  await skillFile(skills, 'implement', '"开始做一个 Task。"')
  // A directory holding no skill file is no skill.
  await mkdir(join(skills, 'notes'))
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    ok: true,
    source: { type: 'directory', path: '~/.claude/skills' },
    skills: [
      { name: 'ask-matt', call: '/ask-matt', description: '问下一步该做什么。', path: '~/.claude/skills/ask-matt/SKILL.md' },
      { name: 'implement', call: '/implement', description: '开始做一个 Task。', path: '~/.claude/skills/implement/SKILL.md' },
      { name: 'tdd', call: '/tdd', description: '先写测试，再写实现。', path: '~/.claude/skills/tdd/SKILL.md' },
    ],
  })
})

test('deck_skills reads a description written as a block over several lines as one line', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const skills = join(user, '.claude', 'skills')
  await skillFile(skills, 'folded', '>\n  先让它能用，\n  再把它做对。')
  await skillFile(skills, 'kept', '|-\n  第一行\n\n  第二行')
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, description }: any) => [name, description]),
    [
      ['folded', '先让它能用， 再把它做对。'],
      ['kept', '第一行 第二行'],
    ],
  )
})

test('deck_skills trims only field boundaries, keeping inner spaces, paired quotes\' spaces, colons and block rules', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const skills = join(user, '.claude', 'skills')
  for (const [folder, text] of [
    ['spaced-quoted', '---\nname:   "spaced-quoted"   \ndescription:   "Read   this field."   \n---\n'],
    ['plain-name', '---\nname:   plain-name   \ndescription:\t  "  kept   inside  "  \t\n---\n'],
    ['single-quoted', '---\nname: single-quoted\ndescription:   \'  single   inside  \'   \n---\n'],
    ['inner-spaces', '---\nname: inner-spaces\ndescription:   keep   middle   spaces   \n---\n'],
    ['colons', '---\nname: colons\ndescription:   Build for AWS: ECS: prod   \n---\n'],
    ['empty-fields', '---\nname:\ndescription:   \n---\n'],
    ['quoted-marker', '---\nname: quoted-marker\ndescription: ">"\n---\n'],
    ['mismatched', '---\nname: mismatched\ndescription: "not-closed\'\n---\n'],
    ['single-quote-only', '---\nname: single-quote-only\ndescription: "\n---\n'],
    [
      'block-then-field',
      '---\nname: block-then-field\ndescription: |+   \n  first   line  \n\n  second line  \nother: ignored\n  after other\n---\n',
    ],
    ['block-empty', '---\nname: block-empty\ndescription: >-\n   \nother: value\n---\n'],
    ['block-fold-plus', '---\nname: block-fold-plus\ndescription: >+\n  one\n  two\n---\n'],
  ]) {
    await rawSkill(skills, folder!, text!)
  }
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, description }: any) => [name, description]),
    [
      ['block-empty', ''],
      ['block-fold-plus', 'one two'],
      ['block-then-field', 'first   line second line'],
      ['colons', 'Build for AWS: ECS: prod'],
      ['empty-fields', ''],
      ['inner-spaces', 'keep   middle   spaces'],
      ['mismatched', '"not-closed\''],
      ['plain-name', '  kept   inside  '],
      ['quoted-marker', '>'],
      ['single-quote-only', '"'],
      ['single-quoted', '  single   inside  '],
      ['spaced-quoted', 'Read   this field.'],
    ],
  )
})

test('deck_skills reads a line whose value holds a carriage return or a Unicode line or paragraph separator as no field, so under a block it goes on the block', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const skills = join(user, '.claude', 'skills')
  await rawSkill(skills, 'under-block', '---\nname: under-block\ndescription: >\n  x\nother: a\u2028b\n  y\n---\n')
  await rawSkill(skills, 'edges', '---\nname: edges\ndescription:\u2029 kept \r\n---\n')
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, description }: any) => [name, description]),
    [
      ['edges', 'kept'],
      ['under-block', 'x other: a\u2028b y'],
    ],
  )
})

test('deck_skills calls the skills of a plugin Skill Source with the plugin prefix, from every folder of it', async t => {
  const { dir, user } = await withSkillSource({ type: 'plugin', name: 'mattpocock-skills' })
  const matt = join(user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skillFile(join(matt, 'skills', 'engineering'), 'tdd', '先写测试，再写实现。')
  await skillFile(join(matt, 'skills', 'productivity'), 'ask-matt', '问下一步该做什么。')
  // The same plugin installed for another project only is not the one used.
  const elsewhere = join(user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '0.9.0')
  await skillFile(join(elsewhere, 'skills'), 'old', '旧版。')
  await installedPlugins(user, {
    'mattpocock-skills@official': [
      { scope: 'project', projectPath: '/somewhere/else', installPath: elsewhere },
      { scope: 'user', installPath: matt },
    ],
  })
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  const base = '~/.claude/plugins/cache/official/mattpocock-skills/1.3.1/skills'
  assert.deepEqual(result.structuredContent, {
    ok: true,
    source: { type: 'plugin', name: 'mattpocock-skills' },
    // By name, whichever folder each lies in.
    skills: [
      {
        name: 'ask-matt',
        call: '/mattpocock-skills:ask-matt',
        description: '问下一步该做什么。',
        path: `${base}/productivity/ask-matt/SKILL.md`,
      },
      { name: 'tdd', call: '/mattpocock-skills:tdd', description: '先写测试，再写实现。', path: `${base}/engineering/tdd/SKILL.md` },
    ],
  })
})

test('a Deck service started for Codex calls every skill as $name, a plugin\'s too, and so the Recommendation Request', async t => {
  const fromDirectory = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillFile(join(fromDirectory.user, '.claude', 'skills'), 'ask-matt', '问下一步该做什么。')
  const fromPlugin = await withSkillSource({ type: 'plugin', name: 'mattpocock-skills' })
  const matt = join(fromPlugin.user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skillFile(join(matt, 'skills', 'engineering'), 'tdd', '先写测试，再写实现。')
  await installedPlugins(fromPlugin.user, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const directoryDeck = startDeck(fromDirectory.dir, { ...gh.env, HOME: fromDirectory.user }, 'codex')
  t.after(directoryDeck.stop)
  const pluginDeck = startDeck(fromPlugin.dir, { HOME: fromPlugin.user }, 'codex')
  t.after(pluginDeck.stop)

  const listed = await directoryDeck.callTool('deck_skills')
  const read = await pluginDeck.callTool('deck_skill', { name: 'tdd' })
  const asked = await directoryDeck.callTool('deck_ask')

  assert.deepEqual(
    listed.structuredContent.skills.map(({ name, call }: any) => ({ name, call })),
    [{ name: 'ask-matt', call: '$ask-matt' }],
  )
  assert.equal(read.structuredContent.skill.call, '$tdd')
  assert.equal(asked.structuredContent.ok, true)
  assert.equal(asked.structuredContent.call, '$ask-matt')
  // The text the Pane in a tab prefills: the call, then its arguments.
  assert.equal(
    asked.structuredContent.prompt,
    `$ask-matt ${askArgs(asked.structuredContent.requestId, ['Specs and Maps: none', 'Ready:', '- #3 Task 3', 'In progress: none', 'Blocked: none', 'Done: 0 Tasks closed'].join('\n'))}`,
  )
})

test('deck_skills reads a directory Skill Source written as an absolute path', async t => {
  const user = await home()
  const skills = join(user, 'matt-skills')
  await skillFile(skills, 'tdd', '先写测试，再写实现。')
  const dir = await workspace(JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: skills } }))
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, path }: any) => [name, path]),
    [['tdd', `${skills}/tdd/SKILL.md`]],
  )
})

test('started for Codex, deck_skills says of each skill whether Codex finds this same file by its name, found, another, or not at all', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const source = join(user, '.claude', 'skills')
  for (const name of ['ask-matt', 'implement', 'tdd', 'wayfinder', 'grill']) {
    await skillFile(source, name, `${name} 的说明。`)
  }
  const userSkills = join(user, '.agents', 'skills')
  await mkdir(userSkills, { recursive: true })
  // The user's Codex skills link implement's folder, and grill's; the
  // project's link implement's folder too, the same file found twice.
  await symlink(join(source, 'implement'), join(userSkills, 'implement'))
  await symlink(join(source, 'grill'), join(userSkills, 'grill'))
  await mkdir(join(dir, '.agents', 'skills'), { recursive: true })
  await symlink(join(source, 'implement'), join(dir, '.agents', 'skills', 'implement'))
  // The project's link ask-matt's file itself, a link Codex does not follow.
  await mkdir(join(dir, '.codex', 'skills', 'ask-matt'), { recursive: true })
  await symlink(join(source, 'ask-matt', 'SKILL.md'), join(dir, '.codex', 'skills', 'ask-matt', 'SKILL.md'))
  // A copy of tdd with the same words is another file; so is the copy of
  // grill beside the link to it.
  await skillFile(join(dir, '.agents', 'skills'), 'tdd', 'tdd 的说明。')
  await skillFile(join(dir, '.agents', 'skills'), 'grill', 'grill 的说明。')
  // triage's folder in the Skill Source is itself a link to a third place,
  // which the user's Codex skills link too.
  const elsewhere = join(user, 'matt-skills')
  await skillFile(elsewhere, 'triage', 'triage 的说明。')
  await symlink(join(elsewhere, 'triage'), join(source, 'triage'))
  await symlink(join(elsewhere, 'triage'), join(userSkills, 'triage'))
  const codex = startDeck(dir, { HOME: user }, 'codex')
  const claudeCode = startDeck(dir, { HOME: user })
  t.after(codex.stop)
  t.after(claudeCode.stop)

  const forCodex = await codex.callTool('deck_skills')
  const forClaudeCode = await claudeCode.callTool('deck_skills')

  assert.equal(forCodex.isError, false)
  assert.deepEqual(
    forCodex.structuredContent.skills.map(({ name, copy }: any) => [name, copy]),
    [
      ['ask-matt', 'missing'],
      ['grill', 'several'],
      ['implement', 'same'],
      ['tdd', 'different'],
      ['triage', 'same'],
      ['wayfinder', 'missing'],
    ],
  )
  // Claude Code reads the Skill Source itself: there is no copy to compare.
  assert.equal(forClaudeCode.structuredContent.skills.some((skill: any) => 'copy' in skill), false)
})

// A skill file in `folder` under `dir` whose frontmatter names it `name`,
// whatever the folder is called.
const skillNamed = async (dir: string, folder: string, name: string) => {
  await mkdir(join(dir, folder), { recursive: true })
  await writeFile(join(dir, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的说明。\n---\n\n# ${name}\n`)
}

const copies = (result: any) => result.structuredContent.skills.map(({ name, copy }: any) => [name, copy])

test('started for Codex, deck_skills says a skill is several where Codex finds more than one file of its name, this one among them or not, and different where it finds one other file alone', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/my-skills' })
  const source = join(user, 'my-skills')
  for (const name of ['ask-matt', 'implement', 'tdd']) {
    await skillFile(source, name, `${name} 的说明。`)
  }
  const userSkills = join(user, '.agents', 'skills')
  await mkdir(userSkills, { recursive: true })
  // ask-matt: this file, linked, and another beside it.
  await symlink(join(source, 'ask-matt'), join(userSkills, 'ask-matt'))
  await skillFile(join(user, '.codex', 'skills'), 'ask-matt', 'Another ask-matt.')
  // implement: two other files, neither this one.
  await skillFile(userSkills, 'implement', 'One other implement.')
  await skillFile(join(user, '.codex', 'skills'), 'implement', 'Another implement.')
  // tdd: one other file alone.
  await skillFile(userSkills, 'tdd', 'Another tdd.')
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  assert.deepEqual(copies(await codex.callTool('deck_skills')), [
    ['ask-matt', 'several'],
    ['implement', 'several'],
    ['tdd', 'different'],
  ])
})

test('started for Codex, deck_skills finds a skill by the name its file gives, as Codex does, whatever its folder is called', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  await skillNamed(join(user, '.agents', 'skills'), 'grill-me', 'grilling')
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, call, copy }: any) => ({ name, call, copy })),
    [{ name: 'grilling', call: '$grilling', copy: 'same' }],
  )
})

test('started for Codex, deck_skills finds no copy of a skill whose name $ cannot call, a path among them, wherever its file is', async t => {
  // Codex lists a skill named a/b, but $a/b calls nothing; a name written
  // as a path is no path to Deck.
  const inCodex = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  await skillNamed(join(inCodex.user, '.agents', 'skills'), 'ab', 'a/b')
  await skillNamed(join(inCodex.user, '.agents', 'skills'), 'tdd', 'tdd')
  const outside = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillNamed(join(outside.user, '.claude', 'skills'), 'walker', '../../.claude/skills/walker')
  await mkdir(join(outside.user, '.agents', 'skills'), { recursive: true })
  const decks = [inCodex, outside].map(({ dir, user }) => startDeck(dir, { HOME: user }, 'codex'))
  for (const deck of decks) {
    t.after(deck.stop)
  }

  const [ofCodex, ofOutside] = await Promise.all(decks.map(deck => deck.callTool('deck_skills')))

  assert.deepEqual(copies(ofCodex), [
    ['a/b', 'missing'],
    ['tdd', 'same'],
  ])
  assert.deepEqual(copies(ofOutside), [['../../.claude/skills/walker', 'missing']])
})

test('started for Codex, deck_skills finds no copy of a skill whose file Codex does not load: no description, or an empty one, no frontmatter as Codex reads one, or a name past 64 characters', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  const long = (n: number) => 'a'.repeat(n)
  for (const [folder, text] of [
    ['no-description', '---\nname: no-description\n---\n'],
    ['empty-description', '---\nname: empty-description\ndescription:\n---\n'],
    ['quoted-empty', '---\nname: quoted-empty\ndescription: ""\n---\n'],
    ['quoted-blank', '---\nname: quoted-blank\ndescription: "   "\n---\n'],
    ['no-frontmatter', '# no-frontmatter\n\nNo frontmatter.\n'],
    ['unclosed', '---\nname: unclosed\ndescription: Not closed.\n\n# unclosed\n'],
    ['long-65', `---\nname: ${long(65)}\ndescription: Too long a name.\n---\n`],
    ['long-64', `---\nname: ${long(64)}\ndescription: A name just short enough.\n---\n`],
    ['folded', '---\nname: folded\ndescription: >\n  Folded over\n  two lines.\n---\n'],
    ['literal', '---\nname: literal\ndescription: |\n  Kept as written.\n---\n'],
    ['very-long', `---\nname: very-long\ndescription: ${long(2000)}\n---\n`],
    ['colon', '---\nname: colon\ndescription: Build for AWS: ECS\n---\n'],
    ['unnamed', '---\ndescription: Named by its folder.\n---\n'],
    ['spaced', '--- \nname: spaced\ndescription: Fenced with spaces.\n ---\n'],
    // Codex trims a fence of what Rust takes for space: not a byte order mark.
    ['bom', '\uFEFF---\nname: bom\ndescription: Opens with a byte order mark.\n---\n'],
  ]) {
    await rawSkill(source, folder!, text!)
  }
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    [long(64), 'same'],
    [long(65), 'missing'],
    ['bom', 'missing'],
    ['colon', 'same'],
    ['empty-description', 'missing'],
    ['folded', 'same'],
    ['literal', 'same'],
    ['no-description', 'missing'],
    ['no-frontmatter', 'missing'],
    ['quoted-blank', 'missing'],
    ['quoted-empty', 'missing'],
    ['spaced', 'same'],
    ['unclosed', 'missing'],
    ['unnamed', 'same'],
    ['very-long', 'same'],
  ])
})

test('started for Codex, deck_skills takes a description Deck cannot read as empty for one: on the indented lines below its key, or under a key written otherwise', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  for (const [folder, text] of [
    ['next-line-quoted', '---\nname: next-line-quoted\ndescription:\n  "Use when the user asks."\n---\n'],
    ['next-line', '---\nname: next-line\ndescription:\n  Use when the user asks.\n---\n'],
    ['space-before-colon', '---\nname: space-before-colon\ndescription : Use when the user asks.\n---\n'],
    ['indented', '---\n  name: indented\n  description: Use when the user asks.\n---\n'],
    ['quoted-key', '---\nname: quoted-key\n"description": Use when the user asks.\n---\n'],
    // The value below the key after a blank line, one of space alone, or a
    // comment, its lines ending in LF or CRLF.
    ['after-blank', '---\nname: after-blank\ndescription:\n\n  Use when asked.\n---\n'],
    ['after-space', '---\nname: after-space\ndescription:\n   \n  Use when asked.\n---\n'],
    ['after-comment', '---\nname: after-comment\ndescription:\n# a note\n  Use when asked.\n---\n'],
    ['after-all', '---\nname: after-all\ndescription:\n\n# a note\n\n  Use when asked.\n---\n'],
    ['after-blank-crlf', '---\r\nname: after-blank-crlf\r\ndescription:\r\n\r\n  Use when asked.\r\n---\r\n'],
    // An explicit key, and a flow mapping, its keys quoted or not.
    ['explicit-key', '---\nname: explicit-key\n? description\n: Use when asked.\n---\n'],
    ['flow-map', '---\n{name: flow-map, description: Use when asked.}\n---\n'],
    ['flow-map-quoted', '---\n{"name": "flow-map-quoted", "description": "Use when asked."}\n---\n'],
    // An empty frontmatter holds no description.
    ['empty-frontmatter', '---\n---\n'],
  ]) {
    await rawSkill(source, folder!, text!)
  }
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    ['after-all', 'same'],
    ['after-blank', 'same'],
    ['after-blank-crlf', 'same'],
    ['after-comment', 'same'],
    ['after-space', 'same'],
    ['empty-frontmatter', 'missing'],
    ['explicit-key', 'same'],
    ['flow-map', 'same'],
    ['flow-map-quoted', 'same'],
    ['indented', 'same'],
    ['next-line', 'same'],
    ['next-line-quoted', 'same'],
    ['quoted-key', 'same'],
    ['space-before-colon', 'same'],
  ])
})

test('started for Codex, deck_skills takes no file of the same name Codex does not load for another copy, and one it loads for another', async t => {
  const results = []
  for (const description of ['', 'description: Theirs.\n']) {
    const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
    await skillFile(join(user, '.agents', 'skills'), 'ok', 'Mine.')
    await rawSkill(join(user, '.codex', 'skills'), 'ok', `---\nname: ok\n${description}---\n`)
    const codex = startDeck(dir, { HOME: user }, 'codex')
    t.after(codex.stop)
    results.push(copies(await codex.callTool('deck_skills')))
  }

  assert.deepEqual(results, [[['ok', 'same']], [['ok', 'several']]])
})

test('started for Codex, deck_skills accepts complex YAML frontmatter and non-Rust whitespace, excludes U+0085-only descriptions and nested/empty metadata', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  for (const [folder, text] of [
    ['block', '---\nname: block\n? |-\n  description\n: Works\n---\n'],
    ['escaped', '---\nname: escaped\n"d\\u0065scription": Works\n---\n'],
    ['flow', '---\n{\ndescription:\nWorks\n}\n---\n'],
    ['feff', '---\nname: feff\ndescription: "\uFEFF"\n---\n'],
    ['unquoted-feff', '---\nname: unquoted-feff\ndescription: \uFEFF\n---\n'],
    ['u0085', '---\nname: u0085\ndescription: "\u0085"\n---\n'],
    ['block-u0085', '---\nname: block-u0085\ndescription: >\n  \u0085\n---\n'],
    ['block-feff', '---\nname: block-feff\ndescription: >\n  \uFEFF\n---\n'],
    ['single-blank', "---\nname: single-blank\ndescription: '   '\n---\n"],
    ['comment-only-desc', '---\nname: comment-only-desc\ndescription:   # comment\n---\n'],
    ['escaped-val', '---\nname: escaped-val\ndescription: "\\u0041"\n---\n'],
    ['dup-desc', '---\nname: dup-desc\ndescription: "   "\ndescription: Works\n---\n'],
    ['with-meta', '---\nname: with-meta\nmetadata:\n  author: matt\n---\n'],
    ['nested-desc', '---\nname: nested-desc\nmetadata:\n  description: Nested only.\n---\n'],
  ]) {
    await rawSkill(source, folder!, text!)
  }
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    ['block', 'same'],
    ['block-feff', 'same'],
    ['block-u0085', 'missing'],
    ['comment-only-desc', 'missing'],
    ['dup-desc', 'same'],
    ['escaped', 'same'],
    ['escaped-val', 'same'],
    ['feff', 'same'],
    ['flow', 'same'],
    ['nested-desc', 'missing'],
    ['single-blank', 'missing'],
    ['u0085', 'missing'],
    ['unquoted-feff', 'same'],
    ['with-meta', 'missing'],
  ])
})

test('started for Codex, deck_skills takes a quoted description holding a line break, or a line going on past a U+0085, for one it cannot read, so counts it as having one', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  for (const [folder, text] of [
    ['double-cr', '---\nname: double-cr\ndescription: "a\rb"\n---\n'],
    ['single-line-separator', "---\nname: single-line-separator\ndescription: 'a\u2028b'\n---\n"],
    ['double-paragraph-separator', '---\nname: double-paragraph-separator\ndescription: "Works\u2029"\n---\n'],
    ['after-nel', '---\nname: after-nel\nx: a\u0085description: Works\n---\n'],
    ['indented-after-nel', '---\nname: indented-after-nel\nx:\n  a\u0085description: Works\n---\n'],
    ['nel-alone', '---\nname: nel-alone\ndescription: \u0085\n---\n'],
  ]) {
    await rawSkill(source, folder!, text!)
  }
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    ['after-nel', 'same'],
    ['double-cr', 'same'],
    ['double-paragraph-separator', 'same'],
    ['indented-after-nel', 'same'],
    ['nel-alone', 'missing'],
    ['single-line-separator', 'same'],
  ])
})

test('started for Codex, deck_skills takes a line breaking at a carriage return or a Unicode line or paragraph separator for one it cannot read where a key may follow the break', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  for (const [folder, text] of [
    ['name-cr', '---\nname: name-cr\rdescription: Works\n---\n'],
    ['name-line-separator', '---\nname: name-line-separator description: Works\n---\n'],
    ['name-paragraph-separator', '---\nname: name-paragraph-separator description: Works\n---\n'],
    ['value-line-separator', '---\nname: value-line-separator\nx: a description: Works\n---\n'],
    ['value-start-cr', '---\nname: value-start-cr\nx: \rdescription: Works\n---\n'],
    ['value-start-line-separator', '---\nname: value-start-line-separator\nx:  description: Works\n---\n'],
    ['comment-cr', '---\nname: comment-cr\n# c\rdescription: Works\n---\n'],
    ['comment-line-separator', '---\nname: comment-line-separator\n# c description: Works\n---\n'],
    ['indented-cr', '---\nname: indented-cr\nx:\n  a\rdescription: Works\n---\n'],
    ['indented-line-separator', '---\nname: indented-line-separator\nx:\n  a description: Works\n---\n'],
    ['block-line-separator', '---\nname: block-line-separator\nx: |\n  a description: Works\n---\n'],
  ]) {
    await rawSkill(source, folder!, text!)
  }
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    ['block-line-separator', 'same'],
    ['comment-cr', 'same'],
    ['comment-line-separator', 'same'],
    ['indented-cr', 'same'],
    ['indented-line-separator', 'same'],
    ['name-cr', 'same'],
    ['name-line-separator', 'same'],
    ['name-paragraph-separator', 'same'],
    ['value-line-separator', 'same'],
    ['value-start-cr', 'same'],
    ['value-start-line-separator', 'same'],
  ])
})

test('started for Codex, deck_skills skips files with invalid UTF-8 even in the body when scanning Codex skill directories', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const badBytes = Buffer.concat([Buffer.from('---\nname: bad\ndescription: Valid frontmatter.\n---\n\nBody '), Buffer.from([0xff])])
  await mkdir(join(user, '.agents', 'skills', 'bad'), { recursive: true })
  await writeFile(join(user, '.agents', 'skills', 'bad', 'SKILL.md'), badBytes)
  const alone = startDeck(dir, { HOME: user }, 'codex')
  t.after(alone.stop)
  const aloneResult = await alone.callTool('deck_skills')
  assert.deepEqual(copies(aloneResult), [['bad', 'missing']])

  const paired = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillFile(join(paired.user, '.claude', 'skills'), 'bad', 'Valid skill.')
  await mkdir(join(paired.user, '.agents', 'skills'), { recursive: true })
  await symlink(join(paired.user, '.claude', 'skills', 'bad'), join(paired.user, '.agents', 'skills', 'bad'))
  await mkdir(join(paired.user, '.codex', 'skills', 'bad'), { recursive: true })
  await writeFile(join(paired.user, '.codex', 'skills', 'bad', 'SKILL.md'), badBytes)
  const withBadSibling = startDeck(paired.dir, { HOME: paired.user }, 'codex')
  t.after(withBadSibling.stop)
  const sameResult = await withBadSibling.callTool('deck_skills')
  assert.deepEqual(copies(sameResult), [['bad', 'same']])

  await skillFile(join(paired.user, '.codex', 'skills'), 'bad', 'Another valid file.')
  const diffResult = await withBadSibling.callTool('deck_skills')
  assert.deepEqual(copies(diffResult), [['bad', 'several']])
})

test('started for Codex, deck_skills still matches a spaced-fence skill by its frontmatter name while the Skill Source keeps its folder name', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const source = join(user, '.claude', 'skills')
  await rawSkill(source, 'folder-name', '--- \nname: frontmatter-name\ndescription: Spaced fence.\n ---\n')
  await skillFile(source, 'frontmatter-name', 'Valid skill.')
  await mkdir(join(user, '.agents', 'skills'), { recursive: true })
  await symlink(join(source, 'folder-name'), join(user, '.agents', 'skills', 'folder-name'))
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    ['folder-name', 'missing'],
    ['frontmatter-name', 'different'],
  ])
})

test('deck_skills for Claude Code lists a skill with no description as before, with no copy', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  await rawSkill(join(user, '.agents', 'skills'), 'no-description', '---\nname: no-description\n---\n')
  const claudeCode = startDeck(dir, { HOME: user })
  t.after(claudeCode.stop)

  const result = await claudeCode.callTool('deck_skills')

  assert.deepEqual(result.structuredContent.skills, [
    { name: 'no-description', call: '/no-description', description: '', path: '~/.agents/skills/no-description/SKILL.md' },
  ])
})

test('started for Codex, deck_skills keeps copy expected for spaced valid and blank descriptions, and reads long fields in linear time', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  await rawSkill(source, 'valid-spaced', '---\nname: valid-spaced\ndescription:   "Read   this field."   \n---\n')
  await rawSkill(source, 'blank-block', '---\nname: blank-block\ndescription: >\n   \n---\n')
  const check = startDeck(dir, { HOME: user }, 'codex')
  t.after(check.stop)
  const checkResult = await check.callTool('deck_skills')
  assert.deepEqual(copies(checkResult), [
    ['blank-block', 'missing'],
    ['valid-spaced', 'same'],
  ])
  assert.equal(checkResult.structuredContent.skills[1].description, 'Read   this field.')

  // One skill file in Codex's own directory so every call exercises both
  // Skill Source parsing and Codex's directory scan on a warmed service.
  const timedHome = await home()
  const timedDir = await workspace(
    JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'directory', path: '~/.agents/skills' } }),
  )
  const timedSource = join(timedHome, '.agents', 'skills')
  const deck = startDeck(timedDir, { HOME: timedHome }, 'codex')
  t.after(deck.stop)
  const timed = async (description: string) => {
    await rawSkill(timedSource, 'long', `---\nname: long\ndescription: ${description}\n---\n`)
    const start = await deck.cpuMs()
    const { structuredContent } = await deck.callTool('deck_skills')
    return { ms: (await deck.cpuMs()) - start, skill: structuredContent.skills[0] }
  }
  const plain = 'ab '.repeat(Math.ceil(BLANK_TOP / 3)).slice(0, BLANK_TOP).trim()
  await timed(plain)
  const plainRead = await timed(plain)
  assert.deepEqual([plainRead.skill.name, plainRead.skill.description, plainRead.skill.copy], ['long', plain, 'same'])
  const shortVal = `a${' '.repeat(10_000)}b`
  const shortRead = await timed(shortVal)
  assert.deepEqual([shortRead.skill.name, shortRead.skill.description, shortRead.skill.copy], ['long', shortVal, 'same'])
  assert.ok(shortRead.ms - plainRead.ms < 1000, `short ${shortRead.ms} ms vs plain ${plainRead.ms} ms`)

  const longCases = [
    { label: 'middle-spaces', raw: `a${' '.repeat(BLANK_TOP - 2)}b`, expected: `a${' '.repeat(BLANK_TOP - 2)}b` },
    { label: 'trailing-spaces', raw: `a${' '.repeat(BLANK_TOP - 1)}`, expected: 'a' },
    { label: 'leading-spaces', raw: `${' '.repeat(BLANK_TOP - 1)}a`, expected: 'a' },
    { label: 'unclosed-quote', raw: `"${'a'.repeat(BLANK_TOP - 1)}`, expected: `"${'a'.repeat(BLANK_TOP - 1)}` },
  ]
  for (const { label, raw, expected } of longCases) {
    const read = await timed(raw)
    assert.deepEqual([read.skill.name, read.skill.description, read.skill.copy], ['long', expected, 'same'], label)
    assert.ok(read.ms - plainRead.ms < 1000, `${label}: ${read.ms} ms vs plain ${plainRead.ms} ms (short ${shortRead.ms} ms)`)
  }
})

test('started for Codex, deck_skills reads a description holding a carriage return or a Unicode line or paragraph separator as none, as Codex does not load it', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  for (const [folder, separator] of [['carriage-return', '\r'], ['line-separator', '\u2028'], ['paragraph-separator', '\u2029']]) {
    await rawSkill(source, folder!, `---\nname: ${folder}\ndescription: a${separator}b\n---\n`)
  }
  await rawSkill(source, 'under-block', '---\nname: under-block\ndescription: >\n  x\nother: a\u2028b\n  y\n---\n')
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, description, copy }: any) => [name, description, copy]),
    [
      ['carriage-return', '', 'missing'],
      ['line-separator', '', 'missing'],
      ['paragraph-separator', '', 'missing'],
      ['under-block', 'x other: a\u2028b y', 'same'],
    ],
  )
})

test('started for Codex, deck_skills reads a description of letters, digits and spaces broken once at a carriage return or a Unicode line or paragraph separator by more of the same as none, as Codex does not load it', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  const folders: string[] = []
  for (const [label, separator] of [['cr', '\r'], ['ls', '\u2028'], ['ps', '\u2029']]) {
    for (const [n, writing] of [`中${separator}文`, `a b${separator}c d`, `a ${separator}b`, `ab12${separator}34 cd`].entries()) {
      const folder = `${label}-${n}`
      folders.push(folder)
      await rawSkill(source, folder, `---\nname: ${folder}\ndescription: ${writing}\n---\n`)
    }
    // Under any key the line is no field, so no description is left.
    folders.push(`${label}-other-key`)
    await rawSkill(source, `${label}-other-key`, `---\nname: ${label}-other-key\nother: a${separator}b\n---\n`)
  }
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, copy }: any) => [name, copy]),
    folders.sort().map(folder => [folder, 'missing']),
  )
})

test('started for Codex, deck_skills reads the name Codex knows a skill file by past a carriage return, U+0085 or a Unicode line or paragraph separator, as Codex breaks a line there too', async t => {
  for (const separator of ['\r', '\u0085', '\u2028', '\u2029']) {
    const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
    const source = join(user, '.agents', 'skills')
    await rawSkill(source, 'name-fallback', `---\nname: actual${separator}description: Works\n---\n`)
    await rawSkill(source, 'other-field', `---\nx: 1${separator}name: actual-too\ndescription: Works\n---\n`)
    await rawSkill(source, 'quoted', `---\ndescription: "a${separator}name: x"\n---\n`)
    await rawSkill(source, 'after-quote', `---\nx: 'it''s'${separator}name: actual-three\ndescription: Works\n---\n`)
    await rawSkill(source, 'after-escape', `---\nx: "a\\"b"${separator}name: actual-four\ndescription: Works\n---\n`)
    // A quoted value broken inside, or holding an escape, is not a plain
    // line Deck can read: it reads the lines as before.
    const unsure = {
      'escaped-single': `x: 'it''s${separator}name: q'\ndescription: Works`,
      'escaped-double': `x: "a\\"${separator}name: q"\ndescription: Works`,
      unclosed: `x: "a${separator}name: q\ndescription: Works`,
      'across-lines': `description: "a\n  b${separator}name: q\n  c"`,
      'other-key': `名字: "a${separator}name: q"\ndescription: Works`,
      flow: `x: [ "a${separator}name: q" ]\ndescription: Works`,
    }
    for (const [folder, frontmatter] of Object.entries(unsure)) {
      await rawSkill(source, folder, `---\n${frontmatter}\n---\n`)
    }
    const unsureSame = Object.fromEntries(Object.keys(unsure).map(folder => [folder, 'same']))
    const deck = startDeck(dir, { HOME: user }, 'codex')
    t.after(deck.stop)
    // The Skill Source's own reading of names is as before: it takes a line
    // broken at U+0085 for one field.
    const listed = separator === '\u0085' ? `actual${separator}description: Works` : 'name-fallback'
    const copyOf = async () => Object.fromEntries(copies(await deck.callTool('deck_skills')))

    assert.deepEqual(await copyOf(), { [listed]: 'missing', 'after-quote': 'same', 'after-escape': 'same', 'other-field': 'missing', quoted: 'same', ...unsureSame }, JSON.stringify(separator))

    await rawSkill(source, 'actual', '---\nname: actual\ndescription: Works\n---\n')
    await rawSkill(source, 'actual-too', '---\nname: actual-too\ndescription: Works\n---\n')
    await rawSkill(source, 'actual-three', '---\nname: actual-three\ndescription: Works\n---\n')
    await rawSkill(source, 'actual-four', '---\nname: actual-four\ndescription: Works\n---\n')
    await rawSkill(source, 'x', '---\nname: x\ndescription: Works\n---\n')

    assert.deepEqual(
      await copyOf(),
      { actual: 'several', 'actual-too': 'several', 'actual-three': 'same', 'actual-four': 'same', 'after-quote': 'same', 'after-escape': 'same', [listed]: 'missing', 'other-field': 'missing', quoted: 'same', x: 'same', ...unsureSame },
      JSON.stringify(separator),
    )
  }
})

test('started for Codex, deck_skills reads a name as before where, broken at a carriage return, U+0085 or a Unicode line or paragraph separator, the frontmatter would not be plain lines it can read, as Codex then reads it line by line', async t => {
  for (const separator of ['\r', '\u0085', '\u2028', '\u2029']) {
    const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
    const source = join(user, '.agents', 'skills')
    const s = separator
    const writings = {
      'name-twice': `name: n1\nx: 1${s}name: A\ndescription: Works`,
      'name-twice-broken': `x: 1${s}name: A\ny: 2${s}name: B\ndescription: Works`,
      'name-twice-after': `x: 1${s}name: A\nname: n2\ndescription: Works`,
      'description-twice': `x: 1${s}name: A${s}description: a\ndescription: Works`,
      'colon-elsewhere': `x: 1${s}name: A\ndescription: Build for AWS: ECS`,
      'colon-before': `x: a: b${s}name: A\ndescription: Works`,
      'colon-after': `x: 1${s}name: a: b\ndescription: Works`,
      'flow-elsewhere': `x: 1${s}name: A\nhint: [a\ndescription: Works`,
      'at-elsewhere': `x: 1${s}name: A\nhint: @a\ndescription: Works`,
      'indented-first': ` y: 1\nx: 1${s}name: A\ndescription: Works`,
      'name-below': `name:${s} actual\ndescription: Works`,
      'name-tilde': `x: 1${s}name: ~\ndescription: Works`,
      'name-null': `x: 1${s}name: null\ndescription: Works`,
      'name-null-title': `x: 1${s}name: Null\ndescription: Works`,
      'name-null-upper': `x: 1${s}name: NULL\ndescription: Works`,
      'name-hash': `x: 1${s}name: #c\ndescription: Works`,
      'name-dash': `x: 1${s}name: - q\ndescription: Works`,
      'name-blank-quoted': `x: 1${s}name: ' '\ndescription: Works`,
      'name-comment': `x: 1${s}name: A # c\ndescription: Works`,
      'metadata-value': `description: Works${s}name: actual${s}metadata: b1`,
      'metadata-number': `description: Works${s}name: actual${s}metadata: 1`,
      'metadata-quoted': `description: Works${s}name: actual${s}metadata: "q"`,
      'metadata-twice': `description: Works${s}name: actual${s}metadata:\n  short-description: a\n  short-description: b`,
      'dash-value': `x: - q${s}name: actual\ndescription: Works`,
      'lone-dash': `x: -${s}name: actual\ndescription: Works`,
      'bracket-value': `x: ]a${s}name: actual\ndescription: Works`,
      'brace-value': `x: }a${s}name: actual\ndescription: Works`,
      'indent-tab': `x: a${s}\tb${s}name: actual\ndescription: Works`,
      'indent-uneven': `x:${s}  y: 1${s} z: 2${s}name: actual\ndescription: Works`,
      'indent-list': `x:${s}  - a${s}  b: 1${s}name: actual\ndescription: Works`,
      'indent-colon': `x:${s}  y: a: b${s}name: actual\ndescription: Works`,
      'flow-value': `x: [1, 2]${s}name: actual\ndescription: Works`,
      'tab-blank': `x: 1${s}\t${s}name: actual\ndescription: Works`,
      'tab-blank-after': `x: 1${s}name: actual${s}\t \ndescription: Works`,
      'block-shallow': `y: 1${s}x: |${s}    deep${s}  shallow${s}name: actual\ndescription: Works`,
      'block-tab': `x: >-${s}\ta${s}name: actual\ndescription: Works`,
      'name-block': `x: 1${s}name: |${s}# c\ndescription: Works`,
      'long-key': `x: 1${s}${'k'.repeat(1025)}: 2${s}name: actual\ndescription: Works`,
      'no-space': `x:1${s}name: actual\ndescription: Works`,
      'odd-key': `@x: 1${s}name: actual\ndescription: Works`,
    }
    for (const [folder, frontmatter] of Object.entries(writings)) {
      await rawSkill(source, folder, `---\n${frontmatter}\n---\n`)
    }
    const deck = startDeck(dir, { HOME: user }, 'codex')
    t.after(deck.stop)

    // Each is listed by the name the Skill Source's reading gives it, which
    // is the one Codex knows it by; but past U+0085 the name it reads below
    // an empty one holds that character, which $ cannot call.
    const result = await deck.callTool('deck_skills')

    assert.deepEqual(
      copies(result).map(([name, copy]: [string, string]) => copy === (name === `${separator} actual` ? 'missing' : 'same')),
      Object.keys(writings).map(() => true),
      JSON.stringify([separator, copies(result)]),
    )
  }
})

test('started for Codex, deck_skills reads a name past a line break over an indented comment, as Codex parses it so', async t => {
  for (const separator of ['\r', '\u0085', '\u2028', '\u2029']) {
    const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
    const source = join(user, '.agents', 'skills')
    await rawSkill(source, 'indented-comment', `---\nx: 1${separator}  # c${separator}name: commented\ndescription: Works\n---\n`)
    await rawSkill(source, 'commented', '---\nname: commented\ndescription: Works\n---\n')
    const deck = startDeck(dir, { HOME: user }, 'codex')
    t.after(deck.stop)

    assert.deepEqual(copies(await deck.callTool('deck_skills')), [
      ['commented', 'several'],
      ['indented-comment', 'missing'],
    ], JSON.stringify(separator))
  }
})

test('started for Codex, deck_skills judges a name read past a carriage return, where Codex reads it so, by Codex\'s 64 characters at most', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  const codexSkills = join(user, '.codex', 'skills')
  // Read past the break, the name is too long, as the folder's is not; and
  // the other way round.
  await rawSkill(source, 'b65', `---\nname: ${'b'.repeat(65)}\ndescription: Works\n---\n`)
  await rawSkill(codexSkills, 'other', `---\nx: 1\rname: ${'b'.repeat(65)}\ndescription: Works\n---\n`)
  await rawSkill(source, 'short', '---\nname: short\ndescription: Works\n---\n')
  await rawSkill(codexSkills, 'c'.repeat(65), '---\nx: 1\rname: short\ndescription: Works\n---\n')
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)

  assert.deepEqual(copies(await deck.callTool('deck_skills')), [
    ['b'.repeat(65), 'missing'],
    ['short', 'several'],
  ])
})

test('started for Codex, deck_skills judges a name read past a carriage return by Codex\'s 64 characters at most', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  const codexSkills = join(user, '.codex', 'skills')
  await rawSkill(source, 'b64', `---\nname: ${'b'.repeat(64)}\ndescription: Works\n---\n`)
  await rawSkill(codexSkills, 'other', `---\nx: 1\rname: ${'b'.repeat(64)}\ndescription: Works\n---\n`)
  await rawSkill(source, 'dup', '---\nname: dup\ndescription: Works\n---\n')
  await rawSkill(codexSkills, 'dup', `---\nx: 1\rname: ${'b'.repeat(65)}\ndescription: Works\n---\n`)
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)

  assert.deepEqual(copies(await deck.callTool('deck_skills')), [
    ['b'.repeat(64), 'several'],
    ['dup', 'same'],
  ])
})

test('started for Codex, deck_skills counts a description broken inside any other way as having one, as it cannot tell whether Codex loads it', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const source = join(user, '.agents', 'skills')
  const writings = (s: string) => [
    `a${s} b c`,
    `a${s} \tb c`,
    `a${s} # note`,
    `a${s}# note`,
    `a${s}...`,
    `a${s}${s} b c`,
    `a${s}? other`,
    `a${s}?`,
    `!!str "a${s}b"`,
    `&anchor "a${s}b"`,
    `a${s}\tb c`,
    `a${s}b${s}c`,
  ]
  // What follows `description:`: the writings above, a break with no space
  // after the colon, an unquoted U+0085 and a break at the value's start.
  const values = (s: string) => [...writings(s).map(writing => ` ${writing}`), `a${s}b`, ' a\u0085b', ` ${s}b`]
  const folders: string[] = []
  for (const [label, separator] of [['cr', '\r'], ['ls', '\u2028'], ['ps', '\u2029']]) {
    for (const [n, value] of values(separator!).entries()) {
      const folder = `${label}-${String(n).padStart(2, '0')}`
      folders.push(folder)
      await rawSkill(source, folder, `---\nname: ${folder}\ndescription:${value}\n---\n`)
    }
  }
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)

  const result = await deck.callTool('deck_skills')

  assert.deepEqual(
    result.structuredContent.skills.map(({ name, copy }: any) => [name, copy]),
    folders.sort().map(folder => [folder, 'same']),
  )
})

test('started for Codex, deck_skills lists every skill when Codex\'s skill directories hold entries that cannot be read, judging each name by the files that can', { skip: process.getuid?.() === 0 }, async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const source = join(user, '.claude', 'skills')
  for (const name of ['ask-matt', 'implement', 'tdd']) {
    await skillFile(source, name, `${name} 的说明。`)
  }
  const userSkills = join(user, '.agents', 'skills')
  await mkdir(userSkills, { recursive: true })
  // tdd's only entry is a link to itself; ask-matt's beside a link to the
  // Skill Source's is one too.
  await symlink(join(userSkills, 'tdd'), join(userSkills, 'tdd'))
  await symlink(join(source, 'ask-matt'), join(userSkills, 'ask-matt'))
  await mkdir(join(dir, '.agents', 'skills'), { recursive: true })
  await symlink(join(dir, '.agents', 'skills', 'ask-matt'), join(dir, '.agents', 'skills', 'ask-matt'))
  // implement's only file cannot be read, and a directory beside it cannot
  // be listed.
  await skillFile(join(dir, '.codex', 'skills'), 'implement', 'implement 的说明。')
  await chmod(join(dir, '.codex', 'skills', 'implement', 'SKILL.md'), 0o000)
  await mkdir(join(userSkills, 'locked'))
  await chmod(join(userSkills, 'locked'), 0o000)
  t.after(() => chmod(join(userSkills, 'locked'), 0o755))
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.equal(result.isError, false)
  assert.deepEqual(copies(result), [
    ['ask-matt', 'same'],
    ['implement', 'missing'],
    ['tdd', 'missing'],
  ])
})

test('started for Codex, deck_skills also looks in the user\'s ~/.codex/skills, as Codex does', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const source = join(user, '.claude', 'skills')
  await skillFile(source, 'tdd', 'tdd 的说明。')
  await skillFile(source, 'grill', 'grill 的说明。')
  const codexSkills = join(user, '.codex', 'skills')
  await mkdir(codexSkills, { recursive: true })
  await symlink(join(source, 'tdd'), join(codexSkills, 'tdd'))
  // grill there is another file, beside the link in ~/.agents/skills.
  await skillFile(codexSkills, 'grill', 'grill 的说明。')
  await mkdir(join(user, '.agents', 'skills'), { recursive: true })
  await symlink(join(source, 'grill'), join(user, '.agents', 'skills', 'grill'))
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    ['grill', 'several'],
    ['tdd', 'same'],
  ])
})

test('started for Codex, deck_skills finds the copies Codex finds below the top of its skill directories, down to its sixth level, outside hidden directories', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const source = join(user, '.claude', 'skills')
  for (const name of ['grill', 'review', 'tdd', 'triage']) {
    await skillFile(source, name, `${name} 的说明。`)
  }
  const userSkills = join(user, '.agents', 'skills')
  await mkdir(userSkills, { recursive: true })
  for (const name of ['grill', 'tdd', 'triage']) {
    await symlink(join(source, name), join(userSkills, name))
  }
  // Another tdd on the second level; another review, the only one, on the
  // sixth. The grill in a hidden directory and the triage on the seventh
  // level Codex does not find.
  await skillFile(join(userSkills, 'team'), 'tdd', 'tdd 的说明。')
  await skillFile(join(userSkills, 'a', 'b', 'c', 'd', 'e'), 'review', 'review 的说明。')
  await skillFile(join(userSkills, '.drafts'), 'grill', 'grill 的说明。')
  await skillFile(join(userSkills, 'a', 'b', 'c', 'd', 'e', 'f'), 'triage', 'triage 的说明。')
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [
    ['grill', 'same'],
    ['review', 'different'],
    ['tdd', 'several'],
    ['triage', 'same'],
  ])
})

test('started for Codex, deck_skills names a skill file without a name by its folder as its links resolve, as Codex does', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const source = join(user, '.claude', 'skills')
  await mkdir(join(source, 'grill-me'), { recursive: true })
  await writeFile(join(source, 'grill-me', 'SKILL.md'), '---\ndescription: 拷问计划。\n---\n\n# grill\n')
  await mkdir(join(user, '.agents', 'skills'), { recursive: true })
  await symlink(join(source, 'grill-me'), join(user, '.agents', 'skills', 'grill'))
  const codex = startDeck(dir, { HOME: user }, 'codex')
  t.after(codex.stop)

  const result = await codex.callTool('deck_skills')

  assert.deepEqual(copies(result), [['grill-me', 'same']])
})

test('the Deck service will not start without the host it runs for', async () => {
  for (const args of [[], ['--host'], ['--host', 'cursor'], ['--host', 'codex', 'extra']]) {
    await assert.rejects(exec(process.execPath, [SERVER, ...args], { env: { ...process.env, HOME: await home() } }), (error: any) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /Usage:/)
      return true
    })
  }
})

test('deck_skills says why when the Skill Source is not there, and lists none when it is empty', async t => {
  const missingDir = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const missingPlugin = await withSkillSource({ type: 'plugin', name: 'mattpocock-skills' })
  const empty = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await mkdir(join(empty.user, '.claude', 'skills'), { recursive: true })
  const decks = [missingDir, missingPlugin, empty].map(({ dir, user }) => startDeck(dir, { HOME: user }))
  for (const deck of decks) {
    t.after(deck.stop)
  }

  const [a, b, c] = await Promise.all(decks.map(deck => deck.callTool('deck_skills')))

  assert.deepEqual(a.structuredContent, {
    ok: false,
    failure: { kind: 'missing', message: 'the directory ~/.claude/skills does not exist' },
  })
  assert.deepEqual(b.structuredContent, {
    ok: false,
    failure: { kind: 'missing', message: 'the plugin mattpocock-skills is not installed' },
  })
  assert.deepEqual(c.structuredContent, { ok: true, source: { type: 'directory', path: '~/.claude/skills' }, skills: [] })
})

test('deck_skill reads one skill\'s file under its frontmatter, and says so of a name it does not hold', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const skills = join(user, '.claude', 'skills')
  const body = '# 问 Matt\n\n读当前的 Task，给出下一步。\n\n```sh\ngh issue list\n```\n'
  await skillFile(skills, 'ask-matt', '问下一步该做什么。', body)
  const before = await readFile(join(skills, 'ask-matt', 'SKILL.md'), 'utf8')
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const found = await deck.callTool('deck_skill', { name: 'ask-matt' })
  const unknown = await deck.callTool('deck_skill', { name: 'wayfinder' })
  const malformed = await Promise.all([{}, { name: '' }, { name: 3 }].map(args => deck.callTool('deck_skill', args)))

  assert.deepEqual(found.structuredContent, {
    ok: true,
    skill: {
      name: 'ask-matt',
      call: '/ask-matt',
      description: '问下一步该做什么。',
      path: '~/.claude/skills/ask-matt/SKILL.md',
      text: body,
    },
  })
  assert.deepEqual(unknown.structuredContent, {
    ok: false,
    failure: { kind: 'unknown-skill', message: 'the Skill Source has no skill named wayfinder' },
  })
  assert.deepEqual(
    malformed.map(result => result.isError),
    [true, true, true],
  )
  // Reading changes no skill file.
  assert.equal(await readFile(join(skills, 'ask-matt', 'SKILL.md'), 'utf8'), before)
})

test('deck_skill given a path reads the skill of that name and that file, of two of one name; without one, the first; a path not holding a skill of that name as a name it does not hold', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const skills = join(user, '.claude', 'skills')
  await rawSkill(skills, 'grill', '---\nname: grill\ndescription: 第一份。\n---\n\n# 第一份\n')
  await rawSkill(skills, 'grill-again', '---\nname: grill\ndescription: 第二份。\n---\n\n# 第二份\n')
  await skillFile(skills, 'tdd', 'tdd 的说明。')
  const deck = startDeck(dir, { HOME: user })
  t.after(deck.stop)

  const read = (args: object) => deck.callTool('deck_skill', args)
  const second = await read({ name: 'grill', path: '~/.claude/skills/grill-again/SKILL.md' })
  const first = await read({ name: 'grill' })
  const astray = await Promise.all([
    read({ name: 'grill', path: '~/.claude/skills/tdd/SKILL.md' }),
    read({ name: 'grill', path: '~/.claude/skills/gone/SKILL.md' }),
  ])
  const malformed = await Promise.all([{ name: 'grill', path: 3 }, { name: 'grill', path: '' }].map(read))

  assert.deepEqual([second.structuredContent.skill.description, second.structuredContent.skill.text], ['第二份。', '# 第二份\n'])
  assert.equal(second.structuredContent.skill.path, '~/.claude/skills/grill-again/SKILL.md')
  assert.deepEqual([first.structuredContent.skill.description, first.structuredContent.skill.text], ['第一份。', '# 第一份\n'])
  assert.deepEqual(
    astray.map(result => result.structuredContent),
    [0, 1].map(() => ({ ok: false, failure: { kind: 'unknown-skill', message: 'the Skill Source has no skill named grill' } })),
  )
  assert.deepEqual(malformed.map(result => result.isError), [true, true])
})

test('deck_skills and deck_skill leave out the configure skill Codex install generated in the Skill Source, for either host; one of that name without its mark is a skill like any', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.agents/skills' })
  const skills = join(user, '.agents', 'skills')
  await skillFile(skills, 'ask-matt', '问下一步该做什么。')
  await exec(process.execPath, [join(import.meta.dirname, '..', 'plugin', 'cli', 'codex.ts'), 'install'], { env: { ...process.env, HOME: user } })
  const generated = join(skills, 'matt-deck-configure', 'SKILL.md')

  for (const host of ['claude-code', 'codex']) {
    const deck = startDeck(dir, { HOME: user }, host)
    t.after(deck.stop)

    const listed = await deck.callTool('deck_skills')
    const read = await deck.callTool('deck_skill', { name: 'matt-deck-configure' })

    assert.deepEqual(listed.structuredContent.skills.map(({ name }: any) => name), ['ask-matt'], host)
    assert.deepEqual(read.structuredContent, {
      ok: false,
      failure: { kind: 'unknown-skill', message: 'the Skill Source has no skill named matt-deck-configure' },
    })
  }

  // A person's own skill of that name: the generated one with its mark taken out.
  await writeFile(generated, (await readFile(generated, 'utf8')).replace(/^<!--.*-->\n/m, ''))
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)

  const listed = await deck.callTool('deck_skills')
  const read = await deck.callTool('deck_skill', { name: 'matt-deck-configure' })

  assert.deepEqual(listed.structuredContent.skills.map(({ name }: any) => name), ['ask-matt', 'matt-deck-configure'])
  assert.equal(read.structuredContent.ok, true)
})

// A Recommendation Request's arguments, as deck_ask writes them for the
// request `id` and the Task Snapshot `snapshot`.
const askArgs = (id: string, snapshot: string) =>
  `Matt Deck Recommendation Request ${id}.\n\n` +
  `Task Snapshot, read from the Task Source as this request was sent:\n${snapshot}\n\n` +
  'Recommend only: do not start the work, change no file and run no other skill. ' +
  `Once you have decided, call the tool deck_recommend with requestId "${id}", ` +
  'task (the number of the Task to do next, or null), nextStep, skill (the skill to use, as it is called), ' +
  'reason and blockers. Then answer in a sentence or two.'

test('deck_ask makes a Recommendation Request for /ask-matt with the Task Snapshot read as it is sent', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  const skills = join(user, '.claude', 'skills')
  await skillFile(skills, 'ask-matt', '问下一步该做什么。')
  const before = await readFile(join(skills, 'ask-matt', 'SKILL.md'), 'utf8')
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1, title: '规格：里程碑一' }),
    issue({ number: 3, title: 'Pane 布局设计', labels: ['ready-for-human'], parent: 1 }),
    issue({ number: 5, title: '任务列表', labels: ['ready-for-agent'], parent: 1, blockedBy: [3] }),
    issue({ number: 2, title: '骨架', state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z', parent: 1 }),
  ])
  const deck = startDeck(dir, { ...gh.env, HOME: user })
  t.after(deck.stop)

  const first = (await deck.callTool('deck_ask')).structuredContent
  // A Task closed while the request was held is in the snapshot of the
  // request sent after it.
  await gh.issues([
    issue({ number: 1, title: '规格：里程碑一' }),
    issue({ number: 3, title: 'Pane 布局设计', state: 'CLOSED', closedAt: '2026-11-13T09:00:00Z', parent: 1 }),
    issue({ number: 5, title: '任务列表', labels: ['ready-for-agent'], parent: 1, blockedBy: [3] }),
    issue({ number: 2, title: '骨架', state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z', parent: 1 }),
  ])
  const second = (await deck.callTool('deck_ask')).structuredContent

  assert.equal(first.ok, true)
  assert.equal(first.call, '/ask-matt')
  assert.equal(first.command, 'ask-matt')
  assert.match(first.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(
    first.args,
    askArgs(
      first.requestId,
      [
        'Specs and Maps:',
        '- #1 规格：里程碑一 (spec, 1 of 3 Child Tasks closed)',
        'Ready:',
        '- #3 Pane 布局设计 [ready-for-human] (in #1)',
        'In progress: none',
        'Blocked:',
        '- #5 任务列表 [ready-for-agent] (in #1), blocked by #3',
        'Done: 1 Task closed',
      ].join('\n'),
    ),
  )
  assert.notEqual(second.requestId, first.requestId)
  assert.equal(
    second.args,
    askArgs(
      second.requestId,
      [
        'Specs and Maps:',
        '- #1 规格：里程碑一 (spec, 2 of 3 Child Tasks closed)',
        'Ready:',
        '- #5 任务列表 [ready-for-agent] (in #1)',
        'In progress: none',
        'Blocked: none',
        'Done: 2 Tasks closed',
      ].join('\n'),
    ),
  )
  // Each request reached the Task Source, past the cache.
  assert.equal((await gh.calls()).length, 2)
  // The skill file is left as it is.
  assert.equal(await readFile(join(skills, 'ask-matt', 'SKILL.md'), 'utf8'), before)
})

test('deck_ask runs a plugin\'s /ask-matt with the plugin prefix, and says why when it cannot make the request', async t => {
  const { dir, user } = await withSkillSource({ type: 'plugin', name: 'mattpocock-skills' })
  const matt = join(user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await installedPlugins(user, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(dir, { ...gh.env, HOME: user })
  t.after(deck.stop)

  // The plugin holds no /ask-matt yet.
  await skillFile(join(matt, 'skills', 'engineering'), 'tdd', '先写测试，再写实现。')
  const noSkill = await deck.callTool('deck_ask')
  await skillFile(join(matt, 'skills', 'productivity'), 'ask-matt', '问下一步该做什么。')
  const asked = await deck.callTool('deck_ask')
  await gh.answer({ stderr: 'error connecting to api.github.com', exitCode: 1 })
  const offline = await deck.callTool('deck_ask')

  assert.deepEqual(noSkill.structuredContent, {
    ok: false,
    failure: { kind: 'unknown-skill', message: 'the Skill Source has no skill named ask-matt' },
  })
  assert.equal(asked.structuredContent.call, '/mattpocock-skills:ask-matt')
  assert.equal(asked.structuredContent.command, 'mattpocock-skills:ask-matt')
  assert.equal(offline.isError, false)
  assert.equal(offline.structuredContent.ok, false)
  assert.equal(offline.structuredContent.failure.kind, 'offline')
})

test('deck_recommend keeps a Recommendation by its request, which deck_recommendation reads, from any Deck service', async t => {
  const dir = await configured()
  const user = await home()
  const agent = startDeck(dir, { HOME: user })
  t.after(agent.stop)
  const pane = startDeck(dir, { HOME: user })
  t.after(pane.stop)
  const recommendation = {
    task: 3,
    nextStep: '先画停靠在侧边的线框图，再画输入框上方的。',
    skill: '/prototype',
    reason: '它挡着 #5、#7、#8，放开 10 个 Task。',
    blockers: '',
  }

  const reported = await agent.callTool('deck_recommend', { requestId: 'request-1', ...recommendation })
  // Nothing to do is a Recommendation too.
  await agent.callTool('deck_recommend', {
    requestId: 'request-2',
    task: null,
    nextStep: '等 #3 的评审。',
    skill: '',
    reason: '没有可执行的 Task。',
    blockers: '#3 在等人评审',
  })
  const read = await pane.callTool('deck_recommendation', { requestId: 'request-1' })
  const nothing = await pane.callTool('deck_recommendation', { requestId: 'request-9' })
  const none = await pane.callTool('deck_recommendation', { requestId: 'request-2' })

  assert.equal(reported.isError, false)
  assert.deepEqual(read.structuredContent, { found: true, recommendation })
  assert.deepEqual(nothing.structuredContent, { found: false })
  assert.equal(none.structuredContent.recommendation.task, null)
})

test('deck_recommend asks for the skill as this host calls it: /tdd for Claude Code, $tdd for Codex', async t => {
  const claudeCode = startDeck(await configured(), { HOME: await home() })
  const codex = startDeck(await configured(), { HOME: await home() }, 'codex')
  t.after(claudeCode.stop)
  t.after(codex.stop)

  const described = await Promise.all(
    [claudeCode, codex].map(async deck => {
      const { result } = await deck.request('tools/list')
      return result.tools.find((tool: any) => tool.name === 'deck_recommend').inputSchema.properties.skill.description
    }),
  )

  assert.deepEqual(described, [
    'The skill to use, as it is called (e.g. /tdd); "" for none.',
    'The skill to use, as it is called (e.g. $tdd); "" for none.',
  ])
})

test('deck_recommend takes the request\'s id, a Task number or null, and the four texts', async t => {
  const deck = startDeck(await configured(), { HOME: await home() })
  t.after(deck.stop)
  const valid = { requestId: 'request-1', task: 3, nextStep: '画线框图', skill: '/prototype', reason: '挡着三个', blockers: '' }

  const malformed = await Promise.all(
    [
      { ...valid, requestId: '' },
      { ...valid, task: '#3' },
      { ...valid, task: 0 },
      { ...valid, reason: undefined },
      { ...valid, blockers: ['#3'] },
    ].map(args => deck.callTool('deck_recommend', args)),
  )
  const read = await deck.callTool('deck_recommendation', { requestId: 'request-1' })

  assert.deepEqual(
    malformed.map(result => result.isError),
    [true, true, true, true, true],
  )
  assert.deepEqual(read.structuredContent, { found: false })
})

// Who occupies each Task deck_tasks lists in progress, by number.
const occupants = (tasks: { number: number; occupant: string | null }[]) =>
  Object.fromEntries(tasks.map(task => [task.number, task.occupant]))

test('deck_occupy records a Session\'s Occupancy of a Task, which every Deck service of the repository lists in progress', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1, title: '规格' }),
    issue({ number: 3, parent: 1 }),
    issue({ number: 5, blockedBy: [3] }),
    issue({ number: 7 }),
  ])
  const here = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(here.stop)
  // Another Session, in the same Workspace, and one in another Workspace of
  // the same repository.
  const besideDir = await configured()
  const beside = startDeck(besideDir, { ...gh.env, HOME: user })
  t.after(beside.stop)
  const elsewhere = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(elsewhere.stop)
  // A Deck service reading before the Occupancy keeps its read in its cache.
  await beside.callTool('deck_tasks')

  const occupied = await here.callTool('deck_occupy', { session: 'session-a', task: 3 })
  // Different Sessions occupy different Tasks at once, a blocked one too.
  const other = await elsewhere.callTool('deck_occupy', { session: 'session-b', task: 5 })

  assert.equal(occupied.isError, false)
  assert.deepEqual(occupied.structuredContent, { ok: true, occupied: true, occupant: 'session-a', occupantHost: 'claude-code', occupantShort: 'session-' })
  assert.deepEqual(other.structuredContent, { ok: true, occupied: true, occupant: 'session-b', occupantHost: 'claude-code', occupantShort: 'session-' })
  for (const deck of [here, beside, elsewhere]) {
    const { groups, containers } = (await deck.callTool('deck_tasks')).structuredContent
    assert.deepEqual(occupants(groups.inProgress), { 3: 'session-a', 5: 'session-b' })
    assert.deepEqual(numbers(groups.ready), [7])
    assert.deepEqual(groups.blocked, [])
    assert.equal(groups.ready[0].occupant, null)
    assert.deepEqual(containers[0].progress, { closed: 0, inProgress: 1, total: 1 })
  }
  // The service reading before the Occupancy answered from its cache, with
  // the Occupancy all the same: it read the Task Source once, and each
  // Occupancy read it as it was recorded.
  assert.equal((await gh.calls()).filter(call => call.cwd === besideDir).length, 1)
})

test('deck_occupy keeps a Task to one Occupancy, and says which Session holds it', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)

  const first = await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })
  await deck.callTool('deck_heartbeat', { session: 'session-a' })
  const again = await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })
  const second = await deck.callTool('deck_occupy', { session: 'session-b', task: 3 })
  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(first.structuredContent, { ok: true, occupied: true, occupant: 'session-a', occupantHost: 'claude-code', occupantShort: 'session-' })
  assert.deepEqual(again.structuredContent, { ok: true, occupied: true, occupant: 'session-a', occupantHost: 'claude-code', occupantShort: 'session-' })
  assert.deepEqual(second.structuredContent, { ok: true, occupied: false, occupant: 'session-a', occupantHost: 'claude-code', occupantShort: 'session-', isOrphaned: false })
  assert.deepEqual(occupants(groups.inProgress), { 3: 'session-a' })
})

test('deck_occupy says when the Session holding the Task is Orphaned, and leaves the Task with it', async t => {
  const user = await home()
  const gh = await fakeGh()
  const start = Date.UTC(2026, 11, 2, 9, 0)
  const clock = await fakeClock(start)
  await gh.issues([issue({ number: 3 }), issue({ number: 5 }), issue({ number: 7 })])
  const deck = startDeck(await configured(), { ...gh.env, ...clock.env, HOME: user })
  t.after(deck.stop)
  for (const [task, session] of [[3, 'ended'], [5, 'stale'], [7, 'never-beat']] as const) {
    await deck.callTool('deck_occupy', { task, session })
  }
  await deck.callTool('deck_heartbeat', { session: 'stale' })
  // Past the last heartbeat by more than three minutes.
  await clock.set(start + 3 * 60_000 + 1)
  // Ended only now, so no old heartbeat makes its Occupancy Orphaned.
  await deck.callTool('deck_end_session', { session: 'ended' })

  const answers = []
  for (const task of [3, 5, 7]) {
    answers.push((await deck.callTool('deck_occupy', { session: 'session-b', task })).structuredContent)
  }
  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(answers, [
    { ok: true, occupied: false, occupant: 'ended', occupantHost: 'claude-code', occupantShort: 'ended', isOrphaned: true },
    { ok: true, occupied: false, occupant: 'stale', occupantHost: 'claude-code', occupantShort: 'stale', isOrphaned: true },
    { ok: true, occupied: false, occupant: 'never-beat', occupantHost: 'claude-code', occupantShort: 'never-be', isOrphaned: true },
  ])
  assert.deepEqual(occupants(groups.inProgress), { 3: 'ended', 5: 'stale', 7: 'never-beat' })
})

test('a closed Task\'s Occupancy is released', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)
  await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })

  await gh.issues([issue({ number: 3, state: 'CLOSED', closedAt: '2026-11-13T09:00:00Z' })])
  const closed = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
  // Opened again, it is occupied by nobody.
  await gh.issues([issue({ number: 3 })])
  const reopened = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
  const taken = await deck.callTool('deck_occupy', { session: 'session-b', task: 3 })

  assert.deepEqual(numbers(closed.groups.done), [3])
  assert.equal(closed.groups.done[0].occupant, null)
  assert.deepEqual(numbers(reopened.groups.ready), [3])
  assert.deepEqual(taken.structuredContent, { ok: true, occupied: true, occupant: 'session-b', occupantHost: 'claude-code', occupantShort: 'session-' })
})

test('a read older than an Occupancy does not release it', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const early = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(early.stop)
  const late = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(late.stop)
  // One Deck service reads before the Task is there, and keeps that read in
  // its cache.
  await early.callTool('deck_tasks')

  await gh.issues([issue({ number: 3 }), issue({ number: 4 })])
  await late.callTool('deck_occupy', { session: 'session-b', task: 4 })
  await early.callTool('deck_tasks')
  const { groups } = (await late.callTool('deck_tasks')).structuredContent

  assert.deepEqual(occupants(groups.inProgress), { 4: 'session-b' })
})

test('deck_occupy occupies a Task a link refers to only in the Task Source\'s repository', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 })], 'acme/shop')
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)

  const other = await deck.callTool('deck_occupy', { session: 'session-a', reference: 'https://github.com/acme/other/issues/5' })
  // GitHub takes a repository's owner and name in any case.
  const same = await deck.callTool('deck_occupy', { session: 'session-a', reference: 'https://github.com/Acme/Shop/issues/3' })
  const malformed = await deck.callTool('deck_occupy', { session: 'session-a', task: 3, reference: '#3' })
  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(other.structuredContent, {
    ok: false,
    task: 5,
    failure: { kind: 'not-open', message: '#5 of acme/other is not a Task of the Task Source, acme/shop' },
  })
  assert.deepEqual(same.structuredContent, { ok: true, task: 3, occupied: true, occupant: 'session-a', occupantHost: 'claude-code', occupantShort: 'session-' })
  assert.equal(malformed.isError, true)
  assert.deepEqual(occupants(groups.inProgress), { 3: 'session-a' })
})

test('an Occupancy belongs to its repository: another repository\'s Task of the same number is not occupied', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })], 'acme/shop')
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)
  await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })

  await gh.issues([issue({ number: 3 })], 'acme/other')
  const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent

  assert.deepEqual(numbers(groups.ready), [3])
  assert.deepEqual(groups.inProgress, [])
})

test('deck_occupy occupies only an open Task of the Task Source, and takes a Session and a Task number', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 2, state: 'CLOSED', closedAt: '2026-11-11T05:40:00Z' })])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const closed = await deck.callTool('deck_occupy', { session: 'session-a', task: 2 })
  const unknown = await deck.callTool('deck_occupy', { session: 'session-a', task: 9 })
  const malformed = await Promise.all(
    [{ session: '', task: 3 }, { session: 'session-a', task: '#3' }, { session: 'session-a', task: 0 }, { task: 3 }].map(
      args => deck.callTool('deck_occupy', args),
    ),
  )
  await gh.answer({ stderr: 'error connecting to api.github.com', exitCode: 1 })
  const unread = startDeck(await configured(), gh.env)
  t.after(unread.stop)
  const offline = await unread.callTool('deck_occupy', { session: 'session-a', task: 3 })

  assert.deepEqual(closed.structuredContent, { ok: false, failure: { kind: 'not-open', message: '#2 is closed' } })
  assert.deepEqual(unknown.structuredContent, {
    ok: false,
    failure: { kind: 'not-open', message: 'the Task Source has no Task #9' },
  })
  assert.deepEqual(
    malformed.map(result => result.isError),
    [true, true, true, true],
  )
  assert.equal(offline.structuredContent.ok, false)
  assert.equal(offline.structuredContent.failure.kind, 'offline')
})

test('deck_occupy with takeOver moves the Occupancy of the Session it names to this Session, which every Deck service of the repository lists', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 }), issue({ number: 7 })])
  const here = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(here.stop)
  const elsewhere = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(elsewhere.stop)
  await elsewhere.callTool('deck_occupy', { session: 'session-b', task: 3 })
  await elsewhere.callTool('deck_occupy', { session: 'session-c', task: 7 })
  await elsewhere.callTool('deck_heartbeat', { session: 'session-c' })

  const taken = await here.callTool('deck_occupy', { session: 'session-a', task: 3, takeOver: 'session-b' })
  // A Task nobody holds is occupied as without takeOver.
  const free = await here.callTool('deck_occupy', { session: 'session-a', task: 5, takeOver: 'session-b' })
  // One that passed to a third Session since the person saw it stays there.
  const passed = await here.callTool('deck_occupy', { session: 'session-a', task: 7, takeOver: 'session-b' })
  const malformed = await Promise.all(
    [true, ''].map(takeOver => here.callTool('deck_occupy', { session: 'session-a', task: 3, takeOver })),
  )

  assert.deepEqual(taken.structuredContent, { ok: true, occupied: true, occupant: 'session-a', occupantHost: 'claude-code', occupantShort: 'session-' })
  assert.deepEqual(free.structuredContent, { ok: true, occupied: true, occupant: 'session-a', occupantHost: 'claude-code', occupantShort: 'session-' })
  assert.deepEqual(passed.structuredContent, { ok: true, occupied: false, occupant: 'session-c', occupantHost: 'claude-code', occupantShort: 'session-', isOrphaned: false })
  assert.deepEqual(
    malformed.map(result => result.isError),
    [true, true],
  )
  for (const deck of [here, elsewhere]) {
    const { groups } = (await deck.callTool('deck_tasks')).structuredContent
    assert.deepEqual(occupants(groups.inProgress), { 3: 'session-a', 5: 'session-a', 7: 'session-c' })
  }
})

test('deck_release releases any Session\'s Occupancy, and the Task goes back to the group it belongs in', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5, blockedBy: [3] }), issue({ number: 7 }), issue({ number: 9 })])
  const here = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(here.stop)
  const elsewhere = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(elsewhere.stop)
  await here.callTool('deck_occupy', { session: 'session-a', task: 3 })
  await elsewhere.callTool('deck_occupy', { session: 'session-b', task: 5 })
  await elsewhere.callTool('deck_occupy', { session: 'session-b', task: 9 })

  const own = await here.callTool('deck_release', { task: 3, session: 'session-a' })
  // Another Session's: every Session is the same person's.
  const others = await here.callTool('deck_release', { task: 5, session: 'session-b' })
  const unoccupied = await here.callTool('deck_release', { task: 7, session: 'session-a' })
  // One that passed to another Session since the person saw it stays there.
  const passed = await here.callTool('deck_release', { task: 9, session: 'session-a' })
  const malformed = await Promise.all(
    [{ task: '#3', session: 'session-a' }, { task: 0, session: 'session-a' }, { task: 3 }, { task: 3, session: '' }, {}].map(args =>
      here.callTool('deck_release', args),
    ),
  )

  assert.deepEqual(own.structuredContent, { ok: true, released: true })
  assert.deepEqual(others.structuredContent, { ok: true, released: true })
  assert.deepEqual(unoccupied.structuredContent, { ok: true, released: false })
  assert.deepEqual(passed.structuredContent, { ok: true, released: false })
  assert.deepEqual(
    malformed.map(result => result.isError),
    [true, true, true, true, true],
  )
  for (const deck of [here, elsewhere]) {
    const { groups } = (await deck.callTool('deck_tasks')).structuredContent
    assert.deepEqual(occupants(groups.inProgress), { 9: 'session-b' })
    assert.deepEqual(numbers(groups.ready), [3, 7])
    assert.deepEqual(numbers(groups.blocked), [5])
  }
  // Released, the Task can be occupied by any Session.
  const again = await elsewhere.callTool('deck_occupy', { session: 'session-b', task: 3 })
  assert.deepEqual(again.structuredContent, { ok: true, occupied: true, occupant: 'session-b', occupantHost: 'claude-code', occupantShort: 'session-' })
})

// A clock every Deck service given its `env` reads, which `set` moves.
const fakeClock = async (start: number) => {
  const file = join(await mkdtemp(join(tmpdir(), 'deck-clock-')), 'now')
  const set = (now: number) => writeFile(file, String(now))
  await set(start)

  return { env: { FAKE_CLOCK_FILE: file }, set }
}

// A Claude Code Session's id, and two of Codex's, begun a moment apart.
const CLAUDE_SESSION = '3f9c21d0-5b7e-4a1c-9d2f-6e8b0c4a7f13'
const CODEX_SESSION = '019a8c3e-1f2b-7c4d-9e0f-0a1b045b96fc'
const CODEX_NEIGHBOUR = '019a8c3e-1f2b-7c4d-9e0f-1c2d77e0aa15'

test('the Sessions of Occupancies and reports carry the host their heartbeat recorded and a short id, a Codex one\'s from its end', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 }), issue({ number: 7 }), issue({ number: 9 })])
  const claude = startDeck(dir, { ...gh.env, HOME: user })
  t.after(claude.stop)
  const codex = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(codex.stop)
  await claude.callTool('deck_heartbeat', { session: CLAUDE_SESSION })
  await codex.callTool('deck_heartbeat', { session: CODEX_SESSION })
  await codex.callTool('deck_heartbeat', { session: CODEX_NEIGHBOUR })
  await claude.callTool('deck_occupy', { session: CLAUDE_SESSION, task: 3 })
  await codex.callTool('deck_occupy', { session: CODEX_SESSION, task: 5 })
  await codex.callTool('deck_occupy', { session: CODEX_NEIGHBOUR, task: 7 })
  // A Session that never beat has no host recorded: it is Claude Code's.
  await codex.callTool('deck_occupy', { session: 'never-beat-session', task: 9 })
  await codex.callTool('deck_report', { task: 5, session: CODEX_SESSION, result: 'Done', evidence: [] })
  await claude.callTool('deck_report', { task: 5, session: CLAUDE_SESSION, result: 'Checked', evidence: [] })

  const { groups } = (await claude.callTool('deck_tasks')).structuredContent
  const refused = (await claude.callTool('deck_occupy', { session: CLAUDE_SESSION, task: 5 })).structuredContent
  const taken = (await codex.callTool('deck_occupy', { session: CODEX_SESSION, task: 9, takeOver: 'never-beat-session' }))
    .structuredContent
  const { occupancies } = (await codex.callTool('deck_inspect')).structuredContent
  await gh.answer({ stdout: viewed({ number: 5 }) })
  const { reports } = (await codex.callTool('deck_task', { number: 5 })).structuredContent

  assert.deepEqual(
    groups.inProgress.map(({ number, occupant, occupantHost, occupantShort }: any) => [number, occupant, occupantHost, occupantShort]),
    [
      [3, CLAUDE_SESSION, 'claude-code', '3f9c21d0'],
      [5, CODEX_SESSION, 'codex', '045b96fc'],
      [7, CODEX_NEIGHBOUR, 'codex', '77e0aa15'],
      [9, 'never-beat-session', 'claude-code', 'never-be'],
    ],
  )
  assert.deepEqual(refused, {
    ok: true,
    occupied: false,
    occupant: CODEX_SESSION,
    occupantHost: 'codex',
    occupantShort: '045b96fc',
    isOrphaned: false,
  })
  assert.deepEqual(taken, { ok: true, occupied: true, occupant: CODEX_SESSION, occupantHost: 'codex', occupantShort: '045b96fc' })
  assert.deepEqual(
    occupancies.map(({ task, session, sessionHost, sessionShort }: any) => [task, session, sessionHost, sessionShort]),
    [
      [3, CLAUDE_SESSION, 'claude-code', '3f9c21d0'],
      [5, CODEX_SESSION, 'codex', '045b96fc'],
      [7, CODEX_NEIGHBOUR, 'codex', '77e0aa15'],
      [9, CODEX_SESSION, 'codex', '045b96fc'],
    ],
  )
  assert.deepEqual(
    reports.map(({ session, sessionHost, sessionShort }: any) => [session, sessionHost, sessionShort]),
    [
      [CODEX_SESSION, 'codex', '045b96fc'],
      [CLAUDE_SESSION, 'claude-code', '3f9c21d0'],
    ],
  )
})

test('started for Codex, deck_tasks lists the Occupancy a Claude Code Session recorded, by that host and its short id', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const claude = startDeck(dir, { ...gh.env, HOME: user })
  t.after(claude.stop)
  const codex = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(codex.stop)
  await claude.callTool('deck_heartbeat', { session: CLAUDE_SESSION })
  await claude.callTool('deck_occupy', { session: CLAUDE_SESSION, task: 3 })

  const { groups } = (await codex.callTool('deck_tasks')).structuredContent

  assert.deepEqual(
    groups.inProgress.map(({ number, occupant, occupantHost, occupantShort }: any) => [number, occupant, occupantHost, occupantShort]),
    [[3, CLAUDE_SESSION, 'claude-code', '3f9c21d0']],
  )
})

test('a Session local state recorded before hosts were is Claude Code\'s, and beats on with its host recorded', async t => {
  const user = await home()
  await mkdir(join(user, '.matt-deck'))
  const stateFile = join(user, '.matt-deck', 'deck.sqlite')
  const db = new DatabaseSync(stateFile)
  t.after(() => db.close())
  // Before hosts, a Session's row held its heartbeat and whether it ended.
  db.exec('CREATE TABLE occupancies (source TEXT NOT NULL, task INTEGER NOT NULL, session TEXT NOT NULL, occupied_at INTEGER NOT NULL, PRIMARY KEY (source, task))')
  db.exec('CREATE TABLE sessions (session TEXT PRIMARY KEY, beat_at INTEGER NOT NULL, is_ended INTEGER NOT NULL)')
  db.prepare('INSERT INTO occupancies VALUES (?, ?, ?, ?)').run('acme/shop', 3, CLAUDE_SESSION, 1)
  db.prepare('INSERT INTO sessions VALUES (?, ?, 0)').run(CLAUDE_SESSION, Date.now())
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 })])
  const dir = await configured()
  const claude = startDeck(dir, { ...gh.env, HOME: user })
  t.after(claude.stop)
  const codex = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(codex.stop)

  // A read that changes nothing reads it as it is.
  const before = await readFile(stateFile)
  const inspected = (await claude.callTool('deck_inspect')).structuredContent.occupancies
  assert.deepEqual(await readFile(stateFile), before)
  await codex.callTool('deck_heartbeat', { session: CODEX_SESSION })
  await codex.callTool('deck_occupy', { session: CODEX_SESSION, task: 5 })
  await claude.callTool('deck_heartbeat', { session: CLAUDE_SESSION })
  const { groups } = (await claude.callTool('deck_tasks')).structuredContent

  assert.deepEqual(inspected, [
    { task: 3, session: CLAUDE_SESSION, sessionHost: 'claude-code', sessionShort: '3f9c21d0', isOrphaned: false },
  ])
  assert.deepEqual(
    groups.inProgress.map(({ number, occupantHost, occupantShort, isOrphaned }: any) => [number, occupantHost, occupantShort, isOrphaned]),
    [
      [3, 'claude-code', '3f9c21d0', false],
      [5, 'codex', '045b96fc', false],
    ],
  )
})

test('local state a Deck service wrote still takes a heartbeat and an end as a Deck service from before hosts writes them', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const codex = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(codex.stop)
  await codex.callTool('deck_heartbeat', { session: CODEX_SESSION })
  await codex.callTool('deck_occupy', { session: CODEX_SESSION, task: 3 })
  await codex.callTool('deck_tasks')
  const db = new DatabaseSync(join(user, '.matt-deck', 'deck.sqlite'))
  t.after(() => db.close())

  // As a Deck service started before the upgrade, and its one-shot end of a
  // Session, write a Session's row: by position, three values.
  db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, 0)').run(CLAUDE_SESSION, Date.now())
  db.prepare('INSERT INTO sessions VALUES (?, ?, 1) ON CONFLICT (session) DO UPDATE SET is_ended = 1').run('ended-session', Date.now())
  db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, 0)').run(CODEX_SESSION, Date.now())

  const { groups } = (await codex.callTool('deck_tasks')).structuredContent
  // The host its heartbeat recorded stays.
  assert.deepEqual(
    groups.inProgress.map(({ number, occupantHost, occupantShort, isOrphaned }: any) => [number, occupantHost, occupantShort, isOrphaned]),
    [[3, 'codex', '045b96fc', false]],
  )
})

// Which Tasks deck_tasks lists in progress as Orphaned, by number.
const orphaned = (tasks: { number: number; isOrphaned: boolean }[]) =>
  tasks.filter(task => task.isOrphaned).map(task => task.number)

const MINUTE = 60_000

test('deck_inspect shows shared Occupancy and Orphaned status without settling or changing state', async t => {
  const user = await home()
  const gh = await fakeGh()
  const start = Date.UTC(2026, 10, 13, 9, 0)
  const clock = await fakeClock(start)
  const env = { ...gh.env, ...clock.env, HOME: user }
  const writer = startDeck(await configured(), env)
  const reader = startDeck(await configured(), env)
  t.after(writer.stop)
  t.after(reader.stop)
  await gh.issues([1, 3, 5, 7, 9].map(number => issue({ number })))
  for (const [task, session] of [[1, 'container'], [3, 'ended'], [5, 'live'], [7, 'never-beat'], [9, 'closed']] as const) {
    await writer.callTool('deck_occupy', { task, session })
  }
  await writer.callTool('deck_end_session', { session: 'ended' })
  await writer.callTool('deck_heartbeat', { session: 'live' })
  await writer.callTool('deck_report', { task: 5, session: 'live', result: 'Checked', evidence: [{ text: 'Passed', source: 'tests' }] })
  // An Occupancy in another Task Source must not leak into this inspection.
  await gh.issues([issue({ number: 11 })], 'acme/other')
  await writer.callTool('deck_occupy', { task: 11, session: 'elsewhere' })
  await gh.issues([
    issue({ number: 1 }), issue({ number: 3, parent: 1 }), issue({ number: 5 }), issue({ number: 7 }),
    issue({ number: 9, state: 'CLOSED', closedAt: '2026-11-13T09:00:00Z' }),
  ])
  const stateFile = join(user, '.matt-deck', 'deck.sqlite')
  const before = await readFile(stateFile)
  await clock.set(start + 3 * MINUTE)
  const atThree = (await reader.callTool('deck_inspect')).structuredContent
  await clock.set(start + 3 * MINUTE + 1)
  const afterThree = (await reader.callTool('deck_inspect')).structuredContent

  assert.deepEqual(atThree.occupancies, [
    { task: 1, session: 'container', sessionHost: 'claude-code', sessionShort: 'containe', isOrphaned: true },
    { task: 3, session: 'ended', sessionHost: 'claude-code', sessionShort: 'ended', isOrphaned: true },
    { task: 5, session: 'live', sessionHost: 'claude-code', sessionShort: 'live', isOrphaned: false },
    { task: 7, session: 'never-beat', sessionHost: 'claude-code', sessionShort: 'never-be', isOrphaned: true },
  ])
  assert.deepEqual(afterThree.occupancies.filter((entry: any) => entry.task === 5), [
    { task: 5, session: 'live', sessionHost: 'claude-code', sessionShort: 'live', isOrphaned: true },
  ])
  assert.deepEqual(occupants(atThree.tasks.groups.inProgress), { 3: 'ended', 5: 'live', 7: 'never-beat' })
  assert.equal(atThree.tasks.containers[0].occupant, 'container')
  assert.equal(atThree.tasks.groups.inProgress.find((task: any) => task.number === 5).hasEvidence, true)
  assert.equal(atThree.tasks.groups.done[0].occupant, null)
  assert.deepEqual(await readFile(stateFile), before)
  assert.deepEqual(await readdir(join(user, '.matt-deck')), ['deck.sqlite'])

  // Reopening it proves the inspection left the closed Task's stored Occupancy intact.
  await gh.issues([issue({ number: 9 })])
  const reopened = (await reader.callTool('deck_inspect')).structuredContent
  assert.deepEqual(reopened.occupancies, [{ task: 9, session: 'closed', sessionHost: 'claude-code', sessionShort: 'closed', isOrphaned: true }])
  assert.deepEqual(await readFile(stateFile), before)
})

test('an Occupancy is Orphaned once its Session ends, in the Pane of every Session, and stays in progress', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 })])
  const clock = await fakeClock(Date.UTC(2026, 10, 13, 9, 0))
  const env = { ...gh.env, ...clock.env, HOME: user }
  const ending = startDeck(await configured(), env)
  t.after(ending.stop)
  const other = startDeck(await configured(), env)
  t.after(other.stop)
  await ending.callTool('deck_heartbeat', { session: 'session-a' })
  await other.callTool('deck_heartbeat', { session: 'session-b' })
  await ending.callTool('deck_occupy', { session: 'session-a', task: 3 })
  await other.callTool('deck_occupy', { session: 'session-b', task: 5 })
  const before = (await other.callTool('deck_tasks')).structuredContent

  const ended = await ending.callTool('deck_end_session', { session: 'session-a' })
  const after = (await other.callTool('deck_tasks')).structuredContent
  const malformed = await Promise.all(
    [{}, { session: '' }, { session: 7 }].flatMap(args => [
      other.callTool('deck_heartbeat', args),
      other.callTool('deck_end_session', args),
    ]),
  )

  assert.deepEqual(orphaned(before.groups.inProgress), [])
  assert.deepEqual(ended, { content: [{ type: 'text', text: 'Recorded.' }], isError: false })
  // Still in progress, held by the Session that ended: it waits on the person.
  assert.deepEqual(occupants(after.groups.inProgress), { 3: 'session-a', 5: 'session-b' })
  assert.deepEqual(orphaned(after.groups.inProgress), [3])
  assert.deepEqual(numbers(after.groups.ready), [])
  assert.deepEqual(
    malformed.map(result => result.isError),
    [true, true, true, true, true, true],
  )
})

test('an Occupancy is Orphaned once its Session\'s heartbeat is three minutes old, and is held again when it beats', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 })])
  const start = Date.UTC(2026, 10, 13, 9, 0)
  const clock = await fakeClock(start)
  const deck = startDeck(await configured(), { ...gh.env, ...clock.env, HOME: user })
  t.after(deck.stop)
  await deck.callTool('deck_heartbeat', { session: 'session-a' })
  await deck.callTool('deck_heartbeat', { session: 'session-b' })
  await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })
  await deck.callTool('deck_occupy', { session: 'session-b', task: 5 })
  const inProgress = async () => (await deck.callTool('deck_tasks')).structuredContent.groups.inProgress

  // session-b goes on beating; session-a vanishes without ending.
  await clock.set(start + 2 * MINUTE)
  await deck.callTool('deck_heartbeat', { session: 'session-b' })
  await clock.set(start + 3 * MINUTE)
  const atThree = await inProgress()
  await clock.set(start + 3 * MINUTE + 1)
  const pastThree = await inProgress()
  // Back, say from a machine's sleep, it beats again.
  await deck.callTool('deck_heartbeat', { session: 'session-a' })
  const back = await inProgress()

  assert.deepEqual(orphaned(atThree), [])
  assert.deepEqual(orphaned(pastThree), [3])
  assert.deepEqual(occupants(pastThree), { 3: 'session-a', 5: 'session-b' })
  assert.deepEqual(orphaned(back), [])
})

test('an Occupancy of a Session that never beat is Orphaned', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })

  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(orphaned(groups.inProgress), [3])
})

test('an Orphaned Occupancy is taken over or released as any other, and released when its Task closes', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 }), issue({ number: 7 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)
  for (const task of [3, 5, 7]) {
    await deck.callTool('deck_occupy', { session: 'session-a', task })
  }
  await deck.callTool('deck_end_session', { session: 'session-a' })
  await deck.callTool('deck_heartbeat', { session: 'session-b' })

  const taken = await deck.callTool('deck_occupy', { session: 'session-b', task: 3, takeOver: 'session-a' })
  const released = await deck.callTool('deck_release', { task: 5, session: 'session-a' })
  await gh.issues([issue({ number: 3 }), issue({ number: 5 }), issue({ number: 7, state: 'CLOSED', closedAt: '2026-11-13T09:00:00Z' })])
  const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent

  assert.deepEqual(taken.structuredContent, { ok: true, occupied: true, occupant: 'session-b', occupantHost: 'claude-code', occupantShort: 'session-' })
  assert.deepEqual(released.structuredContent, { ok: true, released: true })
  // Taken over, it is the beating Session's and no longer Orphaned.
  assert.deepEqual(occupants(groups.inProgress), { 3: 'session-b' })
  assert.deepEqual(orphaned(groups.inProgress), [])
  assert.deepEqual(numbers(groups.ready), [5])
  assert.deepEqual(numbers(groups.done), [7])
  assert.equal(groups.done[0].occupant, null)
})

test('deck_ask tells the agent which Task in progress is Orphaned', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillFile(join(user, '.claude', 'skills'), 'ask-matt', '问下一步该做什么。')
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3, title: '命令行' }), issue({ number: 4, title: '核对 Pane 的生命周期' })])
  const deck = startDeck(dir, { ...gh.env, HOME: user })
  t.after(deck.stop)
  await deck.callTool('deck_heartbeat', { session: 'session-a' })
  await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })
  await deck.callTool('deck_occupy', { session: 'session-b', task: 4 })
  await deck.callTool('deck_end_session', { session: 'session-b' })

  const { requestId, args } = (await deck.callTool('deck_ask')).structuredContent

  assert.equal(
    args,
    askArgs(
      requestId,
      [
        'Specs and Maps: none',
        'Ready: none',
        'In progress:',
        '- #3 命令行',
        '- #4 核对 Pane 的生命周期, Orphaned: its Session has ended',
        'Blocked: none',
        'Done: 0 Tasks closed',
      ].join('\n'),
    ),
  )
})

// One Acceptance Evidence, with where it comes from.
const EVIDENCE = [
  { text: '在本仓库运行配置技能，生成 .matt-deck/config.json', source: '提交 8254bd7' },
  { text: 'node --test tests/ 全部通过', source: '测试命令 npm test 的输出：# pass 42' },
]

test('deck_report keeps each report of a Task with its Session and time, which every Deck service of the repository reads in its detail', async t => {
  const user = await home()
  const gh = await fakeGh()
  const clock = await fakeClock(Date.UTC(2026, 10, 11, 14, 2))
  await gh.issues([issue({ number: 3 }), issue({ number: 7 }), issue({ number: 15, state: 'CLOSED', closedAt: '2026-11-11T14:07:00Z' })])
  const here = startDeck(await configured(), { ...gh.env, ...clock.env, HOME: user })
  t.after(here.stop)
  const elsewhere = startDeck(await configured(), { ...gh.env, ...clock.env, HOME: user })
  t.after(elsewhere.stop)
  await here.callTool('deck_occupy', { session: 'session-a', task: 3 })

  const first = await here.callTool('deck_report', {
    session: 'session-a',
    task: 3,
    result: '先做了一半，测试还没过。',
    evidence: [],
  })
  await clock.set(Date.UTC(2026, 10, 11, 15, 30))
  const second = await elsewhere.callTool('deck_report', {
    session: 'session-b',
    task: 3,
    result: '已实现并在本仓库运行通过。',
    evidence: EVIDENCE,
  })

  assert.equal(first.isError, false)
  assert.deepEqual(first.structuredContent, { ok: true })
  assert.deepEqual(second.structuredContent, { ok: true })
  await gh.answer({ stdout: viewed({ number: 3 }) })
  for (const deck of [here, elsewhere]) {
    const { reports } = (await deck.callTool('deck_task', { number: 3 })).structuredContent
    // Every report stays, the first first.
    assert.deepEqual(reports, [
      { session: 'session-a', sessionHost: 'claude-code', sessionShort: 'session-', reportedAt: Date.UTC(2026, 10, 11, 14, 2), result: '先做了一半，测试还没过。', evidence: [] },
      { session: 'session-b', sessionHost: 'claude-code', sessionShort: 'session-', reportedAt: Date.UTC(2026, 10, 11, 15, 30), result: '已实现并在本仓库运行通过。', evidence: EVIDENCE },
    ])
  }
  await gh.answer({ stdout: viewed({ number: 7 }) })
  assert.deepEqual((await here.callTool('deck_task', { number: 7 })).structuredContent.reports, [])
  // Deck only keeps the report: the Task stays open on GitHub, and with the
  // Session that held it.
  assert.ok((await gh.calls()).every(call => !call.args.includes('close') && !call.args.includes('edit')))
  await gh.issues([issue({ number: 3 }), issue({ number: 7 }), issue({ number: 15, state: 'CLOSED', closedAt: '2026-11-11T14:07:00Z' })])
  const { groups } = (await here.callTool('deck_tasks', { refresh: true })).structuredContent
  assert.deepEqual(occupants(groups.inProgress), { 3: 'session-a' })
  // Acceptance Evidence is apart from the Task Status: an open Task has it,
  // a closed one does not.
  assert.equal(groups.inProgress[0].hasEvidence, true)
  assert.equal(groups.ready[0].hasEvidence, false)
  assert.equal(groups.done[0].hasEvidence, false)
})

test('deck_report keeps a report while the Task Source cannot be read, once a read has named it', async t => {
  const gh = await fakeGh()
  const clock = await fakeClock(Date.UTC(2026, 10, 11, 14, 2))
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), { ...gh.env, ...clock.env })
  t.after(deck.stop)
  await deck.callTool('deck_tasks')
  // Past the cache, and GitHub out of reach.
  await clock.set(Date.UTC(2026, 10, 11, 14, 3))
  await gh.answer({ exitCode: 1, stderr: 'error connecting to api.github.com\n' })

  const reported = await deck.callTool('deck_report', { session: 'session-a', task: 3, result: '做完了。', evidence: EVIDENCE })

  assert.deepEqual(reported.structuredContent, { ok: true })
  await gh.answer({ stdout: viewed({ number: 3 }) })
  assert.deepEqual((await deck.callTool('deck_task', { number: 3 })).structuredContent.reports, [
    { session: 'session-a', sessionHost: 'claude-code', sessionShort: 'session-', reportedAt: Date.UTC(2026, 10, 11, 14, 3), result: '做完了。', evidence: EVIDENCE },
  ])
})

test('deck_report takes a Task, a result, Acceptance Evidence each with where it comes from, and the Session', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)
  const report = { session: 'session-a', task: 3, result: '做完了。', evidence: EVIDENCE }

  const malformed = await Promise.all(
    [
      { ...report, session: undefined },
      { ...report, session: '' },
      { ...report, task: 0 },
      { ...report, task: '#3' },
      { ...report, result: undefined },
      { ...report, evidence: undefined },
      { ...report, evidence: [{ text: '测试通过' }] },
      { ...report, evidence: [{ text: '测试通过', source: '' }] },
      { ...report, evidence: [{ text: '', source: 'npm test' }] },
      { ...report, evidence: '测试通过' },
    ].map(args => deck.callTool('deck_report', args)),
  )

  assert.deepEqual(
    malformed.map(result => result.isError),
    malformed.map(() => true),
  )
  await gh.answer({ stdout: viewed({ number: 3 }) })
  assert.deepEqual((await deck.callTool('deck_task', { number: 3 })).structuredContent.reports, [])
})

// The Pane in a Codex tab: a page the Deck service serves, opened from the
// tab menu of a Session through a tool with a tab entry.
const PANE_PAGE = join(import.meta.dirname, '..', 'plugin', 'codex', 'pane.html')

test('started for Codex, the Deck service offers the Pane in a tab: a tool with a tab entry, and its page', async t => {
  const deck = startDeck(await workspace(), {}, 'codex')
  t.after(deck.stop)

  const { result: started } = await deck.request('initialize', { protocolVersion: '2025-06-18' })
  const { result: listed } = await deck.request('tools/list')
  const pane = listed.tools.find((tool: any) => tool.name === 'deck_pane')
  const { result: resources } = await deck.request('resources/list')
  const { result: read } = await deck.request('resources/read', { uri: pane._meta.ui.resourceUri })

  assert.deepEqual(started.capabilities.resources, {})
  assert.deepEqual(pane._meta['openai/ui'].entrypoints, [{ type: 'thread' }])
  assert.match(pane.description, /tab menu/)
  assert.deepEqual(
    resources.resources.map(({ uri, mimeType }: any) => ({ uri, mimeType })),
    [{ uri: pane._meta.ui.resourceUri, mimeType: 'text/html;profile=mcp-app' }],
  )
  assert.deepEqual(read.contents, [
    { uri: pane._meta.ui.resourceUri, mimeType: 'text/html;profile=mcp-app', text: await readFile(PANE_PAGE, 'utf8') },
  ])
  assert.equal((await deck.request('resources/read', { uri: 'ui://matt-deck/elsewhere.html' })).error.code, -32602)
  assert.deepEqual((await deck.request('resources/templates/list')).result, { resourceTemplates: [] })
})

test('started for Claude Code, the Deck service offers no Pane in a tab', async t => {
  const deck = startDeck(await workspace())
  t.after(deck.stop)

  const { result: started } = await deck.request('initialize', { protocolVersion: '2025-06-18' })
  const { result: listed } = await deck.request('tools/list')

  assert.deepEqual(started.capabilities, { tools: {} })
  assert.deepEqual(
    listed.tools.filter((tool: any) => tool._meta !== undefined),
    [],
  )
  assert.equal(listed.tools.some((tool: any) => tool.name === 'deck_pane' || tool.name === 'deck_session'), false)
})

test('started for Codex, deck_configure answers the call of the configure skill that install generates, for the page only', async t => {
  const deck = startDeck(await workspace(), {}, 'codex')
  t.after(deck.stop)

  const { result: listed } = await deck.request('tools/list')
  const result = await deck.callTool('deck_configure')

  assert.deepEqual(listed.tools.find((tool: any) => tool.name === 'deck_configure')._meta, { ui: { visibility: ['app'] } })
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { call: '$matt-deck-configure' })
})

test('started for Codex, the tools only the Pane calls and the hook\'s tool are for the page only; the agent\'s, the configure skill\'s, the reads and the Pane\'s entry are not', async t => {
  const deck = startDeck(await workspace(), {}, 'codex')
  t.after(deck.stop)

  const { result: listed } = await deck.request('tools/list')
  const forPage = (tool: any) => tool._meta?.ui?.visibility?.join(',') === 'app'

  assert.deepEqual(listed.tools.filter(forPage).map((tool: any) => tool.name).sort(), [
    'deck_ask',
    'deck_configure',
    'deck_end_session',
    'deck_execute',
    'deck_heartbeat',
    'deck_hook',
    'deck_map',
    'deck_occupy',
    'deck_prompt_submitted',
    'deck_recommendation',
    'deck_release',
    'deck_session',
  ])
  for (const tool of listed.tools.filter(forPage)) {
    assert.deepEqual(tool._meta, { ui: { visibility: ['app'] } }, tool.name)
  }
  assert.deepEqual(listed.tools.filter((tool: any) => !forPage(tool)).map((tool: any) => tool.name).sort(), [
    'deck_config',
    'deck_inspect',
    'deck_pane',
    'deck_recommend',
    'deck_report',
    'deck_setup_survey',
    'deck_skill',
    'deck_skills',
    'deck_task',
    'deck_tasks',
    'deck_write_config',
  ])
  for (const tool of listed.tools.filter((tool: any) => !forPage(tool) && tool.name !== 'deck_pane')) {
    assert.equal(tool._meta, undefined, tool.name)
  }
  assert.deepEqual(listed.tools.find((tool: any) => tool.name === 'deck_pane')._meta, {
    ui: { resourceUri: 'ui://matt-deck/pane.html' },
    'openai/ui': { entrypoints: [{ type: 'thread' }], preferredModelDisplayMode: 'fullscreen' },
  })
})

test('started for Codex, the tools for the page only answer whoever calls them', async t => {
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillFile(join(user, '.claude', 'skills'), 'ask-matt', '问下一步该做什么。')
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)

  const asked = await callFrom(deck, CODEX_SESSION, 'deck_ask', {})
  await deck.callTool('deck_recommend', {
    requestId: asked.structuredContent.requestId,
    task: 3,
    nextStep: '先写测试。',
    skill: '$tdd',
    reason: '没有挡着的。',
    blockers: '',
  })
  const recommended = await callFrom(deck, CODEX_SESSION, 'deck_recommendation', { requestId: asked.structuredContent.requestId })
  const mapped = await callFrom(deck, CODEX_SESSION, 'deck_map', { session: CODEX_SESSION })
  const occupied = await callFrom(deck, CODEX_SESSION, 'deck_occupy', { session: CODEX_SESSION, task: 3 })
  const released = await callFrom(deck, CODEX_SESSION, 'deck_release', { session: CODEX_SESSION, task: 3 })
  const hooked = await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })
  const { occupancies } = (await deck.callTool('deck_inspect')).structuredContent
  const { receivedAt } = (await deck.callTool('deck_hook')).structuredContent
  const beaten = await callFrom(deck, CODEX_SESSION, 'deck_heartbeat', { session: CODEX_SESSION })
  const ended = await callFrom(deck, CODEX_SESSION, 'deck_end_session', { session: CODEX_SESSION })

  assert.equal(asked.structuredContent.ok, true)
  assert.equal(asked.structuredContent.call, '$ask-matt')
  assert.deepEqual(recommended.structuredContent, {
    found: true,
    recommendation: { task: 3, nextStep: '先写测试。', skill: '$tdd', reason: '没有挡着的。', blockers: '' },
  })
  assert.equal(mapped.structuredContent.ok, true)
  assert.deepEqual(mapped.structuredContent.maps, [])
  assert.deepEqual([occupied.structuredContent.ok, occupied.structuredContent.occupied], [true, true])
  assert.deepEqual(released.structuredContent, { ok: true, released: true })
  assert.deepEqual(hooked, { content: [], isError: false })
  assert.deepEqual(occupancies.map((each: any) => [each.task, each.session]), [[3, CODEX_SESSION]])
  assert.equal(typeof receivedAt, 'number')
  assert.deepEqual([beaten, ended], [
    { content: [{ type: 'text', text: 'Recorded.' }], isError: false },
    { content: [{ type: 'text', text: 'Recorded.' }], isError: false },
  ])
})

test('started for Codex, deck_session names the Session a call comes from by its _meta.threadId, for the page only', async t => {
  const deck = startDeck(await workspace(), {}, 'codex')
  t.after(deck.stop)

  const { result: listed } = await deck.request('tools/list')
  const { result: named } = await deck.request('tools/call', {
    name: 'deck_session',
    arguments: {},
    _meta: { threadId: CODEX_SESSION, progressToken: 1 },
  })
  const unnamed = await Promise.all(
    [undefined, {}, { threadId: '' }].map(_meta =>
      deck.request('tools/call', { name: 'deck_session', arguments: {}, _meta }).then(reply => reply.result),
    ),
  )

  assert.deepEqual(listed.tools.find((tool: any) => tool.name === 'deck_session')._meta, { ui: { visibility: ['app'] } })
  assert.deepEqual(named.structuredContent, { session: CODEX_SESSION, sessionHost: 'codex', sessionShort: '045b96fc' })
  for (const result of unnamed) {
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /_meta\.threadId/)
  }
})

// Codex also starts Deck services that live a few seconds and receive no tool
// call (ADR-0006): until a tool is called, a Deck service writes nothing.
test('started for Codex, the Deck service writes no local state before its first tool call', async t => {
  const user = await home()
  const deck = startDeck(await workspace(), { HOME: user }, 'codex')
  t.after(deck.stop)

  await deck.request('initialize', { protocolVersion: '2025-06-18' })
  await deck.request('tools/list')
  await deck.request('resources/list')
  await deck.request('resources/read', { uri: 'ui://matt-deck/pane.html' })
  await deck.request('ping')

  assert.deepEqual(await readdir(user), [])
})

// A tool call as Codex sends it, naming the Session in _meta.threadId: the
// page's, the agent's and a hook's alike.
const callFrom = (deck: ReturnType<typeof startDeck>, session: string | undefined, name: string, args: object) =>
  deck
    .request('tools/call', { name, arguments: args, ...(session === undefined ? {} : { _meta: { threadId: session, progressToken: 1 } }) })
    .then(reply => reply.result)

test('started for Codex, deck_execute answers the Execute Prompt of a Task, $implement on it and the ask to report through deck_report, for the page only', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 1 }), issue({ number: 74 })])
  const { dir, user } = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillFile(join(user, '.claude', 'skills'), 'implement', '开始做一个 Task。')
  const deck = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)

  const { result: listed } = await deck.request('tools/list')
  const result = await callFrom(deck, CODEX_SESSION, 'deck_execute', { task: 74 })
  const first = await callFrom(deck, CODEX_SESSION, 'deck_execute', { task: 1 })
  const malformed = await Promise.all([{}, { task: 0 }, { task: 1.5 }, { task: '#74' }].map(args => deck.callTool('deck_execute', args)))

  assert.deepEqual(listed.tools.find((tool: any) => tool.name === 'deck_execute')._meta, { ui: { visibility: ['app'] } })
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    ok: true,
    prompt:
      '$implement #74\n\nWhen you finish, call the tool deck_report for Task #74: what you did, and the Acceptance Evidence for each acceptance criterion with where it comes from.',
  })
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  assert.equal(
    first.structuredContent.prompt,
    '$implement #1\n\nWhen you finish, call the tool deck_report for Task #1: what you did, and the Acceptance Evidence for each acceptance criterion with where it comes from.',
  )
  assert.deepEqual(malformed.map(each => each.isError), [true, true, true, true])
  // Only filled in, the prompt occupies nothing.
  assert.deepEqual((await deck.callTool('deck_inspect')).structuredContent.occupancies, [])
})

// The Codex hook on UserPromptSubmit calls this tool with the prompt sent.
const HOOK_TOOL = 'deck_prompt_submitted'

test('started for Codex, the hook\'s tool records the Session\'s Occupancy of each Task a line of the prompt runs $implement on, by #12, 12 or a link to this repository\'s issue, and answers no text', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([3, 5, 7, 9, 11, 13, 15, 21, 23, 25, 27].map(number => issue({ number })))
  const codex = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(codex.stop)
  const claude = startDeck(dir, { ...gh.env, HOME: user })
  t.after(claude.stop)

  // A draft the Execute Prompt was appended to, and a call typed by hand.
  const sent = await callFrom(codex, CODEX_SESSION, HOOK_TOOL, {
    prompt: [
      'a draft that says $implement #9 in passing',
      'try first: #9 then $implement',
      ' #9',
      ' $implement #11',
      // Before the Tasks it records: one it records none for stops nothing.
      '$implement https://github.com/acme/other/issues/13',
      '$implement https://github.com/acme/shop/pull/9',
      '$implement #9x',
      '$implement #9-',
      '$implement 顺便看 #9',
      '',
      '$implement #3',
      '',
      'When you finish, call the tool deck_report for Task #3.',
      '$implement 5 and then some',
      '$implement https://github.com/acme/shop/issues/7',
      '$implementation #15',
      '$implement15',
      '$implement9 now',
      '/implement #15',
      '$implement',
      '$implement #21\tand more',
      '$implement\t#27',
      '$implement 23',
      '$implement https://github.com/acme/shop/issues/25',
    ].join('\n'),
  })

  assert.deepEqual(sent, { content: [], isError: false })
  // In progress for every host's Pane, with this Session.
  for (const deck of [codex, claude]) {
    const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
    assert.deepEqual(occupants(groups.inProgress), {
      3: CODEX_SESSION,
      5: CODEX_SESSION,
      7: CODEX_SESSION,
      21: CODEX_SESSION,
      23: CODEX_SESSION,
      25: CODEX_SESSION,
      27: CODEX_SESSION,
    })
    assert.deepEqual(numbers(groups.ready), [9, 11, 13, 15])
  }
})

test('the hook\'s tool records no Occupancy for a prompt with no $implement on a Task, reading no Task Source, nor without a Session, nor for a closed or unknown Task', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 4, state: 'CLOSED', closedAt: '2026-11-11T14:07:00Z' })])
  const deck = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)

  const quiet = [
    await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '帮我看看 #3 和 $tdd 3' }),
    await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '' }),
    await callFrom(deck, undefined, HOOK_TOOL, { prompt: '$implement #3' }),
    await callFrom(deck, '', HOOK_TOOL, { prompt: '$implement #3' }),
    await callFrom(deck, 7 as unknown as string, HOOK_TOOL, { prompt: '$implement #3' }),
  ]
  assert.deepEqual(await gh.calls(), [])
  quiet.push(await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #4\n$implement #8' }))
  // Not even in the local state, for the next read to release. deck_inspect
  // lists an open Task's Occupancies only, so the state is read itself.
  const state = new DatabaseSync(join(user, '.matt-deck', 'deck.sqlite'), { readOnly: true })
  const recorded = state.prepare('SELECT * FROM occupancies').all()
  state.close()
  assert.deepEqual(recorded, [])

  for (const each of quiet) {
    assert.deepEqual(each, { content: [], isError: false })
  }
  const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
  assert.deepEqual(groups.inProgress, [])
})

test('the hook\'s tool returns at once in a project that is not configured, as in Codex\'s own Sessions: no Task Source read, no state written, no text', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await workspace(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)

  const sent = await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })

  assert.deepEqual(sent, { content: [], isError: false })
  assert.deepEqual(await gh.calls(), [])
  assert.deepEqual(await readdir(user), [])
})

test('the hook\'s tool answers no text even when the Task Source cannot be read', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.answer({ exitCode: 1, stderr: 'error connecting to api.github.com\n' })
  const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)

  assert.deepEqual(await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' }), { content: [], isError: false })
})

test('the hook\'s tool reads the Task Source from the Deck service\'s cache, as deck_tasks does', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)
  await deck.callTool('deck_tasks', { refresh: true })
  const read = (await gh.calls()).length

  await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })

  assert.equal((await gh.calls()).length, read)
  const { occupancies } = (await deck.callTool('deck_inspect')).structuredContent
  assert.deepEqual(occupancies.map((each: any) => [each.task, each.session]), [[3, CODEX_SESSION]])
})

test('the hook\'s tool records every Task of the prompt while another writer holds the local state a moment', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)
  // Read before, the Task Source is read from the cache: the hook's tool
  // comes to its write at once.
  await deck.callTool('deck_tasks', { refresh: true })
  await mkdir(join(user, '.matt-deck'), { recursive: true })
  const writer = new DatabaseSync(join(user, '.matt-deck', 'deck.sqlite'))
  writer.exec('BEGIN IMMEDIATE')

  const sent = callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3\n$implement #5' })
  // Short of the 2 seconds a write waits.
  await new Promise(resolve => setTimeout(resolve, 1_500))
  writer.exec('COMMIT')
  writer.close()

  assert.deepEqual(await sent, { content: [], isError: false })
  const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
  assert.deepEqual(occupants(groups.inProgress), { 3: CODEX_SESSION, 5: CODEX_SESSION })
})

test('the hook\'s tools of Deck services called at once record each one\'s Task', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  const tasks = [3, 5, 7, 9, 11, 13, 15, 17]
  await gh.issues(tasks.map(number => issue({ number })))
  const decks = tasks.map(() => startDeck(dir, { ...gh.env, HOME: user }, 'codex'))
  for (const deck of decks) t.after(deck.stop)

  await Promise.all(decks.map((deck, at) => callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: `$implement #${tasks[at]}` })))

  const { groups } = (await decks[0]!.callTool('deck_tasks', { refresh: true })).structuredContent
  assert.deepEqual(numbers(groups.inProgress), tasks)
})

test('the hook\'s tool records the Tasks after one whose Occupancy fails to be written', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)
  // A local state that refuses the Occupancy of #3 alone.
  await mkdir(join(user, '.matt-deck'))
  const db = new DatabaseSync(join(user, '.matt-deck', 'deck.sqlite'))
  db.exec(
    'CREATE TABLE occupancies (source TEXT NOT NULL, task INTEGER NOT NULL, session TEXT NOT NULL, occupied_at INTEGER NOT NULL, PRIMARY KEY (source, task))',
  )
  db.exec("CREATE TRIGGER refuse_3 BEFORE INSERT ON occupancies WHEN NEW.task = 3 BEGIN SELECT RAISE(ABORT, 'refused 3'); END")
  db.close()

  const sent = await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3\n$implement #5' })

  assert.deepEqual(sent, { content: [], isError: false })
  const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
  assert.deepEqual(occupants(groups.inProgress), { 5: CODEX_SESSION })
})

test('$implement typed on a Task another Session holds leaves it with that Session', async t => {
  const dir = await configured()
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(dir, { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)
  await callFrom(deck, CODEX_NEIGHBOUR, HOOK_TOOL, { prompt: '$implement #3' })

  await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })

  const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
  assert.deepEqual(occupants(groups.inProgress), { 3: CODEX_NEIGHBOUR })
})

// Deck's hook runs only once the person trusted it (ADR-0006): the Pane in a
// tab tells from deck_hook whether it ever has.
test('started for Codex, deck_hook answers when a hook\'s tool of this machine last received a call in a Configured Project, null before any, for the page only', async t => {
  const dir = await configured()
  const user = await home()
  const clock = await fakeClock(Date.UTC(2026, 10, 26, 9, 0))
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const pane = startDeck(dir, { ...gh.env, ...clock.env, HOME: user }, 'codex')
  t.after(pane.stop)
  const elsewhere = startDeck(dir, { ...gh.env, ...clock.env, HOME: user }, 'codex')
  t.after(elsewhere.stop)
  const unconfigured = startDeck(await workspace(), { ...gh.env, ...clock.env, HOME: user }, 'codex')
  t.after(unconfigured.stop)

  const { result: listed } = await pane.request('tools/list')
  const before = await callFrom(pane, CODEX_SESSION, 'deck_hook', {})
  // A call from a Deck service started outside any Configured Project.
  await callFrom(unconfigured, CODEX_NEIGHBOUR, HOOK_TOOL, { prompt: '$implement #3' })
  const outside = await callFrom(pane, CODEX_SESSION, 'deck_hook', {})
  // Another Deck service, on a prompt that runs nothing, with no Session set
  // by the test.
  await callFrom(elsewhere, undefined, HOOK_TOOL, { prompt: '只是问问 k3v9' })
  const received = await callFrom(pane, CODEX_SESSION, 'deck_hook', {})
  await clock.set(Date.UTC(2026, 10, 26, 9, 5))
  await callFrom(pane, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })
  // A Deck service that read its clock before, writing after.
  await clock.set(Date.UTC(2026, 10, 26, 9, 1))
  await callFrom(elsewhere, CODEX_NEIGHBOUR, HOOK_TOOL, { prompt: '只是问问 k3v9' })
  const again = await callFrom(pane, CODEX_SESSION, 'deck_hook', {})

  assert.deepEqual(listed.tools.find((tool: any) => tool.name === 'deck_hook')._meta, { ui: { visibility: ['app'] } })
  assert.equal(before.isError, false)
  assert.deepEqual(before.structuredContent, { receivedAt: null })
  assert.deepEqual(JSON.parse(before.content[0].text), before.structuredContent)
  assert.deepEqual(outside.structuredContent, { receivedAt: null })
  assert.deepEqual(received.structuredContent, { receivedAt: Date.UTC(2026, 10, 26, 9, 0) })
  assert.deepEqual(again.structuredContent, { receivedAt: Date.UTC(2026, 10, 26, 9, 5) })
})

// The Session that configures its project calls the hook's tool before the
// project is configured, on the prompt calling the configure skill.
test('a hook\'s call this Deck service received before its project was configured counts for its deck_hook once configured, in no other Deck service and in no local state', async t => {
  const dir = await workspace()
  const user = await home()
  const clock = await fakeClock(Date.UTC(2026, 10, 27, 9, 0))
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(dir, { ...gh.env, ...clock.env, HOME: user }, 'codex')
  t.after(deck.stop)
  const other = startDeck(dir, { ...gh.env, ...clock.env, HOME: user }, 'codex')
  t.after(other.stop)

  const sent = await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$matt-deck-configure\n$implement #3' })
  const stateBefore = await readdir(user)
  const readsBefore = await gh.calls()
  await clock.set(Date.UTC(2026, 10, 27, 9, 2))
  await callFrom(deck, CODEX_SESSION, 'deck_write_config', {
    config: { taskSource: { type: 'github-issues' }, skillSource: { type: 'plugin', name: 'mattpocock-skills' } },
  })
  const received = await callFrom(deck, CODEX_SESSION, 'deck_hook', {})
  const elsewhere = await callFrom(other, CODEX_NEIGHBOUR, 'deck_hook', {})

  assert.deepEqual(sent, { content: [], isError: false })
  assert.deepEqual(stateBefore, [])
  assert.deepEqual(readsBefore, [])
  assert.deepEqual(received.structuredContent, { receivedAt: Date.UTC(2026, 10, 27, 9, 0) })
  assert.deepEqual(elsewhere.structuredContent, { receivedAt: null })
})

test('deck_hook answers the later of the time in the local state and the time of the hook\'s last call this Deck service received before its project was configured', async t => {
  const user = await home()
  const clock = await fakeClock(Date.UTC(2026, 10, 27, 9, 0))
  const unconfigured = startDeck(await workspace(), { ...clock.env, HOME: user }, 'codex')
  t.after(unconfigured.stop)
  const configuredDeck = startDeck(await configured(), { ...clock.env, HOME: user }, 'codex')
  t.after(configuredDeck.stop)

  await callFrom(unconfigured, CODEX_SESSION, HOOK_TOOL, { prompt: '只是问问 h4w2' })
  await clock.set(Date.UTC(2026, 10, 27, 9, 5))
  await callFrom(configuredDeck, CODEX_NEIGHBOUR, HOOK_TOOL, { prompt: '只是问问 h4w2' })
  const stateLater = await callFrom(unconfigured, CODEX_SESSION, 'deck_hook', {})
  await clock.set(Date.UTC(2026, 10, 27, 9, 10))
  await callFrom(unconfigured, CODEX_SESSION, HOOK_TOOL, { prompt: '只是问问 h4w2' })
  const processLater = await callFrom(unconfigured, CODEX_SESSION, 'deck_hook', {})

  assert.deepEqual(stateLater.structuredContent, { receivedAt: Date.UTC(2026, 10, 27, 9, 5) })
  assert.deepEqual(processLater.structuredContent, { receivedAt: Date.UTC(2026, 10, 27, 9, 10) })
  assert.deepEqual((await callFrom(configuredDeck, CODEX_NEIGHBOUR, 'deck_hook', {})).structuredContent, {
    receivedAt: Date.UTC(2026, 10, 27, 9, 5),
  })
})

// The command line that installs Deck into Codex, run in the test's home.
const CODEX_CLI = join(import.meta.dirname, '..', 'plugin', 'cli', 'codex.ts')
const codexCli = (user: string, command: string) => exec(process.execPath, [CODEX_CLI, command], { env: { ...process.env, HOME: user } })

// Codex asks for trust again once Deck's hook moves in the hooks file: an
// install that writes the hook in forgets the calls received before it.
test('install that writes Deck\'s hook into the Codex hooks forgets the hook\'s calls received before: deck_hook answers null', async t => {
  const user = await home()
  const deck = startDeck(await configured(), { HOME: user }, 'codex')
  t.after(deck.stop)
  await codexCli(user, 'install')
  await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '只是问问 r2m8' })
  await codexCli(user, 'uninstall')
  // The person's own hook on UserPromptSubmit, ahead of where Deck's goes.
  const hooks = join(user, '.codex', 'hooks.json')
  await writeFile(hooks, `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2)}\n`)
  const received = (await callFrom(deck, CODEX_SESSION, 'deck_hook', {})).structuredContent

  await codexCli(user, 'install')

  assert.notEqual(received.receivedAt, null)
  assert.deepEqual((await callFrom(deck, CODEX_SESSION, 'deck_hook', {})).structuredContent, { receivedAt: null })
})

test('install that finds Deck\'s hook there already keeps the time of the hook\'s last call', async t => {
  const user = await home()
  const clock = await fakeClock(Date.UTC(2026, 10, 26, 9, 0))
  const deck = startDeck(await configured(), { ...clock.env, HOME: user }, 'codex')
  t.after(deck.stop)
  await codexCli(user, 'install')
  await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '只是问问 r2m8' })

  await codexCli(user, 'install')

  assert.deepEqual((await callFrom(deck, CODEX_SESSION, 'deck_hook', {})).structuredContent, { receivedAt: Date.UTC(2026, 10, 26, 9, 0) })
})

test('install that fails to forget the hook\'s calls, the local state not being a database, still writes Deck\'s hook in and succeeds, leaving the state as it is', async () => {
  const user = await home()
  await mkdir(join(user, '.matt-deck'))
  const state = join(user, '.matt-deck', 'deck.sqlite')
  await writeFile(state, 'not a database q4n7\n')

  await codexCli(user, 'install')

  const { hooks } = JSON.parse(await readFile(join(user, '.codex', 'hooks.json'), 'utf8'))
  assert.deepEqual(
    hooks.UserPromptSubmit.flatMap((group: any) => group.hooks).map((handler: any) => [handler.server, handler.tool]),
    [['matt_deck', HOOK_TOOL]],
  )
  assert.equal(await readFile(state, 'utf8'), 'not a database q4n7\n')
})

test('install without a local state writes none', async () => {
  const user = await home()

  const { stdout } = await codexCli(user, 'install')

  assert.match(stdout, /加上 Deck 的钩子/)
  assert.deepEqual((await readdir(user)).sort(), ['.agents', '.codex'])
})

test('the hook\'s tool records the Occupancy when the time of the call fails to be written', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)
  // A local state that refuses the time of a call from the hook.
  await mkdir(join(user, '.matt-deck'))
  const db = new DatabaseSync(join(user, '.matt-deck', 'deck.sqlite'))
  db.exec('CREATE TABLE hook_calls (id INTEGER PRIMARY KEY CHECK (id = 0), received_at INTEGER NOT NULL)')
  db.exec("CREATE TRIGGER refuse_call BEFORE INSERT ON hook_calls BEGIN SELECT RAISE(ABORT, 'refused z8q1'); END")
  db.close()

  const sent = await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })

  assert.deepEqual(sent, { content: [], isError: false })
  assert.deepEqual((await callFrom(deck, CODEX_SESSION, 'deck_hook', {})).structuredContent, { receivedAt: null })
  const { groups } = (await deck.callTool('deck_tasks', { refresh: true })).structuredContent
  assert.deepEqual(occupants(groups.inProgress), { 3: CODEX_SESSION })
})

test('started for Codex, deck_report keeps a report sent with no Session under the Session the call comes from', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const codex = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(codex.stop)
  const claude = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(claude.stop)

  const reported = await callFrom(codex, CODEX_SESSION, 'deck_report', { task: 3, result: '做完了。', evidence: [] })
  // A Session the agent names stays the one named.
  await callFrom(codex, CODEX_SESSION, 'deck_report', { task: 3, session: CODEX_NEIGHBOUR, result: '旁边的。', evidence: [] })
  // Claude Code names no Session in the call: the Mod passes it.
  const unnamed = await callFrom(claude, CLAUDE_SESSION, 'deck_report', { task: 3, result: '也做完了。', evidence: [] })

  assert.deepEqual(reported.structuredContent, { ok: true })
  assert.equal(unnamed.isError, true)
  await gh.answer({ stdout: viewed({ number: 3 }) })
  const { reports } = (await codex.callTool('deck_task', { number: 3 })).structuredContent
  assert.deepEqual(reports.map((report: any) => [report.session, report.result]), [[CODEX_SESSION, '做完了。'], [CODEX_NEIGHBOUR, '旁边的。']])
})

test('only started for Codex does the Deck service offer the hook\'s tool and deck_hook, both for the page only; deck_execute it offers both hosts, for the page only in Codex', async t => {
  const claude = startDeck(await configured())
  t.after(claude.stop)
  const codex = startDeck(await configured(), {}, 'codex')
  t.after(codex.stop)

  const named = (listed: any, name: string) => listed.tools.find((tool: any) => tool.name === name)
  const { result: forClaude } = await claude.request('tools/list')
  const { result: forCodex } = await codex.request('tools/list')
  const refused = await Promise.all(
    [
      [HOOK_TOOL, { prompt: '$implement #3' }],
      ['deck_hook', {}],
    ].map(([name, args]) => claude.request('tools/call', { name, arguments: args, _meta: { threadId: CODEX_SESSION } })),
  )

  assert.deepEqual([named(forClaude, HOOK_TOOL), named(forClaude, 'deck_hook')], [undefined, undefined])
  assert.deepEqual(refused.map(reply => reply.error?.code), [-32602, -32602])
  // Claude Code's Mod calls it: unmarked there.
  assert.equal(named(forClaude, 'deck_execute')._meta, undefined)
  assert.deepEqual(named(forCodex, HOOK_TOOL)._meta, { ui: { visibility: ['app'] } })
  assert.deepEqual(named(forCodex, 'deck_execute')._meta, { ui: { visibility: ['app'] } })
})

test('the hook\'s tool reads a prompt written with CRLF, a link to the repository in another case, and a Task called twice as one Occupancy', async t => {
  const user = await home()
  const gh = await fakeGh()
  // GitHub names the repository in its own case, not always lower.
  await gh.issues([issue({ number: 3 }), issue({ number: 5 }), issue({ number: 7 })], 'ACME/Shop')
  const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)

  await callFrom(deck, CODEX_SESSION, HOOK_TOOL, {
    prompt: 'a draft\r\n\r\n$implement #3\r\n$implement 3\r\n$implement 5\r\n$implement https://github.com/Acme/Shop/issues/7\r\n',
  })

  const { occupancies } = (await deck.callTool('deck_inspect')).structuredContent
  assert.deepEqual(occupancies.map((each: any) => [each.task, each.session]), [[3, CODEX_SESSION], [5, CODEX_SESSION], [7, CODEX_SESSION]])
})

test('started for Codex, deck_report with no Session, in the call or in its _meta, keeps nothing and says it needs one', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const deck = startDeck(await configured(), gh.env, 'codex')
  t.after(deck.stop)

  const unnamed = await callFrom(deck, undefined, 'deck_report', { task: 3, result: '做完了。', evidence: [] })

  assert.equal(unnamed.isError, true)
  assert.match(unnamed.content[0].text, /the id of the Session reporting/)
  await gh.answer({ stdout: viewed({ number: 3 }) })
  assert.deepEqual((await deck.callTool('deck_task', { number: 3 })).structuredContent.reports, [])
})

// Long enough for every Deck service to notice its clock moved: the fake
// clock looks every few milliseconds.
const tick = () => new Promise(resolve => setTimeout(resolve, 300))

// Each Occupancy as a Pane reads it: its Task, Session, host and whether it
// is Orphaned.
const heldIn = async (deck: ReturnType<typeof startDeck>) =>
  (await deck.callTool('deck_inspect')).structuredContent.occupancies.map(
    ({ task, session, sessionHost, isOrphaned }: any) => [task, session, sessionHost, isOrphaned],
  )

test('started for Codex, a Deck service beats for the Session its first call names, at once and every minute after; vanished, the Occupancy is Orphaned three minutes after the last beat, and held again from the Session\'s next call', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 }), issue({ number: 7 })])
  const start = Date.UTC(2026, 10, 26, 9, 0)
  const clock = await fakeClock(start)
  const env = { ...gh.env, ...clock.env, HOME: user }
  const dir = await configured()
  const claude = startDeck(dir, env)
  t.after(claude.stop)
  // Two Sessions, each with the Deck service Codex starts it.
  const early = startDeck(dir, env, 'codex')
  t.after(early.stop)
  const late = startDeck(dir, env, 'codex')
  t.after(late.stop)
  await callFrom(early, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })
  // A Session a later call names is not the one the service beats for.
  const later = '019a8c3e-1f2b-7c4d-9e0f-2e3f88a1bb26'
  await callFrom(early, later, HOOK_TOOL, { prompt: '$implement #7' })
  await callFrom(late, CODEX_NEIGHBOUR, HOOK_TOOL, { prompt: '$implement #5' })
  const atOnce = await heldIn(claude)

  // One vanishes a moment before its first minute, one as its second ends.
  await clock.set(start + MINUTE - 1)
  await tick()
  await early.end('SIGKILL')
  for (const now of [start + MINUTE, start + 2 * MINUTE - 1, start + 2 * MINUTE]) {
    await clock.set(now)
    await tick()
  }
  await late.end('SIGKILL')
  await clock.set(start + 3 * MINUTE)
  const atThree = await heldIn(claude)
  await clock.set(start + 3 * MINUTE + 1)
  const pastThree = await heldIn(claude)
  await clock.set(start + 5 * MINUTE)
  const atFive = await heldIn(claude)
  await clock.set(start + 5 * MINUTE + 1)
  const pastFive = await heldIn(claude)
  // Back in the first Session, Codex starts it a new Deck service, which the
  // Pane opened there calls: its first read already shows its own
  // Occupancy in progress.
  const resumed = startDeck(dir, env, 'codex')
  t.after(resumed.stop)
  const firstRead = (await callFrom(resumed, CODEX_SESSION, 'deck_tasks', {})).structuredContent.groups.inProgress.map(
    ({ number, isOrphaned }: any) => [number, isOrphaned],
  )
  const back = await heldIn(claude)

  assert.deepEqual(atOnce, [
    [3, CODEX_SESSION, 'codex', false],
    [5, CODEX_NEIGHBOUR, 'codex', false],
    [7, later, 'claude-code', true],
  ])
  assert.deepEqual(atThree.slice(0, 2), [[3, CODEX_SESSION, 'codex', false], [5, CODEX_NEIGHBOUR, 'codex', false]])
  assert.deepEqual(pastThree.slice(0, 2), [[3, CODEX_SESSION, 'codex', true], [5, CODEX_NEIGHBOUR, 'codex', false]])
  assert.deepEqual(atFive[1], [5, CODEX_NEIGHBOUR, 'codex', false])
  assert.deepEqual(pastFive[1], [5, CODEX_NEIGHBOUR, 'codex', true])
  assert.deepEqual(firstRead.slice(0, 2), [[3, false], [5, true]])
  assert.deepEqual(back.slice(0, 2), [[3, CODEX_SESSION, 'codex', false], [5, CODEX_NEIGHBOUR, 'codex', true]])
})

test('started for Codex, a Deck service beats again a minute after its first beat: vanished after that beat and before the next, its Occupancy is held three minutes after it and Orphaned past them', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const start = Date.UTC(2026, 10, 26, 9, 0)
  const clock = await fakeClock(start)
  const env = { ...gh.env, ...clock.env, HOME: user }
  const dir = await configured()
  const claude = startDeck(dir, env)
  t.after(claude.stop)
  const deck = startDeck(dir, env, 'codex')
  t.after(deck.stop)
  await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })

  await clock.set(start + MINUTE)
  await tick()
  await deck.end('SIGKILL')
  await clock.set(start + 4 * MINUTE)
  const atFour = await heldIn(claude)
  await clock.set(start + 4 * MINUTE + 1)
  const pastFour = await heldIn(claude)

  assert.deepEqual(atFour, [[3, CODEX_SESSION, 'codex', false]])
  assert.deepEqual(pastFour, [[3, CODEX_SESSION, 'codex', true]])
})

test('started for Codex, a Deck service the host ends by SIGTERM records its Session\'s end: the Occupancy is Orphaned in every Pane, Claude Code\'s too, until a new Deck service for that Session is called', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const env = { ...gh.env, HOME: user }
  const dir = await configured()
  const claude = startDeck(dir, env)
  t.after(claude.stop)
  const other = startDeck(dir, env, 'codex')
  t.after(other.stop)
  const ending = startDeck(dir, env, 'codex')
  t.after(ending.stop)
  const inProgress = async (deck: ReturnType<typeof startDeck>, session?: string) =>
    (await callFrom(deck, session, 'deck_tasks', {})).structuredContent.groups.inProgress.map(
      ({ number, occupant, occupantHost, isOrphaned }: any) => [number, occupant, occupantHost, isOrphaned],
    )
  await callFrom(ending, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })
  const before = await inProgress(claude)

  const exitedBy = await ending.end()
  const inClaudeCode = await inProgress(claude)
  const inCodex = await inProgress(other, CODEX_NEIGHBOUR)
  // Back in that Session, a message sent calls the hook's tool of the Deck
  // service Codex starts it anew.
  const resumed = startDeck(dir, env, 'codex')
  t.after(resumed.stop)
  await callFrom(resumed, CODEX_SESSION, HOOK_TOOL, { prompt: '接着做' })
  const back = await inProgress(claude)

  // It ends as it did before it recorded anything.
  assert.equal(exitedBy, 'SIGTERM')
  assert.deepEqual(before, [[3, CODEX_SESSION, 'codex', false]])
  assert.deepEqual(inClaudeCode, [[3, CODEX_SESSION, 'codex', true]])
  assert.deepEqual(inCodex, [[3, CODEX_SESSION, 'codex', true]])
  assert.deepEqual(back, [[3, CODEX_SESSION, 'codex', false]])
})

test('a Deck service no call has named a Session to beats for none and records no end as it is ended, nor does one started for Claude Code, whose Mod beats, whatever a call names', async t => {
  const start = Date.UTC(2026, 10, 26, 9, 0)
  const clock = await fakeClock(start)
  const codexHome = await home()
  const claudeHome = await home()
  const codex = startDeck(await configured(), { ...clock.env, HOME: codexHome }, 'codex')
  t.after(codex.stop)
  const claude = startDeck(await configured(), { ...clock.env, HOME: claudeHome })
  t.after(claude.stop)
  await codex.request('initialize', { protocolVersion: '2025-06-18' })
  await codex.request('tools/list')
  await callFrom(codex, undefined, 'deck_configure', {})
  await callFrom(codex, '', 'deck_configure', {})
  await callFrom(codex, 7 as unknown as string, 'deck_configure', {})
  await callFrom(claude, CLAUDE_SESSION, 'deck_config', {})

  await clock.set(start + 5 * MINUTE)
  await tick()
  const exitedBy = await Promise.all([codex.end(), claude.end()])

  assert.deepEqual(exitedBy, ['SIGTERM', 'SIGTERM'])
  assert.deepEqual(await readdir(codexHome), [])
  assert.deepEqual(await readdir(claudeHome), [])
})

test('started for Codex in a project that is not configured, a Deck service beats for none and records no end; configured since, it beats from its next call', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 })])
  const env = { ...gh.env, HOME: user }
  const dir = await workspace()
  const before = startDeck(dir, env, 'codex')
  t.after(before.stop)
  await callFrom(before, CODEX_SESSION, 'deck_config', {})
  const exitedBy = await before.end()
  const left = await readdir(user)
  const deck = startDeck(dir, env, 'codex')
  t.after(deck.stop)
  await callFrom(deck, CODEX_SESSION, 'deck_config', {})
  // Nor while its config is malformed.
  await mkdir(join(dir, '.matt-deck'))
  await writeFile(join(dir, '.matt-deck', 'config.json'), '{ not json')
  await callFrom(deck, CODEX_SESSION, 'deck_config', {})
  const malformed = await readdir(user)
  await writeFile(
    join(dir, '.matt-deck', 'config.json'),
    JSON.stringify({ taskSource: { type: 'github-issues' }, skillSource: { type: 'plugin', name: 'mattpocock-skills' } }),
  )

  await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' })

  assert.equal(exitedBy, 'SIGTERM')
  assert.deepEqual(left, [])
  assert.deepEqual(malformed, [])
  const claude = startDeck(dir, env)
  t.after(claude.stop)
  assert.deepEqual(await heldIn(claude), [[3, CODEX_SESSION, 'codex', false]])
})

test('started for Codex, a Deck service two Sessions call at once beats for one of them only', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 3 }), issue({ number: 5 })])
  const env = { ...gh.env, HOME: user }
  const dir = await configured()
  const deck = startDeck(dir, env, 'codex')
  t.after(deck.stop)
  const claude = startDeck(dir, env)
  t.after(claude.stop)

  await Promise.all([
    callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: '$implement #3' }),
    callFrom(deck, CODEX_NEIGHBOUR, HOOK_TOOL, { prompt: '$implement #5' }),
  ])

  const held = await heldIn(claude)
  assert.deepEqual(held.map(([task]: any) => task), [3, 5])
  assert.deepEqual(held.map(([, , , isOrphaned]: any) => isOrphaned).sort(), [false, true])
})

// A Deck service that failed to exit would keep the test waiting.
test('started for Codex, a Deck service that beats exits as its input closes, as one that does not', { timeout: 10_000 }, async t => {
  const user = await home()
  const deck = startDeck(await configured(), { HOME: user }, 'codex')
  t.after(deck.stop)
  await callFrom(deck, CODEX_SESSION, 'deck_config', {})

  assert.equal(await deck.close(), 0)
})

test('started for Codex, a Deck service whose local state cannot be written still answers the call it beats on, and ends by SIGTERM', async t => {
  const user = await home()
  // Where the local state's folder would be, a file.
  await writeFile(join(user, '.matt-deck'), '')
  const dir = await configured()
  const deck = startDeck(dir, { HOME: user }, 'codex')
  t.after(deck.stop)

  const answered = await callFrom(deck, CODEX_SESSION, 'deck_config', {})

  assert.equal(answered.structuredContent.configured, true)
  assert.equal(await deck.end(), 'SIGTERM')
})

test('deck_map answers the list deck_tasks gives, every field of it, and Map Views that agree with it', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([issue({ number: 1, title: '规格' }), issue({ number: 2, parent: 1 }), issue({ number: 3, parent: 1 }), issue({ number: 4, parent: 1, blockedBy: [2] })])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
  t.after(deck.stop)
  await deck.callTool('deck_occupy', { task: 3, session: CODEX_SESSION })

  const tasks = (await deck.callTool('deck_tasks')).structuredContent
  const { maps, ...list } = (await deck.callTool('deck_map', { session: CODEX_SESSION })).structuredContent

  assert.deepEqual(list, tasks)
  const listed = new Map<number, [string, any]>()
  for (const [group, each] of Object.entries(list.groups) as [string, any[]][]) for (const task of each) listed.set(task.number, [group, task])
  for (const card of maps[0].wall) {
    const [group, task] = listed.get(card.number)!
    assert.deepEqual([card.group, card.occupant, card.isOrphaned], [group, task.occupant, task.isOrphaned], `#${card.number}`)
  }
  assert.equal(maps[0].wall.find((card: any) => card.number === 3).occupant, CODEX_SESSION)
})

test('deck_map with refresh reads the Task Source again; without it, it answers from the cache', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 1 }), issue({ number: 2, parent: 1 })])
  const deck = startDeck(await configured(), gh.env, 'codex')
  t.after(deck.stop)

  await deck.callTool('deck_map', { session: CODEX_SESSION })
  await deck.callTool('deck_map', { session: CODEX_SESSION })
  assert.equal((await gh.calls()).length, 1)
  await gh.issues([issue({ number: 1 }), issue({ number: 2, parent: 1, state: 'CLOSED', closedAt: '2026-11-12T09:00:00Z' })])
  const refreshed = (await deck.callTool('deck_map', { session: CODEX_SESSION, refresh: true })).structuredContent
  assert.equal((await gh.calls()).length, 2)
  assert.deepEqual(numbers(refreshed.groups.done), [2])
})

test('a read of the Task Source that takes 16 seconds is answered again for 15 seconds from its end, its fetchedAt the time it began', async t => {
  const start = 1_000_000
  const clock = await fakeClock(start)
  const gh = await fakeGh()
  await gh.issues([issue({ number: 1 }), issue({ number: 2, parent: 1 })])
  // A gh that takes 16 seconds of the Deck service's clock.
  const ghDir = gh.env.PATH
  await writeFile(
    join(ghDir, 'gh'),
    `#!/bin/sh\n"${process.execPath}" -e 'const f=process.argv[1];require("fs").writeFileSync(f,String(Number(require("fs").readFileSync(f,"utf8"))+16000))' "${clock.env.FAKE_CLOCK_FILE}"\nexec "${process.execPath}" "${join(import.meta.dirname, 'fake-gh.ts')}" "$@"\n`,
    { mode: 0o755 },
  )
  const deck = startDeck(await configured(), { ...gh.env, ...clock.env }, 'codex')
  t.after(deck.stop)

  const first = (await deck.callTool('deck_tasks')).structuredContent
  const map = (await deck.callTool('deck_map', { session: CODEX_SESSION })).structuredContent
  const again = (await deck.callTool('deck_tasks')).structuredContent
  assert.equal((await gh.calls()).length, 1)
  assert.deepEqual([first.fetchedAt, map.fetchedAt, again.fetchedAt], [start, start, start])

  await clock.set(start + 16_000 + 14_999)
  await deck.callTool('deck_tasks')
  assert.equal((await gh.calls()).length, 1)
  await clock.set(start + 16_000 + 15_000)
  await deck.callTool('deck_map', { session: CODEX_SESSION })
  assert.equal((await gh.calls()).length, 2)
})

test('deck_tasks gives each Spec and Map of the list its closeout check: a Pending Closeout Spec the one deck_map gives, word for word; every other one null', async t => {
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1 }),
    issue({ number: 2, parent: 1, state: 'CLOSED' }),
    issue({ number: 3, parent: 1, state: 'CLOSED' }),
    issue({ number: 10 }),
    issue({ number: 11, parent: 10, state: 'CLOSED' }),
    issue({ number: 12, parent: 10 }),
    issue({ number: 20, labels: ['wayfinder:map'] }),
    issue({ number: 21, parent: 20, state: 'CLOSED' }),
    issue({ number: 30, state: 'CLOSED' }),
    issue({ number: 31, parent: 30, state: 'CLOSED' }),
  ])
  const deck = startDeck(await configured(), gh.env)
  t.after(deck.stop)

  const { containers } = (await deck.callTool('deck_tasks')).structuredContent
  const { maps } = (await deck.callTool('deck_map', { session: 'this-session' })).structuredContent

  const prompts = (each: { number: number; closeoutPrompt: string | null }[]) => each.map(({ number, closeoutPrompt }) => [number, closeoutPrompt])
  assert.deepEqual(prompts([...containers].sort((a: any, b: any) => a.number - b.number)), prompts(maps))
  assert.match(containers.find((each: any) => each.number === 1).closeoutPrompt, /^请对当前项目的 Spec #1 做收尾核对。Pane 显示 Child Task 已全部关闭（2\/2）/)
  assert.deepEqual(containers.filter((each: any) => each.number !== 1).map((each: any) => each.closeoutPrompt), [null, null, null])
})

// The Execute Prompt of the Task `task`, its call of implement `call`.
const executePrompt = (call: string, task: number) =>
  `${call} #${task}\n\nWhen you finish, call the tool deck_report for Task #${task}: what you did, and the Acceptance Evidence for each acceptance criterion with where it comes from.`

test('deck_execute calls implement as the Skill Source does on each host: /<plugin>:implement or /implement in Claude Code, $implement in Codex; with no implement in it, it answers why', async t => {
  const fromPlugin = await withSkillSource({ type: 'plugin', name: 'mattpocock-skills' })
  const matt = join(fromPlugin.user, '.claude', 'plugins', 'cache', 'official', 'mattpocock-skills', '1.3.1')
  await skillFile(join(matt, 'skills', 'engineering'), 'implement', '开始做一个 Task。')
  await installedPlugins(fromPlugin.user, { 'mattpocock-skills@official': [{ scope: 'user', installPath: matt }] })
  const fromDirectory = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillFile(join(fromDirectory.user, '.claude', 'skills'), 'implement', '开始做一个 Task。')
  const without = await withSkillSource({ type: 'directory', path: '~/.claude/skills' })
  await skillFile(join(without.user, '.claude', 'skills'), 'tdd', '先写测试。')
  const started = [
    startDeck(fromPlugin.dir, { HOME: fromPlugin.user }),
    startDeck(fromDirectory.dir, { HOME: fromDirectory.user }),
    startDeck(fromDirectory.dir, { HOME: fromDirectory.user }, 'codex'),
    startDeck(without.dir, { HOME: without.user }),
  ]
  for (const deck of started) t.after(deck.stop)

  const answers = await Promise.all(started.map(deck => deck.callTool('deck_execute', { task: 7 })))

  assert.deepEqual(answers.slice(0, 3).map(answer => answer.structuredContent), [
    { ok: true, prompt: executePrompt('/mattpocock-skills:implement', 7) },
    { ok: true, prompt: executePrompt('/implement', 7) },
    { ok: true, prompt: executePrompt('$implement', 7) },
  ])
  assert.equal(answers[3].isError, false)
  assert.deepEqual(answers[3].structuredContent, { ok: false, failure: { kind: 'unknown-skill', message: 'the Skill Source has no skill named implement' } })
})

// How the Task references a test sends after implement are read: each one
// that names #12 of the Task Source, and each that names nothing.
const REFERENCES_TO_12 = ['#12', '12', '#12.', '#12，', '#12，接着做', '12。', 'https://github.com/acme/shop/issues/12', 'https://github.com/acme/shop/issues/12#issuecomment-1', 'https://github.com/acme/shop/issues/12，再看']
const NO_REFERENCES = ['https://gitlab.com/acme/shop/issues/9', 'https://github.com/evil/x/acme/shop/issues/11', 'https://github.com/acme/shop/pull/12', '12.5', '#12.5', '1.2.3', '12:30', '12,000', '#12.md']

test('the hook\'s tool reads after $implement #12 and 12, punctuation after it left out, and a link to an issue of github.com, whatever its fragment; no other host, longer path or pull request', async t => {
  for (const reference of [...REFERENCES_TO_12, ...NO_REFERENCES]) {
    const user = await home()
    const gh = await fakeGh()
    await gh.issues([issue({ number: 9 }), issue({ number: 11 }), issue({ number: 12 })])
    const deck = startDeck(await configured(), { ...gh.env, HOME: user }, 'codex')
    await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: `$implement ${reference}` })
    const { groups } = (await deck.callTool('deck_tasks')).structuredContent
    deck.stop()
    assert.deepEqual(occupants(groups.inProgress), REFERENCES_TO_12.includes(reference) ? { 12: CODEX_SESSION } : {}, reference)
  }
})

test('deck_occupy reads a reference as the hook\'s tool does, Claude Code\'s Mod passing it as sent, and names the Task it read; a reference to none occupies nothing', async t => {
  for (const reference of [...REFERENCES_TO_12, ...NO_REFERENCES, '先看看']) {
    const user = await home()
    const gh = await fakeGh()
    await gh.issues([issue({ number: 9 }), issue({ number: 11 }), issue({ number: 12 })])
    const deck = startDeck(await configured(), { ...gh.env, HOME: user })
    const answer = (await deck.callTool('deck_occupy', { session: 'session-a', reference: `${reference} 先写测试` })).structuredContent
    const { groups } = (await deck.callTool('deck_tasks')).structuredContent
    deck.stop()
    if (REFERENCES_TO_12.includes(reference)) {
      assert.deepEqual([answer.ok, answer.occupied, answer.task], [true, true, 12], reference)
      assert.deepEqual(occupants(groups.inProgress), { 12: 'session-a' }, reference)
    } else {
      assert.deepEqual([answer.ok, answer.failure?.kind], [false, 'no-reference'], reference)
      assert.deepEqual(occupants(groups.inProgress), {}, reference)
    }
  }
})

test('the hook\'s tool answers within a second a prompt whose implement is followed by one word of 60,000 characters', async t => {
  const gh = await fakeGh()
  await gh.issues([issue({ number: 12 })])
  const deck = startDeck(await configured(), gh.env, 'codex')
  t.after(deck.stop)
  await deck.callTool('deck_tasks')
  const words = ['a'.repeat(60_000), `${'a/'.repeat(30_000)}issues/12x`, `https://github.com/${'a'.repeat(60_000)}`]

  for (const word of words) {
    const began = await deck.cpuMs()
    await callFrom(deck, CODEX_SESSION, HOOK_TOOL, { prompt: `$implement ${word}` })
    const ms = (await deck.cpuMs()) - began
    assert.ok(ms < 1_000, `${word.slice(0, 20)}… took ${ms} ms`)
  }
})

test('deck_tasks says of each Task, Spec and Map whether it is Executable: a ready Task and one held, by this Session, another or Orphaned, are; a blocked one, one waiting on triage or on more information, a closed one, and every Spec and Map are not', async t => {
  const user = await home()
  const gh = await fakeGh()
  await gh.issues([
    issue({ number: 1 }),
    issue({ number: 2, parent: 1 }),
    issue({ number: 3, parent: 1 }),
    issue({ number: 4, parent: 1 }),
    issue({ number: 5, parent: 1 }),
    issue({ number: 6, parent: 1, blockedBy: [2] }),
    issue({ number: 7, parent: 1, labels: ['needs-triage'] }),
    issue({ number: 8, parent: 1, labels: ['needs-info'] }),
    issue({ number: 9, parent: 1, state: 'CLOSED', closedAt: '2026-11-12T09:00:00Z' }),
    issue({ number: 20, labels: ['wayfinder:map'] }),
  ])
  const deck = startDeck(await configured(), { ...gh.env, HOME: user })
  t.after(deck.stop)
  for (const [task, session] of [[3, 'this-session'], [4, 'other-session'], [5, 'ended']] as const) {
    await deck.callTool('deck_occupy', { session, task })
    await deck.callTool('deck_heartbeat', { session })
  }
  await deck.callTool('deck_end_session', { session: 'ended' })

  const { containers, groups } = (await deck.callTool('deck_tasks')).structuredContent
  const executable = Object.fromEntries(
    [...containers, ...Object.values(groups).flat()].map((each: any) => [each.number, each.isExecutable]),
  )

  assert.deepEqual(executable, { 1: false, 20: false, 2: true, 3: true, 4: true, 5: true, 6: false, 7: false, 8: false, 9: false })
  assert.equal(groups.inProgress.find((each: any) => each.number === 5).isOrphaned, true)
})
