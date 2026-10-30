# 后端重构 V2 · 第二批逐包验收方案

> 编写：B（2026-10-30）。执行：A 派出的**验收子代理**。依据：`docs/DESIGN-BACKEND-V2.md` §10.4.8（D9）、§11。
> 范围：上次验收（截至 `c2bc053`）之后合入 master 的 12 个工作包，以及期间的修复提交。
> 结论写进 `DESIGN-BACKEND-V2.md` §16 和 `docs/CHANGELOG-presets.md`。

---

## 0. 验收子代理必读规则

1. **独立**：验收某个包的子代理，不能是实现这个包的子代理。验收依据是本方案和设计文档，不是实现者的交付报告。
   实现者报告的数字只用来对照，必须自己重新跑出来。
2. **只报告，不修改**：发现问题时写清复现步骤、实际数字和期望数字，交给 A 安排修复。**不改任何代码，不提交修复。**
3. **固定被测版本**：开始前记下 `git rev-parse --short master`，所有结论都针对这个提交。
   在独立的 worktree 里验：`git worktree add .scratch/worktrees/accept-<线> <提交>`。
4. **对比基线**：需要"改前 vs 改后"的项目，用该包第一个提交的父提交建基线 worktree：
   `git worktree add .scratch/worktrees/base-<包> <提交>^`。每个包的提交号见各节标题。
5. **不碰用户工程**：`projects/*` 只读。用副本：复制 `project.vdm.json` 和 `media/` 到 `.scratch/accept/<名字>/`，**不复制 `.vdm/`**。
6. **只用数字判断**：画面一律用像素统计（读 canvas、读 PNG 做差、数像素），不凭肉眼看图下结论。
7. **Blender 任务一次只跑一个**：这台机器内存有限，不要让多个子代理同时渲染。
8. **结果格式**：每一项写成 `编号 · PASS/FAIL/BLOCKED · 实测数字 · 期望 · 命令`。FAIL 必须附复现命令。

---

## 1. 分工（三个验收子代理可并行）

| 子代理 | 负责 | 说明 |
|---|---|---|
| **V1 渲染** | §3 WP3.5、§4 WP4.2、§5 WP3.4、§6 WP4.1 的画面部分 | 需要 Blender，和其他人的 Blender 任务错开 |
| **V2 引擎** | §2 WP2.5e、§7 WP-P、§8 WP4.0、§6 WP4.1 的事务部分、§11 WP2.5c 后端 | 主要是 Node 测试和 HTTP |
| **V3 界面** | §9 WP2.5a、§10 WP2.5b、§11 WP2.5c 界面、§12 WP3.6a | 用 Electron 探针（`scripts/dev.mjs --eval`） |

三人都要跑 §13 的全局回归，但只需在各自 worktree 跑一次。按风险从高到低排序：§2–§6 是重点。

---

## 2. WP2.5e · 应用内 AI 换成工具循环（`c30a061`、`c5c0bcc`）【风险最高】

AI 面板的引擎整个换掉了，旧的一次性 runner 已删除。要确认新链路端到端能用，而且安全边界有效。

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 2.1 | 旧 runner 已删干净 | `grep -rn "AgentRunner" engine app application mcp` | 代码里 0 处（注释说明已删除的除外） |
| 2.2 | 离线全流程（ScriptedAgent） | 写一个脚本：用 `ScriptedAgent` 喂一段固定的工具调用序列，任务是"把 `s1_w2` 字号改为 150"，按 读 → 计划 → 等批准 → `POST /api/agent/approve` → 提交变更集 → 出图 → 测量 → final 的顺序走 | 每一步的 HTTP 状态和 `GET /api/agent/state` 的状态序列与预期一致；最终工程里 `s1_w2` 字号为 150；历史里有一条带 `changesetId` 的事务 |
| 2.3 | 计划未批准不能写 | 同上，但不调用 approve，直接让脚本发写入 | 写入被拒；工程 hash 不变 |
| 2.4 | 范围限制 | 请求带 `scope.elements = ["s1_w2"]`，脚本尝试改 `s1_line` | 返回 `PATH_OUTSIDE_SCOPE`；在变更集产生之前就被拒；工程 hash 不变 |
| 2.5 | 锁定 | 先锁定 `s1_w2`（`el.locked = true`），再让脚本改它 | 返回 `LOCKED`；工程 hash 不变 |
| 2.6 | 取消 | 脚本在第 3 步时调用 `POST /api/agent/cancel` | 当前这一步做完后停止；`state` 为已取消；已提交的变更集保留并可撤回 |
| 2.7 | 报告来自数据，不来自 AI 自述 | 让脚本的 final 文本声称"改了颜色"，实际只改了字号 | 报告里"颜色"一项标为未做或不一致（§8.3）；字号一项带前后数值 |
| 2.8 | 撤回 | 对 2.2 产生的变更集调用撤回 | 工程 hash 回到 2.2 之前 |
| 2.9 | 真实 dsh 跑一次（可选，需联网） | 本机有 `dsh`。在 Electron 里用 AI 面板发同一个任务 | 走完整个流程，审阅页出现变更集；若失败，记录日志并标 BLOCKED，不算 FAIL |
| 2.10 | 契约 | `node scripts/gen-contracts.mjs --check` | 无差异 |

