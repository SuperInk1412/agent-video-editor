# 剪辑 Agent 协议 — 在 VedioMaker 项目里工作

<!-- 此文件由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js（CONTRACT_VERSION 3）。
     重生成：node scripts/gen-contracts.mjs　校验：node scripts/gen-contracts.mjs --check -->

你在一个 **VedioMaker 项目目录**里（含 `project.vdm.json` 与 `media/`），职责是**改时间线**，不是改代码。
本文件不是手写的：它由 `core/contracts.js` 渲染，所以这里列出的 op、字段、单位、默认值就是引擎真正接受的东西。
如果本文与代码不一致，以 `core/contracts.js` 为准，并跑 `node scripts/gen-contracts.mjs --check`（它应当报错）。

## 1. 两种工作方式

- **MCP 工具**（推荐）：`vdm_project_apply_ops` 提交 op 批次，`vdm_changeset_apply` 把一次编辑记成变更集，
  `vdm_inspect_*` 量一帧，`vdm_render_submit` 出真图。工具 schema 与本文件同源。
- **回一个 JSON 对象**（没有 shell / MCP 时）：对象里放 `note` 与 `ops`，引擎会校验、加锁、落盘、进撤销栈；
  校验失败时整批不生效，错误会显示给用户。

```json
{
  "note": "标题改成锈梦、150 号，并卡在 1.6 s",
  "ops": [
    {"op":"set","id":"el_title","path":"style.color","value":"#ffd400"},
    {
      "op": "keySet",
      "id": "el_title",
      "path": "style.size",
      "t": 1.6,
      "value": 150,
      "ease": "outExpo"
    }
  ]
}
```

## 2. 可用 ops

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

`*` = 必填字段；`:m` / `:s` / `:deg` / `:px` 是单位。批里所有 op 同一事务，任一失败整批不生效。

### 元素（2D）

时间线上的 2D 元素：文字、图片、视频、图形、音频、摄像机画面、代码图层。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| addElement | 新建 2D 元素 | element | element* |
| updateElement | 深合并元素字段 | id, patch | id* patch* |
| set | 写一个元素属性 | id, path, value | id* path* value* |
| removeElement | 删除元素 | id | id* |
| moveElement | 移动 / 裁剪元素（相机片段同用） | id | id* start:s duration:s z segment keys |
| splitElement | 在某一刻切开一个元素 | id, at | id* at:s* |
| splitAt | 在播放头一次切开所有相关元素 | at | at:s* id ids |
| duplicateElement | 复制元素 | id | id* start:s offset:s |
| reorder | 改层序 | id | id* z delta |

### 关键帧

元素/物体/相机参数都走同一套关键帧写法；t 是项目绝对时间。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| keySet | 在某一时刻写一个关键帧 | id, path, t, value | id* path* t:s* value* ease curve |
| keyRemove | 删关键帧（带 t 删一个，不带清整条轨） | id, path | id* path* t:s |
| keyCurve | 给一段关键帧区间挂值曲线 | id, path, from, to, curve | host id* path* from:s* to:s* curve* |

### 分镜

分镜是时间标注，不参与求值。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| addSegment | 新建分镜 | segment | segment* |
| updateSegment | 改分镜 | id, patch | id* patch* |
| removeSegment | 删分镜 | id | id* |

### 工程级

工程 meta、画面效果与 world。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| setMeta | 写工程级字段 | path, value | path* value* |
| setFx | 改画面级效果 | fx | fx* |
| worldSet | 深合并 world | patch | patch* |

### 相机

相机栈、路径动画与相机参数轨道。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| cameraKey | 写相机路径关键帧 | t, pos | id t:s* pos:m* look:m fov:° ease out:m in:m speed |
| cameraRemove | 删相机路径关键帧 | t | id t:s* |
| cameraSet | 深合并相机字段 | patch | id patch* |
| cameraPath | 整体替换相机路径 | path | id path* |
| cameraPatch | 按 id 深合并相机 | id, patch | id* patch* |
| cameraParamKey | 相机参数关键帧 | path, t | id path* t:s* v value ease curve |
| cameraParamUnkey | 删相机参数关键帧 | path, t | id path* t:s* |
| addCamera | 新建相机 | — | camera index |
| removeCamera | 删相机 | id | id* |
| reorderCamera | 调整相机栈顺序 | id, index | id* index* |
| activateCamera | 切换活动相机 | id | id* |

### 3D 物体

