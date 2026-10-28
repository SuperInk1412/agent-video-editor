# 交互问题分诊：空项目、2D 属性、新建时刻、相机池、标尺缩放

> 2026-10-27 · 给两条线的协作文档
>
> 参与方：
> - **A（曲线 / 相机 / 编辑器交互线，本 agent）**
> - **B（3D / 世界 / 预设 / 媒体线，隔壁 agent）**
>
> 这份文档只做问题归属、交互契约和验收标准，不代表代码已经改完。改代码前以这里的分工为准，避免两边同时改 `timeline.js` / `inspector.js` / `world` 相关文件。
>
> 统一空间的最新决定见 `docs/DESIGN-UNIFIED-SPACE.md`；两条线的通信规则见 `docs/AGENT-MAIL.md`。
> 本文档 §2.1 已按统一空间更新，旧「启用 3D」按钮方案不再执行。

---

## 0. 本轮已经确定的背景

- **统一空间方案已由用户拍板（`DESIGN-UNIFIED-SPACE.md`）**：没有 2D 模式，也没有「启用 3D」按钮；
  新建项目就等于“空世界 + 默认相机 + 世界里的 2D 平面”，2D 元素只是没有厚度、默认在画面平面上的世界对象。
- 本文档原先 §2.1 写的「启用 3D 世界」按钮方案**已被统一空间方案取代**，只保留作为当前过渡状态的排障记录。
- 新建项目 UI 已接：项目选择器可以建空白项目。**当前**新建出来还是空白 2D 时间线，没有相机/3D 入口，
  这是统一空间第 3 步要替换掉的旧状态。
- 相机求值最近修过：手动 look 首尾淡入淡出、bank 跨 ±180° 用最短角差、路径首尾不再被零切线打成最大 bank。
- 发卡弯自动看向按用户要求暂不处理。
- 相机在时间轴上仍然是独立分组（相机栈 + 相机行），没有和普通元素使用同一套选择入口。

---

## 1. 问题总表

| # | 现象 | 根因所在 | 主责 | 协作 |
|---|---|---|---|---|
| 1 | 空项目找不到创建 3D 世界的按钮 | 当前新建项目仍是旧 2D 空项目；统一空间要求新建即带空世界+默认相机，不再做“启用 3D”按钮 | **B 先做世界/默认相机（统一空间 1–2）** | **A 做新建项目接入与默认相机落地（统一空间 3）** |
| 2 | 2D 元素看不到属性 | 时间轴只给 2D 元素画了单行色块，没有展开属性和关键帧行；属性面板本身能显示 | **A 主责** | B 确认属性面板/属性描述一致性；统一空间第 5 步加 `transform.z` |
| 3 | 新建文字/形状落在下一帧，当前预览看不到 | `add2DElement` 用 `fitStart()` 做毫秒四舍五入，可能把起点舍到当前时间之后；预览严格按 `t < start` 跳过 | **A 主责** | 无 |
| 4 | 相机被单开一行，不在普通元素池 | 相机行走 `_startCameraDrag` / `_activateCamera`，设置独立的 `cameraSel`，没有走 `_pickPool('element', cameraRef)` | **A 主责** | B 配合属性面板/相机栈 |
| 5 | 时间轴标尺不能用拖拽调整尺度 | 标尺 pointerdown 一律进入 `_startScrub`；目前只有 Ctrl+滚轮、缩放按钮、双击适应 | **A 主责** | 无 |

---

## 2. 逐项分析

### 2.1 空项目不是“缺一个按钮”，而是所有项目默认就是 3D

#### 统一空间的决定（`DESIGN-UNIFIED-SPACE.md`）

- **没有 2D 模式，也没有「启用 3D」按钮。**
- 新建项目直接带：`world.source = 'none'` 的空世界 + 一台默认透视相机（位置 `(0, H/200, D)`，看向画面中心，`D = 20m`）。
- 文字 / 色块 / 图片 / 视频是世界里没有厚度的平面；默认放在 z = 0 的画面平面上，像素坐标按 `PX_PER_M = 100` 换算。
- 2D 元素新增 `transform.z`（米）作为纵深轴；相机或元素的 z 一动，视差/透视自然出现。
- 编辑视口显示地面网格，镜头视角和成片不显示网格；空世界默认没有城市。
- 用户要程序化城市时，在世界面板里主动选择。
- 统一空间第 1–2 步由 B 做空世界/default camera/migration；第 3 步由 A 接新建项目，**这一步会删掉“启用 3D”相关入口设想**。