---

## 3. WP3.5 · 画面效果只剩一份 GLSL（`b195be0`）【风险高】

画面效果从 Blender 合成器移到了浏览器后处理。要确认成片没变，导出没有明显变慢，并且不会悄悄丢掉效果。

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 3.1 | 对拍用例 J | `node scripts/check-render-parity.mjs --only=J` | PASS（像素差 ≤ 2%） |
| 3.2 | **成片前后对比** | `demo` 和 `nightcity` 的副本（两者画面效果都开得很重），在基线 worktree（`b195be0^`）和被测 worktree 各渲同一组静帧：每个工程 5 帧（0%、25%、50%、75%、末帧前一帧），1920×1080，16 samples | 每帧差异像素（任一通道差 > 24）≤ 2%；逐帧列出数字。超过的帧单独列出并说明差在哪个区域（按 4×4 网格统计） |
| 3.3 | 导出耗时 | 3.2 的每帧耗时：基线 vs 被测；另导出 `demo` 前 3 秒视频，记录总耗时 | 记录数字。被测比基线慢超过 50% 时标为"需讨论"（D2 已预见会变慢，不算 FAIL） |
| 3.4 | 16 位输出 | 检查 Blender 原始帧的位深 | 开了画面效果时为 16 位 PNG |
| 3.5 | Blender 端已删效果代码 | `grep -n "bloom\|grain\|vignette\|scanline" blender/vdm_build.py` | 只剩注释或与画面效果无关的引用 |
| 3.6 | **没有 Electron 时的行为（B 预判的风险点）** | 在纯 Node 环境（不设 `VDM_ELECTRON`，用 `node cli/vdm.js` 导出）给 `demo` 副本导出一张静帧，同时检查：任务结果 JSON、`GET /api/jobs` 的任务记录、CLI 输出 | 记录实际行为。现状是"跳过并记一行日志"（`engine/blender.js::runPost`）。**如果任务结果和 CLI 输出里没有用户可见的警告**（例如 `warnings: ["画面效果未应用：没有 Electron"]`），标为 **FAIL**：用户会拿到一部没有效果的片子而不知情 |
| 3.7 | 中性效果不走后处理 | 副本把 `meta.fx` 全设为中性值后导出 | 不调用渲染池；输出与 Blender 原始帧逐像素相同 |

---

## 4. WP4.2 · 叠加 / 接管（`d779ee9`，IR 升 v5）【风险高】

改动了求值顺序。最重要的一条：**没有源码的普通工程，画面必须逐帧完全不变。**

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 4.1 | **普通工程 IR 不变** | 在基线 worktree（`d779ee9^`）和被测 worktree，对 `demo`（0–576 帧）、`nightcity`（0–360 帧）、`miku-swiss` 副本（0–450 帧）逐帧 `node scripts/dump-ir.mjs <帧> --compact`，比较 JSON（忽略 `version` 字段） | 全部帧 0 差异（浮点 ≤ 1e-9） |
| 4.2 | 普通工程画面不变 | `miku-swiss` 副本 0–450 帧，基线和被测预览各读一次 canvas | 逐像素相同 |
| 4.3 | 三种模式的数值 | 用夹具 `html-title-card` 编译出元素，取一个源在驱动的属性：位置（`add`）、透明度（`mul`）、任一属性 `override`。用 `dump-ir` 读 3 个时间点 | `add`：结果 = 源值 + 编辑器值；`mul`：结果 = 源值 × 编辑器值；`override`：结果 = 编辑器值，与源值无关。手算对照，误差 ≤ 1e-6 |
| 4.4 | 默认模式按单位 | 未设 `sourceMode` 时改一个比例属性和一个位置属性 | 比例属性按 `mul`，其余按 `add`（§7.3） |
| 4.5 | 求值顺序 | 给一个源元素同时加编辑器层偏移、属性链接和空间父级 | 结果符合"源 → 编辑器层 → 链接 → 父子"（§7.3），手算对照 |
| 4.6 | 性能 | `node scripts/bench-ir.mjs`，用 `miku-swiss` 副本 | PASS；记录单帧耗时，与 v4 时期（约 1.04 ms）对比 |

