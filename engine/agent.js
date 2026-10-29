// DSH-TUI agent bridge.
//
// Two ways to drive an agent, one file:
//
// 1. `AgentRunner` — the legacy one-shot path (kept while the renderer still
//    posts /api/agent). It spawns `dsh --profile headless --json <task>` in the
//    project directory and streams its NDJSON run events; the headless profile
//    can read files but cannot run shell commands, so the agent reads
//    project.vdm.json and replies with one ops object ({"note","ops"}), which
//    the engine validates and applies through core/ops.js. Killing the process
//    = interrupting the agent. Nothing about this path changed in WP2.4.
//
// 2. `AgentLoop` — the WP2.4 tool loop (docs/DESIGN-BACKEND-V2.md §8.4):
//    read → plan → propose a change set → render stills → measure → correct.
//    Every write is one change set through `application/changeset-service.js`
//    (proposed → applied, or reverted), so it lands in the journal with its
//    `changesetId`, can be reviewed, and can be reverted one property at a
//    time. The agent talks to a tool surface (read / contracts / ops / plan /
//    changeset / still / measure / report); every ops batch it wants to write
//    is validated against `core/contracts.js` first and checked against the
//    request's `scope` (element ids + property-path whitelist). The §8.3
//    report is assembled by the loop from the change-set diffs and the
//    measurements it took itself — never from the agent's own prose.
//
// Loop protocol (transport = `ProcessAgent`, one JSON object per line on
// stdout, tool results back on stdin):
//
//   agent  → {"type":"tool","id":"t1","name":"read","args":{"what":"project"}}
//   engine → {"type":"tool_result","id":"t1","ok":true,"result":{…}}
//   agent  → {"type":"final","text":"一句话总结"}
//   engine → {"type":"user","text":"任务…"}            (first line, before t1)
//
// `ScriptedAgent` speaks the same interface in-process (tests, offline runs),
// so a run never needs dsh or the network. The real dsh adapter is not wired
// yet: the headless CLI is one-shot, so `ProcessAgent` is the seam a later WP
// plugs into. See docs/AGENT-PROTOCOL.md for the ops/property contracts.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { which } from './which.js';
import { projectService } from './projects.js';
import { analyzeBeatsLocal } from './beats.js';
import { cloneProject } from '../core/schema.js';
import {
  CONTRACT_VERSION, EDIT_OPS_ARRAY, EDIT_SCHEMA, KEYABLE_PATHS, OP_CONTRACTS, PROPERTY_PATHS_BY_HOST, PUBLIC_OPS,
} from '../core/contracts.js';
import { ChangeSetService } from '../application/changeset-service.js';
import { content } from '../application/project-service.js';
import { validateContract } from '../application/validate-contract.js';
import { fault } from '../application/errors.js';
import { coverage, cutEdges, estimateTextBox, stackAt } from '../application/inspect-service.js';

const NL = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = path.resolve(HERE, '../cli/vdm.js');

const isElectron = !!process.versions.electron;

function npmRoots(node) {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || '';
    return [
      path.join(appdata, 'npm', 'node_modules'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs', 'node_modules'),
    ];
  }
  const home = os.homedir();
  return [
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'lib', 'node_modules'),
    node && path.join(path.dirname(path.dirname(node)), 'lib', 'node_modules'),
    path.join(home, '.local', 'lib', 'node_modules'),
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
}

let cachedNode = null;

/**
 * A real Node binary. Electron's own binary (even with ELECTRON_RUN_AS_NODE)
 * silently exits when running the dsh bundle, so prefer system node.
 */
async function findNode() {
  if (cachedNode) return cachedNode;
  if (process.env.VDM_NODE) { cachedNode = process.env.VDM_NODE; return cachedNode; }
  if (!isElectron) { cachedNode = process.execPath; return cachedNode; }
  cachedNode = which('node') || process.execPath;
  return cachedNode;
}

export async function findDsh() {
  const node = await findNode();
  if (process.env.VDM_DSH && fss.existsSync(process.env.VDM_DSH)) {
    return { node, bin: process.env.VDM_DSH };
  }
  for (const root of npmRoots(node)) {
    const bin = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fss.existsSync(bin)) return { node, bin };
  }
  const shim = which('dsh');
  if (!shim) return null;
  // npm links `dsh` straight to lib/bin.js on POSIX; on Windows it is a .cmd shim
  // that node cannot run, so only hand node a real JS entry.
  let real = shim;
  try { real = fss.realpathSync(shim); } catch { /* keep the shim */ }
  if (/\.(c|m)?js$/i.test(real)) return { node, bin: real };
  return null;
}

function killTree(child) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* ignore */ }
}

export class AgentRunner {
  constructor({ root, onEvent, resolveRuntime = findDsh }) {
    this.root = root;
    this.onEvent = onEvent;
    this.resolveRuntime = resolveRuntime;
    this.run = null;
  }

  get running() { return !!this.run && ['starting', 'running', 'applying', 'cancelling'].includes(this.run.status); }
  get runId() { return this.run?.id || null; }

  /** Context bundle the agent reads: selection, frames, project summary. */
  async writeContext({ selection, frames = [], extra = {} }) {
    const dir = path.join(this.root, '.vdm', 'agent');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `context-${stamp}.json`);
    const bundle = {
      created: new Date().toISOString(),
      projectRoot: this.root,
      selection,
      frames,
      cli: `node "${CLI_PATH}" --project "${this.root}"`,
      ...extra,
    };
    await fs.writeFile(file, JSON.stringify(bundle, null, 2));
    return file;
  }

  buildTask({ task, contextFile, frames, selection, project }) {
    const seg = selection?.segmentId ? project.segments.find((s) => s.id === selection.segmentId) : null;
    const segEls = project.elements
      .filter((e) => !selection?.segmentId || !e.segment || e.segment === selection.segmentId)
      .map((e) => {
        const text = e.type === 'text' ? `, "${String(e.style.text).slice(0, 24)}"` : '';
        return `${e.id} (${e.type}, ${e.start.toFixed(2)}s +${e.duration.toFixed(2)}s, z${e.z}${text})`;
      });
    const frameList = (frames || []).map((f) => `  - ${f}`).join(NL) || '  (none)';
    const lines = [
      'You are the edit agent inside VedioMaker, a local video composer.',
      'You CANNOT run shell commands. Read the project, then reply with edit operations as JSON.',
      '',
      `Project: ${this.root}/project.vdm.json (read it for full detail; it is the timeline document)`,
      `Context bundle: ${contextFile} (selection, beats, frames, summary)`,
      'Frames of the target segment (look at them if you can read images):',
      frameList,
      '',
      seg
        ? `Target segment: ${seg.id} "${seg.name}" ${seg.start.toFixed(2)}s .. ${(seg.start + seg.duration).toFixed(2)}s`
        : 'Target: whole timeline',
      'Elements available:',
      segEls.map((x) => '  ' + x).join(NL) || '  (none)',
      '',
      'REPLY FORMAT - one JSON object, no markdown fences, no prose before/after:',
      '{"note": "one sentence about what you changed", "ops": [ ... ]}',
      '',
      'Operations (same schema the UI and CLI use):',
      '  {"op":"updateElement","id":"el_x","patch":{"style":{"text":"new caption","size":120},"transform":{"y":-40},"motion":{"type":"in","amount":0.1}}}',
      '  {"op":"set","id":"el_x","path":"style.color","value":"#ffd400"}',
      '  {"op":"keySet","id":"el_x","path":"transform.scale","t":4.2,"value":1.2,"ease":"outExpo"}',
      '  {"op":"keyRemove","id":"el_x","path":"transform.scale","t":4.2}   (omit t to clear the whole track)',
      'Keyframe times (t) are absolute project seconds, not relative to the element start.',
      '  {"op":"addElement","element":{"type":"text","start":4.0,"duration":2.5,"z":5,"segment":"seg_2","style":{"text":"TITLE","size":140,"color":"#ffffff"},"transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1},"fadeIn":0.3}}',
      '  {"op":"moveElement","id":"el_x","start":4.0,"duration":2.5}',
      '  {"op":"removeElement","id":"el_x"}',
      '  {"op":"setFx","fx":{"bloom":0.5,"ca":0.3,"grain":0.12,"vignette":0.5,"scanline":0.2}}',
      '  {"op":"setMeta","path":"background","value":"#05070d"}',
      '',
      'Rules:',
      '1. Stay inside the target segment unless the user explicitly asks for the whole piece.',
      '2. Small, reversible changes; 1-6 ops is usually enough.',
      '3. Keep text short - it is rendered at 1920x1080, font size 80-200.',
      '4. Use only the element ids listed above, or add a new element.',
      '5. Align times with meta.beats when it makes sense.',
      '',
      'TASK:',
      task || 'Improve the selected segment.',
    ];
    return lines.join(NL);
  }

  async start({ task, contextFile, frames = [], selection = {}, project }) {
    if (this.running) throw new Error('agent is already running');
    // Reserve this run before resolving the executable; simultaneous starts
    // cannot pass the guard, and callbacks never read the next run's state.
    let finish;
    const run = { id: `run-${randomUUID()}`, baseRev: project.rev, status: 'starting', cancelled: false,
      child: null, finalText: '', text: '', startedAt: Date.now(), done: new Promise((r) => { finish = r; }) };
    this.run = run;
    const emit = async (ev) => this.onEvent?.({ runId: run.id, baseRev: run.baseRev, ...ev });
    let dsh, child;
    try {
      dsh = await this.resolveRuntime();
      if (run.cancelled) throw new Error('agent cancelled');
      if (!dsh) throw new Error('DSH-TUI not found. Install it (npm i -g @deepseek-ai/dsh) or set VDM_DSH to lib/bin.js');
      const prompt = this.buildTask({ task, contextFile, frames, selection, project });
      const env = { ...process.env };
      if (isElectron && dsh.node === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
      child = spawn(dsh.node, [dsh.bin, '--profile', 'headless', '--json', prompt], { cwd: this.root, windowsHide: true, env });
      run.child = child;
      run.status = 'running';
    } catch (e) {
      run.status = run.cancelled ? 'cancelled' : 'failed';
      finish();
      throw e;
    }
    const forward = (ev) => { void emit(ev).catch(() => {}); };
    forward({ type: 'started', bin: dsh.bin, node: dsh.node });

    let buf = '';
    const handle = (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try { ev = JSON.parse(s); } catch { forward({ type: 'raw', text: s }); return; }
      if (ev.type === 'text') {
        run.text += ev.text || '';
        forward({ type: 'agent', event: ev });
      } else if (ev.type === 'final') {
        run.finalText = ev.text || run.text;
        forward({ type: 'agent', event: ev });
      } else {
        forward({ type: 'agent', event: ev });
      }
    };
    child.stdout.on('data', (d) => {
      buf += String(d);
      const parts = buf.split(NL);
      buf = parts.pop();
      parts.forEach(handle);
    });
    let errText = '';
    child.stderr.on('data', (d) => {
      errText += String(d);
      if (errText.length > 20000) errText = errText.slice(-10000);
    });
    child.on('error', (e) => { run.failed = true; forward({ type: 'error', message: String(e) }); });
    child.on('close', async (code) => {
      if (buf) handle(buf);
      run.child = null;
      try {
        const proposal = !run.cancelled && !run.failed && code === 0 ? extractProposal(run.finalText || run.text) : null;
        if (proposal) {
          run.status = 'applying';
          await emit({ type: 'proposal', proposal });
        }
        run.status = run.cancelled ? 'cancelled' : code === 0 && !run.failed ? 'succeeded' : 'failed';
        await emit({
          type: 'exit',
          code,
          cancelled: run.cancelled,
          seconds: (Date.now() - run.startedAt) / 1000,
          stderr: errText ? errText.slice(-2000) : '',
          hadFinal: !!run.finalText,
        });
      } catch (e) {
        run.status = 'failed';
        forward({ type: 'error', message: String(e) });
      } finally { finish(); }
    });
    return { runId: run.id };
  }

  cancel() {
    const run = this.run;
    if (!this.running || run.cancelled || run.status === 'applying') return false;
    run.cancelled = true;
    run.status = 'cancelling';
    killTree(run.child);
    void Promise.resolve(this.onEvent?.({ runId: run.id, type: 'cancelled' })).catch(() => {});
    return true;
  }

  async close() { this.cancel(); await this.run?.done; }
}

