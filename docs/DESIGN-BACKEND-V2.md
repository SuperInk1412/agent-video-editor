# 后端重构 V2 · 单一求值 + 帧 IR + 代码图层 + 人机协作

> 状态：**D1–D7 全部获用户批准（2026-10-29），R0 可以开工**。B 编写。
> **2026-10-30 修订（用户批准 D7′、D8、D9）**：R0、R1 已完成；剩余工作改为按真实依赖分四条线并行，
> 先做准备包 WP-P 和接口冻结包 WP4.0，验收交给 B。**排期以 §10.4 为准**，§10.1 的依赖图和 §10.3 的估时仅作历史参考。
> 实施：A 及 A 的子代理。B 不参与编码，负责计划和独立验收（§10.4.5）。
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

### 4.4 冻结记录（WP0.1 交付 + 评审修订，2026-10-29 —— 本节以下全部**冻结**，`FRAME_IR_VERSION = 2`；v3 见本节末尾）

交付：`core/frame-ir.js`（`buildFrameIR` / `buildRangeIR` / `IRCache` / `elementPixelMatrix` /
`itemModelMatrix` / `mediaUVOf` / `cameraWorld16`）、`core/layers.js`（原 `app/renderer/js/spatial-layers.js`
的纯函数迁入，原文件改为重新导出）、`engine/element-bake.js`（改用 IR 的像素矩阵，仍在序列化时取 6 位小数）、
`tests/frame-ir.test.mjs`（14 项，含 demo 工程 0–576 帧的冻结快照 `tests/fixtures/frame-ir-golden.json`）。
改动 §4 的字段或语义要升级 `FRAME_IR_VERSION` 并通知所有进行中的 WP（§12）。

**与上面草稿的差异（评审要点，均已按此实现）**

| 项 | 冻结结果 | 为什么 |
|---|---|---|
| `world` | 列主序 4×4，把「四边形的**项目像素**坐标」映射到世界米。有 node / 父级的元素与 `elementPixelMatrix` 逐位相同（不取整）；旧屏幕路径的元素由同一套屏幕数据推出等价矩阵 | WP0.1 验收要求两者相同；两种元素走同一个绘制路径 |
| 四边形局部坐标 | lx, ly ∈ [-0.5, 0.5]，图片**上边**在 ly = +0.5，采样 `uv = (lx+0.5, 0.5-ly)`；`itemModelMatrix(item, size)` 是唯一的「IR → 顶点矩阵」转换 | 后端不再各自决定翻转；文字/图形/图片同一约定 |
| `size` | 项目像素；`null` = 内容自己排版（**只有 text**，WP1.3 之前测量在消费方） | 文字几何统一是 WP1.3；在那之前 IR 不假装会量字。**v4**：有字体时文字在 core/ 排版，`size` 就是排版框（见本节末尾 v4 段） |
| `content.uv` | **图片空间**（0,0 = 内容自己的左上）；`null` = 素材固有尺寸不在工程里，后端用 `mediaUVOf(fit, iw, ih, size)`（唯一实现）。`stretch` 用整张图，其余（含 `contain`）按 **cover** 裁——2D 元素是全幅平面，没有黑边。相机投屏的目标纹理是自下而上，翻转是后端的事 | 工程不存素材尺寸；避免第三个 coverUV 实现；WP4.1 编译时写入固有尺寸后再带 uv |
| `content`（v3 新增 `raster` 项） | `code` 元素产出一个 `kind: "raster"` 的 item，`content = { source: { id, runtime }, params（**这一帧**求好的值，来自 `core/code-layer.js::codeLayerPlan`）, seed, size（光栅像素尺寸 = `code.size`，缺省项目尺寸）, mode: "live" \| "bake"（= `code.cache`） }`。四边形 `size` 仍是整幅项目画布（与 image / video 同义），光栅铺满四边形（uv 全幅，故不带 `uv`）。`drawOrder` / `plane` / `src` / `z` / `opacity` / `blend` / `crop` / `effects` / `source` / `content.glow` 与普通 2D 项完全相同 | 光栅只有一份实现（渲染池，§5）；IR 只带请求、不带像素；参数在 core 一次算完，消费方不再求值（P2） |
| `depth` | `{ write, cut, bias }`；`write = 有 node/父级 && opacity ≥ 0.5`（原 `preview.js::DEPTH_ALPHA`），`cut` 是深度专用遍的 `u_aCut`（同一个 0.5），`bias = LAYER_DEPTH_M·el.z` 米，沿法线。写深度的后端必须画两遍：先 `cut`  discard 的深度遍，再 `u_aCut = 0` 的颜色遍，否则文字框会在背后挖洞 | 问题四的规则原样搬进来；两遍配方不能靠后端猜 |
| `drawOrder` | `items` 已按它排好，它是**主眼**（`opts.camera` / `opts.edit`）的混合顺序。投屏源相机各画各的图时，后端用 `core/layers.js::orderLayers` 就着 `plane` 重排——排序规则仍然只有一处 | 一帧只有一个主眼；多眼是投屏的内部需要 |
| 顺序的稳定性 | 同平面同 `el.z` 时按元素在 `project.elements` 里的下标（`src`）决胜：打乱输入数组，结果不变 | 验收项「drawOrder 是全序（打乱输入后结果相同）」 |
| `cameraLayers[]` | `{ id, name, active, opacity, picture: { scale, pivot, offset }, camera: { pos, look, roll, fov, focus, world }, near, far, dof, motionBlur }`。草稿里的 `rect` / `items` 不再需要：2D 元素是世界平面，不是每层一份清单 | 判定与 `preview.js::_drawCameraStack` 一致（透明度 < 0.002 或缩放 ≈ 0 的镜头层不出现） |
| `camera` | `pos / look / up / roll / fov / focus` 为权威值，`world` 是同一姿态的列主序相机世界矩阵（GL 约定：看 -Z、+X 右、+Y 上） | 给只吃矩阵的后端；两处数字同源 |
| `screenFx` | `{ bloom, ca, grain, scanline, vignette, grade, contrast, saturation }`；bloom 夹到 [0,3]，saturation 缺省 1 | 与合成着色器读法一致 |
| `objects3d` | 只放这一帧活着的**可画**对象（`solid/shape/text/image/video/container`，`empty/camera/audio` 不画）：`{ id, type, world（单位基，含 pivot 与父级）, size（geom × |scale|）, opacity, color, emissive, media/text, frame（视频） }` | 与 `engine/shot.js::bakeObjects` 同形；`world` 与 `size` 不重复乘 scale |
| `world` | `{ source, background, hash }`；城市几何按 hash 取快照（`opts.city` 传进来，`hash` 来自它），IR 不装几何；工程没有 world 时 `source = 'none'` | 城市生成在引擎侧（只有 node 能用），core 不能生成；清屏色是画一帧需要的 |
| `effects` | 预留；本轮渲染器只用 `content.glow` | 画面效果与预设是 WP3.5 |
| `meshes`（v4 新增） | `{ id: { vertices, indices, color, opacity, size } }`，顶点是四边形局部像素（原点左上、y 向下，0..size）；文字 item 用 `content.mesh` 引用。没有字体 / 格式不支持 / 样式走旧路径时整条为空 | 文字几何只做一次（§8.5、WP1.3），两个后端画同一份三角形；`size` 让记录自解释，`color/opacity` 只是生成时刻的样式 |
| `viewport` | 不参与 IR（IR 的单位是项目像素），只用于后端自己的帧缓冲 | 分辨率无关 |
| 数值卫生 | 矩阵里的 `-0` 归一化成 `0` | JSON 不能表示 -0，冻结的 IR 必须能原样往返 |

