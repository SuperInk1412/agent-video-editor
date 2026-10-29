# 修复方案 · 2D 平面前后顺序 + 点空白取消选中 + 播放卡顿

> 状态：**已实施**（2026-10-29，A 照着本方案做）。问题一 `25f54d2`、问题二 1/2 `853a085`、
> 问题三 1–5 `0484387`；问题二 3「元素锁定」还需要另行批准。实施记录见文末。
> 问题三的修法 1–5 由 A 实施（`timeline.js`、`pathgizmo.js`），修法 6 的性能检查 B 已完成并记下基线。
> 每个问题一个提交，可单独回退。

---

## 问题一：斜放的 2D 平面被身后的背景盖住（预览错误，成片正确）

### 现象

miku-swiss，t = 3 s。跟随或单独看「相机 9」时，歌词「02 词2 ながら」（`s2_w2`）不显示；
「镜头 02 見せながら消えてゆくヒカリ」（`cam_8`）里正常显示。

### 核实（像素统计，未看图）

| 画面 | 歌词位置附近 | 结论 |
|---|---|---|
| 预览 · 相机 9 | 最亮像素 RGB 和 = 66（一片暗），歌词色像素 0 | **缺失** |
| 预览 · 镜头 02 | 最亮 732，歌词色像素约 1.5 万 | 正常 |
| Blender · 只开相机 9 | 歌词在画面正中，约 2500 个亮像素 | 正常 |
| 预览 · 相机 9 · 只隐藏 `s2_bg` | 最亮 732 | 歌词出现；隐藏其它任何元素都无效 |

数据本身没有问题：歌词在相机 9 画面正中、正对相机、距离 27 m，没有 3D 物体遮挡，雾从 30 m 才开始，景深关闭。

### 原因

`app/renderer/js/spatial-layers.js::compareLayerPlanes` 给 2D 平面排画的先后（远的先画、近的后画盖在上面）时，
用的是 **相机到这块平面所在的无限大平面的垂直距离**（`layerPlaneDistance`）。2D 平面不写深度，谁后画谁在上。

- `s2_bg`：96 × 54 m 的深色板，正对 +Z，在 z = −2。
- `s2_w2`：歌词，旋转 X 19° / Y 25°，在 z = 0，也就是在背景**前面** 2 m。
- 从相机 9：背景平面垂直距离 25.2 m，歌词平面 26.3 m → 判定背景更近 → 背景后画，盖住歌词。
  实际顺着视线，先到歌词（27.2 m）再到背景（29.6 m）。
- 斜的平面"无限延伸"后离相机可以很近，所以平面距离不能代表这块元素离相机多远。
  镜头 02 离得近、角度正，碰巧排对。

Blender 里每块 2D 平面是真实的物体，EEVEE 按**物体原点到相机的距离**排半透明物体；同一平面上的图层
靠 0.1 mm 的深度偏移按 `el.z` 排（`blender/vdm_build.py` 约 1166 行）。所以成片是对的，预览和成片规则不一致。

### 修法

**预览的排序改成和 Blender 一致：**

1. 不同平面：按 **相机到元素原点的距离** 排，远的先画。元素原点 = 元素的世界帧位置，
   与 Blender 物体原点相同（`frameOf(elementWorldNode(...)).pos`；图层上已有 `L.plane.p` 的，确认它就是这个点）。
2. 同一平面（法线相同、平面距离相同，沿用 `sameLayerPlane`）：仍按 `el.z`，从任何角度看全屏底板都在文字后面。
3. 完全相等：按原数组顺序，只为排序稳定。

- 改动集中在 `spatial-layers.js` 的 `compareLayerPlanes`（新增 `layerOriginDistance`，`layerPlaneDistance` 仍用于判断同一平面）。
- `preview.js` 的 `_drawLayers`（画）和 `hitTest`（点选）已经共用 `orderLayers`，改一处两边一起生效：**点到的就是看到的**。

