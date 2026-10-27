// 资源 panel (docs/DESIGN.md §1.3): media library in #panelMedia.
// Search + import, type filter with counts, card grid, add-at-playhead,
// drag to the timeline (application/x-vdm-media), OS file drop = upload.
// Project writes go through the callbacks main.js passes in (ops stay there).

import { h, icon, prefs } from './ui.js';

export const MEDIA_MIME = 'application/x-vdm-media';

const KINDS = [
  { id: 'all', label: '全部' },
  { id: 'video', label: '视频' },
  { id: 'image', label: '图片' },
  { id: 'audio', label: '音频' },
];
const KIND_LABEL = { video: '视频', image: '图片', audio: '音频' };
const KIND_ICON = { video: 'video', image: 'image', audio: 'music' };

export class AssetsPanel {
  /**
   * @param {HTMLElement} root  #panelMedia
   * @param {object} o
   *   getProject(), mediaKind(path), onAdd(m, kind), onSoundtrack(m), onList(list),
   *   menu(x, y, items), toast(msg, level)
   */
  constructor(root, o = {}) {
    this.root = root;
    this.o = o;
    this.media = [];
    this.loaded = false;
    this.query = '';
    this.filter = KINDS.some((k) => k.id === prefs.get('assetFilter')) ? prefs.get('assetFilter') : 'all';
    this.selPath = null;
    this._build();
  }

  // ------------------------------------------------------------ public
  /** Re-read media/ from the engine and redraw. */
  async refresh() {
    const j = await fetch('/api/media').then((r) => r.json()).catch(() => ({ media: [] }));
    this.media = j.media || [];
    this.loaded = true;
    this.o.onList?.(this.media);
    this._render();
  }

  /** Project changed (soundtrack may differ): repaint the badges only. */
  syncProject() {
    const src = this._trackSrc();
    if (src === this._lastTrack) return;
    this._render();
  }

  /** Upload OS files into media/, then refresh. */
  async upload(files) {
    const list = [...(files || [])].filter((f) => f && f.name);
    if (!list.length) return;
    let ok = 0;
    for (const f of list) {
      try {
        const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
        if (r.ok) ok++;
        else this.o.toast?.(`导入失败：${f.name}`, 'error');
      } catch (e) {
        this.o.toast?.(`导入失败：${f.name} · ${e.message}`, 'error');
      }
    }
    if (ok) this.o.toast?.(ok === 1 ? '素材已导入' : `已导入 ${ok} 个素材`, 'success');
    await this.refresh();
  }