`IRCache` 的语义：键 = 帧号 + fps + 视角签名（camera / edit / solo）+ 城市快照 hash；条目只在**同一个 `rev`**
内命中；`invalidate(changedIds)` 只丢掉绘制清单里出现这些 id 的帧，不传参数则全清。**边界**：`changedIds`
只认「这一帧画过谁」，所以元素的时间范围、可见性、层序、相机变化也要用无参数 `invalidate()` 全清（预览在
`setProject` 时直接换一个新缓存，不受影响）。返回的 IR 视为只读。

**评审修订（v1 → v2，2026-10-29）**：独立评审在 WP0.1 交付后提出 5 条阻塞项，均已在 `51d1f85` 修正并升版：

| # | 问题 | 修订 |
|---|---|---|
| B1 | `scale = 0` 被 `\|\| 1` 兜底成 1，两条路径方向还不一样（旧渲染器就不一样） | 逐分支复刻旧行为：屏幕路径 0 = 零尺寸（不可见），节点路径 0 = 满尺寸（`Math.abs(x \|\| 1)`，bug-compatible），已写进 §4.4 与单测 |
| B2 | `content.uv` 对真实工程永远是 `null`（没有 op 写素材尺寸），且不看 `fit`（`stretch` 被裁） | 导出 `mediaUVOf`，`stretch` 短路；文档写明 `contain` 实际按 cover；后端只调这一个函数 |
| B3 | `objects3d` 与 `bakeObjects` 不同源：空物体/相机被画成方块，`world` 已含 scale 又乘一次 | 可画类型集与 shot.js 一致；`world` 出单位基、`size` 只带一次 scale；补 `color/emissive/media/text/frame` |
| B4 | 冻结的「多眼重排」配方不能执行：`orderLayers` 读 `el.z`，IR 项只有 `z` | `compareLayerStack` / `layerZ` 认顶层 `z`（渲染器层回退 `el.z`，行为不变），加单测 |
| B5 | 没有「扁平 / 世界」模式字段，后端只能去读 `scene3d.city` | 决定：**扁平路径在 WP0.2 退役**——没有 3D 快照时用同一世界路径 + 屏幕投影画 IR 四边形。唯一已知画面变化：这十几帧里斜放/挂父级的 2D 元素按真实位置画（以前按屏幕变换）。验收口径 = 有相机（有世界）的工程，miku-swiss 全片适用 |

顺带修的（评审 S1–S8）：`depth.cut` 进 IR；`itemModelMatrix` 无 `size` 时返回 `null`（不画零矩阵）；
`camera.up` 跟随 `world` 里的 roll；帧基写明（**IR 帧号 0 基**，`t = frame / fps`；WP1.1 的 shot v3 `f` 是
1 基 = `frame + 1`）；`content.size` 改名 `content.fontSize`（与四边形 `size` 区分）；缓存键含城市 hash；
`-0` 归一化覆盖 `objects3d`；`buildFrameIR` 的 `opts` 加 `city`。

**验收数字**（2026-10-29；WP0.1 见 `2d71d82`，评审修订见 `51d1f85`）

- 逐帧比对（`.scratch/wp0.1/compare.mjs`：同一份工程喂给旧 `Preview.prototype.computeLayers` 与
  `buildFrameIR`）：demo.json 0–576 帧、nightcity.json 0–240 帧、miku-swiss **副本** 0–450 帧，
  共 **1269** 帧（nightcity 那 241 帧是空工程，实际有内容的 1028 帧）——元素集合、混合顺序、`el.z`
  数组顺序、每个矩阵**零差异**（旧侧是 `Float32Array`，最差数值差 1.74e-6，属表示精度；
  `items[].world` 与 `elementPixelMatrix` 的差为 0）。
- 性能（138 元素 / 8 相机 / 451 帧）：`buildFrameIR` 冷启动平均 **1.13 ms**、p50 1.03、p95 1.97、
  偶发 max 3.58（GC；预算 3 ms 按平均/分位计）；`IRCache` 命中 **0.001 ms**（预算 1 ms）。
- `npm test` 502/502（新增 14 项）、`npm run check:preview` PASS、`check-render-parity` PASS
  （144 格 1 格不同，允许 4）、`check-camfeed` PASS、`check-playback-perf` PASS（59.7 fps）。

**R0 状态（2026-10-29）**：WP0.0 `6a3bf78`+`1d40497`、WP0.1 `2d71d82`（评审修订 `51d1f85`）、WP0.2 `39809dd`、
WP0.3 `cfa151c`——全部合入 master，§4 冻结。**R1、R2、WP3.1 可以并行开工**（子代理一包一分支 `agent/wp-<编号>`，
文件归属见各 WP，合入前过 §11 的四道门）。

**WP0.2（预览只画 IR，`39809dd`）**：`preview.js` 的 `computeLayers` 变成 IR 适配层（只把内容解析成纹理），
`_drawLayers` 每条 item 一个世界四边形，`hitTest` / 选框 / gizmo 读 `world`；屏幕矩阵分支
（`u_world` 0/1、`u_px2w`、`u_z`、`u_carry`）从渲染器删除。像素验收（miku-swiss 副本 0–450 帧，
旧渲染器冻结副本 vs 新实现，960×540 与 1920×1020 两种画布）：**452/452 帧逐像素完全相同（0 个不同
像素）**，点选 200/200 一致；预览 JS 从约 2.5 ms/帧降到 1.3 ms（IR 缓存）。

**给后续 WP 的两条约定**：WP0.2 的预览适配层只准调用 `itemModelMatrix` / `core/layers.js`，不准自己
推导翻转或层序；WP1.1 的 v3 shot 包按本节字段写 `static` / `tracks`，静态字段用 `items[]` 的原名。

**v3 变更（WP3.3，2026-10-29）**：`FRAME_IR_VERSION = 3`，**只新增一种 item，没有改任何已有字段的语义**
（`tests/fixtures/frame-ir-golden.json` 重新生成后，demo 工程 0–576 帧除 `version` 外逐字段不变）：

1. `code` 元素产出一个 `kind: "raster"` 的 item（字段见上表新增行）。参数由 `core/code-layer.js::codeLayerPlan`
   逐帧求好——manifest 默认值、`code.params.*` 关键帧、`propLink`（add / mul）都算完，消费方只把
   `content.source / params / seed / size / mode` 转发给渲染池，不再求值（P2）。`mode` 是**消费策略**而不是画面数据：
   `live` 允许按需渲染，`bake` 只读 `.vdm/cache/raster/`。
2. 像素只有一个来源：`engine/render-workers/pool.js`（§5，P4）。预览**不在渲染进程里跑用户代码**，
   而是 `GET /api/raster?source=<id>&frame=<n>&w=<px>&h=<px>&params=<urlencoded json>&seed=<n>[&mode=bake]`
   取一帧 PNG（`image/png` + `Cache-Control: no-store`，命中缓存直接回缓存帧，错误走既有 JSON 错误格式与状态码）。
   预览侧：同一 `(source, frame, size, params, seed)` 只请求一次，成功前该项不画，播放时预取下一帧（最多 2 个在途），
   `> 300 ms` 或请求失败退到同通道最近一次成功的帧，纹理按该键复用并按上限淘汰（不每帧新建、不漏显存）。
3. Blender 侧见 WP3.4（`raster` 项按图像序列平面处理，复用视频平面路径）；本轮 `blender/*` 未改。

**v4 变更（WP1.3，2026-10-30）**：`FRAME_IR_VERSION = 4`。文字几何统一到 core/：**排版和三角化只做一次**，
两个后端画同一份网格（DESIGN-PRESETS §8.5，消除预览与成片之间约 20 px 的竖直偏差）。
没有改任何已有字段的语义，只新增三个东西：

1. **item 上**：`kind: "text"` 的 item 多一个 `content.mesh`（网格 id 字符串，如 `h_ab12cd…`）和
   `size = [w, h]`（`core/glyphs.js::layoutText` 排出来的框，项目像素）。**没有字体时这两个字段是 `null`**：
   消费方照旧自己量字（v3 行为），这条是回落路径，不是降级。
