// VedioMaker renderer main: state, playback, selection, wiring.
import { Preview } from './preview.js';
import { PathGizmo } from './pathgizmo.js';
import { Timeline } from './timeline.js';
import { CurvePanel, curvePathLabel } from './curvepanel.js';
import { Inspector } from './inspector.js';
import { AgentPanel } from './ai.js';
import { PipelinePanel } from './pipeline.js';
import { LogPanel } from './logs.js';
import { ProjectsPanel } from './projects.js';
import { evalCamera, pathPos, cameraTransform } from '/core/camera.js';
import { curveSegments } from '/core/curves.js';
import { objectPose } from '/core/scene.js';
import { sampleTrack } from '/core/time.js';
import {
  emptySelection, normalizeSelection, selectOne, cameraRef, objectRef, elementRef, splitRef,
  keyframeExists, keyframeDeleteOps,
} from '/core/selection.js';

const $ = (s) => document.querySelector(s);
const S = {
  project: null,
  time: 0,
  playing: false,
  selection: { segmentId: null, elementId: null, objectId: null, camera: false, pool: emptySelection() },
  media: [],
  blender: null,
  agentAvailable: false,
  pipeline: null,
  render: null,
  renderScale: 0.5,
  dpr: Math.min(2, window.devicePixelRatio || 1),
  editMode: false,
  editCam: null,
  viewMode: 'select',
  grid: true,
  keys: new Set(),
  soloCameras: new Set(),
  clipboard: null,
};

let preview, timeline, inspector, agentPanel, pipelinePanel, logPanel, gizmo, projects, curvePanel;

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

