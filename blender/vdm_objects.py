# -*- coding: utf-8 -*-
"""Image / video planes and 3D text for the 3D shot path (vdm_city.py).

The bake (engine/shot.js::bakeObjects) already carries the world pose per frame;
this module only builds the geometry/material and places it. fit_plane() and the
sequence frame mapping mirror core/objects-media.js — keep them in step.

Orientation: the bake's basis is (right, up, forward) with the front facing
`forward`. A plane must read unmirrored from the front, so its Blender local
axes are X = -right, Y = up, Z = forward (a proper rotation).
"""
import os
import struct

import bpy
from mathutils import Matrix, Vector

from vdm_build import plane_mesh, textured_material, flat_material, resolve_font

FITS = ('contain', 'cover', 'stretch')


def fit_plane(fit, img_w, img_h, w, h, uv=(0.0, 0.0, 1.0, 1.0)):
    """Same as core/objects-media.js::fitPlane -> (quad_w, quad_h, (u0, v0, u1, v1))."""
    u0, v0, u1, v1 = uv
    if fit == 'stretch' or not img_w or not img_h:
        return w, h, (u0, v0, u1, v1)
    cw = max(1e-6, img_w * (u1 - u0))
    ch = max(1e-6, img_h * (v1 - v0))
    pic = cw / ch
    frame = w / h
    if fit == 'cover':
        if pic > frame:
            keep = (u1 - u0) * (frame / pic)
            mid = (u0 + u1) / 2.0
            return w, h, (mid - keep / 2.0, v0, mid + keep / 2.0, v1)
        keep = (v1 - v0) * (pic / frame)
        mid = (v0 + v1) / 2.0
        return w, h, (u0, mid - keep / 2.0, u1, mid + keep / 2.0)
    if pic > frame:
        return w, w / pic, (u0, v0, u1, v1)
    return h * pic, h, (u0, v0, u1, v1)


def _png_size(path):
    """(w, h) from a PNG header; image sequences report size (0, 0) until loaded."""
    try:
        with open(path, 'rb') as f:
            head = f.read(24)
        if head[1:4] == b'PNG':
            return struct.unpack('>II', head[16:24])
    except OSError:
        pass
    return 0, 0


def _font_bbox_em(path):
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


def _resolve(root, src):
    if not src:
        return None
    if os.path.isabs(src):
        return src
    return os.path.normpath(os.path.join(root or '', src))


def _rotation(rot):
    right, up, fwd = (Vector(v) for v in rot)
    m = Matrix(((-right[0], up[0], fwd[0]),
                (-right[1], up[1], fwd[1]),
                (-right[2], up[2], fwd[2])))
    return m.to_quaternion()


def _font_path(root, font):
    if font and (('/' in font) or ('\\' in font) or os.path.splitext(font)[1].lower() in ('.ttf', '.otf', '.ttc')):
        p = _resolve(root, font)
        if p and os.path.exists(p):
            return p
    return resolve_font({'font': font or 'SimHei'})


def _build_plane(o, root):
    m = o['media']
    oid = str(o.get('id'))
    seq = m.get('sequence') or None
    img = None
    count = 0
    if o.get('type') == 'video' and seq and os.path.isdir(seq.get('dir') or ''):
        files = sorted(f for f in os.listdir(seq['dir']) if f.endswith('.png'))
        if files:
            img = bpy.data.images.load(os.path.join(seq['dir'], files[0]), check_existing=True)
            img.source = 'SEQUENCE'
            count = len(files)
    elif o.get('type') == 'image':
        p = _resolve(root, m.get('src'))
        if p and os.path.exists(p):
            img = bpy.data.images.load(p, check_existing=True)

    w, h = float(m.get('w') or 2), float(m.get('h') or 2)
    if img is None:
        # missing asset -> magenta placeholder so it is obvious in the render
        mesh = plane_mesh('pl_' + oid, 1.0, 1.0)
        mat, nodes = flat_material('plmat_' + oid, '#ff00aa', 1.0)
        return mesh, mat, nodes, (w, h), None, 0

    iw, ih = img.size[0], img.size[1]
    if not iw or not ih:
        iw, ih = _png_size(bpy.path.abspath(img.filepath))
    qw, qh, uv = fit_plane(m.get('fit', 'contain'), iw, ih, w, h, tuple(m.get('uv') or (0, 0, 1, 1)))
    mesh = plane_mesh('pl_' + oid, 1.0, 1.0, uv)
    mat, nodes = textured_material('plmat_' + oid, img, 1.0)
    try:
        nodes['em'].inputs['Strength'].default_value = float(m.get('emissive', 1.0))
    except Exception:
        pass
    tex = None
    if count:
        tex = nodes['tex']
        iu = tex.image_user
        iu.frame_duration = count
        iu.frame_start = 1
        iu.frame_offset = 0
        iu.use_cyclic = False
        iu.use_auto_refresh = True
    return mesh, mat, nodes, (qw, qh), tex, count


