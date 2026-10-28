// Inspector: edit the selected element down to the details (or project fx when nothing is selected).
// Layout follows docs/DESIGN.md §1.4: sticky header, collapsible sections, one-line property rows
// (label | control | ◆) with vector rows, unit suffixes and three-state keyframe buttons.
import { sampleTrack } from '/core/time.js';
import { objectPose, sampleChannel } from '/core/scene.js';
import { ancestors, wouldCycle, STRENGTH_TRACKS } from '/core/hierarchy.js';
import { MEDIA_TYPES, FITS, ALIGNS, mediaSpec, textSpec } from '/core/objects-media.js';
import { normalizeWorld } from '/core/world.js';
import { RotBall } from './rotball.js';
import { SpeedCurve, SPEED_PRESETS } from './speedcurve.js';
import { attachNumberField, readNumber, writeNumber } from './numfield.js';
import { widthFor, isWidth } from './field-width.js';
import { frameWriteTime } from './timeline-math.js';
import { splitRef } from '/core/selection.js';
import { h, icon, prefs } from './ui.js';
import {
  elementRowLinkPaths, linkJumpTarget, linkOf, linkSourceLabel, linkSummary, openLinkMenu,
} from './link-menu.js';
import { effectiveElementRowValue, localElementRowValue } from './element-link-value.js';

const MOTIONS = ['none', 'in', 'out', 'left', 'right', 'up', 'down', 'drift', 'shake'];
const FONTS = ['SimHei', 'Microsoft YaHei', 'Arial', 'Impact', 'Bahnschrift', 'Consolas'];
const EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth', 'outExpo', 'inOutCubic', 'outBack'];

const EL_LABELS = { image: '图片', video: '视频', text: '文字', shape: '形状', solid: '色块', audio: '声音' };
const OBJ_LABELS = {
  empty: '空元素', solid: '3D 物体', shape: '3D 形状', text: '3D 文字', image: '3D 图片', video: '3D 视频',
  camera: '相机', container: '容器', audio: '声音',
};
// short names for the keyframe list (full path stays in the hover title)
const PATH_LABELS = {
  'transform.x': 'X', 'transform.y': 'Y', 'transform.z': '纵深', 'transform.scale': '缩放',
  'transform.rotation': '旋转', 'transform.opacity': '不透明度', 'style.size': '字号', 'style.color': '颜色',
  'style.fill': '填充', 'fx.glow': '辉光', 'audio.volume': '音量', dir: '朝向', roll: '自转',
};
const KF_TIP = '打关键帧\nShift+点击 删除当前帧关键帧';

