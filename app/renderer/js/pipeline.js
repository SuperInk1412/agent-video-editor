// 渲染 panel (was 流水线): render job, pipeline steps, auto storyboard, artifacts (docs/DESIGN.md §1.4).
import { h, icon, prefs } from './ui.js';

const STEPS = [
  { id: 'storyboard', label: '分镜', desc: '音乐结构 → 段落 / 意图' },
  { id: 'stills', label: '预览帧', desc: '每个关键帧交给 Blender 出图' },
  { id: 'render', label: '片段渲染', desc: '分段出片，可反复重来' },
  { id: 'master', label: '成片', desc: '整片合并 + 音轨' },
];

const ART_ICON = { still: 'photo', render: 'film', video: 'film', ai: 'sparkles', storyboard: 'layers' };

export class PipelinePanel {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.state = null;
    this.render = null;
    this._build();
  }

  set(state) {
    this.state = state;
    this.render = state.render;
    this._paint();
  }

  setRender(r) {
    this.render = r;
    this._paint();
  }

  /** keep the 50% / 100% control in sync with renderActions (top-bar menu) */
  setScale(v) {
    const s = Number(v) === 1 ? 1 : 0.5;
    this.scaleSeg?.querySelectorAll('button').forEach((b) => {
      const on = Number(b.dataset.scale) === s;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  _section(key, title, body, { collapsible = false, collapsed = false } = {}) {
    const sections = prefs.get('sections', {}) || {};
    const isCollapsed = collapsible && (sections[`pipe.${key}`] ?? collapsed);
    const sec = h('div', { class: `sec pipe-sec${isCollapsed ? ' collapsed' : ''}` });
    const head = h('div', { class: 'sec-head' },
      collapsible ? icon(isCollapsed ? 'chevron-right' : 'chevron-down', 'ic-sm') : null,
      h('span', {}, title));
    if (collapsible) {
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      const toggle = () => {
        const c = sec.classList.toggle('collapsed');
        head.setAttribute('aria-expanded', c ? 'false' : 'true');
        head.firstChild.replaceWith(icon(c ? 'chevron-right' : 'chevron-down', 'ic-sm'));
        const all = { ...(prefs.get('sections', {}) || {}) };
        all[`pipe.${key}`] = c;
        prefs.set('sections', all);
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    } else head.classList.add('static');
    sec.append(head, h('div', { class: 'sec-body' }, body));
    return sec;
  }

  _build() {
    this.root.innerHTML = '';
    this.root.classList.add('pipe-panel');
    const ra = this.opts.renderActions;

    // ① render job
    this.bar = h('div', { class: 'bar' });
    this.progress = h('div', { class: 'progress lg', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.bar);
    this.frameEl = h('span', { class: 'rj-frames mono' }, '');
    this.statusEl = h('span', { class: 'rj-status' }, '');
    this.btnCancel = h('button', { class: 'danger mini', 'data-tip': '取消渲染', onclick: () => this._cancel() }, icon('x', 'ic-sm'), '取消');
    this.scaleSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '分辨率' },
      ...[0.5, 1].map((s) => h('button', {
        'data-scale': String(s), 'data-tip': `渲染分辨率 ${s * 100}%`,
        onclick: () => { if (ra?.setScale) ra.setScale(s); else this.setScale(s); },
      }, `${s * 100}%`)));
    const jobBody = h('div', { class: 'rj' },
      h('div', { class: 'rj-meta' }, this.frameEl, this.statusEl),
      this.progress,
      h('div', { class: 'rj-actions' },
        h('button', { class: 'mini', 'data-tip': '预览帧\n用 Blender 渲染当前时刻', onclick: () => this._still() }, icon('photo', 'ic-sm'), '预览帧'),
        h('button', { class: 'mini', 'data-tip': '渲染当前段\n选中的分镜段，否则播放头所在段', onclick: () => this._render('segment') }, icon('film', 'ic-sm'), '渲染当前段'),
        h('button', { class: 'mini', 'data-tip': '渲染成片\n整片合并 + 音轨', onclick: () => this._render('master') }, icon('film', 'ic-sm'), '渲染成片'),
        this.btnCancel,
      ),
      h('div', { class: 'rj-scale' }, h('span', { class: 'rj-label' }, '分辨率'), this.scaleSeg),
    );
    this.root.appendChild(this._section('job', '渲染任务', jobBody));

    // ② pipeline steps
    this.stepsEl = h('ol', { class: 'stepper' });
    this.root.appendChild(this._section('steps', '流水线', this.stepsEl));

    // ③ auto storyboard
    this.styleSel = h('select', { 'aria-label': '风格' },
      h('option', { value: 'neon' }, '霓虹 neon'),
      h('option', { value: 'clean' }, '干净 clean'),
      h('option', { value: 'film' }, '胶片 film'));
    this.brief = h('textarea', { rows: 3, placeholder: '分镜文案（一行一句，会变成字幕/大字）', 'aria-label': '分镜文案' });
    this.root.appendChild(this._section('plan', '自动分镜', h('div', { class: 'plan' },
      h('div', { class: 'prop' }, h('label', {}, '风格'), this.styleSel, h('span', {})),
      this.brief,
      h('div', { class: 'row-btns' },
        h('button', { class: 'mini', onclick: () => this._plan() }, '生成分镜'),
        h('button', { class: 'mini', onclick: () => this._beats() }, '分析节拍'),
      ),
    ), { collapsible: true, collapsed: false }));

    // ④ artifacts
    this.artEl = h('div', { class: 'artifacts' });
    this.root.appendChild(this._section('arts', '产出', this.artEl));

    this.setScale(ra?.getScale ? ra.getScale() : this.opts.getRenderScale?.());
    this._paint();
  }

  _paint() {
    if (!this.stepsEl) return;
    const steps = this.state?.pipeline?.steps || STEPS.map((s) => ({ ...s, status: 'todo', detail: '' }));
    this.stepsEl.innerHTML = '';
    steps.forEach((s, i) => {
      const meta = STEPS.find((x) => x.id === s.id) || {};
      const status = s.status || 'todo';
      this.stepsEl.appendChild(h('li', { class: `step s-${status}` },
        h('span', { class: 'step-idx' }, status === 'done' ? icon('check', 'ic-sm') : status === 'error' ? icon('alert', 'ic-sm') : String(i + 1)),
        h('div', { class: 'step-body' },
          h('div', { class: 'step-top' }, h('span', { class: 'step-label' }, s.label || meta.label || s.id), h('span', { class: `step-state ${status}` }, stateLabel(status))),
          h('div', { class: 'step-detail', title: s.detail || meta.desc || '' }, s.detail || meta.desc || ''),
        ),
      ));
    });

    const arts = this.state?.pipeline?.artifacts || [];
    this.artEl.innerHTML = '';
    if (!arts.length) this.artEl.appendChild(h('div', { class: 'hint art-empty' }, '还没有产出。先生成分镜，再出预览帧。'));
    for (const a of arts.slice(0, 12)) {
      const tip = a.detail ? `${a.label}\n${a.detail}` : a.label;
      if (a.kind === 'still' && a.url) {
        this.artEl.appendChild(h('a', { class: 'art', href: a.url, target: '_blank', 'data-tip': tip },
          h('img', { src: a.url, loading: 'lazy', alt: '' }),
          h('span', { class: 'art-label' }, a.label)));
      } else {
        const inner = [h('span', { class: 'art-thumb' }, icon(ART_ICON[a.kind] || 'folder')), h('span', { class: 'art-label' }, a.label)];
        this.artEl.appendChild(a.url
          ? h('a', { class: 'art file', href: a.url, target: '_blank', 'data-tip': tip }, inner)
          : h('div', { class: 'art file', 'data-tip': tip }, inner));
      }
    }

    const r = this.render;
    const pct = r?.total ? Math.min(100, (r.progress / r.total) * 100) : 0;
    const width = r?.running ? pct : r?.out ? 100 : 0;
    this.bar.style.width = `${width}%`;
    this.progress.setAttribute('aria-valuenow', String(Math.round(width)));
    this.progress.classList.toggle('is-error', !!(r && !r.running && r.error));
    this.frameEl.textContent = r?.total ? `帧 ${r.running ? r.progress : r.out ? r.total : r.progress} / ${r.total}` : '帧 – / –';
    let status = '空闲', cls = '';
    if (r?.running) {
      const what = r.kind === 'still' ? '预览帧' : r.kind === 'video' ? `${(r.from ?? 0).toFixed(1)}–${(r.to ?? 0).toFixed(1)}s` : '';
      status = `渲染中${what ? ' · ' + what : ''} · ${Math.round(pct)}%`; cls = 'running';
    } else if (r?.error) { status = `失败: ${r.error}`; cls = 'error'; }
    else if (r?.out) { status = '完成'; cls = 'done'; }
    this.statusEl.textContent = status;
    this.statusEl.className = `rj-status ${cls}`;
    this.statusEl.title = status;
    this.btnCancel.hidden = !r?.running;
  }

  async _plan() {
    const brief = this.brief.value;
    this.opts.toast?.('生成分镜中…');
    const r = await fetch('/api/plan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ style: this.styleSel.value, brief }),
    });
    const j = await r.json();
    if (!r.ok) { this.opts.toast?.(j.error || '分镜失败', 'error'); return; }
    this.opts.toast?.(`已生成 ${j.steps} 个分镜`, 'success');
  }

  async _beats() {
    const r = await fetch('/api/beats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const j = await r.json();
    if (!r.ok) { this.opts.toast?.(j.error || '节拍分析失败', 'error'); return; }
    this.opts.toast?.(`${j.tempo} bpm · ${j.beats.length} 拍`, 'success');
  }

  _still() {
    const ra = this.opts.renderActions;
    return ra?.still(this.opts.getTime());
  }

  _render(mode) {
    const ra = this.opts.renderActions;
    return mode === 'segment' ? ra?.segment() : ra?.master();
  }

  _cancel() {
    return this.opts.renderActions?.cancel();
  }
}

const stateLabel = (s) => ({ todo: '待办', running: '进行中', done: '完成', error: '出错' }[s] || s);
