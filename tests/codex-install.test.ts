// The command line that installs Deck into Codex and uninstalls it, run in a
// temporary home: the machine's own Codex config is never touched.
import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'smol-toml'

const CODEX = join(import.meta.dirname, '..', 'plugin', 'cli', 'codex.ts')
const exec = promisify(execFile)

const home = async () => realpath(await mkdtemp(join(tmpdir(), 'deck-home-')))

// What a Codex config holds as Codex reads it, Deck's registration left out,
// and mcp_servers too when nothing else is in it.
const withoutDeck = (text: string) => {
  const parsed: any = parse(text)
  delete parsed.mcp_servers?.matt_deck
  if (parsed.mcp_servers !== undefined && Object.keys(parsed.mcp_servers).length === 0) {
    delete parsed.mcp_servers
  }

  return parsed
}

// A run of the command line in the home of `user`, whether it installs or
// stops: a config it changed is one Codex reads, holding all it held before
// but Deck's registration. A config not there before counts as empty.
const checked = async <T>(user: string, command: () => Promise<T>) => {
  const config = join(user, '.codex', 'config.toml')
  const read = () => readFile(config).catch(() => undefined)
  const before = await read()
  try {
    return await command()
  } finally {
    const after = await read()
    if (!(before ?? Buffer.alloc(0)).equals(after ?? Buffer.alloc(0))) {
      const text = (after ?? '').toString()
      assert.deepEqual(withoutDeck(text), withoutDeck((before ?? '').toString()), text)
    }
  }
}

const run = (user: string, ...args: string[]) => checked(user, () => exec(process.execPath, [CODEX, ...args], { env: { ...process.env, HOME: user } }))

// A text with each line ending in CRLF.
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n')

// A Codex config holding what a person had in it before.
const BEFORE = `model = "gpt-5"

[features]
hooks = true

[mcp_servers.other]
command = "other"
args = ["--flag"]
`

const withConfig = async (text: string) => {
  const user = await home()
  await mkdir(join(user, '.codex'))
  await writeFile(join(user, '.codex', 'config.toml'), text)

  return { user, config: join(user, '.codex', 'config.toml') }
}

// The launch command of Deck's registration, from the table install writes.
const registration = (text: string) => {
  const table = (parse(text) as any).mcp_servers?.matt_deck
  assert.ok(table !== undefined, text)

  return { command: table.command as string, args: table.args as string[] }
}

test('install registers the Deck service in the Codex config of the user, keeping what it holds, and says to restart the app', async () => {
  const { user, config } = await withConfig(BEFORE)

  const { stdout } = await run(user, 'install')

  const after = await readFile(config, 'utf8')
  assert.ok(after.startsWith(BEFORE), after)
  assert.match(stdout, new RegExp(config.replace(/[.]/g, '\\.')))
  assert.match(stdout, /重启 Codex 桌面应用/)
  const { command, args } = registration(after)
  assert.deepEqual(args.slice(1), ['--host', 'codex'])

  // Started as Codex starts it from the registration, it is a Deck service
  // for Codex: it offers the Pane in a tab.
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'deck-')))
  const child = spawn(command, args, { cwd: workspace, env: { ...process.env, HOME: await home() }, stdio: ['pipe', 'pipe', 'inherit'] })
  const reply = new Promise<any>((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', line => resolve(JSON.parse(line)))
    child.on('exit', (code, signal) => reject(new Error(`Deck service exited (${code}${signal ? `, ${signal}` : ''})`)))
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
  const listed = await reply
  child.kill('SIGKILL')
  assert.ok(listed.result.tools.some((tool: any) => tool.name === 'deck_pane'))
})

// A directory holding a `node` that is not the node running install.
const otherNode = async () => {
  const dir = await home()
  await writeFile(join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 })

  return dir
}

test('install registers the node found on its PATH through a link to the node running it, as the path of that link', async () => {
  const user = await home()
  // As a package manager links its node into a bin directory that survives
  // an upgrade.
  const linked = await home()
  await symlink(process.execPath, join(linked, 'node'))

  const PATH = [await otherNode(), linked, process.env.PATH].join(delimiter)
  await checked(user, () => exec(process.execPath, [CODEX, 'install'], { env: { ...process.env, HOME: user, PATH } }))

  assert.equal(registration(await readFile(join(user, '.codex', 'config.toml'), 'utf8')).command, join(linked, 'node'))
})

test('install registers the path of the node running it when no node on its PATH is that node, but through a relative entry', async () => {
  const user = await home()
  const linked = await home()
  await symlink(process.execPath, join(linked, 'node'))

  const PATH = [await otherNode(), await home(), '.'].join(delimiter)
  await checked(user, () => exec(process.execPath, [CODEX, 'install'], { cwd: linked, env: { ...process.env, HOME: user, PATH } }))

  assert.equal(registration(await readFile(join(user, '.codex', 'config.toml'), 'utf8')).command, process.execPath)
})

test('install says which node the registration starts, as config.toml writes it: the link on its PATH, or the path of the node running it where none is', async () => {
  const linked = await home()
  await symlink(process.execPath, join(linked, 'node'))
  for (const [PATH, node] of [
    [[await otherNode(), linked, process.env.PATH].join(delimiter), join(linked, 'node')],
    [[await otherNode(), await home()].join(delimiter), process.execPath],
  ]) {
    const user = await home()

    const { stdout } = await checked(user, () => exec(process.execPath, [CODEX, 'install'], { env: { ...process.env, HOME: user, PATH } }))

    assert.equal(registration(await readFile(join(user, '.codex', 'config.toml'), 'utf8')).command, node)
    assert.ok(stdout.includes(`注册里的 node 是 ${node}，`), stdout)
  }
})

test('install says that once the node the registration starts is gone, Codex cannot start the Deck service and install is to run again', async () => {
  const { stdout } = await run(await home(), 'install')

  assert.match(stdout, /注册里的 node 是 [^\n]*没了之后[^\n]*Codex 起不来 Deck 服务[^\n]*要重新运行一次 install/)
})

test('install says which copy of the plugin the registration and the configure skill point at, and to run it again once that copy moves or is updated', async () => {
  const { stdout } = await run(await home(), 'install')

  assert.ok(stdout.includes(join(import.meta.dirname, '..', 'plugin')), stdout)
  assert.match(stdout, /挪了位置或更新之后.*重新运行一次 install/)
})

test('install writes the Codex config when there is none, and registers the Deck service once however often it runs', async () => {
  const user = await home()

  await run(user, 'install')
  const once = await readFile(join(user, '.codex', 'config.toml'), 'utf8')
  await run(user, 'install')

  assert.equal(await readFile(join(user, '.codex', 'config.toml'), 'utf8'), once)
  registration(once)
})

test('uninstall removes only the registration of the Deck service, and says so; again, it changes nothing and does not fail', async () => {
  const { user, config } = await withConfig(BEFORE)
  await run(user, 'install')

  const { stdout: removed } = await run(user, 'uninstall')

  assert.equal(await readFile(config, 'utf8'), BEFORE)
  assert.match(removed, /已从 .*config\.toml 移除/)

  const { stdout: again } = await run(user, 'uninstall')

  assert.equal(await readFile(config, 'utf8'), BEFORE)
  assert.match(again, /没有 Deck 服务的注册/)
})

test('uninstall keeps the tables a person added after the registration, and removes the registration\'s own', async () => {
  const { user, config } = await withConfig(BEFORE)
  await run(user, 'install')
  const later = '\n[mcp_servers.matt_deck.env]\nDEBUG = "1"\n\n[mcp_servers.matt_deck_later]\ncommand = "later"\n\n'
  await writeFile(config, `${await readFile(config, 'utf8')}${later}`)

  await run(user, 'uninstall')

  assert.equal(await readFile(config, 'utf8'), `${BEFORE}\n[mcp_servers.matt_deck_later]\ncommand = "later"\n\n`)
})

test('uninstall and install again keep the comment a person wrote just above the table after the registration', async () => {
  const { user, config } = await withConfig(BEFORE)
  await run(user, 'install')
  const after = '# My other server, keep this note\n[mcp_servers.after]\ncommand = "after"\n\n'
  await writeFile(config, `${await readFile(config, 'utf8')}${after}`)

  await run(user, 'install')
  const reinstalled = await readFile(config, 'utf8')
  await run(user, 'uninstall')

  assert.ok(reinstalled.startsWith(`${BEFORE}\n${after}`), reinstalled)
  registration(reinstalled)
  assert.equal(await readFile(config, 'utf8'), `${BEFORE}\n${after}`)
})

test('uninstall and install read a config written with CRLF, its registration\'s header with a comment or without', async () => {
  const crlf = BEFORE.replaceAll('\n', '\r\n')
  for (const header of ['[mcp_servers.matt_deck] # mine', '[mcp_servers.matt_deck]']) {
    const registered = `${crlf}\r\n${header}\r\ncommand = "old"\r\nargs = []\r\n`
    const { user, config } = await withConfig(registered)

    await run(user, 'uninstall')

    assert.equal(await readFile(config, 'utf8'), crlf, header)

    await writeFile(config, registered)
    await run(user, 'install')

    const installed = await readFile(config, 'utf8')
    assert.ok(installed.startsWith(crlf), header)
    assert.equal(registration(installed).args.at(-1), 'codex', header)
  }
})

