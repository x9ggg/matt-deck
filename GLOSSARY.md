# Matt Deck

Matt Deck 是放在 agent 对话旁边的任务面板：它展示一个项目里按 Matt skills 工作流产生的任务，并把“下一步做什么”和“开始做这个任务”送进对话。

## Language

### 宿主与会话

**Deck**:
这个产品本身：一个项目的任务视图，加上向会话发出请求的能力。
_Avoid_: 插件、工作台、看板

**Host（宿主）**:
承载 Deck 的 agent 应用，例如 Claude Code 或 Codex 桌面应用。
_Avoid_: agent、客户端、平台

**Session（会话）**:
宿主里的一段对话。Codex 称之为 thread，在 Deck 的语言里统一叫 Session。
_Avoid_: 聊天、线程、thread

**Pane（面板）**:
Deck 在宿主窗口内的可见界面，属于且只属于一个 Session。
_Avoid_: 侧边栏、侧栏、sidebar、panel

**Standalone Window（独立窗口）**:
宿主没有内嵌位置时 Deck 的界面形态。它不属于任何 Session，由用户显式选择 Target Session。
_Avoid_: 浮窗、外置面板

**Target Session（目标会话）**:
一次请求要送达的 Session。请求一旦发出，目标不再改变。
_Avoid_: 绑定会话、当前会话

**Configured Project（已配置项目）**:
完成了 Deck 首次配置、选定了 Task Source 和 Skill Source 的项目。Pane 只在这类项目里出现。

**Skill Source（技能来源）**:
一个项目使用的那一份 Matt skills 所在的位置，首次配置时选定，之后固定。

**Workspace（工作区）**:
一个项目在本机的一份检出目录。同一个项目可以有多个 Workspace，它们共用同一个 Task Source。
_Avoid_: 工作副本、工作树、工作目录（Session 启动时所在的目录，可以是 Workspace 里的子目录）

### 任务

**Task Source（任务来源）**:
一个项目里任务的唯一权威存放处，是 GitHub Issues 或本地 Markdown 之一。
_Avoid_: 后端、tracker、任务库

**Task（任务）**:
Task Source 里的一项工作。Matt skills 称之为 ticket 或 issue。
_Avoid_: 工单、票、ticket、issue

**Spec（规格）**:
描述一项多会话构建的 Task，其下挂着拆出来的 Child Task。
_Avoid_: 规格容器、需求、PRD

**Map（地图）**:
`/wayfinder` 为一项尚不清晰的大工作建立的 Task。它的 Child Task 是待解决的决策，产出是决定而不是交付物。
_Avoid_: 探索地图、路线图

**Child Task（子任务）**:
挂在一个 Spec 或 Map 之下的 Task。
_Avoid_: 子票、子 issue

**Blocking Edge（阻塞关系）**:
一个 Task 声明的“另一个 Task 关闭之前我不能开始”。
_Avoid_: 依赖、dependency

**Map View（地图视图）**:
Pane 里展示一个 Spec 或 Map 的 Child Task 及其 Blocking Edge 的部分。它是视图，不是 Map。
_Avoid_: 地图（单独说“地图”时指 Map）

### 协作与完成

**Task Status（任务状态）**:
Task 在 Task Source 里是开着还是已关闭。

**Execution Status（执行状态）**:
是否有 Session 正在做这个 Task。依据是 Deck 自己的 Occupancy 记录，不是 Task Source。

**Occupancy（占用）**:
Deck 记下的“某个 Session 正在执行某个 Task”。一个 Task 同一时间最多有一个。
_Avoid_: 认领、claim（`/wayfinder` 用它指在任务来源里把 Task 指派给人）、锁

**Orphaned（失联）**:
Session 已结束而 Task 仍未关闭时 Occupancy 所处的状态，等待用户决定恢复或转交。
_Avoid_: 超时、过期

**Acceptance Evidence（验收证据）**:
说明一个 Task 满足了验收条件的材料，连同它的出处。
_Avoid_: 完成证明

**Pending Closeout（待收尾核对）**:
一个 Spec 的 Child Task 已全部关闭、但 Spec 自身的收尾核对尚未完成的状态。它不代表验收通过。
_Avoid_: 已完成、done、验收通过

### 推荐与执行

**Recommendation Request（推荐请求）**:
用户按下“我现在该做什么”产生的一次请求，在 Target Session 里以 `/ask-matt` 的形式运行。

**Task Snapshot（任务快照）**:
随 Recommendation Request 一起送出的当前 Task 概况。

**Held Request（持有的请求）**:
Session 忙碌时由 Pane 暂存、尚未发出的 Recommendation Request。发出之前可以取消。
_Avoid_: 排队（宿主自己的排队无法取消，是另一回事）

**Recommendation（推荐）**:
对 Recommendation Request 的结构化回答：做哪个 Task、下一步、用哪个技能、理由、阻塞。
_Avoid_: 建议、suggestion

**Execute Prompt（执行提示词）**:
Pane 为开始做某个 Task 预填进输入框的提示词，由用户自己发送。Occupancy 在它真正发出时成立。
