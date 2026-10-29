# 契约字段表（由 `core/contracts.js` 生成）

<!-- 此文件由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js（CONTRACT_VERSION 3）。
     重生成：node scripts/gen-contracts.mjs　校验：node scripts/gen-contracts.mjs --check -->

这是 WP2.3「契约单一来源」的人读版本。`mcp/tools.js`、`docs/AGENT-PROTOCOL.md` 与
`mcp/contracts.generated.json` 都来自同一个模块；改契约只改 `core/contracts.js`，然后重生成。

- 公开 op：**52**（`OP_KINDS` 里除去 `restoreProject` / `replaceTimeline` 两个内部 op）
- op 字段：**162**
- 属性路径：**122**（可打帧 17 el / 18 ob / 19 cam；
  可链接 18 el / 14 ob / 20 cam）

## 单位

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

| unit | 名称 | 符号 | 说明 |
| --- | --- | --- | --- |
| m | 米 | m | 世界坐标米；画面平面在 z = 0，y 向上，100 项目像素 = 1 米。 |
| project-px | 项目像素 | px | 项目画幅像素（1920×1080 的工程里 100 px = 1 m）。 |
| s | 秒 | s | 项目绝对时间；关键帧的 t 不是元素内的相对时间。 |
| deg | 度 | ° | 角度。 |
| ratio | 倍率 | × | 1 = 原值；用于缩放、透明度、音量。 |
| hz | 赫兹 | Hz | 频率。 |
| normalized | 归一化 | 0..1 | 画幅内的归一化坐标；画面中心是 0.5。 |
| f-stop | 光圈值 | f | 光圈 f 值，越大越虚化。 |
| number | 数值 | — | 无量纲数值。 |
| dir | 方向 | xyz | 单位方向向量（模长 1）。 |
| any | 由源声明 | — | 单位由源码 manifest 的 param.type 决定，core 不换算。 |
| value | 随属性 | — | 单位随 path 指向的属性。 |
| boolean | 开关 | — | true / false。 |

## op 契约

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

`必填` 含 `op` 之外的所有必填字段；`属性` 列标出每个字段的单位（— = 无单位 / 随属性）。

### 元素（2D）

时间线上的 2D 元素：文字、图片、视频、图形、音频、摄像机画面、代码图层。

#### `addElement` — 新建 2D 元素

分配 id、补全默认字段并插入元素数组（同 z 时新元素在最上面）。type 取 ELEMENT_TYPES。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| element | object | — | ✔ | 元素对象：至少给 type；其余字段与 updateElement 的 patch 相同，缺省值见 DOCUMENT_DEFAULTS。 |

```json
{
  "op": "addElement",
  "element": {
    "type": "text",
    "start": 0,
    "duration": 3,
    "style": {
      "text": "锈梦",
      "size": 140,
      "color": "#ffd400"
    }
  }
}
```

#### `updateElement` — 深合并元素字段

把 patch 深度合并进元素。id 不可改；改 src 会丢掉旧的素材时长缓存；改 z 会重排元素数组。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| patch | object | — | ✔ | 要合并进宿主的字段（深度合并；id 不可改）。 |

```json
{
  "op": "updateElement",
  "id": "el_title",
  "patch": {
    "style": {
      "text": "锈梦",
      "size": 150
    },
    "locked": true
  }
}
```

#### `set` — 写一个元素属性

按点号路径写元素字段（写入前把字符串形式的数字/布尔/JSON 转成真值）。不影响关键帧。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 属性路径（点号分隔）。 |
| value | any | value | ✔ | 写入的值；类型与单位由 path 指向的属性决定。 |

```json
{
  "op": "set",
  "id": "el_title",
  "path": "style.color",
  "value": "#ffd400"
}
```

#### `removeElement` — 删除元素

删除元素，并把它作为宿主的属性链接一并摘除（子元素保留自己的本地值）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |

```json
{
  "op": "removeElement",
  "id": "el_title"
}
```

#### `moveElement` — 移动 / 裁剪元素（相机片段同用）

只改 start 时关键帧跟着整体平移；start + duration 一起改是左裁剪（内容在时间上不动）。keys 可强制平移或保留关键帧。相机片段也走这个 op。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| start | number | s |  | 新起点（秒）。 |
| duration | number | s |  | 新时长（秒）；和 start 一起给就是左裁剪。 |
| z | number | — |  | 新的层序（越大越靠前）。 |
| segment | string,null | — |  | 分镜 id；null = 不归属任何分镜。 |
| keys | enum(shift / keep) | — |  | 关键帧处理：shift = 跟时间一起平移，keep = 不动（裁剪时默认）。 |

```json
{
  "op": "moveElement",
  "id": "el_title",
  "start": 1.2,
  "duration": 2.4,
  "segment": "seg_1",
  "keys": "shift"
}
```

#### `splitElement` — 在某一刻切开一个元素

切成左右两段，右段换新 id；关键帧、曲线、素材入点按切点重新分配。切点必须落在元素内部（留 0.02 s 余量）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| at | number | s | ✔ | 切点（项目秒）。 |

#### `splitAt` — 在播放头一次切开所有相关元素

UI 的剪刀（Ctrl+D）：把跨过 at 的元素全部切开，一次撤销。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| at | number | s | ✔ | 切点（项目秒）。 |
| id | string | — |  | 只切这一个元素（可选）。 |
| ids | array | — |  | 只切这些元素（可选）。 |