// The line endings a text holds, each once.
const endings = (text: string) => [...new Set(text.match(/\r?\n/g))]

test('install writes Deck\'s registration in a config written with CRLF with CRLF alone, its last line ending or not, and again the same; uninstall gives back the one ending byte for byte', async () => {
  for (const before of [crlf(BEFORE), crlf(BEFORE).slice(0, -2)]) {
    const { user, config } = await withConfig(before)

    await run(user, 'install')
    const installed = await readFile(config, 'utf8')
    await run(user, 'install')

    assert.ok(installed.startsWith(before), installed)
    assert.deepEqual(endings(installed), ['\r\n'], installed)
    assert.equal(await readFile(config, 'utf8'), installed)

    await run(user, 'uninstall')

    const uninstalled = await readFile(config, 'utf8')
    assert.deepEqual(endings(uninstalled), ['\r\n'], uninstalled)
    if (before.endsWith('\n')) {
      assert.equal(uninstalled, before)
    }
  }
})

test('install writes Deck\'s registration with the line ending of the config\'s first line where CRLF and LF mix, and with LF where no line ends', async () => {
  const [first, ...rest] = BEFORE.split(/(?<=\n)/)
  for (const [before, eol] of [
    [`${crlf(first!)}${rest.join('')}`, '\r\n'],
    [`${first}${crlf(rest.join(''))}`, '\n'],
    ['', '\n'],
    ['model = "gpt-5"', '\n'],
  ] as const) {
    const { user, config } = await withConfig(before)

    await run(user, 'install')

    const installed = await readFile(config, 'utf8')
    assert.ok(installed.startsWith(before), installed)
    assert.deepEqual(endings(installed.slice(before.length)), [eol], installed)
  }
})

test('install and uninstall take a line in a multi-line string for text, not a header, however it looks, its lines ending in LF or CRLF', async () => {
  const strings = [['"""', '"""'], ["'''", "'''"], ['"""Starts here', 'and \\""" ends here"""']]
  for (const [open, close, eol] of strings.flatMap(([open, close]) => [String, crlf].map(eol => [open!, close!, eol] as const))) {
    // A person's own string holding what looks like Deck's table.
    const theirs = eol(`${BEFORE}note = ${open}\n[mcp_servers.matt_deck]\ncommand = "in a string"\n${close}\n`)
    const { user, config } = await withConfig(theirs)

    await run(user, 'install')
    const installed = await readFile(config, 'utf8')
    await run(user, 'uninstall')

    assert.ok(installed.startsWith(theirs), installed)
    assert.equal(registration(installed).args.at(-1), 'codex', open)
    assert.equal(await readFile(config, 'utf8'), theirs, open)
  }
})

test('uninstall removes a multi-line string a person put in Deck\'s table whole, a line in it looking like a header or a comment among the rest, its lines ending in LF or CRLF', async () => {
  for (const string of ['"""\n[other]\nkey = 1\n"""', '"""\n# c"""']) {
    for (const eol of [String, crlf]) {
      const { user, config } = await withConfig(eol(BEFORE))
      await run(user, 'install')
      await writeFile(config, `${await readFile(config, 'utf8')}${eol(`note = ${string}\n[after]\nkey = 2\n`)}`)

      await run(user, 'uninstall')

      assert.equal(await readFile(config, 'utf8'), eol(`${BEFORE}\n[after]\nkey = 2\n`), string)
    }
  }
})

test('install and uninstall take an array a person spread over lines in Deck\'s table for part of that table: install writes the table anew and uninstall removes it whole, its lines ending in LF or CRLF', async () => {
  for (const eol of [String, crlf]) {
    const registered = eol(`${BEFORE}\n[mcp_servers.matt_deck]\ncommand = "old"\nenv_vars = [\n  ["a", "b"]\n]\n`)
    const { user, config } = await withConfig(registered)

    await run(user, 'install')

    const installed = await readFile(config, 'utf8')
    assert.ok(installed.startsWith(eol(BEFORE)), installed)
    assert.equal(registration(installed).args.at(-1), 'codex')
    assert.ok(!installed.includes('["a", "b"]'), installed)

    await writeFile(config, registered)
    await run(user, 'uninstall')

    assert.equal(await readFile(config, 'utf8'), eol(BEFORE))
  }
})

test('install and uninstall take a line in an array or an inline table a person spread over lines for part of that value, not a header or the registration, however it looks, its lines ending in LF or CRLF', async () => {
  for (const theirs of [
    // Were the line in the array a header, the key after it would register
    // the Deck service.
    `${BEFORE}\n[other]\nlist = [\n  ["mcp_servers"]\n]\nmatt_deck = 1\n`,
    `${BEFORE}\n[other]\nlist = [\n  [["mcp_servers"]]\n]\nmatt_deck = 1\n`,
    // Were the line in the inline table a key of the table above it, or of
    // none, it would register the Deck service.
    `${BEFORE}\n[mcp_servers]\nanother = {\n  matt_deck = { command = "theirs" },\n}\n`,
    `note = {\n  mcp_servers.matt_deck.command = "theirs",\n}\n${BEFORE}`,
  ].flatMap(theirs => [theirs, crlf(theirs)])) {
    const { user, config } = await withConfig(theirs)

    await run(user, 'install')
    const installed = await readFile(config, 'utf8')
    await run(user, 'uninstall')

    assert.ok(installed.startsWith(theirs), installed)
    assert.equal(registration(installed).args.at(-1), 'codex', theirs)
    assert.equal(await readFile(config, 'utf8'), theirs)
  }
})

test('uninstall removes an array or an inline table a person spread over lines in Deck\'s table whole, a line in it looking like a header or a key among the rest, its lines ending in LF or CRLF', async () => {
  for (const value of ['[\n  [["c"]]\n]', '[\n  ["after"]\n]', '{\n  a = [\n    [1]\n  ],\n  mcp_servers.matt_deck = 2,\n}']) {
    for (const eol of [String, crlf]) {
      const { user, config } = await withConfig(eol(BEFORE))
      await run(user, 'install')
      await writeFile(config, `${await readFile(config, 'utf8')}${eol(`note = ${value}\n[after]\nkey = 2\n`)}`)

      await run(user, 'uninstall')

      assert.equal(await readFile(config, 'utf8'), eol(`${BEFORE}\n[after]\nkey = 2\n`), value)
    }
  }
})

test('uninstall without a Codex config writes none', async () => {
  const user = await home()

  await run(user, 'uninstall')

  assert.deepEqual(await readdir(user), [])
})

// Deck's registration as a person may write it by hand, in a TOML form other
// than the header install writes: a table appended after it would declare
// the registration twice, and Codex could read none of its config. Each goes
// first in the config, where a dotted key belongs to no table.
const HAND_WRITTEN = [
  '[mcp_servers]\nmatt_deck = { command = "mine" }\n',
  '[ mcp_servers . matt_deck ]\ncommand = "mine"\n',
  '[mcp_servers."matt_deck"]\ncommand = "mine"\n',
  "[mcp_servers.'matt_deck']\ncommand = \"mine\"\n",
  'mcp_servers.matt_deck.command = "mine"\n',
  'mcp_servers = { matt_deck = { command = "mine" } }\n',
  '[mcp_servers]\n"matt_deck".command = "mine"\n',
  '[mcp_servers.matt_deck]\ncommand = "mine"\n\n[mcp_servers."matt_deck".env]\nDEBUG = "1"\n',
  '[mcp_servers]\r\nmatt_deck = { command = "mine" }\r\n',
  '[mcp_servers.matt_deck]\r\ncommand = "mine"\r\n[mcp_servers."matt_deck".env]\r\nDEBUG = "1"\r\n',
  '[mcp_servers]\n"matt\\U0000005Fdeck" = { command = "mine" }\n',
  '[mcp_servers."matt\\u005Fdeck"]\ncommand = "mine"\n',
  '[mcp_servers]\n"matt\\x5Fdeck" = { command = "mine" }\n',
  '[mcp_servers."matt\\x5f\\x64eck"]\ncommand = "mine"\n',
  'mcp_servers = { a = { command = """x"y""" }, matt_deck = { command = "mine" } }\n',
  "mcp_servers = { a = { command = '''a'b''' }, matt_deck = { command = \"mine\" } }\n",
  // After an array spread over lines, a line of which looks like a header.
  '[mcp_servers]\nother.note = [\n  ["a"]\n]\nmatt_deck = { command = "mine" }\n',
  // In mcp_servers as an inline table that runs over lines: after a
  // multi-line string in it, and on a line of its own, as TOML 1.1 allows.
  'mcp_servers = { a = { command = """\nx\n""" }, matt_deck = { command = "mine" } }\n',
  'mcp_servers = {\n  matt_deck = { command = "mine" },\n}\n',
  // After comments in that table, a brace in one of them.
  'mcp_servers = {\n  a = { command = "x" }, # theirs {\n  # mine\n  matt_deck = { command = "mine" },\n}\n',
]

