// DSH-TUI agent bridge.
// Spawns `dsh --profile headless --json <task>` in the project directory and
// streams its NDJSON run events. Killing the process = interrupting the agent.
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const NL = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = path.resolve(HERE, '../cli/vdm.js');

function npmRoots() {
  const appdata = process.env.APPDATA || '';
  return [
    path.join(appdata, 'npm', 'node_modules'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs', 'node_modules'),
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache'),
  ].filter(Boolean);
}

export async function findDsh() {
  if (process.env.VDM_DSH && fss.existsSync(process.env.VDM_DSH)) {
    return { node: process.execPath, bin: process.env.VDM_DSH };
  }
  for (const root of npmRoots()) {
    const bin = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fss.existsSync(bin)) return { node: process.execPath, bin };
  }
  try {
    const { stdout } = await execFileP(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { windowsHide: true });
    const shim = stdout.split(/\r?\n/).find(Boolean)?.trim();
    if (shim) {
      // resolve the real entry from the shim directory
      for (const root of npmRoots()) {
        const bin = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
        if (fss.existsSync(bin)) return { node: process.execPath, bin };
      }
      return { node: process.execPath, bin: shim };
    }
  } catch { /* not installed */ }
  return null;
}

const isElectron = !!process.versions.electron;

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
    this.toolCalls = 0;
  }

  get running() { return !!this.child; }

  /** Write the context bundle the agent will read. */
  async writeContext({ project, selection, frames = [], extra = {} }) {
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
      .map((e) => `${e.id} (${e.type}, ${e.start.toFixed(2)}s +${e.duration.toFixed(2)}s, z${e.z}${e.type === 'text' ? `, "${String(e.style.text).slice(0, 24)}"` : ''})`);
    const frameList = (frames || []).map((f) => `  - ${f}`).join(NL) || '  (none)';
    return [
      'You are the edit agent inside VedioMaker, a local video composer.',
      'You CANNOT run shell commands. You read the project, then reply with edit operations as JSON.',
      '',
      `Project: ${this.root}/project.vdm.json (read it for full detail; it is the timeline document)`,
      `Context bundle: ${contextFile} (selection, beats, frames, summary)`,
      `Frames of the target segment (look at them if you can read images):` + NL + frameList,
      '',
      seg ? `Target segment: ${seg.id} "${seg.name}" ${seg.start.toFixed(2)}s .. ${(seg.start + seg.duration).toFixed(2)}s` : 'Target: whole timeline',
      `Elements available:` + NL + (segEls.map((x) => '  ' + x).join(NL) || '  (none)'),
      '',
      'REPLY FORMAT — one JSON object, no markdown fences, no prose before/after:',
      '{"note": "one sentence about what you changed", "ops": [ ... ]}',
      '',
      'Operations (same schema the UI and CLI use):',
      '  {"op":"updateElement","id":"el_x","patch":{"style":{"text":"新字幕","size":120},"transform":{"y":-40},"motion":{"type":"in","amount":0.1}}}',
      '  {"op":"set","id":"el_x","path":"style.color","value":"#ffd400"}',
      '  {"op":"keySet","id":"el_x","path":"transform.scale","t":4.2,"value":1.2,"ease":"outExpo"}',
      '  {"op":"keyRemove","id":"el_x","path":"transform.scale"}',
      '  {"op":"addElement","element":{"type":"text","start":4.0,"duration":2.5,"z":5,"segment":"seg_2","style":{"text":"标题","size":140,"color":"#ffffff"},"transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1},"fadeIn":0.3}}',
      '  {"op":"moveElement","id":"el_x","start":4.0,"duration":2.5}',
      '  {"op":"removeElement","id":"el_x"}',
      '  {"op":"setFx","fx":{"bloom":0.5,"ca":0.3,"grain":0.12,"vignette":0.5,"scanline":0.2}}',
      '  {"op":"setMeta","path":"background","value":"#05070d"}',
      '',
      'Rules:',
      '1. Stay inside the target segment unless the user explicitly asks for the whole piece.',
      '2. Small, reversible changes; 1-6 ops is usually enough.',
      '3. Keep text short — it is rendered at 1920x1080.',
      '4. Do not invent element ids; use the ones listed above, or add a new element.',
      '',
      'TASK:',
      task || 'Improve the selected segment.',
    ].join(NL);
  }

  async start({ task, contextFile, frames = [], selection = {}, project }) {
    if (this.running) throw new Error('agent is already running');
    const dsh = await findDsh();
    if (!dsh) throw new Error('DSH-TUI not found. Install it (npm i -g @deepseek-ai/dsh) or set VDM_DSH to lib/bin.js');
    const prompt = this.buildTask({ task, contextFile, frames, selection, project });
    this.runId = `run-${Date.now()}`;
    this.toolCalls = 0;
    this.finalText = '';
    this.textBuf = '';
    this.startedAt = Date.now();
    const env = { ...process.env };
    if (isElectron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(dsh.node, [dsh.bin, '--profile', 'headless', '--json', prompt], {
      cwd: this.root,
      windowsHide: true,
      env,
    });
    this.child = child;
    const emit = (ev) => this.onEvent?.({ runId: this.runId, ...ev });
    emit({ type: 'started', prompt });

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
      } else if (ev.type === 'thinking') {
        emit({ type: 'agent', event: ev });
      } else if (ev.type === 'status') {
        emit({ type: 'agent', event: ev });
      } else if (ev.type === 'session') {
        emit({ type: 'agent', event: ev });
      } else {
        emit({ type: 'agent', event: ev });
      }
    };
    child.stdout.on('data', (d) => {
      buf += String(d);
      const parts = buf.split(/\r?\n/);
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
      emit({ type: 'exit', code, seconds: (Date.now() - this.startedAt) / 1000, stderr: code ? errText.slice(-2000) : '' });
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
  const tries = [];
  const start = cleaned.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
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
        if (depth === 0) { tries.push(cleaned.slice(start, i + 1)); break; }
      }
    }
  }
  for (const t of tries) {
    try {
      const obj = JSON.parse(t);
      if (obj && Array.isArray(obj.ops)) return { note: obj.note || '', ops: obj.ops };
      if (obj && obj.op) return { note: '', ops: [obj] };
    } catch { /* next */ }
  }
  return null;
}
