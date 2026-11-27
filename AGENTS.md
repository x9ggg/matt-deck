## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`, also for how a finished Task is committed, pushed and closed.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Running Deck by hand

Every manual run of the Deck service, `plugin/cli/end-session.ts`, the command line or the Codex install and uninstall gets a throwaway home: `HOME=$(mktemp -d) node …`. The real `~/.matt-deck`, `~/.codex` and `~/.agents` hold the person's live sessions. `npm test` already gives each Deck service its own. Stop only the processes you started, by their pid: never `pkill` by a pattern that also matches another worktree's (for example `pkill -f "server/main.ts"`), since other sessions' tests are running Deck services on the same command line.
