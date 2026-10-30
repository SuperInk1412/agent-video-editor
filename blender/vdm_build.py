# -*- coding: utf-8 -*-
"""
VedioMaker -> Blender scene builder.

Draws the **frame IR** (docs/DESIGN-BACKEND-V2.md §4): the shot package carries
`v3`, the per-frame draw list core/ already evaluated, and this file only turns
those numbers into Blender objects and keys (P2/P3 of §3). No curve, easing,
motion preset, property link, parent chain or SpatialNode placement is sampled
here; `core/frame-ir.js` is the only evaluator.

    a plane's placement is its IR `world` matrix (pixels -> metres), plus
    `depth.bias` and the frozen `drawOrder` along the plane normal
    y axis points DOWN in the project, UP in Blender (we negate it)
    world units == project pixels (orthographic camera, ortho_scale = width)

Everything is built once, then a frame_change_pre handler updates each layer,
so an animation render stays fast.
"""
import bpy
from mathutils import Matrix
import json
import math
import struct
import os
import sys
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


def rgb_rgba(rgb, alpha=1.0):
    """A frame-IR `content.fill` (sRGB 0..1) as linear RGBA — `hex_rgba`'s rule."""
    try:
        values = [clamp(float(rgb[i])) for i in range(3)]
    except (TypeError, ValueError, IndexError, KeyError):
        return hex_rgba('#ffffff', alpha)
    return (srgb_to_linear(values[0]), srgb_to_linear(values[1]), srgb_to_linear(values[2]), alpha)


def color_rgba(value, alpha=1.0):
    """A colour as either `#rrggbb` (project) or an sRGB 0..1 triple (the IR)."""
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return rgb_rgba(value, alpha)
    return hex_rgba(value, alpha)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- shot v3
# The job's frame IR (engine/shot.js::buildShotV3, docs/DESIGN-BACKEND-V2.md
# §4.4 / §10.2 WP1.2): every number a 2D element is drawn with — the plane's
# world matrix, its size, opacity, content numbers, `depth.bias` and the frozen
# `drawOrder` — has already been evaluated by core/. Nothing below samples a
# value curve, an ease, a motion preset, a property link, a parent chain or a
# SpatialNode placement of its own (P2 "evaluate once", P3 "the backend only
# draws" of §3): this file only turns numbers into Blender objects and keys.
#
# The payload arrives beside the legacy fields: `project['v3']` for a 2D job
# (engine/blender.js) and `shot['v3']` for a 3D one. Both have the same shape
# (`{ items: [{ id, span, static, tracks }] }`, engine/element-bake.js packV3),
# so one reader serves every path.
#
# Frames are 1-based render frames (§4.4): render frame `f` is IR frame `f - 1`,
# and `scn.frame_current` is exactly that number — no time is sampled.

# Ordering tie-break along the plane normal, in metres per `drawOrder` step.
# Coplanar layers need a distinct distance for EEVEE's blended sort; one z unit
# of `depth.bias` is 1e-4 m (core/layers.js::LAYER_DEPTH_M), so a tenth of that
# keeps `bias` dominant while still separating equal-depth layers.
DEPTH_ORDER_M = 1e-5


