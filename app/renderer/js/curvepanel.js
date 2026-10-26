// Value-curve drawer for the timeline (F2).
//
// Opens when two or more keyframes of the same property are selected. The
// panel covers the element lanes and draws the selected span on its own time
// axis (seconds are printed on the x axis), so the segment fills the panel no
// matter how far the timeline is zoomed out.
//
// P1 implements the cubic-bezier easing preset: progress 0..1 over the
// segment with two draggable control points. The other presets from the
// design are listed but disabled until implemented.
import {
  sampleCurve, normalizeCurve, presetCurve, curveLabel, curveSegments, CURVE_GROUPS,
} from '/core/curves.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const PATH_LABELS = {
  'transform.x': '位置 X', 'transform.y': '位置 Y', 'transform.scale': '缩放',
  'transform.rotation': '旋转', 'transform.opacity': '不透明度', 'style.size': '字号',
  'fx.glow': '辉光', opacity: '透明度', scale: '缩放', center: '中心点',
  picturePivot: '画面中心', pictureOffset: '画面位置', fov: 'FOV', roll: 'Roll',
  lookAhead: '看向距离', bankGain: '转弯侧倾', 'shake.amp': '抖动幅度',
  'shake.freq': '抖动频率', 'dof.fstop': '光圈',
};

/** Display label for a keyed property path (shared with main.js). */
export const curvePathLabel = (path) => PATH_LABELS[path] || path;

const U_STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];

export class CurvePanel {
  constructor(host, { getTimeline, onOp, onClose, toast, getProject } = {}) {
    this.host = host;
    this.getTimeline = getTimeline;
    this.getProject = getProject;
    this.onOp = onOp;
    this.onClose = onClose;
    this.toast = toast;
    this.openState = null;
    this.active = 0;
    this.curve = null;
    this.drag = null;
    this._build();
  }

  // ------------------------------------------------------------ DOM
  _build() {
    this.root = el('div', 'curve-panel');
    this.root.hidden = true;

    const head = el('div', 'cp-head');
    this.titleEl = el('div', 'cp-title', '曲线');
    this.pathSel = document.createElement('select');
    this.pathSel.className = 'cp-pathsel';
    this.pathSel.title = '选择要编辑的属性';
    this.pathSel.addEventListener('change', () => {
      if (!this.openState) return;
      this.openState.index = Number(this.pathSel.value) || 0;
      this.active = 0;
      const track = this._track();
      this.curve = normalizeCurve(track?.segments[0]?.a?.curve) || presetCurve('easeInOut');
      this._syncHead();
      this._markPreset();
      this.draw();
    });
    this.rangeEl = el('div', 'cp-range', '');
    this.presetEl = el('div', 'cp-preset', '');
    const close = el('button', 'cp-close', '×');
    close.title = '关闭 (F2 / Esc)';
    close.onclick = () => this.close();
    head.append(this.titleEl, this.pathSel, this.rangeEl, this.presetEl, el('div', 'cp-spacer'), close);

    const body = el('div', 'cp-body');
    this.canvasWrap = el('div', 'cp-canvaswrap');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cp-canvas';
    this.canvasWrap.appendChild(this.canvas);
    this.rail = el('div', 'cp-rail');
    body.append(this.canvasWrap, this.rail);

    const foot = el('div', 'cp-foot');
    foot.innerHTML = '<span>拖动两个白点调整曲线</span><span class="cp-sep">|</span>'
      + '<span>点段切换编辑段</span><span class="cp-sep">|</span>'
      + '<span>预设作用于全部选中段</span><span class="cp-sep">|</span>'
      + '<span>时间轴缩放同步（Ctrl+滚轮 / 缩放按钮）</span><span class="cp-sep">|</span>'
      + '<span><b>F2</b> / <b>Esc</b> 关闭</span>';
    this.root.append(head, body, foot);
    this.host.appendChild(this.root);

    this.canvas.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    this.canvas.addEventListener('pointermove', (e) => this._hover(e));
    window.addEventListener('resize', () => { if (this.isOpen()) this.draw(); });
  }

  isOpen() { return !this.root.hidden; }

  // ------------------------------------------------------------ open / close
  open(state) {
    this.openState = state;
    this.active = 0;
    const track = this._track();
    this.curve = normalizeCurve(track?.segments[0]?.a?.curve) || presetCurve('easeInOut');
    this.root.hidden = false;
    this._buildRail();
    this._buildPathSelect();
    this._syncHead();
    this._reveal();
    this.draw();
  }

  /** Scroll the timeline so the edited segment is at least partly visible. */
  _reveal() {
    const tl = this.getTimeline();
    const seg = this._track()?.segments[0];
    if (!tl || !seg) return;
    const x0 = tl._trackX(seg.from);
    const viewL = tl.scroll.scrollLeft;
    const viewR = viewL + tl.scroll.clientWidth;
    if (x0 < viewL + 60 || x0 > viewR - 60) {
      tl.scroll.scrollLeft = Math.max(0, x0 - 160);
    }
  }