// Ops are serialized: two quick edits (e.g. a camera dropdown and a field
// blur) must not race the atomic save. Concurrent POSTs otherwise clone the
// same base project and can lose one edit (or hit a Windows rename EPERM).
let opChain = Promise.resolve();
function op(...ops) {
  const run = async () => {
    try {
      const j = await post('/api/ops', { ops });
      if (j.project) applyProject(j.project, 'local');
      return j;
    } catch (e) {
      toast(`操作失败: ${e.message}`, 'error');
      return null;
    }
  };
  const p = opChain.then(run, run);
  opChain = p.catch(() => {});
  return p;
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

// ---------------------------------------------------------------- context menu
function hideContextMenu() {
  const m = $('#ctxMenu');
  if (m) m.hidden = true;
}

function showContextMenu(x, y, items) {
  const m = $('#ctxMenu');
  if (!m || !items?.length) return;
  m.innerHTML = '';
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement('div');
      d.className = 'ctx-sep';
      m.appendChild(d);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    if (it.disabled) {
      b.disabled = true;
      b.title = it.title || '';
    }
    b.onclick = () => {
      if (it.disabled) return;
      hideContextMenu();
      it.run?.();
    };
    m.appendChild(b);
  }
  m.hidden = false;
  m.style.left = '0px';
  m.style.top = '0px';
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 8))}px`;
}

window.addEventListener('pointerdown', (e) => {
  const m = $('#ctxMenu');
  if (m && !m.hidden && !m.contains(e.target)) hideContextMenu();
}, true);

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
  // JSON responses cannot preserve the server-side `camera` alias identity;
  // re-point it at the active stack entry so edits and reads share one object.
  if (p?.activeCameraId) p.camera = (p.cameras || []).find((c) => c.id === p.activeCameraId) || p.camera;
  syncWorld(p);
  if (S.selection.elementId && !p.elements.find((e) => e.id === S.selection.elementId)) S.selection.elementId = null;
  if (S.selection.segmentId && !p.segments.find((s) => s.id === S.selection.segmentId)) S.selection.segmentId = null;
  if (S.selection.objectId && !(p.scene?.objects || []).some((o) => o.id === S.selection.objectId)) S.selection.objectId = null;
  if (S.selection.pool) {
    const camIds = new Set((p.cameras || []).map((c) => c.id));
    const objIds = new Set((p.scene?.objects || []).map((o) => o.id));
    const elIds = new Set((p.elements || []).map((e) => e.id));
    const keyPool = S.selection.pool.kind === 'keyframe';
    const ids = S.selection.pool.ids.filter((ref) => {
      // keyframes also disappear when the key itself is deleted elsewhere
      if (keyPool) return keyframeExists(p, ref);
      const s = splitRef(ref);
      if (!s) return false;
      if (s.type === 'cam') return camIds.has(s.id);
      if (s.type === 'ob') return objIds.has(s.id);
      return elIds.has(s.id);
    });
    S.selection.pool = normalizeSelection({ ...S.selection.pool, ids });
  }
  if (gizmo) gizmo.objSel = S.selection.objectId || null;
  preview.setProject(p);
  if (S.soloCameras) {
    const ids = new Set((p.cameras || []).map((c) => c.id));
    for (const id of [...S.soloCameras]) if (!ids.has(id)) S.soloCameras.delete(id);
    preview.setSoloCameras(S.soloCameras);
  }
  timeline.setProject(p);
  timeline.setSoloCameras(S.soloCameras || new Set());
  timeline.setSelection(S.selection);
  inspector.render(p, S.selection, S.time);
  curvePanel?.setProject(p);
  $('#projTitle').textContent = p.meta.title;
  $('#projMeta').textContent = `${p.meta.width}×${p.meta.height} · ${p.meta.fps}fps · ${p.meta.duration.toFixed(1)}s · rev ${p.rev}`;
  const editBtn = $('#btnEditMode');
  if (editBtn) editBtn.hidden = !p.camera;
  const addBtn = $('#btnAddElement');
  if (addBtn) addBtn.hidden = !p.world || !p.camera;
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
function select(sel = {}) {
  let next;
  if (sel.camera) {
    next = { segmentId: null, elementId: null, objectId: null, camera: true };
  } else if (sel.objectId) {
    next = { segmentId: null, elementId: null, objectId: sel.objectId, camera: false };
  } else {
    next = {
      segmentId: sel.segmentId ?? S.selection.segmentId,
      elementId: sel.elementId ?? null,
      objectId: sel.objectId ?? null,
      camera: false,
    };
    if (sel.elementId) {
      const el = S.project.elements.find((e) => e.id === sel.elementId);
      if (el?.segment) next.segmentId = el.segment;
    }
  }
  let pool;
  if (sel.pool) pool = normalizeSelection(sel.pool);
  else if (sel.camera && S.project?.camera) pool = selectOne('element', cameraRef(S.project.camera.id));
  else if (sel.objectId) pool = selectOne('element', objectRef(sel.objectId));
  else if (sel.elementId) pool = selectOne('element', elementRef(sel.elementId));
  else pool = emptySelection();
  S.selection = { ...next, pool };
  if (gizmo) {
    gizmo.objSel = S.selection.objectId || null;
    gizmo.objHover = null;
    gizmo.axisHover = null;
    gizmo.draw();
  }
  timeline.setSelection(S.selection);
  inspector.render(S.project, S.selection, S.time);
  updateOverlay();
}

// ---------------------------------------------------------------- value curve

/** Every keyed property of a host that has at least two keys, as panel tracks. */
function curveTracksFor(host, id) {
  const tracks = [];
  if (host === 'element') {
    const el = S.project.elements.find((e) => e.id === id);
    if (!el) return tracks;
    const byPath = new Map();
    for (const k of el.keyframes || []) {
      if (!byPath.has(k.path)) byPath.set(k.path, []);
      byPath.get(k.path).push(k);
    }
    for (const [path, keys] of byPath) {
      const segments = curveSegments(keys);
      if (segments.length) tracks.push({ path, label: curvePathLabel(path), segments });
    }
  } else {
    const obj = host === 'object'
      ? (S.project.scene?.objects || []).find((o) => o.id === id)
      : (S.project.cameras || []).find((c) => c.id === id);
    if (!obj) return tracks;
    if (host === 'camera' && Array.isArray(obj.path) && obj.path.length >= 2) {
      tracks.push({
        path: 'path',
        label: curvePathLabel('path'),
        segments: curveSegments(obj.path),
      });
    }
    for (const [path, keys] of Object.entries(obj.tracks || {})) {
      if (host === 'camera' && path === 'path') continue;
      const segments = curveSegments(keys);
      if (segments.length) tracks.push({ path, label: curvePathLabel(path), segments });
    }
  }
  return tracks.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Open the F2 curve drawer.
 * With a keyframe pool it edits exactly that property; otherwise it falls back
 * to the selected element/object/camera and picks its keyed property (the
 * header dropdown can switch between them).
 */
function openCurvePanel() {
  if (!curvePanel || !S.project) return;
  const pool = S.selection.pool;
  let host = null;
  let id = null;
  let wantedPath = null;
  let spanFrom = null;
  let spanTo = null;

  if (pool?.kind === 'keyframe' && pool.ids.length >= 2) {
    const parts = pool.ids.map((ref) => splitRef(ref));
    if (parts.every((p) => p && p.path && p.t != null)) {
      const first = parts[0];
      if (parts.every((p) => p.type === first.type && p.id === first.id && p.path === first.path)) {
        if (first.type === 'cam' && first.path === 'path') {
          const times = parts.map((p) => p.t).sort((a, b) => a - b);
          spanFrom = times[0];
          spanTo = times[times.length - 1];
          if (!(spanTo > spanFrom)) {
            toast('相机轨迹曲线需要选中两个不同时间的路径键', 'warn');
            return;
          }
        }
        host = first.type === 'cam' ? 'camera' : first.type === 'ob' ? 'object' : 'element';
        id = first.id;
        wantedPath = first.path;
      }
    }
  }
  if (!host) {
    // fall back to the current selection so F2 is never a silent no-op
    if (S.selection.camera && S.project.camera) { host = 'camera'; id = S.project.camera.id; }
    else if (S.selection.objectId) { host = 'object'; id = S.selection.objectId; }
    else if (S.selection.elementId) { host = 'element'; id = S.selection.elementId; }
  }
  if (!host || !id) {
    toast('先选中一个元素/物体/相机，或选中两个以上关键帧', 'warn');
    return;
  }
  const tracks = curveTracksFor(host, id);
  if (!tracks.length) {
    toast('这个对象还没有两个以上关键帧可以连成曲线', 'warn');
    return;
  }
  let index = tracks.findIndex((t) => t.path === wantedPath);
  if (index < 0 && host === 'camera') index = tracks.findIndex((t) => t.path === 'path');
  if (index < 0) index = 0;
  curvePanel.open({ host, id, tracks, index, spanFrom, spanTo });
}

function toggleCurvePanel() {
  if (!curvePanel) return;
  if (curvePanel.isOpen()) curvePanel.close();
  else openCurvePanel();
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
const v3add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3len = (a) => Math.hypot(a[0], a[1], a[2]);
const v3norm = (a) => { const l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Parameter along the line `p + a*s` closest to a screen ray (axis drags). */
function axisClosestS(ray, p, a) {
  if (!ray) return null;
  const d = ray.dir;
  const w = [ray.origin[0] - p[0], ray.origin[1] - p[1], ray.origin[2] - p[2]];
  const b = a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  const c = a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
  const e = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const tRay = (b * c - e) / denom;
  return c + b * tRay;
}

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
  }
  if (btn) {
    btn.classList.toggle('on', S.editMode);
    btn.textContent = S.editMode ? '镜头视角' : '编辑视口';
  }
  setViewMode('select');
  preview.render(S.time);
  gizmo?.draw();
}

/** Edit viewport modes: 'select' (pick / drag / context menu) or 'move' (camera). */
function setViewMode(mode) {
  S.viewMode = mode === 'move' ? 'move' : 'select';
  const badge = $('#viewMode');
  if (badge) {
    badge.hidden = !S.editMode;
    badge.textContent = S.viewMode === 'move' ? '移动相机 · Alt 切回选择' : '选择 · Alt 切到移动';
    badge.classList.toggle('move', S.viewMode === 'move');
  }
  document.body.classList.toggle('body-move', S.editMode && S.viewMode === 'move');
  const stage = $('#stage');
  if (stage) stage.style.cursor = S.editMode && S.viewMode === 'move' ? 'grab' : 'default';
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
  if (!cam || !S.editMode || S.viewMode !== 'move') return;
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
    const isAud = /\.(m4a|mp3|wav|flac|ogg|aac|opus)$/i.test(m.path);
    const isTrack = isAud && S.project.meta.audio?.src === m.path;
    const card = document.createElement('div');
    card.className = `media-card${isTrack ? ' on' : ''}`;
    card.title = isAud ? (isTrack ? '当前配乐' : '点击设为配乐（会重新分析节拍）') : (isImg || isVid ? '点击在播放头处加入时间线' : '不支持的素材类型');
    card.innerHTML = isImg
      ? `<img src="/${m.path}" loading="lazy">`
      : `<div class="fileicon">${isVid ? '▶' : isAud ? '♪' : '?'}</div>`;
    const cap = document.createElement('div');
    cap.className = 'media-cap';
    cap.textContent = isTrack ? `♪ 配乐 · ${m.name}` : m.name;
    card.appendChild(cap);
    card.onclick = () => {
      if (isAud) setSoundtrack(m);
      else if (isImg || isVid) addMediaAt(m, isVid);
      else toast('只能把图片和视频放进时间线', 'warn');
    };
    grid.appendChild(card);
  }
  root.appendChild(grid);
}

async function setSoundtrack(m) {
  if (S.project.meta.audio?.src === m.path) { toast('已经是当前配乐'); return; }
  const prev = S.project.meta.audio || {};
  const j = await op({ op: 'setMeta', path: 'audio', value: { src: m.path, offset: 0, gain: prev.gain || 0 } });
  if (!j) return;
  renderMedia();
  toast('已设为配乐，正在分析节拍…');
  try {
    const b = await post('/api/beats', {});
    toast(`配乐节拍 ${b.tempo} bpm · ${b.beats.length} 拍`, 'success');
  } catch (e) { toast(`节拍分析失败: ${e.message}`, 'error'); }
}

/** segment under time t, if any */
const segmentAt = (t) => S.project.segments.find((s) => t >= s.start && t < s.start + s.duration) || null;

/** latest start <= t at which `dur` seconds still fit inside the project */
const fitStart = (t, dur) => Math.round(Math.max(0, Math.min(t, S.project.meta.duration - dur)) * 1000) / 1000;

/** Text / colour block at the playhead, on top of everything, then select it. */
async function add2DElement(kind) {
  if (!S.project) return null;
  const len = Math.min(3, S.project.meta.duration);
  const start = fitStart(S.time, len);
  const base = {
    start, duration: len, segment: segmentAt(start)?.id || null,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, fadeIn: 0.2, fadeOut: 0.2,
  };
  const element = kind === 'text'
    ? { ...base, type: 'text', name: '文字', style: { text: '新文字', size: 120, color: '#ffffff', align: 'center' } }
    : { ...base, type: 'shape', name: '色块', style: { shape: 'rect', fill: '#ff2a4d', w: 640, h: 120, radius: 0 } };
  const j = await op({ op: 'addElement', element });
  const id = j?.changed?.[0];
  if (!id) return null;
  select({ elementId: id });
  switchRightTab('insp');
  if (kind === 'text') {
    const ta = $('#panelInsp textarea');
    if (ta) { ta.focus(); ta.select(); }
  }
  return id;
}

/** paste a copied element at the playhead; its animation travels with it */
function pasteElement(src) {
  const start = fitStart(S.time, src.duration);
  const dt = start - src.start;
  const el = JSON.parse(JSON.stringify(src));
  delete el.id;
  delete el.z;
  el.start = start;
  el.segment = segmentAt(start)?.id || null;
  el.keyframes = (el.keyframes || []).map((k) => ({ ...k, t: Math.round((k.t + dt) * 1000) / 1000 }));
  if (Array.isArray(el.motion?.span)) el.motion.span = el.motion.span.map((v) => Math.round((v + dt) * 1000) / 1000);
  return op({ op: 'addElement', element: el }).then((j) => {
    if (j?.changed?.[0]) select({ elementId: j.changed[0] });
    return j;
  });
}

function addMediaAt(m, isVid) {
  const dur = Math.min(4, S.project.meta.duration);
  const start = fitStart(S.time, dur);
  const seg = segmentAt(start);
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
    visible: () => S.editMode || !!S.selection.camera || !!S.selection.objectId,
    projectPoint: (p) => preview.scene3d.projectPoint(p),
    viewCam: () => preview.scene3d.lastCam,
    stage: () => canvas,
  });
  gizmo.resize();

  // Element actions live on the timeline header (⋯) now that the basics moved left.
  const duplicateObject = (o) => {
    const copy = JSON.parse(JSON.stringify(o));
    copy.id = `ob_${Date.now().toString(36)}`;
    copy.name = `${o.name || '元素'} 副本`;
    copy.pivot = [copy.pivot[0] + 10, copy.pivot[1], copy.pivot[2]];
    return op({ op: 'objectAdd', object: copy }).then((j) => {
      if (j) select({ objectId: copy.id });
      return copy.id;
    });
  };
  const elementMenu = (id, x, y) => {
    const o = (S.project.scene?.objects || []).find((ob) => ob.id === id);
    if (!o) return;
    const at = Math.round(S.time * 1000) / 1000;
    const pose = objectPose(o, S.time);
    const cam = (S.editMode && S.editCam) ? S.editCam : evalCamera(S.project, S.time);
    showContextMenu(x, y, [
      { label: '选中元素', run: () => select({ objectId: id }) },
      {
        label: '面向镜头（在播放头打方向键）',
        run: () => {
          const d = [cam.pos[0] - pose.worldPos[0], cam.pos[1] - pose.worldPos[1], cam.pos[2] - pose.worldPos[2]];
          const l = Math.hypot(d[0], d[1], d[2]) || 1;
          op({ op: 'objectKey', id, path: 'dir', t: at, v: d.map((v) => v / l) });
        },
      },
      {
        label: '落地（在播放头打位置键）',
        run: () => {
          const h = Number(o.geom?.h) || 2;
          op({ op: 'objectKey', id, path: 'pivot', t: at, v: [pose.pivot[0], h / 2, pose.pivot[2]] });
        },
      },
      { label: '复制（含关键帧）', run: () => { duplicateObject(o); } },
      { sep: true },
      {
        label: '删除元素', danger: true,
        run: () => { if (confirm(`删除 ${o.name || o.id}?`)) op({ op: 'objectRemove', id }); },
      },
    ]);
  };
  /** Split one media element at the playhead and keep the right half selected. */
  const splitElementAt = (id) => {
    const el = S.project?.elements?.find((e) => e.id === id);
    if (!el) return;
    const at = Math.round(S.time * 1000) / 1000;
    if (!(at > el.start + 0.02 && at < el.start + el.duration - 0.02)) {
      toast('播放头不在该素材范围内（或离两端太近）', 'warn');
      return;
    }
    return op({ op: 'splitElement', id, at }).then((j) => {
      if (!j) return;
      const right = (j.changed || []).find((x) => x && x !== id);
      if (right) select({ elementId: right });
      toast(`已在 ${at.toFixed(2)}s 切分 ${el.name || id}`, 'info');
    });
  };
  const clipMenu = (id, x, y) => {
    const el = S.project?.elements?.find((e) => e.id === id);
    if (!el) return;
    const at = Math.round(S.time * 1000) / 1000;
    const can = at > el.start + 0.02 && at < el.start + el.duration - 0.02;
    showContextMenu(x, y, [
      {
        label: can ? `在播放头切分（${at.toFixed(2)}s）` : '在播放头切分（播放头不在素材内）',
        disabled: !can,
        title: can ? '快捷键 S' : `素材范围 ${el.start.toFixed(2)}–${(el.start + el.duration).toFixed(2)}s`,
        run: () => { splitElementAt(id); },
      },
      { sep: true },
      { label: '选中素材', run: () => select({ elementId: id }) },
      {
        label: '复制（Ctrl+C）',
        run: () => {
          S.clipboard = JSON.parse(JSON.stringify(el));
          toast(`已复制 ${el.name || id}，Ctrl+V 粘贴到播放头`);
        },
      },
      {
        label: '删除素材',
        danger: true,
        run: () => {
          if (confirm(`删除 ${el.name || id}?`)) op({ op: 'removeElement', id });
        },
      },
    ]);
  };
  const cameraMenu = (id, x, y) => {
    const cam = (S.project.cameras || []).find((c) => c.id === id);
    if (!cam) return;
    const solo = S.soloCameras;
    const checked = solo.has(id);
    showContextMenu(x, y, [
      {
        label: checked ? '✓ 单独查看该相机（们）' : '单独查看该相机（们）',
        run: () => {
          if (checked) solo.delete(id); else solo.add(id);
          timeline.setSoloCameras(solo);
          preview.setSoloCameras(solo);
          preview.render(S.time);
        },
      },
      { label: '激活相机', run: () => { op({ op: 'activateCamera', id }); select({ camera: true }); } },
      { sep: true },
      {
        label: '删除相机', danger: true,
        run: () => { if (confirm(`删除 ${cam.name || id}?`)) op({ op: 'removeCamera', id }); },
      },
    ]);
  };

  timeline = new Timeline($('#timeline'), {
    onSeek: (t) => { setTime(t); if (S.playing) { S.playFrom = t; S.playWall = performance.now(); preview.setAudioTime(t); } },
    onSelect: (sel) => select(sel),
    onOp: (o) => op(o),
    onPause: () => pause(),
    onElementMenu: (id, x, y) => elementMenu(id, x, y),
    onCameraMenu: (id, x, y) => cameraMenu(id, x, y),
    onClipMenu: (id, x, y) => clipMenu(id, x, y),
  });
  timeline.setProject(S.project);

  curvePanel = new CurvePanel($('#timeline'), {
    getTimeline: () => timeline,
    getProject: () => S.project,
    onOp: (o) => op(o),
    toast,
    // Live path-curve drag: the panel temporarily mutates the in-memory camera
    // path; redraw the stage and timeline without a round-trip/rev bump.
    onLivePreview: () => {
      timeline.render(true);
      preview.render(S.time);
      gizmo?.draw();
    },
  });
  // keep the F2 drawer's x axis glued to the timeline while zooming/scrolling
  timeline.onViewChange = () => { if (curvePanel?.isOpen()) curvePanel.draw(); };

  inspector = new Inspector($('#panelInsp'), {
    onOp: (o) => op(o),
    getTime: () => S.time,
    // ◆ records what the property is at the playhead (its keyed value, or the base)
    getTimeValue: (path) => {
      const el = S.project.elements.find((e) => e.id === S.selection.elementId);
      if (!el) return 0;
      const [a, b] = path.split('.');
      const base = a === 'transform' ? el.transform?.[b] : a === 'style' ? el.style?.[b] : a === 'fx' ? el.fx?.[b] : undefined;
      return sampleTrack(el.keyframes, path, S.time, base ?? 0);
    },
    onSelect: (sel) => select(sel),
    onSeek: (t) => { pause(); setTime(t); },
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
      S.selection = { segmentId: id, elementId: null, objectId: null, camera: false, pool: emptySelection() };
      switchRightTab('ai');
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
  document.querySelectorAll('[data-tabs="right"] button').forEach((b) => b.onclick = () => switchRightTab(b.dataset.tab));
  // the left panel is media-only now: paint it once at boot
  renderMedia();

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

  // Add a 3D element in front of the editing camera, then select it so it can
  // be dragged (which keys its pivot at the playhead).
  const addSceneElement = async (primitive = 'box') => {
    if (!S.project) return null;
    if (!S.project.world) { toast('这个项目没有 3D 世界，先给它一个城市/背景', 'error'); return null; }
    if (primitive === 'pen') { toast('钢笔建模工具下一步接', 'warn'); return null; }
    if (!S.editMode) setEditMode(true);
    const c = S.editCam || evalCamera(S.project, S.time);
    const fwd = v3norm(v3sub(c.look, c.pos));
    const right = v3norm(v3cross(fwd, [0, 1, 0]));
    const up = v3cross(right, fwd);
    const n = (S.project.scene?.objects?.length || 0) + 1;
    // stagger new elements so they do not stack at the same spot
    const ox = ((n - 1) % 3 - 1) * 9;
    const oy = -Math.floor((n - 1) / 3) * 5;
    const base = [c.pos[0] + fwd[0] * 30, c.pos[1] + fwd[1] * 30, c.pos[2] + fwd[2] * 30];
    const pivot = base.map((v, i) => Math.round((v + right[i] * ox + up[i] * oy) * 100) / 100);
    const id = `ob_${Date.now().toString(36)}`;
    const label = primitive === 'cylinder' ? '圆柱' : '立方体';
    const geom = primitive === 'cylinder' ? { w: 4, h: 6, d: 4 } : { w: 8, h: 4, d: 0.5 };
    const j = await op({
      op: 'objectAdd',
      object: {
        id, type: 'solid', name: `${label} ${n}`, primitive,
        pivot, geom,
        style: { color: '#17d9ff', emissive: 1 },
        start: 0, duration: S.project.meta.duration,
      },
    });
    if (!j) return null;
    select({ objectId: id });
    toast(`已添加${label}；拖动它会在当前时间打位置关键帧`, 'success');
    return id;
  };

  const createCamera = async () => {
    if (!S.project) return null;
    const view = (S.editMode && S.editCam)
      || (S.project.camera ? evalCamera(S.project, S.time) : null)
      || preview.scene3d.lastCam;
    if (!view) { toast('没有可用视角，先建一个 3D 世界', 'error'); return null; }
    const rnd = (v) => Math.round(v * 100) / 100;
    const at = Math.round(S.time * 1000) / 1000;
    const cam = {
      name: `相机 ${(S.project.cameras?.length || 0) + 1}`,
      fov: view.fov ?? 62,
      roll: view.roll ?? 0,
      center: [0, 0, 0],
      path: [{ t: at, pos: view.pos.map(rnd), look: view.look.map(rnd) }],
    };
    const j = await op({ op: 'addCamera', camera: cam });
    if (!j) return null;
    select({ camera: true });
    toast('已从当前视口新建相机并激活', 'success');
    return j.project?.activeCameraId || null;
  };

  // top-left tools: select / new camera / new 3D (long-press submenu)
  const tool3DMenu = $('#tool3DMenu');
  const hideToolMenu = () => { if (tool3DMenu) tool3DMenu.hidden = true; };
  $('#toolSelect').onclick = () => {
    $('#toolSelect').classList.add('on');
    if (!S.editMode && S.project?.camera) setEditMode(true);
    setViewMode('select');
  };
  $('#toolCamera').onclick = () => { hideToolMenu(); createCamera(); };
  $('#toolText').onclick = () => { hideToolMenu(); add2DElement('text'); };
  $('#toolShape').onclick = () => { hideToolMenu(); add2DElement('shape'); };
  $('#tool3D').onclick = (e) => {
    e.stopPropagation();
    if (tool3DMenu) tool3DMenu.hidden = !tool3DMenu.hidden;
  };
  tool3DMenu?.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { hideToolMenu(); addSceneElement(b.dataset.primitive); };
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('.tool-wrap')) hideToolMenu();
  });

  projects = new ProjectsPanel({ toast });
  $('#btnProject').onclick = () => projects.open();
  $('#btnRestart').onclick = () => projects.restart();

  // ---------- 3D viewport: path nodes, handles, orbit, look ----------
  const stageXY = (e) => {
    const r = canvas.getBoundingClientRect();
    const kx = canvas.width / Math.max(1, r.width);
    const ky = canvas.height / Math.max(1, r.height);
    return { sx: (e.clientX - r.left) * kx, sy: (e.clientY - r.top) * ky, cx: e.clientX, cy: e.clientY };
  };
  let drag = null;
  // Write a value straight into the in-memory track so the viewport previews a
  // drag before the op lands (the op rewrites the same key on pointerup).
  const setLiveKey = (obj, path, v) => {
    const t = Math.round(S.time * 1000) / 1000;
    const tracks = obj.tracks || (obj.tracks = {});
    const list = tracks[path] || (tracks[path] = []);
    const k = list.find((x) => Math.abs(x.t - t) < 1e-3);
    const val = Array.isArray(v) ? v.slice() : v;
    if (k) k.v = val;
    else { list.push({ t, v: val }); list.sort((a, b) => a.t - b.t); }
  };
  // Ctrl while dragging snaps to half a metre.
  const snap3 = (v, e) => (e?.ctrlKey ? v.map((n) => Math.round(n * 2) / 2) : v);
  const camCenter = (cam, t) => cameraTransform(cam, t).center;
  const camWorldKey = (cam, key) => v3add(camCenter(cam, key.t), key.pos);
  const selectAt = (sx, sy) => {
    const id = preview.hitTest(sx, sy, S.time);
    if (id) return select({ elementId: id });
    const obj = preview.scene3d?.pickObject(S.project, S.time, sx, sy);
    if (obj) return select({ objectId: obj.id });
    const seg = S.project.segments.find((s) => S.time >= s.start && S.time < s.start + s.duration);
    if (seg) return select({ elementId: null, segmentId: seg.id });
    if (S.project.camera) return select({ camera: true });
    select({ elementId: null, segmentId: null });
  };

  const nodeMenu = (index) => {
    const key = S.project.camera?.path?.[index];
    if (!key) return [];
    const items = [
      { label: `跳到 ${key.t.toFixed(2)}s`, run: () => setTime(key.t) },
      { label: '删除这个关键点', danger: true, run: () => { gizmo.sel = -1; op({ op: 'cameraRemove', t: key.t }); } },
    ];
    if (key.in || key.out) {
      items.push({
        label: '重置曲线手柄',
        run: () => { key.in = null; key.out = null; commitCameraPath(); gizmo.draw(); },
      });
    }
    items.push({ sep: true });
    items.push({ label: '选中相机', run: () => select({ camera: true }) });
    items.push({ label: '切换到移动相机 (Alt)', run: () => setViewMode('move') });
    return items;
  };
  const canvasMenu = () => [
    { label: '选中相机', run: () => select({ camera: true }) },
    {
      label: '在当前时间打点',
      run: () => {
        const pos = pathPos(S.project.camera, S.time).map((v) => Math.round(v * 100) / 100);
        op({ op: 'cameraKey', t: S.time, pos });
      },
    },
    { sep: true },
    { label: '切换到移动相机 (Alt)', run: () => setViewMode('move') },
  ];
  // Right-click on the live lens (a time with no key): key it here, or grab it.
  const liveMenu = () => [
    {
      label: '在当前时间打点',
      run: () => {
        const pos = pathPos(S.project.camera, S.time).map((v) => Math.round(v * 100) / 100);
        op({ op: 'cameraKey', t: S.time, pos });
      },
    },
    {
      label: '视口对齐到当前镜头',
      run: () => {
        if (!S.editCam) return;
        const c = evalCamera(S.project, S.time);
        S.editCam = { pos: c.pos.slice(), look: c.look.slice(), roll: c.roll || 0, fov: c.fov };
        preview.editCam = S.editCam;
        preview.render(S.time);
        gizmo.draw();
      },
    },
    { label: '选中相机', run: () => select({ camera: true }) },
    { sep: true },
    { label: '切换到移动相机 (Alt)', run: () => setViewMode('move') },
  ];

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!S.editMode || S.viewMode !== 'select') return;
    const { sx, sy } = stageXY(e);
    const hit = gizmo?.hit(sx, sy);
    const live = hit ? null : gizmo?.hitLive(sx, sy);
    if (hit) {
      gizmo.sel = hit.index;
      const key = S.project.camera?.path?.[hit.index];
      if (key) { setTime(key.t); select({ camera: true }); }
      gizmo.draw();
      showContextMenu(e.clientX, e.clientY, nodeMenu(hit.index));
    } else if (live) {
      gizmo.liveSel = true;
      gizmo.sel = -1;
      select({ camera: true });
      gizmo.draw();
      showContextMenu(e.clientX, e.clientY, liveMenu());
    } else {
      showContextMenu(e.clientX, e.clientY, canvasMenu());
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    hideContextMenu();
    const { sx, sy, cx, cy } = stageXY(e);
    if (!S.editMode) {
      if (e.button === 0) selectAt(sx, sy);
      return;
    }
    if (S.viewMode === 'move') {
      drag = { kind: e.button === 2 ? 'look' : 'orbit', button: e.button, x: cx, y: cy, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      e.preventDefault();
      return;
    }
    if (e.button === 2) return; // context menu
    const hit = gizmo?.hit(sx, sy);
    if (hit) {
      gizmo.sel = hit.index;
      gizmo.liveSel = false;
      const key = S.project.camera?.path?.[hit.index];
      const ac = preview.scene3d.lastCam;
      const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
      let other = null;
      let oppLen = 0;
      if (key && (hit.kind === 'out' || hit.kind === 'in')) {
        other = hit.kind === 'out' ? 'in' : 'out';
        const ow = gizmo.handleWorld(hit.index, other);
        const own = gizmo.handleWorld(hit.index, 'node');
        if (ow && own) oppLen = Math.hypot(ow[0] - own[0], ow[1] - own[1], ow[2] - own[2]);
      }
      drag = { kind: hit.kind, index: hit.index, other, oppLen, normal, x: cx, y: cy, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      if (hit.kind === 'node' && key) setTime(key.t);
      gizmo.draw();
      e.preventDefault();
      return;
    }
    const live = gizmo?.hitLive(sx, sy);
    if (live) {
      gizmo.liveSel = true;
      gizmo.sel = -1;
      select({ camera: true });
      pause();
      const ac = preview.scene3d.lastCam;
      const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
      drag = { kind: 'live', normal, x: cx, y: cy, moved: false, created: false, index: -1 };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      gizmo.draw();
      e.preventDefault();
      return;
    }
    // dragged pivot key of the selected element (edit its motion path in 3D)
    const okey = gizmo?.hitObjectKey(sx, sy);
    if (okey) {
      const obj = (S.project.scene?.objects || []).find((o) => o.id === gizmo.objSel);
      const key = obj?.tracks?.pivot?.[okey.index];
      if (obj && key) {
        pause();
        setTime(okey.t);
        select({ objectId: obj.id });
        const ac = preview.scene3d.lastCam;
        const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
        drag = {
          kind: 'objkey', id: obj.id, index: okey.index, keyT: okey.t,
          normal, hit: okey.world, pivot0: key.v.slice(), pivot: key.v.slice(),
          x: cx, y: cy, moved: false,
        };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        gizmo.draw();
        e.preventDefault();
        return;
      }
    }
    // move-gizmo arrow: constrained drag along one world axis
    const ax = gizmo?.hitObjectAxis(sx, sy);
    if (ax) {
      const obj = (S.project.scene?.objects || []).find((o) => o.id === gizmo.objSel);
      if (obj) {
        const axisVec = [ax.axis === 'x' ? 1 : 0, ax.axis === 'y' ? 1 : 0, ax.axis === 'z' ? 1 : 0];
        const s0 = axisClosestS(preview.scene3d.ray(sx, sy), ax.pivot, axisVec);
        if (s0 != null) {
          pause();
          select({ objectId: obj.id });
          gizmo.axisHover = ax.axis;
          drag = {
            kind: 'objaxis', id: obj.id, axis: axisVec, p0: ax.pivot.slice(),
            s0, pivot: ax.pivot.slice(), x: cx, y: cy, moved: false,
          };
          try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
          gizmo.draw();
          e.preventDefault();
          return;
        }
      }
    }
    // timeline element in the 3D scene: pick it and start a keyed move
    const pick = preview.scene3d?.pickObject(S.project, S.time, sx, sy);
    if (pick) {
      const obj = (S.project.scene?.objects || []).find((o) => o.id === pick.id);
      select({ objectId: pick.id });
      if (obj) {
        const ac = preview.scene3d.lastCam;
        const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
        const pose = objectPose(obj, S.time);
        drag = {
          kind: 'object', id: obj.id, normal, hit: pick.point,
          pivot0: pose.pivot.slice(), pivot: pose.pivot.slice(),
          x: cx, y: cy, moved: false,
        };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        gizmo.draw();
        e.preventDefault();
        return;
      }
    }
    gizmo.objHover = null;
    gizmo.draw();
    drag = { kind: 'click', x: cx, y: cy };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const { sx, sy, cx, cy } = stageXY(e);
    const r2 = (v) => Math.round(v * 100) / 100;
    if (!drag) {
      if (S.editMode) {
        if (S.viewMode === 'move') { canvas.style.cursor = 'grab'; return; }
        const hit = gizmo?.hit(sx, sy) || gizmo?.hitLive(sx, sy) || gizmo?.hitObjectKey(sx, sy);
        const axHit = hit ? null : gizmo?.hitObjectAxis(sx, sy);
        const obj = (hit || axHit) ? null : preview.scene3d?.pickObject(S.project, S.time, sx, sy);
        const hoverId = obj?.id || null;
        if (gizmo && (gizmo.objHover !== hoverId || gizmo.axisHover !== (axHit?.axis || null))) {
          gizmo.objHover = hoverId;
          gizmo.axisHover = axHit?.axis || null;
          gizmo.draw();
        }
        canvas.style.cursor = hit || axHit || obj ? 'pointer' : 'default';
        return;
      }
      const hit = S.selection.camera ? gizmo?.hit(sx, sy) : null;
      canvas.style.cursor = hit ? 'pointer' : 'default';
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
    if (drag.kind === 'click') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) > 3) drag.moved = true;
      return;
    }
    if (drag.kind === 'live') {
      if (!drag.created && Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 4) return;
      if (!drag.created) {
        const cam = S.project.camera;
        const t = Math.round(S.time * 1000) / 1000;
        let key = cam.path.find((k) => Math.abs(k.t - t) < 1e-3);
        if (!key) {
          key = { t, pos: pathPos(cam, t).slice(), look: null, fov: null, ease: 'easeInOut', out: null, in: null };
          cam.path.push(key);
          cam.path.sort((a, b) => a.t - b.t);
        }
        const idx = cam.path.indexOf(key);
        if (e.shiftKey) {
          const prev = cam.path[idx - 1] || key;
          const next = cam.path[idx + 1] || key;
          const out = [
            (next.pos[0] - prev.pos[0]) / 6,
            (next.pos[1] - prev.pos[1]) / 6,
            (next.pos[2] - prev.pos[2]) / 6,
          ].map(r2);
          key.out = out;
          key.in = out.map((v) => -v);
        }
        drag.created = true;
        drag.index = idx;
        // the new node becomes the selection so its handles show right away
        gizmo.sel = idx;
        gizmo.liveSel = false;
      }
      const key = S.project.camera?.path?.[drag.index];
      if (!key) return;
      const w = preview.scene3d.planeHit(sx, sy, camWorldKey(S.project.camera, key), drag.normal);
      if (!w) return;
      key.pos = snap3(v3sub(w, camCenter(S.project.camera, key.t)).map(r2), e);
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      return;
    }
    if (drag.kind === 'objkey') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 3) return;
      const w = preview.scene3d.planeHit(sx, sy, drag.hit, drag.normal);
      if (!w) return;
      drag.pivot = snap3([
        r2(drag.pivot0[0] + w[0] - drag.hit[0]),
        r2(drag.pivot0[1] + w[1] - drag.hit[1]),
        r2(drag.pivot0[2] + w[2] - drag.hit[2]),
      ], e);
      const obj = (S.project.scene?.objects || []).find((o) => o.id === drag.id);
      const key = obj?.tracks?.pivot?.[drag.index];
      if (key) key.v = drag.pivot.slice();
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      timeline?.setTime(S.time);
      return;
    }
    if (drag.kind === 'objaxis') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 2) return;
      const s = axisClosestS(preview.scene3d.ray(sx, sy), drag.p0, drag.axis);
      if (s == null) return;
      const delta = s - drag.s0;
      drag.pivot = snap3([
        r2(drag.p0[0] + drag.axis[0] * delta),
        r2(drag.p0[1] + drag.axis[1] * delta),
        r2(drag.p0[2] + drag.axis[2] * delta),
      ], e);
      const obj = (S.project.scene?.objects || []).find((o) => o.id === drag.id);
      if (obj) setLiveKey(obj, 'pivot', drag.pivot);
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      timeline?.setTime(S.time);
      return;
    }
    if (drag.kind === 'object') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 3) return;
      const w = preview.scene3d.planeHit(sx, sy, drag.hit, drag.normal);
      if (!w) return;
      drag.pivot = snap3([
        r2(drag.pivot0[0] + w[0] - drag.hit[0]),
        r2(drag.pivot0[1] + w[1] - drag.hit[1]),
        r2(drag.pivot0[2] + w[2] - drag.hit[2]),
      ], e);
      const obj = (S.project.scene?.objects || []).find((o) => o.id === drag.id);
      if (obj) setLiveKey(obj, 'pivot', drag.pivot);
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      timeline?.setTime(S.time);
      return;
    }
    const key = S.project.camera?.path?.[drag.index];
    if (!key) return;
    const world = camWorldKey(S.project.camera, key);
    const w = preview.scene3d.planeHit(sx, sy, world, drag.normal);
    if (!w) return;
    if (drag.kind === 'node') {
      key.pos = snap3(v3sub(w, camCenter(S.project.camera, key.t)).map(r2), e);
    } else {
      const v = [w[0] - world[0], w[1] - world[1], w[2] - world[2]];
      key[drag.kind] = v.map(r2);
      // default keeps the two handles collinear; Shift frees the dragged one
      if (!e.shiftKey && drag.other) {
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        const opp = drag.oppLen || l;
        key[drag.other] = [(-v[0] / l) * opp, (-v[1] / l) * opp, (-v[2] / l) * opp].map(r2);
      }
    }
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
    } else if (d.kind === 'live') {
      if (d.created) commitCameraPath();
      gizmo.draw();
    } else if (d.kind === 'object') {
      if (d.moved && d.pivot) {
        op({
          op: 'objectKey', id: d.id, path: 'pivot',
          t: Math.round(S.time * 1000) / 1000, v: d.pivot,
        });
      }
      gizmo.draw();
    } else if (d.kind === 'objkey') {
      if (d.moved && d.pivot) {
        op({ op: 'objectKey', id: d.id, path: 'pivot', t: d.keyT, v: d.pivot });
      }
      gizmo.draw();
    } else if (d.kind === 'objaxis') {
      if (d.moved && d.pivot) {
        op({
          op: 'objectKey', id: d.id, path: 'pivot',
          t: Math.round(S.time * 1000) / 1000, v: d.pivot,
        });
      }
      gizmo.draw();
    } else if (d.kind === 'click' && !d.moved) {
      const { sx, sy } = stageXY(e);
      gizmo.sel = -1;
      gizmo.liveSel = false;
      gizmo.draw();
      selectAt(sx, sy);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { drag = null; });

  // double-click a handle to drop it back to the automatic Catmull tangent
  canvas.addEventListener('dblclick', (e) => {
    if (!S.editMode || S.viewMode !== 'select') return;
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
    if (!S.editMode || S.viewMode !== 'move') return;
    e.preventDefault();
    dollyEdit(Math.exp(e.deltaY * 0.0012));
    preview.render(S.time);
    gizmo.draw();
  }, { passive: false });

  // keyboard
  window.addEventListener('keydown', (e) => {
    // F2 works even while a value field is focused (it is not a text key).
    if (e.key === 'F2') { e.preventDefault(); toggleCurvePanel(); return; }
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    S.keys.add(e.code);
    if (e.key === 'Tab') { e.preventDefault(); setEditMode(!S.editMode); return; }
    if (e.key === 'Alt' && !e.repeat) {
      e.preventDefault();
      if (!S.editMode) { toast('先按 Tab 进编辑视口'); return; }
      setViewMode(S.viewMode === 'select' ? 'move' : 'select');
      return;
    }
    if (e.key === 'Escape') {
      if (curvePanel?.isOpen()) { curvePanel.close(); e.preventDefault(); return; }
      const menu = $('#ctxMenu');
      if (menu && !menu.hidden) { hideContextMenu(); return; }
      if (gizmo?.objSel) { select({ elementId: null, segmentId: null }); return; }
      if (S.editMode && S.viewMode === 'move') { setViewMode('select'); return; }
      if (S.editMode) { setEditMode(false); return; }
    }
    if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey) { S.grid = !S.grid; gizmo?.draw(); return; }
    if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (timeline?.applyKeyedFilter()) { e.preventDefault(); return; }
    }
    const dur = S.project?.meta.duration || 12;
    const frame = 1 / (S.project?.meta.fps || 24);
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); setTime(S.time - (e.shiftKey ? 1 : frame)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); setTime(S.time + (e.shiftKey ? 1 : frame)); }
    else if (e.key === 'Home') { pause(); setTime(0); }
    else if (e.key === 'End') { pause(); setTime(dur); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      const pool = S.selection.pool;
      // A keyframe pool wins over the host the key belongs to: Delete removes
      // the selected keyframes, not the whole camera/object.
      if (pool?.kind === 'keyframe' && pool.ids.length) {
        const ops = keyframeDeleteOps(pool.ids, S.project);
        if (ops.length) {
          e.preventDefault();
          select({});
          op(ops.length === 1 ? ops[0] : { op: 'batch', ops });
        }
        return;
      }
      if (S.selection.elementId) { e.preventDefault(); op({ op: 'removeElement', id: S.selection.elementId }); S.selection.elementId = null; }
      else if (S.selection.objectId) {
        e.preventDefault();
        const id = S.selection.objectId;
        S.selection.objectId = null;
        op({ op: 'objectRemove', id });
      }
    } else if (e.key === 's' && !e.ctrlKey) {
      if (S.selection.elementId) {
        e.preventDefault();
        splitElementAt(S.selection.elementId);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) $('#btnRedo').click(); else $('#btnUndo').click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      const el = S.project.elements.find((x) => x.id === S.selection.elementId);
      if (el && !window.getSelection()?.toString()) {
        e.preventDefault();
        S.clipboard = JSON.parse(JSON.stringify(el));
        toast(`已复制 ${el.name || el.id}，Ctrl+V 粘贴到播放头`);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (S.clipboard) { e.preventDefault(); pasteElement(S.clipboard); }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      const el = S.project.elements.find((x) => x.id === S.selection.elementId);
      if (el) {
        e.preventDefault();
        op({ op: 'duplicateElement', id: el.id, start: fitStart(el.start + el.duration, el.duration) })
          .then((j) => { const id = j?.changed?.[0]; if (id) select({ elementId: id }); });
        return;
      }
      const o = (S.project.scene?.objects || []).find((x) => x.id === S.selection.objectId);
      if (o) {
        e.preventDefault();
        const copy = JSON.parse(JSON.stringify(o));
        copy.id = `ob_${Date.now().toString(36)}`;
        copy.name = `${o.name || '元素'} 副本`;
        copy.pivot = [copy.pivot[0] + 10, copy.pivot[1], copy.pivot[2]];
        op({ op: 'objectAdd', object: copy }).then((j) => { if (j) select({ objectId: copy.id }); });
      }
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
  if (new URLSearchParams(location.search).get('picker') === '1') {
    setTimeout(() => projects?.open(), 350);
  }

  // playback loop
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (S.playing) {
      const t = S.playFrom + (now - S.playWall) / 1000;
      if (t >= (S.project?.meta.duration || 12)) { setTime(S.project.meta.duration); pause(); }
      else {
        S.time = t;
        timeline.setTime(t);
        $('#timecode').textContent = `${t.toFixed(2)}s`;
        $('#stageTime').textContent = `${t.toFixed(2)} / ${S.project.meta.duration.toFixed(2)}s`;
      }
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
    S, preview, timeline, inspector, gizmo, projects, op, toast, curvePanel,
    openCurvePanel: () => openCurvePanel(),
    setTime: (t) => setTime(t),
    select: (s) => select(s),
    setEditMode: (on) => setEditMode(on),
    setViewMode: (m) => setViewMode(m),
    addElement: addSceneElement,
    pause: () => pause(),
    play: () => play(),
  };
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f66;padding:24px">启动失败: ${e.message}\n${e.stack}</pre>`;
});
