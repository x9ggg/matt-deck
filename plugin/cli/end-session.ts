// Run directly with Node, just like the Deck service, by the Mod as its
// Session exits: the Deck service has gone by then, so this one-shot run
// records the end through the same kernel (ADR-0005), and exits.
import { homedir } from 'node:os'
import { endSession } from '../kernel/occupancy.ts'

const USAGE = `Usage: node <matt-deck>/cli/end-session.ts <session-id>

把这个 Session 记为已结束：它在未关闭 Task 上的 Occupancy 从此显示为 Orphaned。
由 Mod 在 Session 退出、Deck 服务已经连不上时运行。退出码：0 成功，1 写入失败，2 参数错误。
`
const args = process.argv.slice(2)

if (args.length !== 1 || args[0] === '') {
  process.stderr.write(USAGE)
  process.exitCode = 2
} else {
  endSession(homedir(), args[0]!, Date.now())
}
