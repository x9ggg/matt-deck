// A stand-in for the clock, loaded into the Deck service by the tests with
// `--import`. Where FAKE_CLOCK_FILE is set, `Date.now()` answers the time
// that file holds at that moment, in milliseconds since the epoch, so a test
// moves every Deck service's clock at once by writing it. An interval runs
// on that time too: every few real milliseconds it reads the time, and once
// that has reached its next turn it fires, its next turn set an interval
// past the time read. Elsewhere the clock is the real one.
import { readFileSync } from 'node:fs'

const file = process.env.FAKE_CLOCK_FILE
if (file !== undefined) {
  Date.now = () => Number(readFileSync(file, 'utf8'))
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    let due = Date.now() + ms
    return realSetInterval(() => {
      const now = Date.now()
      if (now >= due) {
        due = now + ms
        callback()
      }
    }, 5)
  }) as typeof setInterval
}