根场景里的 3D 物体（solid / shape / text / image / video / container / empty / camera / audio）。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| objectAdd | 新建 3D 物体 | object | object* |
| objectRemove | 删 3D 物体 | id | id* |
| objectPatch | 深合并 3D 物体 | id, patch | id* patch* |
| objectKey | 3D 物体关键帧 | id, path, t | id* path* t:s* v value ease curve out:m in:m speed |
| objectUnkey | 删 3D 物体关键帧 | id, path, t | id* path* t:s* |

### 父子级

元素、相机、物体都能挂空间父级；旧的对象父级 op 仍然保留。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| spatialParent | 挂空间父级（元素 / 相机 / 物体通用） | id, parent | id* parent* t:s inherit strength |
| spatialUnparent | 解除空间父级 | id | id* |
| objectParent | 3D 物体挂父级（旧式） | id, parent | id* parent* t:s inherit strength |
| objectUnparent | 解除 3D 物体父级 | id | id* t:s |
| objectParentKey | 父级强度关键帧（旧式） | id, channel, t | id* channel* t:s* v value ease |
| objectParentUnkey | 删父级强度关键帧（旧式） | id, channel, t | id* channel* t:s* |
| elementParent | 2D 元素挂父级 | id, parent | id* parent* t:s |
| elementUnparent | 解除 2D 元素父级 | id | id* t:s |
| spatialParentKey | 父级强度关键帧 | id, channel, t | id* channel* t:s* v value ease |
| spatialParentUnkey | 删父级强度关键帧 | id, channel, t | id* channel* t:s* |

### 属性链接

一个宿主的数值属性跟随另一个宿主的数值属性。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| propLink | 属性链接：子属性跟父属性 | id, to, from | host id* to* from* combine t:s enabled bindParentValue |
| propLinkPatch | 改属性链接 | id, to, patch | host id* to* patch* t:s |
| propUnlink | 解除属性链接 | id, to | host id* to* |

### 代码图层源

sources/<id>/ 由工程文档里的源清单派生。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| sourceAdd | 注册 / 替换代码图层源 | id, manifest | id* manifest* files |
| sourceWrite | 改写源里的一个文件 | id, path, content | id* path* content* |
| sourceRemove | 删掉一个源 | id | id* |
| codeParamSet | 改代码图层的参数 | id, name | id* name* value:any v:any t:s |

### 批量

一次提交多个 op。

| op | 作用 | 必填 | 字段（单位） |
| --- | --- | --- | --- |
| batch | 一次提交多个 op | ops | ops* |

### 常用示例

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

**`addElement`** — 新建 2D 元素

```json
{
  "op": "addElement",
  "element": {
    "type": "text",
    "start": 0,
    "duration": 3,
    "style": {"text":"锈梦","size":140,"color":"#ffd400"}
  }
}
```

**`set`** — 写一个元素属性

```json
{"op":"set","id":"el_title","path":"style.color","value":"#ffd400"}
```

**`keySet`** — 在某一时刻写一个关键帧

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

**`moveElement`** — 移动 / 裁剪元素（相机片段同用）

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

**`cameraKey`** — 写相机路径关键帧

```json
{"op":"cameraKey","id":"cam_1","t":0,"pos":[0,5.4,20],"look":[0,5.4,0]}
```

**`cameraParamKey`** — 相机参数关键帧

```json
{"op":"cameraParamKey","id":"cam_1","path":"fov","t":0,"v":62}
```

**`objectKey`** — 3D 物体关键帧

```json
{"op":"objectKey","id":"ob_1","path":"pivot.x","t":1,"v":0.5}
```

**`propLink`** — 属性链接：子属性跟父属性

```json
{
  "op": "propLink",
  "host": "el",
  "id": "el_2",
  "to": "pivot.x",
  "from": {"host":"el","id":"el_1","path":"pivot.x"},
  "combine": "add"
}
```

**`spatialParent`** — 挂空间父级（元素 / 相机 / 物体通用）

```json
{"op":"spatialParent","id":"el_2","parent":"el_1"}
```

**`sourceAdd`** — 注册 / 替换代码图层源

```json
{
  "op": "sourceAdd",
  "id": "dot_pulse",
  "manifest": {
    "runtime": "canvas2d",
    "entry": "main.js",
    "params": [{"id":"radius","type":"number","range":[0,1]}]
  },
  "files": {"main.js":"export function draw(vdm) {}"}
}
```

**`codeParamSet`** — 改代码图层的参数

```json
{"op":"codeParamSet","id":"el_code","name":"radius","value":0.5,"t":1}
```

