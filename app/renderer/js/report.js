// Report draft panel — docs/DESIGN-WP2.5-REVIEW.md §10.4, WP2.5c.
//
// A report says "something is wrong here". It is not an edit: the draft never
// enters the project, the undo history or a revision (core/report-draft.js).
// The editor's selection pool stays homogeneous (delete / move / the inspector
// depend on that), so the draft is the one place that mixes things, like
// attachments on a mail.
//
// This file is the panel: a floating, non-modal card in the bottom-right corner
// of the viewport (§10.4-2). It owns the draft, the symptom chips, the one-line
// note, the screen-region drag (§10.4-4) and the hover highlight of an
// attachment. The finished draft goes to `/api/reports` through main.js
// (DESIGN.md §10: widgets never fetch a write route).
import { h, icon } from './ui.js';
import {
  NOTE_MAX, SYMPTOMS, addAttachment, createDraft, normalizeDraft,
  removeAttachment, setTags,
} from '/core/report-draft.js';
import { PROPERTY_PATHS_BY_HOST } from '/core/contracts.js';

/** Lifecycle in a human's words (§10.4-8). One source for the AI card and 审阅. */
export const REPORT_STATUS_LABEL = { open: '待处理', fixed: '已修', verified: '已验证', dismissed: '已忽略' };
export const reportStatusLabel = (status) => REPORT_STATUS_LABEL[status] || REPORT_STATUS_LABEL.open;

/** Region drags smaller than this (CSS px, what the user sees) are a mis-click. */
const REGION_MIN = 4;

const round2 = (v) => Math.round(Number(v) * 100) / 100 + 0;

function hostOf(project, type, id) {
  if (type === 'cam') {
    return (project?.cameras || []).find((c) => c.id === id)
      || (project?.camera?.id === id ? project.camera : null);
  }
  if (type === 'ob') return (project?.scene?.objects || []).find((o) => o.id === id) || null;
  return (project?.elements || []).find((e) => e.id === id) || null;
}

/** Human name for a host, with the index as a fallback (never an `el_` id). */
function hostName(project, type, id) {
  const host = hostOf(project, type, id);
  if (host?.name) return host.name;
  const list = type === 'cam' ? (project?.cameras || [])
    : type === 'ob' ? (project?.scene?.objects || []) : (project?.elements || []);
  const index = list.findIndex((entry) => entry.id === id);
  const kind = type === 'cam' ? '相机' : type === 'ob' ? '3D 元素' : '元素';
  return `${kind} ${index >= 0 ? index + 1 : list.length + 1}`;
}

/**
 * A selection ref as one attachment (§10.4-1): `el:` / `ob:` / `cam:` become the
 * matching kind with a readable label. Property and keyframe refs are handled
 * by the callers, they need the path split out.
 */
/**
 * A selection ref as one attachment (§10.4-1). The selection pool addresses a
 * host as `el:el_1` / `ob:ob_1` / `cam:cam_1`, but a report's `ref` is the raw
 * host id: `measurePlan` hands it to the measurement service as `elementId` /
 * `focus` (`core/report-draft.js` documents `host` the same way).
 */
function hostAttachment(project, ref) {
  const match = /^(el|ob|cam):([^:]+)$/.exec(String(ref || ''));
  if (!match) return null;
  const type = match[1];
  const id = match[2];
  const kind = type === 'cam' ? 'camera' : type === 'ob' ? 'object' : 'element';
  return { kind, ref: id, label: hostName(project, type, id) };
}

/** The selection ref a stored attachment points at (`el:el_1`), or null. */
function selectionRefOf(attachment, project) {
  const id = String(attachment?.host || attachment?.ref || '');
  if (!id) return null;
  if ((project?.elements || []).some((entry) => entry.id === id)) return `el:${id}`;
  if ((project?.scene?.objects || []).some((entry) => entry.id === id)) return `ob:${id}`;
  if ((project?.cameras || []).some((entry) => entry.id === id)) return `cam:${id}`;
  if (project?.camera?.id === id) return `cam:${id}`;
  return null;
}

