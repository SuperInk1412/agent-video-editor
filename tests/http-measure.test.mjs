// HTTP: measurements (WP2.1) — the read model the report tool asks for.
//
//   POST /api/measure  { kind: stackAt | coverage | cutEdges | pxAt | diff | pixelCoverage }
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers/http.mjs';

test('measure over HTTP answers the report tool and rejects unknown kinds', async (t) => {
  const { post } = await setup(t);
  const edges = await post('api/measure', { kind: 'cutEdges' });
  assert.equal(edges.status, 200);
  const edgeBody = await edges.json();
  assert.equal(edgeBody.kind, 'cutEdges');
  assert.ok(Array.isArray(edgeBody.result.edges));

  const stack = await post('api/measure', { kind: 'stackAt', t: 0.5 });
  assert.equal(stack.status, 200);
  const stackBody = (await stack.json()).result;
  assert.ok(Array.isArray(stackBody.order), 'far -> near rows');
  assert.equal(stackBody.items, stackBody.order.length);

  const px = await post('api/measure', { kind: 'pxAt', x: 320, y: 180, frame: 12 });
  assert.equal(px.status, 200);
  assert.equal((await px.json()).result.readPixels, false);

  const bad = await post('api/measure', { kind: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'INVALID_ARGUMENT');
});
