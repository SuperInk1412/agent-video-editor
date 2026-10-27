// Project picker: lists projects from the engine and reopens the app on one.
// Opening / restarting happens in the Electron main process (the engine runs
// in-process there), so the UI simply asks the preload bridge.
// Layout and keyboard rules: docs/DESIGN.md §2 (modal), styles in css/dialogs.css.
import { h, icon } from './ui.js';

const $ = (s) => document.querySelector(s);

/** The visible modal that sits on top (last in DOM order). */
const topModal = () => [...document.querySelectorAll('.modal:not([hidden])')].pop() || null;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `modal` (cycles first <-> last focusable). */
function trapTab(modal, e) {
  const nodes = [...modal.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function closeButton(onClick) {
  return h('button', { type: 'button', class: 'icon-btn modal-x', 'aria-label': '关闭', 'data-tip': '关闭', 'data-kbd': 'Esc', onClick }, icon('x'));
}

/**
 * Build a dynamic dialog per §2: scrim, card (role=dialog), head (title + hint + ×), body, foot.
 * `onKey(e)` sees keys first while this dialog is on top; return true to consume.
 * `scrimClose()` decides whether a scrim click may close (default: yes).
 * Returns { modal, card, body, foot, close } — close() removes it and restores focus to the opener.
 */
function dialog({ title, hint = '', cls = '', onClose, onKey, scrimClose = () => true }) {
  const opener = document.activeElement;
  const titleId = `dlg${Math.random().toString(36).slice(2, 8)}`;
  let settled = false;
  const close = (...args) => {
    if (settled) return;
    settled = true;
    modal.remove();
    window.removeEventListener('keydown', keyHandler, true);
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    onClose?.(...args);
  };
  const head = h('div', { class: 'modal-head' },
    h('div', { class: 'modal-title' },
      h('strong', { id: titleId }, title),
      hint ? h('span', { class: 'hint' }, hint) : null),
    closeButton(() => close()));
  const body = h('div', { class: 'dlg-body' });
  const foot = h('div', { class: 'modal-foot' });
  const card = h('div', { class: `modal-card dlg ${cls}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    head, body, foot);
  const modal = h('div', { class: 'modal' }, card);
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal && scrimClose()) close(); });
  const keyHandler = (e) => {
    if (topModal() !== modal) return;
    if (onKey?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (e.key === 'Tab') trapTab(modal, e);
  };
  window.addEventListener('keydown', keyHandler, true);
  document.body.append(modal);
  return { modal, card, body, foot, close };
}

const fmtMeta = (p) => `rev ${p.rev} · ${p.width}×${p.height} · ${Number(p.duration || 0).toFixed(1)}s`;

const SIZE_PRESETS = [
  { label: '1920×1080', w: 1920, h: 1080, tip: '横屏 16:9' },
  { label: '1080×1920', w: 1080, h: 1920, tip: '竖屏 9:16' },
  { label: '1080×1080', w: 1080, h: 1080, tip: '方形 1:1' },
  { label: '自定义', w: 0, h: 0, tip: '自己填宽高' },
];

export class ProjectsPanel {
  constructor({ toast }) {
    this.toast = toast;
    this.modal = $('#projectModal');
    this.list = $('#projList');
    this.data = null;
    this.query = '';
    this.act = -1;
    this.rows = [];
    this.opener = null;
    if (!this.modal) return;
    this._enhance();
    $('#projClose').onclick = () => this.close();
    this.modal.addEventListener('pointerdown', (e) => { if (e.target === this.modal) this.close(); });
    $('#projBrowse').onclick = () => this.browse();
    $('#projBrowse').hidden = !window.vdmDesktop;
    $('#projNew').onclick = () => this.newProject();
    $('#projRestart').onclick = () => this.restart();
    // Picker keys (capture, only while the picker is the top dialog).
    window.addEventListener('keydown', (e) => {
      if (this.modal.hidden || topModal() !== this.modal) return;
      const typing = e.target === this.search;
      if (e.key === 'Escape') { this.close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { this._move(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter' && (typing || !(e.target instanceof HTMLButtonElement))) {
        const p = this.rows[this.act >= 0 ? this.act : 0]?.p;
        if (!p) return;
        this.choose(p);
      } else if (e.key === 'Tab') { trapTab(this.modal, e); return; }
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    // Ctrl+O / Ctrl+Shift+R are registered commands (commands.js, wired in main.js).
    window.vdmDesktop?.onOpenPicker(() => this.open());
  }

  /** Add the runtime-only picker chrome (search box, icons, dialog roles) to the static markup. */
  _enhance() {
    const card = this.modal.querySelector('.modal-card');
    card.classList.add('proj-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const strong = card.querySelector('.modal-head strong');
    if (strong) { strong.id = 'projTitle'; card.setAttribute('aria-labelledby', 'projTitle'); }
    card.querySelector('.modal-head > div')?.classList.add('modal-title');
    const cur = $('#projCurrent');
    cur?.classList.add('mono', 'proj-current');
    const x = $('#projClose');
    if (x) {
      x.className = 'icon-btn modal-x';
      x.removeAttribute('title');
      x.setAttribute('aria-label', '关闭');
      x.dataset.tip = '关闭';
      x.dataset.kbd = 'Esc';
      x.replaceChildren(icon('x'));
    }
    this.search = h('input', {
      id: 'projSearch', type: 'search', placeholder: '搜索标题或目录', autocomplete: 'off', spellcheck: 'false',
      'aria-label': '搜索项目', 'aria-controls': 'projList',
      onInput: () => { this.query = this.search.value; this.act = -1; this._renderRows(); },
    });
    const box = h('div', { class: 'proj-search' }, icon('search', 'ic-sm'), this.search);
    this.list.before(box);
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', '项目');
    const deco = (id, ic) => {
      const b = $(id);
      if (!b || b.querySelector('.ic')) return;
      b.classList.add('btn', 'lg');
      b.prepend(icon(ic, 'ic-sm'));
    };
    deco('#projNew', 'plus');
    deco('#projBrowse', 'folder');
    deco('#projRestart', 'refresh');
    const restart = $('#projRestart');
    if (restart) { restart.dataset.tip = '重启当前项目'; restart.dataset.kbd = 'Ctrl+Shift+R'; }
  }

  async open() {
    if (this.modal.hidden) this.opener = document.activeElement;
    this.modal.hidden = false;
    this.search.value = this.query = '';
    this.act = -1;
    this.search.focus();
    this.list.replaceChildren(h('div', { class: 'proj-state hint' }, '读取项目…'));
    try {
      const d = await fetch('/api/projects').then((r) => r.json());
      this.data = d;
      this.render(d);
    } catch (e) {
      this.list.replaceChildren(h('div', { class: 'proj-state hint' }, `读取失败：${e.message}`));
    }
  }

  close() {
    if (!this.modal || this.modal.hidden) return;
    this.modal.hidden = true;
    const o = this.opener;
    this.opener = null;
    if (o && o.isConnected && typeof o.focus === 'function') o.focus();
  }

  render(d) {
    const cur = $('#projCurrent');
    if (cur) { cur.textContent = d.root ? `当前：${d.root}` : ''; cur.title = d.root || ''; }
    // Most recently saved first (meta.savedAt); ties / missing keep server order.
    this.projects = (d.projects || [])
      .map((p, i) => ({ p, i }))
      .sort((a, b) => String(b.p.savedAt || '').localeCompare(String(a.p.savedAt || '')) || a.i - b.i)
      .map((x) => x.p);
    this._renderRows();
  }

  _renderRows() {
    if (!this.projects) return;
    const q = this.query.trim().toLowerCase();
    const shown = q
      ? this.projects.filter((p) => `${p.title}\n${p.dir}`.toLowerCase().includes(q))
      : this.projects;
    this.rows = [];
    if (!shown.length) {
      const none = !this.projects.length;
      this.list.replaceChildren(h('div', { class: 'empty' },
        icon(none ? 'folder' : 'search'),
        h('div', { class: 'empty-title' }, none ? '新建项目' : '没有匹配的项目'),
        h('div', { class: 'empty-text' }, none ? 'projects/ 里还没有项目，先建一个空时间线' : `没有标题或目录包含「${this.query.trim()}」的项目`),
        h('button', { type: 'button', class: 'btn', onClick: () => this.newProject() }, icon('plus', 'ic-sm'), '新建项目…')));
      return;
    }
    const frag = document.createDocumentFragment();
    shown.forEach((p, i) => {
      const del = h('button', {
        type: 'button',
        class: 'icon-btn danger proj-del',
        'aria-label': `删除项目 ${p.title}`,
        'aria-disabled': p.current ? 'true' : null,
        'data-tip': p.current ? '当前打开的项目不能删除，请先切换到其他项目' : '删除项目目录',
        tabindex: '-1',
        onClick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.deleteProject(p);
        },
      }, icon('trash', 'ic-sm'));
      const row = h('div', {
        class: `proj-row${p.current ? ' current' : ''}`,
        role: 'option',
        'aria-selected': 'false',
        dataset: { dir: p.dir },
        onClick: () => this.choose(p),
        onPointerenter: () => this._setAct(i, false),
      },
      h('div', { class: 'pr-main' },
        h('div', { class: 'pr-title' },
          h('span', { class: 'pr-name' }, p.title),
          p.current ? h('span', { class: 'badge badge-accent' }, '当前') : null,
          p.camera ? h('span', { class: 'badge badge-camera' }, '3D 相机') : null),
        h('div', { class: 'pr-dir mono', title: p.dir }, p.dir)),
      h('div', { class: 'pr-meta mono' }, fmtMeta(p)),
      del);
      this.rows.push({ p, row });
      frag.append(row);
    });
    this.list.replaceChildren(frag);
    if (this.act >= this.rows.length) this.act = -1;
    if (this.act >= 0) this._setAct(this.act);
  }

  _setAct(i, scroll = true) {
    this.act = i;
    this.rows.forEach((r, j) => {
      r.row.classList.toggle('act', j === i);
      r.row.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
    if (scroll) this.rows[i]?.row.scrollIntoView({ block: 'nearest' });
  }

  _move(dir) {
    const n = this.rows.length;
    if (!n) return;
    const i = this.act < 0 ? (dir > 0 ? 0 : n - 1) : (this.act + dir + n) % n;
    this._setAct(i);
  }

  /** Create a blank 2D project in a chosen folder, then reopen the app there. */
  newProject() {
    const errs = new Map(); // input -> error node
    let dirty = false;
    const dlg = dialog({
      title: '新建项目',
      hint: '先建一个空时间线，素材和相机之后再加',
      cls: 'newproj-card',
      scrimClose: () => !dirty,
      onKey: (e) => {
        if (e.key !== 'Enter' || e.isComposing) return false;
        if (e.target instanceof HTMLButtonElement) return false; // native click
        submit();
        return true;
      },
    });
    const grid = h('div', { class: 'form-grid' });
    const field = (label, control, input) => {
      const err = h('div', { class: 'field-err', hidden: true });
      const id = input.id || (input.id = `np${Math.random().toString(36).slice(2, 8)}`);
      grid.append(h('label', { class: 'form-label', for: id }, label), h('div', { class: 'form-ctl' }, control, err));
      errs.set(input, err);
      return input;
    };
    const num = (value, attrs) => h('input', { type: 'number', value: String(value), ...attrs });

    const name = h('input', { type: 'text', value: '未命名项目', placeholder: '未命名项目' });
    field('标题', name, name);

    const width = num(1920, { min: 1, step: 1, 'aria-label': '宽度', class: 'num-sm' });
    const height = num(1080, { min: 1, step: 1, 'aria-label': '高度', class: 'num-sm' });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '尺寸预设' });
    const segBtns = SIZE_PRESETS.map((s) => {
      const b = h('button', { type: 'button', 'data-tip': s.tip, onClick: () => {
        if (s.w) { width.value = String(s.w); height.value = String(s.h); }
        syncSeg(s.w ? null : 'custom');
        if (!s.w) width.focus();
      } }, s.label);
      seg.append(b);
      return b;
    });
    const syncSeg = (force) => {
      const w = Number(width.value);
      const ht = Number(height.value);
      let idx = SIZE_PRESETS.findIndex((s) => s.w === w && s.h === ht);
      if (force === 'custom' || idx < 0) idx = SIZE_PRESETS.length - 1;
      segBtns.forEach((b, i) => b.setAttribute('aria-pressed', i === idx ? 'true' : 'false'));
    };
    width.addEventListener('input', () => syncSeg());
    height.addEventListener('input', () => syncSeg());
    syncSeg();
    const sizeRow = h('div', { class: 'form-stack' }, seg,
      h('div', { class: 'form-inline' }, width, h('span', { class: 'dim' }, '×'), height, h('span', { class: 'unit' }, 'px')));
    field('尺寸', sizeRow, width);
    errs.set(height, errs.get(width));

    const fps = num(24, { min: 1, max: 240, step: 1, class: 'num-sm' });
    field('帧率', h('div', { class: 'form-inline' }, fps, h('span', { class: 'unit' }, 'fps')), fps);
    const duration = num(12, { min: 0.1, step: 0.1, class: 'num-sm' });
    field('时长', h('div', { class: 'form-inline' }, duration, h('span', { class: 'unit' }, 's')), duration);

    const swatch = h('input', { type: 'color', value: '#05070d', 'aria-label': '背景颜色' });
    const hex = h('input', { type: 'text', value: '#05070d', class: 'mono num-sm', maxlength: 7, spellcheck: 'false', 'aria-label': '背景颜色 hex' });
    swatch.addEventListener('input', () => { hex.value = swatch.value; clearErr(hex); });
    hex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value.trim())) swatch.value = hex.value.trim(); });
    field('背景', h('div', { class: 'form-inline' }, swatch, hex), hex);

    const pathInput = h('input', { type: 'text', value: 'projects/未命名项目', class: 'mono', spellcheck: 'false' });
    const choose = h('button', { type: 'button', class: 'btn', hidden: !window.vdmDesktop }, icon('folder', 'ic-sm'), '浏览…');
    field('目录', h('div', { class: 'form-inline' }, pathInput, choose), pathInput);

    const status = h('div', { class: 'dlg-error', role: 'alert', hidden: true });
    dlg.body.append(grid, status);

    const cancel = h('button', { type: 'button', class: 'btn lg', onClick: () => dlg.close() }, '取消');
    const create = h('button', { type: 'button', class: 'btn lg primary', onClick: () => submit() }, '创建并打开');
    dlg.foot.append(h('span', { class: 'spacer' }), cancel, create);

    grid.addEventListener('input', (e) => { dirty = true; if (e.target instanceof HTMLInputElement) clearErr(e.target); });

    function setErr(input, msg) {
      const n = errs.get(input);
      if (n) { n.textContent = msg; n.hidden = false; }
      input.setAttribute('aria-invalid', 'true');
    }
    function clearErr(input) {
      const n = errs.get(input);
      if (n) { n.hidden = true; n.textContent = ''; }
      input.removeAttribute('aria-invalid');
      if (input === width || input === height) { width.removeAttribute('aria-invalid'); height.removeAttribute('aria-invalid'); }
    }

    choose.onclick = async () => {
      if (!window.vdmDesktop) return;
      try {
        const dir = await window.vdmDesktop.pickFolder();
        if (dir) { pathInput.value = dir; dirty = true; clearErr(pathInput); }
      } catch (e) {
        status.textContent = String(e?.message || e);
        status.hidden = false;
      }
    };

    let busy = false;
    const submit = async () => {
      if (busy) return;
      for (const i of errs.keys()) clearErr(i);
      status.hidden = true;
      const bad = [];
      const v = (node) => Number(node.value);
      const check = (cond, input, msg) => { if (!cond) { if (!input.hasAttribute('aria-invalid')) setErr(input, msg); bad.push(input); } };
      const w = v(width);
      const ht = v(height);
      check(Number.isInteger(w) && w >= 1 && Number.isInteger(ht) && ht >= 1, Number.isInteger(w) && w >= 1 ? height : width, '宽高要是正整数');
      check(Number.isFinite(v(fps)) && v(fps) >= 1 && v(fps) <= 240, fps, '帧率在 1–240 之间');
      check(Number.isFinite(v(duration)) && v(duration) >= 0.1, duration, '时长至少 0.1s');
      check(/^#[0-9a-f]{6}$/i.test(hex.value.trim()), hex, '颜色写成 #rrggbb');
      check(!!pathInput.value.trim(), pathInput, '先选择项目目录');
      if (bad.length) { bad[0].focus(); bad[0].select?.(); return; }
      const payload = {
        dir: pathInput.value.trim(),
        title: name.value.trim() || '未命名项目',
        width: w,
        height: ht,
        fps: v(fps),
        duration: v(duration),
        background: hex.value.trim(),
      };
      busy = true;
      create.disabled = true;
      create.textContent = '创建中…';
      try {
        const res = await fetch('/api/projects/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `创建失败 (${res.status})`);
        dlg.close();
        this.close();
        this.toast?.(`已创建项目：${j.project?.meta?.title || payload.title}`, 'success');
        if (window.vdmDesktop) await window.vdmDesktop.openProject(j.dir);
        else this.toast?.('项目已创建；浏览器模式请重启到该目录', 'info');
      } catch (e) {
        busy = false;
        status.textContent = String(e?.message || e);
        status.hidden = false;
        create.disabled = false;
        create.textContent = '创建并打开';
      }
    };
    name.focus();
    name.select();
    return dlg;
  }

  /** Delete a non-current project folder after an explicit confirmation. */
  deleteProject(p) {
    if (p.current) {
      this.toast?.('当前项目不能删除，请先切换到其他项目', 'warn');
      return;
    }
    const dlg = dialog({ title: '删除项目', hint: '不可撤销', cls: 'del-dialog' });
    dlg.body.append(
      h('p', { class: 'dlg-text' }, '确定删除「', h('b', {}, p.title), '」？'),
      h('div', { class: 'del-list mono' }, h('div', {}, p.dir)),
      h('p', { class: 'dlg-note' }, '整个目录都会从磁盘删除，包括素材、渲染结果和项目文件。'));
    const cancel = h('button', { type: 'button', class: 'btn lg', onClick: () => dlg.close() }, '取消');
    const ok = h('button', { type: 'button', class: 'btn lg danger' }, icon('trash', 'ic-sm'), '删除项目');
    dlg.foot.append(h('span', { class: 'spacer' }), cancel, ok);
    cancel.focus();
    ok.onclick = async () => {
      ok.disabled = true;
      ok.lastChild.textContent = '删除中…';
      try {
        const res = await fetch('/api/projects/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: p.dir }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `删除失败 (${res.status})`);
        dlg.close();
        this.toast?.(`已删除项目：${p.title}`, 'success');
        await this.open();
      } catch (e) {
        ok.disabled = false;
        ok.lastChild.textContent = '删除项目';
        this.toast?.(String(e?.message || e), 'error');
      }
    };
    return dlg;
  }

  async choose(p) {
    if (p.current) { this.toast?.('已经是当前项目'); this.close(); return; }
    if (!window.vdmDesktop) {
      this.toast?.('浏览器模式：用 npm run dev --project=<目录> 切换项目', 'error');
      return;
    }
    this.toast?.(`正在打开 ${p.title} …`);
    try {
      await window.vdmDesktop.openProject(p.dir);
      this.close();
    } catch (e) {
      this.toast?.(String(e?.message || e), 'error');
    }
  }

  async browse() {
    if (!window.vdmDesktop) return;
    try {
      const dir = await window.vdmDesktop.pickFolder();
      if (!dir) return;
      await this.choose({ dir, title: dir, current: false });
    } catch (e) {
      this.toast?.(String(e?.message || e), 'error');
    }
  }

  async restart() {
    if (window.vdmDesktop) {
      try { await window.vdmDesktop.restart(); } catch (e) { this.toast?.(String(e?.message || e), 'error'); }
      return;
    }
    location.reload();
  }
}
