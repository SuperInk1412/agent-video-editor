# 统一空间：所有项目都是 3D（设计 · 待两条线确认）

> 2026-10-27 · 作者：B（MV/预设 agent）· 读者：A（曲线/相机/编辑器交互 agent）与项目负责人
>
> 用户拍板："启用 3D 是默认必须启用的，2D 只是摄像机不动 + 元素没有厚度 + 元素纵深轴都固定 +
> 所属层级决定细微的纵深区别组合造成的幻觉；只要摄像机纵深一移动，或者元素纵深轴一移动，就能出现 3D 空间的感觉。"
>
> 本文是方案，不代表代码已改。两边按 §8 的顺序**依次**推进，每一步做完在本文末尾登记一行再交棒。

---

## 0. 结论先行

- **没有 2D 模式，也没有"启用 3D"按钮。** 新建项目就带一个空世界（无城市）和一台默认相机。
- 文字 / 色块 / 图片 / 视频这些"2D 元素"是**世界里没有厚度的平面**，默认摆在相机正前方的"画面平面"上。
- 元素多一条可打关键帧的**纵深轴 z**；图层顺序只转成**看不出来的**纵深偏移（见 §3）。
- 相机和所有元素都不动时，画面与今天的 2D 项目**逐像素一致**；相机推拉 / 元素 z 一动，视差和透视自然出现。
- 贴屏元素（永远钉在画面上的字幕、HUD）= **相机的子元素**（复用已合并的父子系统）。
- 这条决定**取代** `INTERACTION-ISSUES-2026-10-27.md` §2.1 的「启用 3D 世界」按钮方案，
  也让 W3（2D 层叠在 3D 画面最上面）成为过渡方案，最终退役（§7）。

---

## 1. 坐标与默认相机

沿用现有约定（`core/migrate.js` 文件头、`PX_PER_M = 100`）：

| 项 | 约定 |
|---|---|
| 单位 | 100 px = 1 m |
| 世界轴 | x 向右、y 向上、z 指向观众（右手系） |
| 画面平面 | `z = 0`，**下沿落在地面**：中心在 `(0, H/200, 0)`（1080 高时 `y = 5.4 m`）；1920×1080 → 19.2 m × 10.8 m |
| 像素 → 世界 | `X = x / 100`，`Y = H/200 − y / 100`（像素 y 向下，原点在画面中心），`Z = transform.z`（**米**） |
| 默认相机 | 透视；位置 `(0, H/200, D)`，看向画面中心 `(0, H/200, 0)`，`D = 20 m`；水平 fov = `2·atan(9.6 / D)` ≈ **51.28°**（fov 本来就是水平视场角，见 SPEC-CAMERA） |

- 透视而不是正交：只要相机和元素都不动，z = 0 平面上的透视与正交成像完全相同；一推拉就有透视，不需要切换。
- 画幅不是 16:9 时：`D` 不变，fov 按 `width / 100 / 2` 算，保证画面平面正好铺满。
- 默认相机是一个**普通相机**（相机栈里的第一台、active），只有一个路径关键点；用户随时可以给它加关键帧。

画面平面下沿落地（用户 2026-10-27 拍板）：用户之后切到程序化城市时，画面平面正好立在地面上。
注意这与 `core/migrate.js` 文件头的旧约定（画面中心在原点）不同，以本文为准；方案乙落地时迁移代码要跟着改。

---

## 2. 元素数据：两个方案

### 方案甲（B 推荐，作为第一阶段）：2D 元素格式不变，只加纵深

- `project.elements` 原样保留：`transform.x / y / scale / rotation / opacity`、style、motion、fades、节拍冲击、关键帧路径都不变；
- 新增 `transform.z`（**米**，默认 0，正值朝向观众），可打关键帧（路径 `transform.z`）；x / y 仍是像素
- 渲染时把元素在 t 时刻的求值结果（`core/evaluate.js`）换算成一块世界平面；
- 现有 UI / CLI / AI / `AGENT-PROTOCOL.md` 的写法全部不变；改动集中在"怎么画"。

### 方案乙（DESIGN-SCENE-EDITOR §8 的长期方向）：元素并入 3D 物体

