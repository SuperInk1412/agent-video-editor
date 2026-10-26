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
  "type": "text",                  // image | video | text | solid | shape
  "src": "",                       // image/video：相对项目根的路径
  "segment": "seg_1",              // 可空
  "start": 0.2, "duration": 3.2,
  "z": 1,                          // 越大越靠前
  "visible": true,
  "transform": { "x": 0, "y": -20, "scale": 1, "rotation": 0, "opacity": 1 },
  "style": { ... },
  "fx": { "glow": 0 },             // 元素级：辉光
  "motion": { "type": "in", "amount": 0.08 },   // none/in/out/left/right/up/down/drift/shake
  "punch": 0.8,                    // 跟随节拍缩放（0..2）
  "fadeIn": 0.45, "fadeOut": 0.4,
  "srcIn": 0,                      // video：从素材的第几秒开始播
  "keyframes": [ { "t": 0.2, "path": "transform.scale", "value": 0.9, "ease": "outExpo" } ]
}
```

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

## ops（唯一的写入口）

```jsonc
{"op":"addElement","element":{...}}
{"op":"updateElement","id":"el_x","patch":{"style":{"text":"新字幕"},"transform":{"y":-40}}}
{"op":"set","id":"el_x","path":"style.color","value":"#ffd400"}
{"op":"removeElement","id":"el_x"}
{"op":"duplicateElement","id":"el_x","start":4.0}
{"op":"moveElement","id":"el_x","start":4.0,"duration":2.5,"z":3}
{"op":"splitElement","id":"el_x","at":2.3}
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
  `"keys": "shift" | "keep"` 可以显式指定。
- **splitElement**：两半各保留自己范围内的关键帧，外加每条轨在范围外最近的一个（保证插值不变）；
  切口处左半不淡出、右半不淡入；右半视频的 `srcIn` 接上左半；有运动预设时两半共用原来的 `motion.span`。
  结果：切开前后逐帧渲染一致。
- **duplicateElement**：副本放到新 `start` 时，关键帧和 `motion.span` 跟着平移。
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
