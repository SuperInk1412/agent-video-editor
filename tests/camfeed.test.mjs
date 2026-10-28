import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp } from '../core/ops.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { cameraLayers } from '../core/camera.js';
import {
  feedPlan, hiddenFeeds, sourceProject, elementsFor, normalizeFeed,
} from '../core/camfeed.js';

/** Default space plus two more cameras (new cameras go on top of the stack). */
function rig() {
  const p = normalizeProject(createProject({ title: 'feed', duration: 4 }));
  ensureSpace(p);
  const a = p.cameras[0].id;
  const b = applyOp(p, { op: 'addCamera' }).camera.id;
  const c = applyOp(p, { op: 'addCamera' }).camera.id;
  return { p, a, b, c };
}

const feed = (p, camera, delay = 0) => applyOp(p, {
  op: 'addElement', element: { type: 'camfeed', start: 0, duration: 4, feed: { camera, delay } },
}).element;

test('addElement keeps a normalised feed and the project validates', () => {
  const { p, a } = rig();
  const el = feed(p, a, 1);
  assert.deepEqual(el.feed, { camera: a, delay: 1 });
  assert.deepEqual(validateProject(p), []);
  assert.deepEqual(normalizeFeed({ camera: 'x', delay: 7 }), { camera: 'x', delay: 0 });
});

test('validation rejects a feed without a camera', () => {
  const { p, a } = rig();
  const el = feed(p, a);
  el.feed = { delay: 0 };
  const paths = validateProject(p).map((i) => i.path);
  assert.ok(paths.some((x) => x.endsWith('.feed.camera')), paths.join(','));
});

test('a camera never films its own live feed', () => {
  const { p, a } = rig();
  const el = feed(p, a);
  const plan = feedPlan(p);
  assert.ok(hiddenFeeds(plan, a).has(el.id));
  assert.deepEqual(plan.sources, [a]);
  assert.equal(elementsFor(p, plan, a).some((e) => e.id === el.id), false);
  // An unknown viewer (the editor's free view) sees everything.
  assert.equal(hiddenFeeds(plan, 'editor').size, 0);
});

test('a previous-frame feed is visible to everyone, its source included', () => {
  const { p, a, b } = rig();
  const el = feed(p, a, 1);
  const plan = feedPlan(p);
  assert.equal(hiddenFeeds(plan, a).has(el.id), false);
  assert.equal(hiddenFeeds(plan, b).has(el.id), false);
  assert.deepEqual(plan.sources, [a]);
});

test('a mutual live pair is broken by camera order: the lower camera loses sight', () => {
  const { p, a, b } = rig();
  const order = p.cameraOrder.slice();
  const hi = order.indexOf(a) < order.indexOf(b) ? a : b;
  const lo = hi === a ? b : a;
  const ofHi = feed(p, hi);
  const ofLo = feed(p, lo);
  const plan = feedPlan(p);
  assert.equal(hiddenFeeds(plan, hi).has(ofLo.id), false, 'higher camera films the lower feed');
  assert.equal(hiddenFeeds(plan, lo).has(ofHi.id), true, 'lower camera loses the higher feed');
  assert.deepEqual(plan.sources, [lo, hi], 'lower renders first');
});

test('a chain renders its sources dependencies first', () => {
  const { p, a, b, c } = rig();
  // c films b's feed, b films a's feed.
  feed(p, a);
  feed(p, b);
  const plan = feedPlan(p);
  assert.ok(plan.sources.indexOf(a) < plan.sources.indexOf(b));
  assert.equal(hiddenFeeds(plan, c).size, 0);
});

test('a hidden camera stays out of the picture but still feeds', () => {
  const { p, a } = rig();
  applyOp(p, { op: 'cameraPatch', id: a, patch: { visible: false } });
  feed(p, a);
  assert.equal(cameraLayers(p).some((c) => c.id === a), false, 'the camera stack decides the picture');
  assert.deepEqual(feedPlan(p).sources, [a], 'still a feed source');
  const src = sourceProject(p, a);
  assert.deepEqual(src.cameras.map((c) => c.id), [a]);
  assert.equal(src.cameras[0].visible, true);
  assert.equal(p.cameras.find((c) => c.id === a).visible, false, 'the project is untouched');
});

test('a clip-ranged source camera films the whole project', () => {
  const { p, a } = rig();
  applyOp(p, { op: 'cameraPatch', id: a, patch: { start: 1, duration: 1 } });
  const src = sourceProject(p, a);
  assert.equal(src.cameras[0].start, undefined);
  assert.equal(cameraLayers(src, null, 3.5).length, 1);
});
