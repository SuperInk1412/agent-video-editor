// Inspector: edit the selected element down to the details (or project fx when nothing is selected).
// Layout follows docs/DESIGN.md §1.4: sticky header, collapsible sections, one-line property rows
// (label | control | ◆) with vector rows, unit suffixes and three-state keyframe buttons.
import { sampleTrack } from '/core/time.js';
import { objectPose, sampleChannel } from '/core/scene.js';
import { normalizeFeed } from '/core/camfeed.js';
import { cameraValueWithLinks, objectPoseWithLinks, writeBackLocalValue } from '/core/links.js';
import { cameraRotationAt, parentStrengthAt, spatialAncestors, wouldSpatialCycle } from '/core/spatial.js';
import { basisFromRotation, rotationFromDirRoll } from '/core/rotation.js';
import { MEDIA_TYPES, FITS, ALIGNS, mediaSpec, textSpec } from '/core/objects-media.js';
import { normalizeWorld } from '/core/world.js';
import { RotBall } from './rotball.js';
import { SpeedCurve, SPEED_PRESETS } from './speedcurve.js';
import { attachNumberField, readNumber, writeNumber } from './numfield.js';
import { widthFor, isWidth } from './field-width.js';
import { frameWriteTime } from './timeline-math.js';
import { elementNodeAt } from './node-at.js';
import { splitRef } from '/core/selection.js';
import {
  XF_AXES, XF_ROWS, bundleOps, xfAxisLinkPath, xfKeyOps, xfKeyState, xfOpacityKeyState,
  xfOpacityOps, xfOpacityUnkeyOps, xfSetAxisOps, xfUnkeyOps, xfValues,
} from './xform.js';
import { h, icon, prefs } from './ui.js';
import {
  linkJumpTarget, linkOf, linkPropLabel, linkSourceLabel, linkSummary, openLinkMenu,
} from './link-menu.js';
import {
  effectiveElementRowValue, elementRowKeyPath, elementRowTarget, localElementRowValue,
  localElementRowValueAt, nodeRowPatch, rowToTarget,
} from './element-link-value.js';

const MOTIONS = ['none', 'in', 'out', 'left', 'right', 'up', 'down', 'drift', 'shake'];
const FONTS = ['SimHei', 'Microsoft YaHei', 'Arial', 'Impact', 'Bahnschrift', 'Consolas'];
const EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth', 'outExpo', 'inOutCubic', 'outBack'];

