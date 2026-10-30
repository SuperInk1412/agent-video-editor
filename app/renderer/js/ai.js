// AI panel: talk to the agent, stream its run, interrupt it (docs/DESIGN.md §1.4).
//
// WP2.4 only touches the data layer. The engine's tool loop
// (docs/DESIGN-BACKEND-V2.md §8.4) streams `loop` / `plan` / `tool` /
// `changeset` / `still` / `measure` / `report` events on top of the old
// `agent` / `proposal` / `exit` ones; this file now keeps that state
// (`this.plan`, `this.changesets`, `this.report`, `this.stills`, …) and
// sends the request `scope` the loop enforces. Rendering those as a review
// panel / timeline markers is WP2.5 — nothing below adds a widget.
import { h, icon } from './ui.js';
import { frameStart } from './timeline-math.js';

const EXAMPLES = [
  '把标题改成「锈梦」，字号加大，加一点辉光',
  '这段节奏太闷，每 2 拍闪一下白',
  '给这个分镜加一句字幕，放在底部',
];

export class AgentPanel {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.running = false;
    this.available = true;
    this.log = [];
    this.current = null;
    this._stick = true; // auto-scroll while the user is at the bottom
    // --- WP2.4 data layer: what the loop produced (WP2.5 draws it) ---
    this.plan = null;          // latest plan from the loop
    this.pendingPlan = null;   // plan waiting for the user's approval
    this.changesets = new Map(); // id -> { id, status, changed, rev, … }
    this.report = null;        // §8.3 report of the last finished run
    this.reportPath = null;
    this.stills = [];
    this.measurements = [];
    this.rejections = [];
    this.contract = null;
    this._render();
  }

  setState({ available, running }) {
    this.available = available;
    this.running = running;
    this._syncButtons();
  }

  _render() {
    this.root.innerHTML = '';
    this.root.classList.add('agent-panel');

    this.dotEl = h('span', { class: 'agent-dot', 'aria-hidden': 'true' });
    this.statusEl = h('span', { class: 'agent-status' });
    this.root.appendChild(h('div', { class: 'agent-head' },
      this.dotEl,
      h('span', { class: 'agent-title' }, 'AI 副驾'),
      this.statusEl,
    ));

    this.logEl = h('div', { class: 'agent-stream', role: 'log', 'aria-live': 'polite' });
    this.logEl.addEventListener('scroll', () => {
      const el = this.logEl;
      this._stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    });
    this.root.appendChild(this.logEl);

    const chip = (label, tip) => {
      const b = h('button', { class: 'chip on', 'aria-pressed': 'true', 'data-tip': tip }, label);
      b.addEventListener('click', () => {
        const on = b.classList.toggle('on');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      return b;
    };
    this.chipSeg = chip('当前分镜', '把选中的分镜段作为上下文');
    this.chipSel = chip('选中元素', '把选中的元素作为上下文');
    this.chipFrames = chip('截 3 帧给 AI 看', '在分镜段内截 3 帧预览画面一起发给 AI');

    this.task = h('textarea', {
      class: 'agent-task', rows: 3,
      placeholder: '让 AI 改这一段…',
      'aria-label': '给 AI 的任务',
    });
    this.task.addEventListener('input', () => this._grow());
    this.task.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!this.running) this._run();
      }
    });

    this.btnRun = h('button', { class: 'agent-send', 'data-kbd': 'Ctrl+Enter' });
    this.btnRun.addEventListener('click', () => (this.running ? this._stop() : this._run()));

    this.root.appendChild(h('div', { class: 'agent-composer' },
      h('div', { class: 'chips agent-chips' }, this.chipSeg, this.chipSel, this.chipFrames),
      this.task,
      h('div', { class: 'agent-send-row' },
        h('span', { class: 'agent-kbd-hint' }, h('kbd', {}, 'Ctrl'), h('kbd', {}, 'Enter'), ' 发送'),
        this.btnRun,
      ),
    ));
    this._syncButtons();
    this._renderLog();
    this._grow();
  }

  /** textarea grows from 3 to 8 rows with its content */
  _grow() {
    const ta = this.task;
    if (!ta) return;
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    ta.style.height = 'auto';
    const min = line * 3 + pad, max = line * 8 + pad;
    const want = Math.min(max, Math.max(min, ta.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)));
    ta.style.height = `${want}px`;
    ta.style.overflowY = ta.scrollHeight + 2 > max ? 'auto' : 'hidden';
  }

  _syncButtons() {
    if (!this.btnRun) return;
    const b = this.btnRun;
    b.replaceChildren(icon(this.running ? 'stop' : 'send', 'ic-sm'), this.running ? '停止' : '发送');
    b.className = `agent-send${this.running ? ' danger' : ''}`;
    b.disabled = !this.running && !this.available;
    b.dataset.tip = this.running ? '打断 AI' : this.available ? '发送任务' : '没有 DSH-TUI：AI 不可用';
    if (this.running) b.removeAttribute('data-kbd'); else b.dataset.kbd = 'Ctrl+Enter';
    this.task.disabled = this.running;
    if (this.statusEl) {
      const st = !this.available ? 'bad' : this.running ? 'busy' : 'ok';
      this.statusEl.textContent = !this.available ? '未找到 DSH-TUI' : this.running ? '运行中…' : '就绪';
      this.statusEl.className = `agent-status ${st}`;
      this.dotEl.className = `agent-dot ${st}`;
    }
  }

  async _run() {
    const task = this.task.value.trim();
    if (!task) { this.opts.toast?.('先写一句要 AI 做什么', 'warn'); return; }
    const sel = this.opts.getSelection();
    const time = this.opts.getTime();
    const frames = [];
    if (this.chipFrames.classList.contains('on')) {
      const project = this.opts.getProject();
      const seg = project.segments.find((s) => s.id === sel.segmentId);
      const fps = project.meta?.fps || 24;
      // Frames only: the model must not be shown a state between two frames.
      // The preview samples whole frames (main.js::pictureTime, §五), so the
      // snapshot and its label both move to the frame start.
      const times = (seg
        ? [seg.start + seg.duration * 0.15, seg.start + seg.duration * 0.5, seg.start + seg.duration * 0.85]
        : [Math.max(0, time - 1), time, time + 1]
      ).map((t) => frameStart(t, fps));
      for (const t of times) {
        try { frames.push({ dataUrl: this.opts.captureAt(t), label: `t${t.toFixed(2)}` }); } catch { /* ignore */ }
      }
    }
    this.log = [];
    this.current = null;
    this._stick = true;
    this.plan = null;
    this.pendingPlan = null;
    this.changesets.clear();
    this.report = null;
    this.reportPath = null;
    this.stills = [];
    this.measurements = [];
    this.rejections = [];
    this.contract = null;
    this._renderLog();
    this._push({ kind: 'task', text: task });
    try {
      const r = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task,
          selection: {
            segmentId: this.chipSeg.classList.contains('on') ? sel.segmentId : null,
            elementIds: this.chipSel.classList.contains('on') ? [sel.elementId].filter(Boolean) : [],
          },
          // The loop refuses writes outside this scope (§8.1). A selection
          // narrows it to one element; otherwise the whole project is in
          // range (creation allowed), which is what the task box implies.
          scope: this._scopeFor(sel),
          frames,
          time,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'agent failed');
      this.running = true;
      this._syncButtons();
      this._push({ kind: 'meta', text: `会话 ${j.runId} · ${frames.length} 帧上下文已生成` });
    } catch (e) {
      this._push({ kind: 'error', text: e.message });
      this.opts.toast?.(`AI 启动失败: ${e.message}`, 'error');
    }
  }

  /**
   * Scope of the request, from the two context chips. Elements are ids; paths
   * are property-path whitelists (`style.size`, `style.*`, `*`). WP2.5 will
   * add the UI that lets a user tighten this; for now a selection means "only
   * this element", everything else means "the project".
   */
  _scopeFor(sel) {
    const picked = this.chipSel?.classList.contains('on') && sel?.elementId;
    if (picked) {
      return {
        elements: [sel.elementId],
        paths: ['*'],
        create: false,
        source: 'ui:selection',
      };
    }
    const bySegment = this.chipSeg?.classList.contains('on') && sel?.segmentId;
    return {
      elements: ['*'],
      paths: ['*'],
      create: !bySegment,
      source: bySegment ? 'ui:segment' : 'ui:project',
    };
  }

  /** WP2.5's review panel calls this; the data layer is ready, the UI is not. */
  approvePlan(planId = this.pendingPlan?.id || null) {
    if (!planId) return Promise.resolve(false);
    this.pendingPlan = null;
    return fetch('/api/agent/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId }),
    }).then((r) => r.ok).catch(() => false);
  }

  /** Everything WP2.5 needs to draw the review panel / report anchors. */
  getData() {
    return {
      plan: this.plan,
      pendingPlan: this.pendingPlan,
      changesets: [...this.changesets.values()],
      report: this.report,
      reportPath: this.reportPath,
      stills: [...this.stills],
      measurements: [...this.measurements],
      rejections: [...this.rejections],
      contract: this.contract,
    };
  }

  /** Put a sentence in the task box (review panel: "让 AI 重新做"). */
  setDraft(text) {
    if (!this.task || text == null) return;
    this.task.value = String(text);
    this._grow();
    this.task.focus();
  }

  async _stop() {
    await fetch('/api/agent/cancel', { method: 'POST' });
    this._push({ kind: 'system', text: '已打断' });
  }

  handleEvent(ev) {
    if (ev.type === 'started') return;
    // ---- WP2.4 tool loop: state only, the widgets are WP2.5 ----
    if (ev.type === 'loop') {
      this.plan = ev.plan ?? this.plan;
      if (ev.phase === 'awaiting-approval') {
        this.pendingPlan = ev.plan ?? this.pendingPlan;
        this._push({ kind: 'step', text: '计划已提交，等待批准' });
      } else if (ev.phase === 'approved') {
        this.pendingPlan = null;
        this._push({ kind: 'step', text: '计划已批准，继续执行' });
      } else if (ev.phase === 'done') {
        this.pendingPlan = null;
      }
      return;
    }
    if (ev.type === 'plan') {
      this.plan = ev.plan;
      this.pendingPlan = ev.plan?.needsApproval ? ev.plan : null;
      this._push({ kind: 'step', text: `计划：${ev.plan?.intent || '(无说明)'} · ${ev.plan?.steps?.length ?? 0} 步 / ${ev.plan?.opsCount ?? 0} 个 op` });
      return;
    }
    if (ev.type === 'tool') {
      this._push({
        kind: 'tool',
        title: ev.name,
        text: ev.ok ? (ev.summary || 'ok') : `${ev.error?.code || 'ERROR'}: ${ev.error?.message || ''}`,
      });
      if (!ev.ok) this.rejections.push({ tool: ev.name, ...(ev.error || {}) });
      return;
    }
    if (ev.type === 'changeset') {
      const record = ev.record || {};
      if (record.id) this.changesets.set(record.id, { ...(this.changesets.get(record.id) || {}), ...record });
      const n = (record.changed || []).length;
      this._push({
        kind: 'ops',
        title: `变更集 ${record.id || ''} · ${record.status || ev.action || ''}`,
        text: `${n} 处改动${record.rev ? ` · rev ${record.rev}` : ''}`,
        changesetId: record.id || null,
        intent: record.intent || '',
      });
      return;
    }
    if (ev.type === 'still') {
      this.stills.push(ev.still);
      this._push({ kind: 'tool', title: '出图', text: `${ev.still?.path} · ${ev.still?.width}×${ev.still?.height}` });
      return;
    }
    if (ev.type === 'measure') {
      this.measurements.push(ev.measurement);
      this._push({ kind: 'tool', title: `测量 ${ev.measurement?.what || ''}`, text: ev.measurement?.summary || '' });
      return;
    }
    if (ev.type === 'report') {
      this.report = ev.report;
      this.reportPath = ev.report?.path ?? null;
      this.contract = ev.report?.contract ?? this.contract;
      const v = ev.report?.verificationSummary || {};
      this._push({
        kind: 'meta',
        text: `报告：已验证 ${v.verified || 0} · 未验证 ${v.unverified || 0} · 没做 ${v.skipped || 0}${this.reportPath ? ` · ${this.reportPath}` : ''}`,
      });
      return;
    }
    if (ev.type === 'proposal') {
      if (ev.error) this._push({ kind: 'error', text: `提议应用失败: ${ev.error}` });
      else if (ev.applied) {
        const nOps = ev.proposal?.ops?.length;
        this._push({
          kind: 'ops',
          title: nOps != null ? `应用 ${nOps} 个操作` : '已应用改动',
          text: `已应用 ${ev.applied.changed.length} 处修改 · rev ${ev.applied.rev}${ev.applied.note ? ' · ' + ev.applied.note : ''}`,
        });
        if (ev.changeset?.id) {
          this.changesets.set(ev.changeset.id, { ...(this.changesets.get(ev.changeset.id) || {}), ...ev.changeset, status: ev.changeset.status || 'applied' });
        }
      } else this._push({ kind: 'meta', text: '收到改动提议' });
      return;
    }
    if (ev.type === 'cancelled') { this.running = false; this._syncButtons(); return; }
    if (ev.type === 'error') { this._push({ kind: 'error', text: ev.message }); return; }
    if (ev.type === 'exit') {
      this.running = false;
      this._syncButtons();
      this._push({ kind: 'system', text: `结束 (code ${ev.code}) · ${ev.seconds?.toFixed(1)}s`, detail: ev.stderr || '' });
      return;
    }
    if (ev.type !== 'agent') return;
    const e = ev.event || {};
    if (e.type === 'thinking') {
      if (e.text) this._append('think', e.text);
      return;
    }
    if (e.type === 'text') {
      this._append('say', e.text || '');
      return;
    }
    if (e.type === 'final') {
      this._append('say', e.text || '');
      this.current = null;
      return;
    }
    if (e.type === 'status') {
      if (e.phase === 'turn_start') this._push({ kind: 'step', text: `第 ${e.turn} 轮` });
      if (e.phase === 'step_end' && e.usage) this._push({ kind: 'meta', text: `tokens ${e.usage.totalTokens}` });
      if (e.phase === 'turn_end' && e.reason?.kind === 'completed') this.current = null;
      return;
    }
    if (e.type === 'session') { this._push({ kind: 'meta', text: `session ${String(e.sessionId).slice(0, 24)}` }); return; }
    // tools / anything else the runtime emits
    const label = e.type || e.kind || 'event';
    const detail = e.text || e.name || e.tool || e.message || JSON.stringify(e).slice(0, 160);
    this._push({ kind: 'tool', title: String(label), text: String(detail).slice(0, 200) });
  }

  _append(kind, text) {
    if (!text) return;
    const last = this.log[this.log.length - 1];
    if (this.current && last && last.kind === kind && last.stream) {
      last.text += text;
    } else {
      this.current = { kind, text, stream: true };
      this.log.push(this.current);
    }
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this._renderLog();
  }

  _push(entry) {
    this.current = null;
    this.log.push(entry);
    if (this.log.length > 400) this.log.shift();
    this._renderLog();
  }

  _entry(e) {
    switch (e.kind) {
      case 'task':
        return h('div', { class: 'msg msg-task' }, h('div', { class: 'msg-label' }, '你的任务'), h('div', { class: 'msg-text' }, e.text));
      case 'say':
        return h('div', { class: 'msg msg-say' }, e.text);
      case 'think': {
        const n = h('div', { class: `msg msg-think${e.open ? ' open' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': e.open ? 'true' : 'false' },
          h('div', { class: 'msg-think-head' }, icon(e.open ? 'chevron-down' : 'chevron-right', 'ic-sm'), '思考中…'),
          e.open ? h('div', { class: 'msg-think-body' }, e.text) : null);
        const toggle = () => { e.open = !e.open; this._renderLog(); };
        n.addEventListener('click', toggle);
        n.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
        return n;
      }
      case 'tool':
      case 'ops': {
        // A change set card carries one extra link: jump to 审阅 (WP2.5a) so a
        // result in the conversation points at the rows that produced it.
        const card = h('div', { class: `msg msg-card msg-${e.kind}` },
          h('div', { class: 'msg-card-head' }, icon(e.kind === 'ops' ? 'check' : 'terminal', 'ic-sm'), h('span', {}, e.title || '')),
          e.text ? h('div', { class: 'msg-card-text' }, e.text) : null);
        if (e.kind === 'ops' && e.changesetId && this.opts.onOpenReview) {
          card.appendChild(h('button', {
            type: 'button', class: 'msg-link', 'data-action': 'open-review', 'data-id': e.changesetId,
            'data-tip': '在审阅页打开这组改动',
            onclick: () => this.opts.onOpenReview(e.changesetId),
          }, '审阅'));
        }
        return card;
      }
      case 'error':
        return h('div', { class: 'msg msg-error' }, icon('alert', 'ic-sm'), h('span', {}, e.text));
      case 'step':
        return h('div', { class: 'msg msg-step' }, h('span', {}, e.text));
      default: // system / meta
        return h('div', { class: `msg msg-${e.kind === 'system' ? 'system' : 'meta'}` },
          h('div', {}, e.text),
          e.detail ? h('pre', { class: 'msg-card-text' }, e.detail) : null);
    }
  }

  _renderEmpty() {
    return h('div', { class: 'agent-empty' },
      icon('sparkles'),
      h('div', { class: 'empty-title' }, '让 AI 改这一段'),
      h('div', { class: 'empty-text' }, '写一句要改什么，或从下面挑一条'),
      h('div', { class: 'agent-suggest' }, ...EXAMPLES.map((t) => h('button', {
        class: 'agent-suggest-item',
        onclick: () => { this.task.value = t; this._grow(); this.task.focus(); },
      }, t))));
  }

  _renderLog() {
    if (!this.logEl) return;
    const el = this.logEl;
    const keep = el.scrollTop;
    el.innerHTML = '';
    if (!this.log.length) { el.appendChild(this._renderEmpty()); return; }
    for (const e of this.log) el.appendChild(this._entry(e));
    if (this._stick) el.scrollTop = el.scrollHeight;
    else el.scrollTop = keep;
  }
}
