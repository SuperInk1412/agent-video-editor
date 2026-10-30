# 第二批验收 · FAIL / BLOCKED 修复任务

> 来源：`docs/ACCEPTANCE-V2-BATCH2.md` 的三线独立验收（V1 渲染 / V2 引擎 / V3 界面），
> 被测 master **`81db87a`**，汇总见 `docs/DESIGN-BACKEND-V2.md` §16.1。
> 验收人未参与实现，数字均为独立重跑；修复人请同样换人。
> 全文报告在本机 `.scratch/accept/results-v1.md` / `results-v2.md` / `results-v3.md`（逐项含复现命令）。
>
> **派发规则**：每条一个修复子代理、一次提交一件事；不许顺手改别的项。
> 修复合入后**只重跑该项 + §13**，结果补记到 §16.1。回归项 §13 = `npm test`、`check-render-parity`、
> `check:preview`、`bench-ir`、`blender:check`、`camfeed --blender`、`check:v3-reader`、`gen-contracts --check`、
> `check-timeline-range`、`no-python-eval`。Blender 一次只跑一个。
>
> **现 master 状态（派修前必读）**：本清单的实测都针对 `81db87a`；验收结束后 master 已推进到 **`9ddf4e9`**
> （新合入 WP3.6b、4.3、4.4、4.6a、5.2、5.3）。**派修前先在现 master 上复测本项**：
> 已知 **F14/12.5 很可能已被 WP3.6b 的 `app/renderer/js/source-view.js` 修掉**（先跑 `node scripts/check-source-view.mjs`）；
> F3/6.6 的渲染器快照接缝已有（`source-badge.js` / `__vdm.setSourceSnapshots`），但 `preview.js` / `engine/shot.js`
> 的 `buildFrameIR` 仍未传，需实测。其余项在现 master 上未见对应改动。已被后续包覆盖的，记"已被覆盖"并关闭，不重复派工。

## 汇总

| 编号 | 验收项 | 一句话 | 优先级 |
|---|---|---|---|
| F1 | 3.2 | 成片画面效果与迁移前不等价（10/10 帧超 2%，vignette 43%） | P0 |
| F2 | 3.6 | 没有 Electron 时静默丢掉全部画面效果，无任何警告 | P0 |
| F3 | 6.6 | 运行路径不传 `sourceSnapshots`，编译出的网页元素不可见、动画全丢 | P0 |
| F4 | 5.5 | 代码图层编译失败仍出片，成片缺图层且错误不含源 id | P0 |
| F5 | 6.3 | 应用编译源后一次撤销回不到原状态（撤销变空转） | P0 |
| F6 | 4.5 | 同一元素同时有源与属性链接时，链接先于源合并（与冻结顺序相反） | P0 |
| F7 | 2.7 | 报告不标"AI 声称改了但实际没改" | P1 |
| F8 | 9.2 | 预览中编辑不自动退出，反而禁用检查器 | P1 |
| F9 | 9.5 | 一个 `moveElement` 显示成 3 行 3 个复选框 | P1 |
| F10 | 9.8 | 锁定元素没有说明行、没有"临时解锁并采纳" | P1 |
| F11 | 10.6 | 没有"知道了"按钮，已采纳标记无法清除 | P1 |
| F12 | 11.3 | 报告放不了变更集附件（其余 5 类可以） | P2 |
| F13 | 11.6 | 命令面板没有"报告编辑器问题"入口 | P2 |
| F14 | 12.5 | "查看源码"只是占位 toast，没有只读源码窗口 | P2 |
| B1 | 5.4 | 预览侧测不出代码图层：live 栅格没有"就绪"信号（导出侧已 PASS） | P1 |
| B2 | 12.4 | 代码图层关键帧→像素的测量口径不可用（`layerRects` 返回整幅） | P1 |

观察项（不是 FAIL，但建议顺手处理）：O1–O5 见文末。

