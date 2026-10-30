# 共享源码夹具 `tests/fixtures/sources/`

`docs/DESIGN-BACKEND-V2.md` §10.4.6 规定的共享夹具：渲染池、代码图层与网页编译的各工作包**共用同一套**，
不各自另编。本目录的前五个由 WP4.0（接口冻结包）建立；`svg-icons`、`three-orbit`、`manim-formula`
由对应的工作包按同样规则补齐。

| 目录 | runtime | 入口 | 用在哪 | 内容 |
| --- | --- | --- | --- | --- |
| `p5-rain` | `p5` | `sketch.js` | 代码图层；对拍用例 I | 雨丝下落，参数 `density` / `speed` / `tint` |
| `glsl-noise` | `glsl` | `main.frag` | 代码图层；对拍用例 I | 域扭曲值噪声，参数 `speed` / `scale` / `tint` |
| `canvas2d-bars` | `canvas2d` | `main.js` | 代码图层；对拍用例 I | 跳动条，参数 `count` / `speed` / `tint` |
| `html-title-card` | `html` | `index.html` | 网页编译；对拍用例 L | 标题 + 引题 + 分隔线，CSS 入场动画 |
| `html-lyrics` | `html` | `index.html` | 网页编译；对拍用例 L | 多条歌词 + 时间轴；`script.js` 从常量数组生成 DOM |

## 规则

- `manifest.json` 一律 `format: "vdm.source/1"`，`deterministic: true`，目录名 = manifest 的 `id`。
- 参数沿用 `DESIGN-TEMPLATES` 的 PROPERTY 形状：`id`（唯一、`[A-Za-z_][A-Za-z0-9_]*`）、`label`、
  `type`（`core/code-layer.js::PROPERTY_TYPES` 之一）、`default`；数值参数给 `range` 时
  `default` 必须落在范围内。
- 脚本不读挂钟（`Date.now` / `performance.now`）、不用无种子随机（`Math.random`）；需要随机时用
  `vdm.random(i, k)`，需要时间时用 `vdm.t`。代码图层夹具要能过 `core/code-layer.js::scanSourceFiles`
  的静态扫描（含 p5 专用规则），所以不调 `loop()` / `frameRate()` / `loadImage()`。
- 代码图层夹具的入口都是**真实可运行**的：p5 用实例模式 `export default (p) => {...}`，
  canvas2d 用 `export function draw(ctx, vdm)`，glsl 只写片元着色器（运行时补 `#version` 与
  `gl_FragColor` 的别名）。glsl 的入口是 `main.frag`，池子按文本读它；`.js` 入口（`export const frag`）
  也是协议允许的，但本夹具不放一份重复的着色器。
- 网页夹具是普通静态页：直接用浏览器打开 `index.html` 就是最终画面，带 `data-vdm-id` 的节点才是
  编译目标。页面参数以 CSS 变量出现并自带默认值（`var(--accent, …)` 那一层兜底），
  注入方式（4.1 决定）不影响独立运行。
- 画布尺寸交给渲染池（`vdm.size` / 页面视口）；夹具不写死项目尺寸。

## 校验

```bash
node --test tests/fixtures-sources.test.mjs   # 文件 + schema，不跑浏览器/Blender
```

测试只做静态检查：`manifest.json` 的形状、入口存在、参数合法、代码夹具过静态扫描、
`sourceFiles()` 往返一致、所有文件是合法 UTF-8。真正的画面验证在各自的 WP 里用对拍用例做。