2. **顶层 `meshes`**（自包含，IR 仍可整体 JSON 化）：
   `{ "<id>": { "vertices": [x0,y0,…], "indices": [i0,i1,i2,…], "color": [r,g,b], "opacity": 1, "size": [w,h] } }`。
   顶点是**四边形局部像素，原点左上、y 向下**，范围 0..size；消费方按本节的贴图约定映射：
   `lx = x/size[0] - 0.5`、`ly = 0.5 - y/size[1]`，再乘自己的 `itemModelMatrix` / `world × size`。
   `indices` 是三角形列表（三角形不需要绕序约定：两个后端都不做背面剔除）。
   `size` 让记录自解释（顶点要以什么框为基准居中），`color` / `opacity` 是**生成时刻的样式**——
   逐帧可变的是 item 自己的 `content.color` 与 `opacity`（淡入淡出不产生新网格）。
3. **去重键** = 字体内容哈希 + 文本 + 字号 + 字距 + 行高 + 对齐（`core/glyphs.js::textMeshId`）。
   颜色 / 不透明度**不进键**：它们逐帧可变，进键会让每一次淡入淡出都生成一条网格。
   同一个键在一帧的 `meshes` 里只出现一次，多帧相同的网格在 v3 包里只存一份。

`buildFrameIR(project, frame, opts)` 新增两个可选参数（不是 IR 的一部分）：
`opts.fonts`（`{ [字体名]: Uint8Array }` 或 `name -> Uint8Array | null` 的解析器）和
`opts.textCache = { fonts, glyphs, meshes }`（三张 Map：解析后的字体、字形模板、网格记录）。
**core 不读文件**：预览通过 `GET /api/font?font=<家族名或项目内路径>` 取字节（只读路由，白名单目录 +
`.ttf/.otf/.ttc`，其余 403），成片在 `engine/shot.js` 里按项目根取字节。字体格式：TrueType
（`glyf`/`loca`，含复合字形，`cmap` 4/12，`ttcf` 取第一个 face）已实现；CFF/OTF 抛 `UNSUPPORTED_FONT`，
调用方回落旧路径。逐字回退：item 的字体缺某个字时，按本项目其他字体（稳定排序）找一个有的；全都没有
⇒ 整条回落到旧路径（不画空洞）。`shadow > 0` 或 `stroke` + `strokeWidth > 0` 的样式同样留在旧路径。

消费方：预览按 mesh id 缓存一个 VBO/VAO（顶点预换算成 `lx, ly`），纯色 + `u_opacity` + `u_glow`；
Blender 用 `from_pydata` 建同一个三角形列表（顶点换成 `(x - w/2, h/2 - y)`），材质颜色 = `color`，
不再建 FONT 曲线。v3 包把 `meshes` 一起带走（`buildShotV3` 顶层 `meshes`、`frameFromShotV3` 只还原
这一帧用到的那些），Blender 端不需要字体文件。

**验收数字**（2026-10-30，WP1.3 见下文状态）：文字对拍用例 H（两种字体、3 行、中英日混排，1920×1080
逐像素）预览 vs 成片差 **0.43 %**（阈值 >24 灰阶，允许 1 %）；A–G 仍 PASS（144 格差 1 格，允许 4）；
miku-swiss 副本 0–450 帧：**隐藏文字后新旧预览 452 帧逐像素相同（0 个不同像素）**，文字框内的差异
只是边缘抗锯齿；成片文字竖直位置从比预览高 24–27 px 移到**与预览完全相同**（0 px）。

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

### 7.8 冻结记录（WP4.0 交付，2026-10-30 —— 本节以下全部**冻结**，`SOURCE_SNAPSHOT_VERSION = 1`）

交付（只有文档、夹具与一个常量，**不含实现**）：本节冻结 R4 内部的四个接口；`tests/fixtures/sources/`
的前五个夹具（§10.4.6）；`tests/fixtures-sources.test.mjs`（纯文件与 schema 校验，不跑浏览器/Blender）；
`core/version.js::SOURCE_SNAPSHOT_VERSION`。`.vdm/sources/` 的读写、`sourceMode` 的求值、写回与合并的
**执行**分别属于 WP4.1–4.4。

改本节任何一个字段或语义 = **升级 `SOURCE_SNAPSHOT_VERSION`**，并在同一个提交里同步：`core/version.js`、
本节、`tests/fixtures/sources/` 与 `tests/fixtures-sources.test.mjs`、`application/source-service.js`（4.1/4.3/4.4）、
`core/source-map.js` 与 `core/source-merge.js`（4.1/4.4）、`core/frame-ir.js`（仅 4.2）、
`application/changeset-service.js`（4.4）、`docs/SPEC-PROJECT.md` 的 `el.source` / `el.sourceMode` 字段表；
然后通知 4.1–4.6 与界面线（§12）。老版本快照**重新编译**，不静默迁移；比本节新的 `version`
按"缺源"降级（§7.8.2），不猜字段。

#### 7.8.1 源编译快照 `.vdm/sources/<id>/base.json`

**谁写谁读**：`application/source-service.js::compile` 是唯一写入方（在 RenderWorkerPool 里加载源、逐帧取样、
算哈希）；读方是 `core/frame-ir.js`（4.2，通过 `buildFrameIR` 的 `opts.sourceSnapshots`）、
`source-service.js::writeBack`（4.3，查节点与可写回路径）、`merge`（4.4）和 `vdm_source_read`（4.3 生成的注释）。
它**不是可删除的缓存**（§7.1）：三方合并拿它当 `base`，删掉就等于失去"上次编译"的基准。

文件头五个键 + 载荷 `nodes`（不多不少，顺序无所谓）：

| 键 | 类型 | 谁写 | 说明 |
|---|---|---|---|
| `version` | int | compile | `SOURCE_SNAPSHOT_VERSION`，现在是 `1`；不等于 1 = 整份按缺源降级 |
| `source` | string | compile | 源 id（= 目录名，规则同 `core/code-layer.js::isSafeSourceId`） |
| `compiler` | object | compile | `{ name, version, runtime, entry }`；诊断用，**不进哈希** |
| `builtAt` | string | compile | ISO 8601 UTC（毫秒）；**不进哈希**，合并时不比较 |
| `hash` | string | compile | `sha256:<64 位小写十六进制>`，口径见下 |
| `nodes` | array | compile | 节点记录，**按 `id` 升序**；同一 `id` 只允许一条 |

节点记录：

```jsonc
{ "id": "n_line_1",            // data-vdm-id；规则 ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$，快照内唯一
  "type": "text",              // text | solid | shape | image
  "parent": null,              // 可选：最近的带 data-vdm-id 的祖先节点 id；只给 UI/合并参考，4.x 不据此建父子
  "props": { "style.text": "第一句歌词", "style.size": 96, "transform.x": -420, "transform.opacity": 1 },
  "tracks": [ { "t": 0,    "path": "transform.opacity", "value": 0, "ease": "easeInOut" },
              { "t": 0.4,  "path": "transform.opacity", "value": 1, "ease": "linear" },
              { "t": 0,    "path": "transform.y",       "value": 184, "ease": "outExpo" },
              { "t": 0.4,  "path": "transform.y",       "value": 160, "ease": "linear" } ] }
```

- `type`：编译器只产出 `text`（文字节点）、`solid`（纯色块）、`shape`（几何/图形）、`image`
  （`<img>`，或渐变/阴影/滤镜这类复杂样式由 worker 栅格化的结果，媒体路径写在 `props.src`）。
  **不产出** `video` / `audio` / `camfeed` / `code`。
