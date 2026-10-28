// Shell (docs/DESIGN.md §1, §1.6): splitters + collapse + persisted sizes,
// timecode field, status bar, log drawer. DOM lives in index.html; main.js wires
// the callbacks. Pure ES module, no deps.
import { prefs } from './ui.js';
import { frameIndex } from './timeline-math.js';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- layout
export const LAYOUT = {
  left: { def: 260, min: 200, max: 420 },
  right: { def: 340, min: 280, max: 520 },
  tl: { def: 280, min: 160, maxFrac: 0.6 },
  centerMin: 480,
  splitter: 4,
};

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/**
 * Wire the three splitters and the two edge handles. Sizes live in CSS vars on
 * #app (--left-w / --right-w / --tl-h) and persist in prefs on release.
 * Returns a small controller; `onChange(state)` runs after every applied change.
 */
export function initLayout({ onChange } = {}) {
  const app = $('#app');
  const st = {
    leftW: num(prefs.get('leftW'), LAYOUT.left.def),
    rightW: num(prefs.get('rightW'), LAYOUT.right.def),
    tlH: num(prefs.get('tlH'), LAYOUT.tl.def),
    leftCollapsed: !!prefs.get('leftCollapsed', false),
    rightCollapsed: !!prefs.get('rightCollapsed', false),
  };

  const sideMax = (side) => {
    const spec = LAYOUT[side];
    const other = side === 'left'
      ? (st.rightCollapsed ? 0 : st.rightW)
      : (st.leftCollapsed ? 0 : st.leftW);
    const room = window.innerWidth - other - LAYOUT.centerMin - 2 * LAYOUT.splitter;
    return Math.max(spec.min, Math.min(spec.max, room));
  };
  const tlMax = () => Math.max(LAYOUT.tl.min, Math.round(window.innerHeight * LAYOUT.tl.maxFrac));
  const clampSide = (side, w) => Math.round(Math.max(LAYOUT[side].min, Math.min(sideMax(side), w)));
  const clampTl = (hgt) => Math.round(Math.max(LAYOUT.tl.min, Math.min(tlMax(), hgt)));

  const apply = () => {
    st.leftW = clampSide('left', st.leftW);
    st.rightW = clampSide('right', st.rightW);
    st.tlH = clampTl(st.tlH);
    app.style.setProperty('--left-w', `${st.leftCollapsed ? 0 : st.leftW}px`);
    app.style.setProperty('--right-w', `${st.rightCollapsed ? 0 : st.rightW}px`);
    app.style.setProperty('--tl-h', `${st.tlH}px`);
    app.classList.toggle('left-collapsed', st.leftCollapsed);
    app.classList.toggle('right-collapsed', st.rightCollapsed);
    const el = $('#edgeLeft');
    const er = $('#edgeRight');
    if (el) el.hidden = !st.leftCollapsed;
    if (er) er.hidden = !st.rightCollapsed;
    onChange?.({ ...st });
  };
  const persist = () => {
    for (const k of ['leftW', 'rightW', 'tlH', 'leftCollapsed', 'rightCollapsed']) prefs.set(k, st[k]);
  };
  const setCollapsed = (side, on) => {
    st[`${side}Collapsed`] = on == null ? !st[`${side}Collapsed`] : !!on;
    apply();
    persist();
  };

  const drag = (handle, kind) => {
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const x0 = e.clientX;
      const y0 = e.clientY;
      const collapsedKey = kind === 'tl' ? null : `${kind}Collapsed`;
      const w0 = kind === 'left' ? (st.leftCollapsed ? 0 : st.leftW)
        : kind === 'right' ? (st.rightCollapsed ? 0 : st.rightW) : st.tlH;
      let moved = false;
      handle.classList.add('dragging');
      app.classList.add('resizing', kind === 'tl' ? 'resizing-row' : 'resizing-col');
      const move = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!moved && Math.abs(kind === 'tl' ? dy : dx) < 3) return;
        moved = true;
        if (collapsedKey && st[collapsedKey]) st[collapsedKey] = false;
        if (kind === 'left') st.leftW = w0 + dx;
        else if (kind === 'right') st.rightW = w0 - dx;
        else st.tlH = w0 - dy;
        apply();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        handle.classList.remove('dragging');
        app.classList.remove('resizing', 'resizing-row', 'resizing-col');
        if (moved) persist();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  };
  drag($('#splitLeft'), 'left');
  drag($('#splitRight'), 'right');
  drag($('#splitTimeline'), 'tl');
  $('#splitLeft')?.addEventListener('dblclick', () => setCollapsed('left'));
  $('#splitRight')?.addEventListener('dblclick', () => setCollapsed('right'));
  $('#splitTimeline')?.addEventListener('dblclick', () => { st.tlH = LAYOUT.tl.def; apply(); persist(); });
  $('#edgeLeft')?.addEventListener('click', () => setCollapsed('left', false));
  $('#edgeRight')?.addEventListener('click', () => setCollapsed('right', false));
  window.addEventListener('resize', apply);
  apply();

  return {
    get state() { return { ...st }; },
    apply,
    setCollapsed,
    setSize(k, v) { if (k in st) { st[k] = v; apply(); persist(); } },
  };
}