### 验证

- 单测（`tests/spatial-layers*.test.mjs` 或新增）：
  - 复现本例：正对 +Z 的大底板在后、斜放的文字在前，相机从斜侧看 → 文字排在底板之后画（在上面）；
  - 同一平面的两层：任何相机位置都按 `el.z`；
  - 原有的平面顺序测试全部保留并通过。
- 预览像素探针：miku-swiss t = 3 s 相机 9，歌词色像素 > 0；镜头 02 不变。
- `scripts/check-render-parity.mjs` 通过（预览与 Blender 的格子差异不增加）；`npm test`、`check:preview` 通过。

### 风险

- 两块**相交**的平面无论怎么排都可能有一部分错（Blender 同样如此），这是按物体排序的固有限制，与成片一致即可。
- 原点离可见部分很远的元素（锚点设在边缘的大平面）会按原点排，同样与 Blender 一致。

---

## 问题二：点空白取消选中"像玄学"

### 原因（三个，叠在一起）

1. **报错，点了没反应。** `main.js:1011` 的框选函数 `beginViewportMarquee` 是顶层函数；"按下没拖动"时它调用
   `selectAt`，但 `selectAt` 定义在另一个函数内部（`main.js:3150` 的 `const selectAt`），访问不到 →
   `ReferenceError: selectAt is not defined`（工程日志里已有记录）。预览模式下点空白、编辑模式下没点中任何东西，
   都走这条路径，所以**什么都不发生**。
2. **规则本身不是"清空"。** 就算 `selectAt` 执行了，点空白也是：播放头在段落里 → **改选这个段落**；
   否则只要有相机（几乎总有）→ **改选相机**；两者都没有才清空。所以会时而"没反应"、时而"看起来取消了"（其实选了段落）、时而变成选中相机。
3. **大底板让"空白"不空。** 点选按矩形判断，全屏的背景板（如 `s2_bg`，96 × 54 m）覆盖了几乎整个画面，
   看起来点在空白处，其实点中了背景，于是选中了背景。

时间轴空白处的点击（`timeline.js` 的 `clear()`）已经是"清空选择"，不受影响。

### 修法

1. **修作用域**：把 `selectAt` 移到模块顶层（它用到的 `preview`、`S`、`select` 都是模块级的），
   或者让 `beginViewportMarquee` 接收点选回调；两个调用点（`main.js` 约 3338、3487 行）都要覆盖。
2. **统一规则：单击空白 = 清空选择**（选择池、元素、物体、相机、段落、属性行全部清空）；
   **Ctrl / Shift + 单击空白 = 保持原选择**。预览模式、编辑模式、时间轴空白处同一条规则。
   去掉"改选段落 / 相机"的隐式回退：要选相机，点相机本身或时间轴相机行；要选段落，点段落条。
3. **大底板（可选，需另行批准）**：给元素加「锁定」开关——锁定后视口里点不中、框不中，时间轴里照常可选。
   背景板、全屏遮罩建议锁定。若不做，至少在第 2 条修好后，点中底板时属性面板标题能看出选中的是背景。

> 曲线面板里定的"点空白不清空"（`DESIGN-CURVEPANEL-V2.md` §8 R1）是面板内的特例，
> 因为那里的选区是在时间轴上跨元素挑出来的；与视口规则不冲突。

### 验证

- 真鼠标 E2E（Electron 探针）：
  - 预览模式、编辑选择模式各一次：选中一个元素 → 点真正的空白处 → 选择为空，控制台无错误；
  - 播放头在段落内点空白 → 不会改选段落；有相机时点空白 → 不会改选相机；
  - Ctrl+点空白 → 选择不变；拖框 → 行为不变（替换 / 追加）；
  - 若做第 3 条：锁定的底板点不中、框不中，时间轴里能选。
- `npm test`、`check:preview` 通过；运行中 `window.onerror` 无 `selectAt` 报错。