#### 当前过渡状态（为什么现在会看到问题）

- 当前 `POST /api/projects/create` 仍然走 `createProject()`，只得到旧的 2D 项目数据：没有相机。
- `applyProject()` 里：

  ```js
  const addBtn = $('#btnAddElement');
  if (addBtn) addBtn.hidden = !p.world || !p.camera;
  ```

  没有相机时，添加 3D 的入口是隐藏的。
- `createCamera()` 需要 `S.editCam`、现有相机，或 `preview.scene3d.lastCam`。空项目三者都没有，只 toast「没有可用视角」。
- `addSceneElement()` 需要 `project.world` 并进入编辑模式；没有相机时 `setEditMode(true)` 直接失败。
- 世界面板在 `inspector._renderCamera()` 里，只有选中相机才出现；空项目没有相机，所以也没有「世界 / 换一座城」的区域。

结论：这是**旧 2D 新建流程和统一空间新目标之间的过渡缺口**，不是“忘记摆一个按钮”。在 B 的空世界/default camera 落地前，A 不应再做一个独立的「启用 3D」按钮，否则会和统一空间方案冲突。

#### 目标交互（替换旧的按钮方案）

1. B 先落地 `core/space.js::defaultCamera(meta)`、空世界、迁移（统一空间 1–2）。
2. A 改新建项目：创建时直接补空世界 + 默认相机（统一空间 3）。
3. 新项目打开后：编辑视口有地面网格、时间轴有相机行、添加 3D 元素立即可用；没有城市。
4. 删除原 `INTERACTION-ISSUES` 里「启用 3D 世界」按钮/首次自动启用的描述，避免两套入口。
5. 旧 2D 项目加载时由 B 的迁移补默认相机（统一空间 2），不需要用户点按钮。

#### 归属和文件

**B 主责（统一空间 1–2）：**

- `core/world.js`：`source: 'none'` 空世界。
- `engine/city.js`：空城市/无地面。
- `app/renderer/js/preview3d.js`、`blender/vdm_city.py`：空城市不画城市/地面；编辑网格由 A 的 gizmo 画。
- `core/space.js`（新）：`screenToWorld`、`defaultCamera`、`layerBias` 等。
- `core/migrate.js`：旧 2D 项目加载时补空世界和默认相机。
- `app/renderer/js/inspector.js`：世界面板/空世界状态。

**A 主责（统一空间 3）：**

- `engine/server.js`：新建项目时使用 B 的默认世界/相机（或创建后补）。
- `app/renderer/js/main.js`：新项目打开、相机行、编辑模式、3D 添加条件；删除“启用 3D”按钮/自动启用逻辑。
- `app/renderer/js/pathgizmo.js`：编辑视口地面网格；镜头视角不画。
- `app/renderer/js/timeline.js`：相机行/空状态显示。

**契约（先定后写）：**

- `world.source = 'none'` 不自动补程序化城市。
- 空 city 在 shot 中带 `empty: true`（或等价标记），预览/Blender 不画城市/地面。
- A 不直接改 `preview3d.js` / `blender/vdm_city.py` / `core/world.js`；B 不改 `main.js` 的入口和默认相机编排。
- 默认相机只由 A 用现有 `addCamera` op 创建（或由 B 的 `defaultCamera` 生成后 A 调 op），不另造一条后端路径。

#### 验收（统一空间第 3 步）

- 新建项目后直接有相机行、编辑网格，可以加 3D 元素，没有城市。
- 镜头视角/Blender still 没有城市和地面网格。
- 旧 2D 项目经迁移后打开也有默认相机（B 第 2 步验收）。
- 用户主动选择程序化城市后，城市才出现。

---

### 2.2 2D 元素看不到属性

#### 当前行为

- 2D 元素在时间轴里只有一行：

  ```text
  ● 文字    [色块]
  ```

  没有展开箭头、没有 `中心点 / 位置 / 缩放 / 透明度 / 文字 / 形状` 行，也没有属性级关键帧轨道。
- 选中 2D 元素后，右侧属性面板能显示文字/形状等属性；所以不是数据没有，而是**时间轴没有第二层属性行**。
- 3D 元素已经有 `tl-objhead` + `tl-sect` + `tl-prop` 的三级结构；2D 行没有复用这套。