- `props`：**扁平的属性路径 → 值**，路径只能取下面 `SOURCE_PATHS` 表里的名字（拼法与 `core/contracts.js`
  的属性路径相同）。值只有 `number` / `string` / `boolean`；`props[path]` 是**基线值**，即源在自己时间轴
  `t = 0` 时的值（没有动画的路径就是静态值）。
- `tracks`：源动画轨，形状与 `el.keyframes` **逐字段相同**（`{ t, path, value, ease?, curve? }`），
  所以 4.2 直接用 `core/time.js::sampleTrack(tracks, path, t, props[path])` 取样，不另写取样器。
  `path` 必须同时出现在 `props` 里（有轨道没有基线 = 快照非法）。数组按 `(path, t)` 排序，
  同一 `(path, t)` 只允许一个键。`parent` 可选，缺省 `null`。

`SOURCE_PATHS`（源层可以驱动的**全部**属性，封闭集合；4.1 在 `core/source-map.js` 导出同名常量）：

| path | 类型 | 单位 | 默认值（= 元素默认值） | 插值 |
|---|---|---|---|---|
| `style.text` | string | — | `''` | 步进（在键处切换） |
| `style.font` | string | — | `SimHei` | 步进 |
| `style.size` | number | 项目像素 | `96` | 数值 |
| `style.weight` | number | — | `400` | 数值 |
| `style.color` | string | 颜色 | `#ffffff` | 步进 |
| `style.align` | string | left / center / right | `center` | 步进 |
| `style.lineHeight` | number | 倍率 | `1.18` | 数值 |
| `style.letterSpacing` | number | 项目像素 | `0` | 数值 |
| `src` | string | 项目相对路径 | `''` | 步进（换图；可以只出现在 `props`） |
| `transform.x` | number | 项目像素（相对画面中心） | `0` | 数值 |
| `transform.y` | number | 项目像素（y 向下） | `0` | 数值 |
| `transform.scale` | number | 倍率（**等比**） | `1` | 数值 |
| `transform.rotation` | number | 度（**元素空间**，与 `el.transform.rotation` 同号） | `0` | 数值 |
| `transform.opacity` | number | 倍率 | `1` | 数值 |

- 默认值与 `core/schema.js::DEFAULT_STYLE` / `DEFAULT_TRANSFORM` 逐项相同；`props` 缺某个路径就用这一列，
  不改元素已有的值。数值不做上下限夹取（与 `keyframes` 一致）。
- 只接受**等比** `transform.scale`：CSS 的非等比 `scale: 1.2 0.8` 不进源轨道（4.1 要么栅格化成 `image`，
  要么按 §7.2 报"这是场景运动，请改用编辑器"）。
- 值都是**元素空间**的：`transform.x/y` 是编译后布局相对画面中心的位置（像素，y 向下），
  `transform.rotation` 已经是元素符号（CSS `rotate()` 与元素旋转的符号差异由 4.1 换算，写回源时反向换算一次）。
- 表外路径一律不写不读：裁切、3D 旋转、`z`、效果、混合、蒙版、父子都在编辑器层（§7.2），
  出现在 `props` / `tracks` 里属于快照非法。

**时间**：轨道 `t` 是**项目绝对秒**（和 `el.keyframes` 一样，不是元素内相对时间、不是 CSS 秒）；`t >= 0`，
写盘时四舍五入到 3 位小数（`Math.round(t * 1000) / 1000`），取样时刻就是 `t = frame / fps`
（IR 帧号 0 基，§4.4）。源时间轴与项目时间轴 0 点对齐：元素的 `start` / `duration` 只决定它何时可见，
**不移动源轨道**（把元素挪到 8 s，源动画不会跟着从头播）。

**插值**：完全按 `core/time.js::sampleTrack`：

- 数值键：段内 `lerp`，进度用该段**起始键**的 `curve`（有则 `core/curves.js::sampleCurve`）或 `ease`
  （`EASE_NAMES` 之一；缺省 `easeInOut`，即 `sampleTrack` 的默认，不另立默认）。CSS `cubic-bezier(...)`
  采样成 `curve: [[u, v], …]`（3–9 点，`u` 递增、都在 0..1），有 `curve` 时忽略 `ease`。
- 字符串 / 颜色 / 枚举 / 布尔键：步进（取 `t` 之前最后一个键的值），与 `sampleTrack` 相同。
- 首键之前取首键值、末键之后取末键值（`sampleTrack` 的钳制）；没有轨道的路径取 `props[path]`。

**哈希口径**：对**规范化后的载荷**算 SHA-256。

1. 载荷 = `{ version, source, nodes }`（三个键，顺序无所谓）；**不含** `compiler` / `builtAt` / `hash`。
2. 规范化：对象键按字典序递归排序，数组保持顺序；数字先四舍五入到 6 位小数、`-0` 归一化成 `0`
   （与 §4.4 的数值卫生同一口径）；不加空格、不加换行。
3. UTF-8 字节 → `sha256` → `"sha256:" + 64 位小写十六进制`。

同一份源在同一台机器上重复编译必须得到同一个 `hash`；换机器可能因渲染实现不同而不同，但**快照内容相同
⇒ hash 相同**。合并用 `hash` 判断"源是否变过"，不看 `builtAt`。

**版本与降级**：`version` 不匹配、`nodes` 形状不对、节点 id / 路径 / 值类型不合法 ⇒ 整份快照视为不可用
（拒绝加载、不改写文件），用它的元素按"缺源"处理（§7.8.2）。不部分解析、不猜字段。

示例（`html-lyrics` 的一行歌词；其余节点省略）：

```jsonc
{ "version": 1, "source": "html-lyrics",
  "compiler": { "name": "source-service", "version": 1, "runtime": "html", "entry": "index.html" },
  "builtAt": "2026-10-30T09:41:12.345Z",
  "hash": "sha256:0f3c…",
  "nodes": [
    { "id": "n_line_1", "type": "text", "parent": null,
      "props": { "style.text": "第一句歌词", "style.font": "SimHei", "style.size": 96, "style.weight": 600,
                 "style.color": "#e8f4ff", "style.align": "left", "style.lineHeight": 1.18,
                 "style.letterSpacing": 2, "transform.x": -420, "transform.y": 160,
                 "transform.scale": 1, "transform.rotation": 0, "transform.opacity": 1 },
      "tracks": [ { "t": 0, "path": "transform.opacity", "value": 0, "ease": "easeInOut" },
                  { "t": 0.4, "path": "transform.opacity", "value": 1, "ease": "linear" },
                  { "t": 0, "path": "transform.y", "value": 184, "ease": "outExpo" },
                  { "t": 0.4, "path": "transform.y", "value": 160, "ease": "linear" } ] }
  ] }
```

#### 7.8.2 `el.source` 与 `el.sourceMode`（§7.3）

字段（`core/schema.js`，WP4.2；`normalizeProject` 只**保留合法值**，不伪造、不自动创建）：