**`batch`** — 一次提交多个 op

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

## 3. 属性路径（可打帧的轨道）

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

路径是点号分隔的字符串。`pivot.x` 用米（100 项目像素 = 1 米，y 向上，画面中心 y = 画幅高 / 200），
`style.size` 用项目像素，`rotation.*` / `roll` 用度。相机 `path` 用 `cameraKey` 写，不是 `keySet`。

### 2D 元素（path 用在 `keySet`）

| path | 单位 | 默认 | 可打帧 | 可链接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| pivot.x | m | 0 | ✔ | ✔ | 世界米（100 px = 1 m）。画面中心 x = 0。 |
| pivot.y | m | 0 | ✔ | ✔ | 世界米，y 向上。1080 工程里画面中心 y = 5.4，画面下缘 y = 0。 |
| pivot.z | m | 0 | ✔ | ✔ | 世界米；z 越大越靠近默认相机（相机在 z = 20 看向 -Z）。 |
| scale.x | × | 1 | ✔ | ✔ | 倍率，1 = 原尺寸。 |
| scale.y | × | 1 | ✔ | ✔ | 倍率，1 = 原尺寸。 |
| scale.z | × | 1 | ✔ | ✔ | 倍率；平面元素的 z 缩放不改变画面尺寸，只影响子级。 |
| rotation.x | ° | 0 | ✔ | ✔ | 度；三轴旋转与 roll 互斥（有 rotation 时以它为准）。 |
| rotation.y | ° | 0 | ✔ | ✔ | 度。 |
| rotation.z | ° | 0 | ✔ | ✔ | 度；和 roll 是同一件事的三轴写法。 |
| roll | ° | 0 | ✔ | ✔ | 度；元素没有 rotation 时用这条轨。 |
| style.size | px | 96 | ✔ | ✔ | 文字字号，项目像素；其他元素不使用。 |
| style.text | — | '' | ✔ | — | 字符串轨：关键帧在离散时刻切换文本，不插值。 |
| style.color | — | `#ffffff` | ✔ | — | 文字/图形颜色；颜色轨在关键帧处离散切换。 |
| fx.glow | — | 0 | ✔ | ✔ | 元素级辉光强度（0 起，常用 0..2）。 |
| fx.blur | — | 0 | ✔ | — | 元素级模糊强度（无量纲）。 |
| audio.volume | × | 1 | ✔ | ✔ | 音频线性音量 0..1；音频自动化按线性段插值（core/audio.js::audioVolume）。 |
| code.params.<name> | any | null | ✔ | ✔ | manifest.params[].id 声明的参数；类型与单位由源声明。 |

可链接路径（`propLink` 的 `to` / `from.path`）：`pivot.x`、`pivot.y`、`pivot.z`、`scale.x`、`scale.y`、`scale.z`、`rotation.x`、`rotation.y`、`rotation.z`、`roll`、`position.x`、`position.y`、`position.z`、`style.size`、`fx.glow`、`audio.volume`、`opacity`、`code.params.<name>`

### 3D 物体（path 用在 `objectKey`）

| path | 单位 | 默认 | 可打帧 | 可链接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| pivot | m | `[0,0,0]` | ✔ | — | 世界米；也可以按 pivot.x / pivot.y / pivot.z 打标量帧。 |
| pivot.x | m | 0 | ✔ | ✔ | 世界米。 |
| pivot.y | m | 0 | ✔ | ✔ | 世界米，y 向上。 |
| pivot.z | m | 0 | ✔ | ✔ | 世界米。 |
| position | m | `[0,0,0]` | ✔ | — | 在物体自身基向量下的偏移（米）；也可按 position.x/y/z 打帧。 |
| position.x | m | 0 | ✔ | ✔ | 米。 |
| position.y | m | 0 | ✔ | ✔ | 米。 |
| position.z | m | 0 | ✔ | ✔ | 米。 |
| scale | × | `[1,1,1]` | ✔ | — | 倍率；也可按 scale.x/y/z 打帧。 |
| scale.x | × | 1 | ✔ | ✔ | 倍率。 |
| scale.y | × | 1 | ✔ | ✔ | 倍率。 |
| scale.z | × | 1 | ✔ | ✔ | 倍率。 |
| dir | xyz | `[0,0,-1]` | ✔ | — | 单位方向向量（旧式旋转）。 |
| roll | ° | 0 | ✔ | ✔ | 度。 |
| rotation.x | ° | 0 | ✔ | ✔ | 度。 |
| rotation.y | ° | 0 | ✔ | ✔ | 度。 |
| rotation.z | ° | 0 | ✔ | ✔ | 度。 |
| opacity | × | 1 | ✔ | ✔ | 0..1。 |

