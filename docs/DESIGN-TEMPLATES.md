# 属性模板与元素模板（并行开发契约）

> 状态：设计草案 v1，配合 `c8264d4`/`ee58643` 之后的相机多图层与 C 方案。
> 目标：把“属性怎么显示、怎么打帧、怎么求值、怎么烘焙、怎么在 Blender 实现”收成一份
> 数据描述，时间轴 / 检查器 / 引擎 / Blender 都消费同一份模板。并行开发时只依赖契约，
> 不互相改对方的硬编码分支。

## 1. 为什么需要模板

现在时间轴、检查器、`core/camera.js`、`engine/shot.js`、`blender/vdm_city.py` 各自知道
“FOV 是一个 1–360 的数字、相机有 path、DOF 是一个全局配置”。多相机堆栈 + 每个相机
逐帧 DOF / 快门 + 通用属性行之后，这种分散会迅速失控：

- 新属性要在 4–5 个地方各加一遍；
- 相机从 1 个变 N 个，时间轴 / 预览 / 烘焙 / Blender 的层叠逻辑不能各写一套；
- U 过滤、组三态、选中池需要知道“这个属性有没有关键帧”；
- 并行开发需要稳定的 schema，而不是“看代码猜”。

模板不是 UI 框架，是**纯数据描述 + 稳定的 handler id**。core 里不放 DOM；UI 用模板生成
行；引擎/Blender 用同一个 `channel` / `render` 键决定怎么取样和渲染。

## 2. 顶层契约

```js
const SCHEMA_VERSION = 1;

// 属性描述：一个数据字段 = 一行 = 一个（可选）关键帧通道
const PROPERTY = {
  id: 'camera.fov',              // 全局唯一
  label: '视场角 FOV',
  group: 'lens',                 // 所属组
  type: 'number',                // number | vec3 | percent | boolean | enum | color | path3 | layer-scale
  unit: '°',
  default: 62,
  range: [1, 360],
  step: 1,
  keyable: 'frame',              // false | 'frame' | 'shot'
  value: 'fov',                  // 元素上的数据字段
  channel: { kind: 'scalar', path: 'fov', sample: 'fov' }, // 关键帧轨道描述
  ops: { set: 'cameraSet', key: 'cameraParamKey', unkey: 'cameraParamUnkey' },
  summary: (v) => `FOV ${v}°`,
  row: { badge: (v) => (v >= 180 ? '鱼眼' : ''), hint: '≥180° 自动切等距鱼眼' },
  render: { preview: 'fov', blender: 'camera.fov' },
};

// 组描述：时间轴里的一级/二级折叠层
const GROUP = {
  id: 'lens',
  label: '镜头 / 构图',
  order: 10,
  defaultOpen: false,
  summary: (element, t) => `FOV ${...}${fov >= 180 ? ' · 鱼眼' : ''}`,
};

// 元素描述：类型 = 基础变换 + 组 + 属性 + 求值/烘焙/渲染 handler
const ELEMENT = {
  type: 'camera',
  schemaVersion: 1,
  label: '相机',
  idPrefix: 'cam_',
  groups: ['transform', 'lens', 'shake', 'dofMb'],
  transform: {
    center: 'center',       // 世界坐标
    position: 'path',       // 相对于 center；相机是路径
    opacity: 'opacity',     // 相机输出 alpha
    scale: 'scale',         // 相机画面缩放（z 保留不用）
  },
  layer: { stack: true, blend: 'alpha', order: 'timeline' },
  eval: { module: 'core/camera.js', fn: 'evalCamera' },
  bake: { module: 'engine/shot.js', fn: 'bakeCameraTrack' },
  preview: { renderer: 'camera3d', post: 'layerQuad' },
  blender: { builder: 'blender/vdm_city.py', panorama: 'FISHEYE_EQUIDISTANT', layers: 'compositor' },
  timeline: { block: 'camera', positionRow: 'path' },
};
```

契约规则：

- `id` / `group` / `type` / `channel.kind` / `render.preview` / `render.blender` 都是**冻结字符串**；
  新属性/新元素只新增，不改已有含义。
- 模板不放函数以外的副作用；跨进程（Blender）只传 JSON 字段，不传函数。
- 属性的 `value` 是元素 JSON 上的字段；数组/路径用固定 shape：
  - `vec3`: `[x,y,z]`；
  - `vec2`: `[x,y]`（画面 pivot/offset 用归一化 0..1）；
  - `path3`: `{ t, pos:[x,y,z], out?, in?, ease?, speed? }[]`；
  - `percent`: `0..1`，UI 显示 `%`；
  - `boolean`: `true/false`；
  - `enum`: 字符串 + options。