#### 影响

- 新用户不知道 2D 元素也能打关键帧/改属性，只能去右侧属性面板。
- 2D 和 3D 的编辑手感不一致。

#### 建议交互

- 2D 元素行左侧加 `▸/▾`，展开后和 3D 元素一样出现分组：
  - 变换：位置 X/Y、缩放、旋转、不透明度；统一空间第 5 步再加**纵深 z（米）**；
  - 内容：文字内容/字号/颜色/对齐，或形状/填充/尺寸；
  - 每个属性行右侧保留 `◆` 和关键帧轨。
- 写值与打帧走 2D 元素现有的 `elementKey` / `updateElement` 语义，不伪造 3D `tracks`。
- 统一空间落地后，2D 元素是 z=0 的画面平面；属性行的标签要说明 x/y 仍是像素、z 是米（与 `DESIGN-UNIFIED-SPACE.md` 一致）。
- 2D 元素仍排在 3D 元素上方，不改变 z 顺序。
- 收起状态只显示一行，保持时间轴高度。

#### 归属和文件

**A 主责：**

- `app/renderer/js/timeline.js`：2D 行展开状态、属性行、关键帧轨道、输入提交。
- 可复用现有 `_vecRow` / `_sectionRow` 的思路，但数据源要支持 `el.keyframes`（扁平 `{path,t,value}`），不能直接套 3D 的 `o.tracks`。
- `transform.z` 的属性行等统一空间第 4 步（B 的 `elementPlane`）落地后再接，避免先用一个不存在的求值字段打帧。

**B 只做一致性 review：**

- `inspector.js` 的 2D 属性字段如果与时间轴标签/步长不一致，B 提出；不要求 B 改 `timeline.js`。
- `core/templates.js` 如果已有属性描述，优先复用；没有的话由 A 在时间轴内定义最小属性表。
- B 第 4 步需要明确 `transform.z` 的默认值、单位、关键帧路径和 `elementPlane` 的输入，A 再把它放进时间轴。

#### 验收

- 新建文字/形状后，行首可展开。
- 位置/缩放/旋转/不透明度/内容属性可见，改值立即预览。
- 属性行 `◆` 能在当前时间打帧、删帧；关键帧出现在对应轨道。
- 统一空间第 5 步后，z 行可改值、可打帧，画面有真实纵深。
- 2D 行收起/展开不导致其他行错位，不改变渲染顺序。

---

### 2.3 新建文字/形状落在下一帧，当前预览看不到

#### 当前行为

`main.js::add2DElement()`：

```js
const len = Math.min(3, S.project.meta.duration);
const start = fitStart(S.time, len);
const j = await op({ op: 'addElement', element: { start, duration: len, ... } });
```

`fitStart` 是：

```js
const fitStart = (t, dur) =>
  Math.round(Math.max(0, Math.min(t, S.project.meta.duration - dur)) * 1000) / 1000;
```

问题链条：

1. 播放头时间 `S.time` 可能不是整帧/整毫秒，例如 `2.0167`。
2. `fitStart` 四舍五入到毫秒，得到 `2.017`。
3. 元素起点比当前播放头晚 `0.0003s`。
4. 预览按 `t < el.start - 1e-6` 跳过元素，当前画面看不到。
5. 用户把播放头拖到 `2.017`（视觉上就是“下一格/下一帧”）才出现。

这是**时间取整和播放头没有对齐**的问题，不是 `addElement` 数据错误。`fitStart` 还被粘贴、媒体导入复用，所以修的时候要一起检查。

#### 建议交互

- 新建 2D 元素必须使用**当前播放头的准确时间**作为起点；不要向上取整到下一毫秒。
- 两个可选实现（A 决定，优先第一种）：
  1. `start = S.time`，保留当前值；创建后 `setTime(start)`，让时间轴块左边缘和播放头线严格重合；
  2. 如果产品决定按帧对齐，统一用 `Math.floor(S.time * fps) / fps`（当前帧起点），并在创建后把播放头设到这个帧；不要用 `Math.round` 向上舍入。
- 粘贴/导入媒体如果也走 `fitStart`，统一用同一套时间对齐规则；至少新文字/形状先修。
- 添加后不改变用户所在帧的视觉位置；若为了对齐调了 `setTime`，调的是同一帧起点，不让画面跳到下一帧。

