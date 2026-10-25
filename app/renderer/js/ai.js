// AI panel: talk to the DSH-TUI agent, stream its run, interrupt it.
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

export class AgentPanel {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.running = false;
    this.available = true;
    this.log = [];
    this.current = null;
    this._render();
  }

  setState({ available, running }) {
    if (this.available !== available) { this.available = available; this._render(); }
    this.running = running;
    this._syncButtons();
  }

  _render() {
    this.root.innerHTML = '';
    this.statusEl = h('div', { class: 'agent-status' });
    this.root.appendChild(h('div', { class: 'panel-head' },
      h('div', { class: 'panel-title' }, 'AI 副驾'),
      this.statusEl,
    ));

    this.task = h('textarea', {
      class: 'agent-task', rows: 3,
      placeholder: '让 AI 改这一段，例如：\n· 把标题改成「锈梦」，字号加大，加一点辉光\n· 这段节奏太闷，每 2 拍闪一下白\n· 给这个分镜加一句字幕，放在底部',
    });
    this.root.appendChild(this.task);

    this.chips = h('div', { class: 'chips' });
    this.chipSeg = h('button', { class: 'chip on', onclick: () => { this.chipSeg.classList.toggle('on'); } }, '当前分镜');
    this.chipSel = h('button', { class: 'chip on', onclick: () => { this.chipSel.classList.toggle('on'); } }, '选中元素');
    this.chipFrames = h('button', { class: 'chip on', onclick: () => { this.chipFrames.classList.toggle('on'); } }, '截 3 帧给 AI 看');
    this.chips.append(this.chipSeg, this.chipSel, this.chipFrames);
    this.root.appendChild(this.chips);

    this.btnRun = h('button', { class: 'primary grow', onclick: () => this._run() }, '▶ 让 AI 改');
    this.btnStop = h('button', { class: 'danger', onclick: () => this._stop() }, '■ 打断');
    this.root.appendChild(h('div', { class: 'row-btns' }, this.btnRun, this.btnStop));

    this.logEl = h('div', { class: 'agent-log' });
    this.root.appendChild(this.logEl);
    this._syncButtons();
    this._renderLog();
  }

  _syncButtons() {
    if (!this.btnRun) return;
    this.btnRun.disabled = this.running || !this.available;
    this.btnStop.disabled = !this.running;
    this.task.disabled = this.running;
    if (this.statusEl) {
      this.statusEl.textContent = !this.available ? 'DSH-TUI 未找到' : this.running ? '运行中…' : '就绪';
      this.statusEl.className = `agent-status ${!this.available ? 'bad' : this.running ? 'busy' : 'ok'}`;
    }
  }

  async _run() {
    const task = this.task.value.trim();
    if (!task) { this.opts.toast?.('先写一句要 AI 做什么', 'warn'); return; }
    const sel = this.opts.getSelection();
    const time = this.opts.getTime();
    const frames = [];
    if (this.chipFrames.classList.contains('on')) {
      const seg = this.opts.getProject().segments.find((s) => s.id === sel.segmentId);
      const times = seg
        ? [seg.start + seg.duration * 0.15, seg.start + seg.duration * 0.5, seg.start + seg.duration * 0.85]
        : [Math.max(0, time - 1), time, time + 1];
      for (const t of times) {
        try { frames.push({ dataUrl: this.opts.captureAt(t), label: `t${t.toFixed(2)}` }); } catch { /* ignore */ }
      }
    }
    this.log = [];
    this.current = null;
    this._renderLog();
    this._push({ kind: 'system', text: `▶ 任务：${task}` });
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
          frames,
          time,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'agent failed');
      this.running = true;
      this._syncButtons();
      this._push({ kind: 'system', text: `会话 ${j.runId} · ${frames.length} 帧上下文已生成` });
    } catch (e) {
      this._push({ kind: 'error', text: e.message });
      this.opts.toast?.(`AI 启动失败: ${e.message}`, 'error');
    }
  }

  async _stop() {
    await fetch('/api/agent/cancel', { method: 'POST' });
    this._push({ kind: 'system', text: '■ 已打断' });
  }

  handleEvent(ev) {
    if (ev.type === 'started') return;
    if (ev.type === 'proposal') {
      if (ev.error) this._push({ kind: 'error', text: `提议应用失败: ${ev.error}` });
      else if (ev.applied) {
        this._push({ kind: 'system', text: `✓ 已应用 ${ev.applied.changed.length} 处修改 (rev ${ev.applied.rev})${ev.applied.note ? ' · ' + ev.applied.note : ''}` });
      } else this._push({ kind: 'meta', text: '收到改动提议' });
      return;
    }
    if (ev.type === 'cancelled') { this.running = false; this._syncButtons(); return; }
    if (ev.type === 'error') { this._push({ kind: 'error', text: ev.message }); return; }
    if (ev.type === 'exit') {
      this.running = false;
      this._syncButtons();
      this._push({ kind: 'system', text: `■ 结束 (code ${ev.code}) · ${ev.seconds?.toFixed(1)}s${ev.stderr ? '\n' + ev.stderr : ''}` });
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
      if (e.phase === 'turn_start') this._push({ kind: 'step', text: `── 第 ${e.turn} 轮 ──` });
      if (e.phase === 'step_end' && e.usage) this._push({ kind: 'meta', text: `tokens ${e.usage.totalTokens}` });
      if (e.phase === 'turn_end' && e.reason?.kind === 'completed') this.current = null;
      return;
    }
    if (e.type === 'session') { this._push({ kind: 'meta', text: `session ${String(e.sessionId).slice(0, 24)}` }); return; }
    // tools / anything else the runtime emits
    const label = e.type || e.kind || 'event';
    const detail = e.text || e.name || e.tool || e.message || JSON.stringify(e).slice(0, 160);
    this._push({ kind: 'tool', text: `⚙ ${label}  ${String(detail).slice(0, 200)}` });
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

  _renderLog() {
    if (!this.logEl) return;
    this.logEl.innerHTML = '';
    for (const e of this.log) {
      this.logEl.appendChild(h('div', { class: `log-line ${e.kind}` }, e.text));
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