test('install and uninstall stop when the Codex config registers the Deck service in a form Deck does not write, its lines ending in LF or CRLF, and change nothing', async () => {
  for (const form of HAND_WRITTEN.flatMap(form => [`${form}\n${BEFORE}`, crlf(`${form}\n${BEFORE}`)])) {
    for (const command of ['install', 'uninstall']) {
      const { user, config } = await withConfig(form)

      await assert.rejects(run(user, command), (error: any) => {
        assert.equal(error.code, 1, form)
        assert.ok(error.stderr.includes(`${config} 里的 Deck 服务注册不是 Deck 认得的写法`), error.stderr)
        assert.ok(error.stderr.includes(`再运行一次 ${command}`), error.stderr)
        return true
      })
      assert.equal(await readFile(config, 'utf8'), form, form)
      assert.deepEqual(await readdir(user), ['.codex'], form)
      assert.deepEqual(await readdir(join(user, '.codex')), ['config.toml'], form)
    }
  }
})

test('install stops when the Codex config holds mcp_servers as an inline table, which no table can be added to; uninstall finds no registration there', async () => {
  for (const inline of [
    `mcp_servers = { other = { command = "other" } }\n`,
    // Named matt_deck deeper in it, or in a string: no registration.
    `mcp_servers = { a = { matt_deck = 1 }, b = [{ matt_deck = 2 }], c = "{ matt_deck = 3 }" }\n`,
    // The same where the table runs over lines, a comment there too, and a
    // line that would register the Deck service were it not inside the table.
    `mcp_servers = {\n  a = {\n    matt_deck = 1,\n    mcp_servers.matt_deck = 2,\n  },\n  b = [\n    { matt_deck = 3 },\n    "matt_deck",\n  ],\n  c = """\n, matt_deck = 4\n""",\n  # , matt_deck = 5\n}\n`,
  ].flatMap(inline => [inline, crlf(inline)])) {
  const { user, config } = await withConfig(inline)

  await assert.rejects(run(user, 'install'), (error: any) => {
    assert.equal(error.code, 1)
    assert.ok(error.stderr.includes(`${config} 里的 mcp_servers 写成了内联表`), error.stderr)
    return true
  })
  assert.equal(await readFile(config, 'utf8'), inline)
  assert.deepEqual(await readdir(join(user, '.codex')), ['config.toml'])

  const { stdout } = await run(user, 'uninstall')

  assert.match(stdout, /没有 Deck 服务的注册/)
  assert.equal(await readFile(config, 'utf8'), inline)
  }
})

test('install and uninstall take keys only named like the Deck service for what they are: not its registration, its lines ending in LF or CRLF', async () => {
  for (const eol of [String, crlf]) {
    const alike = eol(`${BEFORE}\n[mcp_servers.other.env]\nmatt_deck = "1"\n\n[profiles.matt_deck]\nmodel = "o3"\n\n[mcp_servers."matt_deck_later"]\ncommand = "later"\n`)
    const { user, config } = await withConfig(alike)

    await run(user, 'install')
    const installed = await readFile(config, 'utf8')
    await run(user, 'uninstall')

    assert.ok(installed.startsWith(alike), installed)
    registration(installed)
    assert.equal(await readFile(config, 'utf8'), alike)
  }
})

// The skill install generates where Codex finds the user's skills.
const configureSkill = (user: string) => join(user, '.agents', 'skills', 'matt-deck-configure', 'SKILL.md')
const PLUGIN_CONFIGURE = join(import.meta.dirname, '..', 'plugin', 'skills', 'configure', 'SKILL.md')

test('install generates the skill matt-deck-configure, which points at the configure skill of the plugin, and says so; uninstall removes it', async () => {
  const user = await home()
  await mkdir(join(user, '.agents', 'skills', 'tdd'), { recursive: true })
  await writeFile(join(user, '.agents', 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\n---\n')

  const { stdout: installed } = await run(user, 'install')
  const generated = await readFile(configureSkill(user), 'utf8')
  await run(user, 'install')

  assert.match(generated, /^---\nname: matt-deck-configure\ndescription: .+\n---\n/)
  assert.ok(generated.includes(PLUGIN_CONFIGURE), generated)
  assert.equal(await readFile(configureSkill(user), 'utf8'), generated)
  assert.ok(installed.includes(configureSkill(user)), installed)

  const { stdout: removed } = await run(user, 'uninstall')

  assert.deepEqual(await readdir(join(user, '.agents', 'skills')), ['tdd'])
  assert.ok(removed.includes(join(user, '.agents', 'skills', 'matt-deck-configure')), removed)
})

// The policy install writes beside the skill it generates.
const configurePolicy = (user: string) => join(user, '.agents', 'skills', 'matt-deck-configure', 'agents', 'openai.yaml')

test('install writes beside the skill it generates a policy by which Codex uses the skill only when the user calls it, and says so', async () => {
  const user = await home()

  const { stdout } = await run(user, 'install')

  assert.deepEqual(await readdir(join(user, '.agents', 'skills', 'matt-deck-configure')), ['SKILL.md', 'agents'])
  assert.deepEqual(await readdir(join(user, '.agents', 'skills', 'matt-deck-configure', 'agents')), ['openai.yaml'])
  assert.match(await readFile(configurePolicy(user), 'utf8'), /^policy:\n {2}allow_implicit_invocation: false\n/m)
  assert.ok(stdout.includes(configurePolicy(user)), stdout)
})

test('install stops when a skill named matt-deck-configure is there that Deck did not generate, and leaves it and the Codex config as they are', async () => {
  const { user, config } = await withConfig(BEFORE)
  const theirs = '---\nname: matt-deck-configure\ndescription: mine\n---\n\nMy own.\n'
  await mkdir(join(user, '.agents', 'skills', 'matt-deck-configure'), { recursive: true })
  await writeFile(configureSkill(user), theirs)

  await assert.rejects(run(user, 'install'), (error: any) => {
    assert.equal(error.code, 1)
    assert.ok(error.stderr.includes(join(user, '.agents', 'skills', 'matt-deck-configure')), error.stderr)
    return true
  })
  assert.equal(await readFile(configureSkill(user), 'utf8'), theirs)
  assert.equal(await readFile(config, 'utf8'), BEFORE)

  await run(user, 'uninstall')

  assert.equal(await readFile(configureSkill(user), 'utf8'), theirs)
})

test('uninstall removes only the file install generated: what else the directory holds stays, and so does a directory it reached through a link', async () => {
  const user = await home()
  const dir = join(user, '.agents', 'skills', 'matt-deck-configure')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'notes.md'), 'mine\n')
  // The skill's directory a link to one elsewhere.
  const linked = await home()
  const target = join(linked, 'elsewhere')
  await mkdir(target)
  await mkdir(join(linked, '.agents', 'skills'), { recursive: true })
  await symlink(target, join(linked, '.agents', 'skills', 'matt-deck-configure'))

  for (const each of [user, linked]) {
    await run(each, 'install')
    await run(each, 'uninstall')
  }

  assert.deepEqual(await readdir(dir), ['notes.md'])
  assert.equal(await readFile(join(dir, 'notes.md'), 'utf8'), 'mine\n')
  assert.deepEqual(await readdir(target), [])
})

test('uninstall removes the policy install wrote beside the skill, and its agents directory only when nothing else is in it', async () => {
  const user = await home()
  const agents = join(user, '.agents', 'skills', 'matt-deck-configure', 'agents')
  await mkdir(agents, { recursive: true })
  await writeFile(join(agents, 'icon.svg'), '<svg/>\n')
  const alone = await home()

  for (const each of [user, alone]) {
    await run(each, 'install')
    await run(each, 'uninstall')
  }

  assert.deepEqual(await readdir(join(user, '.agents', 'skills', 'matt-deck-configure')), ['agents'])
  assert.deepEqual(await readdir(agents), ['icon.svg'])
  assert.deepEqual(await readdir(join(alone, '.agents', 'skills')), [])
})

test('installed again where an install before the policy generated the skill alone, install writes the policy and the skill as it was', async () => {
  const user = await home()
  await run(user, 'install')
  const generated = await readFile(configureSkill(user), 'utf8')
  // As the install before the policy left it.
  await rm(join(user, '.agents', 'skills', 'matt-deck-configure', 'agents'), { recursive: true, force: true })

  await run(user, 'install')

  assert.match(await readFile(configurePolicy(user), 'utf8'), /allow_implicit_invocation: false/)
  assert.equal(await readFile(configureSkill(user), 'utf8'), generated)
})

test('a policy beside the generated skill that Deck did not write is neither overwritten by install nor removed by uninstall, and each says so', async () => {
  const user = await home()
  const theirs = 'policy:\n  allow_implicit_invocation: true\n'
  await mkdir(join(user, '.agents', 'skills', 'matt-deck-configure', 'agents'), { recursive: true })
  await writeFile(configurePolicy(user), theirs)

  const { stdout: installed } = await run(user, 'install')

  assert.equal(await readFile(configurePolicy(user), 'utf8'), theirs)
  assert.ok(installed.includes(`${configurePolicy(user)} 不是 Deck 写的，没有改它`), installed)
  assert.ok((await readFile(configureSkill(user), 'utf8')).includes(PLUGIN_CONFIGURE))

  const { stdout: removed } = await run(user, 'uninstall')

  assert.equal(await readFile(configurePolicy(user), 'utf8'), theirs)
  assert.ok(removed.includes(`${configurePolicy(user)} 不是 Deck 写的，没有动它`), removed)
  assert.deepEqual(await readdir(join(user, '.agents', 'skills', 'matt-deck-configure')), ['agents'])
})