/** '#abc' / 'abc' / '#aabbcc' -> '#aabbcc' (null when not a hex colour) */
function normHex(v) {
  const s = String(v ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) return `#${s.split('').map((c) => c + c).join('')}`.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s}`.toLowerCase();
  return null;
}

export class Inspector {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.debounce = new Map();
    this.lastRenderKey = '';
    this._kfSync = [];
    this._kind = 'project';
  }

  _commit(key, op, delay = 180) {
    const prev = this.debounce.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.debounce.delete(key);
      this.opts.onOp(op);
    }, delay);
    this.debounce.set(key, { timer, op });
  }

  /** send pending edits now (blur, keyframe button) instead of dropping them */
  _flush() {
    const pending = [...this.debounce.values()];
    this.debounce.clear();
    for (const { timer, op } of pending) {
      clearTimeout(timer);
      this.opts.onOp(op);
    }
  }

  render(project, sel, time) {
    this._last = { project, sel, time };
    const active = document.activeElement;
    if (this._ballDragging || this._speedDragging) return;
    if (this.root.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active?.tagName || '')) { this._syncKeys(); return; }
    // The pool primary is what the panel edits; legacy single-selection fields
    // stay as a fallback for callers that pass no pool. A cam / ob / el mixed
    // selection still shows only the primary entity (plus a count).
    const primary = sel?.pool?.kind ? splitRef(sel.pool.primary) : null;
    const multi = sel?.pool?.kind === 'element' && sel.pool.ids.length > 1 ? sel.pool.ids.length : 0;
    const key = `${project.rev}|${primary ? `${primary.type}:${primary.id}` : (sel?.camera ? 'cam' : '')}|${sel?.elementId}|${sel?.objectId}|${sel?.segmentId}|${multi}|${Math.round(time * 10)}`;
    if (key === this.lastRenderKey) { this._syncKeys(); return; }
    this.lastRenderKey = key;
    this.root.innerHTML = '';
    this._kfSync = [];
    this._elId = null;
    this.root.classList.add('insp');
    // The back chip belongs to the sticky header so a scrolled panel cannot hide
    // it; it is only present after a "转到父级" jump.
    this._back = !!this.opts.canGoBack?.();
    const objectId = primary?.type === 'ob' ? primary.id : (primary ? null : sel?.objectId);
    const elementId = primary?.type === 'el' ? primary.id : (primary ? null : sel?.elementId);
    const camera = primary ? primary.type === 'cam' : !!sel?.camera;
    const object = (project.scene?.objects || []).find((o) => o.id === objectId);
    const element = project.elements.find((e) => e.id === elementId);
    const cam = camera ? ((project.cameras || []).find((c) => c.id === primary?.id) || project.camera) : null;
    if (object) this._renderObject(project, object, time, multi);
    else if (element) this._renderElement(project, element, time, multi);
    else if (sel?.segmentId) this._renderSegment(project, sel.segmentId);
    else if (cam) this._renderCamera(project, time, cam, multi);
    else this._renderProject(project);
  }

  /** Repaint ◆ states / current-key rows for the playhead without rebuilding the panel. */
  _syncKeys() {
    for (const fn of this._kfSync) {
      try { fn(); } catch { /* stale node */ }
    }
  }

  /**
   * Time to write for a new key: the playhead frame's 3-decimal left edge
   * (timeline-math.js frameWriteTime), so the ◆ and the timelane diamond agree
   * at 24/30/60fps. Existing non-frame keys are only ever read, never rewritten.
   */
  _keyTime() {
    const p = this._last?.project;
    return frameWriteTime(this.opts.getTime(), p?.meta?.fps, p?.meta?.duration || 0);
  }

  _refresh() {
    if (!this._last) return;
    this.lastRenderKey = '';
    this.render(this._last.project, this._last.sel, this._last.time);
  }

  // ---------------------------------------------------------------- header
  /**
   * Sticky header: type badge · name (click to rename) · dim id · icon actions.
   * actions: [{ icon, label, tip, danger, run }]
   */
  _header({ type, badge, name, id, onRename, actions = [], multi = 0 }) {
    const nameBtn = onRename
      ? h('button', { type: 'button', class: 'insp-name', 'data-tip': '单击改名', 'aria-label': `名称：${name}，单击改名` }, name || '—')
      : h('span', { class: 'insp-name static', title: name }, name || '—');
    if (onRename) {
      nameBtn.addEventListener('click', () => {
        const input = h('input', { type: 'text', class: 'insp-rename', 'aria-label': '名称', spellcheck: 'false' });
        input.value = name ?? '';
        let done = false;
        const finish = (commit) => {
          if (done) return;
          done = true;
          const v = input.value;
          if (commit && v.trim() && v !== name) {
            onRename(v);
            this._flush();
            name = v;
            nameBtn.textContent = v;
          }
          if (input.isConnected) input.replaceWith(nameBtn);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        nameBtn.replaceWith(input);
        input.focus();
        input.select();
      });
    }
    const head = h('div', { class: 'insp-head' },
      this._back ? h('button', {
        type: 'button', class: 'mini insp-back', 'data-tip': '返回上一个属性面板（Alt+←）',
        onclick: () => this.opts.onBack?.(),
      }, '← 返回') : null,
      h('span', { class: `badge${type ? ` badge-${type}` : ''} insp-kind` }, badge),
      nameBtn,
      id ? h('span', { class: 'insp-id', title: id }, id) : null,
      multi > 1 ? h('span', {
        class: 'insp-multi', 'data-tip': '多选：面板、Delete 都只作用于最后选中的那个（primary）',
      }, `${multi} 个选中`) : null,
      actions.length ? h('div', { class: 'insp-actions' }, ...actions.map((a) => h('button', {
        type: 'button', class: `icon-btn${a.danger ? ' danger' : ''}`,
        'aria-label': a.label, 'data-tip': a.tip || a.label, onclick: a.run,
      }, icon(a.icon)))) : null,
    );
    this.root.appendChild(head);
    return head;
  }

  // ---------------------------------------------------------------- sections
  /** legacy signature: an always-open section keyed by its title */
  _section(title, ...kids) {
    return this._sec(title, {}, ...kids);
  }

  /**
   * Collapsible section. Collapsed state lives in prefs.sections under
   * `<objectKind>:<key>` (key defaults to the title).
   */
  _sec(title, { key, open = true, count, tag } = {}, ...kids) {
    const pk = `${this._kind}:${key || title}`;
    const store = prefs.get('sections', {}) || {};
    const collapsed = Object.prototype.hasOwnProperty.call(store, pk) ? !!store[pk] : !open;
    const head = h('div', { class: 'sec-head', role: 'button', tabindex: '0', 'aria-expanded': String(!collapsed) },
      icon('chevron-down', 'ic-sm sec-chev'),
      h('span', { class: 'sec-name' }, title),
      count != null ? h('span', { class: 'sec-count' }, String(count)) : null,
      tag ? h('span', { class: 'sec-tag' }, tag) : null,
    );
    const sec = h('section', { class: `sec${collapsed ? ' collapsed' : ''}`, dataset: { sec: pk } },
      head, h('div', { class: 'sec-body' }, ...kids));
    const toggle = () => {
      const now = !sec.classList.contains('collapsed');
      sec.classList.toggle('collapsed', now);
      head.setAttribute('aria-expanded', String(!now));
      const s = { ...(prefs.get('sections', {}) || {}) };
      s[pk] = now;
      prefs.set('sections', s);
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return sec;
  }

  // ---------------------------------------------------------------- property rows
  // Label, control, `↳` property-link button and ◆ are direct children of the
  // grid; the control sits in a .ctl wrapper so the width classes (w-third /
  // w-half / w-full) can size it without touching the link / keyframe columns.
  _row(label, control, kfNode, cls = '', linkNode = null, linked = false) {
    return h('div', { class: `prop fld${cls ? ` ${cls}` : ''}` },
      h('label', { title: label }, label,
        linked ? h('span', { class: 'parent-mark', 'data-tip': '这个属性有属性父级' }, '父') : null),
      h('span', { class: 'ctl' }, control),
      h('span', { class: 'link-slot' }, linkNode),
      kfNode || h('span', { class: 'kf-slot' }));
  }

  // ---------------------------------------------------------------- property links
  /** Host by kind + id, always read from the project the panel last rendered. */
  _linkHost(kind, id) {
    const p = this._last?.project;
    if (!p) return null;
    const key = String(id ?? '');
    const list = kind === 'el' ? (p.elements || [])
      : kind === 'ob' ? (p.scene?.objects || [])
        : [...(p.cameras || []), ...(p.camera ? [p.camera] : [])];
    return list.find((host) => String(host?.id ?? '') === key) || null;
  }

  _linked(link) {
    return !!link && !!linkOf(this._linkHost(link.kind, link.id), link.path);
  }

  /**
   * `↳` next to a property input (PLAN-ui-round3 §4.2). Left click opens the
   * link menu; right click opens the same menu at the pointer, where the jump /
   * unlink entries live. Lit = this property has a property parent.
   */
  _linkButton(link) {
    const btn = h('button', { type: 'button', class: 'link-btn', 'aria-label': '属性父级' });
    btn.textContent = '↳';
    const paint = () => {
      const current = linkOf(this._linkHost(link.kind, link.id), link.path);
      btn.classList.toggle('on', !!current);
      btn.dataset.tip = current
        ? `属性父级：${linkSourceLabel(this._last?.project, current)}（右键：转到 / 解除）`
        : '属性父级：点击选择父级属性（右键也可）';
    };
    const open = (anchor, x, y) => {
      this._flush();
      openLinkMenu({
        project: this._last?.project,
        hostKind: link.kind,
        id: link.id,
        to: link.path,
        anchor, x, y,
        t: this.opts.getTime?.(),
        onOp: this.opts.onOp,
        onJump: this.opts.onLinkJump,
        toast: this.opts.onToast,
      });
    };
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); open(btn); });
    btn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      open(null, ev.clientX, ev.clientY);
    });
    paint();
    this._kfSync.push(paint);
    return btn;
  }

  /** First line under the header: linked property parents (count + host chips). */
  _linksSummary(project, host) {
    const summary = linkSummary(project, host);
    if (!summary) return null;
    return h('div', { class: 'insp-links' },
      h('span', { class: 'insp-links-k' }, '属性父级'),
      h('span', { class: 'insp-links-count', 'data-tip': '已链接的属性数量' }, String(summary.count)),
      h('div', { class: 'insp-link-chips' }, ...summary.links.map((link) => h('button', {
        type: 'button', class: 'link-chip',
        'data-tip': `转到父级：${linkSourceLabel(project, link)}（不激活相机、不改项目）`,
        onclick: () => {
          this._flush();
          const target = linkJumpTarget(link, link.to);
          if (target) this.opts.onLinkJump?.(target);
        },
      }, linkSourceLabel(project, link)))));
  }

  /** ◆ with three states; getState() -> 'none' | 'anim' | 'on' (re-read on every playhead sync). */
  _kfButton(getState, onKey, onUnkey) {
    const b = h('button', {
      type: 'button', class: 'kf-btn', 'aria-label': '打关键帧', 'data-tip': KF_TIP,
      onclick: (e) => {
        this._flush();
        if (e.shiftKey) onUnkey(); else onKey();
      },
    });
    const paint = () => {
      const s = getState();
      b.dataset.state = s;
      b.classList.toggle('on', s === 'on');
      b.classList.toggle('anim', s === 'anim');
      b.textContent = s === 'on' ? '◆' : '◇';
    };
    paint();
    this._kfSync.push(paint);
    return b;
  }

  /** ◆ for element tracks: keys every path at the playhead (keySet), Shift removes them (keyRemove). */
  _elKfButton(paths) {
    return this._kfButton(
      () => this._elKeyState(paths),
      () => {
        const t = this._keyTime();
        for (const path of paths) this.opts.onOp({ op: 'keySet', id: this._elId, path, t, value: this.opts.getTimeValue(path) });
      },
      () => {
        for (const path of paths) {
          const k = this._keyAtPlayhead(path);
          if (k) this.opts.onOp({ op: 'keyRemove', id: this._elId, path, t: k.t });
        }
      },
    );
  }

  _elKeyState(paths) {
    const el = this._last?.project?.elements.find((e) => e.id === this._elId);
    if (!el) return 'none';
    if (paths.some((p) => this._keyAtPlayhead(p))) return 'on';
    return paths.some((p) => (el.keyframes || []).some((k) => k.path === p)) ? 'anim' : 'none';
  }

  /** numeric box: optional axis letter / prefix, numfield input, unit suffix */
  _num({ value, step = 0.01, min, max, percent = false, unit, axis, prefix, placeholder, aria, onChange }) {
    const input = h('input', { type: 'text', step, min, max, placeholder: placeholder || '', 'aria-label': aria || null });
    if (percent) { input.dataset.scale = '100'; input.dataset.unit = '%'; }
    attachNumberField(input);
    writeNumber(input, value, { force: true });
    input.addEventListener('input', () => {
      const v = readNumber(input);
      if (v == null || !Number.isFinite(v)) return;
      onChange(v);
    });
    input.addEventListener('blur', () => this._flush());
    const box = h('span', { class: 'nbox' },
      axis ? h('span', { class: `ax ax-${axis}`, 'aria-hidden': 'true' }, axis.toUpperCase())
        : prefix ? h('span', { class: 'ax', 'aria-hidden': 'true' }, prefix) : null,
      input,
      unit && !percent ? h('span', { class: 'unit', 'aria-hidden': 'true' }, unit) : null);
    // clicking the axis letter / unit focuses the value
    box.addEventListener('pointerdown', (e) => {
      if (e.target === input) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
    return box;
  }

  _field({
    label, value, type = 'number', step = 0.01, min, max, path, kf, keyer, options, onChange,
    placeholder, percent = false, unit, w, link = null,
  }) {
    const kfNode = keyer ? this._kfButton(keyer.state, keyer.set, keyer.unset)
      : kf ? this._elKfButton([path]) : null;
    const linkNode = link ? this._linkButton(link) : null;
    const linked = this._linked(link);
    // Width is decided from type/value/step/bounds once per build; an explicit
    // `w` (e.g. a path field that should not shrink while it is empty) wins.
    const width = isWidth(w) ? w : widthFor({ type, value, step, min, max, unit, percent, placeholder, key: label });
    const cls = `w-${width}${type === 'textarea' ? ' tall' : ''}`;
    if (type === 'number') {
      const box = this._num({ value, step, min, max, percent, unit, placeholder, aria: label, onChange });
      return this._row(label, box, kfNode, cls, linkNode, linked);
    }
    if (type === 'color') return this._row(label, this._color(label, value, onChange), kfNode, cls, linkNode, linked);
    let input;
    if (type === 'select') {
      input = h('select', { 'aria-label': label }, ...options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return h('option', { value: v, selected: String(v) === String(value) }, l);
      }));
    } else if (type === 'textarea') {
      input = h('textarea', { rows: 2, placeholder: placeholder || '', 'aria-label': label }); input.value = value ?? '';
    } else if (type === 'checkbox') {
      input = h('input', { type: 'checkbox', checked: !!value, 'aria-label': label });
    } else {
      input = h('input', { type: 'text', placeholder: placeholder || '', 'aria-label': label });
      input.value = value ?? '';
    }
    const emit = () => {
      const v = type === 'checkbox' ? input.checked : input.value;
      if (v == null) return;
      onChange(v);
    };
    if (type === 'select' || type === 'checkbox') input.addEventListener('change', emit);
    else input.addEventListener('input', emit);
    input.addEventListener('blur', () => this._flush());
    const control = type === 'checkbox' ? h('span', { class: 'chk' }, input) : input;
    return this._row(label, control, kfNode, cls, linkNode, linked);
  }

  /** 24×24 swatch + hex text, both editing the same value */
  _color(label, value, onChange) {
    let cur = value ?? '';
    const sw = h('input', { type: 'color', class: 'swatch', value: normHex(cur) || '#ffffff', 'aria-label': `${label}（取色）` });
    const tx = h('input', { type: 'text', class: 'hex', spellcheck: 'false', 'aria-label': `${label}（十六进制）` });
    tx.value = cur;
    sw.addEventListener('input', () => { tx.value = sw.value; tx.classList.remove('invalid'); });
    sw.addEventListener('change', () => { cur = sw.value; tx.value = cur; onChange(cur); });
    tx.addEventListener('change', () => {
      const v = normHex(tx.value);
      if (!v) { tx.classList.add('invalid'); return; }
      tx.classList.remove('invalid');
      cur = v;
      tx.value = v;
      sw.value = v;
      onChange(v);
    });
    tx.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); tx.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); tx.value = cur; tx.classList.remove('invalid'); tx.blur(); }
    });
    for (const n of [sw, tx]) n.addEventListener('blur', () => this._flush());
    return h('span', { class: 'color-ctl' }, sw, tx);
  }

  /**
   * Several number boxes on one row (X/Y, start/duration, W/H).
   * items: [{ axis | prefix, value, step, min, max, unit, percent, onChange, aria }]
   * keyPaths: element tracks keyed together by the row's ◆.
   */
  _vec({ label, items, keyPaths, keyer }) {
    const kfNode = keyer ? this._kfButton(keyer.state, keyer.set, keyer.unset)
      : keyPaths ? this._elKfButton(keyPaths) : null;
    // A per-input `link` gets its own `↳` right of that input (X/Y rows link
    // independently); the row label carries the small 父 mark when any does.
    const boxes = items.map((it) => {
      const box = this._num(it);
      return it.link ? h('span', { class: 'vec-cell' }, box, this._linkButton(it.link)) : box;
    });
    const linked = items.some((it) => it.link && this._linked(it.link));
    return this._row(label, h('div', { class: `vec vec-${items.length}` }, ...boxes), kfNode, 'w-full', null, linked);
  }

  /** read-only value row */
  _ro(label, text) {
    return this._row(label, h('div', { class: 'ro', title: text }, text), undefined, 'w-full');
  }

  /** the selected element's key on `path` within half a frame of the playhead */
  _keyAtPlayhead(path) {
    const p = this._last?.project;
    const el = p?.elements.find((e) => e.id === this._elId);
    if (!el) return null;
    const tol = 0.5 / (p.meta.fps || 24);
    const t = this.opts.getTime();
    return (el.keyframes || []).find((k) => k.path === path && Math.abs(k.t - t) <= tol) || null;
  }

  // ---------------------------------------------------------------- 2D element
  _renderElement(project, el, time, multi = 0) {
    this._elId = el.id;
    this._kind = el.type;
    const set = (path, patch) => this._commit(`${el.id}:${path}`, { op: 'updateElement', id: el.id, patch });
    this._header({
      type: el.type, badge: EL_LABELS[el.type] || el.type, name: el.name, id: el.id, multi,
      onRename: (v) => set('name', { name: v }),
      actions: [
        {
          icon: 'copy', label: '复制', tip: '复制\n在后面复制一份（放不下时贴着结尾）',
          run: () => {
            const start = Math.max(0, Math.min(el.start + el.duration, project.meta.duration - el.duration));
            this.opts.onOp({ op: 'duplicateElement', id: el.id, start: Math.round(start * 1000) / 1000 });
          },
        },
        {
          icon: 'trash', label: '删除', danger: true,
          run: () => { if (confirm(`删除 ${el.name}?`)) this.opts.onOp({ op: 'removeElement', id: el.id }); },
        },
      ],
    });
    const linksSummary = this._linksSummary(project, el);
    if (linksSummary) this.root.appendChild(linksSummary);

    if (el.parent?.id) {
      const parentId = String(el.parent.id);
      const parentHost = parentId === '@live' ? null
        : (project.elements || []).find((x) => x.id === parentId)
          || (project.scene?.objects || []).find((x) => x.id === parentId)
          || (project.cameras || []).find((x) => x.id === parentId);
      const parentName = parentId === '@live' ? '当前镜头 (@live，随剪辑切换)' : (parentHost?.name || parentId);
      const jump = () => {
        if (parentId === '@live') this.opts.onSelect?.({ camera: true });
        else if ((project.elements || []).some((x) => x.id === parentId)) this.opts.onSelect?.({ elementId: parentId });
        else if ((project.scene?.objects || []).some((x) => x.id === parentId)) this.opts.onSelect?.({ objectId: parentId });
        else if ((project.cameras || []).some((x) => x.id === parentId)) this.opts.onSelect?.({ camera: true });
      };
      const unparent = () => this.opts.onOp(el.parent.mode === 'world'
        ? { op: 'spatialUnparent', id: el.id }
        : { op: 'elementUnparent', id: el.id, t: tNow() });
      this.root.appendChild(h('div', { class: 'hint pad insp-parent' },
        h('span', { class: 'insp-parent-name' }, `空间父级：${parentName}`),
        h('button', { type: 'button', class: 'mini', onclick: jump }, '转到父级'),
        h('button', { type: 'button', class: 'mini', onclick: unparent }, '解除')));
    }

    // Keyable fields show the keyed value at the playhead (before motion presets
    // and fades). Once a property has keys, typing a value keys it at the
    // playhead; otherwise it edits the base value.
    const keyed = (path) => (el.keyframes || []).some((k) => k.path === path);
    const kv = (path, base) => effectiveElementRowValue(
      project, el, path, time, sampleTrack(el.keyframes, path, time, base),
    );
    // binding re-reads the pose at the playhead; keys land on the frame edge
    const tNow = () => Math.round(this.opts.getTime() * 1000) / 1000;
    const keyT = () => this._keyTime();
    const edit = (path, patch) => (v) => {
      // A linked row displays the effective value; the project still stores the
      // local value (writeBackLocalValue inverts the link at the playhead).
      const local = localElementRowValue(project, el, path, time, v);
      const value = local == null ? v : local;
      if (keyed(path)) this._commit(`${el.id}:${path}`, { op: 'keySet', id: el.id, path, t: keyT(), value });
      else set(path, patch(value));
    };
    // Property links target core/links.js paths: a legacy 2D element links
    // pivot.* / roll / scale.* / opacity, never transform.* (PLAN §3.3).
    const linkPath = (rowPath) => elementRowLinkPaths(el, rowPath)[0] || null;
    const link = (rowPath) => {
      const path = linkPath(rowPath);
      return path ? { kind: 'el', id: el.id, path } : null;
    };

    const timeRows = [
      this._vec({
        label: '开始 / 时长',
        items: [
          { value: round(el.start), step: 0.01, min: 0, unit: 's', aria: '开始', onChange: (v) => this._commit(`${el.id}:start`, { op: 'moveElement', id: el.id, start: v }) },
          { value: round(el.duration), step: 0.01, min: 0.05, unit: 's', aria: '时长', onChange: (v) => this._commit(`${el.id}:dur`, { op: 'moveElement', id: el.id, duration: v }) },
        ],
      }),
    ];
    if (el.type !== 'audio') {
      timeRows.push(
        this._vec({
          label: '淡入 / 淡出',
          items: [
            { value: el.fadeIn || 0, step: 0.05, min: 0, unit: 's', aria: '淡入', onChange: (v) => set('fade', { fadeIn: v }) },
            { value: el.fadeOut || 0, step: 0.05, min: 0, unit: 's', aria: '淡出', onChange: (v) => set('fade', { fadeOut: v }) },
          ],
        }),
        this._field({ label: '层级 z', value: el.z, step: 1, onChange: (v) => this._commit(`${el.id}:z`, { op: 'moveElement', id: el.id, z: v }) }),
      );
    }
    const baseSec = () => this._sec('基础', { open: false },
      this._field({
        label: '所属分镜', type: 'select', value: el.segment || '', options: [{ value: '', label: '—' }, ...project.segments.map((s) => ({ value: s.id, label: `${s.name} (${s.start.toFixed(1)}s)` }))],
        onChange: (v) => set('segment', { segment: v || null }),
      }));

    if (el.type === 'audio') {
      this.root.appendChild(this._sec('时间', {}, ...timeRows));
      this.root.appendChild(this._sec('声音', {},
        this._field({ label: '素材', type: 'text', value: el.src || '', w: 'full', onChange: (v) => set('src', { src: v }) }),
        this._field({
          label: '音量', value: round(kv('audio.volume', el.volume ?? 1), 3),
          step: 0.01, min: 0, max: 1, percent: true, kf: true, path: 'audio.volume',
          link: link('audio.volume'),
          onChange: edit('audio.volume', (v) => ({ volume: v })),
        }),
        this._field({ label: '源入点', unit: 's', value: round(el.srcIn || 0), step: 0.05, min: 0, onChange: (v) => set('srcIn', { srcIn: v }) }),
        h('div', { class: 'hint' }, '声音也是时间线元素：拖时间块改时长，展开「声音」给音量打关键帧。'),
      ));
      this.root.appendChild(baseSec());
      return;
    }

    this.root.appendChild(this._sec('变换', {},
      this._vec({
        label: '位置', keyPaths: ['transform.x', 'transform.y'],
        items: [
          { axis: 'x', value: round(kv('transform.x', el.transform.x)), unit: 'px', aria: 'X', link: link('transform.x'), onChange: edit('transform.x', (v) => ({ transform: { x: v } })) },
          { axis: 'y', value: round(kv('transform.y', el.transform.y)), unit: 'px', aria: 'Y', link: link('transform.y'), onChange: edit('transform.y', (v) => ({ transform: { y: v } })) },
        ],
      }),
      this._field({ label: '纵深 z', unit: 'm', value: round(kv('transform.z', el.transform.z ?? 0), 3), step: 0.05, kf: true, path: 'transform.z', link: link('transform.z'), onChange: edit('transform.z', (v) => ({ transform: { z: v } })) }),
      this._field({ label: '缩放', value: round(kv('transform.scale', el.transform.scale), 3), step: 0.01, kf: true, path: 'transform.scale', link: link('transform.scale'), onChange: edit('transform.scale', (v) => ({ transform: { scale: v } })) }),
      this._field({ label: '旋转', unit: '°', value: round(kv('transform.rotation', el.transform.rotation), 2), step: 0.5, kf: true, path: 'transform.rotation', link: link('transform.rotation'), onChange: edit('transform.rotation', (v) => ({ transform: { rotation: v } })) }),
      this._field({ label: '不透明度', value: round(kv('transform.opacity', el.transform.opacity), 3), step: 0.01, min: 0, max: 1, percent: true, kf: true, path: 'transform.opacity', link: link('transform.opacity'), onChange: edit('transform.opacity', (v) => ({ transform: { opacity: v } })) }),
      this._field({ label: '跟随节拍', value: el.punch || 0, step: 0.05, min: 0, max: 2, onChange: (v) => set('punch', { punch: v }) }),
      el.parent?.id ? null : this._field({
        label: '贴屏', type: 'checkbox', value: false,
        // screen-locked = parented to the active camera, bound at the playhead (no jump either way)
        onChange: (v) => this.opts.onOp(v
          ? { op: 'elementParent', id: el.id, parent: project.activeCameraId, t: tNow() }
          : { op: 'elementUnparent', id: el.id, t: tNow() }),
      }),
    ));

    this.root.appendChild(this._sec('时间', {}, ...timeRows));

    if (el.type === 'text') {
      this.root.appendChild(this._sec('文字', {},
        this._field({ label: '内容', type: 'textarea', value: el.style.text, onChange: (v) => set('style.text', { style: { text: v } }) }),
        this._field({ label: '字体', type: 'select', value: el.style.font, options: FONTS, onChange: (v) => set('style.font', { style: { font: v } }) }),
        this._field({ label: '字号', unit: 'px', value: round(kv('style.size', el.style.size), 1), step: 1, kf: true, path: 'style.size', onChange: edit('style.size', (v) => ({ style: { size: v } })) }),
        this._field({ label: '颜色', type: 'color', value: el.style.color, onChange: (v) => set('style.color', { style: { color: v } }) }),
        this._field({
          label: '对齐', type: 'select', value: el.style.align, options: [{ value: 'center', label: '居中' }, { value: 'left', label: '左' }, { value: 'right', label: '右' }],
          onChange: (v) => set('style.align', { style: { align: v } }),
        }),
        this._field({ label: '字距', value: el.style.letterSpacing || 0, step: 1, onChange: (v) => set('style.ls', { style: { letterSpacing: v } }) }),
        this._field({ label: '行高', value: el.style.lineHeight || 1.18, step: 0.02, onChange: (v) => set('style.lh', { style: { lineHeight: v } }) }),
        this._field({ label: '阴影', value: el.style.shadow || 0, step: 0.1, min: 0, max: 4, onChange: (v) => set('style.sh', { style: { shadow: v } }) }),
        this._field({ label: '字重', value: el.style.weight || 400, step: 100, onChange: (v) => set('style.w', { style: { weight: v } }) }),
      ));
    } else if (el.type === 'image' || el.type === 'video') {
      this.root.appendChild(this._sec('画面', {},
        this._field({
          label: '适配', type: 'select', value: el.style.fit, options: [{ value: 'cover', label: '填满裁剪' }, { value: 'stretch', label: '拉伸' }],
          onChange: (v) => set('style.fit', { style: { fit: v } }),
        }),
        this._field({ label: '素材', type: 'text', value: el.src || '', w: 'full', onChange: (v) => set('src', { src: v }) }),
        this._field({ label: '源入点', unit: 's', value: el.srcIn || 0, step: 0.05, onChange: (v) => set('srcIn', { srcIn: v }) }),
      ));
    } else {
      this.root.appendChild(this._sec('形状', {},
        this._field({
          label: '类型', type: 'select', value: el.style.shape, options: [{ value: 'rect', label: '矩形' }, { value: 'ellipse', label: '椭圆' }],
          onChange: (v) => set('style.shape', { style: { shape: v } }),
        }),
        this._field({ label: '填充', type: 'color', value: el.style.fill, onChange: (v) => set('style.fill', { style: { fill: v } }) }),
        this._vec({
          label: '尺寸',
          items: [
            { prefix: 'W', value: el.style.w || project.meta.width, step: 10, unit: 'px', aria: '宽', onChange: (v) => set('style.w', { style: { w: v } }) },
            { prefix: 'H', value: el.style.h || project.meta.height, step: 10, unit: 'px', aria: '高', onChange: (v) => set('style.h', { style: { h: v } }) },
          ],
        }),
        this._field({ label: '圆角', unit: 'px', value: el.style.radius || 0, step: 1, onChange: (v) => set('style.r', { style: { radius: v } }) }),
      ));
    }

    this.root.appendChild(this._sec('运动', { open: false },
      this._field({
        label: '预设', type: 'select', value: el.motion?.type || 'none',
        options: MOTIONS.map((m) => ({ value: m, label: ({ none: '无', in: '推近', out: '拉远', left: '左移', right: '右移', up: '上移', down: '下移', drift: '漂移', shake: '手持抖动' })[m] })),
        onChange: (v) => set('motion.type', { motion: { ...el.motion, type: v } }),
      }),
      this._field({ label: '幅度', value: el.motion?.amount || 0, step: 0.01, min: 0, max: 1, onChange: (v) => set('motion.amount', { motion: { ...el.motion, amount: v } }) }),
    ));

    this.root.appendChild(this._sec('效果', { open: false },
      this._field({ label: '辉光', value: round(kv('fx.glow', el.fx?.glow || 0), 3), step: 0.05, min: 0, max: 2, kf: true, path: 'fx.glow', onChange: edit('fx.glow', (v) => ({ fx: { ...el.fx, glow: v } })) }),
      this._field({
        label: '混合', type: 'select', value: el.style.blend || 'normal',
        options: [{ value: 'normal', label: '正常' }, { value: 'add', label: '相加' }, { value: 'screen', label: '滤色' }],
        onChange: (v) => set('style.blend', { style: { blend: v } }),
      }),
    ));

    this._renderKeyframes(project, el, time);
    this.root.appendChild(baseSec());
  }

  // ---------------------------------------------------------------- 3D object: picture / video / text
  /** 内容: source + fit for image/video planes, typography for 3D text. */
  _renderMedia(obj) {
    const id = obj.id;
    const patch = (key, p) => this._commit(`${id}:media:${key}`, { op: 'objectPatch', id, patch: p }, 250);
    const FIT_LABELS = { contain: '完整显示', cover: '铺满裁切', stretch: '拉伸' };
    const ALIGN_LABELS = { left: '左', center: '中', right: '右' };
    const kids = [];
    if (obj.type === 'text') {
      const t = textSpec(obj);
      kids.push(
        this._field({ label: '文字', type: 'textarea', value: t.text, onChange: (v) => patch('text', { style: { text: v } }) }),
        this._field({ label: '字号', unit: 'm', value: t.size, step: 0.05, min: 0.01, onChange: (v) => patch('size', { style: { size: v } }) }),
        this._field({ label: '颜色', type: 'color', value: t.color, onChange: (v) => patch('color', { style: { color: v } }) }),
        this._field({
          label: '字体', type: 'text', value: t.font, placeholder: 'media/fonts/xxx.ttf 或字体名', w: 'full',
          onChange: (v) => patch('font', { style: { font: v } }),
        }),
        this._field({
          label: '对齐', type: 'select', value: t.align, options: ALIGNS.map((a) => ({ value: a, label: ALIGN_LABELS[a] })),
          onChange: (v) => patch('align', { style: { align: v } }),
        }),
        this._field({ label: '字距', unit: 'em', value: t.tracking, step: 0.01, onChange: (v) => patch('tracking', { style: { tracking: v } }) }),
        this._field({ label: '行高', value: t.lineHeight, step: 0.05, min: 0.1, onChange: (v) => patch('lineHeight', { style: { lineHeight: v } }) }),
        this._field({ label: '厚度', unit: 'm', value: t.extrude, step: 0.01, min: 0, onChange: (v) => patch('extrude', { style: { extrude: v } }) }),
        this._field({ label: '亮度', value: t.emissive, step: 0.05, min: 0, onChange: (v) => patch('emissive', { style: { emissive: v } }) }),
        h('div', { class: 'hint' }, '字号 = 一个字（em）的高度，单位米。厚度只在成片里有，视口里画正面。'),
      );
    } else {
      const m = mediaSpec(obj);
      kids.push(
        this._field({
          label: obj.type === 'video' ? '视频' : '图片', type: 'text', value: m.src, placeholder: 'media/xxx', w: 'full',
          onChange: (v) => patch('src', { src: v }),
        }),
        this._field({
          label: '适配', type: 'select', value: m.fit, options: FITS.map((f) => ({ value: f, label: FIT_LABELS[f] })),
          onChange: (v) => patch('fit', { style: { fit: v } }),
        }),
        this._vec({
          label: '框尺寸',
          items: [
            { prefix: 'W', value: m.w, step: 0.1, min: 0.01, unit: 'm', aria: '框宽', onChange: (v) => patch('w', { geom: { w: v } }) },
            { prefix: 'H', value: m.h, step: 0.1, min: 0.01, unit: 'm', aria: '框高', onChange: (v) => patch('h', { geom: { h: v } }) },
          ],
        }),
        this._field({ label: '亮度', value: m.emissive, step: 0.05, min: 0, onChange: (v) => patch('emissive', { style: { emissive: v } }) }),
      );
      if (obj.type === 'video') {
        kids.push(
          this._field({ label: '入点', unit: 's', value: m.srcIn, step: 0.04, min: 0, onChange: (v) => patch('srcIn', { srcIn: v }) }),
          this._field({ label: '速度', value: m.rate, step: 0.05, min: 0.01, onChange: (v) => patch('rate', { rate: v }) }),
        );
      }
      kids.push(h('div', { class: 'hint' }, '正面朝「朝向」所指的方向；从正面看图像不镜像。完整显示会按图片比例缩小到框内。'));
    }
    return this._sec('内容', {}, ...kids);
  }

  // ---------------------------------------------------------------- 3D object: parent
  /** 父级: pick a parent, inherit switches, keyable rotation/scale strength. */
  _renderParent(project, obj, time) {
    const id = obj.id;
    // binding re-reads the pose at the playhead, so it keeps the exact time;
    // strength keys are new keyframes and land on the frame edge
    const tNow = () => Math.round(this.opts.getTime() * 1000) / 1000;
    const keyT = () => this._keyTime();
    const objs = project.scene?.objects || [];
    const par = obj.parent || null;
    const reparent = (extra) => this.opts.onOp({ op: 'objectParent', id, parent: par?.id, t: tNow(), ...extra });
    const options = [{ value: '', label: '（无）' }].concat(objs
      .filter((o) => o.id !== id && o.type !== 'audio' && !wouldCycle(objs, id, o.id))
      .map((o) => ({ value: o.id, label: `${o.name || o.id}${o.type === 'empty' ? ' · 空' : ''}` })));
    const kids = [
      this._field({
        label: '父级', type: 'select', value: par?.id || '', options,
        onChange: (v) => this.opts.onOp(v
          ? { op: 'objectParent', id, parent: v, t: tNow() }
          : { op: 'objectUnparent', id, t: tNow() }),
      }),
    ];
    if (par) {
      const inh = par.inherit || {};
      for (const [k, label] of [['pos', '跟随位置'], ['rot', '跟随旋转'], ['scale', '跟随缩放']]) {
        kids.push(this._field({
          label, type: 'checkbox', value: inh[k] !== false,
          onChange: (v) => reparent({ inherit: { [k]: v } }),
        }));
      }
      const tol = 0.5 / (project.meta?.fps || 24);
      const liveTrack = (ch) => {
        const o = (this._last?.project?.scene?.objects || []).find((x) => x.id === id) || obj;
        return o.tracks?.[STRENGTH_TRACKS[ch]] || [];
      };
      for (const [ch, label] of [['rot', '旋转强度'], ['scale', '缩放强度']]) {
        const track = obj.tracks?.[STRENGTH_TRACKS[ch]] || [];
        const v = sampleChannel(track, time, par.strength?.[ch] ?? 1);
        const atKey = track.find((k) => Math.abs(k.t - time) <= tol);
        kids.push(this._field({
          label, value: Math.round(Number(v) * 1000) / 1000, step: 0.01, min: 0, max: 1, percent: true,
          // Keyed channel: write a key at the playhead; otherwise change the base strength (re-binds at the playhead).
          onChange: (nv) => this._commit(`${id}:parent.${ch}`, track.length
            ? { op: 'objectParentKey', id, channel: ch, t: keyT(), v: nv }
            : { op: 'objectParent', id, parent: par.id, t: tNow(), strength: { [ch]: nv } }),
          keyer: {
            state: () => {
              const tr = liveTrack(ch);
              if (!tr.length) return 'none';
              const now = this.opts.getTime();
              return tr.some((k) => Math.abs(k.t - now) <= tol) ? 'on' : 'anim';
            },
            set: () => this.opts.onOp({ op: 'objectParentKey', id, channel: ch, t: keyT(), v: Number(v) }),
            unset: () => this.opts.onOp({ op: 'objectParentUnkey', id, channel: ch, t: atKey ? atKey.t : keyT() }),
          },
        }));
      }
      const chain = ancestors(objs, id).map((o) => o.name || o.id).join(' ← ');
      kids.push(h('div', { class: 'hint' }, `层级：${obj.name || id} ← ${chain}。挂上 / 取下 / 改开关都以当前时间为准，不跳位。`));
    } else {
      kids.push(h('div', { class: 'hint' }, '选一个元素当父级（常用「空元素」），之后它怎么动，这个元素就跟着怎么动。'));
    }
    return this._sec('父级', {}, ...kids);
  }

  // ---------------------------------------------------------------- 3D object
  _renderObject(project, obj, time, multi = 0) {
    const id = obj.id;
    this._kind = `3d.${obj.type}`;
    const pose = objectPose(obj, time);
    const tNow = () => this._keyTime();
    const key = (path, v) => this.opts.onOp({ op: 'objectKey', id, path, t: tNow(), v });
    const tol = 0.5 / (project.meta?.fps || 24);
    const liveObj = () => (this._last?.project?.scene?.objects || []).find((o) => o.id === id) || obj;

    this._header({ type: 'object', badge: OBJ_LABELS[obj.type] || '3D 元素', name: obj.name || id, id, multi });
    const linksSummary = this._linksSummary(project, obj);
    if (linksSummary) this.root.appendChild(linksSummary);
    this.root.appendChild(h('div', { class: 'hint pad' },
      '内容、中心点、位置、缩放、不透明度已移到时间轴左侧：选中元素后点元素行的 ▾ 展开编辑。',
      '复制 / 删除 / 面向镜头 / 落地在元素行的 ⋯ 菜单里。'));

    const dirKeys = (obj.tracks?.dir || []).filter((k) => Array.isArray(k.v));
    const ballHost = h('div', { class: 'rotball-wrap' });
    new RotBall(ballHost, {
      dir: pose.dir,
      keys: dirKeys,
      time,
      onStart: () => { this._ballDragging = true; },
      onEnd: () => { this._ballDragging = false; },
      onChange: (d) => this._commit(`${id}:dir`, { op: 'objectKey', id, path: 'dir', t: tNow(), v: d }, 90),
    });
    this.root.appendChild(this._sec('朝向', { tag: obj.parent?.id ? '本地' : null },
      ballHost,
      this._field({
        label: '绕轴自转', unit: '°', value: Math.round(pose.roll * 10) / 10, step: 1,
        link: { kind: 'ob', id, path: 'roll' },
        onChange: (v) => key('roll', v),
        keyer: {
          state: () => {
            const tr = liveObj().tracks?.roll || [];
            if (!tr.length) return 'none';
            const now = this.opts.getTime();
            return tr.some((k) => Math.abs(k.t - now) <= tol) ? 'on' : 'anim';
          },
          set: () => key('roll', Math.round(objectPose(liveObj(), this.opts.getTime()).roll * 1000) / 1000),
          unset: () => {
            const now = this.opts.getTime();
            const k = (liveObj().tracks?.roll || []).find((x) => Math.abs(x.t - now) <= tol);
            if (k) this.opts.onOp({ op: 'objectUnkey', id, path: 'roll', t: k.t });
          },
        },
      }),
      h('div', { class: 'hint' }, '拖球面上的点改朝向（写 dir 关键帧）；旋转球和速度曲线留在检查器，其余基础属性在时间轴左侧。'),
    ));

    if (MEDIA_TYPES.has(obj.type)) this.root.appendChild(this._renderMedia(obj));
    this.root.appendChild(this._renderParent(project, obj, time));

    const rows = [];
    for (const [path, list] of Object.entries(obj.tracks || {})) {
      if (path.startsWith('parent.')) continue; // shown in the 父级 section
      for (const k of list || []) rows.push({ path, k });
    }
    rows.sort((a, b) => a.k.t - b.k.t);
    const kfList = h('div', { class: 'kf-list' });
    if (!rows.length) kfList.appendChild(h('div', { class: 'hint' }, '还没有关键帧：拖动元素或点 ◇。'));
    for (const { path, k } of rows) {
      const open = this._speedOpen && this._speedOpen.id === id
        && this._speedOpen.path === path && Math.abs(this._speedOpen.t - k.t) < 1e-3;
      const row = h('div', { class: 'kf-row' },
        h('button', { type: 'button', class: 'kf-t', 'data-tip': '跳到这个关键帧', onclick: () => this.opts.onSeek?.(k.t) }, k.t.toFixed(2)),
        h('span', { class: 'kf-p', title: path }, PATH_LABELS[path] || path),
        h('span', { class: 'kf-v' }, Array.isArray(k.v) ? k.v.map((n) => round(n, 2)).join(', ') : String(k.v)),
        h('select', {
          class: 'kf-ease', 'aria-label': '缓动', 'data-tip': '缓动\n到下一关键帧的 ease 预设（该键有速度曲线时被忽略）',
          onchange: (e) => this.opts.onOp({ op: 'objectKey', id, path, t: k.t, v: k.v, ease: e.target.value }),
        }, ...EASES.map((x) => h('option', { value: x, selected: (k.ease || 'easeInOut') === x }, x))),
        h('button', {
          type: 'button', class: `icon-btn mini${open ? ' on' : ''}`, 'aria-label': '速度曲线', 'data-tip': '速度曲线\n编辑这一段的速度曲线',
          onclick: () => { this._speedOpen = open ? null : { id, path, t: k.t }; this._refresh(); },
        }, icon('curve', 'ic-sm')),
        h('button', {
          type: 'button', class: 'icon-btn mini danger', 'aria-label': '删除关键帧', 'data-tip': '删除这个关键帧',
          onclick: () => this.opts.onOp({ op: 'objectUnkey', id, path, t: k.t }),
        }, icon('trash', 'ic-sm')),
      );
      this._trackAtRow(row, k.t);
      kfList.appendChild(row);
      if (open) {
        const wrap = h('div', { class: 'speed-wrap' });
        new SpeedCurve(wrap, {
          points: k.speed,
          onStart: () => { this._speedDragging = true; },
          onEnd: () => { this._speedDragging = false; },
          onChange: (pts) => this._commit(
            `${id}:speed:${path}:${k.t}`,
            { op: 'objectKey', id, path, t: k.t, v: k.v, speed: pts },
            90,
          ),
        });
        const setPreset = (pts) => this.opts.onOp({ op: 'objectKey', id, path, t: k.t, v: k.v, speed: pts });
        wrap.appendChild(h('div', { class: 'row-btns' },
          h('button', { type: 'button', class: 'mini', onclick: () => setPreset(SPEED_PRESETS.linear) }, '匀速'),
          h('button', { type: 'button', class: 'mini', onclick: () => setPreset(SPEED_PRESETS.easeIn) }, '慢入'),
          h('button', { type: 'button', class: 'mini', onclick: () => setPreset(SPEED_PRESETS.easeOut) }, '慢出'),
          h('button', { type: 'button', class: 'mini', onclick: () => setPreset(SPEED_PRESETS.punch) }, '冲击'),
          h('button', { type: 'button', class: 'mini', onclick: () => this.opts.onOp({ op: 'objectKey', id, path, t: k.t, v: k.v, speed: null }) }, '清除'),
        ));
        kfList.appendChild(wrap);
      }
    }
    this.root.appendChild(this._sec('关键帧', { key: '关键帧', open: false, count: rows.length }, kfList));
  }

  /** tint a keyframe-list row while the playhead sits on its key (kept in sync between rebuilds) */
  _trackAtRow(row, t) {
    const paint = () => row.classList.toggle('at', Math.abs(t - this.opts.getTime()) < 0.05);
    paint();
    this._kfSync.push(paint);
  }

  _renderKeyframes(project, el, time) {
    const kfs = [...(el.keyframes || [])].sort((a, b) => a.t - b.t);
    const list = h('div', { class: 'kf-list' });
    if (!kfs.length) list.appendChild(h('div', { class: 'hint' }, '还没有关键帧。点字段右边的 ◇ 在当前时间记录。'));
    for (const k of kfs) {
      const outside = k.t < el.start - 1e-6 || k.t > el.start + el.duration + 1e-6;
      const row = h('div', {
        class: `kf-row${outside ? ' outside' : ''}`,
        'data-tip': outside ? '这个关键帧在元素时间范围之外（切分后保留，用来保持动画连续）' : null,
      },
        h('button', { type: 'button', class: 'kf-t', 'data-tip': '跳到这个关键帧', onclick: () => this.opts.onSeek?.(k.t) }, k.t.toFixed(2) + 's'),
        h('span', { class: 'kf-p', title: k.path }, PATH_LABELS[k.path] || k.path),
        h('span', { class: 'kf-v', title: String(k.value) }, String(k.value).slice(0, 14)),
        h('select', {
          class: 'kf-ease', 'aria-label': '缓动',
          onchange: (e) => this.opts.onOp({ op: 'keySet', id: el.id, path: k.path, t: k.t, value: k.value, ease: e.target.value }),
        }, ...EASES.map((e) => h('option', { value: e, selected: e === k.ease }, e))),
        h('button', {
          type: 'button', class: 'icon-btn mini', 'aria-label': '复制到播放头', 'data-tip': '复制到播放头\n在当前时间放一个同值关键帧',
          onclick: () => this.opts.onOp({ op: 'keySet', id: el.id, path: k.path, t: this._keyTime(), value: k.value, ease: k.ease }),
        }, icon('plus', 'ic-sm')),
        h('button', {
          type: 'button', class: 'icon-btn mini danger', 'aria-label': '删除关键帧', 'data-tip': '删除这个关键帧',
          onclick: () => this.opts.onOp({ op: 'keyRemove', id: el.id, path: k.path, t: k.t }),
        }, icon('trash', 'ic-sm')),
      );
      this._trackAtRow(row, k.t);
      list.appendChild(row);
    }
    this.root.appendChild(this._sec('关键帧', { key: '关键帧', open: false, count: kfs.length }, list));
  }

  // ---------------------------------------------------------------- world (camera view + project view)
  _worldSection(project, open = true) {
    // normalised: an empty world is stored as little as {source:'none'}
    const w = normalizeWorld(project.world);
    const setW = (patch) => this._commit('world', { op: 'worldSet', patch });
    const empty = w.source === 'none';
    const fog = [
      this._field({ label: '雾开始', unit: 'm', value: w.fog.start ?? 30, step: 5, min: 0, max: 500, onChange: (v) => setW({ fog: { ...w.fog, start: v } }) }),
      this._field({ label: '雾深度', unit: 'm', value: w.fog.depth ?? 700, step: 25, min: 10, max: 5000, onChange: (v) => setW({ fog: { ...w.fog, depth: v } }) }),
      this._field({ label: '雾强度', value: w.fog.strength ?? 1, step: 0.05, min: 0, max: 1, onChange: (v) => setW({ fog: { ...w.fog, strength: v } }) }),
    ];
    const head = [
      this._field({
        label: '世界', type: 'select', value: w.source,
        options: [{ value: 'none', label: '空（只有背景）' }, { value: 'procedural', label: '程序化城市' }],
        onChange: (v) => this.opts.onOp({ op: 'worldSet', patch: { source: v } }),
      }),
      this._field({ label: '背景色', type: 'color', value: w.sky, onChange: (v) => setW({ sky: v }) }),
    ];
    if (empty) {
      return this._sec('世界', { open }, ...head, ...fog,
        h('div', { class: 'hint' }, '空世界只有背景色和你自己加的元素；编辑视口里的地面网格不进成片。需要城市时把「世界」切到程序化城市。'));
    }
    return this._sec('世界', { open },
      ...head,
      this._row('seed',
        h('div', { class: 'ctl-with-btn' },
          this._num({ value: w.seed, step: 1, aria: 'seed', onChange: (v) => setW({ seed: v }) }),
          h('button', { type: 'button', class: 'mini', onclick: () => setW({ seed: Math.floor(Math.random() * 9999) }) }, '换一座城')),
        undefined, 'w-full'),
      this._field({ label: '航线避让', type: 'select', value: String(!!w.corridor.enabled), options: [{ value: 'true', label: '开' }, { value: 'false', label: '关' }], onChange: (v) => setW({ corridor: { ...w.corridor, enabled: v === 'true' } }) }),
      this._field({ label: '避让半径', unit: 'm', value: w.corridor.radius, step: 1, min: 0, max: 120, onChange: (v) => setW({ corridor: { ...w.corridor, radius: v } }) }),
      h('div', { class: 'hint' }, '航线穿过或擦到的楼会被清掉，换 seed 也不会把塔吊在无人机航线上。'),
      this._vec({
        label: '街区 / 街道',
        items: [
          { value: w.grid.block, step: 2, unit: 'm', aria: '街区', onChange: (v) => setW({ grid: { ...w.grid, block: v } }) },
          { value: w.grid.street, step: 2, unit: 'm', aria: '街道', onChange: (v) => setW({ grid: { ...w.grid, street: v } }) },
        ],
      }),
      this._field({ label: '密度', value: w.density, step: 0.02, min: 0, max: 1, onChange: (v) => setW({ density: v }) }),
      this._vec({
        label: '楼高',
        items: [
          { prefix: '低', value: w.height.min, step: 2, unit: 'm', aria: '最低楼高', onChange: (v) => setW({ height: { ...w.height, min: v } }) },
          { prefix: '高', value: w.height.max, step: 5, unit: 'm', aria: '最高楼高', onChange: (v) => setW({ height: { ...w.height, max: v } }) },
        ],
      }),
      this._field({ label: '亮窗比例', value: w.window.density, step: 0.02, min: 0, max: 1, onChange: (v) => setW({ window: { ...w.window, density: v } }) }),
      this._field({ label: '窗光强度', value: w.window.glow, step: 0.1, onChange: (v) => setW({ window: { ...w.window, glow: v } }) }),
      this._field({ label: '霓虹强度', value: w.neon.glow, step: 0.1, onChange: (v) => setW({ neon: { ...w.neon, glow: v } }) }),
      ...fog,
    );
  }

  _renderCamera(project, time, cam = project.camera, multi = 0) {
    if (!cam) return;
    this._kind = 'camera';
    this._header({
      type: 'camera', badge: '镜头', name: cam.name || '镜头',
      id: `${(cam.path || []).length} 关键点 · FOV ${round(cam.fov, 0)}°`, multi,
      actions: [{ icon: 'film', label: '渲染', tip: '渲染\n从头到尾渲染这个镜头', run: () => this.opts.onRenderAll?.() }],
    });
    const linksSummary = this._linksSummary(project, cam);
    if (linksSummary) this.root.appendChild(linksSummary);
    this.root.appendChild(h('div', { class: 'hint pad' },
      '相机属性折叠在时间轴相机行里：点行首 ▾ 展开；位置是飞行路径关键帧，中心点 / 画面 / 透明度 / 缩放也能逐帧打点。'));
    this.root.appendChild(this._worldSection(project, true));
  }

  _renderSegment(project, id) {
    const s = project.segments.find((x) => x.id === id);
    if (!s) return;
    this._kind = 'segment';
    const set = (patch) => this._commit(`${s.id}:seg`, { op: 'updateSegment', id: s.id, patch });
    this._header({ type: null, badge: '分镜', name: s.name, id: s.id, onRename: (v) => set({ name: v }) });
    this.root.appendChild(this._sec('分镜', {},
      this._field({ label: '意图 / 台词', type: 'textarea', value: s.intent, onChange: (v) => set({ intent: v }) }),
      this._vec({
        label: '开始 / 时长',
        items: [
          { value: round(s.start), unit: 's', aria: '开始', onChange: (v) => this._commit(`${s.id}:st`, { op: 'updateSegment', id: s.id, patch: { start: v } }) },
          { value: round(s.duration), unit: 's', aria: '时长', onChange: (v) => this._commit(`${s.id}:du`, { op: 'updateSegment', id: s.id, patch: { duration: v } }) },
        ],
      }),
      this._field({
        label: '状态', type: 'select', value: s.status, options: ['draft', 'previewed', 'approved'],
        onChange: (v) => set({ status: v }),
      }),
    ));
    const kids = project.elements.filter((e) => e.segment === s.id);
    this.root.appendChild(this._sec('本段元素', { key: '本段元素', count: kids.length },
      h('div', { class: 'chip-list' }, ...kids.map((k) => h('button', {
        type: 'button', class: 'chip', onclick: () => this.opts.onSelect({ elementId: k.id, segmentId: s.id }),
      }, `${k.id} ${k.type === 'text' ? JSON.stringify(String(k.style.text).slice(0, 10)) : ''}`)))));
    this.root.appendChild(h('div', { class: 'row-btns insp-foot' },
      h('button', { type: 'button', class: 'mini', onclick: () => this.opts.onRenderSegment(s.id) }, '渲染本段'),
      h('button', { type: 'button', class: 'mini', onclick: () => this.opts.onAskAI(s.id) }, '让 AI 改这段'),
    ));
  }

  _renderProject(project) {
    const fx = project.meta.fx || {};
    this._kind = 'project';
    const setMeta = (path) => (v) => this._commit(`meta:${path}`, { op: 'setMeta', path, value: v });
    const setFx = (k) => (v) => this._commit(`fx:${k}`, { op: 'setFx', fx: { [k]: v } });
    this._header({
      type: 'accent', badge: '项目', name: project.meta.title,
      id: `${project.meta.width}×${project.meta.height} · ${project.meta.fps}fps`,
      onRename: setMeta('title'),
    });

    this.root.appendChild(this._sec('项目', {},
      this._field({ label: '时长', unit: 's', value: round(project.meta.duration), onChange: setMeta('duration') }),
      this._field({ label: '背景色', type: 'color', value: project.meta.background, onChange: setMeta('background') }),
      this._field({ label: '帧率', type: 'text', value: String(project.meta.fps), onChange: setMeta('fps') }),
    ));

    this.root.appendChild(this._sec('画面效果', { open: false },
      this._field({ label: '辉光 bloom', value: fx.bloom, step: 0.05, min: 0, max: 2, onChange: setFx('bloom') }),
      this._field({ label: '色散 ca', value: fx.ca, step: 0.02, min: 0, max: 1, onChange: setFx('ca') }),
      this._field({ label: '颗粒 grain', value: fx.grain, step: 0.01, min: 0, max: 1, onChange: setFx('grain') }),
      this._field({ label: '暗角 vignette', value: fx.vignette, step: 0.02, min: 0, max: 1, onChange: setFx('vignette') }),
      this._field({ label: '扫描线 scanline', value: fx.scanline, step: 0.02, min: 0, max: 1, onChange: setFx('scanline') }),
      this._field({ label: '冷暖 grade', value: fx.grade, step: 0.02, min: -1, max: 1, onChange: setFx('grade') }),
      this._field({ label: '对比 contrast', value: fx.contrast, step: 0.02, min: -1, max: 1, onChange: setFx('contrast') }),
      this._field({ label: '饱和 saturation', value: fx.saturation, step: 0.02, min: 0, max: 2, onChange: setFx('saturation') }),
    ));

    this.root.appendChild(this._sec('音频与节拍', {},
      this._ro('音频', project.meta.audio?.src || '（未设置）'),
      this._field({ label: '偏移', unit: 's', value: project.meta.audio?.offset || 0, step: 0.01, onChange: (v) => this._commit('audio:off', { op: 'setMeta', path: 'audio.offset', value: v }) }),
      this._field({ label: '增益', unit: 'dB', value: project.meta.audio?.gain || 0, step: 0.5, onChange: (v) => this._commit('audio:gain', { op: 'setMeta', path: 'audio.gain', value: v }) }),
      this._row('节拍',
        h('div', { class: 'ctl-with-btn' },
          h('div', { class: 'ro' }, `${project.meta.tempo || 0} bpm · ${project.meta.beats.length} 个`),
          h('button', { type: 'button', class: 'mini', 'data-tip': '重新分析节拍', onclick: () => this.opts.analyzeBeats() }, '重新分析')),
        undefined, 'w-full'),
    ));

    if (project.camera) this.root.appendChild(this._worldSection(project, true));

    this.root.appendChild(h('div', { class: 'hint pad' }, '选中元素后可以逐项编辑；点画面里的元素或时间线里的色块。'));
  }
}

const round = (v, d = 2) => {
  const p = Math.pow(10, d);
  return Math.round(Number(v) * p) / p;
};
