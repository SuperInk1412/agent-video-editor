import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { evalElement } from '../core/evaluate.js';
import { compileProject, clearCompiledTracks } from '../core/tracks.js';

const fields = ['x', 'y', 'scale', 'rotation', 'opacity', 'style.size', 'fx.glow', 'style.text'];
const results = [];
for (const count of [10, 100, 1000]) {
  const project = { elements: Array.from({ length: count }, (_, i) => ({ id: `e${i}`, start: 0, duration: 10,
    keyframes: Array.from({ length: 32 }, (_, n) => fields.map((field, f) => ({ t: n / 4,
      path: field.includes('.') ? field : `transform.${field}`, value: field === 'style.text' ? String(n) : n + f, ease: 'linear' }))).flat() })), cameras: [] };
  const run = () => {
    let checksum = 0;
    for (let frame = 0; frame < 24; frame++) for (const element of project.elements) checksum += evalElement(element, frame / 3, {}).x;
    return checksum;
  };
  clearCompiledTracks();
  const start = performance.now(), reference = run(), referenceMs = performance.now() - start;
  compileProject(project);
  const begin = performance.now(), optimized = run(), compiledMs = performance.now() - begin;
  assert.equal(optimized, reference);
  results.push({ elements: count, keysPerElement: 256, frames: 24, referenceMs: +referenceMs.toFixed(2), compiledMs: +compiledMs.toFixed(2), speedup: +(referenceMs / compiledMs).toFixed(2) });
}
console.log(JSON.stringify({ node: process.version, results }, null, 2));