#### `duplicateElement` — 复制元素

深拷贝并换新 id；start 缺省是「原起点 + offset」，关键帧整体平移。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| start | number | s |  | 副本起点（秒）；省略时用原起点 + offset。 |
| offset | number | s |  | 相对原起点的偏移（秒）。 |

#### `reorder` — 改层序

z 与 delta 二选一：给 z 就设成它，否则在当前 z 上加 delta（默认 +1）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| z | number | — |  | 目标层序。 |
| delta | number | — |  | 相对层序增量（没给 z 时使用，默认 +1）。 |

### 关键帧

元素/物体/相机参数都走同一套关键帧写法；t 是项目绝对时间。

#### `keySet` — 在某一时刻写一个关键帧

t 是项目绝对时间。同一 path + t 覆盖旧键；省略 curve 时保留该时刻原有的曲线。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 属性路径（点号分隔）。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |
| value | any | value | ✔ | 写入的值；类型与单位由 path 指向的属性决定。 |
| ease | string | — |  | 缓动名（linear / easeInOut / inExpo / outExpo …，见 core/curves.js）；省略时保留原有缓动。 |
| curve | object,null | — |  | 值曲线对象；null 表示清除。省略时保留原有曲线。 |

```json
{
  "op": "keySet",
  "id": "el_title",
  "path": "style.size",
  "t": 1.6,
  "value": 150,
  "ease": "outExpo"
}
```

#### `keyRemove` — 删关键帧（带 t 删一个，不带清整条轨）

带 t 只删那一个键；不带 t 清空整条 path 的轨（旧的删除手势）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 属性路径（点号分隔）。 |
| t | number | s |  | 只删这一时刻的键；省略则清空整条轨。 |

#### `keyCurve` — 给一段关键帧区间挂值曲线

曲线存在左键上，控制 [from, to) 这段的插值。相机 host=camera + path=path 时是相机路径的弧长重定时。CURVE=null 清除。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| host | enum(element / object / camera) | — |  | 键所在宿主类型，默认 element。 |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 属性路径（点号分隔）。 |
| from | number | s | ✔ | 区间左端（秒），必须正好有一个键。 |
| to | number | s | ✔ | 区间右端（秒），必须正好有一个键。 |
| curve | object,null | — | ✔ | 值曲线对象；null 表示清除。省略时保留原有曲线。 |

### 分镜

分镜是时间标注，不参与求值。

#### `addSegment` — 新建分镜

分镜是时间上的标注（标题、意图、状态），不剪辑画面。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| segment | object | — | ✔ | 分镜对象：{ id?, name?, start?, duration?, intent?, status? }，status 取 draft\|previewed\|approved。 |

```json
{
  "op": "addSegment",
  "segment": {
    "name": "开场",
    "start": 0,
    "duration": 4,
    "intent": "establishing"
  }
}
```

#### `updateSegment` — 改分镜

深合并 patch；也可以直接给 start / duration。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| patch | object | — | ✔ | 要合并进宿主的字段（深度合并；id 不可改）。 |

#### `removeSegment` — 删分镜

删掉分镜；原本属于它的元素保留，segment 置空。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |

### 工程级

工程 meta、画面效果与 world。

#### `setMeta` — 写工程级字段

按点号路径写 meta（fps、beats、background、title …）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| path | string | — | ✔ | meta 内的字段路径，例如 fps / beats / background。 |
| value | any | value | ✔ | 写入的值；类型与单位由 path 指向的属性决定。 |

```json
{
  "op": "setMeta",
  "path": "fps",
  "value": 24
}
```

#### `setFx` — 改画面级效果

合并进 meta.fx（bloom / ca / grain / vignette / scanline / grade / contrast / saturation / shake）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| fx | object | — | ✔ | 画面效果字段；缺省值见 DOCUMENT_DEFAULTS.fx。 |

```json
{
  "op": "setFx",
  "fx": {
    "bloom": 0.6,
    "vignette": 0.4
  }
}
```

#### `worldSet` — 深合并 world

城市/天空等世界字段（source、background、city …）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| patch | object | — | ✔ | 要合并进宿主的字段（深度合并；id 不可改）。 |

### 相机

相机栈、路径动画与相机参数轨道。

#### `cameraKey` — 写相机路径关键帧

相机位置是路径动画：每个键是「时刻 + 位置 + 可选 look/fov/切线/速度」。省略 id 时写活动相机。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — |  | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |
| pos | array | m | ✔ | 相机位置（世界米）。 |
| look | mixed | m |  | 看向的目标点（世界米）；null = 用切线决定朝向。 |
| fov | number,null | ° |  | 这一时刻的视场角；null = 用相机自身的 fov。 |
| ease | string | — |  | 缓动名（linear / easeInOut / inExpo / outExpo …，见 core/curves.js）；省略时保留原有缓动。 |
| out | array | m |  | 出切线（贝塞尔把手，世界米）。 |
| in | array | m |  | 入切线（贝塞尔把手，世界米）。 |
| speed | any | — |  | 速度折线 [[u, v], …]（u 0..1，v 倍速）；null 清除。 |

```json
{
  "op": "cameraKey",
  "id": "cam_1",
  "t": 0,
  "pos": [
    0,
    5.4,
    20
  ],
  "look": [
    0,
    5.4,
    0
  ]
}
```

#### `cameraRemove` — 删相机路径关键帧

