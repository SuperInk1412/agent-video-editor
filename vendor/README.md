# vendor/ — 固定版本第三方运行时

沙箱（`engine/render-workers/`）里的代码图层要跑 p5 / three.js，而仓库的硬约束是**零 npm 依赖**，
所以库文件以**固定版本 + 许可证**的形式直接放在这里，由自定义协议 `vdm-src://vendor/` 提供给沙箱
（见 `engine/render-workers/window.js`：只服务 `vendor/manifest.json` 里登记过的路径）。

`vendor/manifest.json` 是唯一登记处：版本、来源 URL、文件清单、每个文件的 sha256 与字节数。
**缓存键**（§5.5「vendor 库版本」）取的就是这个 manifest 的哈希，所以换版本一定会让旧帧失效。

## 现在有什么

| 库 | 版本 | 许可 | 文件 | 体积 | 来源 |
| --- | --- | --- | --- | --- | --- |
| p5 | 1.9.4 | LGPL-2.1 | `p5/p5.min.js`、`p5/LICENSE` | 1,034,532 B + 24,480 B ≈ 1.01 MiB | <https://unpkg.com/p5@1.9.4/lib/p5.min.js>（上游 <https://github.com/processing/p5.js/releases/tag/v1.9.4>） |
| three | — | — | — | — | **延后到 WP5.1**：manifest 里留了占位条目 |

## three.js 为什么先不进来

WP3.1 只要求 canvas2d / p5 / glsl 三种 runtime 能画出一帧（§6.1 的 `three` 属于 WP5.1 的
"three.js 动画场景"）。现在放进来的库没有任何代码路径会加载它，等于往仓库里塞一份没人验证过的
第三方代码；`vendor/manifest.json` 里已经把位置留好（`libs.three.status = "deferred-to-WP5.1"`），
WP5.1 加文件 + 版本 + 许可证时只改这个 manifest 与驱动即可。

## 换/加库的步骤

1. 下载到 `vendor/<lib>/`，文件名带固定版本或在 manifest 里写死版本；
2. 把许可证文件一起放进去；
3. 在 `vendor/manifest.json` 里登记 `version`、`files`、`sha256`、`sizes`、`source`；
4. `npm test`（`tests/render-workers.test.mjs` 会校验 manifest 里登记的文件真实存在、sha256 与体积一致）。

不登记的路径 `vdm-src://vendor/...` 一律 403 —— 沙箱只有这一条通往磁盘的路。
