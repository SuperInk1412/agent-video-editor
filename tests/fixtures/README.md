# 固定测试样例

`demo.json` 和 `nightcity.json` 来自提交 `764f253` 的项目文件，用于迁移保真检查。
它们与用户可编辑的 `projects/` 独立；模型契约改变时显式更新样例和对应断言。

`agent-stub.mjs` 只由 agent 生命周期测试作为子进程启动，不调用真实模型。
