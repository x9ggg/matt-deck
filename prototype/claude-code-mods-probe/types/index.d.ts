export type Recommendation = {
  task: string
  nextStep: string
  skill: string
  reason: string
  blockers: string
}

// none: nothing asked. held: pressed while busy, kept by the pane.
// sent: handed to the engine. running: its turn started.
export type RequestStatus =
  | 'none'
  | 'held'
  | 'sent'
  | 'running'
  | 'answered'
  | 'cancelled'

export type View = {
  sessionId: string
  cwd: string
  hasAskMatt: boolean
  isBusy: boolean
  request: RequestStatus
  requestTurnId: string | null
  recommendation: Recommendation | null
  rawAnswer: string | null
  startedAt: number
  log: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'matt-deck-probe': { view: Shaped<View> }
  }
}
