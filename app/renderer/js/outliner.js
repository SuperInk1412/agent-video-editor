// 图层 panel (docs/DESIGN.md §1.3): outliner in #panelLayers.
// Groups 相机 / 3D 元素 / 2D 元素 / 声音, searchable, collapsible. Selection is
// never owned here: clicks go through the callbacks (main.js select() and the
// timeline's own camera activation), and setSelection() only repaints.

import { h, icon, prefs } from './ui.js';
import { sourceMark } from './source-badge.js';
import { cameraRange } from '/core/camera.js';
import { cameraRef, objectRef, elementRef, selectOne, addSelection } from '/core/selection.js';

const EL_ICON = { text: 'text', image: 'image', video: 'video', solid: 'square', shape: 'square', audio: 'music' };
const OB_ICON = { text: 'text', image: 'image', video: 'video', empty: 'empty', container: 'empty', camera: 'camera', audio: 'music' };
const EL_CLIP = { text: 'text', image: 'image', video: 'video', solid: 'shape', shape: 'shape', audio: 'audio' };

const GROUPS = [
  { id: 'cam', label: '相机' },
  { id: 'ob', label: '3D 元素' },
  { id: 'el', label: '2D 元素' },
  { id: 'snd', label: '声音' },
];

const fmt = (t) => (Number(t) || 0).toFixed(2);

export class Outliner {
  /**
   * @param {HTMLElement} root  #panelLayers
   * @param {object} o
   *   getProject(), getSelection(), getTime(),
   *   select(sel)            -> main.js select()
   *   activateCamera(id)     -> same path as clicking a camera row on the timeline
   *   reveal(ref)            -> timeline.reveal?.(ref)
   *   seek(t)                -> pause + setTime
   */
  constructor(root, o = {}) {
    this.root = root;
    this.o = o;
    this.query = '';
    this.collapsed = { ...(prefs.get('outlinerGroups', {}) || {}) };
    this.rows = []; // [{ ref, start, end, always, node }]
    this._lastT = null;
    this._build();
    // Time only toggles the active/inactive class; poll instead of hooking the
    // playback loop so playing never rebuilds anything.
    this._timer = setInterval(() => this._tick(), 150);
  }

  // ------------------------------------------------------------ public
  render() {
    const p = this.o.getProject?.();
    this.rows = [];
    if (!p) { this.body.replaceChildren(); return; }
    const q = this.query;
    const match = (name, id) => !q || String(name || '').toLowerCase().includes(q) || String(id || '').toLowerCase().includes(q);

    const items = { cam: [], ob: [], el: [], snd: [] };
    const cams = Array.isArray(p.cameras) && p.cameras.length ? p.cameras : (p.camera ? [p.camera] : []);
    for (const c of cams) {
      const r = cameraRange(p, c);
      items.cam.push({
        ref: cameraRef(c.id), id: c.id, name: c.name || c.id, icon: 'camera', clip: 'camera',
        start: r.start, end: r.end, always: !r.explicit,
      });
    }
    for (const ob of (p.scene?.objects || [])) {
      const s = Number(ob.start) || 0;
      items.ob.push({
        ref: objectRef(ob.id), id: ob.id, name: ob.name || ob.id, icon: OB_ICON[ob.type] || 'cube', clip: 'object',
        start: s, end: s + (Number(ob.duration) || 0),
      });
    }
    // same order as the timeline: z descending
    for (const e of [...(p.elements || [])].sort((a, b) => b.z - a.z)) {
      const s = Number(e.start) || 0;
      const it = {
        ref: elementRef(e.id), id: e.id, name: e.name || e.id, icon: EL_ICON[e.type] || 'square', clip: EL_CLIP[e.type] || 'shape',
        start: s, end: s + (Number(e.duration) || 0), el: e,
      };
      (e.type === 'audio' ? items.snd : items.el).push(it);
    }

    const frag = document.createDocumentFragment();
    let any = false;
    for (const g of GROUPS) {
      const all = items[g.id];
      if (!all.length) continue;
      any = true;
      const shown = all.filter((it) => match(it.name, it.id));
      if (q && !shown.length) continue;
      const collapsed = !q && !!this.collapsed[g.id];
      const sec = h('div', { class: `ol-group${collapsed ? ' collapsed' : ''}`, dataset: { g: g.id } });
      const headBtn = h('button', {
        type: 'button', class: 'ol-ghead', 'aria-expanded': collapsed ? 'false' : 'true',
        onclick: () => this._toggleGroup(g.id),
      },
      icon(collapsed ? 'chevron-right' : 'chevron-down', 'ic-sm'),
      h('span', { class: 'ol-gtitle' }, g.label),
      h('span', { class: 'ol-gcount' }, q ? `${shown.length} / ${all.length}` : String(all.length)));
      sec.appendChild(headBtn);
      if (!collapsed) {
        const list = h('div', { class: 'ol-rows', role: 'listbox', 'aria-label': g.label });
        for (const it of shown) {
          // The 12×12 source mark sits between the type icon and the name, only
          // for an element that comes from a compiled source (WP4.6a §3.1).
          const mark = sourceMark(p, it.el, 'ol-src');
          const node = h('div', {
            class: 'list-row ol-row', role: 'option', dataset: { ref: it.ref, tip: it.name },
          },
          h('span', { class: `ol-ic clip-${it.clip}` }, icon(it.icon, 'ic-sm')),
          ...(mark ? [mark] : []),
          h('span', { class: 'ol-name' }, it.name),
          h('span', { class: 'ol-time' }, `${fmt(it.start)}–${fmt(it.end)}`));
          this.rows.push({ ...it, node });
          list.appendChild(node);
        }
        sec.appendChild(list);
      }
      frag.appendChild(sec);
    }
    if (!any) {
      this.body.replaceChildren(h('div', { class: 'empty ol-empty' },
        icon('layers'),
        h('div', { class: 'empty-text' }, '还没有图层。用顶栏的工具添加相机、文字或色块，或从资源拖入素材。')));
      return;
    }
    if (!frag.childNodes.length) {
      this.body.replaceChildren(h('div', { class: 'hint ol-none' }, `没有名称或 id 包含「${this.search.value.trim()}」的图层`));
      return;
    }
    this.body.replaceChildren(frag);
    this._lastT = null;
    this._tick(true);
    this.setSelection();
  }

