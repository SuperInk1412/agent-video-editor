// dsh headless adapter for the `AgentLoop` tool protocol (WP2.5e).
//
// `AgentLoop` talks to a transport in steps: `next(ctx)` returns one tool call
// or a final answer, `feed(pending)` hands back the result of the tool the loop
// just ran. `ProcessAgent` keeps one child process alive and speaks NDJSON with
// it; dsh's headless profile is the opposite shape — one prompt in, one answer
// out, no session between runs. This file is the seam between the two:
//
//   * every step spawns `dsh --profile headless --json <prompt>` once;
//   * the prompt carries the task, the scope, the tool surface, the conversation
//     so far (tool + args + result) and the "one JSON object" answer format;
//   * the reply is read as dsh's NDJSON envelope when it looks like one, and the
//     first JSON object in the answer (markdown fences and chatter tolerated)
//     becomes `{type:'tool'|'final'}`;
//   * an answer that is not JSON is a final text: the loop treats it as the
//     agent's closing sentence, never as a successful write;
//   * a spawn failure, a non-zero exit or a timeout is `AGENT_UNAVAILABLE`, which
//     `POST /api/agent` turns into a 503 instead of falling back to legacy.
//
// The process is not shared between steps (dsh headless is one-shot); the
// conversation lives here, so the adapter — not the runtime — is stateful.
import { spawn } from 'node:child_process';
import { fault } from '../application/errors.js';
import { findDsh, killTree, LOOP_TOOLS } from './agent.js';

const NL = String.fromCharCode(10);
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_PROMPT_HISTORY = 40;

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** JSON-ish text for a prompt: strings stay readable, everything else is compact. */
function clip(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function tail(text, limit = 800) {
  const value = String(text || '').trim();
  return value.length > limit ? value.slice(-limit) : value;
}

/**
 * First complete JSON object in `text`, tolerating markdown fences and prose
 * before/after it. Returns null when there is none.
 */
export function firstJsonObject(text) {
  if (typeof text !== 'string' || !text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '');
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth !== 0) continue;
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

/** One answer object (or raw text) as the transport return value. */
function normalizeAnswer(value, fallback) {
  if (isRecord(value)) {
    if (value.type === 'tool' || (value.type === undefined && typeof value.tool === 'string')) {
      const name = value.name ?? value.tool;
      if (typeof name === 'string' && name) {
        return { type: 'tool', name, args: isRecord(value.args) ? value.args : {} };
      }
    }
    if (value.type === 'final') return { type: 'final', text: typeof value.text === 'string' ? value.text : '' };
  }
  return { type: 'final', text: typeof fallback === 'string' ? fallback.trim() : '' };
}

/**
 * Turn one dsh invocation's stdout into `{type:'tool',name,args}` or
 * `{type:'final',text}`.
 *
 * dsh `--json` prints one event per line: `{"type":"text","text":…}` for the
 * answer stream and `{"type":"final","text":…}` for the closing text. A fake
 * adapter may simply print the answer object itself, so both shapes are read.
 * Anything that exposes no JSON object is the agent's prose answer.
 */
export function parseDshReply(stdout) {
  const text = String(stdout ?? '');
  let envelopeFinal = null;
  let streamed = '';
  let direct = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (!isRecord(event)) continue;
    if (event.type === 'final' && typeof event.text === 'string') envelopeFinal = event.text;
    else if (event.type === 'text' && typeof event.text === 'string') streamed += event.text;
    else if (event.type === 'tool' && typeof event.name === 'string') direct = event;
  }
  if (envelopeFinal !== null) return normalizeAnswer(firstJsonObject(envelopeFinal), envelopeFinal);
  if (streamed.trim()) return normalizeAnswer(firstJsonObject(streamed), streamed);
  if (direct) return normalizeAnswer(direct, JSON.stringify(direct));
  const object = firstJsonObject(text);
  return object ? normalizeAnswer(object, text) : { type: 'final', text: text.trim() };
}

