// HTTP: the edit agent routes (WP2.5e).
//
//   POST /api/agent          one AgentLoop run; 409 while a run is in flight
//   POST /api/agent/approve  approve the plan the loop stopped on
//   POST /api/agent/cancel   stop between steps
//   GET  /api/agent/state    running / runId / loop state
//   GET  /api/context
//
// The end-to-end test drives the real server with `VDM_AGENT_SCRIPT`, so no
// dsh and no model are involved: the scripted transport decides, the loop
// enforces (plan → change set → approval → apply), and the SSE stream is read
// like the renderer reads it. A second test uses `VDM_AGENT_BIN` (the external
// line-protocol adapter) to keep a run in flight while it checks 409 + cancel.
// The 503 case is tested against the route itself: no dsh on the machine must
// answer AGENT_UNAVAILABLE instead of silently falling back to legacy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProject } from '../core/schema.js';
import { saveProject } from '../engine/storage.js';
import { AgentLoop } from '../engine/agent.js';
import { register as registerAgentRoutes } from '../engine/routes/agent.js';
import { setup } from './helpers/http.mjs';

const NL = String.fromCharCode(10);
const AGENT_ENV = ['VDM_AGENT_SCRIPT', 'VDM_AGENT_BIN', 'VDM_AGENT_NODE', 'VDM_AGENT_MODE',
  'VDM_AGENT_APPROVAL', 'VDM_AGENT_SCOPE', 'VDM_AGENT_LEGACY'];

