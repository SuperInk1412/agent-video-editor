# SPEC — 场景元素（v3 objects，渐进实现中）

> 目标模型见 `docs/DESIGN-SCENE-EDITOR.md` 第 2 节。这份文档只写**当前代码真的支持**的部分，
> 避免 UI / CLI / AI 按设计文档里的未来字段写坏项目。

## 存哪里

```json
{ "scene": { "version": 3, "units": "m", "objects": [], "annotations": [] } }
```

- 根场景暂存在 `project.scene`（单个 v3 场景对象）。`scenes` 树 / 子场景 / 拍扁还没落地，
  落地时整体搬进 `scenes.root`。
- 所有长度单位都是**米**，y 轴向上，地面 y=0。
- 旧 2D 项目（`project.elements`）保持不变；`project.scene` 是新增的可选字段，
  引擎不迁移、不求值它之外的东西。
- 写项目只能走 `core/ops.js` 的 ops（见下），不要手写 JSON。

## 对象字段

```json
{
  "id": "ob_sign1",
  "type": "solid",            // empty | camera | text | image | video | solid | shape | audio | container
  "name": "招牌",
  "start": 0, "duration": 15,  // 秒；[start, start+duration) 之外不渲染
  "visible": true,
  "pivot": [4.1, 99.3, -465.7],   // 旋转/拖拽的中心（世界坐标，米）
  "position": [0, 0, 0],          // 几何体相对 pivot 的偏移（米）
  "scale": [1, 1, 1],             // 绕几何中心缩放
  "rot": { "dir": [0, 0, -1], "roll": 0 },
  "opacity": 1,
  "geom": { "w": 8, "h": 4, "d": 0.5 },  // 米；盒子的全宽/全高/全厚
  "style": { "color": "#17d9ff", "emissive": 1, "opacity": 1 },
  "tracks": { ... }               // 通道关键帧
}
```

变换（与 `core/scene.js::objectPose` 一致）：

```
M = T(pivot) · R(dir, roll) · T(position) · S(scale) · geometry
几何中心 = pivot + R · position
```

- 盒子几何**以几何中心为原点**（不是贴地）。要落地：`pivot.y = geom.h / 2`（检查器「落地」按钮）。
- `dir` 是朝向，元素正面朝它看的方向；`roll` 是绕朝向自转（度）。
- `geom` 是米制全尺寸；`scale` 再乘上去。预览和 Blender 都先缩放单位立方体到 `geom`，再乘 `scale`。
- `solid / shape / container` 按**盒子**画；`image / video` 画成贴图平面，`text` 画成 3D 文字（见下节）。
  `empty` 只在编辑器视口里画成黄色十字；`audio / camera` 不画。

## 通道（tracks）

键：`pivot`、`position`、`scale`（vec3），`dir`（单位 vec3，球面点）、`roll`、`opacity`
（标量），以及 `pivot.x / .y / .z`、`position.x…`、`scale.x…` 这类标量子轨。

```json
"tracks": {
  "pivot":   [{ "t": 0, "v": [0, 90, -400], "ease": "easeInOut" },
              { "t": 6, "v": [20, 70, -500], "out": [2, -1, 4], "in": [-2, 1, -4] }],
  "dir":     [{ "t": 0, "v": [0, 0, -1] }],
  "opacity": [{ "t": 0, "v": 0 }, { "t": 1, "v": 1 }]
}
```

- 插值：`pivot/position/scale` 是三次贝塞尔（不写 `out/in` 时用 Catmull-Rom 切线/6，与相机一致）；
  `dir` 是球面贝塞尔（切线投到切平面后归一化）；标量按 `ease` 一维插值。
- 每个键可带 `ease`（`linear / easeIn / easeOut / easeInOut / smooth / outExpo / inOutCubic / outBack`）。
- 每个键可带段级 `speed: [[u,v], …]`（`speedWarp` 先积分成弧长再取样），
  检查器里每个元素关键帧的 `∿` 打开速度曲线编辑器（拖点 / 匀速 / 慢入 / 慢出 / 冲击 / 清除）；
  有 `speed` 时该段忽略 `ease`。
- 同轨同 `t`（±0.0001s）只有一个键；`objectKey` 重写值时保留旧键的 `ease/out/in/speed`
  （显式传 `speed: null` 清除速度曲线）。
- vec3 轨存在时优先于 `.x/.y/.z` 子轨（`sampleAxes`）。

## Ops（`core/ops.js` / `vdm ops`）

