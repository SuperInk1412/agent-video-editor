// VedioMaker renderer main: state, playback, selection, wiring.
import { Preview } from './preview.js';
import { PathGizmo } from './pathgizmo.js';
import { Timeline, escapeHtml } from './timeline.js';
import { Inspector } from './inspector.js';
import { AgentPanel } from './ai.js';
import { PipelinePanel } from './pipeline.js';
import { LogPanel } from './logs.js';
import { evalCamera } from '/core/camera.js';

const $ = (s) => document.querySelector(s);
const S = {
  project: null,
  time: 0,
  playing: false,
  selection: { segmentId: null, elementId: null },
  media: [],
  blender: null,
  agentAvailable: false,
  pipeline: null,
  render: null,
  renderScale: 0.5,
  dpr: Math.min(2, window.devicePixelRatio || 1),
  editMode: false,
  editCam: null,
  lookMode: false,
  grid: true,
  keys: new Set(),
};

let preview, timeline, inspector, agentPanel, pipelinePanel, logPanel, gizmo;

// ---- error reporting: everything lands in .vdm/logs and the 日志 panel ----
const reportedErrors = new Set();
function reportError(where, err) {
  const msg = String(err?.message || err || 'unknown error');
  const stack = err?.stack ? String(err.stack).slice(0, 2000) : '';
  fetch('/api/log', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'error', source: 'renderer', msg: `${where}: ${msg}`, stack, url: location.href }),
  }).catch(() => {});
  if (!reportedErrors.has(msg)) {
    reportedErrors.add(msg);
    toast(`${where}: ${msg.slice(0, 140)}`, 'error');
  }
}
window.addEventListener('error', (e) => reportError('window.onerror', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('unhandledrejection', e.reason));

// ---------------------------------------------------------------- helpers
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
}

async function op(...ops) {
  try {
    const j = await post('/api/ops', { ops });
    if (j.project) applyProject(j.project, 'local');
    return j;
  } catch (e) {
    toast(`操作失败: ${e.message}`, 'error');
    return null;
  }
}

let toastTimer = [];
function toast(msg, level = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${level}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  toastTimer.push(setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, level === 'error' ? 5200 : 2600));
  if (toastTimer.length > 8) toastTimer.shift();
}

let worldTimer = null;
let worldKey = '';
function syncWorld(p) {
  if (!p.camera) return;
  const key = JSON.stringify(p.world || {});
  if (key === worldKey) return;
  clearTimeout(worldTimer);
  worldTimer = setTimeout(async () => {
    try {
      const j = await fetch('/api/world').then((r) => r.json());
      if (j.city) { worldKey = key; preview.setCity(j.city); }
    } catch (e) { /* logged by the server when it fails */ }
  }, 250);
}

function applyProject(p, source) {
  S.project = p;
  syncWorld(p);
  if (S.selection.elementId && !p.elements.find((e) => e.id === S.selection.elementId)) S.selection.elementId = null;
  if (S.selection.segmentId && !p.segments.find((s) => s.id === S.selection.segmentId)) S.selection.segmentId = null;
  preview.setProject(p);
  timeline.setProject(p);
  timeline.setSelection(S.selection);
  inspector.render(p, S.selection, S.time);
  renderShots();
  $('#projTitle').textContent = p.meta.title;
  $('#projMeta').textContent = `${p.meta.width}×${p.meta.height} · ${p.meta.fps}fps · ${p.meta.duration.toFixed(1)}s · rev ${p.rev}`;
  const editBtn = $('#btnEditMode');
  if (editBtn) editBtn.hidden = !p.camera;
  if (!p.camera && S.editMode) setEditMode(false);
  updateOverlay();
}

// ---------------------------------------------------------------- time
function setTime(t, { seekAudio = true } = {}) {
  const dur = S.project?.meta.duration || 12;
  S.time = Math.max(0, Math.min(dur, t));
  timeline?.setTime(S.time);
  $('#timecode').textContent = `${S.time.toFixed(2)}s`;
  $('#stageTime').textContent = `${S.time.toFixed(2)} / ${dur.toFixed(2)}s`;
  if (seekAudio && S.playing) preview.setAudioTime(S.time);
  if (!S.playing) inspector.render(S.project, S.selection, S.time);
}

