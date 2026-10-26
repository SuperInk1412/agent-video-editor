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
  - `path3`: `{ t, pos:[x,y,z], out?, in?, ease?, speed? }[]`；
  - `percent`: `0..1`，UI 显示 `%`；
  - `boolean`: `true/false`；
  - `enum`: 字符串 + options。
- `keyable`：
  - `false`: 整段一个值，不显示 `◆`/轨道；
  - `'frame'`: 每帧可不同，显示 `◆` + 轨道，播放头取值；
  - `'shot'`: 对当前镜头/整段生效（保留给以后“整段参数”；C 之下相机参数都走 frame）。
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
- 右轨道：该属性自己的菱形；点击跳转；拖动播放头时 `.at` 高亮；
- 选中某个菱形时，下面临时出 `ease / ∿ / ×` 一行（不常驻、不增加属性行）；
- `row` 只描述渲染差异：`number`、`vec3`、`percent`、`bool`、`enum`、`color`、`path3`；
- `summary` 用于组标题右侧；`badge` 用于 FOV 的“鱼眼”等；
- `keyable: false` 的属性没有 `◆`，但仍有行、摘要和写值 op。

### 3.2 基础变换属性（所有元素）

| 属性 id | 类型 | 语义 |
| --- | --- | --- |
| `transform.center` | `vec3` | **世界坐标**中心点；`position` 的父点 |
| `transform.position` | `vec3` / `path3` | 相对中心点的位置；相机是路径（`path3`） |
| `transform.opacity` | `percent` | 元素 alpha；相机 = 相机输出 alpha |
| `transform.scale` | `vec3` | 元素缩放；相机 = 拍出画面的 x/y 缩放，z 保留但不使用 |

**变换组不包含朝向/旋转**：按新设计，朝向用空元素 + 父子集实现；旧 `dir/roll` 数据保留兼容，
但不再作为基础变换属性行。2D 元素的属性行后续统一迁移到同一组（目前 2D 还没有时间轴行）。

相机上这些字段的语义：

- `center` 是世界点，`path` 是相对偏移；相机世界位置 = `center + path(t)`；
- `opacity` 是相机画面的 alpha，供多相机堆栈时与“时间轴下面的相机”做 alpha-over；
- `scale` 是拍出画面的缩放（x/y），z 保留但无效果；
- 多相机时，每一台相机都是一层；时间轴上越靠上的相机盖在下面的相机上；
- 没有下层相机时，透明部分看到黑色默认背景。

### 3.3 相机属性组

| 组 id | 默认 | 属性 |
| --- | --- | --- |
| `transform` | **展开** | 中心点、位置（路径）、透明度、缩放 |
| `lens` | 收起 | FOV（含鱼眼 badge/hint）、看向前方、转弯侧倾、最大侧倾、手动 roll |
| `shake` | 收起 | 抖动幅度、频率、随速增强、随机种子 |
| `dofMb` | 收起 | 景深开/关、光圈 f、运动模糊开/关、快门角 |

组收起时标题右侧显示摘要，例如：

- `镜头 / 构图`：`FOV 200° · 鱼眼`
- `抖动`：`0.7m · 1.5Hz`
- `景深 / 模糊`：`f/4 · 模糊 180°`

C 方案下，以上相机参数（含 DOF/快门）都要有 `◆` + 轨道，逐帧生效。DOF 的 fstop 逐帧
写进 shot 的相机数据；运动模糊快门是 Blender 场景级设置，需要逐帧驱动（实现时确认
Blender 版本/引擎行为）。

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

`layer: { stack: true, blend: 'alpha', order: 'timeline' }` 的含义：

- 每台相机渲染自己的一条 path/参数；
- 渲染顺序 = 时间轴相机行从下到上（下层先画，上层 alpha-over）；
- 每层做 `opacity` / `scale` 的 2D 后期（中心为画面中心；暂不做画面平移）；
- 预览：每台相机渲到离屏 FBO，再按 2D 变换合成；编辑相机时只画选中相机的路径 gizmo；
- Blender：每台相机一个 render layer / 一台相机 + 合成节点，最后 alpha-over；逐帧 DOF/快门；
- 基础背景：黑。

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
- U：只展开选中元素中**有键**的属性，其余收进组；
- 组标题三态：
  - `full`：`▾` 全部属性；
  - `keyed`：`▾•` 只看带键属性（U 进入）；
  - `collapsed`：`▸` 收起；
  - 在 `keyed` 下点三角 → `collapsed`；再点 → `full`；再点 → `collapsed`；U 重新进 `keyed`；
- 组是否有键由 `hasKeys(element, group)` 统一判断（属性模板的 channel）。

## 7. 并行开发切片

| 切片 | 内容 | 依赖 |
| --- | --- | --- |
| P0（已落地） | 相机二级折叠默认态 + 组摘要 | 无 |
| P1 | 模板 registry + 基础变换模板 + 选中池骨架 | schema |
| P2 | 多相机数据/行/激活相机 + 预览图层合成 + 中心点/位置/透明度/缩放关键帧 | P1 |
| P3 | C：相机参数逐帧轨道 + DOF/快门 + Blender 逐帧 | P1/P2 |
| P4 | U 过滤 + 多选 + 组三态 | P1 |
| P5 | 空元素/父子集/2D 元素属性行 | P1 |

冻结契约后，P2/P3/P4 可并行：UI 只认 `PROPERTY`/`GROUP`，引擎只认 `channel`/`eval`，
Blender 只认 `render.blender`。

## 8. 待拍板

1. 多相机：新增相机入口（相机组标题 `＋相机`？）、行排序（拖拽？）、激活相机/单独查看（solo）怎么交互？
2. 画面后期：缩放是否绕画面中心（当前设计）；是否要画面 2D 平移；透明度混合顺序确认“上行盖下行”。
3. C：运动模糊快门是否必须逐帧（Blender 场景级设置），还是 DOF 逐帧、快门整段？随机种子是否只做整段？
4. 选中池：属性池/关键帧池选中后要支持哪些操作（删除、批量打帧、复制/粘贴）？U 只对元素池？
5. 空元素/父子集/2D 元素属性行：现在做还是 P5？
6. 模板 registry 放 `core/templates.js` + `core/elements/` 是否可行（纯 ESM、浏览器/Node 共用）？