test('the Codex command line takes install or uninstall', async () => {
  const user = await home()

  for (const args of [[], ['add'], ['install', 'extra']]) {
    await assert.rejects(run(user, ...args), (error: any) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /Usage:/)
      assert.match(error.stderr, /挪了位置或更新之后.*重新运行一次 install/)
      return true
    })
  }
  assert.deepEqual(await readdir(user), [])
})

// The Codex hooks of the user, as a person wrote them: their own layout,
// which uninstall gives back as it was.
const HOOKS_BEFORE = `{
    "note": "mine k2w7",
    "hooks": {
        "SessionStart": [{ "hooks": [{ "type": "command", "command": "mine start" }] }],
        "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "mine prompt", "timeout": 5 }] }]
    }
}
`
const hooksFile = (user: string) => join(user, '.codex', 'hooks.json')
const BACKUP = (user: string) => join(user, '.codex', 'hooks.json.before-matt-deck')

// Deck's hook: on each prompt sent, its tool of the Deck service with the
// prompt as written, and no other.
const isDeckHook = (handler: any) => handler.type === 'mcp_tool' && handler.server === 'matt_deck' && handler.tool === 'deck_prompt_submitted'
const DECK_HOOK = { type: 'mcp_tool', server: 'matt_deck', tool: 'deck_prompt_submitted', input: { prompt: '${prompt}' }, timeout: 10 }

test('install adds Deck\'s hook on UserPromptSubmit to the user\'s Codex hooks after theirs, backed up first, and says to trust it; uninstall gives the file back as it was', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)

  const { stdout } = await run(user, 'install')
  const installed = await readFile(hooksFile(user), 'utf8')
  await run(user, 'install')

  const { hooks, note } = JSON.parse(installed)
  assert.equal(note, 'mine k2w7')
  assert.deepEqual(hooks.SessionStart, JSON.parse(HOOKS_BEFORE).hooks.SessionStart)
  assert.deepEqual(hooks.UserPromptSubmit, [...JSON.parse(HOOKS_BEFORE).hooks.UserPromptSubmit, { hooks: [DECK_HOOK] }])
  assert.equal(await readFile(join(user, '.codex', 'hooks.json.before-matt-deck'), 'utf8'), HOOKS_BEFORE)
  // Installed again, the hook stays where it is, as it is: Codex trusts it by
  // its place and its hash.
  assert.equal(await readFile(hooksFile(user), 'utf8'), installed)
  assert.ok(stdout.includes(hooksFile(user)), stdout)
  assert.ok(stdout.includes(`原来的文件备份在 ${join(user, '.codex', 'hooks.json.before-matt-deck')}`), stdout)
  // What to do before the hook runs, and how: Codex asks nowhere else.
  assert.ok(stdout.includes('接下来两步：在终端里运行一次 codex，在钩子审查里信任 Deck 的钩子；再重启 Codex 桌面应用。'), stdout)

  const { stdout: removed } = await run(user, 'uninstall')

  assert.equal(await readFile(hooksFile(user), 'utf8'), HOOKS_BEFORE)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'])
  assert.ok(removed.includes(hooksFile(user)), removed)
})

test('without Codex hooks before, install writes the file with Deck\'s hook alone, backing up none, and uninstall takes the hook out and keeps the file', async () => {
  const user = await home()

  const { stdout } = await run(user, 'install')

  const written = await readFile(hooksFile(user), 'utf8')
  assert.deepEqual(JSON.parse(written), { hooks: { UserPromptSubmit: [{ hooks: [DECK_HOOK] }] } })
  assert.ok(written.startsWith('{\n  "hooks": {\n    "UserPromptSubmit": [\n      {\n'), written)
  assert.ok(written.endsWith('}\n'), written)
  assert.ok(stdout.includes(`已在 ${hooksFile(user)} 里加上 Deck 的钩子。`), stdout)
  assert.ok(!stdout.includes('备份'), stdout)

  const { stdout: removed } = await run(user, 'uninstall')

  // With no backup, nothing shows Deck wrote the file: it stays.
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'])
  assert.equal(await readFile(hooksFile(user), 'utf8'), '{}\n')
  assert.ok(removed.includes(`已从 ${hooksFile(user)} 移除 Deck 的钩子。`), removed)
})

test('uninstall with no backup keeps the hooks file whatever it held before, and takes out only Deck\'s hook: the backup gone, or a Deck hook a person wrote in', async () => {
  // Hooks of { } before install, their backup gone since.
  const gone = await withConfig(BEFORE)
  await writeFile(hooksFile(gone.user), '{ }')
  await run(gone.user, 'install')
  await rm(BACKUP(gone.user))
  // Deck's hook written in by hand, or synced from elsewhere, never backed up.
  const written = await withConfig(BEFORE)
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine stop' }] }], UserPromptSubmit: [{ hooks: [DECK_HOOK] }] } }
  await writeFile(hooksFile(written.user), JSON.stringify(mine))

  for (const [user, kept] of [[gone.user, {}], [written.user, { hooks: { Stop: mine.hooks.Stop } }]] as const) {
    await run(user, 'uninstall')

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), kept)
  }
})

test('uninstall takes out only Deck\'s hook from hooks changed since install, and keeps the rest', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await run(user, 'install')
  const changed = JSON.parse(await readFile(hooksFile(user), 'utf8'))
  changed.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'mine later' }] })
  // A handler a person put beside Deck's, and one of theirs calling another
  // tool of the Deck service.
  changed.hooks.UserPromptSubmit[1].hooks.push({ type: 'command', command: 'mine beside' })
  changed.hooks.UserPromptSubmit[1].matcher = 'mine j4v8'
  changed.hooks.UserPromptSubmit.push({ hooks: [{ type: 'mcp_tool', server: 'matt_deck', tool: 'deck_tasks' }] })
  changed.hooks.Stop = [{ hooks: [{ type: 'command', command: 'mine stop' }] }]
  await writeFile(hooksFile(user), JSON.stringify(changed))

  await run(user, 'uninstall')

  const kept = JSON.parse(await readFile(hooksFile(user), 'utf8'))
  assert.deepEqual(kept.hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: 'mine prompt', timeout: 5 }] },
    { hooks: [{ type: 'command', command: 'mine beside' }], matcher: 'mine j4v8' },
    { hooks: [{ type: 'command', command: 'mine later' }] },
    { hooks: [{ type: 'mcp_tool', server: 'matt_deck', tool: 'deck_tasks' }] },
  ])
  assert.deepEqual(kept.hooks.Stop, changed.hooks.Stop)
  assert.ok(Object.values(kept.hooks).flat().every((group: any) => !group.hooks.some(isDeckHook)))
})

test('install stops when the Codex hooks are not JSON it can add a hook to, and changes nothing', async () => {
  for (const hooks of [
    '{ not json',
    '',
    ' \n\t',
    '\ufeff{}',
    '{} // mine',
    '{ /* mine */ }',
    '[]',
    'null',
    '"hooks"',
    '{ "hooks": [] }',
    '{ "hooks": null }',
    '{ "hooks": { "UserPromptSubmit": {} } }',
  ]) {
    const { user, config } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), hooks)

    await assert.rejects(run(user, 'install'), (error: any) => {
      assert.equal(error.code, 1, hooks)
      assert.ok(error.stderr.includes(`${hooksFile(user)} 不是 Deck 能读懂的钩子文件`), error.stderr)
      return true
    })
    assert.equal(await readFile(config, 'utf8'), BEFORE, hooks)
    assert.equal(await readFile(hooksFile(user), 'utf8'), hooks)
    assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'], hooks)
  }
})

// Codex hooks holding a byte that is not UTF-8: Deck handles UTF-8 text alone,
// so it could neither back them up nor give them back byte for byte.
const NOT_UTF8 = Buffer.from('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"caf\xe9"}]}]}}\n', 'latin1')

test('install and uninstall stop when the Codex hooks hold a byte that is not UTF-8, and change nothing', async () => {
  for (const command of ['install', 'uninstall']) {
    const user = await home()
    if (command === 'uninstall') {
      await run(user, 'install')
    } else {
      await mkdir(join(user, '.codex'))
      await writeFile(join(user, '.codex', 'config.toml'), BEFORE)
    }
    const config = await readFile(join(user, '.codex', 'config.toml'), 'utf8')
    const skill = await readFile(configureSkill(user), 'utf8').catch(() => undefined)
    await writeFile(hooksFile(user), NOT_UTF8)

    await assert.rejects(run(user, command), (error: any) => {
      assert.equal(error.code, 1, command)
      assert.ok(error.stderr.includes(`${hooksFile(user)} 不是 Deck 能读懂的钩子文件`), error.stderr)
      assert.ok(error.stderr.includes(`再运行一次 ${command}`), error.stderr)
      return true
    })
    assert.deepEqual(await readFile(hooksFile(user)), NOT_UTF8, command)
    assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'], command)
    assert.equal(await readFile(join(user, '.codex', 'config.toml'), 'utf8'), config, command)
    assert.equal(await readFile(configureSkill(user), 'utf8').catch(() => undefined), skill, command)
  }
})

