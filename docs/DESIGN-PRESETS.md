# 基础能力 + 效果预设 · 设计与工作安排（MV/预设 agent）

> 状态：**草案，待用户审核**。审核通过前不写代码。
> 分工依据：`docs/HANDOFF-2026-10-26.md` §9（4 轮已确认）。分支 `agent/presets-groundwork`，起点 `bdab52e`。
> 本文件同时是给曲线/相机 agent 的接口契约；改契约要在交接文档 §9 登记。

## 0. 目标与范围

用户要求：MV 里**每个元素、每段文字、每个效果**都能在 VedioMaker 里精细编辑（不需要改网格顶点）。
编辑器原生做不到的效果做成**效果预设**，参数全部可调、可打关键帧，而且预设不能是黑盒。

我负责的部分分五组，按依赖顺序排：

| 组 | 内容 | 为什么排这里 |
|---|---|---|
| **G1 地基** | 空元素 + 父子；3D 图片/视频/文字平面；3D 项目里 2D 元素叠到画面上 | 预设生成的"个体"要挂父子；MV 的卡片、屏幕、招牌、字幕都是平面 |
| **G2 真实场景** | 材质、灯光、可编辑环境、外部模型导入（glb）+ 内存预算 | 解决上次"没材质的壳子"；游戏街区要进得来、渲得动 |
| **G3 预设框架** | 预设包、预设栈、个体、选择器、驱动、烘焙、拍扁、CLI/AI、首批预设 | 依赖 G1 的父子和平面 |
| **G4 界面** | 检查器改成"元素 + 预设"面板、预设库、预设栈 UI | 依赖 G3；`inspector.js` 已归我 |
| **G5 MV 必需** | 转场、LRC 歌词导入、分段渲染/断点续渲、缓存管理、子场景（拍扁容器）、波形/打拍的数据侧 | 做 MV 之前补齐 |

**不归我**（交接文档 §9）：相机路径曲线、`core/camera.js`、`core/curves.js`、`core/ops.js`、
`curvepanel.js`、`numfield.js`、`pathgizmo.js`、`timeline.js`（释放前）、2D 属性行 UI、波形 UI。

## 1. 文件归属与共享调用点

**我独占：** `preview3d.js`、`inspector.js`、`core/ops-ext.js`、`core/hierarchy.js`、`core/objects-media.js`、
`core/material.js`、`core/presets/`、`presets/`、`engine/presets-bake.js`、`engine/cache.js`、
`blender/vdm_objects.py`、`blender/vdm_presets.py`、`cli/presets.js`、本文件、`docs/CHANGELOG-presets.md`。

**共享文件，只加调用点**（每处动之前都先在 §9 登记）：

| 文件 | 加什么 | 哪一期 |
|---|---|---|
| `engine/shot.js::bakeObjects` | 改用 `worldPose()`（含父子）；附带平面/材质/灯光字段 | W1、W2、M1 |
| `blender/vdm_city.py::_build_objects` | 按 `type` 分派给 `vdm_objects.py` | W2、M1 |
| `blender/vdm_build.py` | import `vdm_objects` / `vdm_presets` + 调用，不碰 `sample_*` / `eval_element` 语义 | W3、P-D |
| `core/schema.js`（对象类型白名单） | 追加 `light`、`model`、`environment` | M1–M4 |
| `cli/vdm.js`、`engine/agent.js` | 注册 `preset` / `fx` 子命令 | P-G |
| `app/renderer/app.css` | 只在末尾追加 `/* presets */` 区块 | G4 |

## 2. G1 地基

### W1 空元素 + 父子（约 2 天）

照 `DESIGN-SCENE-EDITOR.md` §3 实现：

```jsonc
{ "id": "ob_7", "type": "empty", ... ,
  "parent": { "id": "ob_3",
              "inherit": { "pos": true, "rot": true, "scale": true },
              "strength": { "rot": 1, "scale": 1 },     // 0..1，可打关键帧
              "bind": [/* 4×4，绑定瞬间父的逆矩阵 */] } }
```

- `core/hierarchy.js::worldPose(project, id, t)`：先用现有 `objectPose()` 算本地，再按
  `childWorld = parentWorld · bind · inherit(childLocal, strength)` 向上组合；限深度 32、防环。
- ops（放 `ops-ext.js`）：`objectParent`（保持当前世界位置不跳）、`objectUnparent`（同样保持位置）。
- Blender **不用改求值**：`bakeObjects` 烘的已经是世界矩阵，Blender 只负责摆放（编辑器现在的做法就是这样）。
- 验收：单测覆盖继承开关、强度、绑定不跳、成环拒绝；Electron 截图核对父子同步运动。