删掉 t 时刻的路径键；同时清掉落在它上面的跨键曲线。省略 id 时用活动相机。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — |  | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |

#### `cameraSet` — 深合并相机字段

改相机的整段属性（名字、fov、shake、dof …）。会重新夹紧画面构图字段并重排路径。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — |  | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| patch | object | — | ✔ | 要合并进宿主的字段（深度合并；id 不可改）。 |

```json
{
  "op": "cameraSet",
  "id": "cam_1",
  "patch": {
    "fov": 60,
    "shake": {
      "amp": 0.2
    }
  }
}
```

#### `cameraPath` — 整体替换相机路径

从视口拖拽时整条写回；不合法（pos 不是三元）的关键点被丢弃。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — |  | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | array | — | ✔ | 路径关键点数组：{ t, pos, look?, fov?, ease?, out?, in?, speed?, curve?, spanTo? }。 |

#### `cameraPatch` — 按 id 深合并相机

和 cameraSet 相同，但 id 必填且必须存在。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| patch | object | — | ✔ | 要合并进宿主的字段（深度合并；id 不可改）。 |

#### `cameraParamKey` — 相机参数关键帧

给相机的一个参数打帧（fov / center / shake.amp …）。path 必须在相机轨道表里，否则报错。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — |  | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 相机轨道路径，取值见 PROPERTY_PATHS 里 host=cam 且 keyable 的行。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |
| v | any | value |  | 写入的值（与 value 等价，v 是时间线/相机轨道的旧名字）。 |
| value | any | value |  | 写入的值；类型与单位由 path 指向的属性决定。 |
| ease | string | — |  | 缓动名（linear / easeInOut / inExpo / outExpo …，见 core/curves.js）；省略时保留原有缓动。 |
| curve | object,null | — |  | 值曲线对象；null 表示清除。省略时保留原有曲线。 |

```json
{
  "op": "cameraParamKey",
  "id": "cam_1",
  "path": "fov",
  "t": 0,
  "v": 62
}
```

#### `cameraParamUnkey` — 删相机参数关键帧

删 t 时刻的相机参数键；轨道空了就删掉轨道。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — |  | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 属性路径（点号分隔）。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |

#### `addCamera` — 新建相机

插入相机栈（默认最上面）并设为活动相机；没有给 id 时分配 cam_*。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| camera | object | — |  | 相机对象：{ id?, name?, fov?, center?, path?, shake?, dof?, … }。 |
| index | integer | — |  | 插入到相机栈的位置（0 = 最上），默认 0。 |

#### `removeCamera` — 删相机

从相机栈移除；活动相机被删时改选栈顶；它作为链接宿主的链接一并摘除。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |

#### `reorderCamera` — 调整相机栈顺序

在相机栈里把相机移到 index（越靠前越在上层）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| index | integer | — | ✔ | 目标位置（0 = 栈顶）。 |

#### `activateCamera` — 切换活动相机

活动相机是预览与导出的主眼。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |

### 3D 物体

根场景里的 3D 物体（solid / shape / text / image / video / container / empty / camera / audio）。

#### `objectAdd` — 新建 3D 物体

在根场景里建物体；id 不冲突时沿用，否则分配 ob_*。start/duration 会被工程时长夹紧。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| object | object | — | ✔ | 物体对象：{ id?, type?, name?, geom?, pivot?, rotation?, scale?, style?, start?, duration? }。 |

```json
{
  "op": "objectAdd",
  "object": {
    "type": "solid",
    "primitive": "box",
    "geom": {
      "w": 1,
      "h": 1,
      "d": 1
    },
    "pivot": [
      0,
      5.4,
      0
    ]
  }
}
```

#### `objectRemove` — 删 3D 物体

从根场景移除，并摘除它作为宿主的属性链接。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |

#### `objectPatch` — 深合并 3D 物体

改物体字段后会重新归一化（几何、旋转、不透明度夹紧）；id 与 tracks 不能用 patch 改。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| patch | object | — | ✔ | 要合并进宿主的字段（深度合并；id 不可改）。 |

#### `objectKey` — 3D 物体关键帧

path 取物体轨道（pivot / position / scale / dir / roll / rotation.x / opacity …）；向量轨可带切线或速度折线。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 物体轨道路径，取值见 PROPERTY_PATHS 里 host=ob 且 keyable 的行。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |
| v | any | value |  | 写入的值（与 value 等价，v 是时间线/相机轨道的旧名字）。 |
| value | any | value |  | 写入的值；类型与单位由 path 指向的属性决定。 |
| ease | string | — |  | 缓动名（linear / easeInOut / inExpo / outExpo …，见 core/curves.js）；省略时保留原有缓动。 |
| curve | object,null | — |  | 值曲线对象；null 表示清除。省略时保留原有曲线。 |
| out | array | m |  | 出切线（只对向量轨有效，世界米）。 |
| in | array | m |  | 入切线（只对向量轨有效，世界米）。 |
| speed | any | — |  | 速度折线 [[u, v], …]；null 清除。 |

```json
{
  "op": "objectKey",
  "id": "ob_1",
  "path": "pivot.x",
  "t": 1,
  "v": 0.5
}
```

#### `objectUnkey` — 删 3D 物体关键帧

删 t 时刻的键；轨道空了就删掉轨道。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 属性路径（点号分隔）。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |

### 父子级

元素、相机、物体都能挂空间父级；旧的对象父级 op 仍然保留。

