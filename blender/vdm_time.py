# -*- coding: utf-8 -*-
"""Frame <-> time, the one rule both backends use (docs/SPEC-PROJECT.md P5).

The preview picks the frame under `t` with `core/keyframe-edit.js::frameIndex`:
`floor(t * fps + 1e-6)` (0-based; the timeline shows frame + 1). Python used
`round()`, whose halves go to the even number, so a time exactly between two
frames could name a different frame in the render than in the preview — the
WP1.2 acceptance worked around it with one frame of slack in the shot range,
but the root stayed. `vdm_render.py` now calls this module for the still frame
and for both ends of a frame range.

No `bpy` import: `tests/still-frame.test.mjs` runs this file with the system
Python and compares it with the JS rule.
"""
import math

FRAME_EPS = 1e-6


def normalize_fps(fps):
    """24 default, at least 1 fps, integer (same rule as the JS side)."""
    try:
        rate = int(round(float(fps or 24)))
    except (TypeError, ValueError):
        rate = 24
    return max(1, rate)


def frame_index(t, fps):
    """0-based frame under `t`: floor with a 1e-6-frame cushion, clamped at 0.

    The cushion is in frame units, not seconds: `123/30 * 30` evaluates to
    122.99999999999999, and flooring that without it would pick frame 122 for
    a keyframe the user put on frame 123.
    """
    rate = normalize_fps(fps)
    try:
        time = max(0.0, float(t or 0))
    except (TypeError, ValueError):
        time = 0.0
    return max(0, int(math.floor(time * rate + FRAME_EPS)))


def still_frame(t, fps, duration):
    """1-based Blender frame of a still at `t`, clamped to the project end.

    The end is a boundary, not a frame: a 5 s / 60 fps project renders frames
    1..300, so `still 5` must render the last frame instead of frame 301.
    """
    total = max(1, int(round(float(duration or 0) * normalize_fps(fps))))
    return min(total, max(1, frame_index(t, fps) + 1))
