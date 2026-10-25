# VedioMaker

**自己定义编辑 · 实时预览 · AI 辅助 · Blender 出片**

VedioMaker 是一个本地的视频作曲台：时间线由你自己定义，画面在浏览器里即时预览，
最终画面交给 Blender 渲染，而 AI（DSH-TUI agent）和你操作的是**同一份项目文件**——
所以你随时能看见它在改什么、打断它、或者自己接手。

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 窗口 (或浏览器打开 localhost)                       │
│  ┌──────────┬─────────────────────┬───────────────────────┐  │
│  │ 分镜/媒体 │  WebGL2 实时预览     │ 检查器 / AI / 流水线   │  │
│  └──────────┴─────────────────────┴───────────────────────┘  │
│                    时间线（段落 + 元素 + 关键帧）              │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP (127.0.0.1:random)
┌───────────────────────────┴─────────────────────────────────┐
│ Node 引擎：项目文件读写 · 媒体探测 · 渲染队列 · 截图 · SSE     │
│   ├── Blender 5.x 无头渲染 (bpy：图层 + 合成器 + ffmpeg 封装) │
│   └── dsh --profile headless --json  (AI 编辑代理，可打断)     │
└──────────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
# 在仓库根启动：先弹项目选择器（不再默认死开 demo）
npm start

# 在项目目录里启动就直接打开那个项目（npm start 的 cwd 是包根，脚本读 INIT_CWD）
cd projects/nightcity && npm start

# 应用内：顶栏「项目」或 Ctrl+O 换项目（会带新项目重启），「重启」或 Ctrl+Shift+R 快速重启

# 或者纯浏览器形态
npm run web

# 命令行走一遍：新建 → 分析节拍 → 自动分镜 → 出帧 → 出片
node cli/vdm.js init projects/myfilm --title "我的片子" --duration 20 --audio bgm.m4a
cd projects/myfilm
node ../../cli/vdm.js import shot01.png shot02.png bgm.m4a
node ../../cli/vdm.js beats --set-duration
node ../../cli/vdm.js plan --style neon --brief $'第一句
第二句'
node ../../cli/vdm.js still 3.2 --out .vdm/frames/a.png
node ../../cli/vdm.js render --from 0 --to 8 --out .vdm/renders/part.mp4
```

Electron 路径可用 `VDM_ELECTRON` 覆盖；Blender 用 `VDM_BLENDER` 覆盖（默认自动找
`E:/mvtools/blender/*` 和 `C:/Program Files/Blender Foundation/*`）。

## 已验证

- `npm test`：14 个单元测试全绿（ops / 求值 / 存储锁 / 节拍 / agent 解析）
- Blender 5.0.1 无头 EEVEE：1080p 单帧约 3–5s（含启动），24s@50% 成片约 70s
- 示例项目 `projects/demo`：24s / 6 分镜 / 13 元素，成片在
  `projects/demo/.vdm/renders/master-*.mp4`（含音轨）
- AI 闭环：在 UI 里选中分镜 → 描述改动 → agent 返回 ops → 引擎落盘 → 预览/时间线即时刷新（可撤销）

## 3D 镜头（v0.2）

带相机的项目会把预览切成 **3D 视口**：程序化霓虹城市 + 无人机轨道，实时拖动播放头就是在飞。
成片由 Blender 消费**同一份烘焙包**（城市几何 + 逐帧机位），所以视口里看到的构图就是要渲的。

```bash
cd projects/nightcity
node ../../cli/vdm.js cam ls
node ../../cli/vdm.js cam set fov 72
node ../../cli/vdm.js cam add 7.6 0 34 -40 --look 90,34,-2
node ../../cli/vdm.js world set seed 4242
node ../../cli/vdm.js render --from 0 --to 6 --scale 0.5
```

参数设计见 `docs/SPEC-CAMERA.md`：轨道关键点 / 朝向 / 侧倾 / 抖动 / FOV / 景深 / 运动模糊 +
城市 seed、街区尺寸、楼高分布、亮窗、霓虹、雾。`world.corridor`（默认开、半径 16m）沿航线
清掉镜头会穿过的楼，换 `seed` 也不会撞楼；关掉用 `world set corridor.enabled false`。

## 三条设计原则

1. **项目文件是唯一真相源。** `projects/<name>/project.vdm.json` 是纯 JSON，
   UI、CLI、AI 都只通过同一套 `core/ops.js` 操作它；每次保存 rev+1、原子写入、带文件锁。
2. **预览和成片共用一套模型。** `core/evaluate.js` 定义每个元素在任意时刻的状态
   （变换 / 关键帧 / 运动 / 淡入淡出），WebGL 预览和 `blender/vdm_build.py` 各自实现同一套语义。
   预览求快，Blender 求真。
3. **AI 不拥有特权。** agent 用的是和人类一样的 CLI（`vdm set / key set / still / render`），
   每一步都是可见、可回滚的项目变更；它"看图"靠的是引擎给它渲染的片段帧。

## 目录

| 路径 | 作用 |
| --- | --- |
| `core/` | 纯 JS 模型：时间、求值、ops、schema、存储（零依赖，浏览器/Node 共用） |
| `cli/vdm.js` | `vdm` 命令：人用，也**是 AI 的工具面** |
| `engine/` | Node 服务：静态/媒体服务、REST+SSE、Blender 调度、agent 调度、节拍分析 |
| `app/renderer/` | 无构建步骤的 UI（原生 ESM + WebGL2） |
| `app/electron/` | Electron 壳（启动引擎 + 开窗） |
| `blender/` | bpy 场景构建与渲染（图层、文字、合成器、ffmpeg 封装） |
| `projects/` | 项目（示例见 `projects/demo/`） |
| `docs/` | 架构、项目格式、CLI、路线图 |

## 排错 / 日志

所有运行日志（引擎、渲染失败、AI 会话、渲染器异常）都进同一个文件：

```
projects/<name>/.vdm/logs/vdm-YYYY-MM-DD.log     # JSONL：ts/level/msg/meta
```

- 界面：右侧 **日志** 标签页，可按「警告+ / 只看错误」过滤、自动跟随；
- 终端：`npm run logs`（或 `node scripts/logs.mjs --project projects/demo --follow`）；
- 渲染失败会把 Blender 最后几 KB 的 stderr 一并写进日志；
- 渲染器里的 `window.onerror` / `unhandledrejection` 会自动上报，不再只躺在 devtools。

## 状态

v0.1（可跑通的 demo）：时间线编辑、实时预览、元素/细节检查器、关键帧、
Blender 出帧与出片、节拍自动分镜、AI 片段编辑（流式 + 打断）。

详见 `docs/ROADMAP.md`。