/**
 * `AgentLoop` transport that drives dsh headless one step at a time.
 *
 * @param {object} options
 * @param {string} [options.root]        project directory (also the child cwd)
 * @param {string} [options.node]        node binary; defaults to the one `findDsh` returns
 * @param {string} [options.bin]         explicit dsh entry (skips discovery — tests/tools)
 * @param {string[]} [options.args]      extra dsh arguments before `--profile headless --json`
 * @param {string} [options.cwd]         child working directory (defaults to `root`)
 * @param {object} [options.env]         child environment
 * @param {number} [options.timeoutMs]   one step's budget (default 180 s)
 * @param {Function} [options.resolveRuntime]  `() => {node,bin}|null`, defaults to `findDsh`
 */
export class DshAgent {
  constructor({
    root, node, bin, args = [], cwd, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS,
    resolveRuntime = findDsh, name = 'dsh', maxOutput = 2 * 1024 * 1024,
  } = {}) {
    this.name = name;
    this.root = root ? String(root) : null;
    this.resolveRuntime = resolveRuntime;
    this.options = {
      node: node || null,
      bin: bin || null,
      args: Array.isArray(args) ? args : [],
      cwd: cwd || this.root || process.cwd(),
      env,
      timeoutMs: Math.max(1, Math.round(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
      maxOutput: Math.max(1024, Math.round(Number(maxOutput) || 2 * 1024 * 1024)),
    };
    this.history = [];
    this.turn = 0;
    this.lastAction = null;
    this.child = null;
    this.runtime = null;
    this.closed = false;
  }

  get steps() { return this.turn; }

  async next(ctx = {}) {
    if (this.closed) throw fault('AGENT_UNAVAILABLE', 'the dsh transport is closed');
    const prompt = this.#prompt(ctx);
    const stdout = await this.#run(prompt);
    const answer = parseDshReply(stdout);
    this.turn += 1;
    this.lastAction = answer.type === 'tool' ? answer : null;
    return answer.type === 'tool' ? { ...answer, id: answer.id || `t${this.turn}` } : answer;
  }

  /** Remember the tool result so the next prompt shows the conversation. */
  feed(pending) {
    if (!pending) return;
    const action = this.lastAction;
    const ok = pending.ok !== false;
    this.history.push({
      n: this.history.length + 1,
      tool: action?.name ?? '?',
      args: action?.args ?? {},
      ok,
      ...(ok ? { result: pending.result ?? null } : { error: pending.error ?? null }),
      ms: pending.ms ?? null,
    });
    this.lastAction = null;
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.lastAction = null;
    if (!child) return;
    try { child.stdout?.destroy(); } catch { /* already gone */ }
    try { child.stderr?.destroy(); } catch { /* already gone */ }
    killTree(child);
    // The child's cwd is the project directory; a test that removes it must not
    // race a dying process (Windows holds the handle).
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      // A step that already timed out can have exited before we got here.
      if (child.exitCode !== null || child.signalCode !== null) return finish();
      child.once('close', finish);
      setTimeout(finish, 2000);
    });
  }

  // ------------------------------------------------------------- prompt + run