可链接路径（`propLink` 的 `to` / `from.path`）：`pivot.x`、`pivot.y`、`pivot.z`、`position.x`、`position.y`、`position.z`、`scale.x`、`scale.y`、`scale.z`、`roll`、`rotation.x`、`rotation.y`、`rotation.z`、`opacity`

### 相机（path 用在 `cameraParamKey（位置用 cameraKey）`）

| path | 单位 | 默认 | 可打帧 | 可链接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| center | m | `[0,0,0]` | ✔ | — | 相机位置（世界米）；旧式 path 之外的整段偏移，也可写作 pivot.x 做属性链接。 |
| scale | × | `[1,1,1]` | ✔ | — | 倍率；只影响子级，不改变取景。 |
| picturePivot | 0..1 | `[0.5,0.5]` | ✔ | — | 归一化 0..1。 |
| pictureOffset | 0..1 | `[0,0]` | ✔ | — | 归一化 -1..1。 |
| opacity | × | 1 | ✔ | ✔ | 0..1；< 0.002 时整层不画。 |
| fov | ° | 62 | ✔ | ✔ | 度；≥ 180 自动切等距鱼眼。 |
| lookAhead | m | 90 | ✔ | ✔ | 米；路径朝向的前瞻距离。 |
| bankGain | × | 1.2 | ✔ | ✔ | 倍率。 |
| maxRoll | ° | 32 | ✔ | ✔ | 度。 |
| roll | ° | 0 | ✔ | ✔ | 度；相机自身 roll，与路径转向无关。 |
| rotation.x | ° | 0 | ✔ | ✔ | 度；三轴旋转偏移。 |
| rotation.y | ° | 0 | ✔ | ✔ | 度。 |
| rotation.z | ° | 0 | ✔ | ✔ | 度。 |
| shake.amp | m | 0.6 | ✔ | ✔ | 米。 |
| shake.freq | Hz | 1.6 | ✔ | ✔ | Hz。 |
| shake.speedGain | × | 1 | ✔ | ✔ | 倍率 0..2。 |
| dof.enabled | — | false | ✔ | — | 开关。 |
| dof.fstop | f | 2.8 | ✔ | ✔ | 0.5..32。 |
| path | m | `[]` | ✔ | — | 相机位置动画：用 cameraKey / cameraRemove 写，不是普通参数轨道。 |

可链接路径（`propLink` 的 `to` / `from.path`）：`opacity`、`fov`、`lookAhead`、`bankGain`、`maxRoll`、`roll`、`rotation.x`、`rotation.y`、`rotation.z`、`shake.amp`、`shake.freq`、`shake.speedGain`、`shake.seed`、`dof.fstop`、`pivot.x`、`pivot.y`、`pivot.z`、`scale.x`、`scale.y`、`scale.z`

## 4. 文档字段（`set` / `updateElement` / `objectPatch`）

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

不是关键帧轨道，直接改值；写字符串形式的数字会被转成数字。默认值是新建时的填充值。

### 2D 元素