  // ------------------------------------------------------------ build
  _build() {
    const root = this.root;
    root.classList.add('assets');
    root.replaceChildren();

    this.file = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1' });
    this.file.addEventListener('change', () => {
      const files = [...this.file.files];
      this.file.value = '';
      this.upload(files);
    });

    this.search = h('input', {
      type: 'search', placeholder: '搜索文件名', autocomplete: 'off', spellcheck: 'false', 'aria-label': '搜索素材',
    });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this._render(); });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.search.value) { this.search.value = ''; this.query = ''; this._render(); e.stopPropagation(); }
    });
    const imp = h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': '导入', dataset: { tip: '导入素材（视频 / 图片 / 音频）' },
      onclick: () => this.file.click(),
    }, icon('upload'));
    const head = h('div', { class: 'asset-head' },
      h('label', { class: 'asset-search' }, icon('search', 'ic-sm'), this.search),
      imp, this.file);

    this.seg = h('div', { class: 'seg asset-filter', role: 'tablist', 'aria-label': '素材类型' });
    this.segBtns = {};
    for (const k of KINDS) {
      const b = h('button', { type: 'button', role: 'tab', dataset: { kind: k.id } },
        h('span', { class: 'asset-fl' }, k.label), h('span', { class: 'asset-fc' }, '0'));
      b.addEventListener('click', () => {
        this.filter = k.id;
        prefs.set('assetFilter', k.id);
        this._render();
      });
      this.segBtns[k.id] = b;
      this.seg.appendChild(b);
    }

    this.body = h('div', { class: 'asset-body' });
    this.drop = h('div', { class: 'asset-drop', hidden: true }, icon('upload'), h('span', {}, '松开导入'));
    root.append(head, this.seg, this.body, this.drop);
    this._bindFileDrop();
  }

  _bindFileDrop() {
    const root = this.root;
    let depth = 0;
    const isFiles = (e) => {
      const t = [...(e.dataTransfer?.types || [])];
      return t.includes('Files') && !t.includes(MEDIA_MIME);
    };
    const hide = () => { depth = 0; this.drop.hidden = true; };
    root.addEventListener('dragenter', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth++;
      this.drop.hidden = false;
    });
    root.addEventListener('dragover', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    root.addEventListener('dragleave', (e) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) this.drop.hidden = true;
    });
    root.addEventListener('drop', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      hide();
      this.upload(e.dataTransfer.files);
    });
    window.addEventListener('dragend', hide);
  }

  // ------------------------------------------------------------ render
  _trackSrc() { return this.o.getProject?.()?.meta?.audio?.src || null; }
  _kind(m) { return this.o.mediaKind?.(m.path) || null; }

  _render() {
    const track = this._trackSrc();
    this._lastTrack = track;
    const counts = { all: this.media.length, video: 0, image: 0, audio: 0 };
    for (const m of this.media) { const k = this._kind(m); if (k in counts) counts[k]++; }
    for (const k of KINDS) {
      const b = this.segBtns[k.id];
      const on = this.filter === k.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.lastChild.textContent = String(counts[k.id]);
    }
    this.seg.hidden = !this.media.length;

    if (!this.loaded) { this.body.replaceChildren(); return; }
    if (!this.media.length) {
      this.body.replaceChildren(h('div', { class: 'empty asset-empty' },
        icon('assets'),
        h('div', { class: 'empty-title' }, '导入素材'),
        h('div', { class: 'empty-text' }, '把视频、图片或音频拖到这里，或点导入'),
        h('button', { type: 'button', class: 'btn', onclick: () => this.file.click() }, icon('upload', 'ic-sm'), '导入')));
      return;
    }
    const q = this.query;
    const shown = this.media.filter((m) => (this.filter === 'all' || this._kind(m) === this.filter)
      && (!q || String(m.name).toLowerCase().includes(q)));
    if (!shown.length) {
      const what = this.filter === 'all' ? '素材' : KIND_LABEL[this.filter];
      this.body.replaceChildren(h('div', { class: 'hint asset-none' },
        q ? `没有文件名包含「${this.search.value.trim()}」的${what}` : `还没有${what}`));
      return;
    }
    if (this.selPath && !this.media.some((m) => m.path === this.selPath)) this.selPath = null;
    const grid = h('div', { class: 'asset-grid', role: 'listbox', 'aria-label': '素材' });
    for (const m of shown) grid.appendChild(this._card(m, track));
    this.body.replaceChildren(grid);
  }

  _card(m, track) {
    const kind = this._kind(m);
    const isTrack = kind === 'audio' && track === m.path;
    const thumb = h('div', { class: 'asset-thumb' });
    if (kind === 'image') thumb.appendChild(h('img', { src: `/${m.path}`, loading: 'lazy', alt: '', draggable: 'false' }));
    else thumb.appendChild(h('span', { class: 'asset-ic' }, icon(KIND_ICON[kind] || 'assets')));
    thumb.appendChild(h('span', { class: 'asset-badges' },
      h('span', { class: `badge ${kind ? `badge-${kind}` : ''}` }, KIND_LABEL[kind] || '其他'),
      isTrack ? h('span', { class: 'badge badge-accent' }, '配乐') : null));
    const add = h('button', {
      type: 'button', class: 'icon-btn mini asset-add', 'aria-label': '在播放头加入', dataset: { tip: '在播放头加入' },
      onclick: (e) => { e.stopPropagation(); this._add(m); },
    }, icon('plus', 'ic-sm'));
    add.addEventListener('dblclick', (e) => e.stopPropagation());
    thumb.appendChild(add);

    const card = h('div', {
      class: `asset-card${isTrack ? ' track' : ''}${this.selPath === m.path ? ' sel' : ''}`,
      role: 'option', tabindex: '0', draggable: 'true',
      'aria-selected': this.selPath === m.path ? 'true' : 'false',
      dataset: { path: m.path, tip: m.name },
    }, thumb, h('div', { class: 'asset-name' }, m.name));
    card.addEventListener('click', () => this._select(m.path));
    card.addEventListener('dblclick', () => this._add(m));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._add(m); }
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._select(m.path);
      this.o.menu?.(e.clientX, e.clientY, this._menu(m, kind, isTrack));
    });
    card.addEventListener('dragstart', (e) => {
      this._select(m.path);
      e.dataTransfer.setData(MEDIA_MIME, m.path);
      e.dataTransfer.setData('text/plain', m.name);
      e.dataTransfer.effectAllowed = 'copy';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    return card;
  }

  _menu(m, kind, isTrack) {
    const items = [{ label: '在播放头加入', icon: 'plus', kbd: 'Enter', run: () => this._add(m) }];
    if (kind === 'audio') {
      items.push({
        label: isTrack ? '当前已是配乐' : '设为配乐（分析节拍）',
        icon: 'music',
        disabled: isTrack,
        run: () => this.o.onSoundtrack?.(m),
      });
    }
    return items;
  }

  _select(path) {
    this.selPath = path;
    for (const c of this.body.querySelectorAll('.asset-card')) {
      const on = c.dataset.path === path;
      c.classList.toggle('sel', on);
      c.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  _add(m) {
    this._select(m.path);
    const kind = this._kind(m);
    if (!kind) { this.o.toast?.('只能把图片、视频和声音放进时间线', 'warn'); return; }
    this.o.onAdd?.(m, kind);
  }
}