  #prompt(ctx) {
    const scope = isRecord(ctx.scope) ? ctx.scope : {};
    const state = isRecord(ctx.state) ? ctx.state : {};
    const changesets = Array.isArray(state.changesets) ? state.changesets : [];
    const lines = [
      'You are the edit agent inside VedioMaker (a local video composer).',
      'You cannot run shell commands and you cannot write files: you act by asking the engine to run exactly one tool per turn.',
      `TASK: ${String(ctx.task ?? '').trim() || '(none given)'}`,
      `SCOPE: elements ${JSON.stringify(scope.elements ?? [])} · paths ${JSON.stringify(scope.paths ?? [])}${scope.create ? ' · creating new elements is allowed' : ''}`,
      `MODE: ${ctx.mode === 'create' ? 'create (larger rewrites allowed)' : 'tune (small, reversible changes)'}`,
    ];
    if (isRecord(ctx.context) && Object.keys(ctx.context).length) {
      lines.push(`REQUEST CONTEXT: ${clip(ctx.context, 1200)}`);
    }
    lines.push(`STATE: rev ${state.rev ?? '?'} · plan ${state.plan?.id ?? 'none'}`
      + ` · changesets ${changesets.length ? changesets.map((row) => `${row.id}:${row.status}`).join(', ') : 'none'}`
      + ` · stills ${state.stills ?? 0} · measurements ${state.measurements ?? 0}`);
    lines.push('', 'CONVERSATION SO FAR (oldest first):');
    if (!this.history.length) lines.push('  (empty — your first turn usually reads the project)');
    else for (const row of this.history.slice(-MAX_PROMPT_HISTORY)) {
      const outcome = row.ok
        ? `ok ${clip(row.result, 3000)}`
        : `error ${row.error?.code || 'ERROR'}: ${clip(row.error?.message ?? '', 600)}`;
      lines.push(`  ${row.n}. ${row.tool} ${clip(row.args, 600)} → ${outcome}${row.ms != null ? ` (${row.ms} ms)` : ''}`);
    }
    const tools = Array.isArray(ctx.tools) && ctx.tools.length ? ctx.tools : LOOP_TOOLS;
    lines.push('', 'TOOLS (call exactly one per turn):');
    for (const tool of tools) {
      lines.push(`  - ${tool.name}: ${tool.summary}${tool.args ? ` args: ${clip(tool.args, 400)}` : ''}`);
    }
    lines.push(
      '',
      'REPLY WITH EXACTLY ONE JSON OBJECT and nothing else — no markdown fences, no prose before or after:',
      '  {"type":"tool","name":"<tool>","args":{...}}   to act now',
      '  {"type":"final","text":"<one sentence>"}       only when the task is finished',
      'RULES:',
      '  1. stay inside SCOPE — the engine refuses anything outside it;',
      '  2. every write is one change set: propose first, apply after the plan is approved;',
      '  3. measure instead of claiming — use "measure" for numbers and "still" for pixels;',
      '  4. when the engine returns an error, fix the arguments and retry in the same run;',
      '  5. never invent element ids or property paths — "read" and "contracts" tell you the truth.',
    );
    return lines.join(NL);
  }

  async #runtime() {
    if (this.runtime) return this.runtime;
    const { node, bin } = this.options;
    if (bin) {
      this.runtime = { node: node || process.execPath, bin };
      return this.runtime;
    }
    let found = null;
    try { found = await this.resolveRuntime(); } catch (error) {
      throw fault('AGENT_UNAVAILABLE', `could not locate dsh: ${error.message}`);
    }
    if (!found || !found.bin) {
      throw fault('AGENT_UNAVAILABLE', 'DSH-TUI not found. Install it (npm i -g @deepseek-ai/dsh) or set VDM_DSH to its lib/bin.js');
    }
    this.runtime = { node: node || found.node || process.execPath, bin: found.bin };
    return this.runtime;
  }

  async #run(prompt) {
    const runtime = await this.#runtime();
    const { cwd, env, timeoutMs, maxOutput, args } = this.options;
    const childEnv = { ...env };
    // Electron's own binary has to be told to behave like node (the dsh bundle
    // silently exits otherwise).
    if (process.versions.electron && runtime.node === process.execPath) childEnv.ELECTRON_RUN_AS_NODE = '1';
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(runtime.node, [runtime.bin, ...args, '--profile', 'headless', '--json', prompt],
          { cwd, windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(fault('AGENT_UNAVAILABLE', `could not start dsh: ${error.message}`));
        return;
      }
      this.child = child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn, { keepChild = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!keepChild) this.child = null;
        fn();
      };
      const timer = setTimeout(() => {
        try { child.stdout?.destroy(); } catch { /* already gone */ }
        try { child.stderr?.destroy(); } catch { /* already gone */ }
        killTree(child);
        // The step budget is spent, so answer now; `this.child` stays so
        // `close()` (or a later step) can wait for the process to really die —
        // Windows keeps its working directory locked until then.
        finish(() => reject(fault('AGENT_UNAVAILABLE', `dsh did not answer within ${timeoutMs} ms`)), { keepChild: true });
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > maxOutput) stdout = stdout.slice(-maxOutput);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 40000) stderr = stderr.slice(-20000);
      });
      child.on('error', (error) => {
        finish(() => reject(fault('AGENT_UNAVAILABLE', `dsh failed to start: ${error.message}`)));
      });
      child.on('close', (code) => {
        if (code === 0) finish(() => resolve(stdout));
        else {
          const detail = tail(stderr);
          finish(() => reject(fault('AGENT_UNAVAILABLE', `dsh exited with code ${code}${detail ? `: ${detail}` : ''}`)));
        }
      });
    });
  }
}