#### `spatialParent` — 挂空间父级（元素 / 相机 / 物体通用）

统一的父级入口：父宿主可以是元素、相机或 3D 物体，支持继承开关与强度。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 子宿主 id。 |
| parent | string | — | ✔ | 父宿主 id。 |
| t | number | s |  | 项目绝对时间（秒，≥ 0）。 |
| inherit | object | — |  | 继承哪些分量，缺省全继承。 |
| strength | object | — |  | 父级影响强度 { rot, scale }。 |

```json
{
  "op": "spatialParent",
  "id": "el_2",
  "parent": "el_1"
}
```

#### `spatialUnparent` — 解除空间父级

解绑父级，宿主保留解绑那一刻的世界姿态。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 子宿主 id。 |

#### `objectParent` — 3D 物体挂父级（旧式）

旧的对象父子关系；新数据请用 spatialParent / objectParent 的等价空间父级。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| parent | string,null | — | ✔ | 父物体 id；null = 解除（和 objectUnparent 等价）。 |
| t | number | s |  | 项目绝对时间（秒，≥ 0）。 |
| inherit | object | — |  | 继承哪些分量（pos / rot / scale），缺省全继承。 |
| strength | object | — |  | 父级影响强度 { rot, scale }，0..1 之间。 |

#### `objectUnparent` — 解除 3D 物体父级

解绑父级，物体保留解绑那一刻的世界姿态。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| t | number | s |  | 项目绝对时间（秒，≥ 0）。 |

#### `objectParentKey` — 父级强度关键帧（旧式）

给 rot / scale 两个继承通道打强度键（0..1）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| channel | enum(rot / scale) | — | ✔ | 通道：rot 或 scale。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |
| v | number | — |  | 强度（0..1）。 |
| value | number | — |  | 强度（0..1），与 v 等价。 |
| ease | string | — |  | 缓动名（linear / easeInOut / inExpo / outExpo …，见 core/curves.js）；省略时保留原有缓动。 |

#### `objectParentUnkey` — 删父级强度关键帧（旧式）

删 t 时刻的通道键。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| channel | enum(rot / scale) | — | ✔ | 通道：rot 或 scale。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |

#### `elementParent` — 2D 元素挂父级

元素跟随父宿主的世界变换；null 等于 elementUnparent。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 子元素 id。 |
| parent | string,null | — | ✔ | 父宿主 id（元素 / 相机 / 3D 物体）；null = 解除。 |
| t | number | s |  | 项目绝对时间（秒，≥ 0）。 |

#### `elementUnparent` — 解除 2D 元素父级

解绑父级，元素保留解绑那一刻的世界姿态。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 元素 id。 |
| t | number | s |  | 项目绝对时间（秒，≥ 0）。 |

#### `spatialParentKey` — 父级强度关键帧

给 rot / scale 两个继承通道打强度键（0..1）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 子宿主 id。 |
| channel | enum(rot / scale) | — | ✔ | 通道：rot 或 scale。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |
| v | number | — |  | 强度（0..1）。 |
| value | number | — |  | 强度（0..1），与 v 等价。 |
| ease | string | — |  | 缓动名（linear / easeInOut / inExpo / outExpo …，见 core/curves.js）；省略时保留原有缓动。 |

#### `spatialParentUnkey` — 删父级强度关键帧

删 t 时刻的通道键。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 子宿主 id。 |
| channel | enum(rot / scale) | — | ✔ | 通道：rot 或 scale。 |
| t | number | s | ✔ | 项目绝对时间（秒，≥ 0）。 |

### 属性链接

一个宿主的数值属性跟随另一个宿主的数值属性。

#### `propLink` — 属性链接：子属性跟父属性

add 是加偏移，mul 是乘比例（比率单位默认 mul）。单位必须同族，代码参数（code.params.*）例外。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| host | enum(el / ob / cam / element / object / camera) | — |  | 子宿主类型（el / ob / cam）；默认 el。 |
| id | string | — | ✔ | 子宿主 id。 |
| to | string | — | ✔ | 子宿主的属性路径（属性路径表里 linkable 的行）。 |
| from | object | — | ✔ | 父属性引用 { host, id, path }；host 可写别名 element/object/camera。 |
| combine | enum(add / mul) | — |  | 叠加方式：add 加偏移，mul 乘比例；缺省按单位（比率默认 mul）。 |
| t | number | s |  | 项目绝对时间（秒，≥ 0）。 |
| enabled | boolean | — |  | 关掉后子属性回到本地值（链接保留）。 |
| bindParentValue | number | — |  | 绑定时父属性的值：之后按父值相对这个点的变化叠加。 |

```json
{
  "op": "propLink",
  "host": "el",
  "id": "el_2",
  "to": "pivot.x",
  "from": {
    "host": "el",
    "id": "el_1",
    "path": "pivot.x"
  },
  "combine": "add"
}
```

#### `propLinkPatch` — 改属性链接

深合并这条链接的字段（combine / enabled / bindParentValue / t …）。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| host | enum(el / ob / cam / element / object / camera) | — |  | 子宿主类型；默认 el。 |
| id | string | — | ✔ | 子宿主 id。 |
| to | string | — | ✔ | 子属性路径。 |
| patch | object | — | ✔ | 要合并进宿主的字段（深度合并；id 不可改）。 |
| t | number | s |  | 项目绝对时间（秒，≥ 0）。 |

