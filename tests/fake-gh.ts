// A stand-in for the `gh` command line, put on the Deck service's PATH by the
// tests. It answers every call with what `answer.json` in FAKE_GH_DIR holds
// at that moment, and appends its arguments and working directory to
// `calls.log` there, one call a line.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_GH_DIR!
appendFileSync(join(dir, 'calls.log'), `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })}\n`)

const answer: { stdout?: unknown; stderr?: string; exitCode?: number } = JSON.parse(
  readFileSync(join(dir, 'answer.json'), 'utf8'),
)
if (answer.stdout !== undefined) {
  process.stdout.write(JSON.stringify(answer.stdout))
}
if (answer.stderr !== undefined) {
  process.stderr.write(answer.stderr)
}
process.exitCode = answer.exitCode ?? 0
