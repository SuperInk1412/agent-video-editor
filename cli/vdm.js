#!/usr/bin/env node
// vdm — VedioMaker command line. The ONE edit surface shared by humans and the AI agent.
// Every command is a thin wrapper over core/ops.js (and engine/ for rendering probes).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  paths, loadProject, saveProject, mutateProject, findProjectRoot, projectExists,
} from '../core/store.js';
import { createProject, normalizeProject, validateProject, DEFAULT_FX, clone } from '../core/schema.js';
import { applyOps, applyOp, coerceValue } from '../core/ops.js';
import { evalElement } from '../core/evaluate.js';
import { timecode } from '../core/time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
  ye: (s) => `\x1b[33m${s}\x1b[0m`,
  gr: (s) => `\x1b[32m${s}\x1b[0m`,
  re: (s) => `\x1b[31m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`,
};

function parseArgv(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function readJsonArg(v) {
  if (v === '-' || v === undefined) {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw);
  }
  if (typeof v === 'string' && v.startsWith('@')) return JSON.parse(fs.readFileSync(v.slice(1), 'utf8'));
  if (typeof v === 'string' && (v.trim().startsWith('{') || v.trim().startsWith('['))) return JSON.parse(v);
  throw new Error('expected JSON, @file or - (stdin)');
}

async function resolveRoot(flags) {
  const target = flags.project ? path.resolve(flags.project) : process.cwd();
  const root = await findProjectRoot(target);
  if (!root) throw new Error(`not a VedioMaker project (no project.vdm.json in ${target} or parents). Run: vdm init <dir>`);
  return root;
}

const fmtT = (t) => `${t.toFixed(2)}s`;
const fmtRange = (s, d) => `${s.toFixed(2)}–${(s + d).toFixed(2)}s`;

function printProjectSummary(p, json) {
  if (json) { console.log(JSON.stringify(p, null, 2)); return; }
  console.log(`${C.b(p.meta.title)}  ${C.dim(`${p.meta.width}x${p.meta.height} @${p.meta.fps}fps · ${p.meta.duration.toFixed(2)}s · rev ${p.rev}`)}`);
  console.log(C.dim(`beats: ${p.meta.beats.length} @ ${p.meta.tempo || '?'} bpm   fx: ${JSON.stringify(p.meta.fx)}`));
  if (p.meta.audio) console.log(C.dim(`audio: ${p.meta.audio.src}`));
  console.log('');
  for (const s of p.segments) {
    console.log(`  ${C.cy(s.id.padEnd(8))} ${fmtRange(s.start, s.duration).padEnd(16)} ${C.b(s.name || '')}  ${C.dim(s.status)} ${C.dim(s.intent || '')}`);
  }
  console.log('');
  const sorted = [...p.elements].sort((a, b) => a.z - b.z);
  for (const e of sorted) {
    const label = e.type === 'text' ? `"${String(e.style.text).slice(0, 18)}"` : (e.src || '');
    console.log(`  ${C.mag(e.id.padEnd(10))} ${String(e.type).padEnd(6)} z${String(e.z).padStart(2)} ${fmtRange(e.start, e.duration).padEnd(16)} ${C.dim((e.segment || '-').padEnd(7))} ${label}`);
  }
}

async function cmdInit(argv, flags) {
  const dir = path.resolve(argv[0] || '.');
  if (await projectExists(dir)) throw new Error(`project already exists in ${dir}`);
  await fsp.mkdir(dir, { recursive: true });
  let [width, height] = String(flags.size || '1920x1080').split('x').map(Number);
  if (!width || !height) { width = 1920; height = 1080; }
  const project = createProject({
    title: flags.title || path.basename(dir),
    fps: num(flags.fps, 24),
    width, height,
    duration: num(flags.duration, 12),
    background: flags.background || '#05070d',
  });
  let audio = null;
  if (flags.audio) {
    const abs = path.resolve(flags.audio);
    const mediaDir = path.join(dir, 'media');
    await fsp.mkdir(mediaDir, { recursive: true });
    const name = path.basename(abs);
    const dest = path.join(mediaDir, name);
    if (path.resolve(dest) !== abs) await fsp.copyFile(abs, dest);
    audio = { src: `media/${name}`, offset: 0, gain: 0 };
    project.meta.audio = audio;
  }
  await saveProject(dir, project);
  console.log(`${C.gr('✓')} 已创建项目 ${C.b(dir)}`);
  console.log(`  ${C.dim('用 `node engine/server.js --project . --open` 或 npm start 打开编辑器')}`);
  console.log(`  ${C.dim('或用 `vdm add` / `vdm plan` 在命令行建时间线')}`);
}