/** Set the agent environment for one test and restore it afterwards. */
function setAgentEnv(t, values) {
  const before = new Map(AGENT_ENV.map((key) => [key, process.env[key]]));
  for (const key of AGENT_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function tempFile(t, name, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-http-agent-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await fs.writeFile(file, body);
  return file;
}

async function waitFor(check, { timeout = 5000, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Record SSE events exactly as the renderer's EventSource sees them. */
async function recordEvents(t, service) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${service.info.url}api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch { /* the test aborts the stream on the way out */ }
  })();
  await waitFor(() => events.some((event) => event.type === 'hello'), { label: 'SSE hello' });
  const agentEvents = () => events.filter((event) => event.type === 'agent').map((event) => event.data);
  return { events, agentEvents };
}

// --------------------------------------------------- approve with nothing pending

test('the approve route is honest while no agent loop is running', async (t) => {
  const { post } = await setup(t);
  const response = await post('api/agent/approve', { planId: 'plan_1' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'NO_PENDING_PLAN');
});

// ------------------------------------------------------- plan → approve → apply

test('POST /api/agent 走 AgentLoop：计划 → 批准 → 变更集 applied（脚本传输）', { timeout: 60000 }, async (t) => {
  const script = [
    { tool: 'read', args: { what: 'project' } },
    { tool: 'plan', args: { intent: '把 el_1 挪到 0.5s', steps: [{ title: '移动', kind: 'timing', ops: [{ op: 'moveElement', id: 'el_1', start: 0.5 }] }] } },
    { tool: 'changeset', args: { action: 'propose', intent: '把 el_1 挪到 0.5s', ops: [{ op: 'moveElement', id: 'el_1', start: 0.5 }] } },
    { tool: 'changeset', args: { action: 'apply', intent: '把 el_1 挪到 0.5s', ops: [{ op: 'moveElement', id: 'el_1', start: 0.5 }] } },
    { type: 'final', text: '已把 el_1 挪到 0.5s' },
  ];
  setAgentEnv(t, {
    VDM_AGENT_SCRIPT: await tempFile(t, 'agent-script.json', JSON.stringify(script)),
    VDM_AGENT_MODE: 'create',
  });
  const { service, post, get } = await setup(t);
  const initial = await service.projects.read();
  const { events, agentEvents } = await recordEvents(t, service);

  const response = await post('api/agent', {
    task: '把 el_1 挪到 0.5s',
    selection: { elementIds: ['el_1'] },
    time: 0.5,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'awaiting-approval', '创作模式的大计划停在批准前');
  assert.ok(body.runId.startsWith('loop-'));
  assert.equal(body.plan.intent, '把 el_1 挪到 0.5s');
  assert.equal(body.plan.steps.length, 1);
  assert.equal(body.changesets.length, 1);
  assert.equal(body.changesets[0].status, 'proposed');
  const proposedId = body.changesets[0].id;
  assert.equal((await service.projects.read()).rev, initial.rev, 'the plan phase wrote nothing');

  // The event stream carried the loop's phases, with the proposal attached.
  await waitFor(() => agentEvents().some((event) => event.type === 'loop' && event.phase === 'awaiting-approval'),
    { label: 'awaiting-approval event' });
  const planned = agentEvents();
  assert.ok(planned.some((event) => event.type === 'loop' && event.phase === 'start'));
  assert.ok(planned.some((event) => event.type === 'tool' && event.name === 'read' && event.ok));
  assert.ok(planned.some((event) => event.type === 'plan' && event.plan?.id === body.plan.id));
  assert.ok(planned.some((event) => event.type === 'changeset' && event.action === 'propose' && event.record?.id === proposedId));
  assert.equal(planned.filter((event) => event.type === 'tool' && event.name === 'still').length, 0, 'no still before approval');

  // GET /api/agent/state reports the loop, not a legacy runner.
  const stateResponse = await get('api/agent/state');
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.running, false);
  assert.equal(state.runId, body.runId);
  assert.equal(state.transport, 'scripted-file');
  assert.equal(state.state.status, 'awaiting-approval');
  assert.equal(state.state.context.time, 0.5);
  assert.deepEqual(state.state.context.selection.elementIds, ['el_1']);

  // Approve → the loop resumes and applies the change set.
  const approveResponse = await post('api/agent/approve', { planId: body.plan.id });
  assert.equal(approveResponse.status, 200);
  const done = await approveResponse.json();
  assert.equal(done.status, 'completed');
  assert.equal(done.agentText, '已把 el_1 挪到 0.5s');
  const applied = done.changesets.find((row) => row.status === 'applied');
  assert.ok(applied, 'the approved plan produced an applied change set');
  assert.ok(applied.changed >= 1);
  assert.ok(done.verification, 'the run hands back its verification summary');
  assert.ok(done.reportPath?.endsWith('.json'), `report path: ${done.reportPath}`);

  const project = await service.projects.read();
  assert.equal(project.elements.find((el) => el.id === 'el_1').start, 0.5);
  assert.equal(project.rev, initial.rev + 1, 'one applied change set = one revision');

  // ... and the applied change set reached the review channel + project refresh.
  await waitFor(() => events.some((event) => event.type === 'changeset' && event.data.action === 'apply'), { label: 'changeset SSE apply' });
  await waitFor(() => events.some((event) => event.type === 'project' && event.data.rev === project.rev), { label: 'project SSE refresh' });
  const finished = agentEvents();
  assert.ok(finished.some((event) => event.type === 'changeset' && event.action === 'apply' && event.record?.status === 'applied'));
  assert.ok(finished.some((event) => event.type === 'report' && event.report?.status === 'completed'));
  assert.ok(finished.some((event) => event.type === 'loop' && event.phase === 'done'));

  // One run at a time, and a finished plan cannot be approved twice.
  const noPlan = await post('api/agent/approve', { planId: body.plan.id });
  assert.equal(noPlan.status, 404);
  assert.equal((await noPlan.json()).code, 'NO_PENDING_PLAN');
  // Cancelling a finished run is an honest no-op.
  const cancel = await (await post('api/agent/cancel', {})).json();
  assert.equal(cancel.ok, false);
  assert.equal(cancel.status, 'completed');
  assert.equal(cancel.runId, body.runId);
});

// ------------------------------------------- 409 while running + cancel between steps

test('POST /api/agent：运行中再请求 409，cancel 在步间生效（外部适配器传输）', { timeout: 60000 }, async (t) => {
  const adapter = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + ${JSON.stringify(NL)});
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'user') setTimeout(() => send({ type: 'tool', name: 'read', args: { what: 'project' } }), 300);
  else if (message.type === 'tool_result') setTimeout(() => send({ type: 'final', text: '慢死了' }), 300);
});
`;
  setAgentEnv(t, { VDM_AGENT_BIN: await tempFile(t, 'agent-adapter.mjs', adapter) });
  const { service, post, get } = await setup(t);
  const { agentEvents } = await recordEvents(t, service);

  const pending = post('api/agent', { task: '慢任务：读一下工程' });
  await waitFor(() => agentEvents().some((event) => event.type === 'loop' && event.phase === 'start'), { label: 'loop start' });

  const busy = await post('api/agent', { task: '再来一次' });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, 'AGENT_RUNNING');

  const cancelled = await (await post('api/agent/cancel', {})).json();
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.running, true);

  const response = await pending;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'cancelled');
  assert.equal(body.runId, cancelled.runId);

  const state = await (await get('api/agent/state')).json();
  assert.equal(state.running, false);
  assert.equal(state.state.status, 'cancelled');
  await waitFor(() => agentEvents().some((event) => event.type === 'loop' && event.phase === 'cancelled'), { label: 'cancelled event' });
});

// --------------------------------------------------- no dsh → 503, never legacy

/** A router that only remembers the two methods agent routes use. */
function captureRouter() {
  const handlers = new Map();
  const add = (method) => (routePath, handler) => { handlers.set(`${method} ${routePath}`, handler); };
  return {
    router: { post: add('POST'), get: add('GET') },
    handler: (method, routePath) => handlers.get(`${method} ${routePath}`),
  };
}

test('POST /api/agent：传输不可用时返回 503 AGENT_UNAVAILABLE（不回退 legacy）', { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-http-agent-503-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveProject(root, createProject());
  const loop = new AgentLoop({
    root,
    scope: { elements: ['*'], paths: ['*'], create: true },
    agent: {
      name: 'dead',
      async next() { throw Object.assign(new Error('DSH-TUI not found'), { code: 'AGENT_UNAVAILABLE' }); },
      async close() { /* nothing to release */ },
    },
  });
  t.after(() => loop.close());
  const { router, handler } = captureRouter();
  registerAgentRoutes(router, {
    agentMode: 'loop',
    agent: loop,
    readBody: async () => ({ task: '随便改一下' }),
    json: (res, code, body) => { res.status = code; res.body = body; },
    getProject: () => null,
  });
  const res = {};
  await handler('POST', '/api/agent')({ headers: {} }, res);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'AGENT_UNAVAILABLE');
  assert.equal(loop.running, false);
});