| 字段 | 类型 | 默认 | 合法值 | 说明 |
|---|---|---|---|---|
| `el.source` | object | 缺省（不需要这个键） | `{ id, node }`，两个都是非空 string | 存在即"这个元素来自某个源节点" |
| `el.source.id` | string | — | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`（同 `isSafeSourceId`） | 目录名 = id |
| `el.source.node` | string | — | `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$` | 必须是 `base.json` 里存在的节点 id |
| `el.sourceMode` | object | `{}`（缺省 = 全部走默认） | `{ "<path>": "add" \| "mul" \| "override" }` | 稀疏表：只写"不按默认"的路径 |
| `el.sourceMode[path]` | string | 按单位：`transform.scale` / `transform.opacity` → `mul`，其余 → `add` | `add` \| `mul` \| `override` | 键必须在 `SOURCE_PATHS` 里 |

- 规范化：`el.source` 缺 `id` / `node`、类型不对或 id 不合法 ⇒ **整个 `el.source` 删掉**（和 `node` 的
  "never fabricate" 同策略）；`el.sourceMode` 里路径不在 `SOURCE_PATHS`、值不是三个之一，或对非数值路径
  写了 `mul` ⇒ **删掉那个键**（落回默认）。都不抛错、不拦加载。`validateProject` 只报问题不修复。
- `sourceDetach`（§7.7）删除 `el.source` 与 `el.sourceMode`，把当前帧的求值结果写进元素的本地值。
- 界面文案"叠加"在数据里只是 `add` 或 `mul`（按单位默认），"接管"是 `override`；**没有第四个值**。
- IR 里的 `item.source` 从 v2 起就是 `{ id, node }` 的**回声**（`core/frame-ir.js` 只搬运，不求值）。
  WP4.2 不新增 IR 字段、不搬 `sourceMode`（IR 是求值后的结果），所以**不升 `FRAME_IR_VERSION`**。

**`buildFrameIR` 里的求值顺序（固定）**：

1. **本地值**：默认值 → `el.keyframes`（这一层就是"编辑器层值"，与 §7.3 的"源层值 → 合入编辑器层"同一件事）。
2. **源层取样**：`base = node.props[path]`，`src(t) = sampleTrack(node.tracks, path, t, base)`（没轨道 = `base`）。
3. **按模式合入**（`local` = 第 1 步的值）：

| 模式 | 数值路径 | 非数值路径（string / 颜色 / 枚举） |
|---|---|---|
| `add`（默认） | `local + (src(t) − base)` | `local !== base ? local : src(t)`（谁改过用谁，比较用 §7.8.1 的规范化） |
| `mul`（默认：`transform.scale`、`transform.opacity`） | `local × src(t) / base`；`abs(base) < 1e-9` 时退化成 `override`（与 `links.js` 拒绝零基准 `mul` 同一条规则） | 同 `add`（没有乘法可做） |
| `override` | `local`（源被忽略） | `local` |

4. **属性链接**：`to` 的本地值 = 第 3 步的结果。
5. **运动预设 / 节拍 / 淡入淡出**：编辑器层的线性增量。
6. **父子**：空间父级链最后乘上去，源合并不碰父级值。

- 数值合入只用加法和乘法，因此实现上可以在 `evalElement` 之后施加（与"链接之前"等价，加法/乘法可交换），
  但**透明度合入后要再夹一次到 0..1**（与 `evalElement` 的 clamp 同口径）。
- **表示无关**：源轨道说的是"元素自身局部空间里的差量 / 倍率"，元素用旧 `transform` 还是 `el.node` 都成立。
  `transform.x` 的 `Δpx` 在屏幕路径加进 `st.x`、在节点路径加进 `node.pivot.x`（`Δpx / 100` 米）；
  `transform.y` 反向（`node.pivot.y -= Δpx / 100`，y 向上）；`transform.scale` 的倍率乘 `st.scale` 或
  `node.scale.x` / `node.scale.y`（z 不变）；`transform.rotation` 的度加到 `st.rotation` 或 `node.roll`
  （节点已有三轴 `rotation.*` 轨道时加到 `rotation.z`）；`transform.opacity` 的倍率乘 `opacity`。
  4.1 的编译产物默认走旧 `transform` 路径（少一层换算，便于对拍），以后升级成节点模型时按本条照样成立。
- **快照的传入方式**（4.2 新增的可选参数，**不是 IR 的一部分**）：`opts.sourceSnapshots` =
  `{ [sourceId]: snapshot }` 或 `(sourceId) => snapshot | null`。core 不读文件（同 `opts.fonts` / `opts.city`），
  预览/成片各自从 `.vdm/sources/<id>/base.json` 读。快照的 `hash` 进入 `IRCache` 的键（按 source id
  排序拼接），重新编译后旧帧自动失效。

**降级（缺源 / 缺节点）**：

| 情况 | 行为 |
|---|---|
| 元素没有 `el.source` | 完全不进入本节逻辑；IR 与冻结前逐字段相同（WP4.2 的验收线） |
| `opts.sourceSnapshots` 里没有这个 id，或快照 `version` / 形状不合法 | 该元素按"缺源"= 编辑器层值（`fallback: 'editor-layer'`），不抛错、不写工程 |
| 快照里没有 `el.source.node` | 同上（整个元素降级，不是逐路径） |
| 某 `path` 在节点里既没有 `props` 也没有轨道 | 该路径按 `override`（不猜默认值，避免把 0 当成真实值） |

"降级"只影响**求值**：不写 `project.vdm.json`、不清 `el.source`，源修好后下一帧自动恢复。

#### 7.8.3 写回 `writeBack(sourceId, nodeId, path, value)`

`application/source-service.js`（WP4.3），**异步**（返回 `Promise`），因为要在沙箱里改 DOM 再读回文本；
同步的只有数据校验：路径/值格式不对直接抛 `OP_INVALID`，**不返回 fallback**。

```js
// 成功：源文件的新文本已经确定，op 还没应用
{ ok: true, changed: true, file: 'index.html', path: 'style.color', value: '#ff5c7a',
  op: { op: 'sourceWrite', id: 'html-title-card', path: 'index.html', content: '<改过的整份文本>' } }
// 降级：一步都没做，调用方把值写进编辑器层
{ ok: false, fallback: 'editor-layer', reason: 'node-unwritable',
  path: 'style.color', value: '#ff5c7a', message: '…' }