```bash
vdm ops '{"op":"objectAdd","object":{"type":"solid","name":"招牌","pivot":[0,40,-300],"geom":{"w":12,"h":6,"d":0.4},"style":{"color":"#17d9ff","emissive":1}}}'
vdm ops '{"op":"objectPatch","id":"ob_1","patch":{"opacity":0.8,"geom":{"w":10}}}'
vdm ops '{"op":"objectKey","id":"ob_1","path":"pivot","t":2,"v":[0,40,-300]}'
vdm ops '{"op":"objectKey","id":"ob_1","path":"opacity","t":2,"v":0,"ease":"easeOut"}'
vdm ops '{"op":"objectUnkey","id":"ob_1","path":"pivot","t":2}'
vdm ops '{"op":"objectRemove","id":"ob_1"}'
```

- `objectAdd`：补默认值（`id` 自动 `ob_N`，`start` 夹到项目时长，`duration` 默认到片尾，
  `geom` 默认 2×2×2，`type` 非法降级为 `solid`）。可显式给 `id`/`start`/`duration`/`style`。
- `objectPatch`：改基础属性；不允许改 `id`/`tracks`（关键帧请用 `objectKey`）。
- `objectKey`：`path` 限上面的通道；vec3 通道要 `v:[x,y,z]`，`dir` 会自动归一化；
  可带 `ease/out/in/speed`。`out/in` 是相对键值的贝塞尔手柄偏移（米/单位向量）。
- `objectUnkey`：删该时刻的键；轨道空了就删轨道。
- 撤销/重做走引擎的快照历史，所有 ops 通用。

## 图片 / 视频 / 文字

`core/objects-media.js`（数据与公式）、`blender/vdm_objects.py`（成片）、`preview3d.js`（视口）。

```json
{ "type": "image", "src": "media/poster.png", "geom": { "w": 8, "h": 4.5 },
  "style": { "fit": "contain", "uv": [0, 0, 1, 1], "emissive": 1, "opacity": 1 } }
{ "type": "video", "src": "media/clip.mp4", "srcIn": 3, "rate": 1, "geom": { "w": 8, "h": 4.5 } }
{ "type": "text", "style": { "text": "锈梦", "size": 2.4, "color": "#ffd23f", "font": "media/fonts/sarasa-bold.ttf",
                              "align": "center", "tracking": 0, "lineHeight": 1.2, "extrude": 0, "emissive": 1 } }
```

- **朝向**：平面/文字的正面朝 `dir`（和「面向镜头」一致），从正面看不镜像；背面可见（镜像）。
- **图片/视频**：`geom.w × geom.h` 是"框"（米），`geom.d` 不用。`fit`：`contain`（默认，按素材比例缩到框内）、
  `cover`（铺满框、居中裁掉多余部分）、`stretch`。`uv` 先裁出素材的一块再适配（0..1，v 向上）。
  自发光材质：亮度 = 素材颜色 × `emissive`，和 Blender 的 Emission 一致；雾和城市同一套。
- **视频**：项目时间 t → 源时间 `srcIn + (t − start) · rate`，夹在片段内（不循环）。成片前引擎把
  `[srcIn, srcIn + duration·rate]` 按项目 fps 抽成**保持原比例**的 PNG 序列（`engine/media-objects.js`，按内容哈希缓存），
  Blender 每帧选第 `floor((t − start)·rate·fps) + 1` 张。视口用 `<video>`：暂停时逐帧对齐，播放时跟播、漂移 > 0.35 s 才校正。
- **文字**：`size` = **一个 em 的高度（米）**，和 CSS 一致。Blender 按字体包围盒定字号，所以成片里会按字体文件
  `head` 表的包围盒把字号和行距换算回 em（实测宽度差约 1%）。`font` 可以是项目里的字体文件（`media/fonts/*.ttf`，
  视口用 `FontFace` 加载同一个文件）或字体名（默认 `SimHei`，走 Blender 的字体表）。
  `align` 左/右对齐时文字从原点向右/向左排（Blender 的锚点规则，视口一致）；多行用 `\n`。
  `extrude` 只在成片里有厚度（前后各一半），视口画正面。`tracking` 是近似（Blender 按字宽倍数，视口按 em）。
- 检查器「内容」区块可改素材、适配、框尺寸、入点/速度、文字排版；顶部 **▦** 新建菜单的
  「场景元素」可直接加空元素 / 图片 / 视频 / 3D 文字（图片和视频从 `media/` 里选，3D 文字
  和顶部的 2D **T** 文字元素不是同一种东西）。