### W2 3D 图片 / 视频 / 文字平面（约 3 天）

- `image` / `video`：`geom.d = 0` 时画成平面，贴图来自 `src`（项目 `media/`）。
  `fit: contain|cover|stretch`，`uv` 裁切，视频有 `inTime` / `rate`。
  - 预览：`preview3d.js` 加带贴图的四边形（视频用 `HTMLVideoElement` 纹理，按项目时间 seek）。
  - Blender：平面 + Emission/Principled 材质 + Image Texture（视频用 movie 序列）。
- `text`：字段为 `text`、`font`（项目内字体文件，默认更纱黑体）、`size`（米）、`color`、`align`、
  `tracking`、`lineHeight`、`extrude`（0 = 平面字）。
  - Blender：FONT 对象，用**同一个字体文件**，挤出深度对应 `extrude`。将来做文字破碎就用它。
  - 预览：canvas 2D 栅格化成贴图。字距/换行和 Blender 只能**近似一致**，在 `parity` 里注明。
- 验收：同一帧预览截图和 Blender 截图交给 DeepSeek 比对版面；单测覆盖字段默认值和迁移。

### W3 3D 项目里 2D 元素叠到画面上（约 1.5 天）

- 现状：3D 项目里，时间轴上的 2D 元素在 Blender 里也会变成发光盒子。
- 改法：2D 元素走现有 2D 渲染路径，单独输出 RGBA 层，然后在合成器里 alpha-over 到 3D 画面上，
  顺序按时间轴图层。预览侧已经是这么叠的，只需核对。
- 动工前先读 `vdm_build.py` 的合成部分，确认这条路走得通；走不通就在 §9 登记，换方案再报告。

## 3. G2 真实场景（约 6 天）

### M1 材质（约 1.5 天）
`object.material = { base, roughness, metallic, emission, emissionStrength, map, normalMap, alpha }`，
每个数值字段都可打关键帧。
- Blender：Principled BSDF。
- 预览：简化 PBR（漫反射 + 高光 + 自发光），`parity: approx`。
- 旧字段 `style.color/emissive` 映射成材质的默认值，不需要迁移项目。

### M2 灯光（约 1.5 天）
新类型 `light`：`kind: point|spot|area|sun`、`color`、`power`、`radius`、`spotAngle`、`blend`，全部可打关键帧。
- 预览：前向光照，最多 8 盏，超出部分按距离裁掉并给出提示。
- Blender：对应的灯光对象。现在写死的那盏"月光"变成环境里的默认 sun，可以删、可以改。

### M3 可编辑环境（约 1 天）
新类型 `environment`（每个场景一个）：天空色/HDRI、雾（密度、颜色、起止距离）、环境光。
- 现有 `world` 参数保持兼容。程序化城市以后变成挂在环境上的**生成预设**（G3 做），现在不动它的代码。

### M4 外部模型导入 + 内存预算（约 2 天）
新类型 `model`：`src` 指向 glb，可以替换部件材质（`materialOverrides[]`）。
- Blender：用 glTF 导入器。上次踩过坑：场景越大导入越慢，所以先导进空场景再链接进来。
- 预览：自己写最小 glb 解析器（零依赖；只读网格、基础色、贴图），配合**代理**：
  - 导入时用 Blender 生成低面数代理和缩小后的贴图，缓存到 `.vdm/cache/proxy-<hash>`。
  - 预览只加载代理，成片用原件。
- 内存预算：项目级 `render.budget = { textureMax: 2048, maxMaterials, lodDistances }`。
  渲染前估算用量，超出就提示并自动降级（合并材质、缩贴图）。上次 Blender 渲到 11 GB 爆掉就是缺这一步。
- 说明：上次的 Night City 街区之所以是"没材质的壳"，是因为贴图没正确接上，而且路面是运行时生成的。
  M4 只提供"能导入、渲得动"的通道。MV 用哪套场景素材，到 MV 重建方案里再定，并另行请你审批。

## 4. G3 预设框架（约 15 天，同前一版计划单）