  /** Currently edited property track ({ path, label, segments }). */
  _track() {
    return this.openState?.tracks?.[this.openState.index] || null;
  }

  close() {
    this.root.hidden = true;
    this.openState = null;
    this.drag = null;
    this.onClose?.();
  }

  toggle(state) {
    if (this.isOpen()) { this.close(); return; }
    this.open(state);
  }

  _keysFor(project, path) {
    const st = this.openState;
    if (st.host === 'element') return (project.elements || []).find((e) => e.id === st.id)?.keyframes || [];
    if (st.host === 'object') return (project.scene?.objects || []).find((o) => o.id === st.id)?.tracks?.[path] || [];
    return (project.cameras || []).find((c) => c.id === st.id)?.tracks?.[path] || [];
  }

  /** Build segments for every keyed property of the edited host. */
  _tracksFromProject(project) {
    const st = this.openState;
    const byPath = new Map();
    if (st.host === 'element') {
      for (const k of this._keysFor(project, null)) {
        if (!byPath.has(k.path)) byPath.set(k.path, []);
        byPath.get(k.path).push(k);
      }
    } else {
      for (const path of Object.keys(this._paths(project))) byPath.set(path, this._keysFor(project, path));
    }
    const tracks = [];
    for (const [path, keys] of byPath) {
      const segs = curveSegments(keys);
      if (segs.length) tracks.push({ path, label: curvePathLabel(path), segments: segs });
    }
    return tracks.sort((a, b) => a.path.localeCompare(b.path));
  }

  _paths(project) {
    const st = this.openState;
    if (st.host === 'object') return (project.scene?.objects || []).find((o) => o.id === st.id)?.tracks || {};
    return (project.cameras || []).find((c) => c.id === st.id)?.tracks || {};
  }

  /** Project changed: re-read keys for every track and keep the same segment selected. */
  setProject(project) {
    if (!this.isOpen() || !project) return;
    const st = this.openState;
    const path = this._track()?.path;
    const tracks = this._tracksFromProject(project);
    if (!tracks.length) { this.close(); return; }
    st.tracks = tracks;
    const idx = Math.max(0, tracks.findIndex((t) => t.path === path));
    st.index = idx;
    const segs = tracks[idx].segments;
    this.active = Math.min(this.active, segs.length - 1);
    this.curve = normalizeCurve(segs[this.active].a?.curve) || this.curve;
    this._buildPathSelect();
    this._syncHead();
    this.draw();
  }

