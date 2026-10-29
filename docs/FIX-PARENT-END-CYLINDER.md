# 修复记录 · 父级相机 / 圆柱 / 片尾帧（2026-10-29）

`projects/未命名项目2` 上暴露的一串问题，都是"相机挂在自转物体上"这条玩法踩出来的。
每个问题一个提交，可单独回退；验证命令附在每节末尾。

---

## 1. 片尾帧丢物体（P0）

**现象**：播放到底或点 ⏭，播放头停在 `00:05.00 f300`，立方体消失；`still 5` 同样没有。

**根因**：`duration` 是**边界不是帧**。5 s / 60 fps 只有 300 帧（f0…f299，t = 0…4.9833）。
片段的可见区间是半开 `[start, start+duration)`（`docs/SPEC-PROJECT.md`），而播放头被
`pictureTime()` 夹到了 `duration` 本身——那里没有任何片段覆盖，所以整帧是空的。
`blender/vdm_render.py` 的 `still` 也按 `round(t*fps)+1` 取帧，t=5 取到 f301。

**修法**：
- `main.js::pictureTime()` 夹到**最后一帧** `(round(duration*fps)-1)/fps`（`timeline-math.js::lastFrameTime`）。
  播放到底、⏭、拖标尺都落在 f299。
- `vdm_render.py::still` 把请求时间夹到同一帧，`still 5` 渲最后一帧。

**注意**：`bakeObjects()` 多烘一帧**隐藏尾帧是既有设计**（`tests/shot.test.mjs`
"the time range has an exclusive end"），这一条**没有改**。

**验证**：`still 5` 有立方体；探针里 `setTime(5)` → `S.time = 4.983333`（f299）。

---

## 2. 三个"跟随"开关重写 bind（P0）

**现象**：t=2.5 关掉"跟随位置"再打开，镜头回不到原位：整条轨迹转了 90°
（t=0 从 `(0,5.4,20)` 变成 `(-20,5.4,-0.2)`）。

**根因**：`core/spatial-parent.js::applySpatialParentOp()` 每次都用**当前播放头**的父级姿态
重写 `bind`。跟随开关走的是同一个 op（`inspector.js` 三个 checkbox），于是在 t=2.5 重新
绑零位，整条相机轨迹跟着转了。

**修法**：父级 id 不变时保留原有 `bind`（只有换父级才重绑）。

**验证**：`tests/spatial-parent.test.mjs` "re-binding to the same parent keeps the zero frame"；
手动复现 t0/t2.5/t4.9 三个机位前后完全一致。

---

## 3. 有空间父级时相机 gizmo 全错位（P1）

**现象**：视锥/路径/关键点画在**不含父级**的本地机位（`(0,5.4,20)`），真实机位是
`(20,5.4,-0.2)`；选中相机时白线从画面左上角射入。

**根因**：`pathgizmo.js` 用 `evalCamera`（本地），预览与烘焙用
`evalCameraWorldWithLinks`（含 `frameParent`）。

**修法**：gizmo 的 `liveState()`、路径采样、关键点、贝塞尔手柄全部走带父级的求值
（手柄的偏移按父级旋转转过去）。

**验证**：探针对比 gizmo 与画面，t=0/1.25/2.5/3.75/4.9 误差 **0 m**（修复前最大 40 m）。

---

## 4. `/api/world` 缓存 key 不含 `scene.objects`（P1）

**现象**：给父物体加旋转动画后，同一 rev 下老窗口返回 320 栋 / cleared 0，新窗口 319 / 1；
被走廊清掉的那栋楼在预览里有、成片里没有。

**根因**：相机挂在 3D 物体上时，相机轨迹 = 物体动画 × 本地路径。城市烘焙确实用了这条轨迹
（`bakeCameraOf` → `bakeCameraTrackWorld`），但 `/api/world` 的缓存 key（服务端和
`main.js::syncWorld`）只看 `cameras`，不看 `scene.objects`。

**修法**：两处 key 都加 `scene.objects`。

