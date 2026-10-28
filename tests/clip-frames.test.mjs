// Clip-window frame alignment (core/clip-frames.js) and the first-save backup
// attached to an in-memory migration (engine/storage.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { ensureSpace } from '../core/space.js';
import { frameIndex, frameKeyTimeForFrame } from '../core/keyframe-edit.js';
import { snapClipFrames } from '../core/clip-frames.js';
import { loadProject, saveProject, paths } from '../engine/storage.js';

const near = (a, b, eps = 1e-6, msg = '') => {
  assert.ok(Number.isFinite(a), `${msg}: ${a} is not finite`);
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};
const onGrid = (t, fps, msg) => {
  const frame = Math.round(t * fps);
  assert.equal(frameIndex(t, fps), frame, `${msg}: frameIndex`);
  near(t, frameKeyTimeForFrame(frame, fps), 1e-9, `${msg}: stored frame edge`);
};

function fresh(fps = 30) {
  const p = normalizeProject(createProject({ title: 'clip frames', duration: 20, fps }));
  ensureSpace(p);
  return p;
}

test('clip-frames: both heads and tails snap; keyframes are untouched', () => {
  const p = fresh(30);
  const el = applyOp(p, {
    op: 'addElement',
    element: {
      type: 'solid', start: 14.56, duration: 0.44,
      keyframes: [{ t: 1.037, path: 'transform.opacity', value: 0.5, ease: 'linear' }],
    },
  }).element;
  const cam = p.cameras[0];
  cam.start = 1.68;
  cam.duration = 0.397;
  const obj = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 2.077, duration: 3.223, pivot: [0, 0, 0] },
  }).changed[0];
  const object = p.scene.objects.find((o) => o.id === obj);

  const changed = snapClipFrames(p);
  assert.equal(changed, 3, 'element, camera and object windows changed');
  for (const host of [el, cam, object]) {
    onGrid(host.start, 30, 'start');
    onGrid(host.start + host.duration, 30, 'end');
  }
  near(el.start, 14.567, 1e-9, '14.56 lands on frame 437');
  near(el.start + el.duration, 15, 1e-9, 'end stays on 15s');
  assert.equal(frameIndex(el.start, 30), 437);
  assert.equal(el.keyframes[0].t, 1.037, 'keyframe time is not rewritten');
  assert.equal(snapClipFrames(p), 0, 'idempotent');
});

test('clip-frames: 24 fps trims, a too-short span and a missing window', () => {
  const p = fresh(24);
  const el = applyOp(p, {
    op: 'addElement',
    element: { type: 'solid', start: 1.83, duration: 2.345 },
  }).element;
  snapClipFrames(p);
  assert.equal(frameIndex(el.start, 24), 44);
  assert.equal(frameIndex(el.start + el.duration, 24), 100);
  onGrid(el.start, 24, '24fps start');
  onGrid(el.start + el.duration, 24, '24fps end');

  const tiny = applyOp(p, {
    op: 'addElement',
    element: { type: 'solid', start: 5.001, duration: 0.001 },
  }).element;
  snapClipFrames(p);
  assert.ok(tiny.duration >= 1 / 24 - 1e-9, 'at least one frame');
  onGrid(tiny.start, 24, 'tiny start');
  onGrid(tiny.start + tiny.duration, 24, 'tiny end');

  const noWindow = { id: 'x' };
  snapClipFrames({ meta: { fps: 24 }, elements: [noWindow] });
  assert.equal(noWindow.start, undefined, 'hosts without a clip stay untouched');
});

test('clip-frames: loading aligns clips and the first save backs up the old file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-clipframes-'));
  try {
    const p = fresh(30);
    applyOp(p, {
      op: 'addElement',
      element: { type: 'solid', start: 14.56, duration: 0.44 },
    });
    await fs.writeFile(paths(dir).file, JSON.stringify(p, null, 2));

    const loaded = await loadProject(dir);
    assert.equal(loaded.meta.ui.migration.backupPending, true);
    onGrid(loaded.elements[0].start, 30, 'loaded start');
    onGrid(loaded.elements[0].start + loaded.elements[0].duration, 30, 'loaded end');

    await saveProject(dir, loaded);
    const backup = loaded.meta.ui.migration.backup;
    assert.ok(backup && backup.includes('backups'), `backup path: ${backup}`);
    const old = JSON.parse(await fs.readFile(path.join(dir, backup), 'utf8'));
    near(old.elements[0].start, 14.56, 1e-9, 'backup keeps the pre-migration times');
    assert.equal(loaded.meta.ui.migration.backupPending, false);
    const saved = JSON.parse(await fs.readFile(paths(dir).file, 'utf8'));
    onGrid(saved.elements[0].start, 30, 'saved start');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
