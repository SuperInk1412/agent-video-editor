// Change set review panel (docs/DESIGN-WP2.5-REVIEW.md §10.2, WP2.5a).
//
// The 审阅 page is the fourth right-column tab: every change set the engine
// stored as `proposed` lands here (agent, CLI, MCP — the list is read from
// `GET /api/changesets`, not from the AI panel's in-memory map). Accepting a
// change set calls back into main.js, which applies it over the one write path
// as actorId `ui`, so a whole change set is one transaction = one Ctrl+Z.
//
// WP2.5a step 1: the tab, the proposed list and whole-set accept. The
// human-readable change rows, the in-canvas preview and the before/after modal
// build on top of this in the same pack.
import { h, icon } from './ui.js';

const STATUS = { proposed: '待审阅', applied: '已应用', reverted: '已撤回', 'needs-decision': '需决定' };

/** Who proposed it, in words; the raw actorId stays in the hover tooltip. */
function actorLabel(actorId) {
  const id = String(actorId || '');
  if (id === 'ui') return '界面';
  if (id === 'cli' || id === 'local') return '命令行';
  if (id.startsWith('agent:')) return 'AI 助手';
  return id || '未知来源';
}

/** Entries in one record: `summary()` carries counts, `publicRecord()` the arrays. */
function changedCount(record) {
  const c = record?.counts;
  if (c) return (c.changed || 0) + (c.added || 0) + (c.removed || 0);
  return (record?.changed?.length || 0) + (record?.added?.length || 0) + (record?.removed?.length || 0);
}

export class ReviewPanel {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.records = [];   // summaries from GET /api/changesets?status=proposed
    this.error = '';     // last read/accept failure, shown as one --danger line
    this._loading = null;
    this._again = false;
  }

  /** Build the page once; safe to call again after a remount. */
  mount(el = this.root) {
    this.root = el;
    el.classList.add('review-panel');
    el.replaceChildren();
    this.pendingEl = h('span', { class: 'rv-pending', hidden: true });
    this.listEl = h('div', { class: 'rv-list' });
    el.appendChild(h('div', { class: 'rv-head' },
      h('span', { class: 'rv-title' }, '审阅'),
      this.pendingEl,
      this._refreshButton(),
    ));
    el.appendChild(this.listEl);
    this.render();
    return this.refresh();
  }

  _refreshButton() {
    const b = h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': '刷新变更集', 'data-tip': '刷新',
    }, icon('refresh', 'ic-sm'));
    b.addEventListener('click', () => this.refresh());
    return b;
  }

  /** Re-read the list. Re-entrant: a second call while one is in flight runs
   *  once more when it finishes (a changeset can land mid-refresh). */
  refresh() {
    if (this._loading) { this._again = true; return this._loading; }
    this._loading = this._read().finally(() => {
      this._loading = null;
      if (this._again) { this._again = false; this.refresh(); }
    });
    return this._loading;
  }

  async _read() {
    try {
      const r = await fetch('/api/changesets?status=proposed&limit=50');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `${r.status}`);
      this.records = Array.isArray(j.changesets) ? j.changesets : [];
      this.error = '';
    } catch (e) {
      this.error = e.message || '读取变更集失败';
      this.opts.toast?.(`读取变更集失败: ${this.error}`, 'error');
    }
    this.render();
  }

  render() {
    if (!this.listEl) return;
    const pending = this.records.filter((record) => record.status === 'proposed').length;
    this.pendingEl.hidden = pending === 0;
    this.pendingEl.textContent = pending ? `${pending} 个待审阅` : '';
    this.listEl.replaceChildren();
    if (this.error) this.listEl.appendChild(h('div', { class: 'rv-err' }, this.error));
    if (!this.records.length) {
      this.listEl.appendChild(h('div', { class: 'rv-empty' }, '暂无待审阅的变更集'));
      return;
    }
    for (const record of this.records) this.listEl.appendChild(this._row(record));
  }

  _row(record) {
    const total = changedCount(record);
    const intent = record.intent || '（无说明）';
    const status = record.status || 'proposed';
    const accept = h('button', {
      type: 'button', class: 'btn mini rv-act',
      'data-action': 'accept', 'data-id': record.id,
      'data-tip': '整组采纳\n一次撤销可以退回',
    }, '采纳');
    accept.disabled = status !== 'proposed';
    accept.addEventListener('click', () => this.accept(record.id));
    return h('div', { class: 'rv-cs', 'data-id': record.id },
      h('div', {
        class: 'rv-cs-head',
        title: `${record.id}\n${actorLabel(record.actorId)} · ${record.actorId || '未知'}`,
      },
        h('span', { class: 'rv-intent', title: intent }, intent),
        h('span', { class: 'rv-n' }, `${total} 处`),
        h('span', { class: `rv-status ${status}` }, STATUS[status] || status),
        accept,
      ));
  }

  /** Accept one whole change set (one transaction; main.js owns the write). */
  async accept(id) {
    try {
      await this.opts.apply?.(id);
      this.opts.toast?.('已采纳整组（Ctrl+Z 可退回）', 'success');
    } catch (e) {
      this.error = e?.code === 'LOCKED' ? '这个元素已锁定' : (e?.message || '采纳失败');
      this.render();
      this.opts.toast?.(`采纳失败: ${this.error}`, 'error');
    }
    return this.refresh();
  }
}
