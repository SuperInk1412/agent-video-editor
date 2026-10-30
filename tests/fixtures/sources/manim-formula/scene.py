"""公式动画：Manim 共享夹具（docs/DESIGN-BACKEND-V2.md §6.4 / §10.4.6）。

`engine/manim.js` 用一条命令把整个场景渲成 PNG 序列：::

    manim render --format png --transparent --fps 24 -r 960,540 \
                 --media_dir <tmp> --disable_caching scene.py FormulaScene

参数通过环境变量以 JSON 传入（`VDM_MANIM_PARAMS`），尺寸 / 帧率 / 时长各
自带一个变量。场景只读这些输入：不读挂钟、不用无种子随机、不请求网络，所以
同一组 (参数, 尺寸, 帧率) 渲两次的画面逐字节相同 —— 这是 WP5.2 的确定性验收。

画面是一张**满幅的公式卡片**（`CARD_COLOR` 的纸面 + `formula` 文字 + 下划线）。
卡片铺满画幅，所以 PNG 的 alpha 基本恒为 255：图层是一块不透明的 2D 平面，
和代码图层一样参与 3D 旋转、遮挡与合成；`--transparent` 仍是命令的一部分
（§6.4），透明画幅的图层也照样能画，只是本夹具选择盖上自己的纸面，让逐像素
对拍（用例 M）比较的是画面本身而不是两套合成器的 alpha 混合。

单独运行（不需要编辑器）::

    VDM_MANIM_PARAMS='{"tint":"#ff8800","scale":2}' \
      manim render --format png --transparent -r 960,540 scene.py FormulaScene

`formula` 用 `Text` 排版，不需要 LaTeX 发行版。
"""
import json
import os

from manim import DOWN, UP, FadeIn, FadeOut, Line, Rectangle, Scene, Text, VGroup, config


def _json_env(name):
    raw = os.environ.get(name) or "{}"
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


PARAMS = _json_env("VDM_MANIM_PARAMS")
DURATION = float(os.environ.get("VDM_MANIM_DURATION") or 3.0)

#: 纸面颜色：固定值（不是 manifest 参数），对拍用例 M 按它识别"图层画在这里"。
CARD_COLOR = "#f0b429"


def _param(name, fallback):
    value = PARAMS.get(name)
    return fallback if value is None or value == "" else value


class FormulaScene(Scene):
    """入场 0.6 s、保持、退场 0.4 s：时长由 manifest.duration 决定，不是挂钟。"""

    def construct(self):
        formula = str(_param("formula", "E = mc²"))
        scale = max(0.05, float(_param("scale", 1.6)))
        tint = str(_param("tint", "#9fd8ff"))

        # 满幅纸面：从第一帧就在，alpha 恒为 255（见模块说明）。
        card = Rectangle(
            width=config.frame_width,
            height=config.frame_height,
            fill_color=CARD_COLOR,
            fill_opacity=1.0,
            stroke_width=0,
        )
        card.move_to([0, 0, 0])
        self.add(card)

        title = Text(formula, color=tint).scale(scale)
        rule = Line(LEFT, RIGHT, color=tint, stroke_width=10)
        rule.set_width(title.width)
        rule.next_to(title, DOWN, buff=0.3)
        group = VGroup(title, rule).move_to([0, 0, 0])

        fade_in = min(0.6, DURATION * 0.2)
        fade_out = min(0.4, DURATION * 0.15)
        hold = max(0.0, DURATION - fade_in - fade_out)

        self.play(FadeIn(group, shift=UP * 0.2), run_time=fade_in)
        if hold > 0:
            self.wait(hold)
        self.play(FadeOut(group, shift=DOWN * 0.2), run_time=fade_out)