/** Contract label for a property path (`style.size` -> 字号, WP2.3). */
function propertyLabel(type, path) {
  const bare = String(path || '').replace(/\.(value|ease|curve|t)$/, '');
  const rows = PROPERTY_PATHS_BY_HOST[type] || [];
  const hit = rows.find((row) => row.path === bare);
  return hit?.label || bare.replace(/^style\./, '').replace(/^node\./, '') || '属性';
}

function propertyAttachment(project, ref) {
  const match = /^(el|ob|cam):([^:]+):(.+)$/.exec(String(ref || ''));
  if (!match) return null;
  const [, type, id, path] = match;
  return {
    kind: 'property',
    ref: `${id}:${path}`,
    host: id,
    path,
    label: `${hostName(project, type, id)} · ${propertyLabel(type, path)}`,
  };
}

function keyframeAttachment(project, ref, fps) {
  const match = /^(el|ob|cam):([^:]+):(.+):(-?[0-9.]+)$/.exec(String(ref || ''));
  if (!match) return null;
  const [, type, id, path, t] = match;
  const time = Number(t);
  if (!Number.isFinite(time)) return null;
  const frame = Math.round(time * fps);
  return {
    kind: 'keyframe',
    ref: `${id}:${path}:${time}`,
    host: id,
    path,
    t: time,
    label: `${hostName(project, type, id)} · ${propertyLabel(type, path)} f${frame}`,
  };
}

/** Stored attachments keep `ref` as the draft's address; the UI reads the rest. */
export class ReportDraftPanel {
  constructor(opts = {}) {
    this.opts = opts;
    this.draft = null;
    this.open = false;
    this.collapsed = false;
    this.error = '';
    this.busy = false;
    this.armed = false;      // one-shot "frame a region" mode (palette entry)
    this._submitToken = 0;   // a cancel while the POST is in flight wins
    this.el = null;
    this._drag = null;
    this._regionEl = null;   // hover rect for a region attachment
  }

