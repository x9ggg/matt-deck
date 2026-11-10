// What `deck_config` on the Deck service answers. Mirrors the kernel's
// ProjectConfigResult; the Mod runs apart from the kernel and cannot import it.
export type SkillSource = { type: 'directory'; path: string } | { type: 'plugin'; name: string }

export type ProjectConfig = {
  taskSource: { type: 'github-issues' }
  skillSource: SkillSource
}

// What `deck_config` answers when it succeeds.
export type DeckConfigAnswer =
  | { configured: false; workspace: string }
  | { configured: true; workspace: string; config: ProjectConfig }

// What the Mod knows of the project config: still asking, the service's
// answer, or why it could not be read.
export type ConfigView =
  | { status: 'loading' }
  | { status: 'unconfigured'; workspace: string }
  | { status: 'configured'; workspace: string; config: ProjectConfig }
  | { status: 'error'; message: string }

export type View = {
  sessionId: string
  config: ConfigView
}

declare module 'claude-code' {
  interface PluginState {
    'matt-deck': { view: Shaped<View> }
  }
}