### 4.1 概念
- **预设 = 操作器**：挂在目标上（3D 物体、文字、平面、空元素、相机、环境、整个画面），一个目标挂一摞，从上往下执行，可以排序、开关。
- **五个阶段**：① 几何 → ② 个体 → ③ 材质 → ④ 模拟 → ⑤ 画面。
- **个体**：复制品、碎块、单字、粒子统称个体。每个都有 `i / N / seed`，以及位置、旋转、缩放、透明度、颜色。预设之间还可以传**事件/数据**（比如雨滴落点交给涟漪）。
- **选择器**：范围（起点 / 终点 / 偏移 / 曲线）、随机、距离场、编号、节拍、音量。可以叠加，叠加方式为相乘、相加或取最大。
- **驱动**：参数的值可以来自固定值、关键帧、节拍、音量，或者链接到另一个参数（带倍率和偏移）。

### 4.2 预设包（全部是可读文本）
```
presets/<id>/  preset.json · README.md · eval.js · preview.glsl? · blender.py · example.vdm.json
```
- `preset.json` 里的参数沿用 `DESIGN-TEMPLATES.md` 的 `PROPERTY` 格式，所以界面能自动生成参数行和 `◆`。
- 额外字段：`stage`、`targets`、`provides`、`requires`、`selectors`、`cache: none|bake`、`parity: exact|approx|cached`。
- 存放位置：仓库级 `presets/` 放内置预设；项目级 `projects/<name>/presets/` 可以覆盖或新增。
- **组合预设**：只有 `preset.json`，内容是一个预设栈，加上"提升到外层"的参数映射。
- **AI 写的预设**：没有 README 就不能注册。`vdm preset export <id>` 把整个预设导出成一个 Markdown 文件，可以直接交给 AI 解释。

### 4.3 求值语义
```js
// eval.js：纯函数，浏览器和 Node 共用；禁止 Math.random / Date / node:*
export function evaluate(ctx) {
  // ctx = { t, frame, fps, params /* 已按关键帧和驱动采样 */, target, items /* 上游个体 */,
  //         rand(i, k) /* 由 seed 决定 */, beat, volume, events }
  return { items, uniforms, events };
}
```
- **求值只写一遍**：JS 逐帧算出的结果（个体变换、材质 uniform）由 `engine/presets-bake.js` 烘焙进 shot 包，
  `blender.py` 只负责搭结构（实例、节点组），数值从包里读。这和编辑器现有的 `objectPose()` 烘焙是同一个做法。
- **模拟类例外**：由 Blender 算（刚体、布料、粒子），结果写进 `.vdm/cache/sim-<hash>.json`，预览和拍扁都读这份缓存。
  缓存哈希包含物理参数，参数一变就提示"需要重新烘焙"；时间缩放、冲击时刻偏移这类后处理参数不需要重算。
- **对拍**：每个预设都要带 `tests/presets/<id>.test.mjs`，加上 `blender:check` 抽帧比对。`approx` 级的预设要写明误差范围。

### 4.4 拍扁规则
- **几何、个体类**：在目标下面生成 `empty` 父元素，每个个体变成一个子元素（类型照搬：碎块是 `model`，单字是 `text`），
  逐帧结果转成关键帧，并按容差精简（默认 0.1 mm / 0.05°），这样不会每帧都留一个键。
- **材质类**：参数直接变成对象 `material` 的轨道。
- **模拟类**：用缓存生成关键帧，规则同上。
- **画面类**：本身就是参数，不需要拍扁。
- 拍扁是一个 op（`effectFlatten`），可以撤销；原预设在栈里保留为禁用状态，并标注 `flattenedInto`，方便再找回来。

### 4.5 ops（全部登记在 `ops-ext.js`）
`objectParent · objectUnparent · effectAdd · effectPatch · effectKey · effectUnkey · effectRemove · effectReorder ·
effectDrive · effectSelectorSet · effectFlatten · effectBake · presetSave`

### 4.6 分期
| 期 | 内容 | 估时 |
|---|---|---|
| P-A | 注册表、清单校验、预设栈、个体、选择器、驱动、单测 | 2 天 |
| P-B | 上面那些 ops、参数校验 | 1 天 |
| P-C | 烘焙进 shot 包、模拟缓存（读写和失效判断） | 1 天 |
| P-D | Blender 接入：实例、几何节点、材质节点组、合成器节点组、跑模拟 | 2 天 |
| P-E | 预览接入：实例化绘制、着色器链、播放模拟缓存 | 2 天 |
| P-G | `vdm preset ls/show/export/new`、`vdm fx …`；AI 上下文附预设目录 | 1 天 |
| P-H | 首批预设：复制器、散开、边缘发光、逐字出现、破碎+刚体、网点，每个带 README 和示例 | 3 天 |
| （界面 P-F 并入 G4） | | |

## 5. G4 界面（约 3 天）

