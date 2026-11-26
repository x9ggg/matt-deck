// The fake Host as the Pane's tests use it: what a test that waits on the page
// gets when the answer it gave goes wrong, or comes late.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answered, openPage } from './fake-host.ts'

// Tests whose answer fails on a call they did not expect: once as the page
// opens, by throwing, once on a later click, by rejecting, and once on a click
// by hand that nothing waits on.
const UNEXPECTED_TEST_FILE = `
import { test } from 'node:test'
import { answered, openPage } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'fake-host.ts')).href)}

test('throws as the page opens', async () => {
  await openPage({
    answer: name => {
      throw new Error('unexpected call of ' + name + ' as the page opens')
    },
  })
})

test('rejects on a click', async t => {
  let opened = false
  const page = await openPage({
    answer: async name => {
      if (opened) {
        throw new Error('unexpected call of ' + name + ' on a click')
      }
      return answered({})
    },
  })
  t.after(page.close)
  opened = true
  await page.click(page.document.querySelector('.dk-head > button'))
})

test('rejects after a click by hand', async t => {
  let opened = false
  const page = await openPage({
    answer: async name => {
      if (opened) {
        throw new Error('unexpected call of ' + name + ' after a click by hand')
      }
      return answered({})
    },
  })
  t.after(page.close)
  opened = true
  ;(page.document.querySelector('.dk-head > button') as HTMLElement).click()
  await new Promise(resolve => setTimeout(resolve, 20))
})
`

test('a test whose answer fails fails with that error, and node --test exits by itself', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'unexpected.test.ts')
  await writeFile(file, UNEXPECTED_TEST_FILE)
  // A run of its own, not a child of this one, in a single process, so that
  // the timeout ends all of it when the run hangs.
  const { NODE_TEST_CONTEXT, ...env } = process.env

  const run = await new Promise<{ error: any; stdout: string }>(resolve =>
    execFile(
      process.execPath,
      ['--test', '--test-isolation=none', '--test-reporter=tap', file],
      { env, timeout: 15_000 },
      (error, stdout) => resolve({ error, stdout }),
    ),
  )

  assert.equal(run.error?.killed, false, run.stdout)
  assert.equal(run.error.code, 1, run.stdout)
  assert.match(run.stdout, /^# fail 3$/m)
  assert.match(run.stdout, /unexpected call of deck_config as the page opens/)
  assert.match(run.stdout, /unexpected call of deck_config on a click/)
  assert.match(run.stdout, /unexpected call of deck_config after a click by hand/)
  assert.doesNotMatch(run.stdout, /unhandledRejection/)
})

test('an answer that comes late, and the calls it leads to, are waited for', async t => {
  const calls: string[] = []
  const page = await openPage({
    answer: async name => {
      calls.push(name)
      await new Promise(resolve => setTimeout(resolve, 50))
      return answered({})
    },
  })
  t.after(page.close)

  assert.deepEqual(calls, ['deck_config', 'deck_session', 'deck_configure'])
  calls.length = 0
  await page.click(page.document.querySelector('.dk-head > button'))
  assert.deepEqual(calls, ['deck_config', 'deck_session', 'deck_configure'])
})

test('an answer to a prefill that throws fails the next wait on the page with that error', { timeout: 5_000 }, async t => {
  const page = await openPage({
    answer: () => answered({}),
    answerMessage: () => {
      throw new Error('unexpected prefill 3k')
    },
  })
  t.after(page.close)

  await assert.rejects(page.click(page.document.querySelector('.dk-empty button')), /unexpected prefill 3k/)
})
