# -*- coding: utf-8 -*-
"""
VedioMaker -> Blender scene builder.

Mirrors core/evaluate.js exactly:
    transform = base -> keyframes -> motion delta (+ beat punch) -> fade
    y axis points DOWN in the project, UP in Blender (we negate it)
    world units == project pixels (orthographic camera, ortho_scale = width)

Everything is built once, then a frame_change_pre handler updates each layer,
so an animation render stays fast.
"""
import bisect
import bpy
import json
import math
import struct
import os
import numpy as np

# ---------------------------------------------------------------- utilities

PX_PER_M = 100.0  # core/scene.js: 100 px = 1 m


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h, alpha=1.0):
    if isinstance(h, (list, tuple)):
        return tuple(h[:3]) + (alpha,)
    s = str(h or '#ffffff').strip().lstrip('#')
    if len(s) == 3:
        s = ''.join(ch * 2 for ch in s)
    if len(s) < 6:
        s = 'ffffff'
    r, g, b = (int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


def clamp(v, a=0.0, b=1.0):
    return a if v < a else b if v > b else v


def lerp(a, b, t):
    return a + (b - a) * t


BEZIER_SOLVE_STEPS = 40


def _bezier_axis(a, b, s):
    inv = 1.0 - s
    # Preserve JS's multiplication order for bit-identical curve evaluation.
    return 3.0 * inv * inv * s * a + 3.0 * inv * s * s * b + s * s * s


# ---------------------------------------------------------------- value curves
# Mirrors core/curves.js. Formulas are ports of the reference easings in
# 参考程序/alight-curve-editor (see tests/fixtures/am-curve-samples.json); keep
# the two implementations in sync.

AM_PI = 3.14159

PRESET_PARAM_SPECS = {
    'bounce': {
        'firstStepLength': (0.01, 1.0, 0.3),
        'bounciness': (0.0, 1.0, 0.8),
    },
    'elastic': {
        'stepLength': (0.01, 1.0, 0.25),
        'attack': (0.0, 10.0, 1.0),
        'decay': (0.0, 1.0, 0.5),
        'magnitude': (0.0, 1.0, 1.0),
    },
    'cyclic': {
        'stepLength': (0.001, 1.0, 0.2857143),
        'sharpness': (0.0, 1.0, 0.0),
        'skew': (0.0, 1.0, 0.5),
        'decay': (0.0, 1.0, 0.0),
    },
    'step': {
        'stepLength': (0.01, 1.0, 0.25),
        'smoothing': (0.0, 1.0, 0.0),
    },
    'elasticStep': {
        'stepLength': (0.01, 1.0, 0.2),
        'magnitude': (0.0, 1.0, 0.5),
    },
}

PRESET_TYPES = {
    'bounce': 'bounce',
    'elastic': 'elastic',
    'cyclic': 'cyclic',
    'step': 'step',
    'elasticStep': 'elasticStep',
}


def _curve_mix(a, b, t):
    return a * (1.0 - t) + b * t


def _round_param(v):
    # JS Math.round rounds halves up; Python's round() is banker's rounding.
    return math.floor(v * 1000000.0 + 0.5) / 1000000.0


def _preset_params(kind, raw):
    spec = PRESET_PARAM_SPECS.get(kind)
    if not spec:
        return None
    src = raw if isinstance(raw, dict) else {}
    out = {}
    for key, (lo, hi, default) in spec.items():
        try:
            value = float(src.get(key, default))
        except (TypeError, ValueError):
            value = default
        if not math.isfinite(value):
            value = default
        out[key] = _round_param(clamp(value, lo, hi))
    return out


def _bounce_sample(p, u):
    first = p['firstStepLength']
    bounce = p['bounciness']
    if first <= 0.0:
        return 1.0
    start = 0.0
    length = first
    amplitude = 1.0
    probe = u + first / 2.0
    for _ in range(512):
        end = start + length
        if probe <= end:
            if start + length / 3.0 > first / 2.0 + 1.0 or (length < 0.1 and end > first / 2.0 + 1.0):
                return 1.0
            x = abs(((probe - start) / length - 0.5) * 2.0)
            return x * x * amplitude + (1.0 - amplitude)
        length *= bounce
        amplitude *= bounce
        if amplitude < 0.005:
            return 1.0
        start = end
    return 1.0


def _elastic_basic(p, x):
    length = max(p['stepLength'], 0.01)
    cos = math.cos((AM_PI * x) / length)
    falloff = 1.0 - max(x, 0.005)
    return cos * abs(falloff ** (p['decay'] * p['decay'] * 15.0 + 1.0))


def _elastic_sample(p, u):
    length = max(p['stepLength'], 0.01)

    def ease(x):
        return 1.0 - _elastic_basic(p, x) * p['magnitude']

    if u >= length:
        return ease(u)
    ramp = (1.0 - math.cos((AM_PI * u) / length)) / 2.0
    return _curve_mix(ramp * ease(length), ease(u), (u / length) ** 3)


def _cyclic_sample(p, u):
    length = max(p['stepLength'], 0.001)

    def pct(x):
        return (((x % length) + length) % length) / length

    def cos_interp(x):
        return 1.0 - ((math.cos((x / length) * AM_PI * 2.0) + 1.0) / 2.0)

    def saw_interp(x):
        return 1.0 - abs(pct(x) - 0.5) * 2.0

    def skew_interp(x):
        q = pct(x)
        f = 0.5
        if q < p['skew']:
            f = (0.5 * q) / p['skew']
        elif q > p['skew']:
            f = 0.5 + ((q - p['skew']) / (1.0 - p['skew'])) / 2.0
        return (x - q * length) + length * f

    warped = skew_interp(u)
    value = _curve_mix(cos_interp(warped), saw_interp(warped), p['sharpness'])
    base = u - (u % length)
    if length / 4.0 + base > 1.0:
        value = 0.0
    elif length / 2.0 + base < 1.0 and base + (length * 3.0) / 4.0 > 1.0 and pct(u) > p['skew']:
        value = 1.0
    return value * (1.0 - u * p['decay']) + u * p['decay']


def _step_sample(p, u):
    length = max(p['stepLength'], 0.001)
    ramp_start = length - p['smoothing'] * length
    rest = u % length
    if ramp_start == length:
        raw = 1.0 if rest >= length else 0.0
    else:
        raw = clamp((rest - ramp_start) / (length - ramp_start))
    smooth = raw * raw * (3.0 - 2.0 * raw)
    return (u - rest) + smooth * length


def _elastic_step_sample(p, u):
    length = max(p['stepLength'], 0.001)
    if u < length:
        return 0.0
    inner = {
        'stepLength': 0.5 - 0.45 * p['magnitude'],
        'decay': 1.0 - p['magnitude'] * 0.5,
        'magnitude': (1.0 - p['magnitude']) * 0.5 + 0.5,
    }
    rest = u % length
    value = _elastic_sample(inner, rest / length)
    return (u - rest) + length * (value - 1.0)


def sample_preset(kind, params, u):
    """Progress for a preset kind and its parameter bag; endpoints are pinned."""
    p = _preset_params(kind, params)
    target = clamp(u)
    if not p:
        return target
    if target <= 0.0:
        return 0.0
    if target >= 1.0:
        return 1.0
    if kind == 'bounce':
        return _bounce_sample(p, target)
    if kind == 'elastic':
        return _elastic_sample(p, target)
    if kind == 'cyclic':
        return _cyclic_sample(p, target)
    if kind == 'step':
        return _step_sample(p, target)
    if kind == 'elasticStep':
        return _elastic_step_sample(p, target)
    return target


def sample_curve(curve, u):
    """Progress for a per-segment value curve (mirrors core/curves.js)."""
    if not isinstance(curve, dict):
        return clamp(u)
    kind = curve.get('type')
    if not kind and curve.get('preset'):
        kind = PRESET_TYPES.get(curve.get('preset'))
    if kind and kind != 'bezier':
        raw = curve.get('params')
        return sample_preset(kind, raw if isinstance(raw, dict) else curve, u)
    p1 = curve.get('p1') or (0.0, 0.0)
    p2 = curve.get('p2') or (1.0, 1.0)
    try:
        x1 = clamp(float(p1[0]))
        y1 = float(p1[1])
        x2 = clamp(float(p2[0]))
        y2 = float(p2[1])
    except (TypeError, ValueError, IndexError):
        return clamp(u)
    if not (math.isfinite(y1) and math.isfinite(y2)):
        return clamp(u)
    target = clamp(u)
    if target <= 0.0:
        return 0.0
    if target >= 1.0:
        return 1.0
    lo, hi = 0.0, 1.0
    for _ in range(BEZIER_SOLVE_STEPS):
        s = (lo + hi) / 2.0
        if _bezier_axis(x1, x2, s) < target:
            lo = s
        else:
            hi = s
    return _bezier_axis(y1, y2, (lo + hi) / 2.0)


def ease(name, p):
    p = clamp(p)
    if name == 'linear':
        return p
    if name == 'easeIn':
        return p * p
    if name == 'easeOut':
        return 1 - (1 - p) ** 2
    if name == 'smooth':
        return p * p * (3 - 2 * p)
    if name == 'outExpo':
        return 1 if p >= 1 else 1 - 2 ** (-10 * p)
    if name == 'inOutCubic':
        return 4 * p ** 3 if p < 0.5 else 1 - (-2 * p + 2) ** 3 / 2
    if name == 'outBack':
        c1, c3 = 1.70158, 2.70158
        return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2
    # easeInOut (default)
    return 2 * p * p if p < 0.5 else 1 - (-2 * p + 2) ** 2 / 2


def sample_track(keys, path, t, base):
    if not keys:
        return base
    track = sorted([k for k in keys if k.get('path') == path], key=lambda k: k['t'])
    if not track:
        return base
    if t <= track[0]['t']:
        return track[0]['value']
    if t >= track[-1]['t']:
        return track[-1]['value']
    for i in range(len(track) - 1):
        a, b = track[i], track[i + 1]
        if a['t'] <= t < b['t']:
            p = (t - a['t']) / max(1e-6, b['t'] - a['t'])
            if isinstance(a['value'], (int, float)) and isinstance(b['value'], (int, float)):
                progress = sample_curve(a['curve'], p) if a.get('curve') else ease(a.get('ease', 'easeInOut'), p)
                return lerp(a['value'], b['value'], progress)
            return a['value']
    return base


def kick(beats, t, dur=0.14):
    """Exponential pulse after the last beat <= t (mirrors core/time.js::kick)."""
    i = bisect.bisect_right(beats, t) - 1
    if i < 0:
        return 0.0
    dt = t - beats[i]
    if dt > dur * 5:
        return 0.0
    return math.exp(-dt / dur)


def motion_progress(el, t):
    """motion.span = [t0, t1] pins the preset to an absolute range (kept across splits)."""
    span = (el.get('motion') or {}).get('span')
    if isinstance(span, (list, tuple)) and len(span) == 2:
        try:
            a, b = float(span[0]), float(span[1])
        except (TypeError, ValueError):
            a = b = 0.0
        if b > a:
            return clamp((t - a) / (b - a))
    return clamp((t - el['start']) / max(1e-6, el['duration']))


def punch_mul(el, t, meta):
    punch = float(el.get('punch') or 0)
    beats = meta.get('beats') or []
    if punch <= 0 or not beats:
        return 1.0
    return 1 + punch * 0.05 * kick(beats, t, 0.12)


def motion_delta(el, t, meta):
    m = el.get('motion') or {}
    amt = float(m.get('amount') or 0)
    d = {'x': 0.0, 'y': 0.0, 'scale': punch_mul(el, t, meta), 'rotation': 0.0}
    if not amt:
        return d
    p = motion_progress(el, t)
    q = 0.35 * ease('easeInOut', p) + 0.65 * p
    w, h = meta['width'], meta['height']
    typ = m.get('type', 'none')
    if typ == 'in':
        d['scale'] *= 1 + amt * q
    elif typ == 'out':
        d['scale'] *= 1 + amt * (1 - q)
    elif typ == 'left':
        d['x'] = -amt * w * (q - 0.5); d['scale'] *= 1.02
    elif typ == 'right':
        d['x'] = amt * w * (q - 0.5); d['scale'] *= 1.02
    elif typ == 'up':
        d['y'] = amt * h * (q - 0.5); d['scale'] *= 1.02
    elif typ == 'down':
        d['y'] = -amt * h * (q - 0.5); d['scale'] *= 1.02
    elif typ == 'drift':
        d['x'] = amt * w * (q - 0.5); d['y'] = -amt * h * 0.25 * (q - 0.5)
    elif typ == 'shake':
        s = amt * 0.5
        d['x'] = s * 14 * (math.sin(t * 37) + math.sin(t * 23.3) * 0.6)
        d['y'] = s * 14 * math.sin(t * 29.1)
        d['rotation'] = s * 0.7 * math.sin(t * 17.7)
    return d


def eval_element(el, t, meta):
    tr = el.get('transform') or {}
    kf = el.get('keyframes') or []

    def g(path, default):
        return sample_track(kf, path, t, default)

    st = {
        'x': float(g('transform.x', tr.get('x', 0)) or 0),
        'y': float(g('transform.y', tr.get('y', 0)) or 0),
        'z': float(g('transform.z', tr.get('z', 0)) or 0),
        'scale': float(g('transform.scale', tr.get('scale', 1)) or 0),
        'rotation': float(g('transform.rotation', tr.get('rotation', 0)) or 0),
        'opacity': float(g('transform.opacity', tr.get('opacity', 1)) or 0),
        'glow': float(g('fx.glow', (el.get('fx') or {}).get('glow', 0)) or 0),
        'text': g('style.text', (el.get('style') or {}).get('text', '')),
        'size': float(g('style.size', (el.get('style') or {}).get('size', 96)) or 0),
        'color': g('style.color', (el.get('style') or {}).get('color', '#ffffff')),
    }
    md = motion_delta(el, t, meta)
    st['x'] += md['x']
    st['y'] += md['y']
    st['scale'] *= md['scale']
    st['rotation'] += md['rotation']

    fin = float(el.get('fadeIn') or 0)
    fout = float(el.get('fadeOut') or 0)
    fade = 1.0
    if fin > 0:
        fade *= clamp((t - el['start']) / fin)
    if fout > 0:
        fade *= clamp((el['start'] + el['duration'] - t) / fout)
    st['opacity'] = clamp(st['opacity'] * fade)
    st['active'] = el['start'] - 1e-6 <= t < el['start'] + el['duration'] - 1e-6
    return st


# ---------------------------------------------------------------- scene bits

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def make_world(scene, color):
    world = bpy.data.worlds.new('VDM_World')
    world.use_nodes = True
    scene.world = world
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = hex_rgba(color)
        bg.inputs[1].default_value = 1.0
    return world


def make_camera(scene, width, height):
    cam_data = bpy.data.cameras.new('VDM_Cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = float(width)
    cam = bpy.data.objects.new('VDM_Cam', cam_data)
    cam.location = (0.0, 0.0, 100.0)
    cam.rotation_euler = (0.0, 0.0, 0.0)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def plane_mesh(name, w, h, uv_rect=(0, 0, 1, 1)):
    mesh = bpy.data.meshes.new(name)
    hx, hy = w / 2.0, h / 2.0
    verts = [(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0)]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    mesh.update()
    uv = mesh.uv_layers.new(name='UVMap')
    u0, v0, u1, v1 = uv_rect
    corners = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            uv.data[li].uv = corners[vi]
    return mesh


def disc_mesh(name, w, h, segments=96):
    mesh = bpy.data.meshes.new(name)
    verts = [(0.0, 0.0, 0.0)]
    for i in range(segments):
        a = 2 * math.pi * i / segments
        verts.append((math.cos(a) * w / 2.0, math.sin(a) * h / 2.0, 0.0))
    faces = [(0, i + 1, (i + 1) % segments + 1) for i in range(segments)]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    return mesh


def new_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    return mat, nt


def finish_shader(nt, shader):
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(shader.outputs[0], out.inputs['Surface'])
    return out


def textured_material(name, image, opacity=1.0):
    mat, nt = new_material(name)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.extension = 'CLIP'
    tex.interpolation = 'Linear'
    em = nt.nodes.new('ShaderNodeEmission')
    trans = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    amul = nt.nodes.new('ShaderNodeMath')
    amul.operation = 'MULTIPLY'
    amul.inputs[1].default_value = opacity
    nt.links.new(tex.outputs['Color'], em.inputs['Color'])
    nt.links.new(tex.outputs['Alpha'], amul.inputs[0])
    nt.links.new(amul.outputs[0], mix.inputs[0])
    nt.links.new(trans.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    finish_shader(nt, mix)
    mat.surface_render_method = 'BLENDED'
    mat.use_transparent_shadow = False
    return mat, {'mix': mix, 'em': em, 'alpha': amul.inputs[1], 'tex': tex}


def flat_material(name, color, opacity=1.0):
    mat, nt = new_material(name)
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = hex_rgba(color)
    trans = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    amul = nt.nodes.new('ShaderNodeValue')
    amul.outputs[0].default_value = opacity
    nt.links.new(amul.outputs[0], mix.inputs[0])
    nt.links.new(trans.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    finish_shader(nt, mix)
    mat.surface_render_method = 'BLENDED'
    mat.use_transparent_shadow = False
    return mat, {'mix': mix, 'em': em, 'alpha': amul.outputs[0]}


FONT_MAP = {
    'simhei': 'C:/Windows/Fonts/simhei.ttf',
    'microsoft yahei': 'C:/Windows/Fonts/msyh.ttc',
    'yahei': 'C:/Windows/Fonts/msyh.ttc',
    'arial': 'C:/Windows/Fonts/arial.ttf',
    'impact': 'C:/Windows/Fonts/impact.ttf',
    'bahnschrift': 'C:/Windows/Fonts/bahnschrift.ttf',
}


def font_bbox_em(path):
    """Height of the font's head-table bbox in em (ttf/otf; ttc uses its first face).

    Blender sizes FONT curves so that this bbox height equals `size`; the
    viewport (CSS) sizes the em. Multiplying by this keeps `size` = em height.
    """
    try:
        with open(path, 'rb') as f:
            data = f.read()
        base = 0
        if data[:4] == b'ttcf':
            base = struct.unpack('>I', data[12:16])[0]
        n = struct.unpack('>H', data[base + 4:base + 6])[0]
        for i in range(n):
            rec = base + 12 + 16 * i
            if data[rec:rec + 4] == b'head':
                off = struct.unpack('>I', data[rec + 8:rec + 12])[0]
                upm = struct.unpack('>H', data[off + 18:off + 20])[0]
                ymin, ymax = struct.unpack('>hh', data[off + 38:off + 40] + data[off + 42:off + 44])
                if upm and ymax > ymin:
                    return (ymax - ymin) / float(upm)
    except (OSError, struct.error, IndexError):
        pass
    return 1.0


def resolve_font(style):
    fp = style.get('fontPath')
    if fp and os.path.exists(fp):
        return fp
    name = str(style.get('font') or 'SimHei')
    key = name.lower()
    if key in FONT_MAP and os.path.exists(FONT_MAP[key]):
        return FONT_MAP[key]
    for k, v in FONT_MAP.items():
        if k in key and os.path.exists(v):
            return v
    return FONT_MAP['simhei'] if os.path.exists(FONT_MAP['simhei']) else None


def cover_uv(img_w, img_h, frame_w, frame_h):
    """UV rect so an image COVERS the frame without distortion."""
    if not img_w or not img_h:
        return (0, 0, 1, 1)
    img_aspect = img_w / img_h
    frame_aspect = frame_w / frame_h
    if img_aspect > frame_aspect:  # image wider -> crop sides
        f = frame_aspect / img_aspect
        return ((1 - f) / 2, 0, 1 - (1 - f) / 2, 1)
    f = img_aspect / frame_aspect  # image taller -> crop top/bottom
    return (0, (1 - f) / 2, 1, 1 - (1 - f) / 2)


# ---------------------------------------------------------------- compositor

def _noise_png(path, w, h, seed=7):
    rng = np.random.default_rng(seed)
    base = rng.normal(0.5, 0.16, size=(h, w))
    base = np.clip(base, 0, 1)
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, 0] = base
    rgba[:, :, 1] = base
    rgba[:, :, 2] = base
    rgba[:, :, 3] = 1.0
    img = bpy.data.images.new('vdm_grain_src', width=w, height=h, alpha=True)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    return path


def _scan_png(path, w, h):
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rows = np.arange(h)
    val = np.where(rows % 3 == 0, 0.80, 1.0).astype(np.float32)
    rgba[:, :, 0] = val[:, None]
    rgba[:, :, 1] = val[:, None]
    rgba[:, :, 2] = val[:, None]
    img = bpy.data.images.new('vdm_scan_src', width=w, height=h, alpha=True)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    return path



def set_menu(sock, *vals):
    """Menu sockets differ in casing across versions; try each spelling."""
    for v in vals:
        try:
            sock.default_value = v
            return True
        except Exception:
            continue
    return False

def _mix(ng, a, b, fac=1.0, blend='MIX'):
    m = ng.nodes.new('ShaderNodeMix')
    m.data_type = 'RGBA'
    m.blend_type = blend
    # RGBA sockets: Factor[0], A[6], B[7]; result RGBA = outputs[2]
    m.inputs[0].default_value = fac
    for src, sock in ((a, m.inputs[6]), (b, m.inputs[7])):
        if isinstance(src, (int, float)):
            sock.default_value = (src, src, src, 1.0)
        elif isinstance(src, tuple):
            sock.default_value = src
        else:
            ng.links.new(src, sock)
    return m


def _val(ng, v):
    n = ng.nodes.new('ShaderNodeValue')
    n.outputs[0].default_value = float(v)
    return n.outputs[0]


def build_compositor(scene, meta, cache_dir, fog=None, overlay=None, backdrop=None):
    """Post chain for `scene`. `overlay` is an optional transparent scene (the
    2D layer of a 3D shot) alpha-overed after the fog and before the post fx.
    `backdrop` (linear RGB) is for a transparent film (the empty world): fog only
    touches rendered pixels, then the picture goes over this flat colour, the
    same as the viewport's clear colour."""
    fx = meta.get('fx') or {}
    w, h = scene.render.resolution_x, scene.render.resolution_y
    os.makedirs(cache_dir, exist_ok=True)

    ng = bpy.data.node_groups.new('VDM_Composite', 'CompositorNodeTree')
    scene.compositing_node_group = ng
    scene.render.use_compositing = True

    rl = ng.nodes.new('CompositorNodeRLayers')
    try:
        rl.scene = scene
        rl.layer = scene.view_layers[0].name
    except Exception:
        pass
    chain = rl.outputs['Image']

    # distance fog for 3D shots: use the Mist pass (EEVEE supports it natively)
    if fog:
        try:
            scene.view_layers[0].use_pass_mist = True
            scene.world.mist_settings.start = float(fog.get('start') or 30.0)
            scene.world.mist_settings.depth = float(fog.get('depth') or 700.0)
        except Exception:
            pass
        fogc = fog.get('color') or [0.03, 0.06, 0.1]
        strength = float(fog.get('strength') or 1.0)
        mul = ng.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = max(0.05, min(3.0, strength))
        ng.links.new(rl.outputs['Mist'], mul.inputs[0])
        if backdrop is not None:
            # the background has mist = 1; keep the fog on the objects only
            only = ng.nodes.new('ShaderNodeMath')
            only.operation = 'MULTIPLY'
            ng.links.new(mul.outputs[0], only.inputs[0])
            ng.links.new(rl.outputs['Alpha'], only.inputs[1])
            mul = only
        rgb = ng.nodes.new('CompositorNodeRGB')
        rgb.outputs[0].default_value = (fogc[0], fogc[1], fogc[2], 1.0)
        mixf = ng.nodes.new('ShaderNodeMix')
        mixf.data_type = 'RGBA'
        mixf.blend_type = 'MIX'
        ng.links.new(chain, mixf.inputs[6])
        ng.links.new(rgb.outputs[0], mixf.inputs[7])
        ng.links.new(mul.outputs[0], mixf.inputs[0])
        chain = mixf.outputs[2]

    if backdrop is not None:
        bgc = ng.nodes.new('CompositorNodeRGB')
        bgc.outputs[0].default_value = (backdrop[0], backdrop[1], backdrop[2], 1.0)
        under = ng.nodes.new('CompositorNodeAlphaOver')
        ng.links.new(bgc.outputs[0], under.inputs['Background'])
        ng.links.new(chain, under.inputs['Foreground'])
        chain = under.outputs[0]

    if overlay is not None:
        orl = ng.nodes.new('CompositorNodeRLayers')
        try:
            orl.scene = overlay
            orl.layer = overlay.view_layers[0].name
        except Exception:
            pass
        over = ng.nodes.new('CompositorNodeAlphaOver')
        # Blender 5 orders the inputs Background, Foreground, Factor; link by
        # name. Render results are premultiplied, so Straight Alpha stays off.
        ng.links.new(chain, over.inputs['Background'])
        ng.links.new(orl.outputs['Image'], over.inputs['Foreground'])
        chain = over.outputs[0]

    # grade ---------------------------------------------------------------
    cb = ng.nodes.new('CompositorNodeColorBalance')
    cb.inputs['Factor'].default_value = 1.0
    set_menu(cb.inputs['Type'], 'Lift/Gamma/Gain', 'LIFT_GAMMA_GAIN')
    for nm in ('Lift', 'Gamma', 'Gain'):
        for i in cb.inputs:
            if i.name == nm and i.type == 'RGBA':
                i.default_value = (1, 1, 1, 1)
    grad = float(fx.get('grade') or 0)
    if grad:
        warm, cool = (1.0, 0.94, 0.86), (0.88, 0.95, 1.0)
        gain = warm if grad > 0 else cool
        k = abs(grad)
        for i in cb.inputs:
            if i.name == 'Gain' and i.type == 'RGBA':
                i.default_value = tuple(lerp(1.0, gain[j], k) for j in range(3)) + (1.0,)
    ng.links.new(chain, cb.inputs['Image'])
    chain = cb.outputs['Image']

    hs = ng.nodes.new('CompositorNodeHueSat')
    hs.inputs['Saturation'].default_value = float(fx.get('saturation', 1) or 1)
    ng.links.new(chain, hs.inputs['Image'])
    chain = hs.outputs['Image']

    bc = ng.nodes.new('CompositorNodeBrightContrast')
    bc.inputs['Contrast'].default_value = float(fx.get('contrast', 0) or 0) * 40
    ng.links.new(chain, bc.inputs['Image'])
    chain = bc.outputs['Image']

    # chromatic aberration ------------------------------------------------
    ca = float(fx.get('ca') or 0)
    if ca > 0.001:
        ld = ng.nodes.new('CompositorNodeLensdist')
        ld.inputs['Dispersion'].default_value = ca * 0.06
        ng.links.new(chain, ld.inputs['Image'])
        chain = ld.outputs['Image']

    # bloom ---------------------------------------------------------------
    bloom = float(fx.get('bloom') or 0)
    if bloom > 0.001:
        gl = ng.nodes.new('CompositorNodeGlare')
        set_menu(gl.inputs['Type'], 'Fog Glow', 'FOG_GLOW')
        set_menu(gl.inputs['Quality'], 'High', 'HIGH')
        gl.inputs['Threshold'].default_value = 0.45
        gl.inputs['Strength'].default_value = bloom * 1.4
        gl.inputs['Size'].default_value = 0.65
        ng.links.new(chain, gl.inputs['Image'])
        chain = gl.outputs['Image']

    # scanlines -----------------------------------------------------------
    scan = float(fx.get('scanline') or 0)
    if scan > 0.001:
        p = os.path.join(cache_dir, f'scan_{w}x{h}.png')
        if not os.path.exists(p):
            _scan_png(p, w, h)
        img = bpy.data.images.load(p, check_existing=True)
        node = ng.nodes.new('CompositorNodeImage')
        node.image = img
        m = _mix(ng, chain, node.outputs['Image'], scan, 'MULTIPLY')
        chain = m.outputs[2]

    # grain ---------------------------------------------------------------
    grain = float(fx.get('grain') or 0)
    if grain > 0.001:
        p = os.path.join(cache_dir, f'grain_{w}x{h}.png')
        if not os.path.exists(p):
            _noise_png(p, w, h)
        img = bpy.data.images.load(p, check_existing=True)
        inode = ng.nodes.new('CompositorNodeImage')
        inode.image = img
        tr = ng.nodes.new('CompositorNodeTranslate')
        set_menu(tr.inputs['Extension X'], 'Repeat', 'REPEAT')
        set_menu(tr.inputs['Extension Y'], 'Repeat', 'REPEAT')
        ng.links.new(inode.outputs['Image'], tr.inputs['Image'])
        # animate the grain by scrolling it with the frame counter
        st = ng.nodes.new('CompositorNodeSceneTime')
        mx = ng.nodes.new('ShaderNodeMath')
        mx.operation = 'MULTIPLY'
        mx.inputs[1].default_value = 37.0
        ng.links.new(st.outputs['Frame'], mx.inputs[0])
        ng.links.new(mx.outputs[0], tr.inputs['X'])
        my = ng.nodes.new('ShaderNodeMath')
        my.operation = 'MULTIPLY'
        my.inputs[1].default_value = 17.0
        ng.links.new(st.outputs['Frame'], my.inputs[0])
        ng.links.new(my.outputs[0], tr.inputs['Y'])
        m = _mix(ng, chain, tr.outputs['Image'], grain * 0.9, 'OVERLAY')
        chain = m.outputs[2]

    # vignette ------------------------------------------------------------
    vig = float(fx.get('vignette') or 0)
    if vig > 0.001:
        ell = ng.nodes.new('CompositorNodeEllipseMask')
        ell.inputs['Mask'].default_value = 1.0
        ell.inputs['Value'].default_value = 1.0
        ell.inputs['Size'].default_value = (0.82, 0.72)
        blur = ng.nodes.new('CompositorNodeBlur')
        set_menu(blur.inputs['Type'], 'Gaussian', 'GAUSSIAN')
        br = max(w, h) * 0.22
        blur.inputs['Size'].default_value = (br, br)
        ng.links.new(ell.outputs['Mask'], blur.inputs['Image'])
        dark = ng.nodes.new('CompositorNodeRGB')
        dark.outputs[0].default_value = (0, 0, 0, 1)
        inv = ng.nodes.new('CompositorNodeInvert')
        ng.links.new(blur.outputs['Image'], inv.inputs['Color'])
        mul = ng.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = vig
        ng.links.new(inv.outputs['Color'], mul.inputs[0])
        ao = ng.nodes.new('CompositorNodeAlphaOver')
        ao.inputs['Factor'].default_value = 1.0
        ng.links.new(chain, ao.inputs['Background'])
        ng.links.new(dark.outputs[0], ao.inputs['Foreground'])
        ng.links.new(mul.outputs[0], ao.inputs['Factor'])
        chain = ao.outputs['Image']

    # The group needs a declared output socket: linking to the output node's
    # empty virtual socket leaves the group without a result, and Blender then
    # writes the raw render (no fog, grade, bloom, grain or vignette).
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    out = ng.nodes.new('NodeGroupOutput')
    ng.links.new(chain, out.inputs['Image'])
    return ng


# ---------------------------------------------------------------- builder

class SceneBuilder:
    def __init__(self, project, opts):
        self.p = project
        self.opts = opts
        self.meta = project['meta']
        self.fps = float(self.meta.get('fps') or 24)
        self.W = float(self.meta.get('width') or 1920)
        self.H = float(self.meta.get('height') or 1080)
        self.root = opts.get('root') or os.path.dirname(opts['project'])
        self.cache = os.path.join(self.root, '.vdm', 'cache')
        self.updaters = []
        self.el_index = 0

    # -- assets ------------------------------------------------------------
    def resolve_src(self, src):
        if not src:
            return None
        if os.path.isabs(src):
            return src
        return os.path.normpath(os.path.join(self.root, src))

    def load_image(self, path, sequence=False):
        if not path or not os.path.exists(path):
            return None
        img = bpy.data.images.load(path, check_existing=True)
        if sequence:
            img.source = 'SEQUENCE'
        return img

    # -- materials ---------------------------------------------------------
    def tex_material(self, name, image, opacity):
        return textured_material(name, image, opacity)

    # -- objects -----------------------------------------------------------
    def add_object(self, mesh, material, name):
        obj = bpy.data.objects.new(name, mesh)
        obj.data.materials.append(material)
        obj.location = (0, 0, 0.002 * self.el_index)
        self.el_index += 1
        obj.visible_shadow = False
        bpy.context.scene.collection.objects.link(obj)
        return obj

    def build_text(self, el, style, st0, z):
        font_path = resolve_font(style)
        cu = bpy.data.curves.new(f'{el["id"]}_txt', 'FONT')
        cu.body = str(st0['text'] or ' ')
        # style.size is the em size in project pixels (CSS / preview.js); Blender
        # sizes a font by its head bbox, so convert (same rule as vdm_objects.py)
        em = font_bbox_em(font_path) if font_path else 1.0
        cu.size = float(st0['size']) * em
        cu.align_x = {'left': 'LEFT', 'right': 'RIGHT'}.get(style.get('align', 'center'), 'CENTER')
        cu.align_y = 'CENTER'
        cu.space_line = float(style.get('lineHeight') or 1.18) / em
        cu.space_character = 1.0 + float(style.get('letterSpacing') or 0) / max(1.0, float(st0['size']))
        if font_path:
            try:
                cu.font = bpy.data.fonts.load(font_path, check_existing=True)
            except Exception:
                pass
        mat, nodes = flat_material(f'{el["id"]}_mat', st0['color'], st0['opacity'])
        obj = self.add_object(cu, mat, el['id'])
        obj.location.z = self.layer_px * z
        obj.scale = (1, 1, 1)
        obj['vdm_em'] = em
        # Preview semantics (preview.js text layers): the text box is centred on
        # the element position and `align` only aligns lines inside the box.
        # Blender anchors LEFT / RIGHT text at the origin, so shift it back by the
        # box centre; the shift scales with the size (style.size can be keyed).
        # Vertically, the preview centres the line box (textBaseline 'middle');
        # CJK / Latin glyphs sit centred in the em box, so centre on the glyph
        # bbox here rather than on Blender's own CENTER metric.
        obj['vdm_center_per_size'] = 0.0
        obj['vdm_vcenter_per_size'] = 0.0
        try:
            bpy.context.scene.view_layers[0].update()
            xs = [v[0] for v in obj.bound_box]
            ys = [v[1] for v in obj.bound_box]
            if cu.align_x != 'CENTER':
                c = (min(xs) + max(xs)) / 2.0
                cu.offset_x = -c
                obj['vdm_center_per_size'] = c / max(1e-6, float(cu.size))
            cy = (min(ys) + max(ys)) / 2.0
            cu.offset_y = -cy
            obj['vdm_vcenter_per_size'] = cy / max(1e-6, float(cu.size))
        except Exception:
            pass
        return obj, nodes

    def build_media(self, el, style, st0, z, src_path, sequence=None):
        if sequence:
            # Image.frame_duration is read-only (Blender 5.2+); the frame count
            # lives on the texture node's ImageUser, set below.
            img = self.load_image(sequence['first'], sequence=True)
        else:
            img = self.load_image(src_path)
        if img is None:
            # missing asset -> magenta placeholder so it is obvious in the render
            mat, nodes = flat_material(f'{el["id"]}_mat', '#ff00aa', st0['opacity'])
            mesh = plane_mesh(f'{el["id"]}_mesh', self.W, self.H)
            obj = self.add_object(mesh, mat, el['id'])
            obj.location.z = self.layer_px * z
            return obj, nodes, None

        fit = style.get('fit', 'cover')
        if img.size[0] and img.size[1]:
            uv = (0, 0, 1, 1) if fit == 'stretch' else cover_uv(img.size[0], img.size[1], self.W, self.H)
        else:
            uv = (0, 0, 1, 1)
        mesh = plane_mesh(f'{el["id"]}_mesh', self.W, self.H, uv)
        mat, nodes = textured_material(f'{el["id"]}_mat', img, st0['opacity'])
        if sequence:
            iu = nodes['tex'].image_user
            iu.frame_duration = max(1, int(sequence['count']))
            iu.frame_start = 1
            iu.frame_offset = 0
            iu.use_cyclic = False
            iu.use_auto_refresh = True
            nodes['tex']['vdm_frames'] = int(sequence['count'])
        obj = self.add_object(mesh, mat, el['id'])
        obj.location.z = self.layer_px * z
        return obj, nodes, nodes['tex']

    def build_shape(self, el, style, st0, z):
        w = float(style.get('w') or self.W)
        h = float(style.get('h') or self.H)
        kind = style.get('shape', 'rect')
        mesh = disc_mesh(f'{el["id"]}_mesh', w, h) if kind == 'ellipse' else plane_mesh(f'{el["id"]}_mesh', w, h)
        mat, nodes = flat_material(f'{el["id"]}_mat', st0['color'] if el['type'] == 'text' else style.get('fill', '#ffffff'), st0['opacity'])
        obj = self.add_object(mesh, mat, el['id'])
        obj.location.z = self.layer_px * z
        return obj, nodes

    # -- main --------------------------------------------------------------
    def build(self, scene=None, overlay=False, embed=None):
        """Build the 2D project. With `scene` given, build into that scene instead
        of resetting the file (the caller makes it bpy.context.scene); `overlay`
        renders on a transparent film without world or compositor (the 2D layer
        of a multi-camera 3D shot, see vdm_city.py). `embed` is an object (the
        screen rig) in an existing 3D scene: the elements are parented to it and
        nothing else of the scene is touched (unified space)."""
        if scene is None:
            scene = reset_scene()
        # pixels between layers along the depth axis; in a perspective 3D scene
        # EEVEE sorts blended objects by distance, so give the layers 0.1 mm
        self.layer_px = 0.01 if embed is not None else 0.002
        if embed is None:
            self._setup_scene(scene, overlay)
        return self._build_elements(scene, overlay, embed)

    def _setup_scene(self, scene, overlay):
        scene.render.engine = 'BLENDER_EEVEE'
        scene.render.resolution_x = int(round(self.W * self.opts.get('scale', 1.0)))
        scene.render.resolution_y = int(round(self.H * self.opts.get('scale', 1.0)))
        scene.render.resolution_percentage = 100
        scene.render.fps = int(round(self.fps))
        scene.render.fps_base = 1.0
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_mode = 'RGB'
        scene.render.image_settings.compression = 15
        scene.render.filter_size = 0.8
        scene.render.film_transparent = bool(overlay)
        if overlay:
            scene.render.image_settings.color_mode = 'RGBA'
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
        scene.view_settings.exposure = 0
        scene.view_settings.gamma = 1
        try:
            scene.eevee.taa_render_samples = int(self.opts.get('samples', 16))
            scene.eevee.use_raytracing = False
        except Exception:
            pass

        if not overlay:
            make_world(scene, self.meta.get('background', '#05070d'))
        make_camera(scene, self.W, self.H)

        duration = float(self.meta.get('duration') or 12)
        scene.frame_start = 1
        scene.frame_end = max(1, int(round(duration * self.fps)))

    def _build_elements(self, scene, overlay, embed):
        before = set(scene.objects)
        # layer order: stable by z then start
        elements = sorted(self.p.get('elements', []), key=lambda e: (e.get('z', 0), e.get('start', 0)))

        for idx, el in enumerate(elements):
            if el.get('visible') is False:
                continue
            # sound clips have no picture: they are mixed by ffmpeg, never drawn
            if el['type'] == 'audio':
                continue
            style = el.get('style') or {}
            z = el.get('z', 0) + idx * 0.001
            st0 = eval_element(el, el['start'], self.meta)
            src_path = self.resolve_src(el.get('src'))
            tex = None

            if el['type'] == 'text':
                obj, nodes = self.build_text(el, style, st0, z)
            elif el['type'] in ('solid', 'shape'):
                obj, nodes = self.build_shape(el, style, st0, z)
            else:
                seq = None
                if el['type'] == 'video':
                    seq_dir = el.get('_sequenceDir')
                    if seq_dir and os.path.isdir(seq_dir):
                        files = sorted(f for f in os.listdir(seq_dir) if f.endswith('.png'))
                        if files:
                            seq = {'first': os.path.join(seq_dir, files[0]), 'count': len(files), 'dir': seq_dir}
                obj, nodes, tex = self.build_media(el, style, st0, z, src_path, seq)

            obj.hide_render = True
            self.updaters.append(self.make_updater(el, obj, nodes, tex, z, style))

        if embed is not None:
            for ob in scene.objects:
                if ob not in before and ob is not embed:
                    ob.parent = embed

        def on_frame(scn, depsgraph=None):
            t = (scn.frame_current - 1) / self.fps
            for u in self.updaters:
                u(t, scn.frame_current)

        bpy.app.handlers.frame_change_pre.append(on_frame)
        on_frame(scene, None)

        if not overlay and embed is None:
            build_compositor(scene, self.meta, os.path.join(self.cache, 'comp'))
        return scene

    def make_updater(self, el, obj, nodes, tex, z, style):
        fps = self.fps
        meta = self.meta
        is_text = el['type'] == 'text'
        glow_max = 1.0 + 6.0 * float((el.get('fx') or {}).get('glow', 0) or 0)
        shadow = bool(style.get('shadow')) and is_text
        shadow_obj = None
        if shadow:
            # a black copy slightly offset behind the text
            sh = bpy.data.objects.new(el['id'] + '_shadow', obj.data.copy())
            sh.location = (obj.location.x + 5, obj.location.y - 5, obj.location.z - 0.0004)
            sh.data.materials.clear()
            smat, _ = flat_material(el['id'] + '_shmat', '#000000', 0.55)
            sh.data.materials.append(smat)
            bpy.context.scene.collection.objects.link(sh)
            sh.hide_render = True
            shadow_obj = sh

        def update(t, frame):
            st = eval_element(el, t, meta)
            if not st['active']:
                obj.hide_render = True
                if shadow_obj:
                    shadow_obj.hide_render = True
                return
            obj.hide_render = False
            obj.location.x = st['x']
            obj.location.y = -st['y']
            # layer offset + the element's own depth (metres -> pixel units)
            obj.location.z = self.layer_px * z + st['z'] * PX_PER_M
            obj.rotation_euler = (0, 0, math.radians(st['rotation']))
            s = st['scale']
            if is_text:
                obj.scale = (s, s, 1)
                try:
                    obj.data.body = str(st['text']) if st['text'] is not None else ''
                    obj.data.size = float(st['size']) * float(obj.get('vdm_em', 1.0))
                    k = float(obj.get('vdm_center_per_size', 0.0))
                    if k:
                        obj.data.offset_x = -k * obj.data.size
                    kv = float(obj.get('vdm_vcenter_per_size', 0.0))
                    if kv:
                        obj.data.offset_y = -kv * obj.data.size
                except Exception:
                    pass
            else:
                obj.scale = (s, s, 1)

            if 'alpha' in nodes:
                nodes['alpha'].default_value = st['opacity']
            if 'em' in nodes:
                nodes['em'].inputs['Strength'].default_value = glow_max
                if is_text:
                    try:
                        nodes['em'].inputs['Color'].default_value = hex_rgba(st['color'])
                    except Exception:
                        pass

            if tex is not None and tex.image and tex.image.source == 'SEQUENCE':
                # Blender reads file number clamp(frame - frame_start + 1, 0, n) + offset;
                # pin frame_start to the current frame so that is exactly the element's
                # local frame (f_<local>.png), holding the last frame past the clip's end.
                count = int(tex.get('vdm_frames', tex.image_user.frame_duration) or 1)
                local = min(count - 1, max(0, int(round((t - el['start']) * fps))))
                tex.image_user.frame_start = frame
                tex.image_user.frame_offset = local - 1

            if shadow_obj:
                shadow_obj.hide_render = False
                shadow_obj.location.x = st['x'] + 5
                shadow_obj.location.y = -st['y'] - 5
                shadow_obj.rotation_euler = (0, 0, math.radians(st['rotation']))
                shadow_obj.scale = (s, s, 1)
                try:
                    shadow_obj.data.body = str(st['text'] or '')
                    shadow_obj.data.size = float(st['size']) * float(obj.get('vdm_em', 1.0))
                    k = float(obj.get('vdm_center_per_size', 0.0))
                    if k:
                        shadow_obj.data.offset_x = -k * shadow_obj.data.size
                    kv = float(obj.get('vdm_vcenter_per_size', 0.0))
                    if kv:
                        shadow_obj.data.offset_y = -kv * shadow_obj.data.size
                except Exception:
                    pass

        return update


def build_scene(project, opts):
    return SceneBuilder(project, opts).build()
