// VedioMaker renderer main: state, playback, selection, wiring.
import { Preview } from './preview.js';
import { Timeline, escapeHtml } from './timeline.js';
import { Inspector } from './inspector.js';
import { AgentPanel } from './ai.js';
import { PipelinePanel } from './pipeline.js';

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
};

let preview, timeline, inspector, agentPanel, pipelinePanel;

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

function applyProject(p, source) {
  S.project = p;
  if (S.selection.elementId && !p.elements.find((e) => e.id === S.selection.elementId)) S.selection.elementId = null;
  if (S.selection.segmentId && !p.segments.find((s) => s.id === S.selection.segmentId)) S.selection.segmentId = null;
  preview.setProject(p);
  timeline.setProject(p);
  timeline.setSelection(S.selection);
  inspector.render(p, S.selection, S.time);
  renderShots();
  $('#projTitle').textContent = p.meta.title;
  $('#projMeta').textContent = `${p.meta.width}×${p.meta.height} · ${p.meta.fps}fps · ${p.meta.duration.toFixed(1)}s · rev ${p.rev}`;
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
  S.selection = { segmentId: sel.segmentId ?? S.selection.segmentId, elementId: sel.elementId ?? null };
  if (sel.elementId) {
    const el = S.project.elements.find((e) => e.id === sel.elementId);
    if (el?.segment) S.selection.segmentId = el.segment;
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
  preview.render(S.time);
  updateOverlay();
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

  // canvas clicks
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    const id = preview.hitTest((e.clientX - r.left) * sx, (e.clientY - r.top) * sy, S.time);
    if (id) select({ elementId: id });
    else {
      const seg = S.project.segments.find((s) => S.time >= s.start && S.time < s.start + s.duration);
      select({ elementId: null, segmentId: seg?.id || null });
    }
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
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

  // resize
  const ro = new ResizeObserver(() => fitStage());
  ro.observe($('#stageWrap'));
  applyProject(S.project, 'boot');
  fitStage();
  setTime(0);

  // playback loop
  let last = performance.now();
  const loop = (now) => {
    if (S.playing) {
      const t = S.playFrom + (now - S.playWall) / 1000;
      if (t >= (S.project?.meta.duration || 12)) { setTime(S.project.meta.duration); pause(); }
      else { S.time = t; timeline.setTime(t); $('#timecode').textContent = `${t.toFixed(2)}s`; $('#stageTime').textContent = `${t.toFixed(2)} / ${S.project.meta.duration.toFixed(2)}s`; }
    }
    if (S.project) {
      preview.render(S.time);
      updateOverlay();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__vdm = { S, preview, timeline, inspector, op, toast, setTime: (t) => setTime(t), select: (s) => select(s), pause: () => pause(), play: () => play() };
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f66;padding:24px">启动失败: ${e.message}\n${e.stack}</pre>`;
});