  // ------------------------------------------------------------ chrome
  _buildPathSelect() {
    const st = this.openState;
    if (!st) return;
    this.pathSel.innerHTML = '';
    st.tracks.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = t.label || t.path;
      this.pathSel.appendChild(o);
    });
    this.pathSel.value = String(st.index);
    this.pathSel.hidden = st.tracks.length < 2;
  }

  _syncHead() {
    const st = this.openState;
    const track = this._track();
    if (!st || !track) return;
    this.titleEl.textContent = `曲线 · ${track.label || track.path}`;
    const s = track.segments[this.active] || track.segments[0];
    this.rangeEl.textContent = `${s.from.toFixed(2)}s → ${s.to.toFixed(2)}s · ${track.segments.length} 段 · 第 ${this.active + 1} 段`;
    this.presetEl.textContent = curveLabel(this.curve);
  }

  _buildRail() {
    this.rail.innerHTML = '';
    for (const group of CURVE_GROUPS) {
      this.rail.appendChild(el('div', 'cp-rail-title', group.title));
      for (const item of group.items) {
        const b = el('button', `cp-thumb${item.ready ? '' : ' disabled'}`);
        b.dataset.preset = item.id;
        const cv = document.createElement('canvas');
        cv.width = 68; cv.height = 34;
        this._drawThumb(cv, item.id, item.ready);
        b.append(cv, el('span', '', item.label));
        b.onclick = item.ready
          ? () => this._applyPreset(item.id)
          : () => this.toast?.(`「${item.label}」还没做`);
        this.rail.appendChild(b);
      }
    }
    this._markPreset();
  }

  _markPreset() {
    const name = normalizeCurve(this.curve)?.preset || '';
    this.rail.querySelectorAll('.cp-thumb').forEach((b) => {
      b.classList.toggle('on', b.dataset.preset === name);
    });
  }

  _drawThumb(cv, id, ready) {
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = ready ? '#17d9ff' : '#45566a';
    ctx.lineWidth = 1.5;
    const curve = ready ? presetCurve(id) : null;
    ctx.beginPath();
    for (let i = 0; i <= 32; i++) {
      const u = i / 32;
      const v = curve ? sampleCurve(curve, u) : u;
      const x = 5 + u * (w - 10);
      const y = h - 5 - clamp(v, 0, 1) * (h - 10);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (!ready) {
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = '#33414f';
      ctx.beginPath(); ctx.moveTo(5, h - 5); ctx.lineTo(w - 5, 5); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ------------------------------------------------------------ geometry
  _layout() {
    const W = this.canvas.clientWidth || this.canvasWrap.clientWidth || 600;
    const H = this.canvas.clientHeight || this.canvasWrap.clientHeight || 180;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    return { W, H, dpr, top: 26, bottom: H - 22, leftPad: 52, rightPad: 16 };
  }

  /**
   * Panel geometry follows the timeline exactly: same gutter, pps and
   * scrollLeft, so keyframe diamonds in the ruler and the curve share x.
   * Zoom the timeline (buttons / Ctrl+wheel) to edit a short segment.
   */
  _geo() {
    const L = this._layout();
    const tl = this.getTimeline();
    const gutter = tl?._gutter?.() || 360;
    const pps = tl?.pps || 60;
    const scroll = tl?.scroll?.scrollLeft || 0;
    const plotLeft = Math.max(0, gutter - scroll);
    const plotRight = L.W - L.rightPad;
    const xOf = (t) => gutter + Number(t) * pps - scroll;
    const tOf = (x) => (x + scroll - gutter) / Math.max(1, pps);
    const yOf = (v) => L.bottom - clamp(Number(v), -0.2, 1.2) * (L.bottom - L.top);
    const vOf = (y) => (L.bottom - y) / Math.max(1, L.bottom - L.top);
    return { ...L, gutter, pps, scroll, plotLeft, plotRight, xOf, tOf, yOf, vOf };
  }

  _handlePos(seg, g, which) {
    const p = which === 'p1' ? this.curve?.p1 : this.curve?.p2;
    if (!p) return null;
    return { x: g.xOf(seg.from + p[0] * (seg.to - seg.from)), y: g.yOf(p[1]), u: p[0], v: p[1] };
  }

  // ------------------------------------------------------------ draw
  draw() {
    if (!this.isOpen() || !this.openState) return;
    const g = this._geo();
    const { W, H, dpr } = g;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0c1118';
    ctx.fillRect(0, 0, W, H);

    // value grid + labels
    ctx.font = '10px system-ui, sans-serif';
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const y = g.yOf(v);
      ctx.strokeStyle = '#19222f';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.plotLeft, y + 0.5); ctx.lineTo(W - g.rightPad, y + 0.5); ctx.stroke();
      ctx.fillStyle = '#5f7288';
      ctx.fillText(v.toFixed(2), 8, y + 3);
    }
    ctx.fillStyle = '#4c5d71';
    ctx.fillText('进度', 8, 12);

    // time ticks (same time→x mapping as the timeline)
    const viewStart = g.tOf(g.plotLeft);
    const viewEnd = g.tOf(W - g.rightPad);
    const viewSpan = Math.max(0.001, viewEnd - viewStart);
    const step = U_STEPS.find((s) => viewSpan / s <= 9) || 10;
    const firstTick = Math.ceil(viewStart / step) * step;
    for (let t = firstTick; t <= viewEnd + 1e-9; t += step) {
      const x = g.xOf(t);
      if (x < g.plotLeft || x > W - g.rightPad) continue;
      ctx.strokeStyle = '#141c27';
      ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke();
      ctx.fillStyle = '#55697f';
      const label = step >= 1 ? `${Math.round(t * 100) / 100}s` : `${t.toFixed(2)}s`;
      ctx.fillText(label, x + 3, H - 7);
    }

    // segments (clipped to the visible time window)
    (this._track()?.segments || []).forEach((seg, i) => {
      const isActive = i === this.active;
      const t0 = Math.max(seg.from, viewStart);
      const t1 = Math.min(seg.to, viewEnd);
      if (t1 <= t0) return;
      const x0 = g.xOf(t0);
      const x1 = g.xOf(t1);
      const curve = isActive ? this.curve : normalizeCurve(seg.a?.curve);
      if (isActive) {
        ctx.fillStyle = 'rgba(23,217,255,0.05)';
        ctx.fillRect(x0, g.top, Math.max(1, x1 - x0), g.bottom - g.top);
      }
      const span = Math.max(1e-6, seg.to - seg.from);
      ctx.beginPath();
      const steps = Math.max(40, Math.round(x1 - x0));
      for (let s = 0; s <= steps; s++) {
        const x = x0 + ((x1 - x0) * s) / steps;
        const u = clamp((g.tOf(x) - seg.from) / span, 0, 1);
        const y = g.yOf(sampleCurve(curve, u));
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = isActive ? '#17d9ff' : 'rgba(23,217,255,0.4)';
      ctx.lineWidth = isActive ? 2.2 : 1.4;
      ctx.stroke();
      ctx.fillStyle = isActive ? '#dff6ff' : '#6f8ea6';
      for (const [x, y] of [[g.xOf(seg.from), g.bottom], [g.xOf(seg.to), g.top]]) {
        if (x < g.plotLeft - 6 || x > W - g.rightPad + 6) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
      }
    });

    // active handles with guides
    const seg = this._track()?.segments[this.active];
    if (seg && this.curve) {
      for (const which of ['p1', 'p2']) {
        const hp = this._handlePos(seg, g, which);
        if (!hp) continue;
        const visible = hp.x >= g.plotLeft - 10 && hp.x <= W - g.rightPad + 10;
        if (!visible) continue;
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(160,180,200,0.4)';
        ctx.beginPath(); ctx.moveTo(g.plotLeft, hp.y); ctx.lineTo(W - g.rightPad, hp.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(hp.x, g.top); ctx.lineTo(hp.x, g.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#f4fbff';
        ctx.fill();
        ctx.strokeStyle = '#8fd8ef';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // playhead
    const tl = this.getTimeline();
    const px = g.xOf(tl?.time ?? 0);
    if (px > g.plotLeft && px < g.plotRight) {
      ctx.strokeStyle = '#ff5c7a';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, g.top); ctx.lineTo(px, g.bottom); ctx.stroke();
    }
  }

  // ------------------------------------------------------------ interaction
  _localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _hitHandle(x, y) {
    const g = this._geo();
    const seg = this._track()?.segments[this.active];
    if (!seg) return null;
    let best = null;
    for (const which of ['p1', 'p2']) {
      const hp = this._handlePos(seg, g, which);
      if (!hp) continue;
      const d = Math.hypot(hp.x - x, hp.y - y);
      if (d <= 15 && (!best || d < best.d)) best = { which, d };
    }
    return best?.which || null;
  }

  _down(e) {
    if (e.button !== 0) return;
    const p = this._localPoint(e);
    const which = this._hitHandle(p.x, p.y);
    if (which) {
      e.preventDefault();
      this.drag = {
        which, seg: this.active,
        curve: { ...this.curve, p1: [...this.curve.p1], p2: [...this.curve.p2] },
      };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const g = this._geo();
    const t = g.tOf(p.x);
    const idx = (this._track()?.segments || []).findIndex((s) => t >= s.from && t <= s.to);
    if (idx >= 0 && idx !== this.active) {
      this.active = idx;
      this.curve = normalizeCurve(this._track()?.segments[idx]?.a?.curve) || presetCurve('easeInOut');
      this._syncHead();
      this._markPreset();
      this.draw();
    }
  }

  _move(e) {
    if (!this.drag) return;
    const seg = this._track()?.segments[this.drag.seg];
    if (!seg) return;
    const g = this._geo();
    const p = this._localPoint(e);
    const u = clamp((g.tOf(p.x) - seg.from) / Math.max(1e-6, seg.to - seg.from), 0, 1);
    const v = clamp(g.vOf(p.y), -0.5, 1.5);
    const c = this.drag.curve;
    const point = [Math.round(u * 1000) / 1000, Math.round(v * 1000) / 1000];
    if (this.drag.which === 'p1') c.p1 = point; else c.p2 = point;
    c.preset = null;
    this.curve = c;
    this.presetEl.textContent = curveLabel(c);
    this._markPreset();
    this.draw();
  }

  _up() {
    if (!this.drag) return;
    const seg = this._track()?.segments[this.drag.seg];
    this.drag = null;
    this.canvas.style.cursor = '';
    if (seg) this._commit(this.curve, [seg]);
  }

  _hover(e) {
    if (this.drag) return;
    const p = this._localPoint(e);
    this.canvas.style.cursor = this._hitHandle(p.x, p.y) ? 'grab' : 'default';
  }

  _applyPreset(id) {
    const curve = presetCurve(id);
    if (!curve) return;
    this.curve = curve;
    this._syncHead();
    this._markPreset();
    this.draw();
    this._commit(curve, this._track()?.segments || []);
  }

  _commit(curve, segments) {
    if (!this.openState || !this._track() || !segments?.length) return;
    const st = this.openState;
    const ops = segments.map((s) => ({
      op: 'keyCurve', host: st.host, id: st.id, path: this._track()?.path,
      from: Math.round(Number(s.from) * 1000) / 1000,
      to: Math.round(Number(s.to) * 1000) / 1000,
      curve: curve ? normalizeCurve(curve) : null,
    }));
    this.onOp?.(ops.length === 1 ? ops[0] : { op: 'batch', ops });
  }
}