---

## 问题三：播放卡顿越来越严重

### 现象

预览播放明显卡顿，且工程越大越卡。

### 实测（miku-swiss 副本，Electron 里测帧间隔，未看图）

138 个元素、9 台相机，窗口 1536×816，预览画布 827×465，未选中任何元素。

| 条件 | 播放帧率 | 帧间隔中位数 |
|---|---|---|
| 现状 | **约 22 fps** | 50 ms |
| 播放时跳过 `timeline.setTime` | **60 fps** | 16.7 ms |
| 隐藏时间轴（`display: none`） | 60 fps | 16.7 ms |
| 隐藏 3D 预览画布 | 21 fps | 50 ms（无改善） |
| 只跳过 `_syncProps` | 43 fps | 16.7 ms |
| 只跳过 `_syncFrameBand` | 37 fps | 33.3 ms |
| 只跳过 `_syncPlayhead` / `onTimeChange` | 22 fps | 50 ms（无改善） |

每帧 JS 计时：`preview.render` 1.5–3 ms，`timeline.setTime` 3–4 ms，`gizmo.draw` 28 ms（见原因 3）。
JS 合计约 5 ms，其余 40 多 ms 是**浏览器每帧重排 / 重绘时间轴**。时间轴 2846 个 DOM 节点，占整页 4658 个的六成。

### 原因

1. **`_syncProps` 每帧重写所有行的静态信息**（`timeline.js` 约 3184 行起）。除了随时间变化的属性数值，
   还对每个元素 / 物体 / 相机的行头每帧重设：名字（`textContent`）、片段位置与宽度、片段名和时长文字、
   提示（`dataset.tip`）、显示开关、颜色点、关键帧菱形的 class 与提示。值没变也照写——重设 `textContent`
   会替换文本节点，浏览器只能整块重排。这些信息只在编辑（op）、缩放、滚动时才会变，播放时不变。
   开销与行数成正比：元素和相机变多、2D 元素迁成节点后属性行变多（旋转一行变三行等），所以**越来越卡**。
2. **`_syncFrameBand` 每帧改时间轴根容器上的 CSS 变量**（约 870 行，`--tl-frame-left` / `--tl-frame-w`，
   写在 `.tl-rows` 上）。改祖先节点的自定义属性会让整个子树（2846 个节点）重算样式，而用到它的只有
   `.tl-frame-band` 一个高亮条。
3. **`gizmo.draw` 的 28 ms 是表象**：预览模式下它什么都不画（`visible` 为假），但 `clear()` 读
   `this.scale` → `getBoundingClientRect()`，把上面两条攒下的重排**提前强制执行**了。实验：缓存 `scale`
   后 `gizmo.draw` 降到 0.02 ms，但帧率不变（22 fps）——开销只是挪到了浏览器绘制阶段。

### 修法

1. **静态信息只在变化时刷新**：行头名字、片段位置 / 宽度 / 文字、提示、显示开关、颜色点，改为在
   工程数据变化（op 应用后）、缩放、滚动、展开 / 折叠时刷新；播放的每帧只刷新随时间变化的东西
   （属性数值、菱形 on / has 状态）。
2. **所有写入先比较**：数值框、`textContent`、`dataset`、`style`、`classList` 都只在值变化时写
   （可以给行对象缓存上次写入的值）。
3. **帧高亮带改成独立元素**：`.tl-frame-band` 单独定位，用 `transform: translateX()` 和宽度移动它，
   不再在 `.tl-rows` 上写 CSS 变量；检查其它规则不再依赖这两个变量。
4. **数值刷新只管看得见的行**：折叠的分组、滚出视野的行跳过（滚动 / 展开时补刷）；播放中数值刷新
   降到每秒约 10 次，暂停或拖动播放头时立即刷新到准确值。播放头和时间码仍每帧更新。