- `keyable`：
  - `false`: 整段一个值，不显示 `◆`/轨道；
  - `'frame'`: 每帧可不同，显示 `◆` + 轨道，播放头取值；
  - `'shot'`: 对当前镜头/整段生效（不显示轨道；行上带“整段”标记）。
- C-b 落地：DOF 的 `enabled/fstop` 是 `frame`；运动模糊 `enabled/shutter` 和 `shake.seed` 是
  `shot`（快门是 Blender 场景级设置；seed 逐帧会让手持噪波跳）。其它相机参数都是 `frame`。
- `ops` 是 `core/ops.js` 里的 op 名；UI 只调这些 op，不直接改 JSON。

## 3. 属性模板

### 3.1 关键帧行契约（时间轴）

所有 `keyable: 'frame'` 的属性共用同一行：

```
[ label ][ 输入 1..n ][ 可选 badge ][ ◆ ][──── 右轨道 ────]
```

- 数值 = **播放头时刻的求值结果**（不是基础值）；
- 改数值 = 在播放头写/改一个键（该通道已有键时）；没有键时写基础值 + 第一个键由 `◆` 创建；
- `◆`：黄色 = 当前时间有键；灰色 = 有轨道但当前时间无键；暗色 = 无轨道；
- 右轨道：该属性自己的菱形；点击只选中（不再跳播放头，时间定位只走顶部标尺）；拖动播放头时 `.at` 高亮；
- 选中某个菱形时，下面临时出 `ease / ∿ / ×` 一行（不常驻、不增加属性行）；
- `row` 只描述渲染差异：`number`、`vec3`、`percent`、`bool`、`enum`、`color`、`path3`；
- `summary` 用于组标题右侧；`badge` 用于 FOV 的“鱼眼”等；
- `keyable: false` 的属性没有 `◆`，但仍有行、摘要和写值 op。

### 3.2 基础变换属性（所有元素）

| 属性 id | 类型 | 语义 |
| --- | --- | --- |
| `transform.position` | `vec3` / `path3` | 相对中心点的位置；相机是路径（`path3`） |
| `transform.center` | `vec3` | **世界坐标**中心点；`position` 的父点 |
| `transform.opacity` | `percent` | 元素 alpha；相机 = 相机输出 alpha |
| `transform.scale` | `vec3` | 元素缩放；相机 = 拍出画面的 x/y 缩放，z 保留但不使用 |

**相机额外画面属性**（只属于相机，仍在 `transform` 组里，默认展开）：

| 属性 id | 类型 | 语义 |
| --- | --- | --- |
| `camera.picturePivot` | `vec2`/归一化 | 画面缩放锚点；默认 `[0.5, 0.5]`，即画面中心 |
| `camera.pictureOffset` | `vec2`/归一化 | 画面 2D 平移；默认 `[0, 0]`；与缩放/透明度一起做画面后期 |

画面 2D 单位统一为 **归一化 0..1**（0.5 是画面中心），换 1080p/4K 不换算。缩放绕
`picturePivot`，再做 `pictureOffset`，再 `opacity` alpha-over。相机世界位置仍由
`center + path(t)` 决定；画面 2D 变换不改变相机世界位置。

**变换组不包含朝向/旋转**：按新设计，朝向用空元素 + 父子集实现；旧 `dir/roll` 数据保留兼容，
但不再作为基础变换属性行。2D 元素的属性行后续统一迁移到同一组（目前 2D 还没有时间轴行）。

相机上这些字段的语义：

- `center` 是世界点，`path` 是相对偏移；相机世界位置 = `center + path(t)`；
- `opacity` 是相机画面的 alpha，供多相机堆栈时与“时间轴下面的相机”做 alpha-over；
- `scale` 是拍出画面的缩放（x/y），z 保留但无效果；缩放绕 `picturePivot`，再 `pictureOffset`；
- 多相机时，每一台相机都是一层；时间轴上越靠上的相机盖在下面的相机上；
- 没有下层相机时，透明部分看到黑色默认背景。

### 3.3 相机属性组

| 组 id | 默认 | 属性 |
| --- | --- | --- |
| `transform` | **展开** | 中心点、位置（路径）、画面中心、画面位置、透明度、缩放 |
| `lens` | 收起 | FOV（含鱼眼 badge/hint）、看向前方、转弯侧倾、最大侧倾、手动 roll |
| `shake` | 收起 | 抖动幅度、频率、随速增强、随机种子（seed 整段） |
| `dofMb` | 收起 | 景深开/关、光圈 f（逐帧）；运动模糊开/关、快门角（整段） |

组收起时标题右侧显示摘要，例如：

- `镜头 / 构图`：`FOV 200° · 鱼眼`
- `抖动`：`0.7m · 1.5Hz`
- `景深 / 模糊`：`f/4 · 模糊 180°`