function play() {
  if (!S.project) return;
  if (S.time >= S.project.meta.duration - 0.02) S.time = 0;
  S.playing = true;
  S.playWall = performance.now();
  S.playFrom = S.time;
  preview.playing = true;
  preview.playAudio(S.time);
  $('#btnPlay').textContent = '⏸';
  $('#btnPlay').classList.add('on');
}

function pause() {
  S.playing = false;
  preview.playing = false;
  preview.pauseAudio();
  $('#btnPlay').textContent = '▶';
  $('#btnPlay').classList.remove('on');
}

function togglePlay() { S.playing ? pause() : play(); }

// ---------------------------------------------------------------- selection
function select(sel) {
  if (sel.camera) {
    S.selection = { segmentId: null, elementId: null, camera: true };
  } else {
    S.selection = {
      segmentId: sel.segmentId ?? S.selection.segmentId,
      elementId: sel.elementId ?? null,
      camera: false,
    };
    if (sel.elementId) {
      const el = S.project.elements.find((e) => e.id === sel.elementId);
      if (el?.segment) S.selection.segmentId = el.segment;
    }
  }
  timeline.setSelection(S.selection);
  inspector.render(S.project, S.selection, S.time);
  renderShots();
  updateOverlay();
}

function updateOverlay() {
  const box = $('#selBox');
  if (!box || !preview || !S.project) return;
  const rects = preview.layerRects();
  const r = rects.find((x) => x.id === S.selection.elementId);
  if (!r) { box.style.display = 'none'; return; }
  const scale = $('#stage').clientWidth / preview.canvas.width;
  box.style.display = 'block';
  box.style.left = `${r.x * scale}px`;
  box.style.top = `${r.y * scale}px`;
  box.style.width = `${r.w * scale}px`;
  box.style.height = `${r.h * scale}px`;
  const el = S.project.elements.find((e) => e.id === r.id);
  box.dataset.label = `${el?.name || r.id}`;
}

function fitStage() {
  if (!preview || !S.project) return;
  const wrap = $('#stageWrap');
  const box = $('#stageBox');
  const availW = Math.max(120, wrap.clientWidth - 28);
  const availH = Math.max(80, wrap.clientHeight - 28);
  const ar = (S.project.meta.width || 16) / (S.project.meta.height || 9);
  let w = availW, h = w / ar;
  if (h > availH) { h = availH; w = h * ar; }
  box.style.width = `${Math.round(w)}px`;
  box.style.height = `${Math.round(h)}px`;
  preview.resize(w, h);
  gizmo?.resize();
  preview.render(S.time);
  gizmo?.draw();
  updateOverlay();
}