/** Pull {"note","ops"} out of the agent's final answer (tolerates fences / chatter). */
export function extractProposal(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end));
    if (obj && Array.isArray(obj.ops)) return { note: obj.note || '', ops: obj.ops };
    if (obj && obj.op) return { note: '', ops: [obj] };
  } catch { /* fall through */ }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// WP2.4 · agent tool loop — docs/DESIGN-BACKEND-V2.md §8.4
//
//   read → plan → propose a change set → render stills → measure → correct
//
// The loop is the engine half; a transport (`ScriptedAgent` here, a real dsh
// adapter later) plays the agent half. Whatever the transport does, the engine
// owns four things the agent cannot talk its way out of:
//
//   * scope — `{ elements, paths, create }` from the request. A write outside
//     it is refused before a change set exists (`PATH_OUTSIDE_SCOPE`); a write
//     to a locked host is refused by WP2.2's `assertUnlockedWrite` (`LOCKED`).
//   * contracts — every ops batch is validated against `core/contracts.js`
//     (`validateContract` + `EDIT_SCHEMA`'s op array) before it is proposed.
//   * change sets — every write is one, `proposed` → `applied`, recorded in the
//     journal with its `changesetId`, revertible (WP2.2).
//   * the report — §8.3 evidence assembled from the change-set diffs plus the
//     measurements this loop took itself, not from the agent's prose.
//
// Scope syntax (ours, not from the design doc — §8.1 only says "element ids and
// property paths"):
//
//   { elements: ['s1_w2'], paths: ['style.size', 'start'], create: false }
//
//   elements  exact host ids, or '*' for every host. '@project' addresses
//             project-level ops (`setMeta`, `setFx`, `worldSet`, segments),
//             '@new' addresses host creation (`addElement`, `addCamera`, …).
//   paths     exact property paths, a trailing `.*` for a subtree
//             (`style.*`), or '*' for any. Structural ops add `@host`
//             (`removeElement`, `splitElement`, `reorder`, …), creation adds
//             `@create`.
//   create    allow `@new`. `'*'` in elements does not imply it.
//
// Every target of an op must match: a `updateElement` patch that touches
// `style.size` and `style.color` needs both paths in the whitelist.
// ═══════════════════════════════════════════════════════════════════════════

/** Bump when the tool surface or the report shape changes. */
export const LOOP_VERSION = 1;

/** Error code for a write outside the request's scope (§8.1). */
export const PATH_OUTSIDE_SCOPE = 'PATH_OUTSIDE_SCOPE';

/** Micro-tune mode caps one change set at six ops (§8.4: 1–6 ops). */
const TUNE_MAX_OPS = 6;
/** A plan bigger than this needs a human "go" even in auto mode (§8.4). */
const APPROVAL_OPS = 6;
const APPROVAL_HOSTS = 3;
const DEFAULT_MAX_STEPS = 80;
/** A still render boots the app offscreen; give it room, then kill it. */
const STILL_TIMEOUT_MS = 180000;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const round3 = (value) => Math.round(Number(value) * 1000) / 1000;
const nowIso = () => new Date().toISOString();

/** `keyframes[1.26].style.color` → `keyframes[*].style.color` (report grouping). */
const pathClassOf = (path) => String(path ?? '')
  .replace(/^keyframes\[[^\]]+\]/, 'keyframes[*]')
  .replace(/\[\d+\]/g, '[*]');

/** The path every loop-generated artifact lives under (inside the project). */
const agentDir = (root, ...parts) => path.join(root, '.vdm', 'agent', ...parts);

// ------------------------------------------------------------------- scope

/**
 * Normalize a request scope. A missing scope is an error: §8.1 says every agent
 * request carries its range, and a loop without one would be unrestricted.
 */
export function normalizeScope(scope) {
  if (!isRecord(scope)) {
    throw fault('INVALID_ARGUMENT', 'an agent run needs a scope ({ elements, paths })');
  }
  const list = (value, name) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
      throw fault('INVALID_ARGUMENT', `scope.${name} must be an array of nonempty strings`);
    }
    return [...new Set(value)];
  };
  const elements = list(scope.elements, 'elements');
  const paths = list(scope.paths, 'paths');
  if (!elements.length) throw fault('INVALID_ARGUMENT', 'scope.elements must name at least one id (or \'*\')');
  if (!paths.length) throw fault('INVALID_ARGUMENT', 'scope.paths must name at least one path (or \'*\')');
  return Object.freeze({
    elements: Object.freeze(elements),
    paths: Object.freeze(paths),
    create: scope.create === true || elements.includes('@new'),
  });
}

/** `style.size` etc. — nested patch objects become their leaf paths. */
function flattenPaths(prefix, value, out, depth = 2) {
  if (!isRecord(value) || depth <= 0) {
    if (prefix) out.add(prefix);
    return out;
  }
  const keys = Object.keys(value);
  if (!keys.length) {
    if (prefix) out.add(prefix);
    return out;
  }
  for (const key of keys) flattenPaths(prefix ? `${prefix}.${key}` : key, value[key], out, depth - 1);
  return out;
}

const flattenSet = (value, depth = 2) => [...flattenPaths('', value, new Set(), depth)];

/**
 * Where one op writes: `[{ id, paths }]`. Derived from the op contract's own
 * field names, so a new op does not silently slip past the scope check — an
 * op with neither `id` nor `path` nor a known body is treated as project-wide
 * and must be white-listed explicitly.
 */
export function opTargets(op) {
  if (!isRecord(op) || typeof op.op !== 'string') throw fault('OP_INVALID', 'op must be an object with an op name');
  if (op.op === 'batch') {
    return (op.ops || []).flatMap((inner) => opTargets(inner));
  }
  const targets = [];
  const create = () => targets.push({ id: '@new', paths: new Set(['@create']) });
  if (op.op === 'addElement') {
    create();
    targets[0].paths = new Set(['@create', ...flattenSet(op.element || {})]);
    return targets;
  }
  if (op.op === 'addCamera' || op.op === 'addSegment' || op.op === 'objectAdd') {
    create();
    if (op.segment) targets[0].paths.add(...flattenSet(op.segment));
    return targets;
  }
  const id = typeof op.id === 'string' && op.id ? op.id : '@project';
  const paths = new Set();
  if (typeof op.path === 'string' && op.path) paths.add(op.path);
  if (isRecord(op.patch)) for (const entry of flattenSet(op.patch)) paths.add(entry);
  if (op.op === 'moveElement') {
    paths.add('@host');
    for (const key of ['start', 'duration', 'z', 'segment', 'keys']) if (key in op) paths.add(key);
  }
  if (['removeElement', 'splitElement', 'duplicateElement', 'reorder'].includes(op.op)) paths.add('@host');
  if (op.op === 'spatialParent') { paths.add('@host'); paths.add('parent'); }
  if (op.op === 'spatialUnparent') paths.add('@host');
  if (op.op === 'setFx') { paths.add('fx'); for (const key of Object.keys(op.fx || {})) paths.add(`fx.${key}`); }
  if (op.op === 'worldSet') paths.add('world');
  if (op.op === 'codeParamSet' && typeof op.name === 'string') paths.add(`code.params.${op.name}`);
  if (op.op === 'setMeta' || op.op === 'updateSegment' || op.op === 'removeSegment') {
    if (!paths.size) paths.add('@meta');
  }
  if (!paths.size) paths.add(`@op:${op.op}`);
  targets.push({ id, paths });
  return targets;
}

const idInScope = (scope, id) => {
  if (id === '@new') return scope.create || scope.elements.includes('@new') || scope.elements.includes('*');
  if (scope.elements.includes('*')) return true;
  return scope.elements.includes(id);
};

const pathInScope = (scope, target) => scope.paths.some((entry) => entry === '*'
  || entry === target
  || (entry.endsWith('.*') && target.startsWith(entry.slice(0, -1))));

/**
 * Throw `PATH_OUTSIDE_SCOPE` for the first op that reaches outside `scope`.
 * Read-only: nothing is written, no change set exists, so a refused run leaves
 * the project and the journal exactly as they were.
 */
export function checkScope(ops, scope) {
  const normalized = normalizeScope(scope);
  if (!Array.isArray(ops)) throw fault('INVALID_ARGUMENT', 'ops must be an array');
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    let targets;
    try {
      targets = opTargets(op);
    } catch (error) {
      throw fault('OP_INVALID', `op #${index + 1}: ${error.message}`);
    }
    for (const target of targets) {
      if (!idInScope(normalized, target.id)) {
        throw fault(PATH_OUTSIDE_SCOPE,
          `op #${index + 1} (${op.op}) targets ${target.id}, outside scope (elements: ${normalized.elements.join(', ')})`,
          { op: index, name: op.op, id: target.id, path: null, scope: scopeSummary(normalized) });
      }
      for (const targetPath of target.paths) {
        if (!pathInScope(normalized, targetPath)) {
          throw fault(PATH_OUTSIDE_SCOPE,
            `op #${index + 1} (${op.op}) writes ${target.id}.${targetPath}, outside scope (paths: ${normalized.paths.join(', ')})`,
            { op: index, name: op.op, id: target.id, path: targetPath, scope: scopeSummary(normalized) });
        }
      }
    }
  }
  return { ok: true, ops: ops.length, scope: scopeSummary(normalized) };
}

const scopeSummary = (scope) => ({ elements: [...scope.elements], paths: [...scope.paths], create: !!scope.create });

// ------------------------------------------------------------- tool surface

/**
 * The tool surface the agent sees. Kept as data so a transport can serialize it
 * into a prompt (`ProcessAgent`) or hand it to a policy (`ScriptedAgent`).
 */
export const LOOP_TOOLS = Object.freeze([
  { name: 'read', summary: '读项目摘要 / 元素 / 节拍 / 分镜。只读。',
    args: { what: 'project | elements | element | beats | segments', id: '元素 id', name: '名字或文字片段（模糊）', near: '{ id, edge: "start"|"end" } 或多个 t' } },
  { name: 'contracts', summary: '查询 op / 属性路径契约（core/contracts.js 的唯一来源）。只读。',
    args: { what: 'ops | op | paths | edit', name: 'op 名（what="op" 时）', host: 'el | ob | cam（what="paths" 时）' } },
  { name: 'ops', summary: '用契约校验一包 ops：不写盘、不建变更集。', args: { ops: 'op 数组' } },
  { name: 'plan', summary: '提交计划（steps[] + intent）；大计划会停下等批准。',
    args: { intent: '一句话目的', steps: '[{ title, kind?, ops? }]' } },
  { name: 'changeset', summary: '变更集：propose（只暂存）| apply | revert | list | show。写项目的唯一入口。',
    args: { action: 'propose | apply | revert | list | show', ops: 'op 数组（propose / apply 直接提交时）', id: '变更集 id', intent: '一句话目的' } },
  { name: 'still', summary: '出图：把某一帧渲染成 PNG，返回路径与尺寸。', args: { t: '秒', frame: '帧号', label: '文件名前缀' } },
  { name: 'measure', summary: '测量：stackAt | coverage | diff | textBox | cutEdges。',
    args: { what: '测量种类', id: '元素 id（diff 用变更集 id）', t: '秒', point: '[x, y] 项目像素', focus: '元素 id（coverage）', f0: '起始帧', f1: '结束帧' } },
  { name: 'report', summary: '读取引擎自动生成的差异报告草稿（不是让 agent 自述）。', args: {} },
]);

