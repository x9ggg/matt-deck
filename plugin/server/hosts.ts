// The hosts a Deck service runs for, and what each writes its own way: how a
// skill is called, and how a Session's id is cut short. The kernel knows
// neither; the Deck service, and the command line printing the same reads,
// hand it these rules.
import type { CallOf } from '../kernel/skills.ts'

const HOST_NAMES = ['claude-code', 'codex'] as const

export type Host = (typeof HOST_NAMES)[number]

const HOSTS: Record<Host, { callOf: CallOf; short: (session: string) => string }> = {
  'claude-code': {
    callOf: (name, plugin) => (plugin === undefined ? `/${name}` : `/${plugin}:${name}`),
    // A Claude Code Session's id is random from its first character.
    short: session => session.slice(0, 8),
  },
  codex: {
    callOf: name => `$${name}`,
    // A Codex Session's id begins with the time it was started: two started
    // a moment apart share their first characters.
    short: session => session.slice(-8),
  },
}

// The host a value names, if it names one: a launch argument, or a host the
// local state recorded.
export const hostNamed = (value: string | null | undefined) => HOST_NAMES.find(host => host === value)

export const callOf = (host: Host) => HOSTS[host].callOf

// A Session as an answer names it, from the host its heartbeat recorded: a
// Session recorded before hosts were, or never recorded, is Claude Code's.
export const nameSession = (session: string, recorded: string | null) => {
  const host = hostNamed(recorded) ?? 'claude-code'

  return { host, short: HOSTS[host].short(session) }
}