---

## F1 · 3.2 画面效果与迁移前不等价

**实测**（基线 `5ab89e2`=`b195be0^` vs `81db87a`；demo/nightcity 副本各 5 帧，1920×1080、16 samples）
- 差异像素（任一通道 >24）占比 10/10 帧超预算 2%：
  demo f0/f144/f288/f432/f575 = **45.90 / 45.75 / 23.99 / 23.94 / 35.69%**；
  nightcity f0/f90/f180/f270/f359 = **73.53 / 53.99 / 71.03 / 62.01 / 99.93%**；最大通道差 193–255。
- 4×4 网格差异集中在左上/右下（demo f0 78.9/34.8/…/53.2），nightcity 末帧 16 格全 98.9–100%。
- 逐效果隔离（demo f0，`meta.fx` 只开一项，两边各渲一帧）：neutral **0.000%**（maxD=1，仅 8→16bit 取整）、
  **vignette 43.205%**、**grade 23.524%**、**ca 10.371%**、**bloom 3.152%**、scanline 0.000%、
  grain 0.000%（但 97.9% 像素有不相关的 ±24 噪声，判读作随机噪声，不计入）。

**期望**：每帧差异像素 ≤2%；开着画面效果的成片观感与迁移前一致（D2 的前提是"效果只实现一次、成片不变"）。

**疑似根因（待修者确认）**：`post.glsl` 与旧 Blender 合成器数值不等价。neutral 为 0 说明取帧/尺寸/位深没问题，
问题在参数映射：暗角形状与强度、grade/contrast/saturation 曲线、CA 偏移、bloom 阈值/半径至少一处不对。

**范围建议**：`app/renderer/shaders/post.glsl`、`core/screen-fx.js`、`engine/render-workers/post.js`。
对照 `git show 5ab89e2:blender/vdm_build.py`（旧 `build_compositor`）和当时的 `app/renderer/shaders/preview.glsl`。

**验收**：3.2 每帧 ≤2%（10 帧全列数字）；3.1 用例 J 仍 ≤2%（当前 0.88%）；3.7 中性不进渲染池；§13 G2/G5。

**注意**：不要回退 WP3.5（效果留在浏览器是 D2 的决定），修映射关系。

---

## F2 · 3.6 无 Electron 时静默丢效果

**实测**（用 `NODE_OPTIONS=--require=.scratch/accept/no-electron.cjs` 让 `findElectron()` 真返回 null，全新副本）
- CLI 退出码 **0**，stdout 只有 `✓ …/x.png`，stderr 只有 `渲染任务 job-… · rev 5`；`--json` 的 artifact **无 warnings 字段**。
- `.vdm/jobs/<id>/job.json` 键里**没有 warnings、也没有 log**；`GET /api/jobs` 两条任务都 `succeeded`、同样无 warnings。
- 出图内容与该工程的"中性 fx Blender 原始帧"**逐像素相同**（>24 差 0%），与正常带效果出图差 **44.13%**（maxD 228）。
  即：用户拿到一张没有画面效果的静帧，退出码 0、没有任何提示。

**期望**：任务结果 JSON、`GET /api/jobs`、CLI 输出里至少一处有用户可见 warning，例如
`warnings: ["画面效果未应用：没有 Electron"]`；人读输出也打印一行。退出码可保持 0，但静默不行。

**范围建议**：`engine/blender.js`（`runPost` / `applyScreenFx` / `renderStill` / `renderVideo` 返回 warnings）、
`engine/jobs.js`（任务记录带 runtime warnings）、`engine/routes/jobs.js`（`/api/jobs`、`/api/still`）、`cli/vdm.js`（打印）。

**验收**：3.6；3.7（中性效果不应报警）；§13 G6。

---

## F3 · 6.6 运行路径不传源快照（编译元素不可见）