const TOOL_NAMES = LOOP_TOOLS.map((tool) => tool.name);

// ------------------------------------------------------------------- beats

/** A beat grid from bpm, quantized to the frame grid (P5). */
function beatGrid(tempo, duration, fps) {
  const period = 60 / Number(tempo);
  if (!(period > 0.02) || !(period < 10)) return [];
  const beats = [];
  // Beats inside the timeline: the end boundary belongs to the next shot, so a
  // beat exactly at `duration` is not something a clip can snap to.
  for (let index = 0; index * period < Number(duration) - 1e-9; index++) {
    const t = index * period;
    beats.push(round3(Math.round(t * fps) / fps));
  }
  return beats;
}

/**
 * Nearest beat to `t`: the answer "卡到最近拍点" needs.
 *
 * Time is whole frames everywhere (§1.3 P5, `t = frame / fps`), so the answer
 * carries the frame-aligned beat as well as the raw marker: `frameAligned` is
 * what an op should write, `deltaFrames` is the distance to it, and
 * `rawDeltaFrames` is the distance to the marker as stored (a beat halfway
 * between two frames can be 0.5 frames off the grid — that is a fact about the
 * beat, not a missed snap).
 */
export function nearestBeat(beats, t, fps) {
  if (!Array.isArray(beats) || !beats.length) return null;
  const value = Number(t);
  const rate = Number(fps);
  if (!Number.isFinite(value) || !(rate > 0)) return null;
  let best = null;
  for (let index = 0; index < beats.length; index++) {
    const beat = Number(beats[index]);
    if (!Number.isFinite(beat)) continue;
    const frame = Math.round(beat * rate);
    // Project times are stored rounded to 3 decimals (core/ops.js), which is
    // 0.03 frames at 60 fps: anything under 0.05 frame is that rounding, not a
    // missed snap.
    const exact = value * rate - frame;
    const deltaFrames = Math.abs(exact) < 0.05 ? 0 : round3(exact);
    const rawDeltaFrames = round3((value - beat) * rate);
    const candidate = {
      index,
      beat: round3(beat),
      frame,
      frameAligned: round3(frame / rate),
      deltaSec: round3(value - beat),
      deltaFrames,
      rawDeltaFrames,
    };
    if (!best || Math.abs(deltaFrames) < Math.abs(best.deltaFrames)) best = candidate;
  }
  return best;
}

/**
 * Beat data for a project, in the order the product prefers it and with the
 * source attached — the report has to say where the grid came from.
 *
 *   meta.beats  the editor's stored markers (analysis pasted into the project)
 *   meta.tempo  a bpm grid, quantized to frames
 *   audio       engine/beats.js::analyzeBeatsLocal on meta.audio.src
 */
async function resolveBeats({ project, dir, analyze = analyzeBeatsLocal }) {
  const meta = project?.meta || {};
  const fps = Number(meta.fps) || 24;
  const duration = Number(meta.duration) || 0;
  const stored = Array.isArray(meta.beats) ? meta.beats.filter((b) => Number.isFinite(Number(b))) : [];
  if (stored.length) {
    return { source: 'meta.beats', tempo: Number(meta.tempo) || 0, fps, count: stored.length, beats: stored.map(Number) };
  }
  if (Number(meta.tempo) > 0) {
    const beats = beatGrid(meta.tempo, duration, fps);
    return { source: 'meta.tempo', tempo: Number(meta.tempo), fps, count: beats.length, beats };
  }
  const src = meta.audio?.src;
  if (src && typeof analyze === 'function') {
    const started = Date.now();
    try {
      const result = await analyze(path.resolve(dir, src), { duration, fps });
      const beats = (result?.beats || []).map(Number).filter(Number.isFinite);
      if (beats.length) {
        return {
          source: 'audio', tempo: result.tempo ?? 0, fps, count: beats.length, beats,
          file: src, method: 'engine/beats.js::analyzeBeatsLocal', analysisMs: Date.now() - started,
        };
      }
      return { source: 'audio', tempo: result?.tempo ?? 0, fps, count: 0, beats: [], file: src, analysisMs: Date.now() - started };
    } catch (error) {
      return { source: 'audio', fps, count: 0, beats: [], file: src, error: error.message };
    }
  }
  return { source: 'none', fps, count: 0, beats: [], error: 'project has no meta.beats, no meta.tempo and no meta.audio' };
}

// -------------------------------------------------------------- measurement

/** Deterministic text box (inspect-service::estimateTextBox), labelled. */
function textBoxOf(project, id) {
  const el = (project?.elements || []).find((entry) => entry.id === id);
  if (!el || el.type !== 'text') return null;
  const style = el.style || {};
  const box = estimateTextBox({
    text: style.text, fontSize: style.size, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight,
  });
  return {
    id, text: style.text ?? '', fontSize: Number(style.size) || null,
    box: [round3(box[0]), round3(box[1])],
    source: 'estimate',
    note: 'WP1.3 之前 IR 不带字形几何；这是 inspect-service::estimateTextBox 的确定性估算',
  };
}

/** The mutable facts of one host that a change set can move. */
function hostFacts(project, id, beats, fps) {
  const el = (project?.elements || []).find((entry) => entry.id === id);
  if (!el) return { id, present: false };
  const start = Number(el.start) || 0;
  const duration = Number(el.duration) || 0;
  const end = round3(start + duration);
  return {
    id,
    present: true,
    type: el.type,
    name: el.name ?? '',
    start: round3(start),
    end,
    duration: round3(duration),
    size: el.style?.size ?? null,
    text: el.style?.text ?? null,
    locked: el.locked === true,
    box: textBoxOf(project, id),
    beatStart: beats?.beats?.length ? nearestBeat(beats.beats, start, fps) : null,
    beatEnd: beats?.beats?.length ? nearestBeat(beats.beats, end, fps) : null,
    frames: [Math.round(start * fps), Math.max(Math.round(start * fps), Math.round(end * fps) - 1)],
  };
}

/** Compact `coverage` for one host over its own frames (geometric, no raster). */
function coverageOf(project, id, frames, camera) {
  try {
    const report = coverage(project, { focus: id, f0: frames[0], f1: frames[1], camera, grid: 5 });
    return {
      id,
      f0: report.f0,
      f1: report.f1,
      frameCount: report.frameCount,
      summary: report.focusSummary,
      numbers: report.numbers,
      source: 'inspect-service::coverage（帧 IR 几何采样，不是像素）',
    };
  } catch (error) {
    return { id, error: { code: error.code || 'ERROR', message: error.message } };
  }
}

/** Compact `stackAt` at the centre of one host's mid frame. */
function stackOf(project, id, frames, camera) {
  try {
    const facts = frames;
    const report = stackAt(project, 0, { frame: Math.round((facts[0] + facts[1]) / 2), camera });
    const row = report.order.find((entry) => entry.id === id) || null;
    return {
      id,
      frame: report.frame,
      t: report.t,
      hit: report.hit,
      front: report.front,
      order: report.order.map((entry) => entry.id),
      row: row ? {
        drawOrder: row.drawOrder, size: row.size, sizeSource: row.sizeSource,
        coversPoint: row.coversPoint, rayDepth: row.rayDepth, opacity: row.opacity,
      } : null,
      source: 'inspect-service::stackAt',
    };
  } catch (error) {
    return { id, error: { code: error.code || 'ERROR', message: error.message } };
  }
}

/**
 * The loop's own before/after measurement of the hosts a change set touched.
 * Deliberately cheap (frame IR only, no rasteriser): it runs on both sides of
 * every apply, so it has to stay in the milliseconds.
 */