5. **gizmo 缓存 `scale`**：窗口 / 画布尺寸变化时（`resize()`、ResizeObserver）更新，`clear()` 和绘制
   不再每帧读布局；`visible` 为假且上一帧已经清空时，直接跳过。
6. **性能回归检查**：新增 `scripts/check-playback-perf.mjs`——打开 miku-swiss（或同规模的生成工程），
   自动播放 3 秒，统计帧间隔中位数和 95 分位；中位数 > 20 ms 或 95 分位 > 34 ms 判失败。
   在同一台机器上记录基线，写进本文实施记录。

### 验证

- 同一副本、同一窗口尺寸重测上表：现状一行应接近 60 fps（中位数 ≤ 17 ms），选中元素并展开属性行后
  不低于 50 fps。
- 功能不退化：编辑后行头名字 / 片段位置 / 时长立刻更新；缩放、滚动后片段位置正确；暂停时属性数值是
  播放头的准确值；正在输入的数值框不被覆盖；帧高亮带位置与播放头一致。
- `npm test`、`check:preview` 通过；新增的 `check-playback-perf` 通过。

### 基线（B，2026-10-29，修复前）

`node scripts/check-playback-perf.mjs`（miku-swiss 副本，138 元素 / 8 相机 / 4507 个 DOM 节点，窗口 1536×816，DPR 1.25，
从 2 s 起播 3 s），连跑两次：

| 次 | 帧率 | 间隔 p50 | p95 | 每帧 JS：时间轴 / 预览 / gizmo |
|---|---|---|---|---|
| 1 | 22 fps | 50 ms | 50.1 ms | 3.5 / 2.3 / 23.6 ms |
| 2 | 23 fps | 49.9 ms | 50.1 ms | 3.4 / 2.3 / 23.1 ms |

判定：**FAIL**（门槛 p50 ≤ 20 ms、p95 ≤ 34 ms）。A 修完后在同一台机器、同一窗口尺寸再跑，应 PASS。
`--report` 只打印不判定；`--project=<dir>` 换工程。脚本没有加进 `npm test`（要开 Electron，耗时约 15 s）。

### 风险

- 漏掉某个"编辑后要刷新"的入口会导致行头显示旧值：所有 op 应用后统一走一次全量刷新，就不会漏。
- 降频刷新数值会让播放中的数值框每 0.1 s 跳一次，属于可接受的显示差异；暂停即准确。

---

## 分工与顺序

| 项 | 负责 | 文件 |
|---|---|---|
| 问题一 排序 | A ✅ `25f54d2` | `app/renderer/js/spatial-layers.js`、单测 |
| 问题一 对拍 | B ✅ `638e063` | `scripts/check-render-parity.mjs` 用例 F（正对相机的卡片在底板前 2 m）：新排序 2/144 PASS，换回旧排序 14/144 FAIL |
| 问题二 1、2 | A ✅ `853a085` | `app/renderer/js/main.js` |
| 问题二 3 锁定 | 待批准后定 | schema（`el.locked`）、`main.js` 点选/框选、时间轴开关 |
| 问题三 1–5 播放卡顿 | A ✅ `0484387` | `app/renderer/js/timeline.js`、`pathgizmo.js`、`main.js`、`css/timeline.css` |
| 问题三 6 性能检查 | B ✅（本提交） | `scripts/check-playback-perf.mjs`（新），基线见问题三 |

问题一、二、三互不依赖，可以并行；各自一个提交，记入改动日志。问题三建议先由 B 加性能检查记下基线，A 改完再测一次对比。

---

## 实施记录（A，2026-10-29）

### 问题一 `25f54d2`

- `spatial-layers.js`：新增 `layerOriginDistance`（相机 → `L.plane.p`，也就是元素原点的世界帧位置）；
  `compareLayerPlanes` 先用 `sameLayerPlane` 判「同一平面」（仍按 `el.z`），不同平面按原点距离远的先画，
  原点距离完全相等（< `PLANE_EPS`）时退回原数组顺序。`layerPlaneDistance` 现在**只**用来判同一平面。