- `elements[]` 迁移成 `scene.objects`（`core/migrate.js` 已经实现，只在 CLI 里用，要求旧项目 golden 帧逐像素不变）；
- 一套数据模型，但 2D 的运动预设 / 淡入淡出 / 节拍冲击 / 文字排版要全部在 objects 侧重做，属性面板、时间轴、ops、AGENT-PROTOCOL 都要改。

**建议**：先做甲，把"所有项目都是 3D"这件事在渲染层落地，用户马上能用；乙作为后续整合，等甲稳定、
golden 帧比对基线建立之后再评估。请 A 表态（§9-2）。下文都按甲写。

---

## 3. 图层与纵深：看不出来的偏移

问题：同在 z = 0 的平面必须有确定的前后关系（今天由 `el.z` 图层顺序决定），但透视下任何真实偏移都会让元素变大一点。

做法：

- 每个元素的**图层偏移** `bias = rank × 1 mm`（rank = 按 `el.z`、`start` 排序后的序号），沿**相机视线**朝观众移动；
- 同时把这块平面按 `(D − bias) / D` **等比缩小**，抵消透视放大：相机不动时成像尺寸与位置严格不变；
- 用户的 `transform.z` 是**真实纵深**，不做补偿，所以一动就有视差；
- 透明物体按距离排序，距离相同时按 rank（预览：排序后依次画；Blender：偏移本身就让 EEVEE 的排序确定）。

> 1 mm × 100 层 = 10 cm；不补偿的话 1000 px 宽的元素会大约 5 px，肉眼可见，所以补偿是必须的。

---

## 4. 求值：一次算好，两边共用

今天 2D 有两份求值：`core/evaluate.js`（预览）和 `blender/vdm_build.py::eval_element`（Blender），靠对拍保持一致。

统一空间后，3D 路径改为**和 3D 物体一样**：JS 侧逐帧求值 → 烘焙进 shot 包 → Blender 只负责摆放。

- 新文件 `core/space.js`（B）：
  - `screenToWorld(meta, x, y, z)`、`defaultCamera(meta)`、`layerBias(project)`；
  - `elementPlane(project, el, t)` → `{ pos, basis, size(m), opacity, style 快照 }`（内部调用 `evaluate.js`）。
- `engine/shot.js::bakeElements()`（B）：每帧一份 `{loc, rot, size, opacity, color, glow, ...}`，和 `bakeObjects` 同构；
- Blender 新增 `blender/vdm_elements.py`（B）：文字用 FONT（字号换算沿用 W2 的 em 规则）、图片/视频/色块/形状用平面 + 材质，
  逐帧关键帧来自烘焙；混合模式 `add / screen` 用材质实现；`fx.glow` 走发光强度 + 合成器辉光。
- 结果：3D 路径不再需要 Python 的 `eval_element`；`AGENTS.md` 里"改 evaluate.js 同步改 eval_element"的规则，
  在 2D 渲染路径退役后可以删掉（§7）。

文字关键帧（字号、颜色变化）：字号变化 = 平面等比缩放（不重排版），颜色变化 = 材质颜色关键帧；
文字内容本身不能逐帧变（今天也不能）。

---

## 5. 预览

- `preview3d.js`（B）画元素平面：纹理来源复用 `preview.js` 已有的文字栅格、图片、视频、形状绘制
  （把这部分抽成可复用的函数，`preview.js` 是共享文件，抽之前在 HANDOFF 登记）；
- 所有项目都走 3D 预览路径；`preview.js` 的纯 2D 分支保留到 §7 退役；
- 编辑视口的地面网格：A 在 gizmo 层画（INTERACTION-ISSUES §7.1 已约定），镜头视角和成片里都没有。

---

## 6. 贴屏元素 = 相机的子元素

- 父子系统（`core/hierarchy.js`）扩展到：**元素可以以相机为父级**，跟随相机的位置和旋转；
- 2D 元素也能有父级（方案甲下，`el.parent` 与 objects 同格式），这样字幕可以钉在画面上，标志可以跟着某个 3D 物体走；
- 第一步只做"元素以相机为父"；元素之间、元素与 3D 物体之间的父子放到后面。

---

