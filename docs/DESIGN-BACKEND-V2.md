# 后端重构 V2 · 单一求值 + 帧 IR + 代码图层 + 人机协作

> 状态：**D1–D7 全部获用户批准（2026-10-29），R0 可以开工**。B 编写。
> 实施：A 及 A 的子代理。B 只负责本计划，不参与实施（用户如另行安排，可由 B 按 §11 验收）。
> 与现有文档的关系见 §15。拍板情况见 §14。

---

## 0. 怎么用这份文档

- **给 A**：§1–§9 是"为什么、做成什么样"，§10 是工作包（WP），§12 是子代理规则。按 §10 的依赖图派活。
- **给子代理**：只读你领到的 WP，以及它"前置阅读"里列出的章节。每个 WP 都写明了要改哪些文件、
  不准碰哪些文件、对外接口、测试和验收标准。验收标准是数字，不是"看起来对"。
- 文中"现在"指 master `d751d0a` 加上 A 工作区里问题五的未提交改动。

---

## 1. 背景与目标

### 1.1 一句话

把现在的"**一份工程、一套求值语义、两个渲染器**"改成"**一份工程、一次求值、一份逐帧绘制清单（帧 IR）、
两个只照清单画的后端**"。在此基础上接入 Agent 擅长的代码技术栈（网页、Canvas、p5、着色器、three.js、Manim），
并保证做出来的东西人还能改。同时给人和 Agent 一套共用的测量与协作工具。

### 1.2 通俗版（给用户核对用）

现在像一个剧组：有一份剧本（工程文件），但有两个导演（预览、Blender）各自读剧本、各自理解。理解不一致时，
就出现"预览闪、成片正常"这类 bug（FIX 文档问题一、四、五）。特效要给两个导演各写一份说明，所以要写两遍。
重构后由一个"场记"统一读剧本，逐帧写出分镜表（帧 IR），两个导演只照表拍。特效和 Agent 写的小程序由一个
"美工"（编辑器自带的浏览器）统一画成图，两个导演都用这些图。

### 1.3 目标

| # | 目标 | 可量化的验收 |
|---|---|---|
| G1 | 预览与成片对同一帧的"有什么、在哪、谁挡谁"没有分歧 | 两个后端都只读帧 IR；`vdm_build.py` 里不再有求值代码（§10 R1 的检查脚本） |
| G2 | 2D 效果、代码图层只实现一次 | 画面类预设和代码图层只有浏览器实现；Blender 端只贴图 |
| G3 | Agent 能用网页、Canvas、p5、GLSL、three.js、Manim 做效果 | 每种技术栈有起步模板、契约检查和一个对拍用例 |
| G4 | Agent 做的东西人能改；人改过之后 Agent 还能接着改，互不覆盖 | 往返测试："Agent 写 → 用户改 → Agent 改 → 合并"，用户的修改一项不丢，冲突全部报告 |
| G5 | 人和 Agent 能精确报告、精确验证问题 | 本轮手工做过的探针（逐帧像素、遮挡、切镜边缘）都能用一条命令或一次点击复现 |
| G6 | 不变慢 | `check-playback-perf` 一直 PASS（p50 ≤ 20 ms，p95 ≤ 34 ms） |

### 1.4 不做的事

- 不推倒重来。不换语言，不引入 npm 依赖（核心保持零依赖），不改现有 ops 的语义。
- 不改人现有的操作方式（时间线、检查器、gizmo、关键帧、快捷键、撤销）。界面只有**新增**，见 §9。
- 不在本轮做 `scenes` 场景树迁移（ARCHITECTURE-REVIEW F10），也不做 DESIGN-PRESETS 的 G2 材质、灯光。

---

## 2. 现状：分歧在哪里（事实清单）

做得好、要保留的：

- 所有写入走 `core/ops.js` 的 `applyOp`；`application/project-service.js` 的 `transact()` 带 `expectedRev`、
  `requestId`、`dryRun`、`actorId`、`intent`；历史持久化在 `.vdm/transactions.json`。
- 相机在 JS 里逐帧烘焙（`engine/shot.js::bakeCameraTrackWorld`）；带空间父级的 2D 元素在 JS 里烘焙世界矩阵
  （`engine/element-bake.js::elementPixelMatrix` → `_world`）。**这就是帧 IR 的雏形**，本方案沿这条路扩展。
- Blender 的视图变换已经是 `Standard`、look 为 `None`（`vdm_build.py:1187`），烘焙出的图贴进去不会被二次映射颜色。
- 问题五（播放按帧取样）A 已在工作区实现（`main.js` 的 `pictureTime` / `setTime`），待提交。

两套实现、会产生分歧的地方：

| 方面 | 预览（JS） | 成片（Python / Blender） | 后果 |
|---|---|---|---|
| 关键帧、缓动、曲线、运动预设 | `core/curves.js`、`core/evaluate.js` | `vdm_build.py` 的 `sample_track`、`ease`、`_bezier_axis`、`sample_preset`、`motion_delta`、`eval_element`、`element_link_overlay` | 改一边忘一边就不一致 |
| 2D 平面前后顺序 | `spatial-layers.js` 排序 + 深度（问题四 `0cff172`） | 真实几何 + `layer_px` 偏移 | 问题一、四 |
| 文字 | 按相机倍率栅格化的贴图（`_textTexture`、`_textZoom`） | FONT 曲线（`build_text`） | 竖直方向约 20 px 偏差（DESIGN-PRESETS §8.5） |
| 画面效果（辉光、色差、颗粒、暗角、扫描线、调色） | `preview.js::_postAndComposite` | `vdm_build.py::build_compositor` | 写两遍，观感难对齐 |
| 每帧画哪些、怎么画 | `preview.js::computeLayers`（约 100 行，混着 GL 调用） | `build_scene` 自己再判断一遍 | 同上 |
| 预设（计划中） | `preview.glsl` | `blender.py` | DESIGN-PRESETS §4.2 计划每个预设写两份 |

缺的能力：

- 元素类型只有 `image / video / text / solid / shape / audio / camfeed`（`core/schema.js:15`），没有能运行代码的元素。
- 3D 对象类型里没有外部模型（`core/scene.js:22`），glTF 导入在 DESIGN-PRESETS M4 里，尚未实施。
- 应用内 AI（`ai.js` + `engine/agent.js`）只能一次性回一包 ops，不能出图、测量、多步执行。
- `docs/AGENT-PROTOCOL.md` 还在教 `transform.*` 和 `roll`，已经过时。
- 没有变更集、报告锚点、测量服务。验证都靠 B 手写的探针（`scripts/check-render-parity.mjs`、`check-playback-perf.mjs`、临时脚本）。

---

## 3. 目标架构

