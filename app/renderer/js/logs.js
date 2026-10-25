// Log panel: tail of <project>/.vdm/logs/*.log, live via SSE.
const h = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

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
    this.root.appendChild(h('div', { class: 'panel-head' },
      h('div', { class: 'panel-title' }, '运行日志'),
      h('div', { class: 'panel-sub' }, '.vdm/logs/'),
    ));
    this.followBtn = h('button', { class: 'chip on', onclick: () => this._follow() }, '跟随中');
    this.filterBar = h('div', { class: 'chips' },
      ...['all', 'warn', 'error'].map((f) => h('button', {
        class: `chip ${f === 'all' ? 'on' : ''}`, 'data-f': f,
        onclick: () => { this.filter = f; this._paint(); this._syncChips(); },
      }, { all: '全部', warn: '警告+', error: '只看错误' }[f])),
      h('button', { class: 'chip', onclick: () => this.refresh(true) }, '刷新'),
      this.followBtn,
    );
    this.root.appendChild(this.filterBar);
    this.list = h('div', { class: 'log-list' });
    this.root.appendChild(this.list);
    this.refresh(true);
  }

  _syncChips() {
    this.filterBar.querySelectorAll('.chip[data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === this.filter));
  }

  _follow() {
    this._following = !this._following;
    clearInterval(this.timer);
    this.timer = this._following ? setInterval(() => this.refresh(), 2000) : null;
    if (this.followBtn) {
      this.followBtn.textContent = this._following ? '跟随中' : '已暂停';
      this.followBtn.classList.toggle('on', !!this._following);
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
      this.list.appendChild(h('div', { class: 'hint' }, '暂无日志'));
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