**实测**：`buildFrameIR` 的四个真实调用点都没有 `opts.sourceSnapshots`：
`app/renderer/js/preview.js:906`、`engine/shot.js:395`、`application/inspect-service.js:137`、`application/report-service.js:37`
（全仓库该参数只出现在 `core/frame-ir.js`、`core/source-eval.js` 和 tests）。
用 `html-title-card` 实测：真实路径 5 个时间点误差 **35.52 / 46.16 / 46.44 / 46.44 / 46.44 px**（预算 0.5 px）；
n_title 的 opacity 退化为 0 被 `opacity<=0.002` 剔除 → **整块不可见**。
带 snapshot 时同一夹具对拍用例 L 的位置误差 worst **0.113 px**、整帧 0.65% —— 编译本身是对的，丢的是运行路径没接快照。

**期望**：预览、Blender 导出、inspect、report 都从 `.vdm/sources/<id>/base.json` 读快照并传给 `buildFrameIR`；
`html-title-card` 在真实预览/成片里可见且动画正确，6.6 五个时间点 ≤0.5 px。

**范围建议**：`preview.js`（经 `GET /api/sources/<id>/base` 取并缓存，按 hash 失效）、`engine/shot.js`（job 前读 base）、
`inspect-service.js`、`report-service.js`；`core/frame-ir.js` 的 IRCache 键已含 snapshot hash，不用改。

**验收**：6.6 五点 ≤0.5 px；6.1 用例 L 仍 PASS；4.1 无源工程 0 差异；§13 G2/G5；另做一次人工预览确认元素可见。

**注意**：不要每帧去读文件；按源 id + hash 缓存，revision/compile 后失效。

---

## F4 · 5.5 代码图层编译失败不阻断

**实测**：把 `glsl-noise` 改成编译不过的着色器再导出 → **导出成功**、成片缺该图层：
该图层区域非黑像素只剩 **15877 / 172800（9.2%）**（正常 172800 / 100%）；错误只出现在内部一行日志里，
且只含元素 id（`el_2`），**不含源 id**。

**期望**：导出失败，错误信息含源 id（并可定位到元素/帧），**不能**产出缺图层的成片。
（方案原文："导出失败并给出清楚的错误（含源 id），不能输出缺图层的成片"。）

**范围建议**：`engine/raster-bake.js`（当前"单帧失败退上一好帧/省略"的策略）、`engine/blender.js`、
`engine/render-workers/pool.js`（错误码/错误体透传）。

**验收**：5.5；5.2/5.3 的缓存命中不受影响；§13 G6。

---

## F5 · 6.3 应用编译源后撤销不是一步

**实测**（miku 副本 rev 309）：`POST /api/sources/html-title-card/apply` 200 → rev 309→310、元素 138→173；
随后一次 `POST /api/undo` → 200 `didChange=true`、rev 311，但内容 hash **仍是应用后的** `eb965d1a…`、元素仍 173；
再撤销一次同样无变化（rev 312）。事务日志在 undo 前出现 `command:"external"`（beforeRev 310 / rev 310），
把"已应用"状态压进 undo 栈。对照：同工程 `addElement` / `updateElement` 后一次 undo 都正常。

**疑似根因（待修者确认）**：`sourceApply` 插入的 35 个元素只带 2D transform；下一次 `load()` 的空间迁移
给它们补 `node`/`legacy` 并改写 `meta.ui.migration`，与 `state.head` 不一致，仓库按外部写入处理。

**期望**：apply 后 rev +1；**一次**撤销回到 apply 前的 hash 与元素数；redo 可用。

**范围建议**：`application/source-service.js`（`elementPayloadFor` / `applyCompiled` / `expandSourceOps` 产出的元素应是
"空间迁移后"的稳定形态）、`application/project-service.js` / `engine/project-repository.js`（head 与迁移的关系）。

**验收**：6.3（hash 逐字节相等）；6.5 重复 apply 不重复建元素；普通 ops 的撤销测试不回归；§13 G1。