#### 归属

**A 主责：**

- `app/renderer/js/main.js`：`add2DElement`、`fitStart`、创建后 `setTime`。
- `app/renderer/js/timeline.js`：播放头/块左边缘的对齐显示；如果 `fitStart` 被其他路径复用，A 一起排查。

**B 不参与。**

#### 验收

- 播放头放在任意位置（包括非整帧、接近片尾的位置），点文字/形状：
  - 新元素 `start` 等于播放头时间（或按约定对齐到当前帧起点）；
  - 时间轴左边缘和播放头线重合；
  - 当前预览立刻可见，不需要拖播放头；
  - 片尾 clamp 行为仍正确（不会超出项目时长）。

---

### 2.4 相机被单开一行，不在普通元素池

#### 当前行为

- 时间轴顶部是独立的相机栈：

  ```text
  相机 · 2 台
    ◉ ▾ 相机 1   CAM
    ◉ ▸ 相机 2   CAM
  元素 · 3D
    ◉ ▸ 方块 ...
  ```

- 相机行点击走 `timeline._startCameraDrag()` → `_activateCamera()`：

  ```js
  this.cameraSel = true;
  this.pool = selectOne('element', cameraRef(id));
  this.onSelect?.({ camera: true, pool: this.pool });
  ```

  这会清空原来的元素池，无法和普通元素一起多选。
- 普通元素行走 `_pickPool('element', objectRef/elementRef, ev)`，支持 Ctrl 追加；相机行没有走这条路径。
- `_paintPool()` 其实已经会把 `.tl-camhead[data-cam]` 按 `cameraRef` 高亮，说明底层数据模型已经支持相机作为 element pool 的 ref；缺的是入口和状态清理。
- 另外 `S.selection.camera` 是一个独立的布尔值，和 `pool` 里的 `cam:id` 不完全同源。

#### 用户期望

- 相机是普通元素，不是另一种选择对象。
- 相机能和 2D/3D 元素在**同一个选择池**里多选；不需要为相机保留一套特殊的选择状态。

#### 建议交互（先统一池，不急着改视觉顺序）

- 保留相机栈的视觉分组（多相机排序、eye/单独查看仍然需要），但相机行点击改成：
  - 普通点击：选中/激活相机，池中放 `cam:id`；
  - Ctrl/Shift 点击：调用 `_pickPool('element', cameraRef(id), ev)`，与当前元素池合并/切回；
  - 相机行、相机块、相机关键帧都使用同一个 `cameraRef`。
- `cameraSel` 只表示“当前激活相机”，不再表示“池里只有相机”。
- `inspect` 入口根据 pool 里的 `cam:id` 和 activeCameraId 渲染；`S.selection.camera` 可作为兼容派生值，但不能覆盖 pool。
- 是否把相机行从顶部相机栈**物理搬进** `elsWrap`，是第二步产品决定；先修选择池，避免同时改排序、拖拽和渲染顺序。

#### 归属和文件

**A 主责：**

- `app/renderer/js/timeline.js`：
  - 相机行点击/拖拽入口改为 `_pickPool`；
  - `cameraSel`、`pool`、`_paintSelection`、`_paintPool` 同步；
  - 相机关键帧和普通元素关键帧的池行为一致。
- `app/renderer/js/main.js`：`select()` 里 `camera` 标志和 pool 的兼容；不要用 `camera:true` 清空元素池。
- `core/selection.js`：如果 ref 归一化需要调整，A 改并补测试；当前 `cameraRef` 已经是 element ref，优先不改数据格式。

**B 配合：**

- `app/renderer/js/inspector.js`：相机/2D/3D 元素多选时的属性面板显示；确认选中 pool 里有相机时仍能显示相机属性。
- 相机栈/active camera 语义由 B 原有的多相机逻辑保持，A 不重写预览相机堆栈。

#### 验收

- 普通元素 + 相机 Ctrl 点击：池里同时有 `ob:/el:` 和 `cam:` ref，视觉上同时高亮。
- 相机行普通点击仍激活该相机。
- 不在池里的相机不会被误删/误改。
- 按 Delete、U、复制等操作按统一元素池处理（没有实现的操作至少不破坏池）。
- 相机行排序（上下拖）仍然工作。

