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
// through moveCurveHandle.
//
// Scalar tracks draw the whole property track as one continuous line on a
// real-value y axis (docs/DESIGN-CURVEPANEL-V2.md §2/§6): every pixel column
// samples core/time.js::sampleTrack, which is the same evaluator the preview
// uses, so keys sit exactly where the element will be. The camera flight track
// keeps its progress 0..1 axis — its stored curves are progress shapes, not
// values, and its view is unchanged by the scalar rework.
import {
  sampleCurve, normalizeCurve, presetCurve, curveLabel, curveSegments, CURVE_GROUPS,
  curveHandles, moveCurveHandle, curveRange, curveParamsText,
} from '/core/curves.js';
import { retimePathSpan } from '/core/camera.js';
import { spanCurveOps, curveFromEase, spanProgress, retimeSpanTimes } from '/core/curve-spans.js';
import { sampleTrack } from '/core/time.js';
import { cameraRef, elementRef, keyframeRef, objectRef, splitRef } from '/core/selection.js';
import { h, icon, token } from './ui.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Numeric value of one key. Element keyframes store `value`, scene object and
 * camera channels store `v`; colours, text and vectors have no numeric value
 * (they still draw, see the step band in draw()).
 */
const keyValue = (key) => {
  const raw = key?.value !== undefined ? key.value : key?.v;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

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
  'transform.z': '纵深 Z', 'transform.rotation': '旋转', 'transform.opacity': '不透明度',
  'style.size': '字号', 'style.color': '颜色',
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
    this.selected = [];
    this.marquee = null;
    this._playheadT = NaN;
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
      + '<span>拖动框选关键帧（Ctrl/Shift 加选）</span><span class="cp-sep">|</span>'
      + '<span>点段切换编辑段</span><span class="cp-sep">|</span>'
      + '<span>预设作用于选中段</span><span class="cp-sep">|</span>'
      + '<span>时间轴缩放同步（Ctrl+滚轮 / 缩放按钮）</span><span class="cp-sep">|</span>'
      + '<span><b>F2</b> / <b>Esc</b> 关闭</span>';
    this.root.append(head, body, foot);
    this.host.appendChild(this.root);

    this.canvas.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    this.canvas.addEventListener('pointermove', (e) => this._hover(e));
    // Capture phase: the panel edits keys, so Esc must reach it before the
    // window-level shortcut that closes the drawer (design §8, Esc three steps).
    window.addEventListener('keydown', (e) => this._onKey(e), true);
    window.addEventListener('resize', () => { if (this.isOpen()) this.draw(); });
  }

  /** True when focus is in a field the panel must not steal keys from. */
  _isTypingTarget(node) {
    const tag = String(node?.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'select' || tag === 'textarea' || node?.isContentEditable === true;
  }

  /**
   * Esc, in that order: cancel the gesture in flight → drop the pool (the
   * selection came from the timeline, so clearing is undoable and cheap) →
   * close. Anything else is left to the global shortcut table.
   */
  _onKey(e) {
    if (!this.isOpen() || !this.openState) return;
    if (this._isTypingTarget(e.target)) return;
    // Editing keys only: Escape (three steps), Tab (next row), arrows (nudge).
    if (e.key === 'Escape') {
      e.preventDefault();
      // Main's shortcut table uses a capture listener on the same window
      // target, where stopPropagation() is not enough: only the immediate
      // variant keeps Esc from also closing the drawer in the same keystroke.
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (this.drag || this.marquee) { this._cancelGesture(); return; }
      if (this.selected.length) {
        this.onSelect?.({ kind: 'keyframe', ids: [] });
        return;
      }
      this.close();
      return;
    }
    if (e.key === 'Tab') {
      if (!this._cycleRow(e.shiftKey ? -1 : 1)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      || e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (!isArrow) return;
    const moved = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      ? this._nudgeSelected(e.key === 'ArrowLeft' ? -step : step, 0)
      : this._nudgeSelected(0, e.key === 'ArrowUp' ? this._valueStep() * step : -this._valueStep() * step);
    if (!moved) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** Frame rate the panel snaps to (project meta, 24 default). */
  _fps() {
    const fps = Number(this.getProject?.()?.meta?.fps);
    return Number.isFinite(fps) && fps > 0 ? fps : 24;
  }

  /** Arrow-key value step: a hundredth of the track's own range. */
  _valueStep() {
    const track = this._track();
    const keys = this._trackKeys(track?.path);
    const values = keys.map((k) => keyValue(k)).filter((v) => v != null);
    if (!values.length) return 0;
    const span = Math.max(...values) - Math.min(...values);
    const step = Math.max(1e-4, (span || Math.abs(values[0]) || 1) / 100);
    return Math.round(step * 1e4) / 1e4;
  }

  /** Keep a nudged value inside the range the property obviously has. */
  _clampValue(path, value) {
    let v = Number(value);
    if (!Number.isFinite(v)) return v;
    if (/(^|\.)opacity$/.test(String(path))) v = clamp(v, 0, 1);
    return Math.round(v * 1000) / 1000;
  }

  /**
   * Ops that move one key (and optionally change its value) while keeping its
   * ease, curve and — for scene objects — its bezier handles. A move is
   * unkey + key in one batch: there is no server-side "move" op (§17).
   */
  _keyMoveOps(path, key, t, value) {
    const st = this.openState;
    if (!st || !key) return [];
    const from = Math.round(Number(key.t) * 1000) / 1000;
    const to = Math.round(Number(t) * 1000) / 1000;
    const changedTime = Math.abs(to - from) > 1e-4;
    if (!changedTime && value === undefined) return [];
    if (st.host === 'element') {
      const next = { op: 'keySet', id: st.id, path, t: to, value: value === undefined ? key.value : value };
      if (key.ease != null) next.ease = key.ease;
      next.curve = key.curve ?? null;
      return [{ op: 'keyRemove', id: st.id, path, t: from }, next];
    }
    const unkey = st.host === 'object' ? 'objectUnkey' : 'cameraParamUnkey';
    const setOp = st.host === 'object' ? 'objectKey' : 'cameraParamKey';
    const next = { op: setOp, id: st.id, path, t: to, v: value === undefined ? key.v : value };
    if (key.ease != null) next.ease = key.ease;
    next.curve = key.curve ?? null;
    for (const h of ['out', 'in', 'speed']) if (key[h] != null) next[h] = key[h];
    return [{ op: unkey, id: st.id, path, t: from }, next];
  }

  /**
   * Arrows: ←/→ move every selected key by whole frames (Shift = 10), ↑/↓ step
   * its value. Keys that would land on a neighbour are skipped, not stacked.
   */
  _nudgeSelected(deltaFrames, deltaValue) {
    const path = this._track()?.path;
    if (!path) return false;
    const keys = this._trackKeys(path);
    const selected = this._selectedFor(path);
    if (!selected.length) return false;
    const fps = this._fps();
    const ops = [];
    for (const t of selected) {
      const key = keys.find((k) => Math.abs(Number(k.t) - t) <= 1e-4);
      if (!key) continue;
      let nextT = Number(key.t);
      if (deltaFrames) {
        const frame = Math.max(0, Math.round(Number(key.t) * fps) + deltaFrames);
        nextT = frame / fps;
      }
      let value;
      if (deltaValue) {
        const v = keyValue(key);
        if (v == null) continue;
        value = this._clampValue(path, v + deltaValue);
      }
      if (Math.abs(nextT - Number(key.t)) > 1e-4
        && keys.some((k) => k !== key && Math.abs(Number(k.t) - nextT) <= 1e-4)) continue;
      ops.push(...this._keyMoveOps(path, key, nextT, value));
    }
    if (!ops.length) return false;
    this.onOp?.(ops.length === 1 ? ops[0] : { op: 'batch', ops });
    return true;
  }

  /** Tab: step through the property rows the drawer knows about (wraps). */
  _cycleRow(dir) {
    const st = this.openState;
    const tracks = st?.tracks || [];
    if (tracks.length < 2) return false;
    const index = (st.index + (dir > 0 ? 1 : tracks.length - 1)) % tracks.length;
    this.open({ ...st, index }, { reveal: false });
    this._jumpPlayhead();
    return true;
  }

  /**
   * Put the playhead on the first selected key of the displayed track when it
   * is outside that track's selected range (design §6). No extra scrolling.
   */
  _jumpPlayhead() {
    const tl = this.getTimeline();
    const track = this._track();
    if (!tl || !track || typeof tl.setTime !== 'function') return;
    const sel = this._selectedFor(track.path);
    if (!sel.length) return;
    const t = Number(tl.time) || 0;
    if (t >= sel[0] - 1e-4 && t <= sel[sel.length - 1] + 1e-4) return;
    tl.setTime(sel[0]);
  }

  /** Abandon the gesture under the pointer and put the panel back. */
  _cancelGesture() {
    const drag = this.drag;
    this.drag = null;
    this.marquee = null;
    this.canvas.style.cursor = '';
    if (drag?.mode === 'path') {
      this._restoreSpanBackup();
      if (this.isOpen()) this.draw();
      return;
    }
    if (drag?.mode === 'spanCurve') {
      this.curve = drag.baseCurve;
      this._restoreLiveSpans();
      return;
    }
    if (drag?.curve) this.curve = drag.curve;
    if (this.isOpen()) {
      this._syncHead();
      this._syncRailGroup();
      this.draw();
    }
  }

  isOpen() { return !this.root.hidden; }

  // ------------------------------------------------------------ open / close
  open(state, { reveal = true } = {}) {
    this.openState = state;
    // The F2 pool decides what the panel is about: every selected key of this
    // host, across property tracks. It is never replaced by an invented range.
    this.selected = Array.isArray(state?.selected)
      ? state.selected
        .map((s) => ({ path: String(s.path || ''), t: Number(s.t) }))
        .filter((s) => s.path && Number.isFinite(s.t))
      : [];
    this.marquee = null;
    this.active = 0;
    this._spanNotice = null;
    const track = this._track();
    if (track?.path === 'path') this._refreshSpan();
    else {
      const segs = track?.segments || [];
      const first = this._selectedFor(track?.path)[0];
      const i = first == null ? 0 : segs.findIndex((s) => Math.abs(s.from - first) <= 1e-4);
      this.active = i >= 0 ? i : 0;
      this.curve = normalizeCurve(segs[this.active]?.a?.curve) || presetCurve('easeInOut');
    }
    this.root.hidden = false;
    this.railGroup = this._groupIndex();
    this._buildRail();
    this._buildPathSelect();
    this._syncHead();
    if (reveal) {
      this._reveal();
      this._jumpPlayhead();
    }
    this.draw();
  }

  /**
   * The timeline selection changed while the drawer is open (design §3): the
   * pool is live state, not a snapshot. Keep the displayed row when it still
   * owns selected keys, otherwise jump to the busiest one — without reopening,
   * zooming or scrolling.
   *
   * @param {{kind?: string, ids?: string[]}|null} pool keyframe refs
   */
  setSelection(pool) {
    if (!this.isOpen() || !this.openState) return;
    const parsed = (Array.isArray(pool?.ids) ? pool.ids : [])
      .map((ref) => splitRef(ref))
      .filter((part) => part && part.path && Number.isFinite(Number(part.t)))
      .map((part) => ({ path: part.path, t: Math.round(Number(part.t) * 1000) / 1000 }));
    const same = parsed.length === this.selected.length
      && parsed.every((s) => this.selected.some((o) => o.path === s.path
        && Math.abs(o.t - s.t) <= 1e-4));
    if (same) return;
    const tracks = this.openState.tracks || [];
    const counts = new Map();
    for (const s of parsed) counts.set(s.path, (counts.get(s.path) || 0) + 1);
    let index = this.openState.index;
    if (!counts.get(tracks[index]?.path)) {
      let best = -1;
      let bestCount = 0;
      tracks.forEach((track, i) => {
        const n = counts.get(track.path) || 0;
        if (n > bestCount) { best = i; bestCount = n; }
      });
      if (best >= 0) index = best;
    }
    this.open({ ...this.openState, index, selected: parsed }, { reveal: false });
  }

  /** Scroll the timeline so the edited segment (or first selected key) is visible. */
  _reveal() {
    const tl = this.getTimeline();
    const track = this._track();
    const seg = this._isPathMode() && this.span
      ? { from: this.span.from }
      : track?.segments[this.active] || track?.segments[0];
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
    // The panel never invents a selection: with no selected path key the whole
    // path is the edit scope and no key is drawn as selected.
    const selected = this._selectedFor('path').filter((t) => find(t) >= 0);

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
    this.curve = firstCurve || (spans.length ? spans[0].curve : null);
    if (this.openState) {
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

  /**
   * Progress window for the camera flight view. Flight spans store progress
   * curves (0..1 between keys), so this axis stays in curve space; every
   * stored span's overshoot is included so its handles stay reachable.
   */
  _progressWindow() {
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

  /**
   * Real-value window for the whole displayed track (§2/§6): keys define the
   * range, segments with a stored curve add their overshoot so bounce/elastic
   * peaks stay on screen, and the final window keeps 8% headroom on each side
   * so the line never touches the frame.
   */
  _valueWindow() {
    const keys = this._trackKeys(this._track()?.path);
    const values = [];
    for (const key of keys) {
      const v = keyValue(key);
      if (v != null) values.push(v);
    }
    let min;
    let max;
    if (values.length >= 2 && Math.max(...values) > Math.min(...values)) {
      min = Math.min(...values);
      max = Math.max(...values);
    } else {
      // One key, equal values or a colour track: no span to scale to, so give
      // the axis room to breathe around the value we do have.
      const center = values[0] ?? 0;
      const pad = Math.max(Math.abs(center) * 0.1, 1);
      min = center - pad;
      max = center + pad;
    }
    const span = Math.max(1e-9, max - min);
    // A curve's progress range maps through the pair's value delta; a pair
    // with no value span still gets a little room so its handle is grabbable.
    let lo = min;
    let hi = max;
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keyValue(keys[i]);
      const b = keyValue(keys[i + 1]);
      const curve = normalizeCurve(keys[i]?.curve);
      if (a == null || b == null || !curve) continue;
      const [p0, p1] = curveRange(curve);
      const v0 = a + (b - a) * p0;
      const v1 = a + (b - a) * p1;
      const below = Math.max(0, min - Math.min(v0, v1));
      const above = Math.max(0, Math.max(v0, v1) - max);
      lo = Math.min(lo, min - Math.max(below, span * 0.06));
      hi = Math.max(hi, max + Math.max(above, span * 0.06));
    }
    const room = Math.max(1e-9, hi - lo) * 0.08;
    return [lo - room, hi + room];
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
    this.selected = [];
    this.marquee = null;
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
    const counts = new Map();
    for (const s of this.selected) counts.set(s.path, (counts.get(s.path) || 0) + 1);
    st.tracks.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      const n = counts.get(t.path) || 0;
      o.textContent = `${t.label || t.path}${n ? ` · ${n} 键` : ''}`;
      this.pathSel.appendChild(o);
    });
    this.pathSel.value = String(st.index);
    this.pathSel.hidden = st.tracks.length < 2;
  }

  _syncHead() {
    const st = this.openState;
    const track = this._track();
    if (!st || !track) return;
    const poolPaths = this._selectedPaths();
    // One line tells the whole scope: which element/object/camera, which
    // property, and how much of the timeline pool this drawer is acting on.
    const poolText = this.selected.length
      ? ` · 池 ${this.selected.length} 键 / ${poolPaths.length} 属性`
      : '';
    const hostName = this._hostName();
    this.titleEl.textContent = hostName
      ? `曲线 · ${hostName} · ${track.label || track.path}`
      : `曲线 · ${track.label || track.path}`;
    if (track.path === 'path' && this.path) {
      const p = this.path;
      const curves = p.segments.map((seg) => this._segmentCurve(seg));
      const applied = curves.filter(Boolean);
      const same = applied.length === curves.length && applied.length > 0
        && applied.every((c) => JSON.stringify(c) === JSON.stringify(applied[0]));
      const from = p.selected.length ? p.selected[0] : p.keys[0].t;
      const to = p.selected.length ? p.selected[p.selected.length - 1] : p.keys[p.keys.length - 1].t;
      this.rangeEl.textContent = p.selected.length === 1
        ? `${from.toFixed(2)}s · 1 键 · ${p.spans.length} 条已存曲线`
        : p.selected.length
          ? `${from.toFixed(2)}s → ${to.toFixed(2)}s · ${p.selected.length} 键 · ${p.segments.length} 段 · ${p.spans.length} 条已存曲线`
          : `整条轨迹 ${from.toFixed(2)}s → ${to.toFixed(2)}s · 未选关键帧 · ${p.spans.length} 条已存曲线`;
      let label;
      if (!p.selected.length) {
        label = p.spans.length ? `${curveLabel(p.spans[0].curve)} · 点预设套用整条` : '未应用 · 点预设套用整条轨迹';
      } else if (p.selected.length === 1) {
        label = '再选一个关键帧才能成段';
      } else if (same) {
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
    const sel = this._selectedFor(track.path);
    const pairs = sel.length ? this._selectedPairs(track.path) : [];
    if (sel.length) {
      const span = sel.length === 1
        ? `${sel[0].toFixed(2)}s · 1 键`
        : `${sel[0].toFixed(2)}s → ${sel[sel.length - 1].toFixed(2)}s · ${sel.length} 键`;
      this.rangeEl.textContent = `${span} · ${pairs.length} 段${poolText}`;
    } else if (s) {
      this.rangeEl.textContent = `${s.from.toFixed(2)}s → ${s.to.toFixed(2)}s · ${track.segments.length} 段 · `
        + `第 ${this.active + 1} 段`;
    } else {
      this.rangeEl.textContent = `未选关键帧${poolText}`;
    }
    // Show what is actually stored; with nothing stored the drawn shape is the
    // fallback the first handle drag or preset will write.
    const stored = normalizeCurve(track.segments[this.active]?.a?.curve);
    const live = this.drag && this.drag.mode !== 'path' ? this.curve : stored;
    const detail = live ? curveParamsText(live) : '';
    this.presetEl.textContent = live
      ? (detail ? `${curveLabel(live)} · ${detail}` : curveLabel(live))
      : '未应用 · 拖动圆点或点预设';
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

  /** Name of the element / 3D object / camera this drawer is editing. */
  _hostName() {
    const st = this.openState;
    const p = this.getProject?.();
    if (!st || !p) return '';
    if (st.host === 'element') return (p.elements || []).find((x) => x.id === st.id)?.name || '';
    if (st.host === 'object') return (p.scene?.objects || []).find((x) => x.id === st.id)?.name || '';
    const cam = (p.cameras || []).find((x) => x.id === st.id)
      || (p.camera?.id === st.id ? p.camera : null);
    return cam?.name || '';
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

  /** Curve actually stored for the active segment (the drawn fallback is not). */
  _storedCurve() {
    if (this._isPathMode()) return this.curve;
    return normalizeCurve(this._track()?.segments[this.active]?.a?.curve);
  }

  _markPreset() {
    const live = this.drag?.mode === 'segment' ? this.curve : this._storedCurve();
    const name = normalizeCurve(live)?.preset || '';
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
   * The y axis shows the track's real values; the camera flight view keeps the
   * progress window its progress-space curves and handles live in.
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
    const range = this._isPathMode() ? this._progressWindow() : this._valueWindow();
    const height = Math.max(1, L.bottom - L.top);
    const yOf = (v) => L.bottom - ((Number(v) - range[0]) / (range[1] - range[0])) * height;
    const vOf = (y) => range[0] + ((L.bottom - y) / height) * (range[1] - range[0]);
    return { ...L, gutter, pps, scroll, plotLeft, plotRight, range, xOf, tOf, yOf, vOf };
  }

  /** Segment endpoints' real values, or null when they have no value span. */
  _segValues(seg) {
    const a = keyValue(seg?.a);
    const b = keyValue(seg?.b);
    return a != null && b != null && Math.abs(b - a) > 1e-9 ? { a, d: b - a } : null;
  }

  /**
   * Visible window in progress units for one segment's handles. Handles store
   * progress, the axis shows values, and the two are affine per segment
   * (`value = a + d * v`), so the window flips when the segment descends —
   * keep the sign or one pixel of drag would move the handle the wrong way.
   * A segment with no value span keeps the old progress-space window.
   */
  _segProgressRange(g, seg) {
    const s = this._segValues(seg);
    if (s) return [(g.range[0] - s.a) / s.d, (g.range[1] - s.a) / s.d];
    return this._progressWindow();
  }

  /**
   * Screen y for one handle's progress. Map it through the segment's real
   * values; without a value span fall back to progress scaled over the window
   * height (the pre-value-axis placement, so zero-span segments still work).
   */
  _handleY(g, seg, v) {
    const s = this._segValues(seg);
    if (s) return g.yOf(s.a + s.d * Number(v));
    const [p0, p1] = this._progressWindow();
    return g.bottom - ((Number(v) - p0) / Math.max(1e-9, p1 - p0)) * (g.bottom - g.top);
  }

  _handlePos(seg, g, handle) {
    if (!handle) return null;
    return {
      x: g.xOf(seg.from + handle.u * (seg.to - seg.from)),
      y: this._handleY(g, seg, handle.v),
      u: handle.u,
      v: handle.v,
      handle,
    };
  }

  _handleOrigin(seg, g, handle) {
    if (!handle?.origin) return null;
    return {
      x: g.xOf(seg.from + handle.origin[0] * (seg.to - seg.from)),
      y: this._handleY(g, seg, handle.origin[1]),
    };
  }

  _tickStep(span) {
    const raw = Math.max(1e-9, (span || 1) / 6);
    const pow = 10 ** Math.floor(Math.log10(raw));
    const mult = raw / pow <= 1 ? 1 : raw / pow <= 2 ? 2 : raw / pow <= 5 ? 5 : 10;
    return mult * pow;
  }

  /** Decimals needed to tell neighbouring ticks apart (values can be tiny). */
  _tickDecimals(tick) {
    const step = Math.abs(Number(tick)) || 1;
    return clamp(-Math.floor(Math.log10(step) + 1e-9), 0, 6);
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

  _isSelectedKey(t, path = this._track()?.path) {
    return this.selected.some((s) => s.path === path && Math.abs(s.t - t) <= 1e-4);
  }

  /** Selected times on one property track (the panel's edit scope unit). */
  _selectedFor(path) {
    return this.selected
      .filter((s) => s.path === path)
      .map((s) => s.t)
      .sort((a, b) => a - b);
  }

  _selectedPaths() {
    return [...new Set(this.selected.map((s) => s.path))];
  }

  _hostRef() {
    const st = this.openState;
    if (!st) return null;
    if (st.host === 'camera') return cameraRef(st.id);
    if (st.host === 'object') return objectRef(st.id);
    return elementRef(st.id);
  }

  /** Every key of one property track, sorted by time. */
  _trackKeys(path) {
    const p = this.getProject?.();
    const st = this.openState;
    if (!p || !st || !path) return [];
    if (st.host === 'element') {
      const el = (p.elements || []).find((e) => e.id === st.id);
      return (el?.keyframes || []).filter((k) => k.path === path).sort((a, b) => a.t - b.t);
    }
    const host = st.host === 'object'
      ? (p.scene?.objects || []).find((o) => o.id === st.id)
      : (p.cameras || []).find((c) => c.id === st.id) || (p.camera?.id === st.id ? p.camera : null);
    return [...(host?.tracks?.[path] || [])].sort((a, b) => a.t - b.t);
  }

  /** Keys drawn on the time axis for the active track (flight keys in path mode). */
  _activeKeys() {
    if (this._isPathMode()) return this.path?.keys || [];
    const path = this._track()?.path;
    return path ? this._trackKeys(path) : [];
  }

  /**
   * Keys in the shape core/time.js::sampleTrack reads. Element keyframes are
   * already `{t, path, value}`; scene object / camera channels store `{t, v}`
   * and are lifted once per draw rather than once per sampled pixel.
   */
  _sampleKeys(keys, path) {
    return (keys || []).map((k) => (
      k && k.path === path && k.value !== undefined
        ? k
        : { t: k.t, path, value: k.v, curve: k.curve, ease: k.ease }
    ));
  }

  /**
   * Segments a preset can own on one track: the run between two *adjacent
   * selected* keys. Keys in between are inner keys and get retimed, so a
   * single selected key never forms a segment on its own (design §3).
   */
  _selectedPairs(path) {
    const keys = this._trackKeys(path);
    const present = new Set(keys.map((k) => Math.round(Number(k.t) * 1000) / 1000));
    const anchors = this._selectedFor(path)
      .map((t) => Math.round(t * 1000) / 1000)
      .filter((t) => present.has(t));
    const pairs = [];
    for (let i = 0; i + 1 < anchors.length; i++) {
      if (anchors[i + 1] > anchors[i] + 1e-4) pairs.push({ path, from: anchors[i], to: anchors[i + 1] });
    }
    return pairs;
  }

  /** True when both anchors of a span carry numeric values (not a colour key). */
  _numericSpan(span) {
    const keys = this._trackKeys(span.path);
    const at = (t) => keys.find((k) => Math.abs(Number(k.t) - t) <= 1e-4);
    return keyValue(at(span.from)) != null && keyValue(at(span.to)) != null;
  }

  /** The key that starts a span (it owns the curve of that segment). */
  _leftKey(path, t) {
    return this._trackKeys(path).find((k) => Math.abs(Number(k.t) - t) <= 1e-4) || null;
  }

  /**
   * Every span the pool can edit: numeric, between adjacent selected keys, on
   * any property track of this host (design §3 pool semantics).
   */
  _editSpans() {
    const spans = [];
    for (const path of this._selectedPaths()) {
      for (const span of this._selectedPairs(path)) {
        if (this._numericSpan(span)) spans.push(span);
      }
    }
    return spans;
  }

  /**
   * Curve drawn on a span. A stored curve wins; otherwise the shape follows the
   * key's real `ease` (fitted to handles), so the handles never claim an
   * `easeInOut` the data does not have (§7 R1, core/curve-spans.js).
   */
  _spanCurve(span) {
    const left = this._leftKey(span.path, span.from);
    const stored = normalizeCurve(left?.curve);
    if (stored) return { curve: stored, fitted: false };
    return { curve: curveFromEase(left?.ease), fitted: true };
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
    // The timeline draws its line on the left edge of the display frame, so
    // mirror playheadStart(): the raw time would sit up to one frame to the
    // right, and at t=0 the inequality below would hide the line entirely.
    const px = g.xOf(tl?.playheadStart?.() ?? tl?.time ?? 0);
    if (px < g.plotLeft || px > g.plotRight) return;
    ctx.strokeStyle = C('--playhead');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, g.top); ctx.lineTo(px, g.bottom); ctx.stroke();
  }

  /**
   * The timeline playhead moved. Playback ticks Timeline.setTime on every
   * animation frame, but the line only moves once per project frame, so stay
   * quiet while the display frame is the same and redraw when it changes.
   */
  syncTime() {
    if (!this.isOpen() || !this.openState) return;
    const tl = this.getTimeline();
    const t = tl?.playheadStart?.() ?? tl?.time ?? 0;
    if (t === this._playheadT) return;
    this._playheadT = t;
    this.draw();
  }

  /**
   * Keyframe diamonds. Scalar tracks put each key on its real value so the
   * diamond sits on the drawn curve; the flight view keeps them on the bottom
   * axis because its y axis is progress, not the key's value.
   */
  _drawKeys(ctx, g, keys, path) {
    const { W } = g;
    const pathMode = this._isPathMode();
    const midY = (g.top + g.bottom) / 2;
    for (const key of keys) {
      const x = g.xOf(key.t);
      if (x < g.plotLeft - 8 || x > W - g.rightPad + 8) continue;
      const value = pathMode ? null : keyValue(key);
      const y = pathMode ? g.bottom : value != null ? g.yOf(value) : midY;
      const on = this._isSelectedKey(key.t, path);
      if (on) {
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = alpha(C('--edit'), 0.4);
        ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = on ? 4.5 : 2.8;
      // A retimed inner key rarely lands on a whole frame: draw it hollow so
      // "align to frames" has something to fix (design §6 R1).
      const offGrid = Math.abs(Number(key.t) * this._fps() - Math.round(Number(key.t) * this._fps())) > 1e-3;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      if (!on && offGrid) {
        ctx.strokeStyle = alpha(C('--text-2'), 0.75);
        ctx.lineWidth = 1.2;
        ctx.strokeRect(-r, -r, r * 2, r * 2);
      } else {
        ctx.fillStyle = on ? C('--edit') : alpha(C('--text-2'), 0.5);
        ctx.fillRect(-r, -r, r * 2, r * 2);
      }
      ctx.restore();
    }
  }

  /** Box-select band drawn over the plot while the pointer is down. */
  _drawMarquee(ctx, g) {
    const m = this.marquee;
    if (!m) return;
    const x0 = clamp(Math.min(m.x0, m.x1), g.plotLeft, g.plotRight);
    const x1 = clamp(Math.max(m.x0, m.x1), g.plotLeft, g.plotRight);
    if (x1 - x0 < 1) return;
    ctx.fillStyle = alpha(C('--accent'), 0.09);
    ctx.fillRect(x0, g.top, x1 - x0, g.bottom - g.top);
    ctx.strokeStyle = alpha(C('--accent'), 0.65);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, g.top + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, g.bottom - g.top - 1));
    ctx.setLineDash([]);
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

    // All keyframes, selected bright, the rest dimmed.
    this._drawKeys(ctx, g, p.keys, 'path');

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

    // y grid + labels. Scalar tracks print their real values (many decimals
    // for tiny spans); the flight view keeps progress and marks 0 / 1 as the
    // segment endpoints it actually interpolates between.
    ctx.font = canvasFont();
    const [vMin, vMax] = g.range;
    const tick = this._tickStep(vMax - vMin);
    const decimals = this._tickDecimals(tick);
    for (let v = Math.ceil(vMin / tick) * tick; v <= vMax + 1e-9; v += tick) {
      const value = Math.abs(v) < 1e-9 ? 0 : v;
      const y = g.yOf(value);
      ctx.strokeStyle = C('--border-subtle');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.plotLeft, y + 0.5); ctx.lineTo(W - g.rightPad, y + 0.5); ctx.stroke();
      ctx.fillStyle = C('--text-3');
      ctx.fillText(value.toFixed(decimals), 8, y + 3);
    }
    if (this._isPathMode()) {
      ctx.strokeStyle = C('--border-strong');
      ctx.setLineDash([3, 4]);
      for (const edge of [0, 1]) {
        if (edge <= vMin || edge >= vMax) continue;
        const y = g.yOf(edge);
        ctx.beginPath(); ctx.moveTo(g.plotLeft, y + 0.5); ctx.lineTo(W - g.rightPad, y + 0.5); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.fillStyle = C('--text-3');
    const track = this._track();
    ctx.fillText(this._isPathMode() ? '进度' : (track?.label || track?.path || ''), 8, 12);

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
      this._drawMarquee(ctx, g);
      return;
    }

    // Selected anchors highlight their spans (§6); with no selection the
    // active segment stays faintly marked because presets still target it.
    const path = track?.path;
    const anchors = this._selectedFor(path);
    const bands = [];
    for (let i = 0; i + 1 < anchors.length; i++) {
      bands.push({ from: anchors[i], to: anchors[i + 1] });
    }
    if (!bands.length) {
      const active = track?.segments[this.active];
      if (active) bands.push({ from: active.from, to: active.to, faint: true });
    }
    for (const band of bands) {
      const x0 = g.xOf(Math.max(band.from, viewStart));
      const x1 = g.xOf(Math.min(band.to, viewEnd));
      if (x1 - x0 < 1) continue;
      ctx.fillStyle = alpha(C('--accent'), band.faint ? 0.035 : 0.07);
      ctx.fillRect(x0, g.top, x1 - x0, g.bottom - g.top);
      if (band.faint) continue;
      ctx.strokeStyle = alpha(C('--accent'), 0.22);
      ctx.lineWidth = 1;
      for (const x of [x0, x1]) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, g.top); ctx.lineTo(x + 0.5, g.bottom); ctx.stroke();
      }
    }

    // One continuous line for the whole track. Sampling the real evaluator per
    // pixel column keeps curve + ease + hold-before-first/after-last identical
    // to the preview (§2/§6), and the keys then sit exactly on the line.
    const keys = this._trackKeys(path);
    const midY = (g.top + g.bottom) / 2;
    const numeric = keys.some((k) => keyValue(k) != null);
    if (!numeric) {
      // Colour / text tracks have no numeric axis in this slice; P3 replaces
      // this placeholder with the real step band. Keep it quiet but visible.
      ctx.fillStyle = alpha(C('--text-2'), 0.16);
      ctx.fillRect(g.plotLeft, midY - 5, Math.max(1, W - g.rightPad - g.plotLeft), 10);
    } else {
      const samples = this._sampleKeys(keys, path);
      const x0 = Math.max(0, g.plotLeft);
      const x1 = W - g.rightPad;
      if (x1 > x0) {
        const steps = Math.max(1, Math.round(x1 - x0));
        ctx.beginPath();
        let y = midY;
        for (let s = 0; s <= steps; s++) {
          const x = x0 + ((x1 - x0) * s) / steps;
          const value = sampleTrack(samples, path, g.tOf(x), null);
          if (typeof value === 'number' && Number.isFinite(value)) y = g.yOf(value);
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = C('--accent');
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
    }

    // Every key of the active track, on its real value.
    this._drawKeys(ctx, g, keys, path);

    // Handles for every editable span of the displayed track (§7: the old
    // "active segment only" rule hid the handles the selection promised).
    const shown = this._editSpans().filter((span) => span.path === path);
    for (const span of shown) {
      const info = this._spanCurve(span);
      if (!info?.curve) continue;
      const draggingThis = this.drag?.mode === 'spanCurve'
        && this.drag.span?.path === span.path
        && Math.abs(this.drag.span.from - span.from) <= 1e-4;
      const handles = curveHandles(draggingThis ? this.drag.curve : info.curve);
      for (const handle of handles) {
        const hp = this._handlePos(span, g, handle);
        if (!hp) continue;
        const visible = hp.x >= g.plotLeft - 14 && hp.x <= W - g.rightPad + 14
          && hp.y >= g.top - 14 && hp.y <= g.bottom + 14;
        if (!visible) continue;
        const origin = this._handleOrigin(span, g, handle);
        if (origin) {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = alpha(C('--text-2'), 0.35);
          ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(hp.x, hp.y); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = alpha(C('--text-2'), 0.22);
        ctx.beginPath(); ctx.moveTo(hp.x, g.top); ctx.lineTo(hp.x, g.bottom); ctx.stroke();
        ctx.setLineDash([]);
        const active = this.drag?.handle?.id === handle.id && draggingThis;
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, active ? 9.5 : 7.5, 0, Math.PI * 2);
        // Fitted handles are hollow: they show the key's current ease, not
        // stored data, until the first drag writes a real curve.
        if (info.fitted) {
          ctx.fillStyle = C('--surface-0');
          ctx.fill();
          ctx.strokeStyle = C('--text-1');
          ctx.lineWidth = 1.6;
        } else {
          ctx.fillStyle = C('--text-1');
          ctx.fill();
          ctx.strokeStyle = C('--accent-hover');
          ctx.lineWidth = 1.5;
        }
        ctx.stroke();
      }
    }

    // playhead + box-select band
    this._drawPlayhead(ctx, g);
    this._drawMarquee(ctx, g);
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
    const path = this._track()?.path;
    if (!path) return null;
    let best = null;
    for (const span of this._editSpans()) {
      if (span.path !== path) continue;
      const info = this._spanCurve(span);
      if (!info?.curve) continue;
      for (const handle of curveHandles(info.curve)) {
        const hp = this._handlePos(span, g, handle);
        if (!hp) continue;
        const d = Math.hypot(hp.x - x, hp.y - y);
        if (d <= 15 && (!best || d < best.d)) best = { span, handle, curve: info.curve, d };
      }
    }
    return best ? { span: best.span, handle: best.handle, curve: best.curve } : null;
  }

  /**
   * Keyframe diamond under the pointer. Scalar diamonds sit on their value,
   * so hit-test in both axes; the flight view keeps them on the bottom axis.
   */
  _hitKey(x, y) {
    const g = this._geo();
    const path = this._track()?.path;
    if (!path) return null;
    const pathMode = this._isPathMode();
    const midY = (g.top + g.bottom) / 2;
    let best = null;
    for (const key of this._activeKeys()) {
      const kx = g.xOf(key.t);
      if (kx < g.plotLeft - 8 || kx > g.plotRight + 8) continue;
      const value = pathMode ? null : keyValue(key);
      const ky = pathMode ? g.bottom : value != null ? g.yOf(value) : midY;
      const d = Math.hypot(kx - x, ky - y);
      if (d <= 11 && (!best || d < best.d)) best = { t: key.t, path, d };
    }
    return best ? { path: best.path, t: best.t } : null;
  }

  /** Panel key clicks use the same pool rules as the timeline lanes. */
  _pickKey(key, ev) {
    const path = String(key?.path || this._track()?.path || '');
    if (!path) return;
    const additive = !!(ev?.ctrlKey || ev?.metaKey || ev?.shiftKey);
    if (!additive) {
      this._setSelection([{ path, t: key.t }]);
      return;
    }
    const on = this._isSelectedKey(key.t, path);
    const next = this.selected.filter((s) => !(s.path === path && Math.abs(s.t - key.t) <= 1e-4));
    if (!on) next.push({ path, t: key.t });
    this._setSelection(next);
  }

  /**
   * Apply a keyframe selection for the edited host. This is the panel's single
   * selection source: it mirrors the timeline pool (so the same diamonds light
   * up) and points the panel at the segment that starts at the first selected
   * key, which is what a preset or handle drag will edit.
   */
  _setSelection(keys) {
    const st = this.openState;
    if (!st) return;
    const seen = new Set();
    const next = [];
    for (const k of keys) {
      const t = Math.round(Number(k.t) * 1000) / 1000;
      const path = String(k.path || '');
      if (!path || !Number.isFinite(t)) continue;
      const id = `${path}:${t}`;
      if (seen.has(id)) continue;
      seen.add(id);
      next.push({ path, t });
    }
    next.sort((a, b) => (a.path === b.path ? a.t - b.t : a.path.localeCompare(b.path)));
    this.selected = next;

    const trackPath = this._track()?.path;
    const times = trackPath ? this._selectedFor(trackPath) : [];
    if (this._isPathMode()) {
      this._refreshSpan();
    } else {
      const segs = this._track()?.segments || [];
      const i = times.length ? segs.findIndex((s) => Math.abs(s.from - times[0]) <= 1e-4) : -1;
      if (i >= 0) {
        this.active = i;
        this.curve = normalizeCurve(segs[i].a?.curve) || presetCurve('easeInOut');
      }
    }

    const hostRef = this._hostRef();
    const ids = hostRef ? next.map((s) => keyframeRef(hostRef, s.path, s.t)) : [];
    this.onSelect?.(ids.length
      ? { kind: 'keyframe', ids, primary: ids[0] }
      : { kind: null, ids: [], primary: null });
    this._syncHead();
    this._syncRailGroup();
    this._buildPathSelect();
    this.draw();
  }

  /**
   * Press: a tap runs the click action, a drag past the slop becomes the same
   * marquee the timeline uses (3px slop, Ctrl/Cmd/Shift toggles, Esc cancels).
   * The selection is only touched on release, never on press.
   */
  _startPress(ev, { tap = null } = {}) {
    const start = { x: ev.clientX, y: ev.clientY };
    const from = this._localPoint(ev);
    const additive = !!(ev.ctrlKey || ev.metaKey || ev.shiftKey);
    const box = { x0: from.x, x1: from.x };
    let moved = false;
    const samePointer = (e) => !e || e.pointerId == null || e.pointerId === ev.pointerId;
    const update = (e) => {
      if (!samePointer(e)) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 3) return;
      moved = true;
      box.x1 = this._localPoint(e).x;
      this.marquee = { x0: box.x0, x1: box.x1, additive };
      this.draw();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
      try { this.canvas.releasePointerCapture?.(ev.pointerId); } catch { /* synthetic */ }
    };
    const up = (e) => {
      if (!samePointer(e)) return;
      cleanup();
      const m = this.marquee;
      this.marquee = null;
      if (!moved) {
        this.draw();
        tap?.();
        return;
      }
      this._applyMarquee(m, additive);
    };
    const cancel = () => {
      cleanup();
      this.marquee = null;
      this.draw();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
    try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
  }

  /** Select the keys inside the band; additive toggles them like the timeline. */
  _applyMarquee(m, additive) {
    const g = this._geo();
    const path = this._track()?.path;
    if (!path) { this.draw(); return; }
    const x0 = Math.min(m.x0, m.x1) - 2;
    const x1 = Math.max(m.x0, m.x1) + 2;
    // The band is a time range, so it takes keys of every property track in
    // the pool, not only the row that happens to be drawn (design §8).
    const hits = [];
    const paths = this.openState?.tracks?.map((t) => t.path) || [path];
    for (const trackPath of paths) {
      for (const key of this._trackKeys(trackPath)) {
        const x = g.xOf(key.t);
        if (x < x0 || x > x1 || x < g.plotLeft - 8 || x > g.plotRight + 8) continue;
        hits.push({ path: trackPath, t: key.t });
      }
    }
    if (!additive) {
      this._setSelection(hits);
      return;
    }
    const next = this.selected.slice();
    for (const hit of hits) {
      const i = next.findIndex((s) => s.path === hit.path && Math.abs(s.t - hit.t) <= 1e-4);
      if (i >= 0) next.splice(i, 1);
      else next.push(hit);
    }
    this._setSelection(next);
  }

  _down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = this._localPoint(e);
    const g = this._geo();
    const hit = this._hitHandle(p.x, p.y);
    if (hit) {
      if (this._isPathMode()) {
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
          range: g.range,
        };
      } else {
        // Scalar track: one curve for the dragged span, applied pool-wide on
        // release. Inner keys follow live unless Alt holds them still (§7).
        const range = this._segProgressRange(g, hit.span);
        this.drag = {
          mode: 'spanCurve',
          span: hit.span,
          handle: hit.handle,
          curve: hit.curve,
          baseCurve: hit.curve,
          pointer: p,
          range,
          alt: !!e.altKey,
          moved: false,
        };
        this._snapshotSpans();
        this.curve = hit.curve;
        this._syncHead();
        this._markPreset();
        this.draw();
      }
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const key = this._hitKey(p.x, p.y);
    if (key) {
      const obj = this._activeKeys().find((k) => Math.abs(Number(k.t) - key.t) <= 1e-4);
      if (obj) {
        this._startKeyPress(e, obj);
        return;
      }
    }
    this._startPress(e, {
      tap: () => {
        // Tapping empty space never changes the pool: the selection is picked
        // across elements in the timeline, and a stray click is costly (§8 R1).
        if (!this._isPathMode()) this._switchSegmentAt(p);
      },
    });
  }

  /**
   * Press on a key: a tap selects it, a drag moves it in time (whole frames,
   * Alt = free) and, on numeric tracks, in value (§8). Dragging an unselected
   * key selects it first so the gesture never edits something not highlighted.
   * The live move mutates the key object; the ops are built from the original
   * state on release and sent as one batch.
   */
  _startKeyPress(ev, key) {
    const path = key.path;
    const start = { x: ev.clientX, y: ev.clientY };
    const startLocal = this._localPoint(ev);
    const g = this._geo();
    const fps = this._fps();
    const originT = Number(key.t);
    const originV = keyValue(key);
    const plotH = Math.max(1, g.bottom - g.top);
    const valueSpan = g.range[1] - g.range[0];
    let moved = false;
    const same = (e) => !e || e.pointerId == null || e.pointerId === ev.pointerId;
    const isEl = this.openState?.host === 'element';
    const writeValue = (v) => { if (isEl) key.value = v; else key.v = v; };
    const restore = () => {
      key.t = originT;
      if (originV != null) writeValue(originV);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', keyCancel, true);
      try { this.canvas.releasePointerCapture?.(ev.pointerId); } catch { /* synthetic */ }
    };
    const update = (e) => {
      if (!same(e)) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 3) return;
      if (!moved) {
        moved = true;
        if (!this._isSelectedKey(key.t, path)) this._setSelection([{ path, t: key.t }]);
        try { this.canvas.setPointerCapture?.(ev.pointerId); } catch { /* synthetic */ }
        this.canvas.style.cursor = 'grabbing';
      }
      const p = this._localPoint(e);
      restore();
      let t = originT + (p.x - startLocal.x) / Math.max(1, g.pps);
      t = Math.max(0, t);
      if (!e.altKey) t = Math.round(t * fps) / fps;
      t = Math.round(t * 1000) / 1000;
      const others = this._trackKeys(path).filter((k) => k !== key);
      if (others.some((k) => Math.abs(Number(k.t) - t) <= 1e-4)) t = originT;
      key.t = t;
      if (originV != null) {
        const dv = (-(p.y - startLocal.y) / plotH) * valueSpan;
        writeValue(this._clampValue(path, originV + dv));
      }
      this.onLivePreview?.();
      this._syncHead();
      this.draw();
    };
    const up = (e) => {
      if (!same(e)) return;
      cleanup();
      this.canvas.style.cursor = '';
      if (!moved) { this._pickKey(key, ev); return; }
      const movedT = Number(key.t);
      const movedV = keyValue(key);
      const newValue = originV != null && movedV != null && Math.abs(movedV - originV) > 1e-9
        ? movedV : undefined;
      restore();
      const ops = this._keyMoveOps(path, key, movedT, newValue);
      if (ops.length) this.onOp?.(ops.length === 1 ? ops[0] : { op: 'batch', ops });
      this.onLivePreview?.();
      this._syncHead();
      this.draw();
    };
    const cancel = () => {
      cleanup();
      this.canvas.style.cursor = '';
      restore();
      this.onLivePreview?.();
      this.draw();
    };
    const keyCancel = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', keyCancel, true);
    try { this.canvas.setPointerCapture?.(ev.pointerId); } catch { /* synthetic */ }
  }

  /** Tap on a segment switches the edited segment; the pool is left alone. */  _switchSegmentAt(p) {
    const g = this._geo();
    const t = g.tOf(p.x);
    const segs = this._track()?.segments || [];
    const idx = segs.findIndex((s) => t >= s.from && t <= s.to);
    if (idx < 0) return;
    if (idx !== this.active) {
      this.active = idx;
      this.curve = normalizeCurve(segs[idx].a?.curve) || presetCurve('easeInOut');
    }
    this._syncHead();
    this._syncRailGroup();
    this.draw();
  }

  _move(e) {
    if (!this.drag) return;
    const drag = this.drag;
    const handle = drag.handle;
    const g = this._geo();
    const p = this._localPoint(e);
    const span = drag.mode === 'segment' ? this._track()?.segments[drag.seg] : drag.span;
    if (!span || span.from == null || span.to == null) return;
    const from = span.from;
    const to = span.to;
    const spanPx = Math.max(1, g.xOf(to) - g.xOf(from));
    const plotH = Math.max(1, g.bottom - g.top);
    const damping = Number.isFinite(handle.damping) ? handle.damping : 1;
    const u = clamp(handle.u + ((p.x - drag.pointer.x) / spanPx) * damping, 0, 1);
    let v = handle.v + (-(p.y - drag.pointer.y) / plotH) * (drag.range[1] - drag.range[0]) * damping;
    if (handle.id === 'p1' || handle.id === 'p2') {
      v = clamp(v, -1, 2);
    } else if (handle.allowOvershoot) {
      // The window can run downwards (a segment whose value drops), so clamp
      // against the sorted bounds rather than assuming range[0] < range[1].
      v = clamp(v, Math.min(drag.range[0], drag.range[1]), Math.max(drag.range[0], drag.range[1]));
    } else {
      v = clamp(v, 0, 1);
    }
    this.curve = moveCurveHandle(drag.curve, handle.id, u, v);
    drag.curve = this.curve;
    drag.moved = true;
    if (drag.mode === 'path') {
      drag.span.curve = this.curve;
      drag.span.left.curve = this.curve;
      drag.span.left.spanTo = drag.span.to;
      this._scheduleLiveSpan();
    } else if (drag.mode === 'spanCurve') {
      // Alt is read live so the gesture can be released without retiming.
      drag.alt = !!e.altKey;
      this._applyLiveSpans(drag.curve);
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
    if (drag.mode === 'spanCurve') {
      if (!drag.moved) {
        this._restoreLiveSpans();
        return;
      }
      // Build the ops from the *committed* state: the live preview already
      // moved the key objects in memory, and the engine never saw those moves,
      // so a keyCurve pointing at a preview-only time would be rejected.
      this._restoreLiveSpans();
      this._commit(drag.curve, this._editSpans(), { retime: !drag.alt });
      return;
    }
    const seg = this._track()?.segments[drag.seg];
    if (seg) this._commit(this.curve, [seg]);
  }

  // ------------------------------------------------ live span retiming (§4/§7)

  /** Remember the spans a handle drag is about to retime (live preview + undo). */
  _snapshotSpans() {
    this._dragBackup = this._editSpans().map((span) => {
      const keys = this._trackKeys(span.path);
      const at = (t) => keys.find((k) => Math.abs(Number(k.t) - t) <= 1e-4) || null;
      return {
        span,
        left: at(span.from),
        right: at(span.to),
        inner: keys
          .filter((k) => Number(k.t) > span.from + 1e-4 && Number(k.t) < span.to - 1e-4)
          .map((k) => ({ key: k, t: Number(k.t) })),
      };
    });
  }

  /**
   * Move the inner keys of every editable span to where `curve` first reaches
   * their value, in the in-memory project (no rev, no history) so the preview,
   * the timeline and the drawn line all follow the handle under the pointer.
   * Recomputes from the origin every frame, so a drag back and forth is exact.
   */
  _applyLiveSpans(curve) {
    const retime = !this.drag?.alt;
    for (const entry of this._dragBackup || []) {
      for (const item of entry.inner) item.key.t = item.t;
      if (!retime || !entry.inner.length) continue;
      const points = entry.inner.map((item) => ({
        t: item.t,
        ys: [spanProgress(keyValue(entry.left), keyValue(entry.right), keyValue(item.key))],
      }));
      const timed = retimeSpanTimes({ from: entry.span.from, to: entry.span.to, curve, points });
      if (!timed) continue;
      timed.forEach((res, i) => {
        if (!res.outOfRange && entry.inner[i]) entry.inner[i].key.t = res.newT;
      });
    }
    this.onLivePreview?.();
  }

  /** Put every retimed inner key back and drop the backup. */
  _restoreLiveSpans() {
    for (const entry of this._dragBackup || []) {
      for (const item of entry.inner) item.key.t = item.t;
    }
    this._dragBackup = null;
    this.onLivePreview?.();
    if (this.isOpen()) {
      this._syncHead();
      this._syncRailGroup();
      this.draw();
    }
  }

  _hover(e) {
    if (this.drag || this.marquee) return;
    const p = this._localPoint(e);
    if (this._hitHandle(p.x, p.y)) {
      this.canvas.style.cursor = 'grab';
      return;
    }
    this.canvas.style.cursor = this._hitKey(p.x, p.y) ? 'pointer' : 'default';
  }

  _applyPreset(id) {
    const curve = presetCurve(id);
    if (!curve) return;
    if (this._isPathMode()) {
      this._applyPathPreset(curve);
      return;
    }
    // Scope = every segment between adjacent selected keys, across the
    // property tracks the timeline pool covers. Colour tracks are skipped:
    // colour keyframes stay stepped (design §5 R2), so they take no curve.
    const targets = [];
    let skippedColour = 0;
    for (const path of this._selectedPaths()) {
      for (const pair of this._selectedPairs(path)) {
        if (this._numericSpan(pair)) targets.push(pair);
        else skippedColour += 1;
      }
    }
    if (!targets.length) {
      if (!this.selected.length) {
        this.toast?.('再添加一个关键帧', 'warn');
      } else if (skippedColour) {
        this.toast?.('颜色关键帧保持跳变，不套曲线', 'warn');
      } else {
        this.toast?.('再添加一个关键帧', 'warn');
      }
      return;
    }
    this.curve = curve;
    this._syncHead();
    this._syncRailGroup();
    this.draw();
    this._commit(curve, targets);
  }

  /**
   * Apply one preset to every segment between adjacent selected keys. With no
   * key selected the whole path is the scope (the panel never invents a
   * selection just to have one). Any old span intersecting the scope is
   * cleared first, then each pair becomes its own span and retimes its inner
   * keys.
   */
  _applyPathPreset(curve) {
    const p = this.path;
    if (!p || !p.keys?.length) return;
    if (p.selected.length === 1) {
      this.toast?.('再选一个关键帧才能成段', 'warn');
      return;
    }
    const scope = p.selected.length
      ? p.selected
      : [p.keys[0].t, p.keys[p.keys.length - 1].t];
    const segments = [];
    for (let i = 0; i + 1 < scope.length; i++) {
      const li = p.keys.findIndex((k) => Math.abs(k.t - scope[i]) <= 1e-4);
      const ri = p.keys.findIndex((k) => Math.abs(k.t - scope[i + 1]) <= 1e-4);
      if (ri > li) segments.push({ from: p.keys[li].t, to: p.keys[ri].t });
    }
    if (!segments.length) {
      this.toast?.('至少选中两个关键帧才能套用曲线', 'warn');
      return;
    }
    const from = scope[0];
    const to = scope[scope.length - 1];
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
    for (const seg of segments) {
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
          this.toast?.(`已套用 ${curveLabel(curve)} · ${segments.length} 段`, 'info');
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

  /**
   * Write one curve to every targeted segment (one batch = one undo step).
   *
   * Each span goes through core/curve-spans.js::spanCurveOps so the curve lands
   * on *every* sub-segment of the span and the keys in between are retimed to
   * where their value now sits on the curve (design §4). `retime: false` is the
   * Alt gesture: same curve, no key moved.
   */
  _commit(curve, segments, { retime = true } = {}) {
    if (!this.openState || !segments?.length) return null;
    const st = this.openState;
    const fallbackPath = this._track()?.path;
    const shape = curve ? normalizeCurve(curve) : null;
    const ops = [];
    const paths = new Set();
    let moved = 0;
    let skipped = 0;
    for (const seg of segments) {
      const path = seg.path || fallbackPath;
      const from = Math.round(Number(seg.from) * 1000) / 1000;
      const to = Math.round(Number(seg.to) * 1000) / 1000;
      const keys = this._trackKeys(path);
      const built = spanCurveOps({ host: st.host, id: st.id, path, keys, from, to, curve: shape, retime });
      if (built) {
        ops.push(...built.ops);
        moved += built.moved;
      } else {
        // Nothing to retime (no stored keys, non-numeric anchors): write the
        // curve itself so the segment still shows the shape.
        if (!shape) continue;
        skipped += 1;
        ops.push({ op: 'keyCurve', host: st.host, id: st.id, path, from, to, curve: shape });
      }
      paths.add(path);
    }
    if (!ops.length) return null;
    const detail = moved ? ` · ${moved} 个内键已移动` : '';
    const done = `已应用到 ${paths.size} 条属性 · ${segments.length} 段${detail}`;
    const pending = this.onOp?.(ops.length === 1 ? ops[0] : { op: 'batch', ops });
    if (pending?.then) {
      pending.then((j) => {
        if (j) this.toast?.(done, 'info');
        else {
          // The op was rejected: put the header back on the stored curve.
          this._syncHead();
          this._syncRailGroup();
          this.draw();
        }
      });
    } else {
      this.toast?.(done, 'info');
    }
    return pending;
  }
}