---

## F6 · 4.5 求值顺序：链接先于源合并

**实测**（`n_rule`：源 scale mul，base `0.62`、src `0.9764131873`；编辑器层 `scale=1`；再挂 `scale.x` add 链接，宿主值 2、bind 1）：
- 冻结顺序（§7.3 / §7.8.2："源 → 编辑器层 → 链接 → 父子"）应为 `1.5748599796 + 1 = **2.5748599795934384**`；
- 实测 **3.1497199591868763** = `(1+1) × src/base` —— **链接先于源合并**，差 `0.5748599796`（22.3%）。
- 空间父级链本身不碰源合并值（子元素跟随父级 local 位置），与 §7.8.2 第 6 条一致。

**期望**：源合并先于链接；误差 ≤1e-6。

**范围建议**：`core/frame-ir.js`（元素值计算里 propLink 的时点）、`core/source-eval.js` 的调用顺序；
补一条"同一元素同时有源与链接、combine 不可交换"的单测。

**验收**：4.5；4.1 无源工程 1389 帧 0 差异；4.3 三模式不变；§13 G1/G2。

---

## F7 · 2.7 报告不标"说法与差异对不上"

**实测**：脚本 final 写"已改好：把 `s1_w2` 的颜色改成红色，字号也改成 150 了"，实际只改 `style.size`
（color 前后都是 `#111111`）。报告 `mismatch=null`；verification 只有 `s1_w2.style.size：230 → 150`（verified），
**没有颜色一行，也没有"未做/不一致"标记**。当前 mismatch 只在"声称有改动但 0 个变更集应用"时触发。

**期望**：§8.3 —— 把 final 里的声称与变更集 diff 对照；对不上的项标"未做/不一致"（例如"颜色：未做"），
字号一项保留前后数值。

**范围建议**：`engine/agent.js`（final 后的 report 生成/校验）、`application/report-service.js`（judge 展示）。

**验收**：2.7；2.2 的 verified 报告仍然正确；§13 G1。

---

## F8 · 9.2 预览中编辑不自动退出

**实测**：预览打开后检查器 **37/37 字段 disabled**；改值不生效、预览不退出（`previewShadow` 仍在、rev 不变），
只弹 toast「预览中不能编辑，先退出预览」；手动点「退出预览」后同样的改值成功（字号 230→161，rev+1）。

**期望**（§10.2-4 / DESIGN-WP2.5-REVIEW）：**一动手编辑就自动退出预览**，改动落到真实工程上。

**范围建议**：`app/renderer/js/main.js`（`op()` 在预览态先 `exitPreview()` 再执行）、`inspector.js`（不要整体只读）、
`review.js`（横幅状态）。保持 9.1 的"预览期间不写盘"语义（现在成了"禁止写"，要改成"先退出再写"）。

**验收**：9.2；9.1 预览像素仍与"采纳后"相同、预览期间不写盘；9.3 一步撤销不变。

---

## F9 · 9.5 一个 moveElement 显示成 3 行

**实测**：一个 `moveElement`（含 2 个关键帧）在审阅面板显示 **3 行 / 3 个复选框**：
`起点 f0→f24`、`关键帧 3 条（+2s）`、`meta.duration 4→5`（diff 实际 5–6 条 changed：删/改/新增关键帧 + start + meta.duration）。

**期望**：1 行、1 个复选框（同一 op / 同一意图的连带改动必须合在一起，否则用户只采纳"起点"会把元素弄坏）。

**范围建议**：`app/renderer/js/review.js`（分组逻辑：按变更集条目的操作意图/元素分组，而不是按 diff 的 changed 项）。

**验收**：9.5（1 行 1 勾选）；9.3 / 9.6 / 9.9 不回归。

---

## F10 · 9.8 锁定元素没有说明行 / 临时解锁入口

