import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { once } from 'node:events';
import { serveMcp } from '../mcp/server.js';
import { listTools } from '../mcp/tools.js';
import { validateContract } from '../application/validate-contract.js';
import { projectService } from '../engine/projects.js';
import { startServer } from '../engine/server.js';
import { findBlender } from '../engine/blender.js';

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' }, capabilities: {} } };

test('stdio handles split Unicode, initialization, notifications, unknown methods and invalid arguments', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const results = [];
  const lines = readline.createInterface({ input: output }); lines.on('line', (line) => results.push(JSON.parse(line)));
  const server = serveMcp({ input, output, client: { call: async () => ({ title: '夜之城' }) } });
  const messages = [initialize, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: '夜', method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'unknown' },
    { jsonrpc: '2.0', method: 'unknown-notification' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vdm_project_apply_ops', arguments: { ops: [] } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vdm_capabilities', arguments: {} } },
  ];
  const bytes = Buffer.from(messages.map(JSON.stringify).join('\n') + '\n');
  for (let i = 0; i < bytes.length; i += 7) input.write(bytes.subarray(i, i + 7));
  input.end(); await server.done;
  assert.equal(results.length, 5);
  assert.equal(results.find((r) => r.id === 1).result.protocolVersion, '2025-11-25');
  assert.equal(results.find((r) => r.id === '夜').result.tools.length, listTools().length);
  assert.equal(results.find((r) => r.id === 3).error.code, -32601);
  assert.equal(results.find((r) => r.id === 4).result.isError, true);
  assert.equal(results.find((r) => r.id === 5).result.structuredContent.title, '夜之城');
  lines.close();
});

test('operation schemas reject unknown kinds and unexpected fields before runtime calls', () => {
  const schema = listTools().find((tool) => tool.name === 'vdm_project_apply_ops').inputSchema;
  const valid = { expectedRev: 1, requestId: 'one', ops: [{ op: 'set', id: 'el_1', path: 'transform.scale', value: 0 }] };
  validateContract(valid, schema);
  for (const op of [{ op: 'restoreProject', project: {} }, { op: 'set', id: 'el_1', path: 'transform.x', value: 1, typo: 2 }]) {
    assert.throws(() => validateContract({ ...valid, ops: [op] }, schema));
  }
});

test('malformed request params and oversized input return protocol errors and close cleanly', async () => {
  const input = new PassThrough(), output = new PassThrough(), results = [];
  const lines = readline.createInterface({ input: output }); lines.on('line', (line) => results.push(JSON.parse(line)));
  const server = serveMcp({ input, output, client: {}, maxMessageBytes: 128 });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: null }) + '\n');
  input.write('x'.repeat(129));
  await server.done;
  assert.ok(results.some((item) => item.error.code === -32602));
  assert.ok(results.some((item) => item.error.code === -32600));
  lines.close();
});

function childClient(root, t) {
  const child = spawn(process.execPath, ['mcp/server.js', '--project', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0, stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  child.on('exit', () => { for (const resolve of pending.values()) resolve({ error: { message: stderr || 'MCP exited' } }); pending.clear(); });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  t.after(async () => { if (child.exitCode == null) { const exit = once(child, 'exit'); child.stdin.end(); await exit; } lines.close(); });
  return { request: (method, params) => new Promise((resolve) => { const requestId = ++id; pending.set(requestId, resolve); send({ jsonrpc: '2.0', id: requestId, method, params }); }),
    notify: (method) => send({ jsonrpc: '2.0', method }), stderr: () => stderr };
}

test('two stdio sessions share atomic edits and a real rendered image', { timeout: 45000 }, async (t) => {
  try { await findBlender(); } catch { return t.skip('Blender not installed'); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-mcp-'));
  const projects = projectService(root);
  await projects.transact({ command: { type: 'initialize', options: { width: 128, height: 72, duration: 1 } } });
  const runtime = await startServer({ root, port: 0 });
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const a = childClient(root, t), b = childClient(root, t);
  for (const client of [a, b]) {
    const hello = await client.request('initialize', initialize.params); assert.ok(hello.result);
    client.notify('notifications/initialized');
  }
  const call = async (client, name, args) => {
    const response = await client.request('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  };
  const input = { expectedRev: 1, requestId: 'shared-create', ops: [{ op: 'addElement', element: { type: 'solid', duration: 1, style: { fill: '#ff2020' } } }] };
  assert.equal((await call(a, 'vdm_project_apply_ops', { ...input, dryRun: true })).structuredContent.rev, 1);
  const edit = await call(a, 'vdm_project_apply_ops', input);
  assert.equal(edit.isError, false);
  assert.equal((await call(b, 'vdm_project_apply_ops', input)).structuredContent.replayed, true);
  const conflict = await call(b, 'vdm_project_apply_ops', { ...input, requestId: 'stale' });
  assert.equal(conflict.structuredContent.error.code, 'REV_CONFLICT');
  assert.equal((await call(b, 'vdm_project_read', {})).structuredContent.rev, 2);
  const submitted = await call(a, 'vdm_render_submit', { kind: 'still', time: 0.5, expectedRev: 2, requestId: 'frame', scale: 1, samples: 2 });
  const id = submitted.structuredContent.jobId;
  const done = await runtime.jobs.wait(id);
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  const image = await call(b, 'vdm_artifact_read', { id, image: true });
  assert.ok(image.content.some((block) => block.type === 'image' && Buffer.from(block.data, 'base64').subarray(1, 4).toString() === 'PNG'));
  const resource = await b.request('resources/read', { uri: `vdm://artifacts/${id}` });
  assert.equal(resource.result.contents[0].mimeType, 'image/png');
  assert.equal((await call(a, 'vdm_job_cancel', { id })).structuredContent.status, 'succeeded');
  assert.equal(a.stderr(), '');
});
