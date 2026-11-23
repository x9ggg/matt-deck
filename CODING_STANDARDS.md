# 编码规范

评审时对照的判断题。能用检查拦住的规则写成检查（`tests/conventions.test.ts`、`.githooks/pre-push`），不写在这里。

## 评审的条目怎么了结

- 在这次 diff 里、几行能改完的：推送前改掉。
- 不在这次 diff 里，但改变 Deck 的行为，或者缺一条守行为的测试：开票。
- 其余的（命名、注释、一两行的重复）：写进关闭评论。

## 测试落在三个接缝上

行为的测试只通过对外接口写：任务内核的行为经 Deck 服务的 `deck_*` 工具验证，Claude Code 上 Pane 的行为经引擎测试工具下的 Mod 验证，Codex 标签页里 Pane 的行为经假宿主下的页面验证。内核新增的行为因此先成为一个 `deck_*` 工具。别的入口（例如命令行）只测自己那一层：参数、输出、退出状态，以及它写的文件。

假宿主下的页面（`tests/fake-host.ts`）：页面 `plugin/codex/pane.html` 原样载入 jsdom，`runScripts: 'dangerously'` 执行它唯一的内联脚本。页面窗口的 `parent` 换成另一个 jsdom 窗口，它扮演宿主：回应 `ui/initialize`，把页面的 `tools/call` 交给测试给的回答（回答还拿到页面的 `document`，测试由此读到调用还没回答时页面显示的内容），对预填用的 `ui/message` 回答成功，记下页面发出的每条消息。`show()` 扮演宿主显示或隐藏标签页：改写页面 `document` 的 `visibilityState` 和 `hidden`，再派发 `visibilitychange`。这是照浏览器的页面可见性扮演的，Codex 实际怎么隐藏标签页还没有在桌面应用里核对。宿主的通知用 `MessageEvent` 发给页面，`source` 是这个宿主窗口。它像 Codex 一样把自己的外观（`light` 或 `dark`）写在页面根元素的 `data-theme` 上：握手完成之后写一次，外观变化时在发变更通知之前先写。jsdom 发出的请求（样式表、`@import`、脚本、框架、XHR、WebSocket）都经一个拦截器记下，不出网；它不请求图片，也不请求样式里 `url()` 的地址，这两样靠查页面源码守：源码里不出现 `src`、`srcset`、`href` 的赋值，也不出现 `url(`、`@import`、`@font-face` 和 `http:`、`https:`。测试读页面显示的文字和它发出的消息，看不到布局：贴顶这类只能读计算后的样式，真实的滚动在桌面应用里核对。jsdom 是仓库根目录的开发依赖，新检出先运行 `npm install`；插件本身仍不装任何包。

引擎测试工具的 `find` 按文档顺序给出第一个匹配。查询的 `in` 选的是另一个 Client 画的树，不能限定在一个已找到的节点下面。Pane 顶部各分组计数的图形排在动作栏前面，所以读动作栏里的某个节点，先按 `type` 和 `text` 找到动作栏，再走它的 `children`。

测试之间形状相同是有意的，不算 Duplicated Code。

## 原因由内核给，句子由展示它的一方写

读取失败时 Deck 服务回答 `{ kind, message }`。给人看的句子属于展示它的那一方：Pane 的措辞在 `plugin/hooks/pane.tsx`，带着只在 Pane 里成立的按键提示。别的入口原样给出 `kind` 和 `message`。

## 字符串的语言跟着读它的人

人在 Pane、toast 和命令行用法里读到的是中文。agent 和程序读到的是英文：工具的 `description`、`failure.message`、抛出的错误、代码注释、提交信息。