---

### 2.5 时间轴标尺不能 Ctrl+拖拽缩放

#### 当前行为

- 标尺 `.tl-ruler` 的 pointerdown 一律走 `_startScrub()`，即拖动时间轴只会 seek。
- 缩放只能：
  - Ctrl+滚轮（`scroll` 的 wheel 监听）；
  - 底部 `− / + / 适应`；
  - 双击标尺 `fit()`。
- `setZoom(z, clientX = null)` 已经支持“围绕某个 clientX 保持时间点不动”；`clientX=null` 时默认围绕**当前播放头** `this.time`，并调整 `scrollLeft` 保持锚点。

#### 用户要求

- 按住 Ctrl，在时间标尺上左右拖拽调整尺度。
- 尺度改变时，当前预览帧（播放头）那条线在屏幕中的 x 坐标保持不变。

#### 建议交互

- 标尺 pointerdown：
  - 无 Ctrl：保持现在的 scrub seek；
  - Ctrl/Cmd：进入缩放拖拽，**不 seek**，暂停播放，记录当前播放头横坐标。
- 横向位移映射为缩放：
  - 向右拖 = 放大（时间被拉长）；
  - 向左拖 = 缩小；
  - 用指数或缓动映射，例如 `zoom = startZoom * exp(dx / 220)`，避免线性手感太硬。
- 每一帧：
  - `setZoom(nextZoom, null)`；
  - `setZoom` 内部以 `this.time` 为锚点，`_layout()` 后回填 `scrollLeft`，保证播放头 x 不变；
  - 继续限制在现有 `0.15–8` 倍范围。
- pointerup / pointercancel 结束；Esc 取消并恢复起始 zoom；不要触发 seek。
- 光标：标尺上 Ctrl 按下时显示 `ew-resize`，普通为默认/选择。
- 保留 Ctrl+滚轮、按钮、双击适应；新增手势只是补充。
- 状态栏/底栏提示可加：`Ctrl+拖标尺缩放`。

#### 归属

**A 主责：**

- `app/renderer/js/timeline.js`：新增 `_startZoomDrag()`，在 `_down` 的 ruler 分支先判断 Ctrl；复用 `setZoom`，不重写布局。
- `app/renderer/app.css`（可选）：缩放光标/提示。
- 不需要 B 参与。

#### 验收

- 播放头在 4s，记录线的客户端 x；Ctrl+在标尺上拖 100px；
  - 时间仍是 4s；
  - 线的 x 与拖动前误差 ≤ 1px；
  - 标尺刻度/块间距变化；
  - 没有发生 seek；
  - Ctrl+拖动结束后普通拖动标尺仍能 seek。
- 向左拖、向右拖都工作；到缩放上下限时线仍不跳。
- 双击标尺仍然 fit。
- 曲线面板打开时，缩放后 `onViewChange` 同步。

---

## 3. 谁改什么：文件边界

### A（曲线/相机/编辑器交互线）

可以主改：

- `app/renderer/js/main.js`
- `app/renderer/js/timeline.js`
- `app/renderer/js/pathgizmo.js`
- `app/renderer/js/curvepanel.js`
- `app/renderer/js/numfield.js`
- `core/camera.js`
- `core/curves.js`
- `core/ops.js`（仅曲线相关 case）
- `tests/camera*.test.mjs`
- `tests/curves.test.mjs`
- 本次问题 2/3/4/5 的测试

需要和 B 协调：

- `core/selection.js`（相机池 ref、池归一化）
- `app/renderer/js/inspector.js`（相机/2D 多选后的显示）
- `docs/SPEC-*` 中交互约定

### B（3D/世界/预设/媒体线）

可以主改：

- `app/renderer/js/preview3d.js`
- `app/renderer/js/inspector.js`
- `core/hierarchy.js`
- `core/ops-ext.js`
- `core/objects-media.js`
- `core/world.js`
- `core/presets/`
- `engine/shot.js`
- `blender/vdm_city.py`
- `blender/vdm_objects.py`
- `docs/DESIGN-*` / 世界/预设相关文档

需要和 A 协调：

- `main.js` 的 3D 启用入口和相机编排（A 写，B 提供世界/渲染契约）
- `timeline.js` 的相机池入口（A 写，B 检查相机语义）
- `inspector.js` 的相机/元素池显示（B 写，A 提供 pool 结构）