- `preview.js` 只改了两处注释：`_drawLayers` 与 `hitTest` 仍然共用 `orderLayers`，画和点选一起生效。
- 单测（`tests/spatial-layers.test.mjs`，10 条全过）：新增本例（底板平面 25.2 m / 歌词平面 26.3 m，
  原点 29.8 m / 27.2 m → 底板先画）、同一平面四个机位都按 `el.z`、不同法线同一原点按源顺序；
  原有平面顺序测试全部保留。
- 预览像素探针（miku-swiss，t = 3 s，Electron 里读 canvas 像素）：

| 画面 | 最亮 RGB 和 | 歌词色像素 | 中心点选 |
|---|---|---|---|
| 相机 9 · 旧代码 | 345 | **0** | `s2_bg` |
| 相机 9 · 新代码 | 732 | **1286** | `s2_w2` |
| 镜头 02 · 新代码 | 732 | 14846 | `s2_w2`（未变） |

点选也跟着画面走了（旧代码中心点中底板，新代码点中歌词），即「点到的就是看到的」。

- `scripts/check-render-parity.mjs` 现有 A–E 用例通过（B 仍要加「斜文字在底板前」这一例）。

### 问题二 1、2 `853a085`

- `selectAt` 移到模块顶层，`beginViewportMarquee` 和两个 `pointerdown`／`pointerup` 分支共用；
  点空白 = `clearSelection()`（池、元素、物体、相机、段落、属性行全清），Ctrl/Cmd/Shift + 点空白保持原选择。
  去掉「改选段落 / 相机」的隐式回退。「清除选中」命令和 Esc 的取消选中也改用 `clearSelection()`。
- `select()` 认显式 `segmentId: null`（原来 `??` 会保留旧段落头），时间轴空白处 `clear()` 发来的
  「清空」payload 现在与视口一致。
- Electron 探针（临时脚本 `.scratch/probe-empty-click.mjs`，不随仓库提交；合成 PointerEvent
  走真事件处理器，18 项检查）：
  - 旧代码：空白单击不生效，6 次 `ReferenceError: selectAt is not defined`；段落头点了也不清。
  - 新代码：预览 / 编辑模式单击空白都清空（段落头、相机都不会被改选），Ctrl/Shift 保持，元素点选和
    拖框行为不变，`window.onerror` 为空。
- 本次未做：问题二 3（元素「锁定」开关）——方案里写着要另行批准，未加 `el.locked`。

### 问题三 1–5 `0484387`

- `timeline.js`：`_syncProps` 拆成两半——
  - `_syncValues`：只写随时间变的东西（数值框、◆ 的 on/has、关键帧菱形的 `.at`）；
  - `_syncStatics`：行头名字、片段位置 / 宽度 / 名字 / 时长 / 提示、眼睛、颜色点、行选中、属性父级按钮。
  编辑和 blur 仍走 `_syncProps()`（两半都刷），播放只走 `_syncValues`。
- 播放降频：`setTime(t, { live })`。主循环每帧传 `live: true`，数值最多每 90 ms 刷一次
  （`VALUE_SYNC_MS`）；播放头、帧高亮带、时间码照旧每帧更新。暂停 `pause()` 调 `timeline.flushValues()`
  落到准确值；拖动播放头、跳转、截图都是非 live，立即刷新。
- 只看看得见的行：`_visibleSpan()` 取 `scrollTop / clientHeight` 上下各留 120 px，`_visibleRows()`
  **先一次性**把所有 `.tl-row` 的 `offsetTop` 量完再写数值（先写再量会每行触发一次重排），
  折叠的分组（`offsetParent` 为空）和滚出视野的行跳过。滚动和展开逐轴子行时用 rAF 补刷一次
  （`_scheduleValueSync`），所以滚回来不会是旧值。
