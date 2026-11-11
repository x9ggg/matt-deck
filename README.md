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

之后新开一个 Session，Pane 会自动出现。
