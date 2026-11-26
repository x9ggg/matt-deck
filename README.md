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

Skill Source 是目录时，Pane 的“技能”列出目录里的全部技能，包括不属于 Matt skills 的；只想看 Matt skills，就把 Skill Source 选成 Matt skills 的插件。这要先装上 Matt skills 的插件，它才会出现在配置技能的候选里；已经配置过的项目重跑 `/matt-deck:configure`，在配置技能问是否修改时选择修改。

## 在 Codex 桌面应用里使用

Codex 桌面应用（`ChatGPT.app`）里，Pane 在 Codex 的标签页里打开，读的是和 Claude Code 同一个 Task Source、同一份项目配置和同一份本机状态。前置条件和上面相同（Node、`gh`）。

### 安装

安装每个用户做一次。取一份本仓库的检出，运行：

```sh
git clone https://github.com/x9ggg/matt-deck.git
node matt-deck/plugin/cli/codex.ts install
```

它最多改三个用户全局的文件（Deck 的钩子已经在 `hooks.json` 里时不改它），另在改 `hooks.json` 之前写一份它的备份（见下面第三项），每改一个都在输出里说一句；真把钩子写进 `hooks.json` 时，还会忘掉本机状态里记下的钩子调用（见下面“钩子未生效的提示”）：

- `~/.codex/config.toml`：追加 `[mcp_servers.matt_deck]`，把 Deck 服务注册进 Codex，原有内容保留。注册写的是运行 install 的那个 `node` 的绝对路径（`PATH` 里第一个绝对路径的、解开链接后就是这个 `node` 的条目：通常是指向它的链接，例如 Homebrew 的 `bin` 目录里的那个；真实路径所在的目录排在链接前面时，写的是真实路径；`PATH` 里没有哪个绝对路径的条目解开链接后是它时，也写真实路径，即 `process.execPath`），和这份检出里 `plugin/server/main.ts` 的路径。
- `~/.agents/skills/matt-deck-configure/SKILL.md`：生成配置技能 `matt-deck-configure`，内容只有一句，让 agent 照这份检出里的配置技能做。这个位置已有一份不是 Deck 生成的同名技能时，install 什么都不改，以退出码 1 结束。
- `~/.codex/hooks.json`：在 `UserPromptSubmit` 上加 Deck 的钩子，排在原有的钩子后面。改之前把原文件备份成 `~/.codex/hooks.json.before-matt-deck`，权限不比原文件宽；原来没有这个文件就不备份。

注册是用户全局的，Matt Deck 的入口出现在这个用户的所有项目里；在未配置的项目里打开，Pane 只提示此项目未配置。项目自己的 `.codex/config.toml` 不能用来注册，见 [ADR-0006](docs/adr/0006-codex-via-mcp-app-thread-tab.md)。

再运行一次 install，注册和配置技能重写一遍，已经在的钩子不动。下面几种情况要重跑：

- 这份检出挪了位置或更新了。注册和配置技能指向的是运行 install 的那一份，输出的最后一行写明是哪一份。
- 注册里的 `node` 路径没了，例如用 nvm 这类版本管理器装的 node 换了版本。这时 Codex 起不来 Deck 服务，Pane 打不开。
- 早先装过、`~/.agents/skills` 里还没有 `matt-deck-configure` 的。

更新 Deck 之后还要重启桌面应用：宿主在一次运行里缓存 Pane 的页面，不重启拿到的仍是旧的。

### 信任钩子，再重启

装完还要两步，install 的输出里也会写：

1. 在终端里运行一次 `codex`。启动时出现 Hooks need review，在钩子审查里信任 Deck 的钩子（`UserPromptSubmit` 上调用 `matt_deck` 的 `deck_prompt_submitted` 的那一个）。
2. 退出并重新打开 Codex 桌面应用。

为什么要这两步：

- 钩子要用户信任一次才运行。桌面应用不提示，没信任的钩子只是不跑，要在 Codex 的终端界面里信任。钩子不跑时，发出的 `$implement` 不会登记 Occupancy。Deck 不替你写信任记录。
- 注册之后只新建会话打不开 Pane，要重启桌面应用。