// A Codex config holding a byte that is not UTF-8: Deck writes the config
// back as text, so it could not keep that byte as it was.
const CONFIG_NOT_UTF8 = Buffer.concat([Buffer.from(BEFORE), Buffer.from('note = "caf\xe9"\n', 'latin1')])

test('install and uninstall stop when the Codex config holds a byte that is not UTF-8, and change nothing', async () => {
  for (const command of ['install', 'uninstall']) {
    const user = await home()
    if (command === 'uninstall') {
      await run(user, 'install')
    }
    await mkdir(join(user, '.codex'), { recursive: true })
    const registered = command === 'uninstall' ? Buffer.from(await readFile(join(user, '.codex', 'config.toml'))) : Buffer.alloc(0)
    const config = Buffer.concat([CONFIG_NOT_UTF8, registered])
    await writeFile(join(user, '.codex', 'config.toml'), config)
    const codex = (await readdir(join(user, '.codex'))).sort()
    const skill = await readFile(configureSkill(user), 'utf8').catch(() => undefined)

    await assert.rejects(run(user, command), (error: any) => {
      assert.equal(error.code, 1, command)
      assert.ok(error.stderr.includes(`${join(user, '.codex', 'config.toml')} 里有不是 UTF-8 的字节`), error.stderr)
      assert.ok(error.stderr.includes(`再运行一次 ${command}`), error.stderr)
      return true
    })
    assert.deepEqual(await readFile(join(user, '.codex', 'config.toml')), config, command)
    assert.deepEqual((await readdir(join(user, '.codex'))).sort(), codex, command)
    assert.equal(await readFile(configureSkill(user), 'utf8').catch(() => undefined), skill, command)
  }
})

test('uninstall with a backup holding a byte that is not UTF-8 takes only Deck\'s hook out of the hooks and leaves the backup byte for byte', async () => {
  // The hooks before install as the backup would read were it decoded with
  // a replacement character: they are not what install wrote.
  const user = await home()
  await mkdir(join(user, '.codex'))
  await writeFile(hooksFile(user), NOT_UTF8.toString('utf8'))
  await run(user, 'install')
  await writeFile(BACKUP(user), NOT_UTF8)

  const { stdout } = await run(user, 'uninstall')

  assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), JSON.parse(NOT_UTF8.toString('utf8')))
  assert.deepEqual(await readFile(BACKUP(user)), NOT_UTF8)
  assert.ok(stdout.includes(`备份留在 ${BACKUP(user)}`), stdout)
})

test('install then uninstall gives back the Codex hooks byte for byte whatever they held, an empty UserPromptSubmit or empty hooks among them, and leaves no backup', async () => {
  for (const before of [
    '{}',
    '{"hooks": {}}',
    '{"hooks": {"UserPromptSubmit": []}}',
    '{\n  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mine stop" }] }], "UserPromptSubmit": [] }\n}\n',
    HOOKS_BEFORE,
    // Groups of a person's own with no list of hooks in them, or a handler
    // that is not one.
    '{"hooks": {"UserPromptSubmit": [{"matcher": "x"}, null, {"hooks": "oops"}, {"hooks": [null]}]}}',
    // Escapes a rewrite writes as they are, and keys like an index all first,
    // in numeric order.
    '{"x": "\\u0001", "y": "\\u001f", "z": "\\n\\"\\\\"}',
    '{"1": 2, "a": 1}',
    '{"1": 1, "2": 2, "hooks": {}}',
    // Laid out with tabs and CRLF, a string holding a quote and a space.
    '{\r\n\t"hooks": {\r\n\t\t"Stop": [{"hooks": [{"type": "command", "command": "echo \\"hi there\\""}]}]\r\n\t}\r\n}\r\n',
  ]) {
    const { user } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), before)

    await run(user, 'install')
    await run(user, 'uninstall')

    assert.equal(await readFile(hooksFile(user), 'utf8'), before)
    assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'], before)
  }
})

test('uninstall of hooks changed since install keeps an empty UserPromptSubmit the hooks had before, and drops the one install added', async () => {
  for (const [before, after] of [
    ['{"hooks": {"UserPromptSubmit": []}}', { hooks: { UserPromptSubmit: [], Stop: [{ hooks: [{ type: 'command', command: 'mine stop' }] }] } }],
    [undefined, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine stop' }] }] } }],
  ] as const) {
    const user = await home()
    if (before !== undefined) {
      await mkdir(join(user, '.codex'))
      await writeFile(hooksFile(user), before)
    }
    await run(user, 'install')
    const changed = JSON.parse(await readFile(hooksFile(user), 'utf8'))
    changed.hooks.Stop = [{ hooks: [{ type: 'command', command: 'mine stop' }] }]
    await writeFile(hooksFile(user), JSON.stringify(changed))

    await run(user, 'uninstall')

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), after)
  }
})

test('uninstall of hooks changed since install keeps a group a person added to the UserPromptSubmit install added, where there was none before', async () => {
  const stop = [{ hooks: [{ type: 'command', command: 'mine stop' }] }]
  const mine = { hooks: [{ type: 'command', command: 'mine later r6t1' }] }
  for (const before of [JSON.stringify({ hooks: { Stop: stop } }), undefined]) {
    const user = await home()
    if (before !== undefined) {
      await mkdir(join(user, '.codex'))
      await writeFile(hooksFile(user), before)
    }
    await run(user, 'install')
    const changed = JSON.parse(await readFile(hooksFile(user), 'utf8'))
    changed.hooks.UserPromptSubmit.push(mine)
    changed.hooks.Stop = stop
    await writeFile(hooksFile(user), JSON.stringify(changed))

    await run(user, 'uninstall')

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), { hooks: { Stop: stop, UserPromptSubmit: [mine] } }, before)
  }
})

// A backup an earlier uninstall left, or one left when Deck's hook was taken
// out by hand: it may hold the only copy of the person's hooks.
const OLD_BACKUP = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"kept only here 4q7z"}]}]}}'

test('a backup left before an install where there are no hooks is moved to the first free numbered name and said, not taken for the hooks before it', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(BACKUP(user), OLD_BACKUP)

  const { stdout } = await run(user, 'install')

  assert.equal(await readFile(`${BACKUP(user)}.1`, 'utf8'), OLD_BACKUP)
  assert.ok(stdout.includes(`之前留下的备份 ${BACKUP(user)} 已挪到 ${BACKUP(user)}.1。`), stdout)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json', 'hooks.json.before-matt-deck.1'])

  await run(user, 'uninstall')

  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json', 'hooks.json.before-matt-deck.1'])
  assert.equal(await readFile(hooksFile(user), 'utf8'), '{}\n')
  assert.equal(await readFile(`${BACKUP(user)}.1`, 'utf8'), OLD_BACKUP)
})

test('a backup left before an install where there are hooks is moved, taking no numbered name in use, and the hooks are backed up in its place', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await writeFile(BACKUP(user), OLD_BACKUP)
  await writeFile(`${BACKUP(user)}.1`, 'taken 8m2c')
  await writeFile(`${BACKUP(user)}.2`, 'taken 3p9w')
  await writeFile(`${BACKUP(user)}.3`, 'taken 6h4n')

  const { stdout } = await run(user, 'install')

  assert.equal(await readFile(`${BACKUP(user)}.4`, 'utf8'), OLD_BACKUP)
  assert.equal(await readFile(`${BACKUP(user)}.1`, 'utf8'), 'taken 8m2c')
  assert.equal(await readFile(`${BACKUP(user)}.2`, 'utf8'), 'taken 3p9w')
  assert.equal(await readFile(`${BACKUP(user)}.3`, 'utf8'), 'taken 6h4n')
  assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE)
  assert.ok(stdout.includes(`之前留下的备份 ${BACKUP(user)} 已挪到 ${BACKUP(user)}.4。`), stdout)
  assert.ok(stdout.includes(`原来的文件备份在 ${BACKUP(user)}`), stdout)

  await run(user, 'uninstall')

  assert.equal(await readFile(hooksFile(user), 'utf8'), HOOKS_BEFORE)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), [
    'config.toml',
    'hooks.json',
    'hooks.json.before-matt-deck.1',
    'hooks.json.before-matt-deck.2',
    'hooks.json.before-matt-deck.3',
    'hooks.json.before-matt-deck.4',
  ])
  assert.equal(await readFile(`${BACKUP(user)}.4`, 'utf8'), OLD_BACKUP)
})

test('a backup left before that holds the hooks as they are, as an install that failed after backing them up leaves it, stays where it is: install run again moves nothing', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await writeFile(BACKUP(user), HOOKS_BEFORE)

  const { stdout } = await run(user, 'install')
  await run(user, 'uninstall')
  await run(user, 'install')

  assert.ok(!stdout.includes('之前留下的备份'), stdout)
  assert.ok(stdout.includes(`原来的文件备份在 ${BACKUP(user)}`), stdout)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json', 'hooks.json.before-matt-deck'])
  assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE)
})