def _build_text(o, root):
    s = o['text']
    oid = str(o.get('id'))
    cu = bpy.data.curves.new('tx_' + oid, 'FONT')
    cu.body = str(s.get('text') or ' ')
    fp = _font_path(root, s.get('font'))
    bbox_em = _font_bbox_em(fp) if fp else 1.0
    cu.size = float(s.get('size') or 1.0) * bbox_em
    # Line pitch is space_line × cu.size (bbox-sized), so divide back to em.
    cu.space_line = max(0.05, float(s.get('lineHeight') or 1.2) / bbox_em)
    # space_character scales the glyph advance; tracking is extra em per letter (approximate).
    cu.space_character = max(0.0, 1.0 + float(s.get('tracking') or 0.0))
    cu.align_x = {'left': 'LEFT', 'right': 'RIGHT'}.get(s.get('align', 'center'), 'CENTER')
    cu.align_y = 'CENTER'
    cu.extrude = max(0.0, float(s.get('extrude') or 0.0)) / 2.0
    if fp:
        try:
            cu.font = bpy.data.fonts.load(fp, check_existing=True)
        except Exception:
            pass
    mat, nodes = flat_material('txmat_' + oid, s.get('color') or '#ffffff', 1.0)
    try:
        nodes['em'].inputs['Strength'].default_value = float(s.get('emissive', 1.0))
    except Exception:
        pass
    return cu, mat, nodes


def build_media_object(scene, o, root, updaters):
    """Build one image/video/text object and key its baked frames.

    Video planes append an updater(frame) that selects the sequence frame; the
    caller runs those from a frame_change_pre handler.
    """
    frames = o.get('frames') or []
    if not frames:
        return None
    name = str(o.get('name') or o.get('id'))
    if o.get('text'):
        data, mat, nodes = _build_text(o, root)
        quad, tex, count = (1.0, 1.0), None, 0
    else:
        data, mat, nodes, quad, tex, count = _build_plane(o, root)
    obj = bpy.data.objects.new(name, data)
    obj.rotation_mode = 'QUATERNION'
    obj.data.materials.append(mat)
    obj.visible_shadow = False
    scene.collection.objects.link(obj)

    alpha = nodes.get('alpha') if isinstance(nodes, dict) else None
    animated_alpha = alpha is not None and min(float(f.get('opacity', 1.0)) for f in frames) < 0.999
    for f in frames:
        fr = int(f['f'])
        obj.location = Vector(f['loc'])
        obj.rotation_quaternion = _rotation(f['rot'])
        sx, sy, sz = f['size']
        obj.scale = Vector((sx * quad[0], sy * quad[1], sz))
        obj.keyframe_insert('location', frame=fr)
        obj.keyframe_insert('rotation_quaternion', frame=fr)
        obj.keyframe_insert('scale', frame=fr)
        if animated_alpha:
            alpha.default_value = float(f.get('opacity', 1.0))
            alpha.keyframe_insert('default_value', frame=fr)

    if tex is not None and count:
        vf = {int(f['f']): int(f.get('vf', 1)) for f in frames}

        def update(frame, tex=tex, vf=vf, count=count):
            # file number = clamp(frame - frame_start + 1, 0, n) + offset; pin
            # frame_start to the current frame so the file is exactly f_<vf>.png
            want = min(count, max(1, vf.get(frame, 1)))
            tex.image_user.frame_start = frame
            tex.image_user.frame_offset = want - 1

        updaters.append(update)
    return obj


def install_updaters(scene, updaters):
    if not updaters:
        return

    def on_frame(scn, depsgraph=None):
        for u in updaters:
            u(scn.frame_current)

    bpy.app.handlers.frame_change_pre.append(on_frame)
    on_frame(scene)