## 父子（空元素）

`core/hierarchy.js`。任何元素都能挂到另一个元素下；`empty`（空元素）是专门当父级用的纯变换元素，
视口里画成黄色三杠十字，不进成片。

```json
"parent": {
  "id": "ob_rig",
  "inherit":  { "pos": true, "rot": true, "scale": true },
  "strength": { "rot": 1, "scale": 1 },
  "bind": { "pos": [x, y, z], "basis": [[right], [up], [forward]], "scale": [sx, sy, sz] }
}
```

- **子元素自己的数值不变**：挂上时只记下父级当时的世界坐标系（`bind`），之后父级相对这一刻的运动带着子元素走。
  所以挂上不跳位，时间轴上子元素的中心点/位置/缩放仍是它自己的数值（父级空间里的本地值）。
- 求值：`x' = c + L·(x − bind.pos)`；`c` = 父级当前位置（`pos` 关掉时用 `bind.pos`）；
  `L = Rd^w · B·diag(k)·Bᵀ`，`Rd` = 父级相对绑定时的旋转（`rot` 关掉时为单位阵），`w` = 旋转强度；
  `k = 1 + (父级缩放 / bind.scale − 1) · 缩放强度`（`scale` 关掉时为 1）。父级的坐标系 = 几何中心 + 朝向基 + 缩放。
- 强度 0..1，可打关键帧：轨道 `parent.rot` / `parent.scale`（标量，支持 `ease`）。
- 多级父子逐级组合，最多 32 级；成环拒绝。父级被 `objectRemove` 删掉后，子元素回到自己的数值（会跳位，见限制）。
- 不跟随：透明度、颜色等非变换属性。

Ops（`core/ops-ext.js` 分发，`OP_KINDS` 已包含）：

```bash
vdm ops '{"op":"objectAdd","object":{"id":"ob_rig","type":"empty","pivot":[0,40,-300]}}'
vdm ops '{"op":"objectParent","id":"ob_1","parent":"ob_rig","t":2}'                       # 以 t 时刻为准绑定，不跳位
vdm ops '{"op":"objectParent","id":"ob_1","parent":"ob_rig","t":2,"inherit":{"rot":false},"strength":{"scale":0.5}}'
vdm ops '{"op":"objectParentKey","id":"ob_1","channel":"rot","t":3,"v":0.3,"ease":"linear"}'
vdm ops '{"op":"objectParentUnkey","id":"ob_1","channel":"rot","t":3}'
vdm ops '{"op":"objectUnparent","id":"ob_1","t":2}'                                       # 保持 t 时刻的世界位置
```

- `objectParent` 换父级、改开关、改基础强度都会先"取下再挂上"，保证 `t` 时刻不跳位；`parent: null` 等于 `objectUnparent`。
- `objectUnparent` 把父级在 `t` 时刻的作用**写回**子元素自己的数值和关键帧（中心点 / 位置 / 缩放 / 朝向 / 自转）。
  在 `t` 时刻精确；父级本身在动时，其它时刻只保留子元素自己的动画（父级的运动不再叠加）。
  父级有非均匀缩放且带旋转时，取最接近的无剪切姿态；`pivot.x/y/z` 分轴轨道在有旋转时会合并成一条 vec3 轨
  （按各分轴键时刻的并集取样，分轴的 ease 不保留）。
- 检查器「父级」区块：选父级、三个跟随开关、旋转/缩放强度（◆ 打帧，Shift+◆ 删帧）。

## 预览 / 成片一致性

- WebGL：`app/renderer/js/preview3d.js` 用 `worldPose()`（`objectPose()` + 父子链）逐对象画单位立方体（一个对象一次 draw），
  颜色/自发光/雾与城市同一套；选中框与运动路径在 `pathgizmo.js`。
- Blender：`engine/shot.js::bakeObjects()` 在 **JS 侧**用同一个 `worldPose()` 烘逐帧
  `{f, loc, rot(3×3 basis), size, opacity}` 进 shot 包；`blender/vdm_city.py::_build_objects()`
  按帧写 location / rotation_quaternion / scale 关键帧，窗外缩放为 1e-4（不可见）。
  两边不各自实现求值，避免漂移。
- shot 缓存键含 `rev`，改元素会重新烘。

## 时间轴里的属性行

3D 元素直接长在时间轴里：每个元素一行（元素名 / 眼睛 / `3D` / `⋯` / 时间段块），
点行首的 `▾` 展开它的属性行；属性行的左列是数值，右列是该属性的关键帧轨道。
左列和右列同一套行线、同一个时间原点，不是两块拼起来的面板。

