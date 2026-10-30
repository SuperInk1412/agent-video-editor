// Change set review panel (docs/DESIGN-WP2.5-REVIEW.md §10.2, WP2.5a).
//
// The 审阅 page is the fourth right-column tab. It reads change sets from the
// engine (`GET /api/changesets`, then one `GET /api/changesets/<id>` per
// expanded record) instead of the AI panel's in-memory map, so a proposal from
// the CLI or MCP shows up exactly like one from the agent.
//
// Everything a person sees is in their own words: changes are grouped by
// element, properties use the contract's Chinese labels (`core/contracts.js`),
// times are frames, and a keyframe move is one merged row. Ids stay in
// `title` tooltips — no `cs_…`, `el_…` or `style.…` in the visible text.
//
// Writes go through main.js (the panel never fetches a write route, DESIGN.md
// §10): apply is one transaction = one Ctrl+Z; a proposed set is discarded with
// `revert` (status only, nothing is written); an applied set is un-applied with
// `revert` / `revert-one`.
//
// `在画面里预览` asks main.js for the shadow project and shows nothing itself;
// the viewport banner, `\` hold-to-compare and the edit lock live there.
import { h, icon } from './ui.js';
import { PROPERTY_PATHS_BY_HOST } from '/core/contracts.js';
import { draftSummary } from '/core/report-draft.js';
import { reportStatusLabel } from './report.js';
import {
  OURS, THEIRS, conflictRows, conflictOps, writableConflicts,
} from './source-conflict.js';

const STATUS = { proposed: '待审阅', applied: '已应用', reverted: '已撤回', 'needs-decision': '需决定' };
const HOST_OF = { element: 'el', camera: 'cam', object: 'ob' };
const TYPE_LABEL = {
  text: '文字', solid: '色块', image: '图片', video: '视频', audio: '声音', code: '代码', empty: '空元素',
};
/** Fields shown as frames, not seconds (§10.2-2). */
const TIME_PATHS = new Set(['start', 'duration', 'fadeIn', 'fadeOut']);
const COMMON_LABEL = {
  size: '字号', color: '颜色', start: '起点', duration: '时长', z: '层级', opacity: '透明度',
  text: '文字内容', font: '字体', weight: '字重', align: '对齐', fill: '填充色', stroke: '描边色',
  visible: '可见', locked: '锁定', volume: '音量', name: '名字', segment: '所属分镜',
};
const KEYFRAME_FIELD = /\.(value|ease|curve|t)$/;

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

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

/** Seconds → 0.5 / 1.17, two decimals at most. */
function formatSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n * 100) / 100;
  return `${rounded}`;
}

/** A value the way the panel prints it: numbers, flags and strings, no JSON. */
function formatValue(value, path = '') {
  if (value === null || value === undefined) return '无';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '—';
  if (typeof value === 'string') return value === '' ? '空' : value;
  if (Array.isArray(value)) return path === 'pivot' || path.endsWith('pivot') ? value.map((v) => formatValue(v)).join(', ') : `${value.length} 项`;
  return `${Object.keys(value).length} 项`;
}

/** Contract label for a property path; a readable fallback for the rest. */
function propertyLabel(kind, path) {
  const host = HOST_OF[kind];
  const rows = (host && PROPERTY_PATHS_BY_HOST[host]) || [];
  const wanted = String(path || '').replace(KEYFRAME_FIELD, '');
  const hit = rows.find((row) => row.path === wanted);
  if (hit) return hit.label;
  const bare = wanted.replace(/^style\./, '').replace(/^transform\./, '').replace(/^node\./, '');
  if (COMMON_LABEL[bare]) return COMMON_LABEL[bare];
  const bareHit = rows.find((row) => row.path === bare);
  if (bareHit) return bareHit.label;
  return bare || '属性';
}

/** The parsed keyframe address inside one changed[] entry, or null. */
function keyframeOf(entry) {
  const match = /^keyframes\[([^\]]+)\]\.(.+)$/.exec(String(entry?.path || ''));
  if (!match) return null;
  const beforeT = Number.isFinite(Number(entry?.before?.t)) ? Number(entry.before.t) : null;
  const afterT = Number.isFinite(Number(entry?.after?.t)) ? Number(entry.after.t) : null;
  return {
    t: Number(match[1]),
    inner: match[2].replace(KEYFRAME_FIELD, ''),
    beforeT,
    afterT,
  };
}

function hostOf(project, kind, id) {
  if (!project) return null;
  if (kind === 'element') return (project.elements || []).find((e) => e.id === id) || null;
  if (kind === 'camera') return (project.cameras || []).find((c) => c.id === id) || null;
  if (kind === 'object') return (project.scene?.objects || []).find((o) => o.id === id) || null;
  if (kind === 'project') return project;
  return null;
}

function typeName(kind, host) {
  if (kind === 'camera') return '相机';
  if (kind === 'object') return '3D 元素';
  return TYPE_LABEL[host?.type] || '元素';
}

/** Human host name; ids never reach the visible text (§10.2-2). */
function hostName(project, kind, id, fallbackHost = null) {
  if (kind === 'project') return '项目设置';
  const host = hostOf(project, kind, id) || fallbackHost;
  if (host?.name) return host.name;
  const list = kind === 'element' ? (project?.elements || [])
    : kind === 'camera' ? (project?.cameras || [])
      : kind === 'object' ? (project?.scene?.objects || []) : [];
  const index = list.findIndex((entry) => entry.id === id);
  return `${typeName(kind, host)} ${index >= 0 ? index + 1 : list.length + 1}`;
}

function leafAt(host, path) {
  if (!host || !path || String(path).startsWith('keyframes[')) return { found: false };
  let cursor = host;
  for (const key of String(path).split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.hasOwn(cursor, key)) return { found: false };
    cursor = cursor[key];
  }
  return { found: true, value: cursor };
}

/** First frame the record touches (start / keyframe times), in frames. */
function firstFrameOf(entries, fps) {
  let min = null;
  for (const entry of entries || []) {
    const kf = keyframeOf(entry);
    const times = [];
    if (kf) times.push(kf.t, kf.beforeT, kf.afterT);
    if (entry.path === 'start') times.push(Number(entry.before), Number(entry.after));
    for (const t of times) if (Number.isFinite(t) && (min === null || t < min)) min = t;
  }
  if (min === null) return null;
  return Math.max(0, Math.round(min * (Number(fps) || 24)));
}

