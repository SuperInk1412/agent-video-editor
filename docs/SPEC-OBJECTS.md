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
- 目前可绘制类型：`solid / shape / text / image / video / container`，都按**盒子**画
  （贴图/文字平面还没做）。`empty / audio / camera` 不画。

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

## 预览 / 成片一致性

- WebGL：`app/renderer/js/preview3d.js` 用 `objectPose()` 逐对象画单位立方体（一个对象一次 draw），
  颜色/自发光/雾与城市同一套；选中框与运动路径在 `pathgizmo.js`。
- Blender：`engine/shot.js::bakeObjects()` 在 **JS 侧**用同一个 `objectPose()` 烘逐帧
  `{f, loc, rot(3×3 basis), size, opacity}` 进 shot 包；`blender/vdm_city.py::_build_objects()`
  按帧写 location / rotation_quaternion / scale 关键帧，窗外缩放为 1e-4（不可见）。
  两边不各自实现求值，避免漂移。
- shot 缓存键含 `rev`，改元素会重新烘。

## 时间轴左侧属性面板

选中 3D 元素时，时间轴左侧出现属性面板（`app/renderer/js/tlprops.js`），不选中时显示提示。

- **内容**：几何 `w/h/d`、颜色；**变换**：`中心点`（pivot）xyz、`位置`（position）xyz、
  `缩放` xyz、`不透明度`。**旋转不在这个面板里**（右侧检查器的旋转球负责 `dir`）。
- 三个维度都各给 X/Y/Z 输入框；中心点是世界坐标（m），位置是相对中心点的偏移（m），缩放是倍数。
- 数值是**播放头时刻的真实求值结果**：`objectPose()` 会把位置/缩放/不透明度的 ease、speed 曲线
  和贝塞尔插值算进去，所以拖动播放头、播放时面板会逐帧同步（不会停留在基础值）。
- 编辑行为：该通道**已有键**时，改数值 = 在当前时间写/改一个键；**没有键**时 = 改基础属性，
  不会凭空产生关键帧。
- 每行右侧 `◆`：黄色 = 当前时间有键；灰色 = 轨道有键但当前时间没有；暗色 = 没有轨道。
  点击 = 在当前时间打帧；再点 = 删掉这一帧（用当前求值结果打帧，不会跳变）。

## 已知限制（下一步）

- 贴图/文字平面、父子（空元素）、子场景还没做。
- 相机轨道的速度曲线也在关键点行里编辑（`∿`），但 `vdm cam` CLI 还没暴露 speed。
- 视口拾取是 CPU ray vs 有向盒子；不考虑城市楼体遮挡（时间线选中永远可用）。
- 3D 元素的旋转只有检查器里的旋转球和「面向镜头」，还没有视口旋转手柄。