#### `propUnlink` — 解除属性链接

删掉子属性上的链接，子属性保留当前本地值。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| host | enum(el / ob / cam / element / object / camera) | — |  | 子宿主类型；默认 el。 |
| id | string | — | ✔ | 子宿主 id。 |
| to | string | — | ✔ | 子属性路径。 |

### 代码图层源

sources/<id>/ 由工程文档里的源清单派生。

#### `sourceAdd` — 注册 / 替换代码图层源

源清单（manifest）与文本文件都存在工程文档里，sources/<id>/ 由它派生。manifest 会被校验（runtime / entry / params），id 就是目录名。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 源 id，同时是目录名：字母数字开头，允许 - 和 _。 |
| manifest | object | — | ✔ | 源清单 { runtime: canvas2d\|p5\|glsl, entry, params?, deterministic?, libs? }。 |
| files | object | — |  | 文本文件表 { 相对路径: 内容 }；manifest.json 由 manifest 字段生成，不要放进来。 |

```json
{
  "op": "sourceAdd",
  "id": "dot_pulse",
  "manifest": {
    "runtime": "canvas2d",
    "entry": "main.js",
    "params": [
      {
        "id": "radius",
        "type": "number",
        "range": [
          0,
          1
        ]
      }
    ]
  },
  "files": {
    "main.js": "export function draw(vdm) {}"
  }
}
```

#### `sourceWrite` — 改写源里的一个文件

只改文本文件；改 manifest 用 sourceAdd。内容相同则不算变更。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |
| path | string | — | ✔ | 源内的相对路径；不允许 .. 或绝对路径。 |
| content | string | — | ✔ | 文件全文。 |

#### `sourceRemove` — 删掉一个源

还有 code 元素在用这个源时拒绝删除。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | 宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。 |

#### `codeParamSet` — 改代码图层的参数

按 manifest 声明的类型转换并按 range 夹紧；参数已打帧时写到 t 时刻的键上。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| id | string | — | ✔ | code 元素 id。 |
| name | string | — | ✔ | 参数名（manifest.params[].id）。 |
| value | any | any |  | 参数值；类型按 manifest 声明转换。 |
| v | any | any |  | 参数值（与 value 等价）。 |
| t | number | s |  | 参数已打帧时写到这个时间的键上（秒）。 |

```json
{
  "op": "codeParamSet",
  "id": "el_code",
  "name": "radius",
  "value": 0.5,
  "t": 1
}
```

### 批量

一次提交多个 op。

#### `batch` — 一次提交多个 op

顺序执行同一批 op，任一失败整批不生效；返回每个 op 的结果与合并后的 changed。

| 字段 | 类型 | 单位 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| ops | array | — | ✔ | 要顺序执行的 op 列表（同一事务）。 |

```json
{
  "op": "batch",
  "ops": [
    {
      "op": "keySet",
      "id": "el_title",
      "path": "style.size",
      "t": 1.5,
      "value": 150
    },
    {
      "op": "keySet",
      "id": "el_title",
      "path": "style.size",
      "t": 2.5,
      "value": 120
    }
  ]
}
```

## 属性路径

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

`kind`：`track` = 求值器采样的关键帧轨道；`field` = 文档字段；`link` = 只作为属性链接端点的写法。
`keyable` = 打这个路径的帧会改变画面；`linkable` = `propLink` 可以引用它。

### 2D 元素（host = `el`）