export class ReviewPanel {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.project = null;          // the real project (stale detection reads it)
    this.records = [];            // proposed first, then recent applied/reverted
    this.details = new Map();     // id -> GET /api/changesets/<id>
    this.expanded = new Set();    // ids whose change rows are open
    this.unchecked = new Map();   // id -> Set of row keys the user unchecked
                                  // (everything fresh is checked by default)
    this.kfOpen = new Set();      // `id:kf` merged keyframe rows that are open
    this.conflictChoices = new Map(); // id -> Map(index -> 'ours' | 'theirs'), default 保留我的
    this.activeId = null;         // the change set the bottom bar acts on
    this.error = '';              // one --danger line at the panel bottom
    this.errorRetry = null;       // id an apply may retry (LOCKED)
    this._loading = null;
    this._again = false;
    this._cmp = null;             // { el, close }
    this._detailLoads = new Map();
    // 报告 section (WP2.5c, §10.4-8): what a human reported, read from
    // `/api/reports`. `remeasured` remembers which rows already show a verdict.
    this.reports = [];
    this.reportError = '';
    this.remeasured = new Set();
    this._remeasuring = new Set();
  }

  /** Build the page once; safe to call again after a remount. */
  mount(el = this.root) {
    this.root = el;
    el.classList.add('review-panel');
    el.replaceChildren();
    this.pendingEl = h('span', { class: 'rv-pending', hidden: true });
    this.listEl = h('div', { class: 'rv-list' });
    this.footEl = h('div', { class: 'rv-foot' });
    el.appendChild(h('div', { class: 'rv-head' },
      h('span', { class: 'rv-title' }, '审阅'), this.pendingEl, this._refreshButton()));
    el.appendChild(this.listEl);
    el.appendChild(this.footEl);
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

  /** The real project changed (SSE `project`): recompute "过期" from it. */
  setProject(project) {
    this.project = project;
    this.render();
  }

  /** Re-read both lists. Re-entrant: a second call runs once more at the end. */
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
      const [proposed, recent] = await Promise.all([
        this._get('/api/changesets?status=proposed&limit=50'),
        this._get('/api/changesets?limit=20'),
      ]);
      const seen = new Set();
      const records = [];
      for (const record of [...(proposed.changesets || []), ...(recent.changesets || [])]) {
        if (!record?.id || seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }
      // One record the panel does not know any more is dropped; a cached detail
      // whose status moved (applied → reverted) is dropped too, so the footer
      // never explains a state that no longer exists.
      this.details.forEach((detail, id) => {
        const record = records.find((entry) => entry.id === id);
        if (!record || (detail.status && detail.status !== record.status)) this.details.delete(id);
      });
      this.records = records;
      if (!this.records.some((record) => record.id === this.activeId)) {
        this.activeId = this.records.find((record) => record.status === 'proposed')?.id
          || this.records[0]?.id || null;
      }
      this.error = '';
      this.errorRetry = null;
      // Expand the first pending set once, lazily; its rows load below.
      const first = this.records.find((record) => record.status === 'proposed');
      if (first && !this._autoExpanded) { this._autoExpanded = true; this.expanded.add(first.id); }
    } catch (e) {
      this.error = e.message || '读取变更集失败';
      this.opts.toast?.(`读取变更集失败: ${this.error}`, 'error');
    }
    // 报告 is a separate list: a failure there must never blank the change sets
    // (an engine without WP2.5c simply has no reports).
    try {
      const payload = await this._get('/api/reports?limit=20');
      this.reports = Array.isArray(payload.reports) ? payload.reports : [];
      this.reportError = '';
    } catch (e) {
      this.reportError = e.message || '读取报告失败';
    }
    this.render();
    // Load the detail of every expanded record, plus the active one (the footer
    // counts its rows even while it is collapsed).
    const pending = this.records.filter((record) => record.status === 'proposed'
      && (this.expanded.has(record.id) || record.id === this.activeId));
    for (const record of pending) await this.ensureDetail(record.id);
    this.render();
  }

  async _get(url) {
    const response = await fetch(url);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.error || `${response.status}`);
      error.code = json.code;
      throw error;
    }
    return json;
  }

  /** Fetch (and cache) one record's change rows. */
  ensureDetail(id) {
    if (!id) return Promise.resolve(null);
    const cached = this.details.get(id);
    const record = this.records.find((entry) => entry.id === id);
    if (cached && (!record || cached.status === record.status)) return Promise.resolve(cached);
    if (this._detailLoads.has(id)) return this._detailLoads.get(id);
    const load = this._get(`/api/changesets/${encodeURIComponent(id)}?limit=100`)
      .then((json) => {
        if (json.changeset) this.details.set(id, json.changeset);
        return json.changeset || null;
      })
      .catch((e) => {
        this.error = e.message || '读取变更详情失败';
        this.opts.toast?.(`读取变更详情失败: ${this.error}`, 'error');
        return null;
      })
      .finally(() => this._detailLoads.delete(id));
    this._detailLoads.set(id, load);
    return load;
  }

  // ---------------------------------------------------------------- model
  /** One record's rows: element groups, merged keyframe rows, host adds. */
  model(detail) {
    if (!detail) return [];
    const groups = new Map();
    const group = (kind, id) => {
      const key = `${kind}:${id ?? ''}`;
      if (!groups.has(key)) groups.set(key, { kind, id, rows: [] });
      return groups.get(key);
    };
    const changed = Array.isArray(detail.changed) ? detail.changed : [];
    const offset = changed.length; // `added` entries follow changed[] in revertEntries
    const kfByHost = new Map();
    changed.forEach((entry, index) => {
      const kf = keyframeOf(entry);
      if (!kf) {
        group(entry.kind || 'element', entry.id).rows.push({ kind: 'entry', entry, index, key: `c${index}` });
        return;
      }
      const hostKey = `${entry.kind || 'element'}:${entry.id || ''}`;
      if (!kfByHost.has(hostKey)) kfByHost.set(hostKey, { kind: 'kf', id: entry.id, kindOf: entry.kind || 'element', entries: [], key: `kf:${hostKey}` });
      kfByHost.get(hostKey).entries.push({ entry, index, kf });
    });
    for (const merged of kfByHost.values()) {
      merged.count = merged.entries.length;
      merged.delta = this._keyframeDelta(merged.entries);
      group(merged.kindOf, merged.id).rows.push(merged);
    }
    (detail.added || []).forEach((entry, i) => {
      group(entry.kind || 'element', entry.id).rows.push({
        kind: 'host', change: 'added', entry, index: offset + i, key: `a${i}`,
        object: entry.object || null,
      });
    });
    (detail.removed || []).forEach((entry, i) => {
      group(entry.kind || 'element', entry.id).rows.push({
        kind: 'host', change: 'removed', entry, index: offset + i, key: `r${i}`,
        object: entry.object || null,
      });
    });
    return [...groups.values()];
  }

  /** The shared time shift of a merged keyframe row, in seconds (or null). */
  _keyframeDelta(entries) {
    const deltas = [];
    const used = new Set();
    for (const { entry } of entries) {
      if (entry.change === 'modified' && entry.before && entry.after) {
        const d = Number(entry.after.t) - Number(entry.before.t);
        if (Number.isFinite(d)) deltas.push(d);
      }
    }
    if (!deltas.length) {
      const removed = entries.filter(({ entry }) => entry.change === 'removed' && Number.isFinite(Number(entry.before?.t)));
      const added = entries.filter(({ entry }) => entry.change === 'added' && Number.isFinite(Number(entry.after?.t)));
      for (const r of removed) {
        const inner = keyframeOf(r.entry)?.inner;
        const a = added.find((candidate) => !used.has(candidate.entry) && keyframeOf(candidate.entry)?.inner === inner);
        if (!a) continue;
        used.add(a.entry);
        deltas.push(Number(a.entry.after.t) - Number(r.entry.before.t));
      }
    }
    if (!deltas.length) return null;
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    return Math.abs(median) < 0.0005 ? null : median;
  }

  /**
   * Row state: `fresh` (safe to apply), `stale` (the human changed this
   * property after the proposal), `decide` (an applied change conflicts with
   * what is in the project now), or `host` (whole element added/removed).
   */
  _rowState(detail, row) {
    if (row.kind === 'host') return 'host';
    if (detail.status === 'needs-decision') return 'decide';
    if (detail.status !== 'proposed') return 'applied';
    const project = this.project || this.opts.getProject?.();
    if (!project) return 'fresh';
    if (row.kind === 'kf') {
      for (const { entry } of row.entries) {
        const state = this._entryState(project, entry, true);
        if (state !== 'fresh') return state;
      }
      return 'fresh';
    }
    return this._entryState(project, row.entry, false);
  }

  _entryState(project, entry, isKeyframe) {
    if (isKeyframe || entry.change !== 'modified') return 'fresh';
    if (String(entry.path || '').startsWith('keyframes[')) return 'fresh';
    const host = hostOf(project, entry.kind, entry.id);
    const current = leafAt(host, entry.path);
    const value = current.found ? current.value : null;
    if (same(value, entry.before)) return 'fresh';
    return 'stale';
  }

  _currentValue(entry) {
    const project = this.project || this.opts.getProject?.();
    const host = hostOf(project, entry.kind, entry.id);
    const current = leafAt(host, entry.path);
    return current.found ? current.value : null;
  }

  // ---------------------------------------------------------------- render
  render() {
    if (!this.listEl) return;
    const pending = this.records.filter((record) => record.status === 'proposed').length;
    this.pendingEl.hidden = pending === 0;
    this.pendingEl.textContent = pending ? `${pending} 个待审阅` : '';
    this._tabDot(pending);
    this.listEl.replaceChildren();
    if (this.error) {
      const line = h('div', { class: 'rv-err' }, this.error);
      if (this.errorRetry) {
        const retry = h('button', { type: 'button', class: 'btn mini', 'data-action': 'retry-apply' }, '以人的身份采纳');
        retry.addEventListener('click', () => this.apply(this.errorRetry, { retry: true }));
        line.appendChild(retry);
      }
      this.listEl.appendChild(line);
    }
    if (!this.records.length) {
      this.listEl.appendChild(h('div', { class: 'rv-empty' }, '暂无待审阅的变更集'));
      this.listEl.appendChild(this._reportsSection());
      this._renderFoot();
      return;
    }
    for (const record of this.records) this.listEl.appendChild(this._recordRow(record));
    this.listEl.appendChild(this._reportsSection());
    this._renderFoot();
  }

  /** The 8px `--warn` dot on the tab; never switches pages by itself. */
  _tabDot(pending) {
    if (!this.dotEl) {
      this.dotEl = document.querySelector('[data-tabs="right"] [data-tab="review"] .tab-dot');
    }
    if (this.dotEl) this.dotEl.hidden = pending === 0;
  }

  _recordRow(record) {
    const detail = this.details.get(record.id) || null;
    const status = record.status || 'proposed';
    const open = this.expanded.has(record.id);
    const intent = record.intent || '（无说明）';
    const exp = h('button', {
      type: 'button', class: 'rv-exp', 'aria-expanded': open ? 'true' : 'false',
      'aria-label': open ? '收起改动' : '展开改动', 'data-action': 'expand', 'data-id': record.id,
    }, icon(open ? 'chevron-down' : 'chevron-right', 'ic-sm'));
    exp.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(record.id); });
    const head = h('div', {
      class: 'rv-cs-head',
      title: `${record.id}\n${actorLabel(record.actorId)} · ${record.actorId || '未知'}`,
    },
      exp,
      h('span', { class: 'rv-intent', title: intent }, intent),
      h('span', { class: 'rv-src', title: record.actorId || '' }, actorLabel(record.actorId)),
      h('span', { class: 'rv-n' }, `${changedCount(record)} 处`),
      h('span', { class: `rv-status ${status}` }, STATUS[status] || status),
    );
    head.addEventListener('click', () => this.toggle(record.id));
    const body = open ? this._recordBody(record, detail) : null;
    return h('div', { class: `rv-cs${open ? ' open' : ''}`, 'data-id': record.id }, head, body);
  }

  _recordBody(record, detail) {
    const body = h('div', { class: 'rv-body' });
    const status = record.status || 'proposed';
    const tools = h('div', { class: 'rv-tools' });
    if (status === 'proposed') {
      const previewing = this.opts.previewId?.() === record.id;
      const button = h('button', {
        type: 'button', class: `btn mini${previewing ? ' on' : ''}`, 'data-action': 'preview', 'data-id': record.id,
        'data-tip': '在画面里预览\n不写盘、不占 rev；按住 \\ 看修改前',
      }, previewing ? '预览中' : '在画面里预览');
      button.addEventListener('click', () => this.togglePreview(record));
      tools.appendChild(button);
    }
    if (this.opts.isPreviewing?.()) {
      const cmp = h('button', { type: 'button', class: 'btn mini', 'data-action': 'compare-inline' }, '对比');
      cmp.addEventListener('click', () => this.openCompare(record));
      tools.appendChild(cmp);
    }
    if (tools.childElementCount) body.appendChild(tools);
    if (!detail) {
      body.appendChild(h('div', { class: 'rv-loading' }, '读取改动…'));
      return body;
    }
    // 源冲突 (§7.3 R1): a merge's conflicts live here, not in a modal.
    if (Array.isArray(detail.merge?.conflicts) && detail.merge.conflicts.length) {
      body.appendChild(this._conflictSection(record, detail));
    }
    if (!changedCount(detail)) {
      body.appendChild(h('div', { class: 'rv-empty' }, '这组改动没有属性差异'));
      return body;
    }
    for (const group of this.model(detail)) body.appendChild(this._group(record, detail, group));
    return body;
  }

  _group(record, detail, group) {
    const project = this.project || this.opts.getProject?.();
    const name = hostName(project, group.kind, group.id);
    const head = h('div', {
      class: 'rv-grp-head',
      title: group.id ? `${group.id}` : '',
    },
      h('span', { class: 'rv-grp-name' }, name),
      h('span', { class: 'rv-grp-n' }, `${group.rows.length} 处`),
    );
    const rows = group.rows.map((row) => this._row(record, detail, row));
    return h('div', { class: 'rv-grp' }, head, ...rows);
  }

  _row(record, detail, row) {
    if (row.kind === 'kf') return this._kfRow(record, detail, row);
    if (row.kind === 'host') return this._hostRow(detail, row);
    return this._entryRow(record, detail, row);
  }

  /** Checkbox + label + before → after + hover actions. */
  _entryRow(record, detail, row) {
    const entry = row.entry || {};
    const state = this._rowState(detail, row);
    const label = propertyLabel(entry.kind, entry.path);
    const node = h('div', { class: 'rv-row', 'data-key': row.key, 'data-index': row.index, 'data-state': state, title: entry.path || '' });
    const check = this._checkbox(detail, row, state);
    node.appendChild(check);
    const main = h('div', { class: 'rv-main' });
    main.appendChild(h('span', { class: 'rv-label' }, label));
    if (state === 'stale') {
      const current = formatValue(this._currentValue(entry));
      main.appendChild(h('span', { class: 'rv-note warn' }, `你之后改过这里（现在 ${current}）`));
    } else if (state === 'decide') {
      main.appendChild(this._values(entry));
      main.appendChild(h('span', { class: 'rv-note warn' }, `当前 ${formatValue(this._currentValue(entry))}`));
    } else {
      main.appendChild(this._values(entry));
    }
    node.appendChild(main);
    node.appendChild(this._rowActions(record, detail, row, state));
    main.addEventListener('click', () => this.jump(record, detail, row));
    return node;
  }

  _values(entry) {
    const kind = entry.kind;
    const path = String(entry.path || '');
    const isTime = TIME_PATHS.has(path.replace(KEYFRAME_FIELD, ''));
    const fps = Number(this.opts.getFps?.()) || 24;
    const show = (value) => {
      if (!isTime) return formatValue(value, path);
      const n = Number(value);
      return Number.isFinite(n) ? `f${Math.round(n * fps)}` : '—';
    };
    const wrap = h('span', { class: 'rv-vals' });
    if (entry.change === 'added') {
      wrap.appendChild(h('span', { class: 'rv-add' }, `新增 ${show(entry.after)}`));
    } else if (entry.change === 'removed') {
      wrap.appendChild(h('span', { class: 'rv-del' }, `删除 ${show(entry.before)}`));
    } else {
      wrap.appendChild(h('s', { class: 'rv-before' }, show(entry.before)));
      wrap.appendChild(h('span', { class: 'rv-arrow', 'aria-hidden': 'true' }, '→'));
      wrap.appendChild(h('span', { class: 'rv-after' }, show(entry.after)));
    }
    return wrap;
  }

  /** Checked by default; only an explicit uncheck is remembered. */
  _isChecked(detail, row, state) {
    if ((detail.status || 'proposed') !== 'proposed' || state !== 'fresh') return false;
    const off = this.unchecked.get(detail.id);
    return !(off && off.has(row.key));
  }

  /** Row keys the footer counts for one record. */
  _checkedRows(detail) {
    const out = [];
    if (!detail || (detail.status || 'proposed') !== 'proposed') return out;
    for (const group of this.model(detail)) {
      for (const row of group.rows) {
        if (row.kind === 'host') continue;
        const state = this._rowState(detail, row);
        if (this._isChecked(detail, row, state)) out.push(row.key);
      }
    }
    return out;
  }

  _checkbox(detail, row, state) {
    const id = detail.id;
    const proposed = (detail.status || 'proposed') === 'proposed';
    const box = h('input', { type: 'checkbox', class: 'rv-check', 'aria-label': '采纳这一处' });
    box.checked = this._isChecked(detail, row, state);
    box.disabled = !proposed || state !== 'fresh';
    box.addEventListener('change', () => {
      let off = this.unchecked.get(id);
      if (!off) { off = new Set(); this.unchecked.set(id, off); }
      if (box.checked) off.delete(row.key); else off.add(row.key);
      this.activeId = id;
      this._renderFoot();
    });
    return box;
  }

  _rowActions(record, detail, row, state) {
    const wrap = h('div', { class: `rv-row-act${state === 'fresh' || state === 'applied' ? '' : ' always'}` });
    const status = detail.status || 'proposed';
    // A merge's rows are the merge's own diff; its conflicts are decided in the
    // conflict section (§7.3 R1), so 保留现在的值 / 用 AI 的值 would undo the
    // wrong thing here.
    if (Array.isArray(detail.merge?.conflicts) && detail.merge.conflicts.length) return wrap;
    const button = (label, action, run, extra = {}) => {
      const b = h('button', { type: 'button', class: 'rv-link', 'data-action': action, ...extra }, label);
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      wrap.appendChild(b);
      return b;
    };
    if (state === 'stale') {
      button('仍然采纳', 'still-accept', () => this.apply(detail.id, { retry: true }), { 'data-tip': '整组采纳\n一次撤销可以退回' });
      button('让 AI 重新做', 'redo', () => this.retryAI(record, detail));
      return wrap;
    }
    if (state === 'decide') {
      const current = formatValue(this._currentValue(row.entry));
      const ai = formatValue(row.entry?.after);
      button(`保留现在的值（${current}）`, 'keep-current', () => this.discard(detail.id), { 'data-tip': '撤回 AI 的改动，保留现在的值' });
      button(`用 AI 的值（${ai}）`, 'use-ai', () => this.apply(detail.id), { 'data-tip': '整组采纳 AI 的值' });
      return wrap;
    }
    if (status === 'proposed') {
      button('采纳', 'row-accept', () => this.apply(detail.id), { 'data-tip': '整组采纳\n一次撤销可以退回' });
      button('不要', 'row-discard', () => this.discard(detail.id), { 'data-tip': '整组不要\n只是丢掉提议，不写项目' });
    } else if (status === 'applied') {
      button('撤回', 'row-revert', () => this.revertRow(detail.id, row), { 'data-tip': '只撤回这一处' });
    }
    return wrap;
  }

  /** Merged keyframe row: `关键帧 12 条（+0.5s）`, details on demand. */
  _kfRow(record, detail, merged) {
    const state = this._rowState(detail, merged);
    const openKey = `${detail.id}:${merged.key}`;
    const open = this.kfOpen.has(openKey);
    const delta = merged.delta === null ? '' : `（${merged.delta > 0 ? '+' : ''}${formatSeconds(merged.delta)}s）`;
    const node = h('div', { class: 'rv-row rv-kf', 'data-key': merged.key, 'data-state': state, title: '这一组关键帧' });
    node.appendChild(this._checkbox(detail, merged, state));
    const main = h('div', { class: 'rv-main' });
    const toggle = h('button', {
      type: 'button', class: 'rv-kf-toggle', 'aria-expanded': open ? 'true' : 'false', 'data-action': 'kf-toggle',
    }, icon(open ? 'chevron-down' : 'chevron-right', 'ic-sm'), `关键帧 ${merged.count} 条${delta}`);
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.activeId = detail.id;
      if (open) this.kfOpen.delete(openKey); else this.kfOpen.add(openKey);
      this.render();
    });
    main.appendChild(toggle);
    node.appendChild(main);
    node.appendChild(this._rowActions(record, detail, { ...merged, entry: merged.entries[0]?.entry }, state));
    const list = open ? h('div', { class: 'rv-kf-list' }, ...merged.entries.map(({ entry, kf }) => {
      const label = propertyLabel(entry.kind, kf.inner);
      const fps = Number(this.opts.getFps?.()) || 24;
      const beforeT = kf.beforeT ?? kf.t;
      const afterT = kf.afterT ?? kf.t;
      const times = beforeT === afterT
        ? `f${Math.round(kf.t * fps)}`
        : `f${Math.round(beforeT * fps)} → f${Math.round(afterT * fps)}`;
      let value = '';
      if (entry.change === 'added') value = `新增 ${formatValue(entry.after?.value ?? entry.after)}`;
      else if (entry.change === 'removed') value = `删除 ${formatValue(entry.before?.value ?? entry.before)}`;
      else if (entry.before?.value !== undefined || entry.after?.value !== undefined) {
        value = `${formatValue(entry.before?.value)} → ${formatValue(entry.after?.value)}`;
      }
      return h('div', { class: 'rv-kf-line' },
        h('span', { class: 'rv-kf-name' }, label),
        h('span', { class: 'rv-kf-time' }, times),
        value ? h('span', { class: 'rv-kf-val' }, value) : null,
      );
    })) : null;
    return h('div', { class: 'rv-kf-wrap' }, node, list);
  }

  _hostRow(detail, row) {
    const host = row.object || {};
    const name = host.name || `${typeName(row.entry.kind, host)}`;
    const status = detail.status || 'proposed';
    const node = h('div', { class: 'rv-row rv-host', 'data-key': row.key, 'data-state': 'host' });
    node.appendChild(h('span', { class: 'rv-check-slot', 'aria-hidden': 'true' }));
    node.appendChild(h('div', { class: 'rv-main' },
      h('span', { class: 'rv-label' }, name),
      h('span', { class: 'rv-note' }, row.change === 'added' ? '新增' : '删除'),
    ));
    const actions = h('div', { class: 'rv-row-act' });
    if (status === 'proposed') {
      const accept = h('button', { type: 'button', class: 'rv-link', 'data-action': 'row-accept' }, '采纳');
      accept.addEventListener('click', () => this.apply(detail.id));
      const discard = h('button', { type: 'button', class: 'rv-link', 'data-action': 'row-discard' }, '不要');
      discard.addEventListener('click', () => this.discard(detail.id));
      actions.append(accept, discard);
    } else if (status === 'applied') {
      const undo = h('button', { type: 'button', class: 'rv-link', 'data-action': 'row-revert' }, '撤回');
      undo.addEventListener('click', () => this.revertRow(detail.id, row));
      actions.appendChild(undo);
    }
    if (actions.childElementCount) node.appendChild(actions);
    return node;
  }

  // ---------------------------------------------------------------- 源冲突 (WP4.6b)
  /**
   * §7.3 R1: conflicts are `needs-decision` rows, not a modal. One row per
   * `merge.conflicts` entry with base / ours / theirs, the kind, and the intent
   * of the update that caused it; the radio pair is the decision, default
   * 保留我的. Closing the panel decides nothing — the record stays here.
   */
  _conflictSection(record, detail) {
    const project = this.project || this.opts.getProject?.();
    const merge = detail.merge;
    const rows = conflictRows(merge, project);
    const intent = record.intent || detail.intent || '';
    const section = h('section', { class: 'rv-conflicts', 'data-section': 'conflicts' });
    section.appendChild(h('div', { class: 'rv-cf-head' },
      h('span', { class: 'rv-cf-title' }, `源冲突 ${rows.length} 处`),
      h('span', { class: 'rv-cf-hint' }, '默认保留我的 · 关掉不处理也留在待决定'),
    ));
    for (const row of rows) section.appendChild(this._conflictRow(detail, row, intent));
    return section;
  }

  _conflictRow(detail, row, intent) {
    const conflict = row.conflict || {};
    const project = this.project || this.opts.getProject?.();
    const decided = (detail.status || '') !== 'needs-decision';
    const choice = this.conflictChoice(detail, row.index);
    const node = h('div', {
      class: 'rv-cf', 'data-index': row.index, 'data-kind': conflict.kind || 'conflict',
      'data-choice': choice, title: conflict.path || '',
    });
    const head = h('div', { class: 'rv-cf-line' },
      h('span', { class: 'rv-cf-where' }, `节点 ${conflict.nodeId || '—'} · ${row.pathLabel}`),
      h('span', { class: 'rv-cf-kind' }, row.kindLabel),
    );
    const group = h('div', { class: 'rv-cf-choice', role: 'radiogroup', 'aria-label': '这一处冲突怎么办' });
    for (const [value, label] of [[OURS, '保留我的'], [THEIRS, '用源的']]) {
      const input = h('input', {
        type: 'radio', class: 'rv-cf-radio', name: `cf:${detail.id}:${row.index}`,
        value, 'data-action': `cf-${value}`,
      });
      input.checked = choice === value;
      input.disabled = decided;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.setConflictChoice(detail, row.index, value);
      });
      group.appendChild(h('label', { class: 'rv-cf-opt' }, input, h('span', {}, label)));
    }
    head.appendChild(group);
    node.appendChild(head);
    node.appendChild(h('div', { class: 'rv-cf-sides' },
      this._conflictSide('原来的', row.base),
      this._conflictSide('我的', row.ours, choice === OURS),
      this._conflictSide('源里的', row.theirs, choice === THEIRS),
    ));
    const name = row.element ? hostName(project, 'element', row.element.id) : '元素已不在工程里';
    node.appendChild(h('div', { class: 'rv-cf-meta' },
      h('span', { class: 'rv-cf-el' }, name),
      h('span', { class: 'rv-cf-intent', title: intent }, `这次源更新：${intent || '（无说明）'}`),
    ));
    return node;
  }

  _conflictSide(label, value, picked = false) {
    return h('div', { class: `rv-cf-side${picked ? ' picked' : ''}` },
      h('span', { class: 'rv-cf-key' }, label),
      h('span', { class: 'rv-cf-val', title: value }, value),
    );
  }

  /**
   * One conflict's decision: the click the user made in this session, else the
   * decision stored on the record (`merge.decisions`, so an applied merge shows
   * what was chosen), else the §7.3 R1 default 保留我的.
   */
  conflictChoice(detail, index) {
    const picked = this.conflictChoices.get(detail?.id)?.get(index);
    if (picked) return picked === THEIRS ? THEIRS : OURS;
    const stored = Array.isArray(detail?.merge?.decisions)
      ? detail.merge.decisions.find((entry) => entry?.index === index) : null;
    return stored?.choice === THEIRS ? THEIRS : OURS;
  }

  setConflictChoice(detail, index, choice) {
    if (!detail?.id) return;
    let map = this.conflictChoices.get(detail.id);
    if (!map) { map = new Map(); this.conflictChoices.set(detail.id, map); }
    map.set(index, choice === THEIRS ? THEIRS : OURS);
    this.activeId = detail.id;
    this._renderFoot();
  }

  setAllConflicts(detail, choice) {
    if (!detail?.id) return;
    let map = this.conflictChoices.get(detail.id);
    if (!map) { map = new Map(); this.conflictChoices.set(detail.id, map); }
    const count = (detail.merge?.conflicts || []).length;
    for (let index = 0; index < count; index += 1) map.set(index, choice === THEIRS ? THEIRS : OURS);
    this.activeId = detail.id;
    this.render();
  }

  /**
   * 应用: the chosen sides written as one transaction through main.js
   * (`ChangeSetService.decide`), so one Ctrl+Z is back to the provisional
   * `theirs` state. The merge record leaves `needs-decision`.
   */
  async applyConflicts(record, detail) {
    if (!record?.id || !detail?.merge) return null;
    if (this._busy) return null;
    const project = this.project || this.opts.getProject?.();
    const conflicts = detail.merge.conflicts || [];
    const choices = conflicts.map((_, index) => this.conflictChoice(detail, index));
    const { ops, decisions, skipped } = conflictOps(project, detail.merge, choices);
    this._busy = true;
    this.render();
    let result = null;
    try {
      result = await this.opts.decide?.(detail.id, ops, decisions);
      this.error = '';
      const applied = decisions.length - skipped;
      this.opts.toast?.(skipped
        ? `已应用 ${applied} 处（${skipped} 处的元素已不在工程里）`
        : `已按你的选择应用 ${applied} 处（Ctrl+Z 可退回）`, 'success');
      this.conflictChoices.delete(detail.id);
      this.details.delete(detail.id);
      this.expanded.delete(detail.id);
      this.activeId = null;
    } catch (e) {
      this.error = e?.message || '应用冲突失败';
      this.opts.toast?.(`应用冲突失败: ${this.error}`, 'error');
    } finally {
      this._busy = false;
    }
    await this.refresh();
    return result;
  }

  // ---------------------------------------------------------------- footer
  _renderFoot() {
    if (!this.footEl) return;
    const record = this.records.find((entry) => entry.id === this.activeId) || null;
    const detail = record ? this.details.get(record.id) : null;
    const status = record?.status || null;
    // §7.3 R1: a merge waiting for a human gets its own action bar — the
    // 采纳/不要 buttons of a proposal mean nothing for it.
    if (status === 'needs-decision' && Array.isArray(detail?.merge?.conflicts) && detail.merge.conflicts.length) {
      this.footEl.replaceChildren(...this._conflictFoot(record, detail));
      return;
    }
    const checkedCount = this._checkedRows(detail).length;
    const stale = detail && status === 'proposed' ? this._staleCount(detail) : 0;
    const pending = this._busy ? 0 : 1;
    const disabled = !record || !pending || status !== 'proposed';
    const acceptSelected = h('button', {
      type: 'button', class: 'btn primary', 'data-action': 'accept-selected',
      'data-tip': '采纳整组\n一次撤销可以退回',
    }, `采纳选中 (${checkedCount})`);
    acceptSelected.disabled = disabled || checkedCount === 0;
    acceptSelected.addEventListener('click', () => this.apply(record?.id));
    const acceptAll = h('button', {
      type: 'button', class: 'btn', 'data-action': 'accept-all', 'data-tip': '采纳整组\n一次撤销可以退回',
    }, '全部采纳');
    // Deliberately not disabled when a row is stale: a disabled button explains
    // nothing (DESIGN.md §6). `apply()` refuses and puts the reason in the
    // panel; `仍然采纳` on the row is the explicit override.
    acceptAll.disabled = disabled;
    acceptAll.addEventListener('click', () => this.apply(record?.id));
    const rejectAll = h('button', { type: 'button', class: 'btn', 'data-action': 'reject-all' }, '全部不要');
    rejectAll.disabled = !record || !pending || status === 'reverted';
    rejectAll.addEventListener('click', () => this.discard(record?.id));
    const compare = h('button', {
      type: 'button', class: 'btn', 'data-action': 'compare',
      'data-tip': this.opts.isPreviewing?.() ? '对比修改前后' : '先在变更集上打开「在画面里预览」',
    }, '对比');
    compare.disabled = !this.opts.isPreviewing?.();
    compare.addEventListener('click', () => this.openCompare(record));
    const parts = [h('div', { class: 'rv-foot-row' }, acceptSelected, acceptAll, rejectAll, compare)];
    if (stale > 0) parts.push(h('div', { class: 'rv-foot-note' }, `这组有 ${stale} 处你在提议之后改过，逐条确认后才能整组采纳`));
    this.footEl.replaceChildren(...parts);
  }

  _staleCount(detail) {
    let n = 0;
    for (const group of this.model(detail)) {
      for (const row of group.rows) if (this._rowState(detail, row) === 'stale') n += 1;
    }
    return n;
  }

  /** The merge record's action bar: 全部保留我的 / 全部用源的 / 应用 (§7.3 R1). */
  _conflictFoot(record, detail) {
    const project = this.project || this.opts.getProject?.();
    const merge = detail.merge;
    const rows = conflictRows(merge, project);
    const writable = writableConflicts(merge, project);
    const button = (label, action, run, extra = {}) => {
      const b = h('button', { type: 'button', class: `btn${extra.primary ? ' primary' : ''}`, 'data-action': action, ...(extra.tip ? { 'data-tip': extra.tip } : {}) }, label);
      b.disabled = extra.disabled === true;
      b.addEventListener('click', run);
      return b;
    };
    const keepAll = button('全部保留我的', 'cf-all-ours', () => this.setAllConflicts(detail, OURS), {
      tip: '每一处都用编辑器里的值\n一次撤销可以退回',
    });
    const useAll = button('全部用源的', 'cf-all-theirs', () => this.setAllConflicts(detail, THEIRS), {
      tip: '每一处都用这次源更新给的值',
    });
    const apply = button(`应用 (${writable})`, 'cf-apply', () => this.applyConflicts(record, detail), {
      primary: true, disabled: this._busy || writable === 0,
      tip: '按上面的选择写一次事务\n一次 Ctrl+Z 回到现在的画面',
    });
    const parts = [h('div', { class: 'rv-foot-row' }, keepAll, useAll, apply)];
    const missing = rows.length - writable;
    parts.push(h('div', { class: 'rv-foot-note' },
      `这组源更新有 ${rows.length} 处冲突：默认保留我的；关掉不处理也留在待决定`
      + (missing ? `（${missing} 处的元素已不在工程里）` : '')));
    return parts;
  }

  // ---------------------------------------------------------------- 报告 (WP2.5c)
  /** The section under the change sets (§10.4-8): every report + its verdict. */
  _reportsSection() {
    const section = h('section', { class: 'rv-reports', 'data-section': 'reports' });
    section.appendChild(h('div', { class: 'rv-reports-head' },
      h('span', { class: 'rv-reports-title' }, '报告'),
      h('span', { class: 'rv-reports-n' }, this.reports.length ? `${this.reports.length} 条` : ''),
    ));
    if (this.reportError) section.appendChild(h('div', { class: 'rv-err' }, this.reportError));
    if (!this.reports.length) {
      section.appendChild(h('div', { class: 'rv-empty' }, '还没有报告：选中对象后按 Shift+R，记一句哪里不对'));
      return section;
    }
    for (const report of this.reports) section.appendChild(this._reportRow(report));
    return section;
  }

  _reportRow(report) {
    const status = report.status || 'open';
    // §10.4-8 line: the frame it was written at, the words, the attachment
    // count — "报告 f150 · 闪烁 · 2 个附件".
    const line = `报告 f${Number(report.frame) || 0} · ${draftSummary(report).subtitle}`;
    const main = h('button', {
      type: 'button', class: 'rv-report-main', 'data-action': 'open-report',
      title: report.id || '', 'data-report-id': report.id || '',
    }, h('span', { class: 'rv-report-line' }, line));
    const note = this._reportNote(report);
    if (note) main.appendChild(h('span', { class: 'rv-report-note' }, note));
    main.addEventListener('click', () => this.opts.openReport?.(report));
    const measure = h('button', {
      type: 'button', class: 'rv-link', 'data-action': 'remeasure-report',
      'data-tip': '在同一组附件上重跑同一组测量',
    }, this._remeasuring.has(report.id) ? '测量中…' : '重新测量');
    measure.disabled = this._remeasuring.has(report.id);
    measure.addEventListener('click', (e) => { e.stopPropagation(); this.remeasure(report.id); });
    const row = h('div', {
      class: 'rv-report', 'data-report-id': report.id || '', 'data-status': status, title: report.id || '',
    },
      main,
      h('span', { class: `rv-status ${status}` }, reportStatusLabel(status)),
      measure,
    );
    // Padding / status clicks open the report too; the buttons keep their own.
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      this.opts.openReport?.(report);
    });
    return row;
  }

  /** The verdict line: only after a re-measure, and only when it adds a number
   *  the status badge does not already say (a verified row just turns green). */
  _reportNote(report) {
    if (!this.remeasured.has(report.id) && report.status !== 'verified') return '';
    const verification = report.verification || {};
    const failed = (verification.failed || []).length;
    const pending = (verification.pending || []).length;
    if (report.status === 'verified' || verification.status === 'verified') return '';
    if (failed) return `仍有 ${failed} 项未通过`;
    if (pending) return `还有 ${pending} 项要等后台`;
    return '还没有可判断的测量';
  }

  /** Run the same plan again; only a full pass verifies the report. */
  async remeasure(id) {
    if (!id || this._remeasuring.has(id)) return null;
    this._remeasuring.add(id);
    this.reportError = '';
    this.render();
    try {
      const next = await this.opts.remeasureReport?.(id);
      if (next) {
        this.reports = this.reports.map((report) => (report.id === id ? next : report));
        this.remeasured.add(id);
        const failed = (next.verification?.failed || []).length;
        const pending = (next.verification?.pending || []).length;
        const verdict = next.status === 'verified'
          ? { text: '已重新测量：通过', level: 'success' }
          : failed ? { text: `已重新测量：仍有 ${failed} 项未通过`, level: 'info' }
            : pending ? { text: '已重新测量：有项要等后台', level: 'info' }
              : { text: '已重新测量：还没有可判断的测量', level: 'info' };
        this.opts.toast?.(verdict.text, verdict.level);
      }
      return next || null;
    } catch (e) {
      this.reportError = e?.message ? `重新测量失败：${e.message}` : '重新测量失败';
      this.opts.toast?.(this.reportError, 'error');
      return null;
    } finally {
      this._remeasuring.delete(id);
      this.render();
    }
  }

  /** AI card / __vdm: jump to one report row in the 报告 section. */
  async focusReport(id) {
    if (!id) return false;
    await this.refresh();
    this.render();
    const row = this.listEl?.querySelector(`.rv-report[data-report-id="${CSS.escape(String(id))}"]`);
    if (!row) return false;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('hl');
    setTimeout(() => row.classList.remove('hl'), 1400);
    return true;
  }

  // ---------------------------------------------------------------- data/actions
  /** Open / close one record's rows; loads its detail first. */
  async toggle(id) {
    if (!id) return;
    this.activeId = id;
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
      this.render();
      return;
    }
    this.expanded.add(id);
    this.render();
    await this.ensureDetail(id);
    this.render();
  }

  /** Open one record from another page (the AI card's 审阅 link). */
  async focus(id) {
    if (!id) return;
    this.activeId = id;
    this.expanded.add(id);
    this.render();
    await this.ensureDetail(id);
    this.render();
    const node = this.listEl?.querySelector(`.rv-cs[data-id="${id}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }

  /** Accept one whole change set (one transaction; main.js owns the write). */
  async apply(id, { retry = false } = {}) {
    if (!id) return null;
    const record = this.records.find((entry) => entry.id === id);
    let detail = this.details.get(id) || null;
    if (!detail && record) detail = await this.ensureDetail(id);
    if (detail && detail.status === 'proposed' && !retry && this._staleCount(detail) > 0) {
      this.error = '这组里有你之后改过的值，先逐条确认（仍然采纳 / 让 AI 重新做）';
      this.render();
      return null;
    }
    this._busy = true;
    this.render();
    let result = null;
    try {
      result = await this.opts.apply?.(id);
      this.error = '';
      this.errorRetry = null;
      this.opts.toast?.('已采纳整组（Ctrl+Z 可退回）', 'success');
      this.expanded.delete(id);
      this.activeId = null; // the list moved on: follow the next pending set
    } catch (e) {
      this.error = e?.code === 'LOCKED' ? '这个元素已锁定' : (e?.message || '采纳失败');
      this.errorRetry = e?.code === 'LOCKED' ? id : null;
      this.opts.toast?.(`采纳失败: ${this.error}`, 'error');
    } finally {
      this._busy = false;
    }
    await this.refresh();
    return result;
  }

  /** Banner / compare modal: the user already saw the picture, so an explicit
   *  accept overrides the stale guard. */
  accept(id) {
    return this.apply(id, { retry: true });
  }

  /** Discard / un-apply the whole change set. */
  async discard(id) {
    if (!id) return null;
    this._busy = true;
    this.render();
    let result = null;
    try {
      result = await this.opts.revert?.(id);
      this.error = '';
      this.errorRetry = null;
      this.opts.toast?.('已不要这组改动', 'success');
      this.expanded.delete(id);
      this.activeId = null;
    } catch (e) {
      this.error = e?.message || '撤回失败';
      this.opts.toast?.(`撤回失败: ${this.error}`, 'error');
    } finally {
      this._busy = false;
    }
    await this.refresh();
    return result;
  }

  /** Un-apply one row (`revert-one`); a merged keyframe row does each entry. */
  async revertRow(id, row) {
    if (!id || !row) return;
    const indexes = row.kind === 'kf'
      ? row.entries.map(({ index }) => index).sort((a, b) => b - a)
      : [row.index];
    this._busy = true;
    this.render();
    try {
      for (const index of indexes) await this.opts.revertOne?.(id, { index });
      this.error = '';
      this.opts.toast?.('已撤回这一处', 'success');
    } catch (e) {
      this.error = e?.message || '撤回失败';
      this.opts.toast?.(`撤回失败: ${this.error}`, 'error');
    } finally {
      this._busy = false;
    }
    this.unchecked.delete(id);
    this.details.delete(id);
    await this.refresh();
  }

  /** Row click: select the host, seek to the first affected frame, show the
   *  property in the inspector. */
  jump(record, detail, row) {
    const entry = row.entry || {};
    const fps = Number(this.opts.getFps?.()) || 24;
    let frame = null;
    const kf = row.kind === 'kf' ? row.entries[0]?.kf : keyframeOf(entry);
    if (kf) frame = Math.round((kf.afterT ?? kf.t) * fps);
    else if (entry.path === 'start') frame = Math.round(Number(entry.after ?? entry.before) * fps);
    if (frame === null) frame = firstFrameOf(detail?.changed, fps);
    this.opts.onJump?.({
      kind: entry.kind || 'element',
      id: entry.id,
      path: row.kind === 'kf' ? row.entries[0]?.kf?.inner : entry.path,
      frame,
      recordId: record?.id,
    });
  }

  /** "让 AI 重新做": open the AI page with the proposal's intent as the draft. */
  retryAI(record, detail) {
    const intent = record?.intent || detail?.intent || '';
    this.opts.retryAI?.(intent);
  }

  /** Toggle the in-canvas preview of one proposed set. */
  async togglePreview(record) {
    if (!record?.id) return;
    if (this.opts.previewId?.() === record.id) {
      this.opts.exitPreview?.();
      this.render();
      return;
    }
    this._busy = true;
    this.render();
    await this.opts.enterPreview?.(record);
    this._busy = false;
    this.render();
  }

  // ---------------------------------------------------------------- compare
  /** Before/after stills, both drawn from the real preview canvas. */
  async openCompare(record = null) {
    if (!this.opts.isPreviewing?.()) {
      this.opts.toast?.('先在变更集上打开「在画面里预览」', 'warn');
      return;
    }
    const detail = record ? this.details.get(record.id) : null;
    const frame = firstFrameOf(detail?.changed, this.opts.getFps?.());
    let data = null;
    try {
      data = await this.opts.compare?.({ frame });
    } catch (e) {
      this.opts.toast?.(`对比失败: ${e.message}`, 'error');
      return;
    }
    if (!data) return;
    this.closeCompare();
    const left = h('canvas', { class: 'cmp-canvas cmp-left', 'data-side': 'before' });
    const right = h('canvas', { class: 'cmp-canvas cmp-right', 'data-side': 'after' });
    const leftPane = h('div', { class: 'cmp-pane' }, left, h('span', { class: 'cmp-tag' }, '现在'));
    const rightPane = h('div', { class: 'cmp-pane' }, right, h('span', { class: 'cmp-tag' }, 'AI 修改后'));
    const split = h('div', { class: 'cmp-split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动分隔线' });
    const meta = h('span', { class: 'hint cmp-meta' },
      `${Number.isFinite(data.frame) && data.frame !== null ? `f${data.frame} · ` : ''}rev ${data.revBefore} → ${data.revAfter}`);
    const card = h('div', { class: 'modal-card cmp-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '对比修改前后' },
      h('div', { class: 'modal-head' },
        h('strong', {}, '对比'),
        meta,
        h('button', { type: 'button', class: 'icon-btn mini cmp-close', 'aria-label': '关闭对比' }, icon('x', 'ic-sm')),
      ),
      h('div', { class: 'cmp-body' }, leftPane, split, rightPane),
      h('div', { class: 'modal-foot' },
        h('span', { class: 'hint' }, '左：现在的工程 · 右：采纳后的画面'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn primary cmp-accept' }, '采纳整组'),
        h('button', { type: 'button', class: 'btn cmp-close' }, '关闭'),
      ),
    );
    const el = h('div', { id: 'reviewCompare', class: 'modal' }, card);
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.closeCompare();
    };
    const close = () => this.closeCompare();
    card.querySelectorAll('.cmp-close').forEach((b) => b.addEventListener('click', close));
    card.querySelector('.cmp-accept').addEventListener('click', () => {
      const id = this.activeId;
      this.closeCompare();
      this.accept(id);
    });
    el.addEventListener('click', (event) => { if (event.target === el) close(); });
    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      const box = el.querySelector('.cmp-body').getBoundingClientRect();
      const ratio = Math.min(0.85, Math.max(0.15, (event.clientX - box.left) / Math.max(1, box.width)));
      leftPane.style.flexBasis = `${ratio * 100}%`;
    };
    const onUp = () => { dragging = false; };
    split.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      dragging = true;
      try { split.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
    this._cmp = { el, onKey, onMove, onUp };
    await Promise.all([this._drawSnap(left, data.before), this._drawSnap(right, data.after)]);
  }

  async _drawSnap(canvas, url) {
    if (!url) return;
    const img = new Image();
    await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = url; });
    const width = 640;
    const height = Math.max(2, Math.round(width * (img.height || 9) / (img.width || 16)));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (img.width) ctx.drawImage(img, 0, 0, width, height);
  }

  closeCompare() {
    if (!this._cmp) return;
    const { el, onKey, onMove, onUp } = this._cmp;
    this._cmp = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    el.remove();
  }
}