async function cmdInfo(root, flags) {
  const p = await loadProject(root);
  if (flags.json) {
    const { findBlender } = await import('../engine/blender.js').catch(() => ({ findBlender: null }));
    let blender = null;
    try { blender = findBlender ? await findBlender() : null; } catch { /* none */ }
    console.log(JSON.stringify({ root, file: paths(root).file, project: p, blender }, null, 2));
    return;
  }
  printProjectSummary(p, false);
}

async function cmdLs(root, flags) {
  const p = await loadProject(root);
  if (flags.json) { console.log(JSON.stringify(p.elements, null, 2)); return; }
  const els = p.elements.filter((e) => !flags.segment || e.segment === flags.segment).sort((a, b) => a.z - b.z);
  for (const e of els) {
    const label = e.type === 'text' ? JSON.stringify(e.style.text) : (e.src || '');
    console.log(`${C.mag(e.id)}  ${e.type.padEnd(6)} z${String(e.z).padStart(2)}  ${fmtRange(e.start, e.duration)}  ${C.dim(e.segment || '-')}  ${label}`);
  }
  if (!els.length) console.log(C.dim('(no elements)'));
}

async function cmdGet(root, argv, flags) {
  const p = await loadProject(root);
  const id = argv[0];
  const el = p.elements.find((e) => e.id === id) || p.segments.find((s) => s.id === id);
  if (!el) throw new Error(`no element/segment ${id}`);
  if (argv[1]) {
    const v = argv.slice(1).join('.').split('.').reduce((o, k) => (o == null ? undefined : o[k]), el);
    console.log(flags.json ? JSON.stringify(v) : (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)));
    return;
  }
  console.log(JSON.stringify(el, null, 2));
}