```
 真相（人和 Agent 编辑的）                     派生（随时可重算，只是缓存，放 .vdm/cache/）
 ┌──────────────────────────┐
 │ project.vdm.json          │─┐
 │ sources/<id>/             │ │ SourceService       ┌──────────────────┐
 │   manifest.json           │ ├──── 编译 ─────────→ │ 源快照 / 源动画轨  │─┐
 │   index.html | sketch.js  │ │ (RenderWorkerPool) └──────────────────┘ │
 │   shader.frag | scene.py  │─┘                                           │ core/frame-ir.js
 └──────────────────────────┘                                              ├─ buildFrameIR(project, frame)
                                                                           ▼
                         ┌────────────── 帧 IR（第 N 帧画什么、在哪、谁挡谁、套什么效果）──────────────┐
                         │ 原生图元（文字/色块/图片/视频/3D 对象）+ 光栅图层（代码图层、2D 效果的输出）  │
                         └───────┬───────────────────────────────────────────────────────┬──────┘
                                 ▼                                                       ▼
                     预览后端 preview.js（WebGL）                         导出后端 vdm_build.py（Blender）
                     只画 IR，不做判断                                   只画 IR，不做判断
                                 │                                                       │
                                 └──────── 光栅图层都来自 RenderWorkerPool（同一个 Chromium）──┘
```

原则：

- **P1 唯一真相**：工程文件加 `sources/` 目录。其余（源快照、源动画轨、烘焙帧、IR 缓存）都可以删掉重建。
- **P2 只求值一次**：`core/` 是唯一的求值实现。Python 端只读数值，不再计算任何曲线、缓动、链接、运动。
- **P3 后端只画**：前后顺序、可见性、深度偏移、时间取整都在 IR 里定死，后端照做。
- **P4 光栅只画一次**：凡是"一块像素"的东西（代码图层、画面类效果、2D 预设），只由 RenderWorkerPool 渲染，两个后端共用结果。
- **P5 时间只取整数帧**：`t = 帧号 / fps`。预览播放、逐帧、导出都用同一个取样器（问题五已在预览侧实现）。
- **P6 一切写入走事务**：人、CLI、MCP、Agent、编译器的写回，全部走 `transact()`，都进同一历史。

---

## 4. 帧 IR 规格（R0 的核心交付，冻结后其余 WP 才能并行）

### 4.1 入口

```js
// core/frame-ir.js — 纯 ESM，禁止 node:* 与 DOM
export const FRAME_IR_VERSION = 1;
export function buildFrameIR(project, frame, opts) -> FrameIR
//   opts = { camera: 'live' | <camId>, viewport: {w, h}, edit: {cam, mode} | null,
//            soloCameras: Set | null, cache: IRCache | null }
export function buildRangeIR(project, f0, f1, opts) -> Iterable<FrameIR>   // 导出用，流式
export class IRCache { constructor(); invalidate(changedIds); }            // 按 rev + changedIds 增量失效
```

### 4.2 结构

```jsonc
{
  "version": 1,
  "frame": 150, "t": 5.0, "fps": 30,
  "size": [1920, 1080],
  "camera": { "id": "cam_8", "world": [16], "fov": 50, "near": 0.5, "far": 5000,
              "dof": {}, "motionBlur": {} },
  "cameraLayers": [ /* 多相机叠层时，每层一个 {camera, rect, opacity, items} */ ],
  "items": [
    {
      "id": "s2_w4",                     // 元素或对象 id；代码图层的子图元为 "<id>#<node>"
      "kind": "text",                    // text | solid | image | video | shape | raster | object3d | camfeed
      "world": [16],                     // 每个项目像素的世界矩阵（与 element-bake 的 _world 同义）
      "size": [w, h],                    // 像素
      "crop": [l, t, r, b],              // 0..1 相对比例，编辑器层的裁切
      "opacity": 0.8,
      "blend": "normal",
      "depth": { "write": true, "bias": 3 },   // 写不写深度；同平面按 el.z 的层序偏移
      "drawOrder": 17,                   // 一致的全序，只用于半透明混合
      "content": { /* 按 kind：text 的排版与样式、image 的 src 与 uv、raster 的帧路径或 worker 句柄 */ },
      "effects": [ { "preset": "glow", "stage": "screen", "uniforms": {} } ],
      "source": { "id": "src_title", "node": "line2" }   // 来自源编译时才有
    }
  ],
  "screenFx": { "bloom": 0.6, "ca": 0.2 },
  "objects3d": [ /* 3D 对象：type、world、material 参数（数值已求好） */ ],
  "world": { /* 环境：雾、背景、城市快照 id */ }
}
```

规则：

1. `items` 已经剔除了这一帧不可见的元素（时间范围、相机独显、透明度为 0）。
2. 前后关系由 `depth`（写深度 + 层序偏移）决定，`drawOrder` 只用于半透明混合，必须是全序。
   规则从 `spatial-layers.js` 和问题四的实现原样搬过来，**行为不变**。
3. 所有数值是最终值：关键帧、缓动、链接（`link-eval.js`）、运动预设、父子、源层与编辑器层的合成（§7.3）都已算完。
4. `content.text` 携带排版结果（每行基线、字号、字距、字体文件），后端不再自己排版
   （文字几何的完全一致见 WP1.3）。
5. IR 可序列化为 JSON。导出时，静态属性只写一次，动画属性逐帧写（见 WP1.1 的压缩格式）。

### 4.3 性能预算

miku-swiss（138 元素、8 相机）：`buildFrameIR` 单帧 ≤ 3 ms（播放时 IRCache 命中后 ≤ 1 ms）。
超出预算不得合入，以 `check-playback-perf` 和 WP0.3 的微基准为准。

### 4.4 冻结记录（WP0.1 交付评审，2026-10-29 —— 本节以下全部**冻结**）

交付：`core/frame-ir.js`（`buildFrameIR` / `buildRangeIR` / `IRCache` / `elementPixelMatrix` /
`itemModelMatrix` / `cameraWorld16`）、`core/layers.js`（原 `app/renderer/js/spatial-layers.js` 的纯函数迁入，
原文件改为重新导出）、`tests/frame-ir.test.mjs`（10 项，含 demo 工程 0–576 帧的冻结快照
`tests/fixtures/frame-ir-golden.json`）。改动 §4 的字段或语义要升级 `FRAME_IR_VERSION` 并通知所有
进行中的 WP（§12）。

**与上面草稿的差异（评审要点，均已按此实现）**

