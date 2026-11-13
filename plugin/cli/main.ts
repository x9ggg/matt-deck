// Run directly with Node, just like the Deck service. All project behavior
// lives in the kernel and is also exposed through deck_inspect.
import { homedir } from 'node:os'
import { inspectProject } from '../kernel/inspect.ts'
import { workspaceAt } from '../kernel/workspace.ts'

const USAGE = `Usage: node <matt-deck>/cli/main.ts [--help]

在项目目录运行，输出只读 JSON：配置、本机状态文件位置、Task 分组和 Occupancy（含 Orphaned）。
退出码：0 成功，1 读取失败或未配置，2 参数错误。
`
const args = process.argv.slice(2)

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(USAGE)
} else if (args.length > 0) {
  process.stderr.write(USAGE)
  process.exitCode = 2
} else {
  try {
    const inspection = await inspectProject(workspaceAt(process.cwd()), homedir())
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
    process.exitCode = inspection.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
