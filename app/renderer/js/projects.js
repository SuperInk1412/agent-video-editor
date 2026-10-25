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