| 项 | 冻结结果 | 为什么 |
|---|---|---|
| `world` | 列主序 4×4，把「四边形的**项目像素**坐标」映射到世界米。有 node / 父级的元素与 `elementPixelMatrix` 逐位相同（不取整）；旧屏幕路径的元素由同一套屏幕数据推出等价矩阵 | WP0.1 验收要求两者相同；两种元素走同一个绘制路径 |
| 四边形局部坐标 | lx, ly ∈ [-0.5, 0.5]，图片**上边**在 ly = +0.5，采样 `uv = (lx+0.5, 0.5-ly)`；`itemModelMatrix(item, size)` 是唯一的「IR → 顶点矩阵」转换 | 后端不再各自决定翻转；文字/图形/图片同一约定 |
| `size` | 项目像素；`null` = 内容自己排版（**只有 text**，WP1.3 之前测量在消费方） | 文字几何统一是 WP1.3；在那之前 IR 不假装会量字 |
| `content.uv` | **图片空间**（0,0 = 内容自己的左上）；`null` = 素材固有尺寸不在工程里，后端问素材。相机投屏的目标纹理是自下而上，翻转是后端的事 | 工程不存素材尺寸；WP4.1 编译时写入后再带 uv |
| `depth` | `{ write, bias }`；`write = 有 node/父级 && opacity ≥ 0.5`（原 `preview.js::DEPTH_ALPHA`），`bias = LAYER_DEPTH_M·el.z` 米，沿法线 | 问题四的规则原样搬进来，行为不变 |
| `drawOrder` | `items` 已按它排好，它是**主眼**（`opts.camera` / `opts.edit`）的混合顺序。投屏源相机各画各的图时，后端用 `core/layers.js::orderLayers` 就着 `plane` 重排——排序规则仍然只有一处 | 一帧只有一个主眼；多眼是投屏的内部需要 |
| 顺序的稳定性 | 同平面同 `el.z` 时按元素在 `project.elements` 里的下标（`src`）决胜：打乱输入数组，结果不变 | 验收项「drawOrder 是全序（打乱输入后结果相同）」 |
| `cameraLayers[]` | `{ id, name, active, opacity, picture: { scale, pivot, offset }, camera: { pos, look, roll, fov, focus, world }, near, far, dof, motionBlur }`。草稿里的 `rect` / `items` 不再需要：2D 元素是世界平面，不是每层一份清单 | 判定与 `preview.js::_drawCameraStack` 一致（透明度 < 0.002 或缩放 ≈ 0 的镜头层不出现） |
| `camera` | `pos / look / up / roll / fov / focus` 为权威值，`world` 是同一姿态的列主序相机世界矩阵（GL 约定：看 -Z、+X 右、+Y 上） | 给只吃矩阵的后端；两处数字同源 |
| `screenFx` | `{ bloom, ca, grain, scanline, vignette, grade, contrast, saturation }`；bloom 夹到 [0,3]，saturation 缺省 1 | 与合成着色器读法一致 |
| `objects3d` | 只放这一帧活着的对象：`{ id, type, world, size, opacity }`；图像/视频/文字的 `size` 是 [1,1,1]×scale，盒子按 geom | 与 `engine/shot.js::bakeObjects` 同源 |
| `world` | `{ source, hash }`；城市几何按 hash 取快照，IR 不装几何 | 城市生成在引擎侧（只有 node 能用），core 不能生成 |
| `effects` | 预留；本轮渲染器只用 `content.glow` | 画面效果与预设是 WP3.5 |
| `viewport` | 不参与 IR（IR 的单位是项目像素），只用于后端自己的帧缓冲 | 分辨率无关 |
| 数值卫生 | 矩阵里的 `-0` 归一化成 `0` | JSON 不能表示 -0，冻结的 IR 必须能原样往返 |

`IRCache` 的语义：键 = 帧号 + fps + 视角签名（camera / edit / solo）；条目只在**同一个 `rev`** 内命中；
`invalidate(changedIds)` 只丢掉绘制清单里出现这些 id 的帧，不传参数则全清。返回的 IR 视为只读。

**WP0.1 验收数字**（2026-10-29，master `09e243e` + 本包改动）

- 逐帧比对（`.scratch/wp0.1/compare.mjs`：同一份工程喂给旧 `Preview.prototype.computeLayers` 与
  `buildFrameIR`）：demo.json 0–576 帧、nightcity.json 0–240 帧、miku-swiss **副本** 0–450 帧——
  元素集合、混合顺序、`el.z` 数组顺序、每个矩阵**零差异**（旧侧是 `Float32Array`，最差数值差
  1.91e-6，属表示精度；`items[].world` 与 `elementPixelMatrix` 的差为 0）。
- 性能（138 元素 / 8 相机 / 451 帧）：`buildFrameIR` 冷启动平均 **1.52 ms**、p50 1.41、p95 2.56
  （预算 3 ms）；`IRCache` 命中 **0.001 ms**（预算 1 ms）。
- `npm test` 498/498（新增 10 项）、`npm run check:preview` PASS。

**给后续 WP 的两条约定**：WP0.2 的预览适配层只准调用 `itemModelMatrix` / `core/layers.js`，不准自己
推导翻转或层序；WP1.1 的 v3 shot 包按本节字段写 `static` / `tracks`，静态字段用 `items[]` 的原名。

---

## 5. RenderWorkerPool：单一光栅渲染器

### 5.1 做什么

一池隐藏的 Electron 离屏窗口（Electron 自带 Chromium，不新增依赖），对外只有一个接口：

```js
// engine/render-workers/pool.js
pool.render({ runtime, sourceId, params, frame, fps, size, seed }) -> { rgba | pngPath, hash, ms }
pool.renderRange({ ..., f0, f1, outDir }) -> 帧序列（.vdm/cache/raster/<hash>/f%05d.png）
pool.compile({ sourceId }) -> 源快照（§7）
pool.post({ framesDir, screenFx, outDir }) -> 套完画面效果的帧序列（§5.4）
```

### 5.2 确定性（契约强制）

- 画面必须是 `(代码, 参数, 帧号, 尺寸, 种子)` 的纯函数。
- 禁止 `Date.now`、`performance.now`、`requestAnimationFrame`、不带种子的 `Math.random`、`fetch`、`XMLHttpRequest`、`WebSocket`。
  运行时注入同名替身：随机数改为带种子，时间固定为当前帧。WP3.2 的契约检查会做静态扫描。
- 同一帧渲染两次，哈希必须相同（契约检查的一项）。

### 5.3 沙箱

- 离屏窗口：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；CSP 禁止一切网络请求。
- 通过自定义协议 `vdm-src://` 只暴露 `sources/<id>/` 和 `vendor/`（固定版本的 p5、three.js），其余文件一律不可见。
- 每帧耗时上限（默认 200 ms，导出时 2 s），超时即报错，不卡死引擎。

### 5.4 画面效果单一实现（取决于 D2）

推荐方案：Blender 不再做画面效果合成，改为输出 16 位 PNG；导出管线最后一步由 `pool.post`
用预览的同一份着色器（`_postAndComposite` 搬到 `core/` 外的共享 GLSL 文件）套效果，再交给 ffmpeg。
`build_compositor` 里的画面效果部分在对拍通过后删除。