  /** Selection changed: repaint row highlight only. */
  setSelection() {
    const sel = this.o.getSelection?.() || {};
    const p = this.o.getProject?.();
    const on = new Set();
    const pool = sel.pool;
    if (pool?.kind === 'element') for (const r of pool.ids || []) on.add(r);
    if (!on.size) {
      if (sel.elementId) on.add(elementRef(sel.elementId));
      if (sel.objectId) on.add(objectRef(sel.objectId));
      const camId = p?.activeCameraId || p?.camera?.id;
      if (sel.camera && camId) on.add(cameraRef(camId));
    }
    for (const r of this.rows) {
      const s = on.has(r.ref);
      r.node.classList.toggle('sel', s);
      r.node.setAttribute('aria-selected', s ? 'true' : 'false');
    }
  }

  // ------------------------------------------------------------ internals
  _build() {
    this.root.classList.add('outliner');
    this.search = h('input', {
      type: 'search', placeholder: '搜索名称或 id', autocomplete: 'off', spellcheck: 'false', 'aria-label': '搜索图层',
    });
    let deb = null;
    this.search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { this.query = this.search.value.trim().toLowerCase(); this.render(); }, 60);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.search.value) {
        this.search.value = ''; this.query = ''; this.render(); e.stopPropagation();
      }
    });
    this.body = h('div', { class: 'ol-body' });
    this.root.replaceChildren(
      h('div', { class: 'ol-head' }, h('label', { class: 'asset-search' }, icon('search', 'ic-sm'), this.search)),
      this.body);
    // one delegated listener set for all rows
    this.body.addEventListener('click', (e) => {
      const row = e.target.closest('.ol-row');
      if (row) this._pick(row.dataset.ref, e);
    });
    this.body.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.ol-row');
      const it = row && this.rows.find((r) => r.ref === row.dataset.ref);
      if (it) this.o.seek?.(it.start);
    });
  }

  _toggleGroup(id) {
    if (this.query) return; // groups are forced open while searching
    this.collapsed[id] = !this.collapsed[id];
    if (!this.collapsed[id]) delete this.collapsed[id];
    prefs.set('outlinerGroups', { ...this.collapsed });
    this.render();
  }

  /** Mirror the timeline's header-row click for each kind. */
  _pick(ref, ev) {
    const i = ref.indexOf(':');
    const type = ref.slice(0, i);
    const id = ref.slice(i + 1);
    if (type === 'cam') {
      this.o.activateCamera?.(id);
    } else {
      const sel = this.o.getSelection?.() || {};
      const additive = !!(ev?.ctrlKey || ev?.metaKey || ev?.shiftKey);
      const pool = additive && sel.pool ? addSelection(sel.pool, 'element', ref) : selectOne('element', ref);
      if (type === 'ob') this.o.select?.({ objectId: id, pool });
      else this.o.select?.({ elementId: id, pool });
    }
    this.o.reveal?.(ref);
  }

  _tick(force = false) {
    if (!force && this.root.hidden) return;
    const t = Number(this.o.getTime?.()) || 0;
    if (!force && t === this._lastT) return;
    this._lastT = t;
    for (const r of this.rows) {
      const live = r.always || (t >= r.start - 1e-6 && t < r.end - 1e-6);
      r.node.classList.toggle('off', !live);
    }
  }
}
