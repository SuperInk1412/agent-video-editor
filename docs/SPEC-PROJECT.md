# 项目格式与求值语义（vdm.project/1）

一个项目 = `projects/<name>/project.vdm.json` + `media/` 目录。

## 坐标系

- 单位：**项目像素**，原点在画面中心，**x 向右、y 向下**（和 CSS/预览一致；Blender 侧取反）。
- 画面尺寸由 `meta.width/height` 决定，默认 1920×1080。
- 元素 `transform.x/y` 是相对中心的偏移；`scale` 为倍数；`rotation` 为角度。
- 图片/视频的 `scale=1` 表示"cover 填满整个画面"；文字以 `style.size` 为字号。

## 顶层结构

```jsonc
{
  "schema": "vdm.project/1",
  "rev": 12,                       // 每次保存 +1
  "meta": {
    "title": "锈梦 · Demo",
    "fps": 24, "width": 1920, "height": 1080,
    "duration": 24,
    "background": "#05070d",
    "audio": { "src": "media/bgm.m4a", "offset": 0, "gain": 0 },
    "beats": [0.366, 0.869, ...],  // 秒
    "tempo": 119.32,
    "fx": { "bloom": 0.55, "ca": 0.35, "grain": 0.12, "vignette": 0.5,
            "scanline": 0.22, "grade": 0.15, "contrast": 0.08, "saturation": 1.12 },
    "style": "neon"
  },
  "segments": [
    { "id": "seg_1", "name": "镜 01", "start": 0, "duration": 3.9,
      "intent": "夜之城不睡", "status": "draft" }   // draft | previewed | approved
  ],
  "elements": [ /* 见下 */ ]
}
```

## 元素

```jsonc
{
  "id": "el_title",
  "name": "主标题",
  "type": "text",                  // image | video | text | solid | shape | audio
  "src": "",                       // image/video/audio：相对项目根的路径
  "segment": "seg_1",              // 可空
  "start": 0.2, "duration": 3.2,
  "z": 1,                          // 越大越靠前（audio 不使用，但保留字段）
  "visible": true,
  "transform": { "x": 0, "y": -20, "scale": 1, "rotation": 0, "opacity": 1 },
  "style": { ... },
  "fx": { "glow": 0 },             // 元素级：辉光
  "motion": { "type": "in", "amount": 0.08 },   // none/in/out/left/right/up/down/drift/shake
  "punch": 0.8,                    // 跟随节拍缩放（0..2）
  "fadeIn": 0.45, "fadeOut": 0.4,
  "srcIn": 0,                      // video/audio：从素材的第几秒开始播
  "loop": false,                   // video/audio：true 才允许长度超过素材本身
  "volume": 1,                     // audio：基础线性音量 0..1
  "keyframes": [ { "t": 0.2, "path": "transform.scale", "value": 0.9, "ease": "outExpo" } ]
}
```

- 音频元素的音量关键帧 path 是 `audio.volume`，值 `0..1`；与元素时间一样是绝对时间。
  `volume` 是基础值；有键时按线性段插值（预览和成片一致）。
- `video`/`audio` 的 `duration` 是从源素材截取的窗口长度，不是变速拉伸。没有 `loop: true` 时，
  `srcIn + duration` 不能超过素材源时长；时间轴拖动会被限制在素材结尾，`ops` 也会按
  `meta.sourceDuration`（添加素材时 probe 得到）兜底 clamp。开启 `loop` 后长度可超过素材，
  预览、抽帧和混音都从素材 0 秒重新循环。
- `audio` 没有画面，预览和 Blender 的 2D 图层都会跳过它；它只进入声音混音和项目时长计算。
- 旧项目的 `meta.audio` 仍是配乐/节拍分析的兼容字段；打开时 `ensureAudioElements()` 会把它变成一条
  `type:"audio"` 元素并写 `meta.audioMigrated: true`，之后再编辑/切分/音量都是元素操作，不会重复生成。
- 关键帧的 `t` 是**项目绝对时间**（秒），不是相对元素起点。
- `motion.span = [t0, t1]`（可选）把运动预设钉在一段绝对时间上；没有时按元素自身的
  `start..start+duration` 走。切分会写入它，让两半延续同一个运动。

### style 字段