def _num(value, default=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _deep(value):
    """A JSON-shaped deep copy (the frame value starts from `record.static`)."""
    if isinstance(value, dict):
        return {key: _deep(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_deep(item) for item in value]
    return value


def _path_key(node, part):
    """`"12"` indexes a list, everything else keys a dict (the JS reader's rule)."""
    return int(part) if isinstance(node, list) and part.isdigit() else part


def _path_get(node, key):
    try:
        return node[key]
    except (IndexError, KeyError, TypeError):
        return None


def v3_set_path(target, path, value):
    """Write `value` at a dotted path (engine/element-bake.js::setV3Path)."""
    parts = str(path).split('.')
    cur = target
    for i in range(len(parts) - 1):
        key = _path_key(cur, parts[i])
        nxt = _path_get(cur, key)
        if not isinstance(nxt, (dict, list)):
            nxt = [] if parts[i + 1].isdigit() else {}
            cur[key] = nxt
        cur = nxt
    key = _path_key(cur, parts[-1])
    if isinstance(cur, list) and isinstance(key, int) and key >= len(cur):
        cur.extend([None] * (key + 1 - len(cur)))
    cur[key] = value
    return target


def v3_unpack(record, frame):
    """One frame's value of a v3 record, or None when the frame is outside its span."""
    try:
        f = int(round(float(frame)))
        first, last = record['span']
    except (KeyError, TypeError, ValueError):
        return None
    if not (first <= f <= last):
        return None
    out = _deep(record.get('static') or {})
    for path, track in (record.get('tracks') or {}).items():
        if not isinstance(track, dict):
            continue
        try:
            index = f - int(track.get('f0'))
        except (TypeError, ValueError):
            continue
        values = track.get('values') or []
        if 0 <= index < len(values):
            v3_set_path(out, path, values[index])
    return out


class ShotV3:
    """The job's frame IR, read per frame: `item(id, frame)` -> draw item or None.

    Records are kept per id (an element that leaves the picture and comes back
    has one record per run), so a lookup is a handful of span checks.
    """

    def __init__(self, payload):
        self.payload = payload if isinstance(payload, dict) else None
        self.records = {}
        self.spans = {}
        # Text geometry (§4.4 v4, WP1.3): the package carries the glyph meshes
        # core/glyphs.js triangulated, once per mesh id; an item only says which
        # one it draws. This side never typesets and needs no font file.
        self.meshes = (self.payload or {}).get('meshes') or {}
        # Code layers (§6.1, WP3.4): `engine/raster-bake.js` rendered every
        # `raster` item's frames through the one rasteriser (§5) and wrote down
        # where the image sequence of each item lives. This side only samples
        # it — no user code runs in Blender.
        self.rasters = (self.payload or {}).get('rasters') or {}
        for record in (self.payload or {}).get('items') or []:
            ident = record.get('id') if isinstance(record, dict) else None
            if not isinstance(ident, str):
                continue
            self.records.setdefault(ident, []).append(record)
            span = record.get('span') or [0, 0]
            try:
                a, b = int(span[0]), int(span[1])
            except (TypeError, ValueError, IndexError):
                continue
            cur = self.spans.get(ident)
            self.spans[ident] = [min(cur[0], a), max(cur[1], b)] if cur else [a, b]

    def __bool__(self):
        return self.payload is not None

    def first_frame(self, ident):
        """First render frame `ident` draws in this job, or None when it never does."""
        span = self.spans.get(ident)
        return span[0] if span else None

    def item(self, ident, frame):
        for record in self.records.get(ident) or []:
            value = v3_unpack(record, frame)
            if value is not None:
                return value
        return None

    def mesh_ids(self, ident):
        """Mesh ids a text item can draw over its whole span (content.mesh)."""
        found = []
        for record in self.records.get(ident) or []:
            if not isinstance(record, dict):
                continue
            static = (record.get('static') or {}).get('content') or {}
            mid = static.get('mesh')
            if isinstance(mid, str) and mid not in found:
                found.append(mid)
            track = (record.get('tracks') or {}).get('content.mesh')
            if isinstance(track, dict):
                for value in track.get('values') or []:
                    if isinstance(value, str) and value not in found:
                        found.append(value)
        return [mid for mid in found if isinstance(self.meshes.get(mid), dict)]

    def raster(self, ident):
        """The baked image sequence of a code layer, or None (WP3.4).

        The description is `engine/raster-bake.js`'s: `dir` holds
        `f_00000.png ... f_<count-1>.png`, `from` is the first IR frame it
        covers (0 based, `core/frame-ir.js` numbering) and `pattern` is the file
        name template. A job rendered without the pool (no Electron) has no
        entry here; the layer then draws nothing, like the preview while its
        PNG is missing.
        """
        entry = self.rasters.get(ident) if isinstance(self.rasters, dict) else None
        return entry if isinstance(entry, dict) else None


def load_shot_v3(project, opts=None):
    """The v3 payload of this job: `project['v3']`, else the 3D shot's own copy."""
    payload = project.get('v3') if isinstance(project, dict) else None
    if isinstance(payload, dict):
        return payload
    shot_path = (opts or {}).get('shot')
    if shot_path and os.path.exists(shot_path):
        try:
            with open(shot_path, 'r', encoding='utf-8') as handle:
                shot = json.load(handle)
        except (OSError, ValueError):
            return None
        payload = shot.get('v3') if isinstance(shot, dict) else None
        if isinstance(payload, dict):
            return payload
    return None


def v3_build_inputs(el, item):
    """`(numbers, style)` of one IR item, in the shape the builders read.

    Everything that can change per frame is IR data (`content.text`,
    `content.fontSize`, `content.color`, the quad `size`, `content.fill`,
    `content.uv`, `content.fit`, the text layout). Only the font *file* is
    authored data: `style.font` / `style.fontPath`, which is not a number.
    """
    content = (item or {}).get('content') or {}
    style = dict(el.get('style') or {})
    for key in ('fit', 'font', 'align', 'lineHeight', 'letterSpacing', 'shadow',
                'stroke', 'strokeWidth'):
        if content.get(key) is not None:
            style[key] = content[key]
    if content.get('ellipse'):
        style['shape'] = 'ellipse'
    quad = (item or {}).get('size')
    if isinstance(quad, (list, tuple)) and len(quad) >= 2:
        style['w'] = quad[0]
        style['h'] = quad[1]
    state = {
        'active': True,
        'opacity': _num((item or {}).get('opacity'), 0.0),
        'glow': _num(content.get('glow'), 0.0),
        'text': content.get('text', ''),
        'size': _num(content.get('fontSize'), 96.0),
        'color': content.get('color') or '#ffffff',
        'fill': content.get('fill'),
        'uv': content.get('uv'),
        'quad': quad,
    }
    return state, style


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
    em.inputs['Color'].default_value = color_rgba(color)
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


def build_compositor(scene, meta, cache_dir, fog=None, overlay=None, backdrop=None, planes=None):
    """Post chain for `scene`. `overlay` is an optional transparent scene (the
    2D layer of a 3D shot) alpha-overed after the fog and before the post fx.
    `backdrop` (linear RGB) is for a transparent film (the empty world): fog only
    touches rendered pixels, then the picture goes over this flat colour, the
    same as the viewport's clear colour. `planes` names the view layer that
    holds the 2D element planes (the 3D world as holdout): it goes over the
    fogged world, so the planes are never fogged — as in the viewport, where
    only 3D objects get fog."""
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

    if planes is not None:
        prl = ng.nodes.new('CompositorNodeRLayers')
        try:
            prl.scene = scene
            prl.layer = planes
        except Exception:
            pass
        pover = ng.nodes.new('CompositorNodeAlphaOver')
        ng.links.new(chain, pover.inputs['Background'])
        ng.links.new(prl.outputs['Image'], pover.inputs['Foreground'])
        chain = pover.outputs[0]

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

FEED_OVERSCAN_PX = 8.0  # project pixels a camfeed plane reaches past each frame edge


def feed_frame_path(el, frame):
    """Source frame file a camfeed element shows at `frame`, or None when hidden."""
    feed = el.get('feed') or {}
    folder = el.get('_feedDir') or ''
    if not folder:
        return None
    for a, b in el.get('_feedHidden') or []:
        if a <= frame <= b:
            return None
    n = int(frame) - (1 if int(feed.get('delay') or 0) == 1 else 0)
    path = os.path.join(folder, 'f_%04d.png' % n)
    return path if os.path.exists(path) else None


def show_feed_frame(el, obj, tex, frame):
    path = feed_frame_path(el, frame)
    if path is None:
        obj.hide_render = True
        return
    img = tex.image
    if img.source != 'FILE' or bpy.path.abspath(img.filepath) != path:
        img.source = 'FILE'
        img.filepath = path
    img.reload()


def raster_sequence(entry):
    """The image sequence of a baked code layer, as `build_media` wants it.

    `entry` is one item of `v3['rasters']` (engine/raster-bake.js): `dir` holds
    `f_00000.png ... f_<count-1>.png`, `pattern` is the name template and
    `frameOffset` is the index of the first file. A missing directory or a
    count without its first file means the bake did not happen: the caller then
    leaves the layer out instead of drawing a placeholder over other layers.
    """
    if not isinstance(entry, dict):
        return None
    folder = entry.get('dir') or ''
    pattern = str(entry.get('pattern') or 'f_%05d.png')
    try:
        count = int(entry.get('count') or 0)
        first_index = int(entry.get('frameOffset') or 0)
    except (TypeError, ValueError):
        return None
    if not folder or count <= 0:
        return None
    try:
        first = os.path.join(folder, pattern % first_index)
    except (TypeError, ValueError):
        return None
    if not os.path.exists(first):
        return None
    return {'first': first, 'count': count, 'dir': folder}


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
        # The frame IR of this job: every number drawn below comes from here
        # (WP1.2). Without it there is nothing to draw — the Python evaluator
        # that used to read the project is gone on purpose.
        self.v3 = ShotV3(load_shot_v3(project, opts))
        if not self.v3:
            raise RuntimeError(
                'vdm_build: the job carries no shot v3 payload — render through '
                'engine/blender.js (WP1.2 draws the frame IR, not the project)')
        self.units_per_m = PX_PER_M
        self.y_shift = 0.0
        self.embed = False

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

    def build_text(self, el, style, st0):
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

    def build_text_mesh(self, el, style, st0, mesh):
        """One text mesh from the IR's glyph triangles (§4.4 v4, WP1.3).

        `mesh.vertices` are quad-local project pixels, origin top-left, y down
        (core/glyphs.js); Blender's pixel scene has y up and its origin at the
        quad centre, so a vertex becomes `(x - w/2, h/2 - y)`. The quad's world
        placement comes from `item_matrix`, exactly like a textured plane, which
        is what makes preview and Blender draw the same picture.
        """
        size = mesh.get('size') or [1, 1]
        w = _num(size[0], 1.0) or 1.0
        h = _num(size[1], 1.0) or 1.0
        verts = mesh.get('vertices') or []
        idx = mesh.get('indices') or []
        points = []
        for i in range(0, len(verts) - 1, 2):
            points.append((_num(verts[i]) - w / 2.0, h / 2.0 - _num(verts[i + 1]), 0.0))
        faces = []
        for i in range(0, len(idx) - 2, 3):
            faces.append((int(idx[i]), int(idx[i + 1]), int(idx[i + 2])))
        me = bpy.data.meshes.new(f"{el['id']}_mesh")
        if points and faces:
            me.from_pydata(points, [], faces)
        me.update()
        # Colour and opacity come from the item's content (`st0`), not from the
        # mesh record: the mesh id leaves colour out of its key, so a colour
        # change keeps the same triangles and must still repaint. `mesh.color`
        # is only the snapshot the mesh was first built with.
        color = st0.get('color')
        mat, nodes = flat_material(f"{el['id']}_mat", color, st0['opacity'])
        obj = self.add_object(me, mat, el['id'])
        return obj, nodes

    def build_media(self, el, style, st0, src_path, sequence=None, uv=None):
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
            return obj, nodes, None

        # `content.uv` is the IR's image-space rect (null until the project knows
        # the media's intrinsic size); otherwise the IR's `mediaUVOf` rule applies.
        # A caller may pin the rect: a code layer's raster fills its quad exactly
        # (`[0, 0, 1, 1]`, the preview's rule in preview.js, WP3.4).
        rect = uv if (isinstance(uv, (list, tuple)) and len(uv) == 4) else st0.get('uv')
        if not (isinstance(rect, (list, tuple)) and len(rect) == 4):
            fit = style.get('fit', 'cover')
            if img.size[0] and img.size[1]:
                rect = (0, 0, 1, 1) if fit == 'stretch' else cover_uv(img.size[0], img.size[1], self.W, self.H)
            else:
                rect = (0, 0, 1, 1)
        mesh = plane_mesh(f'{el["id"]}_mesh', self.W, self.H, rect)
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
        return obj, nodes, nodes['tex']

    def build_feed(self, el, style, st0):
        # Camera feed (engine/camfeed-render.js): a full-frame plane whose image
        # is swapped every frame for f_<frame - delay>.png of the source pass.
        img = bpy.data.images.new(f'{el["id"]}_feed', 4, 4, alpha=True)
        # Overscan: the plane reaches a few pixels past the frame with the edge
        # texels extended, so the pixel filter at the border never mixes in the
        # background (a full-frame feed would otherwise get a dark rim).
        m = FEED_OVERSCAN_PX
        mesh = plane_mesh(f'{el["id"]}_mesh', self.W + 2 * m, self.H + 2 * m,
                          (-m / self.W, -m / self.H, 1 + m / self.W, 1 + m / self.H))
        mat, nodes = textured_material(f'{el["id"]}_mat', img, st0['opacity'])
        nodes['tex'].extension = 'EXTEND'
        obj = self.add_object(mesh, mat, el['id'])
        nodes['tex']['vdm_feed'] = 1
        return obj, nodes, nodes['tex']

    def build_shape(self, el, style, st0):
        w = float(style.get('w') or self.W)
        h = float(style.get('h') or self.H)
        kind = style.get('shape', 'rect')
        mesh = disc_mesh(f'{el["id"]}_mesh', w, h) if kind == 'ellipse' else plane_mesh(f'{el["id"]}_mesh', w, h)
        # the IR's `content.fill` (sRGB triple) wins; the project's hex is the fallback
        fill = st0.get('fill') or style.get('fill', '#ffffff')
        mat, nodes = flat_material(f'{el["id"]}_mat', st0['color'] if el['type'] == 'text' else fill, st0['opacity'])
        obj = self.add_object(mesh, mat, el['id'])
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
        # Scene units. Embedded in a 3D scene the units are metres — the IR's own
        # unit — so `world` is used as is. A standalone / overlay build is a
        # pixel canvas (the ortho camera spans `width` units, the old screen rig
        # was 100 px per metre), so `world` is scaled by PX_PER_M and the screen
        # centre (half the picture height) becomes the origin.
        self.embed = embed is not None
        self.units_per_m = 1.0 if self.embed else PX_PER_M
        self.y_shift = 0.0 if self.embed else -(self.H / 2.0)
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
        # Stacking is the IR's job (`depth.bias` + `drawOrder`); this order only
        # decides in which order the objects are created. `sorted` keeps the
        # creation sequence stable under a shuffled input.
        elements = sorted(self.p.get('elements', []), key=lambda e: (e.get('z', 0), e.get('start', 0)))

        for el in elements:
            if el.get('visible') is False:
                continue
            # sound clips have no picture: they are mixed by ffmpeg, never drawn
            if el['type'] == 'audio':
                continue
            style = el.get('style') or {}
            # Only elements the IR draws inside this job get an object, and its
            # first drawn frame has every number the build needs.
            first = self.v3.first_frame(el.get('id'))
            if first is None:
                continue
            st0, style = v3_build_inputs(el, self.v3.item(el.get('id'), first))
            src_path = self.resolve_src(el.get('src'))
            tex = None
            raster = None

            if el['type'] == 'text':
                # v4: the frame IR carries the glyph mesh (§4.4, WP1.3), so the
                # text is a plain mesh built from those vertices. The text an
                # element shows can change over its span (typing), so every mesh
                # id it uses gets an object and the updater shows the right one.
                meshes = self.v3.mesh_ids(el.get('id'))
                if meshes:
                    built = {}
                    for mid in meshes:
                        obj, nodes = self.build_text_mesh(el, style, st0, self.v3.meshes[mid])
                        obj.hide_render = True
                        built[mid] = (obj, nodes)
                    self.updaters.append(self._v3_update_text_mesh(el, built, style))
                    continue
                # no mesh (no font on the JS side, shadow/stroke): the pre-v4
                # FONT curve, typeset by Blender
                obj, nodes = self.build_text(el, style, st0)
            elif el['type'] == 'camfeed':
                obj, nodes, tex = self.build_feed(el, style, st0)
            elif el['type'] in ('solid', 'shape'):
                obj, nodes = self.build_shape(el, style, st0)
            elif el['type'] == 'code':
                # A code layer (§6.1, WP3.4): one raster of the shared pool per
                # frame, baked by engine/raster-bake.js and handed over as an
                # image sequence — the video plane path, painted with
                # `content.size` rasters onto the item's own quad. Without a
                # sequence (no Electron, a failing sketch) the layer draws
                # nothing, exactly like the preview before its PNG arrives.
                raster = self.v3.raster(el.get('id'))
                seq = raster_sequence(raster) if raster else None
                if seq is None:
                    sys.stderr.write(f'VDM_RASTER fallback: {el.get("id")} has no baked sequence\n')
                    sys.stderr.flush()
                    continue
                obj, nodes, tex = self.build_media(el, style, st0, None, seq, uv=(0, 0, 1, 1))
            else:
                seq = None
                if el['type'] == 'video':
                    seq_dir = el.get('_sequenceDir')
                    if seq_dir and os.path.isdir(seq_dir):
                        files = sorted(f for f in os.listdir(seq_dir) if f.endswith('.png'))
                        if files:
                            seq = {'first': os.path.join(seq_dir, files[0]), 'count': len(files), 'dir': seq_dir}
                obj, nodes, tex = self.build_media(el, style, st0, src_path, seq)

            obj.hide_render = True
            self.updaters.append(self.make_updater(el, obj, nodes, tex, style, raster))

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

    # -- per frame ---------------------------------------------------------
    def make_updater(self, el, obj, nodes, tex, style, raster=None):
        return self._v3_update(el, obj, nodes, tex, style, raster)

    def _v3_update_text_mesh(self, el, objects, style):
        """Per-frame Blender state of a text drawn as IR meshes.

        One object per mesh id the element uses over its span; the item of the
        frame says which one is on screen. No curve, no `body`, no typesetting:
        the vertices came from core/glyphs.js and only the placement, the colour
        and the alpha change here.
        """
        identity = Matrix.Identity(4)

        def update(t, frame):
            item = self.v3.item(el['id'], frame)
            if item is None:
                for obj, _nodes in objects.values():
                    obj.hide_render = True
                return
            content = item.get('content') or {}
            mid = content.get('mesh')
            matrix = self.item_matrix(item)
            opacity = _num(item.get('opacity'), 0.0)
            for key, (obj, nodes) in objects.items():
                show = key == mid
                obj.hide_render = not show
                if not show:
                    continue
                if matrix is not None:
                    parent = obj.parent.matrix_basis if obj.parent else identity
                    obj.matrix_basis = parent.inverted() @ matrix
                if 'alpha' in nodes:
                    nodes['alpha'].default_value = opacity
                if 'em' in nodes:
                    nodes['em'].inputs['Strength'].default_value = 1.0 + 6.0 * _num(content.get('glow'), 0.0)

        return update

    def _make_shadow(self, el, obj):
        """A black copy slightly offset behind the text."""
        sh = bpy.data.objects.new(el['id'] + '_shadow', obj.data.copy())
        sh.data.materials.clear()
        smat, _ = flat_material(el['id'] + '_shmat', '#000000', 0.55)
        sh.data.materials.append(smat)
        bpy.context.scene.collection.objects.link(sh)
        sh.hide_render = True
        return sh

    def item_matrix(self, item):
        """Blender matrix of one IR item: `world`, `depth.bias` and `drawOrder`.

        `world` (core/frame-ir.js) is column-major and maps quad-local project
        pixels to world metres; the meshes here are built in project pixels, so
        a pixel scene multiplies by PX_PER_M and the metres scene does not.
        `depth.bias` is pushed along the plane normal — the same hair of
        separation `itemModelMatrix()` gives the preview — and the frozen
        `drawOrder` adds a tenth of it on top so EEVEE's blended sort follows
        the IR's order for layers sitting on one plane.
        """
        world = item.get('world')
        if not isinstance(world, (list, tuple)) or len(world) < 16:
            return None
        u = self.units_per_m
        m = [_num(v) for v in world[:16]]
        rows = [
            [m[0] * u, m[4] * u, m[8] * u, m[12] * u],
            [m[1] * u, m[5] * u, m[9] * u, m[13] * u + self.y_shift],
            [m[2] * u, m[6] * u, m[10] * u, m[14] * u],
            [0.0, 0.0, 0.0, 1.0],
        ]
        depth = item.get('depth') or {}
        offset = (_num(depth.get('bias')) + DEPTH_ORDER_M * _num(item.get('drawOrder'))) * u
        normal = [rows[0][2], rows[1][2], rows[2][2]]
        length = math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2)
        normal = [v / length for v in normal] if length > 1e-12 else [0.0, 0.0, 1.0]
        for axis in range(3):
            rows[axis][3] += normal[axis] * offset
        return Matrix(rows)

    def _v3_update(self, el, obj, nodes, tex, style, raster=None):
        """Per-frame Blender keys from the frame IR numbers of this element."""
        fps = self.fps
        is_text = el['type'] == 'text'
        shadow_obj = self._make_shadow(el, obj) if (bool(style.get('shadow')) and is_text) else None
        identity = Matrix.Identity(4)

        def hide():
            obj.hide_render = True
            if shadow_obj:
                shadow_obj.hide_render = True

        def update(t, frame):
            item = self.v3.item(el['id'], frame)
            if item is None:
                # The IR does not draw this element on this frame: no curve, no
                # time range, no fade and no link test happens here.
                hide()
                return
            content = item.get('content') or {}
            matrix = self.item_matrix(item)
            obj.hide_render = False
            if matrix is not None:
                # Relative to the screen rig without waiting for a depsgraph
                # update (a just-built parent's matrix_world is still stale).
                parent = obj.parent.matrix_basis if obj.parent else identity
                obj.matrix_basis = parent.inverted() @ matrix
            opacity = _num(item.get('opacity'), 0.0)
            if is_text:
                try:
                    obj.data.body = '' if content.get('text') is None else str(content.get('text'))
                    obj.data.size = _num(content.get('fontSize'), 96.0) * float(obj.get('vdm_em', 1.0))
                    k = float(obj.get('vdm_center_per_size', 0.0))
                    if k:
                        obj.data.offset_x = -k * obj.data.size
                    kv = float(obj.get('vdm_vcenter_per_size', 0.0))
                    if kv:
                        obj.data.offset_y = -kv * obj.data.size
                except Exception:
                    pass

            if 'alpha' in nodes:
                nodes['alpha'].default_value = opacity
            if 'em' in nodes:
                nodes['em'].inputs['Strength'].default_value = 1.0 + 6.0 * _num(content.get('glow'), 0.0)
                if is_text:
                    try:
                        nodes['em'].inputs['Color'].default_value = hex_rgba(content.get('color') or '#ffffff')
                    except Exception:
                        pass

            if el['type'] == 'camfeed' and tex is not None:
                show_feed_frame(el, obj, tex, frame)

            if tex is not None and tex.image and tex.image.source == 'SEQUENCE':
                # Blender reads file number clamp(frame - frame_start + 1, 0, n) + offset;
                # pin frame_start to the current frame so that is exactly the element's
                # local frame (f_<local>.png), holding the last frame past the clip's end.
                count = int(tex.get('vdm_frames', tex.image_user.frame_duration) or 1)
                if raster:
                    # A code layer is one raster per IR frame (WP3.4): the file
                    # index is the project's own frame minus the sequence start
                    # (`from`, 0 based, engine/raster-bake.js) — never the
                    # element's local time. A missing mid-sequence frame was
                    # already replaced by its predecessor when the frames were
                    # staged, so this clamp only guards the two ends.
                    local = int(round(frame)) - 1 - int(raster.get('from') or 0) + int(raster.get('frameOffset') or 0)
                    local = min(count - 1, max(0, local))
                else:
                    local = min(count - 1, max(0, int(round((t - el['start']) * fps))))
                tex.image_user.frame_start = frame
                tex.image_user.frame_offset = local - 1

            if shadow_obj:
                shadow_obj.hide_render = False
                if matrix is not None:
                    # the shadow rides the same plane, offset in its own pixels
                    shadow_obj.matrix_basis = obj.matrix_basis @ Matrix.Translation((5.0, -5.0, -0.0004))
                try:
                    shadow_obj.data.body = str(content.get('text') or '')
                    shadow_obj.data.size = obj.data.size
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
