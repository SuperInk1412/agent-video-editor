// dsh headless adapter — docs/DESIGN-BACKEND-V2.md §10.2 WP2.5e.
//
// What this file guards:
//   * the adapter speaks the `AgentLoop` step protocol: one dsh process per
//     step, `next()` returns one tool call, `feed()` records its result and the
//     next prompt carries the conversation;
//   * the answer is read as dsh's NDJSON envelope when present, and the first
//     JSON object in it (markdown fences tolerated) becomes the action;
//   * an answer that is not JSON is a final text — never a fake successful
//     write (the loop treats final text as the agent's closing sentence);
//   * a non-zero exit and a timeout are `AGENT_UNAVAILABLE`, and a machine
//     without dsh resolves to the same code instead of falling back to legacy.
//
// Everything is a local fake "dsh" script (no model, no network): the point is
// the adapter's contract, not the model behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LOOP_TOOLS } from '../engine/agent.js';
import { DshAgent, firstJsonObject, parseDshReply } from '../engine/dsh-agent.js';

const NL = String.fromCharCode(10);

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-dsh-agent-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a fake `dsh` entry point and return its absolute path. */
async function fakeDsh(t, body) {
  const dir = await tempDir(t);
  const bin = path.join(dir, 'fake-dsh.mjs');
  await fs.writeFile(bin, body);
  return { dir, bin };
}

const CTX = {
  task: '把 01 词2 改成 150 号字',
  scope: { elements: ['s1_w2'], paths: ['style.size'], create: false },
  mode: 'tune',
  tools: LOOP_TOOLS,
  state: { rev: 3, plan: null, changesets: [], stills: 0, measurements: 0 },
  context: { selection: { elementIds: ['s1_w2'] }, time: 0.5 },
};

// -------------------------------------------------------------- answer parsing

test('dsh adapter: 回答解析（envelope / 代码围栏 / 非 JSON → final）', () => {
  // A protocol object inside dsh's `final` event text.
  const envelope = JSON.stringify({ type: 'final', text: JSON.stringify({ type: 'tool', name: 'read', args: { what: 'project' } }) });
  assert.deepEqual(parseDshReply(envelope), { type: 'tool', name: 'read', args: { what: 'project' } });

  // Prose + fenced JSON, as a chatty model loves to answer.
  const fenced = 'Let me look first.' + NL + '```json' + NL + '{"type":"tool","tool":"elements","args":{"what":"elements"}}' + NL + '```';
  assert.deepEqual(parseDshReply(fenced), { type: 'tool', name: 'elements', args: { what: 'elements' } });

  // dsh streams `text` events before its `final` one.
  const streamed = [
    JSON.stringify({ type: 'text', text: '{"type":"fi' }),
    JSON.stringify({ type: 'text', text: 'nal","text":"改好了"}' }),
    JSON.stringify({ type: 'final', text: '改好了' }),
  ].join(NL);
  assert.deepEqual(parseDshReply(streamed), { type: 'final', text: '改好了' });

  // Not JSON at all → the prose is the final answer.
  assert.deepEqual(parseDshReply('I would set the lyric to 150 px.'),
    { type: 'final', text: 'I would set the lyric to 150 px.' });

  // A legacy one-shot {"note","ops"} answer is final text; the loop turns it
  // into one change set (WP2.4), so no path around the journal.
  const legacy = '{"note":"n","ops":[{"op":"set","id":"s1_w2","path":"style.size","value":150}]}';
  assert.equal(parseDshReply(legacy).type, 'final');
  assert.equal(parseDshReply(legacy).text, legacy);

  // Braces inside strings do not confuse the scanner.
  assert.deepEqual(firstJsonObject('x {"a":"}{","b":2} y'), { a: '}{', b: 2 });
  assert.equal(firstJsonObject('no object here'), null);
});

// ------------------------------------------------------ tool → feed → next