### 5.5 缓存

键 = 哈希(源文件内容, manifest, 参数在该帧的值, 尺寸, 种子, 运行时版本, vendor 库版本)。
参数没动、代码没动就不重渲。缓存放在 `.vdm/cache/raster/`，可以随时删除。

---

## 6. 代码图层

### 6.1 数据

```jsonc
// 元素
{ "id": "el_rain", "type": "code", "start": 2, "duration": 4,
  "code": { "source": "src_rain", "params": { "density": 0.6, "color": "#9fd" }, "seed": 7,
            "size": [1920, 1080], "cache": "live" },     // live：预览实时画；bake：只用缓存帧
  "node": { /* 照常是一块 2D 节点平面：可以摆在 3D 里、旋转、被遮挡 */ } }
```

```jsonc
// sources/src_rain/manifest.json
{ "id": "src_rain", "runtime": "p5",          // canvas2d | p5 | glsl | three | html-live | manim
  "entry": "sketch.js", "libs": { "p5": "1.9.4" },
  "params": [ /* 沿用 DESIGN-TEMPLATES 的 PROPERTY 格式：id、label、type、unit、default、range、keyable */ ],
  "deterministic": true }
```

- 参数关键帧路径为 `code.params.<name>`，可以作为 `propLink` 的目标和来源（叠加方式沿用 `core/links.js` 的 `add` / `mul`）。
- 新 ops 登记在 `core/ops-ext.js`：`sourceAdd`、`sourceWrite`、`sourceRemove`、`codeParamSet`（关键帧走现有 `keySet`）。

### 6.2 运行时 SDK（注入到沙箱里的 `vdm` 对象）

```js
vdm.frame, vdm.t, vdm.fps, vdm.size        // 当前帧
vdm.param('density')                       // 已按关键帧和链接求好的值
vdm.random(i, k)                           // 带种子
vdm.beat, vdm.volume                       // 节拍、音量（来自工程）
```

- p5 使用 instance 模式，`draw` 由运行时逐帧调用，禁止 `loop()` 和 `frameRate()`。
- GLSL 只写片元着色器，运行时提供 `u_time`、`u_resolution` 和 `u_<param>`。
- three.js 由运行时创建 renderer，Agent 只写 `setup(scene, camera)` 和 `update(frame)`。

### 6.3 起步模板与契约检查

- 起步模板：`templates/code/<runtime>/`，`vdm source new --runtime p5` 生成，模板里已经内置契约。
- 契约检查（`vdm source check <id>`，也通过 MCP 提供）：
  1. 静态扫描禁用的 API；
  2. 同一帧渲染两次，比较哈希；
  3. 透明通道是否正常（全透明或全不透明时给提示）；
  4. 单帧耗时；
  5. manifest 里声明的参数是否真的被读取（防止 Agent 把关键数值写死）。

### 6.4 Manim（离线运行时）

- Python 子进程，命令 `manim render --format png --transparent`，参数通过 JSON 传入；路径受 `engine/path-policy.js` 限制。
- 走 `application/job-service.js` 后台执行；预览显示缓存帧，渲染中显示进度。
- 检测不到 manim 时，`vdm_capabilities` 标为不可用，相关入口置灰（见 D5）。

---

## 7. 源编译：HTML / SVG / three.js 静态场景 → 原生元素

### 7.1 编译

`application/source-service.js::compile(sourceId)`：

1. 在 RenderWorkerPool 里加载源。
2. 遍历所有带 `data-vdm-id` 的节点（SVG 用 `id`，three.js 用对象 `name`），读取 `getBoundingClientRect` 和 `getComputedStyle`，生成原生元素：
   - 文字节点 → `text`
   - 纯色块 → `solid`
   - `<img>` → `image`
   - 复杂样式（渐变、阴影、滤镜）→ 由 worker 栅格化成 `image`
3. 动画：
   - CSS `@keyframes` 和 Web Animations：用 `document.getAnimations()`，把 `currentTime` 逐帧设定后取样。
     能翻译的（`translate`、`scale`、`rotate`、`opacity`，以及 `cubic-bezier` 缓动）翻译成**源动画轨**上的原生关键帧；
   - 翻译不了的（JS 驱动）逐帧取样成只读源动画轨。
4. 结果：元素写入工程（走事务），并带上 `el.source = { id, node }`。源动画轨和本次的编译快照存入
   `.vdm/sources/<id>/base.json`。三方合并要用这份快照，所以它**不是可删除的缓存**。
5. three.js 静态场景用 GLTFExporter 导出 `media/<id>.glb`，作为 3D 对象导入。**依赖 DESIGN-PRESETS M4（外部模型导入）**，M4 未完成前跳过。

### 7.2 两层模型

| 层 | 内容 | 写的人 | 存放 |
|---|---|---|---|
| 源层 | 文字、排版、元素自身的动画 | Agent（用户改字、改色时写回） | `sources/<id>/` |
| 编辑器层 | 裁切、3D 位置与旋转、效果预设、蒙版、混合、用户加的关键帧 | 用户；Agent 通过 ops 也可以加 | `project.vdm.json`，挂在 `el.source.node` 对应的元素上 |

**分工规则（写进契约和协议文档）**：内容、排版、相对兄弟元素的运动写在源里；相对场景、世界、相机的运动和效果用编辑器。
契约检查在源里发现 `translateZ`、`perspective`、`rotateX`、`rotateY` 时给出提示："这是场景运动，请改用编辑器关键帧"。

### 7.3 同一属性两层都在动：叠加或接管

- `el.sourceMode = { "<path>": "add" | "mul" | "override" }`。默认值按单位决定，和 `links.js` 的 `combine` 规则相同：
  比例类（透明度、缩放）用 `mul`，其余用 `add`。
- 求值顺序固定为：**源层值 → 按模式合入编辑器层 → 链接 → 父子**，在 `buildFrameIR` 里完成。
- `override` 表示这条属性只听编辑器的，源动画被忽略，可以随时切回。

### 7.4 写回

| 用户的修改 | 处理方式 |
|---|---|
| 改文字 | 写回 DOM 文本 |
| 改颜色、字号、字体、字距、行高 | 写回该节点的行内样式 |
| 拖动位置、缩放、旋转（在流式排版里） | 不写回，记为编辑器层（`add` 模式的偏移） |
| 裁切、3D 旋转、效果、蒙版 | 本来就属于编辑器层，不写回 |

写回本身是一次事务（`sourceWrite`），可以撤销。契约要求源码属于"可写回子集"：关键样式写在行内或 CSS 变量里。
写回失败（选择器太复杂、有歧义）时自动降级为编辑器层，不会丢失修改。

