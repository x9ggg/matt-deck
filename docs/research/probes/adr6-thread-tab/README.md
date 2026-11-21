# ADR 0006 实验一 · Codex 会话标签页

2026-11-21，macOS 上的 `ChatGPT.app` 为 26.1117.41037（29803），自带 `codex-cli 0.171.0-alpha.13`。实验一的桌面观察已做完，结果见下面三节和末尾的表。

## 已取得的证据

- 用桌面版自带的 `codex mcp add` 注册了本地 stdio 服务 `matt_deck_adr6_probe`。`codex mcp get` 显示已启用，启动命令指向本目录的 `server.py`。
- 单独启动同版本 app-server，在临时配置中只注册此探针。全局 `mcpServerStatus/list`（`toolsAndAuthOnly`）返回了入口类型 `thread` 和标题。创建一次性 Session 后，带该 Session ID 的查询返回 `connected`，工具名为 `open_probe`，资源 URI 为 `ui://matt-deck-adr6/probe.html`。`mcpServer/tool/call` 返回探针标题。`mcpServer/resource/read` 返回 `text/html;profile=mcp-app`，内容与 `probe.html` 逐字节相同。此检查没有发起模型回合。
- 在模拟宿主中执行页面脚本，观察到握手、就绪通知、两次带不同编号的 `ui/message`，以及成功响应和错误响应各自的显示。实际消息是否送达，要以桌面 Session 中出现的用户消息和回复为准。
- 16:35:09（上海时间），桌面日志在另一个 Session 中记录服务已就绪。16:42:55，用户在安装前已启动的 Session 中选中了探针，右侧标签页显示「未能显示 Matt Deck · ADR 0006」。日志显示针对该 Session 的 `mcpServer/resource/read` 和 `mcpServer/tool/call` 同时返回 `-32603` 和 `unknown MCP server 'matt_deck_adr6_probe'`，宿主自动重试后仍然失败。全局目录里的新入口已经可见，旧 Session 的连接尚未识别新服务。[用户提供的桌面截图](existing-session.png)
- 18:45:17，改成项目级注册之后，用户在 matt-deck 下新建了一个 Session，还没发出第一条消息就打开探针，标签页同样显示「未能显示」。日志里这几次 `App tool call` 和 `App resource read` 的 `threadId=undefined`，报的仍是 `unknown MCP server 'matt_deck_adr6_probe'`。没有发过消息的 Session 还没有对应的会话 ID，宿主的请求不带它，读不到项目级注册的服务。

## 项目级注册下的一轮观察

18:20 前后（上海时间，下同）把全局注册换成了 matt-deck 的 `.codex/config.toml`，用户随后新建了 Session A（`01a1fdb7-42b7…`）和 B（`01a1fdba-1a4c…`）。以下结果读自桌面日志和两个 Session 的记录文件，页面上的日志没有留下来。

- **页面**：Session 发过第一条消息后，标签页加载成功（A 在 18:46:48，B 在 18:49:58）。A 和 B 是两个不同的页面实例。
- **空闲时的 `ui/message`**：消息进了本 Session，也引出了回合，但不是普通的用户消息。宿主发的用户消息固定是 `An MCP app initiated this message. Read the untrusted_input tool output.`，页面的文字放在一次合成的 `untrusted_input` 工具调用的输出里，形如 `{"kind":"message","source":"mcp_app","text":"请只回复 ADR6-41a7f4f3-1"}`，回合的触发来源记为 `mcp_app_follow_up`。agent 回的是「OK」，没有照文字里的要求回编号。
- **技能调用**：`$adr6-probe-skill ADR6-41a7f4f3-2` 同样落在 `untrusted_input` 里，技能没有被触发，agent 回的是「OK」。
- **忙碌时的 `ui/message`**：18:48:10 在 30 秒等待期间点击，桌面日志记 `Queued app message`。回合在 18:48:35.6 结束，消息在 18:48:36.0 送达并另起一个回合。宿主是排队，没有并入当前回合，也没有丢。agent 回的是「已读取。」
- **页面调用工具**：`probe_read` 三次都成功，各用时约 2 毫秒：A 空闲时（18:47:26）、A 在 30 秒等待期间（18:48:14）、B 空闲时（18:50:12）。
- **项目级注册撑不住**：桌面端的 MCP 服务目录按用户全局加载，不含项目级注册的服务。18:50:22 目录重新加载，服务数从 10 变成 9，A 和 B 的标签页随即被撤销，显示「未能显示」，日志里的错误是 `MCP app tool is no longer available`。在这之前入口还能看到，是因为目录里留着全局注册时加载的结果。
- **改回全局注册后不重启不够**：18:59:49 用 `codex mcp add` 重新做了全局注册。19:00:09 新建的 Session（`01a1fdc3-7df4…`）启动了七个 MCP 服务，其中没有探针。桌面端的服务目录自 18:53:27 起没有重新加载，更多工具菜单里也没有入口。