```

- `ok` **总是存在**（`true` / `false`），调用方只判这一个字段；`fallback: 'editor-layer'` + `reason`
  只在 `ok === false` 时出现。`changed === false` 表示源里已经是这个值（`op = null`，不产生事务）。
- 写回本身是一次事务：调用方把返回的 `op` 交给 `core/ops.js`（一个 `sourceWrite`，撤销一步），
  **不直接写盘**。源必须登记在 `project.sources[]`（HTML/SVG 源与代码源同一张表，`manifest.runtime`
  是 `html` / `svg`；4.1 把 runtime 白名单扩过来）。
- 成功的完整事务（4.3）：**(1)** `sourceWrite` 改源文本 → **(2)** `set` / `keySet` 把同一个值写进元素
  （镜像与 `base` 保持一致）→ **(3)** 重新编译该源、刷新 `base.json` 与 `hash`。第 3 步可以防抖；
  防抖窗口里快照是旧的，允许（不写第二份真值）。
- 失败语义：**源、元素、快照都不动**，不抛错；调用方接着写编辑器层——元素值 + `el.sourceMode[path] = 'override'`，
  修改不丢失（§7.4 最后一行）。
- 只有 §7.4 表里"写回源"的内容可以走这条路：`style.text`、`style.color` / `size` / `font` / `weight` /
  `letterSpacing` / `lineHeight`（写行内样式），以及 `src`（改 `<img src>`）。`path` 必须在 `SOURCE_PATHS`；
  表外路径（`transform.*`、`pivot.*`、效果、裁切……）一律 `reason: 'path-editor-only'`，不去看源。
- `el.sourceMode[path] === 'override'` ⇒ **不尝试**，直接 `reason: 'path-overridden'`（用户已接管）；
  `add` / `mul`（默认）才尝试。
- `reason` 是封闭枚举（新增值 = 升级本节）：`source-missing`、`node-missing`、`path-editor-only`、
  `path-overridden`、`node-unwritable`（有歧义 / 文本节点里有子元素 / 空元素上写文字 / `src` 不在 `<img>` 上）、
  `source-read-only`、`worker-unavailable`、`type-mismatch`（节点**类型**不能承载该路径，R2）。
  值类型不对不在这里：那是同步校验，抛 `OP_INVALID`。
- 不适用于 `code` 元素：代码图层的源走 `sourceWrite` / `codeParamSet`，没有 DOM 写回。

#### 7.8.4 合并 `merge(base, ours, theirs)`

`core/source-merge.js`（WP4.4），**纯函数、同步、无 IO**。三份输入都是快照形状（`{ nodes }`，
多余的头字段忽略）：

| 输入 | 谁提供 | 含义 |
|---|---|---|
| `base` | 上次编译的 `base.json` | 上次的源侧事实 |
| `ours` | 编辑器层（`el.source.id === sourceId` 的元素导成快照形状） | 编辑器层的当前值；缺节点 = 用户删了元素 |
| `theirs` | 本次新编译的快照 | 源侧的新事实 |

返回 `{ result, conflicts }`；`result = { version, source, nodes, hash }`（可以直接写成新的 `base.json`，
`compiler` / `builtAt` 由调用方盖时间戳）。`merge` 不改入参、不写盘、不改 `el.sourceMode`。

逐 `(nodeId, path)` 三方比较（`path` 覆盖 `props` + `tracks`；有轨道的路径**整条轨道当一个值**比较，
不逐键拆冲突；相等用 §7.8.1 的规范化）：

| base | ours | theirs | result | 冲突 |
|---|---|---|---|---|
| a | a | b | b | — |
| a | c | a | c | — |
| a | c | b | b（暂定，人决定） | `both-changed` |
| a | c | 节点没了 | result 不含该节点 | `node-deleted` |
| a | a | 节点没了 | 删掉 | — |
| 节点不存在 | — | b | b | — |
| 节点不存在 | 同 id 已有元素 | b | 保留 ours | `node-collision` |
| a | a | b，且 `type` 变了 | 整节点取 theirs | — |
| a | c | b，且 `type` 变了 | 整节点取 theirs | `type-changed` |

- 冲突记录字段（**只有这六个**）：`{ nodeId, path, base, ours, theirs, kind }`。`path` 为 `null` 表示
  节点级冲突（`node-deleted` / `node-collision` / `type-changed`），此时 `base/ours/theirs` 是节点摘要
  `{ type, props, tracks }`；标量路径就是标量，轨道路径是整条键数组；缺的那一侧写 `null`。
- `kind` 封闭枚举：`both-changed` | `node-deleted` | `node-collision` | `type-changed`。
- **谁决定：人**。冲突汇总进一个 `needs-decision` 变更集（§8.1），UI 逐条选 `base` / `ours` / `theirs`
  （或"保留编辑器层并脱离源码"）；4.4 只按人的选择写 op。`merge` 自己不做决定、不写报告状态。
- 非冲突项直接落到 `result`。`type` 只按 `base` / `theirs` 判定（源侧事实），`ours.type` 不参与；
  编辑器层独有的东西（裁切、3D、效果、蒙版、混合）不在快照里，类型变化时天然不受影响（§7.6 最后一行）。

#### 7.8.5 版本常量与共享夹具

- `core/version.js`：`export const SOURCE_SNAPSHOT_VERSION = 1;`（只有常量，不带逻辑；和其他版本常量一样
  各自生命周期，编辑 `rev` 永远不是格式版本）。本节的 `version` 字段都引用它。
- 夹具 `tests/fixtures/sources/`（本包建前五个，其余由对应包补齐，§10.4.6）：

| 目录 | runtime | 入口 | 用在哪 | 内容 |
|---|---|---|---|---|
| `p5-rain` | `p5` | `sketch.js` | 代码图层 / 对拍 I | 雨丝下落，`density` / `speed` / `tint` |
| `glsl-noise` | `glsl` | `main.frag` | 代码图层 / 对拍 I | 域扭曲值噪声，`speed` / `scale` / `tint` |
| `canvas2d-bars` | `canvas2d` | `main.js` | 代码图层 / 对拍 I | 跳动条，`count` / `speed` / `tint` |
| `html-title-card` | `html` | `index.html` | 网页编译 / 对拍 L | 标题 + 引题 + 分隔线，CSS 入场动画 |
| `html-lyrics` | `html` | `index.html` | 网页编译 / 对拍 L | 多条歌词 + 时间轴，`script.js` 由常量数组生成 DOM |

  每个夹具：`manifest.json` 用 `format: 'vdm.source/1'`、`deterministic: true`、目录名 = `id`、
  参数有 `default`（有 `range` 时 `default` 必须在范围内）、脚本不读时钟也不用无种子随机
  （`vdm.random` 除外）。`tests/fixtures-sources.test.mjs` 只做文件与 schema 校验：入口存在、
  参数合法、代码夹具过 `scanSourceFiles`、`sourceFiles()` 往返一致、HTML 夹具是合法 UTF-8。
- 其余三个（`svg-icons`、`three-orbit`、`manim-formula`）由 4.1 / 5.1 / 5.2 按同一规则补齐，不再各编一套。

#### 7.8.6 本包留下的假设（4.1–4.4 直接采用；要改按本节开头的流程升版）

1. **快照由调用方传进 core**（`opts.sourceSnapshots`），core 不读 `.vdm/`；缺快照 = 缺源降级。
   `buildFrameIR` 保持纯函数，`IRCache` 用快照 `hash` 做键。
2. **快照是绝对源值 + 基线**：`props[path]` 是 `t = 0` 的基线，`add` / `mul` 都相对它算差量
   （与 `links.js` 的 `bindParentValue` 同一个公式）。编译产物在元素上**镜像**基线值，元素单独看也是对的，
   `sourceDetach` 直接可用。
3. **源轨道落在元素自身局部空间**，与元素用 `transform` 还是 `node` 表示无关（换算式见 §7.8.2）；
   像素→米只用项目规则（100 px = 1 m、y 反向）。
4. **非数值路径的 `add`** 退化成"谁改过用谁"（编辑器值 ≠ 基线时用编辑器值），不是字符串相加。
5. **`mul` 的零基线**退化成 `override`（同 `links.js` 拒绝零基准 `mul`）。
6. **写回是三件事一个事务**（源文本、元素镜像值、快照刷新）；失败时一步都不做，改走编辑器层 + `override`。
7. **冲突整条轨道一个值**，不逐键拆；冲突项暂取 `theirs`，由人决定。
8. **编译源的 runtime 是 `html` / `svg`**，登记在 `project.sources[]`（和代码源同表），写回用现有
   `sourceWrite` op；4.1 需要把 runtime 白名单扩到 `core/code-layer.js` / `core/source-map.js`。

#### 7.8.7 修订 R1（2026-10-30，WP4.2 开工时对照实现）

WP4.2 动手前对照本节与实现，发现三处冲突。按「冻结记录优先、任务书作废」处理，记录在此：

1. **`override` 的语义是「本地值胜出、源被忽略」**——§7.8.2 表格、§7.3、§7.8.3、§7.8.6 #5 四处一致。
   任何写成「`override` = 源值」的表述作废；界面上的「接管」就是这个语义。
2. **`FRAME_IR_VERSION` 升到 5**：`item.source` 增加 `fallback: 'editor-layer'`，IR 形状确实变了
   （UI 要区分「有源但降级」与「无源」）。§7.8.2 里「不升 `FRAME_IR_VERSION`」作废；
   `tests/fixtures/frame-ir-golden.json` 与硬编码版本的测试同步升版。
3. **非法 `el.source` / `sourceMode` 静默丢弃**，不拦加载、不抛错；`validateProject` 只报问题（§7.8.2 原文）。
   任务书里的「抛 `INVALID_ARGUMENT`」作废（core 只用 `OP_INVALID`，`INVALID_ARGUMENT` 属于 application）。
4. **`SOURCE_PATHS` 的归属**：定义在 `core/source-eval.js`（求值侧），`core/source-map.js`（4.1）直接
   re-export，不复制第二份常量。

以上四条对 4.1–4.4 都有效；后续若再改，按本节开头的升版流程记 R2。

#### 7.8.8 修订 R2（2026-10-30，WP4.3 交付时对照实现）

WP4.3 落地 `writeBack` 时，§7.8.3 有四处按任务书与实现补齐（只动这一节的文字，快照格式不变，
`SOURCE_SNAPSHOT_VERSION` 仍是 `1`）：

1. **`reason` 枚举补一项 `type-mismatch`**：节点存在、但它的**类型**不能承载这条路径
   （`solid` / `shape` / `image` 上的 `style.text`、非 `text` 节点上的文字样式、非 `image` 节点上的 `src`）。
   §7.8.3 原先的 `node-unwritable` 括号里只写写入机制的失败（选择器太复杂 / 样式不在子集 / 没有行内样式），
   盖不住“节点类型不对”这一类，而它又必须给调用方一个降级理由（既不静默，也不必升级成错误）。
   **值类型不对仍然抛 `OP_INVALID`**（§7.8.3 原文的同步校验），不返回 fallback——两者不混。
2. **“没有行内样式”不再是 `node-unwritable`**：节点没有 `style` 属性时写回**新建**一个，与
   `el.style.color = …` 的 DOM 语义一致（§7.4“写回该节点的行内样式”）。行内样式的特异性高于任何选择器，
   §7.8.2 的编译顺序保证下一次编译读到新值。`node-unwritable` 现在的生产者是：同一个 `data-vdm-id`
   在源里出现多次（有歧义）、文本节点里还有子元素、`style.text` 落在空元素上、`src` 落在非 `<img>` 上。
3. **写回是文本级操作，不是 DOM 沙箱**：`application/source-writeback.js` 用编译器的那个 tokenizer
   （`core/source-map.js::tokenizeHtml`，WP4.3 给它加了 token 的 `start` / `end`）找到元素、只拼接变动的
   span，其余字节原样保留——文件格式因此可读、可 diff。所以 `worker-unavailable` 没有生产者；
   `source-read-only` 同样没有（schema 里还没有只读源）。两个值留在枚举里，是为了将来真做成沙箱 DOM
   时不扩枚举。
4. **第 3 步在事务之后**：调用方提交 `[sourceWrite, 元素镜像 set]` 一个事务，成功后才 `compileSource`
   刷新 `base.json`。§7.8.3 本来允许第 3 步防抖，这样做的额外好处是事务失败时源、元素、快照**一步都没做**
   （§7.8.6 #6）；代价是撤销后快照仍停在新值，直到下一次编译——冻结记录里“防抖窗口里快照是旧的，允许”
   已经接受这一点。

WP4.3 的验收与文件记录见 `docs/CHANGELOG-presets.md`。

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
- 基准脚本：`scripts/bench-agent.mjs` —— 同一组固定任务（改字号卡拍 / 加一个元素 / 修一个位置）分别走变更集与
  「无变更集、直接写盘」两条路径，记录耗时（总时长与写入本身）、工具调用数、变更集、rev、verified、失败/拒绝、
  回退代价，输出 JSON + markdown 表。`--agent=scripted` 用 `ScriptedAgent` 的固定脚本经 MCP 工具面
  （`mcp/tools.js::callTool` → `POST /api/rpc`）跑，可重复、用于回归；`--agent=dsh` 用真 dsh（`findDsh`，缺失时跳过并说明）。
  用法：`node scripts/bench-agent.mjs --agent=scripted [--project <工程副本>] [--runs 3]`。源工程只读（每跑一次复制到
  临时目录），「直接写盘」是同机模拟，报告里写明「只有本轮数字」；dsh 在变更集之外直接改工程文件时会被标成旁路写入。

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

> 2026-10-30：上图是按"阶段"画的。剩余工作按**真实依赖**重新安排，见 §10.4。
> 要点：R4 只依赖 WP3.1、WP2.2（都已完成），不必等 R3 做完。

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
- 验收：Electron 探针脚本覆盖 接受 / 拒绝 / 单独撤回 / 前后对比 / 点选生成报告锚点。估时 7 天（R1 修订后：审阅 3 + 标记与锁定 1.5 + 报告 2 + 时间范围 0.5；含变更集 / 测量 / 报告三条 HTTP 面，见 `docs/DESIGN-WP2.5-REVIEW.md` §10.8 与 §11）。

**WP2.5e AgentLoop 接线（待排期，不计入 R2）**
- 现状（`1cb6bbc`）：`/api/agent` 仍跑 legacy `AgentRunner`，它的 proposal 已经走 `ChangeSetService`（每次 AI 写入都是可回退的变更集），但「计划 → 批准」还没有。
- 缺口：`AgentLoop` 的 `ProcessAgent` 说的是工具调用 NDJSON，dsh headless 说的是「一次 prompt + 一段 JSON 回复」，中间缺一层适配；没有它，切过去会让 `/api/agent` 端到端失效。
- 内容：写 dsh 适配层 → `engine/server.js` 切到 `AgentLoop`（`run` / `approve` / `state`，并给 `AgentLoop` 补 `cancel()`）→ 删 `AgentRunner`。估时 1.5 天。

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
| R2 | 测量、变更集（含锁定）、契约、Agent 循环、界面 | 约 16 天（WP2.5 由 3 天调到 7 天） |
| R3 | 渲染池、代码图层、画面效果单一实现、界面 | 约 13 天 |
| R4 | 源编译、合并、界面 | 约 12 天 |
| R5 | three.js、Manim、对比基准 | 约 6 天 |

R1、R2 与 WP3.1 可以并行，按两到三个子代理同时推进，日历时间约为总量的一半到三分之二。

### 10.4 并行加速安排（2026-10-30 修订，用户批准；剩余工作以本节为准）

#### 10.4.1 现状与剩余工作

已完成并合入 master：R0（WP0.0–0.3）、R1（WP1.1–1.3，含静帧取帧修复 `c2bc053`）、WP2.1–2.4、WP2.5a 后端（`b50f094`）、WP2.5b（`06a9365`）、WP2.5d、WP3.1–3.3。

| 阶段 | 剩余 | 估时 |
|---|---|---|
| R2 | 2.5a 界面、2.5c（进行中），2.5e | 约 4.5 天 |
| R3 | 3.4、3.5、3.6 | 约 5.5 天 |
| R4 | 4.1–4.6 | 约 12 天 |
| R5 | 5.1、5.2、5.3 | 约 6 天 |

按原顺序（R3 → R4 → R5）串行约需 25 天以上。

#### 10.4.2 按真实依赖开工

| 工作包 | 真正的前置 | 能否立即开工 |
|---|---|---|
| WP4.1 编译、WP4.2 叠加/接管 | WP3.1、WP2.2、**WP4.0**（§10.4.4） | WP4.0 完成后即可 |
| WP5.2 Manim | WP3.2、任务系统 | 可以 |
| WP5.1 three.js 动画图层（runtime `three`） | WP3.1 | 可以；**静态场景导入 glTF 仍需 DESIGN-PRESETS M4**，拆为 WP5.1b，M4 完成前不做 |
| WP5.3 对比基准 | WP2.4（走 MCP 即可，不必等 2.5e） | 可以 |
| WP3.4 Blender 接代码图层 | WP3.3 | 可以 |
| WP3.5 画面效果单一实现 | WP3.4（改同样的文件） | 3.4 之后 |
| WP3.6 代码图层界面 | WP3.2、**WP-P**（检查器分区登记） | WP-P 之后 |
| WP4.6 源编辑界面 | WP4.2、WP4.4、**WP-P** | 依赖完成后 |

#### 10.4.3 准备包 WP-P：拆开热点文件（约 1 天，优先做）

起因：进行中的 2.5a 和 2.5c 两个分支都改了 `engine/server.js`（各加约 100 行）、`application/changeset-service.js`、
`application/errors.js`、`tests/http.test.mjs`、`tests/changeset.test.mjs`。后面的 2.5e、R4、R5 还会继续往这些文件里加。

- 目标：把"多个工作包都要往里加东西"的文件改为"各自登记"，之后各包只新增自己的文件。**行为零变化**。
- 前置：2.5a、2.5c 全部合入 master（避免在它们进行中改动同样的文件）；2.5b 已合入。
- 改动文件与做法：
  1. `engine/server.js` → 新建 `engine/routes/`，每个功能一个文件（`agent.js`、`changesets.js`、`reports.js`、`raster.js`、`font.js` 等），
     导出 `register(router, ctx)`；`server.js` 只负责组装。之后新增接口只新建一个路由文件。
  2. op 与契约：`core/ops-ext.js`、`core/contracts.js` 增加登记接口（`registerOps(module)`、`registerContracts(fragment)`），
     新功能在自己的模块里登记（例如 `core/source-ops.js`），不再修改这两个文件的主体。生成的 MCP schema 与协议文档不变（测试比对）。
  3. `app/renderer/js/inspector.js` 增加**分区登记**：`registerInspectorSection({ id, order, when(sel), render(ctx) })`。
     2.5b（锁定头部）、3.6（代码参数）、4.6（来源标记、叠加/接管）各自注册一个分区文件，不再同时修改 `inspector.js`。
  4. 测试：`tests/http.test.mjs` 按路由拆成 `tests/http-<功能>.test.mjs`，公共启动逻辑放进 `tests/helpers/http.mjs`。
- 验收：`npm test` 全过且测试数不减少；MCP schema、`AGENT-PROTOCOL.md` 与改前逐字节相同；HTTP 接口列表（方法 + 路径）与改前相同；
  检查器的 DOM 结构对三种选中（元素、相机、3D 物体）与改前相同（探针读 DOM 比对）。

#### 10.4.4 接口冻结包 WP4.0（约 0.5 天，R4 的第一步）

像 §4 冻结 IR 格式一样，先冻结 R4 内部的接口，之后 R4 内部也能并行：

1. 源编译快照 `.vdm/sources/<id>/base.json` 的格式：节点 id、类型、属性值、源动画轨的表示方式；
2. `el.source = { id, node }` 与 `el.sourceMode` 的字段和默认值（§7.3），以及它在 `buildFrameIR` 里的求值顺序；
3. 写回接口 `writeBack(sourceId, nodeId, path, value) → { ok } | { fallback: 'editor-layer', reason }`；
4. 合并接口 `merge(base, ours, theirs) → { result, conflicts[] }`，冲突记录的字段。

交付：写进本文 §7 末尾的"冻结记录"，并配一组共享夹具 `tests/fixtures/sources/`（见 §10.4.6）。冻结后：
**4.1 ∥ 4.2**，然后 **4.3 ∥ 4.4**，最后 4.5。

#### 10.4.5 四条线

同时最多四条线（A 的审查与合并能力是上限）。每条线内部串行；线与线之间不改同一个文件。

| 线 | 顺序 | 主要文件 |
|---|---|---|
| ① 渲染线 | 3.4 → 3.5 | `blender/vdm_build.py`、`engine/blender.js`、`engine/render-workers/post.js`、共享 GLSL |
| ② 界面线 | 2.5a 界面 → 2.5c 界面 → 3.6 → 4.6（2.5b 已完成） | `main.js`、`timeline.js`、`review.js`、`report.js`、检查器分区文件 |
| ③ 引擎线 | 2.5c 后端 → **WP-P** → 2.5e → 5.3 | `engine/routes/`、`engine/agent.js`、`application/` |
| ④ 源编译线 | WP4.0 → (4.1 ∥ 4.2) → (4.3 ∥ 4.4) → 4.5；空档插 5.2、5.1 | `application/source-service.js`、`core/source-*.js`、`core/frame-ir.js`（仅 4.2） |

- `core/frame-ir.js` 在这一轮只归 WP4.2 修改；其他包需要 IR 新字段，先报 A，由 4.2 统一加入并升级 `FRAME_IR_VERSION`。
- 估算日历时间：约 **10–12 天**（最长的是界面线）。

#### 10.4.6 共享夹具与对拍编号

- **对拍用例编号预先分配**（`scripts/check-render-parity.mjs`），各包只用自己的字母：
  A–H 已有（H = 文字几何，WP1.3）；**I** = 代码图层在 3D 中倾斜并被遮挡（WP3.4）；**J** = 画面效果全开（WP3.5）；
  **K** = three.js 动画图层（WP5.1）；**L** = 网页编译（WP4.1）；**M** = Manim 图层（WP5.2）。
- **共享夹具**：`tests/fixtures/sources/` 放一套示例源码，各包共用，不各自另编：
  `p5-rain`、`glsl-noise`、`canvas2d-bars`（代码图层）；`html-title-card`、`html-lyrics`、`svg-icons`（网页编译）；
  `three-orbit`（three.js）；`manim-formula`（Manim，检测不到 manim 时测试自动跳过）。由 WP4.0 建立前五个，其余由对应包补齐。

#### 10.4.7 界面方案提前写、集中审

界面线是关键路径，而每个界面包开工前都要用户批准界面方案。A 现在就写 **3.6、4.6 的界面方案**（只写文档），
与 2.5 剩余部分一起交给用户审，"等批准"不再卡在关键路径上。

#### 10.4.8 B 独立验收

- 每个工作包合入 master 后，A 通知用户，由 B 按 §11 和该包的验收项独立复核（像素统计、独立运行检查脚本），
  结论写进本文件末尾的"验收记录"，并记入 `docs/CHANGELOG-presets.md`。
- A 的子代理仍需在合入前自测并交付验收数字；B 的复核是第二道，不替代自测。
- B 发现问题时只报告、不改代码：写清复现步骤和数字，由 A 安排修复。

---

## 11. 质量门槛（每个 WP 合入前都要过）

1. `npm test` 全部通过。
2. `node scripts/check-render-parity.mjs` 全部用例 PASS（A–H，以及之后新增的 I–M，编号见 §10.4.6）。
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
| 多个子代理并行改同一文件 | 合并冲突 | 文件归属表加接口冻结；A 统一合入；WP-P 把热点文件改为各自登记（§10.4.3） |
| 四条线并行，A 的审查与合并跟不上 | 分支积压、返工 | 同时最多四条线；B 承担合入后的独立验收（§10.4.8） |

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
| **D7′** ✅ 已批准（2026-10-30，取代 D7 的剩余部分） | R0、R1 完成后，剩余工作按真实依赖分四条线并行（§10.4.5），R4 与 R3 同时进行 | 同意 |
| **D8** ✅ 已批准（2026-10-30） | 先做准备包 WP-P（拆开 `server.js`、op/契约登记、检查器分区，约 1 天）和接口冻结包 WP4.0 | 同意 |
| **D9** ✅ 已批准（2026-10-30） | 合入后的独立验收交给 B（§10.4.8） | 同意 |

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

---

## 16. 验收记录（B 独立复核，§10.4.8）

| 日期 | 范围（master 提交） | 结论 | 数字 |
|---|---|---|---|
| 2026-10-29 | R0（WP0.0–0.3）、WP2.1、WP3.1 | 通过；补三处（像素覆盖、rev 303 复现、沙箱两条），A 已补齐 | `cut-edges` 在 rev 303 副本上抓出 `s1_w2` +0.99 帧；`s2_w4` cam_8 f142–158 每帧可见、未被 `s2_bg` 遮挡 |
| 2026-10-30 | 至 `c2bc053`（含 WP1.1、WP1.2、WP2.2–2.4、WP2.5d、WP3.2、WP3.3） | 通过；静帧取帧规则不一致（`vdm_render.py` 用四舍五入），A 已在 `c2bc053` 修复 | `npm test` 629/631（2 跳过，0 失败）；对拍 A–G 1/144 格，PASS；播放 60 fps，p50 16.7 ms，PASS；`vdm_build.py` 无求值函数 |