### 7.5 Agent 怎么看到用户的修改

`vdm_source_read`（MCP）返回源码，并在每个节点上附一段**生成的**注释，汇总这个节点的编辑器层，
例如 `<!-- vdm: rotation.y=30°；裁切 右 20%；预设 辉光；透明度 接管 -->`。注释不写进源文件，只出现在给 Agent 看的视图里。

### 7.6 三方合并

重新编译时，对每个 `(节点 id, 属性)`：

| 上次编译快照 | 用户（编辑器层 / 写回） | Agent（新源码） | 结果 |
|---|---|---|---|
| a | a | b | 取 b |
| a | c | a | 保留 c |
| a | c | b | **冲突**，进报告，让用户选 |
| 节点存在 | 有编辑器层 | 节点被删除 | **冲突**："编辑器层无处挂靠" |
| text | 有编辑器层 | 类型变为 image | 能套用的照常套用（变换、裁切、效果），不能套用的进报告 |

冲突汇总成一个变更集（§8.1），状态为 `needs-decision`，在 UI 里逐条选择。

### 7.7 脱离源码

`sourceDetach` 操作：删除 `el.source`，元素变成纯原生元素。这是显式操作，可以撤销，不会自动发生。

---

## 8. 人机协作核心

### 8.1 变更集（ChangeSetService，`application/changeset-service.js`）

```jsonc
{ "id": "cs_…", "actorId": "agent:dsh", "intent": "歌词 2 加辉光并卡第 3 拍",
  "transactions": ["tx_…"], "status": "proposed | applied | reverted | needs-decision",
  "changed": [ { "id": "s2_w2", "path": "style.size", "before": 120, "after": 150 } ],
  "report": { /* §8.3 的差异报告 */ } }
```

- `proposed`：在影子工程上 `dryRun`，UI 可以在预览里切换前后对比；接受后才真正提交。
- **选择性撤销**：只撤销这个变更集。它改过的属性如果之后没被别人改过，就直接逆操作；如果被改过，标为冲突、进报告，不强行撤销。
- **锁定和范围**：Agent 的请求带范围（元素 id、时间段、分镜）。范围外或被锁定（`el.locked`，见 D4）的写入一律拒绝，
  返回 `PATH_OUTSIDE_SCOPE` / `LOCKED`。

### 8.2 测量服务（InspectService，`application/inspect-service.js`）

基于帧 IR，必要时调用后端出图：

| 接口 | 回答 | 对应本轮的手工探针 |
|---|---|---|
| `visibleAt(frame, camera)` | 这一帧可见的元素，以及各自的屏幕包围盒 | — |
| `stackAt(frame, camera, x, y)` | 这个像素上从前到后的元素和深度 | 问题一、四 |
| `coverage(id, f0, f1, camera)` | 逐帧可见像素数（有和没有该元素两次渲染做差） | 问题四 cam_8、问题五 |
| `bbox(id, frame, camera)` | 屏幕包围盒，到画面边缘和到相邻元素的距离 | — |
| `cutEdges()` | 元素起止离镜头切换点不到 1 帧的情况 | 问题五的全片扫描 |
| `beatOffset(id)` | 起止和关键帧到最近拍点相差几帧 | — |
| `parity(cases)` / `perf()` | 收编 `check-render-parity`、`check-playback-perf` | 问题一、三、四 |

同时以 MCP 工具（`vdm_inspect_*`）和 CLI（`vdm inspect …`）的形式提供。人用的报告工具和 Agent 的自检用的是同一套接口。

### 8.3 报告

- **Agent → 人（差异报告）**：由变更集前后对比**自动生成**，不由 Agent 自述。每条标注"已验证 / 未验证 / 没做"。
  证据是受影响帧的前后截图，加上相关的测量数值。Agent 的说法和实际差异对不上时标红。
- **人 → Agent（报告锚点）**：在预览上点选或框选时自动记录：
  帧、时间、相机、模式、渲染器、点或框的坐标、命中的元素栈（含被遮挡的）、这些元素当时的求值属性、截图裁切。
  用户再选一个现象标签，系统自动附上对应的测量：

  | 标签 | 自动附上 |
  |---|---|
  | 消失 / 闪烁 | 逐帧覆盖像素 + 逐帧遮挡关系 |
  | 遮挡 | 该点的元素栈 |
  | 位置 / 大小 | 包围盒和间距 |
  | 节奏 | 拍点偏差 |
  | 颜色 | 区域平均色、对比度 |
  | 卡顿 | 播放帧间隔 |
  | 预览和成片不一致 | 自动出一张 Blender 帧并做差 |

- 报告存成工单：`.vdm/reports/<id>.json`，状态为 待处理 / 已修 / 已验证。关单条件是在同一锚点上重跑同一组测量并达标。

### 8.4 Agent 运行方式升级

- `engine/agent.js`：从"一次回一包 ops"改为 MCP 工具循环：读 → 计划 → 提交变更集 → 出图 → 测量 → 修正。
  大任务先提交计划，用户批准后分步执行，每一步一个变更集。
- 协议单一来源：ops、属性路径、代码图层参数的 schema 放在 `core/contracts/`，由 `scripts/gen-contracts.mjs`
  生成 MCP 的 JSON Schema、`docs/AGENT-PROTOCOL.md` 和检查器字段描述。生成的文件不允许手改，有测试比对。
- "创作模式"与"微调模式"：创作模式取消"一次 1–6 个 op"的限制，允许用生成器（一段产出 ops 的代码）批量创建。

---

## 9. 前端变化（界面，A 的 UI 子代理负责）

**不变**：时间线、检查器、gizmo、关键帧、曲线面板、相机编辑、快捷键、撤销重做。

| 何时 | 变化 | 位置 |
|---|---|---|
| 问题五（已做） | 空格播放按片子帧率一格一格走 | `main.js` |
| R0 | 无可见变化（预览改为画 IR，画面必须逐像素不变） | `preview.js` |
| R2 | AI 修改在时间线上有标记；变更集审阅面板（整组接受、逐条接受、单独撤回、前后对比）；报告工具（点选框选 + 现象标签）；锁定开关（D4） | `ai.js`、`timeline.js`、`main.js`、新 `review.js`、`report.js` |
| R3 | 代码元素：检查器显示 manifest 参数行（带 ◆ 可打关键帧）；"查看源码"入口；渲染中状态 | `inspector.js`、新 `source-view.js` |
| R4 | 来自源的元素带来源标记；属性旁的"叠加 / 接管"切换；冲突选择对话框；"脱离源码"菜单项 | `inspector.js`、`timeline.js`、新 `conflict.js` |

每一批 UI 开工前，A 都要先把界面方案给用户批准（沿用现有规则）。

---

## 10. 分期与工作包

### 10.1 依赖图

