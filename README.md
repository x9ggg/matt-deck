# Matt Deck

用 Matt skills 推进项目时，放在 Claude Code 对话旁边的任务 Pane。

## 安装

```sh
claude plugin install matt-deck --marketplace x9ggg/matt-deck
```

这一行把本仓库加为插件源（marketplace 名为 `matt-deck`），再从中装上 Deck。装完重启 Claude Code 即可，不需要 `npm install` 或构建。

已经在 Claude Code 里的话，也可以分两步：

```
/plugin marketplace add x9ggg/matt-deck
/plugin install matt-deck@matt-deck
```

### 前置条件

- Node 22.18 或更高（23.x 需 23.6 或更高）。Deck 服务直接用 Node 运行 TypeScript 源码。
- `gh` 已安装并已登录（`gh auth status`）。Deck 通过它读写 GitHub Issues。
- 本机能访问 GitHub，`claude plugin` 从这里拉取插件源。

## 首次配置一个项目

Pane 只在 Configured Project 里出现，也就是仓库根目录有 `.matt-deck/config.json` 的项目。在项目里打开 Claude Code，运行：

```
/matt-deck:configure
```

配置技能会从仓库的 `docs/agents/issue-tracker.md` 预填 Task Source，在本机找出 Matt skills 供你选作 Skill Source，然后写出 `.matt-deck/config.json`。把它提交进仓库，配置就随仓库走。

最后它会问你，要不要在本项目的 `.claude/settings.local.json` 里加一条权限规则 `mcp__plugin_matt-deck_deck`，允许 Deck 服务的工具不再逐次询问。Pane 的每次读取都是对这些工具的调用；没有这条规则时，Session 里等人批准的权限钩子（例如 cmux 注入的）会让 Pane 每次读取都等上一两分钟。

之后新开一个 Session，Pane 会自动出现。

## 命令行排查

不打开 Claude Code，也可以在要排查的项目目录或其子目录运行：

```sh
node /path/to/matt-deck/plugin/cli/main.ts
```

把路径换成本仓库检出的实际位置。已安装的插件也包含 `cli/main.ts`，可直接用 Node 运行，无需安装依赖或构建；Node 和 `gh` 的前置条件同上。

命令输出格式化 JSON，包含：

- `workspace`、`configured`、`config`：识别到的 Workspace 和项目配置。
- `stateFile`：Deck 实际使用的本机 SQLite 文件绝对路径。尚未产生状态时文件可能不存在，检查不会创建它。
- `tasks.groups`：`ready`（可执行）、`inProgress`（进行中）、`blocked`（阻塞）、`done`（已完成）；Spec 和 Map 位于 `tasks.containers`，各自带有 `group`。
- `occupancies`：当前打开的 Task 的占用，包含 `task`、完整 `session` 和 `isOrphaned`，也包含 Spec 和 Map 的占用。

每次运行直接读取 Task Source，分组及 Orphaned 规则与 Pane 共用。检查只读，不登记 Session、更新心跳、释放 Occupancy 或迁移本机状态；已关闭 Task 的残留占用不展示，也不清理。旧版状态库尚未建立的表按空数据读取。

未配置时输出 `not-configured` 说明；Task Source 读取失败时，`failure` 的 `kind` 和 `message` 就是 Pane 收到的那一份原因，Pane 再把 `kind` 换成中文提示显示；配置和状态路径仍可查看。配置损坏或本机文件无法读取时，错误输出到 stderr。退出码为 `0`（成功）、`1`（未配置或读取失败）、`2`（参数错误）；`--help` 显示用法。