C-b 落地：DOF 的 `enabled/fstop` 逐帧写进 shot 的相机数据；运动模糊的 `enabled/shutter` 和
`shake.seed` 整段生效。快门是 Blender 场景级设置，这样多相机/多层时不需要给每层做不同的
场景快门，渲染最稳；如果以后要做快门动画，再单独升级到 C-a。

### 3.4 数据路径 / 迁移

相机从单对象升级为列表：

```js
project.cameras = [
  { id:'cam_a', name:'主镜头', center:[0,0,0], path:[...], opacity:1, scale:[1,1,1], ... },
  { id:'cam_b', ... },
];
project.cameraOrder = ['cam_a', 'cam_b']; // 上 -> 下
project.activeCameraId = 'cam_a';
```

现有 `project.camera` 迁移成 `cameras = [camera]`、`center = [0,0,0]`、`path` 保持原世界坐标
（即 position 相对 center 0），视觉不变。以后移动 center 会移动整条路径。

## 4. 元素模板

`ELEMENT` 描述“这个类型有什么组/属性、怎么求值、怎么出图”：

- `box`（3D 盒子）：`transform` + `content`（geom/color）；预览/Blender 画盒子；
- `camera`：`transform` + `lens` + `shake` + `dofMb`；层叠 + path；
- `empty`：只有 `transform`；父子集的父节点，用来表达朝向/整体运动；
- `text/image/video/solid/shape`：现有 2D 元素，后续统一到 `transform` 属性行；
- `container`：子场景，后续。

模板只描述“有什么”，具体求值/出图通过 handler id 找实现；这样并行开发时：

- 一个人加 `camera.dof.fstop` 的属性模板 + ops + 求值；
- 一个人只写时间轴通用行渲染器；
- 一个人只写 Blender 相机层/合成；
- 互不改对方的 `timeline.js` / `inspector.js` / `vdm_city.py` 大分支。

## 5. 相机多图层模板

`layer: { stack: true, blend: 'alpha', order: 'timeline', solo: 'viewport' }` 的含义：

- 每台相机渲染自己的一条 path/参数；
- 渲染顺序 = 时间轴相机行从下到上（下层先画，上层 alpha-over）；**越靠上的相机盖住下面的**；
- 每层做 `picturePivot` / `pictureOffset` / `scale` / `opacity` 的 2D 后期；归一化坐标；
- 预览：每台相机渲到 `layerFBO`，再按 2D 变换 alpha-over 到 `sceneFBO`；编辑视口仍用
  编辑相机单层（便于飞 scene / 拖 path），退出编辑后的预览帧显示完整堆栈；
- 点击相机行 = 激活该相机（编辑 path/gizmo）；预览仍显示所有可见相机的合成；
- **每个元素最左的 eye** = 可见性：隐藏该元素/图层，时间轴行明显变暗；隐藏元素的变换
  仍作用于子集（可见性 ≠ 禁用变换）；
- **右键相机 → 单独查看该相机（们）**：其他相机在视口自动隐藏、行变暗；这是**视口预览**
  状态，不影响最终成片；成片仍用所有 eye 开着的相机；
- 新建入口只在顶部工具栏；拖拽相机行排序；
- Blender：每台相机一个 scene，复制城市几何；master scene 用 VSE scene strip 从下到上
  叠层（`ALPHA_OVER`），每帧写 strip 的 scale/offset/opacity 关键帧；单相机且画面变换为
  默认值时仍走直接场景路径，保留项目原有 fog/bloom/grade 合成器。多相机 VSE 叠层目前
  输出 clean layer；项目级 bloom/vignette 等还在单相机直接路径上，后续需要一层 master
  FX 才能完全等价。

顶部工具栏固定在应用标题栏左侧（logo 右边）：

```
[选择]  [新建相机]  [新建 3D 物体 ▾]
                              ├ 立方体
                              ├ 圆柱
                              └ 钢笔
```

- “新建 3D 物体”长按或点开子菜单；钢笔先作为创建工具占位，建模深度后续再定；
- 工具栏是全局的，不随项目面板滚动；
- eye/单独查看只影响可见性和视口，不改变相机数据。

## 6. 选中池与 U

选中池只允许**同一种对象**：

```js
selection = {
  kind: null | 'element' | 'property' | 'keyframe',
  ids: [],
  primary: null,
};
```

- 点不同类型 = 替换选中池；Ctrl/Shift 只在同 kind 内扩选；
- 元素池：时间轴元素行 / 相机行 / 视口元素；U 只对元素池生效；
- 属性池：属性行；关键帧池：菱形；
- 主选（primary）= 检查器/预览的焦点；多选元素时预览高亮全部，检查器用主选；
- **属性池的加选规则**：已选属性后 Ctrl 加选一个元素 = 加这个元素的所有属性；加选一个
  折叠组标题 = 加这个组里折叠的所有属性；池仍是属性池；