| 字段 | 单位 | 默认 | 说明 |
| --- | --- | --- | --- |
| id | — | '' | el_*；不可修改（只能新建）。 |
| type | — | `image` | 取值：image / video / text / solid / shape / audio / camfeed / code。文字 / 图片 / 视频 / 图形 / 音频 / 摄像机画面 / 代码图层之一。 |
| name | — | '' | 时间线与检查器里显示的名字。 |
| src | — | '' | image / video / audio 的媒体相对路径（media/ 下）。 |
| start | s | 0 | 项目绝对时间（秒）。 |
| duration | s | 1 | 秒；媒体会被素材时长夹紧。 |
| z | — | 0 | 越大越靠前；同 z 按元素数组顺序。 |
| segment | — | null | 分镜 id 或 null。 |
| visible | — | true | false 后不参与渲染与测量。 |
| locked | — | false | true 后 agent 身份（agent:*）的写入返回 LOCKED；人和 ui 仍可改。 |
| loop | — | false | 视频/音频素材循环填满时间块。 |
| fadeIn | s | 0 | 秒。 |
| fadeOut | s | 0 | 秒。 |
| punch | — | 0 | 0..1；按 meta.beats 做缩放脉冲。 |
| srcIn | s | 0 | 从素材的第几秒开始用（秒）。 |
| volume | × | 1 | 0..1；关键帧在 audio.volume 轨上。 |
| motion.type | — | `none` | 取值：none / in / out / left / right / up / down / drift / shake。叠加在关键帧之上的预设位移。 |
| motion.amount | × | 0 | 0..1。 |
| motion.dir | — | `in` | 取值：in / out。预设朝向。 |
| style.fit | — | `cover` | 取值：cover / contain / stretch。图片/视频在平面上的取景方式；contain 实际按 cover 裁（见 §4.4）。 |
| style.font | — | `SimHei` | 字体族名。 |
| style.weight | — | 400 | 100..900。 |
| style.align | — | `center` | 取值：left / center / right。文字对齐。 |
| style.lineHeight | × | 1.18 | 倍率。 |
| style.letterSpacing | px | 0 | 项目像素。 |
| style.shadow | — | 0 | 0..1 的文字投影强度。 |
| style.shape | — | `rect` | 取值：rect / ellipse。shape 元素用。 |
| style.fill | — | `#ffffff` | 图形/物体的填充色。 |
| style.radius | px | 0 | 项目像素。 |
| style.stroke | — | '' | 空字符串 = 无描边。 |
| style.strokeWidth | px | 0 | 项目像素。 |
| node.pivot | m | `[0,0,0]` | el.node.pivot（米）；关键帧请用 pivot.x/y/z。 |
| node.rotation | ° | `[0,0,0]` | el.node.rotation（度）；关键帧请用 rotation.x/y/z。 |
| node.roll | ° | 0 | el.node.roll（度）；关键帧请用 roll。 |
| node.scale | × | `[1,1,1]` | el.node.scale；关键帧请用 scale.x/y/z。 |
| node.position | m | `[0,0,0]` | el.node.position（父级空间，米）；关键帧请用 position.x/y/z。 |
| code.source | — | '' | code 元素引用的源（sources/<id>/）。 |

### 3D 物体

| 字段 | 单位 | 默认 | 说明 |
| --- | --- | --- | --- |
| id | — | '' | ob_*。 |
| type | — | `solid` | 取值：solid / shape / text / image / video / container / empty / camera / audio。只有可画类型进帧 IR。 |
| name | — | '' | 显示名。 |
| start | s | 0 | 项目绝对时间（秒）。 |
| duration | s | 1 | 秒。 |
| visible | — | true | false 后不参与渲染。 |
| locked | — | false | agent:* 身份的写入返回 LOCKED。 |
| geom.w | m | 2 | 米。 |
| geom.h | m | 2 | 米。 |
| geom.d | m | 2 | 米。 |
| style.color | — | `#17d9ff` | 物体基色。 |
| style.emissive | — | 0 | 0..1。 |

### 相机

| 字段 | 单位 | 默认 | 说明 |
| --- | --- | --- | --- |
| id | — | '' | cam_*。 |
| name | — | '' | 显示名。 |
| focal | px | 0 | 历史字段，取景由 fov 决定。 |
| near | m | 0.1 | 米。 |
| far | m | 1000 | 米。 |
| motionBlur.enabled | — | false | 整段镜头属性。 |
| motionBlur.shutter | × | 0.5 | 0..1（整段镜头属性）。 |
| locked | — | false | agent:* 身份的写入返回 LOCKED；人和 ui 仍可改。 |

## 5. 关键帧的写法

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

- `t` 是**项目绝对时间**（秒），不是元素内的相对时间；`fps` 在 `meta.fps`。
- 同一 `path` + `t` 覆盖旧键；省略 `curve` 时保留原本的曲线，`curve: null` 才清除。
- `keyRemove` 带 `t` 只删那一个键，不带 `t` 清空整条轨。
- 想给一段区间加缓动曲线：`keyCurve { id, path, from, to, curve }`（曲线存在左键上）。
- 相机参数（`fov` / `center` / `shake.amp` …）用 `cameraParamKey`，相机位置用 `cameraKey`；3D 物体用 `objectKey`。
- 淡入淡出优先用 `fadeIn` / `fadeOut` 字段；要手打透明度关键帧，用 §9 里标注「沿用旧名（仍生效）」的那一条轨道。
- 可打帧的轨道：2D 元素 17 条、3D 物体 18 条、相机 19 条（完整列表见 §3）；
  其余字段只能改值，不能打帧。

## 6. 属性链接的写法

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