Codex 把信任记在 `~/.codex/config.toml` 的 `hooks.state` 里，按钩子在文件里的位置和内容的哈希记，位置或内容变了就要重新信任。Deck 写进去的钩子内容固定，升级 Deck 也不改它；你在 `hooks.json` 里挪动了钩子（例如在 `UserPromptSubmit` 上 Deck 的那一组前面加了一组），就再信任一次。卸载不删 `hooks.state` 里的记录。卸载再装之后 Codex 的信任还认不认，还没有在桌面应用里核对。

### 打开 Pane

新建一个会话并发出第一条消息，然后按 ⌘T 或点右侧标签栏的“＋”开新标签页，在“打开”旁的更多工具菜单里选 Matt Deck。用过一次之后，Matt Deck 出现在新标签页的快捷项里。

在未配置的项目里，Pane 显示“此项目未配置。”，点“配置这个项目”会把 `$matt-deck-configure` 填进输入框，由你发送；配置技能在 Codex 下跳过写权限规则那一步。在 Claude Code 里配置过的项目不用再配，前提是它的 Skill Source 是 Codex 自己找得到的那一份（Codex 的技能目录 `~/.agents/skills`、项目里的 `.agents/skills` 或 `.codex/skills` 里的，经链接指到同一份文件也算）。不是的话，Pane 停用“执行”和“预填”（`ask-matt` 不是同一份时，“我现在该做什么”也停用），提示“重跑配置”：在 Codex 里重跑 `$matt-deck-configure`，选 Codex 技能目录里的那一份。重跑改的是项目的 `.matt-deck/config.json`，Claude Code 一侧读的也是它。不想改的话，在 `~/.agents/skills` 里给每个要用的技能（`implement`、`ask-matt`、每个要预填的技能）各放一个链接，指到 Skill Source 里的同一份，也就不用重跑；同一个名字在项目的 `.agents/skills` 或 `.codex/skills` 里也有一份的，它也要解开链接后是同一个文件，否则仍算不是同一份。Deck 认的是 `~/.agents/skills/<技能名>/SKILL.md` 解开链接后的文件，所以链接放在 `~/.agents/skills/<技能名>`（指到技能目录）、`~/.agents/skills/<技能名>/SKILL.md`（指到技能文件）上，或整个 `~/.agents/skills` 就是一个链接，都算。整个目录是链接时，install 会把生成的 `matt-deck-configure` 写进链接指向的目录（Skill Source 是插件缓存时就写进插件缓存），删掉链接它也留在那里，所以推荐给每个技能各放一个链接，不要把整个 `~/.agents/skills` 做成链接。Codex 自己会不会经符号链接加载技能还没有核对过，列在[手动检查清单](docs/codex-manual-checklist.md)里。

### 钩子未生效的提示

自 install 最近一次把 Deck 的钩子写进 `hooks.json` 以来，本机的 Deck 服务没在任何已配置的项目里收到过钩子的调用时，所有已配置项目的 Pane 顶部有一条橙色提示“钩子未生效，开始执行不会登记占用。”，点“怎么做”是运行 `codex`、信任钩子、重启这三步。下面几种情况里，它和钩子实际能不能跑对不上：

- **首次配置之后仍在**：只在安装后还没在任何已配置的项目里发过消息时成立。在未配置的项目里钩子的调用不算，配置做完之后，要在任一已配置的项目里发一条消息，提示才消失。
- **卸载再装之后又出现**：install 把钩子写回去时提示通常会重新出现（那时本机状态正被写着、install 忘不掉之前收到的调用的话，就不出现），要在任一已配置的项目里发一条消息才消失，哪怕 Codex 的信任记录还认。
- **钩子没跑时提示也可能不在**：agent 自己调用 `deck_prompt_submitted` 也算收到过；你手改了 `hooks.json` 让 Deck 的钩子换了位置，或在桌面应用开着时卸载再装，提示都可能不出现，而钩子可能要重新信任才跑。这几种情况照上面重新信任一次。

### 卸载

```sh
node matt-deck/plugin/cli/codex.ts uninstall
```

- `config.toml`：只移除 `[mcp_servers.matt_deck]` 和它下面的子表，别的内容不动；只是原文件结尾没有换行时，卸载后结尾多一个换行（#66）。
- 配置技能：只删 Deck 生成的那个 `SKILL.md`，目录空了才删目录；不是 Deck 生成的，不动。
- `hooks.json`：安装之后没改过（按解析后的内容比，只改了空白和换行的也算没改过），就逐字节还原成备份并删掉备份；安装前没有这个文件，就删掉它。改过，就只摘掉 Deck 的钩子，备份留着，输出写明在哪里。比较时键的顺序也算在内：只调换了键的顺序也算改过。