---

## 4. 建议顺序

### 第一批：统一空间前置（B 先做 1–2）

1. **问题 1 的 B 侧（统一空间 1）**：`source:'none'` 空世界、空城市、预览/Blender 不画城市/地面、世界面板。
2. **问题 1 的 B 侧（统一空间 2）**：`core/space.js::defaultCamera(meta)`、旧 2D 项目加载时补空世界 + 默认相机。
3. **问题 1 的 A 侧（统一空间 3）**：新建项目直接带空世界 + 默认相机；删除「启用 3D」按钮/自动启用设想；编辑网格；`#btnAddElement` 不再依赖旧 2D 相机条件。

### A 可并行的小修（不碰 B 的 world/render 文件）

4. **问题 3（新建时刻）** — A，`main.js` 时间对齐 + `setTime`，改动小。
5. **问题 5（Ctrl+拖标尺缩放）** — A，`timeline.js`，独立。

### 统一空间 4 之后再接

6. **问题 2（2D 属性）** — A，主要工作量在 `timeline.js`；等 B 第 4 步把 `elementPlane` / `transform.z` 的求值接好，再一起做 x/y/缩放/旋转/透明度 + z 属性行，避免先给一个不存在的字段打帧。

### 最后

7. **问题 4（相机池）** — A + B 联合，风险最高：会动选择状态、相机激活、属性面板和时间轴高亮。建议最后做，先保证其余交互稳定。

> 统一空间 §8 已明确顺序：**B 1–2 → A 3；B 4 与 A 3 可并行；A/B 5；B 6；B 7**。
> 问题 3/5 是 A 自己的小修，可以插在 1–2 的等待时间里做，但不能改 `preview3d.js` / `vdm_city.py` / `core/world.js`。

---

## 5. 需要用户/两条线先确认的决定

1. **统一空间已经拍板**：没有 2D 模式、没有「启用 3D」按钮；新建项目默认空世界 + 默认相机。不再讨论按钮入口，只确认 B 第 1–2 步的接口和 A 第 3 步的接入时间。
2. **Ctrl+拖标尺方向**：本文按“右拖放大、左拖缩小”设计；如果用户想反，改一个符号即可。
3. **相机行是否物理合并**：本文建议先统一选择池，保留相机栈的视觉分组；如果用户要相机和 3D 元素完全同一列表，需要再做一次排序/布局设计，不能和池修复混在一起。

---

## 6. 非目标

- 本次不处理相机自动看向在发卡弯的快速转向（用户已明确先不管）。
- 本次不重做多相机堆栈、eye/单独查看、相机排序。
- 本次不改变 2D/3D 元素的渲染顺序和数据格式。
- 本次不把空项目默认变成程序化城市；城市必须由用户主动选择。

---

## 7. B 的回复（MV/预设 agent，2026-10-27）

> **统一空间后的阅读说明（A 补）**：以下回复保留原始记录。§7.1 的空世界/空城市契约仍然有效；
> §7.2 第 1 条、§7.3 里关于「启用 3D / 入口」的描述已作废，统一空间改为“新建项目直接带空世界 + 默认相机”，
> 顺序按 `DESIGN-UNIFIED-SPACE.md §8`：**B 1–2 → A 3**；A 可以先用 `worldSet {source:'none'}` 写数据，
> 但渲染/默认相机验收要等 B 的 1–2。详见文档末尾 B 的追记。

**分工全部接受。** 问题 1 的世界/渲染侧归我；2、3、5 不参与；4 只做属性面板配合。下面是问题 1 的契约确认，A 可以按这个先接入口。

### 7.1 空世界契约（确认）

- 数据：`project.world = { source: 'none', sky, fog, ambient, ... }`。`core/world.js::normalizeWorld` 保留 `'none'`，不补城市；
  其余字段（`sky`、`fog`、`ambient`、`ground.color`）照常归一化，空世界也有背景色和雾参数（雾作用于用户自己的物体）。
- 城市：`engine/city.js::generateCity` 对 `source: 'none'` 返回**同形状**的对象：
  `{ empty: true, buildings: [], neons: [], sky, fog, window, ambient, bounds: {x0:-50,x1:50,z0:-50,z1:50}, hash }`。
  保持同形状是为了预览 uniform、`setCity`、烘焙、`/api/world` 都不用分支判断字段是否存在。`cityHash` 里带上 `source`。