## 7. 迁移与退役

- **打开旧项目**（没有相机 / 世界的 2D 项目，例如 `projects/miku-swiss`、`projects/demo`）：
  `core/migrate.js` 新增一个在**加载时**跑的小迁移：补 `world = {source:'none'}` + 默认相机；元素不动（`transform.z` 缺省 0）。
  验收：迁移前后 Blender 成片与预览**逐像素一致**（允许抗锯齿误差，阈值在测试里写死）。
- **退役**（全部通过 golden 帧比对后）：
  - W3 的 `VDM_2D` 叠加场景（`vdm_city.py::_build_overlay`）；
  - `vdm_build.py` 的 2D 正交构建器与 `eval_element`；
  - `preview.js` 的纯 2D 分支。
  退役前两条路径并存，用项目里一个临时开关切换，便于对比。

---

## 8. 分工与顺序（依次推进，每步登记后交棒）

| 步 | 内容 | 负责 | 主要文件 | 验收 |
|---|---|---|---|---|
| 1 | 空世界：`source:'none'`、空城市、预览/Blender 不画城市（INTERACTION-ISSUES §7.1） | **B** | `core/world.js`、`engine/city.js`、`preview3d.js`、`vdm_city.py`、`inspector.js` | 空世界 still 只有背景 + 用户对象 |
| 2 | 坐标与默认相机：`core/space.js`；加载时迁移（补世界 + 默认相机） | **B** | `core/space.js`（新）、`core/migrate.js`、测试 | 旧 2D 项目打开后有相机，数据其余不变 |
| 3 | 新建项目直接带空世界 + 默认相机；删除「启用 3D」相关入口设想；编辑网格 | **A** | `engine/server.js`（create）、`main.js`、gizmo | 新建项目即可加 3D 元素、相机行可见 |
| 4 | 元素进 3D：`elementPlane`、`bakeElements`、`vdm_elements.py`、预览画元素平面、图层偏移 + 补偿 | **B** | `core/space.js`、`engine/shot.js`、`blender/vdm_elements.py`（新）、`preview3d.js`、`preview.js`（抽函数） | demo / miku-swiss 的 golden 帧逐像素一致；推相机出现视差 |
| 5 | 编辑：`transform.z` 进时间轴属性行（并入 INTERACTION-ISSUES 问题 2）、属性面板纵深字段、视口拖拽沿深度 | **A**（时间轴/视口）+ **B**（属性面板） | `timeline.js`、`main.js`、`inspector.js` | 界面里能改 z、打 z 关键帧 |
| 6 | 元素以相机为父（贴屏） | **B**（数据/求值）+ **A**（选择/拖拽） | `core/hierarchy.js`、`core/space.js`、`main.js` | 相机运动时贴屏字幕不动 |
| 7 | 退役旧 2D 路径与 W3 叠加；更新 `ARCHITECTURE.md` / `SPEC-PROJECT.md` / `AGENTS.md` / `AGENT-PROTOCOL.md` | **B** 主笔，A review | 见 §7 | golden 帧全部通过后才删 |

- 1 和 2 是 B 连做；3 等 2 的默认相机函数落地后 A 接；4 与 3 可并行；5 等 4；6 等 5；7 最后。
- 每步：Conventional Commits、单测、真机截图（DeepSeek 看图）、Blender still 对拍，做完在 §10 追加一行（sha + 验收结果），并用信箱（`docs/AGENT-MAIL.md`）通知下一步的负责方。
- 歌词样例（`projects/miku-swiss`）暂停，等第 4 步后在新模型上继续，顺带作为 golden 帧样本。

---

## 9. 已确认（用户，2026-10-27）

1. 画面平面**抬高，下沿落在地面**（中心 `y = H/200`）。
2. 元素数据**先甲后乙**。
3. 默认相机距离 **D = 20 m**。
4. `transform.z` 用**米**。

A 对其他细节有异议，通过 `docs/AGENT-MAIL.md` 的信箱提出，B 改方案后在本文更新，不另开文档。

## 10. 进度登记

