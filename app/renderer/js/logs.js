// Log panel: tail of <project>/.vdm/logs/*.log, live via SSE. Lives in the status-bar log drawer.
import { h, icon } from './ui.js';

const FILTERS = { all: '全部', warn: '警告+', error: '只看错误' };

export class LogPanel {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.rows = [];
    this.filter = 'all';
    this.timer = null;
    this._build();
  }

  _build() {
    this.root.innerHTML = '';
    this.root.classList.add('log-panel');
    this.followBtn = h('button', { class: 'mini on', 'aria-pressed': 'true', 'data-tip': '跟随\n每 2 秒重新读取日志', onclick: () => this._follow() }, '跟随中');
    this.filterBar = h('div', { class: 'seg', role: 'group', 'aria-label': '日志级别' },
      ...Object.keys(FILTERS).map((f) => h('button', {
        class: f === 'all' ? 'on' : '', 'data-f': f, 'aria-pressed': f === 'all' ? 'true' : 'false',
        onclick: () => { this.filter = f; this._paint(); this._syncChips(); },
      }, FILTERS[f])));
    this.root.appendChild(h('div', { class: 'log-toolbar' },
      this.filterBar,
      h('button', { class: 'icon-btn mini', 'aria-label': '刷新', 'data-tip': '刷新', onclick: () => this.refresh(true) }, icon('refresh', 'ic-sm')),
      this.followBtn,
      h('span', { class: 'log-path mono', 'data-tip': '日志目录\n<项目>/.vdm/logs/' }, '.vdm/logs/'),
    ));
    this.list = h('div', { class: 'log-list', role: 'log' });
    this.root.appendChild(this.list);
    this.refresh(true);
  }

  _syncChips() {
    this.filterBar.querySelectorAll('button[data-f]').forEach((b) => {
      const on = b.dataset.f === this.filter;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  _follow() {
    this._following = !this._following;
    clearInterval(this.timer);
    this.timer = this._following ? setInterval(() => this.refresh(), 2000) : null;
    if (this.followBtn) {
      this.followBtn.textContent = this._following ? '跟随中' : '已暂停';
      this.followBtn.classList.toggle('on', !!this._following);
      this.followBtn.setAttribute('aria-pressed', this._following ? 'true' : 'false');
    }
  }

  async refresh(force = false) {
    if (!force && !this._following && this.timer) return;
    try {
      const r = await fetch('/api/logs?lines=300');
      const j = await r.json();
      this.rows = (j.records || []).slice().reverse();
      this._paint();
    } catch (e) {
      this.list.textContent = `读取日志失败: ${e.message}`;
    }
  }

  append(rec) {
    this.rows.unshift(rec);
    if (this.rows.length > 600) this.rows.length = 600;
    this._paint();
  }

  _paint() {
    if (!this.list) return;
    const rows = this.rows.filter((r) => {
      if (this.filter === 'error') return r.level === 'error';
      if (this.filter === 'warn') return r.level === 'error' || r.level === 'warn';
      return true;
    });
    this.list.innerHTML = '';
    if (!rows.length) {
      this.list.appendChild(h('div', { class: 'hint log-empty' }, '暂无日志'));
      return;
    }
    for (const r of rows) {
      const meta = r.meta ? JSON.stringify(r.meta) : '';
      const time = String(r.ts || '').slice(11, 19);
      this.list.appendChild(h('div', { class: `log-entry lv-${r.level}` },
        h('span', { class: 'le-time' }, time),
        h('span', { class: `le-level ${r.level}` }, r.level),
        h('span', { class: 'le-msg' }, r.msg),
        meta ? h('span', { class: 'le-meta' }, meta.slice(0, 300)) : null,
      ));
    }
  }
}
