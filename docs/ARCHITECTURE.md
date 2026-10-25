# 架构

> 一句话：**一份项目文件、一套求值语义、两个渲染器（浏览器实时预览 / Blender 成片），
> 所有编辑（人、CLI、AI）都走同一套 ops。**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Electron 窗口  (或浏览器打开 http://127.0.0.1:<port>)                      │
│                                                                          │
│  ┌────────────┐   ┌─────────────────────────┐   ┌─────────────────────┐   │
│  │ 分镜 / 媒体 │   │ WebGL2 预览 (60fps)      │   │ 检查器 / AI / 流水线 │   │
│  └────────────┘   └─────────────────────────┘   └─────────────────────┘   │
│                    时间线：分镜 + 元素 + 关键帧 + 播放头                     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTP + SSE (127.0.0.1, 随机端口)
┌───────────────────────────────┴──────────────────────────────────────────┐
│ Node 引擎 (engine/)                                                       │
│   server.js   静态/媒体服务(含 Range) · REST · SSE · 撤销栈 · 流水线        │
│   media.js    ffprobe / 抽帧 / 编码 / 缩略图                              │
│   beats.js    纯 JS STFT 频谱通量 → onset → 速度/节拍网格                  │
│   blender.js  Blender 任务调度（抽序列、写 job、进度、取消）                │
│   agent.js    dsh --profile headless --json 的流式封装 + ops 解析          │
│   storyboard.js 自动分镜（节拍 + 媒体池 + 风格预设）                        │
└──────────┬───────────────────────────────────────────┬───────────────────┘
           │                                           │
   ┌───────┴────────┐                        ┌─────────┴──────────┐
   │ Blender 5.x     │                        │ DSH-TUI headless   │
   │ 无头 EEVEE      │                        │ 读项目 → 回 ops JSON│
   │ bpy 场景 + 合成器│                        │ (无 shell 权限)     │
   │ → PNG 序列       │                        └────────────────────┘
   │ → ffmpeg 封装    │
   └────────────────┘
```

## 1. 唯一真相源

`projects/<name>/project.vdm.json` 是**唯一的编辑状态**。没有藏在内存里的影子时间线。

- 每次修改都是 `core/ops.js` 里一个 JSON 操作；
- `core/store.js` 用「mkdir 原子锁 + 临时文件 rename」写入，`rev` 自增；
- UI 与 CLI/AI 都会改这个文件，引擎用 `fs.watchFile` 监听外部变更并广播；
- 失败的操作不会落盘（先克隆校验再写）。

这样做的直接好处：**AI 的修改和你手动的修改是同一类东西**——看得见（时间线会跳）、
能撤销（服务端撤销栈）、能 diff（纯 JSON）。

## 2. 两个渲染器，一套语义

`core/evaluate.js` 定义「某元素在 t 时刻长什么样」：

```
base(transform/style) → 关键帧覆盖 → motion 预设增量 → 淡入淡出 → 节拍 punch
```

- **预览** `app/renderer/js/preview.js`：WebGL2 逐层绘制 → 场景 FBO → Bloom 链 →
  合成（色散/颗粒/扫描线/暗角/调色）。图片/视频用 cover 的 UV 裁切，文字走 2D canvas
  转纹理（按画布像素比生成，缩放清晰）。
- **成片** `blender/vdm_build.py`：正交相机（世界单位 = 项目像素）→ 每个元素一个平面/文字对象
  → `frame_change_pre` 处理器按同一套公式改变换 → 合成器节点组复刻同一组后期。

两者不追求逐像素一致，但**构图、时间、运动、图层顺序一致**。Blender 是"真"，预览是"快"。
`docs/SPEC-PROJECT.md` 里写明了求值规则，改任何一边都要同步另一边。

## 3. Blender 后端

- 引擎把项目 + 抽好的视频序列写成 job JSON，`blender -b --factory-startup -P blender/vdm_render.py -- --job ...`；
- Python 侧只认 job，不认 UI；stdout 用 `VDM_PROGRESS {...}` 报进度，Node 解析后转 SSE；
- 静帧：`--mode still --time t`；片段：`--mode frames --from --to`（PNG 序列，可断点续跑）；
- 编码：ffmpeg 把序列 + 项目音频（含 `-itsoffset` 对齐）封成 H.264 mp4；
- 合成器在 Blender 5 里是 `scene.compositing_node_group`（不是旧的 `scene.node_tree`），
  节点组用 `NodeGroupOutput` 收尾——代码里对 4.x/5.x 的枚举大小写做了容错。

**扩展点**：`blender/ops/` 里放任意 bpy 片段，按项目里的 `meta.extensions` 调用（v0.2）。

## 4. AI 集成（DSH-TUI）

真实的约束：headless agent **能读文件、不能执行 shell**（沙箱拦截）。

所以协议不是"AI 调 CLI"，而是：

```
上下文包(.vdm/agent/context-*.json) + 片段截图路径 + 元素清单
        ↓  (agent 读项目 JSON)
{"note": "...", "ops": [ {...}, {...} ]}      ← 只回一个 JSON
        ↓  (引擎校验、加锁、落盘、广播、进撤销栈)
时间线立刻变；UI 收到 project 事件
```

- `engine/agent.js` 负责起进程、流式转发 NDJSON（`session/status/thinking/text/final`）、
  取消时 `taskkill /T`、从最终回答里**容错提取** JSON（允许代码围栏、前后废话）；
- op 校验失败时不会落盘，错误回到 AI 面板；
- 因为 ops 是结构化数据，未来可以接任意模型/任意 agent，只要它会吐这个 JSON。

## 5. 可见、可打断、可重写的流水线

`分镜 → 预览帧 → 片段 → 成片` 四步都落在 `pipeline` 状态里（SSE 实时推）：

- 自动分镜是**确定性**的（种子随机 + 节拍切分），重复跑结果一致；
- 每步都有产物：分镜 JSON、Blender 静帧、片段 mp4、成片 mp4，全部挂在流水线面板上；
- 渲染是单任务队列，带进度与取消（`AbortController` → 杀 blender 进程树）；
- 撤销栈让"重写"成本极低。

## 6. 为什么是这些技术选择

| 选择 | 原因 |
| --- | --- |
| Electron 36（复用本机 dist，不装依赖） | 桌面窗口/菜单/文件关联，渲染仍是 Web 技术 |
| 引擎用纯 Node（零 npm 依赖） | 可单独 `node engine/server.js` 起服务、可测试、可被任意壳包 |
| WebGL2 自写合成器 | 实时预览必须 60fps 且和 Blender 有相同的图层/FX 语义 |
| Blender 无头 EEVEE | 10 门合成器 + 3D 能力，出片质量远高于 2D 库；EEVEE 后台可跑 |
| 项目 JSON + ops | AI/UI/CLI 天然同构，diff/撤销/回放都免费 |
| `dsh --profile headless --json` | 现成的流式 agent 运行时，事件可读、进程可杀 |
