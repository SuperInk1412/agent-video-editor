# 改动日志 · 基础能力 + 效果预设（MV/预设 agent）

每个提交一条。格式：日期 · 提交号 · 改了什么 · 为什么 · 文件 · 回退方式。
分支：`agent/presets-groundwork`（起点 `bdab52e`，2026-10-27 rebase 到 `7b93562`，同日快进合并进 master）。设计与排期见 `docs/DESIGN-PRESETS.md`。

| 日期 | 提交 | 改了什么 | 为什么 | 文件 | 回退 |
|---|---|---|---|---|---|
| 2026-10-26 | `87be2a6` | 新增设计与排期文档、白话版、本日志，记下用户拍板 | 用户审核前先写计划 | `docs/DESIGN-PRESETS.md`、`docs/工作安排-简明版.md`、`docs/CHANGELOG-presets.md` | `git revert 87be2a6` |
| 2026-10-27 | `45e6350` | W1 父子核心：世界姿态按父子链求值；新 op `objectParent`/`objectUnparent`/`objectParentKey`/`objectParentUnkey`；11 条单测 | 后面的平面、模型、灯光、预设拍扁都要挂父级 | `core/hierarchy.js`（新）、`core/ops-ext.js`、`tests/hierarchy.test.mjs`（新） | `git revert 45e6350`（先回退下面三条） |
| 2026-10-27 | `ac2591f` | 成片烘焙改用世界姿态，Blender 里子元素跟着父级动 | 共享调用点（DESIGN-PRESETS §1 已登记） | `engine/shot.js` | `git revert ac2591f` |
| 2026-10-27 | `3f7609d` | 预览视口按世界姿态画和点选；空元素画成黄色十字（只在编辑器里） | 视口要和成片一致 | `app/renderer/js/preview3d.js` | `git revert 3f7609d` |
| 2026-10-27 | `c0d5bfb` | 检查器加「父级」区块：选父级、三个跟随开关、旋转/缩放强度（可打帧） | 不用命令行也能挂父级 | `app/renderer/js/inspector.js` | `git revert c0d5bfb` |
| 2026-10-27 | `6b42621` | SPEC-OBJECTS 写清父子的数据、求值、ops 和限制 | 文档跟代码同步 | `docs/SPEC-OBJECTS.md` | `git revert 6b42621` |
| 2026-10-27 | `4293e8b` | W2 数据：图片/视频/文字元素的字段、默认值、适配公式（完整显示/铺满裁切/拉伸 + 裁切）、视频时间换算；6 条单测 | 3D 里放真正的图片、视频、文字 | `core/objects-media.js`（新）、`tests/objects-media.test.mjs`（新） | `git revert 4293e8b`（先回退下面几条） |
| 2026-10-27 | `19ab307` | 成片烘焙带上图片/视频/文字信息；渲染前把视频平面抽成保持原比例的图片序列 | 共享调用点：`shot.js::bakeObjects`、`blender.js` 两处（已在交接文档登记） | `engine/shot.js`、`engine/blender.js`、`engine/media-objects.js`（新） | `git revert 19ab307` |
| 2026-10-27 | `64603f4` | Blender 里建图片/视频平面和 3D 文字（更纱黑体等字体文件、厚度）；字号统一按 em 计算 | 成片和预览一致 | `blender/vdm_objects.py`（新）、`blender/vdm_city.py`（只加分派） | `git revert 64603f4` |
| 2026-10-27 | `1c79b35` | 预览视口画图片/视频/文字平面（视频跟时间轴同步） | 编辑时看得到真实内容 | `app/renderer/js/preview3d.js` | `git revert 1c79b35` |
| 2026-10-27 | `072aecc` | 检查器「内容」区块：素材、适配、框尺寸、入点/速度、文字排版 | 不用命令行也能改内容 | `app/renderer/js/inspector.js` | `git revert 072aecc` |
| 2026-10-27 | `e8f7f01` | SPEC-OBJECTS 写清图片/视频/文字的数据、公式、一致性和限制 | 文档跟代码同步 | `docs/SPEC-OBJECTS.md` | `git revert e8f7f01` |
| 2026-10-27 | `f2755bf` | **修复**：Blender 合成器节点组没声明输出接口，导致成片一直是原始渲染（雾、调色、辉光、颗粒、暗角都没生效）；补上输出接口 | W3 的 2D 叠加依赖合成器；顺带让所有成片的后期真正生效（观感会变） | `blender/vdm_build.py`（`build_compositor` 末尾 4 行） | `git revert f2755bf`（成片回到无后期的样子） |
| 2026-10-27 | `2c26333` | W3：3D 项目里的 2D 元素在 Blender 成片里叠到 3D 画面上（单相机走合成器，多相机走 VSE 顶层轨道） | 字幕、HUD、遮罩要盖在 3D 画面上 | `blender/vdm_build.py`（`SceneBuilder.build` 可建到指定场景、透明底）、`blender/vdm_city.py` | `git revert 2c26333` |
| 2026-10-27 | `b729c58` | W3：预览里 3D 画面画完后再画 2D 图层 | 预览和成片一致 | `app/renderer/js/preview.js` | `git revert b729c58` |
| 2026-10-27 | `729f839` | SPEC-PROJECT 写清 3D 项目里 2D 元素的规则、合成器输出接口的要求和已知差异 | 文档跟代码同步 | `docs/SPEC-PROJECT.md` | `git revert 729f839` |
