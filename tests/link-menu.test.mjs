// Property-link UI helpers (app/renderer/js/link-menu.js): catalog filtering,
// row-path mapping and labels. The DOM menu itself is exercised by the Electron
// capture check, not by Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraRowLinkPaths,
  elementRowLinkPaths,
  linkHostLabel,
  linkJumpTarget,
  linkOf,
  linkSourceChoices,
  linkSourceLabel,
  linkSummary,
  objectRowLinkPaths,
} from '../app/renderer/js/link-menu.js';
import { findLinkTarget } from '../core/links.js';

const transform = (x = 0, y = 0) => ({
  x, y, z: 0, scale: 1, rotation: 0, opacity: 1,
});

function fixture() {
  return {
    meta: { width: 1920, height: 1080, fps: 30, duration: 5 },
    elements: [
      {
        id: 'el_a', name: 'A', type: 'solid', start: 0, duration: 5, transform: transform(),
        keyframes: [], links: [],
      },
      {
        id: 'el_b', name: 'B', type: 'solid', start: 0, duration: 5, transform: transform(),
        keyframes: [], links: [],
      },
      {
        id: 'el_node', name: 'N', type: 'solid', start: 0, duration: 5, transform: transform(),
        node: { pivot: [0, 0, 0], position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1] },
        keyframes: [], links: [],
      },
    ],
    scene: {
      objects: [{
        id: 'ob_c', name: 'Cube', type: 'solid', start: 0, duration: 5,
        pivot: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1], rot: { dir: [0, 0, 1], roll: 0 },
        tracks: {}, links: [],
      }],
    },
    cameras: [{
      id: 'cam_1', name: '相机 1', path: [], center: [0, 0, 0], scale: [1, 1, 1],
      fov: 50, roll: 0, tracks: {}, links: [],
    }],
    camera: { id: 'cam_1' },
  };
}

const byHost = (choices, kind, id) => choices.find((c) => c.kind === kind && c.id === id);

test('link-menu: legacy 2D rows link pivot.* / roll / scale.*, never transform.*', () => {
  const legacy = { id: 'el_1', transform: transform(), keyframes: [] };
  assert.deepEqual(elementRowLinkPaths(legacy, 'transform.x'), ['pivot.x']);
  assert.deepEqual(elementRowLinkPaths(legacy, 'transform.y'), ['pivot.y']);
  assert.deepEqual(elementRowLinkPaths(legacy, 'transform.z'), ['pivot.z']);
  assert.deepEqual(elementRowLinkPaths(legacy, 'transform.scale'), ['scale.x']);
  assert.deepEqual(elementRowLinkPaths(legacy, 'transform.rotation'), ['roll']);
  assert.deepEqual(elementRowLinkPaths(legacy, 'transform.opacity'), ['opacity']);
  assert.deepEqual(elementRowLinkPaths(legacy, 'audio.volume'), ['audio.volume']);
  assert.deepEqual(elementRowLinkPaths(legacy, 'transform.name'), []);
  for (const row of ['transform.x', 'transform.y', 'transform.z', 'transform.scale', 'transform.rotation', 'transform.opacity']) {
    for (const path of elementRowLinkPaths(legacy, row)) {
      assert.ok(!path.startsWith('transform.'), `${row} must not link a transform.* path`);
      assert.ok(findLinkTarget('el', legacy, path), `${path} is in the legacy element catalog`);
    }
  }
  // Migrated elements keep screen placement on the node pivot (migrate-spatial
  // rewrites transform.x/y keys to pivot.x/y); the row editor maps accordingly.
  const node = { id: 'el_2', node: { pivot: [0, 0, 0] } };
  assert.deepEqual(elementRowLinkPaths(node, 'transform.x'), ['pivot.x']);
  assert.deepEqual(elementRowLinkPaths(node, 'transform.y'), ['pivot.y']);
  assert.deepEqual(elementRowLinkPaths(node, 'transform.z'), ['pivot.z']);
  assert.deepEqual(elementRowLinkPaths(node, 'transform.scale'), ['scale.x']);
});

test('link-menu: 3D and camera timeline rows map to catalog paths', () => {
  assert.deepEqual(objectRowLinkPaths('pivot'), ['pivot.x', 'pivot.y', 'pivot.z']);
  assert.deepEqual(objectRowLinkPaths('position'), ['position.x', 'position.y', 'position.z']);
  assert.deepEqual(objectRowLinkPaths('scale'), ['scale.x', 'scale.y', 'scale.z']);
  assert.deepEqual(objectRowLinkPaths('opacity'), ['opacity']);
  assert.deepEqual(objectRowLinkPaths('roll'), ['roll']);
  assert.deepEqual(objectRowLinkPaths('geom'), []);
  assert.deepEqual(cameraRowLinkPaths('center'), ['pivot.x', 'pivot.y', 'pivot.z']);
  assert.deepEqual(cameraRowLinkPaths('scale'), ['scale.x', 'scale.y', 'scale.z']);
  assert.deepEqual(cameraRowLinkPaths('fov'), ['fov']);
  assert.deepEqual(cameraRowLinkPaths('path'), ['path']);
  assert.equal(findLinkTarget('cam', null, 'path'), null, 'camera path position is never linkable');
});

