// A stand-in for the clock, loaded into the Deck service by the tests with
// `--import`. Where FAKE_CLOCK_FILE is set, `Date.now()` answers the time
// that file holds at that moment, in milliseconds since the epoch, so a test
// moves every Deck service's clock at once by writing it. Elsewhere the clock
// is the real one.
import { readFileSync } from 'node:fs'

const file = process.env.FAKE_CLOCK_FILE
if (file !== undefined) {
  Date.now = () => Number(readFileSync(file, 'utf8'))
}