---

## 5. WP3.4 · Blender 画代码图层（`c5df785`）

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 5.1 | 对拍用例 I | `check-render-parity.mjs --only=I` | PASS |
| 5.2 | 缓存命中不重渲 | 同一个含 `p5-rain` 代码图层的副本连续导出两次 | 第二次日志显示缓存命中，渲染池没有启动渲染；两次输出帧哈希相同 |
| 5.3 | 参数变化会重渲 | 改代码图层的一个参数再导出 | 受影响的帧重新渲染，哈希改变；未受影响的帧（参数没有关键帧变化的范围之外）命中缓存 |
| 5.4 | 三种运行时都能导出 | `p5-rain`、`glsl-noise`、`canvas2d-bars` 各放一个图层导出一帧 | 每个图层区域的非透明像素 > 0；与预览同一帧的同一区域像素差 ≤ 2% |
| 5.5 | 代码出错时 | 把 `glsl-noise` 改成编译不过的着色器再导出 | 导出失败并给出清楚的错误（含源 id），**不能**输出缺图层的成片 |

---

## 6. WP4.1 · HTML / SVG 编译（`2cdb160`）

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 6.1 | 对拍用例 L | `check-render-parity.mjs --only=L` | PASS（整帧 ≤ 2%，位置误差 ≤ 0.5 px） |
| 6.2 | 编译不写工程 | `POST /api/sources/<id>/compile` | 工程 rev 和 hash 不变；生成 `.vdm/sources/<id>/base.json` |
| 6.3 | 应用是一次事务 | `POST /api/sources/<id>/apply` | rev + 1；一次撤销回到原 hash |
| 6.4 | 稳定 id | 每个生成的元素都有 `el.source = { id, node }`，`node` 与源里的 `data-vdm-id` 一一对应 | 全部对应，无重复、无遗漏 |
| 6.5 | 重复应用不重复建元素 | 连续 apply 两次 | 第二次不新增元素（按 `node` 更新），元素总数不变 |
| 6.6 | CSS 动画翻译精度 | `html-title-card` 的动画元素，在 5 个时间点比较编辑器 IR 位置与浏览器原生渲染的位置 | 误差 ≤ 0.5 px |
| 6.7 | 不支持的结构 | 写一个含复杂选择器、`position: fixed` 等的样例 | 不报错，返回 `warnings` 列出降级的节点 |
| 6.8 | **SVG 是否真的测到了** | 共享夹具里没有 `svg-icons`（§10.4.6 要求有）。检查 `tests/` 里是否有 SVG 编译的用例 | 有 SVG 用例且通过 → PASS；没有 → **FAIL**（缺测试，报告给 A 补夹具和用例） |

---

## 7. WP-P · 拆分热点文件（`f2d0eff`）

要求"行为零变化"。

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 7.1 | 接口列表不变 | 在基线（`f2d0eff^`）启动引擎，抓出所有路由（方法 + 路径）；被测同样抓一份 | 被测 ⊇ 基线；多出的路由必须属于之后的包（2.5c、4.1 等），逐条列出来源 |
| 7.2 | 契约与协议不变 | 基线和被测分别跑 `gen-contracts`，比较生成的 MCP schema 与 `AGENT-PROTOCOL.md` | 在 `f2d0eff` 这一个提交上逐字节相同（不包括后续包新增的部分） |
| 7.3 | 测试数不减少 | 基线与 `f2d0eff` 的 `npm test` 测试数 | `f2d0eff` ≥ 基线 |
| 7.4 | 检查器结构不变 | 在 `f2d0eff` 和基线上，分别选中一个元素、一个相机、一个 3D 物体，读检查器的 DOM 结构（标签 + class + 文本） | 三种选中下完全相同 |
| 7.5 | 登记机制可用 | 读 `engine/routes/index.js`、`registerInspectorSection` 与 op/契约登记接口 | 之后的包（2.5c、3.6a、4.1、4.2）确实是通过登记接入的，没有再改 `server.js` 主体（`git log --oneline f2d0eff..master -- engine/server.js` 应为空或只有组装改动） |