test('link-menu: source choices stay in the child unit, on real hosts and never @live', () => {
  const p = fixture();
  const choices = linkSourceChoices(p, 'el', 'el_b', 'pivot.x');
  assert.ok(choices.length >= 3);
  for (const choice of choices) {
    assert.ok(['el', 'ob', 'cam'].includes(choice.kind));
    assert.notEqual(choice.id, '@live');
    assert.ok(choice.targets.length > 0);
    for (const target of choice.targets) {
      assert.equal(target.unit, 'length', `${choice.label}.${target.path} is a length`);
      assert.ok(!(choice.kind === 'cam' && target.path.startsWith('position.')), 'camera path position is excluded');
      assert.equal(target.cycle, false);
    }
  }
  // The exact child property is never offered as its own source.
  assert.ok(!(byHost(choices, 'el', 'el_b')?.targets || []).some((t) => t.path === 'pivot.x'));
  // Other properties of the same host are fine, and 3D/camera hosts are listed.
  assert.ok((byHost(choices, 'el', 'el_b')?.targets || []).some((t) => t.path === 'pivot.y'));
  assert.ok(byHost(choices, 'ob', 'ob_c'), '3D object is a source');
  assert.ok(byHost(choices, 'cam', 'cam_1'), 'camera is a source');
  assert.ok(!(byHost(choices, 'ob', 'ob_c')?.targets || []).some((t) => t.unit !== 'length'));
});

test('link-menu: node elements expose the full node catalog; units never mix', () => {
  const p = fixture();
  const node = linkSourceChoices(p, 'el', 'el_a', 'pivot.x').find((c) => c.id === 'el_node');
  assert.ok(node, 'node element is a source');
  assert.ok(node.targets.some((t) => t.path === 'position.x'));
  assert.ok(node.targets.some((t) => t.path === 'position.z'));
  // Node scale.z is a ratio: it only appears for a ratio child row.
  const ratioNode = linkSourceChoices(p, 'el', 'el_b', 'scale.x').find((c) => c.id === 'el_node');
  assert.ok(ratioNode.targets.some((t) => t.path === 'scale.z'));
  const roll = linkSourceChoices(p, 'el', 'el_b', 'roll');
  for (const choice of roll) {
    for (const target of choice.targets) assert.equal(target.unit, 'angle');
  }
  assert.ok(roll.some((c) => c.kind === 'cam' && c.targets.some((t) => t.path === 'maxRoll')));
  const ratio = linkSourceChoices(p, 'el', 'el_b', 'scale.x');
  for (const choice of ratio) {
    for (const target of choice.targets) assert.equal(target.unit, 'ratio');
  }
});

test('link-menu: current source and would-be cycles are flagged, not hidden', () => {
  const p = fixture();
  p.elements[0].links = [{ // el_a.pivot.x <- el_b.pivot.x
    id: 'lnk_1', to: 'pivot.x', from: { host: 'el', id: 'el_b', path: 'pivot.x' },
    combine: 'add', bindParentValue: 0, enabled: true,
  }];
  p.elements[1].links = [{ // el_b.pivot.x <- el_a.pivot.x  => cycle
    id: 'lnk_2', to: 'pivot.x', from: { host: 'el', id: 'el_a', path: 'pivot.x' },
    combine: 'add', bindParentValue: 0, enabled: true,
  }];
  const current = linkSourceChoices(p, 'el', 'el_a', 'pivot.x');
  const b = byHost(current, 'el', 'el_b');
  assert.equal(b.targets.find((t) => t.path === 'pivot.x').current, true);
  assert.equal(b.targets.find((t) => t.path === 'pivot.y').current, false);
  // el_b.pivot.x -> el_a.pivot.x would close the 2-node loop.
  const child = linkSourceChoices(p, 'el', 'el_b', 'pivot.x');
  assert.equal(byHost(child, 'el', 'el_a').targets.find((t) => t.path === 'pivot.x').cycle, true);
  // A different property of the same host is not a cycle.
  assert.equal(byHost(child, 'el', 'el_a').targets.find((t) => t.path === 'pivot.y').cycle, false);
});

test('link-menu: labels, summaries and jump payloads read from the project', () => {
  const p = fixture();
  p.elements[0].links = [{
    id: 'lnk_1', to: 'pivot.x', from: { host: 'ob', id: 'ob_c', path: 'pivot.y' },
    combine: 'add', bindParentValue: 0, enabled: true,
  }];
  p.elements[0].links.push({
    id: 'lnk_2', to: 'roll', from: { host: 'cam', id: 'cam_1', path: 'fov' },
    combine: 'add', bindParentValue: 0, enabled: true,
  });
  const link = linkOf(p.elements[0], 'pivot.x');
  assert.equal(linkSourceLabel(p, link), '3D「Cube」 · 中心点 Y');
  assert.equal(linkHostLabel(p, 'el', 'el_a'), '元素「A」');
  assert.equal(linkHostLabel(p, 'ob', 'missing'), '3D「missing」');
  assert.equal(linkHostLabel(p, 'cam', 'cam_1'), '相机「相机 1」');
  assert.deepEqual(linkJumpTarget(link, 'pivot.x'), { host: 'ob', id: 'ob_c', path: 'pivot.y', to: 'pivot.x' });
  assert.equal(linkJumpTarget(null), null);
  const summary = linkSummary(p, p.elements[0]);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.hosts, ['3D「Cube」 · 中心点 Y', '相机「相机 1」 · 视场角 FOV']);
  assert.equal(linkSummary(p, p.elements[1]), null);
  assert.equal(linkOf(p.elements[0], 'pivot.y'), null);
});