```
WP0.0 ─→ WP0.1(IR 规格，冻结) ─┬─→ WP0.2 ─→ WP0.3 ─┬─→ R1: WP1.1 ─→ WP1.2 ─→ WP1.3
                                │                    │
                                │                    ├─→ R2: WP2.1 ─┬─→ WP2.4
                                │                    │      WP2.2 ─┤
                                │                    │      WP2.3 ─┘─→ WP2.5(UI)
                                │                    │
                                └────────────────────┴─→ R3: WP3.1 ─→ WP3.2 ─→ WP3.3 / WP3.4 ─→ WP3.5 ─→ WP3.6(UI)
                                                                                   │
                                                          R4（需 WP3.1、WP2.2）: WP4.1 ─→ WP4.2 ─→ WP4.3 ─→ WP4.4 ─→ WP4.5/4.6(UI)
                                                          R5（需 R3、R4；three 静态部分需 DESIGN-PRESETS M4）
```

可以并行的：R0 完成后，R1、R2、WP3.1 三条线可以同时开。
同一时间每个文件只属于一个 WP，文件归属见各 WP 的"改动文件"。

### 10.2 工作包

每个 WP 的统一格式：**目标 · 前置阅读 · 改动文件 · 禁止改动 · 步骤 · 测试 · 验收 · 估时**。
所有 WP 共同的验收门槛见 §11，下面只列各自额外的要求。

---

#### R0 地基：帧 IR（预览先切过去）

**WP0.0 提交问题五**
- 目标：把工作区里问题五的改动（`main.js`、`ai.js`）和"多选删除"那条线拆开，分别提交。
- 验收：`git status` 里不再有问题五相关的改动；FIX 文档的实施记录补上提交号。估时 0.5 天。

**WP0.1 IR 规格与构建器**
- 前置阅读：§3、§4；`app/renderer/js/preview.js::computeLayers / _nodePlane / _textZoom`、`spatial-layers.js`、`engine/element-bake.js`、`engine/shot.js`。
- 改动文件：新建 `core/frame-ir.js`、`core/layers.js`（把 `spatial-layers.js` 的纯函数迁过来，原文件改为重新导出，保持现有 import 可用）、`tests/frame-ir.test.mjs`。
- 禁止改动：`preview.js`、`vdm_build.py`（留给 WP0.2 和 R1）。
- 步骤：
  1. 把 `computeLayers` 里与 GL 无关的判断（可见性、相机、独显、节点平面矩阵、层序、深度标志）搬进 `buildFrameIR`；
  2. `items[].world` 与 `elementPixelMatrix` 对同一元素、同一帧给出相同矩阵（误差 ≤ 1e-9）；
  3. 实现 `IRCache`。
- 测试：
  - 用 `tests/fixtures` 和 miku-swiss 的**副本**，对 0–450 帧逐帧比对 `buildFrameIR` 与旧 `computeLayers` 的元素集合、顺序、矩阵；
  - `drawOrder` 是全序（打乱输入后结果相同）。
- 验收：逐帧比对零差异；单帧 ≤ 3 ms。**交付后由 A 组织评审并冻结 §4 的格式**，之后改格式要走变更流程（§12）。估时 2 天。

**WP0.2 预览只画 IR**
- 改动文件：`app/renderer/js/preview.js`（`render`、`computeLayers` 改为 IR 适配层、`_drawLayers`、`hitTest`）。
- 步骤：`render(t)` → `buildFrameIR` → 绘制。删除 `computeLayers` 里已经搬走的判断；`hitTest` 改为读 IR 的 `depth` 和 `world`。
- 验收：
  - miku-swiss 副本 0–450 帧，新旧预览逐帧读 canvas，**像素差为 0**（允许字形抗锯齿 ≤ 0.1% 像素差，超出要说明原因）；
  - 点选结果在 200 个随机点上与旧实现一致。
- 估时 2 天。

**WP0.3 IR 工具与基准**
- 改动文件：新建 `scripts/dump-ir.mjs`（任意帧的 IR 输出成 JSON，供人和 Agent 查看）、`scripts/bench-ir.mjs`。
- 验收：`check-playback-perf` PASS；`bench-ir` 报告单帧耗时并设门槛。估时 0.5 天。

---

#### R1 Blender 只画 IR

**WP1.1 shot 包 v3**
- 改动文件：`engine/shot.js`、`engine/element-bake.js`（并入 IR）、`core/version.js`（`RENDER_PLAN_VERSION = 3`）、`tests/shot.test.mjs`。
- 格式：每个元素 `{ static: {...首帧全部字段}, tracks: { "<字段>": { f0, values[] } } }`，只为真正变化的字段写逐帧值；
  帧号约定沿用 `round(t·fps) + 1`。
- 验收：v3 包能无损还原每一帧的 IR（测试逐帧比对）；miku-swiss 全片的包大小记录在 CHANGELOG。估时 1.5 天。

**WP1.2 `vdm_build.py` 只读数值**
- 改动文件：`blender/vdm_build.py`。
- 步骤：
  1. 新增 v3 读取路径；
  2. 用对拍 A–G 和 miku-swiss 抽帧确认一致后，删除 `sample_track`、`ease`、`_bezier_axis`、`_curve_mix`、`sample_preset` 及各 `_*_sample`、`motion_progress`、`punch_mul`、`motion_delta`、`element_link_overlay`、`baked_world`、`eval_element`；
  3. 层序和深度偏移改读 IR 的 `depth.bias`，不再自己按 `layer_px * z` 推导。
- 验收：
  - 对拍 A–G PASS；miku-swiss 每个镜头取 3 帧，新旧 Blender 输出像素差 ≤ 旧版的对拍容差；
  - 新增 `tests/no-python-eval.test.mjs`：扫描 `blender/*.py`，出现上述函数名即失败。
- 估时 2.5 天。

**WP1.3 文字几何统一（D6 已批准，R1 必做）**
- 内容：即 DESIGN-PRESETS §8.5：`core/glyphs.js` 解析字体并三角化，预览和 Blender 都画同一份网格，消除约 20 px 的竖直偏差。
- 验收：文字对拍用例（新增 H：多种字体、中英混排）像素差 ≤ 1%。估时 2 天。

---

#### R2 测量与协作核心（可与 R1 并行）

**WP2.1 InspectService**
- 改动文件：新建 `application/inspect-service.js`、`mcp/tools.js`（新增 `vdm_inspect_*`）、`cli/vdm.js`（新增 `inspect` 子命令）、`tests/inspect.test.mjs`。
- 验收：用新命令复现本轮三个手工探针，数值与 FIX 文档记录一致：
  - 问题四 cam_8 f142–158 的逐帧覆盖；
  - 问题五 `cutEdges` 在 rev 303 的数据上找出 `s1_w2`，在 rev 304 上为空；
  - 问题一 `stackAt` 给出正确的前后顺序。