（每一步做完在这里追加：日期 · 步号 · 负责方 · sha · 验收结果）
- 2026-10-27 · 第 1 步 · B · `076ca3c` `39cdff8` `5f36cf5`（已快进合入 master）· 空世界 `source:'none'`：空城市同形状；Blender 跳过地面/楼/霓虹，透明底片 + 合成器纯色底，雾只作用于物体；属性面板世界面板「空 / 程序化城市」。验收：空世界预览与 Blender 中物体位置一致（红方块包围盒横向 0.229–0.484、纵向 0.30–0.70 两边相同），无城市；带城市的 nightcity still 改动前后逐像素一致（max diff 0）。
- 2026-10-27 · 第 2 步 · B · `4046ce7` `ccd114a`（已快进合入 master）· `core/space.js`（`SCREEN_DISTANCE` / `screenCenterY` / `defaultFov` / `screenToWorld` / `defaultWorld(meta)` / `defaultCamera(meta)` / `hasCamera` / `ensureSpace`）；`store.loadProject` 打开时内存升级（不写盘）。验收：miku-swiss 升级前后 Blender still max diff 7/255（颗粒）、预览视口 max diff 4/255；单测 `tests/space.test.mjs` 4 条。**已知阻塞**：A 的单关键点相机 1 s 后 look 塌缩（见信 B-002），默认相机是单关键点，第 3/4 步验收前需要修掉。
- 2026-10-27 · 相机阻塞修复 · A · `0c69388` · 单关键点带 look 的相机在 t=0..end 都保持目标方向；无 look 的静止相机回退到 -Z；新增回归测试，`tests/camera.test.mjs` 27/27。
- 2026-10-27 · 第 3 步 · A · `5ca0f6b` · `/api/projects/create` 调 `ensureSpace`，新建项目直接有空世界+默认相机；Electron 实测相机行/编辑网格/3D 立方体可见，默认相机 look 不塌缩。
- 2026-10-27 · 第 4 步 · B · `a291ad4` `c624c68` `cb49c9d`（已快进合入 master）· 2D 元素进世界：`transform.z`（米）进入两边求值；预览在 Scene3D 内用相机矩阵画 2D 图层（深度测试、不写深度、远到近）；Blender 用 2D 构建器嵌入 3D 场景、挂 `VDM_Screen` 支架（每层 0.1 mm），空世界像素滤镜 0.8；默认相机关闭运动模糊 / 抖动 / 自动侧倾。验收：miku-swiss 对旧 2D 路径 Blender 5 个时刻平均差 0.006–0.014/255、差值 > 8 的像素 ≤ 0.04%；视差测试（z=0 与 z=4 m 两块、相机平移 3 m）Blender 与预览都与针孔投影误差 < 0.6 px；带城市的 nightcity 逐像素不变。**与 §4 的偏差**：第一阶段复用 Python `eval_element`（2D 构建器）而不是 JS 烘焙，方案乙时再换。**限制**：多相机（VSE）路径仍是贴屏叠加；预览 2D 点选仍按画面坐标（相机移动后不准，归第 5 步）。
- 2026-10-27 · 第 5 步（B 部分）· B · `7054ee8` · 属性面板 2D 元素「纵深 z (m)」字段，可改基础值 / 打 `transform.z` 关键帧；Electron 实测改值落盘。
- 2026-10-27 · 第 5 步（A 部分）· A · `cdf04c5` `6811df4` · 时间轴 2D 行可展开：X/Y（项目 px）、纵深 z（m，步长 0.05）、缩放、旋转、不透明度，各有 ◆ 和关键帧菱形；基础值走 `updateElement`，已有键的轴走 `keySet`。预览点选用 `scene3d.lastVP` 把四角投到画布做点在多边形内判断，选中框同一套投影；视口拖拽把射线投到元素 z 平面，再按 100 px/m 换回像素，已打键的轴写键、未打键的轴改基础值，Esc 回滚。验收：Electron 实测 z 改 1.25 后打帧，`transform.z` 键值 1.25；z=4 的横线拖拽落盘 x=134.74 / y=-282.63；已给 x 打键后拖拽，x 新增键 89.82、base x 保持 0，未打键的 y 改 base；`check:preview` PASS，全部单测 PASS。
- 2026-10-27 · 第 6 步（B 部分）· B · `2375a14` `1cd7347` `0fcb5be`（已快进合入 master）· 元素以相机为父（贴屏）：`elementParent` / `elementUnparent`；`elementCarrier` 用与渲染器相同的相机基，预览乘 `u_carry`、Blender 用烘焙的 `elementCarriers` 驱动 `VDM_Carry`；属性面板「贴屏」开关。验收：相机平移 3 m 时贴屏方块在 Blender 与预览都保持 x=559.5/559.6 px，较近元素的遮挡正确；miku-swiss 与 nightcity 逐像素不变；单测 `tests/element-parent.test.mjs` 4 条（含平移+转向+roll 下画面坐标不变）。
- 2026-10-27 · 第 4 步更正 · B · `e6bbb90` · 预览里世界图层原按到元素中心的距离排序，全屏底色块被排到最后盖住同平面所有元素（miku-swiss 预览一片底色）。改为按视线深度（clip w）排序，同平面保持图层顺序。补做预览 golden：与第 2 步路径在 1 / 4.5 / 11 / 14.3 s 逐像素一致（max 2/255）。第 4 步当时只做了 Blender golden，漏了预览。
- 2026-10-27 · 第 4 步再更正 · B · `3f59f7b` · 视线深度排序在斜视角下仍会打乱同一平面的图层（编辑视口从左上看时「犠牲」被底板盖住）。改为按相机到元素所在平面的距离排序（同平面同键，保持图层顺序），绘制与点选（A 的 hitTest，df264b1）共用 `_planeDist`。正视逐像素不变；Blender 本来正确。**请 A 知悉**：hitTest 的排序键被我改成了 `_planeDist`。
- 2026-10-27 · miku-swiss 完整版（B）· 渲染修复 `9d98936`（贴屏元素渲染时拉到相机前 1 m，特写下不再被画面平面/底板挡住）`9b81fb9`（Blender 2D 文字按预览语义排版：左/右对齐以文字框居中、竖直按字形中心、字号按 em）。**请 A 知悉**：贴屏绑定数据新增 `bind.depth`，`elementCarrier(project, el, t, {rigid})` 渲染时带缩放，点选/拖拽贴屏元素请用 `{ rigid: true }` 的刚体部分或直接用渲染矩阵投影。
- 2026-10-27 · 相机片段（B 部分，按 B-007 / A-004）· B · `29a280d` `3581933`（已合入 master）· `elementParent` 支持 `parent: '@live'`（跟随当前镜头，切镜头后画面位置不变）；预览 `_cameraLayers(t)` 把 t 传给 `cameraLayers(project, solo, t)`；`engine/shot.js::isCutSequence`：相机都带显式 start/duration、互不重叠、画面变换默认时，按 `evalCamera` 的当前镜头逐帧烘成一条相机轨，Blender 走单相机路径（切点逐帧准确、视差/贴屏/后期保留），否则仍走 VSE 叠加。**等 A**：`cameraLayers(…, t)` 与 `evalCamera` 当前镜头规则、`splitElement` 相机分支提交后，我做联调并把 miku-swiss 拆成 7 段。
- 2026-10-27 · 相机片段（A 部分，按 B-007 / A-004）· A · `0b20d18`（本地 master）· `core/camera.js`：`cameraRange` / `cameraCovers` / `cameraLayers(project, solo, t)` / `cameraAtTime`；`evalCamera` 的当前镜头规则（active 覆盖 → 栈顶覆盖 → 回退 active），所以 `@live` 与切点连续。`core/ops.js`：`splitElement` 相机分支（左半保 id，右半新 id + 名称 `· 2`，`start=at`，插到 `cameraOrder` 源相机下方并 active；path/tracks 不插新键；cubic 路径额外保留两侧第二个键以保住切线），`moveElement` 相机分支（平移带 path/tracks，裁边保留绝对时间），`syncDuration` 只计显式 `duration` 的相机。时间轴相机行变成 `start/duration` 片段块：拖块/拖边、S / Ctrl+D / 右键切分，非 active 相机拖动把 activate+move 合成一个 batch。验收：`tests/camera-clip.test.mjs` 6 条；Electron 以 0.5s/2.5s 切镜头截图确认左/右机位画面与时间轴块一致；S、Ctrl+D、拖边、右键菜单实测落盘；`npm test` 188/188，`npm run check:preview` PASS。**等 B**：用这份实现联调 `_drawCameraStack` / miku-swiss 7 段。
- 2026-10-27 · 贴屏元素拖拽 · A · `de52036`（本地 master）· 点选已经用 `L.carry` 的投影四边形；拖拽原来仍把指针投到世界 `z` 平面，贴屏元素被相机拉近后会跳。现在用 `elementCarrier` 的渲染 carry 矩阵（含 `SCREEN_LOCK_DEPTH` 拉近缩放）构造元素平面，射线命中后把世界位移乘逆矩阵回元素本地 px；自由元素 carry 为单位矩阵，行为不变。验收：Electron 贴屏方块在相机平移 2 m 后从画布 (623,265) 拖到 (723,265)，包围盒中心位移 99.998 px、本地 `transform.x` 200→378.47 落盘；`npm test` 188/188。
- 2026-10-27 · 文字原位编辑 · A · `60a152a`（本地 master）· 双击画面上的 2D 文字、时间轴 2D 文字块/3D 文字行进入舞台内原位输入：不再弹浮窗。2D 用 `preview._layerCorners` 的投影四角，3D 用对象平面 `_planeSizes` + basis 投影；透明 textarea 通过 `matrix3d` 单应变换贴到文字四角，canvas 继续渲染真实排版，输入时只改内存 `style.text` 并即时 `preview.render`，光标/选区在文字上。`Ctrl+Enter` 或点空白处一次 `updateElement`/`objectPatch` 提交，`Esc` 还原；3D 文字同步支持。验收：Electron 实测 2D 画面双击、时间轴双击、3D 文字行双击、旋转 22° 文字、点空白保存、Esc 取消、实时换行；浮窗已删除；`npm test` 188/188，`npm run check:preview` PASS。
- 2026-10-27 · 文字框收紧 + 时间轴高度固定 · A · `b36ef55`（本地 master）· 选中框和原位输入层从整张文字纹理收窄到实际字块（`preview._textContentRect`，去掉光栅留白；2D 投影四角仍用 `matrix3d`）；双击进入编辑时不再全选（光标落在末尾），不再出现远离文字的淡蓝色覆盖。属性展开不再设置 `#app.tl-expanded` / 不再把时间轴从 252px 抬到 400px，超出行在时间轴内部滚动。验收：Electron 文字选中框 398–624px 收窄到 415–607px、原文可直接续写、`#app` 无 `tl-expanded`；`npm test` 192/192，`npm run check:preview` PASS。
- 2026-10-27 · 声音元素 · A · `b36ef55` `e09d6c9` `89ec8b1`（本地 master）· 声音成为真正的 `type:"audio"` 时间线元素：`start/duration/srcIn/volume` + `audio.volume` 关键帧；旧 `meta.audio` 在 `loadProject` 时迁移为一条 `fromSoundtrack` 元素并写 `meta.audioMigrated`。时间轴新增独立 **声音** 区（固定在标尺下方、相机表头之上，8 机位项目也能一眼看到），块可拖/裁/切，展开是音量行和菱形；媒体面板点击音频加入时间线（右键仍可设配乐）。预览为每段声音建一个 `HTMLAudioElement`，每帧按 `audioVolume` 推音量；成片 `engine/audio-mix.js` 用 ffmpeg `amix` 把各段按 `adelay` 对齐、按线性音量表达式 `volume` 逐帧应用、`apad` 到区间长，再交给现有 encoder。验收：`tests/audio.test.mjs` 4 条（迁移、音量线性、切分/裁剪 `srcIn`、渲染表达式）；Node `loadProject` 从 miku-swiss 的 `meta.audio` 迁移出 `shoushitsu-226-241.m4a` 声音元素，Electron `_audioedit` 实测切分后两段 `srcIn` 0.5/1.5、音量键 0.2 在预览生效；生成 WAV 混音时长 4.000s，早段约 -48dB、末段约 -21dB（音量包络生效）；`npm test` 192/192，`check:preview` PASS。
