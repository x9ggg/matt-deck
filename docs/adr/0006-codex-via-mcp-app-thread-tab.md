---
status: proposed
---

# Codex 侧以 MCP App 线程标签页为主路径

在 Codex 桌面应用（`ChatGPT.app`）里，面板计划做成 MCP App 的线程标签页：每个线程一个实例，界面可以用 `ui/message` 向当前会话发消息。退路是独立窗口加 `codex queue`，由用户显式选择目标会话。两条路径目前都只有文档和源码依据，没有实测，所以首个里程碑只做 Claude Code，这条决策在实验完成之前保持 proposed。

## Considered Options

- **外部进程直接连 app-server 控制桌面端的会话**：不可行。桌面应用使用私有的 app-server，不连共享 daemon；通知只发给连在同一个 server 上并订阅了该线程的客户端；协议里也没有“当前聚焦的线程”。
- **内置浏览器加 WebMCP**：不够用。页面只能向 agent 提供工具，不能主动让聊天发出消息。

## Consequences

- 转为 accepted 之前需要两个实验。其一，在线程里装一个最小的 MCP App，验证界面能出现、`ui/message` 可用、会话忙碌时的行为，以及切换线程和重启之后的状态。其二，向一个一次性线程执行 `codex queue`，验证消息在约 10 秒内出现并运行。
- Codex 上面板读不到回答文本，`deck_recommend` 是唯一的结果回传通道（见 ADR-0003）。
- 以上事实调研于 2026-11-11：本机 `codex-cli` 为 0.165.0，桌面应用自带 0.167.0-alpha；源码依据来自 `openai/codex` 的 main 分支，与桌面应用自带的版本可能有出入。
