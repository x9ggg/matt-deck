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

const CODEX = join(import.meta.dirname, '..', 'plugin', 'cli', 'codex.ts')
const exec = promisify(execFile)

const home = async () => realpath(await mkdtemp(join(tmpdir(), 'deck-home-')))

const run = (user: string, ...args: string[]) => exec(process.execPath, [CODEX, ...args], { env: { ...process.env, HOME: user } })

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
  const table = text.split(/^(?=\[)/m).filter(part => part.startsWith('[mcp_servers.matt_deck]'))
  assert.equal(table.length, 1, text)
  const value = (key: string) => JSON.parse(table[0]!.match(new RegExp(`^${key} = (.*)$`, 'm'))![1]!)

  return { command: value('command') as string, args: value('args') as string[] }
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
    child.on('exit', code => reject(new Error(`Deck service exited (${code})`)))
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
  const listed = await reply
  child.kill()
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

  await exec(process.execPath, [CODEX, 'install'], { env: { ...process.env, HOME: user, PATH: [await otherNode(), linked, process.env.PATH].join(delimiter) } })

  assert.equal(registration(await readFile(join(user, '.codex', 'config.toml'), 'utf8')).command, join(linked, 'node'))
})

test('install registers the path of the node running it when no node on its PATH is that node, but through a relative entry', async () => {
  const user = await home()
  const linked = await home()
  await symlink(process.execPath, join(linked, 'node'))

  await exec(process.execPath, [CODEX, 'install'], { cwd: linked, env: { ...process.env, HOME: user, PATH: [await otherNode(), await home(), '.'].join(delimiter) } })

  assert.equal(registration(await readFile(join(user, '.codex', 'config.toml'), 'utf8')).command, process.execPath)
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
]

test('install and uninstall stop when the Codex config registers the Deck service in a form Deck does not write, and change nothing', async () => {
  for (const form of HAND_WRITTEN) {
    for (const command of ['install', 'uninstall']) {
      const { user, config } = await withConfig(`${form}\n${BEFORE}`)

      await assert.rejects(run(user, command), (error: any) => {
        assert.equal(error.code, 1, form)
        assert.ok(error.stderr.includes(`${config} 里的 Deck 服务注册不是 Deck 认得的写法`), error.stderr)
        assert.ok(error.stderr.includes(`再运行一次 ${command}`), error.stderr)
        return true
      })
      assert.equal(await readFile(config, 'utf8'), `${form}\n${BEFORE}`, form)
      assert.deepEqual(await readdir(user), ['.codex'], form)
      assert.deepEqual(await readdir(join(user, '.codex')), ['config.toml'], form)
    }
  }
})

test('install stops when the Codex config holds mcp_servers as an inline table, which no table can be added to; uninstall finds no registration there', async () => {
  const inline = `mcp_servers = { other = { command = "other" } }\n`
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
})

test('install and uninstall take keys only named like the Deck service for what they are: not its registration', async () => {
  const alike = `${BEFORE}\n[mcp_servers.other.env]\nmatt_deck = "1"\n\n[profiles.matt_deck]\nmodel = "o3"\n\n[mcp_servers."matt_deck_later"]\ncommand = "later"\n`
  const { user, config } = await withConfig(alike)

  await run(user, 'install')
  const installed = await readFile(config, 'utf8')
  await run(user, 'uninstall')

  assert.ok(installed.startsWith(alike), installed)
  registration(installed)
  assert.equal(await readFile(config, 'utf8'), alike)
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

test('without Codex hooks before, install writes the file with Deck\'s hook alone, backing up none, and uninstall removes it', async () => {
  const user = await home()

  const { stdout } = await run(user, 'install')

  const written = await readFile(hooksFile(user), 'utf8')
  assert.deepEqual(JSON.parse(written), { hooks: { UserPromptSubmit: [{ hooks: [DECK_HOOK] }] } })
  assert.ok(written.startsWith('{\n  "hooks": {\n    "UserPromptSubmit": [\n      {\n'), written)
  assert.ok(written.endsWith('}\n'), written)
  assert.ok(stdout.includes(`已在 ${hooksFile(user)} 里加上 Deck 的钩子。`), stdout)
  assert.ok(!stdout.includes('备份'), stdout)

  const { stdout: removed } = await run(user, 'uninstall')

  assert.deepEqual(await readdir(join(user, '.codex')), ['config.toml'])
  assert.ok(removed.includes(`已删掉 Deck 加的 ${hooksFile(user)}，安装前没有这个文件。`), removed)
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
  for (const hooks of ['{ not json', '[]', 'null', '"hooks"', '{ "hooks": [] }', '{ "hooks": null }', '{ "hooks": { "UserPromptSubmit": {} } }']) {
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

  assert.deepEqual((await readdir(join(user, '.codex'))).sort(), ['config.toml', 'hooks.json.before-matt-deck.1'])
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
const CHANGED_BY_A_REWRITE = ['{"x": 1.0}', '{"x": 9007199254740993}', '{"x": 1, "x": 2}', '{"x": "\\u0041"}', '{"a": "x\\/y"}', '{"x": 1, "1": 2}']

test('install stops when the Codex hooks hold what Deck would not write back as written, says so, and writes nothing', async () => {
  for (const hooks of CHANGED_BY_A_REWRITE) {
    const { user, config } = await withConfig(BEFORE)
    await writeFile(hooksFile(user), hooks)

    await assert.rejects(run(user, 'install'), (error: any) => {
      assert.equal(error.code, 1, hooks)
      assert.ok(error.stderr.includes(`${hooksFile(user)} 里有 Deck 改写时会变样的写法`), error.stderr)
      assert.ok(error.stderr.includes('（超出双精度的数、1.0 或 1e400 这样的数、重复的键、\\u、\\/ 这样的转义，或像序号的键）'), error.stderr)
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

    assert.deepEqual(JSON.parse(await readFile(hooksFile(user), 'utf8')), JSON.parse(backup), backup)
    assert.equal(await readFile(BACKUP(user), 'utf8'), backup)
    assert.ok(stdout.includes(`备份留在 ${BACKUP(user)}`), stdout)
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
