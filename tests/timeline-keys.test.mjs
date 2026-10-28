import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostKeys, poolHostKeys, keyedSections,
  elementHostKeys, objectHostKeys, cameraHostKeys,
} from '../core/timeline-keys.js';
import { cameraRef, objectRef, elementRef } from '../core/selection.js';

const project = () => ({
  elements: [
    {
      id: 'el_keys',
      keyframes: [
        { t: 0, path: 'transform.x', value: 0 },
        { t: 1, path: 'style.size', value: 40 }, // inspector-only row: no lane
      ],
    },
    { id: 'el_styleonly', keyframes: [{ t: 0, path: 'style.size', value: 40 }] },
    { id: 'el_plain', keyframes: [] },
    { id: 'el_audio', type: 'audio', keyframes: [{ t: 0, path: 'audio.volume', value: 1 }] },
  ],
  cameras: [
    {
      id: 'cam_path',
      path: [{ t: 0, pos: [0, 10, 0] }],
      tracks: {},
    },
    {
      id: 'cam_params',
      path: [],
      tracks: {
        fov: [{ t: 0, v: 50 }],
        'shake.freq': [{ t: 0, v: 2 }],
        'dof.fstop': [{ t: 0, v: 2.8 }],
      },
    },
    { id: 'cam_idle', path: [], tracks: {} },
  ],
  camera: { id: 'cam_path' },
  scene: {
    objects: [
      { id: 'ob_pivot', tracks: { 'pivot.x': [{ t: 0, v: 1 }] } },
      { id: 'ob_scale', tracks: { scale: [{ t: 0, v: [1, 1, 1] }] } },
      { id: 'ob_empty', tracks: {} },
    ],
  },
});

test('element host keys only count rows the timeline can draw', () => {
  const p = project();
  const keys = elementHostKeys(p.elements[0]);
  assert.equal(keys.keyed, true);
  assert.deepEqual(keys.paths, new Set(['transform.x']));
  assert.deepEqual(keys.groups, new Set(['transform']));

  // A style-only key is inspector-only: no timeline row, so U must not expand.
  const styleOnly = elementHostKeys(p.elements[1]);
  assert.equal(styleOnly.keyed, false);
  assert.deepEqual(styleOnly.paths, new Set());

  assert.equal(elementHostKeys(p.elements[2]).keyed, false);
  const audio = elementHostKeys(p.elements[3]);
  assert.equal(audio.keyed, true);
  assert.deepEqual(audio.groups, new Set(['audio']));
});

test('3D object keys group under 变换, content is never keyable', () => {
  const p = project();
  const pivot = objectHostKeys(p.scene.objects[0]);
  assert.equal(pivot.keyed, true);
  // One diamond row covers pivot / pivot.x / pivot.y / pivot.z.
  assert.deepEqual(pivot.paths, new Set(['pivot']));
  assert.deepEqual(pivot.groups, new Set(['transform']));
  assert.deepEqual(objectHostKeys(p.scene.objects[1]).paths, new Set(['scale']));
  assert.equal(objectHostKeys(p.scene.objects[2]).keyed, false);
});

test('camera keys map to their section (path keys belong to 变换)', () => {
  const p = project();
  assert.deepEqual(cameraHostKeys(p.cameras[0]), {
    keyed: true,
    paths: new Set(['path']),
    groups: new Set(['camPos']),
  });
  const params = cameraHostKeys(p.cameras[1]);
  assert.equal(params.keyed, true);
  assert.deepEqual(params.groups, new Set(['camMain', 'camShake', 'camDof']));
  assert.equal(cameraHostKeys(p.cameras[2]).keyed, false);
});

test('hostKeys resolves element / object / camera refs and drops stale ones', () => {
  const p = project();
  assert.equal(hostKeys(p, elementRef('el_keys')).type, 'el');
  assert.equal(hostKeys(p, objectRef('ob_pivot')).type, 'ob');
  assert.equal(hostKeys(p, cameraRef('cam_path')).type, 'cam');
  // The active camera alias is not in `cameras`; it must still resolve.
  assert.equal(hostKeys(p, cameraRef('cam_path')).id, 'cam_path');
  assert.equal(hostKeys(p, elementRef('el_missing')), null);
  assert.equal(hostKeys(p, cameraRef('cam_missing')), null);
  assert.equal(hostKeys(p, 'nonsense'), null);
});

test('poolHostKeys keeps pool order and marks which hosts U may expand', () => {
  const p = project();
  const pool = {
    kind: 'element',
    ids: [cameraRef('cam_idle'), objectRef('ob_pivot'), elementRef('el_plain'),
      elementRef('el_keys'), elementRef('el_missing')],
    primary: elementRef('el_keys'),
  };
  const states = poolHostKeys(p, pool);
  assert.deepEqual(states.map((s) => s.ref), ['cam:cam_idle', 'ob:ob_pivot', 'el:el_plain', 'el:el_keys']);
  assert.deepEqual(states.filter((s) => s.keyed).map((s) => s.ref), ['ob:ob_pivot', 'el:el_keys']);
  // Non-element pools are not a host selection.
  assert.deepEqual(poolHostKeys(p, { kind: 'property', ids: ['cam:cam_path:fov'], primary: 'cam:cam_path:fov' }), []);
  assert.deepEqual(poolHostKeys(p, null), []);
});

test('keyedSections lists the groups that must stay open', () => {
  const p = project();
  assert.deepEqual(keyedSections(hostKeys(p, cameraRef('cam_params'))), ['camMain', 'camShake', 'camDof']);
  assert.deepEqual(keyedSections(hostKeys(p, objectRef('ob_empty'))), []);
  assert.deepEqual(keyedSections(null), []);
});