| 类型 | 字段 |
| --- | --- |
| text | `text, font, size, weight, color, align(left/center/right), lineHeight, letterSpacing, shadow` |
| image/video | `fit: cover\|stretch` |
| shape/solid | `shape: rect\|ellipse, fill, w, h, radius` |
| 通用 | `blend: normal\|add\|screen` |

## 求值顺序（**预览与 Blender 必须一致**）

```
1. base   = transform/style 里的静态值
2. 关键帧  = 对同 path 的关键帧按 t 插值（数值线性 + ease；字符串/颜色取前值）
3. motion = 预设增量（scale 乘法、x/y 加法、rotation 加法），进度 p 取 motion.span 或元素自身范围
4. punch  = 每个节拍点乘 (1 + punch·0.05·e^{-Δt/0.12})，和有没有运动预设无关
5. fade   = opacity × clamp((t-start)/fadeIn) × clamp((end-t)/fadeOut)
```

`motion.amount`：`in/out` 是缩放幅度；`left/right` 是画面宽度的比例；`up/down` 是高度比例；
`drift` 为宽 0.5/高 0.25 倍的比例；`shake` 为手持抖动强度。

实现：`core/evaluate.js`（JS）与 `blender/vdm_build.py::eval_element`（Python）逐行对应。

## 全局 fx

| 字段 | 范围 | 说明 |
| --- | --- | --- |
| `bloom` | 0..2 | 阈值 0.55 的雾状辉光 |
| `ca` | 0..1 | 径向色散（镜头色差） |
| `grain` | 0..1 | 随时间滚动的颗粒 |
| `vignette` | 0..1 | 椭圆暗角 |
| `scanline` | 0..1 | 三行一组的扫描线 |
| `grade` | -1..1 | 负=冷、正=暖 |
| `contrast` | -1..1 | 对比度 |
| `saturation` | 0..2 | 饱和度 |

Blender 侧这些效果由合成器节点组 `VDM_Composite` 完成。节点组必须声明输出接口
（`ng.interface.new_socket('Image', in_out='OUTPUT', ...)`）再连到 `NodeGroupOutput`；
只连到输出节点的空占位接口时，节点组没有结果，Blender 会直接写出原始渲染（2026-10-27 之前的成片都是这种情况：
没有雾、调色、辉光、颗粒和暗角）。

## 2D 元素在统一空间里（所有项目都是 3D）

见 `docs/DESIGN-UNIFIED-SPACE.md`。每个项目都有世界和相机（新建、或打开没有相机的旧项目时由 `core/space.js::ensureSpace` 补上）；
`elements` 里的 2D 元素是世界里**没有厚度的平面**：

- 画面平面在 `z = 0`，下沿落地，100 px = 1 m：`X = x / 100`，`Y = height/200 − y / 100`，`Z = transform.z`（**米**，正值朝相机，可打关键帧 `transform.z`）。
- 默认相机在画面平面正前方 20 m，水平 fov 恰好铺满画面，无运动模糊、无抖动、无自动侧倾；相机不动、`transform.z = 0` 时与旧 2D 渲染一致
  （miku-swiss golden：Blender 平均差 ≤ 0.014/255，差值 > 8 的像素 ≤ 0.04%）。
- 相机移动或元素 `transform.z` 变化就产生透视和视差（实测与透视公式的误差 < 0.6 px）。
- 图层顺序：预览按"距离由远到近，同距离按图层"绘制，开深度测试但不写深度（会被 3D 物体遮挡）；Blender 中每层沿深度轴错开 0.1 mm。
- 预览：2D 图层在 Scene3D 画完自己的物体后，用同一个视图投影矩阵画进世界（编辑视口、相机分层、鱼眼同样适用）。
- Blender（单相机路径）：2D 构建器（同一套 `eval_element`）把元素建进 3D 场景，挂在 `VDM_Screen` 支架下（位于画面平面中心、缩放 1/100）；
  空世界用 0.8 的像素滤镜（与 2D 一致）。
