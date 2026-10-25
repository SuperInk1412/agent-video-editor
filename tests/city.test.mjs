import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCity, cityHash } from '../engine/city.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('city generation is deterministic for the same seed', () => {
  const a = generateCity({ seed: 2077 });
  const b = generateCity({ seed: 2077 });
  assert.equal(a.buildings.length, b.buildings.length);
  assert.ok(same(a.buildings, b.buildings));
  assert.ok(same(a.neons, b.neons));
});

test('corridor removes the buildings the camera flies through', () => {
  const world = { seed: 2077, corridor: { enabled: true, radius: 16 } };
  const plain = generateCity(world);
  const target = plain.buildings[0];
  // low pass straight over the first tower -> it must be gone
  const path = [[target.x, 12, target.z - 40], [target.x, 12, target.z], [target.x, 12, target.z + 40]];
  const cleared = generateCity(world, { path });

  assert.ok(cleared.corridor.cleared >= 1);
  assert.equal(cleared.buildings.some((b) => b.seed === target.seed), false);
  assert.equal(cleared.buildings.length, plain.buildings.length - cleared.corridor.cleared);
  assert.notEqual(cleared.hash, plain.hash);
});

test('corridor only removes blocks: surviving buildings are byte-identical', () => {
  const world = { seed: 4242 };
  const plain = generateCity(world);
  const mid = plain.buildings[Math.floor(plain.buildings.length / 2)];
  const path = [[mid.x - 30, 30, mid.z], [mid.x + 30, 30, mid.z]];
  const cut = generateCity(world, { path });

  const lookup = new Set(plain.buildings.map((b) => JSON.stringify(b)));
  for (const b of cut.buildings) assert.ok(lookup.has(JSON.stringify(b)), 'building changed by corridor');
  assert.ok(cut.corridor.cleared >= 1);
  // neons follow their building: never more than the plain city
  assert.ok(cut.neons.length <= plain.neons.length);
});

test('a high pass over the roofs leaves the city alone', () => {
  const world = { seed: 2077, height: { min: 24, max: 60 } };
  const plain = generateCity(world);
  const top = Math.max(...plain.buildings.map((b) => b.h));
  const path = [[0, top + 200, -500], [0, top + 200, 500]];
  const fly = generateCity(world, { path });
  assert.equal(fly.corridor.cleared, 0);
  assert.equal(fly.buildings.length, plain.buildings.length);
});

test('corridor off ignores the path; hash tracks the path only when on', () => {
  const off = { seed: 2077, corridor: { enabled: false, radius: 16 } };
  const path = [[0, 10, -500], [0, 10, 500]];
  const a = generateCity(off);
  const b = generateCity(off, { path });
  assert.equal(b.corridor.cleared, 0);
  assert.equal(a.buildings.length, b.buildings.length);
  assert.equal(a.hash, b.hash);
  assert.equal(cityHash(off, path), cityHash(off, null));

  const on = { seed: 2077, corridor: { enabled: true, radius: 16 } };
  assert.notEqual(cityHash(on, path), cityHash(on, null));
  assert.equal(cityHash(on, path), cityHash(on, path.slice()));
});

test('a sparse keyframe path still cuts a continuous tube', () => {
  const world = { seed: 9, corridor: { enabled: true, radius: 18 } };
  const plain = generateCity(world);
  const a = plain.buildings[0];
  // only two keyframes 400 m apart: sampling must still clear blocks between
  const path = [[a.x, 10, a.z], [a.x, 10, a.z + 400]];
  const cut = generateCity(world, { path });
  assert.ok(cut.corridor.cleared >= 1);
});
