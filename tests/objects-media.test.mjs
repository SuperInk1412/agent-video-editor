import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp } from '../core/ops.js';
import { createProject, normalizeProject } from '../core/schema.js';
import {
  mediaSpec, textSpec, fitPlane, normalizeUV, videoTime, videoFrame, videoSpan, mediaUrl, isFontFile,
} from '../core/objects-media.js';
import { bakeObjects } from '../engine/shot.js';

const near = (a, b, eps = 1e-9) => {
  if (Array.isArray(a)) return a.forEach((v, i) => near(v, b[i], eps));
  assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
};
const fresh = () => normalizeProject(createProject({ title: 'media', duration: 10 }));

test('objects-media: defaults', () => {
  const m = mediaSpec({ type: 'image' });
  assert.deepEqual(m, { src: '', srcIn: 0, rate: 1, fit: 'contain', uv: [0, 0, 1, 1], w: 2, h: 2, emissive: 1 });
  const t = textSpec({ type: 'text' });
  assert.equal(t.text, 'Text');
  assert.equal(t.size, 1);
  assert.equal(t.align, 'center');
  assert.equal(t.font, 'SimHei');
  assert.equal(textSpec({ style: { align: 'diagonal', size: -3, text: 42 } }).align, 'center');
  assert.equal(textSpec({ style: { size: -3 } }).size, 0.001);
  assert.equal(textSpec({ style: { text: 42 } }).text, '42');
  assert.equal(mediaSpec({ style: { fit: 'zoom' } }).fit, 'contain');
});

test('objects-media: uv crop is sanitised', () => {
  assert.deepEqual(normalizeUV([0.8, 0.9, 0.2, 0.1]), [0.2, 0.1, 0.8, 0.9]);
  assert.deepEqual(normalizeUV([0.5, 0.5, 0.5, 0.9]), [0, 0, 1, 1]);
  assert.deepEqual(normalizeUV([-1, 0, 2, 1]), [0, 0, 1, 1]);
  assert.deepEqual(normalizeUV('x'), [0, 0, 1, 1]);
});

test('objects-media: fitPlane contain / cover / stretch', () => {
  // 16:9 picture into a 4×4 frame
  near(fitPlane('stretch', 1920, 1080, 4, 4).w, 4);
  const c = fitPlane('contain', 1920, 1080, 4, 4);
  near([c.w, c.h], [4, 4 * 9 / 16]);
  const tall = fitPlane('contain', 1080, 1920, 4, 4);
  near([tall.w, tall.h], [4 * 9 / 16, 4]);
  const cov = fitPlane('cover', 1920, 1080, 4, 4);
  near([cov.w, cov.h], [4, 4]);
  near(cov.uv, [0.5 - 9 / 32, 0, 0.5 + 9 / 32, 1], 1e-12);
  const covTall = fitPlane('cover', 1080, 1920, 4, 2);
  near(covTall.uv, [0, 0.5 - 9 / 64, 1, 0.5 + 9 / 64], 1e-12); // keep 0.5625 / 2 of the height
  // the crop rect is fitted, not the whole picture
  const crop = fitPlane('contain', 1920, 1080, 4, 4, [0, 0, 0.5, 1]);
  near([crop.w, crop.h], [4 * 960 / 1080, 4]);
  // unknown size -> frame as is
  assert.deepEqual(fitPlane('cover', 0, 0, 3, 2), { w: 3, h: 2, uv: [0, 0, 1, 1] });
});

test('objects-media: video time and sequence frames', () => {
  const o = { type: 'video', start: 2, duration: 4, srcIn: 10, rate: 2 };
  near(videoTime(o, 1), 10);
  near(videoTime(o, 3), 12);
  near(videoTime(o, 99), 18);
  assert.equal(videoSpan(o), 8);
  assert.equal(videoFrame(o, 2, 24), 1);
  assert.equal(videoFrame(o, 2 + 1 / 24, 24), 3);
  assert.equal(videoFrame(o, 5.99, 24, 100), 100);
});

test('objects-media: media urls and font files', () => {
  assert.equal(mediaUrl('media/a b.png'), '/media/a b.png');
  assert.equal(mediaUrl('clips\\x.mp4'), '/media/clips/x.mp4');
  assert.ok(isFontFile('media/fonts/sarasa.ttf'));
  assert.ok(!isFontFile('SimHei'));
  assert.ok(!isFontFile('Sarasa Gothic SC'));
});

test('objects-media: ops keep media fields, the bake carries them', () => {
  const p = fresh();
  applyOp(p, { op: 'objectAdd', object: {
    id: 'ob_img', type: 'image', src: 'media/poster.png', geom: { w: 4, h: 3, d: 0.1 },
    style: { fit: 'cover', uv: [0, 0, 0.5, 1] }, scale: [2, 2, 2],
  } });
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_vid', type: 'video', src: 'media/clip.mp4', srcIn: 1, rate: 0.5 } });
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_txt', type: 'text', style: { text: '锈梦', size: 3, color: '#ff0', extrude: 0.2 } } });
  applyOp(p, { op: 'objectPatch', id: 'ob_img', patch: { style: { emissive: 2 } } });
  const q = normalizeProject(JSON.parse(JSON.stringify(p)));
  const img = q.scene.objects.find((o) => o.id === 'ob_img');
  assert.equal(img.src, 'media/poster.png');
  assert.equal(img.style.fit, 'cover');
  assert.equal(img.style.emissive, 2);

  q.scene.objects.find((o) => o.id === 'ob_vid')._sequenceCount = 30;
  const baked = bakeObjects(q, { fps: 10, from: 0, to: 2 });
  const bi = baked.find((b) => b.id === 'ob_img');
  assert.equal(bi.media.fit, 'cover');
  assert.equal(bi.media.w, 4);
  assert.equal(bi.media.emissive, 2);
  assert.equal(bi.media.sequence, null);
  near(bi.frames[0].size, [2, 2, 2], 1e-9); // planes carry only the object scale
  const bv = baked.find((b) => b.id === 'ob_vid');
  assert.equal(bv.frames[0].vf, 1);
  assert.equal(bv.frames[20].vf, 11); // 2 s at rate 0.5 and 10 fps -> frame 11
  const bt = baked.find((b) => b.id === 'ob_txt');
  assert.equal(bt.text.text, '锈梦');
  assert.equal(bt.text.extrude, 0.2);
  assert.equal(bt.media, undefined);
});
