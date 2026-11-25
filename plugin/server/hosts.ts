// The hosts a Deck service runs for, and what each writes its own way: how a
// skill is called, and how a Session's id is cut short. The kernel knows
// neither; the Deck service, and the command line printing the same reads,
// hand it these rules.
import type { CallOf } from '../kernel/skills.ts'

const HOST_NAMES = ['claude-code', 'codex'] as const

export type Host = (typeof HOST_NAMES)[number]

// `skillDirectories` are where the host finds skills itself, written as a
// Skill Source's path is: `~/...` under the home, or relative to the
// Workspace. First configuration offers the copies of Matt skills there.
const HOSTS: Record<Host, { callOf: CallOf; short: (session: string) => string; skillDirectories: string[] }> = {
  'claude-code': {
    callOf: (name, plugin) => (plugin === undefined ? `/${name}` : `/${plugin}:${name}`),
    // A Claude Code Session's id is random from its first character.
    short: session => session.slice(0, 8),
    skillDirectories: [],
  },
  codex: {
    callOf: name => `$${name}`,
    // A Codex Session's id begins with the time it was started: two started
    // a moment apart share their first characters.
    short: session => session.slice(-8),
    skillDirectories: ['~/.agents/skills', '.agents/skills', '.codex/skills'],
  },
}

// The host a value names, if it names one: a launch argument, or a host the
// local state recorded.
export const hostNamed = (value: string | null | undefined) => HOST_NAMES.find(host => host === value)

export const callOf = (host: Host) => HOSTS[host].callOf

export const skillDirectories = (host: Host) => HOSTS[host].skillDirectories

// The configure skill as Codex names it: install generates a skill of this
// name in the user's own Codex skills, pointing at the plugin's. The plugin's
// is named `configure`, which in a user-wide directory meets other skills of
// that name, and renaming it would rename `/matt-deck:configure`.
export const CODEX_CONFIGURE_SKILL = 'matt-deck-configure'

// The tool Deck's Codex hook on UserPromptSubmit calls with the prompt sent.
// Codex trusts a hook by the hash of what it says, so install writes it the
// same, and this name stays.
export const CODEX_HOOK_TOOL = 'deck_prompt_submitted'

// A Session as an answer names it, from the host its heartbeat recorded: a
// Session recorded before hosts were, or never recorded, is Claude Code's.
export const nameSession = (session: string, recorded: string | null) => {
  const host = hostNamed(recorded) ?? 'claude-code'

  return { host, short: HOSTS[host].short(session) }
}