- 右侧检查器改成**"元素 + 预设"**：上半部分是元素的基础信息（类型、源素材、材质），下半部分是预设栈
  （拖动排序、开关、参数行、`◆`、选择器、驱动、拍扁/烘焙按钮、"查看原理"、"查看代码"）。
- 底部或侧栏加预设库面板，能搜索、看预览图，拖到元素上就挂上。
- 不改 `numfield` 接入和现有字段行为；样式只追加 `/* presets */` 区块。
- 时间轴里预设参数的轨道行：等对方释放 `timeline.js` 后，在 §9 协商由谁来接。

## 6. G5 MV 必需（约 7 天）

| 项 | 内容 | 估时 |
|---|---|---|
| 转场 | `kind: transition` 的画面预设，挂在两个相邻元素或镜头之间：对位溶解、网点擦除、斜切 | 1.5 天 |
| LRC 导入 | `vdm lyrics import x.lrc` → 每行歌词生成一个文字元素（可套用字幕样式预设） | 0.5 天 |
| 分段渲染 / 断点续渲 | 渲染队列按帧段切开，已渲完的段可以跳过，进程并发数可设（适配 16 GB 内存） | 1.5 天 |
| 缓存管理 | `.vdm/cache` 索引、占用统计、清理，"需要重新烘焙"提示 | 1 天 |
| 波形 / 打拍数据侧 | 波形峰值缓存、手动拍点的 ops 和 CLI，UI 归对方 | 0.5 天 |

**子场景 / 拍扁容器**（`DESIGN-SCENE-EDITOR.md` §6 的 P7：`scenes` 树、透明输出、容器当屏幕，约 3 天，不含 UI 的进入/退出）
用户确认有用，但放到**最后**做（▶7）。

## 7. 总排期（按顺序，每个功能做完并测试通过后汇报一次）

| 顺序 | 工作 | 估时 | 累计 |
|---|---|---|---|
| ▶1 | W1 父子 + W2 平面 + W3 2D 叠加 | 6.5 天 | 6.5 |
| ▶2 | M1–M4 材质 / 灯光 / 环境 / 模型 + 预算 | 6 天 | 12.5 |
| ▶3 | P-A … P-E（框架打通，命令行可以出片） | 8 天 | 20.5 |
| ▶4 | P-G + P-H（CLI/AI + 首批 6 个预设） | 4 天 | 24.5 |
| ▶5 | G4 界面 | 3 天 | 27.5 |
| ▶6 | G5 MV 必需（不含子场景） | 4 天 | 31.5 |
| ▶7 | 子场景 / 拍扁容器 | 3 天 | 34.5 |

▶1 内部再按 W1 → W2 → W3 逐项做，每项做完、测完再开始下一项。

这里的"天"指 agent 的工作日估计，实际耗时受 Blender 渲染、内存限制和对方合并节奏影响。
MV 用的预设（12 种分段风格、全息卡、霓虹招牌、对位溶解、网点擦除、斜切、摩羯火花、DV 界面、雨、体积雾、AI 重绘离线处理）
在 ▶4 之后按需编写，不再单独请示（用户规则：写预设不用问）。

## 8. 改动管理

- **工作区**：`E:/MyProject/VedioMaker/.claude/worktrees/presets`，分支 `agent/presets-groundwork`。▶3 起另开 `agent/presets-framework`。
- **提交**：Conventional Commits，一个提交只做一件事；改求值、ops、存储的提交必须带测试。
- **日志**：`docs/CHANGELOG-presets.md`，每个提交记一条：改了什么、为什么、改了哪些文件、提交号、怎么回退。
- **回退**：单个提交用 `git revert <sha>`；整组不要了就删掉分支。
- **合并**：每次合并前 rebase 到最新 master，冲突我来解决；合并进 master 由你拍板。
- **验证**：
  - 单测按文件逐个跑：`node tests/<x>.test.mjs`。
  - 跑 `check:preview`、`blender:check`，以及 JS↔Python 对拍。
  - 用**临时项目副本**做 Electron 截图（不能指向 `projects/nightcity`）。
  - 截图由 DeepSeek 检查，我自己不看图。
- **内存**：Blender 渲染在前台分段跑，单段控制在 10 分钟以内；不同时开多个 Blender。

## 9. 拍板结果（2026-10-26）

1. **排期顺序**：按 §7；先单独做 W1 父子，再做 W2、W3。
2. **代码预设的安全**：首次启用**不需要**确认。
3. **子场景**：有用，放到最后（▶7）。
4. **汇报节奏**：一个功能完整做完、测试没问题之后汇报一次，中途不汇报。