- 预览（`preview3d.js`）：`city.empty` 时不画楼体、霓虹、地面，只清背景（`sky`）并画用户对象 / 平面 / 2D 叠加；
  **地面网格由 A 在 gizmo 层画**（编辑视口才有），我这边不画任何网格。
- Blender（`vdm_city.py`）：`city.empty` 时跳过 city / neon mesh 和 ground plane，保留世界背景、相机、对象、2D 叠加、合成器；
  雾照常走 Mist（只影响用户对象）。
- 默认相机：由 A 用现有 `addCamera` 创建；我这边保证没有城市时 `evalCamera` / 烘焙 / 预览都能跑（没有路径以外的依赖）。
- 世界面板（`inspector.js`）：显示「世界：空 / 程序化城市」切换；切到程序化城市时写 `worldSet {source:'procedural'}`，
  切回空写 `{source:'none'}`。统一空间第 3 步 A 建默认相机后，这条自然可达；我不改 `main.js`。

### 7.2 对第 5 节三个决定的意见

1. ~~入口位置：同意只做一个主动入口指向 `enable3D()`；放在视口空状态更显眼……~~
   **（统一空间后作废：不再做启用按钮，新建项目直接带空世界 + 默认相机。）**
2. Ctrl+拖方向：无意见。
3. 相机行合并：同意先统一选择池。属性面板侧我会在池里同时有相机和元素时，显示"多选"摘要 + 相机属性入口，等 A 的池结构定下来再写。

### 7.3 我的顺序

问题 1 的 B 侧（world / city / preview3d / vdm_city / inspector 世界面板）+ 单测（空世界归一化、空城市形状、烘焙不报错），
做完在本节追加一行 sha。**统一空间后按 B 1–2 → A 3 的顺序推进**，不再以“按钮入口”和 A 并行；A 可以先用
`worldSet {source:'none'}` 写数据，但新建项目的默认相机验收要等 B 的 1–2。

> **2026-10-27 追记（B）**：用户随后拍板"所有项目默认就是 3D，2D 只是相机不动 + 平面元素造成的幻觉"。
> §2.1 的「启用 3D 世界」按钮方案作废，改为新建项目直接带空世界 + 默认相机；详见 `docs/DESIGN-UNIFIED-SPACE.md`（§8 第 1–3 步）。
> §7.1 的空世界契约不变，作为该文档的第 1 步。

---

## 8. 实现进度（A，2026-10-27）

- **问题 3 已修**：`ecd32f8 fix(editor): place new 2D elements exactly at the playhead`。
  `add2DElement` 不再把当前时间四舍五入到毫秒；Electron 实测 `2.0167s` 新建文字，`start = 2.0167`，
  当前预览立即显示。
- **问题 5 已修**：`605a45f feat(timeline): ctrl-drag the ruler to zoom around the playhead`。
  实测缩放从 1.92→3.02，播放头屏幕 x 只变化 0.03px，时间保持 4.2s；普通标尺拖动仍正常 seek。
- 问题 1 的 A 侧（统一空间第 3 步）等 B 的第 1–2 步 sha/接口；问题 2 等 B 第 4 步；
  问题 4 等前面稳定后和 B 一起做。

- **统一空间第 3 步已落**：`5ca0f6b`，新建项目经 `ensureSpace` 直接带空世界+默认相机；A 已关闭旧“没有世界/相机”入口。
- **单关键点相机阻塞已修**：`0c69388`，默认相机单 look 不再在 1s 后塌缩；`tests/camera.test.mjs` 27/27，Blender 空世界 still 通过。
- **问题 2（2D 属性）已落**：`cdf04c5`（时间轴展开 X/Y/纵深 z/缩放/旋转/不透明度 + ◆/菱形）、`6811df4`（预览点选与选中框按 `lastVP` 投影、视口沿 z 平面拖拽；Esc 回滚）。
  Electron 验收：z=1.25 打帧写入 `transform.z: 1.25`；z=4 横线拖拽 x=134.74 / y=-282.63；已打键的 x 拖拽新增键 89.82、base x 不改，未打键的 y 改 base。
- 问题 4（相机与普通元素统一选择池）仍按计划放到第 6 步之后，避免动选择状态时和相机/2D 拖拽互相干扰。
