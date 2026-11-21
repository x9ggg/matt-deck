// The command line that installs Deck into Codex and uninstalls it, run in a
// temporary home: the machine's own Codex config is never touched.
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('the Codex command line takes install or uninstall', async () => {
  const user = await home()

  for (const args of [[], ['add'], ['install', 'extra']]) {
    await assert.rejects(run(user, ...args), (error: any) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /Usage:/)
      return true
    })
  }
  assert.deepEqual(await readdir(user), [])
})