- **贴屏（以相机为父）**：`el.parent = { id: <相机 id>, kind: 'camera', bind: { pos, basis } }`，ops `elementParent {id, parent, t}` /
  `elementUnparent {id, t}`（`core/hierarchy.js`，经 ops-ext 注册）。绑定时不动；之后元素随相机的刚体运动（位置 + 旋转）一起动，在画面上保持原位；
  变焦（fov）仍会改变它的大小。取消时元素中心留在原处（x / y / z 及其关键帧平移，旋转不回写）。预览在 VERT 里乘 `u_carry`，
  Blender 用逐帧烘焙的 `shot.elementCarriers` 驱动 `VDM_Carry_<id>` 空物体。检查器 2D 元素「贴屏」开关绑定到当前激活相机。
- **已知限制**：多相机分层（VSE）路径仍把 2D 元素作为贴屏层叠在最上面（不产生视差）；预览里 2D 元素点选已经按 `scene3d.lastVP` 投影，相机移动后命中与选中框一致。
- **编辑器剪贴板**：Ctrl+C / Ctrl+V 复制选中的 2D 元素和 3D 对象，保存在本机 localStorage，跨项目重启仍可用；
  粘贴时保持组内相对时间，落到当前播放头，2D 副本放到当前图层最上面。跨项目只带元素数据，`media/` 文件不会随剪贴板复制。
- **时间轴列表顺序（编辑器状态）**：`meta.ui.timelineOrder` 是左侧统一列表自上而下的引用数组
  （`cam:<id>` / `el:<id>` / `ob:<id>`）。只有 2D 行的相对顺序会写回 `el.z`、相机行的相对顺序会写回
  `cameraOrder`；3D 物体和声音行只改变显示顺序，不参与求值/渲染。编辑器用现有 `setMeta` 写入，
  一次拖动一次撤销；读入时按 `el.z` / `cameraOrder` 重排对应的槽位，过期引用忽略、缺失引用补入。

## 相机与镜头片段

相机栈在 `cameras[]`，`cameraOrder` 是自顶向下顺序，`activeCameraId` 是编辑相机（`camera` 是它的旧别名）。
相机路径 `/ tracks` 的关键帧时间都是**项目绝对时间**。

```jsonc
{
  "id": "cam_1", "name": "主机位",
  "start": 0, "duration": 3.2,     // 片段范围，可省略
  "path": [ { "t": 0, "pos": [0, 5, 20], "look": [0, 5, 0] } ],
  "tracks": { "fov": [ { "t": 0, "v": 62 } ] }
}
```

- `start` / `duration` 都可省略：省略 = 覆盖整个项目（旧相机行为不变）。给了 `duration` 后片段是
  半开区间 `[start, start+duration)`；`start` 缺省为 0，`duration` 缺省到项目结束。
- `cameraLayers(project, solo?, t?)`：不传 `t` 返回整栈（渲染器和相机栈 UI 用）；传 `t` 只返回覆盖该时刻的片段。
- `evalCamera(project, t)` 的「当前镜头」：active 相机覆盖 `t` 就用它；否则取栈里最上面一台覆盖 `t` 的可见相机；
  都不覆盖才回退 active。`elementParent { parent: '@live' }` 跟着这个当前镜头走。
- 相机也是可切分的元素：`splitElement {id, at}` 在相机 id 上走相机分支。左半保留原 id，右半新 id，
  `start = at`，名称加 ` · 2`，路径和参数轨用与 2D 元素相同的 range 规则保留（不插新键），
  右半插在 `cameraOrder` 中源相机下面并设为 active。`moveElement {id, start, duration}` 同样接受相机 id：
  平移会带着路径 / 参数键一起走，裁边保留键的绝对时间。
- 项目总时长只把带**显式 `duration`** 的相机片段计入（否则旧全段相机不会因为项目变短而被截断）。

## ops（唯一的写入口）

