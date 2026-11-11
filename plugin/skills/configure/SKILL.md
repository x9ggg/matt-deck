---
name: configure
description: 首次配置 Matt Deck：为当前项目选定 Task Source 和 Skill Source，写入 `.matt-deck/config.json`，使其成为 Configured Project。
disable-model-invocation: true
---

# 配置 Matt Deck

为当前项目写出 Deck 的项目配置。之后新开的 Session 里 Pane 会自动出现。

所有读写都经 Deck 服务（MCP 服务 `deck`）的两个工具完成：`deck_setup_survey` 摸底，`deck_write_config` 写出配置文件。一次只问一个问题，把推荐答案放在最前面。

## 1. 摸底

调用 `deck_setup_survey`。它返回：

- `existing`：现有配置。`{ configured: false }`；`{ configured: true, config }`；或配置文件存在但格式不对时的 `{ configured: true, problem }`。
- `taskSource`：从仓库的 Matt issue tracker 文档预填的 Task Source，没有文档时为 `null`。`tracker` 是文档标题里写的任务来源，标题里读不出时为 `null`。`type` 是它对应的 Task Source 类型，没有可预填的类型时为 `null`。
- `skillSources`：本机找到的 Matt skills，每份一项，可直接放进配置。

Deck 服务连不上时，告诉用户原因并停止。

## 2. 已有配置

`existing.configured` 为 `true` 时，把现有配置（或 `problem`）原样展示给用户，问是否修改。用户不改就停止。用户要改就继续，写入时带 `replace: true`：

- Task Source 照第 3 步重新判定，以这次摸底的结果为准。
- Skill Source 在第 4 步把 `existing.config.skillSource` 作为推荐项。`existing` 只有 `problem` 时没有现有值，第 4 步只用 `skillSources`。

## 3. Task Source

本里程碑只有 GitHub Issues 一种（`{ "type": "github-issues" }`）。

- `taskSource.type` 为 `github-issues`：直接采用，告诉用户这是从 `taskSource.doc` 预填的，不再问。
- `taskSource.tracker` 有值而 `taskSource.type` 为 `null`：告诉用户文档里配置的是 `taskSource.tracker`，本里程碑只支持 GitHub Issues，然后停止，不写配置。
- `taskSource.tracker` 为 `null`：文档 `taskSource.doc` 存在，但从标题里读不出它配置的任务来源。把这一点告诉用户，问这个项目的任务是否在 GitHub Issues 里。是就采用；不是就说明本里程碑只支持 GitHub Issues，然后停止，不写配置。
- `taskSource` 为 `null`：仓库里没有 Matt 的 issue tracker 文档。提议 GitHub Issues 并请用户确认；`git remote -v` 不指向 GitHub 时一并说明。用户不接受就停止。

## 4. Skill Source

Skill Source 选定后固定，Deck 展示和 agent 执行都用这一份。

候选是 `skillSources`。修改已有配置时，把现有的 `skillSource` 排在候选最前；它不在 `skillSources` 里时也加进候选，并说明本机这次没找到它。

- 候选只有一项：提议它，请用户确认。
- 有多项：全部列出，请用户选一份。
- 为空：告诉用户本机没找到 Matt skills（含 `ask-matt` 技能的位置），请用户给出一个技能目录；确认 `<目录>/ask-matt/SKILL.md` 存在后，记为 `{ "type": "directory", "path": "<目录>" }`，用户目录下的路径写成 `~/...`。用户给不出就停止。

## 5. 写入

调用 `deck_write_config`，参数为 `{ "config": { "taskSource": ..., "skillSource": ... } }`，第 2 步用户同意修改时加 `"replace": true`。工具报错时把原文告诉用户并停止。

写入成功后告诉用户：配置在 `.matt-deck/config.json`，提交进仓库后随仓库走；新开一个 Session，Pane 会自动出现。
