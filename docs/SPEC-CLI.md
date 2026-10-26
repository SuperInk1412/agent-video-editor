# `vdm` CLI 参考

> 人类和 agent 共用的一套命令；所有写操作都经过 `core/ops.js`（加锁 + rev + 校验）。

```bash
node cli/vdm.js <command> [args] [--project <dir>] [--json]
```

不传 `--project` 时从当前目录向上找 `project.vdm.json`。

编辑命令支持 `--expected-rev N`、`--request-id ID`、`--dry-run`。`ops` 也可接收
`{"ops":[...],"expectedRev":N,"requestId":"...","dryRun":true}`；预检不写入，重试同一请求
返回相同事务结果。`vdm history` / `undo` / `redo` 使用持久化的项目全局历史。

## 项目

| 命令 | 说明 |
| --- | --- |
| `vdm init [dir] --title T --fps 24 --size 1920x1080 --duration 12 --audio f` | 新建项目 |
| `vdm info` | 概览（分镜 + 元素 + beats + fx） |
| `vdm ls [--segment id]` | 元素列表 |
| `vdm get <id> [path]` | 取元素或某字段 |
| `vdm eval <id> [--t 3.2]` | 某时刻的求值结果（调试关键帧/运动） |

## 编辑

| 命令 | 例子 |
| --- | --- |
| `vdm set <id> <path> <value>` | `vdm set el_1 transform.scale 1.2` |
| `vdm update <id> <json>` | `vdm update el_1 '{"style":{"color":"#ff0"}}'` |
| `vdm add --type text --text "标题" --start 1 --duration 3` | 也支持 `vdm add '{"type":"image",...}'` |
| `vdm rm <id>` / `vdm mv <id> --start 2 --duration 3` | 删除 / 移动裁剪（只改 start = 平移，关键帧跟着走；start+duration 一起改且结尾不动 = 左裁剪） |
| `vdm split <id> <t>` | 在 t 处切开（两半的画面与切开前逐帧一致） |
| `vdm key set <id> <path> <t> <value> [--ease outExpo]` | 关键帧（t 是项目绝对时间） |
| `vdm key rm <id> <path> [--t 1.2]` / `vdm key ls <id>` | 删除 t 处的一个关键帧（不传 `--t` 清空整条轨）/ 列出 |
| `vdm seg ls` / `add --start --duration --name` / `set` / `rm` | 分镜 |
| `vdm meta <path> <value>` | `vdm meta background "#05070d"` |
| `vdm fx '{"bloom":0.6,"ca":0.3}'` | 全局效果 |
| `vdm ops <json|@file|->` | 批量执行 |

## 素材 / 分镜

```bash
vdm import shot01.png bgm.m4a          # 拷进 media/
vdm beats --set-duration               # 分析项目音频，写 beats/tempo
vdm plan --style neon --brief $'第一句\n第二句' --seed 7
```

`plan` 是**确定性**的：同样的 seed + brief + 媒体池 → 同样的分镜。
它会重建 segments/elements（保留标题、音频、节拍、相机、世界和 3D 物体）。
brief 的每一行对应一个分镜（每段至少 1.2s）；媒体池里的图片和视频按种子洗牌后轮流使用，
用完一轮才会重复。

## 渲染

```bash
vdm still 3.2 --out .vdm/frames/a.png --scale 1 --samples 16
vdm render --from 0 --to 6 --out .vdm/renders/part.mp4 --scale 0.5
```

- `still`：Blender 单帧（真实成片观感，约 3–6s）
- `render`：PNG 序列 + ffmpeg 封装（含音轨、`-itsoffset` 对齐）
- 渲染失败时会打印 Blender 输出的最后 25 行（Python traceback 就在这里）
- `npm run blender:check`：换机器后的自检——找 Blender/ffmpeg，建一个临时项目（文字 + 色块 + 视频）真渲一帧

Blender / Electron / ffmpeg 先看环境变量 `VDM_BLENDER` / `VDM_ELECTRON` / `VDM_FFMPEG`，
再找常见安装位置（Windows、macOS 的 .app），最后在 `PATH` 里找。

## 给 agent 的用法

headless agent 没有 shell 权限，所以它的编辑通道是**返回 ops JSON**（见 `AGENTS.md`）：

```json
{"note":"把标题改成红色","ops":[
  {"op":"updateElement","id":"el_title","patch":{"style":{"color":"#ff2a4d"}}}
]}
```

CLI 仍然适合：人类手动批处理、CI、脚本，以及未来有 shell 权限的 agent。