**实测**（真实顺序：先提案、之后才上锁）：面板里**没有说明行、没有「临时解锁并采纳」**，
文本只有「03 锁定标题 1 处 / 字号 200→120 / 采纳 / 不要」；采纳后能写（120、rev+1、仍 `locked:true`、
一次 Ctrl+Z 回 200 且仍锁定）。用户看不出这是一次越权写入。

**期望**：变更集里 AI 想改锁定元素时有说明行；提供「临时解锁并采纳」，采纳后值已改、元素仍锁定、
整个过程一次 Ctrl+Z 可撤回。

**范围建议**：`app/renderer/js/review.js`（LOCKED 行识别与按钮）、`engine/routes/changesets.js`、
`application/changeset-service.js`（预览/应用时带"以人的身份"标记）。

**验收**：9.8；10.1–10.4 的锁定语义（点不中/拖不动/AI 写不进/人仍可改）不变。

---

## F11 · 10.6 没有"知道了"，标记无法清除

**实测**：采纳 3 组后标记保留且变淡（竖条 opacity 0.4、关键帧外圈 `is-ack`、标尺 `ack=true`）✅；
但全代码库 **没有"知道了"按钮**（`grep -rn 知道 app core engine` = 0 处），已采纳标记会一直留着。

**期望**：采纳后标记变淡且保留；点「知道了」后消失（按组/按元素）。

**范围建议**：`app/renderer/js/timeline.js`（标记 ack 状态与按钮）、`core/timeline-marks.js`（accepted 集合的持久/清除）、
`app/renderer/js/review.js`（入口）。

**验收**：10.6；10.5 三种标记类型不回归。

---

## F12 · 11.3 报告放不了变更集附件

**实测**：元素 / 属性 / 关键帧 / 时间范围 / 画面区域 五类都能加并落盘、类型正确；
**变更集附件没有任何入口**：`app.select({pool:{kind:'changeset'}})` + Shift+R 后 kind 仍无 changeset，
`grep -rn "kind: 'changeset'" app/renderer` = 0 处（只有 `core/report-draft.js` 白名单里有）。

**期望**：草稿能放进一个变更集（从审阅面板/变更集列表入口），保存后类型正确。

**范围建议**：`app/renderer/js/report.js`、`review.js`（"加入报告"入口）。

**验收**：11.3（六类齐全）；11.1 不回归。

---

## F13 · 11.6 没有"报告编辑器问题"入口

**实测**：命令面板搜「编辑器」→ `[]`；搜「报告」只有「报告问题…」「报告：框选画面区域」；
没有帧率/日志采集入口，也没有"编辑器问题 / 内容问题"的类型区分。

**期望**：命令面板有独立入口；生成的报告带播放帧率与日志，且与内容问题分开（§10.4-6）。

**范围建议**：`app/renderer/js/main.js`（命令注册）、`report.js`（草稿类型与字段）、
`application/report-service.js`（类型/日志字段）、`engine/log.js`（最近日志读取）。

**验收**：11.6；11.1 不回归。

---

## F14 · 12.5 "查看源码"只是占位

**实测**：检查器「查看源码」按钮在，点后 toast「源码视图即将提供」——打开模态 0 个、含源码的 `pre` 0 个、
`contenteditable` 0 个。验收要求"源码窗口里无法编辑、可以复制"。

**期望**：只读源码窗口（无 contenteditable/无输入框），可选中复制；能看当前源的全部文件。

**范围建议**：`app/renderer/js/inspector-code.js`、`app/renderer/index.html`、`app/renderer/css/inspector.css`。

**验收**：12.5；12.1/12.2 不回归。

---

## B1 · 5.4 预览侧测不出代码图层（缺"就绪"信号）

