// Value-curve drawer for the timeline (F2).
//
// Opens when two or more keyframes of the same property are selected. The
// panel covers the element lanes and draws the selected span on its own time
// axis (seconds are printed on the x axis), so the segment fills the panel no
// matter how far the timeline is zoomed out.
//
// Bezier presets expose their two control points; the parameterised presets
// (bounce / elastic / cyclic / step / elasticStep) expose the handles declared
// by core/curves.js::curveHandles, and dragging one writes the mapped parameter
// through moveCurveHandle. The value window follows curveRange so overshoot
// handles (elastic magnitude, cyclic sharpness) stay reachable.
import {
  sampleCurve, normalizeCurve, presetCurve, curveLabel, curveSegments, CURVE_GROUPS,
  curveHandles, moveCurveHandle, curveRange, curveParamsText,
} from '/core/curves.js';
import { retimePathSpan } from '/core/camera.js';
import { cameraRef, keyframeRef } from '/core/selection.js';
import { h, icon, token } from './ui.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Canvas colors come from the design tokens (DESIGN.md §3); `alpha` tints one.
const C = (name) => token(name);
function alpha(color, a) {
  const c = String(color || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) {
    const [r, g, b] = m[1].split('').map((x) => parseInt(x + x, 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  m = /^#([0-9a-f]{6})/i.exec(c);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return c;
}
const canvasFont = () => `11px ${token('--font-ui') || 'system-ui, sans-serif'}`;

const PATH_LABELS = {
  path: '飞行轨迹',
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
  constructor(host, { getTimeline, onOp, onClose, toast, getProject, onLivePreview, onSelect } = {}) {
    this.host = host;
    this.getTimeline = getTimeline;
    this.getProject = getProject;
    this.onOp = onOp;
    this.onClose = onClose;
    this.toast = toast;
    this.onLivePreview = onLivePreview;
    this.onSelect = onSelect;
    this.openState = null;
    this.active = 0;
    this.railGroup = 0;
    this.span = null;
    this.path = null;
    this.previewInner = null;
    this._spanBackup = null;
    this._spanNotice = null;
    this._liveRaf = 0;
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
      if (track?.path === 'path') this._refreshSpan();
      else this.curve = normalizeCurve(track?.segments[0]?.a?.curve) || presetCurve('easeInOut');
      this._syncHead();
      this._syncRailGroup();
      this.draw();
    });
    this.rangeEl = el('div', 'cp-range', '');
    this.presetEl = el('div', 'cp-preset', '');
    const close = h('button', {
      type: 'button', class: 'cp-close icon-btn mini', 'aria-label': '关闭', 'data-tip': '关闭', 'data-kbd': 'F2 / Esc',
    }, icon('x', 'ic-sm'));
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
    foot.innerHTML = '<span>拖动圆点调整曲线 / 参数</span><span class="cp-sep">|</span>'
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
    this._spanNotice = null;
    const track = this._track();
    if (track?.path === 'path') this._refreshSpan();
    else this.curve = normalizeCurve(track?.segments[0]?.a?.curve) || presetCurve('easeInOut');
    this.root.hidden = false;
    this.railGroup = this._groupIndex();
    this._buildRail();
    this._buildPathSelect();
    this._syncHead();
    this._reveal();
    this.draw();
  }

  /** Scroll the timeline so the edited segment is at least partly visible. */
  _reveal() {
    const tl = this.getTimeline();
    const seg = this._isPathMode() && this.span
      ? { from: this.span.from }
      : this._track()?.segments[0];
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

  _isPathMode() {
    return this._track()?.path === 'path';
  }

  _camera() {
    const st = this.openState;
    if (!st || st.host !== 'camera') return null;
    const p = this.getProject?.();
    if (!p) return null;
    return (p.cameras || []).find((c) => c.id === st.id)
      || (p.camera?.id === st.id ? p.camera : null);
  }

  /**
   * Path mode model. Selected path keys are *segment boundaries*: every
   * adjacent pair is one independent span for the same preset. Stored spans
   * (curve + spanTo) are the real data the panel draws; selection only decides
   * which segments the preset will be applied to.
   */
  _refreshSpan() {
    this.previewInner = null;
    const cam = this._camera();
    const track = this._track();
    if (!cam || track?.path !== 'path' || !Array.isArray(cam.path) || cam.path.length < 2) {
      this.span = null;
      this.path = null;
      return;
    }
    const keys = [...cam.path].sort((a, b) => a.t - b.t);
    const find = (t) => keys.findIndex((k) => Math.abs(k.t - t) <= 1e-4);
    const explicit = Array.isArray(this.openState?.selectedTimes);
    let selected = explicit
      ? [...new Set(this.openState.selectedTimes.map(Number))].filter((t) => find(t) >= 0).sort((a, b) => a - b)
      : [keys[0].t, keys[keys.length - 1].t];
    if (!explicit) selected = [keys[0].t, keys[keys.length - 1].t];

    const spans = [];
    keys.forEach((k, i) => {
      if (!k.curve || !Number.isFinite(Number(k.spanTo))) return;
      const j = find(Number(k.spanTo));
      if (j <= i) return;
      spans.push({
        from: keys[i].t,
        to: keys[j].t,
        left: keys[i],
        right: keys[j],
        inner: keys.slice(i + 1, j),
        curve: normalizeCurve(k.curve),
      });
    });

    const segments = [];
    for (let i = 0; i < selected.length - 1; i++) {
      const li = find(selected[i]);
      const ri = find(selected[i + 1]);
      if (ri <= li) continue;
      segments.push({
        from: keys[li].t,
        to: keys[ri].t,
        left: keys[li],
        right: keys[ri],
        inner: keys.slice(li + 1, ri),
      });
    }

    this.path = { cameraId: cam.id, keys, selected, segments, spans };
    const first = selected[0] ?? keys[0].t;
    const last = selected[selected.length - 1] ?? keys[keys.length - 1].t;
    this.span = { from: first, to: last, cameraId: cam.id };
    const firstCurve = segments.length ? this._segmentCurve(segments[0]) : null;
    // No curve means no preset should look active. The rail may still show
    // thumbnails, but the header says 未应用 until the user picks one.
    this.curve = firstCurve || null;
    if (this.openState) {
      this.openState.selectedTimes = [...selected];
      this.openState.spanFrom = first;
      this.openState.spanTo = last;
    }
  }

  /** Real stored curve for one selected segment, if it exactly matches. */
  _segmentCurve(segment) {
    if (!segment || !this.path) return null;
    const span = this.path.spans.find((s) => Math.abs(s.from - segment.from) <= 1e-4
      && Math.abs(s.to - segment.to) <= 1e-4);
    return span?.curve || null;
  }

  /** All real curves the panel must show, plus a sensible fallback window. */
  _curveWindow() {
    if (!this._isPathMode() || !this.path?.spans?.length) return curveRange(this.curve);
    let min = Infinity;
    let max = -Infinity;
    for (const span of this.path.spans) {
      const [a, b] = curveRange(span.curve);
      min = Math.min(min, a);
      max = Math.max(max, b);
    }
    return Number.isFinite(min) ? [min, max] : [-0.25, 1.25];
  }

  close() {
    if (this._liveRaf) {
      cancelAnimationFrame(this._liveRaf);
      this._liveRaf = 0;
    }
    this._restoreSpanBackup();
    this.root.hidden = true;
    this.openState = null;
    this.drag = null;
    this.span = null;
    this.path = null;
    this.previewInner = null;
    this._spanNotice = null;
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
    if (st.host === 'camera') {
      const cam = (project.cameras || []).find((c) => c.id === st.id);
      if (cam && Array.isArray(cam.path) && cam.path.length >= 2) {
        tracks.push({ path: 'path', label: curvePathLabel('path'), segments: curveSegments(cam.path) });
      }
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
    if (tracks[idx].path === 'path') this._refreshSpan();
    else this.curve = normalizeCurve(segs[this.active].a?.curve) || this.curve;
    this._buildPathSelect();
    this._syncHead();
    this._syncRailGroup();
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
    if (track.path === 'path' && this.path) {
      const p = this.path;
      const curves = p.segments.map((seg) => this._segmentCurve(seg));
      const applied = curves.filter(Boolean);
      const same = applied.length === curves.length && applied.length > 0
        && applied.every((c) => JSON.stringify(c) === JSON.stringify(applied[0]));
      const from = p.selected[0] ?? this.span?.from ?? 0;
      const to = p.selected[p.selected.length - 1] ?? this.span?.to ?? 0;
      this.rangeEl.textContent = `${from.toFixed(2)}s → ${to.toFixed(2)}s · `
        + `${p.selected.length} 键 · ${p.segments.length} 段 · ${p.spans.length} 条已存曲线`;
      let label;
      if (!p.segments.length) label = '至少选中两个关键帧';
      else if (same) {
        const detail = curveParamsText(applied[0]);
        label = `${curveLabel(applied[0])}${p.segments.length > 1 ? ` ×${p.segments.length}` : ''}`
          + (detail ? ` · ${detail}` : '');
      } else if (!applied.length) {
        const old = p.spans.filter((s) => s.to > from + 1e-4 && s.from < to - 1e-4).length;
        label = old ? `已有 ${old} 条旧曲线 · 点预设替换` : '未应用 · 点预设套用';
      } else {
        label = `${applied.length}/${p.segments.length} 段已应用`;
      }
      this.presetEl.textContent = label;
      this.presetEl.title = label;
      return;
    }
    const s = track.segments[this.active] || track.segments[0];
    this.rangeEl.textContent = `${s.from.toFixed(2)}s → ${s.to.toFixed(2)}s · ${track.segments.length} 段 · 第 ${this.active + 1} 段`;
    const detail = curveParamsText(this.curve);
    this.presetEl.textContent = detail ? `${curveLabel(this.curve)} · ${detail}` : curveLabel(this.curve);
    this.presetEl.title = this.presetEl.textContent;
  }

  /** Rail tab that contains the current curve (custom bezier counts as 基础). */
  _groupIndex() {
    const c = normalizeCurve(this.curve);
    const id = c?.preset || (c?.type === 'bezier' ? 'linear' : c?.type);
    if (!id) return 0;
    const idx = CURVE_GROUPS.findIndex((g) => g.items.some((it) => it.id === id));
    return idx >= 0 ? idx : 0;
  }

  _syncRailGroup() {
    const idx = this._groupIndex();
    if (idx !== this.railGroup) {
      this.railGroup = idx;
      this._buildRail();
    } else {
      this._markPreset();
    }
  }

  _buildRail() {
    this.rail.innerHTML = '';
    const tabs = el('div', 'cp-tabs');
    CURVE_GROUPS.forEach((group, i) => {
      const tab = el('button', `cp-tab${i === this.railGroup ? ' on' : ''}`, group.short || group.title);
      tab.title = group.title;
      tab.onclick = () => {
        if (i === this.railGroup) return;
        this.railGroup = i;
        this._buildRail();
      };
      tabs.append(tab);
    });
    const grid = el('div', 'cp-thumbs');
    const group = CURVE_GROUPS[this.railGroup] || CURVE_GROUPS[0];
    for (const item of group.items) {
      const b = el('button', `cp-thumb${item.ready ? '' : ' disabled'}`);
      b.dataset.preset = item.id;
      b.title = item.label;
      const cv = document.createElement('canvas');
      cv.width = 68; cv.height = 34;
      this._drawThumb(cv, item.id, item.ready);
      b.append(cv, el('span', '', item.label));
      b.onclick = item.ready
        ? () => this._applyPreset(item.id)
        : () => this.toast?.(`「${item.label}」还没做`);
      grid.append(b);
    }
    this.rail.append(tabs, grid);
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
    ctx.strokeStyle = ready ? C('--accent') : C('--text-disabled');
    ctx.lineWidth = 1.5;
    const curve = ready ? presetCurve(id) : null;
    const range = curve ? curveRange(curve) : [0, 1];
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const u = i / 64;
      const raw = curve ? sampleCurve(curve, u) : u;
      const v = clamp(raw, range[0], range[1]);
      const x = 5 + u * (w - 10);
      const y = h - 5 - ((v - range[0]) / (range[1] - range[0])) * (h - 10);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (!ready) {
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = C('--border-strong');
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
   * The value window comes from `curveRange` so overshoot handles stay visible.
   */
  _geo() {
    const L = this._layout();
    const tl = this.getTimeline();
    const gutter = tl?._gutter?.() || 340;
    const pps = tl?.pps || 60;
    const scroll = tl?.scroll?.scrollLeft || 0;
    const plotLeft = Math.max(0, gutter - scroll);
    const plotRight = L.W - L.rightPad;
    const xOf = (t) => gutter + Number(t) * pps - scroll;
    const tOf = (x) => (x + scroll - gutter) / Math.max(1, pps);
    const range = this._curveWindow();
    const height = Math.max(1, L.bottom - L.top);
    const yOf = (v) => L.bottom - ((Number(v) - range[0]) / (range[1] - range[0])) * height;
    const vOf = (y) => range[0] + ((L.bottom - y) / height) * (range[1] - range[0]);
    return { ...L, gutter, pps, scroll, plotLeft, plotRight, range, xOf, tOf, yOf, vOf };
  }

  _handlePos(seg, g, handle) {
    if (!handle) return null;
    return {
      x: g.xOf(seg.from + handle.u * (seg.to - seg.from)),
      y: g.yOf(handle.v),
      u: handle.u,
      v: handle.v,
      handle,
    };
  }

  _handleOrigin(seg, g, handle) {
    if (!handle?.origin) return null;
    return {
      x: g.xOf(seg.from + handle.origin[0] * (seg.to - seg.from)),
      y: g.yOf(handle.origin[1]),
    };
  }

  _tickStep(span) {
    const raw = Math.max(1e-9, (span || 1) / 6);
    const pow = 10 ** Math.floor(Math.log10(raw));
    const mult = raw / pow <= 1 ? 1 : raw / pow <= 2 ? 2 : raw / pow <= 5 ? 5 : 10;
    return mult * pow;
  }

  _handlePosSpan(g, span, handle) {
    if (!span || !handle) return null;
    return {
      x: g.xOf(span.from + handle.u * (span.to - span.from)),
      y: g.yOf(handle.v),
      u: handle.u,
      v: handle.v,
      span,
      handle,
    };
  }

  _handleOriginSpan(g, span, handle) {
    if (!span || !handle?.origin) return null;
    return {
      x: g.xOf(span.from + handle.origin[0] * (span.to - span.from)),
      y: g.yOf(handle.origin[1]),
    };
  }

  _isSelectedKey(t) {
    return !!this.path?.selected.some((x) => Math.abs(x - t) <= 1e-4);
  }

  _isSelectedSegment(span) {
    return !!this.path?.segments.some((s) => Math.abs(s.from - span.from) <= 1e-4
      && Math.abs(s.to - span.to) <= 1e-4);
  }

  /** Spans whose handles are editable for the current selection. */
  _pathEditableSpans() {
    const p = this.path;
    if (!p) return [];
    if (p.selected.length < 2) return p.spans;
    const from = p.selected[0];
    const to = p.selected[p.selected.length - 1];
    return p.spans.filter((s) => s.to > from + 1e-4 && s.from < to - 1e-4);
  }

  _drawPlayhead(ctx, g) {
    const tl = this.getTimeline();
    const px = g.xOf(tl?.time ?? 0);
    if (px <= g.plotLeft || px >= g.plotRight) return;
    ctx.strokeStyle = C('--playhead');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, g.top); ctx.lineTo(px, g.bottom); ctx.stroke();
  }

  /** Camera flight: draw every real span, then selection + keyframe markers. */
  _drawPathSpan(ctx, g) {
    const { W } = g;
    const p = this.path;
    if (!p) return;
    const view0 = g.tOf(g.plotLeft);
    const view1 = g.tOf(W - g.rightPad);

    // Selection bands: each adjacent selected pair is one segment.
    for (const seg of p.segments) {
      const x0 = g.xOf(Math.max(seg.from, view0));
      const x1 = g.xOf(Math.min(seg.to, view1));
      if (x1 <= x0) continue;
      ctx.fillStyle = this._segmentCurve(seg)
        ? alpha(C('--accent'), 0.06)
        : alpha(C('--edit'), 0.045);
      ctx.fillRect(x0, g.top, Math.max(1, x1 - x0), g.bottom - g.top);
      ctx.strokeStyle = alpha(C('--accent'), 0.22);
      ctx.lineWidth = 1;
      for (const x of [x0, x1]) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, g.top); ctx.lineTo(x + 0.5, g.bottom); ctx.stroke();
      }
    }

    // Real stored spans, clipped to the visible time window.
    for (const span of p.spans) {
      const t0 = Math.max(span.from, view0);
      const t1 = Math.min(span.to, view1);
      if (t1 <= t0) continue;
      const x0 = g.xOf(t0);
      const x1 = g.xOf(t1);
      const full = Math.max(1e-6, span.to - span.from);
      const steps = Math.max(40, Math.round(x1 - x0));
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const x = x0 + ((x1 - x0) * s) / steps;
        const u = clamp((g.tOf(x) - span.from) / full, 0, 1);
        const y = g.yOf(sampleCurve(span.curve, u));
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const active = this._isSelectedSegment(span);
      ctx.strokeStyle = active ? C('--accent') : alpha(C('--accent'), 0.38);
      ctx.lineWidth = active ? 2.2 : 1.4;
      ctx.stroke();
    }

    // Selected segments that have no stored curve yet. A segment that is
    // already covered by an older span keeps its real curve visible above;
    // only mark the ones with no data at all.
    for (const seg of p.segments) {
      if (this._segmentCurve(seg)) continue;
      const covered = p.spans.some((s) => s.to > seg.from + 1e-4 && s.from < seg.to - 1e-4);
      if (covered) continue;
      const x0 = g.xOf(Math.max(seg.from, view0));
      const x1 = g.xOf(Math.min(seg.to, view1));
      if (x1 - x0 < 44) continue;
      ctx.fillStyle = alpha(C('--edit'), 0.55);
      ctx.font = canvasFont();
      ctx.fillText('未应用', (x0 + x1) / 2 - 15, g.top + 14);
    }

    // All keyframes, selected (boundaries) bright, internal ones dimmed.
    for (const key of p.keys) {
      const x = g.xOf(key.t);
      if (x < g.plotLeft - 8 || x > W - g.rightPad + 8) continue;
      const on = this._isSelectedKey(key.t);
      if (on) {
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = alpha(C('--edit'), 0.4);
        ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = on ? 4.5 : 2.8;
      ctx.save();
      ctx.translate(x, g.bottom);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = on ? C('--edit') : alpha(C('--text-2'), 0.5);
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }

    // Editable curve handles for the spans intersecting the selection.
    for (const span of this._pathEditableSpans()) {
      for (const handle of curveHandles(span.curve)) {
        const hp = this._handlePosSpan(g, span, handle);
        if (!hp) continue;
        const visible = hp.x >= g.plotLeft - 14 && hp.x <= W - g.rightPad + 14
          && hp.y >= g.top - 14 && hp.y <= g.bottom + 14;
        if (!visible) continue;
        const origin = this._handleOriginSpan(g, span, handle);
        if (origin) {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = alpha(C('--text-2'), 0.3);
          ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(hp.x, hp.y); ctx.stroke();
          ctx.setLineDash([]);
        }
        const active = this.drag?.handle?.id === handle.id
          && this.drag?.span === span;
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, active ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = C('--text-1');
        ctx.fill();
        ctx.strokeStyle = C('--accent-hover');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------ draw
  draw() {
    if (!this.isOpen() || !this.openState) return;
    const g = this._geo();
    const { W, H, dpr } = g;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C('--surface-0');
    ctx.fillRect(0, 0, W, H);

    // value grid + labels (window depends on the curve's overshoot)
    ctx.font = canvasFont();
    const [vMin, vMax] = g.range;
    const tick = this._tickStep(vMax - vMin);
    for (let v = Math.ceil(vMin / tick) * tick; v <= vMax + 1e-9; v += tick) {
      const value = Math.abs(v) < 1e-9 ? 0 : v;
      const y = g.yOf(value);
      ctx.strokeStyle = C('--border-subtle');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.plotLeft, y + 0.5); ctx.lineTo(W - g.rightPad, y + 0.5); ctx.stroke();
      ctx.fillStyle = C('--text-3');
      ctx.fillText(value.toFixed(tick < 1 ? 2 : 1), 8, y + 3);
    }
    ctx.strokeStyle = C('--border-strong');
    ctx.setLineDash([3, 4]);
    for (const edge of [0, 1]) {
      if (edge <= vMin || edge >= vMax) continue;
      const y = g.yOf(edge);
      ctx.beginPath(); ctx.moveTo(g.plotLeft, y + 0.5); ctx.lineTo(W - g.rightPad, y + 0.5); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = C('--text-3');
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
      ctx.strokeStyle = C('--border-subtle');
      ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke();
      ctx.fillStyle = C('--text-3');
      const label = step >= 1 ? `${Math.round(t * 100) / 100}s` : `${t.toFixed(2)}s`;
      ctx.fillText(label, x + 3, H - 7);
    }

    if (this._isPathMode() && this.span) {
      this._drawPathSpan(ctx, g);
      this._drawPlayhead(ctx, g);
      return;
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
        ctx.fillStyle = alpha(C('--accent'), 0.05);
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
      ctx.strokeStyle = isActive ? C('--accent') : alpha(C('--accent'), 0.4);
      ctx.lineWidth = isActive ? 2.2 : 1.4;
      ctx.stroke();
      ctx.fillStyle = isActive ? C('--text-1') : C('--text-3');
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
      for (const handle of curveHandles(this.curve)) {
        const hp = this._handlePos(seg, g, handle);
        if (!hp) continue;
        const visible = hp.x >= g.plotLeft - 14 && hp.x <= W - g.rightPad + 14
          && hp.y >= g.top - 14 && hp.y <= g.bottom + 14;
        if (!visible) continue;
        const origin = this._handleOrigin(seg, g, handle);
        if (origin) {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = alpha(C('--text-2'), 0.35);
          ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(hp.x, hp.y); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = alpha(C('--text-2'), 0.32);
        ctx.beginPath(); ctx.moveTo(g.plotLeft, hp.y); ctx.lineTo(W - g.rightPad, hp.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(hp.x, g.top); ctx.lineTo(hp.x, g.bottom); ctx.stroke();
        ctx.setLineDash([]);
        const active = this.drag?.handle?.id === handle.id;
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, active ? 9.5 : 8, 0, Math.PI * 2);
        ctx.fillStyle = C('--text-1');
        ctx.fill();
        ctx.strokeStyle = C('--accent-hover');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // playhead
    this._drawPlayhead(ctx, g);
  }

  // ------------------------------------------------------------ interaction
  _localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _hitHandle(x, y) {
    const g = this._geo();
    if (this._isPathMode()) {
      let best = null;
      for (const span of this._pathEditableSpans()) {
        for (const handle of curveHandles(span.curve)) {
          const hp = this._handlePosSpan(g, span, handle);
          if (!hp) continue;
          const d = Math.hypot(hp.x - x, hp.y - y);
          if (d <= 15 && (!best || d < best.d)) best = { span, handle, d };
        }
      }
      return best ? { span: best.span, handle: best.handle } : null;
    }
    const seg = this._track()?.segments[this.active];
    if (!seg) return null;
    let best = null;
    for (const handle of curveHandles(this.curve)) {
      const hp = this._handlePos(seg, g, handle);
      if (!hp) continue;
      const d = Math.hypot(hp.x - x, hp.y - y);
      if (d <= 15 && (!best || d < best.d)) best = { handle, d };
    }
    return best?.handle || null;
  }

  _hitPathKey(x, y) {
    const p = this.path;
    if (!p) return null;
    const g = this._geo();
    if (Math.abs(y - g.bottom) > 14) return null;
    let best = null;
    for (const key of p.keys) {
      const kx = g.xOf(key.t);
      if (kx < g.plotLeft - 8 || kx > g.plotRight + 8) continue;
      const d = Math.abs(kx - x);
      if (d <= 10 && (!best || d < best.d)) best = { t: key.t, d };
    }
    return best?.t ?? null;
  }

  /** Panel key clicks use the same pool rules as the timeline lanes. */
  _pickPathKey(t, ev) {
    const additive = !!(ev?.ctrlKey || ev?.metaKey || ev?.shiftKey);
    let selected = this.path?.selected || [];
    if (additive) {
      selected = selected.some((x) => Math.abs(x - t) <= 1e-4)
        ? selected.filter((x) => Math.abs(x - t) > 1e-4)
        : [...selected, t];
    } else {
      selected = [t];
    }
    this._setPathSelection(selected);
  }

  _setPathSelection(times) {
    if (!this.openState || !this.path) return;
    const unique = [...new Set(times.map((t) => Math.round(Number(t) * 1000) / 1000))]
      .sort((a, b) => a - b);
    this.openState.selectedTimes = unique;
    this._refreshSpan();
    this._spanNotice = null;
    const camId = this.path?.cameraId;
    if (camId) {
      const ids = unique.map((t) => keyframeRef(cameraRef(camId), 'path', t));
      this.onSelect?.(ids.length
        ? { kind: 'keyframe', ids, primary: ids[0] }
        : { kind: null, ids: [], primary: null });
    }
    this._syncHead();
    this._syncRailGroup();
    this.draw();
  }

  _down(e) {
    if (e.button !== 0) return;
    const p = this._localPoint(e);
    if (this._isPathMode()) {
      e.preventDefault();
      const hit = this._hitHandle(p.x, p.y);
      if (hit) {
        const span = hit.span;
        this._spanBackup = {
          left: span.left,
          curve: normalizeCurve(span.left.curve),
          spanTo: span.left.spanTo,
          inner: span.inner.slice(),
          times: span.inner.map((k) => k.t),
        };
        this.drag = {
          mode: 'path',
          handle: hit.handle,
          span,
          curve: span.curve,
          pointer: p,
          range: this._geo().range,
        };
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      const keyT = this._hitPathKey(p.x, p.y);
      if (keyT != null) {
        this._pickPathKey(keyT, e);
        return;
      }
      this._setPathSelection([]);
      return;
    }
    const handle = this._hitHandle(p.x, p.y);
    if (handle) {
      e.preventDefault();
      this._spanBackup = null;
      this.drag = {
        mode: 'segment',
        handle,
        seg: this.active,
        curve: this.curve,
        pointer: p,
        range: this._geo().range,
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
      this._syncRailGroup();
      this.draw();
    }
  }

  _move(e) {
    if (!this.drag) return;
    const drag = this.drag;
    const handle = drag.handle;
    const g = this._geo();
    const p = this._localPoint(e);
    const from = drag.mode === 'path' ? drag.span.from : this._track()?.segments[drag.seg]?.from;
    const to = drag.mode === 'path' ? drag.span.to : this._track()?.segments[drag.seg]?.to;
    if (from == null || to == null) return;
    const spanPx = Math.max(1, g.xOf(to) - g.xOf(from));
    const plotH = Math.max(1, g.bottom - g.top);
    const damping = Number.isFinite(handle.damping) ? handle.damping : 1;
    const u = clamp(handle.u + ((p.x - drag.pointer.x) / spanPx) * damping, 0, 1);
    let v = handle.v + (-(p.y - drag.pointer.y) / plotH) * (drag.range[1] - drag.range[0]) * damping;
    if (handle.id === 'p1' || handle.id === 'p2') {
      v = clamp(v, -1, 2);
    } else {
      v = handle.allowOvershoot ? clamp(v, drag.range[0], drag.range[1]) : clamp(v, 0, 1);
    }
    this.curve = moveCurveHandle(drag.curve, handle.id, u, v);
    if (drag.mode === 'path') {
      drag.span.curve = this.curve;
      drag.span.left.curve = this.curve;
      drag.span.left.spanTo = drag.span.to;
      this._scheduleLiveSpan();
    }
    this._syncHead();
    this._markPreset();
    this.draw();
  }

  _up() {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    this.canvas.style.cursor = '';
    if (drag.mode === 'path') {
      const pending = this._commitPathSpan(drag.span);
      if (pending?.then) {
        pending.then((j) => {
          if (j) this._spanBackup = null;
          else this._restoreSpanBackup();
        });
      } else {
        this._spanBackup = null;
      }
      return;
    }
    const seg = this._track()?.segments[drag.seg];
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
    if (this._isPathMode()) {
      this._applyPathPreset(curve);
      return;
    }
    this.curve = curve;
    this._syncHead();
    this._syncRailGroup();
    this.draw();
    this._commit(curve, this._track()?.segments || []);
  }

  /**
   * Apply one preset to every segment between adjacent selected keys. Any old
   * span intersecting the selection is cleared first (its whole range), then
   * each selected pair becomes its own span and retimes its dimmed inner keys.
   */
  _applyPathPreset(curve) {
    const p = this.path;
    if (!p || p.selected.length < 2 || !p.segments.length) {
      this.toast?.('至少选中两个关键帧才能套用曲线', 'warn');
      return;
    }
    const from = p.selected[0];
    const to = p.selected[p.selected.length - 1];
    const ops = [];
    for (const span of p.spans) {
      if (span.to > from + 1e-4 && span.from < to - 1e-4) {
        ops.push({
          op: 'keyCurve', host: 'camera', id: p.cameraId, path: 'path',
          from: Math.round(span.from * 1000) / 1000,
          to: Math.round(span.to * 1000) / 1000,
          curve: null,
        });
      }
    }
    for (const seg of p.segments) {
      ops.push({
        op: 'keyCurve', host: 'camera', id: p.cameraId, path: 'path',
        from: Math.round(seg.from * 1000) / 1000,
        to: Math.round(seg.to * 1000) / 1000,
        curve: normalizeCurve(curve),
      });
    }
    this.curve = curve;
    this._syncHead();
    this._syncRailGroup();
    this.draw();
    const pending = this.onOp?.(ops.length === 1 ? ops[0] : { op: 'batch', ops });
    if (pending?.then) {
      pending.then((j) => {
        if (!j) {
          this._refreshSpan();
          this._syncHead();
          this._syncRailGroup();
          this.draw();
        } else {
          this.toast?.(`已套用 ${curveLabel(curve)} · ${p.segments.length} 段`, 'info');
        }
      });
    }
  }

  _commitPathSpan(span) {
    if (!span || !this.path) return null;
    return this.onOp?.({
      op: 'keyCurve',
      host: 'camera',
      id: this.path.cameraId,
      path: 'path',
      from: Math.round(Number(span.from) * 1000) / 1000,
      to: Math.round(Number(span.to) * 1000) / 1000,
      curve: normalizeCurve(this.curve),
    });
  }

  _scheduleLiveSpan() {
    if (this._liveRaf) return;
    this._liveRaf = requestAnimationFrame(() => {
      this._liveRaf = 0;
      this._applyLiveSpan();
    });
  }

  /**
   * Live drag preview for one stored span: write the curve/times into the
   * in-memory project (no rev, no history) and let main re-render the viewport
   * and timeline. The real op is sent on pointerup; a failure restores the backup.
   */
  _applyLiveSpan() {
    if (!this.drag || this.drag.mode !== 'path' || !this.drag.span) return;
    const cam = this._camera();
    if (!cam) return;
    const span = this.drag.span;
    const curve = normalizeCurve(this.curve);
    if (!curve) return;
    span.curve = curve;
    span.left.curve = curve;
    span.left.spanTo = span.to;
    const retime = retimePathSpan(cam, span.from, span.to, curve);
    if (retime?.times) retime.times.forEach((t, j) => { if (span.inner[j]) span.inner[j].t = t; });
    this.onLivePreview?.(cam.id);
  }

  _restoreSpanBackup() {
    const b = this._spanBackup;
    this._spanBackup = null;
    if (!b?.left) return;
    if (b.curve) b.left.curve = b.curve;
    else delete b.left.curve;
    if (b.spanTo != null) b.left.spanTo = b.spanTo;
    else delete b.left.spanTo;
    (b.inner || []).forEach((k, j) => { k.t = b.times[j]; });
    this.previewInner = null;
    this.onLivePreview?.();
    if (this.isOpen()) {
      this._refreshSpan();
      this._syncHead();
      this.draw();
    }
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
