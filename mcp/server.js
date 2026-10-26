#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { connectRuntime } from '../engine/runtime.js';
import { listTools, callTool, resourceDefinitions, readResource } from './tools.js';
import { fault } from '../application/errors.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** Newline-delimited MCP stdio. Only valid JSON-RPC messages reach stdout. */
export function serveMcp({ client, input = process.stdin, output = process.stdout, maxMessageBytes = 4 * 1024 * 1024 } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', phase = 'new', writes = Promise.resolve(), closed = false;
  const pending = new Map();
  const running = new Set();
  const send = (message) => {
    if (closed || output.destroyed) return Promise.resolve();
    const line = JSON.stringify(message) + '\n';
    const write = writes.then(() => new Promise((resolve, reject) => output.write(line, (error) => error ? reject(error) : resolve())));
    writes = write.catch(() => {});
    return write;
  };
  const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const handle = async (message) => {
    const hasId = Object.hasOwn(message || {}, 'id');
    const id = hasId && (typeof message.id === 'string' || Number.isInteger(message.id)) ? message.id : null;
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || hasId && id === null) return rpcError(id, -32600, 'Invalid Request');
    const { method, params = {} } = message;
    if (message.params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params))) {
      if (hasId) return rpcError(id, -32602, 'params must be an object');
      return;
    }
    if (method === 'notifications/initialized' && !hasId) { if (phase === 'initializing') phase = 'ready'; return; }
    if (method === 'notifications/cancelled' && !hasId) { pending.get(params.requestId)?.abort(); return; }
    if (!hasId) return; // Never reply to notifications, including unknown ones.
    if (pending.has(id)) return rpcError(id, -32600, 'duplicate active request id');
    if (pending.size >= 64) return rpcError(id, -32000, 'too many active requests');
    const controller = new AbortController(); pending.set(id, controller);
    try {
      let result;
      if (method === 'initialize') {
        if (phase !== 'new') return await rpcError(id, -32600, 'already initialized');
        if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || !params.capabilities) return await rpcError(id, -32602, 'invalid initialization parameters');
        phase = 'initializing';
        result = { protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'vediomaker', version: '0.2.0' },
          instructions: 'Use vdm_capabilities, read the project revision, then apply small atomic ops with expectedRev and requestId. Render jobs outlive MCP disconnection; poll and explicitly cancel by job id.' };
      } else if (method === 'ping') result = {};
      else {
        if (phase !== 'ready') return await rpcError(id, -32000, 'initialization is not complete');
        switch (method) {
          case 'tools/list': result = { tools: listTools() }; break;
          case 'tools/call':
            if (typeof params?.name !== 'string') return await rpcError(id, -32602, 'tool name is required');
            if (!listTools().some((tool) => tool.name === params.name)) return await rpcError(id, -32602, 'unknown tool');
            result = await callTool(await client, params.name, params.arguments || {}); break;
          case 'resources/list': result = { resources: resourceDefinitions }; break;
          case 'resources/templates/list': result = { resourceTemplates: [{ uriTemplate: 'vdm://artifacts/{jobId}', name: 'rendered-image', mimeType: 'image/png' }] }; break;
          case 'resources/read':
            if (typeof params?.uri !== 'string') return await rpcError(id, -32602, 'resource URI is required');
            result = await readResource(await client, params.uri); break;
          default: return await rpcError(id, -32601, 'Method not found');
        }
      }
      if (controller.signal.aborted) return await rpcError(id, -32800, 'request cancelled; accepted transactions and jobs may still have completed');
      await send({ jsonrpc: '2.0', id, result });
    } catch (e) { await rpcError(id, -32603, e.message); }
    finally { pending.delete(id); }
  };
  let handling = Promise.resolve();
  const track = (promise) => {
    running.add(promise);
    void promise.finally(() => running.delete(promise)).catch(() => {});
  };
  const line = (text) => {
    if (!text.trim()) return;
    let message;
    try { message = JSON.parse(text); } catch { void rpcError(null, -32700, 'Parse error'); return; }
    // Init and initialized are ordered. Calls themselves execute concurrently so
    // cancellation and polling never sit behind a long render submission.
    if (message?.method === 'initialize' || message?.method === 'notifications/initialized') {
      handling = handling.then(() => handle(message)); track(handling);
    } else track(handling.then(() => handle(message)));
  };
  input.on('data', (chunk) => {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const text = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(text) > maxMessageBytes) { void rpcError(null, -32600, 'message too large'); continue; }
      line(text);
    }
    if (Buffer.byteLength(buffer) > maxMessageBytes) { buffer = ''; void rpcError(null, -32600, 'message too large'); input.destroy(); }
  });
  const done = new Promise((resolve) => {
    let ending = false;
    const finish = async () => {
      if (ending) return; ending = true;
      buffer += decoder.end();
      if (buffer.trim()) await rpcError(null, -32700, 'unterminated MCP message');
      await Promise.allSettled([...running]);
      await writes; closed = true; resolve();
    };
    input.on('end', () => { void finish(); });
    input.on('close', () => { void finish(); });
  });
  input.on('error', (e) => { console.error(`[vdm mcp] input: ${e.message}`); });
  output.on('error', () => { closed = true; input.destroy(); });
  return { done };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const index = process.argv.indexOf('--project');
    if (index < 0 || !process.argv[index + 1]) throw fault('INVALID_ARGUMENT', 'usage: node mcp/server.js --project <directory>');
    const client = await connectRuntime(process.argv[index + 1]);
    await serveMcp({ client }).done;
  } catch (e) { console.error(`[vdm mcp] ${e.message}`); process.exitCode = 1; }
}