---

## 8. WP4.0 · 接口冻结与共享夹具（`a2ee2ef`，修订 `d07c30b`）

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 8.1 | 冻结记录完整 | 读 `DESIGN-BACKEND-V2.md` §7 末尾的冻结记录 | 覆盖 §10.4.4 的四项：快照格式、`el.source`/`sourceMode`、写回接口、合并接口 |
| 8.2 | 实现与冻结一致 | 对照 `application/source-service.js`、`core/source-map.js` 的导出签名和 `base.json` 实际内容 | 字段、函数签名一致；不一致处逐条列出 |
| 8.3 | 夹具 | `node --test tests/fixtures-sources.test.mjs`；每个夹具跑 `vdm source check`（代码类）或编译（网页类） | 全部通过 |

---

## 9. WP2.5a · 审阅面板（`0af5a06`、`5eba9cf`，后端 `b50f094`、`764f4a5`）

先跑 `node scripts/check-review-ui.mjs`（实现者报告 44/44），再按 `docs/DESIGN-WP2.5-REVIEW.md` §10 独立探针：

| # | 检查 | 通过标准 |
|---|---|---|
| 9.1 | 画面内预览 | 打开预览后视口像素 = "采纳后"工程（另起一个已采纳的副本渲同一帧比对，像素差 0）；按住 `\` 时 = 原工程（像素差 0）；预览期间 `project.vdm.json` 的 hash 和 rev 不变 |
| 9.2 | 预览中编辑自动退出 | 预览时在检查器改一个值，预览退出，修改落在真实工程上 |
| 9.3 | 采纳 = 一步撤销 | 采纳整组后 rev + 1；一次 Ctrl+Z 回到原 hash |
| 9.4 | 人话显示 | 面板 DOM 文本里不出现 `cs_`、`el_`、`style.`、`actorId`；悬停提示里有 |
| 9.5 | 连带改动合一行 | 一个 `moveElement`（带 2 个关键帧）显示为一行，复选框只有一个 |
| 9.6 | 提议过期 | 提议后在检查器改同一属性 → 该行变为过期；`全部采纳` 不覆盖人的值 |
| 9.7 | 需决定 | 不是红色（不用 `--danger`）；有"保留现在的值 / 用 AI 的值"两个按钮，点后结果正确 |
| 9.8 | AI 想改锁定元素 | 变更集里有相应说明行；"临时解锁并采纳"后：值已改、元素仍锁定、整个过程一次 Ctrl+Z 可撤回 |
| 9.9 | 按钮按状态 | 待审阅无"撤回"字样；已采纳只有"撤回" |

---

## 10. WP2.5b · 时间线标记与锁定（`06a9365`）

先跑 `node scripts/check-timeline-marks.mjs`，再：

| # | 检查 | 通过标准 |
|---|---|---|
| 10.1 | **锁定穿透** | 副本里锁定 `s2_bg`，在 t = 5.0 s、`cam_8`，在 `s2_bg` 覆盖、且下面或前面有其他元素的 5 个点单击：选中的都不是 `s2_bg`；在只有 `s2_bg` 的点单击：什么都不选 |
| 10.2 | 框选跳过 | 框选范围包含 `s2_bg` 和 2 个其他元素 → 只选中 2 个 |
| 10.3 | 时间线可解锁 | 时间线行内锁图标点一下 → `locked` 变 false（走 op，可撤销） |
| 10.4 | 锁定时的 gizmo 与检查器 | 从时间线选中锁定元素：视口不显示可拖动 gizmo；检查器改值成功 |
| 10.5 | 标记按类型 | 注入三种变更集：改字号（整段属性）、改关键帧、移动起点 → 分别是元素行竖条、关键帧外圈、标尺菱形 |
| 10.6 | 已采纳淡色标记 | 采纳后标记变淡且保留；点"知道了"后消失 |
| 10.7 | 颜色 | `tokens.css` 有 `--ai` / `--ai-bg`；标记不用 `--accent`；`grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' app/renderer/css/*.css | grep -v tokens.css` 为空 |
| 10.8 | 图标 | 锁图标来自 `icon()`，DOM 里没有 🔒🔓 字符 |

---

## 11. WP2.5c · 报告草稿（后端 `9624555`，界面 `feca7d2`）

先跑 `node scripts/check-report-ui.mjs`，再：