test('with no backup left before, install says nothing of moving one', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)

  const { stdout } = await run(user, 'install')

  assert.ok(!stdout.includes('之前留下的备份'), stdout)
  assert.ok(!stdout.includes(`${BACKUP(user)}.`), stdout)
})

test('uninstall stops when the Codex hooks are not JSON it can take a hook out of, and changes nothing', async () => {
  for (const hooks of ['{ not json', '[]', 'null', '"hooks"', '{ "hooks": [] }', '{ "hooks": null }', '{ "hooks": { "UserPromptSubmit": {} } }']) {
    const user = await home()
    await run(user, 'install')
    await writeFile(hooksFile(user), hooks)
    const config = await readFile(join(user, '.codex', 'config.toml'), 'utf8')

    await assert.rejects(run(user, 'uninstall'), (error: any) => {
      assert.equal(error.code, 1, hooks)
      assert.ok(error.stderr.includes(hooksFile(user)), error.stderr)
      return true
    })
    assert.equal(await readFile(join(user, '.codex', 'config.toml'), 'utf8'), config, hooks)
    assert.equal(await readFile(hooksFile(user), 'utf8'), hooks)
    assert.ok((await readFile(configureSkill(user), 'utf8')).includes(PLUGIN_CONFIGURE), hooks)
  }
})

test('installed again, install says Deck\'s hook is there already and changes nothing, its backup and the hooks as they are', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await run(user, 'install')
  const installed = await readFile(hooksFile(user), 'utf8')

  const { stdout } = await run(user, 'install')

  assert.match(stdout, /Deck 的钩子已经在 .*hooks\.json 里，没有改动/)
  assert.ok(!stdout.includes('备份'), stdout)
  assert.equal(await readFile(hooksFile(user), 'utf8'), installed)
  assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json', 'hooks.json.before-matt-deck'])
})

test('uninstall of hooks changed since install keeps empty hooks the file had before, and drops the empty hooks install added', async () => {
  for (const [before, after] of [
    ['{"hooks": {}}', { hooks: {}, version: 1 }],
    ['{}', { version: 1 }],
  ] as const) {
    const { user } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), before)
    await run(user, 'install')
    await writeFile(hooksFile(user), JSON.stringify({ ...JSON.parse(await readFile(hooksFile(user), 'utf8')), version: 1 }))

    await run(user, 'uninstall')

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), after, before)
  }
})

test('uninstall takes Deck\'s hook a person edited since install for hooks changed since: it takes the hook out, and keeps the backup', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await run(user, 'install')
  const edited = JSON.parse(await readFile(hooksFile(user), 'utf8'))
  edited.hooks.UserPromptSubmit.at(-1).hooks[0].timeout = 30
  await writeFile(hooksFile(user), JSON.stringify(edited))

  await run(user, 'uninstall')

  assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), JSON.parse(HOOKS_BEFORE))
  assert.equal(await readFile(join(user, '.codex', 'hooks.json.before-matt-deck'), 'utf8'), HOOKS_BEFORE)
})

test('uninstall says where the backup of the hooks before install stays when it leaves one: hooks changed since, Deck\'s hook taken out by hand, or no hooks file', async () => {
  for (const change of [
    (installed: string) => installed.replace('mine start', 'mine start again'),
    () => HOOKS_BEFORE,
    undefined,
  ]) {
    const { user } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), HOOKS_BEFORE)
    await run(user, 'install')
    if (change === undefined) {
      await rm(hooksFile(user))
    } else {
      await writeFile(hooksFile(user), change(await readFile(hooksFile(user), 'utf8')))
    }

    const { stdout } = await run(user, 'uninstall')

    assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE)
    assert.ok(stdout.includes(`备份留在 ${BACKUP(user)}`), stdout)
  }
})

test('uninstall says nothing of a backup when it leaves none: the hooks unchanged since install, or changed where there were none before', async () => {
  const unchanged = await withConfig(BEFORE)
  await writeFile(hooksFile(unchanged.user), HOOKS_BEFORE)
  const none = await home()
  for (const user of [unchanged.user, none]) {
    await run(user, 'install')
  }
  await writeFile(hooksFile(none), (await readFile(hooksFile(none), 'utf8')).replace('"timeout": 10', '"timeout": 10, "x": 1'))

  for (const user of [unchanged.user, none]) {
    const { stdout } = await run(user, 'uninstall')

    assert.ok(!stdout.includes('before-matt-deck'), stdout)
    assert.ok(!stdout.includes('备份'), stdout)
  }
})

test('uninstall leaves Codex hooks that hold no Deck hook as they are, and says nothing of them, as for an install before Deck added its hook', async () => {
  const { user } = await withConfig(BEFORE)
  const compact = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"mine prompt"}]}]}}'
  await writeFile(hooksFile(user), compact)

  const { stdout } = await run(user, 'uninstall')

  assert.equal(await readFile(hooksFile(user), 'utf8'), compact)
  assert.ok(!stdout.includes(hooksFile(user)), stdout)
})

test('a handler of a person\'s own naming the hook\'s tool, but not as Deck\'s hook calls it, is not taken for Deck\'s hook', async () => {
  const theirs = [
    { type: 'mcp_tool', server: 'other_deck', tool: 'deck_prompt_submitted' },
    { type: 'command', server: 'matt_deck', tool: 'deck_prompt_submitted', command: 'mine prompt' },
  ]
  for (const handler of theirs) {
    const { user } = await withConfig(BEFORE)
    const before = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [handler] }] } })
    await writeFile(hooksFile(user), before)

    await run(user, 'install')

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')).hooks.UserPromptSubmit, [{ hooks: [handler] }, { hooks: [DECK_HOOK] }])
    await run(user, 'uninstall')
    assert.equal(await readFile(hooksFile(user), 'utf8'), before)
  }
})

// Backups Deck cannot read hooks from: not JSON, empty, not hooks a
// UserPromptSubmit hook can be added to, and a directory. Uninstall takes
// them for hooks changed since install: it takes Deck's hook out of the hooks
// and leaves the backup as it is.
const UNREADABLE_BACKUPS = ['NOT JSON 3kx9', '', '{"hooks": [], "note": "w5p1"}', undefined]

const writeBackup = async (user: string, text: string | undefined) => {
  if (text === undefined) {
    await mkdir(BACKUP(user))
    await writeFile(join(BACKUP(user), 'inside'), 'mine r8d2')
  } else {
    await writeFile(BACKUP(user), text)
  }
}

const assertBackupAsWritten = async (user: string, text: string | undefined) => {
  if (text === undefined) {
    assert.deepEqual(await readdir(BACKUP(user)), ['inside'])
    assert.equal(await readFile(join(BACKUP(user), 'inside'), 'utf8'), 'mine r8d2')
  } else {
    assert.equal(await readFile(BACKUP(user), 'utf8'), text)
  }
}

test('uninstall with a backup it cannot read hooks from takes Deck\'s hook out of the hooks, leaves the backup as it is and says where it stays', async () => {
  for (const backup of UNREADABLE_BACKUPS) {
    const user = await home()
    await run(user, 'install')
    await writeBackup(user, backup)

    const { stdout } = await run(user, 'uninstall')

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), {}, String(backup))
    await assertBackupAsWritten(user, backup)
    assert.ok(stdout.includes(`备份留在 ${BACKUP(user)}`), stdout)
    assert.ok(stdout.includes(`已从 ${hooksFile(user)} 移除 Deck 的钩子`), stdout)
    assert.doesNotMatch(await readFile(join(user, '.codex', 'config.toml'), 'utf8'), /matt_deck/)
    assert.deepEqual(await readdir(join(user, '.agents', 'skills')), [], String(backup))
    // The hooks left are ones install and uninstall read.
    await run(user, 'uninstall')
    await run(user, 'install')
  }
})

test('uninstall with a backup it cannot read hooks from and hooks holding no Deck hook leaves both as they are, says where the backup stays, and removes the rest', async () => {
  for (const backup of UNREADABLE_BACKUPS) {
    const { user, config } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), HOOKS_BEFORE)
    await run(user, 'install')
    await writeFile(hooksFile(user), HOOKS_BEFORE)
    await rm(BACKUP(user))
    await writeBackup(user, backup)

    const { stdout } = await run(user, 'uninstall')

    assert.equal(await readFile(hooksFile(user), 'utf8'), HOOKS_BEFORE)
    await assertBackupAsWritten(user, backup)
    assert.ok(stdout.includes(`备份留在 ${BACKUP(user)}`), stdout)
    assert.equal(await readFile(config, 'utf8'), BEFORE)
    assert.deepEqual(await readdir(join(user, '.agents', 'skills')), [], String(backup))
  }
})

test('uninstall takes hooks only laid out anew since install for unchanged: it gives back the backup byte for byte and leaves none', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await run(user, 'install')
  await writeFile(hooksFile(user), JSON.stringify(JSON.parse(await readFile(hooksFile(user), 'utf8'))))

  await run(user, 'uninstall')

  assert.equal(await readFile(hooksFile(user), 'utf8'), HOOKS_BEFORE)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'])
})

