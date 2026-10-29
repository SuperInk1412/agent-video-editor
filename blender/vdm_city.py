# -*- coding: utf-8 -*-
"""
VedioMaker 3D shot builder.

Consumes the baked shot package (engine/shot.js) — city geometry + per-frame camera —
so Blender and the WebGL viewport show exactly the same world and move the same way.

Coordinate system: metres, y up, ground at y=0, camera looks at `look`.
"""
import bpy
import json
import math
import os
from mathutils import Matrix, Vector, Quaternion

from vdm_build import (
    reset_scene, hex_rgba, build_compositor, set_menu, srgb_to_linear, SceneBuilder,
)


# ---------------------------------------------------------------- geometry

def _add_box(verts, faces, uvs, colors, seeds, x, y, z, w, h, d, color, seed):
    """Append a box (base at y, centred on x/z) with metre-scale UVs per face."""
    hw, hd = w / 2.0, d / 2.0
    i0 = len(verts)
    # 0..3 bottom (y), 4..7 top (y+h)
    verts.extend([
        (x - hw, y, z - hd), (x + hw, y, z - hd), (x + hw, y, z + hd), (x - hw, y, z + hd),
        (x - hw, y + h, z - hd), (x + hw, y + h, z - hd), (x + hw, y + h, z + hd), (x - hw, y + h, z + hd),
    ])
    quads = [
        (0, 1, 2, 3),  # bottom
        (4, 7, 6, 5),  # top
        (0, 4, 5, 1),  # -z
        (2, 6, 7, 3),  # +z
        (3, 7, 4, 0),  # -x
        (1, 5, 6, 2),  # +x
    ]
    for q in quads:
        faces.append(tuple(i0 + i for i in q))
        colors.extend([color] * 4)
        seeds.extend([seed] * 4)
    # uv per face in metres: u = horizontal, v = height (matches each loop order)
    uvs.extend([(0, 0), (w, 0), (w, d), (0, d)])                 # bottom (0,1,2,3)
    uvs.extend([(0, 0), (0, d), (w, d), (w, 0)])                 # top    (4,7,6,5)
    uvs.extend([(0, 0), (0, h), (w, h), (w, 0)])                 # -z     (0,4,5,1)
    uvs.extend([(0, 0), (0, h), (w, h), (w, 0)])                 # +z     (2,6,7,3)
    uvs.extend([(0, 0), (0, h), (d, h), (d, 0)])                 # -x     (3,7,4,0)
    uvs.extend([(0, 0), (0, h), (d, h), (d, 0)])                 # +x     (1,5,6,2)


def _mesh_from(verts, faces, uvs, colors, seeds, name):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    uv = mesh.uv_layers.new(name='UVMap')
    for i, (u, v) in enumerate(uvs):
        if i < len(uv.data):
            uv.data[i].uv = (u, v)
    col = mesh.color_attributes.new(name='tint', type='FLOAT_COLOR', domain='CORNER')
    for i, c in enumerate(colors):
        if i < len(col.data):
            col.data[i].color = (c[0], c[1], c[2], 1.0)
    sd = mesh.attributes.new(name='seed', type='FLOAT', domain='CORNER')
    for i, s in enumerate(seeds):
        if i < len(sd.data):
            sd.data[i].value = s
    return mesh


# ---------------------------------------------------------------- materials

