// The Deck service's tool interface, called the way the agent or the Pane
// calls it: a real child process speaking MCP over stdio.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SERVER = join(import.meta.dirname, '..', 'plugin', 'server', 'main.ts')
const FAKE_CLOCK = join(import.meta.dirname, 'fake-clock.ts')

// Unless a test gives it a HOME of its own, each Deck service keeps its local
// state in a temporary home, never the user's.
const startDeck = (cwd: string, env: Record<string, string> = {}) => {
  const child = spawn(process.execPath, ['--import', FAKE_CLOCK, SERVER], {
    cwd,
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'deck-home-')), ...env },
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
    issues: (nodes: object[], repository = 'acme/shop') =>
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

// One issue as the GraphQL query reads it.
const issue = ({
  number,
  title = `Task ${number}`,
  state = 'OPEN',
  closedAt = null,
  labels = [],
  body = '',
  parent = null,
  blockedBy = [],
}: {
  number: number
  title?: string
  state?: 'OPEN' | 'CLOSED'
  closedAt?: string | null
  labels?: string[]
  body?: string
  parent?: number | null
  blockedBy?: number[]
}) => ({
  number,
  title,
  state,
  closedAt,
  body,
  labels: { nodes: labels.map(name => ({ name })) },
  parent: parent === null ? null : { number: parent },
  blockedBy: { nodes: blockedBy.map(number => ({ number })) },
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
    isOrphaned: false,
  })
  assert.deepEqual(groups.done[0].blockers, [])
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
  assert.deepEqual(occupied.structuredContent, { ok: true, occupied: true, occupant: 'session-a' })
  assert.deepEqual(other.structuredContent, { ok: true, occupied: true, occupant: 'session-b' })
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
  const again = await deck.callTool('deck_occupy', { session: 'session-a', task: 3 })
  const second = await deck.callTool('deck_occupy', { session: 'session-b', task: 3 })
  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(first.structuredContent, { ok: true, occupied: true, occupant: 'session-a' })
  assert.deepEqual(again.structuredContent, { ok: true, occupied: true, occupant: 'session-a' })
  assert.deepEqual(second.structuredContent, { ok: true, occupied: false, occupant: 'session-a' })
  assert.deepEqual(occupants(groups.inProgress), { 3: 'session-a' })
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
  assert.deepEqual(taken.structuredContent, { ok: true, occupied: true, occupant: 'session-b' })
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

  const other = await deck.callTool('deck_occupy', { session: 'session-a', task: 5, repository: 'acme/other' })
  // GitHub takes a repository's owner and name in any case.
  const same = await deck.callTool('deck_occupy', { session: 'session-a', task: 3, repository: 'Acme/Shop' })
  const malformed = await deck.callTool('deck_occupy', { session: 'session-a', task: 3, repository: 7 })
  const { groups } = (await deck.callTool('deck_tasks')).structuredContent

  assert.deepEqual(other.structuredContent, {
    ok: false,
    failure: { kind: 'not-open', message: '#5 of acme/other is not a Task of the Task Source, acme/shop' },
  })
  assert.deepEqual(same.structuredContent, { ok: true, occupied: true, occupant: 'session-a' })
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

  const taken = await here.callTool('deck_occupy', { session: 'session-a', task: 3, takeOver: 'session-b' })
  // A Task nobody holds is occupied as without takeOver.
  const free = await here.callTool('deck_occupy', { session: 'session-a', task: 5, takeOver: 'session-b' })
  // One that passed to a third Session since the person saw it stays there.
  const passed = await here.callTool('deck_occupy', { session: 'session-a', task: 7, takeOver: 'session-b' })
  const malformed = await Promise.all(
    [true, ''].map(takeOver => here.callTool('deck_occupy', { session: 'session-a', task: 3, takeOver })),
  )

  assert.deepEqual(taken.structuredContent, { ok: true, occupied: true, occupant: 'session-a' })
  assert.deepEqual(free.structuredContent, { ok: true, occupied: true, occupant: 'session-a' })
  assert.deepEqual(passed.structuredContent, { ok: true, occupied: false, occupant: 'session-c' })
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
  assert.deepEqual(again.structuredContent, { ok: true, occupied: true, occupant: 'session-b' })
})

// A clock every Deck service given its `env` reads, which `set` moves.
const fakeClock = async (start: number) => {
  const file = join(await mkdtemp(join(tmpdir(), 'deck-clock-')), 'now')
  const set = (now: number) => writeFile(file, String(now))
  await set(start)

  return { env: { FAKE_CLOCK_FILE: file }, set }
}

// Which Tasks deck_tasks lists in progress as Orphaned, by number.
const orphaned = (tasks: { number: number; isOrphaned: boolean }[]) =>
  tasks.filter(task => task.isOrphaned).map(task => task.number)

const MINUTE = 60_000

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

  assert.deepEqual(taken.structuredContent, { ok: true, occupied: true, occupant: 'session-b' })
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
