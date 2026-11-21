# 里程碑二探针 · Codex 的钩子和会话标识

里程碑二要在 Codex 桌面应用上登记 Occupancy、打心跳，这依赖几条只在源码里读到的事实（`openai/codex` 的 `rust-v0.171.0-alpha.13`）。这个探针在桌面端核对它们。2026-11-22 做了两轮，各项都有了结果，探针已移除。

## 要核对的事

| 观察项 | 源码里读到的 | 取证方法 | 本次结果 |
| --- | --- | --- | --- |
| 钩子是否运行 | 默认开启，app-server 驱动的 Session 也跑 | 装上钩子后发一条消息，看日志里有没有 `hook-command` 和 `call probe_hook` | 信任之后运行，命令钩子和调工具的钩子都跑。没信任时不跑 |
| 钩子的信任 | 非托管的钩子要用户信任一次，信任记在 `~/.codex/config.toml` 的 `hooks.state` | 没运行时记下桌面端有没有提示，以及怎么信任 | 桌面端没有任何提示，要在 Codex 的终端界面里信任，信任按钩子在文件里的位置和内容的哈希记录 |
| 钩子调工具带不带会话标识 | 钩子可以直接调 MCP 工具，参数里能填 `${session_id}` | 看 `call probe_hook` 那一行的参数和 `_meta` | 带。参数里的 `${session_id}`、`${cwd}`、`${prompt}` 都填上了，`_meta.threadId` 也有 |
| 页面调用带不带会话标识 | 宿主在 `_meta.threadId` 里附上 | 看 `call probe_page` 那一行的 `_meta` | 带。`_meta` 里有 `threadId` 和 `thread_id`，值相同 |
| agent 调用带不带会话标识 | `_meta` 里有 `threadId` 和 `sessionId` | 让 agent 调 `probe_agent`，看那一行的 `_meta` | 带。`_meta` 里有 `threadId`、`sessionId`，`x-codex-turn-metadata` 里还有 `turn_id` 和项目目录 |
| 服务的工作目录 | 配置里不写 `cwd` 时用 Session 的目录 | 看 `start cwd=` | Session 的那个进程是 Session 的目录。另有短命进程，见下 |
| 服务进程怎么结束 | Session 卸载时关闭它的 MCP 连接 | 切走一分钟再回来，再退出桌面应用，看日志里有没有 `stdin closed` 或 `signal`，以及 `SessionEnd` 钩子 | 收到 `SIGTERM`，应用退出时也是，随后 `SessionEnd` 钩子触发。切走一分钟没有卸载 |
| 输入框有草稿时预填 | 没有依据 | 先在输入框里打几个字，再点页面的预填，看是替换还是追加 | 追加在草稿后面，中间空一行 |

## 第一轮观察

2026-11-22 01:45（上海时间）重启桌面应用，01:46 在 matt-deck 下新建 Session（`01a1ff37-11a1…`）。结果读自 `probe-log.txt`、桌面日志和 Session 的记录文件。

- **钩子没有运行**：`SessionStart`、`UserPromptSubmit` 和 `Stop` 都该触发过，日志里没有命令钩子的记录，也没有 `probe_hook` 的调用。`~/.codex/config.toml` 里 `[features] hooks = true`，`[hooks.state]` 是空的，所以这些钩子处在未信任状态。未信任的钩子不运行，桌面日志里也没有相关的记录。
- **会话标识**：页面经宿主调用工具时，`_meta` 是 `{"thread_id": …, "threadId": …, "progressToken": …}`。agent 调用时 `_meta` 里有 `threadId`、`sessionId`、`callId`，以及 `x-codex-turn-metadata`（含 `turn_id`、`thread_id`、项目目录和它的远端地址）。三处的标识和 Session 的记录文件名一致。
- **服务进程**：这个 Session 的调用全部落在同一个进程上（`pid=48897`），它的工作目录是这个 Session 的项目目录。宿主另外起过十来个短命进程，工作目录有 `~/.codex`、`/` 和项目目录，几秒后被 `SIGTERM` 结束，它们没有收到过工具调用。服务不能在启动时做任何有后果的事。
- **进程的结束方式**：短命进程都是收到 `SIGTERM`，没有一个是标准输入关闭。用户切到别的 Session 一分钟再回来，`pid=48897` 一直活着。
- **预填**：输入框里已有「草稿」时预填，结果是「草稿」、一个空行、预填的文字，发出的消息也是这样。桌面应用的代码里这一步写的是追加。用户随后又预填过一次，发送前把那一段手动删了，所以发出的消息里只有第一段。