**实测**：导出侧三层都满足（p5-rain / glsl-noise / canvas2d-bars 各 480×360 区域 **172800/172800 非透明非黑**，
均值 72.75 / 159.81 / 90.00）。预览侧测不出：t=0.5 时预览只画出 canvas2d-bars（区域均值 32.2 vs 导出 70.8，
p5/glsl 两层缺失）；改到 t=11/24（对齐导出实际 IR 帧）重试 40×250ms 后三层区域仍全黑。

**卡点**：live 模式栅格没有可等待的就绪信号（`preview.assets` 不含 raster，`p.render(t)` 返回时纹理可能还没到）。

**期望**：给渲染侧的 raster 项一个可等待的就绪信号（例如 `preview.whenRastersReady(frame)` 或把 raster 加进 `assets`），
让探针/CI 能稳定等到"这一帧三层都画好"，然后完成 5.4 的预览 vs 导出同区域 ≤2% 对拍。

**验收**：5.4 全 PASS（三层预览 vs 导出 ≤2%）；p5 仍由用例 I 覆盖（0.55%）。

---

## B2 · 12.4 关键帧→像素的测量口径不可用

**实测**：`p5-rain` 密度已在 f0/f30 打两个不同值的关键帧，`rasterStateOf` 显示 `live` 且 `shownFrame` 跟手（0/15/30，
23–46ms）；但像素统计不可用：非背景像素 `122638 / 115512 / 121881`、tint 像素 `0 / 0 / 1647` 不单调；
原因是 `layerRects` 给该代码图层返回整幅 827×465，无法隔离图层区域。

**期望**：能按图层区域（或只渲该层）量非透明像素数，在 f0/f15/f30 三帧单调变化。

**范围建议**：`app/renderer/js/preview.js` 的 `rasterStateOf` / `layerRects`（给出真实图层矩形），
或探针侧只渲该层（`soloCameras`/隐藏其它元素）——先判断是实现缺信息还是探针口径问题。

**验收**：12.4 得出单调结论；若实际发现产品缺陷，另开 FAIL 任务。

---

## 观察项（不是 FAIL，建议顺手处理）

- **O1 · 11.1 报告头 fps/camera 错**：报告文件 `fps=24`（工程 30）、`camera=cam_6`（该帧实际机位 cam_8），
  与同文件 measure 里的 30/cam_8 自相矛盾。修 `POST /api/reports` / 面板 `getCameraId` 的来源。
- **O2 · 6.4 sourceApply 另建 31 个无 `el.source` 的背景元素**（`srcbg_*`；编译产物 35 项 = 4 节点 + 31 背景带）。
  行为可用，但"哪些元素归源管"需要写进 §7.8 或加 `el.source` 绑定，避免下次写回/合并漏掉它们。
- **O3 · `svg-icons` 共享夹具缺失**（6.8 判 PASS 的原因是有 4 条 SVG 单测且全过，但 §10.4.6 要求的夹具不存在；
  对拍用例 L 只覆盖 HTML）。补夹具 + 一条 SVG 对拍用例；顺带补渐变/filter/mask 的用例。
- **O4 · 探针稳健性**：`check:preview` 用固定 `--delay=2200`、parity 的 preview 用 `--delay=2600` 且无重试，
  并行负载下会 `window.__vdm` 未 boot（本轮三条线都踩到，V3 因此判 G5 FAIL、V1 遇到一次整轮预览错位）；
  Electron 类检查还会互相抢磁盘缓存（`Unable to move the cache: 拒绝访问`）。建议改成轮询 `window.__vdm` + 重试，
  并在探针里做进程级互斥。这条不修，CI 会随机红。
- **O5 · 3.3 导出变慢**：单帧中位 +48.2%（demo）/ +46.3%（nightcity）；demo 前 3 秒（72 帧）118.6 s → **230.8 s（+94.6%）**。
  D2 已预见（多一遍 16bit 解码→GLSL→16bit 编码），按方案标"需讨论"、不算 FAIL。需要拍板：接受，还是优化
  post 的 I/O（例如流水线化/少一次编码）。
