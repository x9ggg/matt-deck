// Run directly with Node, once a user: installs Deck into the Codex desktop
// app, or uninstalls it. Codex loads its MCP services from the user's own
// config, never a project's (ADR-0006), so the Deck service is registered
// there, started for Codex.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const USAGE = `Usage: node <matt-deck>/cli/codex.ts <install|uninstall>

install：把 Deck 服务注册进 Codex 的用户全局配置 ~/.codex/config.toml，原有内容保留。装完要重启 Codex 桌面应用。
uninstall：从 ~/.codex/config.toml 移除 Deck 服务的注册，别的内容不动。
退出码：0 成功，1 读写失败，2 参数错误。
`
const TABLE = 'mcp_servers.matt_deck'

// The config without Deck's registration: its table, and the tables under it,
// each from its header to the next table's. The comment lines just above that
// next header stay: Deck writes no comment, they are about the table after.
// Each line keeps its own ending, LF or CRLF.
const unregistered = (text: string) => {
  const kept: string[] = []
  let ours = false
  let above: string[] = []

  for (const line of text.split(/(?<=\n)/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?\r?\n?$/)
    if (header !== null) {
      const isOurs = header[1] === TABLE || header[1]!.startsWith(`${TABLE}.`)
      if (ours && !isOurs) {
        kept.push(...above)
      }
      ours = isOurs
      above = []
    }
    if (!ours) {
      kept.push(line)
    } else if (header === null) {
      above = /^\s*#/.test(line) ? [...above, line] : []
    }
  }
  // Deck's table ran to the end: the blank line install set it apart with
  // goes with it.
  if (ours && kept.length > 0 && kept.at(-1)!.trim() === '') {
    kept.pop()
  }

  return kept.join('')
}

const args = process.argv.slice(2)

if (args.length !== 1 || (args[0] !== 'install' && args[0] !== 'uninstall')) {
  process.stderr.write(USAGE)
  process.exitCode = 2
} else {
  try {
    const config = join(homedir(), '.codex', 'config.toml')
    let before: string | undefined
    try {
      before = await readFile(config, 'utf8')
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
    const kept = unregistered(before ?? '')

    if (args[0] === 'install') {
      // A JSON string is a TOML basic string.
      const launch = [join(import.meta.dirname, '..', 'server', 'main.ts'), '--host', 'codex']
      const table = `[${TABLE}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${launch.map(arg => JSON.stringify(arg)).join(', ')}]\n`
      const gap = kept === '' ? '' : kept.endsWith('\n') ? '\n' : '\n\n'
      await mkdir(dirname(config), { recursive: true })
      await writeFile(config, `${kept}${gap}${table}`)
      process.stdout.write(`已把 Deck 服务注册进 ${config}。\n重启 Codex 桌面应用之后，每个 Session 的标签页菜单里出现 Matt Deck。\n`)
    } else if (before === undefined || kept === before) {
      process.stdout.write(`${config} 里没有 Deck 服务的注册，没有改动。\n`)
    } else {
      await writeFile(config, kept)
      process.stdout.write(`已从 ${config} 移除 Deck 服务的注册。\n`)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
