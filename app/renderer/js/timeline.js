// Timeline: ruler + segment lane + camera element + 3D element rows.
// Element rows expand in place: the left column edits the element's properties
// and the right lanes show per-property keyframes, all on the same row grid.
// The camera is an element too: its attributes are folded inside the camera
// row, and the flight path is one "摄像机位置" property whose keyframes are
// the diamonds on that row's lane.
import { timecode } from '/core/time.js';
import { objectPose } from '/core/scene.js';
import { pathPos } from '/core/camera.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const TYPE_COLOR = { image: '#3b6ea5', video: '#2f8f6b', text: '#a06a2b', shape: '#8a4b8f', solid: '#666' };
const AX = ['x', 'y', 'z'];

export class Timeline {
  constructor(root, { onSeek, onSelect, onOp, onSegment, onPause, onElementMenu, onCameraMenu } = {}) {
    this.root = root;
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onOp = onOp;
    this.onSegment = onSegment;
    this.onPause = onPause;
    this.onElementMenu = onElementMenu;
    this.onCameraMenu = onCameraMenu;
    this.project = null;
    this.time = 0;
    this.segmentId = null;
    this.elementId = null;
    this.objectId = null;
    this.cameraSel = false;
    this.camOpenId = null;
    this.soloCameras = new Set();
    this._camPos = null;
    this._camDrag = null;
    this.zoom = 1;
    this.pps = 60;
    this.expanded = new Set();
    this.sections = { content: true, transform: true, camPos: true, camMain: false, camShake: false, camDof: false };
    this.propSel = null;
    this._autoObj = null;
    this._scrollTo = null;
    this._pending = new Map();
    this._editTimes = new Map();
    this._propRows = [];
    this._objHeads = new Map();
    this._anyPointerDown = false;
    this._pendingRender = false;
    // Expanding the timeline resizes the stage; if the user is dragging an
    // element in the viewport, delay the expansion until the pointer is up so
    // the drag's screen mapping does not jump under the cursor.
    window.addEventListener('pointerdown', () => { this._anyPointerDown = true; }, true);
    const release = () => {
      this._anyPointerDown = false;
      if (!this._pendingRender) return;
      this._pendingRender = false;
      this.render(true);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
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
    this.rulerGutter = el('div', 'tl-gutter');
    this.timeLabel = el('span', 'tl-sub');
    this.rulerGutter.append(el('span', '', '时间轴'), this.timeLabel);
    this.rulerTrack = el('div', 'tl-track');
    this.rulerRow.append(this.rulerGutter, this.rulerTrack);

    this.segRow = el('div', 'tl-row tl-segrow');
    this.segGutter = el('div', 'tl-gutter', '<span>分镜</span>');
    this.segTrack = el('div', 'tl-track');
    this.segRow.append(this.segGutter, this.segTrack);

    this.camHead = el('div', 'tl-row tl-sechead tl-camsec');
    this.camHeadGutter = el('div', 'tl-gutter', '<span>相机</span>');
    this.camHeadTrack = el('div', 'tl-track');
    this.camHead.append(this.camHeadGutter, this.camHeadTrack);

    this.camsWrap = el('div', 'tl-cams');
    this.elsWrap = el('div', 'tl-els');
    this.playhead = el('div', 'tl-playhead');
    this.inner.append(this.rulerRow, this.segRow, this.camHead, this.camsWrap, this.elsWrap, this.playhead);

    const hint = el('div', 'tl-hint');
    hint.innerHTML = '<span>▾ 元素 / 相机展开</span><span class="tl-hint-sep">|</span>'
      + '<span>中心点 / 位置 / 缩放 各 3 维</span><span class="tl-hint-sep">|</span>'
      + '<span>拖播放头，数值按关键帧实时同步</span><span class="tl-hint-sep">|</span>'
      + '<span><b>◆</b> 打帧 / 删帧</span>';
    this.root.appendChild(hint);

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

  // ------------------------------------------------------------ state
  setProject(p) {
    const firstLoad = !this.project;
    const durChanged = this.project && this.project.meta.duration !== p.meta.duration;
    this.project = p;
    if (firstLoad || durChanged) {
      this._fitOnce = true;
      this._layout();
    } else {
      this.render();
    }
  }

  setSelection(sel) {
    const prev = this.objectId;
    this.segmentId = sel?.segmentId || null;
    this.elementId = sel?.elementId || null;
    this.objectId = sel?.objectId || null;
    this.cameraSel = !!sel?.camera;
    const id = this.objectId;
    if (!id) this._autoObj = null;
    let force = false;
    if (id && id !== this._autoObj && !this.expanded.has(id)) {
      this.expanded.add(id);
      this._autoObj = id;
      this._scrollTo = id;
      force = true;
    } else if (id && id !== prev) {
      force = true;
    }
    if (id !== prev) this.propSel = null;
    if (force) {
      if (this._anyPointerDown) {
        this._pendingRender = true;
        this._paintSelection();
      } else {
        this.render(true);
      }
    } else {
      this._paintSelection();
      this._updateHeight();
    }
  }

  setTime(t) {
    this.time = t;
    const dur = this.project?.meta.duration || 12;
    if (this.timeLabel) this.timeLabel.textContent = `${t.toFixed(2)} / ${dur.toFixed(2)}s`;
    const x = this._trackX(t);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.scroll.scrollLeft > x - 20) this.scroll.scrollLeft = Math.max(0, x - 80);
    this._syncProps(true);
  }

  fit() {
    const w = this.scroll.clientWidth - this._gutter() - 24;
    this.zoom = Math.max(0.15, Math.min(8, w / Math.max(1, this.project?.meta.duration || 12) / 60));
    this._layout();
  }

  _gutter() { return 360; }
  _trackX(t) { return this._gutter() + t * this.pps; }
  _timeAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    const x = clientX - r.left + this.scroll.scrollLeft - this._gutter();
    return Math.max(0, x / this.pps);
  }