- 估时 2.5 天。

**WP2.2 ChangeSetService**
- 改动文件：新建 `application/changeset-service.js`；`engine/project-repository.js`（事务记录增加 `changesetId`）；`mcp/tools.js`；测试。
- 元素锁定（D4 已批准，即 FIX 文档问题二第 3 项）：`core/schema.js` 增加 `el.locked`（对象、相机同理）；锁定的元素拒绝 Agent 写入（`LOCKED`），人仍可在检查器里修改；点选和框选跳过锁定元素的逻辑放在 WP2.5（`main.js`），时间线的锁定开关也在 WP2.5。
- 验收：选择性撤销的单测覆盖三种情况（无人再改、被别人改过、元素被删）；影子工程预演不写盘、不占 rev；锁定元素的 Agent 写入全部被拒绝。估时 3 天。

**WP2.3 契约单一来源**
- 改动文件：新建 `core/contracts/`（从 `ops.js`、`ops-ext.js`、`templates.js` 提取）、`scripts/gen-contracts.mjs`；生成 `docs/AGENT-PROTOCOL.md`，替换旧内容。
- 验收：生成结果和 `mcp/tools.js` 的 schema 由测试比对一致；协议里不再出现 `transform.*` 作为推荐写法。估时 1.5 天。

**WP2.4 Agent 工具循环**
- 改动文件：`engine/agent.js`、`app/renderer/js/ai.js`（只改数据流，界面放在 WP2.5）。
- 验收：用固定任务（"把 01 词2 改成 150 号字并卡到最近拍点"）走完 计划 → 变更集 → 出图 → 测量 → 报告 全流程；范围外写入被拒绝。估时 2 天。

**WP2.5 协作界面（UI 子代理）**
- 内容：§9 的 R2 一行。开工前界面方案先给用户批准。
- 验收：Electron 探针脚本覆盖 接受 / 拒绝 / 单独撤回 / 前后对比 / 点选生成报告锚点。估时 3 天。

---

#### R3 单一光栅渲染器 + 代码图层

**WP3.1 RenderWorkerPool**
- 改动文件：新建 `engine/render-workers/`（pool、离屏窗口、协议、沙箱、缓存）、`vendor/`（固定版本的 p5、three.js，附许可证）、测试。
- 验收：
  - 同一输入渲染两次哈希相同；
  - 沙箱测试：读本机文件、联网、访问 `process` 全部失败；
  - 超时会被终止；
  - Electron 未启动时（纯 Node 测试环境）明确报 `DEPENDENCY_MISSING`。
- 估时 3 天。

**WP3.2 `code` 元素、manifest、SDK、契约检查**
- 改动文件：`core/schema.js`（`ELEMENT_TYPES` 加 `code`）、`core/ops-ext.js`、新建 `core/code-layer.js`、`templates/code/{canvas2d,p5,glsl}/`、`cli/vdm.js`（`source new|check`）、测试。
- 验收：三个模板通过契约检查；故意写坏的样例（用 `Date.now`、不读参数、结果不确定）全部被检查出来。估时 2.5 天。

**WP3.3 预览接入代码图层**
- 改动文件：`app/renderer/js/preview.js`（IR 的 `raster` 项绘制）、`core/frame-ir.js`（`raster` 项）。
- 做法：`live` 模式通过 worker 取帧并贴成纹理；超出预算时自动改用缓存帧。
- 验收：一个 p5 图层在 3D 中倾斜摆放、被前景遮挡，预览与 Blender 对拍通过（新用例 I）；`check-playback-perf` PASS。估时 2 天。

**WP3.4 Blender 接入代码图层**
- 改动文件：`engine/blender.js`（导出前 `renderRange` 烘焙）、`blender/vdm_build.py`（`raster` 项按图像序列平面处理，复用视频平面路径）。
- 验收：对拍用例 I PASS；缓存命中时不重渲（日志可查）。估时 1.5 天。

**WP3.5 画面效果单一实现（取决于 D2）**
- 改动文件：把 `preview.js` 的效果着色器抽成共享文件 `app/renderer/shaders/post.glsl`；`engine/blender.js`（导出最后一步调用 `pool.post`）；`vdm_build.py`（删除 `build_compositor` 的画面效果部分，改为输出 16 位 PNG）；同时修订 `docs/DESIGN-PRESETS.md` §4.2：画面类预设只写一份 GLSL。
- 验收：对拍新用例 J（辉光、色差、颗粒、暗角全开），预览与成片像素差 ≤ 2%（颗粒用固定种子）。估时 2 天。

**WP3.6 代码图层界面（UI 子代理）**
- 内容：§9 的 R3 一行。估时 2 天。

---

#### R4 源编译与往返编辑

**WP4.1 HTML / SVG 编译**
- 改动文件：新建 `application/source-service.js`、`core/source-map.js`（CSS → 元素属性的映射表）、测试。
- 验收：样例集（标题卡、歌词排版、列表卡片、SVG 图标组）编译后，预览与浏览器原生渲染的同一帧像素差 ≤ 2%；CSS 动画翻译为关键帧后，逐帧位置误差 ≤ 0.5 px。估时 3 天。

**WP4.2 叠加 / 接管**
- 改动文件：`core/frame-ir.js`（§7.3 的求值顺序）、`core/schema.js`（`sourceMode`）、`core/ops-ext.js`、测试。
- 验收：三种模式的单测；未设置 `sourceMode` 的工程，IR 逐帧不变。估时 1.5 天。

**WP4.3 写回与 Agent 视图**
- 改动文件：`application/source-service.js`、`mcp/tools.js`（`vdm_source_read` / `vdm_source_write`）。
- 验收：§7.4 表中每一行各有一个测试；写回失败时降级为编辑器层并记日志。估时 2 天。

**WP4.4 三方合并、冲突、脱离源码**
- 改动文件：`application/source-service.js`、`application/changeset-service.js`、`core/ops-ext.js`（`sourceDetach`）。
- 验收：往返测试（G4）：Agent 写 → 用户做 10 种修改 → Agent 改源码 → 合并。非冲突修改一项不丢；冲突全部进报告；§7.6 表的每一行都有测试。估时 2.5 天。

**WP4.5 契约检查补充**：§7.2 的"内容归源、空间归编辑器"检查。估时 0.5 天。

**WP4.6 源编辑界面（UI 子代理）**：§9 的 R4 一行。估时 2.5 天。

---

#### R5 three.js 与 Manim

**WP5.1 three.js**
- 动画场景作为 `code` 图层（runtime `three`）；静态场景导出 glTF 导入为 3D 对象，**需要 DESIGN-PRESETS M4 先完成**。
- 验收：对拍用例 K。估时 2 天（不含 M4）。