// Hooks Deck would not write back as written: Deck parses the file and writes
// it anew, so it handles only one that, written anew, differs in whitespace
// alone. A number past what a double holds, 1e400, 1.0, a key given twice, an
// escape such as \u or \/, or a key like an index, which moves first, would
// change.
const CHANGED_BY_A_REWRITE = [
  '{"x": 1.0}',
  '{"x": 0.10}',
  '{"x": 1e3}',
  '{"x": -0}',
  '{"x": 1e400}',
  '{"x": 9007199254740993}',
  '{"x": 1, "x": 2}',
  '{"x": "\\u0041"}',
  '{"x": "\\u001F"}',
  '{"a": "x\\/y"}',
  '{"x": 1, "1": 2}',
  '{"a": 1, "1": 2}',
  '{"2": 1, "1": 2}',
]

test('install stops when the Codex hooks hold what Deck would not write back as written, says so, and writes nothing', async () => {
  for (const hooks of CHANGED_BY_A_REWRITE) {
    const { user, config } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), hooks)

    await assert.rejects(run(user, 'install'), (error: any) => {
      assert.equal(error.code, 1, hooks)
      assert.ok(error.stderr.includes(`${hooksFile(user)} 里有 Deck 改写时会变样的写法`), error.stderr)
      assert.ok(
        error.stderr.includes(
          '（超出双精度的数、1.0 或 1e400 这样重写后写法会变的数、重复的键、\\u0041、\\/ 这样重写后会变样的转义，或没有全部按数值升序排在最前面的像序号的键）',
        ),
        error.stderr,
      )
      assert.ok(error.stderr.includes('再运行一次 install'), error.stderr)
      return true
    })
    assert.equal(await readFile(config, 'utf8'), BEFORE, hooks)
    assert.equal(await readFile(hooksFile(user), 'utf8'), hooks)
    assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'], hooks)
    assert.equal(await readFile(configureSkill(user), 'utf8').catch(() => undefined), undefined, hooks)
  }
})

test('uninstall stops when hooks edited since install hold what Deck would not write back as written, and changes nothing, the backup included', async () => {
  for (const [before, edit] of [
    ['{"x":9007199254740992}', (text: string) => text.replace('9007199254740992', '9007199254740993')],
    ['{"x":null}', (text: string) => text.replace('null', '1e400')],
    ['{}', (text: string) => text.replace('{', '{"9007199254740993": 9007199254740993,')],
  ] as const) {
    const user = await home()
    await mkdir(join(user, '.codex'))
    await writeFile(hooksFile(user), before)
    await run(user, 'install')
    const edited = edit(await readFile(hooksFile(user), 'utf8'))
    await writeFile(hooksFile(user), edited)
    const config = await readFile(join(user, '.codex', 'config.toml'), 'utf8')

    await assert.rejects(run(user, 'uninstall'), (error: any) => {
      assert.equal(error.code, 1, before)
      assert.ok(error.stderr.includes(`${hooksFile(user)} 里有 Deck 改写时会变样的写法`), error.stderr)
      assert.ok(error.stderr.includes('再运行一次 uninstall'), error.stderr)
      return true
    })
    assert.equal(await readFile(hooksFile(user), 'utf8'), edited)
    assert.equal(await readFile(BACKUP(user), 'utf8'), before)
    assert.equal(await readFile(join(user, '.codex', 'config.toml'), 'utf8'), config, before)
    assert.ok((await readFile(configureSkill(user), 'utf8')).includes(PLUGIN_CONFIGURE), before)
  }
})

test('uninstall with a backup holding what Deck would not write back as written takes only Deck\'s hook out of the hooks and leaves the backup as it is', async () => {
  // Each backup read as the hooks before install would be them.
  for (const backup of CHANGED_BY_A_REWRITE) {
    const user = await home()
    await mkdir(join(user, '.codex'))
    await writeFile(hooksFile(user), JSON.stringify(JSON.parse(backup)))
    await run(user, 'install')
    await writeFile(BACKUP(user), backup)

    const { stdout } = await run(user, 'uninstall')

    // As JSON writes them: -0 is written 0.
    assert.equal(JSON.stringify(JSON.parse(await readFile(hooksFile(user), 'utf8'))), JSON.stringify(JSON.parse(backup)), backup)
    assert.equal(await readFile(BACKUP(user), 'utf8'), backup)
    assert.ok(stdout.includes(`备份留在 ${BACKUP(user)}`), stdout)
  }
})

// What install leaves in a home it stopped in: the config as it was, no
// skill, and in .codex only what was there.
const unchanged = async (user: string, codex: string[], why: string) => {
  assert.equal(await readFile(join(user, '.codex', 'config.toml'), 'utf8'), BEFORE, why)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), codex, why)
  assert.equal(await readFile(configureSkill(user), 'utf8').catch(() => undefined), undefined, why)
}

// Permissions stop no one running as root.
const AS_ROOT = { skip: process.getuid?.() === 0 }

test('install stops before writing anything when it cannot write the hooks, and run again once they can be written it installs, with one backup', AS_ROOT, async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE, { mode: 0o444 })

  for (let n = 0; n < 2; n++) {
    await assert.rejects(run(user, 'install'), (error: any) => {
      assert.equal(error.code, 1)
      assert.ok(error.stderr.includes(`${hooksFile(user)} 写不进去（EACCES），没有安装，什么都没改。`), error.stderr)
      assert.ok(error.stderr.includes('再运行一次 install'), error.stderr)
      return true
    })
    await unchanged(user, ['config.toml', 'hooks.json'], 'read-only')
  }

  await chmod(hooksFile(user), 0o644)
  await run(user, 'install')

  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json', 'hooks.json.before-matt-deck'])
  assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE)
})

test('install takes a backup there holding the hooks as they are for its own and leaves it as it is, though it cannot be written, as a run that stopped on read-only hooks leaves it', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), '{}\n')
  await writeFile(BACKUP(user), '{}\n', { mode: 0o444 })

  await run(user, 'install')

  assert.equal(await readFile(BACKUP(user), 'utf8'), '{}\n')
  assert.equal((await stat(BACKUP(user))).mode & 0o777, 0o444)
  assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), { hooks: { UserPromptSubmit: [{ hooks: [DECK_HOOK] }] } })
})

// A file macOS will not let anyone change or remove, where the check before
// writing finds nothing amiss: removing a file asks only its directory.
const IMMUTABLE = { skip: process.platform !== 'darwin' || process.getuid?.() === 0 }
const chflags = (flag: string, path: string) => exec('chflags', [flag, path])

test('uninstall gives the hooks back before it removes their backup: a backup it cannot remove leaves the hooks as they were before install', IMMUTABLE, async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await run(user, 'install')
  await chflags('uchg', BACKUP(user))

  try {
    await assert.rejects(run(user, 'uninstall'), (error: any) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /EPERM/)
      return true
    })
    assert.equal(await readFile(hooksFile(user), 'utf8'), HOOKS_BEFORE)
    assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE)
  } finally {
    await chflags('nouchg', BACKUP(user))
  }
})

// A run of the command line where macOS denies writing one file, which the
// check before writing does not see: making a file asks only its directory.
const SANDBOXED = {
  skip:
    process.platform !== 'darwin' ||
    process.getuid?.() === 0 ||
    !(await exec('sandbox-exec', ['-p', '(version 1)(allow default)', 'true']).then(() => true, () => false)),
}
const runDenying = (user: string, denied: string, ...args: string[]) =>
  checked(user, () =>
    exec('sandbox-exec', ['-p', `(version 1)(allow default)(deny file-write* (literal ${JSON.stringify(denied)}))`, process.execPath, CODEX, ...args], {
      env: { ...process.env, HOME: user },
    }),
  )

test('install backs the hooks up before it writes Deck\'s hook in: a backup it cannot make leaves the hooks as they were', SANDBOXED, async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), '{"hooks":{}}\n')

  await assert.rejects(runDenying(user, BACKUP(user), 'install'), (error: any) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /EPERM/)
    return true
  })
  assert.equal(await readFile(hooksFile(user), 'utf8'), '{"hooks":{}}\n')
  assert.equal(await lstat(BACKUP(user)).catch(() => undefined), undefined)
})

test('install stops before writing anything when the hooks are a link to a file it cannot write', AS_ROOT, async () => {
  const { user } = await withConfig(BEFORE)
  const elsewhere = await home()
  await writeFile(join(elsewhere, 'hooks.json'), HOOKS_BEFORE, { mode: 0o444 })
  await symlink(join(elsewhere, 'hooks.json'), hooksFile(user))

  await assert.rejects(run(user, 'install'), (error: any) => {
    assert.equal(error.code, 1)
    assert.ok(error.stderr.includes(`${hooksFile(user)} 写不进去（EACCES）`), error.stderr)
    return true
  })
  await unchanged(user, ['config.toml', 'hooks.json'], 'link')
  assert.equal(await readFile(join(elsewhere, 'hooks.json'), 'utf8'), HOOKS_BEFORE)
})