  // ---------------------------------------------------------------- lifecycle
  mount(node = null) {
    if (this.el) return this.el;
    const host = node || (typeof document !== 'undefined' ? document.querySelector('#stageWrap') : null);
    if (!host) return null;

    this.countEl = h('span', { class: 'rd-count' });
    this.foldEl = h('button', {
      type: 'button', class: 'rd-icon', 'aria-label': '折叠报告草稿', 'aria-expanded': 'true',
      'data-tip': '折叠',
    }, icon('chevron-down', 'ic-sm'));
    this.foldEl.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.render();
    });
    const closeEl = h('button', {
      type: 'button', class: 'rd-icon', 'aria-label': '关闭报告草稿（不保存）', 'data-tip': '关闭（不保存）',
    }, icon('x', 'ic-sm'));
    closeEl.addEventListener('click', () => this.cancel());

    const head = h('div', { class: 'rd-head' },
      icon('alert', 'ic-sm'),
      h('span', { class: 'rd-title' }, '报告草稿'),
      this.countEl,
      this.foldEl,
      closeEl,
    );

    this.attsEl = h('div', { class: 'rd-atts' });
    this.addEl = h('button', {
      type: 'button', class: 'rd-add', 'data-action': 'append-selection',
      'data-tip': '等价于再按一次 Shift+R',
    }, '+ 加入当前选中');
    this.addEl.addEventListener('click', () => this.appendFromUI());

    this.symEl = h('div', { class: 'rd-syms' });
    this.symButtons = new Map();
    for (const symptom of SYMPTOMS) {
      const chip = h('button', {
        type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-symptom': symptom,
      }, symptom);
      chip.addEventListener('click', () => this._toggleSymptom(symptom));
      this.symButtons.set(symptom, chip);
      this.symEl.appendChild(chip);
    }

    this.noteEl = h('input', {
      type: 'text', class: 'rd-note', maxlength: String(NOTE_MAX), spellcheck: 'false',
      placeholder: '一句话描述出了什么问题', 'aria-label': '一句话描述',
    });
    this.noteEl.addEventListener('input', () => {
      if (!this.draft) return;
      this.draft = { ...this.draft, note: this.noteEl.value.slice(0, NOTE_MAX) };
      this._changed();
      this._syncSubmit();
    });
    this.noteEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });

    this.submitEl = h('button', { type: 'button', class: 'btn primary', 'data-action': 'submit-report' }, '提交');
    this.submitEl.addEventListener('click', () => this.submit());
    this.cancelEl = h('button', { type: 'button', class: 'btn', 'data-action': 'cancel-report' }, '取消');
    this.cancelEl.addEventListener('click', () => this.cancel());
    this.errEl = h('div', { class: 'rd-err', role: 'alert', hidden: true });

    this.bodyEl = h('div', { class: 'rd-body' },
      h('div', { class: 'rd-label' }, '附件'),
      this.attsEl,
      this.addEl,
      h('div', { class: 'rd-label' }, '症状'),
      this.symEl,
      this.noteEl,
      h('div', { class: 'rd-foot' }, this.submitEl, this.cancelEl),
      this.errEl,
    );

    this.el = h('div', {
      class: 'report-draft', role: 'region', 'aria-label': '报告草稿', 'data-region': 'report-draft', hidden: true,
    }, head, this.bodyEl);
    // Escape inside the panel closes it without saving (§10.4-2); the handler
    // sits on the panel, so a global Escape keeps its usual layering elsewhere.
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    });
    host.appendChild(this.el);
    this.render();
    return this.el;
  }

  isOpen() {
    return !!(this.open && this.draft);
  }

  /** Shift+R (§10.4-2/3): first press opens, a second one appends. */
  toggle() {
    if (!this.isOpen()) { this.begin(); return; }
    this.appendFromUI();
  }

  /** A fresh draft that already holds whatever is selected right now. */
  begin() {
    this.draft = createDraft();
    this.error = '';
    this.collapsed = false;
    this.open = true;
    this.appendCurrent();
    this._changed();
    this.render();
    return this.draft;
  }

  /** 取消 / × / Escape: drop the draft, write nothing. */
  cancel() {
    const wasOpen = this.isOpen() || this.armed;
    this._cancelDrag();
    this._highlight(null);
    this._submitToken += 1;   // a request still in flight must not resurrect it
    this.armed = false;
    this.draft = null;
    this.open = false;
    this.error = '';
    this.busy = false;
    this._changed();
    this.render();
    return wasOpen;
  }

  // ---------------------------------------------------------------- attachments
  /** Attachments for the current selection pool (property / keyframe included). */
  currentAttachments() {
    const selection = this.opts.getSelection?.() || {};
    const project = this.opts.getProject?.();
    const fps = this._fps();
    const pool = selection.pool;
    const out = [];
    if (pool?.kind === 'property') {
      for (const ref of pool.ids || []) {
        const attachment = propertyAttachment(project, ref);
        if (attachment) out.push(attachment);
      }
      return out;
    }
    if (pool?.kind === 'keyframe') {
      for (const ref of pool.ids || []) {
        const attachment = keyframeAttachment(project, ref, fps);
        if (attachment) out.push(attachment);
      }
      return out;
    }
    const refs = pool?.kind === 'element' && pool.ids?.length
      ? pool.ids
      : legacyRefs(selection, project);
    for (const ref of refs) {
      const attachment = hostAttachment(project, ref);
      if (attachment) out.push(attachment);
    }
    return out;
  }

  /** The time range, when the timeline has one (§10.6-5). */
  rangeAttachment() {
    const range = this.opts.getRange?.();
    if (!range) return null;
    return {
      kind: 'range',
      ref: `range:${range.from}-${range.to}`,
      from: range.from,
      to: range.to,
      label: `f${range.from}–f${range.to}`,
    };
  }

  /** Append the selection + the range. Returns how many attachments are new. */
  appendCurrent() {
    if (!this.draft) return 0;
    const before = this.draft.attachments.length;
    const refs = new Set(this.draft.attachments.map((a) => `${a.kind}:${a.ref}`));
    let draft = this.draft;
    const add = (attachment) => {
      if (!attachment) return;
      if (refs.has(`${attachment.kind}:${attachment.ref}`)) return;
      draft = addAttachment(draft, attachment);
      refs.add(`${attachment.kind}:${attachment.ref}`);
    };
    for (const attachment of this.currentAttachments()) add(attachment);
    add(this.rangeAttachment());
    this.draft = draft;
    this._changed();
    return draft.attachments.length - before;
  }

  /** "Add what is selected" with a toast that explains the outcome. */
  appendFromUI() {
    const candidates = this.currentAttachments().length + (this.rangeAttachment() ? 1 : 0);
    const added = this.appendCurrent();
    this.collapsed = false;
    this.render();
    if (!candidates) this.opts.toast?.('先选中一个元素、物体或一段范围', 'info');
    else this.opts.toast?.(added ? '已加入草稿' : '草稿里已经有这些了', added ? 'success' : 'info');
    return added;
  }

  remove(ref) {
    if (!this.draft) return;
    this.draft = removeAttachment(this.draft, ref);
    this._changed();
    this.render();
  }

  _toggleSymptom(symptom) {
    if (!this.draft) return;
    const tags = this.draft.tags || [];
    const next = tags.includes(symptom) ? tags.filter((tag) => tag !== symptom) : [...tags, symptom];
    this.draft = setTags(this.draft, next);
    this._changed();
    this.render();
  }

  /** Add one `region` attachment (§10.4-4): project pixels, y down. */
  addRegion(rect) {
    if (!this.draft || !rect) return null;
    const frame = Math.round(this._fps() * (this.opts.getTime?.() || 0));
    const attachment = {
      kind: 'region',
      ref: `region:${frame}:${rect.join(',')}`,
      frame,
      rect: rect.map(round2),
      label: `画面区域 f${frame}`,
    };
    this.draft = addAttachment(this.draft, attachment);
    this.collapsed = false;
    this._changed();
    this.render();
    return attachment;
  }

  // ---------------------------------------------------------------- region drag
  /**
   * Viewport press hook for main.js: a Shift+drag with the draft open frames a
   * screen region instead of the usual additive marquee (§10.4-4). Returns true
   * when the press was consumed. Fly mode keeps its camera drag.
   */
  beginPointer(ev) {
    if (!this.isOpen() || ev?.button !== 0) return false;
    if (this.armed) {
      this.armed = false;
      return this._startDrag(ev);
    }
    if (!ev.shiftKey) return false;
    if (this.opts.isFlying?.()) return false;
    return this._startDrag(ev);
  }

  /** 报告：框选画面区域 — the palette entry for people without a mouse drag. */
  armRegion() {
    if (!this.isOpen()) this.begin();
    this.armed = true;
    this.collapsed = false;
    this.render();
    this.opts.toast?.('在视口里拖出一块区域', 'info');
  }

  _startDrag(ev) {
    const canvas = this.opts.canvas?.();
    const box = this.opts.stageBox?.();
    if (!canvas || !box) return false;
    this._cancelDrag();
    const start = { x: ev.clientX, y: ev.clientY };
    let last = { ...start };
    const band = h('div', { class: 'report-region' });
    box.appendChild(band);
    const place = () => {
      const r = box.getBoundingClientRect();
      band.style.left = `${Math.min(start.x, last.x) - r.left}px`;
      band.style.top = `${Math.min(start.y, last.y) - r.top}px`;
      band.style.width = `${Math.abs(last.x - start.x)}px`;
      band.style.height = `${Math.abs(last.y - start.y)}px`;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
      band.remove();
      this._drag = null;
    };
    const move = (e) => {
      last = { x: e.clientX, y: e.clientY };
      place();
    };
    const cancel = () => cleanup();
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    };
    const up = (e) => {
      if (e) last = { x: e.clientX, y: e.clientY };
      const w = Math.abs(last.x - start.x);
      const hgt = Math.abs(last.y - start.y);
      cleanup();
      if (w < REGION_MIN || hgt < REGION_MIN) {
        this.opts.toast?.('区域太小，没有加入', 'info');
        return;
      }
      const rect = this._projectRect(start, last, canvas);
      if (!rect) return;
      this.addRegion(rect);
      this.opts.toast?.('已加入画面区域', 'success');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
    this._drag = { band, cancel };
    place();
    ev.preventDefault?.();
    return true;
  }

  _cancelDrag() {
    if (!this._drag) return;
    const { cancel } = this._drag;
    this._drag = null;
    cancel();
  }

  /** CSS client points -> project pixels [x, y, w, h] (the measurement unit). */
  _projectRect(start, last, canvas) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const meta = this.opts.getProject?.()?.meta || {};
    const pw = Number(meta.width) || canvas.width;
    const ph = Number(meta.height) || canvas.height;
    const kx = pw / Math.max(1, r.width);
    const ky = ph / Math.max(1, r.height);
    const x0 = (Math.min(start.x, last.x) - r.left) * kx;
    const y0 = (Math.min(start.y, last.y) - r.top) * ky;
    const w = Math.abs(last.x - start.x) * kx;
    const hgt = Math.abs(last.y - start.y) * ky;
    const x = Math.min(pw, Math.max(0, x0));
    const y = Math.min(ph, Math.max(0, y0));
    const w2 = Math.max(0, Math.min(pw - x, w));
    const h2 = Math.max(0, Math.min(ph - y, hgt));
    if (w2 <= 0 || h2 <= 0) return null;
    return [round2(x), round2(y), round2(w2), round2(h2)];
  }

  // ---------------------------------------------------------------- hover / jump
  /** Paint the attachment under the cursor in the timeline or the viewport. */
  _highlight(attachment) {
    const timeline = this.opts.timeline?.();
    this._clearRegionRect();
    if (!attachment) { timeline?.setReportHint?.(null); return; }
    if (attachment.kind === 'range') {
      timeline?.setReportHint?.({ range: { from: attachment.from, to: attachment.to } });
      return;
    }
    if (attachment.kind === 'region') {
      timeline?.setReportHint?.(null);
      this._showRegionRect(attachment);
      return;
    }
    const host = selectionRefOf(attachment, this.opts.getProject?.());
    timeline?.setReportHint?.({ refs: [host].filter(Boolean) });
  }

  _showRegionRect(attachment) {
    const box = this.opts.stageBox?.();
    const meta = this.opts.getProject?.()?.meta || {};
    if (!box || !Array.isArray(attachment.rect)) return;
    const pw = Number(meta.width) || box.clientWidth;
    const ph = Number(meta.height) || box.clientHeight;
    if (!pw || !ph) return;
    const [x, y, w, hgt] = attachment.rect;
    const node = h('div', { class: 'report-region-hl', 'aria-hidden': 'true' });
    node.style.left = `${(x / pw) * 100}%`;
    node.style.top = `${(y / ph) * 100}%`;
    node.style.width = `${(w / pw) * 100}%`;
    node.style.height = `${(hgt / ph) * 100}%`;
    box.appendChild(node);
    this._regionEl = node;
  }

  _clearRegionRect() {
    this._regionEl?.remove();
    this._regionEl = null;
  }

  // ---------------------------------------------------------------- submit
  async submit() {
    if (this.busy || !this.draft) return;
    const draft = normalizeDraft(this.draft);
    if (!draft.attachments.length && !draft.tags.length) {
      this.opts.toast?.('至少加一个附件或选一个症状', 'warn');
      return;
    }
    this.busy = true;
    this.error = '';
    this.render();
    const token = ++this._submitToken;
    try {
      const report = await this.opts.submit?.({
        draft,
        frame: Math.round(this._fps() * (this.opts.getTime?.() || 0)),
        camera: this.opts.getCameraId?.() || null,
        mode: this.opts.getMode?.() || 'preview',
      });
      if (token !== this._submitToken) return; // cancelled while saving
      this.busy = false;
      this.draft = null;
      this.open = false;
      this._changed();
      this.render();
      this.opts.toast?.('已记录报告', 'success');
      this.opts.onCreated?.(report);
    } catch (e) {
      if (token !== this._submitToken) return;
      // The draft is kept: a failed save must never cost the user their words.
      this.busy = false;
      this.error = e?.message ? `提交失败：${e.message}` : '提交失败';
      this.render();
      this.opts.toast?.(this.error, 'error');
    }
  }

  // ---------------------------------------------------------------- render
  _fps() {
    const fps = Number(this.opts.getFps?.());
    return Number.isFinite(fps) && fps > 0 ? fps : 24;
  }

  _changed() {
    this.opts.onState?.(this.isOpen()
      ? { draft: normalizeDraft(this.draft), open: true }
      : null);
  }

  _syncSubmit() {
    if (!this.submitEl) return;
    const ready = !!this.draft && (this.draft.attachments.length > 0 || (this.draft.tags || []).length > 0);
    this.submitEl.disabled = this.busy || !ready;
    this.submitEl.textContent = this.busy ? '提交中…' : '提交';
  }

  render() {
    if (!this.el) return;
    const open = this.isOpen();
    this.el.hidden = !open;
    if (!open) return;
    const draft = this.draft;
    this.countEl.textContent = `${draft.attachments.length} 个附件`;
    this.attsEl.replaceChildren(...(draft.attachments.length
      ? draft.attachments.map((attachment) => this._chip(attachment))
      : [h('div', { class: 'rd-empty' }, '还没有附件：选中元素、物体或相机再按 Shift+R')]));
    for (const [symptom, chip] of this.symButtons) {
      const on = (draft.tags || []).includes(symptom);
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (document.activeElement !== this.noteEl) this.noteEl.value = draft.note || '';
    this._syncSubmit();
    this.errEl.hidden = !this.error;
    this.errEl.textContent = this.error || '';
    this.el.classList.toggle('collapsed', this.collapsed);
    this.bodyEl.hidden = this.collapsed;
    this.foldEl.setAttribute('aria-expanded', this.collapsed ? 'false' : 'true');
    this.el.classList.toggle('arming', !!this.armed);
  }

  _chip(attachment) {
    const label = h('button', {
      type: 'button', class: 'rd-chip-label', title: attachment.ref,
      'data-action': 'open-attachment',
    }, attachment.label);
    label.addEventListener('click', () => this.opts.onJump?.(attachment));
    const x = h('button', {
      type: 'button', class: 'rd-chip-x', 'aria-label': `移除 ${attachment.label}`,
      'data-action': 'remove-attachment',
    }, icon('x', 'ic-sm'));
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      this.remove(attachment.ref);
    });
    const chip = h('div', { class: `rd-chip ${attachment.kind}`, 'data-ref': attachment.ref }, label, x);
    chip.addEventListener('pointerenter', () => this._highlight(attachment));
    chip.addEventListener('pointerleave', () => this._highlight(null));
    label.addEventListener('focus', () => this._highlight(attachment));
    label.addEventListener('blur', () => this._highlight(null));
    return chip;
  }
}

/** Legacy single-selection fields -> host refs (older call sites pass no pool). */
function legacyRefs(selection, project) {
  const out = [];
  if (selection.elementId) out.push(`el:${selection.elementId}`);
  if (selection.objectId) out.push(`ob:${selection.objectId}`);
  if (selection.camera) {
    const id = project?.camera?.id || project?.activeCameraId;
    if (id) out.push(`cam:${id}`);
  }
  return out;
}
