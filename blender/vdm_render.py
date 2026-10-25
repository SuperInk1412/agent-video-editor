# -*- coding: utf-8 -*-
"""VedioMaker Blender entry point.

usage:
  blender -b --factory-startup -noaudio -P blender/vdm_render.py -- --job <job.json>

job.json = {project, root, mode: "still"|"frames", time|from|to, out, framesDir, scale, samples}
Progress is printed as:  VDM_PROGRESS {"frame":12,"total":240}
"""
import bpy
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from vdm_build import build_scene  # noqa: E402


def emit(obj):
    sys.stdout.write('VDM_PROGRESS ' + json.dumps(obj) + '\n')
    sys.stdout.flush()


def main():
    argv = sys.argv
    args = argv[argv.index('--') + 1:] if '--' in argv else []
    job_path = None
    for i, a in enumerate(args):
        if a == '--job' and i + 1 < len(args):
            job_path = args[i + 1]
    if not job_path:
        raise SystemExit('missing --job <json>')

    with open(job_path, 'r', encoding='utf-8') as f:
        job = json.load(f)

    t0 = time.time()
    with open(job['project'], 'r', encoding='utf-8') as f:
        project = json.load(f)

    scene = build_scene(project, job)
    emit({'stage': 'built', 'sec': round(time.time() - t0, 2)})

    mode = job.get('mode', 'still')
    fps = float(project['meta'].get('fps') or 24)

    if mode == 'still':
        t = float(job.get('time') or 0)
        frame = int(round(t * fps)) + 1
        scene.frame_set(frame)
        out = job['out']
        os.makedirs(os.path.dirname(out), exist_ok=True)
        scene.render.filepath = out
        bpy.ops.render.render(write_still=True)
        emit({'stage': 'done', 'out': out, 'frame': frame, 'sec': round(time.time() - t0, 2)})
        return

    # ---- frames (animation) ----
    start = float(job.get('from') or 0)
    end = float(job.get('to') or project['meta']['duration'])
    f0 = int(round(start * fps)) + 1
    f1 = max(f0, int(round(end * fps)))
    scene.frame_start = f0
    scene.frame_end = f1
    frames_dir = job['framesDir']
    os.makedirs(frames_dir, exist_ok=True)
    scene.render.filepath = os.path.join(frames_dir, 'f_')
    scene.render.use_file_extension = True

    total = f1 - f0 + 1

    def on_post(scn, depsgraph=None):
        done = scn.frame_current - f0 + 1
        emit({'stage': 'frame', 'frame': done, 'total': total, 'sceneFrame': scn.frame_current})

    bpy.app.handlers.render_post.append(on_post)
    bpy.ops.render.render(animation=True)
    bpy.app.handlers.render_post.remove(on_post)
    emit({'stage': 'done', 'frames': total, 'sec': round(time.time() - t0, 2)})


if __name__ == '__main__':
    main()
