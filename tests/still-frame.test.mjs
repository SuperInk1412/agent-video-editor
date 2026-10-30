// Still-frame choice — the preview and Blender must name the same frame
// (docs/SPEC-PROJECT.md P5; the WP1.2 tail).
//
// The preview picks the frame under `t` with `core/keyframe-edit.js::frameIndex`
// (floor plus a 1e-6-frame cushion). `engine/camfeed-render.js::jobFrames` and
// `blender/vdm_time.py` have to answer the same frame. They used to round:
// JS `Math.round` goes half up, Python `round()` goes half to even, so a time
// exactly between two frames could render a different frame than the preview
// (WP1.2 hid that with one frame of slack in the shot range).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { frameIndex } from '../core/keyframe-edit.js';
import { jobFrames } from '../engine/camfeed-render.js';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const FPS = [24, 25, 30, 60];
const TIMES = [0, 1 / 30, 0.5, 1, 1.75, 1.7833333333, 2.5, 3.999, 5];

test('jobFrames picks the frame the preview picks, including between-frame times', () => {
  for (const fps of FPS) {
    for (const time of TIMES) {
      const [f0, f1] = jobFrames({ mode: 'still', time }, fps, 10);
      assert.equal(f0, frameIndex(time, fps) + 1, `still ${time}s @ ${fps}fps`);
      assert.equal(f1, f0);
    }
  }
  // 1.75 s at 30 fps is frame 52.5. The floor rule names 0-based 52 (1-based
  // 53); the old Python round() also said 52 there, but 53.5 was the half that
  // went to even (54). Pin both sides of the boundary.
  assert.equal(frameIndex(1.75, 30), 52);
  assert.equal(jobFrames({ mode: 'still', time: 1.75 }, 30, 10)[0], 53);
  assert.equal(frameIndex(1.7833333333, 30), 53);
  assert.equal(jobFrames({ mode: 'still', time: 1.7833333333 }, 30, 10)[0], 54);
});

test('jobFrames range ends follow the same rule', () => {
  const [f0, f1] = jobFrames({ mode: 'frames', from: 0, to: 2.5 }, 30, 10);
  assert.equal(f0, 1);
  assert.equal(f1, 75, '2.5 s at 30 fps is frame 75');
  assert.equal(f1, frameIndex(2.5, 30));
  // A range that ends on a frame boundary keeps its last frame; a range that
  // ends between frames stops at the frame under it.
  assert.equal(jobFrames({ mode: 'frames', from: 0, to: 1 }, 24, 10)[1], 24);
  assert.equal(jobFrames({ mode: 'frames', from: 0, to: 1.02 }, 24, 10)[1], 24);
});

/** First Python that runs; null when the machine has none (the check skips). */
async function findPython() {
  for (const bin of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      await run(bin, ['-c', 'print(1)']);
      return bin;
    } catch { /* try the next one */ }
  }
  return null;
}

const PYTHON = await findPython();

test('blender/vdm_time.py answers the same frames as JS', { skip: !PYTHON && 'no Python on this machine' }, async () => {
  const script = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'blender'))})`,
    'from vdm_time import frame_index, still_frame',
    `times = ${JSON.stringify(TIMES)}`,
    'fps_list = [24, 25, 30, 60]',
    'print(json.dumps({',
    '  "index": {f"{t}@{fps}": frame_index(t, fps) for t in times for fps in fps_list},',
    '  "still": {f"{t}@{fps}": still_frame(t, fps, 10) for t in times for fps in fps_list},',
    '}))',
  ].join('\n');
  const { stdout } = await run(PYTHON, ['-c', script], { cwd: ROOT });
  const data = JSON.parse(stdout);
  for (const [key, value] of Object.entries(data.index)) {
    const [t, fps] = key.split('@').map(Number);
    assert.equal(value, frameIndex(t, fps), `frame_index(${t}, ${fps})`);
  }
  for (const [key, value] of Object.entries(data.still)) {
    const [t, fps] = key.split('@').map(Number);
    const expected = Math.min(Math.max(1, Math.round(10 * fps)), frameIndex(t, fps) + 1);
    assert.equal(value, expected, `still_frame(${t}, ${fps})`);
  }
  // The documented case, spelled out: 1.75 s at 30 fps is the same frame in
  // both languages (1-based 53).
  assert.equal(data.still['1.75@30'], 53);
});
