# 3D 镜头模型：相机 / 无人机穿城

> 一份镜头 = **世界（world）+ 相机轨道（camera）+ 时间轴上的其它元素**。
> 这是 3D 编辑器的核心：你在时间轴上编辑的不是"图层"，而是**摄影机在空间里的运动**。

## 为什么是参数化城市

隔壁项目的「夜之城资产」实际只有游戏本体 + WolvenKit + Blender 插件，**没有任何已导出的
街区模型**。走 WolvenKit 从 `.archive` 里导出一个 district 是独立的大工程（GB 级、上千个
mesh、还要处理 shader 转换），不适合作为这一步的基础。

因此 v0.2 的世界是**程序化生成**的：一个 `seed` + 一小组参数就能长出一座城，JS（实时预览）
与 Blender（成片）消费**同一份烘焙出的几何**（`.vdm/cache/shot-*.json`），保证你看到的就是
你渲的。真街区以后通过 `world.source = "blend"` 接进来，相机/参数模型不变。

## 一、相机（camera）

| 参数 | 范围 | 说明 |
| --- | --- | --- |
| `path[]` | 关键点 | `{ t, pos:[x,y,z], out?, in?, ease?, speed? }`，米制世界坐标；**三次贝塞尔**穿过每个点。`out`/`in` 是相对 `pos` 的手柄，省略时自动取 Catmull-Rom 切线（旧数据因而完全等价）。视口里可直接拖节点、拉手柄，双击手柄回到自动。`speed` 是段级 `[u,v]` 速度曲线（数据字段；时间轴只把关键点显示为位置帧，不单独列表） |
| `fov` | 1–360° | 水平视场角；逐关键点可覆盖（变焦 / dolly zoom）。≥180° 时透视投影退化，自动切**等距鱼眼**：预览用立方体贴图 + 鱼眼合成，Blender 用 Cycles 的 `FISHEYE_EQUIDISTANT`（EEVEE 不支持全景相机） |
| `lookAhead` | 0–500 m | 自动看向前方多远；0 表示用显式 `look` 点 |
| `look` | 可选 | 关键点里的显式目标点（拍楼、拍霓虹招牌时用） |
| `bankGain` | 0–4 | 转弯自动侧倾的增益（无人机/战斗机手感） |
| `maxRoll` | 0–60° | 侧倾上限 |
| `roll` | -60–60° | 手动荷兰角 |
| `shake.amp` | 0–5 m | 抖动幅度 |
| `shake.freq` | 0.1–8 Hz | 抖动频率 |
| `shake.octaves` | 1–4 | 噪声层数（越多越"手持"） |
| `shake.speedGain` | 0–2 | 速度越快抖得越狠 |
| `shake.seed` | 整数 | 可复现的抖动 |
| `dof.enabled` / `fstop` / `focusOffset` | — | 景深：对焦点=看向点，光圈越小越虚 |
| `motionBlur.enabled` / `shutter` | 0–1 | 运动模糊（快门角 = 0.5 即 180°） |
| `near` / `far` | — | 裁剪面 |

**相机属性折叠在时间轴相机行里**：默认收起，点行首 `▾` 展开。`变换` 默认展开，包含
`中心点`（世界坐标）、`位置`（相对中心点的 path）、`画面中心`、`画面位置`、`透明度`、`缩放`
六行；每行 X/Y/Z（画面 2D 为 X/Y）跟随播放头，右轨道菱形就是该属性的关键帧。改数值时该
通道已有键就在播放头写/改键，没有键就改基础值；行末 `◆` 在当前时间打帧 / 删帧。`镜头 / 构图`、`抖动`、
`景深 / 模糊` 三个组默认收起，标题右侧直接显示摘要（FOV、抖动、光圈/快门），点标题展开。
右侧检查器只保留世界参数和渲染按钮。FOV ≥ 180° 时自动切等距鱼眼，预览用鱼眼合成；
Blender 侧这一档用 **Cycles** 渲 `FISHEYE_EQUIDISTANT`（EEVEE 不支持全景相机）。