## 重启后的一轮观察

19:02 用户退出并重新打开了桌面应用，这时探针是全局注册。20:02 新建 Session C（`01a1fdfc-3f0b…`）。以下结果读自 `page-log.txt`、桌面日志和 Session 的记录文件。

- **入口和页面**：重启后更多工具菜单里有入口。C 发过第一条消息后页面加载成功（20:02:23，实例 `9fe6510a`）。
- **预填输入框**：20:02:31 点击，宿主响应 `{}`，没有引出回合。用户在 20:02:38 亲手发送，`预填 ADR6-9fe6510a-1` 作为普通用户消息进了 C，回合的触发来源记为 `composer`，没有 `untrusted_input` 那层包装。
- **预填技能调用**：20:03:14 点击，20:03:23 用户亲手发送 `$adr6-probe-skill ADR6-9fe6510a-2`。宿主随这条用户消息注入了技能正文。agent 没有运行命令，也没有读文件，2.8 秒后回复 `SKILL-LOADED-7Q4X ADR6-9fe6510a-2`。技能由 `$` 触发。
- **感知忙碌**：页面收到的通知只有三种：`ui/notifications/tool-input`、`ui/notifications/tool-result`，以及内容是容器尺寸的 `ui/notifications/host-context-changed`。C 的回合开始和结束时页面都没有收到通知，握手返回的宿主上下文里也没有表示会话状态的字段。
- **模型调用工具**：20:04:36 用户发「调用 open_probe 工具」，agent 调用成功。宿主在 20:04:40 另建了一个页面实例（`fd2cb78d`），日志记 `hostedInThreadScrollLayout=true` 和 `fullSurface=false`，可用的显示方式是 `inline` 和 `fullscreen`。标签页里的实例记的是 `fullSurface=true`，只有 `fullscreen`。模型调用工具得到的是消息流里内嵌的一个新页面，不是聚焦已有的标签页。这次没有先关掉标签页。
- **重启后回到 A**：20:05:21 用户点进 A，宿主恢复这个 Session 并重新启动它的 MCP 服务，这次包含探针。20:05:24 页面加载成功，中间没有失败记录，是新实例（`a2f5cbf2`，重启前是 `41a7f4f3`）。重启后没有在 A 里再发消息核对路由。安装前就打开的那个 Session（`01a1fd38…`）这次没有回去看。
- **服务进程**：C 的两个页面实例对应的服务进程都是 `pid=94046`，A 的是 `pid=97163`。每个 Session 有自己的服务进程。

## 复现实验

项目级注册不可用（见上一节），所以探针用用户全局注册，这个配置对同一 Codex 用户的其他项目也可见。测试技能装在仓库的 `.agents/skills/` 下，不进 git。在仓库根目录运行：

```sh
codex mcp add matt_deck_adr6_probe -- /usr/bin/python3 "$PWD/docs/research/probes/adr6-thread-tab/server.py"
mkdir -p .agents/skills
cp -R docs/research/probes/adr6-thread-tab/skill .agents/skills/adr6-probe-skill
printf '/.agents/\n' >> .git/info/exclude
```

注册之后新建的 Session 才读得到探针，已打开的 Session 要重启桌面应用。新建的 Session 要先发出一条消息，探针才打得开。