test('dsh adapter: 工具调用 → feed → 下一步的 prompt 带上对话', { timeout: 30000 }, async (t) => {
  const { dir, bin } = await fakeDsh(t, `
import fs from 'node:fs';
const prompt = process.argv[process.argv.length - 1];
fs.writeFileSync(new URL('./last-prompt.txt', import.meta.url), prompt);
if (prompt.includes('fed-marker-42')) {
  process.stdout.write(JSON.stringify({ type: 'final', text: 'all done' }) + ${JSON.stringify(NL)});
} else {
  process.stdout.write('thinking…' + ${JSON.stringify(NL)});
  process.stdout.write('\`\`\`json' + ${JSON.stringify(NL)});
  process.stdout.write(JSON.stringify({ type: 'tool', name: 'read', args: { what: 'project' } }) + ${JSON.stringify(NL)});
  process.stdout.write('\`\`\`' + ${JSON.stringify(NL)});
}
`);
  const agent = new DshAgent({ bin, cwd: dir, timeoutMs: 15000, name: 'fake-dsh' });
  t.after(() => agent.close());

  const first = await agent.next(CTX);
  assert.deepEqual(first, { type: 'tool', name: 'read', args: { what: 'project' }, id: 't1' });
  assert.equal(agent.steps, 1);

  const firstPrompt = await fs.readFile(path.join(dir, 'last-prompt.txt'), 'utf8');
  assert.match(firstPrompt, /TASK: 把 01 词2 改成 150 号字/);
  assert.match(firstPrompt, /SCOPE: elements \["s1_w2"\] · paths \["style\.size"\]/);
  assert.match(firstPrompt, /REQUEST CONTEXT: .*elementIds/);
  assert.match(firstPrompt, /CONVERSATION SO FAR/);
  assert.match(firstPrompt, /TOOLS \(call exactly one per turn\)/);
  assert.match(firstPrompt, /REPLY WITH EXACTLY ONE JSON OBJECT/);

  agent.feed({ id: first.id, ok: true, result: { marker: 'fed-marker-42' }, ms: 7 });
  const second = await agent.next(CTX);
  assert.deepEqual(second, { type: 'final', text: 'all done' });

  const secondPrompt = await fs.readFile(path.join(dir, 'last-prompt.txt'), 'utf8');
  assert.match(secondPrompt, /1\. read \{"what":"project"\} → ok /);
  assert.match(secondPrompt, /fed-marker-42/);
  assert.match(secondPrompt, /7 ms/);
});

// --------------------------------------------------------- failure modes

test('dsh adapter: 非 JSON 输出当 final 文本，不假装成功', { timeout: 30000 }, async (t) => {
  const { dir, bin } = await fakeDsh(t, `process.stdout.write('I would change the font size to 150.' + ${JSON.stringify(NL)});`);
  const agent = new DshAgent({ bin, cwd: dir, timeoutMs: 15000 });
  t.after(() => agent.close());
  const answer = await agent.next(CTX);
  assert.equal(answer.type, 'final');
  assert.equal(answer.text, 'I would change the font size to 150.');
});

test('dsh adapter: 非零退出 → AGENT_UNAVAILABLE（带上 stderr 尾巴）', { timeout: 30000 }, async (t) => {
  const { dir, bin } = await fakeDsh(t, "process.stderr.write('no auth for profile headless'); process.exit(3);");
  const agent = new DshAgent({ bin, cwd: dir, timeoutMs: 15000 });
  t.after(() => agent.close());
  await assert.rejects(agent.next(CTX), (error) => {
    assert.equal(error.code, 'AGENT_UNAVAILABLE');
    assert.match(error.message, /exited with code 3/);
    assert.match(error.message, /no auth for profile headless/);
    return true;
  });
});

test('dsh adapter: 超时 → AGENT_UNAVAILABLE，进程被收掉', { timeout: 30000 }, async (t) => {
  const { dir, bin } = await fakeDsh(t, 'setTimeout(() => {}, 20000);');
  const agent = new DshAgent({ bin, cwd: dir, timeoutMs: 250 });
  await assert.rejects(agent.next(CTX), (error) => {
    assert.equal(error.code, 'AGENT_UNAVAILABLE');
    assert.match(error.message, /did not answer within 250 ms/);
    return true;
  });
  // close() waits for the killed child, so removing the directory afterwards
  // cannot race a process that still holds it (Windows).
  await agent.close();
});

test('dsh adapter: 找不到 dsh 就是 AGENT_UNAVAILABLE（不回退 legacy）', { timeout: 30000 }, async (t) => {
  const agent = new DshAgent({ resolveRuntime: async () => null });
  t.after(() => agent.close());
  await assert.rejects(agent.next(CTX), (error) => {
    assert.equal(error.code, 'AGENT_UNAVAILABLE');
    assert.match(error.message, /DSH-TUI not found/);
    return true;
  });
});

test('dsh adapter: close() 幂等，关闭后再 next 直接不可用', { timeout: 30000 }, async (t) => {
  const { dir, bin } = await fakeDsh(t, `process.stdout.write('{"type":"final","text":"ok"}' + ${JSON.stringify(NL)});`);
  const agent = new DshAgent({ bin, cwd: dir, timeoutMs: 15000 });
  await agent.close();
  await agent.close();
  await assert.rejects(agent.next(CTX), (error) => error.code === 'AGENT_UNAVAILABLE');
});