中心点是世界点，位置是相对中心点的 path；相机世界位置 = `center(t) + path(t)`。
画面 2D 变换用归一化坐标（0.5 是画面中心）：缩放绕 `画面中心`，再平移到 `画面位置`，
最后用 `透明度` 做 alpha-over。画布变换不改变相机世界位置。

多相机预览：`cameraOrder` 从上到下，预览从最下层开始渲染到 `layerFBO`，逐层 alpha-over
到 `sceneFBO`；每层先做上面的 2D 画面变换。eye 关掉的相机不进堆栈；右键“单独查看”只
限制预览（`preview.soloCameras`），不写项目、不影响成片。编辑视口仍用编辑相机单层，
退出编辑后的预览帧才显示完整相机堆栈；Blender 多相机合成属于 P5。

轨道求值顺序（`core/camera.js`，Blender 用**同一份烘焙结果**）：

```
path 关键点 → Catmull-Rom 位置
          → 切线 → look = pos + normalize(tangent)·lookAhead（或显式 look）
          → 曲率 → roll = clamp(-yawRate·bankGain, ±maxRoll) + 手动 roll
          → shake：3D value noise × (amp + 速度项)，叠加到 pos 与 look
          → fov：默认值 / 关键点覆盖
```

## 二、世界（world）

| 参数 | 说明 |
| --- | --- |
| `seed` | 换一座城（同 seed 完全一致） |
| `grid.nx / nz` | 街区行列数（城市规模） |
| `grid.block` / `grid.street` | 街区边长 / 街道宽度（米）——决定"峡谷感" |
| `density` | 有楼的街区比例（空地=广场/缺口） |
| `height.min / max / power` | 楼高分布；`power` 越大越容易出现少数摩天楼 |
| `palette[]` | 楼体基色（冷灰蓝/水泥） |
| `window.density / glow / color` | 窗格密度、亮度、色温 |
| `neon.count / glow / colors[]` | 霓虹条数量、强度、色板（粉/青/黄） |
| `fog.color / start / depth / strength` | 雾色、起雾距离、多远到满、整体强度（预览与 Blender 的 Mist 用同一套：`(dist-start)/depth × strength`） |
| `ground.color / wet` | 地面颜色与反光强度 |
| `sky` / `ambient` | 天空色与环境光 |
| `corridor.enabled` / `corridor.radius` | 航线避让（默认开、16m）：镜头航线半径内、楼顶高于机位 8m 以内的楼会被清掉，换 `seed` 不会把塔吊在航线上；只删受影响的楼，其余几何与 RNG 序列不变 |

## 三、镜头在时间轴上的其它部分

- 元素（文字/图/色块）仍然可以叠在 3D 之上（v0.2 先支持纯 3D）；
- 全局后期（bloom / CA / grain / vignette / scanline / grade）对 3D 同样生效；
- `still` / `render` 命令不变：同一个项目既能出 2D 图层，也能出 3D 镜头。

## 四、这个镜头怎么调（导演向）

1. **先定世界**：`seed` 找到有"峡谷"的街区，`grid.block` 大、`street` 窄 → 楼更挤；
2. **再定轨道**：起点高（y≈120）、俯冲穿过街道（y≈25）、转弯时 `bankGain` 给到 1.5；
3. **速度就是节奏**：关键点的时间间隔决定速度，转弯前留长一点（减速），出弯后压缩（加速）；
4. **抖动别过头**：`amp≈0.5`、`freq≈1.5`，`speedGain≈1`，高速段自动更抖；
5. **雾是纵深**：`fog.density` 0.002–0.004 之间，远处楼只剩霓虹轮廓；
6. **运动模糊**：快门 0.5（180°），高速段开始有速度感，太高会糊。

## 五、下一步（未做）

- 路径关键点在预览里可视化编辑（贝塞尔手柄、曲线视图）；
- `look` 目标点吸附到楼体/霓虹；
- 真街区：`world.source="blend"` 导入 WolvenKit 导出的 district；
- 车流/飞行车光带、体积雾、雨、镜头光晕。