- 所有写入先比较：新增 `setText / setTip / setAttr / setStyle / setValue`（`setStyle` 把上次的值缓存在
  节点上，因为 `#17d9ff` 读回来是 `rgb(23, 217, 255)`），`writeNumber`、`setClipWidth`、
  `classList.toggle(name, force)` 本来就只在值变化时动 DOM。
- 帧高亮带：`.tl-frame-band` 自己写行内 `transform` / `width`，`.tl-rows` 上不再有
  `--tl-frame-left / --tl-frame-w`（改祖先的自定义属性会让整棵 2800 节点子树重算样式）。
- `pathgizmo.js`：`scale` 改为缓存（`resize()` 清掉），不再每次读取都 `getBoundingClientRect()`
  ——每帧的 `draw()` 排在时间轴弄脏布局之后，这一读就是一次整页重排。`visible` 为假且上一帧已经
  清过画布时，`draw()` 直接返回。
- `main.js`：主循环传 `{ live: true }`；`pause()` 里 `timeline.flushValues()`。

实测（`node scripts/check-playback-perf.mjs`，miku-swiss 副本，138 元素 / 9 相机 / 4532 个 DOM 节点，
窗口 1536×816，从 2 s 起播 3 s，连跑三次）：

| 次 | 帧率 | 间隔 p50 | p95 | 每帧 JS：时间轴 / 预览 / gizmo |
|---|---|---|---|---|
| 修复前（B 的基线） | 22 fps | 50 ms | 50.1 ms | 3.5 / 2.3 / 23.6 ms |
| 1 | 59.7 fps | 16.7 ms | 16.7 ms | 1.3 / 1.84 / 0 ms |
| 2 | 60 fps | 16.7 ms | 16.8 ms | 1.22 / 2.16 / 0 ms |
| 3 | 59.7 fps | 16.7 ms | 16.7 ms | 1.41 / 2.12 / 0 ms |

判定由 **FAIL** 变 **PASS**（门槛 p50 ≤ 20 ms、p95 ≤ 34 ms）。另测最坏情况（选中一个节点元素、
8 个元素展开属性行 + 一个相机属性页打开，6498 个 DOM 节点）：59.7 fps，p50 / p95 16.7 ms。

功能没有退化，Electron 探针（临时脚本 `.scratch/probe-timeline-sync.mjs`，21 项全过）：

- 帧高亮带：49 条带子的行内 transform / width 一致；`band.left` 与 DOM 一致（586 px）且与播放头重合；
  宽度 8.14 px（326% 缩放下一帧的宽度）；
- 数值：跳到 0 s / 3 s 立刻变成 −2 / +2 m，1.5 s 是中点（easeInOut 对称）；播放 0.7 s 后暂停，
  数值框与暂停时刻的准确值一致（没有停在降频前的旧值）；90 ms 内的 live tick 不动，到点的那次会刷，
  `flushValues()` 立即准确；
- 行滚出视野时不刷（符合预期）；滚回来不用再 seek，rAF 补刷后就是当前播放头的值；
- 改名字 / 改时长 / 切换显示后 `_syncStatics` 立刻反映（名字、片段宽度、眼睛图标都对）；
- gizmo：`scale` 缓存生效（1.251 = DPR 1.25），预览模式下 `draw()` 走空白跳过；
- `window.onerror` 为空。

### 验证

- `npm test`：481 项全过。
- `npm run check:preview`：PASS（朝向未变）。
- `npm run blender:check`：PASS（Blender 5.0.1，渲一帧 4.3 s）。
- `node scripts/check-render-parity.mjs`：PASS，144 格里 2 格不同（允许 4 格；B 的用例 F 已加进来）。
- `node scripts/check-playback-perf.mjs`：**PASS**，22 fps / p50 50 ms → 59.7 fps / p50 16.7 ms（问题三）。