/** Mark the active tab of a [role=tablist] (`.on` + aria-selected). */
export function markTab(tablist, name) {
  tablist?.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
}

// ---------------------------------------------------------------- timecode
const pad2 = (n) => String(n).padStart(2, '0');

/** 1.8 -> '00:01.80'; minutes are not wrapped into hours. */
export function formatClock(t) {
  const cs = Math.max(0, Math.round((Number(t) || 0) * 100));
  const m = Math.floor(cs / 6000);
  const s = (cs % 6000) / 100;
  return `${pad2(m)}:${s.toFixed(2).padStart(5, '0')}`;
}

// The frame under `t`, floored like the timeline playhead (so the transport
// frame and the highlighted frame band always agree).
export const frameOf = (t, fps) => frameIndex(t, fps);

/**
 * Parse a typed time: '1.8' / '1.8s' (seconds), '1:02.5' (m:ss), '1:02:03' (h:mm:ss),
 * '54f' / 'f54' (frame number). Returns seconds, or null when the text is not a time.
 */
export function parseTimecode(text, fps = 24) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let m = s.match(/^f(\d+)$/) || s.match(/^(\d+)f$/);
  if (m) return Number(m[1]) / (fps || 24);
  m = s.match(/^(\d+):(\d+):(\d+(?:\.\d*)?)$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = s.match(/^(\d+):(\d+(?:\.\d*)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d*)?|\.\d+)s?$/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * The transport timecode: `00:01.80 f54`; click (or Enter/Space when focused) turns
 * it into an input. Enter seeks via onSeek(seconds), Esc / blur cancels, invalid
 * text marks the input and keeps editing.
 */
export class Timecode {
  constructor(el, { onSeek, getFps } = {}) {
    this.el = el;
    this.onSeek = onSeek;
    this.getFps = getFps || (() => 24);
    this.editing = false;
    this.t = 0;
    this.main = document.createElement('span');
    this.main.className = 'tc-main';
    this.frame = document.createElement('span');
    this.frame.className = 'tc-frame';
    el.replaceChildren(this.main, this.frame);
    el.addEventListener('click', () => this.edit());
    el.addEventListener('keydown', (e) => {
      if (this.editing || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation();
      this.edit();
    });
  }

  update(t) {
    this.t = t;
    if (this.editing) return;
    const a = formatClock(t);
    const b = `f${frameOf(t, this.getFps())}`;
    if (this.main.textContent !== a) this.main.textContent = a;
    if (this.frame.textContent !== b) this.frame.textContent = b;
  }

  edit() {
    if (this.editing) return;
    this.editing = true;
    this.el.classList.add('editing');
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.setAttribute('aria-label', '跳转到时间');
    input.value = (Math.round(this.t * 100) / 100).toFixed(2);
    this.input = input;
    this.el.replaceChildren(input);
    const finish = (seek) => {
      if (!this.editing) return;
      this.editing = false;
      this.input = null;
      this.el.classList.remove('editing');
      this.el.replaceChildren(this.main, this.frame);
      if (seek != null) this.onSeek?.(seek);
      else this.update(this.t);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = parseTimecode(input.value, this.getFps());
        if (v == null || !Number.isFinite(v)) { input.classList.add('invalid'); return; }
        finish(v);
        this.el.focus({ preventScroll: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
        this.el.focus({ preventScroll: true });
      }
    });
    input.addEventListener('input', () => input.classList.remove('invalid'));
    input.addEventListener('blur', () => finish(null));
    input.focus();
    input.select();
  }
}

// ---------------------------------------------------------------- status bar
const BADGE_STATES = ['badge-warn', 'badge-danger', 'badge-ok'];

function setBadge(node, text, tip, state = null) {
  if (!node) return;
  node.textContent = text;
  node.dataset.tip = tip;
  node.classList.remove(...BADGE_STATES);
  if (state) node.classList.add(`badge-${state}`);
}

export class StatusBar {
  constructor({ onCancelRender, onToggleLogs } = {}) {
    this.conn = $('#sbConn');
    this.renderBox = $('#sbRender');
    this.renderText = $('#sbRenderText');
    this.renderBar = $('#sbRenderBar');
    this.logCountEl = $('#logCount');
    this.meta = $('#projMeta');
    this.logCounts = { warn: 0, error: 0 };
    this.wasRunning = false;
    this.doneTimer = 0;
    $('#sbRenderCancel')?.addEventListener('click', () => onCancelRender?.());
    $('#btnLogs')?.addEventListener('click', () => onToggleLogs?.());
  }

  /** 'ok' | 'warn' (reconnecting) | 'danger' (closed) */
  setConnection(state) {
    if (!this.conn) return;
    const text = { ok: '已连接', warn: '重连中', danger: '已断开' }[state] || '连接中';
    const tip = {
      ok: '引擎已连接\n项目改动实时同步',
      warn: '与引擎的连接中断，正在重连\n期间的改动可能不会实时显示',
      danger: '与引擎的连接已断开\n点项目菜单里的「重启引擎」',
    }[state] || '正在连接引擎';
    this.conn.classList.remove('ok', 'warn', 'danger');
    this.conn.classList.add(state === 'ok' ? 'ok' : state === 'danger' ? 'danger' : 'warn');
    this.conn.querySelector('.sb-text').textContent = text;
    this.conn.dataset.tip = tip;
  }

  setCapabilities({ blender, ffmpeg, ai } = {}) {
    if (blender) {
      const v = String(blender.version || 'Blender').replace(/\s*\(.*$/, '');
      setBadge($('#sbBlender'), /blender/i.test(v) ? v : `Blender ${v}`, `${blender.version || 'Blender'}\n${blender.exe || ''}`.trim());
    } else {
      setBadge($('#sbBlender'), 'Blender 未找到', '没有 Blender：预览帧和渲染不可用\n装好后（或设置 VDM_BLENDER）点重启引擎', 'warn');
    }
    if (ffmpeg === true) setBadge($('#sbFfmpeg'), 'ffmpeg', 'ffmpeg 可用');
    else if (ffmpeg === false) setBadge($('#sbFfmpeg'), 'ffmpeg 未找到', '没有 ffmpeg：视频抽帧、缩略图和成片编码不可用\n装好后（或设置 VDM_FFMPEG）点重启引擎', 'warn');
    else setBadge($('#sbFfmpeg'), 'ffmpeg', 'ffmpeg 状态未知');
    if (ai) setBadge($('#sbAI'), 'AI', 'AI 副驾可用（DSH-TUI）');
    else setBadge($('#sbAI'), 'AI 不可用', '未找到 DSH-TUI：AI 副驾不可用\n设置 VDM_DSH 或把 dsh 加进 PATH 后重启引擎', 'warn');
  }

  /** Render job progress; `initial` skips the「渲染完成」flash for a stale done state. */
  setRender(d, { initial = false } = {}) {
    const box = this.renderBox;
    if (!box || !d) return;
    clearTimeout(this.doneTimer);
    if (d.running) {
      const total = Math.max(0, Number(d.total) || 0);
      const progress = Math.max(0, Number(d.progress) || 0);
      box.hidden = false;
      box.classList.remove('done');
      this.renderText.textContent = total ? `渲染 ${progress}/${total}` : '渲染中…';
      this.renderBar.style.width = `${total ? Math.min(100, (progress / total) * 100) : 0}%`;
      this.wasRunning = true;
      return;
    }
    if (d.done && !d.error && this.wasRunning && !initial) {
      box.hidden = false;
      box.classList.add('done');
      this.renderText.textContent = '渲染完成';
      this.doneTimer = setTimeout(() => { box.hidden = true; box.classList.remove('done'); }, 4000);
    } else {
      box.hidden = true;
      box.classList.remove('done');
    }
    this.wasRunning = false;
  }

  setMeta(text) { if (this.meta) this.meta.textContent = text; }

  /** Count warn/error log records (shown on the 日志 button until the drawer opens). */
  noteLog(rec) {
    if (rec?.level !== 'warn' && rec?.level !== 'error') return;
    this.logCounts[rec.level] += 1;
    this._paintLogCount();
  }

  resetLogCount() {
    this.logCounts = { warn: 0, error: 0 };
    this._paintLogCount();
  }

  _paintLogCount() {
    const el = this.logCountEl;
    if (!el) return;
    const n = this.logCounts.warn + this.logCounts.error;
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('badge-danger', this.logCounts.error > 0);
    el.classList.toggle('badge-warn', !this.logCounts.error);
    const btn = $('#btnLogs');
    if (btn) btn.dataset.tip = n ? `日志\n${this.logCounts.error} 个错误 · ${this.logCounts.warn} 个警告` : '日志\n.vdm/logs 运行日志';
  }
}

// ---------------------------------------------------------------- log drawer
export class LogDrawer {
  constructor({ onOpen } = {}) {
    this.el = $('#logDrawer');
    this.btn = $('#btnLogs');
    this.onOpen = onOpen;
    $('#logDrawerClose')?.addEventListener('click', () => this.close());
  }

  isOpen() { return !!this.el && !this.el.hidden; }

  open() {
    if (!this.el || this.isOpen()) return;
    this.el.hidden = false;
    this.btn?.setAttribute('aria-pressed', 'true');
    this.onOpen?.();
  }

  close() {
    if (!this.el || !this.isOpen()) return false;
    this.el.hidden = true;
    this.btn?.setAttribute('aria-pressed', 'false');
    return true;
  }

  toggle() { if (this.isOpen()) this.close(); else this.open(); }
}