const EL_LABELS = { image: '图片', video: '视频', text: '文字', shape: '形状', solid: '色块', audio: '声音', camfeed: '投屏' };
const OBJ_LABELS = {
  empty: '空元素', solid: '3D 物体', shape: '3D 形状', text: '3D 文字', image: '3D 图片', video: '3D 视频',
  camera: '相机', container: '容器', audio: '声音',
};
// short names for the keyframe list (full path stays in the hover title)
const PATH_LABELS = {
  'transform.x': 'X', 'transform.y': 'Y', 'transform.z': '纵深', 'transform.scale': '缩放',
  'transform.rotation': '旋转', 'transform.opacity': '不透明度', 'style.size': '字号', 'style.color': '颜色',
  'style.fill': '填充', 'fx.glow': '辉光', 'audio.volume': '音量', dir: '朝向', roll: '自转',
  'rotation.x': '旋转 X', 'rotation.y': '旋转 Y', 'rotation.z': '旋转 Z',
  'pivot.x': '中心点 X', 'pivot.y': '中心点 Y', 'pivot.z': '中心点 Z',
  'position.x': '位置 X', 'position.y': '位置 Y', 'position.z': '位置 Z',
  'scale.x': '缩放 X', 'scale.y': '缩放 Y', 'scale.z': '缩放 Z',
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
   * actions: [{ icon, label, tip, danger, on, run }]
   * `locked` tints the header (--edit-bg) and the lock action (WP2.5b §10.5);
   * the fields below stay editable, because a human may still edit a lock.
   */
  _header({ type, badge, name, id, onRename, actions = [], multi = 0, locked = false }) {
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
    const head = h('div', { class: `insp-head${locked ? ' is-locked' : ''}` },
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
        type: 'button', class: `icon-btn${a.danger ? ' danger' : ''}${a.on ? ' on' : ''}${a.lock ? ' insp-lock' : ''}`,
        'aria-label': a.label, 'aria-pressed': a.on ? 'true' : null, 'data-tip': a.tip || a.label, onclick: a.run,
      }, icon(a.icon)))) : null,
    );
    this.root.appendChild(head);
    return head;
  }

  /** Lock action for a host header (first action, before copy / trash). */
  _lockAction(kind, host) {
    const locked = host?.locked === true;
    const op = kind === 'camera' ? 'cameraPatch' : kind === 'object' ? 'objectPatch' : 'updateElement';
    return {
      icon: locked ? 'lock' : 'lock-open',
      label: locked ? '解锁' : '锁定',
      on: locked,
      lock: true,
      tip: locked ? '已锁定：视口里不能点选拖动，AI 不能修改' : '锁定后 agent 不能改这个元素',
      run: () => this.opts.onOp({ op, id: host.id, patch: { locked: !locked } }),
    };
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
    if (!link) return false;
    const host = this._linkHost(link.kind, link.id);
    if (!host) return false;
    const paths = Array.isArray(link.paths) && link.paths.length ? link.paths : [link.path];
    return paths.some((p) => !!linkOf(host, p));
  }

  /**
   * `↳` next to a property input (PLAN-ui-round3 §4.2). Left click opens the
   * link menu; right click opens the same menu at the pointer, where the jump /
   * unlink entries live. Lit = this property has a property parent.
   */
  _linkButton(link) {
    const btn = h('button', { type: 'button', class: 'link-btn', 'aria-label': '属性父级' });
    btn.textContent = '↳';
    // A row-level button carries several axis paths (one menu for X/Y/Z); the
    // old single-path form is unchanged.
    const paths = Array.isArray(link.paths) && link.paths.length ? link.paths.slice() : [link.path];
    const paint = () => {
      const host = this._linkHost(link.kind, link.id);
      const current = paths.map((p) => linkOf(host, p)).find(Boolean) || null;
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
        paths,
        labels: paths.map((p) => linkPropLabel(p)),
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
  _num({ value, step = 0.01, min, max, percent = false, unit, axis, prefix, placeholder, aria, onChange, dim = false, tip = '', readOnly = false }) {
    const input = h('input', { type: 'text', step, min, max, placeholder: placeholder || '', 'aria-label': aria || null });
    if (percent) { input.dataset.scale = '100'; input.dataset.unit = '%'; }
    if (readOnly) { input.readOnly = true; input.tabIndex = -1; }
    attachNumberField(input);
    writeNumber(input, value, { force: true });
    if (!readOnly) {
      input.addEventListener('input', () => {
        const v = readNumber(input);
        if (v == null || !Number.isFinite(v)) return;
        onChange(v);
      });
      input.addEventListener('blur', () => this._flush());
    }
    const box = h('span', { class: `nbox${dim ? ' dim' : ''}${readOnly ? ' ro' : ''}` },
      axis ? h('span', { class: `ax ax-${axis}`, 'aria-hidden': 'true' }, axis.toUpperCase())
        : prefix ? h('span', { class: 'ax', 'aria-hidden': 'true' }, prefix) : null,
      input,
      unit && !percent ? h('span', { class: 'unit', 'aria-hidden': 'true' }, unit) : null);
    if (dim) box.dataset.tip = tip || '这个轴在当前类型上不改变外观';
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
  _vec({ label, items, keyPaths, keyer, kfNode: explicitKf, rowLink = null }) {
    const kfNode = explicitKf !== undefined ? explicitKf
      : keyer ? this._kfButton(keyer.state, keyer.set, keyer.unset)
        : keyPaths ? this._elKfButton(keyPaths) : null;
    const rowLinkNode = rowLink ? this._linkButton(rowLink) : null;
    // A per-input `link` gets its own `↳` right of that input (X/Y rows link
    // independently) unless the row carries one multi-axis `↳` instead; the
    // row label keeps the small 父 mark either way.
    const boxes = items.map((it) => {
      const box = this._num(it);
      return it.link && !rowLinkNode
        ? h('span', { class: 'vec-cell' }, box, this._linkButton(it.link))
        : box;
    });
    const linked = (rowLink && this._linked(rowLink))
      || items.some((it) => it.link && this._linked(it.link));
    return this._row(label, h('div', { class: `vec vec-${items.length}` }, ...boxes), kfNode, 'w-full', rowLinkNode, linked);
  }

  /** read-only value row */
  _ro(label, text) {
    return this._row(label, h('div', { class: 'ro', title: text }, text), undefined, 'w-full');
  }

  /**
   * One rotation row, three cells (X / Y / Z degrees). Each cell carries its own
   * property-link `↳`; one ◆ keys/removes the whole triple because rotation is
   * authored as a pose (the timeline has per-axis diamonds for single axes).
   */
  _rotationRow({ label = '三轴旋转', items, kfNode = null }) {
    const boxes = items.map((it) => {
      const box = this._num({
        axis: it.axis, value: it.value, step: 0.5,
        aria: `${label} ${it.axis.toUpperCase()}`, onChange: it.onChange,
      });
      return it.link
        ? h('span', { class: 'vec-cell rot-cell' }, box, this._linkButton(it.link))
        : box;
    });
    const linked = items.some((it) => it.link && this._linked(it.link));
    return this._row(label, h('div', { class: 'vec vec-3' }, ...boxes), kfNode, 'w-full', null, linked);
  }

  _xfTol() {
    return 0.5 / (Number(this._last?.project?.meta?.fps) || 24);
  }

  _xfOp(ops) {
    const op = bundleOps(ops);
    if (!op) return;
    this._flush();
    this.opts.onOp(op);
  }

  /**
   * One unified transform row for the property panel (DESIGN-TRANSFORM-UNIFY
   * §9): a total ◆ keys the row, three cells edit/link X/Y/Z. The timeline adds
   * the expandable per-axis sub-rows; here the row is the compact form.
   */
  _xfRow(project, host, kind, rowKey, {
    step = 0.1, unit = '', readOnly = false, noKf = false,
    dimZ = false, dimTip = '', label = '',
  } = {}) {
    const t = this.opts.getTime();
    const vals = xfValues(project, host, kind, t)[rowKey] || [0, 0, 0];
    const tol = this._xfTol();
    const lab = label || (XF_ROWS.find((r) => r.key === rowKey) || {}).label || rowKey;
    const state = () => {
      const st = xfKeyState(host, kind, rowKey, this.opts.getTime(), tol);
      return st.at ? 'on' : st.has ? 'anim' : 'none';
    };
    const kfNode = noKf
      ? h('button', {
        type: 'button', class: 'kf-btn off', disabled: true, 'aria-label': '关键帧',
        'data-tip': '2D 位置暂不单独打帧：屏幕运动写在中心点（运动路径 §5 待做）',
      }, '◇')
      : this._kfButton(
        state,
        () => this._xfOp(xfKeyOps(project, host, kind, rowKey, this._keyTime())),
        () => this._xfOp(xfUnkeyOps(project, host, kind, rowKey, this._keyTime(), tol)),
      );
    const axisPaths = XF_AXES.map((ax) => xfAxisLinkPath(kind, host, rowKey, ax)).filter(Boolean);
    const rowLink = axisPaths.length ? { kind, id: host.id, paths: axisPaths } : null;
    const row = this._vec({
      label: lab,
      kfNode,
      rowLink,
      items: XF_AXES.map((ax, i) => {
        return {
          axis: ax,
          value: Math.round(Number(vals[i]) * 1000) / 1000,
          step, unit, aria: `${lab} ${ax.toUpperCase()}`,
          readOnly,
          link: null,
          onChange: readOnly ? null : (v) => this._xfOp(
            xfSetAxisOps(project, host, kind, rowKey, ax, v, this._keyTime(), tol),
          ),
          dim: dimZ && ax === 'z',
          tip: dimZ && ax === 'z'
            ? (dimTip || '平面没有厚度：Z 缩放只影响挂在下面的子元素')
            : '',
        };
      }),
    });
    // The four short transform labels fit a narrower column than the default
    // 72px, which gives the three value cells room for values like -12.5.
    row.classList.add('xf-row');
    return row;
  }

  /** Opacity row after the four transform rows (same key semantics as the timeline). */
  _xfOpacity(project, host, kind) {
    const t = this.opts.getTime();
    const tol = this._xfTol();
    const value = Math.round(Number(xfValues(project, host, kind, t).opacity) * 1000) / 1000;
    return this._field({
      label: '不透明度', value, step: 0.01, min: 0, max: 1, percent: true,
      link: { kind, id: host.id, path: 'opacity' },
      keyer: {
        state: () => {
          const st = xfOpacityKeyState(host, kind, this.opts.getTime(), tol);
          return st.at ? 'on' : st.has ? 'anim' : 'none';
        },
        set: () => this._xfOp(xfOpacityOps(project, host, kind, value, this._keyTime(), true)),
        unset: () => this._xfOp(xfOpacityUnkeyOps(host, kind, this._keyTime(), tol)),
      },
      onChange: (v) => this._xfOp(xfOpacityOps(
        project, host, kind, v, this._keyTime(), xfOpacityKeyState(host, kind, t, tol).has,
      )),
    });
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
      locked: el.locked === true,
      actions: [
        // The lock comes before copy / delete (docs/DESIGN-WP2.5-REVIEW.md §5).
        this._lockAction('element', el),
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
      const unparent = () => this.opts.onOp({ op: 'spatialUnparent', id: el.id });
      this.root.appendChild(h('div', { class: 'hint pad insp-parent' },
        h('span', { class: 'insp-parent-name' }, `空间父级：${parentName}`),
        h('button', { type: 'button', class: 'mini', onclick: jump }, '转到父级'),
        h('button', { type: 'button', class: 'mini', onclick: unparent }, '解除')));
    }
    this.root.appendChild(this._parentTools(project, el, 'el'));

    // Keyable fields show the keyed value at the playhead (before motion presets
    // and fades). Once a property has keys, typing a value keys it at the
    // playhead; otherwise it edits the base value.
    const keyed = (rowPath) => (el.keyframes || []).some((k) => k.path === elementRowKeyPath(el, rowPath));
    const kp = (rowPath) => elementRowKeyPath(el, rowPath);
    const kv = (rowPath, base) => {
      const local = localElementRowValueAt(project, el, rowPath, time);
      const fallback = local != null
        ? local
        : sampleTrack(el.keyframes, elementRowKeyPath(el, rowPath), time, base);
      return effectiveElementRowValue(project, el, rowPath, time, fallback);
    };
    // binding re-reads the pose at the playhead; keys land on the frame edge
    const tNow = () => Math.round(this.opts.getTime() * 1000) / 1000;
    const keyT = () => this._keyTime();
    const edit = (rowPath, patch) => (v) => {
      // A linked row displays the effective value; the project still stores the
      // local value (writeBackLocalValue inverts the link at the playhead).
      const local = localElementRowValue(project, el, rowPath, time, v);
      const rowValue = local == null ? v : local;
      if (keyed(rowPath)) {
        const target = elementRowTarget(el, rowPath);
        const value = target ? rowToTarget(el, project.meta, target, rowValue, rowPath) : rowValue;
        this._commit(`${el.id}:${rowPath}`, {
          op: 'keySet', id: el.id, path: elementRowKeyPath(el, rowPath), t: keyT(),
          value: value == null ? rowValue : value,
        });
        return;
      }
      if (el.node) {
        const nodePatch = nodeRowPatch(el, rowPath, rowValue, project.meta);
        if (nodePatch) {
          this._commit(`${el.id}:node`, { op: 'updateElement', id: el.id, patch: nodePatch });
          return;
        }
      }
      set(rowPath, patch(rowValue));
    };
    // Property links target core/links.js paths: a legacy 2D element links
    // pivot.* / roll / scale.* / opacity, never transform.* (PLAN §3.3).
    const linkPath = (rowPath) => elementRowTarget(el, rowPath);
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

    const node = el.node ? elementNodeAt(el, project.meta, time) : null;
    const nodeVec = (group, label, step, unit, { dimZ = false, dimTip = '', noKf = false } = {}) => {
      const arr = Array.isArray(node?.[group]) ? node[group] : [0, 0, 0];
      const kf = noKf
        ? h('button', {
          type: 'button', class: 'kf-btn off', disabled: true, 'aria-label': '关键帧',
          'data-tip': '2D 位置暂不单独打帧：屏幕运动写在中心点（运动路径 §5 待做）',
        }, '◇')
        : undefined;
      const paths = ['x', 'y', 'z'].map((ax) => `${group}.${ax}`);
      const rowLink = noKf ? null : { kind: 'el', id: el.id, paths };
      const row = this._vec({
        label,
        kfNode: kf,
        rowLink,
        keyPaths: noKf ? undefined : paths,
        items: ['x', 'y', 'z'].map((ax, i) => ({
          axis: ax, value: round(kv(`${group}.${ax}`, arr[i]), 3), step, unit,
          aria: `${label} ${ax.toUpperCase()}`,
          link: null,
          onChange: edit(`${group}.${ax}`, null),
          dim: dimZ && ax === 'z',
          tip: dimZ && ax === 'z'
            ? (dimTip || '平面没有厚度：Z 缩放只影响挂在下面的子元素')
            : '',
        })),
      });
      row.classList.add('xf-row');
      return row;
    };
    // Three-axis rotation (DESIGN-TRANSFORM-UNIFY §2). The node may still carry
    // only dir/roll from before 2c; show the equivalent angles and write a full
    // rotation on the first edit so the pose cannot jump.
    const nodeRot = node
      ? (Array.isArray(node.rotation) ? node.rotation.slice() : rotationFromDirRoll(node.dir, node.roll))
      : null;
    const rotAxes = ['x', 'y', 'z'];
    const writeNodeRotation = (next) => {
      if (!node || !el.node) return;
      const anyKeyed = rotAxes.some((ax) => (el.keyframes || []).some((k) => k.path === `rotation.${ax}`));
      if (!anyKeyed) {
        this._commit(`${el.id}:rotation`, {
          op: 'updateElement', id: el.id,
          patch: { node: { ...el.node, rotation: next.slice() } },
        }, 60);
        return;
      }
      const t = keyT();
      const ops = [];
      if (!Array.isArray(el.node.rotation)) {
        ops.push({ op: 'updateElement', id: el.id, patch: { node: { ...el.node, rotation: next.slice() } } });
      }
      for (const ax of rotAxes) {
        const i = rotAxes.indexOf(ax);
        const local = localElementRowValue(project, el, `rotation.${ax}`, time, next[i]);
        ops.push({
          op: 'keySet', id: el.id, path: `rotation.${ax}`, t,
          value: Number.isFinite(local) ? local : next[i],
        });
      }
      this._commit(`${el.id}:rotation`, ops.length === 1 ? ops[0] : { op: 'batch', ops }, 60);
    };
    const opacityField = this._field({
      label: '不透明度', value: round(kv('transform.opacity', el.transform.opacity), 3),
      step: 0.01, min: 0, max: 1, percent: true, kf: true, path: kp('transform.opacity'),
      link: link('transform.opacity'), onChange: edit('transform.opacity', (v) => ({ transform: { opacity: v } })),
    });
    const bindRows = [
      this._field({ label: '跟随节拍', value: el.punch || 0, step: 0.05, min: 0, max: 2, onChange: (v) => set('punch', { punch: v }) }),
    ];
    if (node) {
      const rotBallHost = h('div', { class: 'rotball-wrap' });
      new RotBall(rotBallHost, {
        rotation: nodeRot,
        time,
        onStart: () => { this._ballDragging = true; },
        onEnd: () => { this._ballDragging = false; },
        onChange: (next) => writeNodeRotation(next),
      });
      // Unified SpatialNode editor: pivot / position / three-axis rotation /
      // xyz scale. The rotation ball is the free-hand tool; the three cells stay
      // exact and linkable.
      this.root.appendChild(this._sec('变换', {},
        nodeVec('pivot', '中心点', 0.05, 'm'),
        nodeVec('position', '位置', 0.05, 'm', { noKf: true }),
        this._xfRow(project, el, 'el', 'rotation', { step: 0.5, unit: '°' }),
        nodeVec('scale', '缩放', 0.01, '', { dimZ: true }),
        this._xfOpacity(project, el, 'el'),
        rotBallHost,
        ...bindRows,
      ));
    } else {
      this.root.appendChild(this._sec('变换', {},
        this._vec({
          label: '位置', keyPaths: [kp('transform.x'), kp('transform.y')],
          items: [
            { axis: 'x', value: round(kv('transform.x', el.transform.x)), unit: 'px', aria: 'X', link: link('transform.x'), onChange: edit('transform.x', (v) => ({ transform: { x: v } })) },
            { axis: 'y', value: round(kv('transform.y', el.transform.y)), unit: 'px', aria: 'Y', link: link('transform.y'), onChange: edit('transform.y', (v) => ({ transform: { y: v } })) },
          ],
        }),
        this._field({ label: '纵深 z', unit: 'm', value: round(kv('transform.z', el.transform.z ?? 0), 3), step: 0.05, kf: true, path: kp('transform.z'), link: link('transform.z'), onChange: edit('transform.z', (v) => ({ transform: { z: v } })) }),
        this._field({ label: '缩放', value: round(kv('transform.scale', el.transform.scale), 3), step: 0.01, kf: true, path: kp('transform.scale'), link: link('transform.scale'), onChange: edit('transform.scale', (v) => ({ transform: { scale: v } })) }),
        this._field({ label: '旋转', unit: '°', value: round(kv('transform.rotation', el.transform.rotation), 2), step: 0.5, kf: true, path: kp('transform.rotation'), link: link('transform.rotation'), onChange: edit('transform.rotation', (v) => ({ transform: { rotation: v } })) }),
        opacityField,
        ...bindRows,
      ));
    }

    this.root.appendChild(this._sec('时间', {}, ...timeRows));

    if (el.type === 'text') {
      this.root.appendChild(this._sec('文字', {},
        this._field({ label: '内容', type: 'textarea', value: el.style.text, onChange: (v) => set('style.text', { style: { text: v } }) }),
        this._field({ label: '字体', type: 'select', value: el.style.font, options: FONTS, onChange: (v) => set('style.font', { style: { font: v } }) }),
        this._field({ label: '字号', unit: 'px', value: round(kv('style.size', el.style.size), 1), step: 1, kf: true, path: 'style.size', onChange: edit('style.size', (v) => ({ style: { size: v } })) }),
        // 颜色是可打帧属性：值跟着播放头走，◆ 在该帧写入一个步进颜色键
        // （design §9；颜色关键帧保持跳变）。
        this._field({
          label: '颜色', type: 'color', value: kv('style.color', el.style.color),
          kf: true, path: kp('style.color'),
          onChange: edit('style.color', (v) => ({ style: { color: v } })),
        }),
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
    } else if (el.type === 'camfeed') {
      const delay = el.feed?.delay === 1 ? 1 : 0;
      const options = [{ value: '', label: '（未选择）' }].concat(
        (project.cameras || []).map((c) => ({ value: c.id, label: c.name || c.id })),
      );
      const source = normalizeFeed(el.feed).camera;
      const select = h('select', { 'aria-label': '来源相机' }, ...options.map((o) => h('option', {
        value: o.value, selected: String(o.value) === String(source),
      }, o.label)));
      select.addEventListener('change', () => this.opts.onOp({
        op: 'updateElement', id: el.id, patch: { feed: { camera: select.value, delay } },
      }));
      const follow = h('button', {
        type: 'button', class: 'btn ghost mini', 'data-tip': '进入编辑视口的选择模式，并跟随这块投屏的来源相机 (F5)',
      }, '跟随');
      follow.disabled = !source;
      follow.addEventListener('click', () => this.opts.onFollowCamera?.(source));
      this.root.appendChild(this._sec('投屏', {},
        this._row('来源相机', h('span', { class: 'follow-row' }, select, follow), null, 'w-full'),
        this._field({
          label: '延迟一帧', type: 'checkbox', value: delay === 1,
          onChange: (v) => this.opts.onOp({
            op: 'updateElement', id: el.id, patch: { feed: { camera: el.feed?.camera || '', delay: v ? 1 : 0 } },
          }),
        }),
        h('div', { class: 'hint' },
          '默认显示来源相机的当前帧；来源相机拍不到自己的当前帧投屏。',
          '延迟一帧用于无限隧道/反馈画面，首帧为黑。'),
      ));
    } else {
      this.root.appendChild(this._sec('形状', {},
        this._field({
          label: '类型', type: 'select', value: el.style.shape, options: [{ value: 'rect', label: '矩形' }, { value: 'ellipse', label: '椭圆' }],
          onChange: (v) => set('style.shape', { style: { shape: v } }),
        }),
        this._field({
          label: '填充', type: 'color', value: kv('style.fill', el.style.fill),
          kf: true, path: kp('style.fill'),
          onChange: edit('style.fill', (v) => ({ style: { fill: v } })),
        }),
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
  /**
   * 父级: the spatial parent (the only placement parent, docs/DESIGN-CAMFEED-PARENTS.md §3):
   * pick any element / 3D object / camera, inherit switches, keyable rotation/scale strength.
   */
  _renderParent(project, obj, time) {
    const id = obj.id;
    // binding re-reads the pose at the playhead, so it keeps the exact time;
    // strength keys are new keyframes and land on the frame edge
    const tNow = () => Math.round(this.opts.getTime() * 1000) / 1000;
    const keyT = () => this._keyTime();
    const objs = project.scene?.objects || [];
    const par = obj.frameParent?.id ? obj.frameParent : null;
    const reparent = (extra) => this.opts.onOp({ op: 'spatialParent', id, parent: par?.id, t: tNow(), ...extra });
    const hosts = [
      ...objs.filter((o) => o.type !== 'audio').map((o) => [o.id, `${o.name || o.id}${o.type === 'empty' ? ' · 空' : ' · 3D'}`]),
      ...(project.elements || []).filter((e) => e.type !== 'audio').map((e) => [e.id, `${e.name || e.id} · 2D`]),
      ...(project.cameras || []).map((c) => [c.id, `${c.name || c.id} · 相机`]),
    ];
    const options = [{ value: '', label: '（无）' }].concat(hosts
      .filter(([hid]) => hid !== id && !wouldSpatialCycle(project, id, hid))
      .map(([value, label]) => ({ value, label })));
    const kids = [
      this._field({
        label: '父级', type: 'select', value: par?.id || '', options,
        onChange: (v) => this.opts.onOp(v
          ? { op: 'spatialParent', id, parent: v, t: tNow() }
          : { op: 'spatialUnparent', id }),
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
        return o.frameParent?.strengthKeys?.[ch] || [];
      };
      for (const [ch, label] of [['rot', '旋转强度'], ['scale', '缩放强度']]) {
        const track = par.strengthKeys?.[ch] || [];
        const v = parentStrengthAt(par, time)[ch];
        const atKey = track.find((k) => Math.abs(k.t - time) <= tol);
        kids.push(this._field({
          label, value: Math.round(Number(v) * 1000) / 1000, step: 0.01, min: 0, max: 1, percent: true,
          // Keyed channel: write a key at the playhead; otherwise change the base strength (re-binds at the playhead).
          onChange: (nv) => this._commit(`${id}:parent.${ch}`, track.length
            ? { op: 'spatialParentKey', id, channel: ch, t: keyT(), v: nv }
            : { op: 'spatialParent', id, parent: par.id, t: tNow(), strength: { [ch]: nv } }),
          keyer: {
            state: () => {
              const tr = liveTrack(ch);
              if (!tr.length) return 'none';
              const now = this.opts.getTime();
              return tr.some((k) => Math.abs(k.t - now) <= tol) ? 'on' : 'anim';
            },
            set: () => this.opts.onOp({ op: 'spatialParentKey', id, channel: ch, t: keyT(), v: Number(v) }),
            unset: () => this.opts.onOp({ op: 'spatialParentUnkey', id, channel: ch, t: atKey ? atKey.t : keyT() }),
          },
        }));
      }
      const chain = spatialAncestors(project, id).map((o) => o.name || o.id).join(' ← ');
      kids.push(h('div', { class: 'hint' }, `层级：${obj.name || id} ← ${chain}。挂上和改开关以当前时间为准，不跳位；取下后回到自己的数值。`));
    } else {
      kids.push(h('div', { class: 'hint' }, '选一个元素当父级（常用「空元素」），之后它怎么动，这个元素就跟着怎么动。'));
    }
    return this._sec('父级', {}, ...kids);
  }

  /**
   * 空间父级 summary for a 3D object / camera: `frameParent` is the unified
   * matrix parent (core/spatial-parent.js), separate from the old 3D `obj.parent`
   * shown in the 父级 section below. Header row, same shape as the 2D summary.
   */
  _spatialParentSummary(project, host) {
    const par = host?.frameParent;
    if (!par?.id) return null;
    const parentId = String(par.id);
    const parentHost = (project.elements || []).find((x) => x.id === parentId)
      || (project.scene?.objects || []).find((x) => x.id === parentId)
      || (project.cameras || []).find((x) => x.id === parentId);
    const name = parentHost?.name || parentId;
    const jump = () => {
      if ((project.elements || []).some((x) => x.id === parentId)) this.opts.onSelect?.({ elementId: parentId });
      else if ((project.scene?.objects || []).some((x) => x.id === parentId)) this.opts.onSelect?.({ objectId: parentId });
      else if ((project.cameras || []).some((x) => x.id === parentId)) this.opts.onSelect?.({ camera: true });
    };
    const unparent = () => this.opts.onOp({ op: 'spatialUnparent', id: host.id });
    return h('div', { class: 'hint pad insp-parent' },
      h('span', { class: 'insp-parent-name' }, `空间父级：${name}`),
      h('button', { type: 'button', class: 'mini', onclick: jump }, '转到父级'),
      h('button', { type: 'button', class: 'mini', onclick: unparent }, '解除'));
  }

  /**
   * Parent controls under the spatial-parent summary (PLAN-ui-round3 §4.2):
   * the same drag `↳` as the timeline row plus the three inherit switches.
   * Dragging reuses timeline._startParentDrag, so target rows highlight and a
   * plain click removes the parent; every toggle is one spatialParent op.
   */
  _parentTools(project, host, kind) {
    const par = kind === 'el'
      ? (host?.parent?.mode === 'world' ? host.parent : null)
      : (host?.frameParent?.id ? host.frameParent : null);
    const btn = h('button', {
      type: 'button',
      class: `insp-parentbtn${par?.id ? ' on' : ''}`,
      'aria-label': '空间父级',
      'data-tip': par?.id
        ? '空间父级：按住拖到时间轴元素行换父级；单击解除'
        : '空间父级：按住拖到时间轴元素行建立父级',
    }, '↳');
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.opts.onStartParentDrag?.(ev, kind, host, btn);
    });
    const inherit = par?.inherit || {};
    const boxes = [['pos', '跟随位置'], ['rot', '跟随旋转'], ['scale', '跟随缩放']].map(([ch, label]) => h(
      'label',
      { class: `insp-inherit${par ? '' : ' off'}`, 'data-tip': par ? '这个轴跟随父级运动' : '先绑定空间父级' },
      h('input', {
        type: 'checkbox',
        class: 'insp-inherit-box',
        checked: par ? inherit[ch] !== false : false,
        disabled: !par,
        onchange: (ev) => {
          if (!par?.id) return;
          this.opts.onOp({
            op: 'spatialParent',
            id: host.id,
            parent: par.id,
            t: this._keyTime(),
            inherit: { [ch]: ev.target.checked },
          });
        },
      }),
      h('span', {}, label),
    ));
    return h('div', { class: 'insp-parent-tools' }, btn, ...boxes);
  }

  // ---------------------------------------------------------------- 3D object
  _renderObject(project, obj, time, multi = 0) {
    const id = obj.id;
    this._kind = `3d.${obj.type}`;
    const pose = objectPoseWithLinks(project, obj, time);
    const tNow = () => this._keyTime();
    const key = (path, v) => this.opts.onOp({ op: 'objectKey', id, path, t: tNow(), v });
    const tol = 0.5 / (project.meta?.fps || 24);
    const liveObj = () => (this._last?.project?.scene?.objects || []).find((o) => o.id === id) || obj;

    this._header({
      type: 'object', badge: OBJ_LABELS[obj.type] || '3D 元素', name: obj.name || id, id, multi,
      locked: obj.locked === true,
      actions: [this._lockAction('object', obj)],
    });
    const linksSummary = this._linksSummary(project, obj);
    if (linksSummary) this.root.appendChild(linksSummary);
    const spatialParent = this._spatialParentSummary(project, obj);
    if (spatialParent) this.root.appendChild(spatialParent);
    this.root.appendChild(h('div', { class: 'hint pad' },
      '内容在时间轴左侧：选中元素后点元素行的 ▾ 展开编辑；变换栏四行与时间轴一致。',
      '复制 / 删除 / 面向镜头 / 落地在元素行的 ⋯ 菜单里。'));

    const poseRot = Array.isArray(pose.rotation)
      ? pose.rotation.slice()
      : rotationFromDirRoll(pose.dir, pose.roll);
    const rotAxes = ['x', 'y', 'z'];
    const objRotAt = (o, at) => {
      const p = objectPoseWithLinks(project, o, at);
      return Array.isArray(p.rotation) ? p.rotation : rotationFromDirRoll(p.dir, p.roll);
    };
    const objLocalRotAt = (o, at) => {
      const p = objectPose(o, at);
      return Array.isArray(p.rotation) ? p.rotation : rotationFromDirRoll(p.dir, p.roll);
    };
    const writeObjRotation = (next) => {
      const objNow = liveObj();
      const t = tNow();
      const localRot = rotAxes.map((ax, i) => {
        const local = writeBackLocalValue(project, { host: 'ob', id }, `rotation.${ax}`, t, next[i]);
        return Number.isFinite(local) ? local : next[i];
      });
      const keyed = rotAxes.some((ax) => (objNow.tracks?.[`rotation.${ax}`] || []).length);
      if (!keyed) {
        this._commit(`${id}:rotation`, { op: 'objectPatch', id, patch: { rotation: localRot } }, 40);
        return;
      }
      const ops = [];
      if (!Array.isArray(objNow.rotation)) {
        ops.push({ op: 'objectPatch', id, patch: { rotation: localRot.slice() } });
      }
      for (const ax of rotAxes) {
        ops.push({ op: 'objectKey', id, path: `rotation.${ax}`, t, v: localRot[rotAxes.indexOf(ax)] });
      }
      this._commit(`${id}:rotation`, ops.length === 1 ? ops[0] : { op: 'batch', ops }, 40);
    };
    const setObjRotAxis = (i) => (v) => {
      const objNow = liveObj();
      const path = `rotation.${rotAxes[i]}`;
      const t = tNow();
      const local = writeBackLocalValue(project, { host: 'ob', id }, path, t, v);
      const value = Number.isFinite(local) ? local : v;
      if ((objNow.tracks?.[path] || []).length) {
        key(path, value);
        return;
      }
      const base = objLocalRotAt(objNow, t);
      base[i] = value;
      this.opts.onOp({ op: 'objectPatch', id, patch: { rotation: base } });
    };
    const objRotKf = this._kfButton(
      () => {
        const o = liveObj();
        const now = this.opts.getTime();
        const lists = rotAxes.map((ax) => o.tracks?.[`rotation.${ax}`] || []);
        if (lists.some((tr) => tr.some((k) => Math.abs(k.t - now) <= tol))) return 'on';
        return lists.some((tr) => tr.length) ? 'anim' : 'none';
      },
      () => {
        const t = tNow();
        const rot = objLocalRotAt(liveObj(), t);
        const ops = [];
        const objNow = liveObj();
        if (!Array.isArray(objNow.rotation)) {
          ops.push({ op: 'objectPatch', id, patch: { rotation: rot.slice() } });
        }
        for (const ax of rotAxes) {
          ops.push({ op: 'objectKey', id, path: `rotation.${ax}`, t, v: rot[rotAxes.indexOf(ax)] });
        }
        this.opts.onOp(ops.length === 1 ? ops[0] : { op: 'batch', ops });
      },
      () => {
        const now = this.opts.getTime();
        const ops = [];
        for (const ax of rotAxes) {
          const k = (liveObj().tracks?.[`rotation.${ax}`] || []).find((x) => Math.abs(x.t - now) <= tol);
          if (k) ops.push({ op: 'objectUnkey', id, path: `rotation.${ax}`, t: k.t });
        }
        if (ops.length) this.opts.onOp({ op: 'batch', ops });
      },
    );
    const rotTimes = new Set();
    for (const ax of rotAxes) for (const k of liveObj().tracks?.[`rotation.${ax}`] || []) rotTimes.add(k.t);
    const rotKeys = [...rotTimes].map((t) => ({
      t, dir: basisFromRotation(objRotAt(liveObj(), t)).forward,
    }));
    const ballHost = h('div', { class: 'rotball-wrap' });
    new RotBall(ballHost, {
      rotation: poseRot,
      keys: rotKeys,
      time,
      onStart: () => { this._ballDragging = true; },
      onEnd: () => { this._ballDragging = false; },
      onChange: (rot) => writeObjRotation(rot),
    });
    this.root.appendChild(this._sec('变换', { tag: obj.parent?.id ? '本地' : null },
      this._xfRow(project, obj, 'ob', 'pivot', { step: 0.05, unit: 'm' }),
      this._xfRow(project, obj, 'ob', 'position', { step: 0.05, unit: 'm' }),
      this._xfRow(project, obj, 'ob', 'rotation', { step: 0.5, unit: '°' }),
      this._xfRow(project, obj, 'ob', 'scale', { step: 0.01, unit: '倍' }),
      this._xfOpacity(project, obj, 'ob'),
      ballHost,
      h('div', { class: 'hint' }, '四行顺序与时间轴一致；拖球面改三个角，逐轴打帧在时间轴的子行。X 俯仰 · Y 转身 · Z 画面内。'),
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
      locked: cam.locked === true,
      actions: [
        this._lockAction('camera', cam),
        { icon: 'film', label: '渲染', tip: '渲染\n从头到尾渲染这个镜头', run: () => this.opts.onRenderAll?.() },
      ],
    });
    const linksSummary = this._linksSummary(project, cam);
    if (linksSummary) this.root.appendChild(linksSummary);
    const spatialParent = this._spatialParentSummary(project, cam);
    if (spatialParent) this.root.appendChild(spatialParent);
    this.root.appendChild(this._parentTools(project, cam, 'cam'));
    this.root.appendChild(this._sec('变换', {},
      this._xfRow(project, cam, 'cam', 'pivot', { step: 0.1, unit: 'm' }),
      this._xfRow(project, cam, 'cam', 'position', { step: 0.1, unit: '', readOnly: true }),
      this._xfRow(project, cam, 'cam', 'rotation', { step: 0.5, unit: '°' }),
      this._xfRow(project, cam, 'cam', 'scale', { step: 0.05, unit: '倍' }),
      this._xfOpacity(project, cam, 'cam'),
      h('div', { class: 'hint' }, 'X 俯仰 · Y 转身 · Z 画面内旋转（旧手动 roll 已并入 Z）。位置是飞行路径（单位 m），只读；在时间轴或视口打点。'),
    ));
    this.root.appendChild(h('div', { class: 'hint pad' },
      '镜头 / 构图（FOV、画面中心 / 位置、抖动、景深）在时间轴的相机行里：点行首 ▾ 展开；中心点 / 旋转 / 缩放、不透明度也能逐帧打点。'));
    const feeds = (project.elements || []).filter((e) => e.type === 'camfeed'
      && normalizeFeed(e.feed).camera === cam.id);
    this.root.appendChild(this._sec('这台相机的投屏', { key: 'camfeeds', count: feeds.length },
      ...(feeds.length ? feeds.map((f) => {
        const delayed = normalizeFeed(f.feed).delay === 1;
        const btn = h('button', { type: 'button', class: 'btn ghost mini', 'data-tip': '把编辑视角飞到这块投屏前（不跟随）' }, '飞到');
        btn.addEventListener('click', () => this.opts.onFlyToFeed?.(f.id));
        return this._row(`${f.name || f.id}${delayed ? ' · 上一帧' : ''}`, btn, null, 'w-full');
      }) : [h('div', { class: 'hint' }, '还没有投屏元素使用这台相机。')])));
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
