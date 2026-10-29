# 改动日志 · 基础能力 + 效果预设（MV/预设 agent）

每个提交一条。格式：日期 · 提交号 · 改了什么 · 为什么 · 文件 · 回退方式。
分支：`agent/presets-groundwork`；2026-10-28 起 `agent/camfeed`（基于 master `6c2ec5f`，未合入）（起点 `bdab52e`，2026-10-27 rebase 到 `7b93562`，同日快进合并进 master；W3 rebase 到 `18ff573` 后再次快进合并）。设计与排期见 `docs/DESIGN-PRESETS.md`。

| 日期 | 提交 | 改了什么 | 为什么 | 文件 | 回退 |
|---|---|---|---|---|---|
| 2026-10-26 | `87be2a6` | 新增设计与排期文档、白话版、本日志，记下用户拍板 | 用户审核前先写计划 | `docs/DESIGN-PRESETS.md`、`docs/工作安排-简明版.md`、`docs/CHANGELOG-presets.md` | `git revert 87be2a6` |
| 2026-10-27 | `45e6350` | W1 父子核心：世界姿态按父子链求值；新 op `objectParent`/`objectUnparent`/`objectParentKey`/`objectParentUnkey`；11 条单测 | 后面的平面、模型、灯光、预设拍扁都要挂父级 | `core/hierarchy.js`（新）、`core/ops-ext.js`、`tests/hierarchy.test.mjs`（新） | `git revert 45e6350`（先回退下面三条） |
| 2026-10-27 | `ac2591f` | 成片烘焙改用世界姿态，Blender 里子元素跟着父级动 | 共享调用点（DESIGN-PRESETS §1 已登记） | `engine/shot.js` | `git revert ac2591f` |
| 2026-10-27 | `3f7609d` | 预览视口按世界姿态画和点选；空元素画成黄色十字（只在编辑器里） | 视口要和成片一致 | `app/renderer/js/preview3d.js` | `git revert 3f7609d` |
| 2026-10-27 | `c0d5bfb` | 属性面板加「父级」区块：选父级、三个跟随开关、旋转/缩放强度（可打帧） | 不用命令行也能挂父级 | `app/renderer/js/inspector.js` | `git revert c0d5bfb` |
| 2026-10-27 | `6b42621` | SPEC-OBJECTS 写清父子的数据、求值、ops 和限制 | 文档跟代码同步 | `docs/SPEC-OBJECTS.md` | `git revert 6b42621` |
| 2026-10-27 | `4293e8b` | W2 数据：图片/视频/文字元素的字段、默认值、适配公式（完整显示/铺满裁切/拉伸 + 裁切）、视频时间换算；6 条单测 | 3D 里放真正的图片、视频、文字 | `core/objects-media.js`（新）、`tests/objects-media.test.mjs`（新） | `git revert 4293e8b`（先回退下面几条） |
| 2026-10-27 | `19ab307` | 成片烘焙带上图片/视频/文字信息；渲染前把视频平面抽成保持原比例的图片序列 | 共享调用点：`shot.js::bakeObjects`、`blender.js` 两处（已在交接文档登记） | `engine/shot.js`、`engine/blender.js`、`engine/media-objects.js`（新） | `git revert 19ab307` |
| 2026-10-27 | `64603f4` | Blender 里建图片/视频平面和 3D 文字（更纱黑体等字体文件、厚度）；字号统一按 em 计算 | 成片和预览一致 | `blender/vdm_objects.py`（新）、`blender/vdm_city.py`（只加分派） | `git revert 64603f4` |
| 2026-10-27 | `1c79b35` | 预览视口画图片/视频/文字平面（视频跟时间轴同步） | 编辑时看得到真实内容 | `app/renderer/js/preview3d.js` | `git revert 1c79b35` |
| 2026-10-27 | `072aecc` | 属性面板「内容」区块：素材、适配、框尺寸、入点/速度、文字排版 | 不用命令行也能改内容 | `app/renderer/js/inspector.js` | `git revert 072aecc` |
| 2026-10-27 | `e8f7f01` | SPEC-OBJECTS 写清图片/视频/文字的数据、公式、一致性和限制 | 文档跟代码同步 | `docs/SPEC-OBJECTS.md` | `git revert e8f7f01` |
| 2026-10-27 | `f2755bf` | **修复**：Blender 合成器节点组没声明输出接口，导致成片一直是原始渲染（雾、调色、辉光、颗粒、暗角都没生效）；补上输出接口 | W3 的 2D 叠加依赖合成器；顺带让所有成片的后期真正生效（观感会变） | `blender/vdm_build.py`（`build_compositor` 末尾 4 行） | `git revert f2755bf`（成片回到无后期的样子） |
| 2026-10-27 | `2c26333` | W3：3D 项目里的 2D 元素在 Blender 成片里叠到 3D 画面上（单相机走合成器，多相机走 VSE 顶层轨道） | 字幕、HUD、遮罩要盖在 3D 画面上 | `blender/vdm_build.py`（`SceneBuilder.build` 可建到指定场景、透明底）、`blender/vdm_city.py` | `git revert 2c26333` |
| 2026-10-27 | `b729c58` | W3：预览里 3D 画面画完后再画 2D 图层 | 预览和成片一致 | `app/renderer/js/preview.js` | `git revert b729c58` |
| 2026-10-27 | `729f839` | SPEC-PROJECT 写清 3D 项目里 2D 元素的规则、合成器输出接口的要求和已知差异 | 文档跟代码同步 | `docs/SPEC-PROJECT.md` | `git revert 729f839` |
| 2026-10-28 | `abeed8a` | 设计：相机投屏替代贴屏、父子只剩两种 | 用户拍板 | `docs/DESIGN-CAMFEED-PARENTS.md` | `git revert abeed8a` |
| 2026-10-28 | `98d4e64` | 投屏核心：camfeed 元素、`cam.output`、谁拍谁（断环） | 相机投屏 | `core/camfeed.js`（新）、`core/schema.js`、`core/ops.js`（addElement 带 feed，3 行） | `git revert 98d4e64` |
| 2026-10-28 | `7734c41` | 预览投屏 | 预览能看到投屏 | `app/renderer/js/preview.js`、`scripts/check-camfeed.mjs`（新） | `git revert 7734c41` |
| 2026-10-28 | `127b02d` | **修复**：Blender 把 3D 路线里的 2D 元素整片涂成雾色 | master 上就有的成片错误 | `blender/vdm_build.py`、`blender/vdm_city.py` | `git revert 127b02d` |
| 2026-10-28 | `498a726` | 成片投屏（来源相机先渲成序列） | 成片能出投屏 | `engine/camfeed-render.js`（新）、`engine/blender.js`、`blender/vdm_build.py`、`scripts/check-camfeed-blender.mjs`（新） | `git revert 498a726` |
| 2026-10-28 | `64aac91` | Blender 2D 世界矩阵烘焙（空间父级 / 节点） | 2D 元素挂父级后成片位置正确 | `engine/element-bake.js`（新）、`engine/blender.js`、`blender/vdm_build.py`、`scripts/check-render-parity.mjs`（新） | `git revert 64aac91` |
| 2026-10-28 | `e83808d` | 父子只剩空间父级（加强度），旧 3D 父级打开时迁移 | 用户拍板：父子只有两种 | `core/parent-strength.js`（新）、`core/spatial.js`、`core/spatial-parent.js`、`core/ops-ext.js`、`core/contracts.js`、`engine/storage.js`、`inspector.js`、测试 | `git revert e83808d` |
| 2026-10-28 | `4c0fdf9` | 贴屏退役，打开时迁到 HUD 机位 | 用户拍板：贴屏用投屏替代 | `core/screen-lock-migrate.js`（新）、`core/hierarchy.js`、`preview.js`、`engine/shot.js`、`blender/*.py`、`inspector.js`、测试 | `git revert 4c0fdf9` |
| 2026-10-28 | `0626929` | 设计定稿：投屏修正、三轴旋转、姿态预设、新建相机、路径推广 | 用户逐条拍板 | `docs/DESIGN-TRANSFORM-UNIFY.md`（新） | `git revert 0626929` |
| 2026-10-28 | `b6c6217` | 去掉"仅投屏"（出画只看相机栈）；贴屏改为按镜头切段挂到镜头相机，HUD 机位项目先还原 | 用户拍板：投屏不该决定出画、不自动搭全屏拍屏 | `core/camfeed.js`、`core/screen-lock-migrate.js`、`engine/*`、`preview.js`、测试、文档 | `git revert b6c6217` |
| 2026-10-28 | `4edc742` | 打开时把所有旧朝向迁到三轴旋转（开关 `ROTATION_MIGRATION`，默认关） | 用户拍板：所有元素统一 X/Y/Z 三轴 | `core/rotation-migrate.js`（新）、`core/schema.js`、`core/scene.js`、`engine/storage.js`、测试 | `git revert 4edc742` |
| 2026-10-28 | `dbbc8b2` | 相机旧手动 roll 在 2b 后的旋转偏移上精确合并；记 2c 验收与开关暂不开的原因 | 2b 后相机可能同时带 roll 和 rotation | `core/rotation-migrate.js`、测试、`docs/DESIGN-TRANSFORM-UNIFY.md` | `git revert dbbc8b2` |
| 2026-10-28 | `ce12230` | 新建内容直接写三轴旋转（2D 建成节点、物体/相机写 `rotation`），旧写法的 op 自动翻译；打开 `ROTATION_MIGRATION` | 用户批准：新建即三轴，避免每次打开重复迁移 | `core/rotation-ops.js`（新）、`core/ops.js`、`core/scene.js`、`core/camera.js`、`engine/shot.js`、14 个测试 | `git revert ce12230`（开关和新建格式一起回退） |
| 2026-10-29 | `306fbe1` | 物体「面向镜头」改写 `rotation.x/y/z`：`facingRotation` 保自转、按整圈就近展开、首键补基础值，旧 `dir` op 翻译共用同一函数 | 界面不再写旧字段 | `app/renderer/js/main.js`、`core/rotation-ops.js`、`tests/rotation-ops.test.mjs` | `git revert 306fbe1` |
| 2026-10-29 | `f0846c8` | 时间轴相机删掉「手动 roll°」行，画面内旋转用 `旋转 Z°`；模板注册表和「只看带键」分组表同步，属性页提示改为已并入 Z | 旧 roll 打开工程时并进 `rotation.z`，不再需要单独一行 | `app/renderer/js/timeline.js`、`app/renderer/js/inspector.js`、`core/templates.js`、`core/timeline-keys.js`、`tests/templates.test.mjs` | `git revert f0846c8` |
| 2026-10-28 | `9986cbc` | 设计：变换栏统一（中心点→位置→旋转→缩放，一行三格可展开逐轴）、缩放和中心点逐轴打帧、位置保持整点路径 | 用户拍板 | `docs/DESIGN-TRANSFORM-UNIFY.md` §9 | `git revert 9986cbc` |
| 2026-10-29 | `7498eca` | 修复方案：预览 2D 平面排序与 Blender 不一致（斜文字被身后底板盖住）、点空白取消选中报错和隐式改选 | 用户发现相机 9 看不到歌词、取消选中像玄学 | `docs/FIX-LAYER-ORDER-EMPTY-CLICK.md`（新） | `git revert 7498eca` |