```jsonc
{"op":"addElement","element":{...}}
{"op":"addElement","element":{"type":"audio","src":"media/voice.m4a","start":2,"duration":4,"srcIn":1,"volume":0.8}}
{"op":"updateElement","id":"el_x","patch":{"style":{"text":"新字幕"},"transform":{"y":-40}}}
{"op":"set","id":"el_x","path":"style.color","value":"#ffd400"}
{"op":"removeElement","id":"el_x"}
{"op":"duplicateElement","id":"el_x","start":4.0}
{"op":"moveElement","id":"el_x","start":4.0,"duration":2.5,"z":3}
{"op":"moveElement","id":"cam_1","start":2.0,"duration":3.0}   // 相机片段同样
{"op":"splitElement","id":"el_x","at":2.3}
{"op":"splitElement","id":"cam_1","at":2.3}                    // 相机 id：切成两个镜头片段
{"op":"splitAt","at":2.3,"ids":["el_a","el_b"]}   // 不传 ids：切开红线经过的所有元素
{"op":"reorder","id":"el_x","z":5}
{"op":"addSegment","segment":{"start":0,"duration":3,"name":"镜 01"}}
{"op":"updateSegment","id":"seg_1","patch":{"status":"approved"}}
{"op":"removeSegment","id":"seg_1"}
{"op":"setMeta","path":"background","value":"#05070d"}
{"op":"setFx","fx":{"bloom":0.6}}
{"op":"keySet","id":"el_x","path":"transform.scale","t":1.6,"value":1.15,"ease":"outExpo"}
{"op":"keyRemove","id":"el_x","path":"transform.scale","t":1.6}   // 不带 t：清空整条轨
{"op":"batch","ops":[...]}
```

时间相关的编辑语义（预览和 Blender 都依赖它们，改动要补测试 `tests/edit.test.mjs`）：

- **moveElement**：只改 `start`（或 `start` 加不变的 `duration`）= 平移，关键帧和 `motion.span`
  一起平移；`start` 和 `duration` 一起变 = 左裁剪，关键帧留在原处，视频的 `srcIn` 前进同样的秒数。
  `"keys": "shift" | "keep"` 可以显式指定。相机 id 也走这里（平移带路径/参数键，裁边保留绝对时间）。
- **splitElement**：两半各保留自己范围内的关键帧，外加每条轨在范围外最近的一个（保证插值不变）；
  相机路径是 Catmull-Rom 曲线，额外保留两侧第二个键以保住切线（同样不插新键）。切口处左半不淡出、右半不淡入；
  右半视频的 `srcIn` 接上左半；有运动预设时两半共用原来的 `motion.span`；相机右半插在源相机下面并成为 active。
  结果：切开前后逐帧渲染一致。
- **splitAt**：UI 的「切开」动作。传 `ids` 时只切这些元素里跨过 `at` 的，不传时切所有跨过 `at` 的元素；
  右半段保持原 `z`，但插入到源元素之后，并把全部元素的 `z` 按新顺序重编号，所以右半段就在源元素上一层；
  `changed` 只返回右半段 id，方便编辑器选中它们。操作是原子的。
- **项目总时长**：`applyOps` 在所有时间相关操作（增删/移动/切开/裁剪/复制元素、增删/改时长 3D 对象、
  显式带 `duration` 的相机片段）之后，自动设为所有 2D 元素、3D 对象和相机片段
  `start + duration` 的最大值；元素变长会变大，变短会变小。
- **duplicateElement**：副本放到新 `start` 时，关键帧和 `motion.span` 跟着平移。
- **2D 元素属性**：属性没有关键帧时，时间轴输入框走 `updateElement` 改 `transform` 基础值，所有时间生效；
  已有该属性的键时才走 `keySet` 在当前时间写键。没有键的元素不会因为改一次值就凭空多出关键帧。
- **keySet**：同一时刻已有关键帧时，不传 `ease` 就保留原来的缓动。

校验规则：id 唯一、`duration > 0`、`segment` 必须存在、`type` 合法、分割点在元素内部。
任何一条失败 → 整个批次不落盘。

## 媒体约定

- 所有素材放 `projects/<name>/media/`，元素里写 `media/xxx`（相对路径）。
- 视频在渲染时会被 ffmpeg 抽成 PNG 序列（`fps/scale/cover` 烘焙进去），缓存在 `.vdm/cache/src/`。
- `.vdm/` 中的 `frames/`（静帧）、`renders/`（成片）、`agent/`（上下文包）、
  `cache/`（序列、Blender job、合成器贴图）是产物与缓存，不要手改或提交。
- `.vdm/transactions.json` 是持久化历史、请求回执与提交恢复记录；`.vdm/jobs/` 保存应用任务
  和提交时的项目 / 素材快照。它们不能按普通渲染缓存随意删除。
- 文件格式、编辑语义、场景模型和渲染包分别由 `core/version.js` 管理版本；项目 `rev` 只表示编辑修订。
