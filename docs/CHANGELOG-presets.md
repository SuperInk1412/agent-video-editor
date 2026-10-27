# 改动日志 · 基础能力 + 效果预设（MV/预设 agent）

每个提交一条。格式：日期 · 提交号 · 改了什么 · 为什么 · 文件 · 回退方式。
分支：`agent/presets-groundwork`（起点 `bdab52e`，2026-10-27 rebase 到 `d5f38ca`）。设计与排期见 `docs/DESIGN-PRESETS.md`。

| 日期 | 提交 | 改了什么 | 为什么 | 文件 | 回退 |
|---|---|---|---|---|---|
| 2026-10-26 | `5813cf9` | 新增设计与排期文档、白话版、本日志，记下用户拍板 | 用户审核前先写计划 | `docs/DESIGN-PRESETS.md`、`docs/工作安排-简明版.md`、`docs/CHANGELOG-presets.md` | `git revert 5813cf9` |
| 2026-10-27 | `fd0d819` | W1 父子核心：世界姿态按父子链求值；新 op `objectParent`/`objectUnparent`/`objectParentKey`/`objectParentUnkey`；11 条单测 | 后面的平面、模型、灯光、预设拍扁都要挂父级 | `core/hierarchy.js`（新）、`core/ops-ext.js`、`tests/hierarchy.test.mjs`（新） | `git revert fd0d819`（先回退下面三条） |
| 2026-10-27 | `9495f07` | 成片烘焙改用世界姿态，Blender 里子元素跟着父级动 | 共享调用点（DESIGN-PRESETS §1 已登记） | `engine/shot.js` | `git revert 9495f07` |
| 2026-10-27 | `059f496` | 预览视口按世界姿态画和点选；空元素画成黄色十字（只在编辑器里） | 视口要和成片一致 | `app/renderer/js/preview3d.js` | `git revert 059f496` |
| 2026-10-27 | `44e3045` | 检查器加「父级」区块：选父级、三个跟随开关、旋转/缩放强度（可打帧） | 不用命令行也能挂父级 | `app/renderer/js/inspector.js` | `git revert 44e3045` |
| 2026-10-27 | `e3e30a0` | SPEC-OBJECTS 写清父子的数据、求值、ops 和限制 | 文档跟代码同步 | `docs/SPEC-OBJECTS.md` | `git revert e3e30a0` |
| 2026-10-27 | `4baebe5` | W2 数据：图片/视频/文字元素的字段、默认值、适配公式（完整显示/铺满裁切/拉伸 + 裁切）、视频时间换算；6 条单测 | 3D 里放真正的图片、视频、文字 | `core/objects-media.js`（新）、`tests/objects-media.test.mjs`（新） | `git revert 4baebe5`（先回退下面几条） |
| 2026-10-27 | `0104e5f` | 成片烘焙带上图片/视频/文字信息；渲染前把视频平面抽成保持原比例的图片序列 | 共享调用点：`shot.js::bakeObjects`、`blender.js` 两处（已在交接文档登记） | `engine/shot.js`、`engine/blender.js`、`engine/media-objects.js`（新） | `git revert 0104e5f` |
| 2026-10-27 | `792bd22` | Blender 里建图片/视频平面和 3D 文字（更纱黑体等字体文件、厚度）；字号统一按 em 计算 | 成片和预览一致 | `blender/vdm_objects.py`（新）、`blender/vdm_city.py`（只加分派） | `git revert 792bd22` |
| 2026-10-27 | `766a136` | 预览视口画图片/视频/文字平面（视频跟时间轴同步） | 编辑时看得到真实内容 | `app/renderer/js/preview3d.js` | `git revert 766a136` |
| 2026-10-27 | `82ae96d` | 检查器「内容」区块：素材、适配、框尺寸、入点/速度、文字排版 | 不用命令行也能改内容 | `app/renderer/js/inspector.js` | `git revert 82ae96d` |
| 2026-10-27 | `617a0e5` | SPEC-OBJECTS 写清图片/视频/文字的数据、公式、一致性和限制 | 文档跟代码同步 | `docs/SPEC-OBJECTS.md` | `git revert 617a0e5` |
