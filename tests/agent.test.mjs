import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '../engine/agent.js';
import { createProject } from '../core/schema.js';

function fixture(t) {
  const events = [];
  let sawFinal;
  const final = new Promise((r) => { sawFinal = r; });
  const runner = new AgentRunner({ root: process.cwd(),
    resolveRuntime: async () => ({ node: process.execPath, bin: fileURLToPath(new URL('./fixtures/agent-stub.mjs', import.meta.url)) }),
    onEvent: (event) => { events.push(event); if (event.event?.type === 'final') sawFinal(); },
  });
  t.after(() => runner.close());
  const start = (task) => runner.start({ task, contextFile: 'unused', project: createProject() });
  return { runner, events, final, start };
}

test('cancel after final output prevents proposal submission and waits for exit', { timeout: 10000 }, async (t) => {
  const { runner, events, final, start } = fixture(t);
  await start('review:hang');
  await final;
  assert.equal(runner.cancel(), true);
  await runner.run.done;
  assert.equal(runner.running, false);
  assert.equal(runner.run.status, 'cancelled');
  assert.equal(events.some((event) => event.type === 'proposal'), false);
  const cancelledId = runner.runId;
  await start('review:success');
  await runner.run.done;
  const proposal = events.find((event) => event.type === 'proposal');
  assert.ok(proposal);
  assert.notEqual(proposal.runId, cancelledId);
});

test('failed agent process never submits its final proposal', { timeout: 10000 }, async (t) => {
  const { runner, events, start } = fixture(t);
  await start('review:fail');
  await runner.run.done;
  assert.equal(runner.run.status, 'failed');
  assert.equal(events.some((event) => event.type === 'proposal'), false);
});

test('starting a run reserves its slot before runtime discovery completes', async (t) => {
  const { runner, start } = fixture(t);
  const first = start('review:success');
  await assert.rejects(start('review:success'), /already running/);
  await first;
  await runner.run.done;
});
