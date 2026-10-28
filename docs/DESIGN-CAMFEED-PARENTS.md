# 相机投屏 + 父子收敛（设计 · 用户已批准）

> 2026-10-28 · 作者：B（MV/预设 agent）· 读者：A 与项目负责人
>
> 用户拍板（原话）：
> - "贴屏要ban了，因为相机投屏出的2d元素可以替代它的功能"
> - "右键相机，可以创建一个2D元素，这个元素实时显示相机拍到的画面，默认相机不能拍到自己拍到的画面的2D元素，
>   但是可以通过特殊设置，将相机拍到的画面所呈现的2D元素，使用上一帧相机拍的画面，防止产生递归"
> - "以后父子级只有两种类型"：**空间父级**（整体跟着动）+ **属性父级**（属性链接）。

## 1. 相机投屏元素 `camfeed`

新的 2D 元素类型，和图片元素一样是一块平面，内容是某台相机的实时画面。

```jsonc
{ "id": "el_12", "type": "camfeed", "start": 0, "duration": 8,
  "feed": { "camera": "cam_3",   // 画面来源相机（必填）
            "delay": 0 },       // 0 = 当前帧（默认）；1 = 上一帧
  "style": { "fit": "stretch" },  // 同图片：stretch | cover | contain；平面大小 = 项目画幅
  "transform": { ... } }       // 和其它 2D 元素完全相同（位置/缩放/旋转/纵深/关键帧/空间父级）
```

- 显示的是**来源相机的原始画面**（不含全局后期）。全局后期（辉光、颗粒、调色……）只在最终输出上做一次，不会重复叠加。
- 平面是自发光的，不受场景灯光影响。

### 1.1 谁能拍到谁（防递归）

- **`delay: 0`（当前帧）**：来源相机**拍不到**这个元素。
  若两台相机互相拍对方的当前帧投屏（A 拍 B 的投屏、B 拍 A 的投屏），按 `cameraOrder` 断环：
  靠下的相机先渲，看不到靠上相机的当前帧投屏。
  一般规则：先按"当前帧投屏"建依赖图，从下往上渲染；会成环的那条边上的投屏，对环上的相机隐藏。
- **`delay: 1`（上一帧）**：任何相机都能拍到，包括来源相机自己，显示的是来源相机**上一帧**的画面（第一帧为黑）。
  这样可以做"无限隧道"之类的反馈效果，而不会递归。
- 编辑器的自由视角（编辑模式）不是来源相机，能看到所有投屏。

### 1.2 只供投屏的相机：`output: false`

相机新增字段 `output`（默认 `true`）。`output: false` 的相机**不直接出画**：不进最终画面的相机栈和切镜头，只给投屏当来源。
时间轴上仍然显示、可以编辑；相机行上标"仅投屏"。

### 1.3 预览与成片

| | 预览（WebGL） | 成片（Blender） |
|---|---|---|
| 当前帧投屏 | 每帧先按依赖顺序把来源相机渲到各自的离屏纹理，再画主画面 | 渲染前先给每个来源相机单独渲一遍图片序列（去掉全局后期），主渲染把投屏当图片序列平面 |
| 上一帧投屏 | 用来源相机上一次渲出的纹理（暂停拖动时是"上一次画的那帧"，播放时就是上一帧，注明为近似） | 逐帧顺序渲染，投屏读刚写出的上一帧文件；单帧预览图（still）里上一帧投屏为黑 |
| 代价 | 每个来源相机多一次场景绘制 | 每个来源相机多一遍渲染时间 |

## 2. 贴屏退役（`elementParent` / `@live`）

贴屏 = 元素钉在画面上不随镜头动。用投屏实现同样效果的结构（**HUD 机位**）：

```
HUD 空元素（远离场景，比如 x = 10 km）
 ├─ HUD 相机（静止、默认取景、output: true、相机栈最上层、覆盖全片）
 ├─ 投屏元素 × N（每个原镜头片段一个，铺满画面，在最底层，来源 = 该镜头，时间 = 该镜头片段）
 └─ 原来的贴屏元素（字幕、HUD），位置不变
原来的所有镜头相机 → output: false
```

- 因为 HUD 相机静止，拍到的字幕永远在画面同一位置，镜头切换时投屏跟着切 —— 等价于原来的 `@live`。
- 所有挂法都用**空间父级**（HUD 元素、投屏、HUD 相机都是 HUD 空元素的子级），以后可以整体移动。
- **迁移**：打开带贴屏元素的旧项目时，自动换成上面的结构（内存升级，和现有迁移一样；保存时写盘前提示）。
  `scripts/migrate-camfeed.mjs` 也能显式迁移副本做对拍。真实 miku-swiss 迁移前单独备份，并逐帧对拍成片。
- **删除**：`elementParent` / `elementUnparent` op（保留为"拒绝 + 提示改用投屏"一个版本）、`@live`、`elementCarrier`、
  预览的 `u_carry`、Blender 的 `VDM_Carry` / `elementCarriers`、`SCREEN_LOCK_DEPTH`、属性面板"贴屏"开关、相关测试与文档。

## 3. 父子只剩两种

| 保留 | 说明 |
|---|---|
| **空间父级** | `el.parent` / `ob.frameParent` / `cam.frameParent`，`mode: "world"`。**新增** `strength: { rot, scale }`（0–1，可打关键帧，键在 `tracks['parent.rot']` / `tracks['parent.scale']`），补上旧 3D 父子独有的功能 |
| **属性父级** | `links`（不变） |

