---
name: configure
description: 首次配置 Matt Deck：为当前项目选定 Task Source 和 Skill Source，写入 `.matt-deck/config.json`，使其成为 Configured Project。
disable-model-invocation: true
---

# 配置 Matt Deck

为当前项目写出 Deck 的项目配置。Claude Code 和 Codex 读的是同一份，在哪个宿主里配置都一样。本技能在 Claude Code 里是 `/matt-deck:configure`，在 Codex 里是 `$matt-deck-configure`。

所有读写都经 Deck 服务（Claude Code 里是 MCP 服务 `deck`，Codex 里是 `matt_deck`）的工具完成：`deck_setup_survey` 摸底，`deck_write_config` 写出配置文件；以 Claude Code 为宿主时还有 `deck_allow_service`，写入允许 Deck 服务的权限规则。一次只问一个问题，把推荐答案放在最前面。

## 1. 摸底

调用 `deck_setup_survey`。它返回：

- `host`：Deck 服务所在的宿主，`claude-code` 或 `codex`。
- `existing`：现有配置。`{ configured: false }`；`{ configured: true, config }`；或配置文件存在但格式不对时的 `{ configured: true, problem }`。
- `taskSource`：从仓库的 Matt issue tracker 文档预填的 Task Source，没有文档时为 `null`。`tracker` 是文档标题里写的任务来源，标题里读不出时为 `null`。`type` 是它对应的 Task Source 类型，没有可预填的类型时为 `null`。
- `skillSources`：本机找到的 Matt skills，每份一项，去掉 `hostCallsAskMatt` 后可直接放进配置。`host` 为 `codex` 时还包括 Codex 自己的技能目录：用户目录下的 `~/.codex/skills`，和项目里的 `.agents/skills`、`.codex/skills`，项目里这两项的路径相对项目根目录写，随仓库走。`host` 为 `codex` 时每项还有 `hostCallsAskMatt`：Codex 用 `$ask-matt` 调到的是不是这份里的 `ask-matt`；调得到的排在前面，其余照找到的先后。
- `isServiceAllowed`：只在 `host` 为 `claude-code` 时有。本项目的 `.claude/settings.local.json` 里是否已有允许 Deck 服务工具的权限规则。

Deck 服务连不上时，告诉用户原因并停止。

## 2. 已有配置

`existing.configured` 为 `true` 时，把现有配置（或 `problem`）原样展示给用户，问是否修改。用户不改：`existing` 有 `config` 时跳到第 6 步；只有 `problem` 时停止，配置读不出来，Pane 用不了。用户要改就继续，写入时带 `replace: true`：

- Task Source 照第 3 步重新判定，以这次摸底的结果为准。
- Skill Source 在第 4 步把 `existing.config.skillSource` 作为推荐项。`existing` 只有 `problem` 时没有现有值，第 4 步只用 `skillSources`。

## 3. Task Source

本里程碑只有 GitHub Issues 一种（`{ "type": "github-issues" }`）。

- `taskSource.type` 为 `github-issues`：直接采用，告诉用户这是从 `taskSource.doc` 预填的，不再问。
- `taskSource.tracker` 有值而 `taskSource.type` 为 `null`：告诉用户文档里配置的是 `taskSource.tracker`，本里程碑只支持 GitHub Issues，然后停止，不写配置。
- `taskSource.tracker` 为 `null`：文档 `taskSource.doc` 存在，但从标题里读不出它配置的任务来源。把这一点告诉用户，问这个项目的任务是否在 GitHub Issues 里。是就采用；不是就说明本里程碑只支持 GitHub Issues，然后停止，不写配置。
- `taskSource` 为 `null`：仓库里没有 Matt 的 issue tracker 文档。提议 GitHub Issues 并请用户确认；`git remote -v` 不指向 GitHub 时一并说明。用户不接受就停止。

## 4. Skill Source

Skill Source 选定后，Deck 展示和 agent 执行都用这一份；要改就重跑配置。

候选是 `skillSources`。修改已有配置时，把现有的 `skillSource` 排在候选最前；它不在 `skillSources` 里时也加进候选，并说明本机这次没找到它。

- 候选只有一项：提议它，请用户确认。
- 有多项：全部列出，请用户选一份。
- `host` 为 `codex` 时：第一项是推荐项。每项都标出 Codex 调不调得到它的 `ask-matt`（`hostCallsAskMatt`）。调不到的照列，并告诉用户：选了它，Codex 的 Pane 里技能不能预填，“我现在该做什么”和“执行”也用不了。修改已有配置时，现有的 `skillSource` 照旧排在最前，同样标出调不调得到：它在 `skillSources` 里时看那一项；不在时，按调不到说明。
- 为空：告诉用户本机没找到 Matt skills（含 `ask-matt` 技能的位置），请用户给出一个技能目录；确认 `<目录>/ask-matt/SKILL.md` 存在后，记为 `{ "type": "directory", "path": "<目录>" }`，用户目录下的路径写成 `~/...`。用户给不出就停止。

## 5. 写入

调用 `deck_write_config`，参数为 `{ "config": { "taskSource": ..., "skillSource": ... } }`，`skillSource` 只带 `type` 和 `path` 或 `name`，不带 `hostCallsAskMatt`；第 2 步用户同意修改时加 `"replace": true`。工具报错时把原文告诉用户并停止。

写入成功后告诉用户：配置在 `.matt-deck/config.json`，提交进仓库后随仓库走。

## 6. 权限规则

`host` 为 `codex` 时跳过这一步，直接到最后一句：权限规则只对 Claude Code 有意义，Codex 下也没有 `deck_allow_service`。

Pane 的每次读取都是对 Deck 服务工具的一次调用。项目里没有允许这些工具的权限规则时，每次调用都要先经过 Session 的权限钩子；钩子等人批准的环境里（例如 cmux），Pane 会迟迟不出现，每次刷新都要等。

`isServiceAllowed` 为 `true`：规则已经在，不用问。

否则把下面三点告诉用户，问是否写入：

- 写入的位置是本项目的 `.claude/settings.local.json`，只在本机生效，不随仓库走。
- 写入的规则是 `mcp__plugin_matt-deck_deck`，文件里已有的内容保留。
- 之后本项目里 Deck 服务的所有工具都不再逐次询问，agent 调用时也一样。

用户同意就调用 `deck_allow_service`；工具报错时把原文告诉用户。用户不同意就不写，并说明：Pane 读取迟迟不返回时，可以再运行一次本技能补上。

最后告诉用户怎么看到 Pane：`host` 为 `claude-code` 时，新开一个 Session，Pane 会自动出现；`host` 为 `codex` 时，在 Pane 上点“刷新”，或从 Session 的标签页菜单打开 Matt Deck。