def _window_material(name, city):
    """Dark facade + scattered lit windows (cool/warm mix). Emission stays <=1 so
    bloom in the compositor creates the glow instead of clipping to white."""
    win = city.get('window', {})
    cell_u, cell_v = 2.6, 3.4
    margin = 0.30
    lit = max(0.02, min(1.0, float(win.get('density', 0.22))))
    glow = float(win.get('glow', 1.2))
    wcol = win.get('color', [0.62, 0.9, 1.0])

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Roughness'].default_value = 0.6
    bsdf.inputs['Metallic'].default_value = 0.35
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])

    # ---- facade material ----
    tint = nt.nodes.new('ShaderNodeAttribute'); tint.attribute_name = 'tint'
    nt.links.new(tint.outputs['Color'], bsdf.inputs['Base Color'])

    # ---- window grid: uv (metres) -> cell space ----
    uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    cell = nt.nodes.new('ShaderNodeVectorMath'); cell.operation = 'DIVIDE'
    cell.inputs[1].default_value = (cell_u, cell_v, 1.0)
    nt.links.new(uv.outputs[0], cell.inputs[0])

    frac = nt.nodes.new('ShaderNodeVectorMath'); frac.operation = 'FRACTION'
    nt.links.new(cell.outputs[0], frac.inputs[0])
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(frac.outputs[0], sep.inputs[0])

    def band(x):
        a = nt.nodes.new('ShaderNodeMath'); a.operation = 'GREATER_THAN'; a.inputs[1].default_value = margin
        b = nt.nodes.new('ShaderNodeMath'); b.operation = 'LESS_THAN'; b.inputs[1].default_value = 1.0 - margin
        nt.links.new(x, a.inputs[0]); nt.links.new(x, b.inputs[0])
        m = nt.nodes.new('ShaderNodeMath'); m.operation = 'MULTIPLY'
        nt.links.new(a.outputs[0], m.inputs[0]); nt.links.new(b.outputs[0], m.inputs[1])
        return m

    mask = nt.nodes.new('ShaderNodeMath'); mask.operation = 'MULTIPLY'
    nt.links.new(band(sep.outputs['X']).outputs[0], mask.inputs[0])
    nt.links.new(band(sep.outputs['Y']).outputs[0], mask.inputs[1])

    # ---- per-window randomness ----
    snap = nt.nodes.new('ShaderNodeVectorMath'); snap.operation = 'SNAP'
    snap.inputs[1].default_value = (1.0, 1.0, 1.0)
    nt.links.new(cell.outputs[0], snap.inputs[0])
    seed_attr = nt.nodes.new('ShaderNodeAttribute'); seed_attr.attribute_name = 'seed'
    seed_xyz = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(seed_attr.outputs['Fac'], seed_xyz.inputs['X'])
    seed_xyz.outputs[0].default_value[1] = 0.0
    jitter = nt.nodes.new('ShaderNodeVectorMath'); jitter.operation = 'ADD'
    nt.links.new(snap.outputs[0], jitter.inputs[0])
    nt.links.new(seed_xyz.outputs[0], jitter.inputs[1])

    wn = nt.nodes.new('ShaderNodeTexWhiteNoise'); wn.noise_dimensions = '3D'
    nt.links.new(jitter.outputs[0], wn.inputs['Vector'])
    is_lit = nt.nodes.new('ShaderNodeMath'); is_lit.operation = 'GREATER_THAN'
    is_lit.inputs[1].default_value = 1.0 - lit
    nt.links.new(wn.outputs['Value'], is_lit.inputs[0])

    warm_noise = nt.nodes.new('ShaderNodeTexWhiteNoise'); warm_noise.noise_dimensions = '3D'
    warm_vec = nt.nodes.new('ShaderNodeVectorMath'); warm_vec.operation = 'MULTIPLY'
    warm_vec.inputs[1].default_value = (1.31, 2.17, 0.77)
    nt.links.new(jitter.outputs[0], warm_vec.inputs[0])
    nt.links.new(warm_vec.outputs[0], warm_noise.inputs['Vector'])
    warm = nt.nodes.new('ShaderNodeMath'); warm.operation = 'GREATER_THAN'
    warm.inputs[1].default_value = 0.62
    nt.links.new(warm_noise.outputs['Value'], warm.inputs[0])

    cool = nt.nodes.new('ShaderNodeRGB')
    cool.outputs[0].default_value = (wcol[0], wcol[1], wcol[2], 1.0)
    warmc = nt.nodes.new('ShaderNodeRGB')
    warmc.outputs[0].default_value = (1.0, 0.72, 0.38, 1.0)
    mixc = nt.nodes.new('ShaderNodeMix'); mixc.data_type = 'RGBA'; mixc.blend_type = 'MIX'
    mixc.inputs[0].default_value = 0.55
    nt.links.new(warm.outputs[0], mixc.inputs[6])
    nt.links.new(cool.outputs[0], mixc.inputs[7])
    nt.links.new(warmc.outputs[0], mixc.inputs[8]) if False else None
    # A=warm colour? simpler: use A=tint cool, B=warm
    nt.links.new(cool.outputs[0], mixc.inputs[6])
    nt.links.new(warmc.outputs[0], mixc.inputs[7])

    strength = nt.nodes.new('ShaderNodeMath'); strength.operation = 'MULTIPLY'
    nt.links.new(mask.outputs[0], strength.inputs[0])
    nt.links.new(is_lit.outputs[0], strength.inputs[1])
    strength2 = nt.nodes.new('ShaderNodeMath'); strength2.operation = 'MULTIPLY'
    nt.links.new(strength.outputs[0], strength2.inputs[0])
    strength2.inputs[1].default_value = glow

    em = nt.nodes.new('ShaderNodeVectorMath'); em.operation = 'SCALE'
    nt.links.new(mixc.outputs[2], em.inputs[0])
    nt.links.new(strength2.outputs[0], em.inputs['Scale'])

    sheen = nt.nodes.new('ShaderNodeVectorMath'); sheen.operation = 'SCALE'
    nt.links.new(tint.outputs['Color'], sheen.inputs[0])
    sheen.inputs['Scale'].default_value = 0.05
    total = nt.nodes.new('ShaderNodeVectorMath'); total.operation = 'ADD'
    nt.links.new(em.outputs[0], total.inputs[0])
    nt.links.new(sheen.outputs[0], total.inputs[1])
    nt.links.new(total.outputs[0], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 1.0
    return mat


def _neon_material(name, glow):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    col = nt.nodes.new('ShaderNodeAttribute'); col.attribute_name = 'tint'
    nt.links.new(col.outputs['Color'], em.inputs['Color'])
    em.inputs['Strength'].default_value = max(1.0, glow)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    mat.surface_render_method = 'DITHERED'
    return mat


def _ground_material(name, ground):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    c = ground.get('color', [0.02, 0.03, 0.05])
    bsdf.inputs['Base Color'].default_value = (c[0], c[1], c[2], 1.0)
    bsdf.inputs['Roughness'].default_value = max(0.08, 1.0 - float(ground.get('wet', 0.6)))
    bsdf.inputs['Metallic'].default_value = 0.55
    return mat


# ---------------------------------------------------------------- elements

def _raw_rgb(h):
    """0..1 channels straight from the hex, like the viewport shader (the city
    palette is treated as linear there too, so both sides agree)."""
    s = str(h or '#ffffff').strip().lstrip('#')
    if len(s) == 3:
        s = ''.join(ch * 2 for ch in s)
    if len(s) < 6:
        s = 'ffffff'
    return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _element_material(name, color, emissive):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    c = _raw_rgb(color)
    bsdf.inputs['Base Color'].default_value = (c[0], c[1], c[2], 1.0)
    bsdf.inputs['Roughness'].default_value = 0.38
    bsdf.inputs['Metallic'].default_value = 0.05
    try:
        bsdf.inputs['Emission Color'].default_value = (c[0], c[1], c[2], 1.0)
        bsdf.inputs['Emission Strength'].default_value = max(0.0, 1.9 * float(emissive or 0.0))
    except Exception:
        pass
    try:
        mat.surface_render_method = 'DITHERED'
    except Exception:
        pass
    return mat


def _unit_cube_mesh(name):
    verts = [
        (-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (-0.5, 0.5, -0.5),
        (-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5),
    ]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    return mesh


def _unit_cylinder_mesh(name, segments=48):
    """Unit cylinder: radius 0.5 (geom.w / geom.d are the diameter), height 1.

    Same shape the viewport draws (preview3d.js::UNIT_CYLINDER): smooth side,
    flat caps, so a `primitive: "cylinder"` solid renders the same in both.
    """
    verts = []
    faces = []
    smooth = []
    for i in range(segments):
        a = 2.0 * math.pi * i / segments
        verts.append((math.cos(a) * 0.5, -0.5, math.sin(a) * 0.5))
        verts.append((math.cos(a) * 0.5, 0.5, math.sin(a) * 0.5))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((i * 2, j * 2, j * 2 + 1, i * 2 + 1))
        smooth.append(True)
    top = len(verts)
    verts.append((0.0, 0.5, 0.0))
    bottom = len(verts)
    verts.append((0.0, -0.5, 0.0))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((top, i * 2 + 1, j * 2 + 1))
        smooth.append(False)
        faces.append((bottom, j * 2, i * 2))
        smooth.append(False)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for poly, sm in zip(mesh.polygons, smooth):
        poly.use_smooth = sm
    return mesh


def _solid_mesh(name, primitive):
    """Mesh for a solid: a cylinder when the object says so, else the unit cube."""
    if str(primitive or '').lower() == 'cylinder':
        return _unit_cylinder_mesh(name)
    return _unit_cube_mesh(name)


def _build_objects(scene, shot, root=None):
    """Timeline elements as emissive boxes, animated exactly like the viewport.
    Image/video/text objects are built as planes / 3D text by vdm_objects.py."""
    from mathutils import Matrix
    import vdm_objects
    updaters = []
    for i, o in enumerate(shot.get('objects') or []):
        frames = o.get('frames') or []
        if not frames:
            continue
        if o.get('media') or o.get('text'):
            vdm_objects.build_media_object(scene, o, root, updaters)
            continue
        name = str(o.get('name') or o.get('id') or f'element_{i}')
        mesh = _solid_mesh('el_' + str(o.get('id') or i), o.get('primitive'))
        obj = bpy.data.objects.new(name, mesh)
        obj.rotation_mode = 'QUATERNION'
        mat = _element_material('elmat_' + str(o.get('id') or i), o.get('color'), o.get('emissive'))
        obj.data.materials.append(mat)
        scene.collection.objects.link(obj)

        alpha_input = None
        try:
            alpha_input = mat.node_tree.nodes.get('Principled BSDF').inputs['Alpha']
        except Exception:
            pass
        animated_alpha = min(float(f.get('opacity', 1.0)) for f in frames) < 0.999

        for f in frames:
            fr = int(f['f'])
            obj.location = Vector(f['loc'])
            r = f['rot']
            rot = Matrix((r[0], r[1], r[2])).transposed().to_quaternion()
            obj.rotation_quaternion = rot
            obj.scale = Vector(f['size'])
            obj.keyframe_insert('location', frame=fr)
            obj.keyframe_insert('rotation_quaternion', frame=fr)
            obj.keyframe_insert('scale', frame=fr)
            if animated_alpha and alpha_input is not None:
                alpha_input.default_value = float(f.get('opacity', 1.0))
                alpha_input.keyframe_insert('default_value', frame=fr)
    vdm_objects.install_updaters(scene, updaters)


# ---------------------------------------------------------------- camera

def _build_camera(scene, shot, width, height):
    cfg = shot.get('cameraCfg', {})
    cam_data = bpy.data.cameras.new('VDM_Cam')
    cam_data.type = 'PERSP'
    cam_data.sensor_fit = 'HORIZONTAL'
    cam_data.sensor_width = 36.0
    cam_data.clip_start = float(cfg.get('near', 0.5))
    cam_data.clip_end = float(cfg.get('far', 5000))
    cam = bpy.data.objects.new('VDM_Cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_mode = 'QUATERNION'

    dof = cfg.get('dof') or {}
    if dof.get('enabled'):
        cam_data.dof.use_dof = True
        cam_data.dof.aperture_fstop = float(dof.get('fstop', 2.8))

    track = {}
    for e in shot.get('camera', []):
        track[int(e['f'])] = e
    frames = sorted(track)

    def apply(f):
        e = track.get(f)
        if e is None:
            near = min(frames, key=lambda x: abs(x - f))
            e = track[near]
        pos = Vector(e['pos'])
        look = Vector(e['look'])
        cam.location = pos
        d = look - pos
        if d.length < 1e-4:
            d = Vector((0, 0, -1))
        d = d.normalized()
        # The project world is Y-up, so build the camera basis from world +Y:
        # camera X = right, Y = up, -Z = view direction.  Blender's
        # to_track_quat('-Z', 'Y') would instead pull camera Y towards world
        # +Z and silently roll the shot (nightcity was ~45 degrees off from
        # the preview).
        right = d.cross(Vector((0.0, 1.0, 0.0)))
        if right.length < 1e-5:
            right = Vector((1.0, 0.0, 0.0))
        right.normalize()
        up = right.cross(d)
        up.normalize()
        basis = Matrix((
            (right.x, up.x, -d.x),
            (right.y, up.y, -d.y),
            (right.z, up.z, -d.z),
        ))
        q = basis.to_quaternion()
        roll = math.radians(float(e.get('roll', 0.0)))
        q = q @ Quaternion((0.0, 0.0, 1.0), roll)
        cam.rotation_quaternion = q
        # A rectilinear projection degenerates at 180°: from there on render
        # with an equidistant fisheye so the fov can keep going up to 360°.
        fov = float(e.get('fov', 62.0))
        if fov >= 180.0:
            try:
                cam_data.type = 'PANO'
                cam_data.panorama_type = 'FISHEYE_EQUIDISTANT'
                cam_data.fisheye_fov = math.radians(min(360.0, max(180.0, fov)))
            except Exception:
                cam_data.type = 'PERSP'
                cam_data.angle = math.radians(179.0)
        else:
            cam_data.type = 'PERSP'
            cam_data.angle = math.radians(max(1.0, min(179.5, fov)))
        # DOF is sampled per frame (C-b): enabled/fstop can be keyed in the
        # timeline; fall back to cameraCfg when an older bake has no e.dof.
        edof = e.get('dof') or dof
        cam_data.dof.use_dof = bool(edof.get('enabled'))
        cam_data.dof.aperture_fstop = float(edof.get('fstop', 2.8))
        focus = float(e.get('focus', 0.0))
        cam_data.dof.focus_distance = max(1.0, focus if focus > 0 else d.length)

    def on_frame(scn, depsgraph=None):
        apply(scn.frame_current)

    bpy.app.handlers.frame_change_pre.append(on_frame)
    apply(scene.frame_start)
    return cam


# ---------------------------------------------------------------- multi-camera

def _copy_render_settings(src, dst):
    r, s = src.render, dst.render
    for attr in ('engine', 'resolution_x', 'resolution_y', 'resolution_percentage',
                 'fps', 'fps_base', 'film_transparent', 'filter_size',
                 'use_motion_blur', 'motion_blur_shutter', 'use_compositing'):
        try:
            setattr(s, attr, getattr(r, attr))
        except Exception:
            pass
    for attr in ('file_format', 'color_mode', 'compression'):
        try:
            setattr(s.image_settings, attr, getattr(r.image_settings, attr))
        except Exception:
            pass
    for attr in ('view_transform', 'look'):
        try:
            setattr(dst.view_settings, attr, getattr(src.view_settings, attr))
        except Exception:
            pass
    try:
        dst.render.engine = r.engine
    except Exception:
        pass
    try:
        dst.cycles.samples = src.cycles.samples
        dst.cycles.use_denoising = src.cycles.use_denoising
        dst.cycles.max_bounces = src.cycles.max_bounces
    except Exception:
        pass
    try:
        dst.eevee.taa_render_samples = src.eevee.taa_render_samples
        dst.eevee.use_raytracing = src.eevee.use_raytracing
    except Exception:
        pass
    dst.frame_start = src.frame_start
    dst.frame_end = src.frame_end


def _force_engine(scene, engine, opts):
    scene.render.engine = engine
    try:
        if engine == 'CYCLES':
            scene.cycles.samples = max(16, int(opts.get('samples', 32)))
            scene.cycles.use_denoising = True
            scene.cycles.max_bounces = 4
        else:
            scene.eevee.taa_render_samples = int(opts.get('samples', 32))
            scene.eevee.use_raytracing = True
            scene.eevee.ray_tracing_options.resolution_scale = '2'
    except Exception:
        pass


def _apply_motion_blur(scene, cfg):
    mb = (cfg or {}).get('motionBlur') or {}
    try:
        scene.render.use_motion_blur = bool(mb.get('enabled', True))
        scene.render.motion_blur_shutter = float(mb.get('shutter', 0.5))
    except Exception:
        pass
    try:
        if scene.render.engine != 'CYCLES' and mb.get('enabled', True):
            scene.eevee.use_motion_blur = True
            scene.eevee.motion_blur_steps = 2
    except Exception:
        pass


def _layer_picture_default(layer):
    frames = layer.get('frames') or []
    for f in frames:
        op = float(f.get('opacity', 1.0))
        sx, sy = (f.get('scale') or [1, 1])[:2]
        px, py = (f.get('picturePivot') or [0.5, 0.5])[:2]
        ox, oy = (f.get('pictureOffset') or [0, 0])[:2]
        if abs(op - 1) > 1e-4 or abs(sx - 1) > 1e-4 or abs(sy - 1) > 1e-4:
            return False
        if abs(px - 0.5) > 1e-4 or abs(py - 0.5) > 1e-4:
            return False
        if abs(ox) > 1e-4 or abs(oy) > 1e-4:
            return False
    return True


def _make_camera_scene(base, layer, shot, opts, engine):
    """A full city scene sharing the base geometry, with its own camera."""
    sid = str(layer.get('id') or len(bpy.data.scenes))
    s = bpy.data.scenes.new('VDM_Cam_' + sid)
    _copy_render_settings(base, s)
    _force_engine(s, engine, opts)
    s.world = base.world
    s.frame_start = base.frame_start
    s.frame_end = base.frame_end
    s.render.film_transparent = False
    for ob in list(base.objects):
        # FONT objects are the 3D text planes; without them the per-camera
        # scene renders the city but drops every text object.
        if ob.type in {'MESH', 'LIGHT', 'FONT'}:
            try:
                # Copy the object (sharing mesh/light data) rather than linking
                # one datablock into several scenes: each scene strip gets a
                # stable, independent object graph.
                dup = ob.copy()
                dup.data = ob.data
                s.collection.objects.link(dup)
            except Exception:
                pass
    sub = dict(shot)
    sub['camera'] = layer.get('camera') or []
    sub['cameraCfg'] = layer.get('cameraCfg') or shot.get('cameraCfg') or {}
    _build_camera(s, sub, s.render.resolution_x, s.render.resolution_y)
    _apply_motion_blur(s, sub['cameraCfg'])
    return s


def _build_master(base, scenes, layers, shot, opts):
    """VSE master: scene strips bottom -> top with alpha-over and picture transform.

    Blender 5's compositor Alpha Over is unreliable when a transformed image is
    used as the background of a second Alpha Over, so the VSE scene strips do
    the actual layering. Each strip has its own scene (and camera), transform
    and per-frame blend_alpha.
    """
    m = bpy.data.scenes.new('VDM_Master')
    _copy_render_settings(base, m)
    m.render.use_sequencer = True
    m.render.use_compositing = False
    m.render.film_transparent = False
    m.frame_start = base.frame_start
    m.frame_end = base.frame_end
    # The master scene needs a camera to render; the strips come from the
    # camera scenes and this camera only satisfies the render operator.
    mcd = bpy.data.cameras.new('VDM_MasterCam')
    mco = bpy.data.objects.new('VDM_MasterCam', mcd)
    m.collection.objects.link(mco)
    m.camera = mco

    m.sequence_editor_create()
    seq = m.sequence_editor.strips
    W = m.render.resolution_x
    H = m.render.resolution_y
    pairs = list(zip(layers, scenes))
    for i, (layer, scene) in enumerate(reversed(pairs)):
        st = seq.new_scene('cam_' + str(layer.get('id') or i), scene, i + 1, base.frame_start)
        st.blend_type = 'ALPHA_OVER'
        st.blend_alpha = 1.0
        frames = layer.get('frames') or []
        for f in frames:
            fr = int(f.get('f') or 1)
            sx, sy = (f.get('scale') or [1, 1])[:2]
            px, py = (f.get('picturePivot') or [0.5, 0.5])[:2]
            ox, oy = (f.get('pictureOffset') or [0, 0])[:2]
            # VSE transform scales about the image centre; offset so the
            # requested picture pivot stays put. y is bottom-up in the VSE,
            # while the UI stores normalized y down.
            st.transform.scale_x = sx
            st.transform.scale_y = sy
            st.transform.offset_x = (px - 0.5) * (1.0 - sx) * W + ox * W
            st.transform.offset_y = -((py - 0.5) * (1.0 - sy) * H + oy * H)
            st.transform.keyframe_insert('scale_x', frame=fr)
            st.transform.keyframe_insert('scale_y', frame=fr)
            st.transform.keyframe_insert('offset_x', frame=fr)
            st.transform.keyframe_insert('offset_y', frame=fr)
            st.blend_alpha = float(f.get('opacity', 1.0))
            st.keyframe_insert('blend_alpha', frame=fr)
    # In background mode the render operator targets the active window scene.
    try:
        bpy.context.window.scene = m
    except Exception:
        pass
    return m


def _build_multi_camera_scene(shot, opts):
    layers = shot.get('cameraLayers') or []
    base_shot = dict(shot)
    base_shot.pop('cameraLayers', None)
    base_shot['camera'] = layers[0].get('camera') or shot.get('camera') or []
    base_shot['cameraCfg'] = layers[0].get('cameraCfg') or shot.get('cameraCfg') or {}
    base = build_shot_scene(base_shot, dict(opts, _no_overlay=True))
    fisheye = any(
        any(float(e.get('fov', 62.0)) >= 180.0 for e in (layer.get('camera') or []))
        for layer in layers
    )
    engine = 'CYCLES' if fisheye else 'BLENDER_EEVEE'
    _force_engine(base, engine, opts)
    _apply_motion_blur(base, base_shot['cameraCfg'])
    # Use standalone camera scenes for every layer so each VSE strip has its
    # own camera, engine and render settings.
    scenes = [_make_camera_scene(base, layer, shot, opts, engine) for layer in layers]
    master = _build_master(base, scenes, layers, shot, opts)
    # 2D elements: one more scene strip on top of the camera layers
    ov = _build_overlay(opts)
    if ov is not None:
        ov.frame_start = master.frame_start
        ov.frame_end = master.frame_end
        st = master.sequence_editor.strips.new_scene('2d', ov, len(scenes) + 1, master.frame_start)
        st.blend_type = 'ALPHA_OVER'
    return master


def _build_city_geometry(scene, city):
    """Ground plane, merged towers and neon (skipped for an empty world)."""
    # ground
    span = max(4000.0, (city['bounds']['x1'] - city['bounds']['x0']) * 3.0)
    gm = bpy.data.meshes.new('ground')
    gm.from_pydata([(-span, 0, -span), (span, 0, -span), (span, 0, span), (-span, 0, span)], [], [(0, 1, 2, 3)])
    gm.update()
    gobj = bpy.data.objects.new('ground', gm)
    gobj.data.materials.append(_ground_material('ground', city.get('ground', {})))
    scene.collection.objects.link(gobj)

    # buildings (one merged mesh)
    verts, faces, uvs, colors, seeds = [], [], [], [], []
    for b in city['buildings']:
        _add_box(verts, faces, uvs, colors, seeds,
                 b['x'], b['y'], b['z'], b['w'], b['h'], b['d'], b['tint'], b['seed'])
    bmesh = _mesh_from(verts, faces, uvs, colors, seeds, 'city')
    bobj = bpy.data.objects.new('city', bmesh)
    bobj.data.materials.append(_window_material('windows', city))
    scene.collection.objects.link(bobj)

    # neons (one merged emissive mesh)
    nverts, nfaces, nuvs, ncolors, nseeds = [], [], [], [], []
    for n in city['neons']:
        _add_box(nverts, nfaces, nuvs, ncolors, nseeds,
                 n['x'], n['y'], n['z'], n['w'], n['h'], n['d'], n['color'], n['seed'])
    nmesh = _mesh_from(nverts, nfaces, nuvs, ncolors, nseeds, 'neon')
    nobj = bpy.data.objects.new('neon', nmesh)
    nobj.data.materials.append(_neon_material('neon', city.get('neonGlow', 6.0)))
    scene.collection.objects.link(nobj)


# ---------------------------------------------------------------- 2D layer

def _embed_elements(scene, opts, shot=None):
    """The project's 2D elements as planes in the world (unified space).

    The 2D SceneBuilder (same eval_element as 2D projects) builds them in pixel
    units under a screen rig: the rig sits at the screen-plane centre
    (height / 200 m, bottom edge on the ground) and scales 1/100, so a pixel is
    a centimetre and transform.z moves an element toward the camera."""
    path = opts.get('project')
    if not path or not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        project = json.load(f)
    if not any(e.get('visible') is not False for e in project.get('elements') or []):
        return None
    h = float((project.get('meta') or {}).get('height') or 1080)
    rig = bpy.data.objects.new('VDM_Screen', None)
    rig.location = (0.0, h / 200.0, 0.0)
    rig.scale = (0.01, 0.01, 0.01)
    scene.collection.objects.link(rig)
    with bpy.context.temp_override(scene=scene):
        SceneBuilder(project, opts).build(scene=scene, embed=rig)
    return rig


def _plane_layer(scene, rig):
    """Split the 2D element planes into their own view layer; returns its name.

    The planes use blended (transparent) materials, which EEVEE leaves out of
    the Mist pass, so the compositor fog would paint them in full fog colour.
    The main layer renders the 3D world without the planes (and fogs it); the
    'VDM_Planes' layer renders only the planes with the world as holdout, so
    3D objects still cover them, and the compositor lays it over the fogged
    world. Matches the viewport, where 2D layers are never fogged."""
    plane_objs = set()
    roots = [rig]

    def walk(ob):
        plane_objs.add(ob)
        for ch in ob.children:
            walk(ch)
    for r in roots:
        walk(r)
    cp = bpy.data.collections.new('VDM_Planes')
    cw = bpy.data.collections.new('VDM_World')
    scene.collection.children.link(cp)
    scene.collection.children.link(cw)
    for ob in list(scene.collection.objects):
        target = cp if ob in plane_objs else cw
        target.objects.link(ob)
        scene.collection.objects.unlink(ob)
    main = scene.view_layers[0]
    main.layer_collection.children['VDM_Planes'].exclude = True
    layer = scene.view_layers.new('VDM_Planes')
    layer.layer_collection.children['VDM_World'].holdout = True
    for attr in ('use_sky', 'use_pass_mist'):
        if hasattr(layer, attr):
            setattr(layer, attr, False)
    return layer.name


def _build_overlay(opts):
    """The project's 2D elements as a transparent scene ('VDM_2D'), or None.

    Built by the 2D SceneBuilder (same evaluation as 2D projects) into its own
    scene; the shot composites it over the 3D picture."""
    path = opts.get('project')
    if not path or not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        project = json.load(f)
    if not any(e.get('visible') is not False for e in project.get('elements') or []):
        return None
    ov = bpy.data.scenes.new('VDM_2D')
    with bpy.context.temp_override(scene=ov):
        SceneBuilder(project, opts).build(scene=ov, overlay=True)
    return ov


# ---------------------------------------------------------------- scene

def build_shot_scene(shot, opts):
    layers = shot.get('cameraLayers') or []
    # A single camera with the default picture transform uses the direct scene
    # path, preserving the project's fog/bloom/grade compositor exactly.
    if len(layers) == 1 and _layer_picture_default(layers[0]):
        single = dict(shot)
        single.pop('cameraLayers', None)
        single['camera'] = layers[0].get('camera') or shot.get('camera') or []
        single['cameraCfg'] = layers[0].get('cameraCfg') or shot.get('cameraCfg') or {}
        return build_shot_scene(single, opts)
    # Multiple cameras (or a transformed single picture) go through the VSE
    # master where every layer's transform and opacity are applied.
    if len(layers) >= 1:
        return _build_multi_camera_scene(shot, opts)

    city = shot['city']
    scene = reset_scene()
    W = int(round(shot.get('width', 1920) * opts.get('scale', 1.0)))
    H = int(round(shot.get('height', 1080) * opts.get('scale', 1.0)))
    # A rectilinear camera has no projection at >= 180°, so those shots fall
    # back to the equidistant fisheye. EEVEE does not support panorama cameras;
    # Cycles does, so fisheye shots render in Cycles.
    fisheye = any(float(e.get('fov', 62.0)) >= 180.0 for e in (shot.get('camera') or []))
    scene.render.engine = 'CYCLES' if fisheye else 'BLENDER_EEVEE'
    scene.render.resolution_x = W
    scene.render.resolution_y = H
    scene.render.resolution_percentage = 100
    scene.render.fps = int(round(shot.get('fps', 24)))
    scene.render.fps_base = 1.0
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.compression = 15
    scene.render.film_transparent = False
    scene.render.use_sequencer = False
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.filter_size = 1.2
    try:
        if fisheye:
            scene.cycles.samples = max(16, int(opts.get('samples', 32)))
            scene.cycles.use_denoising = True
            scene.cycles.max_bounces = 4
        else:
            scene.eevee.taa_render_samples = int(opts.get('samples', 32))
            scene.eevee.use_raytracing = True
            scene.eevee.ray_tracing_options.resolution_scale = '2'
    except Exception:
        pass
    # motion blur (EEVEE Next exposes it on the eevee settings in 5.x)
    mb = (shot.get('cameraCfg') or {}).get('motionBlur') or {}
    try:
        if mb.get('enabled', True):
            scene.render.use_motion_blur = True
            scene.render.motion_blur_shutter = float(mb.get('shutter', 0.5))
    except Exception:
        pass
    try:
        if not fisheye and mb.get('enabled', True):
            scene.eevee.use_motion_blur = True
            scene.eevee.motion_blur_steps = 2
    except Exception:
        pass

    # world / sky: vertical gradient so the skyline reads against the horizon haze
    sky = city.get('sky', [0.02, 0.03, 0.06])
    fogc = city.get('fog', {}).get('color', [0.04, 0.13, 0.21])
    world = bpy.data.worlds.new('VDM_Sky')
    world.use_nodes = True
    wnt = world.node_tree
    for n in list(wnt.nodes):
        wnt.nodes.remove(n)
    wout = wnt.nodes.new('ShaderNodeOutputWorld')
    bg = wnt.nodes.new('ShaderNodeBackground')
    tex = wnt.nodes.new('ShaderNodeTexCoord')
    sepz = wnt.nodes.new('ShaderNodeSeparateXYZ')
    wnt.links.new(tex.outputs['Generated'], sepz.inputs[0])
    ramp = wnt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (fogc[0] * 1.6, fogc[1] * 1.6, fogc[2] * 1.6, 1.0)
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = (sky[0], sky[1], sky[2], 1.0)
    mid = ramp.color_ramp.elements.new(0.18)
    mid.color = (fogc[0] * 0.7, fogc[1] * 0.75, fogc[2] * 0.9, 1.0)
    wnt.links.new(sepz.outputs['Z'], ramp.inputs[0])
    if city.get('empty'):
        # Empty world: one flat background colour, like the viewport's clear
        # (a migrated 2D project keeps its background exactly). The film is
        # transparent and the compositor lays the picture over that colour, so
        # the fog only touches the user's objects (see build_compositor).
        bg.inputs[0].default_value = (sky[0], sky[1], sky[2], 1.0)
        bg.inputs[1].default_value = 1.0
        scene.render.film_transparent = True
        # flat motion graphics: the 2D path's sharper pixel filter (1.2 softens
        # type edges; measured against projects/miku-swiss golden frames)
        scene.render.filter_size = 0.8
    else:
        wnt.links.new(ramp.outputs['Color'], bg.inputs[0])
        bg.inputs[1].default_value = max(0.9, float(city.get('ambient', 0.3)) * 2.4)
    wnt.links.new(bg.outputs[0], wout.inputs['Surface'])
    scene.world = world

    # cool key light so the towers have form (the neon does the rest)
    sun_data = bpy.data.lights.new('moon', 'SUN')
    sun_data.energy = 0.45
    sun_data.color = (0.55, 0.72, 1.0)
    try:
        sun_data.angle = math.radians(8.0)
    except Exception:
        pass
    sun = bpy.data.objects.new('moon', sun_data)
    sun.rotation_euler = (math.radians(64), 0.0, math.radians(38))
    scene.collection.objects.link(sun)

    if not city.get('empty'):
        _build_city_geometry(scene, city)

    # timeline elements (emissive boxes with baked per-frame transforms)
    _build_objects(scene, shot, opts.get('root'))

    # frame range from the baked camera
    cam_frames = [int(e['f']) for e in shot.get('camera', [])]
    scene.frame_start = min(cam_frames) if cam_frames else 1
    scene.frame_end = max(cam_frames) if cam_frames else 240
    _build_camera(scene, shot, W, H)

    # compositor: same post chain as the 2D path + depth fog
    meta = {'fx': shot.get('fx') or {}}
    # 2D elements: planes in the world on the screen plane (single camera); the
    # multi-camera path still lays them over the picture (see _build_overlay)
    rig = None
    if not opts.get('_no_overlay'):
        rig = _embed_elements(scene, opts, shot)
    planes = _plane_layer(scene, rig) if rig is not None and city.get('fog') else None
    build_compositor(scene, meta, os.path.join(opts['root'], '.vdm', 'cache', 'comp'),
                     fog=city.get('fog'),
                     backdrop=city.get('sky') if city.get('empty') else None,
                     planes=planes)
    return scene