| 退役 | 迁移 |
|---|---|
| 旧 3D 层级父子 `obj.parent`（W1） | 打开时转成 `obj.frameParent`（inherit、strength、绑定时刻的世界姿态保持不变），`objectParent*` op 退役 |
| 贴屏 `el.parent.kind: 'camera'` / `@live` | 见 §2 |

## 4. 顺带补齐（父子"只在显示层生效"的缺口）

- Blender 2D 构建器消费 2D 元素的空间父级（HUD 机位依赖它）。
- 属性链接进入所有求值入口：预览 3D 物体、相机、Blender 2D、shot 烘焙。界面显示的有效值 = 画面用的值。
  （A 先做完并合入 master：`67b5c7e`，`core/link-eval.js`；B 只补了 Blender 2D 的世界矩阵烘焙。）

## 5. 顺序

1. 投屏核心（数据、op、依赖与断环规则、单测）
2. 投屏预览
3. 投屏成片（Blender）
4. Blender 2D 空间父级 + 属性链接进入渲染
5. 贴屏退役 + 迁移（依赖 1–4）
6. 旧 3D 父子并入空间父级（strength）

## 6. 分工

- **B**：上面 1–6 的数据、求值、预览、成片、迁移、属性面板（`inspector.js`）。
- **A**：右键相机"创建投屏元素"菜单、时间轴相机行"仅投屏"标记与开关、时间轴里贴屏相关入口的删除、空间父级 strength 的时间轴行。
- 共享文件登记：`app/renderer/js/preview.js`（B 改投屏绘制和去掉 carry）、`core/spatial-parent.js`（B 加 strength）、
  `core/schema.js` / `core/contracts.js`（追加 `camfeed`、`output`）、`engine/shot.js`、`engine/blender.js`、`blender/vdm_build.py`。

## 7. 进度登记（B）

- 2026-10-28 · 分支 `agent/camfeed`（基于 master `6c2ec5f`），未合入 master。- `98d4e64` 投屏核心：`core/camfeed.js`（`el.feed`、`cam.output`、`feedPlan` 断环、`programProject` / `sourceProject`），9 条单测。
- `7734c41` 预览投屏：每个来源相机一对离屏纹理（当前帧 / 上一帧），按依赖顺序先渲；`scripts/check-camfeed.mjs` 像素检查。
- `127b02d` **修复（master 上就有的问题）**：Blender 3D 路线里 2D 平面（混合材质）不写 Mist，合成器的雾把所有 2D 元素涂成纯雾色——空世界项目的成片整片一个颜色。2D 平面改到单独的视图层（3D 世界作 holdout），雾只作用于 3D。
- `498a726` 成片投屏：来源相机先单独渲（去全局后期，缓存在 `.vdm/cache/feeds`），投屏平面逐帧读 `f_<帧-delay>.png`；`check-camfeed --blender` 6/6 PASS。
- `64aac91` Blender 2D 世界矩阵烘焙：带 `el.node` 或空间父级的 2D 元素逐帧烘焙平面矩阵（与预览同一个 `nodePlaneMatrix`）；`scripts/check-render-parity.mjs` 预览 vs Blender 0/144 格不同。
- `e83808d` 父子只剩一种：空间父级加 `strength` / `strengthKeys`；打开项目时 `obj.parent` 迁移成 `obj.frameParent`（单测：迁移前后姿态差 < 1e-5）；`objectParent*` 保留名字但写空间父级；新 op `spatialParentKey` / `spatialParentUnkey`。**行为变化**：解除父级保留子级自己的数值（空间父级规则），不再烘焙世界位置。
- `4c0fdf9` 贴屏退役：打开项目时把贴屏元素迁到 HUD 机位（`core/screen-lock-migrate.js`）；`elementParent` / `elementUnparent` 拒绝并提示用投屏。miku-swiss 副本对拍：预览 48×27 网格最大差 7/255；Blender 场景对齐到 0.02 px，字幕偏差 ≤ 0.5 px（960 宽），PSNR 31–36 dB。

### A 侧进度（2026-10-28）

- `35b523a` 把 B 的 `agent/camfeed`（9 个提交，基于属性链接 master）合入 master；
  B 的 420 条单测、`check:preview` / `check:evaluate` / `blender:check` /
  `check-render-parity` / `check-camfeed` 均 PASS。
- 右键相机「创建投屏元素」：按相机片段范围建 `type:"camfeed"` 元素（默认 delay 0、置顶），并选中它。
- 时间轴相机行：`output:false` 显示「仅投屏」标记，点击恢复出画；相机菜单和相机属性面板都能切 `output`。
- camfeed 属性面板补「来源相机 / 延迟一帧」，修改写 `updateElement {feed}`。
- 2D 元素的屏幕锁 carry 从视口拖拽里删除；`elementCarrier` 暂留空桩给测试。
- **未做**：空间父级 `strength` 的时间轴行（读 `parentStrengthAt`，写 `spatialParentKey/Unkey`）。
- 注：`35b523a` 之后，打开旧项目会按 §2 在内存里迁到 HUD 机位；真实 `projects/miku-swiss` 仍是原文件，保存前请先备份。
