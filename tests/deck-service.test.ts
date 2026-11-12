// The Deck service's tool interface, called the way the agent or the Pane
// calls it: a real child process speaking MCP over stdio.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
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
    // --slurp` prints them: one page.
    issues: (nodes: object[]) =>
      answer({
        stdout: [{ data: { repository: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } }],
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
  // Occupancy comes later (#10): nothing is in progress yet.
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
    data: { repository: { issues: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null } } } },
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