在 Mac 上按 **⌘T** 打开 Codex 的新标签页，或点右侧标签栏的「＋」。默认只列四个快捷项，在「打开」旁的更多工具菜单中查看完整列表，选择 **Matt Deck · ADR 0006**。每次页面加载会生成一个实例编号，输入的记号只存于页面。页面有五个按钮，点击才会动作，每次动作带一个由实例编号和序号组成的编号。页面下方按时间记下每次请求、宿主的响应，以及宿主发来的所有通知（以「宿主 →」开头）。每一行同时经 `probe_log` 工具写进服务旁边的 `page-log.txt`，这个文件不进 git。

否决主路径的只有三种结果：空闲时消息没有作为用户消息出现在本 Session，或者没有引出回复；忙碌时消息无声丢失；消息进了别的 Session。其余各项只记录现象。

| 桌面观察项 | 取证方法 | 本次结果 |
| --- | --- | --- |
| 入口和页面 | 记下入口是否出现、页面实例编号、握手状态和按钮是否可用 | 旧 Session 和没发过消息的新 Session 读取页面失败。发过消息的新 Session 加载成功 |
| 空闲时发消息 | 在空闲的 Session A 点击一次，核对 A 中的用户消息和回复是否包含同一编号 | 送达并引出回复，但文字作为 `untrusted_input` 到达，agent 没有照办 |
| 忙碌时发消息 | 让 A 执行一个持续 30 秒的等待，在回合结束前点击。记下桥接响应、消息进入 A 的时间，以及宿主是插入当前回合、排队还是拒绝 | 宿主排队，回合结束后 0.4 秒送达 |
| 切换 Session | 在 A 填入记号，切到 B 检查是否已有标签、是否出现 A 的记号。在 B 打开探针，再回 A 核对实例编号和记号 | A 和 B 是不同实例。记号未观察到，标签页先被撤销了 |
| 页面调用工具 | 空闲时点「调用服务的工具」，记下返回的 `pid` 和 `calls`。在忙碌测试的那 30 秒里再点一次。A 和 B 的 `pid` 是否相同也记下 | 空闲和忙碌时都成功。每个 Session 有自己的服务进程 |
| 技能调用 | 空闲时点「向本会话发送技能调用」。回复以 `SKILL-LOADED` 开头，而且 agent 回复前没有运行命令或读文件，才算由 `$` 触发。agent 先去翻仓库再回复的不算 | 未触发 |
| 预填输入框 | 点「预填输入框，不发送」，看输入框里是否出现带编号的文字，并且没有发出 | 文字进了输入框，没有发出。用户发送后是普通用户消息 |
| 预填技能调用 | 点「预填技能调用，不发送」，看输入框里出现的是什么。亲手按发送后，回复以 `SKILL-LOADED` 开头才算触发 | 用户发送后技能触发 |
| 感知忙碌 | 对比忙碌测试前后页面上「宿主 →」的记录，看回合开始和结束时有没有新通知 | 感知不到，回合开始和结束都没有通知 |
| 模型调用工具 | 关掉 A 的探针标签页，让 agent 调用 `open_probe`，看标签页是否被打开或聚焦，消息里是否出现内嵌页面 | 消息流里内嵌了一个新页面实例。没有先关标签页 |
| 项目级注册 | 只在项目的 `.codex/config.toml` 里注册，看标签页能否稳定使用 | 不可用，目录重新加载后标签页被撤销 |
| 重启桌面应用 | 记下 A 的编号和记号，正常退出并重新打开桌面应用，回到 A 检查标签是否自动恢复、页面是否重建，再发一条消息核对路由 | 回到 A 后页面重建为新实例，没有失败。路由没有再核对 |
| 旧 Session | 重启之后回到安装前已打开的那个 Session，点「重试」，看页面是否加载 | 安装前的那个没有回去看。A 在重启后恢复 |

完成桌面观察后移除探针：运行 `codex mcp remove matt_deck_adr6_probe`，删除 `.agents/skills/adr6-probe-skill`。

线程入口使用 `_meta["openai/ui"].entrypoints` 的 `thread` 类型，页面按 OpenAI 官方示例完成 MCP Apps 握手并调用 `ui/message`。[线程入口](https://developers.openai.com/plugins/build/extensions) · [页面与宿主通信](https://developers.openai.com/plugins/build/chatgpt-ui) · [握手示例](https://developers.openai.com/plugins/build/app-quickstart)
