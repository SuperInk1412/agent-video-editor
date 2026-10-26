# AGENTS.md — 在 VedioMaker **代码库**里工作

这是 VedioMaker 的源码仓库（不是某个视频项目）。视频项目在 `projects/<name>/`。
剪辑 agent 的协议见 `docs/AGENT-PROTOCOL.md`。

## 先读

1. `docs/ARCHITECTURE.md` —— 进程模型、数据流、为什么这样分层
2. `docs/SPEC-PROJECT.md` —— 项目 JSON 格式与**求值语义**（预览/Blender 必须一致）
3. `docs/SPEC-CLI.md` —— `vdm` 命令面

## 硬约束

- **零 npm 依赖**：core/engine/cli/renderer 不许引入第三方包；Electron 复用本机 dist。
- `core/` 是纯 ESM，浏览器与 Node 共用；不要在里面 `import node:*`。
- 任何写项目的行为都必须经过 `core/ops.js`（加锁 + rev + 校验），不要手写 `project.vdm.json`。
- 改 `core/evaluate.js` 的求值规则时，**同步改** `blender/vdm_build.py::eval_element`。
- Blender 5 的合成器是 `scene.compositing_node_group`，节点组用 `NodeGroupOutput` 收尾。

## 验证

```bash
npm test                          # 单元测试（ops / 编辑语义 / 求值 / 相机 / 存储与监听 / 节拍 / agent 解析）
npm run check:preview             # 预览朝向回归检查（红顶/蓝底标记图，读像素断言）
npm run blender:check             # 找 Blender/ffmpeg 并真渲一帧临时项目（文字 + 色块 + 视频）
node cli/vdm.js still 1.5 --out /tmp/a.png    # 真渲一帧（需要 Blender）
node scripts/dev.mjs --project projects/demo --capture=/tmp/ui.png --at=1.8
```

- Blender / Electron / dsh 都会在 `PATH` 里找（Linux / macOS 不用设环境变量）；
  `VDM_BLENDER` / `VDM_ELECTRON` / `VDM_DSH` 仍然优先。
- 改了求值规则，除了单测，再用 Blender 跑一遍 `vdm_build.eval_element` 和 JS 对拍
  （同一组元素、同一组时间点，数值应完全一致）。

- 截图自检走 Electron 的 `--capture`（`show:false` + offscreen），**不要用无头 Chrome**：
  浏览器会请求 `/media/*.mp4|m4a`，可能触发本机 IDM 之类的下载嗅探弹窗。
- 渲染真帧是最快的"看起来对不对"检查；UI 改动至少截一张图。
- 动 `preview.js` 的纹理/矩阵/合成器时，**必须**跑 `npm run check:preview`：
  上下翻转这类 bug 不会改变包围盒，肉眼很容易漏。

## 提交

Conventional Commits；一次提交一件事。改动求值语义/ops/存储时补测试。