  _layout() {
    if (!this.project) return;
    if (this._fitOnce) {
      this.pps = Math.max(8, ((this.scroll.clientWidth - this._gutter() - 24) / Math.max(1, this.project.meta.duration)));
      this._fitOnce = false;
    } else {
      this.pps = 60 * this.zoom;
    }
    this.render(true);
  }

  _updateHeight() {
    const app = document.querySelector('#app');
    const open = (!!this.camOpenId && !!this.project?.camera) || this.expanded.size > 0;
    if (app) app.classList.toggle('tl-expanded', open);
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

  // ------------------------------------------------------------ render
  render(force = false) {
    const p = this.project;
    if (!p) return;
    if (!this.pps) { this._layout(); return; }
    const active = document.activeElement;
    const typing = !force && this.root.contains(active)
      && /INPUT|SELECT|TEXTAREA/.test(active?.tagName || '');
    if (typing) { this._syncProps(); return; }

    const dur = p.meta.duration;
    this.inner.style.width = `${this._gutter() + dur * this.pps + 60}px`;
    this.inner.style.minHeight = '100%';

    const objs = Array.isArray(p.scene?.objects) ? p.scene.objects : [];
    const ids = new Set(objs.map((o) => o.id));
    for (const id of [...this.expanded]) if (!ids.has(id)) this.expanded.delete(id);

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
    this.segGutter.innerHTML = `<span>分镜</span><span class="tl-sub">${p.segments.length} 个</span>`;
    for (const s of p.segments) {
      const b = el('div', 'blk seg');
      b.dataset.id = s.id;
      b.style.left = `${s.start * this.pps}px`;
      b.style.width = `${Math.max(6, s.duration * this.pps)}px`;
      b.innerHTML = `<span class="blk-name">${escapeHtml(s.name || s.id)}</span><span class="blk-meta">${s.duration.toFixed(2)}s</span>`;
      b.appendChild(el('div', 'handle handle-r'));
      this.segTrack.appendChild(b);
    }

    // camera stack: a section header + one row per camera (top of the stack
    // first). The expanded camera is always the active one.
    const cams = Array.isArray(p.cameras) && p.cameras.length ? p.cameras : (p.camera ? [p.camera] : []);
    this.camHeadGutter.innerHTML = cams.length
      ? `<span>相机</span><span class="tl-sub">${cams.length} 台</span>`
      : '<span>相机 · 无</span>';
    this.camHeadGutter.classList.toggle('dim', !cams.length);
    this.camsWrap.innerHTML = '';
    this._camPos = null;
    if (this.camOpenId && p.activeCameraId && this.camOpenId !== p.activeCameraId) this.camOpenId = null;
    if (this.camOpenId && !cams.some((c) => c.id === this.camOpenId)) this.camOpenId = null;
    for (const cam of cams) this._cameraGroup(cam, p);

    // v2 (2D) element lanes, then the 3D objects
    this.elsWrap.innerHTML = '';
    this._propRows = [];
    this._objHeads = new Map();
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
    this._build3D(p, objs);

    this.setTime(this.time);
    this._paintSelection();
    this._updateHeight();
    if (this._scrollTo) {
      const id = this._scrollTo;
      this._scrollTo = null;
      this._scrollObject(id);
    }
  }

  _build3D(p, objs) {
    if (!objs.length) return;
    const head = el('div', 'tl-row tl-sechead');
    head.append(
      el('div', 'tl-gutter', `<span>元素 · 3D</span><span class="tl-sub">${objs.length} 个</span>`),
      el('div', 'tl-track'),
    );
    this.elsWrap.appendChild(head);
    for (const o of objs) this._objectGroup(o);
  }

  // ------------------------------------------------------------ camera stack
  _activeCameraId() {
    return this.project?.activeCameraId || this.project?.camera?.id || null;
  }

  _activateCamera(id) {
    if (!id) return;
    if (this._activeCameraId() !== id) this.camOpenId = null;
    this.cameraSel = true;
    this.onSelect?.({ camera: true });
    this._paintSelection();
    if (this._activeCameraId() === id) return;
    const r = this.onOp?.({ op: 'activateCamera', id });
    if (r?.then) r.then(() => this.render(true)).catch(() => {});
  }

  _toggleCam(id) {
    if (!id) return;
    if (this.camOpenId === id) {
      this.camOpenId = null;
      this.render(true);
      return;
    }
    this.camOpenId = id;
    this.cameraSel = true;
    this.onSelect?.({ camera: true });
    if (this._activeCameraId() !== id) {
      const r = this.onOp?.({ op: 'activateCamera', id });
      if (r?.then) r.then(() => this.render(true)).catch(() => {});
      else this.render(true);
    } else {
      this.render(true);
    }
  }

  setSoloCameras(ids) {
    this.soloCameras = new Set(ids || []);
    this.render(true);
  }

  _startCameraDrag(id, startY, row) {
    const rows = [...this.camsWrap.querySelectorAll('.tl-camhead[data-cam]')];
    if (rows.length < 2) return;
    const from = rows.findIndex((r) => r.dataset.cam === id);
    if (from < 0) return;
    let target = from;
    let moved = false;
    row.classList.add('cam-dragging');
    const move = (e) => {
      if (!moved && Math.abs(e.clientY - startY) < 4) return;
      moved = true;
      let best = Infinity;
      rows.forEach((r, i) => {
        const b = r.getBoundingClientRect();
        const d = Math.abs(e.clientY - (b.top + b.height / 2));
        if (d < best) { best = d; target = i; }
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      row.classList.remove('cam-dragging');
      if (moved && target !== from) this.onOp?.({ op: 'reorderCamera', id, index: target });
      // 拖动后激活被拖的相机；单击（没移动）也算选中
      this._activateCamera(id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  _cameraGroup(cam, p) {
    const activeId = p.activeCameraId || p.camera?.id || null;
    const open = this.camOpenId === cam.id;
    const row = el('div', 'tl-row tl-objhead tl-camhead tl-camrow');
    row.dataset.cam = cam.id;
    row.classList.toggle('sel', cam.id === activeId && this.cameraSel);
    row.classList.toggle('cam-hidden', cam.visible === false);
    row.classList.toggle('solo-hidden', this.soloCameras.size > 0 && !this.soloCameras.has(cam.id));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onCameraMenu?.(cam.id, e.clientX, e.clientY);
    });

    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    const eye = el('button', 'tl-objeye', '◉');
    eye.title = cam.visible === false ? '显示该相机' : '隐藏该相机（变换仍作用于子集）';
    if (cam.visible === false) eye.classList.add('off');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onOp?.({ op: 'cameraPatch', id: cam.id, patch: { visible: cam.visible === false } });
    });
    const caret = el('button', 'tl-objtoggle', open ? '▾' : '▸');
    caret.title = open ? '折叠相机属性' : '展开相机属性';
    caret.addEventListener('click', (e) => { e.stopPropagation(); this._toggleCam(cam.id); });
    const dot = el('span', 'tl-camdot');
    const name = el('span', 'tl-objname');
    name.textContent = cam.name || '相机';
    name.title = '相机';
    const kind = el('span', 'tl-objkind', 'CAM');
    g.append(eye, caret, dot, name, kind);

    const track = el('div', 'tl-track');
    const block = el('div', 'blk cam');
    block.dataset.cam = cam.id;
    block.style.left = '0px';
    block.style.width = `${Math.max(8, p.meta.duration * this.pps)}px`;
    block.innerHTML = `<span class="blk-name">${escapeHtml(cam.name || '镜头')}</span><span class="blk-meta">${(cam.path || []).length} 关键点</span>`;
    track.appendChild(block);
    row.append(g, track);
    this.camsWrap.appendChild(row);
    if (open) this._cameraRows(cam, this.camsWrap);
  }

  _cameraRows(cam, host) {
    const set = (patch) => this.onOp?.({ op: 'cameraSet', patch });

    // One "摄像机位置" property. Its lane diamonds are the flight keys.
    host.appendChild(this._sectionRow('变换', 'camPos'));
    if (this.sections.camPos) host.appendChild(this._camPosRow());

    const lensSummary = `FOV ${Math.round(cam.fov)}°${cam.fov >= 180 ? ' · 鱼眼' : ''}`;
    const shakeSummary = `${round2(cam.shake.amp)}m · ${cam.shake.freq}Hz`;
    const dofSummary = `f/${cam.dof.fstop} · 模糊 ${Math.round((cam.motionBlur.shutter || 0) * 360)}°`;
    host.appendChild(this._sectionRow('镜头 / 构图', 'camMain', lensSummary));
    if (this.sections.camMain) {
      host.appendChild(this._camNumRow('视场角 FOV', cam.fov, {
        step: 1, min: 1, max: 360,
        badge: cam.fov >= 180 ? '鱼眼' : '',
        apply: (v) => set({ fov: v }),
      }));
      host.appendChild(this._camHintRow('≥180° 自动切等距鱼眼（可到 360°）；Blender 侧用 Cycles 渲这一档。'));
      host.appendChild(this._camNumRow('看向前方 (m)', cam.lookAhead, {
        step: 5, min: 2, max: 500, apply: (v) => set({ lookAhead: v }),
      }));
      host.appendChild(this._camNumRow('转弯侧倾', cam.bankGain, {
        step: 0.1, min: 0, max: 4, apply: (v) => set({ bankGain: v }),
      }));
      host.appendChild(this._camNumRow('最大侧倾°', cam.maxRoll, {
        step: 1, min: 0, max: 60, apply: (v) => set({ maxRoll: v }),
      }));
      host.appendChild(this._camNumRow('手动 roll°', cam.roll || 0, {
        step: 1, min: -60, max: 60, apply: (v) => set({ roll: v }),
      }));
    }

    host.appendChild(this._sectionRow('抖动', 'camShake', shakeSummary));
    if (this.sections.camShake) {
      host.appendChild(this._camNumRow('抖动幅度', cam.shake.amp, {
        step: 0.05, min: 0, max: 5, apply: (v) => set({ shake: { ...cam.shake, amp: v } }),
      }));
      host.appendChild(this._camNumRow('抖动频率', cam.shake.freq, {
        step: 0.1, min: 0.1, max: 8, apply: (v) => set({ shake: { ...cam.shake, freq: v } }),
      }));
      host.appendChild(this._camNumRow('随速度增强', cam.shake.speedGain, {
        step: 0.1, min: 0, max: 2, apply: (v) => set({ shake: { ...cam.shake, speedGain: v } }),
      }));
      host.appendChild(this._camNumRow('随机种子', cam.shake.seed, {
        step: 1, apply: (v) => set({ shake: { ...cam.shake, seed: v } }),
      }));
    }

    host.appendChild(this._sectionRow('景深 / 模糊', 'camDof', dofSummary));
    if (this.sections.camDof) {
      host.appendChild(this._camSelectRow('景深', String(!!cam.dof.enabled), [['false', '关'], ['true', '开']],
        (v) => set({ dof: { ...cam.dof, enabled: v === 'true' } })));
      host.appendChild(this._camNumRow('光圈 f', cam.dof.fstop, {
        step: 0.2, min: 0.5, max: 32, apply: (v) => set({ dof: { ...cam.dof, fstop: v } }),
      }));
      host.appendChild(this._camSelectRow('运动模糊', String(!!cam.motionBlur.enabled), [['true', '开'], ['false', '关']],
        (v) => set({ motionBlur: { ...cam.motionBlur, enabled: v === 'true' } })));
      host.appendChild(this._camNumRow('快门角', cam.motionBlur.shutter, {
        step: 0.05, min: 0, max: 1, apply: (v) => set({ motionBlur: { ...cam.motionBlur, shutter: v } }),
      }));
    }
  }

  _camPosRow() {
    const row = el('div', 'tl-row tl-camprop tl-camposrow');
    const g = el('div', 'tl-gutter');
    g.appendChild(el('span', 'tl-plabel', '摄像机位置'));
    const inputs = [];
    for (const ax of AX) {
      const { box, inp } = this._numBox(ax, ax.toUpperCase());
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this._editTimes.set('camera:position', round3(this.time));
        this._schedule('camera:position', () => this._commitCamPos());
      });
      inp.addEventListener('blur', () => { this._flush('camera:position'); this._syncProps(); });
      inputs.push(inp);
      g.appendChild(box);
    }
    const kf = el('button', 'tl-kf', '◆');
    kf.title = '在当前时间打点 / 删点';
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleCamKey(); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._camPos = { inputs, kf, lane, sig: '', keys: [] };
    this._refreshCamLane();
    return row;
  }