function measureHosts({ project, ids, beats, fps, camera }) {
  const out = [];
  for (const id of ids) {
    const facts = hostFacts(project, id, beats, fps);
    if (!facts.present) { out.push(facts); continue; }
    out.push({
      ...facts,
      stack: stackOf(project, id, facts.frames, camera),
      coverage: facts.type === 'text' ? coverageOf(project, id, facts.frames, camera) : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------- still

/** Width/height from a PNG's IHDR — no decoder, no dependency. */
export function pngSize(buffer) {
  if (!buffer || buffer.length < 33) throw fault('INVALID_ARGUMENT', 'not a PNG: too short');
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) throw fault('INVALID_ARGUMENT', 'not a PNG: bad signature');
  }
  if (String.fromCharCode(...buffer.slice(12, 16)) !== 'IHDR') throw fault('INVALID_ARGUMENT', 'not a PNG: no IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Default `still` backend: render one frame through the real preview and save
 * the canvas as PNG. It boots the app offscreen (`scripts/dev.mjs --capture`),
 * asks the preview to draw `t`, and exports the canvas from inside the page —
 * so the picture is the project as it is on disk, at that frame, with no
 * Blender involved. A window screenshot is written next to it as evidence.
 *
 * Injected into `AgentLoop` as `renderStill`; tests pass a cheap fake and the
 * loop never notices the difference (it only reads path/size/bytes).
 */
export async function previewStill({ dir, frame, fps, t, out, label = 'still', timeoutMs = STILL_TIMEOUT_MS }) {
  const repo = path.resolve(HERE, '..');
  const dev = path.join(repo, 'scripts', 'dev.mjs');
  if (!fss.existsSync(dev)) throw fault('STILL_UNAVAILABLE', `preview capture script missing: ${dev}`);
  const rate = Number(fps) || 24;
  const when = Number.isFinite(Number(t)) ? Number(t) : (Number(frame) || 0) / rate;
  const target = path.resolve(out || agentDir(dir, 'stills', `${label}-f${Math.round(when * rate)}.png`));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const evalScript = `(() => { const app = window.__vdm; const p = app && app.preview; `
    + `if (!p) return 'NO_PREVIEW'; p.render(${when}); `
    + `try { window.__probe = p.canvas.toDataURL('image/png'); } catch (e) { window.__probe = null; } `
    + `return 'OK'; })()`;
  const started = Date.now();
  const child = spawn(process.execPath, [
    dev, '--project', path.resolve(dir), `--capture=${target}`, `--at=${when}`,
    `--eval=${evalScript}`, '--delay=2600', '--hold=260',
  ], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 40000) stderr = stderr.slice(-20000); });
  const close = new Promise((resolve) => { child.on('close', (code) => resolve(code)); child.on('error', () => resolve(-1)); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
  const code = await close;
  clearTimeout(timer);
  const probe = target.replace(/\.png$/, '.probe.png');
  const file = fss.existsSync(probe) ? probe : (fss.existsSync(target) ? target : null);
  if (!file) {
    throw fault('STILL_FAILED', `preview still produced no image (exit ${code})`, {
      exitCode: code, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000),
    });
  }
  const buffer = await fs.readFile(file);
  const size = pngSize(buffer);
  return {
    path: file,
    width: size.width,
    height: size.height,
    bytes: buffer.length,
    ms: Date.now() - started,
    backend: file === probe ? 'preview-canvas' : 'preview-window',
    window: fss.existsSync(target) ? target : null,
    frame: Math.round(when * rate),
    t: round3(when),
    booted: /\[capture\]/.test(stdout),
  };
}

// ---------------------------------------------------------------- transports

/**
 * In-process agent for tests and offline runs. `script` is an array of steps:
 * `{ tool, args }` or `(ctx) => ({ tool, args } | { type: 'final', text })`.
 * `ctx` exposes the conversation helpers a policy needs (last results by tool
 * name) so a scripted run is a real loop — it reacts to what the engine told it.
 */
export class ScriptedAgent {
  constructor({ name = 'scripted', script = [] } = {}) {
    if (!Array.isArray(script)) throw fault('INVALID_ARGUMENT', 'scripted agent needs an array script');
    this.name = name;
    this.script = script;
    this.index = 0;
    this.calls = [];
  }

  get done() { return this.index >= this.script.length; }

  async next(ctx) {
    if (this.index >= this.script.length) return { type: 'final', text: '' };
    const step = this.script[this.index++];
    const action = typeof step === 'function' ? await step(ctx) : step;
    this.calls.push(action);
    if (!action) return { type: 'final', text: '' };
    if (action.type) return action;
    return { type: 'tool', name: action.tool, args: action.args || {}, id: `t${this.index}` };
  }

  async close() { /* nothing to release */ }
}

/**
 * Line-protocol transport (the seam for a real dsh adapter, §8.4). The engine
 * writes one JSON object per line to the child's stdin and reads one per line
 * from its stdout; anything the child prints that is neither `tool` nor `final`
 * is ignored, so a chatty runtime cannot break the loop.
 */
export class ProcessAgent {
  constructor({ node = process.execPath, bin, args = [], cwd = process.cwd(), env = process.env, timeoutMs = 600000, name = 'process' }) {
    if (!bin || typeof bin !== 'string') throw fault('INVALID_ARGUMENT', 'ProcessAgent needs a bin');
    this.name = name;
    this.options = { node, bin, args, cwd, env, timeoutMs };
    this.child = null;
    this.pending = null;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.closed = false;
  }

  #start(ctx) {
    const { node, bin, args, cwd, env } = this.options;
    this.child = spawn(node, [bin, ...args], { cwd, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.child.stdout.on('data', (chunk) => {
      this.buffer += String(chunk);
      const parts = this.buffer.split(NL);
      this.buffer = parts.pop();
      for (const line of parts) if (line.trim()) this.#push(line);
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
      if (this.stderr.length > 40000) this.stderr = this.stderr.slice(-20000);
    });
    this.child.on('close', (code) => { this.code = code; this.closed = true; this.#push(null); });
    this.child.on('error', (error) => { this.error = error; this.closed = true; this.#push(null); });
    this.#write({ type: 'user', text: this.#prompt(ctx), tools: LOOP_TOOLS, scope: ctx.scope, mode: ctx.mode });
  }

  #prompt(ctx) {
    return [
      'You are the edit agent inside VedioMaker. Work in small, reversible steps.',
      `TASK: ${ctx.task}`,
      `SCOPE: elements ${JSON.stringify(ctx.scope.elements)}, paths ${JSON.stringify(ctx.scope.paths)}${ctx.scope.create ? ', create allowed' : ''}`,
      'Answer with one JSON object per line: {"type":"tool","name":"…","args":{…}} or {"type":"final","text":"…"}.',
      'Tools:',
      ...LOOP_TOOLS.map((tool) => `  ${tool.name} — ${tool.summary}`),
      'Rules: every write ends up in a change set (propose, then apply after the plan is approved);',
      'outside the scope is refused; measure instead of claiming.',
    ].join(NL);
  }

  #write(message) {
    if (!this.child?.stdin?.writable) return;
    try { this.child.stdin.write(`${JSON.stringify(message)}${NL}`); } catch { /* child gone */ }
  }

  #push(line) {
    const waiter = this.waiters.shift();
    if (waiter) { waiter(line); return; }
    this.lines.push(line);
  }

  #readLine() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.options.timeoutMs);
      this.waiters.push((line) => { clearTimeout(timer); resolve(line); });
    });
  }

  async next(ctx) {
    if (!this.child) {
      this.#start(ctx);
    } else if (this.pending) {
      this.#write({ type: 'tool_result', ...this.pending });
      this.pending = null;
    }
    for (let guard = 0; guard < 10000; guard++) {
      const line = await this.#readLine();
      if (line === null) {
        if (this.error) throw fault('AGENT_UNAVAILABLE', String(this.error.message || this.error));
        return { type: 'final', text: '' };
      }
      let event;
      try { event = JSON.parse(String(line).trim()); } catch { continue; }
      if (event?.type === 'tool' || event?.type === 'final') return event;
    }
    throw fault('AGENT_LOOP_LIMIT', 'transport produced no tool call or final answer');
  }

  /** The loop hands the result of the tool it just executed back to the child. */
  feed(pending) { this.pending = pending; }

  async close() {
    const child = this.child;
    this.child = null;
    this.pending = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    const exited = new Promise((resolve) => {
      if (this.closed) resolve();
      else child.once('close', () => resolve());
    });
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    // The project directory is the child's cwd; a test that removes it must not
    // race a dying process (Windows holds the handle).
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

// ---------------------------------------------------------------------- loop

const LOOP_SYSTEM = [
  'You are the edit agent inside VedioMaker (docs/AGENT-PROTOCOL.md holds the ops and property contracts).',
  'Work in steps: read, plan, propose a change set, render a still, measure, then correct.',
  'Every write is one change set; outside the request scope is refused. Do not claim a result you did not measure.',
].join(NL);

export class AgentLoop {
  /**
   * @param {object} options
   * @param {string} options.root      project directory (`project.vdm.json` lives here)
   * @param {object} options.scope     `{ elements, paths, create }` — mandatory (§8.1)
   * @param {object} options.agent     transport: `ScriptedAgent` / `ProcessAgent`
   * @param {Function} [options.renderStill]  `still` backend, defaults to the preview
   * @param {object} [options.service] project service (defaults to `projectService(root)`)
   * @param {object} [options.changesets] `ChangeSetService` (defaults to one over `service`)
   */
  constructor({
    root, scope, agent, service, changesets, renderStill = previewStill,
    actorId = 'agent:dsh', onEvent = null, now = nowIso, mode = 'tune', approval = 'auto',
    maxSteps = DEFAULT_MAX_STEPS, beats = analyzeBeatsLocal,
  } = {}) {
    if (typeof root !== 'string' || !root) throw fault('INVALID_ARGUMENT', 'AgentLoop needs a project root');
    if (!agent) throw fault('INVALID_ARGUMENT', 'AgentLoop needs a transport (agent)');
    this.root = path.resolve(root);
    this.scope = normalizeScope(scope);
    this.agent = agent;
    this.service = service || projectService(this.root);
    this.changesets = changesets || new ChangeSetService(this.service);
    this.renderStill = renderStill;
    this.actorId = actorId;
    this.onEvent = onEvent;
    this.clock = now;
    this.mode = mode === 'create' ? 'create' : 'tune';
    this.approval = approval === 'manual' ? 'manual' : 'auto';
    this.maxSteps = Math.max(1, Math.round(Number(maxSteps) || DEFAULT_MAX_STEPS));
    this.beatsAnalyzer = beats;
    this.state = null;
    this.messages = [];
    this.task = '';
    this.planOnly = false;
    this._beats = null;
    this._running = false;
    this._stepNo = 0;
  }

  get running() { return this._running; }
  get runId() { return this.state?.runId ?? null; }

  // --------------------------------------------------------------- utilities

  async #emit(event) {
    try { await this.onEvent?.({ runId: this.runId, ...event }); } catch { /* a listener never breaks a run */ }
  }

  #step(step, title, detail = '') {
    this._stepNo += 1;
    const n = this._stepNo;
    this.state.steps.push({ n, step, title, detail, at: this.clock() });
    this.state.log.push(`[${String(n).padStart(2, '0')}] ${step} · ${title}${detail ? ` → ${detail}` : ''}`);
  }

  /** A tool line: indented under the step it belongs to (no new number). */
  #log(line) { this.state.log.push(line); }

  async #project() { return this.service.read(); }

  async #beatsOf(project) {
    const rev = project.rev;
    if (this._beats && this._beats.rev === rev) return this._beats.value;
    const value = await resolveBeats({ project, dir: this.root, analyze: this.beatsAnalyzer });
    this._beats = { rev, value };
    this.state.beats = value;
    return value;
  }

  async #fileHash() {
    try { return sha256(await fs.readFile(path.join(this.root, 'project.vdm.json'))); } catch { return null; }
  }

  #contentHash(project) { return sha256(JSON.stringify(content(project))); }

  #scopeSummary() { return scopeSummary(this.scope); }

  /** Reject a batch before it can become a change set. */
  #assertOps(ops, { validate = true, scope = true } = {}) {
    if (!Array.isArray(ops) || !ops.length) throw fault('INVALID_ARGUMENT', 'ops must be a nonempty array');
    if (this.mode === 'tune' && ops.length > TUNE_MAX_OPS) {
      throw fault('TOO_MANY_OPS', `微调模式一次最多 ${TUNE_MAX_OPS} 个 op（收到 ${ops.length} 个）；大改请改用创作模式并先提交计划`);
    }
    if (scope) checkScope(ops, this.scope);
    if (validate) this.#validateContract(ops);
    return ops;
  }

  #validateContract(ops) {
    const contract = this.state.contract;
    contract.checks += 1;
    try {
      // EDIT_SCHEMA carries `$defs.op`; only the baseline fields are optional
      // here, because the change-set service adds expectedRev/requestId itself.
      validateContract({ ops }, { ...EDIT_SCHEMA, required: ['ops'] });
    } catch (error) {
      contract.failures += 1;
      // The op array is a `oneOf` of every variant, so its own error is always
      // "does not match a supported variant". Re-check the ops one at a time to
      // name the field the agent got wrong — it has to be able to correct.
      throw fault('OP_INVALID', `契约校验失败：${this.#contractDetail(ops) || error.message}`);
    }
    contract.ops += ops.length;
    return contract;
  }

  /** First op that fails its own contract, with the field-level reason. */
  #contractDetail(ops) {
    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      const at = `op #${index + 1} (${op?.op ?? '?'})`;
      const contract = OP_CONTRACTS[op?.op];
      if (!contract) return `${at}: unknown op（contracts.what="ops" 列出全部操作）`;
      try {
        validateContract(op, contract.schema);
      } catch (error) {
        return `${at}: ${error.message}`;
      }
    }
    return null;
  }

  #hostsOf(ops) {
    const ids = new Set();
    for (const op of ops || []) {
      for (const target of opTargets(op)) if (!target.id.startsWith('@')) ids.add(target.id);
    }
    return [...ids];
  }

  #needsApproval() {
    if (this.mode === 'create') return true;
    const plan = this.state?.plan;
    const ops = plan?.opsCount ?? 0;
    const hosts = plan?.hosts ?? 0;
    return ops > APPROVAL_OPS || hosts > APPROVAL_HOSTS;
  }

  #proposedCount() { return this.state.changesets.filter((entry) => entry.status === 'proposed').length; }

  #transportContext() {
    const messages = this.messages;
    const toolMessages = (name) => messages.filter((message) => message.role === 'tool' && message.name === name);
    const last = (name) => {
      const all = toolMessages(name);
      return all.length ? all[all.length - 1] : null;
    };
    return {
      task: this.task,
      messages,
      tools: LOOP_TOOLS,
      scope: this.#scopeSummary(),
      mode: this.mode,
      state: {
        rev: this.state.rev,
        plan: this.state.plan,
        changesets: this.state.changesets.map((entry) => ({ id: entry.id, status: entry.status, changes: entry.changed?.length ?? 0 })),
        stills: this.state.stills.length,
        measurements: this.state.measurements.length,
        contract: { ...this.state.contract },
        rejections: this.state.rejections.map((entry) => ({ tool: entry.tool, ...entry.error })),
      },
      last: (name) => { const message = last(name); return message ? (message.ok ? message.result : { error: message.error }) : null; },
      lastOk: (name) => { const message = last(name); return message?.ok ? message.result : null; },
      lastError: (name) => { const message = last(name); return message && !message.ok ? message.error : null; },
      toolResults: toolMessages,
    };
  }

  // ------------------------------------------------------------------ tools

  async #dispatch(name, args) {
    switch (name) {
      case 'read': return this.#toolRead(args);
      case 'contracts': return this.#toolContracts(args);
      case 'ops': return this.#toolOps(args);
      case 'plan': return this.#toolPlan(args);
      case 'changeset': return this.#toolChangeset(args);
      case 'still': return this.#toolStill(args);
      case 'measure': return this.#toolMeasure(args);
      case 'report': return this.#buildReport({ draft: true });
      default: throw fault('INVALID_ARGUMENT', `unknown tool ${name}; the surface is ${TOOL_NAMES.join(', ')}`);
    }
  }

  async #toolRead(args) {
    const what = String(args?.what || 'project');
    const project = await this.#project();
    const meta = project.meta || {};
    const fps = Number(meta.fps) || 24;
    if (what === 'project') {
      return {
        rev: project.rev,
        title: meta.title,
        fps,
        size: [Number(meta.width) || 1920, Number(meta.height) || 1080],
        duration: Number(meta.duration) || 0,
        background: meta.background,
        tempo: Number(meta.tempo) || 0,
        beats: (meta.beats || []).length,
        camera: { active: project.activeCameraId ?? null, count: (project.cameras || []).length },
        counts: { elements: (project.elements || []).length, cameras: (project.cameras || []).length, objects: (project.scene?.objects || []).length, segments: (project.segments || []).length },
        world: project.world?.source ?? 'none',
        locked: (project.elements || []).filter((el) => el.locked).map((el) => el.id),
      };
    }
    if (what === 'elements') {
      const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 40)));
      const name = typeof args.name === 'string' ? args.name.toLowerCase() : null;
      const text = typeof args.text === 'string' ? args.text.toLowerCase() : null;
      const ids = Array.isArray(args.ids) ? new Set(args.ids) : null;
      const rows = (project.elements || []).filter((el) => {
        if (typeof args.id === 'string' && el.id !== args.id) return false;
        if (ids && !ids.has(el.id)) return false;
        if (typeof args.type === 'string' && el.type !== args.type) return false;
        if (name && !String(el.name ?? '').toLowerCase().includes(name)) return false;
        if (text && !String(el.style?.text ?? '').toLowerCase().includes(text)) return false;
        return true;
      }).slice(0, limit).map((el) => ({
        id: el.id,
        name: el.name ?? '',
        type: el.type,
        start: round3(el.start),
        duration: round3(el.duration),
        z: el.z,
        locked: el.locked === true,
        text: el.type === 'text' ? el.style?.text ?? null : null,
        size: el.style?.size ?? null,
        keys: (el.keyframes || []).length,
      }));
      return { rev: project.rev, fps, total: (project.elements || []).length, count: rows.length, elements: rows };
    }
    if (what === 'element') {
      const el = (project.elements || []).find((entry) => entry.id === args.id);
      if (!el) {
        throw fault('INVALID_ARGUMENT', `unknown element ${args.id ?? '(no id)'}`, {
          elements: (project.elements || []).slice(0, 50).map((entry) => entry.id),
        });
      }
      const beats = await this.#beatsOf(project);
      const facts = hostFacts(project, el.id, beats, fps);
      return {
        ...facts,
        z: el.z,
        visible: el.visible !== false,
        style: { text: el.style?.text ?? null, size: el.style?.size ?? null, color: el.style?.color ?? null, align: el.style?.align ?? null },
        keyframes: (el.keyframes || []).map((key) => ({ t: key.t, path: key.path, value: key.value, ease: key.ease ?? null })),
        node: el.node ? { pivot: el.node.pivot, scale: el.node.scale, rotation: el.node.rotation } : null,
      };
    }
    if (what === 'beats') {
      const beats = await this.#beatsOf(project);
      const targets = [];
      if (args.near !== undefined) {
        const near = args.near;
        if (Array.isArray(near)) for (const t of near) targets.push({ label: `t=${t}`, t: Number(t) });
        else if (isRecord(near) && near.id) {
          const facts = hostFacts(project, near.id, beats, fps);
          const edge = near.edge === 'end' ? 'end' : 'start';
          targets.push({ label: `${near.id}.${edge}`, t: edge === 'end' ? facts.end : facts.start });
        } else if (isRecord(near) && near.t !== undefined) targets.push({ label: `t=${near.t}`, t: Number(near.t) });
        else if (typeof near === 'number') targets.push({ label: `t=${near}`, t: near });
      } else {
        for (const el of (project.elements || []).filter((entry) => entry.id === args.id)) {
          targets.push({ label: `${el.id}.start`, t: Number(el.start) }, { label: `${el.id}.end`, t: Number(el.start) + Number(el.duration) });
        }
      }
      const nearest = targets.map((target) => ({ ...target, nearest: nearestBeat(beats.beats, target.t, fps) }));
      return { ...beats, beats: beats.beats.slice(0, 400), nearest };
    }
    if (what === 'segments') {
      return { rev: project.rev, segments: (project.segments || []).map((seg) => ({ id: seg.id, name: seg.name, start: seg.start, duration: seg.duration })) };
    }
    throw fault('INVALID_ARGUMENT', `read.what must be project | elements | element | beats | segments (got ${what})`);
  }

  #toolContracts(args) {
    const what = String(args?.what || 'ops');
    if (what === 'ops') {
      return {
        version: CONTRACT_VERSION,
        count: PUBLIC_OPS.length,
        ops: PUBLIC_OPS.map((op) => ({
          op,
          group: OP_CONTRACTS[op].group,
          required: [...OP_CONTRACTS[op].required],
          fields: OP_CONTRACTS[op].fields.map((field) => field.name),
        })),
      };
    }
    if (what === 'op') {
      const name = String(args?.name || '');
      const contract = OP_CONTRACTS[name];
      if (!contract) throw fault('INVALID_ARGUMENT', `unknown op ${name}`, { ops: PUBLIC_OPS.slice(0, 80) });
      return contract;
    }
    if (what === 'paths') {
      const host = String(args?.host || 'el');
      const rows = PROPERTY_PATHS_BY_HOST[host];
      if (!rows) throw fault('INVALID_ARGUMENT', 'host must be el | ob | cam');
      return {
        host,
        count: rows.length,
        keyable: KEYABLE_PATHS[host] || [],
        paths: rows.map((row) => ({
          path: row.path, type: row.type, unit: row.unit, keyable: !!row.keyable,
          linkable: !!row.linkable, legacy: !!row.legacy, description: row.description,
        })),
      };
    }
    if (what === 'edit') {
      return {
        version: CONTRACT_VERSION,
        opsArray: { minItems: EDIT_OPS_ARRAY.minItems, maxItems: EDIT_OPS_ARRAY.maxItems, description: EDIT_OPS_ARRAY.description },
        baseline: ['expectedRev', 'requestId', 'dryRun'],
        changeset: ['id | ops', 'actorId', 'intent', 'expectedRev', 'requestId', 'dryRun'],
        scope: this.#scopeSummary(),
      };
    }
    throw fault('INVALID_ARGUMENT', `contracts.what must be ops | op | paths | edit (got ${what})`);
  }

  #toolOps(args) {
    if (!Array.isArray(args?.ops)) throw fault('INVALID_ARGUMENT', 'ops tool needs an ops array');
    const ops = args.ops;
    if (!ops.length) throw fault('INVALID_ARGUMENT', 'ops must be a nonempty array');
    // Contract first (the single source), then the scope report. A contract
    // failure is an error result; a scope hit is reported, not thrown, so the
    // agent can see the violation and correct before proposing anything.
    this.#validateContract(ops);
    const violations = [];
    try {
      checkScope(ops, this.scope);
    } catch (error) {
      violations.push({ code: error.code, message: error.message, id: error.id ?? null, path: error.path ?? null });
    }
    return {
      ok: violations.length === 0,
      ops: ops.length,
      contract: { version: CONTRACT_VERSION, checks: this.state.contract.checks, ops: this.state.contract.ops },
      targets: ops.map((op, index) => ({ index, op: op.op, targets: opTargets(op).map((target) => ({ id: target.id, paths: [...target.paths] })) })),
      violations,
    };
  }

  #toolPlan(args) {
    const intent = String(args?.intent ?? '').slice(0, 512);
    const raw = Array.isArray(args?.steps) ? args.steps : [];
    if (!raw.length) throw fault('INVALID_ARGUMENT', 'plan needs a nonempty steps array');
    const steps = raw.slice(0, 40).map((step, index) => {
      const ops = Array.isArray(step?.ops) ? step.ops : [];
      return {
        n: index + 1,
        title: String(step?.title ?? step?.kind ?? `step ${index + 1}`).slice(0, 200),
        kind: typeof step?.kind === 'string' ? step.kind : null,
        ops: ops.length,
      };
    });
    const opsCount = steps.reduce((sum, step) => sum + step.ops, 0);
    const hosts = new Set();
    for (const step of raw) for (const op of Array.isArray(step?.ops) ? step.ops : []) {
      for (const target of opTargets(op)) if (!target.id.startsWith('@')) hosts.add(target.id);
    }
    const plan = {
      id: `plan_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      intent,
      steps,
      opsCount,
      hosts: hosts.size,
      mode: this.mode,
      needsApproval: this.mode === 'create' || opsCount > APPROVAL_OPS || hosts.size > APPROVAL_HOSTS,
      createdAt: this.clock(),
    };
    this.state.plan = plan;
    this.#step('plan', `计划：${intent || '(无说明)'}`,
      `${steps.length} 步 · ${opsCount} 个 op · ${hosts.size} 个宿主${plan.needsApproval ? ' · 需要批准' : ''}`);
    void this.#emit({ type: 'plan', plan });
    return plan;
  }

  async #toolChangeset(args) {
    const action = String(args?.action || '');
    if (action === 'propose') return this.#propose(args);
    if (action === 'apply') {
      if (typeof args.id === 'string' && args.id) return this.#applyById(args.id);
      return this.#proposeAndApply(args);
    }
    if (action === 'revert') {
      if (typeof args.id !== 'string' || !args.id) throw fault('INVALID_ARGUMENT', 'revert needs a change set id');
      const before = await this.#project();
      const beforeHash = this.#contentHash(before);
      const record = await this.changesets.revert({ id: args.id, actorId: this.actorId });
      const after = await this.#project();
      const afterHash = this.#contentHash(after);
      // "Back to the state before this change set" compares with the apply's
      // pre-apply hash, not with the state right before the revert (that one is
      // the applied project and can never match).
      const appliedEntry = this.state.applyLog.find((row) => row.id === args.id && row.hashBefore);
      const restored = appliedEntry ? appliedEntry.hashBefore === afterHash : null;
      const entry = {
        id: record.id,
        status: record.status,
        rev: record.revert?.rev ?? null,
        reverted: record.revert?.reverted ?? 0,
        conflicts: record.revert?.conflicts ?? 0,
        changed: record.changed || [],
        hashBefore: beforeHash,
        hashAfter: afterHash,
        restored,
      };
      this.state.changesets.push({ ...entry, action: 'revert', baseRev: before.rev });
      this.#step('revert', `回退变更集 ${record.id}`,
        `rev ${before.rev} → ${after.rev} · ${entry.reverted} 回滚 / ${entry.conflicts} 冲突 · 内容 ${restored === null ? 'hash 未知' : restored ? '回到执行前' : 'hash 不同'}`);
      this.#emit({ type: 'changeset', action: 'revert', record: entry });
      return entry;
    }
    if (action === 'list') {
      const list = await this.changesets.list({ limit: args.limit ?? 20, status: args.status });
      return list;
    }
    if (action === 'show') {
      if (typeof args.id !== 'string' || !args.id) throw fault('INVALID_ARGUMENT', 'show needs a change set id');
      return this.changesets.show(args.id, { limit: args.limit ?? 100 });
    }
    throw fault('INVALID_ARGUMENT', `changeset.action must be propose | apply | revert | list | show (got ${action})`);
  }

  async #propose(args, { silent = false } = {}) {
    const ops = args?.ops;
    this.#assertOps(ops);
    const intent = String(args?.intent ?? this.state.plan?.intent ?? '').slice(0, 512);
    const record = await this.changesets.propose({ ops, actorId: this.actorId, intent });
    const summary = {
      id: record.id,
      status: record.status,
      baseRev: record.baseRev,
      afterRev: record.afterRev,
      opsCount: record.opsCount,
      equal: record.equal,
      counts: record.report?.counts ?? null,
      changed: (record.changed || []).map((row) => ({ id: row.id, path: row.path, before: row.before, after: row.after })),
    };
    this.state.changesets.push({
      ...summary,
      action: 'propose',
      intent,
      rev: record.rev,
      proposedAt: this.clock(),
    });
    // The plan phase ends here: a proposal is on record and nothing was
    // written. Hash the project file now, not at the end of the run, so the
    // §8.3 "plan did not touch the project" row is evidence about the plan
    // phase rather than about everything that happened afterwards.
    const planPhase = this.state.planPhase;
    if (planPhase && planPhase.hashAfter === null) {
      planPhase.revAfter = (await this.#project()).rev;
      planPhase.hashAfter = await this.#fileHash();
      planPhase.unchanged = !!planPhase.hashBefore && planPhase.hashBefore === planPhase.hashAfter;
    }
    if (!silent) {
      this.#step('propose', `提交变更集 ${record.id}（proposed）`,
        `${summary.opsCount} 个 op · ${summary.changed.length} 处改动 · baseRev ${record.baseRev}`);
      this.#emit({ type: 'changeset', action: 'propose', record: summary });
    }
    return summary;
  }

  async #proposeAndApply(args) {
    const proposed = await this.#propose(args);
    return this.#applyById(proposed.id);
  }

  /** Apply one stored proposal: measure before, commit, measure after. */
  async #applyById(id) {
    const stored = await this.changesets.get(id);
    if (!stored || stored.id !== id) throw fault('CHANGESET_NOT_FOUND', `no change set ${id}`);
    if (stored.status === 'applied') return { ...this.#summaryOf(stored), alreadyApplied: true };
    if (stored.status !== 'proposed') throw fault('INVALID_ARGUMENT', `change set ${id} is ${stored.status}, not proposed`);
    this.#assertOps(stored.ops, { validate: false });
    const before = cloneProject(await this.#project());
    const beatDoc = await this.#beatsOf(before);
    const fps = Number(before.meta?.fps) || 24;
    const ids = [...new Set([
      ...(stored.changed || []).map((row) => row.id),
      ...(stored.added || []).map((row) => row.id),
    ])].filter(Boolean).slice(0, 4);
    const beforeFacts = measureHosts({ project: before, ids, beats: beatDoc, fps, camera: null });
    const beforeHash = this.#contentHash(before);
    const applied = await this.changesets.apply({ id, actorId: this.actorId });
    const after = await this.#project();
    const afterFacts = measureHosts({ project: after, ids, beats: beatDoc, fps, camera: null });
    const afterHash = this.#contentHash(after);
    // A change set with no diff means the ops were a no-op; say so loudly
    // instead of letting the report imply a write happened.
    const entry = {
      ...this.#summaryOf(applied),
      action: 'apply',
      beforeRev: before.rev,
      rev: applied.rev,
      transactions: applied.transactions || [],
      hashBefore: beforeHash,
      hashAfter: afterHash,
      before: beforeFacts,
      after: afterFacts,
      appliedAt: this.clock(),
    };
    this.state.applyLog.push(entry);
    const index = this.state.changesets.findIndex((row) => row.id === id);
    if (index >= 0) this.state.changesets[index] = { ...this.state.changesets[index], status: applied.status, rev: applied.rev, transactions: applied.transactions || [] };
    else this.state.changesets.push(entry);
    this.#step('apply', `应用变更集 ${applied.id}（applied）`,
      `rev ${before.rev} → ${applied.rev} · ${entry.changed.length} 处改动 · 事务 ${entry.transactions.length}`);
    this.#emit({ type: 'changeset', action: 'apply', record: entry });
    return entry;
  }

  #summaryOf(record) {
    return {
      id: record.id,
      status: record.status,
      baseRev: record.baseRev ?? null,
      rev: record.rev ?? null,
      afterRev: record.afterRev ?? null,
      opsCount: record.opsCount ?? (record.ops ? record.ops.length : 0),
      equal: record.equal ?? null,
      counts: record.report?.counts ?? null,
      transactions: record.transactions || [],
      changed: (record.changed || []).map((row) => ({
        id: row.id, kind: row.kind ?? 'element', path: row.path ?? null, before: row.before, after: row.after, change: row.change ?? null,
      })),
    };
  }

  async #toolStill(args) {
    const project = await this.#project();
    const fps = Number(project.meta?.fps) || 24;
    const t = Number.isFinite(Number(args?.t)) ? Number(args.t)
      : (Number.isFinite(Number(args?.frame)) ? Number(args.frame) / fps : 0);
    const frame = Number.isFinite(Number(args?.frame)) ? Math.round(Number(args.frame)) : Math.round(t * fps);
    const label = String(args?.label || `f${frame}`).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 48);
    const started = Date.now();
    const rendered = await this.renderStill({ dir: this.root, project, frame, fps, t, label });
    const relative = path.isAbsolute(rendered.path) ? path.relative(this.root, rendered.path).split(path.sep).join('/') : rendered.path;
    const still = {
      label,
      path: relative,
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.bytes ?? null,
      ms: rendered.ms ?? Date.now() - started,
      backend: rendered.backend ?? 'custom',
      rev: project.rev,
      frame,
      t: round3(t),
    };
    this.state.stills.push(still);
    this.#step('still', `出图 ${label}（帧 ${frame}）`, `${still.path} · ${still.width}×${still.height} · rev ${still.rev}`);
    this.#emit({ type: 'still', still });
    return still;
  }

  async #toolMeasure(args) {
    const what = String(args?.what || '');
    const project = await this.#project();
    const beats = await this.#beatsOf(project);
    const fps = Number(project.meta?.fps) || 24;
    let result;
    let summary;
    if (what === 'stackAt') {
      const report = stackAt(project, Number(args.t ?? 0), {
        ...(args.frame !== undefined ? { frame: Number(args.frame) } : {}),
        ...(args.point === null ? { point: null } : (Array.isArray(args.point) ? { point: args.point } : {})),
        ...(args.camera ? { camera: args.camera } : {}),
      });
      result = {
        what, frame: report.frame, t: report.t, camera: report.camera, point: report.point,
        hit: report.hit, front: report.front, covering: report.covering, order: report.order.map((row) => row.id),
        rows: report.order.map((row) => ({
          id: row.id, kind: row.kind, drawOrder: row.drawOrder, size: row.size,
          sizeSource: row.sizeSource, coversPoint: row.coversPoint, rayDepth: row.rayDepth,
        })),
        source: 'inspect-service::stackAt',
      };
      summary = `stackAt f${report.frame} → 命中 ${report.hit ?? '-'} · 前景 ${report.front ?? '-'} · ${report.order.length} 层`;
    } else if (what === 'coverage') {
      const focus = String(args.focus ?? args.id ?? '');
      if (!focus) throw fault('INVALID_ARGUMENT', 'coverage needs focus (an element id)');
      const facts = hostFacts(project, focus, beats, fps);
      const f0 = Math.max(0, Math.round(Number(args.f0 ?? facts.frames?.[0] ?? 0)));
      const f1 = Math.max(f0, Math.round(Number(args.f1 ?? facts.frames?.[1] ?? f0)));
      const report = coverage(project, { focus, f0, f1, ...(args.camera ? { camera: args.camera } : {}), grid: args.grid ?? 5 });
      result = {
        what, focus, f0: report.f0, f1: report.f1, frameCount: report.frameCount,
        summary: report.focusSummary, numbers: report.numbers, source: 'inspect-service::coverage',
      };
      summary = `coverage ${focus} f${report.f0}–f${report.f1} → 在场 ${report.focusSummary.framesPresent}/${report.frameCount} · 未遮挡采样 ${report.focusSummary.samplesUnoccluded}/${report.focusSummary.samples}`;
    } else if (what === 'diff') {
      const id = String(args.id ?? '');
      const record = id ? await this.changesets.get(id) : null;
      if (!record) throw fault('INVALID_ARGUMENT', 'diff needs a change set id (the diff of a change set is its report)');
      result = {
        what, id: record.id, status: record.status,
        before: record.report?.before ?? null, after: record.report?.after ?? null,
        counts: record.report?.counts ?? null,
        changed: (record.changed || []).map((row) => ({ id: row.id, path: row.path, before: row.before, after: row.after })),
        source: 'application/changeset-service.js（§8.3 报告，由 inspect-service::diff 生成）',
      };
      summary = `diff ${record.id} → ${record.changed?.length ?? 0} 处改动 · ${record.status}`;
    } else if (what === 'textBox') {
      const id = String(args.id ?? '');
      const box = textBoxOf(project, id);
      if (!box) throw fault('INVALID_ARGUMENT', `element ${id || '(no id)'} is not a text element`);
      result = { what, ...box };
      summary = `textBox ${id} → ${box.box[0]}×${box.box[1]} px（字号 ${box.fontSize}，估算）`;
    } else if (what === 'cutEdges') {
      const report = cutEdges(project, { maxGapFrames: args.maxGapFrames ?? 1 });
      result = {
        what, fps: report.fps, count: report.count ?? (report.edges || []).length,
        edges: (report.edges || []).slice(0, 10), cuts: (report.cuts || []).length,
        source: 'inspect-service::cutEdges',
      };
      summary = `cutEdges → ${result.count} 条边不到一帧`;
    } else {
      throw fault('INVALID_ARGUMENT', `measure.what must be stackAt | coverage | diff | textBox | cutEdges (got ${what})`);
    }
    result.summaryText = summary;
    const phase = this.state.applyLog.length ? 'after' : 'before';
    const measurement = { phase, what, rev: project.rev, at: this.clock(), summary, data: result };
    this.state.measurements.push(measurement);
    this.#step('measure', `测量 ${what}`, summary);
    this.#emit({ type: 'measure', measurement });
    return result;
  }

  // ------------------------------------------------------------------- drive

  async run({ task, planOnly = false, approval } = {}) {
    if (this._running) throw fault('INVALID_ARGUMENT', 'this loop is already running');
    if (typeof task !== 'string' || !task.trim()) throw fault('INVALID_ARGUMENT', 'run needs a task');
    this._running = true;
    this.planOnly = planOnly === true;
    if (approval) this.approval = approval === 'manual' ? 'manual' : 'auto';
    this.task = task.trim();
    const project = await this.#project();
    this.state = {
      runId: `loop-${randomUUID()}`,
      version: LOOP_VERSION,
      task: this.task,
      actorId: this.actorId,
      mode: this.mode,
      approval: this.approval,
      scope: this.#scopeSummary(),
      status: 'running',
      startedAt: this.clock(),
      endedAt: null,
      rev: project.rev,
      plan: null,
      approved: null,
      changesets: [],
      applyLog: [],
      stills: [],
      measurements: [],
      rejections: [],
      contract: { version: CONTRACT_VERSION, checks: 0, ops: 0, failures: 0 },
      beats: null,
      finalText: null,
      steps: [],
      log: [],
      planPhase: { revBefore: project.rev, hashBefore: await this.#fileHash(), revAfter: null, hashAfter: null, unchanged: null },
    };
    this.messages = [{ role: 'system', content: LOOP_SYSTEM }];
    this._beats = null;
    this._stepNo = 0;
    this.#step('read', '开始：读项目', `rev ${project.rev} · ${project.meta?.title ?? ''} · ${project.meta?.width}×${project.meta?.height}`);
    this.#emit({ type: 'loop', phase: 'start', runId: this.state.runId, task: this.task, scope: this.state.scope, mode: this.mode, approval: this.approval });
    try {
      const outcome = await this.#drive();
      return await this.#finish(outcome);
    } finally {
      this._running = false;
    }
  }

  /** Continue a run that stopped at `awaiting-approval` (§8.4: 批准后分步执行). */
  async approve({ planId, note } = {}) {
    if (!this.state || this.state.status !== 'awaiting-approval') {
      throw fault('INVALID_ARGUMENT', 'nothing is awaiting approval');
    }
    if (planId && this.state.plan?.id && planId !== this.state.plan.id) {
      throw fault('INVALID_ARGUMENT', `plan ${planId} is not the plan awaiting approval (${this.state.plan.id})`);
    }
    this._running = true;
    this.state.approved = { at: this.clock(), planId: this.state.plan?.id ?? null, note: String(note ?? '') };
    this.state.status = 'running';
    this.#step('approve', '计划已批准，继续执行', this.state.approved.planId ?? '');
    this.#emit({ type: 'loop', phase: 'approved', plan: this.state.plan, approval: this.state.approved });
    try {
      const outcome = await this.#drive();
      return await this.#finish(outcome);
    } finally {
      this._running = false;
    }
  }

  #gated() {
    return this.planOnly || this.approval === 'manual' || this.#needsApproval();
  }

  async #drive() {
    let turns = 0;
    // Resume the apply a legacy one-shot answer was waiting to make: the
    // approval covers the proposal, not the write, so it happens here.
    if (this.state.pendingLegacy) {
      const { id } = this.state.pendingLegacy;
      this.state.pendingLegacy = null;
      this.state.approved = this.state.approved || { at: this.clock(), planId: null, note: 'legacy proposal' };
      const applied = await this.#applyById(id);
      if (!this.state.stills.length && this.#looksVisual(applied)) await this.#autoStill(applied);
      this.#step('final', '结束', this.state.finalText ? this.state.finalText.slice(0, 200) : '（没有总结）');
      return { status: 'final' };
    }
    while (turns++ < this.maxSteps) {
      const action = await this.agent.next(this.#transportContext());
      if (!action || action.type === 'final') {
        this.state.finalText = typeof action?.text === 'string' ? action.text : '';
        // A one-shot answer that still carries {"note","ops"} becomes a change
        // set too, so legacy transports cannot bypass the journal (§8.1).
        const legacy = this.state.finalText ? extractProposal(this.state.finalText) : null;
        if (legacy) {
          const proposed = await this.#propose({ ops: legacy.ops, intent: legacy.note || this.task }, { silent: false });
          if (this.#gated() && !this.state.approved) {
            this.state.pendingLegacy = { id: proposed.id };
            this.state.status = 'awaiting-approval';
            this.#emit({ type: 'loop', phase: 'awaiting-approval', plan: this.state.plan, proposed: [proposed.id] });
            return { status: 'awaiting-approval' };
          }
          await this.#applyById(proposed.id);
          if (!this.state.stills.length && this.#looksVisual(proposed)) await this.#autoStill(proposed);
        }
        this.#step('final', '结束', this.state.finalText ? this.state.finalText.slice(0, 200) : '（没有总结）');
        return { status: 'final' };
      }
      if (action.type !== 'tool') {
        throw fault('INVALID_ARGUMENT', `transport returned "${action.type}"; expected "tool" or "final"`);
      }
      const result = await this.#call(action);
      if (this.agent.feed) this.agent.feed(result);
      if (this.#gated() && this.#proposedCount() && !this.state.approved) {
        this.state.status = 'awaiting-approval';
        this.#step('plan', '等待批准', `proposed: ${this.state.changesets.filter((row) => row.status === 'proposed').map((row) => row.id).join(', ')}`);
        this.#emit({ type: 'loop', phase: 'awaiting-approval', plan: this.state.plan, proposed: this.state.changesets.filter((row) => row.status === 'proposed').map((row) => row.id) });
        return { status: 'awaiting-approval' };
      }
    }
    throw fault('AGENT_LOOP_LIMIT', `agent stopped after ${this.maxSteps} steps without a final answer`);
  }

  #looksVisual(record) {
    return (record.changed || []).some((row) => typeof row.path === 'string'
      && /^(style\.|transform\.|node\.|pivot\.|scale\.|fx\.)/.test(row.path));
  }

  /** A default still when the agent forgot the 出图 step: the loop owes evidence. */
  async #autoStill(record) {
    const project = await this.#project();
    const row = (record.changed || []).find((entry) => typeof entry.path === 'string' && /^style\./.test(entry.path))
      || (record.changed || [])[0];
    const host = row ? (project.elements || []).find((el) => el.id === row.id) : null;
    const t = host ? (Number(host.start) + Number(host.duration) / 2) : 0;
    try { await this.#toolStill({ t, label: 'auto-after' }); } catch (error) {
      this.state.measurements.push({ phase: 'after', what: 'still', rev: project.rev, at: this.clock(), error: { code: error.code || 'ERROR', message: error.message } });
      this.#step('still', '自动出图失败', `${error.code || 'ERROR'}: ${error.message}`);
    }
  }

  async #call(action) {
    const name = String(action.name || '');
    const args = isRecord(action.args) ? action.args : {};
    const started = Date.now();
    const id = action.id ?? null;
    let entry;
    if (!TOOL_NAMES.includes(name)) {
      const error = { code: 'INVALID_ARGUMENT', message: `unknown tool ${name}; the surface is ${TOOL_NAMES.join(', ')}` };
      entry = { ok: false, error };
    } else {
      try {
        const result = await this.#dispatch(name, args);
        entry = { ok: true, result };
      } catch (error) {
        entry = {
          ok: false,
          error: {
            code: error.code || 'ERROR',
            message: error.message,
            ...(error.id !== undefined ? { id: error.id } : {}),
            ...(error.path !== undefined ? { path: error.path } : {}),
            ...(error.op !== undefined ? { op: error.op } : {}),
            ...(error.scope !== undefined ? { scope: error.scope } : {}),
            ...(error.currentRev !== undefined ? { currentRev: error.currentRev } : {}),
          },
        };
      }
    }
    const ms = Date.now() - started;
    this.messages.push({ role: 'assistant', tool: name, args, id });
    this.messages.push({ role: 'tool', name, id, ...entry, ms });
    if (entry.ok) {
      const summary = this.#summarize(name, args, entry.result);
      const line = `    ↳ ${name}${args.what ? `(${args.what})` : ''} → ${summary}`;
      this.#log(line);
      this.#emit({ type: 'tool', name, args: this.#thinArgs(args), ok: true, ms, summary });
    } else {
      this.state.rejections.push({ tool: name, error: entry.error, at: this.clock() });
      this.#log(`    ↳ ${name} → 被拒 ${entry.error.code}: ${entry.error.message}`);
      this.#emit({ type: 'tool', name, args: this.#thinArgs(args), ok: false, ms, error: entry.error });
    }
    return { id, ok: entry.ok, ...(entry.ok ? { result: entry.result } : { error: entry.error }) };
  }

  #thinArgs(args) {
    const out = {};
    for (const [key, value] of Object.entries(args || {})) {
      if (key === 'ops') out.ops = Array.isArray(value) ? `${value.length} ops` : value;
      else if (key === 'steps') out.steps = Array.isArray(value) ? value.length : value;
      else if (typeof value === 'string' && value.length > 120) out[key] = `${value.slice(0, 120)}…`;
      else out[key] = value;
    }
    return out;
  }

  #summarize(name, args, result) {
    switch (name) {
      case 'read': {
        if (args.what === 'project' || !args.what) return `rev ${result.rev} · ${result.counts?.elements ?? '?'} 元素 · ${result.fps} fps · ${result.duration}s`;
        if (args.what === 'elements') return `${result.count} 个元素${result.elements?.[0] ? ` · ${result.elements.slice(0, 3).map((row) => `${row.id}(${row.name})`).join(', ')}` : ''}`;
        if (args.what === 'element') return `${result.id} · ${result.name} · ${result.type} · start ${result.start} · ${result.size ?? '-'}`;
        if (args.what === 'beats') return `${result.source} × ${result.count}${result.nearest?.length ? ` · 最近 ${result.nearest.map((row) => `${row.label}=${row.nearest ? row.nearest.beat : '-'}`).join(' ')}` : ''}`;
        if (args.what === 'segments') return `${result.segments.length} 个分镜`;
        return 'ok';
      }
      case 'contracts': return result.count !== undefined ? `${result.count} 条` : 'ok';
      case 'ops': return `${result.ops} 个 op 通过契约 v${result.contract?.version}（累计 ${result.contract?.checks} 次）${result.violations.length ? ` · 范围外 ${result.violations.length}` : ''}`;
      case 'plan': return `${result.steps.length} 步 · ${result.opsCount} 个 op${result.needsApproval ? ' · 需要批准' : ''}`;
      case 'changeset': return `${result.id} ${result.status}${result.rev ? ` · rev ${result.rev}` : ''}${result.changed ? ` · ${result.changed.length} 处` : ''}`;
      case 'still': return `${result.path} · ${result.width}×${result.height}`;
      case 'measure': return result.summaryText ? String(result.summaryText).slice(0, 180) : (args.what || 'ok');
      case 'report': return `verified ${result.verificationSummary?.verified ?? 0} / unverified ${result.verificationSummary?.unverified ?? 0} / skipped ${result.verificationSummary?.skipped ?? 0}`;
      default: return 'ok';
    }
  }

  // ------------------------------------------------------------------ report

  async #finish(outcome) {
    this.state.status = outcome.status === 'awaiting-approval' ? 'awaiting-approval' : 'completed';
    this.state.endedAt = this.clock();
    const planPhase = this.state.planPhase;
    if (planPhase.hashAfter === null) {
      planPhase.revAfter = (await this.#project()).rev;
      planPhase.hashAfter = await this.#fileHash();
      planPhase.unchanged = !!planPhase.hashBefore && planPhase.hashBefore === planPhase.hashAfter;
    }
    const report = this.#buildReport({ draft: false });
    if (this.state.status === 'completed') {
      this.#step('report', '报告', `verified ${report.verificationSummary.verified} / unverified ${report.verificationSummary.unverified} / skipped ${report.verificationSummary.skipped}`);
      // The report is written after the last step so its log is complete.
      report.log = this.state.log;
      report.steps = this.state.steps;
    }
    const file = await this.#writeReport(report);
    report.path = file;
    await this.#emit({ type: 'report', report });
    await this.#emit({ type: 'loop', phase: this.state.status === 'awaiting-approval' ? 'awaiting-approval' : 'done', status: this.state.status });
    return {
      runId: this.state.runId,
      status: this.state.status,
      task: this.state.task,
      agentText: this.state.finalText,
      revision: { before: planPhase.revBefore, after: planPhase.revAfter },
      plan: this.state.plan,
      approved: this.state.approved,
      changesets: this.state.changesets,
      stills: this.state.stills,
      measurements: this.state.measurements,
      rejections: this.state.rejections,
      contract: this.state.contract,
      beats: this.state.beats,
      report,
      reportPath: file,
      log: this.state.log,
      steps: this.state.steps,
    };
  }

  async #writeReport(report) {
    const dir = agentDir(this.root, 'reports');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${report.runId}.json`);
    await fs.writeFile(file, `${JSON.stringify(report, null, 2)}${NL}`);
    return path.relative(this.root, file).split(path.sep).join('/');
  }

  /**
   * The §8.3 before/after table, grouped per (change set, host, property
   * family). `diff` addresses a keyframe by its time — moving a clip shifts all
   * of its keys, which would otherwise be a dozen near-identical rows — so
   * `keyframes[1.26].style.color` becomes `keyframes[*].style.color` and the
   * row keeps the raw entries in `changes[]`. `report.changesets[].changed`
   * stays ungrouped: the audit list is never summarized.
   */
  #comparison() {
    const pick = (facts) => (facts ? {
      start: facts.start,
      end: facts.end,
      size: facts.size,
      box: facts.box?.box ?? null,
      boxSource: facts.box?.source ?? null,
      beatStart: facts.beatStart,
      beatEnd: facts.beatEnd,
      stack: facts.stack ? { hit: facts.stack.hit, front: facts.stack.front, frame: facts.stack.frame, covers: facts.stack.row?.coversPoint ?? null } : null,
      coverage: facts.coverage?.summary ? {
        framesPresent: facts.coverage.summary.framesPresent,
        samples: facts.coverage.summary.samples,
        samplesUnoccluded: facts.coverage.summary.samplesUnoccluded,
      } : null,
    } : null);
    const groups = new Map();
    for (const apply of this.state.applyLog) {
      for (const change of apply.changed) {
        const path = pathClassOf(change.path);
        const key = `${apply.id}|${change.id}|${path}`;
        let group = groups.get(key);
        if (!group) {
          const before = (apply.before || []).find((row) => row.id === change.id) || null;
          const after = (apply.after || []).find((row) => row.id === change.id) || null;
          group = {
            changeset: apply.id,
            id: change.id,
            path,
            count: 0,
            changes: [],
            before: null,
            after: null,
            delta: null,
            measured: { before: pick(before), after: pick(after) },
          };
          groups.set(key, group);
        }
        group.count += 1;
        if (group.changes.length < 8) {
          group.changes.push({ path: change.path, before: change.before, after: change.after, change: change.change ?? null });
        }
        if (group.count === 1) {
          group.before = change.before;
          group.after = change.after;
          group.delta = typeof change.before === 'number' && typeof change.after === 'number'
            ? round3(change.after - change.before) : null;
        } else {
          // A batch has no single before/after; the entries are in `changes[]`.
          group.before = null;
          group.after = null;
          group.delta = null;
        }
      }
    }
    return [...groups.values()];
  }

  #verification() {
    const rows = [];
    const applied = this.state.applyLog.filter((entry) => entry.status === 'applied');
    const comparison = this.#comparison();
    for (const row of comparison) {
      const measured = row.measured.before && row.measured.after;
      const styleDelta = row.path === 'style.size' && row.measured.before?.box && row.measured.after?.box;
      if (row.count > 1) {
        // A batch (the keyframes a clip move shifts): one row, every entry kept.
        rows.push({
          claim: `${row.id}.${row.path}：${row.count} 条改动（一批）`,
          status: measured ? 'verified' : 'unverified',
          evidence: `变更集 ${row.changeset} 的 changed[]；例如 ${row.changes.slice(0, 3).map((entry) => `${entry.path}: ${JSON.stringify(entry.before)} → ${JSON.stringify(entry.after)}`).join('；')}`,
        });
        continue;
      }
      rows.push({
        claim: `${row.id}.${row.path}：${JSON.stringify(row.before)} → ${JSON.stringify(row.after)}`,
        status: measured ? 'verified' : 'unverified',
        evidence: styleDelta
          ? `变更集 ${row.changeset} 的 changed[]；文本包围盒 ${row.measured.before.box.join('×')} → ${row.measured.after.box.join('×')} px（${row.measured.before.boxSource || 'estimate'}）`
          : `变更集 ${row.changeset} 的 changed[]（由 inspect-service::diff 生成）`,
      });
    }
    // Beat snap: the number the "卡到最近拍点" half of the task is judged on.
    for (const apply of applied) {
      for (const change of apply.changed) {
        if (change.path !== 'start' && change.path !== 'duration') continue;
        const before = (apply.before || []).find((row) => row.id === change.id);
        const after = (apply.after || []).find((row) => row.id === change.id);
        const beat = after?.beatStart;
        const previous = before?.beatStart;
        if (!beat) {
          rows.push({
            claim: `${change.id}.start 卡到最近拍点`,
            status: 'skipped',
            evidence: `没有节拍数据（source: ${this.state.beats?.source ?? 'none'}）`,
          });
          continue;
        }
        const moved = !previous || Math.abs(previous.deltaFrames) > Math.abs(beat.deltaFrames) + 1e-9;
        rows.push({
          claim: `${change.id}.start ${change.before} → ${change.after}，最近拍点差 ${Math.abs(beat.deltaFrames)} 帧`,
          status: Math.abs(beat.deltaFrames) < 1e-9 ? 'verified' : (moved ? 'verified' : 'unverified'),
          evidence: `节拍来源 ${this.state.beats?.source}${this.state.beats?.file ? ` (${this.state.beats.file})` : ''}`
            + `${this.state.beats?.tempo ? ` · ${round3(this.state.beats.tempo)} bpm` : ''}`
            + ` · 第 ${beat.index + 1} 拍 @${beat.beat}s → 帧 ${beat.frame}（${beat.frameAligned}s）`
            + ` · 前后偏差 ${previous ? Math.abs(previous.deltaFrames) : '?'} → ${Math.abs(beat.deltaFrames)} 帧`
            + `（原始拍点到帧网格 ${Math.abs(beat.rawDeltaFrames ?? 0)} 帧）`,
        });
      }
    }
    if (this.state.stills.length) {
      rows.push({
        claim: `出图 ${this.state.stills.length} 张`,
        status: 'verified',
        evidence: this.state.stills.map((still) => `${still.path} ${still.width}×${still.height}（帧 ${still.frame} · rev ${still.rev}）`).join('；'),
      });
    } else {
      rows.push({ claim: '出图', status: 'skipped', evidence: '本次运行没有渲染任何静帧' });
    }
    if (comparison.length) {
      const seen = new Set();
      const coverageRows = comparison.filter((row) => {
        if (!row.measured.after?.coverage || seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
      if (coverageRows.length) {
        rows.push({
          claim: '受影响帧的可见采样',
          status: 'verified',
          evidence: coverageRows.map((row) => `${row.id}: 未遮挡采样 ${row.measured.before?.coverage?.samplesUnoccluded ?? '?'} → ${row.measured.after?.coverage?.samplesUnoccluded ?? '?'}`).join('；'),
        });
      }
    }
    const outside = this.state.rejections.filter((entry) => entry.error.code === PATH_OUTSIDE_SCOPE);
    rows.push({
      claim: '请求范围外的写入全部被拒',
      status: 'verified',
      evidence: outside.length
        ? `${outside.length} 次被拒（${outside[0].error.code}: ${outside[0].error.message}），项目 rev 与事务日志未变`
        : '本次没有范围外写入尝试',
    });
    const locked = this.state.rejections.filter((entry) => entry.error.code === 'LOCKED');
    if (locked.length) rows.push({ claim: '锁定宿主的写入被拒（LOCKED）', status: 'verified', evidence: locked[0].error.message });
    const contract = this.state.contract;
    rows.push({
      claim: `ops 契约校验 ${contract.checks} 次（${contract.ops} 个 op，失败 ${contract.failures} 次）`,
      status: contract.checks ? 'verified' : 'skipped',
      evidence: `core/contracts.js v${contract.version} + application/validate-contract.js（EDIT_SCHEMA 的 ops 数组）`,
    });
    const plan = this.state.planPhase;
    rows.push({
      claim: '计划阶段没有动项目（proposed 变更集不写盘）',
      status: plan.unchanged === null ? 'skipped' : (plan.unchanged ? 'verified' : 'unverified'),
      evidence: plan.unchanged === null
        ? '本次运行没有计划阶段（没有产生 proposed 变更集）'
        : `project.vdm.json sha256 ${plan.hashBefore === plan.hashAfter ? '前后相同' : '前后不同'} · rev ${plan.revBefore} → ${plan.revAfter} · ${plan.hashBefore?.slice(0, 16)}…`,
    });
    for (const entry of this.state.changesets.filter((row) => row.action === 'revert')) {
      rows.push({
        claim: `变更集 ${entry.id} 可回退`,
        status: entry.restored === true ? 'verified' : (entry.restored === null ? 'skipped' : 'unverified'),
        evidence: entry.restored === null
          ? '这一轮没有它的 apply 记录，无法比较执行前的 hash'
          : `回退后内容 hash ${entry.restored ? '与执行前相同' : '不同'}（raw 文件的 rev / meta.savedAt 会变，内容不含这两个字段）`,
      });
    }
    const appliedIds = applied.map((entry) => entry.id);
    rows.push({
      claim: `每一步写入都是变更集（proposed → applied）`,
      status: appliedIds.length ? 'verified' : 'skipped',
      evidence: appliedIds.length
        ? appliedIds.map((id) => {
          const row = this.state.changesets.find((entry) => entry.id === id);
          return `${id}: proposed@baseRev ${row?.baseRev ?? '?'} → applied@rev ${row?.rev ?? '?'}`;
        }).join('；')
        : '本次运行没有应用任何变更集',
    });
    const summary = { verified: 0, unverified: 0, skipped: 0 };
    for (const row of rows) summary[row.status] = (summary[row.status] || 0) + 1;
    return { rows, summary };
  }

  #buildReport({ draft }) {
    const { rows, summary } = this.#verification();
    const planPhase = this.state.planPhase;
    const comparison = this.#comparison();
    const applied = this.state.applyLog.filter((entry) => entry.status === 'applied');
    const outside = this.state.rejections.filter((entry) => entry.error.code === PATH_OUTSIDE_SCOPE);
    const mismatch = (() => {
      const text = String(this.state.finalText || '');
      if (!text.trim()) return null;
      const claims = /(改好|已改|完成|加好|去掉|调整|done|changed|updated|snapped)/i.test(text);
      if (claims && !applied.length) {
        return { flagged: true, reason: 'agent 声称有改动，但没有任何变更集被应用', agentText: text.slice(0, 400) };
      }
      return null;
    })();
    const report = {
      version: LOOP_VERSION,
      kind: 'agent-report',
      draft: draft === true,
      runId: this.state.runId,
      task: this.state.task,
      actorId: this.state.actorId,
      mode: this.state.mode,
      approval: { mode: this.state.approval, ...(this.state.approved ? { approvedAt: this.state.approved.at, planId: this.state.approved.planId } : {}) },
      scope: this.state.scope,
      status: this.state.status,
      createdAt: this.state.startedAt,
      endedAt: this.state.endedAt,
      revision: { before: planPhase.revBefore, after: planPhase.revAfter },
      plan: this.state.plan,
      beats: this.state.beats ? {
        source: this.state.beats.source,
        fps: this.state.beats.fps,
        tempo: this.state.beats.tempo ?? null,
        count: this.state.beats.count,
        ...(this.state.beats.file ? { file: this.state.beats.file, method: this.state.beats.method, analysisMs: this.state.beats.analysisMs } : {}),
        ...(this.state.beats.error ? { error: this.state.beats.error } : {}),
      } : null,
      changesets: this.state.changesets.map((row) => ({
        id: row.id, action: row.action ?? null, status: row.status,
        baseRev: row.baseRev ?? null, rev: row.rev ?? null, transactions: row.transactions || [],
        opsCount: row.opsCount ?? null, changed: row.changed || [], counts: row.counts ?? null,
      })),
      comparison,
      stills: this.state.stills,
      measurements: this.state.measurements,
      contract: { ...this.state.contract },
      rejections: this.state.rejections,
      agentText: this.state.finalText,
      mismatch,
      verification: rows,
      verificationSummary: summary,
      planPhase: {
        before: planPhase.revBefore,
        after: planPhase.revAfter,
        unchanged: planPhase.unchanged,
        hashBefore: planPhase.hashBefore,
        hashAfter: planPhase.hashAfter,
      },
      log: this.state.log,
      steps: this.state.steps,
      counts: {
        changesets: this.state.changesets.length,
        applied: applied.length,
        stills: this.state.stills.length,
        measurements: this.state.measurements.length,
        rejections: this.state.rejections.length,
        outsideScope: outside.length,
      },
      ...(draft ? {} : { path: null }),
    };
    return report;
  }

  async close() {
    try { await this.agent?.close(); } catch { /* already gone */ }
  }
}
