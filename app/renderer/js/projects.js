// Project picker: lists projects from the engine and reopens the app on one.
// Opening / restarting happens in the Electron main process (the engine runs
// in-process there), so the UI simply asks the preload bridge.
import { escapeHtml } from './timeline.js';

const $ = (s) => document.querySelector(s);

export class ProjectsPanel {
  constructor({ toast }) {
    this.toast = toast;
    this.modal = $('#projectModal');
    this.list = $('#projList');
    this.data = null;
    if (!this.modal) return;
    $('#projClose').onclick = () => this.close();
    this.modal.addEventListener('pointerdown', (e) => { if (e.target === this.modal) this.close(); });
    $('#projBrowse').onclick = () => this.browse();
    $('#projBrowse').hidden = !window.vdmDesktop;
    $('#projNew').onclick = () => this.newProject();
    $('#projRestart').onclick = () => this.restart();
    window.addEventListener('keydown', (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (!this.modal.hidden && e.key === 'Escape') { this.close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); this.open(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); this.restart(); }
    });
    window.vdmDesktop?.onOpenPicker(() => this.open());
  }

  async open() {
    this.modal.hidden = false;
    this.list.innerHTML = '<div class="hint" style="padding:16px">读取项目…</div>';
    try {
      const d = await fetch('/api/projects').then((r) => r.json());
      this.data = d;
      this.render(d);
    } catch (e) {
      this.list.innerHTML = `<div class="hint" style="padding:16px">读取失败：${escapeHtml(e.message)}</div>`;
    }
  }

  close() {
    if (this.modal) this.modal.hidden = true;
  }

  /** Create a blank 2D project in a chosen folder, then reopen the app there. */
  newProject() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card newproj-card';

    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = '新建项目';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '先建一个空时间线，素材和相机之后再加';
    title.append(strong, hint);
    const close = document.createElement('button');
    close.className = 'mini';
    close.textContent = '×';
    close.title = '关闭';
    head.append(title, close);

    const body = document.createElement('div');
    body.className = 'newproj-body';
    const grid = document.createElement('div');
    grid.className = 'newproj-grid';
    const field = (label, input, wide = false) => {
      const l = document.createElement('label');
      if (wide) l.className = 'wide';
      const s = document.createElement('span');
      s.textContent = label;
      l.append(s, input);
      grid.append(l);
      return input;
    };
    const inp = (type, value, attrs = {}) => {
      const i = document.createElement('input');
      i.type = type;
      i.value = String(value);
      for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, String(v));
      return i;
    };

    const name = field('标题', inp('text', '未命名项目'));
    const pathInput = inp('text', 'projects/未命名项目');
    const pathRow = document.createElement('div');
    pathRow.className = 'newproj-path';
    pathRow.append(pathInput);
    const choose = document.createElement('button');
    choose.className = 'mini';
    choose.textContent = '选择…';
    choose.hidden = !window.vdmDesktop;
    pathRow.append(choose);
    field('位置', pathRow, true);
    const width = field('宽度 px', inp('number', 1920, { min: 1, step: 1 }));
    const height = field('高度 px', inp('number', 1080, { min: 1, step: 1 }));
    const fps = field('帧率', inp('number', 24, { min: 1, max: 240, step: 1 }));
    const duration = field('时长 s', inp('number', 12, { min: 0.1, step: 0.1 }));
    const bg = field('背景', inp('color', '#05070d'));
    body.append(grid);

    const status = document.createElement('div');
    status.className = 'newproj-status';
    body.append(status);

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const cancel = document.createElement('button');
    cancel.className = 'mini';
    cancel.textContent = '取消';
    const create = document.createElement('button');
    create.className = 'primary';
    create.textContent = '创建并打开';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    foot.append(spacer, cancel, create);
    card.append(head, body, foot);
    modal.append(card);
    document.body.append(modal);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      modal.remove();
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish();
    };
    window.addEventListener('keydown', onKey, true);
    close.onclick = finish;
    cancel.onclick = finish;
    modal.addEventListener('pointerdown', (e) => { if (e.target === modal) finish(); });

    choose.onclick = async () => {
      if (!window.vdmDesktop) return;
      try {
        const dir = await window.vdmDesktop.pickFolder();
        if (dir) pathInput.value = dir;
      } catch (e) {
        status.textContent = String(e?.message || e);
      }
    };

    create.onclick = async () => {
      const n = (node, dflt) => {
        const v = Number(node.value);
        return Number.isFinite(v) && v > 0 ? v : dflt;
      };
      const payload = {
        dir: pathInput.value.trim(),
        title: name.value.trim() || '未命名项目',
        width: n(width, 1920),
        height: n(height, 1080),
        fps: n(fps, 24),
        duration: n(duration, 12),
        background: bg.value,
      };
      if (!payload.dir) { status.textContent = '先选择项目目录'; return; }
      create.disabled = true;
      create.textContent = '创建中…';
      status.textContent = '';
      try {
        const res = await fetch('/api/projects/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `创建失败 (${res.status})`);
        finish();
        this.close();
        this.toast?.(`已创建项目：${j.project?.meta?.title || payload.title}`, 'success');
        if (window.vdmDesktop) await window.vdmDesktop.openProject(j.dir);
        else this.toast?.('项目已创建；浏览器模式请重启到该目录', 'info');
      } catch (e) {
        status.textContent = String(e?.message || e);
        create.disabled = false;
        create.textContent = '创建并打开';
      }
    };
    name.focus();
    name.select();
  }

  render(d) {
    const cur = $('#projCurrent');
    if (cur) cur.textContent = d.root ? `当前：${d.root}` : '';
    this.list.innerHTML = '';
    if (!d.projects?.length) {
      this.list.innerHTML = '<div class="hint" style="padding:16px">没有找到项目</div>';
      return;
    }
    for (const p of d.projects) {
      const row = document.createElement('div');
      row.className = `proj-row${p.current ? ' current' : ''}`;
      row.dataset.dir = p.dir;
      row.innerHTML = `
        <div class="pr-title">${escapeHtml(p.title)}${p.current ? '<span class="badge-cam">当前</span>' : ''}${p.camera ? '<span class="badge-cam">3D 相机</span>' : ''}</div>
        <div class="pr-dir">${escapeHtml(p.dir)}</div>
        <div class="pr-meta">rev ${p.rev} · ${p.width}×${p.height} · ${Number(p.duration || 0).toFixed(1)}s</div>`;
      row.onclick = () => this.choose(p);
      this.list.appendChild(row);
    }
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