// ---------------------------------------------------------------- 3D viewport
const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));
const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3len = (a) => Math.hypot(a[0], a[1], a[2]);
const v3norm = (a) => { const l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function setEditMode(on) {
  const btn = $('#btnEditMode');
  if (on && !S.project?.camera) { toast('这个项目没有相机'); return; }
  S.editMode = !!on;
  preview.editMode = S.editMode;
  if (S.editMode) {
    const c = evalCamera(S.project, S.time);
    S.editCam = { pos: c.pos.slice(), look: c.look.slice(), roll: c.roll || 0, fov: c.fov };
    preview.editCam = S.editCam;
  } else {
    S.editCam = null;
    preview.editCam = null;
    if (S.lookMode) toggleLookMode(false);
  }
  if (btn) {
    btn.classList.toggle('on', S.editMode);
    btn.textContent = S.editMode ? '镜头视角' : '编辑视口';
  }
  preview.render(S.time);
  gizmo?.draw();
}

function toggleLookMode(on) {
  if (on === undefined) on = !S.lookMode;
  if (on && !S.editMode) { toast('先按 Tab 进编辑视口，再用 Alt 环视'); return; }
  S.lookMode = on;
  document.body.classList.toggle('look-mode', on);
}

function orbitEdit(dx, dy) {
  const cam = S.editCam;
  if (!cam) return;
  const target = cam.look.slice();
  const v = v3sub(cam.pos, target);
  const dist = v3len(v) || 1;
  let yaw = Math.atan2(v[0], v[2]);
  let pitch = Math.asin(clampNum(v[1] / dist, -1, 1));
  yaw -= dx * 0.006;
  pitch = clampNum(pitch + dy * 0.006, -1.45, 1.45);
  const cp = Math.cos(pitch);
  cam.pos = [
    target[0] + Math.sin(yaw) * cp * dist,
    target[1] + Math.sin(pitch) * dist,
    target[2] + Math.cos(yaw) * cp * dist,
  ];
}

function flyEdit(dt) {
  const cam = S.editCam;
  if (!cam || !S.editMode || S.lookMode) return;
  const k = S.keys;
  const boost = k.has('ShiftLeft') || k.has('ShiftRight');
  const speed = (boost ? 180 : 45) * dt;
  const f = v3norm(v3sub(cam.look, cam.pos));
  const r = v3norm(v3cross(f, [0, 1, 0]));
  const up = [0, 1, 0];
  const m = [0, 0, 0];
  const add = (v, s) => { m[0] += v[0] * s; m[1] += v[1] * s; m[2] += v[2] * s; };
  if (k.has('KeyW')) add(f, 1);
  if (k.has('KeyS')) add(f, -1);
  if (k.has('KeyD')) add(r, 1);
  if (k.has('KeyA')) add(r, -1);
  if (k.has('KeyE')) add(up, 1);
  if (k.has('KeyQ')) add(up, -1);
  const l = v3len(m);
  if (l < 1e-6) return;
  const step = m.map((v) => (v / l) * speed);
  cam.pos = cam.pos.map((v, i) => v + step[i]);
  cam.look = cam.look.map((v, i) => v + step[i]);
}

function dollyEdit(factor) {
  const cam = S.editCam;
  if (!cam) return;
  const d = v3sub(cam.pos, cam.look).map((v) => v * factor);
  cam.pos = cam.look.map((v, i) => v + d[i]);
}

function commitCameraPath() {
  if (S.project?.camera) op({ op: 'cameraPath', path: S.project.camera.path });
}

// ---------------------------------------------------------------- panels
function renderShots() {
  const root = $('#panelShots');
  if (!root || !S.project) return;
  root.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'panel-head';
  head.innerHTML = `<div class="panel-title">分镜 <span class="dim">${S.project.segments.length}</span></div>`;
  const add = document.createElement('button');
  add.className = 'mini';
  add.textContent = '+ 分镜';
  add.onclick = () => {
    const t = Math.round(S.time * 100) / 100;
    const dur = Math.min(4, Math.max(0.5, S.project.meta.duration - t));
    op({ op: 'addSegment', segment: { start: t, duration: dur, name: `镜 ${S.project.segments.length + 1}` } });
  };
  head.appendChild(add);
  root.appendChild(head);

  const list = document.createElement('div');
  list.className = 'seg-list';
  for (const s of S.project.segments) {
    const n = S.project.elements.filter((e) => e.segment === s.id).length;
    const row = document.createElement('div');
    row.className = `seg-item ${S.selection.segmentId === s.id ? 'on' : ''}`;
    row.innerHTML = `
      <div class="seg-top"><span class="seg-name">${escapeHtml(s.name)}</span><span class="seg-status st-${s.status}">${s.status}</span></div>
      <div class="seg-sub"><span>${s.start.toFixed(2)}–${(s.start + s.duration).toFixed(2)}s</span><span>${n} 元素</span></div>
      <div class="seg-intent">${escapeHtml(s.intent || '')}</div>`;
    row.onclick = () => { S.selection = { segmentId: s.id, elementId: null }; timeline.setSelection(S.selection); setTime(s.start); inspector.render(S.project, S.selection, S.time); renderShots(); updateOverlay(); };
    const btns = document.createElement('div');
    btns.className = 'seg-btns';
    const b1 = document.createElement('button'); b1.className = 'mini'; b1.textContent = '预览帧';
    b1.onclick = async (e) => { e.stopPropagation(); await post('/api/still', { time: s.start + s.duration / 2, scale: 0.5 }); };
    const b2 = document.createElement('button'); b2.className = 'mini'; b2.textContent = '出片';
    b2.onclick = async (e) => { e.stopPropagation(); await post('/api/render', { from: s.start, to: s.start + s.duration, scale: S.renderScale }); toast('开始渲染本段'); };
    btns.append(b1, b2);
    row.appendChild(btns);
    list.appendChild(row);
  }
  root.appendChild(list);
}

async function renderMedia() {
  const root = $('#panelMedia');
  if (!root) return;
  const j = await fetch('/api/media').then((r) => r.json()).catch(() => ({ media: [] }));
  S.media = j.media || [];
  root.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'panel-head';
  head.innerHTML = `<div class="panel-title">媒体 <span class="dim">${S.media.length}</span></div>`;
  const imp = document.createElement('button'); imp.className = 'mini'; imp.textContent = '导入';
  const file = document.createElement('input'); file.type = 'file'; file.multiple = true; file.style.display = 'none';
  imp.onclick = () => file.click();
  file.onchange = async () => {
    for (const f of file.files) {
      await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    }
    toast('素材已导入');
    renderMedia();
  };
  head.append(imp, file);
  root.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'media-grid';
  for (const m of S.media) {
    const isVid = /\.(mp4|webm|mov)$/i.test(m.path);
    const isImg = /\.(png|jpe?g|webp|gif)$/i.test(m.path);
    const card = document.createElement('div');
    card.className = 'media-card';
    card.innerHTML = isImg
      ? `<img src="/${m.path}" loading="lazy">`
      : `<div class="fileicon">${isVid ? '▶' : '♪'}</div>`;
    const cap = document.createElement('div');
    cap.className = 'media-cap';
    cap.textContent = m.name;
    card.appendChild(cap);
    card.onclick = () => addMediaAt(m, isVid);
    grid.appendChild(card);
  }
  root.appendChild(grid);
}

function addMediaAt(m, isVid) {
  const seg = S.project.segments.find((s) => S.time >= s.start && S.time < s.start + s.duration);
  const start = Math.round(S.time * 100) / 100;
  const dur = Math.min(4, Math.max(1, S.project.meta.duration - start));
  op({
    op: 'addElement',
    element: {
      type: isVid ? 'video' : 'image', src: m.path, start, duration: dur,
      segment: seg?.id || null, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      style: { fit: 'cover' }, motion: { type: 'in', amount: 0.08 },
      fadeIn: 0.2, fadeOut: 0.2,
    },
  }).then((j) => { if (j?.changed?.[0]) select({ elementId: j.changed[0] }); });
}

function switchRightTab(name) {
  document.querySelectorAll('[data-tabs="right"] button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('#panelInsp').hidden = name !== 'insp';
  $('#panelAI').hidden = name !== 'ai';
  $('#panelPipe').hidden = name !== 'pipe';
  $('#panelLogs').hidden = name !== 'logs';
  if (name === 'logs') logPanel?.refresh(true);
}
function switchLeftTab(name) {
  document.querySelectorAll('[data-tabs="left"] button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('#panelShots').hidden = name !== 'shots';
  $('#panelMedia').hidden = name !== 'media';
  if (name === 'media') renderMedia();
}

// ---------------------------------------------------------------- boot
async function boot() {
  const state = await fetch('/api/state').then((r) => r.json());
  S.project = state.project;
  S.pipeline = state.pipeline;
  S.render = state.render;
  S.agentAvailable = state.agent.available;
  S.blender = state.blender;

  const canvas = $('#stage');
  preview = new Preview(canvas);
  preview.setProject(S.project);
  preview.playing = false;
  gizmo = new PathGizmo($('#gizmo'), {
    project: () => S.project,
    time: () => S.time,
    editMode: () => S.editMode,
    grid: () => S.grid,
    visible: () => S.editMode || !!S.selection.camera,
    projectPoint: (p) => preview.scene3d.projectPoint(p),
    stage: () => canvas,
  });
  gizmo.resize();

  timeline = new Timeline($('#timeline'), {
    onSeek: (t) => { setTime(t); if (S.playing) { S.playFrom = t; S.playWall = performance.now(); preview.setAudioTime(t); } },
    onSelect: (sel) => select(sel),
    onSegment: (id) => { S.selection = { segmentId: id, elementId: null }; renderShots(); inspector.render(S.project, S.selection, S.time); },
    onOp: (o) => op(o),
  });
  timeline.setProject(S.project);

  inspector = new Inspector($('#panelInsp'), {
    onOp: (o) => op(o),
    getTime: () => S.time,
    getTimeValue: (path) => {
      const el = S.project.elements.find((e) => e.id === S.selection.elementId);
      if (!el) return 0;
      const [a, b] = path.split('.');
      if (a === 'transform') return el.transform?.[b] ?? 0;
      if (a === 'style') return el.style?.[b] ?? 0;
      if (a === 'fx') return el.fx?.[b] ?? 0;
      return 0;
    },
    onSelect: (sel) => select(sel),
    analyzeBeats: async () => {
      toast('分析节拍中…');
      try { const j = await post('/api/beats', {}); toast(`${j.tempo} bpm · ${j.beats.length} 拍`, 'success'); } catch (e) { toast(e.message, 'error'); }
    },
    onRenderAll: async () => {
      try { await post('/api/render', { from: 0, to: S.project.meta.duration, scale: S.renderScale }); toast('开始渲染镜头'); } catch (e) { toast(e.message, 'error'); }
    },
    onRenderSegment: (id) => {
      const s = S.project.segments.find((x) => x.id === id);
      if (s) post('/api/render', { from: s.start, to: s.start + s.duration, scale: S.renderScale }).then(() => toast('开始渲染')).catch((e) => toast(e.message, 'error'));
    },
    onAskAI: (id) => {
      S.selection = { segmentId: id, elementId: null };
      switchRightTab('ai');
      switchLeftTab('shots');
      toast('在右侧写下让 AI 改什么');
    },
  });

  agentPanel = new AgentPanel($('#panelAI'), {
    getProject: () => S.project,
    getSelection: () => S.selection,
    getTime: () => S.time,
    captureAt: (t) => { preview.render(t); const d = preview.capture(); preview.render(S.time); return d; },
    toast,
  });
  agentPanel.setState({ available: S.agentAvailable, running: false });

  logPanel = new LogPanel($('#panelLogs'), { toast });

  pipelinePanel = new PipelinePanel($('#panelPipe'), {
    getProject: () => S.project,
    getSelection: () => S.selection,
    getTime: () => S.time,
    getRenderScale: () => S.renderScale,
    toast,
  });
  pipelinePanel.set(state);

  // tabs
  document.querySelectorAll('[data-tabs="left"] button').forEach((b) => b.onclick = () => switchLeftTab(b.dataset.tab));
  document.querySelectorAll('[data-tabs="right"] button').forEach((b) => b.onclick = () => switchRightTab(b.dataset.tab));

  // transport
  $('#btnPlay').onclick = togglePlay;
  $('#btnPrev').onclick = () => { setTime(S.time - 1 / (S.project.meta.fps || 24)); if (S.playing) { S.playFrom = S.time; S.playWall = performance.now(); } };
  $('#btnNext').onclick = () => { setTime(S.time + 1 / (S.project.meta.fps || 24)); if (S.playing) { S.playFrom = S.time; S.playWall = performance.now(); } };
  $('#btnUndo').onclick = async () => { try { const j = await post('/api/undo', {}); applyProject(j.project, 'undo'); } catch (e) { toast('没有可撤销的操作'); } };
  $('#btnRedo').onclick = async () => { try { const j = await post('/api/redo', {}); applyProject(j.project, 'redo'); } catch (e) { toast('没有可重做的操作'); } };
  $('#btnStill').onclick = async () => {
    toast(`Blender 渲染 ${S.time.toFixed(2)}s …`);
    try { const j = await post('/api/still', { time: S.time, scale: 1 }); toast('预览帧完成', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  $('#btnRender').onclick = async () => {
    try { await post('/api/render', { from: 0, to: S.project.meta.duration, scale: S.renderScale }); toast('开始渲染成片'); } catch (e) { toast(e.message, 'error'); }
  };
  $('#renderScale').onchange = (e) => { S.renderScale = Number(e.target.value); };
  $('#btnEditMode').onclick = () => setEditMode(!S.editMode);

  // ---------- 3D viewport: path nodes, handles, orbit, look ----------
  const stageXY = (e) => {
    const r = canvas.getBoundingClientRect();
    const kx = canvas.width / Math.max(1, r.width);
    const ky = canvas.height / Math.max(1, r.height);
    return { sx: (e.clientX - r.left) * kx, sy: (e.clientY - r.top) * ky, cx: e.clientX, cy: e.clientY };
  };
  let drag = null;
  const selectAt = (sx, sy) => {
    const id = preview.hitTest(sx, sy, S.time);
    if (id) return select({ elementId: id });
    const seg = S.project.segments.find((s) => S.time >= s.start && S.time < s.start + s.duration);
    if (seg) return select({ elementId: null, segmentId: seg.id });
    if (S.project.camera) return select({ camera: true });
    select({ elementId: null, segmentId: null });
  };

  canvas.addEventListener('contextmenu', (e) => {
    if (S.editMode || S.selection.camera) e.preventDefault();
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const { sx, sy, cx, cy } = stageXY(e);
    if (S.editMode && S.lookMode) {
      drag = { kind: 'look', button: e.button, x: cx, y: cy };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      e.preventDefault();
      return;
    }
    const canEditPath = S.editMode || !!S.selection.camera;
    const hit = canEditPath ? gizmo?.hit(sx, sy) : null;
    if (hit) {
      gizmo.sel = hit.index;
      const key = S.project.camera?.path?.[hit.index];
      const ac = preview.scene3d.lastCam;
      const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
      drag = { kind: hit.kind, index: hit.index, normal, x: cx, y: cy, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      if (hit.kind === 'node' && key) setTime(key.t);
      gizmo.draw();
      e.preventDefault();
      return;
    }
    if (S.editMode) {
      drag = { kind: 'orbit', x: cx, y: cy, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      e.preventDefault();
      return;
    }
    selectAt(sx, sy);
  });

  canvas.addEventListener('pointermove', (e) => {
    const { sx, sy, cx, cy } = stageXY(e);
    if (!drag) {
      const canEditPath = S.editMode || !!S.selection.camera;
      const hit = canEditPath ? gizmo?.hit(sx, sy) : null;
      canvas.style.cursor = hit ? 'pointer' : (S.editMode ? 'grab' : 'default');
      return;
    }
    if (drag.kind === 'look') {
      const dx = cx - drag.x, dy = cy - drag.y;
      drag.x = cx; drag.y = cy;
      if (S.editCam) {
        if (drag.button === 2) S.editCam.roll = clampNum(S.editCam.roll + dx * 0.25, -180, 180);
        else S.editCam.fov = clampNum(S.editCam.fov + dy * 0.2, 1, 360);
        preview.render(S.time);
        gizmo.draw();
      }
      return;
    }
    if (drag.kind === 'orbit') {
      const dx = cx - drag.x, dy = cy - drag.y;
      drag.x = cx; drag.y = cy;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      orbitEdit(dx, dy);
      preview.render(S.time);
      gizmo.draw();
      return;
    }
    const key = S.project.camera?.path?.[drag.index];
    if (!key) return;
    const w = preview.scene3d.planeHit(sx, sy, key.pos, drag.normal);
    if (!w) return;
    const r2 = (v) => Math.round(v * 100) / 100;
    if (drag.kind === 'node') key.pos = w.map(r2);
    else key[drag.kind] = [w[0] - key.pos[0], w[1] - key.pos[1], w[2] - key.pos[2]].map(r2);
    drag.moved = true;
    preview.render(S.time);
    gizmo.draw();
  });

  const endDrag = (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === 'node' || d.kind === 'out' || d.kind === 'in') {
      if (d.moved) commitCameraPath();
      gizmo.draw();
    } else if (d.kind === 'orbit' && !d.moved) {
      const { sx, sy } = stageXY(e);
      selectAt(sx, sy);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { drag = null; });

  // double-click a handle to drop it back to the automatic Catmull tangent
  canvas.addEventListener('dblclick', (e) => {
    const canEditPath = S.editMode || !!S.selection.camera;
    if (!canEditPath) return;
    const { sx, sy } = stageXY(e);
    const hit = gizmo?.hit(sx, sy);
    if (!hit || (hit.kind !== 'out' && hit.kind !== 'in')) return;
    const key = S.project.camera?.path?.[hit.index];
    if (!key) return;
    key[hit.kind] = null;
    commitCameraPath();
    gizmo.draw();
  });

  canvas.addEventListener('wheel', (e) => {
    if (!S.editMode) return;
    e.preventDefault();
    dollyEdit(Math.exp(e.deltaY * 0.0012));
    preview.render(S.time);
    gizmo.draw();
  }, { passive: false });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    S.keys.add(e.code);
    if (e.key === 'Tab') { e.preventDefault(); setEditMode(!S.editMode); return; }
    if (e.key === 'Alt' && !e.repeat) { e.preventDefault(); toggleLookMode(); return; }
    if (e.key === 'Escape') {
      if (S.lookMode) { toggleLookMode(false); return; }
      if (S.editMode) { setEditMode(false); return; }
    }
    if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey) { S.grid = !S.grid; gizmo?.draw(); return; }
    const dur = S.project?.meta.duration || 12;
    const frame = 1 / (S.project?.meta.fps || 24);
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); setTime(S.time - (e.shiftKey ? 1 : frame)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); setTime(S.time + (e.shiftKey ? 1 : frame)); }
    else if (e.key === 'Home') { pause(); setTime(0); }
    else if (e.key === 'End') { pause(); setTime(dur); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (S.selection.elementId) { e.preventDefault(); op({ op: 'removeElement', id: S.selection.elementId }); S.selection.elementId = null; }
    } else if (e.key === 's' && !e.ctrlKey) {
      if (S.selection.elementId) { e.preventDefault(); op({ op: 'splitElement', id: S.selection.elementId, at: Math.round(S.time * 1000) / 1000 }); }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) $('#btnRedo').click(); else $('#btnUndo').click();
    }
  });

  window.addEventListener('keyup', (e) => S.keys.delete(e.code));
  window.addEventListener('blur', () => S.keys.clear());

  // events
  const es = new EventSource('/api/events');
  es.addEventListener('project', (e) => {
    const d = JSON.parse(e.data);
    applyProject(d.project, d.source);
  });
  es.addEventListener('render', (e) => {
    const d = JSON.parse(e.data);
    S.render = d;
    pipelinePanel.setRender(d);
    $('#renderBadge').hidden = !d.running;
    if (d.running) $('#renderBadge').textContent = `渲染 ${d.progress}/${d.total}`;
    if (d.done) { toast('渲染完成', 'success'); $('#renderBadge').hidden = true; }
    if (d.error) { toast(`渲染失败: ${d.error}`, 'error'); $('#renderBadge').hidden = true; }
  });
  es.addEventListener('agent', (e) => agentPanel.handleEvent(JSON.parse(e.data)));
  es.addEventListener('pipeline', (e) => { S.pipeline = JSON.parse(e.data); pipelinePanel.set({ pipeline: S.pipeline, render: S.render }); });
  es.addEventListener('toast', (e) => { const d = JSON.parse(e.data); toast(d.message, d.level); });
  es.addEventListener('beats', () => toast('节拍已更新', 'success'));
  es.addEventListener('log', (e) => { try { logPanel.append(JSON.parse(e.data)); } catch { /* ignore */ } });

  // resize
  const ro = new ResizeObserver(() => fitStage());
  ro.observe($('#stageWrap'));
  applyProject(S.project, 'boot');
  fitStage();
  setTime(0);

  // playback loop
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (S.playing) {
      const t = S.playFrom + (now - S.playWall) / 1000;
      if (t >= (S.project?.meta.duration || 12)) { setTime(S.project.meta.duration); pause(); }
      else { S.time = t; timeline.setTime(t); $('#timecode').textContent = `${t.toFixed(2)}s`; $('#stageTime').textContent = `${t.toFixed(2)} / ${S.project.meta.duration.toFixed(2)}s`; }
    }
    if (S.project) {
      if (S.editMode) flyEdit(dt);
      preview.render(S.time);
      gizmo?.draw();
      updateOverlay();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__vdm = {
    S, preview, timeline, inspector, gizmo, op, toast,
    setTime: (t) => setTime(t),
    select: (s) => select(s),
    setEditMode: (on) => setEditMode(on),
    pause: () => pause(),
    play: () => play(),
  };
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f66;padding:24px">启动失败: ${e.message}\n${e.stack}</pre>`;
});