**验证**：同一服务进程里改父物体动画 → `/api/world` hash 变化（319 → 320 栋）；
`tests/shot.test.mjs` "a parented camera carries its parent animation into the city"。

---

## 5. 圆柱画成立方体

**现象**：`primitive: "cylinder"` 的物体在预览和成片里都是立方体。

**根因**：两个渲染端都不读 `primitive`：`preview3d.js` 只有 `UNIT_CUBE`，
Blender 只有 `_unit_cube_mesh`。

**修法**：两边都加单位圆柱（半径 0.5，所以 `geom.w/d` 是直径；高 1 = `geom.h`；侧面平滑、
两端平盖），按 `primitive` 选网格；`engine/shot.js::bakeObjects` 把 `primitive` 传给 Blender。
时间轴内容区加了「图元」选择（立方体 / 圆柱），改 `objectPatch {primitive}`。

**验证**：同一个工程一个 box 一个 cylinder，预览截图与 `vdm still` 都是"方 + 圆"。

---

## 6. 选中效果是个框，不是描边

**现象**：选中 3D 物体时画的是包围盒 12 条棱；相机挂在物体上时它永远屏幕对齐，套在圆柱上更不像。

**修法**：改成**轮廓**：按形状采样（立方体 8 角点；圆柱上下两圈各 32 点）→ 投影 → 取凸包 → 描一圈。

**验证**：叠加层导出图：立方体是六边形轮廓、圆柱是胶囊形轮廓。

---

## 7. 合并菱形不可选（上一轮遗留）

**现象**：变换行收起时父轨道上的菱形点了没反应，反而把选区清空。

**根因**：合并菱形（`.tl-key-sum`）没有 ref，`keyframeRefOf()` 返回 null，点击落到轨道空白
→ `_startMarquee` 的 tap 分支 `clear()`。

**修法**：合并菱形展开成"该时刻所有有键的轴"的 ref 一起进池；Ctrl 整组切换；框选/拖动/Delete
一致；整组选中实心、部分选中空心描边（`poolpart`）。

**验证**：探针：t=0 选中 `rotation.x/y/z` 三个键、t=4.984 选中两个；Ctrl 整组取消；拖动整组
按帧移动；Delete 整组删除。

---

## 8. 时间轴展开变换行后子行掉出视野

**现象**：行贴着滚动区底边时点 ▸，子行出现在可视区外，看起来"行自己消失了"。

**修法**：`_toggleXformExpand()` 展开后调 `_revealRows()`：把最后一根子行滚进视野，同时
保证被点的表头不会被推到自己粘性标尺上方。

**验证**：探针：scrollTop 26 → 103，表头 688–716、子行 716–764，全部在滚动区 545–792 内。

---

## 9. 编辑器小项

- **进入编辑视角**不再直接复制镜头机位：后移 `min(12, max(3, 距离*0.35))`、抬高 `min(2.5, 后移*0.25)`，
  第一眼就能看出是编辑视角（跟随相机 F5 仍精确贴在镜头上）。
- **主体出画提示**：状态栏选中摘要显示「出画 NN%」（按镜头相机投影的包围盒算），
  暂停时刷新（播放中不逐帧算）。
- **只读输入框**（相机的飞行 XYZ）去掉输入框外观（无底色/边框、更暗、默认光标），
  tooltip 说明"由飞行路径算出"。

---

## 验证汇总

| 项 | 结果 |
|---|---|
| `npm test` | 532/532 |
| `npm run check:preview` | PASS |
| gizmo 跟随父级 | 5 个时间点误差 0 m |
| 片尾 | `still 5` 有内容；播放头停在 f299 |
| 世界缓存 | 同一进程改父物体动画 → 319 → 320 栋 |
| 圆柱 | 预览与 Blender 都是圆柱 |
| 合并菱形 | 选中/框选/拖动/Delete 全通 |
| 时间轴展开 | 子行进入视野 |

临时探针都在 `.scratch/`（已 gitignore），不随仓库提交。
