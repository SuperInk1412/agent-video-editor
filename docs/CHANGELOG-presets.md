# 改动日志 · 基础能力 + 效果预设（MV/预设 agent）

每个提交一条。格式：日期 · 提交号 · 改了什么 · 为什么 · 文件 · 回退方式。
分支：`agent/presets-groundwork`（起点 `bdab52e`，2026-10-27 rebase 到 `620a7bf`）。设计与排期见 `docs/DESIGN-PRESETS.md`。

| 日期 | 提交 | 改了什么 | 为什么 | 文件 | 回退 |
|---|---|---|---|---|---|
| 2026-10-26 | `5813cf9` | 新增设计与排期文档、白话版、本日志，记下用户拍板 | 用户审核前先写计划 | `docs/DESIGN-PRESETS.md`、`docs/工作安排-简明版.md`、`docs/CHANGELOG-presets.md` | `git revert 5813cf9` |
| 2026-10-27 | `fd0d819` | W1 父子核心：世界姿态按父子链求值；新 op `objectParent`/`objectUnparent`/`objectParentKey`/`objectParentUnkey`；11 条单测 | 后面的平面、模型、灯光、预设拍扁都要挂父级 | `core/hierarchy.js`（新）、`core/ops-ext.js`、`tests/hierarchy.test.mjs`（新） | `git revert fd0d819`（先回退下面三条） |
| 2026-10-27 | `9495f07` | 成片烘焙改用世界姿态，Blender 里子元素跟着父级动 | 共享调用点（DESIGN-PRESETS §1 已登记） | `engine/shot.js` | `git revert 9495f07` |
| 2026-10-27 | `059f496` | 预览视口按世界姿态画和点选；空元素画成黄色十字（只在编辑器里） | 视口要和成片一致 | `app/renderer/js/preview3d.js` | `git revert 059f496` |
| 2026-10-27 | `44e3045` | 检查器加「父级」区块：选父级、三个跟随开关、旋转/缩放强度（可打帧） | 不用命令行也能挂父级 | `app/renderer/js/inspector.js` | `git revert 44e3045` |
| 2026-10-27 | `e3e30a0` | SPEC-OBJECTS 写清父子的数据、求值、ops 和限制 | 文档跟代码同步 | `docs/SPEC-OBJECTS.md` | `git revert e3e30a0` |