- `propLink` 让一个宿主的数值属性跟随另一个宿主的数值属性；`host` 取 `el` / `ob` / `cam`。
- 可被链接的路径：2D 元素 18 条、3D 物体 14 条、相机 20 条（每节末尾列出）。
- `combine: add` 是加偏移，`mul` 是乘比例（比率单位默认 `mul`）；单位必须同族：length / angle / ratio / number（代码参数是 `any`）。
- 代码图层的 `code.params.<name>` 是唯一允许跨单位的例外（单位由 manifest 声明）。
- 写之前引擎会查环与链深（上限 32 层）；父宿主被删时链接自动摘除，子宿主保留本地值。

## 7. 锁定与变更集

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

- `locked: true` 的宿主（2D 元素 / 3D 物体 / 相机）：`actorId` 以 `agent:` 开头的写入一律返回 `LOCKED`，`ui` / `human` / `cli` 照常可写。
- 改锁定状态的 op 本身也受这条规则约束（agent 不能给自己解锁）。
- 一次被接受的编辑用 `vdm_changeset_apply` 记成变更集：带 `expectedRev`、`requestId`、`dryRun`，语义与 `vdm_project_apply_ops` 相同。
- `vdm_changeset_revert` 只撤销「现在仍等于该变更集写下的值」的属性；别人改过的属性进 `report.decisions`，不会强行覆盖。

## 8. 规则

1. **留在被指定的分镜里**（除非用户要求整片）。
2. 先看 `meta.beats`：让改动落在拍点上（元素起点 / 关键帧时间对齐 beats）。
3. 少而准：先 `dryRun`，再提交；改完能一句话说清。
4. 不要编造元素 id；只用清单里有的，或者 `addElement` 新建。
5. 不要手写整个 `project.vdm.json`，不要动 `media/` 与 `.vdm/` 之外的文件。
6. 文字要短（1920×1080 上 6–12 个字最稳），字号 80–200 之间。
7. 想确认效果就要求重新出图；你看的截图是预览（近似），Blender 才是最终观感。
8. 锁定（`locked`）不是建议而是边界：被拒绝时报告给用户，不要绕路。

<!-- gen:legacy-begin — 旧字段名区块（tests/contracts.test.mjs 用它证明旧字段名只在里面出现） -->

## 9. 旧字段名（不推荐给新元素，唯一仍生效的已标注）

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

下面这些路径名沿用了旧的 2D 变换字段。`已废弃` 的几条只对没有迁移过的老工程生效——写在新元素上不会改变画面，
新元素一律用 §3 的节点字段（`pivot.*` / `rotation.*` / `roll` / `scale.*`）。`沿用旧名` 的一条是例外：
它仍然是唯一的实现，可以继续用。本节是全文唯一出现 `transform.*` 的地方，且已明确标注状态，不是推荐写法。

| host | path | 单位 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| el | transform.x | px | 已废弃（仅旧工程） | 旧 2D 横向位置（像素，y 向下）；新元素改用 pivot.x（米）。 |
| el | transform.y | px | 已废弃（仅旧工程） | 旧 2D 纵向位置（像素，y 向下）；新元素改用 pivot.y（米）。 |
| el | transform.z | m | 已废弃（仅旧工程） | 旧深度（米）；新元素改用 pivot.z。 |
| el | transform.scale | × | 已废弃（仅旧工程） | 旧统一缩放；新元素改用 scale.x / scale.y。 |
| el | transform.rotation | ° | 已废弃（仅旧工程） | 旧平面旋转；新元素改用 roll 或 rotation.z。 |
| el | transform.opacity | × | 沿用旧名（仍生效） | 透明度：名字沿用旧字段，但它是唯一生效的透明度轨道（新元素也一样）。淡入淡出也可以改用 fadeIn / fadeOut 字段。 |

<!-- gen:legacy-end -->

## 10. 生成与校验

<!-- 此段由 scripts/gen-contracts.mjs 生成，勿手改。契约源：core/contracts.js -->

- 本文件由 `scripts/gen-contracts.mjs` 从 `core/contracts.js` 生成（CONTRACT_VERSION 3），**不要手改**。
- 重生成：`node scripts/gen-contracts.mjs`；校验：`node scripts/gen-contracts.mjs --check`（不一致时非零退出并打印 diff 摘要）。
- 同源生成物：`docs/CONTRACTS.md`（人读字段表）、`mcp/contracts.generated.json`（机读快照）。
- 当前规模：52 个公开 op、162 个 op 字段、122 条属性路径。