| 路径 | kind | 类型 | 单位 | 默认 | 可打帧 | 可链接 | legacy | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pivot.x | track | number | m | 0 | ✔ | ✔ | — | 世界米（100 px = 1 m）。画面中心 x = 0。 |
| pivot.y | track | number | m | 0 | ✔ | ✔ | — | 世界米，y 向上。1080 工程里画面中心 y = 5.4，画面下缘 y = 0。 |
| pivot.z | track | number | m | 0 | ✔ | ✔ | — | 世界米；z 越大越靠近默认相机（相机在 z = 20 看向 -Z）。 |
| scale.x | track | number | × | 1 | ✔ | ✔ | — | 倍率，1 = 原尺寸。 |
| scale.y | track | number | × | 1 | ✔ | ✔ | — | 倍率，1 = 原尺寸。 |
| scale.z | track | number | × | 1 | ✔ | ✔ | — | 倍率；平面元素的 z 缩放不改变画面尺寸，只影响子级。 |
| rotation.x | track | number | ° | 0 | ✔ | ✔ | — | 度；三轴旋转与 roll 互斥（有 rotation 时以它为准）。 |
| rotation.y | track | number | ° | 0 | ✔ | ✔ | — | 度。 |
| rotation.z | track | number | ° | 0 | ✔ | ✔ | — | 度；和 roll 是同一件事的三轴写法。 |
| roll | track | number | ° | 0 | ✔ | ✔ | — | 度；元素没有 rotation 时用这条轨。 |
| position.x | track | number | m | 0 | — | ✔ | — | 米。属性链接与父级链会读写它；2D 元素自身的渲染不采样这条轨（见 CONTRACTS.md 已知遗留）。 |
| position.y | track | number | m | 0 | — | ✔ | — | 米；同上。 |
| position.z | track | number | m | 0 | — | ✔ | — | 米；同上。 |
| style.size | track | number | px | 96 | ✔ | ✔ | — | 文字字号，项目像素；其他元素不使用。 |
| style.text | track | string | — | '' | ✔ | — | — | 字符串轨：关键帧在离散时刻切换文本，不插值。 |
| style.color | track | color | — | `#ffffff` | ✔ | — | — | 文字/图形颜色；颜色轨在关键帧处离散切换。 |
| fx.glow | track | number | — | 0 | ✔ | ✔ | — | 元素级辉光强度（0 起，常用 0..2）。 |
| fx.blur | track | number | — | 0 | ✔ | — | — | 元素级模糊强度（无量纲）。 |
| audio.volume | track | number | × | 1 | ✔ | ✔ | — | 音频线性音量 0..1；音频自动化按线性段插值（core/audio.js::audioVolume）。 |
| opacity | link | number | × | 1 | — | ✔ | — | 属性链接用的写法；链接写入的值落到唯一生效的透明度轨道（旧名字，见 LEGACY_PATHS）。 |
| id | field | string | — | '' | — | — | — | el_*；不可修改（只能新建）。 |
| type | field | enum(image / video / text / solid / shape / audio / camfeed / code) | — | `image` | — | — | — | 文字 / 图片 / 视频 / 图形 / 音频 / 摄像机画面 / 代码图层之一。 |
| name | field | string | — | '' | — | — | — | 时间线与检查器里显示的名字。 |
| src | field | string | — | '' | — | — | — | image / video / audio 的媒体相对路径（media/ 下）。 |
| start | field | number | s | 0 | — | — | — | 项目绝对时间（秒）。 |
| duration | field | number | s | 1 | — | — | — | 秒；媒体会被素材时长夹紧。 |
| z | field | number | — | 0 | — | — | — | 越大越靠前；同 z 按元素数组顺序。 |
| segment | field | string | — | null | — | — | — | 分镜 id 或 null。 |
| visible | field | boolean | — | true | — | — | — | false 后不参与渲染与测量。 |
| locked | field | boolean | — | false | — | — | — | true 后 agent 身份（agent:*）的写入返回 LOCKED；人和 ui 仍可改。 |
| loop | field | boolean | — | false | — | — | — | 视频/音频素材循环填满时间块。 |
| fadeIn | field | number | s | 0 | — | — | — | 秒。 |
| fadeOut | field | number | s | 0 | — | — | — | 秒。 |
| punch | field | number | — | 0 | — | — | — | 0..1；按 meta.beats 做缩放脉冲。 |
| srcIn | field | number | s | 0 | — | — | — | 从素材的第几秒开始用（秒）。 |
| volume | field | number | × | 1 | — | — | — | 0..1；关键帧在 audio.volume 轨上。 |
| motion.type | field | enum(none / in / out / left / right / up / down / drift / shake) | — | `none` | — | — | — | 叠加在关键帧之上的预设位移。 |
| motion.amount | field | number | × | 0 | — | — | — | 0..1。 |
| motion.dir | field | enum(in / out) | — | `in` | — | — | — | 预设朝向。 |
| style.fit | field | enum(cover / contain / stretch) | — | `cover` | — | — | — | 图片/视频在平面上的取景方式；contain 实际按 cover 裁（见 §4.4）。 |
| style.font | field | string | — | `SimHei` | — | — | — | 字体族名。 |
| style.weight | field | number | — | 400 | — | — | — | 100..900。 |
| style.align | field | enum(left / center / right) | — | `center` | — | — | — | 文字对齐。 |
| style.lineHeight | field | number | × | 1.18 | — | — | — | 倍率。 |
| style.letterSpacing | field | number | px | 0 | — | — | — | 项目像素。 |
| style.shadow | field | number | — | 0 | — | — | — | 0..1 的文字投影强度。 |
| style.shape | field | enum(rect / ellipse) | — | `rect` | — | — | — | shape 元素用。 |
| style.fill | field | color | — | `#ffffff` | — | — | — | 图形/物体的填充色。 |
| style.radius | field | number | px | 0 | — | — | — | 项目像素。 |
| style.stroke | field | color | — | '' | — | — | — | 空字符串 = 无描边。 |
| style.strokeWidth | field | number | px | 0 | — | — | — | 项目像素。 |
| node.pivot | field | vec3 | m | `[0,0,0]` | — | — | — | el.node.pivot（米）；关键帧请用 pivot.x/y/z。 |
| node.rotation | field | vec3 | ° | `[0,0,0]` | — | — | — | el.node.rotation（度）；关键帧请用 rotation.x/y/z。 |
| node.roll | field | number | ° | 0 | — | — | — | el.node.roll（度）；关键帧请用 roll。 |
| node.scale | field | vec3 | × | `[1,1,1]` | — | — | — | el.node.scale；关键帧请用 scale.x/y/z。 |
| node.position | field | vec3 | m | `[0,0,0]` | — | — | — | el.node.position（父级空间，米）；关键帧请用 position.x/y/z。 |
| code.source | field | string | — | '' | — | — | — | code 元素引用的源（sources/<id>/）。 |
| code.params.<name> | track | any | any | null | ✔ | ✔ | — | manifest.params[].id 声明的参数；类型与单位由源声明。 |

### 3D 物体（host = `ob`）