卸载之后重启桌面应用。卸载后入口是否消失，列在[手动检查清单](docs/codex-manual-checklist.md)里待核对。安装前没有 `config.toml` 时，卸载后会留下一个空的；`~/.agents/skills` 这类安装时新建的上级目录也会留下。

### install 和 uninstall 不动的 config.toml

Deck 不解析 `config.toml`，按行认 `[mcp_servers.matt_deck]` 这种单独一行的表头和它下面的子表（`codex mcp add` 写的也是这种）。`config.toml` 里的 `matt_deck` 注册是别的写法时，install 和 uninstall 都以退出码 1 结束，什么都不改，改成这种表头或删掉之后再运行一次。别的写法指：`[mcp_servers]` 下的 `matt_deck = { ... }` 或 `matt_deck.command = ...`、带空格或引号的表头（如 `[ mcp_servers . matt_deck ]`、`[mcp_servers."matt_deck"]`）、顶层的点分键 `mcp_servers.matt_deck.command = ...`、`mcp_servers = { matt_deck = { ... } }`（#85）。照原样追加一张表会让同一个注册声明两次，Codex 整份配置都读不了。

`mcp_servers` 写成内联表（`mcp_servers = { ... }`）、里面没有 `matt_deck` 时，install 同样以退出码 1 结束、什么都不改，因为内联表后面不能再加子表；uninstall 照常说没有注册。多行字符串里恰好有像这些写法的行时，Deck 也当它是，宁可停下。

### install 和 uninstall 不动的钩子文件

Deck 读进 `hooks.json` 之后整份重写，所以它只经手重写之后只差空白的文件。遇到下面这些，install 和 uninstall 都以退出码 1 结束，什么都不改，`hooks.json` 原样留着，改好之后再运行一次：

- 读不懂的：空文件、只有空白、带 BOM、带注释、含不合法的 UTF-8、不是 JSON 对象、`"hooks"` 不是对象（包括 `"hooks": null`）、`UserPromptSubmit` 不是数组。
- 重写会变样的：写法和重写后不一样的数（如超出双精度的、`1.0`、`0.10`、`1e3`、`-0`、`1e400`）、重复的键、重写后会变样的转义（如 `"\u0041"`、`"\u001F"`、`"\/"`；`"\u0001"`、`"\u001f"` 这类重写后照旧的不算）、没有全部按数值升序排在最前面的像序号的键（如 `{"a":1,"1":2}`、`{"2":1,"1":2}`，重写时它们会被挪到最前面、按数值排好；`{"1":2,"a":1}`、`{"1":1,"2":2}` 不算）。

install 要把 Deck 的钩子写进 `hooks.json`（钩子不在里面）、`hooks.json.before-matt-deck` 又已经在时（上一次卸载因为钩子改过而留下的，或者你手动摘掉 Deck 的钩子时留下的），它先被挪到第一个空着的带序号的名字，如 `hooks.json.before-matt-deck.1`，输出会说。之后 Deck 不再碰这些带序号的文件，卸载也不删，要你自己处理。

退出码是 1、报的是系统错误（如 `EACCES`、`ENOENT`）时，前面的步骤可能已经做了，例如注册已经写进去而钩子还没加。修好原因之后再运行一次 install 能补齐，或者运行 uninstall 撤掉；上一次已经写出了备份、Deck 的钩子又不在 `hooks.json` 里时，重跑 install 会把那份备份挪成带序号的文件。

### Codex 上的已知限制

- 新会话发出第一条消息之前打不开 Pane。安装后没有重启桌面应用时也打不开：菜单里没有入口，或者打开后读取失败。这些界面由宿主画，Deck 不处理。
- Pane 要手动打开，自动出现的只是标签页菜单里的入口。重启桌面应用后标签页不恢复，要重新从菜单打开。
- 没有 Held Request，不显示会话是否忙碌。“我现在该做什么”和“执行”只把文字填进输入框，由你发送；推荐请求不能取消，Pane 也读不到回答原文，agent 没有调用 `deck_recommend` 时，Pane 等 10 分钟后停止等待。
- agent 调用入口工具时，消息流里会内嵌一个 Pane。它不是受支持的位置。

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
