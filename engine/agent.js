// DSH-TUI agent bridge.
// Spawns `dsh --profile headless --json <task>` in the project directory and
// streams its NDJSON run events. Killing the process = interrupting the agent.
//
// The headless profile can read files but cannot run shell commands, so the edit
// protocol is: the agent reads project.vdm.json and replies with an ops JSON object
// ({"note", "ops"}), which the engine validates and applies through core/ops.js.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { which } from './which.js';

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
  constructor({ root, onEvent }) {
    this.root = root;
    this.onEvent = onEvent;
    this.child = null;
    this.runId = null;
    this.finalText = '';
    this.textBuf = '';
    this.startedAt = 0;
  }

  get running() { return !!this.child; }

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
      '  {"op":"keyRemove","id":"el_x","path":"transform.scale"}',
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
    const dsh = await findDsh();
    if (!dsh) throw new Error('DSH-TUI not found. Install it (npm i -g @deepseek-ai/dsh) or set VDM_DSH to lib/bin.js');
    const prompt = this.buildTask({ task, contextFile, frames, selection, project });
    this.runId = `run-${Date.now()}`;
    this.finalText = '';
    this.textBuf = '';
    this.startedAt = Date.now();

    const env = { ...process.env };
    if (isElectron && dsh.node === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(dsh.node, [dsh.bin, '--profile', 'headless', '--json', prompt], {
      cwd: this.root,
      windowsHide: true,
      env,
    });
    this.child = child;
    const emit = (ev) => this.onEvent?.({ runId: this.runId, ...ev });
    emit({ type: 'started', bin: dsh.bin, node: dsh.node });

    let buf = '';
    const handle = (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try { ev = JSON.parse(s); } catch { emit({ type: 'raw', text: s }); return; }
      if (ev.type === 'text') {
        this.textBuf += ev.text || '';
        emit({ type: 'agent', event: ev });
      } else if (ev.type === 'final') {
        this.finalText = ev.text || this.textBuf;
        emit({ type: 'agent', event: ev });
      } else {
        emit({ type: 'agent', event: ev });
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
    child.on('error', (e) => emit({ type: 'error', message: String(e) }));
    child.on('close', (code) => {
      if (buf) handle(buf);
      this.child = null;
      const proposal = extractProposal(this.finalText || this.textBuf);
      if (proposal) emit({ type: 'proposal', proposal });
      emit({
        type: 'exit',
        code,
        seconds: (Date.now() - this.startedAt) / 1000,
        stderr: errText ? errText.slice(-2000) : '',
        hadFinal: !!this.finalText,
      });
    });
    return { runId: this.runId };
  }

  cancel() {
    if (!this.child) return false;
    const runId = this.runId;
    killTree(this.child);
    this.child = null;
    this.onEvent?.({ runId, type: 'cancelled' });
    return true;
  }
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
