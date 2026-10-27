// Timeline: ruler + camera stack + 2D and 3D element rows. Segments still live
// in the project (AI / pipeline use them) but no longer get a lane here.
// Element rows expand in place: the left column edits the element's properties
// and the right lanes show per-property keyframes, all on the same row grid.
// 2D rows expose the transform in pixels and metres (transform.z is depth);
// 3D rows expose the parent/world transform. The camera is an element too:
// its attributes are folded inside the camera row.
import { timecode, sampleTrack } from '/core/time.js';
import { objectPose } from '/core/scene.js';
import { childrenOf } from '/core/hierarchy.js';
import { pathPos, cameraTransform, cameraParamValue } from '/core/camera.js';
import {
  emptySelection, normalizeSelection, selectOne, addSelection, toggleSelection,
  cameraRef, objectRef, elementRef, propertyRef, keyframeRef, splitRef,
} from '/core/selection.js';
import { attachNumberField, readNumber, writeNumber } from './numfield.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const TYPE_COLOR = { image: '#3b6ea5', video: '#2f8f6b', text: '#a06a2b', shape: '#8a4b8f', solid: '#666' };
const AX = ['x', 'y', 'z'];

export class Timeline {
  constructor(root, { onSeek, onSelect, onOp, onPause, onElementMenu, onCameraMenu, onClipMenu, onSplit } = {}) {
    this.root = root;
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onOp = onOp;
    this.onPause = onPause;
    this.onElementMenu = onElementMenu;
    this.onCameraMenu = onCameraMenu;
    this.onClipMenu = onClipMenu;
    this.onSplit = onSplit;
    this.project = null;
    this.time = 0;
    this.pool = emptySelection();
    this.segmentId = null;
    this.elementId = null;
    this.objectId = null;
    this.cameraSel = false;
    this.camOpenId = null;
    this.soloCameras = new Set();
    this._camPos = null;
    this._camPropRows = [];
    this._camDrag = null;
    this.zoom = 1;
    this.pps = 60;
    this.expanded = new Set();
    this.sections = {
      content: 'full', transform: 'full', camPos: 'full',
      camMain: 'collapsed', camShake: 'collapsed', camDof: 'collapsed',
    };
    this.propSel = null;
    this._autoObj = null;
    this._autoEl = null;
    this._scrollTo = null;
    this._pending = new Map();
    this._editTimes = new Map();
    this._propRows = [];
    this._elPropRows = [];
    this._objHeads = new Map();
    this._elHeads = new Map();
    this.expandedEls = new Set();
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

    this.camHead = el('div', 'tl-row tl-sechead tl-camsec');
    this.camHeadGutter = el('div', 'tl-gutter', '<span>相机</span>');
    this.camHeadTrack = el('div', 'tl-track');
    this.camHead.append(this.camHeadGutter, this.camHeadTrack);

    this.camsWrap = el('div', 'tl-cams');
    this.elsWrap = el('div', 'tl-els');
    this.playhead = el('div', 'tl-playhead');
    const splitBtn = el('button', 'tl-split', '✂');
    splitBtn.type = 'button';
    splitBtn.title = '在红线处切开（Ctrl+D）';
    splitBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    splitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onSplit?.();
    });
    this.playhead.appendChild(splitBtn);
    this.inner.append(this.rulerRow, this.camHead, this.camsWrap, this.elsWrap, this.playhead);

    const hint = el('div', 'tl-hint');
    hint.innerHTML = '<span>▾ 元素 / 相机展开</span><span class="tl-hint-sep">|</span>'
      + '<span>U 只看带键属性</span><span class="tl-hint-sep">|</span>'
      + '<span>组标题三态 ▾ 全部 / ▾• 带键 / ▸ 收起</span><span class="tl-hint-sep">|</span>'
      + '<span><b>◆</b> 打帧 / 删帧</span><span class="tl-hint-sep">|</span>'
      + '<span>Ctrl+D 红线切开</span><span class="tl-hint-sep">|</span>'
      + '<span>Ctrl + 拖标尺缩放</span>';

    // timeline zoom: buttons + Ctrl+wheel + double-click the ruler to fit
    const zoomBar = el('div', 'tl-zoom');
    const zOut = el('button', 'tl-zoomb', '−');
    zOut.title = '缩小时间轴（Ctrl + 滚轮 / Ctrl + 拖标尺）';
    const zIn = el('button', 'tl-zoomb', '+');
    zIn.title = '放大时间轴（Ctrl + 滚轮 / Ctrl + 拖标尺）';
    this._zoomLabel = el('span', 'tl-zoomval', '100%');
    const zFit = el('button', 'tl-zoomb', '适应');
    zFit.title = '缩放到整段时长（双击标尺）';
    zOut.onclick = () => this.zoomBy(0.8);
    zIn.onclick = () => this.zoomBy(1.25);
    zFit.onclick = () => this.fit();
    zoomBar.append(zOut, this._zoomLabel, zIn, zFit);
    hint.appendChild(zoomBar);
    this.root.appendChild(hint);

    this.inner.addEventListener('pointerdown', (e) => this._down(e));
    this.scroll.addEventListener('scroll', () => this.onViewChange?.());
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.zoomBy(e.deltaY > 0 ? 0.9 : 1.1, e.clientX);
      }
    }, { passive: false });
    this.rulerTrack.addEventListener('dblclick', () => this.fit());
    // A rebuild that was deferred while typing runs as soon as the field is left.
    this.root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!this._renderPending) return;
        if (this.root.contains(document.activeElement)) return;
        this._renderPending = false;
        this.render(true);
      }, 0);
    }, true);
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
    const prevEl = this.elementId;
    this.pool = normalizeSelection(sel?.pool || (
      sel?.camera && this._activeCameraId() ? selectOne('element', cameraRef(this._activeCameraId()))
        : sel?.objectId ? selectOne('element', objectRef(sel.objectId))
          : sel?.elementId ? selectOne('element', elementRef(sel.elementId))
            : emptySelection()
    ));
    this.segmentId = sel?.segmentId || null;
    this.elementId = sel?.elementId || null;
    this.objectId = sel?.objectId || null;
    this.cameraSel = !!sel?.camera;
    const id = this.objectId;
    const elId = this.elementId;
    if (!id) this._autoObj = null;
    if (!elId) this._autoEl = null;
    let force = false;
    if (id && id !== this._autoObj && !this.expanded.has(id)) {
      this.expanded.add(id);
      this._autoObj = id;
      this._scrollTo = id;
      force = true;
    } else if (id && id !== prev) {
      force = true;
    }
    if (elId && elId !== this._autoEl && !this.expandedEls.has(elId)) {
      this.expandedEls.add(elId);
      this._autoEl = elId;
      this._scrollTo = `el:${elId}`;
      force = true;
    } else if (elId && elId !== prevEl) {
      force = true;
    }
    if (id !== prev || elId !== prevEl) this.propSel = null;
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
    this.onViewChange?.();
  }

  /** Zoom around `clientX` (defaults to the playhead) and keep that time in place. */
  setZoom(z, clientX = null) {
    const next = Math.max(0.15, Math.min(8, Number(z) || this.zoom));
    if (Math.abs(next - this.zoom) < 1e-6) return;
    const rect = this.scroll.getBoundingClientRect();
    const anchorX = clientX != null
      ? Math.max(0, Math.min(this.scroll.clientWidth, clientX - rect.left))
      : Math.max(8, Math.min(this.scroll.clientWidth - 8, this._trackX(this.time) - this.scroll.scrollLeft));
    const anchorTime = (anchorX + this.scroll.scrollLeft - this._gutter()) / Math.max(1, this.pps);
    this.zoom = next;
    this._layout();
    this.scroll.scrollLeft = Math.max(0, this._gutter() + anchorTime * this.pps - anchorX);
    this.onViewChange?.();
  }

  zoomBy(factor, clientX = null) {
    this.setZoom(this.zoom * factor, clientX);
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
      this.zoom = Math.max(0.15, Math.min(8, this.pps / 60));
      this._fitOnce = false;
    } else {
      this.pps = 60 * this.zoom;
    }
    if (this._zoomLabel) this._zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.render(true);
    this.onViewChange?.();
  }

  _updateHeight() {
    const app = document.querySelector('#app');
    const open = (!!this.camOpenId && !!this.project?.camera)
      || this.expanded.size > 0 || this.expandedEls.size > 0;
    if (app) app.classList.toggle('tl-expanded', open);
  }

  _snap(t) {
    if (this._noSnap) return t;
    const p = this.project;
    const tol = 7 / this.pps;
    const cands = [0, p.meta.duration, ...(p.meta.beats || [])];
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
    const focusedHere = this.root.contains(active)
      && /INPUT|SELECT|TEXTAREA/.test(active?.tagName || '');
    if (focusedHere) {
      // Rebuilding the rows would throw away the focused input (and the caret)
      // in the middle of typing. Sync values instead, remember that a rebuild
      // is owed, and run it when the field is left.
      this._syncProps();
      if (force) this._renderPending = true;
      return;
    }

    const dur = p.meta.duration;
    this.inner.style.width = `${this._gutter() + dur * this.pps + 60}px`;
    this.inner.style.minHeight = '100%';

    const objs = Array.isArray(p.scene?.objects) ? p.scene.objects : [];
    const ids = new Set(objs.map((o) => o.id));
    for (const id of [...this.expanded]) if (!ids.has(id)) this.expanded.delete(id);
    const elIds = new Set(p.elements.map((e) => e.id));
    for (const id of [...this.expandedEls]) if (!elIds.has(id)) this.expandedEls.delete(id);

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
    for (const b of (p.meta.beats || [])) {
      const bt = el('div', 'tl-beat');
      bt.style.left = `${b * this.pps}px`;
      this.rulerTrack.appendChild(bt);
    }

    // camera / element rows follow; segments live in the data only

    // camera stack: a section header + one row per camera (top of the stack
    // first). The expanded camera is always the active one.
    const cams = Array.isArray(p.cameras) && p.cameras.length ? p.cameras : (p.camera ? [p.camera] : []);
    this.camHeadGutter.innerHTML = cams.length
      ? `<span>相机</span><span class="tl-sub">${cams.length} 台</span>`
      : '<span>相机 · 无</span>';
    this.camHeadGutter.classList.toggle('dim', !cams.length);
    this.camsWrap.innerHTML = '';
    this._camPos = null;
    this._camPropRows = [];
    if (this.camOpenId && p.activeCameraId && this.camOpenId !== p.activeCameraId) this.camOpenId = null;
    if (this.camOpenId && !cams.some((c) => c.id === this.camOpenId)) this.camOpenId = null;
    for (const cam of cams) this._cameraGroup(cam, p);

    // v2 (2D) element lanes, then the 3D objects
    this.elsWrap.innerHTML = '';
    this._propRows = [];
    this._elPropRows = [];
    this._objHeads = new Map();
    this._elHeads = new Map();
    const els = [...p.elements].sort((a, b) => b.z - a.z);
    if (els.length) {
      const head = el('div', 'tl-row tl-sechead');
      head.append(
        el('div', 'tl-gutter', `<span>元素 · 2D</span><span class="tl-sub">${els.length} 个</span>`),
        el('div', 'tl-track'),
      );
      this.elsWrap.appendChild(head);
    }
    for (const e of els) this._elementGroup(e);
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
    this.pool = selectOne('element', cameraRef(id));
    this.onSelect?.({ camera: true, pool: this.pool });
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
    this.pool = selectOne('element', cameraRef(id));
    this.onSelect?.({ camera: true, pool: this.pool });
    if (this._activeCameraId() !== id) {
      const r = this.onOp?.({ op: 'activateCamera', id });
      if (r?.then) r.then(() => this.render(true)).catch(() => {});
      else this.render(true);
    } else {
      this.render(true);
    }
  }

  setSoloCameras(ids) {
    const next = new Set(ids || []);
    const same = next.size === this.soloCameras.size
      && [...this.soloCameras].every((id) => next.has(id));
    this.soloCameras = next;
    // applyProject calls this after every op: do not rebuild the whole
    // timeline (and destroy focused inputs) when the solo set did not change.
    if (!same) this.render(true);
  }

  _startCameraDrag(id, startY, row) {
    const rows = [...this.camsWrap.querySelectorAll('.tl-camhead[data-cam]')];
    if (rows.length < 2) { this._activateCamera(id); return; }
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
    // One "位置" property (path keys) plus the rest of the base transform.
    // The camera transform group stays open by default: it is what users edit
    // most, while lens/shake/DOF stay folded with summaries.
    host.appendChild(this._sectionRow('变换', 'camPos'));
    const xformMode = this.sections.camPos;
    if (xformMode !== 'collapsed') {
      const tr = cameraTransform(cam, this.time);
      const show = (path) => xformMode === 'full' || this._camTracked(cam, path);
      if (show('center')) {
        host.appendChild(this._camVecRow(cam, 'center', '中心点', 3, tr.center, { step: 0.1, unit: 'm' }));
      }
      if (xformMode === 'full' || (cam.path || []).length > 0) host.appendChild(this._camPosRow(cam));
      if (show('picturePivot')) {
        host.appendChild(this._camVecRow(cam, 'picturePivot', '画面中心', 2, tr.picturePivot, {
          step: 0.01, min: 0, max: 1, unit: '0..1',
        }));
      }
      if (show('pictureOffset')) {
        host.appendChild(this._camVecRow(cam, 'pictureOffset', '画面位置', 2, tr.pictureOffset, {
          step: 0.01, min: -1, max: 1, unit: '-1..1',
        }));
      }
      if (show('opacity')) host.appendChild(this._camOpacityRow(cam, tr.opacity));
      if (show('scale')) host.appendChild(this._camVecRow(cam, 'scale', '缩放', 3, tr.scale, { step: 0.05, unit: '倍' }));
    }

    const fov = this._camValue(cam, 'fov');
    const lookAhead = this._camValue(cam, 'lookAhead');
    const bankGain = this._camValue(cam, 'bankGain');
    const maxRoll = this._camValue(cam, 'maxRoll');
    const roll = this._camValue(cam, 'roll');
    const shakeAmp = this._camValue(cam, 'shake.amp');
    const shakeFreq = this._camValue(cam, 'shake.freq');
    const shakeGain = this._camValue(cam, 'shake.speedGain');
    const dofOn = this._camValue(cam, 'dof.enabled');
    const fstop = this._camValue(cam, 'dof.fstop');
    const lensSummary = `FOV ${Math.round(fov)}°${fov >= 180 ? ' · 鱼眼' : ''}`;
    const shakeSummary = `${round2(shakeAmp)}m · ${round2(shakeFreq)}Hz`;
    const dofSummary = `f/${round2(fstop)} · 模糊 ${Math.round((cam.motionBlur.shutter || 0) * 360)}°`;
    host.appendChild(this._sectionRow('镜头 / 构图', 'camMain', lensSummary));
    const lensMode = this.sections.camMain;
    if (lensMode !== 'collapsed') {
      const show = (path) => lensMode === 'full' || this._camTracked(cam, path);
      if (show('fov')) {
        host.appendChild(this._camParamNumRow(cam, 'fov', '视场角 FOV', fov, {
          step: 1, min: 1, max: 360, badge: fov >= 180 ? '鱼眼' : '',
        }));
      }
      if (lensMode === 'full') {
        host.appendChild(this._camHintRow('≥180° 自动切等距鱼眼（可到 360°）；Blender 侧用 Cycles 渲这一档。'));
      }
      if (show('lookAhead')) {
        host.appendChild(this._camParamNumRow(cam, 'lookAhead', '看向前方 (m)', lookAhead, {
          step: 5, min: 2, max: 500,
        }));
      }
      if (show('bankGain')) {
        host.appendChild(this._camParamNumRow(cam, 'bankGain', '转弯侧倾', bankGain, {
          step: 0.1, min: 0, max: 4,
        }));
      }
      if (show('maxRoll')) {
        host.appendChild(this._camParamNumRow(cam, 'maxRoll', '最大侧倾°', maxRoll, {
          step: 1, min: 0, max: 60,
        }));
      }
      if (show('roll')) {
        host.appendChild(this._camParamNumRow(cam, 'roll', '手动 roll°', roll, {
          step: 1, min: -60, max: 60,
        }));
      }
    }

    host.appendChild(this._sectionRow('抖动', 'camShake', shakeSummary));
    const shakeMode = this.sections.camShake;
    if (shakeMode !== 'collapsed') {
      const show = (path) => shakeMode === 'full' || this._camTracked(cam, path);
      if (show('shake.amp')) {
        host.appendChild(this._camParamNumRow(cam, 'shake.amp', '抖动幅度', shakeAmp, {
          step: 0.05, min: 0, max: 5,
        }));
      }
      if (show('shake.freq')) {
        host.appendChild(this._camParamNumRow(cam, 'shake.freq', '抖动频率', shakeFreq, {
          step: 0.1, min: 0.1, max: 8,
        }));
      }
      if (show('shake.speedGain')) {
        host.appendChild(this._camParamNumRow(cam, 'shake.speedGain', '随速度增强', shakeGain, {
          step: 0.1, min: 0, max: 2,
        }));
      }
      if (shakeMode === 'full') {
        host.appendChild(this._camParamNumRow(cam, 'shake.seed', '随机种子', cam.shake.seed, {
          step: 1, keyable: false, badge: '整段',
        }));
      }
    }

    host.appendChild(this._sectionRow('景深 / 模糊', 'camDof', dofSummary));
    const dofMode = this.sections.camDof;
    if (dofMode !== 'collapsed') {
      const show = (path) => dofMode === 'full' || this._camTracked(cam, path);
      if (show('dof.enabled')) {
        host.appendChild(this._camParamSelectRow(cam, 'dof.enabled', '景深', dofOn,
          [['false', '关'], ['true', '开']]));
      }
      if (show('dof.fstop')) {
        host.appendChild(this._camParamNumRow(cam, 'dof.fstop', '光圈 f', fstop, {
          step: 0.2, min: 0.5, max: 32,
        }));
      }
      if (dofMode === 'full') {
        host.appendChild(this._camParamSelectRow(cam, 'motionBlur.enabled', '运动模糊', cam.motionBlur.enabled,
          [['true', '开'], ['false', '关']], { keyable: false, badge: '整段' }));
        host.appendChild(this._camParamNumRow(cam, 'motionBlur.shutter', '快门角', cam.motionBlur.shutter, {
          step: 0.05, min: 0, max: 1, keyable: false, badge: '整段',
        }));
      }
    }
  }

  _camPosRow(cam = this.project?.camera) {
    const row = el('div', 'tl-row tl-camprop tl-camposrow');
    row.dataset.cam = cam?.id || '';
    row.dataset.path = 'path';
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam?.id || '';
    g.appendChild(el('span', 'tl-plabel', '位置'));
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
    const v = posRow.inputs.map((i) => readNumber(i));
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
        d.dataset.cam = cam.id;
        d.dataset.path = 'path';
        d.dataset.t = String(t);
        d.style.left = `${t * this.pps}px`;
        d.title = `位置 · ${t.toFixed(2)}s`;
        posRow.lane.appendChild(d);
        return { t, node: d };
      });
    }
    for (const k of posRow.keys) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 5e-4);
  }

  _camVecRow(cam, path, label, dims, values, { step = 0.1, min, max, letter } = {}) {
    const row = el('div', 'tl-row tl-camprop tl-camxform');
    row.dataset.cam = cam.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    g.appendChild(el('span', 'tl-plabel', label));
    const inputs = [];
    for (let i = 0; i < dims; i++) {
      const axis = AX[i];
      const mark = letter !== undefined ? letter : axis.toUpperCase();
      const { box, inp } = this._numBox(axis, mark);
      inp.step = String(step);
      if (min != null) inp.min = String(min);
      if (max != null) inp.max = String(max);
      // opacity keeps 0..1 in the project but reads as a percentage here
      if (path === 'opacity') { inp.dataset.scale = '100'; inp.dataset.unit = '%'; }
      writeNumber(inp, values[i], { force: true });
      const editKey = `cam:${cam.id}:${path}`;
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this._editTimes.set(editKey, round3(this.time));
        this._schedule(editKey, () => this._commitCamParam(cam.id, path));
      });
      inp.addEventListener('blur', () => { this._flush(editKey); this._syncProps(); });
      inputs.push(inp);
      g.appendChild(box);
    }
    const kf = el('button', 'tl-kf', '◆');
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleCamParamKey(cam.id, path); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    const pr = { camId: cam.id, path, kind: dims === 1 ? 'scalar' : 'vec', dims, inputs, kf, lane, row, sig: '' };
    this._camPropRows.push(pr);
    this._refreshCamPropLane(pr, cam);
    return row;
  }

  _camOpacityRow(cam, value) {
    return this._camVecRow(cam, 'opacity', '透明度', 1, [value], {
      step: 0.01, min: 0, max: 1, letter: '',
    });
  }

  _camById(id) {
    return (this.project?.cameras || []).find((c) => c.id === id)
      || (this.project?.camera?.id === id ? this.project.camera : null);
  }

  _camPatch(path, v) {
    if (!path.includes('.')) return { [path]: v };
    const [a, b] = path.split('.');
    return { [a]: { [b]: v } };
  }

  _camValue(cam, path, t = this.time) {
    return cameraParamValue(cam, path, t);
  }

  _camHasTrack(cam, path) {
    return (cam?.tracks?.[path] || []).length > 0;
  }

  _commitCamParam(camId, path) {
    const cam = this._camById(camId);
    const pr = this._camPropRows.find((x) => x.camId === camId && x.path === path);
    if (!cam || !pr) return;
    const values = pr.inputs.map((i) => readNumber(i));
    if (!values.every(Number.isFinite)) return;
    const v = pr.dims === 1 ? values[0] : values;
    const t = this._editTimes.get(`cam:${camId}:${path}`) ?? round3(this.time);
    if (this._camHasTrack(cam, path)) {
      this.onOp?.({ op: 'cameraParamKey', id: camId, path, t, v });
    } else {
      const patch = this._camPatch(path, path === 'opacity' ? Math.max(0, Math.min(1, v)) : v);
      this.onOp?.({ op: 'cameraSet', patch });
    }
  }

  _commitCamSelect(camId, path, raw) {
    const cam = this._camById(camId);
    if (!cam) return;
    const v = raw === 'true' ? true : raw === 'false' ? false : raw;
    const t = round3(this.time);
    if (this._camHasTrack(cam, path)) {
      this.onOp?.({ op: 'cameraParamKey', id: camId, path, t, v });
    } else {
      this.onOp?.({ op: 'cameraSet', patch: this._camPatch(path, v) });
    }
  }

  _commitCamShotValue(camId, path, value) {
    this.onOp?.({ op: 'cameraSet', patch: this._camPatch(path, value) });
  }

  _toggleCamParamKey(camId, path) {
    const cam = this._camById(camId);
    if (!cam) return;
    this.onPause?.();
    const t = round3(this.time);
    const track = cam.tracks?.[path] || [];
    if (track.some((k) => Math.abs(k.t - t) < 1e-3)) {
      this.onOp?.({ op: 'cameraParamUnkey', id: camId, path, t });
      return;
    }
    const v = this._camValue(cam, path, t);
    this.onOp?.({ op: 'cameraParamKey', id: camId, path, t, v });
  }

  _refreshCamPropLane(pr, cam) {
    const keys = (cam.tracks?.[pr.path] || [])
      .map((k) => round3(k.t))
      .sort((a, b) => a - b);
    const sig = keys.join(',');
    if (sig !== pr.sig) {
      pr.sig = sig;
      pr.lane.innerHTML = '';
      pr.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.cam = cam.id;
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

  _camParamNumRow(cam, path, label, value, { step = 0.1, min, max, badge = '', keyable = true } = {}) {
    const row = el('div', 'tl-row tl-camprop tl-camparamrow');
    row.dataset.cam = cam.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    g.appendChild(el('span', 'tl-plabel', label));
    const { box, inp } = this._numBox('d', '');
    box.classList.add('tl-camnum');
    inp.step = String(step);
    if (min != null) inp.min = String(min);
    if (max != null) inp.max = String(max);
    writeNumber(inp, value, { force: true });
    const editKey = `cam:${cam.id}:${path}`;
    inp.addEventListener('focus', () => this.onPause?.());
    inp.addEventListener('input', () => {
      this._editTimes.set(editKey, round3(this.time));
      this._schedule(editKey, () => {
        if (keyable) this._commitCamParam(cam.id, path);
        else {
          const v = readNumber(inp);
          if (Number.isFinite(v)) this._commitCamShotValue(cam.id, path, v);
        }
      });
    });
    inp.addEventListener('blur', () => { this._flush(editKey); this._syncProps(); });
    g.appendChild(box);
    if (badge) g.appendChild(el('span', 'tl-camfish', badge));
    let kf = null;
    if (keyable) {
      kf = el('button', 'tl-kf', '◆');
      kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleCamParamKey(cam.id, path); });
      g.appendChild(kf);
    }
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    if (keyable) {
      const pr = { camId: cam.id, path, kind: 'scalar', dims: 1, inputs: [inp], kf, lane, row, sig: '' };
      this._camPropRows.push(pr);
      this._refreshCamPropLane(pr, cam);
    }
    return row;
  }

  _camParamSelectRow(cam, path, label, value, options, { badge = '', keyable = true } = {}) {
    const row = el('div', 'tl-row tl-camprop tl-camparamrow');
    row.dataset.cam = cam.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
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
    sel.addEventListener('change', () => {
      if (keyable) this._commitCamSelect(cam.id, path, sel.value);
      else this.onOp?.({ op: 'cameraSet', patch: this._camPatch(path, sel.value === 'true') });
    });
    g.appendChild(sel);
    if (badge) g.appendChild(el('span', 'tl-camfish', badge));
    let kf = null;
    if (keyable) {
      kf = el('button', 'tl-kf', '◆');
      kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleCamParamKey(cam.id, path); });
      g.appendChild(kf);
    }
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    if (keyable) {
      const pr = { camId: cam.id, path, kind: 'select', sel, inputs: [], dims: 1, kf, lane, row, sig: '' };
      this._camPropRows.push(pr);
      this._refreshCamPropLane(pr, cam);
    }
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

  _elementGroup(e) {
    const open = this.expandedEls.has(e.id);
    const row = el('div', 'tl-row tl-elhead');
    row.dataset.el = e.id;
    row.classList.toggle('sel', e.id === this.elementId);
    const g = el('div', 'tl-gutter');
    g.dataset.el = e.id;
    const caret = el('button', 'tl-objtoggle', open ? '▾' : '▸');
    caret.title = open ? '折叠属性' : '展开属性';
    caret.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._toggleElementExpand(e.id);
    });
    const eye = el('button', 'tl-objeye', '◉');
    eye.title = e.visible === false ? '显示' : '隐藏';
    if (e.visible === false) eye.classList.add('off');
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onOp?.({ op: 'updateElement', id: e.id, patch: { visible: e.visible === false } });
    });
    const dot = el('i', 'type-dot');
    dot.style.background = TYPE_COLOR[e.type] || '#666';
    const name = el('span', 'tl-objname');
    name.textContent = e.name || e.id;
    name.title = e.name || e.id;
    const kind = el('span', 'tl-objkind', '2D');
    kind.title = '画面元素（纵深 z 单位：米）';
    g.append(caret, eye, dot, name, kind);

    const track = el('div', 'tl-track');
    const b = el('div', `blk el t-${e.type}`);
    b.dataset.id = e.id;
    b.style.left = `${(Number(e.start) || 0) * this.pps}px`;
    b.style.width = `${Math.max(4, (Number(e.duration) || 0) * this.pps)}px`;
    const label = e.type === 'text' ? String(e.style?.text || '').slice(0, 24) : (e.src || '').split('/').pop();
    b.innerHTML = `<span class="blk-name">${escapeHtml(label || e.id)}</span>`;
    const hl = el('div', 'handle handle-l');
    hl.title = '拖动左边界：改开始时间';
    const hr = el('div', 'handle handle-r');
    hr.title = '拖动右边界：改结束时间';
    b.append(hl, hr);
    b.style.setProperty('--c', TYPE_COLOR[e.type] || '#666');
    b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.onClipMenu?.(e.id, ev.clientX, ev.clientY);
    });
    track.appendChild(b);
    row.append(g, track);
    this.elsWrap.appendChild(row);
    this._elHeads.set(e.id, { row, g, eye, name, dot, block: b });

    if (!open) return;
    this.elsWrap.appendChild(this._sectionRow('变换', 'transform', 'px / m'));
    if (this.sections.transform === 'collapsed') return;
    const mode = this.sections.transform;
    const show = (path) => mode === 'full' || this._elTrack(e, path).length > 0;
    if (show('transform.x')) this.elsWrap.appendChild(this._elementNumRow(e, 'transform.x', 'X', { step: 0.1, axis: 'x', letter: 'X', unit: 'px' }));
    if (show('transform.y')) this.elsWrap.appendChild(this._elementNumRow(e, 'transform.y', 'Y', { step: 0.1, axis: 'y', letter: 'Y', unit: 'px' }));
    if (show('transform.z')) {
      this.elsWrap.appendChild(this._elementNumRow(e, 'transform.z', '纵深 z', {
        step: 0.05, axis: 'd', letter: '', unit: 'm', title: '纵深 z (m)，正值朝相机；在播放头打帧',
      }));
    }
    if (show('transform.scale')) this.elsWrap.appendChild(this._elementNumRow(e, 'transform.scale', '缩放', { step: 0.01, axis: 'd', letter: '', unit: '×', min: 0 }));
    if (show('transform.rotation')) this.elsWrap.appendChild(this._elementNumRow(e, 'transform.rotation', '旋转°', { step: 0.5, axis: 'd', letter: '', unit: '°' }));
    if (show('transform.opacity')) {
      this.elsWrap.appendChild(this._elementNumRow(e, 'transform.opacity', '不透明度', {
        step: 0.01, axis: 'd', letter: '', unit: '', min: 0, max: 1,
      }));
    }
  }

  _elementNumRow(e, path, label, { step = 0.1, axis = 'd', letter = '', unit = '', min, max, title } = {}) {
    const row = el('div', 'tl-row tl-prop tl-elprop');
    row.dataset.el = e.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.el = e.id;
    const lab = el('span', 'tl-plabel', label);
    lab.title = title || `${label}${unit ? ` (${unit})` : ''}`;
    g.appendChild(lab);
    const { box, inp } = this._numBox(axis, letter);
    box.classList.add('tl-scalar');
    inp.step = String(step);
    if (Number.isFinite(min)) inp.min = String(min);
    if (Number.isFinite(max)) inp.max = String(max);
    inp.title = `${lab.title} · 无关键帧时改基础值（所有时间），已有键时改当前帧`;
    // Decide once, when editing starts: an unkeyed property keeps editing its
    // base value for the whole gesture. Otherwise a stray key created while a
    // field is focused would silently turn the next keystroke into a keyframe.
    const pr = { elId: e.id, path, input: inp, kf: null, lane: null, row, sig: '', keyedAtFocus: null };
    inp.addEventListener('focus', () => {
      this.onPause?.();
      pr.keyedAtFocus = this._elTrack(e, path).length > 0;
    });
    inp.addEventListener('input', () => {
      this._editTimes.set(`${e.id}:${path}`, round3(this.time));
      this._schedule(`${e.id}:${path}`, () => this._commitElementNum(e.id, path));
    });
    inp.addEventListener('blur', () => { this._flush(`${e.id}:${path}`); pr.keyedAtFocus = null; this._syncProps(); });
    g.appendChild(box);
    const kf = el('button', 'tl-kf', '◆');
    kf.title = '在当前时间打帧 / 删帧';
    kf.addEventListener('click', (ev) => { ev.stopPropagation(); this._toggleElementKey(e.id, path); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    pr.kf = kf;
    pr.lane = lane;
    this._elPropRows.push(pr);
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
    if (o.parent?.id) {
      const p = (this.project?.scene?.objects || []).find((x) => x.id === o.parent.id);
      const link = el('span', 'tl-objparent', '↳');
      link.title = `父级：${p?.name || o.parent.id}`;
      g.append(caret, eye, dot, link, name);
    } else {
      g.append(caret, eye, dot, name);
    }
    const kind = el('span', 'tl-objkind', o.type === 'empty' ? '空' : '3D');
    const kids = childrenOf(this.project, o.id).length;
    if (kids) {
      const badge = el('span', 'tl-objkids', `${kids} 子级`);
      badge.title = '直接子元素数量';
      g.append(kind, badge);
    } else {
      g.append(kind);
    }
    const more = el('button', 'tl-objmore', '⋯');
    more.title = '元素操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      this.onElementMenu?.(o.id, e.clientX || r.left, (e.clientY || r.bottom) + 2);
    });
    g.append(more);

    const track = el('div', 'tl-track');
    const block = el('div', 'blk ob');
    block.dataset.obj = o.id;
    block.style.left = `${(Number(o.start) || 0) * this.pps}px`;
    block.style.width = `${Math.max(4, (Number(o.duration) || 0) * this.pps)}px`;
    block.innerHTML = `<span class="blk-name">${escapeHtml(o.name || o.id)}</span><span class="blk-meta">${(Number(o.duration) || 0).toFixed(2)}s</span>`;
    const hl = el('div', 'handle handle-l');
    hl.title = '拖动左边界：改开始时间';
    const hr = el('div', 'handle handle-r');
    hr.title = '拖动右边界：改结束时间';
    block.append(hl, hr);
    track.appendChild(block);
    row.append(g, track);
    this.elsWrap.appendChild(row);
    this._objHeads.set(o.id, { row, g, eye, name, dot, block });

    if (!open) return;
    this.elsWrap.appendChild(this._sectionRow('内容', 'content'));
    if (this.sections.content === 'full') {
      this.elsWrap.appendChild(this._geomRow(o));
      this.elsWrap.appendChild(this._colorRow(o));
    }
    this.elsWrap.appendChild(this._sectionRow('变换', 'transform', 'm / 倍'));
    if (this.sections.transform !== 'collapsed') {
      const mode = this.sections.transform;
      const show = (path) => mode === 'full' || this._propKeys(o, path).length > 0;
      if (show('pivot')) this.elsWrap.appendChild(this._vecRow(o, 'pivot', '中心点'));
      if (show('position')) this.elsWrap.appendChild(this._vecRow(o, 'position', '位置'));
      if (show('scale')) this.elsWrap.appendChild(this._vecRow(o, 'scale', '缩放'));
      if (show('opacity')) this.elsWrap.appendChild(this._opacityRow(o));
    }
  }

  _groupOpen(key) {
    return this.sections[key] !== 'collapsed';
  }

  _groupCaret(key) {
    const m = this.sections[key];
    return m === 'keyed' ? '▾•' : m === 'full' ? '▾' : '▸';
  }

  _camTracked(cam, path) {
    return (cam?.tracks?.[path] || []).length > 0;
  }

  _camGroupKeyed(cam, group) {
    if (!cam) return false;
    if (group === 'transform') {
      return (cam.path || []).length > 0
        || ['center', 'opacity', 'scale', 'picturePivot', 'pictureOffset']
          .some((p) => this._camTracked(cam, p));
    }
    if (group === 'lens') {
      return ['fov', 'lookAhead', 'bankGain', 'maxRoll', 'roll'].some((p) => this._camTracked(cam, p));
    }
    if (group === 'shake') {
      return ['shake.amp', 'shake.freq', 'shake.speedGain'].some((p) => this._camTracked(cam, p));
    }
    if (group === 'dofMb') {
      return ['dof.enabled', 'dof.fstop'].some((p) => this._camTracked(cam, p));
    }
    return false;
  }

  _objGroupKeyed(o, group) {
    if (!o) return false;
    if (group === 'transform') {
      return ['pivot', 'position', 'scale', 'opacity'].some((p) => this._propKeys(o, p).length > 0);
    }
    return false; // content (primitive / geom / color) is not keyable
  }

  /** U: show only the properties carrying keys for the selected element. */
  applyKeyedFilter() {
    const pool = this.pool;
    if (pool.kind !== 'element') return false;
    const refs = pool.ids.map(splitRef).filter(Boolean);
    const objects = refs.filter((r) => r.type === 'ob');
    if (objects.length) {
      for (const r of objects) this.expanded.add(r.id);
      this.sections.content = 'collapsed';
      this.sections.transform = objects.some((r) => this._objGroupKeyed(this._obj(r.id), 'transform'))
        ? 'keyed' : 'collapsed';
      this.render(true);
      return true;
    }
    const elements = refs.filter((r) => r.type === 'el');
    if (elements.length) {
      for (const r of elements) this.expandedEls.add(r.id);
      this.sections.transform = elements.some((r) => {
        const e = this._element(r.id);
        return ['transform.x', 'transform.y', 'transform.z', 'transform.scale', 'transform.rotation', 'transform.opacity']
          .some((p) => this._elTrack(e, p).length > 0);
      }) ? 'keyed' : 'collapsed';
      this.render(true);
      return true;
    }
    const cams = refs.filter((r) => r.type === 'cam');
    if (cams.length) {
      const primary = splitRef(pool.primary);
      const id = (primary?.type === 'cam' && cams.some((r) => r.id === primary.id)) ? primary.id : cams[0].id;
      const cam = this._camById(id);
      if (!cam) return false;
      this.camOpenId = id;
      for (const g of ['transform', 'lens', 'shake', 'dofMb']) {
        const key = g === 'transform' ? 'camPos' : g === 'lens' ? 'camMain' : g === 'shake' ? 'camShake' : 'camDof';
        this.sections[key] = this._camGroupKeyed(cam, g) ? 'keyed' : 'collapsed';
      }
      this.render(true);
      return true;
    }
    return false;
  }

  _sectionRow(title, key, hint = '') {
    const row = el('div', 'tl-row tl-sect');
    const g = el('div', 'tl-gutter');
    g.append(el('span', 'tl-seccaret', this._groupCaret(key)), el('span', '', title));
    if (hint) g.append(el('span', 'tl-sub', hint));
    row.append(g, el('div', 'tl-track'));
    row.addEventListener('click', () => {
      const m = this.sections[key];
      this.sections[key] = m === 'full' ? 'collapsed' : m === 'collapsed' ? 'full' : 'collapsed';
      this.render(true);
    });
    return row;
  }

  _numBox(axis, letter) {
    const box = el('span', 'tl-num');
    if (letter) box.appendChild(el('i', axis ? `axis-${axis}` : 'axis-d', letter));
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.step = '0.1';
    attachNumberField(inp);
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
    const lab = el('span', 'tl-plabel');
    if (o.parent?.id) {
      const local = el('span', 'tl-plocal', '本');
      local.title = '本地值（相对父级）';
      lab.append(local);
    }
    lab.append(document.createTextNode(label));
    g.appendChild(lab);
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
    inp.dataset.scale = '100';
    inp.dataset.unit = '%';
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

  _element(id) {
    return (this.project?.elements || []).find((e) => e.id === id) || null;
  }

  _elTrack(e, path) {
    return (e?.keyframes || [])
      .filter((k) => k.path === path && Number.isFinite(Number(k.t)))
      .sort((a, b) => Number(a.t) - Number(b.t));
  }

  /** Base / keyed value of a 2D element property (no motion presets or fades). */
  _elValue(e, path, t) {
    const prop = path.slice(path.lastIndexOf('.') + 1);
    let base = path.startsWith('transform.') ? e?.transform?.[prop] : undefined;
    if (base == null) base = (prop === 'scale' || prop === 'opacity') ? 1 : 0;
    return sampleTrack(e?.keyframes, path, t, Number(base));
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

  _refreshElLane(pr, e) {
    const keys = this._elTrack(e, pr.path).map((k) => Math.round(Number(k.t) * 1000) / 1000);
    const sig = keys.join(',');
    if (sig !== pr.sig) {
      pr.sig = sig;
      pr.lane.innerHTML = '';
      pr.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.el = e.id;
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
    // Never write into the field the user is typing in (force included): that
    // is what used to swallow the "." right after "0" on every re-render.
    const set = (inp, v) => writeNumber(inp, v);
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
    for (const pr of this._elPropRows) {
      const e = this._element(pr.elId);
      if (!e) continue;
      set(pr.input, this._elValue(e, pr.path, t));
      const keys = this._elTrack(e, pr.path);
      const at = keys.some((k) => Math.abs(Number(k.t) - t) < 1e-3);
      const has = keys.length > 0;
      pr.kf.classList.toggle('on', at);
      pr.kf.classList.toggle('has', !at && has);
      pr.kf.title = at ? '删除这一帧' : has ? `在当前时间打帧（已有 ${keys.length} 帧）` : '在当前时间打帧';
      this._refreshElLane(pr, e);
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
    for (const pr of this._camPropRows) {
      const cam = this._camById(pr.camId);
      if (!cam) continue;
      const value = this._camValue(cam, pr.path, t);
      if (pr.kind === 'select') {
        if (pr.sel && document.activeElement !== pr.sel) pr.sel.value = String(value);
      } else {
        const values = pr.dims === 1 ? [value] : (value || []);
        pr.inputs.forEach((inp, i) => set(inp, values[i]));
      }
      if (pr.kf) {
        const track = cam.tracks?.[pr.path] || [];
        const at = track.some((k) => Math.abs(k.t - t) < 1e-3);
        const has = track.length > 0;
        pr.kf.classList.toggle('on', at);
        pr.kf.classList.toggle('has', !at && has);
        pr.kf.title = at ? '删除这一帧' : has ? `在当前时间打帧（已有 ${track.length} 帧）` : '在当前时间打帧';
      }
      this._refreshCamPropLane(pr, cam);
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
    for (const [id, h] of this._elHeads) {
      const e = this._element(id);
      if (!e) continue;
      if (document.activeElement !== h.name) h.name.textContent = e.name || e.id;
      h.eye.classList.toggle('off', e.visible === false);
      h.eye.title = e.visible === false ? '显示' : '隐藏';
      h.row.classList.toggle('sel', id === this.elementId);
      const left = `${(Number(e.start) || 0) * this.pps}px`;
      const width = `${Math.max(4, (Number(e.duration) || 0) * this.pps)}px`;
      if (h.block.style.left !== left) h.block.style.left = left;
      if (h.block.style.width !== width) h.block.style.width = width;
      const nameEl = h.block.querySelector('.blk-name');
      const label = e.type === 'text' ? String(e.style?.text || '').slice(0, 24) : (e.src || '').split('/').pop();
      if (nameEl) nameEl.textContent = label || e.id;
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
    const v = pr.inputs.map((i) => readNumber(i));
    if (v.some((n) => !Number.isFinite(n))) return;
    const t = this._editTimes.get(`${objId}:${path}`) ?? round3(this.time);
    if (this._hasTrack(o, path)) this.onOp?.({ op: 'objectKey', id: objId, path, t, v });
    else this.onOp?.({ op: 'objectPatch', id: objId, patch: { [path]: v } });
  }

  _commitOpacity(objId) {
    const pr = this._propRows.find((x) => x.objId === objId && x.path === 'opacity');
    const o = this._obj(objId);
    if (!pr || !o) return;
    const v = readNumber(pr.inputs[0]);
    if (!Number.isFinite(v)) return;
    const t = this._editTimes.get(`${objId}:opacity`) ?? round3(this.time);
    if (this._hasTrack(o, 'opacity')) this.onOp?.({ op: 'objectKey', id: objId, path: 'opacity', t, v });
    else this.onOp?.({ op: 'objectPatch', id: objId, patch: { opacity: Math.max(0, Math.min(1, v)) } });
  }

  _commitGeom(objId) {
    const pr = this._propRows.find((x) => x.objId === objId && x.path === 'geom');
    const o = this._obj(objId);
    if (!pr || !o) return;
    const [w, h, d] = pr.inputs.map((i) => readNumber(i));
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

  _commitElementNum(elId, path) {
    const pr = this._elPropRows.find((x) => x.elId === elId && x.path === path);
    const e = this._element(elId);
    if (!pr || !e) return;
    let v = readNumber(pr.input);
    if (!Number.isFinite(v)) return;
    if (path === 'transform.opacity') v = Math.max(0, Math.min(1, v));
    if (path === 'transform.scale') v = Math.max(0, v);
    const t = this._editTimes.get(`${elId}:${path}`) ?? round3(this.time);
    const keyed = pr.keyedAtFocus ?? this._elTrack(e, path).length > 0;
    if (keyed) {
      this.onOp?.({ op: 'keySet', id: elId, path, t, value: v });
      return;
    }
    const key = path.slice(path.lastIndexOf('.') + 1);
    this.onOp?.({ op: 'updateElement', id: elId, patch: { transform: { [key]: v } } });
  }

  _toggleElementKey(elId, path) {
    const e = this._element(elId);
    if (!e) return;
    this.onPause?.();
    const t = round3(this.time);
    const keys = this._elTrack(e, path);
    if (keys.some((k) => Math.abs(Number(k.t) - t) < 1e-3)) {
      this.onOp?.({ op: 'keyRemove', id: elId, path, t });
      return;
    }
    this.onOp?.({ op: 'keySet', id: elId, path, t, value: this._elValue(e, path, t) });
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
    this._autoObj = this.expanded.has(id) ? id : null;
    this.render(true);
  }

  _toggleElementExpand(id) {
    if (this.expandedEls.has(id)) {
      this.expandedEls.delete(id);
    } else {
      this.expandedEls.add(id);
      this._scrollTo = `el:${id}`;
    }
    this._autoEl = this.expandedEls.has(id) ? id : null;
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
    const elId = String(id).startsWith('el:') ? String(id).slice(3) : null;
    const row = elId
      ? this.inner.querySelector(`.tl-elhead[data-el="${elId}"]`)
      : id === 'camera'
        ? (camId ? this.inner.querySelector(`.tl-camhead[data-cam="${camId}"]`) : null)
        : this.inner.querySelector(`.tl-objhead[data-obj="${id}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const sr = this.scroll.getBoundingClientRect();
    if (elId) {
      // Auto-expanding a 2D element: put its header just below the sticky
      // ruler so the property rows below it are visible too, not just the
      // header (aligning to the scroll top hides it under the ruler).
      const rulerH = this.rulerRow?.offsetHeight || 26;
      this.scroll.scrollTop = Math.max(0, this.scroll.scrollTop + (r.top - sr.top) - rulerH - 4);
      return;
    }
    if (r.top < sr.top) this.scroll.scrollTop -= (sr.top - r.top) + 4;
    else if (r.bottom > sr.bottom) this.scroll.scrollTop += (r.bottom - sr.bottom) + 8;
  }

  // ------------------------------------------------------------ selection / input
  _paintPool() {
    this.inner.querySelectorAll('.poolsel').forEach((n) => n.classList.remove('poolsel'));
    const pool = this.pool;
    if (!pool.kind || !pool.ids.length) return;
    const ids = new Set(pool.ids);
    const mark = (node, ref) => { if (ids.has(ref)) node.classList.add('poolsel'); };
    if (pool.kind === 'element') {
      this.inner.querySelectorAll('.tl-camhead[data-cam], .blk.cam[data-cam]').forEach((n) => mark(n, cameraRef(n.dataset.cam)));
      this.inner.querySelectorAll('.tl-objhead[data-obj], .blk.ob[data-obj]').forEach((n) => mark(n, objectRef(n.dataset.obj)));
      this.inner.querySelectorAll('.tl-elhead[data-el], .blk.el[data-id]').forEach((n) => mark(n, elementRef(n.dataset.el || n.dataset.id)));
    } else if (pool.kind === 'property') {
      this.inner.querySelectorAll('.tl-prop[data-obj][data-path]').forEach((n) => mark(n, propertyRef(objectRef(n.dataset.obj), n.dataset.path)));
      this.inner.querySelectorAll('.tl-elprop[data-el][data-path]').forEach((n) => mark(n, propertyRef(elementRef(n.dataset.el), n.dataset.path)));
      this.inner.querySelectorAll('.tl-camprop[data-cam][data-path]').forEach((n) => mark(n, propertyRef(cameraRef(n.dataset.cam), n.dataset.path)));
    } else if (pool.kind === 'keyframe') {
      this.inner.querySelectorAll('.tl-key[data-t]').forEach((n) => {
        if (n.dataset.cam) mark(n, keyframeRef(cameraRef(n.dataset.cam), n.dataset.path || 'path', n.dataset.t));
        else if (n.dataset.obj) mark(n, keyframeRef(objectRef(n.dataset.obj), n.dataset.path, n.dataset.t));
        else if (n.dataset.el) mark(n, keyframeRef(elementRef(n.dataset.el), n.dataset.path, n.dataset.t));
      });
    }
  }

  _paintSelection() {
    this.inner.querySelectorAll('.blk.sel').forEach((n) => n.classList.remove('sel'));
    this.inner.querySelectorAll('.tl-objhead.sel, .tl-elhead.sel, .tl-prop.sel, .tl-camposrow.sel').forEach((n) => n.classList.remove('sel'));
    this.inner.querySelectorAll('.tl-objhead.kin').forEach((n) => n.classList.remove('kin'));
    if (this.objectId) {
      this.inner.querySelector(`.blk.ob[data-obj="${this.objectId}"]`)?.classList.add('sel');
      this.inner.querySelector(`.tl-objhead[data-obj="${this.objectId}"]`)?.classList.add('sel');
      const obj = this._obj(this.objectId);
      const kin = new Set(childrenOf(this.project, this.objectId));
      if (obj?.parent?.id) kin.add(obj.parent.id);
      for (const id of kin) {
        this.inner.querySelector(`.tl-objhead[data-obj="${id}"]`)?.classList.add('kin');
      }
      if (this.propSel && this.propSel.objId === this.objectId) {
        this.inner.querySelector(`.tl-prop[data-obj="${this.propSel.objId}"][data-path="${this.propSel.path}"]`)?.classList.add('sel');
      }
    }
    if (this.elementId) {
      this.inner.querySelector(`.blk.el[data-id="${this.elementId}"]`)?.classList.add('sel');
      this.inner.querySelector(`.tl-elhead[data-el="${this.elementId}"]`)?.classList.add('sel');
      if (this.propSel && this.propSel.elId === this.elementId) {
        this.inner.querySelector(`.tl-elprop[data-el="${this.propSel.elId}"][data-path="${this.propSel.path}"]`)?.classList.add('sel');
      }
    }
    if (this.cameraSel) {
      const camId = this._activeCameraId();
      if (camId) {
        this.inner.querySelector(`.blk.cam[data-cam="${camId}"]`)?.classList.add('sel');
        this.inner.querySelector(`.tl-camhead[data-cam="${camId}"]`)?.classList.add('sel');
      }
      this.inner.querySelector('.tl-camposrow')?.classList.add('sel');
    }
    this._paintPool();
  }

  _pickPool(kind, ref, ev) {
    const additive = !!(ev?.ctrlKey || ev?.metaKey || ev?.shiftKey);
    // Keyframes cannot mix into an element/property pool: Ctrl-clicking one is
    // ignored until the pool is cleared and keyframes are selected on their own.
    if (kind === 'keyframe' && additive && this.pool.kind !== 'keyframe') return false;
    this.pool = additive ? addSelection(this.pool, kind, ref) : selectOne(kind, ref);
    return true;
  }

  /**
   * Ctrl/Cmd-drag the ruler to zoom. The playhead is the anchor, so its screen
   * x stays fixed while the time scale changes. This path never seeks.
   */
  _startZoomDrag(ev) {
    this.onPause?.();
    const startX = ev.clientX;
    const startZoom = this.zoom;
    const ruler = this.rulerTrack;
    const oldCursor = ruler.style.cursor;
    ruler.style.cursor = 'ew-resize';
    const move = (e) => {
      const dx = e.clientX - startX;
      this.setZoom(startZoom * Math.exp(dx / 220), null);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      ruler.style.cursor = oldCursor;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Ruler-only scrub: the time axis is the only place that seeks. */
  _startScrub(ev) {
    const seek = (e) => {
      this._noSnap = e.altKey;
      this.onSeek?.(this._snap(this._timeAt(e.clientX)));
    };
    seek(ev);
    const move = (e) => seek(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * Drag a box over the lower lanes to select keyframe diamonds. This replaces
   * the old "empty lane click scrubs" behaviour; the ruler is now the only
   * seek surface. A click without movement clears the keyframe pool.
   */
  _startMarquee(ev) {
    const startClient = { x: ev.clientX, y: ev.clientY };
    let lastClient = { ...startClient };
    const box = el('div', 'tl-marquee');
    box.hidden = true;
    this.inner.appendChild(box);
    let moved = false;

    // A mostly-horizontal drag still needs a visible band around its row.
    const padded = (a, b) => {
      let left = Math.min(a.x, b.x);
      let right = Math.max(a.x, b.x);
      let top = Math.min(a.y, b.y);
      let bottom = Math.max(a.y, b.y);
      if (bottom - top < 18) {
        const mid = (top + bottom) / 2;
        top = mid - 9;
        bottom = mid + 9;
      }
      if (right - left < 8) {
        const mid = (left + right) / 2;
        left = mid - 4;
        right = mid + 4;
      }
      return { left, right, top, bottom };
    };

    const update = (e) => {
      lastClient = { x: e.clientX, y: e.clientY };
      const rect = this.inner.getBoundingClientRect();
      const band = padded(startClient, lastClient);
      box.style.left = `${band.left - rect.left}px`;
      box.style.top = `${band.top - rect.top}px`;
      box.style.width = `${band.right - band.left}px`;
      box.style.height = `${band.bottom - band.top}px`;
      if (!moved && Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) > 3) {
        moved = true;
        box.hidden = false;
      }
    };

    const up = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', up);
      box.remove();
      if (!moved) {
        this.pool = emptySelection();
        this.cameraSel = false;
        this.objectId = null;
        this.elementId = null;
        this.segmentId = null;
        this.propSel = null;
        this.onSelect?.({ elementId: null, segmentId: null, objectId: null, camera: false, pool: this.pool });
        this._paintSelection();
        return;
      }
      const band = padded(startClient, lastClient);
      const ids = [];
      this.inner.querySelectorAll('.tl-key[data-t]').forEach((node) => {
        const r = node.getBoundingClientRect();
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        if (cx < band.left || cx > band.right || cy < band.top || cy > band.bottom) return;
        let ref = null;
        if (node.dataset.cam) ref = keyframeRef(cameraRef(node.dataset.cam), node.dataset.path || 'path', Number(node.dataset.t));
        else if (node.dataset.obj) ref = keyframeRef(objectRef(node.dataset.obj), node.dataset.path, Number(node.dataset.t));
        else if (node.dataset.id && node.dataset.path) ref = keyframeRef(elementRef(node.dataset.id), node.dataset.path, Number(node.dataset.t));
        if (ref && !ids.includes(ref)) ids.push(ref);
      });
      this.pool = ids.length
        ? normalizeSelection({ kind: 'keyframe', ids, primary: ids[0] })
        : emptySelection();
      this.cameraSel = false;
      this.objectId = null;
      this.elementId = null;
      this.segmentId = null;
      this.propSel = null;
      this.onSelect?.({ elementId: null, segmentId: null, objectId: null, camera: false, pool: this.pool });
      this._paintSelection();
    };

    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', up);
  }

  _down(ev) {
    if (ev.button !== 0) return;
    const target = ev.target;
    // controls / fields handle themselves (focus, clicks)
    if (/INPUT|TEXTAREA|SELECT/.test(target.tagName || '') || target.closest('button')) return;
    if (target.closest('.tl-sect')) return;
    // Only the time ruler seeks; the rows below are selection surfaces.
    if (target.closest('.tl-ruler')) {
      if (target.closest('.tl-gutter')) return;
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        this._startZoomDrag(ev);
        return;
      }
      this._startScrub(ev);
      return;
    }
    ev.preventDefault();
    this._noSnap = ev.altKey;
    const blk = target.closest?.('.blk');
    const gutterEl = target.closest?.('.tl-gutter[data-id]');

    // ---- 3D elements ----
    const camKeyEl = target.closest?.('.tl-key[data-cam]');
    if (camKeyEl) {
      const t = Number(camKeyEl.dataset.t);
      const ref = keyframeRef(cameraRef(camKeyEl.dataset.cam), camKeyEl.dataset.path || 'path', t);
      if (!this._pickPool('keyframe', ref, ev)) return;
      this.cameraSel = true;
      this.elementId = null; this.segmentId = null; this.objectId = null;
      this.onSelect?.({ camera: true, pool: this.pool });
      this._paintSelection();
      return;
    }
    const elKeyEl = target.closest?.('.tl-key[data-el]');
    if (elKeyEl) {
      const t = Number(elKeyEl.dataset.t);
      const id = elKeyEl.dataset.el;
      const ref = keyframeRef(elementRef(id), elKeyEl.dataset.path, t);
      if (!this._pickPool('keyframe', ref, ev)) return;
      this.elementId = id;
      this.objectId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = { elId: id, path: elKeyEl.dataset.path };
      this.onSelect?.({ elementId: id, pool: this.pool });
      this._paintSelection();
      return;
    }
    const key = target.closest?.('.tl-key');
    if (key && key.dataset.obj) {
      const t = Number(key.dataset.t);
      const ref = keyframeRef(objectRef(key.dataset.obj), key.dataset.path, t);
      if (!this._pickPool('keyframe', ref, ev)) return;
      this.objectId = key.dataset.obj;
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = { objId: key.dataset.obj, path: key.dataset.path };
      this.onSelect?.({ objectId: this.objectId, pool: this.pool });
      this._paintSelection();
      return;
    }
    const elPropGutter = target.closest?.('.tl-elprop[data-el] .tl-gutter');
    if (elPropGutter) {
      const pr = elPropGutter.closest('.tl-elprop');
      const id = pr.dataset.el;
      const ref = propertyRef(elementRef(id), pr.dataset.path);
      if (!this._pickPool('property', ref, ev)) return;
      this.elementId = id;
      this.objectId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = { elId: id, path: pr.dataset.path };
      this.onSelect?.({ elementId: id, pool: this.pool });
      this._paintSelection();
      return;
    }
    const propGutter = target.closest?.('.tl-prop[data-obj] .tl-gutter');
    if (propGutter) {
      const pr = propGutter.closest('.tl-prop');
      const id = pr.dataset.obj;
      const ref = propertyRef(objectRef(id), pr.dataset.path);
      if (!this._pickPool('property', ref, ev)) return;
      this.objectId = id;
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = { objId: id, path: pr.dataset.path };
      this.onSelect?.({ objectId: id, pool: this.pool });
      this._paintSelection();
      return;
    }
    // camera row header: select/activate + vertical drag to reorder the stack
    const camHead = target.closest?.('.tl-camhead[data-cam]');
    if (camHead) {
      this._startCameraDrag(camHead.dataset.cam, ev.clientY, camHead);
      return;
    }
    // 2D element header: select without moving the clip
    const elHead = target.closest?.('.tl-elhead[data-el]');
    if (elHead && !target.closest?.('.blk.el')) {
      const id = elHead.dataset.el;
      this.elementId = id;
      this._pickPool('element', elementRef(id), ev);
      this.objectId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = null;
      this.onSelect?.({ elementId: id, pool: this.pool });
      this._paintSelection();
      return;
    }
    const objHead = target.closest?.('.tl-objhead');
    if (objHead && !target.closest?.('.blk.ob')) {
      this.objectId = objHead.dataset.obj;
      this._pickPool('element', objectRef(this.objectId), ev);
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.onSelect?.({ objectId: this.objectId, pool: this.pool });
      this._paintSelection();
      return;
    }
    const objBlk = target.closest?.('.blk.ob');
    if (objBlk) {
      const id = objBlk.dataset.obj;
      this.objectId = id;
      this._pickPool('element', objectRef(id), ev);
      this.elementId = null; this.segmentId = null; this.cameraSel = false;
      this.onSelect?.({ objectId: id, pool: this.pool });
      this._paintSelection();
      const item = this._obj(id);
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
          const end = orig.start + orig.duration;
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
    // camera property labels (the lane below is for marquee selection, not scrubbing)
    if (target.closest?.('.tl-camprop .tl-gutter')) {
      const row = target.closest('.tl-camprop');
      const camId = row.dataset.cam || this._activeCameraId();
      const path = row.dataset.path;
      if (path) {
        const ref = propertyRef(cameraRef(camId), path);
        if (!this._pickPool('property', ref, ev)) return;
      } else {
        this.pool = selectOne('element', cameraRef(camId));
      }
      this.cameraSel = true;
      this.elementId = null; this.segmentId = null; this.objectId = null;
      this.onSelect?.({ camera: true, pool: this.pool });
      this._paintSelection();
      return;
    }
    if (target.closest?.('.tl-camhint .tl-gutter')) {
      this._activateCamera(this._activeCameraId());
      return;
    }

    if (blk) {
      const id = blk.dataset.id;
      this.elementId = id;
      this._pickPool('element', elementRef(id), ev);
      this.objectId = null; this.segmentId = null; this.cameraSel = false;
      this.propSel = null;
      this.onSelect?.({ elementId: id, segmentId: this.project.elements.find((e) => e.id === id)?.segment || null, pool: this.pool });
      this._paintSelection();

      const p = this.project;
      const item = p.elements.find((e) => e.id === id);
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
        this.onOp?.({ op: 'moveElement', id, start: round3(ns), duration: round3(nd) });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    if (gutterEl) {
      this._pickPool('element', elementRef(gutterEl.dataset.id), ev);
      this.onSelect?.({ elementId: gutterEl.dataset.id, pool: this.pool });
      this.elementId = gutterEl.dataset.id;
      this._paintSelection();
      return;
    }

    // Clicking empty space below the ruler never seeks; drag to box-select
    // keyframe diamonds, or click to clear the current pool.
    if (target.closest('.tl-track')) this._startMarquee(ev);
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const fmtTick = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { escapeHtml };