**WP5.2 Manim**：§6.4。验收：一个公式动画模板的确定性测试 + 对拍。估时 2 天。

**WP5.3 对比基准**
- 内容：同一题目，Agent 一次走项目、一次在干净环境里直接写脚本出片。成片交给视觉模型盲评，再加客观指标。
  第一题是 A Rusty Dream MV：用之前直接写脚本做的版本作为干净环境那一边。
- 交付：`scripts/bench-agent/` 与报告模板；项目一侧输了的题目，要转成能力缺口条目。估时 2 天。

### 10.3 估时汇总

| 期 | 内容 | 估时 |
|---|---|---|
| R0 | 帧 IR + 预览切换 | 约 5 天 |
| R1 | Blender 只画 IR + 文字几何统一 | 约 6 天 |
| R2 | 测量、变更集（含锁定）、契约、Agent 循环、界面 | 约 12 天 |
| R3 | 渲染池、代码图层、画面效果单一实现、界面 | 约 13 天 |
| R4 | 源编译、合并、界面 | 约 12 天 |
| R5 | three.js、Manim、对比基准 | 约 6 天 |

R1、R2 与 WP3.1 可以并行，按两到三个子代理同时推进，日历时间约为总量的一半到三分之二。

---

## 11. 质量门槛（每个 WP 合入前都要过）

1. `npm test` 全部通过。
2. `node scripts/check-render-parity.mjs` 全部用例 PASS（A–G，以及之后新增的 H–K）。
3. `node scripts/check-playback-perf.mjs` PASS。
4. 涉及画面的 WP：用像素统计验收（读 canvas 或读 PNG 做差），**不靠肉眼看图下结论**。
5. 用户的工程（`projects/miku-swiss` 等）只读不写。测试一律复制到 `.scratch/` 再用，只复制 `project.vdm.json` 和 `media/`，不复制 `.vdm/`。
6. 每个 WP 单独提交，并在 `docs/CHANGELOG-presets.md` 记一行（日期、提交号、做了什么、为什么、改了哪些文件、怎么回退）。
7. 删除旧代码（例如 WP1.2 的 Python 求值）要放在独立提交里，并且排在"新路径已验证"的提交之后，确保能单独回退。

---

## 12. 子代理工作规则

- **一个子代理一个 WP**，在自己的 worktree 和分支（`agent/wp-<编号>`）上工作，完成后由 A 审查并合入 master。
- **文件归属**：只改 WP 写明的"改动文件"。需要改别的文件时，先报告 A，由 A 协调，不得自行修改。
- **接口冻结**：§4 的 IR 格式在 WP0.1 评审后冻结。之后任何改动都要写进本文 §4 并升级 `FRAME_IR_VERSION`，
  通知所有正在进行的 WP。
- **不扩大范围**：做 WP 时发现的其他问题，记下来交给 A，不顺手修。
- **交付报告格式**：
  - 改了哪些文件；
  - 测试结果（贴出命令和输出摘要）；
  - 验收数字（逐条对应 WP 的验收项）；
  - 已知遗留；
  - 回退方法。
- **卡住时**：某个验收项做不到，如实报告卡在哪里、试过什么，不要降低标准后宣称完成。

---

## 13. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 每帧构建 IR 拖慢预览 | 播放卡顿 | IRCache 增量失效；性能门槛卡在每个 WP 上 |
| R0、R1 改的是两个渲染器的输入 | 画面回退 | 逐帧零差异比对；旧代码在新路径验证后才删，并且可以单独回退 |
| 不同显卡上 Chromium 光栅结果有细微差异 | 跨机器复现不一致 | 预览和导出在同一台机器上没有影响；跨机器时固定渲染参数，必要时导出改用软件渲染 |
| 16 位 PNG 加浏览器后处理（D2）让导出变慢 | 导出时间变长 | 只在开了画面效果时走这条路；记录导出耗时基线 |
| Agent 写出不可写回的 HTML | 往返编辑退化 | 契约限制为可写回子集；写回失败自动降级为编辑器层，不丢修改 |
| Manim 依赖外部 Python | 环境不一致 | 作为可选能力，检测不到就禁用（D5） |
| 多个子代理并行改同一文件 | 合并冲突 | 文件归属表加接口冻结；A 统一合入 |

---

## 14. 待用户拍板

| # | 事项 | B 的建议 |
|---|---|---|
| **D1** ✅ 已批准 | 以"帧 IR + 两个只画 IR 的后端"作为重构核心，并据此修改 `ARCHITECTURE.md` 的总纲 | 同意 |
| **D2** ✅ 已批准 | 画面效果（辉光等）只保留浏览器一份实现：Blender 输出 16 位 PNG，由浏览器后处理；或者保留两份实现、靠对拍约束 | 只保留一份 |
| **D3** ✅ 已批准 | 源编译后以源码为准，加上编辑器层和三方合并（§7）；或者编译后以原生元素为准 | 以源码为准 |
| **D4** ✅ 已批准 | 元素锁定开关（FIX 文档问题二第 3 项）是否随 WP2.2 和 WP2.5 一起做 | 一起做，Agent 的权限范围要用到它 |
| **D5** ✅ 已批准 | Manim 作为可选外部依赖：检测不到就禁用，不破坏零依赖原则 | 同意 |
| **D6** ✅ 已批准 | 文字几何统一（WP1.3）是否放进 R1 | 放进 R1，顺带消除约 20 px 的竖直偏差 |
| **D7** ✅ 已批准 | 实施顺序 R0 → (R1 ∥ R2 ∥ WP3.1) → R3 → R4 → R5 | 同意 |

---

## 15. 与现有文档的关系

| 文档 | 关系 |
|---|---|
| `ARCHITECTURE.md` | D1 通过后，总纲改为"一份工程、一次求值、一份帧 IR、两个只画 IR 的后端"（WP0.1 一并修改） |
| `ARCHITECTURE-REVIEW.md` | 应用服务层和每项目一个运行时的规划不变；本文新增 4 个服务都按它的结构放在 `application/` 下 |
| `DESIGN-PRESETS.md` | §4.2：画面类预设只写一份 GLSL，`blender.py` 只用于必须与 3D 场景互动的预设，并且必须配对拍（WP3.5 修订）。§4.3"求值只写一遍"与本文一致。§8.5 文字几何即 WP1.3 |
| `FIX-LAYER-ORDER-EMPTY-CLICK.md` | 问题一、四的排序和深度规则搬进 `core/layers.js` 和 IR，行为不变；问题五由 WP0.0 提交 |
| `SPEC-MCP.md`、`SPEC-CLI.md` | WP2.1、WP2.3、WP4.3 新增工具和子命令时同步更新 |
| `AGENT-PROTOCOL.md` | 改为由 WP2.3 自动生成 |