| 路径 | kind | 类型 | 单位 | 默认 | 可打帧 | 可链接 | legacy | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pivot | track | vec3 | m | `[0,0,0]` | ✔ | — | — | 世界米；也可以按 pivot.x / pivot.y / pivot.z 打标量帧。 |
| pivot.x | track | number | m | 0 | ✔ | ✔ | — | 世界米。 |
| pivot.y | track | number | m | 0 | ✔ | ✔ | — | 世界米，y 向上。 |
| pivot.z | track | number | m | 0 | ✔ | ✔ | — | 世界米。 |
| position | track | vec3 | m | `[0,0,0]` | ✔ | — | — | 在物体自身基向量下的偏移（米）；也可按 position.x/y/z 打帧。 |
| position.x | track | number | m | 0 | ✔ | ✔ | — | 米。 |
| position.y | track | number | m | 0 | ✔ | ✔ | — | 米。 |
| position.z | track | number | m | 0 | ✔ | ✔ | — | 米。 |
| scale | track | vec3 | × | `[1,1,1]` | ✔ | — | — | 倍率；也可按 scale.x/y/z 打帧。 |
| scale.x | track | number | × | 1 | ✔ | ✔ | — | 倍率。 |
| scale.y | track | number | × | 1 | ✔ | ✔ | — | 倍率。 |
| scale.z | track | number | × | 1 | ✔ | ✔ | — | 倍率。 |
| dir | track | vec3 | xyz | `[0,0,-1]` | ✔ | — | — | 单位方向向量（旧式旋转）。 |
| roll | track | number | ° | 0 | ✔ | ✔ | — | 度。 |
| rotation.x | track | number | ° | 0 | ✔ | ✔ | — | 度。 |
| rotation.y | track | number | ° | 0 | ✔ | ✔ | — | 度。 |
| rotation.z | track | number | ° | 0 | ✔ | ✔ | — | 度。 |
| opacity | track | number | × | 1 | ✔ | ✔ | — | 0..1。 |
| id | field | string | — | '' | — | — | — | ob_*。 |
| type | field | enum(solid / shape / text / image / video / container / empty / camera / audio) | — | `solid` | — | — | — | 只有可画类型进帧 IR。 |
| name | field | string | — | '' | — | — | — | 显示名。 |
| start | field | number | s | 0 | — | — | — | 项目绝对时间（秒）。 |
| duration | field | number | s | 1 | — | — | — | 秒。 |
| visible | field | boolean | — | true | — | — | — | false 后不参与渲染。 |
| locked | field | boolean | — | false | — | — | — | agent:* 身份的写入返回 LOCKED。 |
| geom.w | field | number | m | 2 | — | — | — | 米。 |
| geom.h | field | number | m | 2 | — | — | — | 米。 |
| geom.d | field | number | m | 2 | — | — | — | 米。 |
| style.color | field | color | — | `#17d9ff` | — | — | — | 物体基色。 |
| style.emissive | field | number | — | 0 | — | — | — | 0..1。 |

### 相机（host = `cam`）

| 路径 | kind | 类型 | 单位 | 默认 | 可打帧 | 可链接 | legacy | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| center | track | vec3 | m | `[0,0,0]` | ✔ | — | — | 相机位置（世界米）；旧式 path 之外的整段偏移，也可写作 pivot.x 做属性链接。 |
| scale | track | vec3 | × | `[1,1,1]` | ✔ | — | — | 倍率；只影响子级，不改变取景。 |
| picturePivot | track | vec2 | 0..1 | `[0.5,0.5]` | ✔ | — | — | 归一化 0..1。 |
| pictureOffset | track | vec2 | 0..1 | `[0,0]` | ✔ | — | — | 归一化 -1..1。 |
| opacity | track | number | × | 1 | ✔ | ✔ | — | 0..1；< 0.002 时整层不画。 |
| fov | track | number | ° | 62 | ✔ | ✔ | — | 度；≥ 180 自动切等距鱼眼。 |
| lookAhead | track | number | m | 90 | ✔ | ✔ | — | 米；路径朝向的前瞻距离。 |
| bankGain | track | number | × | 1.2 | ✔ | ✔ | — | 倍率。 |
| maxRoll | track | number | ° | 32 | ✔ | ✔ | — | 度。 |
| roll | track | number | ° | 0 | ✔ | ✔ | — | 度；相机自身 roll，与路径转向无关。 |
| rotation.x | track | number | ° | 0 | ✔ | ✔ | — | 度；三轴旋转偏移。 |
| rotation.y | track | number | ° | 0 | ✔ | ✔ | — | 度。 |
| rotation.z | track | number | ° | 0 | ✔ | ✔ | — | 度。 |
| shake.amp | track | number | m | 0.6 | ✔ | ✔ | — | 米。 |
| shake.freq | track | number | Hz | 1.6 | ✔ | ✔ | — | Hz。 |
| shake.speedGain | track | number | × | 1 | ✔ | ✔ | — | 倍率 0..2。 |
| shake.seed | track | number | — | 7 | — | ✔ | — | 整段镜头属性（templates 标为 shot 级），不能逐帧打。 |
| dof.enabled | track | boolean | — | false | ✔ | — | — | 开关。 |
| dof.fstop | track | number | f | 2.8 | ✔ | ✔ | — | 0.5..32。 |
| path | track | path3 | m | `[]` | ✔ | — | — | 相机位置动画：用 cameraKey / cameraRemove 写，不是普通参数轨道。 |
| pivot.x | link | number | m | 0 | — | ✔ | — | 属性链接用的写法，映射到 center。 |
| pivot.y | link | number | m | 0 | — | ✔ | — | 属性链接用的写法，映射到 center。 |
| pivot.z | link | number | m | 0 | — | ✔ | — | 属性链接用的写法，映射到 center。 |
| scale.x | link | number | × | 1 | — | ✔ | — | 属性链接用的写法，映射到 scale。 |
| scale.y | link | number | × | 1 | — | ✔ | — | 属性链接用的写法，映射到 scale。 |
| scale.z | link | number | × | 1 | — | ✔ | — | 属性链接用的写法，映射到 scale。 |
| id | field | string | — | '' | — | — | — | cam_*。 |
| name | field | string | — | '' | — | — | — | 显示名。 |
| focal | field | number | px | 0 | — | — | — | 历史字段，取景由 fov 决定。 |
| near | field | number | m | 0.1 | — | — | — | 米。 |
| far | field | number | m | 1000 | — | — | — | 米。 |
| motionBlur.enabled | field | boolean | — | false | — | — | — | 整段镜头属性。 |
| motionBlur.shutter | field | number | × | 0.5 | — | — | — | 0..1（整段镜头属性）。 |
| locked | field | boolean | — | false | — | — | — | agent:* 身份的写入返回 LOCKED；人和 ui 仍可改。 |

