# 编码规范

评审时对照的判断题。能用检查拦住的规则写成检查（`tests/conventions.test.ts`、`.githooks/pre-push`），不写在这里。

## 测试落在两个接缝上

行为的测试只通过对外接口写：任务内核的行为经 Deck 服务的 `deck_*` 工具验证，Pane 的行为经引擎测试工具下的 Mod 验证。内核新增的行为因此先成为一个 `deck_*` 工具。别的入口（例如命令行）只测自己那一层：参数、输出、退出状态。

## 原因由内核给，句子由展示它的一方写

读取失败时 Deck 服务回答 `{ kind, message }`。给人看的句子属于展示它的那一方：Pane 的措辞在 `plugin/hooks/pane.tsx`，带着只在 Pane 里成立的按键提示。别的入口原样给出 `kind` 和 `message`。

## 字符串的语言跟着读它的人

人在 Pane、toast 和命令行用法里读到的是中文。agent 和程序读到的是英文：工具的 `description`、`failure.message`、抛出的错误、代码注释、提交信息。
