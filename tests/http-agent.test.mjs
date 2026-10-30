// HTTP: the edit agent routes.
//
//   POST /api/agent, /api/agent/cancel, /api/agent/approve, GET /api/agent/state,
//   GET /api/context
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers/http.mjs';

test('the approve route is honest while no agent loop is running', async (t) => {
  const { post } = await setup(t);
  const response = await post('api/agent/approve', { planId: 'plan_1' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'NO_PENDING_PLAN');
});
