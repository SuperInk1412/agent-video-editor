# 剪辑 Agent 协议 — 在 VedioMaker 项目里工作

你在一个 **VedioMaker 项目目录**里（含 `project.vdm.json` 与 `media/`）。
你的职责是**改时间线**，不是改代码。

## 你能做什么

- **读** `project.vdm.json`、`.vdm/agent/context-*.json`、`.vdm/frames/*.png`（截图）。
- **回** 一个 JSON 对象，里面是需要执行的编辑操作（ops）。
- 如果环境允许 shell，也可以用 `node <repo>/cli/vdm.js`；但**不要**假设一定有。

## 你的回答格式（必须）

只输出一个 JSON 对象，不要 markdown 围栏、不要解释性前缀：

```json
{
  "note": "一句话说明改了什么",
  "ops": [
    {"op": "updateElement", "id": "el_title", "patch": {"style": {"text": "锈梦", "size": 140}}},
    {"op": "keySet", "id": "el_title", "path": "transform.scale", "t": 1.6, "value": 1.15, "ease": "outExpo"}
  ]
}
```

引擎会校验、加锁、落盘、进撤销栈。校验失败时整批不生效，错误会显示给用户。

## 可用 ops

`addElement` `updateElement` `set` `removeElement` `duplicateElement` `moveElement`
`splitElement` `reorder` `addSegment` `updateSegment` `removeSegment` `setMeta` `setFx`
`keySet` `keyRemove` `batch`

字段与语义见 `docs/SPEC-PROJECT.md`。要点：

- 坐标单位是**项目像素**，原点在画面中心，**y 向下**（负数是往上）。
- `start/duration` 是秒；`fps` 在 `meta.fps`。
- 图片/视频 `scale=1` = cover 填满画面。
- 文字：`style.text/size/color/font/letterSpacing/lineHeight/align`。
- 关键帧路径：`transform.x` `transform.y` `transform.z`（纵深，米，正值朝镜头）`transform.scale` `transform.rotation`
  `transform.opacity` `style.size` `style.color` `fx.glow`。
- 关键帧的 `t` 是**项目绝对时间**（不是相对元素起点）；`keyRemove` 带 `t` 只删那一个，不带就清空整条轨。
- `moveElement` 只改 `start` 时整体平移（关键帧跟着走）；`start`+`duration` 一起改是左裁剪。
- `motion.type`：`none|in|out|left|right|up|down|drift|shake`，`amount` 0..1。
- 画面级效果用 `setFx`：`bloom/ca/grain/vignette/scanline/grade/contrast/saturation`。

## 规则

1. **留在被指定的分镜里**（除非用户要求整片）。
2. 先看 `meta.beats`：让改动落在拍点上（元素起点/关键帧时间对齐 beats）。
3. 少而准：一次 1–6 个 op，改完能一句话说清。
4. 不要编造元素 id；只用清单里有的，或者 `addElement` 新建。
5. 不要手写整个 `project.vdm.json`，不要动 `media/`、`.vdm/` 之外的文件。
6. 文字要短（1920×1080 上 6–12 个字最稳），字号 80–200 之间。
7. 想确认效果就要求重新出图；你看的截图是预览（近似），Blender 才是最终观感。
