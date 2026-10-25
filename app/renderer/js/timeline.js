// Timeline: ruler + segment lane + element lanes. Drag to move, edges to trim.
import { timecode } from '/core/time.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const TYPE_COLOR = { image: '#3b6ea5', video: '#2f8f6b', text: '#a06a2b', shape: '#8a4b8f', solid: '#666' };

export class Timeline {
  constructor(root, { onSeek, onSelect, onOp, onSegment }) {
    this.root = root;
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onOp = onOp;
    this.onSegment = onSegment;
    this.project = null;
    this.time = 0;
    this.segmentId = null;
    this.elementId = null;
    this.zoom = 1;
    this.pps = 60;
    this._build();
    window.addEventListener('resize', () => this._layout());
  }

  _build() {
    this.root.classList.add('tl');
    this.scroll = el('div', 'tl-scroll');
    this.inner = el('div', 'tl-inner');
    this.scroll.appendChild(this.inner);
    this.root.appendChild(this.scroll);

    this.rulerRow = el('div', 'tl-row tl-ruler');
    this.rulerGutter = el('div', 'tl-gutter', '<span>时间轴</span>');
    this.rulerTrack = el('div', 'tl-track');
    this.rulerRow.append(this.rulerGutter, this.rulerTrack);

    this.segRow = el('div', 'tl-row tl-segrow');
    this.segGutter = el('div', 'tl-gutter', '<span>分镜</span>');
    this.segTrack = el('div', 'tl-track');
    this.segRow.append(this.segGutter, this.segTrack);

    this.elsWrap = el('div', 'tl-els');
    this.playhead = el('div', 'tl-playhead');
    this.inner.append(this.rulerRow, this.segRow, this.elsWrap, this.playhead);

    this.inner.addEventListener('pointerdown', (e) => this._down(e));
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const dir = e.deltaY > 0 ? 0.9 : 1.1;
        this.zoom = Math.max(0.15, Math.min(8, this.zoom * dir));
        this._layout();
      }
    }, { passive: false });
    this.rulerTrack.addEventListener('dblclick', () => this.fit());
  }

  setProject(p) {
    const firstLoad = !this.project;
    const durChanged = this.project && this.project.meta.duration !== p.meta.duration;
    this.project = p;
    if (firstLoad || durChanged) this._fitOnce = true;
    this.render();
  }

  setSelection(sel) {
    this.segmentId = sel?.segmentId || null;
    this.elementId = sel?.elementId || null;
    this._paintSelection();
  }

  setTime(t) {
    this.time = t;
    const x = this._trackX(t);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.scroll.scrollLeft > x - 20) this.scroll.scrollLeft = Math.max(0, x - 80);
  }

  fit() {
    const w = this.scroll.clientWidth - 150;
    this.zoom = Math.max(0.15, Math.min(8, w / Math.max(1, this.project?.meta.duration || 12) / 60));
    this._layout();
  }

  _gutter() { return 132; }
  _trackX(t) { return this._gutter() + t * this.pps; }
  _timeAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    const x = clientX - r.left + this.scroll.scrollLeft - this._gutter();
    return Math.max(0, x / this.pps);
  }

  _layout() {
    if (!this.project) return;
    if (this._fitOnce) {
      this.pps = Math.max(8, ((this.scroll.clientWidth - this._gutter() - 24) / Math.max(1, this.project.meta.duration)) );
      this._fitOnce = false;
    } else {
      this.pps = 60 * this.zoom;
    }
    this.render();
  }

  _snap(t) {
    if (this._noSnap) return t;
    const p = this.project;
    const tol = 7 / this.pps;
    const cands = [0, p.meta.duration, ...(p.meta.beats || [])];
    for (const s of p.segments) { cands.push(s.start, s.start + s.duration); }
    let best = t, bd = tol;
    for (const c of cands) {
      const d = Math.abs(c - t);
      if (d < bd) { bd = d; best = c; }
    }
    return Math.max(0, best);
  }

  render() {
    const p = this.project;
    if (!p) return;
    if (!this.pps) this._layout();
    const dur = p.meta.duration;
    const totalW = this._gutter() + dur * this.pps + 60;
    this.inner.style.width = `${totalW}px`;
    this.inner.style.minHeight = '100%';

    // ruler
    this.rulerTrack.innerHTML = '';
    const step = this.pps > 90 ? 1 : this.pps > 40 ? 2 : this.pps > 18 ? 5 : 10;
    for (let t = 0; t <= dur + 0.001; t += step) {
      const tick = el('div', 'tl-tick');
      tick.style.left = `${t * this.pps}px`;
      const lab = el('span', 'tl-ticklabel', step >= 1 ? fmtTick(t) : timecode(t, p.meta.fps));
      tick.appendChild(lab);
      this.rulerTrack.appendChild(tick);
    }
    // camera path keys live on the ruler so 3D shots are scrubbable
    if (p.camera) {
      for (const k of p.camera.path) {
        const tag = el('div', 'tl-camkey');
        tag.style.left = `${k.t * this.pps}px`;
        tag.title = `相机关键点 ${k.t.toFixed(2)}s`;
        tag.dataset.t = String(k.t);
        tag.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.onSeek?.(k.t); });
        this.rulerTrack.appendChild(tag);
      }
    }
    for (const b of (p.meta.beats || [])) {
      const bt = el('div', 'tl-beat');
      bt.style.left = `${b * this.pps}px`;
      this.rulerTrack.appendChild(bt);
    }

    // segments
    this.segTrack.innerHTML = '';
    this.segTrack.style.height = '34px';
    for (const s of p.segments) {
      const b = el('div', 'blk seg');
      b.dataset.id = s.id;
      b.style.left = `${s.start * this.pps}px`;
      b.style.width = `${Math.max(6, s.duration * this.pps)}px`;
      b.innerHTML = `<span class="blk-name">${escapeHtml(s.name || s.id)}</span><span class="blk-meta">${s.duration.toFixed(2)}s</span>`;
      const h = el('div', 'handle handle-r');
      b.appendChild(h);
      this.segTrack.appendChild(b);
    }

    // element lanes
    this.elsWrap.innerHTML = '';
    const els = [...p.elements].sort((a, b) => b.z - a.z);
    for (const e of els) {
      const row = el('div', 'tl-row tl-elrow');
      const g = el('div', 'tl-gutter');
      g.innerHTML = `<i class="type-dot" style="background:${TYPE_COLOR[e.type] || '#666'}"></i><span title="${escapeHtml(e.name)}">${escapeHtml(e.name || e.id)}</span>`;
      g.dataset.id = e.id;
      const track = el('div', 'tl-track');
      const b = el('div', `blk el t-${e.type}`);
      b.dataset.id = e.id;
      b.style.left = `${e.start * this.pps}px`;
      b.style.width = `${Math.max(4, e.duration * this.pps)}px`;
      const label = e.type === 'text' ? String(e.style.text || '').slice(0, 24) : (e.src || '').split('/').pop();
      b.innerHTML = `<span class="blk-name">${escapeHtml(label || e.id)}</span>`;
      b.appendChild(el('div', 'handle handle-l'));
      b.appendChild(el('div', 'handle handle-r'));
      b.style.setProperty('--c', TYPE_COLOR[e.type] || '#666');
      track.appendChild(b);
      row.append(g, track);
      this.elsWrap.appendChild(row);
    }

    // element lane height: 26px rows handled by CSS
    this.setTime(this.time);
    this._paintSelection();
  }

  _paintSelection() {
    this.inner.querySelectorAll('.blk.sel').forEach((n) => n.classList.remove('sel'));
    if (this.elementId) {
      const b = this.inner.querySelector(`.blk.el[data-id="${this.elementId}"]`);
      b?.classList.add('sel');
    }
    if (this.segmentId) {
      const b = this.inner.querySelector(`.blk.seg[data-id="${this.segmentId}"]`);
      b?.classList.add('sel');
    }
  }

  _down(ev) {
    ev.preventDefault();
    const target = ev.target;
    this._noSnap = ev.altKey;
    const blk = target.closest?.('.blk');
    const gutterEl = target.closest?.('.tl-gutter[data-id]');

    if (blk) {
      const id = blk.dataset.id;
      const isSeg = blk.classList.contains('seg');
      if (isSeg) {
        this.segmentId = id;
        this.onSegment?.(id);
      } else {
        this.elementId = id;
        this.onSelect?.({ elementId: id, segmentId: this.project.elements.find((e) => e.id === id)?.segment || null });
      }
      this._paintSelection();

      const p = this.project;
      const item = isSeg ? p.segments.find((s) => s.id === id) : p.elements.find((e) => e.id === id);
      if (!item) return;
      const mode = target.classList.contains('handle-l') ? 'l'
        : target.classList.contains('handle-r') ? 'r' : 'move';
      const startX = ev.clientX;
      const t0 = this._timeAt(ev.clientX);
      const orig = { start: item.start, duration: item.duration };

      const move = (e) => {
        this._noSnap = e.altKey;
        const t = this._timeAt(e.clientX);
        let dt = t - t0;
        let ns = orig.start, nd = orig.duration;
        if (mode === 'move') {
          ns = this._snap(orig.start + dt);
          ns = Math.max(0, ns);
        } else if (mode === 'r') {
          let end = this._snap(orig.start + orig.duration + dt);
          nd = Math.max(0.08, end - orig.start);
        } else {
          let s = this._snap(orig.start + dt);
          s = Math.min(orig.start + orig.duration - 0.08, Math.max(0, s));
          nd = Math.max(0.08, orig.start + orig.duration - s);
          ns = s;
        }
        if (isSeg) {
          blk.style.left = `${ns * this.pps}px`;
          blk.style.width = `${nd * this.pps}px`;
        } else {
          blk.style.left = `${ns * this.pps}px`;
          blk.style.width = `${nd * this.pps}px`;
        }
        blk._ns = ns; blk._nd = nd;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const ns = blk._ns, nd = blk._nd;
        if (ns == null || (Math.abs(ns - orig.start) < 1e-4 && Math.abs(nd - orig.duration) < 1e-4)) return;
        if (isSeg) this.onOp({ op: 'updateSegment', id, patch: { start: round3(ns), duration: round3(nd) } });
        else this.onOp({ op: 'moveElement', id, start: round3(ns), duration: round3(nd) });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    if (gutterEl) {
      this.onSelect?.({ elementId: gutterEl.dataset.id });
      this.elementId = gutterEl.dataset.id;
      this._paintSelection();
      return;
    }

    // seek anywhere on the tracks
    const t = this._snap(this._timeAt(ev.clientX));
    this.onSeek?.(t);
    const move = (e) => {
      this._noSnap = e.altKey;
      this.onSeek?.(this._snap(this._timeAt(e.clientX)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const fmtTick = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { escapeHtml };