  _commitCamPos() {
    const cam = this.project?.camera;
    const posRow = this._camPos;
    if (!cam || !posRow) return;
    const v = posRow.inputs.map((i) => Number(i.value));
    if (v.some((n) => !Number.isFinite(n))) return;
    const t = this._editTimes.get('camera:position') ?? round3(this.time);
    const old = cam.path.find((k) => Math.abs(k.t - t) <= 1e-4);
    this.onOp?.({ op: 'cameraKey', t, pos: v, look: old?.look ?? null, fov: old?.fov ?? null });
  }

  _toggleCamKey() {
    const cam = this.project?.camera;
    if (!cam) return;
    this.onPause?.();
    const t = round3(this.time);
    const key = cam.path.find((k) => Math.abs(k.t - t) < 1e-3);
    if (key) {
      this.onOp?.({ op: 'cameraRemove', t: key.t });
      return;
    }
    const pos = pathPos(cam, this.time).map(round3);
    this.onOp?.({ op: 'cameraKey', t, pos });
  }

  _refreshCamLane() {
    const posRow = this._camPos;
    const cam = this.project?.camera;
    if (!posRow || !cam) return;
    const keys = cam.path.map((k) => round3(k.t)).sort((a, b) => a - b);
    const sig = keys.join(',');
    if (sig !== posRow.sig) {
      posRow.sig = sig;
      posRow.lane.innerHTML = '';
      posRow.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.cam = '1';
        d.dataset.t = String(t);
        d.style.left = `${t * this.pps}px`;
        d.title = `摄像机位置 · ${t.toFixed(2)}s`;
        posRow.lane.appendChild(d);
        return { t, node: d };
      });
    }
    for (const k of posRow.keys) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 5e-4);
  }

  _camNumRow(label, value, { step = 0.1, min, max, apply, badge = '' } = {}) {
    const row = el('div', 'tl-row tl-camprop');
    const g = el('div', 'tl-gutter');
    g.appendChild(el('span', 'tl-plabel', label));
    const { box, inp } = this._numBox('d', '');
    box.classList.add('tl-camnum');
    inp.step = String(step);
    if (min != null) inp.min = String(min);
    if (max != null) inp.max = String(max);
    inp.value = String(round2(value));
    const key = `cam:${label}`;
    inp.addEventListener('focus', () => this.onPause?.());
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      this._schedule(key, () => apply(v));
    });
    inp.addEventListener('blur', () => this._flush(key));
    g.appendChild(box);
    if (badge) g.appendChild(el('span', 'tl-camfish', badge));
    row.append(g, el('div', 'tl-track'));
    return row;
  }

  _camSelectRow(label, value, options, apply) {
    const row = el('div', 'tl-row tl-camprop');
    const g = el('div', 'tl-gutter');
    g.appendChild(el('span', 'tl-plabel', label));
    const sel = document.createElement('select');
    sel.className = 'tl-camselect';
    for (const [v, lab] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = lab;
      o.selected = String(v) === String(value);
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => apply(sel.value));
    g.appendChild(sel);
    row.append(g, el('div', 'tl-track'));
    return row;
  }

  _camHintRow(text) {
    const row = el('div', 'tl-row tl-camhint');
    const g = el('div', 'tl-gutter');
    const span = el('span', 'tl-camhint-text');
    span.textContent = text;
    g.appendChild(span);
    row.append(g, el('div', 'tl-track'));
    return row;
  }

  _objectGroup(o) {
    const open = this.expanded.has(o.id);
    const row = el('div', 'tl-row tl-objhead');
    row.dataset.obj = o.id;
    row.classList.toggle('sel', o.id === this.objectId);
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    const caret = el('button', 'tl-objtoggle', open ? '▾' : '▸');
    caret.title = open ? '折叠属性' : '展开属性';
    caret.addEventListener('click', (e) => { e.stopPropagation(); this._toggleExpand(o.id); });
    const eye = el('button', 'tl-objeye', '◉');
    eye.title = o.visible === false ? '显示' : '隐藏';
    if (o.visible === false) eye.classList.add('off');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onOp?.({ op: 'objectPatch', id: o.id, patch: { visible: o.visible === false } });
    });
    const dot = el('span', 'tl-objdot');
    dot.style.background = o.style?.color || '#17d9ff';
    const name = el('span', 'tl-objname');
    name.textContent = o.name || o.id;
    name.title = '双击重命名';
    name.addEventListener('dblclick', () => this._inlineName(name, o));
    const kind = el('span', 'tl-objkind', '3D');
    const more = el('button', 'tl-objmore', '⋯');
    more.title = '元素操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      this.onElementMenu?.(o.id, e.clientX || r.left, (e.clientY || r.bottom) + 2);
    });
    g.append(caret, eye, dot, name, kind, more);

    const track = el('div', 'tl-track');
    const block = el('div', 'blk ob');
    block.dataset.obj = o.id;
    block.style.left = `${(Number(o.start) || 0) * this.pps}px`;
    block.style.width = `${Math.max(4, (Number(o.duration) || 0) * this.pps)}px`;
    block.innerHTML = `<span class="blk-name">${escapeHtml(o.name || o.id)}</span><span class="blk-meta">${(Number(o.duration) || 0).toFixed(2)}s</span>`;
    block.appendChild(el('div', 'handle handle-l'));
    block.appendChild(el('div', 'handle handle-r'));
    track.appendChild(block);
    row.append(g, track);
    this.elsWrap.appendChild(row);
    this._objHeads.set(o.id, { row, g, eye, name, dot, block });

    if (!open) return;
    if (this.sections.content) {
      this.elsWrap.appendChild(this._sectionRow('内容', 'content'));
      this.elsWrap.appendChild(this._geomRow(o));
      this.elsWrap.appendChild(this._colorRow(o));
    }
    if (this.sections.transform) {
      this.elsWrap.appendChild(this._sectionRow('变换', 'transform', 'm / 倍'));
      for (const [path, label] of [['pivot', '中心点'], ['position', '位置'], ['scale', '缩放']]) {
        this.elsWrap.appendChild(this._vecRow(o, path, label));
      }
      this.elsWrap.appendChild(this._opacityRow(o));
    }
  }

  _sectionRow(title, key, hint = '') {
    const row = el('div', 'tl-row tl-sect');
    const g = el('div', 'tl-gutter');
    g.append(el('span', 'tl-seccaret', this.sections[key] ? '▾' : '▸'), el('span', '', title));
    if (hint) g.append(el('span', 'tl-sub', hint));
    row.append(g, el('div', 'tl-track'));
    row.addEventListener('click', () => {
      this.sections[key] = !this.sections[key];
      this.render(true);
    });
    return row;
  }

  _numBox(axis, letter) {
    const box = el('span', 'tl-num');
    if (letter) box.appendChild(el('i', axis ? `axis-${axis}` : 'axis-d', letter));
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.1';
    box.appendChild(inp);
    return { box, inp };
  }

  _geomRow(o) {
    const row = el('div', 'tl-row tl-prop');
    row.dataset.obj = o.id;
    row.dataset.path = 'geom';
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(el('span', 'tl-plabel', '几何'));
    const inputs = [];
    for (const [ax, letter] of [['w', 'W'], ['h', 'H'], ['d', 'D']]) {
      const { box, inp } = this._numBox('d', letter);
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this._editTimes.set(`${o.id}:geom`, round3(this.time));
        this._schedule(`${o.id}:geom`, () => this._commitGeom(o.id));
      });
      inp.addEventListener('blur', () => { this._flush(`${o.id}:geom`); this._syncProps(); });
      inputs.push(inp);
      g.appendChild(box);
    }
    g.appendChild(el('span', 'tl-keyspace'));
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path: 'geom', kind: 'geom', inputs, lane, row, sig: '' });
    return row;
  }

  _colorRow(o) {
    const row = el('div', 'tl-row tl-prop');
    row.dataset.obj = o.id;
    row.dataset.path = 'color';
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(el('span', 'tl-plabel', '颜色'));
    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'tl-color';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'tl-hex';
    hex.spellcheck = false;
    color.addEventListener('input', () => {
      this._editTimes.set(`${o.id}:color`, round3(this.time));
      this._schedule(`${o.id}:color`, () => this._commitColor(o.id, color.value));
    });
    color.addEventListener('blur', () => { this._flush(`${o.id}:color`); this._syncProps(); });
    hex.addEventListener('change', () => {
      const v = String(hex.value || '').trim();
      if (/^#?[0-9a-f]{6}$/i.test(v)) this.onOp?.({ op: 'objectPatch', id: o.id, patch: { style: { ...(o.style || {}), color: v.startsWith('#') ? v : `#${v}` } } });
      else this._syncProps();
    });
    g.append(color, hex, el('span', 'tl-keyspace'));
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path: 'color', kind: 'color', inputs: [], color, hex, lane, row, sig: '' });
    return row;
  }

  _vecRow(o, path, label) {
    const row = el('div', 'tl-row tl-prop');
    row.dataset.obj = o.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(el('span', 'tl-plabel', label));
    const inputs = [];
    for (const ax of AX) {
      const { box, inp } = this._numBox(ax, ax.toUpperCase());
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this._editTimes.set(`${o.id}:${path}`, round3(this.time));
        this._schedule(`${o.id}:${path}`, () => this._commitVec(o.id, path));
      });
      inp.addEventListener('blur', () => { this._flush(`${o.id}:${path}`); this._syncProps(); });
      inputs.push(inp);
      g.appendChild(box);
    }
    const kf = el('button', 'tl-kf', '◆');
    kf.title = '在当前时间打帧 / 删帧';
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleKey(o.id, path); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path, kind: 'vec', inputs, kf, lane, row, sig: '' });
    return row;
  }

  _opacityRow(o) {
    const row = el('div', 'tl-row tl-prop');
    row.dataset.obj = o.id;
    row.dataset.path = 'opacity';
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(el('span', 'tl-plabel', '不透明度'));
    const { box, inp } = this._numBox('d', '');
    box.classList.add('tl-scalar');
    inp.min = '0';
    inp.max = '1';
    inp.addEventListener('focus', () => this.onPause?.());
    inp.addEventListener('input', () => {
      this._editTimes.set(`${o.id}:opacity`, round3(this.time));
      this._schedule(`${o.id}:opacity`, () => this._commitOpacity(o.id));
    });
    inp.addEventListener('blur', () => { this._flush(`${o.id}:opacity`); this._syncProps(); });
    g.appendChild(box);
    const kf = el('button', 'tl-kf', '◆');
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleKey(o.id, 'opacity'); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path: 'opacity', kind: 'opacity', inputs: [inp], kf, lane, row, sig: '' });
    return row;
  }

  // ------------------------------------------------------------ values / keys
  _obj(id) {
    return (this.project?.scene?.objects || []).find((o) => o.id === id) || null;
  }

  _propKeys(o, path) {
    const tracks = o.tracks || {};
    const out = new Set();
    const add = (list) => {
      for (const k of list || []) if (Number.isFinite(Number(k.t))) out.add(Math.round(Number(k.t) * 1000) / 1000);
    };
    if (path === 'opacity') add(tracks.opacity);
    else {
      add(tracks[path]);
      for (const ax of AX) add(tracks[`${path}.${ax}`]);
    }
    return [...out].sort((a, b) => a - b);
  }

  _refreshLane(pr, o) {
    const keys = this._propKeys(o, pr.path);
    const sig = keys.join(',');
    if (sig !== pr.sig) {
      pr.sig = sig;
      pr.lane.innerHTML = '';
      pr.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.obj = o.id;
        d.dataset.path = pr.path;
        d.dataset.t = String(t);
        d.style.left = `${t * this.pps}px`;
        d.title = `${pr.path} · ${t.toFixed(2)}s`;
        pr.lane.appendChild(d);
        return { t, node: d };
      });
    }
    for (const k of pr.keys || []) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 5e-4);
  }

  _syncProps(force = false) {
    const t = this.time;
    const set = (inp, v) => {
      if (!inp) return;
      if (!force && document.activeElement === inp) return;
      const n = Math.round(Number(v) * 100) / 100;
      if (inp.value !== String(n)) inp.value = String(n);
    };
    for (const pr of this._propRows) {
      const o = this._obj(pr.objId);
      if (!o) continue;
      const pose = objectPose(o, t);
      if (pr.kind === 'geom') {
        const g = o.geom || {};
        ['w', 'h', 'd'].forEach((ax, i) => set(pr.inputs[i], Number(g[ax]) || 2));
      } else if (pr.kind === 'color') {
        const color = String(o.style?.color || o.style?.fill || '#17d9ff');
        if (pr.color && document.activeElement !== pr.color) pr.color.value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#17d9ff';
        if (pr.hex && document.activeElement !== pr.hex) pr.hex.value = color;
      } else if (pr.kind === 'opacity') {
        set(pr.inputs[0], pose.opacity);
      } else {
        const arr = pose[pr.path] || [0, 0, 0];
        pr.inputs.forEach((inp, i) => set(inp, arr[i]));
      }
      if (pr.kf) {
        const track = o.tracks?.[pr.path] || [];
        const sub = AX.some((a) => (o.tracks?.[`${pr.path}.${a}`] || []).length > 0);
        const at = track.some((k) => Math.abs(k.t - t) < 1e-3);
        const has = track.length > 0 || sub;
        pr.kf.classList.toggle('on', at);
        pr.kf.classList.toggle('has', !at && has);
        pr.kf.title = at ? '删除这一帧' : has ? `在当前时间打帧（已有 ${track.length} 帧）` : '在当前时间打帧';
      }
      if (pr.kind !== 'geom' && pr.kind !== 'color') this._refreshLane(pr, o);
    }
    const cam = this.project?.camera;
    if (this._camPos && cam) {
      const pos = pathPos(cam, t);
      this._camPos.inputs.forEach((inp, i) => set(inp, pos[i]));
      const at = cam.path.some((k) => Math.abs(k.t - t) < 1e-3);
      const has = cam.path.length > 0;
      this._camPos.kf.classList.toggle('on', at);
      this._camPos.kf.classList.toggle('has', !at && has);
      this._camPos.kf.title = at ? '删除这一帧' : has ? `在当前时间打点（已有 ${cam.path.length} 帧）` : '在当前时间打点';
      this._refreshCamLane();
    }
    for (const [id, h] of this._objHeads) {
      const o = this._obj(id);
      if (!o) continue;
      if (document.activeElement !== h.name && !h.name.querySelector('input')) h.name.textContent = o.name || o.id;
      h.eye.classList.toggle('off', o.visible === false);
      h.eye.title = o.visible === false ? '显示' : '隐藏';
      h.dot.style.background = o.style?.color || '#17d9ff';
      h.row.classList.toggle('sel', id === this.objectId);
      const start = Number(o.start) || 0;
      const dur = Number(o.duration) || 0;
      const left = `${start * this.pps}px`;
      const width = `${Math.max(4, dur * this.pps)}px`;
      if (h.block.style.left !== left) h.block.style.left = left;
      if (h.block.style.width !== width) h.block.style.width = width;
      const nameEl = h.block.querySelector('.blk-name');
      if (nameEl) nameEl.textContent = o.name || o.id;
      const metaEl = h.block.querySelector('.blk-meta');
      if (metaEl) metaEl.textContent = `${dur.toFixed(2)}s`;
    }
  }

  _hasTrack(o, path) {
    if ((o.tracks?.[path] || []).length) return true;
    return AX.some((a) => (o.tracks?.[`${path}.${a}`] || []).length > 0);
  }

  _commitVec(objId, path) {
    const pr = this._propRows.find((x) => x.objId === objId && x.path === path);
    const o = this._obj(objId);
    if (!pr || !o) return;
    const v = pr.inputs.map((i) => Number(i.value));
    if (v.some((n) => !Number.isFinite(n))) return;
    const t = this._editTimes.get(`${objId}:${path}`) ?? round3(this.time);
    if (this._hasTrack(o, path)) this.onOp?.({ op: 'objectKey', id: objId, path, t, v });
    else this.onOp?.({ op: 'objectPatch', id: objId, patch: { [path]: v } });
  }

  _commitOpacity(objId) {
    const pr = this._propRows.find((x) => x.objId === objId && x.path === 'opacity');
    const o = this._obj(objId);
    if (!pr || !o) return;
    const v = Number(pr.inputs[0].value);
    if (!Number.isFinite(v)) return;
    const t = this._editTimes.get(`${objId}:opacity`) ?? round3(this.time);
    if (this._hasTrack(o, 'opacity')) this.onOp?.({ op: 'objectKey', id: objId, path: 'opacity', t, v });
    else this.onOp?.({ op: 'objectPatch', id: objId, patch: { opacity: Math.max(0, Math.min(1, v)) } });
  }

  _commitGeom(objId) {
    const pr = this._propRows.find((x) => x.objId === objId && x.path === 'geom');
    const o = this._obj(objId);
    if (!pr || !o) return;
    const [w, h, d] = pr.inputs.map((i) => Number(i.value));
    if (![w, h, d].every(Number.isFinite)) return;
    this.onOp?.({
      op: 'objectPatch', id: objId,
      patch: { geom: { ...(o.geom || {}), w: Math.max(0.01, w), h: Math.max(0.01, h), d: Math.max(0.01, d) } },
    });
  }

  _commitColor(objId, value) {
    const o = this._obj(objId);
    if (!o) return;
    this.onOp?.({ op: 'objectPatch', id: objId, patch: { style: { ...(o.style || {}), color: value } } });
  }

  _toggleKey(objId, path) {
    const o = this._obj(objId);
    if (!o) return;
    this.onPause?.();
    const t = round3(this.time);
    const track = o.tracks?.[path] || [];
    const at = track.some((k) => Math.abs(k.t - t) < 1e-3);
    if (at) {
      this.onOp?.({ op: 'objectUnkey', id: objId, path, t });
      return;
    }
    const pose = objectPose(o, t);
    const v = path === 'opacity' ? pose.opacity : pose[path];
    this.onOp?.({ op: 'objectKey', id: objId, path, t, v });
  }

  _schedule(key, fn) {
    this._flush(key);
    const timer = setTimeout(() => {
      this._pending.delete(key);
      fn();
    }, 110);
    this._pending.set(key, { timer, fn });
  }

  _flush(key) {
    const p = this._pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(key);
    p.fn();
  }

  _toggleExpand(id) {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
      this._scrollTo = id;
    }
    this._autoObj = this.expanded.has(id) ? id : this._autoObj;
    this.render(true);
  }

  _inlineName(span, o) {
    if (span.querySelector('input')) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = o.name || o.id;
    span.textContent = '';
    span.appendChild(inp);
    inp.focus();
    inp.select();
    const done = (save) => {
      const v = inp.value.trim();
      span.textContent = v || o.name || o.id;
      if (save && v && v !== o.name) this.onOp?.({ op: 'objectPatch', id: o.id, patch: { name: v } });
    };
    inp.addEventListener('blur', () => done(true));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = o.name || o.id; inp.blur(); }
    });
  }

  _scrollObject(id) {
    const camId = this.camOpenId || this._activeCameraId();
    const row = id === 'camera'
      ? (camId ? this.inner.querySelector(`.tl-camhead[data-cam="${camId}"]`) : null)
      : this.inner.querySelector(`.tl-objhead[data-obj="${id}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const sr = this.scroll.getBoundingClientRect();
    if (r.top < sr.top) this.scroll.scrollTop -= (sr.top - r.top) + 4;
    else if (r.bottom > sr.bottom) this.scroll.scrollTop += (r.bottom - sr.bottom) + 8;
  }

  // ------------------------------------------------------------ selection / input
  _paintSelection() {
    this.inner.querySelectorAll('.blk.sel').forEach((n) => n.classList.remove('sel'));
    this.inner.querySelectorAll('.tl-objhead.sel, .tl-prop.sel, .tl-camposrow.sel').forEach((n) => n.classList.remove('sel'));
    if (this.objectId) {
      this.inner.querySelector(`.blk.ob[data-obj="${this.objectId}"]`)?.classList.add('sel');
      this.inner.querySelector(`.tl-objhead[data-obj="${this.objectId}"]`)?.classList.add('sel');
      if (this.propSel && this.propSel.objId === this.objectId) {
        this.inner.querySelector(`.tl-prop[data-obj="${this.propSel.objId}"][data-path="${this.propSel.path}"]`)?.classList.add('sel');
      }
    }
    if (this.elementId) {
      this.inner.querySelector(`.blk.el[data-id="${this.elementId}"]`)?.classList.add('sel');
    }
    if (this.segmentId) {
      this.inner.querySelector(`.blk.seg[data-id="${this.segmentId}"]`)?.classList.add('sel');
    }
    if (this.cameraSel) {
      const camId = this._activeCameraId();
      if (camId) {
        this.inner.querySelector(`.blk.cam[data-cam="${camId}"]`)?.classList.add('sel');
        this.inner.querySelector(`.tl-camhead[data-cam="${camId}"]`)?.classList.add('sel');
      }
      this.inner.querySelector('.tl-camposrow')?.classList.add('sel');
    }
  }

  _down(ev) {
    if (ev.button !== 0) return;
    const target = ev.target;
    // controls / fields handle themselves (focus, clicks)
    if (/INPUT|TEXTAREA|SELECT/.test(target.tagName || '') || target.closest('button')) return;
    if (target.closest('.tl-sect')) return;
    ev.preventDefault();
    this._noSnap = ev.altKey;
    const blk = target.closest?.('.blk');
    const gutterEl = target.closest?.('.tl-gutter[data-id]');

    // ---- 3D elements ----
    const camKeyEl = target.closest?.('.tl-key[data-cam="1"]');
    if (camKeyEl) {
      this.cameraSel = true;
      this.elementId = null; this.segmentId = null; this.objectId = null;
      this.onSelect?.({ camera: true });
      this.onSeek?.(Number(camKeyEl.dataset.t));
      this._paintSelection();
      return;
    }
    const key = target.closest?.('.tl-key');
    if (key) {
      this.objectId = key.dataset.obj;
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = { objId: key.dataset.obj, path: key.dataset.path };
      this.onSelect?.({ objectId: this.objectId });
      this.onSeek?.(Number(key.dataset.t));
      this._paintSelection();
      return;
    }
    const propGutter = target.closest?.('.tl-prop .tl-gutter');
    if (propGutter) {
      const pr = propGutter.closest('.tl-prop');
      const id = pr.dataset.obj;
      this.objectId = id;
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = { objId: id, path: pr.dataset.path };
      this.onSelect?.({ objectId: id });
      this._paintSelection();
      return;
    }
    // camera row header: select/activate + vertical drag to reorder the stack
    const camHead = target.closest?.('.tl-camhead[data-cam]');
    if (camHead) {
      this._startCameraDrag(camHead.dataset.cam, ev.clientY, camHead);
      return;
    }
    const objHead = target.closest?.('.tl-objhead');
    if (objHead && !target.closest?.('.blk.ob')) {
      this.objectId = objHead.dataset.obj;
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.onSelect?.({ objectId: this.objectId });
      this._paintSelection();
      return;
    }
    const objBlk = target.closest?.('.blk.ob');
    if (objBlk) {
      const id = objBlk.dataset.obj;
      this.objectId = id;
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.onSelect?.({ objectId: id });
      this._paintSelection();
      const item = this._obj(id);
      if (!item) return;
      const mode = target.classList.contains('handle-l') ? 'l'
        : target.classList.contains('handle-r') ? 'r' : 'move';
      const t0 = this._timeAt(ev.clientX);
      const orig = { start: item.start, duration: item.duration };
      const total = this.project.meta.duration;
      const move = (e) => {
        this._noSnap = e.altKey;
        const t = this._timeAt(e.clientX);
        const dt = t - t0;
        let ns = orig.start, nd = orig.duration;
        if (mode === 'move') {
          ns = Math.max(0, Math.min(Math.max(0, total - orig.duration), this._snap(orig.start + dt)));
        } else if (mode === 'r') {
          const end = this._snap(orig.start + orig.duration + dt);
          nd = Math.max(0.08, Math.min(Math.max(0.08, total - orig.start), end - orig.start));
        } else {
          const end = Math.min(total, orig.start + orig.duration);
          const s = Math.min(end - 0.08, Math.max(0, this._snap(orig.start + dt)));
          nd = Math.max(0.08, end - s);
          ns = s;
        }
        objBlk.style.left = `${ns * this.pps}px`;
        objBlk.style.width = `${nd * this.pps}px`;
        objBlk._ns = ns; objBlk._nd = nd;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const ns = objBlk._ns, nd = objBlk._nd;
        if (ns == null || (Math.abs(ns - orig.start) < 1e-4 && Math.abs(nd - orig.duration) < 1e-4)) return;
        this.onOp?.({ op: 'objectPatch', id, patch: { start: round3(ns), duration: round3(nd) } });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    // ---- camera / segments / v2 ----
    if (blk?.classList.contains('cam')) {
      this._activateCamera(blk.dataset.cam);
      return;
    }
    // camera property labels (the lane itself still scrubs)
    if (target.closest?.('.tl-camprop .tl-gutter') || target.closest?.('.tl-camhint .tl-gutter')) {
      this._activateCamera(this._activeCameraId());
      return;
    }

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
      const t0 = this._timeAt(ev.clientX);
      const orig = { start: item.start, duration: item.duration };

      const move = (e) => {
        this._noSnap = e.altKey;
        const t = this._timeAt(e.clientX);
        const dt = t - t0;
        let ns = orig.start, nd = orig.duration;
        if (mode === 'move') {
          ns = Math.max(0, this._snap(orig.start + dt));
        } else if (mode === 'r') {
          const end = this._snap(orig.start + orig.duration + dt);
          nd = Math.max(0.08, end - orig.start);
        } else {
          const s = Math.min(orig.start + orig.duration - 0.08, Math.max(0, this._snap(orig.start + dt)));
          nd = Math.max(0.08, orig.start + orig.duration - s);
          ns = s;
        }
        blk.style.left = `${ns * this.pps}px`;
        blk.style.width = `${nd * this.pps}px`;
        blk._ns = ns; blk._nd = nd;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const ns = blk._ns, nd = blk._nd;
        if (ns == null || (Math.abs(ns - orig.start) < 1e-4 && Math.abs(nd - orig.duration) < 1e-4)) return;
        if (isSeg) this.onOp?.({ op: 'updateSegment', id, patch: { start: round3(ns), duration: round3(nd) } });
        else this.onOp?.({ op: 'moveElement', id, start: round3(ns), duration: round3(nd) });
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

    // scrub anywhere on the tracks
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
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const fmtTick = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { escapeHtml };
