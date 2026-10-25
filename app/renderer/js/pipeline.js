// Pipeline panel: storyboard -> preview frames -> segment render -> master, all visible.
const h = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

const STEPS = [
  { id: 'storyboard', label: '分镜', desc: '音乐结构 → 段落 / 意图' },
  { id: 'stills', label: '预览帧', desc: '每个关键帧交给 Blender 出图' },
  { id: 'render', label: '片段渲染', desc: '分段出片，可反复重来' },
  { id: 'master', label: '成片', desc: '整片合并 + 音轨' },
];

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

  _build() {
    this.root.innerHTML = '';
    this.root.appendChild(h('div', { class: 'panel-head' },
      h('div', { class: 'panel-title' }, '流水线'),
      h('div', { class: 'panel-sub' }, '每一步都能看见、打断、重来'),
    ));
    this.stepsEl = h('div', { class: 'steps' });
    this.root.appendChild(this.stepsEl);
    this.artEl = h('div', { class: 'artifacts' });
    this.root.appendChild(h('div', { class: 'sec-title' }, '产出'), this.artEl);

    this.styleSel = h('select', {},
      h('option', { value: 'neon' }, '霓虹 neon'),
      h('option', { value: 'clean' }, '干净 clean'),
      h('option', { value: 'film' }, '胶片 film'));
    this.brief = h('textarea', { rows: 3, placeholder: '分镜文案（一行一句，会变成字幕/大字）' });
    this.root.appendChild(h('div', { class: 'sec' },
      h('div', { class: 'sec-title' }, '自动分镜'),
      h('div', { class: 'fld span2' }, h('label', {}, '风格'), this.styleSel),
      h('div', { class: 'fld span3' }, this.brief),
      h('div', { class: 'row-btns' },
        h('button', { class: 'primary', onclick: () => this._plan() }, '生成分镜'),
        h('button', { class: 'mini', onclick: () => this._beats() }, '分析节拍'),
      ),
    ));

    this.progress = h('div', { class: 'progress' }, h('div', { class: 'bar' }), h('span', { class: 'ptext' }, ''));
    this.root.appendChild(h('div', { class: 'sec' },
      h('div', { class: 'sec-title' }, '出片'),
      this.progress,
      h('div', { class: 'row-btns' },
        h('button', { class: 'mini', onclick: () => this._still() }, '当前帧预览'),
        h('button', { onclick: () => this._render('segment') }, '渲染当前段'),
        h('button', { class: 'primary', onclick: () => this._render('master') }, '渲染成片'),
        h('button', { class: 'danger', onclick: () => this._cancel() }, '取消'),
      ),
    ));
    this._paint();
  }

  _paint() {
    if (!this.stepsEl) return;
    const steps = this.state?.pipeline?.steps || STEPS.map((s) => ({ ...s, status: 'todo', detail: '' }));
    this.stepsEl.innerHTML = '';
    steps.forEach((s, i) => {
      const meta = STEPS.find((x) => x.id === s.id) || {};
      this.stepsEl.appendChild(h('div', { class: `step s-${s.status}` },
        h('div', { class: 'step-idx' }, String(i + 1)),
        h('div', { class: 'step-body' },
          h('div', { class: 'step-top' }, h('span', { class: 'step-label' }, s.label), h('span', { class: `step-state ${s.status}` }, stateLabel(s.status))),
          h('div', { class: 'step-detail' }, s.detail || meta.desc || ''),
        ),
      ));
    });

    const arts = this.state?.pipeline?.artifacts || [];
    this.artEl.innerHTML = '';
    if (!arts.length) this.artEl.appendChild(h('div', { class: 'hint' }, '还没有产出。先生成分镜，再出预览帧。'));
    for (const a of arts.slice(0, 12)) {
      if (a.kind === 'still' && a.url) {
        this.artEl.appendChild(h('a', { class: 'art', href: a.url, target: '_blank', title: a.label },
          h('img', { src: a.url, loading: 'lazy' }),
          h('span', {}, a.label)));
      } else if (a.url) {
        this.artEl.appendChild(h('a', { class: 'art file', href: a.url, target: '_blank' }, '▶ ', a.label));
      } else {
        this.artEl.appendChild(h('div', { class: 'art file' }, a.label));
      }
    }

    const r = this.render;
    if (r) {
      const pct = r.total ? Math.min(100, (r.progress / r.total) * 100) : 0;
      this.progress.querySelector('.bar').style.width = `${r.running ? pct : r.out ? 100 : 0}%`;
      this.progress.querySelector('.ptext').textContent = r.running
        ? `${r.progress}/${r.total} 帧`
        : r.error ? `失败: ${r.error}` : r.out ? '完成' : '';
    }
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

  async _still() {
    const t = this.opts.getTime();
    this.opts.toast?.(`Blender 渲染 ${t.toFixed(2)}s …`);
    const r = await fetch('/api/still', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ time: t, scale: 0.5 }) });
    const j = await r.json();
    if (!r.ok) { this.opts.toast?.(j.error || '渲染失败', 'error'); return; }
    this.opts.toast?.('预览帧完成', 'success');
  }

  async _render(mode) {
    const p = this.opts.getProject();
    const sel = this.opts.getSelection();
    let from = 0, to = p.meta.duration;
    if (mode === 'segment' && sel.segmentId) {
      const s = p.segments.find((x) => x.id === sel.segmentId);
      if (s) { from = s.start; to = s.start + s.duration; }
    }
    const r = await fetch('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, scale: this.opts.getRenderScale() }),
    });
    const j = await r.json();
    if (!r.ok) this.opts.toast?.(j.error || '渲染启动失败', 'error');
    else this.opts.toast?.(`开始渲染 ${from.toFixed(1)}–${to.toFixed(1)}s`);
  }

  async _cancel() {
    await fetch('/api/render/cancel', { method: 'POST' });
    this.opts.toast?.('已请求取消渲染');
  }
}

const stateLabel = (s) => ({ todo: '待办', running: '进行中', done: '完成', error: '出错' }[s] || s);