- **内容**：几何 `w/h/d`、颜色；**变换**：`中心点`（pivot）xyz、`位置`（position）xyz、
  `缩放` xyz、`不透明度`。**旋转不在时间轴里**（右侧检查器的旋转球负责 `dir`）。
- 三个维度都各给 X/Y/Z 输入框；中心点是世界坐标（m），位置是相对中心点的偏移（m），缩放是倍数。
- 数值是**播放头时刻的真实求值结果**：`objectPose()` 会把位置/缩放/不透明度的 ease、speed 曲线
  和贝塞尔插值算进去，所以拖动播放头、播放时属性行会逐帧同步（不会停留在基础值）。
- 编辑行为：该通道**已有键**时，改数值 = 在当前时间写/改一个键；**没有键**时 = 改基础属性，
  不会凭空产生关键帧。属性行的右轨道直接显示该通道的关键帧菱形，播放头所在帧高亮。
- 每行右侧 `◆`：黄色 = 当前时间有键；灰色 = 轨道有键但当前时间没有；暗色 = 没有轨道。
  点击 = 在当前时间打帧；再点 = 删掉这一帧（用当前求值结果打帧，不会跳变）。
- 元素行 `⋯` 菜单：选中 / 面向镜头 / 落地 / 复制（含关键帧）/ 删除。双击元素名可改名。
- **相机**也用同一套行：相机行默认折叠，点行首 `▾` 展开。`变换` 默认展开，包含 `中心点`
  （世界坐标）、`位置`（相对中心点的 path）、`画面中心`、`画面位置`、`透明度`、`缩放`；
  每行 X/Y/Z（画面 2D 为 X/Y）跟随播放头，右轨道菱形就是该属性的关键帧，`◆` 打帧 / 删帧。
  `位置` 改数值写 `cameraKey`，其它变换属性写 `cameraParamKey`。`镜头 / 构图`（FOV / 看向 /
  侧倾 / 手动 roll）、`抖动`、`景深 / 模糊` 默认收起，标题右侧显示摘要，点标题展开；这些组里
  FOV / 看向 / 侧倾 / roll / 抖动幅度·频率·随速 / 景深开关·光圈是逐帧属性，各有 `◆` 和轨道，
  随机种子 / 运动模糊 / 快门角标“整段”。
  FOV ≥ 180° 自动切等距鱼眼（预览鱼眼合成，Blender 用 Cycles + `FISHEYE_EQUIDISTANT`）。
- 展开属性不会抬高整个时间轴：行数超出时在时间轴内部滚动，主布局保持固定高度。右侧检查器
  对 3D 元素只保留旋转球、逐帧 ease / 速度曲线等高级项；对相机只保留世界参数和渲染。
- 组标题三态：`▾` 全部属性、`▾•` 只看带键、`▸` 收起；点标题按“全部 → 收起 → 全部”循环。
  选中相机 / 3D 对象 / 2D 元素按 **U**：只展开带键 host 的属性行，并隐藏组标题行；再按一次 U
  恢复之前的展开、分组和滚动位置。
- 选中池：Ctrl 混选 2D 元素 / 3D 对象 / 相机为同一个元素池；属性行、关键帧仍各自成池，关键帧不能混入。
  当前多选主要服务视觉与 U，属性池批量操作尚未接。

## 已知限制（下一步）

- 子场景还没做。
- 图片/视频/文字：文字的竖直居中、字距只能近似一致；视口里文字没有厚度；视频不循环；
  3D 文字和 2D 文字元素的排版仍各走一套实现。
- 父子：视口选中框、轴向手柄、运动路径和拖动已按世界姿态；时间轴的变换属性仍显示本地值并标 `本`，
  镜头下方显示父级链/世界坐标；大纲树还没有。`core/ops.js::objectRemove` / CLI 直接删父级时子元素
  仍会掉回本地值；编辑器里删有子级的父级会走确认框，在当前帧用 `objectUnparent` 保位。
- 相机轨道的 `speed` 速度曲线还在数据里，当前时间轴只显示位置帧，还没有单独的曲线编辑入口；
  `vdm cam` CLI 也还没暴露 speed。
- 视口拾取是 CPU ray vs 有向盒子；不考虑城市楼体遮挡（时间线选中永远可用）。
- 3D 元素的旋转只有检查器里的旋转球和「面向镜头」，还没有视口旋转手柄。