test('install stops before writing anything when the hooks are a link reaching no file, in a directory that is there or one that is not', async () => {
  for (const gone of ['gone 7k3e.json', join('no such dir 2r8q', 'hooks.json')]) {
    const { user } = await withConfig(BEFORE)
    const elsewhere = await home()
    await symlink(join(elsewhere, gone), hooksFile(user))

    await assert.rejects(run(user, 'install'), (error: any) => {
      assert.equal(error.code, 1, gone)
      assert.ok(error.stderr.includes(`${hooksFile(user)} 是一个链接，链到的文件不存在，没有安装，什么都没改。`), error.stderr)
      return true
    })
    await unchanged(user, ['config.toml', 'hooks.json'], gone)
    assert.deepEqual(await readdir(elsewhere), [], gone)
  }
})

test('install stops before writing anything when the Codex config or the configure skill is a link reaching no file', async () => {
  for (const which of ['config', 'skill'] as const) {
    const user = await home()
    const elsewhere = await home()
    const path = which === 'config' ? join(user, '.codex', 'config.toml') : configureSkill(user)
    await mkdir(join(path, '..'), { recursive: true })
    await symlink(join(elsewhere, 'gone 4w9s'), path)

    await assert.rejects(run(user, 'install'), (error: any) => {
      assert.equal(error.code, 1, which)
      assert.ok(error.stderr.includes(`${path} 是一个链接，链到的文件不存在，没有安装，什么都没改。`), error.stderr)
      return true
    })
    assert.deepEqual(await readdir(elsewhere), [], which)
    assert.equal(await lstat(hooksFile(user)).catch(() => undefined), undefined, which)
  }
})

test('install stops before writing anything when a file is where it would make the directory of the policy beside the skill', async () => {
  const { user } = await withConfig(BEFORE)
  const agents = join(user, '.agents', 'skills', 'matt-deck-configure', 'agents')
  await mkdir(join(agents, '..'), { recursive: true })
  await writeFile(agents, 'mine\n')

  await assert.rejects(run(user, 'install'), (error: any) => {
    assert.equal(error.code, 1)
    assert.ok(error.stderr.includes(`${configurePolicy(user)} 写不进去（ENOTDIR），没有安装，什么都没改。`), error.stderr)
    return true
  })
  await unchanged(user, ['config.toml'], 'agents is a file')
  assert.equal(await readFile(agents, 'utf8'), 'mine\n')
})

test('install stops before writing anything when it cannot make the backup beside the hooks', AS_ROOT, async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await chmod(join(user, '.codex'), 0o555)

  try {
    await assert.rejects(run(user, 'install'), (error: any) => {
      assert.equal(error.code, 1)
      assert.ok(error.stderr.includes(`${join(user, '.codex')} 写不进去（EACCES）`), error.stderr)
      return true
    })
    await unchanged(user, ['config.toml', 'hooks.json'], 'directory')
  } finally {
    await chmod(join(user, '.codex'), 0o755)
  }
})

test('uninstall stops before changing anything when it cannot write the hooks, and run again once they can be written it uninstalls', AS_ROOT, async () => {
  const { user, config } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await run(user, 'install')
  const installed = await readFile(config, 'utf8')
  const hooks = await readFile(hooksFile(user), 'utf8')
  await chmod(hooksFile(user), 0o444)

  await assert.rejects(run(user, 'uninstall'), (error: any) => {
    assert.equal(error.code, 1)
    assert.ok(error.stderr.includes(`${hooksFile(user)} 写不进去（EACCES），没有卸载，什么都没改。`), error.stderr)
    assert.ok(error.stderr.includes('再运行一次 uninstall'), error.stderr)
    return true
  })
  assert.equal(await readFile(config, 'utf8'), installed)
  assert.equal(await readFile(hooksFile(user), 'utf8'), hooks)
  assert.ok((await readFile(configureSkill(user), 'utf8')).length > 0)

  await chmod(hooksFile(user), 0o644)
  await run(user, 'uninstall')

  assert.equal(await readFile(config, 'utf8'), BEFORE)
  assert.equal(await readFile(hooksFile(user), 'utf8'), HOOKS_BEFORE)
  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json'])
})

test('uninstall stops before changing anything when it cannot remove the backup it gives back, or the skill it generated', AS_ROOT, async () => {
  for (const dir of ['.codex', join('.agents', 'skills', 'matt-deck-configure')]) {
    const { user, config } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), HOOKS_BEFORE)
    await run(user, 'install')
    const installed = await readFile(config, 'utf8')
    await chmod(join(user, dir), 0o555)

    try {
      await assert.rejects(run(user, 'uninstall'), (error: any) => {
        assert.equal(error.code, 1, dir)
        assert.ok(error.stderr.includes(`${join(user, dir)} 写不进去（EACCES），没有卸载`), error.stderr)
        return true
      })
      assert.equal(await readFile(config, 'utf8'), installed, dir)
      assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE, dir)
      assert.ok((await readFile(configureSkill(user), 'utf8')).length > 0, dir)
    } finally {
      await chmod(join(user, dir), 0o755)
    }
  }
})

test('install backs the hooks up with the permissions the file has', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE, { mode: 0o600 })
  await chmod(hooksFile(user), 0o600)

  await run(user, 'install')

  assert.equal((await stat(BACKUP(user))).mode & 0o777, 0o600)
})

test('install backs up hooks that are a link with the permissions of the file it reaches', async () => {
  const { user } = await withConfig(BEFORE)
  const reached = join(user, 'my hooks 8n3d.json')
  await writeFile(reached, HOOKS_BEFORE)
  await chmod(reached, 0o600)
  await symlink(reached, hooksFile(user))

  await run(user, 'install')

  assert.equal((await stat(BACKUP(user))).mode & 0o777, 0o600)
})

test('uninstall with a link for a backup that reaches no file keeps the hooks, takes out only Deck\'s hook, and leaves the link as it is and says where', async () => {
  const user = await home()
  await mkdir(join(user, '.codex'))
  await writeFile(hooksFile(user), '{}')
  await run(user, 'install')
  await rm(BACKUP(user))
  await symlink(join(user, 'gone 5c2v'), BACKUP(user))

  const { stdout } = await run(user, 'uninstall')

  assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), {})
  assert.equal(await readlink(BACKUP(user)), join(user, 'gone 5c2v'))
  assert.ok(stdout.includes(`备份留在 ${BACKUP(user)}`), stdout)
})

test('uninstall takes out Deck\'s hook from its group behind a handler a person put first, and the group it leaves with only a matcher of theirs', async () => {
  for (const [change, after] of [
    [
      (group: any) => group.hooks.unshift({ type: 'command', command: 'mine first' }),
      [...JSON.parse(HOOKS_BEFORE).hooks.UserPromptSubmit, { hooks: [{ type: 'command', command: 'mine first' }] }],
    ],
    [(group: any) => (group.matcher = 'mine m3k8'), JSON.parse(HOOKS_BEFORE).hooks.UserPromptSubmit],
  ] as const) {
    const { user } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), HOOKS_BEFORE)
    await run(user, 'install')
    const changed = JSON.parse(await readFile(hooksFile(user), 'utf8'))
    change(changed.hooks.UserPromptSubmit.at(-1))
    await writeFile(hooksFile(user), JSON.stringify(changed))

    await run(user, 'uninstall')

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')).hooks.UserPromptSubmit, after)
  }
})

test('installed again after a person edited Deck\'s hook, install adds no second one', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  await run(user, 'install')
  const edited = JSON.parse(await readFile(hooksFile(user), 'utf8'))
  edited.hooks.UserPromptSubmit.at(-1).hooks[0].timeout = 30
  await writeFile(hooksFile(user), JSON.stringify(edited))

  const { stdout } = await run(user, 'install')

  assert.equal(await readFile(hooksFile(user), 'utf8'), JSON.stringify(edited))
  assert.match(stdout, /Deck 的钩子已经在 .*hooks\.json 里，没有改动/)
})

test('a numbered name a directory or a link reaching no file takes is not free for a backup left before', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(BACKUP(user), OLD_BACKUP)
  await mkdir(`${BACKUP(user)}.1`)
  await symlink(join(user, 'gone 8t4d'), `${BACKUP(user)}.2`)

  const { stdout } = await run(user, 'install')

  assert.equal(await readFile(`${BACKUP(user)}.3`, 'utf8'), OLD_BACKUP)
  assert.deepEqual(await readdir(`${BACKUP(user)}.1`), [])
  assert.equal(await readlink(`${BACKUP(user)}.2`), join(user, 'gone 8t4d'))
  assert.ok(stdout.includes(`已挪到 ${BACKUP(user)}.3。`), stdout)
})

test('a backup left before that is a link reaching no file is moved as the link, and the hooks are backed up in a file of its own, not where the link reached', async () => {
  const { user } = await withConfig(BEFORE)
  await writeFile(hooksFile(user), HOOKS_BEFORE)
  const gone = join(user, 'gone 2r7j')
  await symlink(gone, BACKUP(user))

  const { stdout } = await run(user, 'install')

  assert.equal(await readlink(`${BACKUP(user)}.1`), gone)
  assert.equal((await lstat(BACKUP(user))).isFile(), true)
  assert.equal(await readFile(BACKUP(user), 'utf8'), HOOKS_BEFORE)
  assert.equal(await lstat(gone).catch(() => undefined), undefined)
  assert.ok(stdout.includes(`之前留下的备份 ${BACKUP(user)} 已挪到 ${BACKUP(user)}.1。`), stdout)
})