- **关键帧不能混入属性/元素池**：Ctrl 点关键帧会被忽略；在下方空白轨道按住拖动即可框选
  关键帧（出现选框，不改变播放头）；框选只产生关键帧池，点空白清空；
- **元素先选再加属性的默认处理**：把元素展开成它的全部属性，再并入属性池（与上一条对称）；
- 检查器里的属性逐步搬到元素/属性行，选中池是迁移后的批量操作入口；
- U：只展开选中元素中**有键**的属性，其余收进组；
- 组标题三态：
  - `full`：`▾` 全部属性；
  - `keyed`：`▾•` 只看带键属性（U 进入）；
  - `collapsed`：`▸` 收起；
  - 在 `keyed` 下点三角 → `collapsed`；再点 → `full`；再点 → `collapsed`；U 重新进 `keyed`；
- 组是否有键由 `hasKeys(element, group)` 统一判断（属性模板的 channel）。

当前落地：同质选中池（元素 / 属性 / 关键帧，Ctrl 加选；关键帧不能混入元素/属性池）已进
时间轴：元素行、相机行、属性行、菱形都会按池高亮；`U` 对主选相机 / 选中的 3D 元素生效，
按上述三态把有键的组展开成 `keyed`、无键组收起。组标题点击按 `full → collapsed → full`
循环，`keyed` 点击进入 `collapsed`。选中的关键帧按 `Delete` / `Backspace` 删除：
`core/selection.js::keyframeDeleteOps()` 把每条 ref 解析成 `cameraRemove`（path 键）/
`cameraParamUnkey`（参数键）/ `objectUnkey`（对象键，一个菱形可能跨 `pivot.x` 等轴轨道）/
`keyRemove`（2D 元素键），多条合成一个 `batch`，一次保存一次撤销；删除后选中池清空。
关键帧框选（下方空白轨道拖框，选框可见、不改变播放头）已落地；属性池加元素/组展开规则、
`B` 快捷键框选和其余批量操作仍是下一步。

## 7. 并行开发切片

| 切片 | 内容 | 依赖 |
| --- | --- | --- |
| P0（已落地） | 相机二级折叠默认态 + 组摘要 | 无 |
| P1（已落地） | 模板 registry：`core/templates.js` + 12 个契约测试 | schema |
| P2（已落地） | 多相机数据/行/激活相机 + 预览图层合成 + 中心点/位置/画面/透明度/缩放关键帧 | P1 |
| P3（已落地） | C-b：相机参数逐帧轨道 + DOF 逐帧 + Blender 逐帧 | P1/P2 |
| P4（部分） | 同质选中池 + U 过滤 + 组三态已落地；属性池展开规则、B 框选、批量操作待做 | P1 |
| P5 | 空元素/父子集/2D 元素属性行 | P1 |

冻结契约后，P2/P3/P4 可并行：UI 只认 `PROPERTY`/`GROUP`，引擎只认 `channel`/`eval`，
Blender 只认 `render.blender`。

## 8. v1 拍板结果与剩余问题

已定：

- 相机变换：`center` 世界坐标、`position` 相对；相机额外 `picturePivot` / `pictureOffset`
  （归一化 0..1，0.5 画面中心）；画面缩放绕 pivot，再平移；透明度做层 alpha；无朝向。
- C-b：DOF `enabled/fstop` 逐帧；运动模糊 `enabled/shutter` 和 `shake.seed` 整段。
- 多相机：现在就做堆栈；相机行越靠上越在上层；eye 隐藏但变换仍作用于子集；右键相机
  “单独查看该相机（们）”只影响视口，其他相机视口隐藏、行变暗；成片仍用所有可见相机。
- 工具栏：应用标题栏左侧横条；选择 / 新建相机 / 新建 3D（长按立方体/圆柱/钢笔）。
- 新建相机：默认取**当前编辑视口机位**（在播放头写一个位置键 + `look`），插到时间轴最上层
  并设为激活；相机组标题不重复放 `＋相机`，新建入口只在顶部工具栏。
- 选中池：三种同质池；属性池加元素/组 = 展开成属性；元素先选再加属性也展开成属性池；
  关键帧不能混入，清空后框选（`B`）；检查器属性逐步迁入；U 只对元素池生效；组三态如 §6。

剩余待定（不阻塞 P1 模板 registry）：

1. 属性池/关键帧池的批量操作：删除、批量打帧、复制/粘贴里先做哪些？
2. 钢笔工具做到什么程度：先创建空网格占位，还是直接做挤出/画线建模？
3. 空元素/父子集/2D 元素属性行：按 P5 还是提前？
4. 模板 registry 文件布局：`core/templates.js`（P1 已采用）+ 后续按元素拆 `core/elements/`。