## 第二轮观察

02:07 用户在终端里运行 Codex，在启动时的钩子审查里信任了全部钩子，然后重启桌面应用，在原来的 Session 和一个新建的 Session（`01a1ff4b-223d…`）里各发了一条消息。

- **信任**：重启桌面应用时没有任何关于钩子的提示，未信任的钩子只是不运行。信任是在 Codex 的终端界面里做的，启动时出现 Hooks need review。信任之后 `~/.codex/config.toml` 的 `hooks.state` 里每个钩子多一条记录，键是文件路径、事件名和钩子在文件里的位置（如 `hooks.json:user_prompt_submit:0:1`），值是内容的哈希。钩子的内容或位置变了就要重新信任。
- **钩子运行**：两个 Session 都依次触发了 `SessionStart`、`UserPromptSubmit` 和 `Stop`，命令钩子和调工具的钩子都跑了。恢复的 Session 的 `SessionStart` 带 `source: resume`，在重启后的第一条消息时触发；新建的带 `source: startup`。
- **钩子调工具**：`probe_hook` 收到的参数里 `session_id`、`cwd` 和提示词原文都已填好，`_meta` 是 `{"threadId": …, "progressToken": …}`。调用落在这个 Session 自己的服务进程上。
- **命令钩子的输入**：有 `session_id`、`cwd`、`transcript_path`、`model`、`permission_mode`，和回合有关的事件另有 `turn_id`。`UserPromptSubmit` 带 `prompt`，`Stop` 带 `last_assistant_message`。
- **宿主自己的 Session 也触发钩子**：02:08:20 一个工作目录是 `~/.codex/memories` 的 Session 触发了 `SessionStart` 和 `UserPromptSubmit`，提示词有五万多字，不是用户发的。命令钩子跑了，调工具的钩子在日志里没有对应的调用。Deck 的钩子在未配置的项目里要立即返回，这类 Session 也包括在内。
- **应用退出**：02:07:25 退出桌面应用时，原 Session 的服务进程（`pid=48897`）收到 `SIGTERM`。这次退出没有记到 `SessionEnd` 钩子，那时桌面应用加载的还是信任之前的配置。02:13:34 信任之后再次退出，两个测试 Session 的服务进程先收到 `SIGTERM`，一秒后各自的 `SessionEnd` 钩子触发，`reason` 是 `other`。

## 复现实验

探针用用户全局注册，对同一 Codex 用户的所有项目可见。钩子加在 `~/.codex/hooks.json` 里，原有的钩子保留，安装前的文件另存为 `hooks.json.before-matt-deck-hook-probe`。探针装着的时候，所有项目的 Session 都会往日志里写一行事件。提示词和回答只在本仓库的 Session 里记原文，别的项目里只记长度。在仓库根目录运行：

```sh
codex mcp add matt_deck_hook_probe -- /usr/bin/python3 "$PWD/docs/research/probes/codex-hooks/server.py"
/usr/bin/python3 docs/research/probes/codex-hooks/hooks.py install
printf '/docs/research/probes/codex-hooks/probe-log.txt\n' >> .git/info/exclude
```

然后在终端里运行一次 `codex`，在启动时的钩子审查里信任探针的钩子，再重启桌面应用。日志写在本目录的 `probe-log.txt`，不进 git。

做完后移除：

```sh
codex mcp remove matt_deck_hook_probe
/usr/bin/python3 docs/research/probes/codex-hooks/hooks.py remove
```