## 已废弃路径（仅旧工程）

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

| host | path | 单位 | 说明 |
| --- | --- | --- | --- |
| el | transform.x | px | 旧 2D 横向位置（像素，y 向下）；新元素改用 pivot.x（米）。 |
| el | transform.y | px | 旧 2D 纵向位置（像素，y 向下）；新元素改用 pivot.y（米）。 |
| el | transform.z | m | 旧深度（米）；新元素改用 pivot.z。 |
| el | transform.scale | × | 旧统一缩放；新元素改用 scale.x / scale.y。 |
| el | transform.rotation | ° | 旧平面旋转；新元素改用 roll 或 rotation.z。 |
| el | transform.opacity | × | 透明度：名字沿用旧字段，但它是唯一生效的透明度轨道（新元素也一样）。淡入淡出也可以改用 fadeIn / fadeOut 字段。 |

## 新建时的默认值

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

`addElement` / `addCamera` / `objectAdd` 实际写入的缺省值。

| 类别 | 字段 | 默认值 |
| --- | --- | --- |
| element | transform | `{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1}` |
| element | style | `{"fit":"cover","text":"","font":"SimHei","size":96,"weight":400,"color":"#ffffff","align":"center","lineHeight":1.18,"letterSpacing":0,"shadow":0,"shape":"rect","fill":"#ffffff","radius":0,"stroke":"","strokeWidth":0}` |
| element | fx | `{"bloom":0.25,"ca":0,"grain":0.04,"vignette":0.35,"scanline":0,"grade":0,"contrast":0,"saturation":1,"shake":0}` |
| element | motion | `{"type":"none","amount":0,"dir":"in"}` |
| element | node | `{"pivot":[0,0,0],"position":[0,0,0],"dir":[0,0,-1],"roll":0,"scale":[1,1,1]}` |
| element | start | 0 |
| element | duration | 1 |
| element | z | `max+1` |
| element | visible | true |
| element | locked | false |
| element | loop | false |
| element | fadeIn | 0 |
| element | fadeOut | 0 |
| element | punch | 0 |
| element | srcIn | 0 |
| element | volume | 1 |
| object | pivot | `[0,0,0]` |
| object | position | `[0,0,0]` |
| object | rotation | `[0,0,0]` |
| object | scale | `[1,1,1]` |
| object | opacity | 1 |
| object | geom | `{"w":2,"h":2,"d":2}` |
| object | type | `solid` |
| camera | center | `[0,0,0]` |
| camera | scale | `[1,1,1]` |
| camera | opacity | 1 |
| camera | roll | 0 |
| camera | fov | `计算：按画幅填满画面（1920×1080 约 51.28°，core/space.js::defaultFov）` |
| camera | motionBlur | `{"enabled":false,"shutter":0.5}` |
| camera | shake | `{"amp":0}` |

## 生成的 JSON Schema

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

`mcp/tools.js` 直接引用这些对象，不复制字段：

| 导出 | 用在哪里 |
| --- | --- |
| EDIT_SCHEMA | `vdm_project_apply_ops` 的 inputSchema（含 `$defs.op`）、`vdm://project/schema` 资源 |
| CHANGESET_APPLY_SCHEMA | `vdm_changeset_apply` 的 inputSchema（`id` 或 `ops` 二选一） |
| EDIT_BASELINE | `expectedRev` / `requestId` / `dryRun`，`vdm_history_undo\|redo` 也用它 |
| ACTOR_ID | `vdm_changeset_*` 的 actorId 字段 |
| OP_SCHEMA | `vdm://project/schema` 资源里的单 op 联合 |

工具名 → schema 的对照由 `TOOL_SCHEMAS` 导出：

| 工具 | schema |
| --- | --- |
| vdm_project_apply_ops | `EDIT_SCHEMA`（$defs.op 内嵌） |
| vdm_changeset_apply | `CHANGESET_APPLY_SCHEMA`（$defs.op 内嵌） |

## 生成与校验

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

- 重生成：`node scripts/gen-contracts.mjs`
- 校验：`node scripts/gen-contracts.mjs --check`（不一致时非零退出并打印 diff 摘要）
- 生成器：`scripts/gen-contracts.mjs`；契约版本：`CONTRACT_VERSION 3`