| # | 检查 | 通过标准 |
|---|---|---|
| 11.1 | **完整场景** | `miku-swiss` 副本：时间线选 `s2_w4` → Shift+R → 播放头到 f144 按 I、到 f153 按 O → Shift+R → 选"闪烁" → 写一句话 → 提交。报告文件有 2 个附件；`measures` 里有 10 条逐帧可见性记录 |
| 11.2 | 测量数字一致 | 11.1 的逐帧数字与 `vdm inspect coverage --focus s2_w4 --camera cam_8 --frames 144:153 --mode pixel` 一致（同一像素口径；不同口径时说明并分别列出） |
| 11.3 | 混合附件 | 草稿里同时放元素、关键帧、时间范围、画面区域、变更集各一个 → 都能保存，类型正确 |
| 11.4 | 快捷键边界 | Ctrl+Shift+R 只重启引擎、不开草稿；Alt+Shift+R 不开草稿；文本框里输入大写 R 不触发 |
| 11.5 | 带上已选中 | 先在时间线选一个画面上看不见的元素（例如还没出场的），再按 Shift+R → 草稿里有它 |
| 11.6 | 报告编辑器问题 | 命令面板"报告编辑器问题"生成的报告带播放帧率和日志，类型与内容问题分开 |
| 11.7 | 重新测量 | 对 11.1 的报告调用 `POST /api/reports/<id>/remeasure` → 返回同一组测量；数据达标时状态可标为"已验证" |
| 11.8 | 报告不进撤销 | 提交报告后 Ctrl+Z 不影响报告，工程 hash 不因报告改变 |

---

## 12. WP3.6a · 代码图层检查器（`ede0648`）

先跑 `node scripts/check-code-ui.mjs`（实现者报告 31/31），再：

| # | 检查 | 通过标准 |
|---|---|---|
| 12.1 | 只在代码图层出现 | 选中文字、相机、3D 物体时没有该分区；选中 `code` 元素时有 |
| 12.2 | 参数行 = manifest | 对三个夹具，参数行数与 manifest `params` 数相同；◆ 只在 `keyable` 参数上 |
| 12.3 | 改参数走事务 | 改一个参数 → rev + 1，`code.params` 更新，Ctrl+Z 恢复 |
| 12.4 | 关键帧影响画面 | 给 `p5-rain` 的密度在 f0、f30 打两个不同值的关键帧 → f0、f15、f30 三帧的图层非透明像素数单调变化 |
| 12.5 | 查看源码只读 | 源码窗口里无法编辑（DOM 无可编辑元素）；可以复制 |

（3.6b 的"载入外部修改"等尚未实现，不在本批。）

---

## 13. 全局回归（每个验收子代理在自己的 worktree 跑一次）

| # | 命令 | 通过标准 |
|---|---|---|
| G1 | `npm test` | 0 失败；记录总数、通过数、跳过数（上次 820 / 822，2 跳过） |
| G2 | `node scripts/check-render-parity.mjs` | A–L 全部 PASS |
| G3 | `node scripts/check-playback-perf.mjs --project=<miku-swiss 副本>` | PASS |
| G4 | `node scripts/bench-ir.mjs` | PASS |
| G5 | `npm run check:preview` | PASS |
| G6 | `npm run blender:check`、`node scripts/check-camfeed.mjs --blender` | PASS |
| G7 | `npm run check:v3-reader` | PASS |
| G8 | `node scripts/gen-contracts.mjs --check` | 无差异 |
| G9 | `node scripts/check-timeline-range.mjs`（WP2.5d 的回归） | PASS |
| G10 | `node --test tests/no-python-eval.test.mjs` | PASS |

期间合入的修复提交（`94fb59b` 文字网格颜色、`ab9c7fc` camfeed 延迟一帧检查、HTTP 端口修复）只要求全局回归通过，不单独验收。

---

## 14. 交付

1. 每个子代理交一份结果表（§0 第 8 条格式），汇总给 A。
2. A 把汇总写进 `DESIGN-BACKEND-V2.md` §16 的新一行（范围、结论、关键数字），并在 `docs/CHANGELOG-presets.md` 记一行。
3. 每个 FAIL 单独开一条修复任务；修复合入后，**只重跑该项及 §13**，结果补记到 §16。
4. 交给用户的摘要只写：通过了哪些、哪几项 FAIL、各自影响、修复计划。

预计耗时：V1 约 1 天（Blender 任务多）；V2 约 0.5–1 天；V3 约 1 天。三人并行，日历时间约 1 天。
