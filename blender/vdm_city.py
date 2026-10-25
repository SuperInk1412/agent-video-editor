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
from mathutils import Vector, Quaternion

from vdm_build import (
    reset_scene, hex_rgba, build_compositor, set_menu, srgb_to_linear,
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
        q = d.to_track_quat('-Z', 'Y')
        roll = math.radians(float(e.get('roll', 0.0)))
        q = q @ Quaternion((0.0, 0.0, 1.0), roll)
        cam.rotation_quaternion = q
        cam_data.angle = math.radians(float(e.get('fov', 62.0)))
        if dof.get('enabled'):
            cam_data.dof.focus_distance = max(1.0, d.length)

    def on_frame(scn, depsgraph=None):
        apply(scn.frame_current)

    bpy.app.handlers.frame_change_pre.append(on_frame)
    apply(scene.frame_start)
    return cam


# ---------------------------------------------------------------- scene

def build_shot_scene(shot, opts):
    city = shot['city']
    scene = reset_scene()
    W = int(round(shot.get('width', 1920) * opts.get('scale', 1.0)))
    H = int(round(shot.get('height', 1080) * opts.get('scale', 1.0)))
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = W
    scene.render.resolution_y = H
    scene.render.resolution_percentage = 100
    scene.render.fps = int(round(shot.get('fps', 24)))
    scene.render.fps_base = 1.0
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.compression = 15
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.filter_size = 1.2
    try:
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
        if mb.get('enabled', True):
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

    # frame range from the baked camera
    cam_frames = [int(e['f']) for e in shot.get('camera', [])]
    scene.frame_start = min(cam_frames) if cam_frames else 1
    scene.frame_end = max(cam_frames) if cam_frames else 240
    _build_camera(scene, shot, W, H)

    # compositor: same post chain as the 2D path + depth fog
    meta = {'fx': shot.get('fx') or {}}
    build_compositor(scene, meta, os.path.join(opts['root'], '.vdm', 'cache', 'comp'),
                     fog=city.get('fog'))
    return scene