async function cmdSet(root, argv, flags) {
  const [id, propPath, ...rest] = argv;
  if (!id || !propPath || !rest.length) throw new Error('usage: vdm set <id> <path> <value>');
  const raw = rest.join(' ');
  const { project, result } = await mutateProject(root, (p) => applyOp(p, { op: 'set', id, path: propPath, value: coerceValue(raw) }), { by: 'cli' });
  const v = propPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), project.elements.find((e) => e.id === id) || {});
  if (flags.json) console.log(JSON.stringify({ ok: true, id, path: propPath, value: v, rev: project.rev }));
  else console.log(`${C.gr('✓')} ${id}.${propPath} = ${C.ye(JSON.stringify(v))}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdUpdate(root, argv, flags) {
  const [id, json] = argv;
  if (!id) throw new Error('usage: vdm update <id> <json-patch|@file|->');
  const patch = readJsonArg(json);
  const { project } = await mutateProject(root, (p) => applyOp(p, { op: 'updateElement', id, patch }), { by: 'cli' });
  console.log(flags.json ? JSON.stringify({ ok: true, rev: project.rev }) : `${C.gr('✓')} 已更新 ${id}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdAdd(root, argv, flags) {
  let element = argv[0] && (argv[0].startsWith('@') || argv[0].startsWith('{')) ? readJsonArg(argv[0]) : null;
  if (!element) {
    if (!flags.type) throw new Error('usage: vdm add --type image|video|text|solid|shape [--src ...] [--text ...] [--start t] [--duration d] [--segment seg]');
    element = {
      type: flags.type,
      src: flags.src,
      start: num(flags.start, 0),
      duration: num(flags.duration, 3),
      z: flags.z !== undefined ? num(flags.z) : undefined,
      segment: flags.segment,
      transform: flags.x || flags.y || flags.scale ? { x: num(flags.x, 0), y: num(flags.y, 0), scale: num(flags.scale, 1) } : undefined,
      style: flags.text ? { text: flags.text, size: num(flags.size, 96), color: flags.color || '#ffffff' } : undefined,
      motion: flags.motion ? { type: flags.motion, amount: num(flags.amount, 0.1) } : undefined,
      fadeIn: num(flags['fade-in'], 0) || undefined,
      fadeOut: num(flags['fade-out'], 0) || undefined,
    };
    if (flags['json-patch']) Object.assign(element, readJsonArg(flags.patch));
  }
  if (flags.segment && !element.segment) element.segment = flags.segment;
  if (flags.at !== undefined) element.start = num(flags.at);
  const { project, result } = await mutateProject(root, (p) => applyOp(p, { op: 'addElement', element }), { by: 'cli' });
  const created = result?.element;
  console.log(flags.json ? JSON.stringify({ ok: true, element: created, rev: project.rev })
    : `${C.gr('✓')} 新增 ${C.mag(created?.id)} ${created?.type} @ ${fmtT(created?.start)}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdRm(root, argv, flags) {
  const id = argv[0];
  if (!id) throw new Error('usage: vdm rm <id>');
  const { project } = await mutateProject(root, (p) => applyOp(p, { op: 'removeElement', id }), { by: 'cli' });
  console.log(flags.json ? JSON.stringify({ ok: true, rev: project.rev }) : `${C.gr('✓')} 删除 ${id}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdMv(root, argv, flags) {
  const id = argv[0];
  if (!id) throw new Error('usage: vdm mv <id> [--start t] [--duration d] [--z n] [--segment seg]');
  const op = { op: 'moveElement', id };
  if (flags.start !== undefined) op.start = num(flags.start);
  if (flags.duration !== undefined) op.duration = num(flags.duration);
  if (flags.z !== undefined) op.z = num(flags.z);
  if (flags.segment !== undefined) op.segment = flags.segment;
  const { project, result } = await mutateProject(root, (p) => applyOp(p, op), { by: 'cli' });
  const el = result?.element;
  console.log(flags.json ? JSON.stringify({ ok: true, element: el, rev: project.rev })
    : `${C.gr('✓')} ${id} → ${fmtRange(el.start, el.duration)} z${el.z}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdSplit(root, argv, flags) {
  const [id, at] = argv;
  if (!id || at === undefined) throw new Error('usage: vdm split <id> <t>');
  const { project, result } = await mutateProject(root, (p) => applyOp(p, { op: 'splitElement', id, at: num(at) }), { by: 'cli' });
  const right = result?.element;
  console.log(flags.json ? JSON.stringify({ ok: true, right, rev: project.rev })
    : `${C.gr('✓')} 切开 ${id} → 右半 ${C.mag(right.id)}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdSeg(root, argv, flags) {
  const sub = argv[0];
  if (!sub || sub === 'ls') {
    const p = await loadProject(root);
    if (flags.json) { console.log(JSON.stringify(p.segments, null, 2)); return; }
    for (const s of p.segments) console.log(`${C.cy(s.id.padEnd(8))} ${fmtRange(s.start, s.duration).padEnd(16)} ${C.b(s.name)} ${C.dim(s.status)} ${C.dim(s.intent || '')}`);
    return;
  }
  if (sub === 'add') {
    const { project, result } = await mutateProject(root, (p) => applyOp(p, {
      op: 'addSegment',
      segment: {
        start: num(flags.start, 0), duration: num(flags.duration, 3),
        name: flags.name, intent: flags.intent, status: flags.status,
      },
    }), { by: 'cli' });
    const seg = result?.segment;
    console.log(flags.json ? JSON.stringify({ ok: true, segment: seg, rev: project.rev })
      : `${C.gr('✓')} 新增分镜 ${C.cy(seg.id)} ${fmtRange(seg.start, seg.duration)}  ${C.dim(`rev ${project.rev}`)}`);
    return;
  }
  if (sub === 'set') {
    const [id, propPath, ...rest] = argv.slice(1);
    if (!id || !propPath) throw new Error('usage: vdm seg set <id> <path> <value>');
    const { project } = await mutateProject(root, (p) => {
      const seg = p.segments.find((s) => s.id === id);
      if (!seg) throw new Error(`no segment ${id}`);
      const val = coerceValue(rest.join(' '));
      if (propPath === 'start') seg.start = Number(val);
      else if (propPath === 'duration') seg.duration = Number(val);
      else {
        const parts = propPath.split('.');
        let o = seg;
        for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = val;
      }
      p.segments.sort((a, b) => a.start - b.start);
    }, { by: 'cli' });
    console.log(flags.json ? JSON.stringify({ ok: true, rev: project.rev }) : `${C.gr('✓')} 分镜 ${id}.${propPath} 已更新  ${C.dim(`rev ${project.rev}`)}`);
    return;
  }
  if (sub === 'rm') {
    const id = argv[1];
    if (!id) throw new Error('usage: vdm seg rm <id>');
    const { project } = await mutateProject(root, (p) => applyOp(p, { op: 'removeSegment', id }), { by: 'cli' });
    console.log(flags.json ? JSON.stringify({ ok: true, rev: project.rev }) : `${C.gr('✓')} 删除分镜 ${id}  ${C.dim(`rev ${project.rev}`)}`);
    return;
  }
  throw new Error(`unknown seg subcommand ${sub}`);
}

async function cmdKey(root, argv, flags) {
  const sub = argv[0];
  if (sub === 'set') {
    const [id, propPath, t, ...valueParts] = argv.slice(1);
    if (!id || !propPath || t === undefined || !valueParts.length) throw new Error('usage: vdm key set <id> <path> <t> <value> [--ease name]');
    const value = coerceValue(valueParts.join(' '));
    const { project } = await mutateProject(root, (p) => applyOp(p, {
      op: 'keySet', id, path: propPath, t: num(t), value, ease: flags.ease || 'easeInOut',
    }), { by: 'cli' });
    console.log(flags.json ? JSON.stringify({ ok: true, rev: project.rev })
      : `${C.gr('✓')} 关键帧 ${id}.${propPath} @${num(t).toFixed(2)}s = ${C.ye(JSON.stringify(value))} (${flags.ease || 'easeInOut'})  ${C.dim(`rev ${project.rev}`)}`);
    return;
  }
  if (sub === 'rm') {
    const [id, propPath] = argv.slice(1);
    if (!id || !propPath) throw new Error('usage: vdm key rm <id> <path>');
    const { project } = await mutateProject(root, (p) => applyOp(p, { op: 'keyRemove', id, path: propPath }), { by: 'cli' });
    console.log(flags.json ? JSON.stringify({ ok: true, rev: project.rev }) : `${C.gr('✓')} 已清除 ${id}.${propPath} 的关键帧  ${C.dim(`rev ${project.rev}`)}`);
    return;
  }
  if (sub === 'ls' || !sub) {
    const p = await loadProject(root);
    const el = p.elements.find((e) => e.id === argv[1]);
    if (!el) throw new Error('usage: vdm key ls <id>');
    const kfs = [...el.keyframes].sort((a, b) => a.t - b.t);
    if (flags.json) { console.log(JSON.stringify(kfs, null, 2)); return; }
    for (const k of kfs) console.log(`  ${k.t.toFixed(2)}s  ${k.path.padEnd(20)} ${JSON.stringify(k.value).padEnd(12)} ${k.ease}`);
    if (!kfs.length) console.log(C.dim('(no keyframes)'));
    return;
  }
  throw new Error(`unknown key subcommand ${sub}`);
}

async function cmdMeta(root, argv, flags) {
  const [propPath, ...rest] = argv;
  if (!propPath) throw new Error('usage: vdm meta <path> <value>');
  const value = coerceValue(rest.join(' '));
  const { project } = await mutateProject(root, (p) => applyOp(p, { op: 'setMeta', path: propPath, value }), { by: 'cli' });
  console.log(`${C.gr('✓')} meta.${propPath} = ${C.ye(JSON.stringify(value))}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdFx(root, argv, flags) {
  const fx = readJsonArg(argv[0]);
  const { project } = await mutateProject(root, (p) => applyOp(p, { op: 'setFx', fx }), { by: 'cli' });
  console.log(`${C.gr('✓')} fx = ${C.ye(JSON.stringify(fx))}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdOps(root, argv, flags) {
  const ops = readJsonArg(argv[0]);
  const list = Array.isArray(ops) ? ops : (ops.ops || [ops]);
  const { project, result } = await mutateProject(root, (p) => applyOps(p, list), { by: 'cli' });
  console.log(flags.json ? JSON.stringify({ ok: true, changed: result, rev: project.rev })
    : `${C.gr('✓')} 应用 ${list.length} 个操作，变更 ${(result.changed || []).join(', ')}  ${C.dim(`rev ${project.rev}`)}`);
}

async function cmdImport(root, argv, flags) {
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) throw new Error('usage: vdm import <file...>');
  const mediaDir = path.join(root, 'media');
  await fsp.mkdir(mediaDir, { recursive: true });
  const out = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (!(await fsp.stat(abs).catch(() => null))) { console.log(C.re(`! 跳过 ${f} (不存在)`)); continue; }
    let name = path.basename(abs);
    let dest = path.join(mediaDir, name);
    let i = 1;
    while (await fsp.stat(dest).catch(() => null)) {
      const ext = path.extname(name);
      name = `${path.basename(name, ext)}-${i++}${ext}`;
      dest = path.join(mediaDir, name);
    }
    await fsp.copyFile(abs, dest);
    out.push({ path: `media/${name}`, name });
    console.log(`${C.gr('✓')} 导入 ${C.cy(`media/${name}`)}`);
  }
  if (flags.json) console.log(JSON.stringify({ imported: out }, null, 2));
}

async function cmdBeats(root, flags) {
  const p = await loadProject(root);
  const rel = flags.src || p.meta.audio?.src;
  if (!rel) throw new Error('no audio in project; pass --src <file> or add meta.audio first');
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const { analyzeBeats } = await import('../engine/beats.js');
  console.log(C.dim(`分析 ${rel} …`));
  const r = await analyzeBeats(file, { duration: flags.duration ? num(flags.duration) : null, fps: p.meta.fps });
  const { project } = await mutateProject(root, (proj) => {
    proj.meta.beats = r.beats;
    proj.meta.tempo = r.tempo;
    if (!proj.meta.audio) proj.meta.audio = { src: rel, offset: 0, gain: 0 };
    if (flags['set-duration'] || !proj.meta.duration) proj.meta.duration = Math.round(r.duration * 1000) / 1000;
  }, { by: 'cli' });
  console.log(`${C.gr('✓')} ${r.tempo} bpm · ${r.beats.length} beats · ${r.duration.toFixed(1)}s  ${C.dim(`rev ${project.rev}`)}`);
  if (flags.json) console.log(JSON.stringify(r, null, 2));
}

async function cmdPlan(root, flags) {
  const p = await loadProject(root);
  const { autoStoryboard } = await import('../engine/storyboard.js');
  const media = flags.media
    ? String(flags.media).split(',').map((s) => s.trim().replace(/^media\//, '')).map((s) => `media/${s}`)
    : (await fsp.readdir(path.join(root, 'media')).catch(() => []))
      .filter((f) => /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(f)).map((f) => `media/${f}`);
  const base = createProject({
    title: p.meta.title, fps: p.meta.fps, width: p.meta.width, height: p.meta.height,
    duration: flags.duration ? num(flags.duration) : p.meta.duration,
    background: p.meta.background, audio: p.meta.audio,
  });
  base.meta.beats = p.meta.beats;
  base.meta.tempo = p.meta.tempo;
  const { ops } = autoStoryboard({
    project: base, media, style: flags.style || 'neon', brief: flags.brief || '',
    seed: num(flags.seed, 7), maxSegments: num(flags['max-segments'], 12),
  });
  const planned = clone(base);
  applyOps(planned, ops);
  planned.meta.title = p.meta.title;
  planned.meta.audio = p.meta.audio;
  planned.meta.beats = p.meta.beats;
  planned.meta.tempo = p.meta.tempo;
  planned.rev = p.rev;
  await saveProject(root, planned, { by: 'cli' });
  base.segments = planned.segments;
  base.elements = planned.elements;
  console.log(`${C.gr('✓')} 自动分镜: ${base.segments.length} 段 / ${base.elements.length} 元素  ${C.dim(`(style=${flags.style || 'neon'})`)}`);
}

async function cmdStill(root, argv, flags) {
  const time = num(argv[0] ?? flags.time ?? 0);
  const project = await loadProject(root);
  const { renderStill } = await import('../engine/blender.js');
  const out = flags.out ? path.resolve(flags.out) : path.join(paths(root).frames, `still-${Date.now()}.png`);
  console.log(C.dim(`Blender 渲染 ${time.toFixed(2)}s …`));
  const file = await renderStill({
    dir: root, project, time, out,
    scale: num(flags.scale, 1), samples: num(flags.samples, 16),
  });
  if (flags.json) console.log(JSON.stringify({ ok: true, time, out: file }));
  else console.log(`${C.gr('✓')} ${file}`);
}

async function cmdRender(root, flags) {
  const project = await loadProject(root);
  const { renderVideo } = await import('../engine/blender.js');
  const from = num(flags.from, 0);
  const to = num(flags.to, project.meta.duration);
  const out = flags.out ? path.resolve(flags.out) : path.join(paths(root).renders, `render-${Date.now()}.mp4`);
  console.log(C.dim(`渲染 ${from.toFixed(2)}–${to.toFixed(2)}s → ${out}`));
  const t0 = Date.now();
  const res = await renderVideo({
    dir: root, project, from, to, out,
    scale: num(flags.scale, 1), crf: num(flags.crf, 18),
    onProgress: (ev) => {
      if (ev.stage === 'frame' && (ev.frame % 12 === 0 || ev.frame === ev.total)) {
        process.stdout.write(`\r  ${C.dim(`${ev.frame}/${ev.total} 帧`)}`);
      }
    },
  });
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
  if (flags.json) console.log(JSON.stringify({ ok: true, ...res }));
  else console.log(`${C.gr('✓')} ${res.out}  ${C.dim(`${res.frames} 帧 · ${((Date.now() - t0) / 1000).toFixed(1)}s`)}`);
}

async function cmdEval(root, argv, flags) {
  const [id] = argv;
  const t = num(flags.t, 0);
  const p = await loadProject(root);
  const el = p.elements.find((e) => e.id === id);
  if (!el) throw new Error(`no element ${id}`);
  const st = evalElement(el, t, p.meta);
  console.log(JSON.stringify(st, null, 2));
}

function usage() {
  console.log(`${C.b('vdm')} — VedioMaker CLI

${C.b('项目')}
  vdm init [dir] [--title T] [--fps 24] [--size 1920x1080] [--duration 12] [--audio f]
  vdm info [--json]           项目概览
  vdm ls [--segment id] [--json]
  vdm get <id> [path]         取元素（或某字段）

${C.b('编辑')}
  vdm set <id> <path> <value>         例: vdm set el_1 transform.scale 1.2
  vdm update <id> <json>              深合并补丁
  vdm add --type text --text "标题" --start 1 --duration 3 [--segment seg_1]
  vdm add '{"type":"image","src":"media/a.png","start":0,"duration":4}'
  vdm rm <id> | vdm mv <id> --start 2 --duration 3 | vdm split <id> <t>
  vdm key set <id> <path> <t> <value> [--ease outExpo]
  vdm key rm <id> <path> | vdm key ls <id>
  vdm seg ls|add|set|rm
  vdm meta <path> <value> | vdm fx '{"bloom":0.5}'
  vdm ops <json|@file|->

${C.b('素材 / 分镜')}
  vdm import <file...>
  vdm beats [--src f] [--set-duration]
  vdm plan [--style neon|clean|film] [--brief "第一句\\n第二句"] [--seed 7]

${C.b('渲染')}
  vdm still <t> [--out a.png] [--scale 1] [--samples 16]
  vdm render [--from 0] [--to 6] [--out a.mp4] [--scale 1] [--crf 18]
  vdm eval <id> [--t 3.2]     元素在某时刻的求值结果

${C.b('全局')}
  --project <dir>   指定项目目录（默认向上查找 project.vdm.json）
  --json            机器可读输出

${C.dim('AI agent 用同样的命令改片；所有写操作都经过 core/ops.js，带锁与 rev 版本号。')}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { pos, flags } = parseArgv(argv);
  const cmd = pos[0];
  const rest = pos.slice(1);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { usage(); return; }

  if (cmd === 'init') return cmdInit(rest, flags);
  const root = await resolveRoot(flags);

  switch (cmd) {
    case 'info': return cmdInfo(root, flags);
    case 'ls': return cmdLs(root, flags);
    case 'get': return cmdGet(root, rest, flags);
    case 'set': return cmdSet(root, rest, flags);
    case 'update': return cmdUpdate(root, rest, flags);
    case 'add': return cmdAdd(root, rest, flags);
    case 'rm': return cmdRm(root, rest, flags);
    case 'mv': return cmdMv(root, rest, flags);
    case 'split': return cmdSplit(root, rest, flags);
    case 'seg': return cmdSeg(root, rest, flags);
    case 'key': return cmdKey(root, rest, flags);
    case 'meta': return cmdMeta(root, rest, flags);
    case 'fx': return cmdFx(root, rest, flags);
    case 'ops': return cmdOps(root, rest, flags);
    case 'import': return cmdImport(root, rest, flags);
    case 'beats': return cmdBeats(root, flags);
    case 'plan': return cmdPlan(root, flags);
    case 'still': return cmdStill(root, rest, flags);
    case 'render': return cmdRender(root, flags);
    case 'eval': return cmdEval(root, rest, flags);
    default:
      console.error(C.re(`unknown command: ${cmd}`));
      usage();
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`${C.re('✗')} ${e.message}`);
  if (process.env.VDM_DEBUG) console.error(e.stack);
  process.exitCode = 1;
});
