// Timeline: ruler + camera stack + 2D and 3D element rows. Segments still live
// in the project (AI / pipeline use them) but no longer get a lane here.
// Element rows expand in place: the left column edits the element's properties
// and the right lanes show per-property keyframes, all on the same row grid.
// 2D rows expose the transform in pixels and metres (transform.z is depth);
// 3D rows expose the parent/world transform. The camera is an element too:
// its attributes are folded inside the camera row.
import { timecode, sampleTrack } from '/core/time.js';
import { objectPose } from '/core/scene.js';
import { cameraRotationAt } from '/core/spatial.js';
import { rotationFromDirRoll } from '/core/rotation.js';
import { childrenOf } from '/core/hierarchy.js';
import { feedElements, normalizeFeed } from '/core/camfeed.js';
import { pathPos, cameraTransform, cameraParamValue, cameraRange } from '/core/camera.js';
import {
  emptySelection, normalizeSelection, selectOne, pickSelection, legacyFields,
  cameraRef, objectRef, elementRef, propertyRef, keyframeRef, splitRef,
} from '/core/selection.js';
import { poolHostKeys } from '/core/timeline-keys.js';
import { keyframeMoveOps } from '/core/keyframe-edit.js';
import {
  planRowInsert, planInsertionZ, planMoveZ, renumber2D, poolAnchors, sameOrder,
} from '/core/timeline-order.js';
import { attachNumberField, readNumber, writeNumber } from './numfield.js';
import { h, icon, token, prefs } from './ui.js';
import {
  cameraValueWithLinks, findLinkTarget, objectPoseWithLinks, writeBackLocalValue,
} from '/core/links.js';
import {
  cameraRowLinkPaths, elementRowLinkPaths, linkOf, linkPropLabel, linkSourceLabel,
  objectRowLinkPaths, openLinkMenu,
} from './link-menu.js';
import {
  effectiveElementRowValue, elementRowKeyPath, elementRowTarget, localElementRowValue,
  localElementRowValueAt, nodeRowPatch, rowToTarget,
} from './element-link-value.js';
import {
  XF_AXES, XF_ROWS, xfAxisKeyOps, xfAxisKeyState, xfAxisLinkPath, xfAxisPath,
  xfAxisUnkeyOps, xfKeyOps, xfKeyState, xfLinkPaths, xfLocalValues, xfMode,
  xfSetAxisOps, xfUnkeyOps, xfValues, xfVectorPath, bundleOps,
} from './xform.js';
import { normalizeFps, frameIndex, frameStart, frameBand, planRulerTicks, frameWriteTime, frameClipEdit } from './timeline-math.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

// Lanes hold the frame band plus keyframe diamonds; refreshing a lane must keep
// the band (its only other child) and only replace the diamonds.
const clearLaneKeys = (lane) => {
  for (const n of [...lane.children]) if (n.classList.contains('tl-key')) n.remove();
};

// Clip-type badge labels; colors come from the --clip-* tokens (badge-* / t-* classes).
const TYPE_LABEL = { text: '文字', image: '图片', video: '视频', shape: '形状', solid: '色块', audio: '声音' };
const AX = ['x', 'y', 'z'];
// Name column (--tl-gutter): default / clamp, persisted as prefs.tlGutter.
const GUTTER_DEFAULT = 340;
const GUTTER_MIN = 280;
const GUTTER_MAX = 480;
const clampGutter = (w) => Math.round(Math.max(GUTTER_MIN, Math.min(GUTTER_MAX, Number(w) || GUTTER_DEFAULT)));
// Zoom limits (setZoom / fit) and the toolbar slider's log mapping onto them.
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 8;
const ZOOM_STEPS = 1000;
const zoomToSlider = (z) => Math.round(((Math.log(z) - Math.log(ZOOM_MIN)) / (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN))) * ZOOM_STEPS);
const sliderToZoom = (v) => Math.exp(Math.log(ZOOM_MIN) + (Number(v) / ZOOM_STEPS) * (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN)));
// Clips narrower than this hide their right-side meta ("7 关键点", "2.00s").
const CLIP_META_MIN = 90;
// Playback: how often the property fields may be rewritten while the playhead
// runs (~11 Hz). The playhead, the frame band and the timecode still follow
// every frame; a pause or a seek flushes the last skipped tick immediately.
const VALUE_SYNC_MS = 90;
// Rows this far outside the visible part of the scroller still refresh, so a
// row scrolled just off screen is not stale when it comes back.
const ROW_SYNC_PAD = 120;

// Link target path -> the row `data-path` this timeline draws for it. Used by
// revealProperty() after a "转到父级" jump. `transform.*` is the legacy 2D row
// path; link data itself is always pivot.* / roll / scale.* (core/links.js).
const EL_LINK_ROW_PATH = Object.freeze({
  'pivot.x': 'pivot', 'pivot.y': 'pivot', 'pivot.z': 'pivot',
  'position.x': 'position', 'position.y': 'position', 'position.z': 'position',
  'scale.x': 'scale', 'scale.y': 'scale', 'scale.z': 'scale', scale: 'scale',
  roll: 'rotation', opacity: 'transform.opacity',
  'rotation.x': 'rotation', 'rotation.y': 'rotation', 'rotation.z': 'rotation',
  'audio.volume': 'audio.volume',
});
const OB_LINK_ROW_PATH = (path) => {
  if (path === 'opacity' || path === 'roll') return path;
  if (/^rotation\.[xyz]$/.test(path)) return 'rotation';
  return /^(pivot|position|scale)\./.test(path) ? path.slice(0, path.indexOf('.')) : null;
};
const CAM_LINK_ROW_PATH = (path) => {
  if (path.startsWith('pivot.')) return 'pivot';
  if (path.startsWith('scale.')) return 'scale';
  if (path.startsWith('rotation.')) return 'rotation';
  if (path === 'position' || path === 'path') return 'position';
  return path;
};

/** Link target path -> the row this timeline draws, for one 2D element. */
function elLinkRowPath(el, path) {
  const source = String(path ?? '');
  if (el?.node) return EL_LINK_ROW_PATH[source] ?? null;
  if (source === 'pivot.x') return 'transform.x';
  if (source === 'pivot.y') return 'transform.y';
  if (source === 'pivot.z') return 'transform.z';
  if (source === 'scale.x' || source === 'scale.y') return 'transform.scale';
  if (source === 'roll' || source === 'rotation.z') return 'transform.rotation';
  if (source === 'opacity') return 'transform.opacity';
  return null;
}

export class Timeline {
  constructor(root, {
    onSeek, onSelect, onOp, onPause, onElementMenu, onCameraMenu, onClipMenu, onSplit, onTextEdit,
    onToggleCurves, isCurvesOpen, sourceDuration, onSourceLimit, onToast, onLinkJump,
  } = {}) {
    this.root = root;
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onOp = onOp;
    this.onPause = onPause;
    this.onElementMenu = onElementMenu;
    this.onCameraMenu = onCameraMenu;
    this.onClipMenu = onClipMenu;
    this.onSplit = onSplit;
    this.onTextEdit = onTextEdit;
    this.onToggleCurves = onToggleCurves;
    this.isCurvesOpen = isCurvesOpen;
    this.sourceDuration = sourceDuration;
    this.onSourceLimit = onSourceLimit;
    this.onToast = onToast;
    this.onLinkJump = onLinkJump;
    this.project = null;
    this.time = 0;
    this.pool = emptySelection();
    this.segmentId = null;
    this.elementId = null;
    this.objectId = null;
    this.cameraSel = false;
    // Camera property pages that are open, like expandedEls: ephemeral UI state,
    // independent of which camera is active. Several cameras may be open at once.
    this.openCams = new Set();
    this.soloCameras = new Set();
    this._camPosRows = [];
    this._camPropRows = [];
    this._camDrag = null;
    this.zoom = 1;
    this.pps = 60;
    this.expanded = new Set();
    this.sections = {
      content: 'full', transform: 'full', audio: 'full', camPos: 'full',
      camMain: 'collapsed', camShake: 'collapsed', camDof: 'collapsed',
    };
    this.propSel = null;
    this._scrollTo = null;
    this._frameBand = null; // cached { frame, left, width, atEnd } for the playhead
    this._frameBands = []; // one band element per track (moved by _syncFrameBand)
    this._bandLeft = NaN;
    this._bandW = NaN;
    this._lastValues = 0; // wall clock of the last property-field refresh
    this._valueSyncRaf = 0;
    this._pending = new Map();
    this._editTimes = new Map();
    this._propRows = [];
    this._elPropRows = [];
    this._xformRows = [];
    this._xformOpen = new Set();
    this._linkButtons = [];
    this._objHeads = new Map();
    this._elHeads = new Map();
    this.expandedEls = new Set();
    // "Keyed only" pass (U): the row expansion / group state from before the
    // pass, restored by the second U. `_keyedOnly` itself forces every group
    // into keyed mode and hides the group label rows.
    this._keyedOnly = false;
    this._keyedSnapshot = null;
    this._snapOn = prefs.get('snap', true) !== false;
    this._gutterW = clampGutter(prefs.get('tlGutter', GUTTER_DEFAULT));
    this.filterText = '';
    // One unified row list (audio / cameras / 2D / 3D). The display order is
    // persisted in meta.ui.timelineOrder; only 2D rows (el.z) and camera rows
    // (cameraOrder) are semantic, 3D/audio rows are display-only.
    this.viewOrder = [];
    this._rankCam = new Map();
    this._rank2D = new Map();
    this._rowDragging = false;
    this._rowCommitting = false;
    this._rowDrag = null;
    this._dropLine = null;
    this._rowDragTimer = null;
    this._build();
    window.addEventListener('resize', () => this._layout());
  }

  _build() {
    this.root.classList.add('tl');
    this.root.style.setProperty('--tl-gutter', `${this._gutterW}px`);
    this._buildToolbar();
    this.scroll = el('div', 'tl-scroll');
    this.inner = el('div', 'tl-inner');
    this.scroll.appendChild(this.inner);
    this.root.appendChild(this.scroll);

    this.rulerRow = el('div', 'tl-row tl-ruler');
    this.rulerGutter = el('div', 'tl-gutter');
    this.timeLabel = el('span', 'tl-sub');
    // drag the name column's right edge (ruler row) to resize --tl-gutter
    const grip = el('div', 'tl-gutter-grip');
    grip.addEventListener('pointerdown', (e) => this._startGutterDrag(e, grip));
    this.rulerGutter.append(el('span', '', '时间轴'), this.timeLabel, grip);
    this.rulerTrack = el('div', 'tl-track');
    this.rulerRow.append(this.rulerGutter, this.rulerTrack);

    // One host for every header row + its expanded property rows. The order is
    // meta.ui.timelineOrder, reconciled against z / cameraOrder on each render.
    this.rowsWrap = el('div', 'tl-rows');
    this.playhead = el('div', 'tl-playhead');
    const splitBtn = h('button', {
      type: 'button', class: 'tl-split', 'aria-label': '在播放头切开', 'data-tip': '单击切开 · 拖动移动播放头', 'data-kbd': 'Ctrl+D',
    }, icon('scissors', 'ic-sm'));
    // The scissors ride on the playhead, so they double as its drag handle:
    // past 3px of movement it scrubs like the ruler; a plain click still splits.
    let splitDragged = false;
    splitBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      e.preventDefault();
      splitDragged = false;
      const x0 = e.clientX;
      const move = (m) => {
        if (!splitDragged && Math.abs(m.clientX - x0) < 3) return;
        if (!splitDragged) { splitDragged = true; this.onPause?.(); document.body.classList.add('tl-scrubbing'); }
        this._noSnap = m.altKey;
        this.onSeek?.(this._snapPlayhead(this._timeAt(m.clientX)));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        document.body.classList.remove('tl-scrubbing');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    splitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (splitDragged) { splitDragged = false; return; }
      this.onSplit?.();
    });
    this.playhead.appendChild(splitBtn);
    this.playheadLayer = el('div', 'tl-playhead-layer');
    this.playheadLayer.appendChild(this.playhead);
    this.inner.append(this.rulerRow, this.rowsWrap);

    // Native horizontal scrollbars span the whole footer, including the sticky
    // property gutter (--tl-gutter). Draw our own track starting at the gutter so the
    // scroll range never looks like it belongs to the property editor.
    this.hscroll = el('div', 'tl-hscroll');
    this.hthumb = el('div', 'tl-hthumb');
    this.hscroll.appendChild(this.hthumb);
    this.root.appendChild(this.hscroll);
    this.root.appendChild(this.playheadLayer);
    this.hthumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hthumb.classList.add('drag');
      const startX = e.clientX;
      const startScroll = this.scroll.scrollLeft;
      const track = Math.max(1, this.hscroll.clientWidth);
      const thumb = Math.max(1, this.hthumb.offsetWidth);
      const maxThumb = Math.max(1, track - thumb);
      const maxScroll = Math.max(0, this.scroll.scrollWidth - this.scroll.clientWidth);
      const move = (ev) => {
        const x = Math.max(0, Math.min(maxThumb, (ev.clientX - startX) + (startScroll / Math.max(1, maxScroll)) * maxThumb));
        this.scroll.scrollLeft = maxScroll ? (x / maxThumb) * maxScroll : 0;
      };
      const up = () => {
        this.hthumb.classList.remove('drag');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.hscroll.addEventListener('pointerdown', (e) => {
      if (e.target === this.hthumb) return;
      e.preventDefault();
      const r = this.hscroll.getBoundingClientRect();
      const thumb = Math.max(1, this.hthumb.offsetWidth);
      const maxThumb = Math.max(1, r.width - thumb);
      const maxScroll = Math.max(0, this.scroll.scrollWidth - this.scroll.clientWidth);
      const x = Math.max(0, Math.min(maxThumb, e.clientX - r.left - thumb / 2));
      this.scroll.scrollLeft = maxScroll ? (x / maxThumb) * maxScroll : 0;
    });

    this.inner.addEventListener('pointerdown', (e) => this._down(e));
    this.scroll.addEventListener('scroll', () => {
      this._syncHScroll();
      this._syncPlayhead();
      // Rows that just scrolled into view were skipped while they were off
      // screen; bring their fields up to date before the next paint.
      this._scheduleValueSync();
      this.onViewChange?.();
    });
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
        if (this._rowFocused()) return;
        this._renderPending = false;
        this.render(true);
      }, 0);
    }, true);
    // The 曲线 toggle mirrors the F2 drawer, which lives in this root too and
    // opens/closes from F2, Esc and its own close button.
    new MutationObserver((list) => {
      if (list.some((m) => m.target.classList?.contains('curve-panel'))) this._syncCurvesBtn();
    }).observe(this.root, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }

  /** Focus inside the rebuilt area (rows / curve drawer), not the toolbar. */
  _rowFocused(active = document.activeElement) {
    return !!active && this.root.contains(active) && !this.toolbar.contains(active);
  }

  // ------------------------------------------------------------ toolbar (DESIGN.md §1.5)
  _buildToolbar() {
    const btn = (ic, label, tip, kbd, onClick, extra = {}) => {
      const b = h('button', {
        type: 'button', class: 'btn mini ghost tl-tb-btn', 'data-tip': tip, 'data-kbd': kbd, ...extra,
      }, icon(ic, 'ic-sm'), label ? h('span', {}, label) : null);
      b.addEventListener('click', onClick);
      return b;
    };
    const iconBtn = (ic, label, kbd, onClick) => {
      const b = h('button', {
        type: 'button', class: 'icon-btn mini tl-tb-btn', 'aria-label': label, 'data-tip': label, 'data-kbd': kbd,
      }, icon(ic, 'ic-sm'));
      b.addEventListener('click', onClick);
      return b;
    };

    this.filterInput = h('input', {
      type: 'text', class: 'tl-filter-input', placeholder: '筛选图层', 'aria-label': '筛选图层', spellcheck: 'false',
      autocomplete: 'off',
    });
    this.filterCount = h('span', { class: 'tl-filter-count' });
    this.filterInput.addEventListener('input', () => this._setFilter(this.filterInput.value));
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.filterInput.value = '';
      this._setFilter('');
      this.filterInput.blur();
    });
    const filter = h('label', { class: 'tl-filter', 'data-tip': '按名称或 ID 筛选图层', 'data-kbd': 'Ctrl+F' },
      icon('search', 'ic-sm'), this.filterInput, this.filterCount);

    const keyed = btn('keyframe', '仅带键', '只看带关键帧的属性', 'U', () => {
      if (this.applyKeyedFilter()) return;
      keyed.classList.remove('shake');
      void keyed.offsetWidth; // restart the no-op shake
      keyed.classList.add('shake');
    });
    keyed.addEventListener('animationend', () => keyed.classList.remove('shake'));
    this._keyedBtn = keyed;
    this._snapBtn = btn('magnet', '吸附', '吸附到 0 / 结尾 / 节拍（拖动时按住 Alt 临时关闭）', null,
      () => this.setSnap(!this._snapOn), { 'aria-pressed': 'false' });
    const split = btn('scissors', '切开', '在播放头切开', 'Ctrl+D', () => this.onSplit?.());
    this._curvesBtn = btn('curve', '曲线', '曲线面板', 'F2', () => {
      this.onToggleCurves?.();
      this._syncCurvesBtn();
    }, { 'aria-pressed': 'false' });

    this._zoomRange = h('input', {
      type: 'range', class: 'tl-zoomrange', min: '0', max: String(ZOOM_STEPS), step: '1',
      'aria-label': '时间轴缩放', 'data-tip': '时间轴缩放', 'data-kbd': 'Ctrl+滚轮',
    });
    this._zoomRange.addEventListener('input', () => this.setZoom(sliderToZoom(this._zoomRange.value)));
    this._zoomLabel = h('span', { class: 'tl-zoomval' }, '100%');
    const zOut = iconBtn('zoom-out', '缩小', null, () => this.zoomBy(0.8));
    const zIn = iconBtn('zoom-in', '放大', null, () => this.zoomBy(1.25));
    const zFit = btn('fit', '适应', '缩放到整段时长（双击标尺）', null, () => this.fit());

    this.toolbar = h('div', { class: 'tl-toolbar', role: 'toolbar', 'aria-label': '时间轴' },
      filter, keyed, this._snapBtn, h('span', { class: 'tl-tb-sep', role: 'separator' }), split, this._curvesBtn,
      h('span', { class: 'tl-tb-spacer' }),
      zOut, this._zoomRange, zIn, this._zoomLabel, zFit);
    this.root.appendChild(this.toolbar);
    this._syncSnapBtn();
    this._syncKeyedBtn();
    this._syncZoomUi();
  }

  /** Focus + select the toolbar filter (Ctrl+F). */
  focusFilter() {
    this.filterInput.focus();
    this.filterInput.select();
  }

  get snap() { return this._snapOn; }

  setSnap(on) {
    this._snapOn = !!on;
    prefs.set('snap', this._snapOn);
    this._syncSnapBtn();
  }

  _syncSnapBtn() {
    this._snapBtn?.setAttribute('aria-pressed', String(this._snapOn));
  }

  /** Toolbar 仅带键 button reflects the keyed-only pass (U). */
  _syncKeyedBtn() {
    if (!this._keyedBtn) return;
    this._keyedBtn.setAttribute('aria-pressed', String(this._keyedOnly));
    this._keyedBtn.classList.toggle('on', this._keyedOnly);
  }

  _syncCurvesBtn() {
    if (!this._curvesBtn) return;
    const open = this.isCurvesOpen
      ? !!this.isCurvesOpen()
      : !!this.root.querySelector(':scope > .curve-panel:not([hidden])');
    this._curvesBtn.setAttribute('aria-pressed', String(open));
  }

  _syncZoomUi() {
    if (this._zoomLabel) this._zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    if (this._zoomRange) this._zoomRange.value = String(zoomToSlider(this.zoom));
  }

  _setFilter(text) {
    this.filterText = String(text || '');
    this._applyFilter();
  }

  /**
   * Hide header rows (camera / 2D / audio / 3D) whose name or id does not
   * contain the filter text. Their expanded property rows follow the header in
   * the same unified list and hide with it.
   */
  _applyFilter() {
    const q = this.filterText.trim().toLowerCase();
    const rows = [...this.rowsWrap.children];
    let total = 0;
    let shown = 0;
    let visible = true;
    for (const r of rows) {
      if (r.dataset.filter != null) {
        total++;
        visible = !q || r.dataset.filter.includes(q);
        if (visible) shown++;
      }
      r.classList.toggle('tl-filtered', !visible);
    }
    if (this.filterCount) this.filterCount.textContent = `${shown} / ${total}`;
  }

  /** Header row element for a selection ref ('cam:id' / 'ob:id' / 'el:id'). */
  _rowOf(ref) {
    const r = splitRef(ref);
    if (!r) return null;
    const q = CSS.escape(String(r.id));
    return r.type === 'cam' ? this.inner.querySelector(`.tl-camhead[data-cam="${q}"]`)
      : r.type === 'ob' ? this.inner.querySelector(`.tl-objhead[data-obj="${q}"]`)
        : this.inner.querySelector(`.tl-elhead[data-el="${q}"]`);
  }

  /**
   * Scroll a camera / element / object header row into view (vertically) and
   * its clip start (horizontally). Expansion and selection are untouched.
   * `ref` is a selection ref ('cam:id' / 'ob:id' / 'el:id', leaf parts ignored)
   * or { kind: 'element' | 'object' | 'camera', id }. Returns false when the
   * row is not on screen (unknown id, or hidden by the filter).
   */
  reveal(ref) {
    let kind = null;
    let id = null;
    if (ref && typeof ref === 'object') {
      kind = ref.kind;
      id = ref.id;
    } else {
      const r = splitRef(ref);
      if (r) {
        kind = r.type === 'cam' ? 'camera' : r.type === 'ob' ? 'object' : 'element';
        id = r.id;
      }
    }
    if (!kind || id == null || !this.project) return false;
    const row = this._rowOf(ref);
    if (!row || !row.getClientRects().length) return false;

    const sr = this.scroll.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const top = sr.top + (this.rulerRow?.offsetHeight || 26);
    const bottom = sr.top + this.scroll.clientHeight;
    if (r.top < top) this.scroll.scrollTop -= (top - r.top) + 4;
    else if (r.bottom > bottom) this.scroll.scrollTop += (r.bottom - bottom) + 4;

    const item = kind === 'camera' ? this._camById(id) : kind === 'object' ? this._obj(id) : this._element(id);
    const start = !item ? 0 : kind === 'camera' ? cameraRange(this.project, item).start : (Number(item.start) || 0);
    const x = this._trackX(start);
    const viewL = this.scroll.scrollLeft + this._gutter();
    const viewR = this.scroll.scrollLeft + this.scroll.clientWidth;
    if (x < viewL + 8 || x > viewR - 40) this.scroll.scrollLeft = Math.max(0, x - this._gutter() - 40);
    return true;
  }

  /**
   * Scroll to an expanded property row (property-link "转到父级"). `path` is the
   * link source path (`pivot.x`, `roll`, `fov`, …); it is mapped onto the row
   * path this timeline draws. Falls back to the host header when the row is not
   * rendered (collapsed group, keyed-only pass, or a 3D roll with no row here).
   * Returns false only when neither the row nor the header can be shown.
   */
  revealProperty(ref, path) {
    let kind = null;
    let id = null;
    if (ref && typeof ref === 'object') {
      kind = ref.kind;
      id = ref.id;
    } else {
      const r = splitRef(ref);
      if (r) {
        kind = r.type === 'cam' ? 'camera' : r.type === 'ob' ? 'object' : 'element';
        id = r.id;
      }
    }
    if (!kind || id == null || !this.project) return false;
    const source = String(path ?? '');
    const el = kind === 'element' ? this._element(id) : null;
    const rowPath = kind === 'camera' ? CAM_LINK_ROW_PATH(source)
      : kind === 'object' ? OB_LINK_ROW_PATH(source)
        : elLinkRowPath(el, source);
    if (rowPath) {
      const q = CSS.escape(String(id));
      const sel = kind === 'camera' ? `.tl-camprop[data-cam="${q}"][data-path="${CSS.escape(rowPath)}"]`
        : kind === 'object' ? `.tl-prop[data-obj="${q}"][data-path="${CSS.escape(rowPath)}"]`
          : `.tl-elprop[data-el="${q}"][data-path="${CSS.escape(rowPath)}"]`;
      const row = this.inner.querySelector(sel);
      if (row && row.getClientRects().length) {
        const sr = this.scroll.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        const top = sr.top + (this.rulerRow?.offsetHeight || 26);
        const bottom = sr.top + this.scroll.clientHeight;
        if (r.top < top) this.scroll.scrollTop -= (top - r.top) + 4;
        else if (r.bottom > bottom) this.scroll.scrollTop += (r.bottom - bottom) + 4;
        return true;
      }
    }
    return this.reveal({ kind, id });
  }

  // ------------------------------------------------------------ row insertion
  // Every "new element" action (toolbar text/shape, asset quick add, media
  // drop, audio add, 3D add) goes through these helpers via main.js so the row
  // lands above the selection, `meta.ui.timelineOrder` is persisted in the
  // same batch as the add, and the 2D z stack agrees with the display slot.

  /** Selection anchor refs: pool hosts first (incl. non-active cameras), then the active camera. */
  _anchorRefs() {
    const out = poolAnchors(this.pool);
    // A camera selection normally carries its cam host in the pool (the primary
    // one even when another camera is active). Only legacy/empty camera
    // selections fall back to the active camera.
    if (this.cameraSel && !out.some((ref) => ref.startsWith('cam:'))) {
      const id = this._activeCameraId();
      if (id) out.push(cameraRef(id));
    }
    return out;
  }

  /** Current reconciled display order (before the new row exists). */
  _orderNow() {
    const p = this.project;
    if (!p) return [];
    const cams = Array.isArray(p.cameras) && p.cameras.length ? p.cameras : (p.camera ? [p.camera] : []);
    const objs = Array.isArray(p.scene?.objects) ? p.scene.objects : [];
    return this._reconcileOrder(p, cams, objs);
  }

  /**
   * Where a new row with `ref` should go. Returns `{ index, order }`: `index`
   * is one row above the topmost selected row (0 = top of the list) and
   * `order` is the timelineOrder value to persist with the add.
   */
  rowInsertPlan(ref) {
    return planRowInsert(this._orderNow(), this._anchorRefs(), ref);
  }

  /**
   * z value + reorder ops for a new 2D element placed by `order` (the plan from
   * rowInsertPlan). The element only needs `id`, `type` and `start`.
   */
  planElementInsertion(element, order) {
    const els = this.project?.elements || [];
    const byId = new Map(els.map((e) => [e.id, e]));
    const stack = (order || []).map(String).filter((ref) => {
      const s = splitRef(ref);
      if (!s || s.type !== 'el') return false;
      const e = byId.get(s.id);
      if (!e) return s.id === element.id && element.type !== 'audio';
      return e.type !== 'audio';
    });
    return planInsertionZ({ stack, elements: els, element });
  }

  /**
   * After the add op applied and the new row exists: top insert scrolls (smoothly)
   * to the top; otherwise reveal the row. A filter that hides the new row is
   * cleared first so the reveal can actually land on it.
   */
  afterInsertRow({ index = 0, ref } = {}) {
    if (!this.project || !ref) return;
    if (this.filterText.trim()) {
      const q = this.filterText.trim().toLowerCase();
      const row = this._rowOf(ref);
      if (row && !String(row.dataset.filter || '').includes(q)) {
        this._setFilter('');
        if (this.filterInput) this.filterInput.value = '';
      }
    }
    if (!index) {
      // Respect reduced-motion: the jump is still instant, just not animated.
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      this.scroll.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      return;
    }
    this.reveal(ref);
  }

  /** Left edge of the frame the playhead sits in (the display frame's start). */
  frameStart(t) {
    const fps = Math.max(1, Math.round(Number(this.project?.meta.fps) || 24));
    const f = Math.max(0, Math.floor((Number(t) || 0) * fps + 1e-6));
    return Math.floor((f / fps) * 1e6) / 1e6;
  }

  /** Playhead time snapped to the left edge of its display frame. */
  playheadStart() {
    return this._displayTime();
  }

  // ------------------------------------------------------------ name column width
  _setGutterWidth(w) {
    const next = clampGutter(w);
    if (next === this._gutterW) return false;
    this._gutterW = next;
    this.root.style.setProperty('--tl-gutter', `${next}px`);
    // lanes are positioned inside .tl-track, so only the content width, the
    // custom h-scrollbar and the playhead layer (both inset by the gutter) depend on it
    if (this.project && this.pps) {
      this.inner.style.width = `${this._gutter() + this.project.meta.duration * this.pps + 60}px`;
      this.setTime(this.time);
      this._syncHScroll();
    }
    this.onViewChange?.();
    return true;
  }

  /** Public: set the name column width (clamped 280–480) and persist it. */
  setGutter(w) {
    this._setGutterWidth(w);
    prefs.set('tlGutter', this._gutterW);
  }

  _startGutterDrag(ev, grip) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = this._gutterW;
    grip.classList.add('dragging');
    document.body.classList.add('tl-gutter-resizing');
    const move = (e) => this._setGutterWidth(startW + (e.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      grip.classList.remove('dragging');
      document.body.classList.remove('tl-gutter-resizing');
      prefs.set('tlGutter', this._gutterW);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ------------------------------------------------------------ state
  /**
   * First load fits the whole project into view. Later calls (an edit, a new
   * element, a duration change) must NOT refit: a long clip added at the end
   * would otherwise reset the user's zoom/scroll. Double-clicking the ruler
   * (`fit()`) is the explicit way to refit.
   */
  setProject(p) {
    const firstLoad = !this.project;
    this.project = p;
    if (firstLoad) {
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
    // The pool primary drives the legacy fields, so a mixed cam / ob / el pool
    // still highlights exactly one row. Main derives the same values.
    const host = legacyFields(this.pool, {
      elementId: sel?.elementId, objectId: sel?.objectId, camera: sel?.camera,
    });
    this.segmentId = sel?.segmentId || null;
    this.elementId = host.elementId;
    this.objectId = host.objectId;
    this.cameraSel = host.camera;
    if (this.objectId !== prev || this.elementId !== prevEl) this.propSel = null;
    // Selection alone never opens a property group. A second click on the
    // already-selected row does that (see _down / viewport click handling).
    this._paintSelection();
  }

  /**
   * Adopt the pool primary as the timeline's own single-selection fields and
   * tell main. Every pick path goes through here: a Ctrl toggle that removes a
   * host has to move the legacy selection to the surviving primary, otherwise
   * Delete / the inspector would keep acting on the ref that just left the pool.
   */
  _selectPoolHost(explicit = {}) {
    const host = legacyFields(this.pool, explicit);
    this.elementId = host.elementId;
    this.objectId = host.objectId;
    this.cameraSel = host.camera;
    const segmentId = host.elementId ? (this._element(host.elementId)?.segment || null) : null;
    this.onSelect?.({ ...host, segmentId, pool: this.pool });
    return host;
  }

  /**
   * One time tick. `live` marks a playback frame (the editor's rAF loop): the
   * playhead, the frame band and the timecode follow every frame, but the
   * property fields are refreshed at most every VALUE_SYNC_MS. Every other
   * caller (seek, scrub, edit, capture) syncs immediately.
   */
  setTime(t, { live = false } = {}) {
    this.time = t;
    const dur = this.project?.meta.duration || 12;
    if (this.timeLabel) this.timeLabel.textContent = `${t.toFixed(2)} / ${dur.toFixed(2)}s`;
    const x = this._trackX(this._displayTime(t));
    if (this.scroll.scrollLeft > x - this._gutter() - 20) {
      this.scroll.scrollLeft = Math.max(0, x - this._gutter() - 80);
    }
    this._syncPlayhead();
    this._syncFrameBand();
    if (live) this._syncValuesSoon();
    else this._syncValues();
    this.onTimeChange?.();
  }

  /** Refresh the property fields now (pause, an edit, a capture at time t). */
  flushValues() {
    this._syncValues();
  }

  fit() {
    const w = this.scroll.clientWidth - this._gutter() - 24;
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, w / Math.max(1, this.project?.meta.duration || 12) / 60));
    this._layout();
    this.onViewChange?.();
  }

  /** Zoom around `clientX` (defaults to the playhead) and keep that time in place. */
  setZoom(z, clientX = null) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(z) || this.zoom));
    if (Math.abs(next - this.zoom) < 1e-6) return;
    const rect = this.scroll.getBoundingClientRect();
    const anchorX = clientX != null
      ? Math.max(0, Math.min(this.scroll.clientWidth, clientX - rect.left))
      : Math.max(8, Math.min(this.scroll.clientWidth - 8, this._trackX(this._displayTime()) - this.scroll.scrollLeft));
    const anchorTime = (anchorX + this.scroll.scrollLeft - this._gutter()) / Math.max(1, this.pps);
    this.zoom = next;
    this._layout();
    this.scroll.scrollLeft = Math.max(0, this._gutter() + anchorTime * this.pps - anchorX);
    this.onViewChange?.();
  }

  zoomBy(factor, clientX = null) {
    this.setZoom(this.zoom * factor, clientX);
  }

  _gutter() { return this._gutterW; }
  _trackX(t) { return this._gutter() + t * this.pps; }
  _fps() { return normalizeFps(this.project?.meta.fps); }

  /**
   * Time to write into the project for a new key or a dragged clip edge: the
   * left edge of the frame under `t`, rounded up to the stored millisecond so
   * frameIndex() still reads the same frame (round3 can drop one frame).
   * Callers snap first (`_snap`: 0 / end / beats), so Alt — which turns the
   * magnet off — still lands on the frame grid. A snap that lands exactly on
   * the project end keeps its exact duration instead of rounding past the tail.
   */
  _frameTime(t = this.time) {
    return frameWriteTime(t, this._fps(), this.project?.meta.duration || 0);
  }

  /** Quantized start/duration for a block drag; see frameClipEdit. */
  _clipEdit(mode, start, duration, { maxDuration = null } = {}) {
    return frameClipEdit({
      mode,
      start,
      duration,
      fps: this._fps(),
      tail: this.project?.meta.duration || 0,
      maxDuration,
    });
  }

  /**
   * Live preview of a clip drag: the dragged edge lands on the frame grid while
   * the pointer moves, not only after release. `_snap` is the magnetic layer
   * (0 / tail / beats); this is the frame layer. The opposite edge stays where
   * the caller had it, so a trim of a legacy off-grid clip keeps that edge.
   */
  _clipPreview(mode, start, duration, { maxDuration = null } = {}) {
    const q = this._clipEdit(mode, start, duration, { maxDuration });
    return q && q.duration >= 0.08 ? q : { start, duration };
  }

  /**
   * Where the playhead line is drawn: the start of the frame under `t`, except
   * at/after the end where the exact duration keeps it on the last pixel.
   * `this.time` stays exact (playback ticks, keyframe jumps); only the line,
   * the auto-scroll x and the zoom anchor use this quantized time.
   */
  _displayTime(t = this.time) {
    const dur = this.project?.meta.duration || 0;
    const time = Math.max(0, Number(t) || 0);
    if (time >= dur) return dur;
    return frameStart(time, this._fps());
  }

  /**
   * Playhead time for a scrub: clamp, keep the existing magnet (0 / duration /
   * beats), then land on the frame grid. The exact duration is preserved at the
   * end. Only the ruler scrub and the scissors drag use this — clip drags keep
   * their sub-frame `_snap` behaviour.
   */
  _snapPlayhead(t) {
    const dur = this.project?.meta.duration || 0;
    const raw = Math.max(0, Math.min(Number(t) || 0, dur));
    const snapped = this.project ? Math.max(0, Math.min(dur, this._snap(raw))) : raw;
    if (dur > 0 && snapped >= dur) return dur;
    return frameStart(snapped, this._fps());
  }

  /**
   * The frame under the playhead is drawn once per track (rows create stacking
   * contexts and selected rows paint opaque backgrounds, so a single band
   * behind the rows would not show). Each band moves itself with a transform
   * and its width; the geometry used to live in two custom properties on
   * `.tl-rows`, and every write to an ancestor's custom property restyles the
   * whole 2800-node subtree — once per frame, at 22 fps.
   */
  _syncFrameBand() {
    if (!this.rowsWrap) return;
    const band = frameBand({
      t: this.time,
      fps: this._fps(),
      pps: this.pps,
      duration: this.project?.meta.duration || 0,
    });
    this._frameBand = band;
    if (band.left === this._bandLeft && band.width === this._bandW) return;
    this._bandLeft = band.left;
    this._bandW = band.width;
    for (const b of this._frameBands) {
      if (b.__left !== band.left) {
        b.__left = band.left;
        b.style.transform = `translateX(${band.left}px)`;
      }
      if (b.__width !== band.width) {
        b.__width = band.width;
        b.style.width = `${band.width}px`;
      }
    }
  }

  /** Keep the custom track inset over the scrollable (non-gutter) part. */
  _syncHScroll() {
    if (!this.hscroll || !this.hthumb) return;
    this.hscroll.style.left = `${this._gutter()}px`;
    const s = this.scroll;
    const maxScroll = Math.max(0, s.scrollWidth - s.clientWidth);
    this.hscroll.classList.toggle('off', maxScroll < 1);
    if (maxScroll < 1) return;
    const view = Math.max(1, s.clientWidth - this._gutter());
    const content = Math.max(view, s.scrollWidth - this._gutter());
    const track = Math.max(1, this.hscroll.clientWidth);
    const thumb = Math.max(24, Math.min(track, (track * view) / content));
    const maxThumb = Math.max(1, track - thumb);
    this.hthumb.style.width = `${thumb}px`;
    this.hthumb.style.transform = `translateX(${(s.scrollLeft / maxScroll) * maxThumb}px)`;
  }

  /** The red line belongs to the track; the sticky gutter clips it naturally. */
  _syncPlayhead() {
    if (!this.playhead || !this.playheadLayer) return;
    this.playheadLayer.style.left = `${this._gutter()}px`;
    const screen = this._trackX(this._displayTime()) - this.scroll.scrollLeft;
    this.playhead.style.transform = `translateX(${screen - this._gutter()}px)`;
  }
  _timeAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    const x = clientX - r.left + this.scroll.scrollLeft - this._gutter();
    return Math.max(0, x / this.pps);
  }

  _layout() {
    if (!this.project) return;
    if (this._fitOnce) {
      this.pps = Math.max(8, ((this.scroll.clientWidth - this._gutter() - 24) / Math.max(1, this.project.meta.duration)));
      this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.pps / 60));
      this._fitOnce = false;
    } else {
      this.pps = 60 * this.zoom;
    }
    this._syncZoomUi();
    this.render(true);
    this.onViewChange?.();
  }

  _snap(t) {
    if (this._noSnap || !this._snapOn) return t;
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
    // A rebuild while a row is being dragged would detach the header rows the
    // pointer handler is measuring. Defer until the drop (or the click) ends.
    if (this._rowDragging) { this._renderPending = true; return; }
    if (!this.pps) { this._layout(); return; }
    const active = document.activeElement;
    const focusedHere = this._rowFocused(active)
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
    this._syncHScroll();
    this._syncPlayhead();

    const objs = Array.isArray(p.scene?.objects) ? p.scene.objects : [];
    const ids = new Set(objs.map((o) => o.id));
    for (const id of [...this.expanded]) if (!ids.has(id)) this.expanded.delete(id);
    const elIds = new Set(p.elements.map((e) => e.id));
    for (const id of [...this.expandedEls]) if (!elIds.has(id)) this.expandedEls.delete(id);

    // ruler: labels adapt to the zoom, and once a frame is wide enough the
    // minor ticks switch from seconds to exact frame boundaries. Frame counts
    // are used (not accumulated seconds) so ticks never drift at 24/30/60 fps;
    // timeline-math.js also snaps major labels onto whole seconds.
    this.rulerTrack.innerHTML = '';
    const fps = this._fps();
    const totalFrames = frameIndex(dur, fps);
    const plan = planRulerTicks({ duration: dur, fps, pps: this.pps });
    const majorSet = new Set();
    for (let f = 0; f <= totalFrames; f += plan.majorFrames) majorSet.add(f);
    if (plan.minorFrames < plan.majorFrames) {
      for (let f = 0; f <= totalFrames; f += plan.minorFrames) {
        if (majorSet.has(f)) continue;
        const tick = el('div', 'tl-tick minor');
        tick.style.left = `${(f / fps) * this.pps}px`;
        this.rulerTrack.appendChild(tick);
      }
    }
    const useTimecode = plan.useTimecode;
    for (const f of majorSet) {
      const t = f / fps;
      const tick = el('div', 'tl-tick major');
      tick.style.left = `${t * this.pps}px`;
      const lab = el('span', 'tl-ticklabel', useTimecode ? timecode(t, fps) : fmtTick(t));
      tick.appendChild(lab);
      this.rulerTrack.appendChild(tick);
    }
    for (const b of (p.meta.beats || [])) {
      const bt = el('div', 'tl-beat');
      bt.style.left = `${b * this.pps}px`;
      this.rulerTrack.appendChild(bt);
    }

    // camera / element rows follow; segments live in the data only. One list:
    // the saved display order is reconciled against the real 2D layer order (z)
    // and the camera stack (cameraOrder), then every header + its expanded
    // property rows is appended in that order. 3D and audio rows are display
    // only — their position never feeds the renderer.
    const cams = Array.isArray(p.cameras) && p.cameras.length ? p.cameras : (p.camera ? [p.camera] : []);
    this.rowsWrap.innerHTML = '';
    this._camPosRows = [];
    this._camPropRows = [];
    this._propRows = [];
    this._elPropRows = [];
    this._xformRows = [];
    this._linkButtons = [];
    this._objHeads = new Map();
    this._elHeads = new Map();
    // Open camera pages survive activation changes (the active camera may well be
    // folded); only ids whose camera is gone are pruned, like expandedEls above.
    const camIds = new Set(cams.map((c) => c.id));
    for (const id of [...this.openCams]) if (!camIds.has(id)) this.openCams.delete(id);

    const order = this._reconcileOrder(p, cams, objs);
    this.viewOrder = order;
    const elById = new Map(p.elements.map((e) => [elementRef(e.id), e]));
    const camById = new Map(cams.map((c) => [cameraRef(c.id), c]));
    const objById = new Map(objs.map((o) => [objectRef(o.id), o]));
    const twoDRefs = order.filter((ref) => {
      const e = elById.get(ref);
      return e && e.type !== 'audio';
    });
    const camRefs = order.filter((ref) => camById.has(ref));
    this._rank2D = new Map(twoDRefs.map((ref, i) => [ref, i]));
    this._rankCam = new Map(camRefs.map((ref, i) => [ref, i]));
    for (const ref of order) {
      if (ref.startsWith('cam:')) {
        const cam = camById.get(ref);
        if (cam) this._cameraGroup(cam, p, this.rowsWrap);
      } else if (ref.startsWith('ob:')) {
        const o = objById.get(ref);
        if (o) this._objectGroup(o, this.rowsWrap);
      } else {
        const e = elById.get(ref);
        if (e) this._elementGroup(e, this.rowsWrap);
      }
    }

    // One frame band per track, created before _applyFilter so filtered rows
    // keep their band. First child of the track: above its background, below
    // the blocks and keyframe diamonds added after it.
    this._frameBands = [];
    const bandLeft = Number.isFinite(this._bandLeft) ? this._bandLeft : 0;
    const bandW = Number.isFinite(this._bandW) ? this._bandW : 0;
    for (const track of this.rowsWrap.querySelectorAll('.tl-track')) {
      const band = el('div', 'tl-frame-band');
      band.style.transform = `translateX(${bandLeft}px)`;
      band.style.width = `${bandW}px`;
      band.__left = bandLeft;
      band.__width = bandW;
      this._frameBands.push(band);
      track.prepend(band);
    }
    this._bandLeft = bandLeft;
    this._bandW = bandW;
    this._syncFrameBand();

    this._applyFilter();
    this.setTime(this.time);
    this._paintSelection();
    if (this._scrollTo) {
      const id = this._scrollTo;
      this._scrollTo = null;
      this._scrollObject(id);
    }
  }

  // ------------------------------------------------------------ row order
  /**
   * The order the timeline showed before meta.ui.timelineOrder existed:
   * soundtrack, camera stack, 2D elements, 3D objects.
   */
  _defaultOrder(p, cams, objs) {
    const zOf = (e) => (Number.isFinite(Number(e?.z)) ? Number(e.z) : 0);
    const startOf = (e) => (Number.isFinite(Number(e?.start)) ? Number(e.start) : 0);
    const els = [...(p.elements || [])].sort((a, b) => (zOf(b) - zOf(a)) || (startOf(a) - startOf(b)));
    const order = [];
    for (const e of els) if (e.type === 'audio') order.push(elementRef(e.id));
    const camById = new Map(cams.map((c) => [c.id, c]));
    const camIds = Array.isArray(p.cameraOrder) && p.cameraOrder.length ? p.cameraOrder : cams.map((c) => c.id);
    const seenCams = new Set();
    for (const id of camIds) {
      if (!camById.has(id) || seenCams.has(id)) continue;
      seenCams.add(id);
      order.push(cameraRef(id));
    }
    for (const c of cams) if (!seenCams.has(c.id)) order.push(cameraRef(c.id));
    for (const e of els) if (e.type !== 'audio') order.push(elementRef(e.id));
    for (const o of objs) order.push(objectRef(o.id));
    return order;
  }

  /**
   * Saved display order + current project. Real orders win inside their slots:
   * 2D rows are sorted by el.z, camera rows by cameraOrder. Audio/3D rows keep
   * whatever slot the user dragged them to.
   */
  _reconcileOrder(p, cams, objs) {
    const items = new Map();
    for (const c of cams) items.set(cameraRef(c.id), { kind: 'cam', item: c });
    for (const e of (p.elements || [])) items.set(elementRef(e.id), { kind: e.type === 'audio' ? 'audio' : 'el', item: e });
    for (const o of objs) items.set(objectRef(o.id), { kind: 'ob', item: o });

    const saved = Array.isArray(p.meta?.ui?.timelineOrder) ? p.meta.ui.timelineOrder : [];
    const order = [];
    const seen = new Set();
    for (const raw of saved) {
      const ref = String(raw);
      if (items.has(ref) && !seen.has(ref)) { order.push(ref); seen.add(ref); }
    }

    const lastWhere = (pred) => {
      for (let i = order.length - 1; i >= 0; i--) if (pred(order[i])) return i;
      return -1;
    };
    for (const ref of this._defaultOrder(p, cams, objs)) {
      if (seen.has(ref)) continue;
      const kind = items.get(ref)?.kind;
      let at;
      if (kind === 'audio') at = lastWhere((r) => items.get(r)?.kind === 'audio') + 1;
      else if (kind === 'cam') {
        at = lastWhere((r) => items.get(r)?.kind === 'cam') + 1;
        if (!at) at = lastWhere((r) => items.get(r)?.kind === 'audio') + 1;
      } else if (kind === 'el') {
        at = lastWhere((r) => items.get(r)?.kind === 'el') + 1;
        if (!at) at = lastWhere((r) => items.get(r)?.kind === 'cam') + 1;
        if (!at) at = lastWhere((r) => items.get(r)?.kind === 'audio') + 1;
      } else {
        at = order.length;
      }
      at = Math.max(0, Math.min(order.length, at));
      order.splice(at, 0, ref);
      seen.add(ref);
    }

    const camIdx = new Map();
    const camIds = Array.isArray(p.cameraOrder) && p.cameraOrder.length ? p.cameraOrder : cams.map((c) => c.id);
    camIds.forEach((id, i) => { if (!camIdx.has(id)) camIdx.set(id, i); });
    const zOf = (ref) => {
      const z = Number(items.get(ref)?.item?.z);
      return Number.isFinite(z) ? z : 0;
    };
    const startOf = (ref) => {
      const s = Number(items.get(ref)?.item?.start);
      return Number.isFinite(s) ? s : 0;
    };
    const sortSlots = (pred, cmp) => {
      const idxs = [];
      const refs = [];
      order.forEach((ref, i) => {
        if (pred(ref)) { idxs.push(i); refs.push(ref); }
      });
      refs.sort(cmp);
      idxs.forEach((idx, i) => { order[idx] = refs[i]; });
    };
    sortSlots(
      (ref) => items.get(ref)?.kind === 'cam',
      (a, b) => ((camIdx.get(a.slice(4)) ?? 1e9) - (camIdx.get(b.slice(4)) ?? 1e9)),
    );
    sortSlots(
      (ref) => items.get(ref)?.kind === 'el',
      (a, b) => ((zOf(b) - zOf(a)) || (startOf(a) - startOf(b))),
    );
    return order;
  }

  // ------------------------------------------------------------ camera stack
  _activeCameraId() {
    return this.project?.activeCameraId || this.project?.camera?.id || null;
  }

  /** Camera the selection points at: the pool primary, else the active camera. */
  _selectedCameraId() {
    const host = splitRef(this.pool?.primary);
    if (host?.type === 'cam' && this._camById(host.id)) return host.id;
    return this._activeCameraId();
  }

  _activateCamera(id) {
    if (!id) return;
    this.cameraSel = true;
    this.pool = selectOne('element', cameraRef(id));
    this.onSelect?.({ camera: true, pool: this.pool });
    this._paintSelection();
    if (this._activeCameraId() === id) return;
    // The reply applies the project (and renders) on its own; activation must
    // never close or reorder the open camera property pages.
    this.onOp?.({ op: 'activateCamera', id });
  }

  _toggleCam(id) {
    if (!id) return;
    if (this.openCams.has(id)) {
      this.openCams.delete(id);
      this.render(true);
      return;
    }
    this.openCams.add(id);
    this.cameraSel = true;
    this.pool = selectOne('element', cameraRef(id));
    this.onSelect?.({ camera: true, pool: this.pool });
    // Expand now. Activation is a server transaction + preview render + project
    // reply, so waiting for it made the row appear long after the click.
    this.render(true);
    // Activate in the background; its project reply re-renders. Opening a camera
    // does not have to keep it active if another one is already live.
    if (this._activeCameraId() !== id) this.onOp?.({ op: 'activateCamera', id });
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

  /** Every header row in DOM order, with its pool ref. */
  _headerRows() {
    if (!this.rowsWrap) return [];
    const out = [];
    for (const row of this.rowsWrap.querySelectorAll('.tl-camhead[data-cam], .tl-elhead[data-el], .tl-objhead[data-obj]')) {
      const cam = row.dataset.cam;
      const elId = row.dataset.el;
      const obj = row.dataset.obj;
      if (cam) out.push({ row, ref: cameraRef(cam), kind: 'cam', id: cam });
      else if (elId) out.push({ row, ref: elementRef(elId), kind: 'el', id: elId });
      else if (obj) out.push({ row, ref: objectRef(obj), kind: 'ob', id: obj });
    }
    return out;
  }

  /**
   * Drag a header row up/down. The drag reorders the display list, then derives
   * the real orders from it: 2D element rows write el.z, camera rows write
   * cameraOrder, everything else is display-only. One drop = one batch op
   * (meta.ui.timelineOrder + real orders) = one undo step.
   */
  _startRowDrag(ev, header) {
    const p = this.project;
    if (!p || this._rowCommitting) return;
    const hit = this._headerRows().find((x) => x.row === header);
    if (!hit) return;
    const { ref, kind, id } = hit;
    const additive = !!(ev.ctrlKey || ev.metaKey || ev.shiftKey);
    const downDetail = Number(ev.detail) || 0;
    const wasInPool = this.pool?.kind === 'element' && this.pool.ids.includes(ref);
    const wasSelected = kind === 'cam'
      ? (this.cameraSel && this._activeCameraId() === id)
      : kind === 'el' ? this.elementId === id : this.objectId === id;
    // A plain second click on the same row toggles its property pages, unless
    // a text element/object wants the double-click for inline text editing.
    const toggleAfterClick = (kind === 'el' || kind === 'ob') && wasInPool && wasSelected && !additive;

    if (kind === 'cam') {
      if (additive) {
        // Ctrl/Cmd-click appends or toggles the camera in the shared element
        // pool. Activation stays on the plain-click path, so building a mixed
        // cam / ob / el selection never changes the live picture.
        this._pickPool('element', ref, ev);
        this.propSel = null;
        this._selectPoolHost();
        this._paintSelection();
        return;
      }
    } else if (kind === 'el') {
      if (!wasInPool || additive) this._pickPool('element', ref, ev);
      else if (this.pool?.kind === 'element' && this.pool.ids.includes(ref)) {
        // Preserve the multi-selection but make the grabbed row its primary.
        this.pool = normalizeSelection({ ...this.pool, primary: ref });
      }
      this.propSel = null;
      this._selectPoolHost();
      this._paintSelection();
    } else if (kind === 'ob') {
      if (!wasInPool || additive) this._pickPool('element', ref, ev);
      else if (this.pool?.kind === 'element' && this.pool.ids.includes(ref)) {
        this.pool = normalizeSelection({ ...this.pool, primary: ref });
      }
      this.propSel = null;
      this._selectPoolHost();
      this._paintSelection();
    }
    // Cameras are activated on pointerup (activation is an op and a render
    // mid-drag would detach the row being measured).

    let group = [ref];
    if (kind !== 'cam' && (wasInPool || additive)) {
      const ids = new Set(this.pool.ids);
      const fromPool = this.viewOrder.filter((r) => ids.has(r));
      if (fromPool.length) group = fromPool;
    }
    const groupSet = new Set(group);
    if (!groupSet.has(ref)) groupSet.add(ref);

    const headers = this._headerRows();
    const domOrder = headers.map((x) => x.ref);
    let baseOrder = this.viewOrder.slice();
    if (baseOrder.length !== domOrder.length || baseOrder.some((r, i) => r !== domOrder[i])) baseOrder = domOrder;
    const moving = baseOrder.filter((r) => groupSet.has(r));
    const rest = baseOrder.filter((r) => !groupSet.has(r));
    const restHeaders = headers.filter((x) => !groupSet.has(x.ref));
    const groupRows = headers.filter((x) => groupSet.has(x.ref));
    const canDrag = !this.filterText.trim();
    const downY = ev.clientY;
    let lastY = downY;
    let moved = false;
    let target = 0;

    // If a previous drag lost its pointerup (window blur etc.), do not leave
    // its timer/line behind.
    if (this._rowDragTimer) { clearInterval(this._rowDragTimer); this._rowDragTimer = null; }
    if (this._dropLine) { this._dropLine.remove(); this._dropLine = null; }
    this._rowDragging = true;
    const line = el('div', 'tl-dropline');
    line.hidden = true;
    this.rowsWrap.appendChild(line);
    this._dropLine = line;

    const updateTarget = (y) => {
      lastY = y;
      let at = restHeaders.length;
      for (let i = 0; i < restHeaders.length; i++) {
        const r = restHeaders[i].row.getBoundingClientRect();
        if (y < r.top + r.height / 2) { at = i; break; }
      }
      target = at;
      let top = 0;
      if (at < restHeaders.length) top = restHeaders[at].row.offsetTop;
      else {
        const kids = this.rowsWrap.children;
        for (let i = kids.length - 1; i >= 0; i--) {
          if (kids[i] === line) continue;
          top = kids[i].offsetTop + kids[i].offsetHeight;
          break;
        }
      }
      line.style.top = `${top}px`;
      line.hidden = false;
    };

    const tick = () => {
      if (!moved) return;
      const sr = this.scroll.getBoundingClientRect();
      const edge = 26;
      let dy = 0;
      if (lastY < sr.top + edge) dy = -Math.min(18, (sr.top + edge - lastY) / 1.2);
      else if (lastY > sr.bottom - edge) dy = Math.min(18, (lastY - (sr.bottom - edge)) / 1.2);
      if (dy) {
        this.scroll.scrollTop += dy;
        updateTarget(lastY);
      }
    };

    const onMove = (e) => {
      lastY = e.clientY;
      if (!canDrag) return;
      if (!moved) {
        if (Math.abs(e.clientY - downY) < 4) return;
        moved = true;
        this.root.classList.add('tl-row-dragging');
        for (const x of groupRows) x.row.classList.add('tl-row-drag');
        if (!this._rowDragTimer) this._rowDragTimer = setInterval(tick, 16);
      }
      updateTarget(e.clientY);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (this._rowDragTimer) { clearInterval(this._rowDragTimer); this._rowDragTimer = null; }
      line.remove();
      this._dropLine = null;
      this._rowDrag = null;
      this._rowDragging = false;
      this.root.classList.remove('tl-row-dragging');
      for (const x of groupRows) x.row.classList.remove('tl-row-drag');
    };

    const onUp = (e) => {
      const didMove = moved;
      cleanup();
      if (!didMove) {
        if (kind === 'cam') this._activateCamera(id);
        else if (toggleAfterClick) {
          if (kind === 'el') {
            const isText = this._element(id)?.type === 'text';
            if (!(downDetail > 1 && isText)) this._toggleElementExpand(id);
          } else {
            const onName = !!ev.target?.closest?.('.tl-objname');
            const isText = this._obj(id)?.type === 'text';
            if (!(downDetail > 1 && (isText || onName))) this._toggleExpand(id);
          }
        }
        if (this._renderPending) { this._renderPending = false; this.render(true); }
        return;
      }
      const next = rest.slice();
      next.splice(Math.max(0, Math.min(next.length, target)), 0, ...moving);
      if (next.length !== baseOrder.length || next.some((r, i) => r !== baseOrder[i])) {
        // Only a real camera-vs-camera reorder activates the dragged camera.
        // A cross-type camera drag is display-only and must not change the
        // active (live) camera, otherwise the picture would change.
        const oldCam = baseOrder.filter((r) => r.startsWith('cam:'));
        const newCam = next.filter((r) => r.startsWith('cam:'));
        this._commitRowOrder(next, baseOrder, {
          cameraId: kind === 'cam' && !sameOrder(oldCam, newCam) ? id : null,
          group: [...groupSet],
        });
      } else if (this._renderPending) {
        this._renderPending = false;
        this.render(true);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /** Commit one drop: display order + real z/camera order + optional activation. */
  async _commitRowOrder(newOrder, oldOrder, { cameraId, group, project } = {}) {
    const p = project || this.project;
    if (!p) return;
    const ops = [];
    if (!sameOrder(newOrder, oldOrder)) ops.push({ op: 'setMeta', path: 'ui.timelineOrder', value: newOrder });
    ops.push(...this._elementOrderOps(oldOrder, newOrder, p, group || []));
    ops.push(...this._cameraOrderOps(oldOrder, newOrder, p));
    if (cameraId && this._activeCameraId() !== cameraId) ops.push({ op: 'activateCamera', id: cameraId });
    if (!ops.length) {
      if (cameraId) this._activateCamera(cameraId);
      return;
    }
    this._rowCommitting = true;
    const pending = this.onOp?.({ op: 'batch', ops });
    if (!pending?.then) {
      this._rowCommitting = false;
      this.viewOrder = newOrder;
      this.render(true);
      if (cameraId) this._activateCamera(cameraId);
      return;
    }
    let res = null;
    try { res = await pending; } catch { res = null; } finally { this._rowCommitting = false; }
    if (!res) {
      this.viewOrder = oldOrder;
      this.render(true);
      if (cameraId) this._activateCamera(cameraId);
      return;
    }
    const alreadyRendered = sameOrder(this.viewOrder, newOrder);
    this.viewOrder = newOrder;
    if (cameraId) this._activateCamera(cameraId);
    if (!alreadyRendered || this._renderPending) {
      this._renderPending = false;
      this.render(true);
    }
  }

  /**
   * 2D element ops for a drop. Only the relative order of 2D rows matters; the
   * midpoint / whole-stack renumber rules live in core/timeline-order.js and are
   * shared with the insertion path in main.js.
   */
  _elementOrderOps(oldOrder, newOrder, p, group) {
    const byRef = new Map((p.elements || []).map((e) => [elementRef(e.id), e]));
    const is2D = (ref) => {
      const e = byRef.get(ref);
      return !!e && e.type !== 'audio';
    };
    const old2D = oldOrder.filter(is2D);
    const new2D = newOrder.filter(is2D);
    if (sameOrder(old2D, new2D)) return [];
    const moved = (group || []).filter(is2D);
    if (moved.length === 1 && new2D.length > 1) {
      return planMoveZ({ stack: new2D, byRef, ref: moved[0] });
    }
    // A group move (or a single row in a one-row stack): renumber the 2D stack
    // bottom-to-top. This changes several z values but never the picture.
    return renumber2D(new2D, byRef);
  }

  /** Camera stack ops: only the relative order of camera rows matters. */
  _cameraOrderOps(oldOrder, newOrder, p) {
    const oldCam = oldOrder.filter((r) => r.startsWith('cam:'));
    const newCam = newOrder.filter((r) => r.startsWith('cam:'));
    if (sameOrder(oldCam, newCam)) return [];
    const ids = newCam.map((r) => r.slice(4));
    const work = (Array.isArray(p.cameras) ? p.cameras : []).map((c) => c.id);
    if (!work.length && Array.isArray(p.cameraOrder)) work.push(...p.cameraOrder);
    const ops = [];
    for (let i = 0; i < ids.length; i++) {
      if (work[i] === ids[i]) continue;
      const from = work.indexOf(ids[i]);
      if (from < 0) continue;
      work.splice(from, 1);
      work.splice(i, 0, ids[i]);
      ops.push({ op: 'reorderCamera', id: ids[i], index: i });
    }
    return ops;
  }

  _cameraGroup(cam, p, host = this.rowsWrap) {
    const activeId = p.activeCameraId || p.camera?.id || null;
    const open = this.openCams.has(cam.id);
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

    row.dataset.filter = filterKey(cam.name || '相机', cam.id);
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    const eye = eyeButton(cam.visible !== false, '显示该相机', '隐藏该相机（变换仍作用于子集）');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onOp?.({ op: 'cameraPatch', id: cam.id, patch: { visible: cam.visible === false } });
    });
    const caret = caretButton(open, '展开相机属性', '折叠相机属性');
    caret.addEventListener('click', (e) => { e.stopPropagation(); this._toggleCam(cam.id); });
    const dot = el('span', 'tl-camdot');
    const name = el('span', 'tl-objname');
    name.textContent = cam.name || '相机';
    const kind = el('span', 'tl-objkind badge badge-camera', '相机');
    const camRank = this._rankCam?.get(cameraRef(cam.id));
    kind.dataset.tip = camRank == null
      ? '相机'
      : `相机叠层：从上往下第 ${camRank + 1} / ${this._rankCam.size} 层；拖到另一台相机上下会改叠层（并激活），拖过其它类型只改显示`;
    g.append(eye, this._parentButton('cam', cam), caret, dot, name, kind);
    const feeds = feedElements(p).filter((e) => normalizeFeed(e.feed).camera === cam.id);
    if (feeds.length) {
      // A hint, not a switch: feeds never decide which camera reaches the
      // picture (DESIGN-TRANSFORM-UNIFY §1.1). Hidden cameras still feed.
      const badge = el('span', 'tl-feeds', `被投屏 ×${feeds.length}`);
      const names = feeds.map((e) => e.name || e.id);
      badge.dataset.tip = `这台相机被 ${feeds.length} 个投屏元素使用：${names.slice(0, 4).join('、')}`
        + `${names.length > 4 ? '…' : ''}\n隐藏或移出镜头时间段都不影响它给投屏供画面`;
      g.append(badge);
    }

    const track = el('div', 'tl-track');
    const block = el('div', 'blk cam');
    block.dataset.cam = cam.id;
    const range = cameraRange(p, cam);
    const keys = (cam.path || []).length;
    block.style.left = `${range.start * this.pps}px`;
    setClipWidth(block, Math.max(8, range.duration * this.pps));
    block.dataset.tip = `${cam.name || '镜头'} · ${keys} 关键点\n${range.start.toFixed(2)}–${range.end.toFixed(2)}s`;
    block.innerHTML = `<span class="blk-name">${escapeHtml(cam.name || '镜头')}</span><span class="blk-meta">${keys} 关键点</span>`;
    block.append(...clipHandles());
    block.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onCameraMenu?.(cam.id, e.clientX, e.clientY);
    });
    track.appendChild(block);
    row.append(g, track);
    host.appendChild(row);
    if (open) this._cameraRows(cam, host);
  }

  /**
   * Drag / trim a camera clip. Mirrors the 2D element block: a move carries
   * path + parameter keys (moveElement does that), an edge trim keeps them
   * pinned in absolute time so the shot content does not jump.
   */
  _startCameraClipDrag(cam, block, ev) {
    const p = this.project;
    if (!p) return;
    const range = cameraRange(p, cam);
    const orig = { start: range.start, duration: range.duration };
    const active = this._activeCameraId() === cam.id;
    const wasSelected = this.cameraSel && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && active;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      // Ctrl/Cmd-click on a camera clip: add / toggle it in the shared element
      // pool. It must not activate or start a trim drag, so building a mixed
      // selection never changes the live shot.
      this._pickPool('element', cameraRef(cam.id), ev);
      this.propSel = null;
      this._selectPoolHost();
      this._paintSelection();
      return;
    }
    // Select on pointerdown, but do not activate through an op here: an op
    // reply re-renders the timeline and detaches the block mid-drag. Activation
    // is batched with the move on pointerup instead (one save / one undo).
    if (!this.cameraSel || this.pool?.primary !== cameraRef(cam.id)) {
      this.cameraSel = true;
      this.pool = selectOne('element', cameraRef(cam.id));
      this.onSelect?.({ camera: true, pool: this.pool });
      this._paintSelection();
    }

    const mode = ev.target.classList.contains('handle-l') ? 'l'
      : ev.target.classList.contains('handle-r') ? 'r' : 'move';
    const t0 = this._timeAt(ev.clientX);
    const downX = ev.clientX, downY = ev.clientY;
    let moved = false;
    const move = (e) => {
      this._noSnap = e.altKey;
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 3) moved = true;
      const dt = this._timeAt(e.clientX) - t0;
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
      const q = this._clipPreview(mode, ns, nd);
      ns = q.start;
      nd = q.duration;
      block.style.left = `${ns * this.pps}px`;
      setClipWidth(block, Math.max(8, nd * this.pps));
      block._ns = ns;
      block._nd = nd;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!moved) {
        if (wasSelected && mode === 'move') this._toggleCam(cam.id);
        else if (!active) this._activateCamera(cam.id);
        return;
      }
      const ns = block._ns, nd = block._nd;
      const q = ns == null ? null : this._clipEdit(mode, ns, nd);
      const changed = q != null
        && (Math.abs(q.start - orig.start) >= 1e-4 || Math.abs(q.duration - orig.duration) >= 1e-4);
      if (!changed) {
        if (!active) this._activateCamera(cam.id);
        return;
      }
      const ops = [];
      if (!active) ops.push({ op: 'activateCamera', id: cam.id });
      // A move keeps the clip length exactly (keyframes travel with it); a trim
      // keeps the opposite edge and lands the dragged edge on the frame grid.
      ops.push(mode === 'move'
        ? { op: 'moveElement', id: cam.id, start: q.start }
        : { op: 'moveElement', id: cam.id, start: q.start, duration: q.duration });
      this.onOp?.(ops.length > 1 ? { op: 'batch', ops } : ops[0]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  _cameraRows(cam, host) {
    // One "位置" property (path keys) plus the rest of the base transform.
    // The camera transform group stays open by default: it is what users edit
    // most, while lens/shake/DOF stay folded with summaries.
    this._appendSection(host, '变换', 'camPos', 'm / 度 / 倍');
    const xformMode = this._groupMode('camPos');
    if (xformMode !== 'collapsed') {
      const tr = cameraTransform(cam, this.time);
      const show = (rowKey) => xformMode === 'full'
        || xfKeyState(cam, 'cam', rowKey, this.time, 0).has
        || (rowKey === 'position' && (cam.path || []).length > 0);
      if (show('pivot')) this._xformRow(host, cam, 'cam', 'pivot', { step: 0.1, unit: 'm' });
      if (show('position')) {
        // The flight path point is read-only here; the path gizmo edits it.
        this._xformRow(host, cam, 'cam', 'position', {
          step: 0.1, unit: 'm', readOnly: true, point: true,
        });
      }
      if (show('rotation')) {
        this._xformRow(host, cam, 'cam', 'rotation', {
          step: 0.5, unit: '°',
          tip: 'X 俯仰 · Y 转身 · Z 画面内旋转（旧手动 roll 已并入 Z）',
        });
      }
      if (show('scale')) this._xformRow(host, cam, 'cam', 'scale', { step: 0.05, unit: '倍' });
      if (xformMode === 'full' || this._camTracked(cam, 'opacity')) {
        this._camOpacityRow(cam, tr.opacity);
      }
    }

    const fov = this._camValue(cam, 'fov');
    const lookAhead = this._camValue(cam, 'lookAhead');
    const bankGain = this._camValue(cam, 'bankGain');
    const maxRoll = this._camValue(cam, 'maxRoll');
    const shakeAmp = this._camValue(cam, 'shake.amp');
    const shakeFreq = this._camValue(cam, 'shake.freq');
    const shakeGain = this._camValue(cam, 'shake.speedGain');
    const dofOn = this._camValue(cam, 'dof.enabled');
    const fstop = this._camValue(cam, 'dof.fstop');
    const lensSummary = `FOV ${Math.round(fov)}°${fov >= 180 ? ' · 鱼眼' : ''}`;
    const shakeSummary = `${round2(shakeAmp)}m · ${round2(shakeFreq)}Hz`;
    const dofSummary = `f/${round2(fstop)} · 模糊 ${Math.round((cam.motionBlur.shutter || 0) * 360)}°`;
    this._appendSection(host, '镜头 / 构图', 'camMain', lensSummary);
    const lensMode = this._groupMode('camMain');
    if (lensMode !== 'collapsed') {
      const tr = cameraTransform(cam, this.time);
      const show = (path) => lensMode === 'full' || this._camTracked(cam, path);
      // 画面中心 / 画面位置 used to sit in 变换; they are picture-space
      // composition values, so they live with the lens now (§9.1).
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
    }

    this._appendSection(host, '抖动', 'camShake', shakeSummary);
    const shakeMode = this._groupMode('camShake');
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

    this._appendSection(host, '景深 / 模糊', 'camDof', dofSummary);
    const dofMode = this._groupMode('camDof');
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

  _camPosRow(cam) {
    // Camera path position is animation, not a linkable scalar (PLAN §3.3):
    // the placeholder keeps this row aligned with the linkable rows above it.
    const row = el('div', 'tl-row tl-camprop tl-camposrow tl-linkrow');
    row.dataset.cam = cam.id;
    row.dataset.path = 'path';
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    g.appendChild(this._linkButton('cam', cam, cameraRowLinkPaths('position')));
    g.appendChild(el('span', 'tl-plabel', '位置'));
    const inputs = [];
    for (const ax of AX) {
      const { box, inp } = this._numBox(ax, ax.toUpperCase());
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this._editTimes.set(camPosEditKey(cam.id), this._frameTime());
        this._schedule(camPosEditKey(cam.id), () => this._commitCamPos(cam.id));
      });
      inp.addEventListener('blur', () => { this._flush(camPosEditKey(cam.id)); this._syncProps(); });
      inputs.push(inp);
      g.appendChild(box);
    }
    const kf = kfButton();
    kf.dataset.tip = '在当前时间打点 / 删点';
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleCamKey(cam.id); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    // One row state per camera: several cameras may be open, and each row must
    // read/write its own camera (this.project.camera is only the active one).
    const posRow = { camId: cam.id, inputs, kf, lane, row, sig: '', keys: [] };
    this._camPosRows.push(posRow);
    this._refreshCamLane(posRow, cam);
    return row;
  }

  _commitCamPos(camId) {
    const cam = this._camById(camId);
    const posRow = this._camPosRows.find((r) => r.camId === camId);
    if (!cam || !posRow) return;
    const v = posRow.inputs.map((i) => readNumber(i));
    if (v.some((n) => !Number.isFinite(n))) return;
    const t = this._editTimes.get(camPosEditKey(camId)) ?? this._frameTime();
    const old = (cam.path || []).find((k) => Math.abs(k.t - t) <= 1e-4);
    this.onOp?.({ op: 'cameraKey', id: camId, t, pos: v, look: old?.look ?? null, fov: old?.fov ?? null });
  }

  _toggleCamKey(camId) {
    const cam = this._camById(camId);
    if (!cam) return;
    this.onPause?.();
    const t = this._frameTime();
    const key = (cam.path || []).find((k) => Math.abs(k.t - t) < 1e-3);
    if (key) {
      this.onOp?.({ op: 'cameraRemove', id: camId, t: key.t });
      return;
    }
    const pos = pathPos(cam, this.time).map(round3);
    this.onOp?.({ op: 'cameraKey', id: camId, t, pos });
  }

  _refreshCamLane(posRow, cam) {
    if (!posRow || !cam) return;
    const keys = (cam.path || []).map((k) => round3(k.t)).sort((a, b) => a - b);
    const sig = keys.join(',');
    if (sig !== posRow.sig) {
      posRow.sig = sig;
      clearLaneKeys(posRow.lane);
      posRow.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.cam = cam.id;
        d.dataset.path = 'path';
        d.dataset.t = String(t);
        d.style.left = `${t * this.pps}px`;
        d.dataset.tip = `位置 · ${t.toFixed(2)}s`;
        posRow.lane.appendChild(d);
        return { t, node: d };
      });
    }
    for (const k of posRow.keys) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 1e-3);
  }

  _camVecRow(cam, path, label, dims, values, { step = 0.1, min, max, letter } = {}) {
    const row = el('div', 'tl-row tl-camprop tl-camxform tl-linkrow');
    row.dataset.cam = cam.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    g.appendChild(this._linkButton('cam', cam, cameraRowLinkPaths(path)));
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
        this._editTimes.set(editKey, this._frameTime());
        this._schedule(editKey, () => this._commitCamParam(cam.id, path));
      });
      inp.addEventListener('blur', () => { this._flush(editKey); this._syncProps(); });
      inputs.push(inp);
      g.appendChild(box);
    }
    const kf = kfButton();
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
    return this._camVecRow(cam, 'opacity', '不透明度', 1, [value], {
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
    const linked = cameraValueWithLinks(this.project, cam, path, t);
    return linked == null ? cameraParamValue(cam, path, t) : linked;
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
    let v = pr.dims === 1 ? values[0] : values;
    const t = this._editTimes.get(`cam:${camId}:${path}`) ?? this._frameTime();
    if (path.startsWith('rotation.')) {
      const i = AX.indexOf(path.slice(9));
      if (i < 0) return;
      const local = writeBackLocalValue(this.project, { host: 'cam', id: camId }, path, t, Number(v));
      const rot = cameraRotationAt(cam, t).slice();
      rot[i] = Number.isFinite(local) ? local : Number(v);
      if (this._camHasTrack(cam, path)) this.onOp?.({ op: 'cameraParamKey', id: camId, path, t, v: rot[i] });
      else this.onOp?.({ op: 'cameraSet', id: camId, patch: { rotation: rot } });
      return;
    }
    // Camera rows display effective values; store the local value so the same
    // picture remains after the edit. center -> pivot.*, scale -> scale.*.
    if (path === 'center' || path === 'scale') {
      const group = path === 'center' ? 'pivot' : 'scale';
      v = values.map((n, i) => {
        const back = writeBackLocalValue(this.project, { host: 'cam', id: camId }, `${group}.${AX[i]}`, t, n);
        return Number.isFinite(back) ? back : n;
      });
    } else if (pr.dims === 1) {
      const back = writeBackLocalValue(this.project, { host: 'cam', id: camId }, path, t, Number(v));
      if (Number.isFinite(back)) v = back;
    }
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
    const t = this._frameTime();
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
    const t = this._frameTime();
    const track = cam.tracks?.[path] || [];
    if (track.some((k) => Math.abs(k.t - t) < 1e-3)) {
      this.onOp?.({ op: 'cameraParamUnkey', id: camId, path, t });
      return;
    }
    const v = path.startsWith('rotation.')
      ? cameraRotationAt(cam, t)[AX.indexOf(path.slice(9))]
      : cameraParamValue(cam, path, t);
    this.onOp?.({ op: 'cameraParamKey', id: camId, path, t, v });
  }

  _refreshCamPropLane(pr, cam) {
    const keys = (cam.tracks?.[pr.path] || [])
      .map((k) => round3(k.t))
      .sort((a, b) => a - b);
    const sig = keys.join(',');
    if (sig !== pr.sig) {
      pr.sig = sig;
      clearLaneKeys(pr.lane);
      pr.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.cam = cam.id;
        d.dataset.path = pr.path;
        d.dataset.t = String(t);
        d.style.left = `${t * this.pps}px`;
        d.dataset.tip = `${pr.path} · ${t.toFixed(2)}s`;
        pr.lane.appendChild(d);
        return { t, node: d };
      });
    }
    for (const k of pr.keys || []) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 1e-3);
  }

  _camParamNumRow(cam, path, label, value, { step = 0.1, min, max, badge = '', keyable = true } = {}) {
    const row = el('div', `tl-row tl-camprop tl-camparamrow tl-linkrow${badge ? ' has-badge' : ''}`);
    row.dataset.cam = cam.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    g.appendChild(this._linkButton('cam', cam, cameraRowLinkPaths(path)));
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
      this._editTimes.set(editKey, this._frameTime());
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
      kf = kfButton();
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
    const row = el('div', `tl-row tl-camprop tl-camparamrow tl-linkrow${badge ? ' has-badge' : ''}`);
    row.dataset.cam = cam.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.cam = cam.id;
    g.appendChild(this._linkButton('cam', cam, []));
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
      kf = kfButton();
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

  _elementGroup(e, host = this.rowsWrap) {
    const open = this.expandedEls.has(e.id);
    const row = el('div', 'tl-row tl-elhead');
    row.dataset.el = e.id;
    row.classList.toggle('sel', e.id === this.elementId);
    row.dataset.filter = filterKey(e.name || e.id, e.id);
    const g = el('div', 'tl-gutter');
    g.dataset.el = e.id;
    const caret = caretButton(open, '展开属性', '折叠属性');
    caret.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._toggleElementExpand(e.id);
    });
    const eye = eyeButton(e.visible !== false, '显示', '隐藏');
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onOp?.({ op: 'updateElement', id: e.id, patch: { visible: e.visible === false } });
    });
    const dot = el('i', `type-dot t-${e.type}`);
    const name = el('span', 'tl-objname');
    name.textContent = e.name || e.id;
    name.dataset.tip = e.type === 'text' ? '双击时间块或画面编辑文字内容'
      : e.type === 'audio' ? '声音元素：展开可给音量打关键帧' : (e.name || e.id);
    const kind = el('span', `tl-objkind badge badge-${e.type}`, TYPE_LABEL[e.type] || e.type);
    kind.dataset.tip = e.type === 'audio'
      ? '声音不参与画面；上下拖动只改列表显示，不影响声音'
      : '2D 图层：列表越靠上越高；同一平面才看得出；拖过相机/3D/声音只改显示';
    const rank2D = this._rank2D?.get(elementRef(e.id));
    if (e.type !== 'audio' && rank2D != null) {
      kind.dataset.tip = `2D 图层：当前第 ${rank2D + 1} / ${this._rank2D.size} 个（越靠上越高；同面才看得出；拖过相机/3D/声音只改显示）`;
    }
    const parentBtn = e.type === 'audio' ? null : this._parentButton('el', e);
    g.append(eye, parentBtn || '', caret, dot, name, kind);
    if (e.type === 'camfeed') {
      // The clip has its own menu; the header should open the same one so
      // "跟随投屏来源" is reachable from the row as well.
      row.addEventListener('contextmenu', (ev) => {
        if (ev.target.closest?.('button, input, textarea, .handle')) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.onClipMenu?.(e.id, ev.clientX, ev.clientY);
      });
    }

    const track = el('div', 'tl-track');
    const b = el('div', `blk el t-${e.type}`);
    b.dataset.id = e.id;
    b.style.left = `${(Number(e.start) || 0) * this.pps}px`;
    setClipWidth(b, Math.max(4, (Number(e.duration) || 0) * this.pps));
    const label = elementClipLabel(e);
    b.innerHTML = `<span class="blk-name">${escapeHtml(label)}</span>`;
    setClipLoopMark(b, isLooping(e));
    b.append(...clipHandles());
    b.dataset.tip = elementClipTip(e, label);
    b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.onClipMenu?.(e.id, ev.clientX, ev.clientY);
    });
    track.appendChild(b);
    row.append(g, track);
    host.appendChild(row);
    this._elHeads.set(e.id, { row, g, eye, name, dot, block: b });
    if (e.type === 'text') {
      row.addEventListener('dblclick', (ev) => {
        if (ev.target.closest?.('button, input, textarea, .handle')) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.onTextEdit?.('element', e.id, ev);
      });
    }

    if (!open) return;
    if (e.type === 'audio') {
      this._appendSection(host, '声音', 'audio');
      const mode = this._groupMode('audio');
      if (mode === 'collapsed') return;
      if (mode === 'full' || this._elTrack(e, 'audio.volume').length > 0) {
        host.appendChild(this._elementNumRow(e, 'audio.volume', '音量', {
          step: 0.01, axis: 'd', letter: '', unit: '0..1', min: 0, max: 1,
          title: '音量 0..1；◆ 在当前时间打关键帧',
        }));
      }
      return;
    }
    this._appendSection(host, '变换', 'transform', e.node ? 'm / 度 / 倍' : 'px / m');
    const mode = this._groupMode('transform');
    if (mode === 'collapsed') return;
    const show = (path) => mode === 'full' || this._elTrack(e, this._elKeyPath(e, path)).length > 0;
    if (e.node) {
      // Unified transform rows (§9): 中心点 → 位置 → 旋转 → 缩放 → 不透明度.
      const showRow = (rowKey) => mode === 'full' || xfKeyState(e, 'el', rowKey, this.time, 0).has;
      if (showRow('pivot')) this._xformRow(host, e, 'el', 'pivot', { step: 0.05, unit: 'm' });
      if (showRow('position')) {
        this._xformRow(host, e, 'el', 'position', {
          step: 0.05, unit: 'm', point: true, noKey: true,
        });
      }
      if (showRow('rotation')) this._xformRow(host, e, 'el', 'rotation', { step: 0.5, unit: '°' });
      if (showRow('scale')) {
        this._xformRow(host, e, 'el', 'scale', {
          step: 0.01, unit: '',
          dimZ: true, dimTip: '平面没有厚度：Z 缩放只影响挂在下面的子元素',
        });
      }
      if (show('transform.opacity')) {
        host.appendChild(this._elementNumRow(e, 'transform.opacity', '不透明度', {
          step: 0.01, axis: 'd', letter: '', unit: '', min: 0, max: 1,
        }));
      }
      return;
    }
    if (show('transform.x')) host.appendChild(this._elementNumRow(e, 'transform.x', 'X', { step: 0.1, axis: 'x', letter: 'X', unit: 'px' }));
    if (show('transform.y')) host.appendChild(this._elementNumRow(e, 'transform.y', 'Y', { step: 0.1, axis: 'y', letter: 'Y', unit: 'px' }));
    if (show('transform.z')) {
      host.appendChild(this._elementNumRow(e, 'transform.z', '纵深 z', {
        step: 0.05, axis: 'd', letter: '', unit: 'm', title: '纵深 z (m)，正值朝相机；在播放头打帧',
      }));
    }
    if (show('transform.scale')) host.appendChild(this._elementNumRow(e, 'transform.scale', '缩放', { step: 0.01, axis: 'd', letter: '', unit: '×', min: 0 }));
    if (show('transform.rotation')) host.appendChild(this._elementNumRow(e, 'transform.rotation', '旋转°', { step: 0.5, axis: 'd', letter: '', unit: '°' }));
    if (show('transform.opacity')) {
      host.appendChild(this._elementNumRow(e, 'transform.opacity', '不透明度', {
        step: 0.01, axis: 'd', letter: '', unit: '', min: 0, max: 1,
      }));
    }
  }

  _elementNumRow(e, path, label, { step = 0.1, axis = 'd', letter = '', unit = '', min, max, title } = {}) {
    const row = el('div', 'tl-row tl-prop tl-elprop tl-linkrow');
    row.dataset.el = e.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.el = e.id;
    g.appendChild(this._linkButton('el', e, elementRowLinkPaths(e, path)));
    const lab = el('span', 'tl-plabel', label);
    lab.dataset.tip = title || `${label}${unit ? ` (${unit})` : ''}`;
    g.appendChild(lab);
    const { box, inp } = this._numBox(axis, letter);
    box.classList.add('tl-scalar');
    inp.step = String(step);
    if (Number.isFinite(min)) inp.min = String(min);
    if (Number.isFinite(max)) inp.max = String(max);
    inp.dataset.tip = `${lab.dataset.tip} · 无关键帧时改基础值（所有时间），已有键时改当前帧`;
    // Decide once, when editing starts: an unkeyed property keeps editing its
    // base value for the whole gesture. Otherwise a stray key created while a
    // field is focused would silently turn the next keystroke into a keyframe.
    const pr = {
      elId: e.id, path, keyPath: this._elKeyPath(e, path), input: inp, kf: null, lane: null, row, sig: '',
      keyedAtFocus: null,
    };
    inp.addEventListener('focus', () => {
      this.onPause?.();
      pr.keyedAtFocus = this._elTrack(e, pr.keyPath).length > 0;
    });
    inp.addEventListener('input', () => {
      this._editTimes.set(`${e.id}:${path}`, this._frameTime());
      this._schedule(`${e.id}:${path}`, () => this._commitElementNum(e.id, path));
    });
    inp.addEventListener('blur', () => { this._flush(`${e.id}:${path}`); pr.keyedAtFocus = null; this._syncProps(); });
    g.appendChild(box);
    const kf = kfButton();
    kf.dataset.tip = '在当前时间打帧 / 删帧';
    kf.addEventListener('click', (ev) => { ev.stopPropagation(); this._toggleElementKey(e.id, path); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    pr.kf = kf;
    pr.lane = lane;
    this._elPropRows.push(pr);
    return row;
  }

  _objectGroup(o, host = this.rowsWrap) {
    const open = this.expanded.has(o.id);
    const row = el('div', 'tl-row tl-objhead');
    row.dataset.obj = o.id;
    row.classList.toggle('sel', o.id === this.objectId);
    row.dataset.filter = filterKey(o.name || o.id, o.id);
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    const caret = caretButton(open, '展开属性', '折叠属性');
    caret.addEventListener('click', (e) => { e.stopPropagation(); this._toggleExpand(o.id); });
    const eye = eyeButton(o.visible !== false, '显示', '隐藏');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onOp?.({ op: 'objectPatch', id: o.id, patch: { visible: o.visible === false } });
    });
    const dot = el('span', 'tl-objdot');
    dot.style.background = o.style?.color || token('--accent');
    const name = el('span', 'tl-objname');
    name.textContent = o.name || o.id;
    name.dataset.tip = '双击重命名';
    name.addEventListener('dblclick', () => this._inlineName(name, o));
    g.append(eye, this._parentButton('ob', o), caret, dot, name);
    const kind = el('span', 'tl-objkind badge badge-object', o.type === 'empty' ? '空' : '3D');
    kind.dataset.tip = '3D 物体按深度遮挡；上下拖动只改列表显示，不影响画面';
    const kids = childrenOf(this.project, o.id).length;
    if (kids) {
      const badge = el('span', 'tl-objkids', `${kids} 子级`);
      badge.dataset.tip = '直接子元素数量';
      g.append(kind, badge);
    } else {
      g.append(kind);
    }
    const more = h('button', {
      type: 'button', class: 'tl-objmore', 'aria-label': '元素操作', 'data-tip': '元素操作',
    }, icon('more', 'ic-sm'));
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
    setClipWidth(block, Math.max(4, (Number(o.duration) || 0) * this.pps));
    block.innerHTML = `<span class="blk-name">${escapeHtml(o.name || o.id)}</span><span class="blk-meta">${(Number(o.duration) || 0).toFixed(2)}s</span>`;
    block.dataset.tip = `${o.name || o.id} · ${(Number(o.duration) || 0).toFixed(2)}s`;
    block.append(...clipHandles());
    track.appendChild(block);
    row.append(g, track);
    host.appendChild(row);
    this._objHeads.set(o.id, { row, g, eye, name, dot, block });
    if (o.type === 'text') {
      row.addEventListener('dblclick', (ev) => {
        if (ev.target.closest?.('.tl-objname, button, input, textarea, .handle')) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.onTextEdit?.('object', o.id, ev);
      });
    }

    if (!open) return;
    // Content rows (geometry / colour) are not keyable, so the keyed-only pass
    // hides the whole group, label included.
    if (!this._keyedOnly) {
      host.appendChild(this._sectionRow('内容', 'content'));
      if (this.sections.content === 'full') {
        host.appendChild(this._geomRow(o));
        host.appendChild(this._colorRow(o));
      }
    }
    this._appendSection(host, '变换', 'transform', 'm / 度 / 倍');
    const mode = this._groupMode('transform');
    if (mode !== 'collapsed') {
      const showRow = (rowKey) => mode === 'full' || xfKeyState(o, 'ob', rowKey, this.time, 0).has;
      if (showRow('pivot')) this._xformRow(host, o, 'ob', 'pivot', { step: 0.05, unit: 'm' });
      if (showRow('position')) this._xformRow(host, o, 'ob', 'position', { step: 0.05, unit: 'm', point: true });
      if (showRow('rotation')) this._xformRow(host, o, 'ob', 'rotation', { step: 0.5, unit: '°' });
      if (showRow('scale')) this._xformRow(host, o, 'ob', 'scale', { step: 0.01, unit: '倍' });
      if (mode === 'full' || this._hasTrack(o, 'opacity')) this._opacityRow(o);
    }
  }

  /** One 3D-object rotation axis; base `obj.rotation[i]` or a per-axis track. */
  _objectRotationRow(o, axis) {
    const path = `rotation.${axis}`;
    const pose = objectPoseWithLinks(this.project, o, this.time);
    const rot = Array.isArray(pose.rotation) ? pose.rotation : rotationFromDirRoll(pose.dir, pose.roll);
    const row = el('div', 'tl-row tl-prop tl-linkrow');
    row.dataset.obj = o.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(this._linkButton('ob', o, objectRowLinkPaths(path)));
    g.appendChild(el('span', 'tl-plabel', `旋转 ${axis.toUpperCase()}°`));
    const { box, inp } = this._numBox(axis, axis.toUpperCase());
    box.classList.add('tl-scalar');
    inp.step = '0.5';
    writeNumber(inp, rot[AX.indexOf(axis)], { force: true });
    inp.addEventListener('focus', () => this.onPause?.());
    inp.addEventListener('input', () => {
      this._editTimes.set(`${o.id}:${path}`, this._frameTime());
      this._schedule(`${o.id}:${path}`, () => this._commitObjectRotation(o.id, axis));
    });
    inp.addEventListener('blur', () => { this._flush(`${o.id}:${path}`); this._syncProps(); });
    g.appendChild(box);
    const kf = kfButton();
    kf.dataset.tip = '在当前时间打帧 / 删帧';
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleObjectRotationKey(o.id, axis); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path, kind: 'rotation', axis, inputs: [inp], kf, lane, row, sig: '' });
    return row;
  }

  _commitObjectRotation(objId, axis) {
    const obj = this._obj(objId);
    const pr = this._propRows.find((x) => x.objId === objId && x.path === `rotation.${axis}`);
    if (!obj || !pr) return;
    let v = readNumber(pr.input);
    if (!Number.isFinite(v)) return;
    const path = `rotation.${axis}`;
    const t = this._editTimes.get(`${objId}:${path}`) ?? this._frameTime();
    const local = writeBackLocalValue(this.project, { host: 'ob', id: objId }, path, t, v);
    if (Number.isFinite(local)) v = local;
    if ((obj.tracks?.[path] || []).length) {
      this.onOp?.({ op: 'objectKey', id: objId, path, t, v });
      return;
    }
    const pose = objectPose(obj, t);
    const rot = Array.isArray(obj.rotation)
      ? obj.rotation.slice()
      : rotationFromDirRoll(pose.dir, pose.roll);
    rot[AX.indexOf(axis)] = v;
    this.onOp?.({ op: 'objectPatch', id: objId, patch: { rotation: rot } });
  }

  _toggleObjectRotationKey(objId, axis) {
    const obj = this._obj(objId);
    if (!obj) return;
    this.onPause?.();
    const path = `rotation.${axis}`;
    const t = this._frameTime();
    const track = obj.tracks?.[path] || [];
    if (track.some((k) => Math.abs(k.t - t) < 1e-3)) {
      this.onOp?.({ op: 'objectUnkey', id: objId, path, t });
      return;
    }
    const pose = objectPose(obj, t);
    const rot = Array.isArray(pose.rotation) ? pose.rotation : rotationFromDirRoll(pose.dir, pose.roll);
    const ops = [];
    // A first key needs a base pose too, otherwise the other two axes fall back
    // to 0 and the object jumps before/after this key.
    if (!Array.isArray(obj.rotation)) ops.push({ op: 'objectPatch', id: objId, patch: { rotation: rot } });
    ops.push({ op: 'objectKey', id: objId, path, t, v: rot[AX.indexOf(axis)] });
    this.onOp?.(ops.length === 1 ? ops[0] : { op: 'batch', ops });
  }

  _groupOpen(key) {
    return this.sections[key] !== 'collapsed';
  }

  /** Group header state: ▾ all / ▾• keyed only / ▸ collapsed (chevron + keyframe dot). */
  _groupCaret(key) {
    const m = this.sections[key];
    const span = el('span', `tl-seccaret${m === 'keyed' ? ' keyed' : ''}`);
    span.append(icon(m === 'collapsed' ? 'chevron-right' : 'chevron-down', 'ic-sm'));
    if (m === 'keyed') {
      span.append(el('i', 'tl-keyed-dot'));
      span.dataset.tip = '只显示带关键帧的属性（再点一次收起）';
    }
    return span;
  }

  _camTracked(cam, path) {
    const tr = cam?.tracks || {};
    if (path === 'center' || path === 'scale') {
      return (tr[path] || []).length > 0
        || XF_AXES.some((ax) => (tr[`${path}.${ax}`] || []).length > 0);
    }
    if (path === 'rotation') {
      return XF_AXES.some((ax) => (tr[`rotation.${ax}`] || []).length > 0);
    }
    return (tr[path] || []).length > 0;
  }

  /**
   * U: keep only the hosts of the current pool that actually carry keys, with
   * every group label row hidden and every group in keyed mode. A second U
   * restores the expansion / group / scroll state from before the pass; the
   * pool and the filter are never touched. Returns false when nothing has keys,
   * so the toolbar keeps its shake and the shortcut stays unhandled.
   *
   * `core/timeline-keys.js` owns the "which host has keys / which groups must
   * stay open" rules, so the pass sees exactly the rows this timeline can draw.
   */
  applyKeyedFilter() {
    if (this._keyedOnly) return this.exitKeyedOnly();
    const keyed = poolHostKeys(this.project, this.pool).filter((s) => s.keyed);
    if (!keyed.length) return false;
    this._keyedSnapshot = {
      sections: { ...this.sections },
      expanded: [...this.expanded],
      expandedEls: [...this.expandedEls],
      openCams: [...this.openCams],
      scrollTop: this.scroll.scrollTop,
      scrollLeft: this.scroll.scrollLeft,
    };
    this._keyedOnly = true;
    // Only keyed hosts open. Cameras get their page opened but are never
    // activated: activation would change the live picture.
    this.expanded = new Set(keyed.filter((s) => s.type === 'ob').map((s) => s.id));
    this.expandedEls = new Set(keyed.filter((s) => s.type === 'el').map((s) => s.id));
    this.openCams = new Set(keyed.filter((s) => s.type === 'cam').map((s) => s.id));
    this._syncKeyedBtn();
    this.render(true);
    return true;
  }

  /** Second U: leave the keyed-only pass and restore the pre-pass state. */
  exitKeyedOnly() {
    if (!this._keyedOnly) return false;
    const snap = this._keyedSnapshot;
    this._keyedSnapshot = null;
    this._keyedOnly = false;
    if (snap) {
      this.sections = { ...snap.sections };
      this.expanded = new Set(snap.expanded);
      this.expandedEls = new Set(snap.expandedEls);
      this.openCams = new Set(snap.openCams);
    }
    this._scrollTo = null;
    this._syncKeyedBtn();
    this.render(true);
    if (snap) {
      this.scroll.scrollTop = snap.scrollTop;
      this.scroll.scrollLeft = snap.scrollLeft;
    }
    return true;
  }

  /**
   * Effective mode of a property group. The keyed-only pass forces 'keyed' for
   * every group without writing `sections`, so exiting restores what was there.
   */
  _groupMode(key) {
    return this._keyedOnly ? 'keyed' : this.sections[key];
  }

  /** Section label row; skipped entirely during the keyed-only pass. */
  _appendSection(host, title, key, hint = '') {
    if (this._keyedOnly) return null;
    const row = this._sectionRow(title, key, hint);
    host.appendChild(row);
    return row;
  }

  _sectionRow(title, key, hint = '') {
    const row = el('div', 'tl-row tl-sect');
    row.dataset.sec = key;
    const g = el('div', 'tl-gutter');
    g.append(this._groupCaret(key), el('span', '', title));
    if (hint) g.append(el('span', 'tl-sub', hint));
    row.append(g, el('div', 'tl-track'));
    // Clicks are resolved by _down: a tap on the gutter toggles the group, a
    // drag starting anywhere on the row becomes a marquee.
    return row;
  }

  /** Cycle a section between expanded, keyed-only and collapsed. */
  _toggleSection(key) {
    if (!key || !(key in this.sections)) return;
    const m = this.sections[key];
    this.sections[key] = m === 'full' ? 'collapsed' : m === 'collapsed' ? 'full' : 'collapsed';
    this.render(true);
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

  // ------------------------------------------------------------ property links
  /**
   * `↳` button for a property row (PLAN-ui-round3 §4.2). A row that cannot be
   * linked keeps a 20px placeholder so the name column does not jump between
   * rows. Lit = the host carries a link for one of `paths`.
   */
  _linkButton(kind, host, paths) {
    const usable = (paths || []).filter((path) => findLinkTarget(kind, host, path));
    if (!usable.length) return el('span', 'tl-linkflag');
    const btn = el('button', 'tl-linkbtn');
    btn.type = 'button';
    btn.textContent = '↳';
    btn.setAttribute('aria-label', '属性父级');
    const rec = { node: btn, kind, hostId: String(host?.id ?? ''), paths: usable };
    this._linkButtons.push(rec);
    const open = (anchor, x, y) => {
      this.onPause?.();
      openLinkMenu({
        project: this.project,
        hostKind: kind,
        id: rec.hostId,
        to: usable,
        labels: usable.map((path) => linkPropLabel(path)),
        anchor, x, y,
        t: this._frameTime(),
        onOp: (op) => this.onOp?.(op),
        onJump: (jump) => this.onLinkJump?.(jump),
        toast: this.onToast,
      });
    };
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      open(btn);
    });
    btn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      open(null, ev.clientX, ev.clientY);
    });
    this._paintLink(rec);
    return btn;
  }

  _paintLink(rec) {
    if (!rec?.node) return;
    const host = this._linkHost(rec.kind, rec.hostId);
    const links = host ? rec.paths.map((path) => linkOf(host, path)).filter(Boolean) : [];
    rec.node.classList.toggle('on', links.length > 0);
    setTip(rec.node, links.length
      ? `属性父级：${links.map((link) => linkSourceLabel(this.project, link)).join('；')}`
      : '属性父级：点击选择父级属性（右键也可）');
  }

  /** Repaint every link button from the live project (called by _syncProps). */
  _paintLinks() {
    for (const rec of this._linkButtons) this._paintLink(rec);
  }

  _linkHost(kind, id) {
    const p = this.project;
    if (!p) return null;
    const key = String(id ?? '');
    const list = kind === 'el' ? (p.elements || [])
      : kind === 'ob' ? (p.scene?.objects || [])
        : [...(p.cameras || []), ...(p.camera ? [p.camera] : [])];
    return list.find((host) => String(host?.id ?? '') === key) || null;
  }

  /**
   * 图元 row: which mesh a solid draws. Not keyable (it is a content row like
   * 几何 / 颜色); the preview and the Blender build both read `primitive`
   * (preview3d.js::UNIT_CYLINDER, blender/vdm_city.py::_solid_mesh).
   */
  _primitiveRow(o) {
    const row = el('div', 'tl-row tl-prop');
    row.dataset.obj = o.id;
    row.dataset.path = 'primitive';
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(el('span', 'tl-linkflag'));
    g.appendChild(el('span', 'tl-plabel', '图元'));
    const sel = document.createElement('select');
    sel.className = 'tl-primselect';
    for (const [value, label] of [['box', '立方体'], ['cylinder', '圆柱']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = o.primitive === 'cylinder' ? 'cylinder' : 'box';
    sel.dataset.tip = '图元：立方体 / 圆柱（视口与成片用同一个）';
    sel.addEventListener('focus', () => this.onPause?.());
    sel.addEventListener('change', () => {
      this.onOp?.({ op: 'objectPatch', id: o.id, patch: { primitive: sel.value } });
    });
    g.appendChild(sel);
    g.appendChild(el('span', 'tl-keyspace'));
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path: 'primitive', kind: 'select', input: sel, lane, row, sig: '' });
    return row;
  }

  _geomRow(o) {
    const row = el('div', 'tl-row tl-prop');
    row.dataset.obj = o.id;
    row.dataset.path = 'geom';
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(el('span', 'tl-linkflag'));
    g.appendChild(el('span', 'tl-plabel', '几何'));
    const inputs = [];
    for (const [ax, letter] of [['w', 'W'], ['h', 'H'], ['d', 'D']]) {
      const { box, inp } = this._numBox('d', letter);
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this._editTimes.set(`${o.id}:geom`, this._frameTime());
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
    g.appendChild(el('span', 'tl-linkflag'));
    g.appendChild(el('span', 'tl-plabel', '颜色'));
    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'tl-color';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'tl-hex';
    hex.spellcheck = false;
    color.addEventListener('input', () => {
      this._editTimes.set(`${o.id}:color`, this._frameTime());
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
    const row = el('div', 'tl-row tl-prop tl-linkrow');
    row.dataset.obj = o.id;
    row.dataset.path = path;
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(this._linkButton('ob', o, objectRowLinkPaths(path)));
    const lab = el('span', 'tl-plabel');
    if (o.parent?.id) {
      const local = el('span', 'tl-plocal', '本');
      local.dataset.tip = '本地值（相对父级）';
      lab.append(local);
    }
    lab.append(document.createTextNode(label));
    g.appendChild(lab);
    const inputs = [];
    for (const ax of AX) {
      const { box, inp } = this._numBox(ax, ax.toUpperCase());
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this._editTimes.set(`${o.id}:${path}`, this._frameTime());
        this._schedule(`${o.id}:${path}`, () => this._commitVec(o.id, path));
      });
      inp.addEventListener('blur', () => { this._flush(`${o.id}:${path}`); this._syncProps(); });
      inputs.push(inp);
      g.appendChild(box);
    }
    const kf = kfButton();
    kf.dataset.tip = '在当前时间打帧 / 删帧';
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleKey(o.id, path); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path, kind: 'vec', inputs, kf, lane, row, sig: '' });
    return row;
  }

  _opacityRow(o) {
    const row = el('div', 'tl-row tl-prop tl-linkrow');
    row.dataset.obj = o.id;
    row.dataset.path = 'opacity';
    const g = el('div', 'tl-gutter');
    g.dataset.obj = o.id;
    g.appendChild(this._linkButton('ob', o, objectRowLinkPaths('opacity')));
    g.appendChild(el('span', 'tl-plabel', '不透明度'));
    const { box, inp } = this._numBox('d', '');
    box.classList.add('tl-scalar');
    inp.min = '0';
    inp.max = '1';
    inp.dataset.scale = '100';
    inp.dataset.unit = '%';
    inp.addEventListener('focus', () => this.onPause?.());
    inp.addEventListener('input', () => {
      this._editTimes.set(`${o.id}:opacity`, this._frameTime());
      this._schedule(`${o.id}:opacity`, () => this._commitOpacity(o.id));
    });
    inp.addEventListener('blur', () => { this._flush(`${o.id}:opacity`); this._syncProps(); });
    g.appendChild(box);
    const kf = kfButton();
    kf.addEventListener('click', (e) => { e.stopPropagation(); this._toggleKey(o.id, 'opacity'); });
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    this._propRows.push({ objId: o.id, path: 'opacity', kind: 'opacity', inputs: [inp], kf, lane, row, sig: '' });
    return row;
  }

  // ------------------------------------------------------------ unified transform rows
  /** Owner object of a transform row (the panel may render while it is gone). */
  _xformHost(entry) {
    if (!entry) return null;
    if (entry.kind === 'cam') return this._camById(entry.id);
    if (entry.kind === 'ob') return this._obj(entry.id);
    return this._element(entry.id);
  }

  _xformClass(kind) {
    return kind === 'cam' ? 'tl-camprop' : kind === 'el' ? 'tl-elprop' : '';
  }

  _xformData(node, kind, id) {
    node.dataset.kind = kind;
    node.dataset.id = String(id);
    if (kind === 'cam') node.dataset.cam = String(id);
    else if (kind === 'ob') node.dataset.obj = String(id);
    else node.dataset.el = String(id);
  }

  /**
   * One row of the unified transform section: [↳] 标签 [X][Y][Z] [◆] plus three
   * X/Y/Z sub-rows (docs/DESIGN-TRANSFORM-UNIFY.md §9). The parent ◆ keys all
   * three axes; expanded sub-rows key one axis each. Position is the motion
   * path: its sub-rows only show/edit values and the parent ◆ keys the point.
   */
  _xformRow(container, owner, kind, rowKey, opts = {}) {
    const id = owner.id;
    const {
      step = 0.1, min, max, unit = '', percent = false, readOnly = false,
      dimZ = false, dimTip = '', point = rowKey === 'position', noKey = false, tip = '',
    } = opts;
    const label = (XF_ROWS.find((r) => r.key === rowKey) || {}).label || rowKey;
    const row = el('div', `tl-row tl-prop tl-xrow ${this._xformClass(kind)}`.trim());
    this._xformData(row, kind, id);
    row.dataset.path = rowKey;
    const g = el('div', 'tl-gutter');
    this._xformData(g, kind, id);

    g.appendChild(this._linkButton(kind, owner, xfLinkPaths(kind, owner, rowKey)));

    const lab = el('span', 'tl-plabel');
    const caret = h('button', {
      type: 'button', class: 'tl-xcaret', 'aria-label': `展开${label}逐轴`,
      'data-tip': `展开 ${label} 的 X/Y/Z 子行（逐轴打帧）`,
    }, '▸');
    lab.append(caret, document.createTextNode(label));
    if (tip) lab.dataset.tip = tip;
    g.appendChild(lab);

    const cells = [];
    for (const ax of XF_AXES) {
      const { box, inp } = this._numBox(ax, ax.toUpperCase());
      inp.step = String(step);
      if (min != null) inp.min = String(min);
      if (max != null) inp.max = String(max);
      if (percent) { inp.dataset.scale = '100'; inp.dataset.unit = '%'; }
      box.classList.add(`tl-xcell-${ax}`);
      box.dataset.tip = readOnly
        ? `${label} ${ax.toUpperCase()}（只读：由飞行路径算出，用视口里的路径点改）`
        : `${label} ${ax.toUpperCase()}${unit ? ` (${unit})` : ''}`;
      if (readOnly) {
        inp.readOnly = true;
        inp.tabIndex = -1;
        box.classList.add('tl-ro');
      }
      if (dimZ && ax === 'z') {
        box.classList.add('dim');
        box.dataset.tip = dimTip || `${label} Z：平面没有厚度，只影响挂在下面的子元素`;
      }
      cells.push({ ax, box, inp });
      g.appendChild(box);
    }

    const kf = kfButton();
    g.appendChild(kf);
    const lane = el('div', 'tl-track');
    row.append(g, lane);
    container.appendChild(row);

    const subRows = [];
    for (const ax of XF_AXES) {
      const sub = el('div', `tl-row tl-xsub ${this._xformClass(kind)}`.trim());
      this._xformData(sub, kind, id);
      sub.dataset.path = xfAxisPath(kind, rowKey, ax);
      sub.dataset.sub = '1';
      const sg = el('div', 'tl-gutter');
      this._xformData(sg, kind, id);
      const linkPath = xfAxisLinkPath(kind, owner, rowKey, ax);
      sg.appendChild(this._linkButton(kind, owner, linkPath ? [linkPath] : []));
      const slab = el('span', 'tl-plabel tl-xsub-label');
      slab.textContent = ax.toUpperCase();
      sg.appendChild(slab);
      const { box, inp } = this._numBox(ax, ax.toUpperCase());
      inp.step = String(step);
      if (min != null) inp.min = String(min);
      if (max != null) inp.max = String(max);
      if (percent) { inp.dataset.scale = '100'; inp.dataset.unit = '%'; }
      box.classList.add('tl-xsub-cell');
      box.dataset.tip = readOnly
        ? `${label} ${ax.toUpperCase()} 子行（只读：由飞行路径算出）`
        : `${label} ${ax.toUpperCase()} 子行${unit ? ` (${unit})` : ''}`;
      if (readOnly) {
        inp.readOnly = true;
        inp.tabIndex = -1;
        box.classList.add('tl-ro');
      }
      if (dimZ && ax === 'z') {
        box.classList.add('dim');
        box.dataset.tip = dimTip || `${label} Z：平面没有厚度，只影响挂在下面的子元素`;
      }
      sg.appendChild(box);
      const skf = kfButton();
      sg.appendChild(skf);
      const slane = el('div', 'tl-track');
      sub.append(sg, slane);
      sub.hidden = true;
      container.appendChild(sub);
      subRows.push({ ax, row: sub, gutter: sg, box, input: inp, kf: skf, lane: slane });
    }

    const openKey = `${kind}:${id}:${rowKey}`;
    const entry = {
      kind, id, rowKey, label, row, gutter: g, caret, cells, kf, lane, subRows,
      expanded: this._xformOpen.has(openKey),
      openKey, point, readOnly, noKey, dimZ, sig: new Map(),
    };
    this._xformRows.push(entry);

    // Restore the open state after a re-render: the row → sub-rows toggle is
    // DOM-only, but `_xformOpen` survives project/ops renders.
    entry.row.classList.toggle('open', entry.expanded);
    entry.caret.textContent = entry.expanded ? '▾' : '▸';
    entry.caret.setAttribute('aria-expanded', String(entry.expanded));
    entry.caret.dataset.tip = entry.expanded
      ? `收起 ${label} 的逐轴子行`
      : `展开 ${label} 的 X/Y/Z 子行（逐轴打帧）`;
    for (const sub of subRows) sub.row.hidden = !entry.expanded;

    const commit = (axis, input) => {
      const host = this._xformHost(entry);
      if (!host || readOnly) return;
      const v = readNumber(input);
      if (!Number.isFinite(v)) return;
      const t = this._editTimes.get(`${kind}:${id}:${rowKey}.${axis}`) ?? this._frameTime();
      const ops = xfSetAxisOps(this.project, host, kind, rowKey, axis, v, t, this._tol());
      const op = bundleOps(ops);
      if (op) this.onOp?.(op);
    };
    const bindInput = (axis, input) => {
      if (readOnly) return;
      const editKey = `${kind}:${id}:${rowKey}.${axis}`;
      input.addEventListener('focus', () => this.onPause?.());
      input.addEventListener('input', () => {
        this._editTimes.set(editKey, this._frameTime());
        this._schedule(editKey, () => commit(axis, input));
      });
      input.addEventListener('blur', () => { this._flush(editKey); this._syncProps(); });
    };
    for (const cell of cells) bindInput(cell.ax, cell.inp);
    for (const sub of subRows) bindInput(sub.ax, sub.input);

    caret.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._toggleXformExpand(entry);
    });
    kf.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._toggleXformKey(entry, ev.shiftKey);
    });
    for (const sub of subRows) {
      sub.kf.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleXformAxisKey(entry, sub, ev.shiftKey);
      });
    }

    this._paintXformEntry(entry);
    return entry;
  }

  _tol() {
    return 0.5 / (Number(this._last?.project?.meta?.fps) || Number(this.project?.meta?.fps) || 24);
  }

  _toggleXformExpand(entry) {
    entry.expanded = !entry.expanded;
    if (entry.expanded) this._xformOpen.add(entry.openKey);
    else this._xformOpen.delete(entry.openKey);
    entry.row.classList.toggle('open', entry.expanded);
    entry.caret.textContent = entry.expanded ? '▾' : '▸';
    entry.caret.setAttribute('aria-expanded', String(entry.expanded));
    entry.caret.dataset.tip = entry.expanded
      ? `收起 ${entry.label} 的逐轴子行`
      : `展开 ${entry.label} 的 X/Y/Z 子行（逐轴打帧）`;
    for (const sub of entry.subRows) sub.row.hidden = !entry.expanded;
    this._paintXformEntry(entry);
    // The lane's diamonds are rebuilt (merged <-> per-axis), so the pool's
    // highlight has to be repainted on the new nodes.
    this._paintPool();
    // Opening a row near the bottom used to put its sub-rows below the fold:
    // the row you just opened looked like it had disappeared.
    if (entry.expanded) this._revealRows(entry.row, entry.subRows[entry.subRows.length - 1]?.row);
    // The rows below moved: refresh whatever the new span makes visible.
    this._scheduleValueSync();
  }

  /**
   * Scroll just enough that `last` is inside the scroller while `first` stays
   * below the sticky ruler. Used when a row grows (a transform row expanding
   * into its X/Y/Z sub-rows): the new rows must land in view, and the header
   * that was clicked must not be pushed out of it.
   */
  _revealRows(first, last) {
    const sc = this.scroll;
    if (!sc || !first || !last || last.hidden) return;
    const sr = sc.getBoundingClientRect();
    const rulerH = this.rulerRow?.offsetHeight || 26;
    const top = sr.top + rulerH + 4;
    const bottom = sr.bottom - 4;
    if (!(sr.height > rulerH + 8)) return; // scroller too short to judge
    const fr = first.getBoundingClientRect();
    const lr = last.getBoundingClientRect();
    let delta = 0;
    if (lr.bottom > bottom) delta = lr.bottom - bottom;
    // Keep the header visible: never scroll it above the ruler.
    if (delta > 0 && fr.top - delta < top) delta = Math.max(0, fr.top - top);
    if (delta > 0.5) sc.scrollTop += delta;
  }

  _toggleXformKey(entry, shift) {
    const host = this._xformHost(entry);
    if (!host || entry.noKey) return;
    this.onPause?.();
    const t = this._frameTime();
    const tol = this._tol();
    const st = xfKeyState(host, entry.kind, entry.rowKey, t, tol);
    const ops = (shift || st.at)
      ? xfUnkeyOps(this.project, host, entry.kind, entry.rowKey, t, tol)
      : xfKeyOps(this.project, host, entry.kind, entry.rowKey, t);
    const op = bundleOps(ops);
    if (op) this.onOp?.(op);
  }

  _toggleXformAxisKey(entry, sub, shift) {
    const host = this._xformHost(entry);
    if (!host || entry.point || entry.noKey || sub.kf.disabled) return;
    this.onPause?.();
    const t = this._frameTime();
    const tol = this._tol();
    const st = xfAxisKeyState(host, entry.kind, entry.rowKey, sub.ax, t, tol);
    const ops = (shift || st.at)
      ? xfAxisUnkeyOps(this.project, host, entry.kind, entry.rowKey, sub.ax, t, tol)
      : xfAxisKeyOps(this.project, host, entry.kind, entry.rowKey, sub.ax, t);
    const op = bundleOps(ops);
    if (op) this.onOp?.(op);
  }

  /** Paint one row + its sub-rows from the project the panel last rendered. */
  _paintXformEntry(entry) {
    const host = this._xformHost(entry);
    if (!host) return;
    const t = this.time;
    const tol = this._tol();
    const values = xfValues(this.project, host, entry.kind, t)[entry.rowKey] || [0, 0, 0];
    entry.cells.forEach((cell, i) => writeNumber(cell.inp, values[i]));
    entry.subRows.forEach((sub, i) => writeNumber(sub.input, values[i]));

    const st = xfKeyState(host, entry.kind, entry.rowKey, t, tol);
    paintKf(entry.kf, st, { point: entry.point, noKey: entry.noKey, label: entry.label });
    for (const sub of entry.subRows) {
      const mode = xfMode(host, entry.kind, entry.rowKey);
      const disabled = entry.point || entry.noKey || mode === 'base'
        || (mode === 'vector' && entry.rowKey !== 'position');
      sub.kf.disabled = disabled;
      sub.kf.classList.toggle('off', disabled);
      if (disabled) {
        setText(sub.kf, '◇');
        setTip(sub.kf, entry.noKey
          ? '2D 位置暂不逐轴打帧：屏幕运动写在中心点（运动路径 §5 待做）'
          : entry.point
            ? '位置整点打键：点父行 ◆；子行只改数值'
            : '整向量轨道：逐轴键要等字段迁移；先在父行 ◆ 打整组');
      } else {
        const ast = xfAxisKeyState(host, entry.kind, entry.rowKey, sub.ax, t, tol);
        paintKf(sub.kf, ast, { axis: sub.ax, label: entry.label });
        if (!sub.kf.dataset.tip) setTip(sub.kf, '给这个轴单独打帧 / 删帧（Shift+点击删除）');
      }
    }
    this._refreshXformLane(entry, host, st);
  }

  _refreshXformLane(entry, host, st) {
    // Expanded axis rows show their own keys; the merged summary would only
    // duplicate them. Collapsed rows keep the union on the parent lane (§9.1).
    const hideParent = st.mode === 'axis' && entry.expanded;
    const parentSig = hideParent ? 'hidden' : `${st.mode}|${st.times.join(',')}`;
    if (entry.sig.get('parent') !== parentSig) {
      entry.sig.set('parent', parentSig);
      clearLaneKeys(entry.lane);
      if (hideParent) {
        entry.lane.keys = [];
      } else {
        const summary = st.mode === 'axis';
        const path = st.mode === 'path' ? 'path'
          : st.mode === 'vector' ? xfVectorPath(entry.kind, entry.rowKey) : null;
        entry.lane.keys = st.times.map((t) => this._xformKeyNode(entry, entry.lane, t, path, summary, entry.label));
      }
    }
    for (const k of entry.lane.keys || []) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 1e-3);

    entry.subRows.forEach((sub, i) => {
      const ast = xfAxisKeyState(host, entry.kind, entry.rowKey, sub.ax, this.time, this._tol());
      const sig = ast.times.join(',');
      if (sub.sig === sig) {
        for (const k of sub.keys || []) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 1e-3);
        return;
      }
      sub.sig = sig;
      clearLaneKeys(sub.lane);
      sub.keys = ast.times.map((t) => this._xformKeyNode(entry, sub.lane, t,
        xfAxisPath(entry.kind, entry.rowKey, sub.ax), false, `${entry.label} ${sub.ax.toUpperCase()}`));
      for (const k of sub.keys) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 1e-3);
    });
  }

  _xformKeyNode(entry, lane, t, path, summary, label) {
    const d = el('div', 'tl-key');
    d.dataset.t = String(t);
    d.style.left = `${t * this.pps}px`;
    d.dataset.tip = `${label} · ${t.toFixed(2)}s`;
    if (summary) {
      d.classList.add('tl-key-sum');
    } else {
      if (entry.kind === 'cam') d.dataset.cam = entry.id;
      else if (entry.kind === 'ob') d.dataset.obj = entry.id;
      else d.dataset.el = entry.id;
      if (path) d.dataset.path = path;
    }
    lane.appendChild(d);
    return { t, node: d };
  }

  _syncXformRows(shown = () => true) {
    for (const entry of this._xformRows) {
      // The sub-rows sit right below the parent, so one test on the parent
      // covers the block — unless only one of them is inside the viewport.
      if (!shown(entry.row) && !entry.subRows.some((sub) => shown(sub.row))) continue;
      this._paintXformEntry(entry);
    }
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
    const viaNode = localElementRowValueAt(this.project, e, path, t);
    if (viaNode != null) return viaNode;
    const prop = path.slice(path.lastIndexOf('.') + 1);
    let base = path.startsWith('transform.') ? e?.transform?.[prop] : undefined;
    if (path === 'audio.volume') base = e?.volume;
    if (base == null) base = (prop === 'scale' || prop === 'opacity' || path === 'audio.volume') ? 1 : 0;
    return sampleTrack(e?.keyframes, path, t, Number(base));
  }

  /** Actual keyframe path behind a 2D row (node elements key pivot.* / roll / scale.*). */
  _elKeyPath(e, path) {
    return elementRowKeyPath(e, path);
  }

  /** Display value of a 2D row: local plus its property-link contribution. */
  _elEffective(e, path, t) {
    return effectiveElementRowValue(this.project, e, path, t, this._elValue(e, path, t));
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
      clearLaneKeys(pr.lane);
      pr.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.obj = o.id;
        d.dataset.path = pr.path;
        d.dataset.t = String(t);
        d.style.left = `${t * this.pps}px`;
        d.dataset.tip = `${pr.path} · ${t.toFixed(2)}s`;
        pr.lane.appendChild(d);
        return { t, node: d };
      });
    }
    for (const k of pr.keys || []) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 1e-3);
  }

  _refreshElLane(pr, e) {
    const keyPath = pr.keyPath || pr.path;
    const keys = this._elTrack(e, keyPath).map((k) => Math.round(Number(k.t) * 1000) / 1000);
    const sig = keys.join(',');
    if (sig !== pr.sig) {
      pr.sig = sig;
      clearLaneKeys(pr.lane);
      pr.keys = keys.map((t) => {
        const d = el('div', 'tl-key');
        d.dataset.el = e.id;
        d.dataset.path = keyPath;
        d.dataset.t = String(t);
        d.style.left = `${t * this.pps}px`;
        d.dataset.tip = `${keyPath} · ${t.toFixed(2)}s`;
        pr.lane.appendChild(d);
        return { t, node: d };
      });
    }
    for (const k of pr.keys || []) k.node.classList.toggle('at', Math.abs(k.t - this.time) < 1e-3);
  }

  /**
   * Full refresh: the per-frame values plus everything that only changes when
   * the project, the zoom or the selection does. Edits and the controls' blur
   * handlers call this; a playback tick calls _syncValues only.
   */
  _syncProps() {
    this._syncValues();
    this._syncStatics();
  }

  /** A live playback tick: rewrite the fields at most every VALUE_SYNC_MS. */
  _syncValuesSoon() {
    if (performance.now() - this._lastValues >= VALUE_SYNC_MS) this._syncValues();
  }

  /**
   * Refresh the fields once on the next frame: used when rows may have scrolled
   * or unfolded into view (their values were skipped while they were hidden).
   */
  _scheduleValueSync() {
    if (this._valueSyncRaf) return;
    this._valueSyncRaf = requestAnimationFrame(() => {
      this._valueSyncRaf = 0;
      this._syncValues();
    });
  }

  /** Visible span of the scroller in row coordinates, padded by ROW_SYNC_PAD. */
  _visibleSpan() {
    const s = this.scroll;
    // A hidden timeline has no box to measure (and no paint to save): sync all.
    if (!s || !s.clientHeight) return null;
    const top = s.scrollTop - ROW_SYNC_PAD;
    return [top, top + s.clientHeight + ROW_SYNC_PAD * 2];
  }

  /**
   * The rows inside the visible span, measured in one pass *before* any field
   * is written: an offsetTop read after a write would force a reflow per row.
   * Collapsed groups (their rows carry `hidden`) and rows scrolled away are
   * left out; they are brought up to date when they come back, because the
   * next sync measures again. Returns null when there is nothing to filter.
   */
  _visibleRows([top, bottom]) {
    const out = new Set();
    for (const row of this.rowsWrap.querySelectorAll('.tl-row')) {
      if (row.offsetParent === null) continue;
      const y = row.offsetTop;
      if (y + row.offsetHeight > top && y < bottom) out.add(row);
    }
    return out;
  }

  /**
   * Per-frame part: the numbers and the ◆ state, the only things the playhead
   * changes. Names, clips, tips and the eyes are in _syncStatics — rewriting
   * them every frame is what used to force a full timeline reflow per frame.
   */
  _syncValues() {
    this._lastValues = performance.now();
    const t = this.time;
    const span = this._visibleSpan();
    const vis = span ? this._visibleRows(span) : null;
    const shown = (row) => !vis || !row || vis.has(row);
    // Never write into the field the user is typing in: writeNumber skips the
    // focused input (that is what used to swallow the "." right after "0").
    const set = (inp, v) => writeNumber(inp, v);
    for (const pr of this._propRows) {
      if (!shown(pr.row)) continue;
      const o = this._obj(pr.objId);
      if (!o) continue;
      const pose = objectPoseWithLinks(this.project, o, t);
      if (pr.kind === 'geom') {
        const g = o.geom || {};
        ['w', 'h', 'd'].forEach((ax, i) => set(pr.inputs[i], Number(g[ax]) || 2));
      } else if (pr.kind === 'color') {
        const color = String(o.style?.color || o.style?.fill || '#17d9ff');
        if (pr.color && document.activeElement !== pr.color) setValue(pr.color, /^#[0-9a-f]{6}$/i.test(color) ? color : '#17d9ff');
        if (pr.hex && document.activeElement !== pr.hex) setValue(pr.hex, color);
      } else if (pr.kind === 'opacity') {
        set(pr.inputs[0], pose.opacity);
      } else if (pr.kind === 'rotation') {
        const rot = Array.isArray(pose.rotation) ? pose.rotation : rotationFromDirRoll(pose.dir, pose.roll);
        set(pr.inputs[0], rot[AX.indexOf(pr.axis)]);
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
        setTip(pr.kf, at ? '删除这一帧' : has ? `在当前时间打帧（已有 ${track.length} 帧）` : '在当前时间打帧');
      }
      if (pr.kind !== 'geom' && pr.kind !== 'color') this._refreshLane(pr, o);
    }
    for (const pr of this._elPropRows) {
      if (!shown(pr.row)) continue;
      const e = this._element(pr.elId);
      if (!e) continue;
      set(pr.input, this._elEffective(e, pr.path, t));
      const keys = this._elTrack(e, pr.keyPath || pr.path);
      const at = keys.some((k) => Math.abs(Number(k.t) - t) < 1e-3);
      const has = keys.length > 0;
      pr.kf.classList.toggle('on', at);
      pr.kf.classList.toggle('has', !at && has);
      setTip(pr.kf, at ? '删除这一帧' : has ? `在当前时间打帧（已有 ${keys.length} 帧）` : '在当前时间打帧');
      this._refreshElLane(pr, e);
    }
    for (const posRow of this._camPosRows) {
      if (!shown(posRow.row)) continue;
      const cam = this._camById(posRow.camId);
      if (!cam) continue;
      const pos = pathPos(cam, t);
      posRow.inputs.forEach((inp, i) => set(inp, pos[i]));
      const at = (cam.path || []).some((k) => Math.abs(k.t - t) < 1e-3);
      const has = (cam.path || []).length > 0;
      posRow.kf.classList.toggle('on', at);
      posRow.kf.classList.toggle('has', !at && has);
      setTip(posRow.kf, at ? '删除这一帧' : has ? `在当前时间打点（已有 ${(cam.path || []).length} 帧）` : '在当前时间打点');
      this._refreshCamLane(posRow, cam);
    }
    for (const pr of this._camPropRows) {
      if (!shown(pr.row)) continue;
      const cam = this._camById(pr.camId);
      if (!cam) continue;
      let values;
      if (pr.path === 'center' || pr.path === 'scale') {
        const group = pr.path === 'center' ? 'pivot' : 'scale';
        const tr = cameraTransform(cam, t);
        values = AX.map((ax, i) => {
          const linked = cameraValueWithLinks(this.project, cam, `${group}.${ax}`, t);
          return Number.isFinite(linked) ? linked : tr[pr.path][i];
        });
      } else if (pr.path.startsWith('rotation.')) {
        const i = AX.indexOf(pr.path.slice(9));
        const value = this._camValue(cam, pr.path, t);
        values = [Number.isFinite(value) ? value : cameraRotationAt(cam, t)[i]];
      } else {
        const value = this._camValue(cam, pr.path, t);
        values = pr.dims === 1 ? [value] : (value || []);
      }
      if (pr.kind === 'select') {
        if (pr.sel && document.activeElement !== pr.sel) setValue(pr.sel, String(values[0]));
      } else {
        pr.inputs.forEach((inp, i) => set(inp, values[i]));
      }
      if (pr.kf) {
        const track = cam.tracks?.[pr.path] || [];
        const at = track.some((k) => Math.abs(k.t - t) < 1e-3);
        const has = track.length > 0;
        pr.kf.classList.toggle('on', at);
        pr.kf.classList.toggle('has', !at && has);
        setTip(pr.kf, at ? '删除这一帧' : has ? `在当前时间打帧（已有 ${track.length} 帧）` : '在当前时间打帧');
      }
      this._refreshCamPropLane(pr, cam);
    }
    this._syncXformRows(shown);
  }

  /**
   * Static part: names, clip geometry and labels, tips, the eye / colour dots,
   * row selection and the link buttons. They change on an edit, a zoom, a
   * scroll or an expand — never because the playhead moved.
   */
  _syncStatics() {
    for (const [id, h] of this._objHeads) {
      const o = this._obj(id);
      if (!o) continue;
      if (document.activeElement !== h.name && !h.name.querySelector('input')) setText(h.name, o.name || o.id);
      setEye(h.eye, o.visible !== false, '显示', '隐藏');
      setStyle(h.dot, 'background', o.style?.color || token('--accent'));
      h.row.classList.toggle('sel', id === this.objectId);
      const start = Number(o.start) || 0;
      const dur = Number(o.duration) || 0;
      const left = `${start * this.pps}px`;
      if (h.block.style.left !== left) h.block.style.left = left;
      setClipWidth(h.block, Math.max(4, dur * this.pps));
      const nameEl = h.block.querySelector('.blk-name');
      if (nameEl) setText(nameEl, o.name || o.id);
      const metaEl = h.block.querySelector('.blk-meta');
      if (metaEl) setText(metaEl, `${dur.toFixed(2)}s`);
      setTip(h.block, `${o.name || o.id} · ${dur.toFixed(2)}s`);
    }
    for (const [id, h] of this._elHeads) {
      const e = this._element(id);
      if (!e) continue;
      if (document.activeElement !== h.name) setText(h.name, e.name || e.id);
      setEye(h.eye, e.visible !== false, '显示', '隐藏');
      h.row.classList.toggle('sel', id === this.elementId);
      const left = `${(Number(e.start) || 0) * this.pps}px`;
      if (h.block.style.left !== left) h.block.style.left = left;
      setClipWidth(h.block, Math.max(4, (Number(e.duration) || 0) * this.pps));
      const nameEl = h.block.querySelector('.blk-name');
      const label = elementClipLabel(e);
      if (nameEl) setText(nameEl, label);
      setClipLoopMark(h.block, isLooping(e));
      setTip(h.block, elementClipTip(e, label));
    }
    this._paintLinks();
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
    const t = this._editTimes.get(`${objId}:${path}`) ?? this._frameTime();
    // Rows display effective values; store the local value each linked axis
    // needs at the playhead (unlinked axes pass through).
    const local = v.map((n, i) => {
      const back = writeBackLocalValue(this.project, { host: 'ob', id: objId }, `${path}.${'xyz'[i]}`, t, n);
      return Number.isFinite(back) ? back : n;
    });
    if (this._hasTrack(o, path)) this.onOp?.({ op: 'objectKey', id: objId, path, t, v: local });
    else this.onOp?.({ op: 'objectPatch', id: objId, patch: { [path]: local } });
  }

  _commitOpacity(objId) {
    const pr = this._propRows.find((x) => x.objId === objId && x.path === 'opacity');
    const o = this._obj(objId);
    if (!pr || !o) return;
    let v = readNumber(pr.inputs[0]);
    if (!Number.isFinite(v)) return;
    const t = this._editTimes.get(`${objId}:opacity`) ?? this._frameTime();
    const back = writeBackLocalValue(this.project, { host: 'ob', id: objId }, 'opacity', t, v);
    if (Number.isFinite(back)) v = back;
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
    const t = this._frameTime();
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
    if (path === 'transform.opacity' || path === 'audio.volume') v = Math.max(0, Math.min(1, v));
    if (path === 'transform.scale') v = Math.max(0, v);
    const t = this._editTimes.get(`${elId}:${path}`) ?? this._frameTime();
    // The input shows the effective value; store the local value its property
    // link needs at this time (no-op for unlinked rows).
    const local = localElementRowValue(this.project, e, path, t, v);
    if (local != null && Number.isFinite(local)) v = local;
    const keyPath = this._elKeyPath(e, path);
    const target = elementRowTarget(e, path);
    const keyed = pr.keyedAtFocus ?? this._elTrack(e, keyPath).length > 0;
    if (keyed) {
      const value = target ? rowToTarget(e, this.project?.meta, target, v, path) : v;
      this.onOp?.({ op: 'keySet', id: elId, path: keyPath, t, value: value == null ? v : value });
      return;
    }
    if (path === 'audio.volume') {
      this.onOp?.({ op: 'updateElement', id: elId, patch: { volume: v } });
      return;
    }
    if (e.node) {
      const patch = nodeRowPatch(e, path, v, this.project?.meta);
      if (patch) {
        this.onOp?.({ op: 'updateElement', id: elId, patch });
        return;
      }
    }
    const key = path.slice(path.lastIndexOf('.') + 1);
    this.onOp?.({ op: 'updateElement', id: elId, patch: { transform: { [key]: v } } });
  }

  _toggleElementKey(elId, path) {
    const e = this._element(elId);
    if (!e) return;
    this.onPause?.();
    const t = this._frameTime();
    const keyPath = this._elKeyPath(e, path);
    const keys = this._elTrack(e, keyPath);
    if (keys.some((k) => Math.abs(Number(k.t) - t) < 1e-3)) {
      this.onOp?.({ op: 'keyRemove', id: elId, path: keyPath, t });
      return;
    }
    const local = this._elValue(e, path, t);
    const target = elementRowTarget(e, path);
    const value = target ? rowToTarget(e, this.project?.meta, target, local, path) : local;
    // A rotation key on a node that still carries only dir/roll needs a base
    // rotation first; otherwise the other two axes read 0 and the pose jumps.
    if (keyPath.startsWith('rotation.') && e.node && !Array.isArray(e.node.rotation)) {
      const rot = AX.map((ax) => {
        const v = this._elValue(e, `rotation.${ax}`, t);
        return Number.isFinite(v) ? v : 0;
      });
      this.onOp?.({
        op: 'batch',
        ops: [
          { op: 'updateElement', id: elId, patch: { node: { ...e.node, rotation: rot } } },
          { op: 'keySet', id: elId, path: keyPath, t, value: value == null ? local : value },
        ],
      });
      return;
    }
    this.onOp?.({ op: 'keySet', id: elId, path: keyPath, t, value: value == null ? local : value });
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

  /** Send every debounced property edit now (property-link jump must not lose typing). */
  flushPending() {
    for (const key of [...this._pending.keys()]) this._flush(key);
  }

  _toggleExpand(id) {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
      this._scrollTo = id;
    }
    this.render(true);
  }

  _toggleElementExpand(id) {
    if (this.expandedEls.has(id)) {
      this.expandedEls.delete(id);
    } else {
      this.expandedEls.add(id);
      this._scrollTo = `el:${id}`;
    }
    this.render(true);
  }

  /** Public toggle used by a second click in the viewport. */
  toggleExpanded(id, kind = 'element') {
    if (kind === 'object') this._toggleExpand(id);
    else this._toggleElementExpand(id);
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
    // 'camera' has no header id of its own: prefer the live camera, then any
    // open camera page.
    const camId = this._activeCameraId() || [...this.openCams][0] || null;
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
    this.inner.querySelectorAll('.poolsel').forEach((n) => n.classList.remove('poolsel', 'poolprimary', 'poolpart'));
    const pool = this.pool;
    if (!pool.kind || !pool.ids.length) return;
    const ids = new Set(pool.ids);
    const primary = pool.primary;
    const mark = (node, ref) => {
      if (!ids.has(ref)) return;
      node.classList.add('poolsel');
      if (ref === primary) node.classList.add('poolprimary');
    };
    if (pool.kind === 'element') {
      this.inner.querySelectorAll('.tl-camhead[data-cam], .blk.cam[data-cam]').forEach((n) => mark(n, cameraRef(n.dataset.cam)));
      this.inner.querySelectorAll('.tl-objhead[data-obj], .blk.ob[data-obj]').forEach((n) => mark(n, objectRef(n.dataset.obj)));
      this.inner.querySelectorAll('.tl-elhead[data-el], .blk.el[data-id]').forEach((n) => mark(n, elementRef(n.dataset.el || n.dataset.id)));
    } else if (pool.kind === 'property') {
      this.inner.querySelectorAll('.tl-prop[data-obj][data-path]').forEach((n) => mark(n, propertyRef(objectRef(n.dataset.obj), n.dataset.path)));
      this.inner.querySelectorAll('.tl-elprop[data-el][data-path]').forEach((n) => mark(n, propertyRef(elementRef(n.dataset.el), n.dataset.path)));
      this.inner.querySelectorAll('.tl-camprop[data-cam][data-path]').forEach((n) => mark(n, propertyRef(cameraRef(n.dataset.cam), n.dataset.path)));
    } else if (pool.kind === 'keyframe') {
      this.inner.querySelectorAll('.tl-key').forEach((n) => {
        // A merged diamond is one node for up to three refs: it reads as
        // selected once every key it stands for is, and keeps its hollow shape
        // (poolpart) while only some of them are.
        const refs = this._keyNodeRefs(n);
        if (!refs.length) return;
        const inside = refs.filter((ref) => ids.has(ref));
        if (!inside.length) return;
        n.classList.add('poolsel');
        if (inside.length < refs.length) n.classList.add('poolpart');
        else if (refs.includes(primary)) n.classList.add('poolprimary');
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
      // Mark the selected camera header and every 位置 row of that camera. The
      // active camera is only a fallback: with several open pages the selection
      // (pool primary) is what tells them apart.
      const camId = this._selectedCameraId();
      if (camId) {
        this.inner.querySelector(`.blk.cam[data-cam="${camId}"]`)?.classList.add('sel');
        this.inner.querySelector(`.tl-camhead[data-cam="${camId}"]`)?.classList.add('sel');
        this.inner.querySelector(`.tl-camposrow[data-cam="${camId}"]`)?.classList.add('sel');
      }
    }
    this._paintPool();
  }

  /** Human name of a parent id across elements, objects and cameras. */
  _parentName(parent) {
    const id = parent?.id == null ? '' : String(parent.id);
    if (!id) return '';
    if (id === '@live') return '当前镜头 (@live)';
    const p = this.project;
    const host = (p?.elements || []).find((x) => x.id === id)
      || (p?.scene?.objects || []).find((x) => x.id === id)
      || (p?.cameras || []).find((x) => x.id === id);
    return host?.name || id;
  }

  /**
   * Parent button in a header row. Every host can be a spatial child now
   * (core/spatial-parent.js::spatialParent writes `el.parent` for 2D elements,
   * `ob.frameParent` / `cam.frameParent` for 3D objects and cameras). Press and
   * drag to a target row of any kind; a plain click removes the parent.
   */
  _parentButton(kind, host) {
    const record = kind === 'el' ? host.parent : (host.frameParent || (kind === 'ob' ? host.parent : null));
    const btn = h('button', {
      type: 'button', class: `tl-objparentbtn${record?.id ? ' on' : ''}`,
      'aria-label': '空间父级', 'data-tip': record?.id
        ? `空间父级：${this._parentName(record)}\n拖动到别的元素换父级；单击解除`
        : '空间父级\n按住拖到目标元素行',
    }, '↳');
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._startParentDrag(ev, kind, host, btn);
    });
    return btn;
  }

  _runParentOp(op) {
    try {
      const pending = this.onOp?.(op);
      if (pending?.catch) pending.catch((err) => this.onToast?.(String(err?.message || err)));
    } catch (err) {
      this.onToast?.(String(err?.message || err));
    }
  }

  _removeParent(kind, host) {
    if (kind === 'el') {
      if (!host?.parent?.id) return;
      this._runParentOp(host.parent.mode === 'world'
        ? { op: 'spatialUnparent', id: host.id }
        : { op: 'elementUnparent', id: host.id, t: round3(this.time) });
      return;
    }
    if (host?.frameParent?.id) {
      this._runParentOp({ op: 'spatialUnparent', id: host.id });
      return;
    }
    // Keep the old 3D parent button behaviour when only obj.parent is set.
    if (kind === 'ob' && host?.parent?.id) {
      this._runParentOp({ op: 'objectUnparent', id: host.id, t: round3(this.time) });
    }
  }

  _startParentDrag(ev, kind, host, btn) {
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    let line = null;
    let targetRow = null;
    const childId = host.id;
    const clean = () => {
      line?.remove();
      line = null;
      targetRow?.classList.remove('parent-target');
      targetRow = null;
      btn.classList.remove('drop');
      document.body.classList.remove('tl-parent-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
    };
    const rowAt = (x, y) => document.elementFromPoint(x, y)?.closest?.(
      '.tl-elhead[data-el], .tl-objhead[data-obj], .tl-camhead[data-cam]',
    ) || null;
    const targetOf = (row) => {
      if (!row) return null;
      if (row.dataset.el) return { kind: 'el', id: row.dataset.el, name: this._element(row.dataset.el)?.name };
      if (row.dataset.obj) return { kind: 'ob', id: row.dataset.obj, name: this._obj(row.dataset.obj)?.name };
      if (row.dataset.cam) return { kind: 'cam', id: row.dataset.cam, name: this._camById(row.dataset.cam)?.name };
      return null;
    };
    const wire = (x, y) => {
      if (!line) {
        line = h('div', { class: 'tl-parent-wire' });
        document.body.appendChild(line);
      }
      const r = btn.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const dx = x - x0, dy = y - y0;
      line.style.left = `${x0}px`;
      line.style.top = `${y0}px`;
      line.style.width = `${Math.hypot(dx, dy)}px`;
      line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    };
    const move = (e) => {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3) {
        moved = true;
        document.body.classList.add('tl-parent-dragging');
        btn.classList.add('drop');
      }
      if (!moved) return;
      wire(e.clientX, e.clientY);
      const row = rowAt(e.clientX, e.clientY);
      if (row !== targetRow) {
        targetRow?.classList.remove('parent-target');
        targetRow = row;
        targetRow?.classList.add('parent-target');
      }
    };
    const up = (e) => {
      const didMove = moved;
      const row = targetRow;
      clean();
      if (!didMove) {
        this._removeParent(kind, host);
        return;
      }
      const target = targetOf(row);
      if (!target) return this.onToast?.('没有落在元素行上');
      if (target.id === childId) return this.onToast?.('不能把自己设成父级');
      // One op for every child kind: 2D elements, 3D objects and cameras all
      // become spatial children (op writes `el.parent` / `*.frameParent`).
      this._runParentOp({ op: 'spatialParent', id: childId, parent: target.id, t: round3(this.time) });
    };
    const cancel = () => clean();
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      clean();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
  }

  _pickPool(kind, ref, ev) {
    const additive = !!(ev?.ctrlKey || ev?.metaKey || ev?.shiftKey);
    // The pool is homogeneous: additive picks toggle inside it and enter it
    // from an empty / foreign pool, so the first Ctrl+click on a diamond is
    // never swallowed (see pickSelection in core/selection.js).
    this.pool = pickSelection(this.pool, kind, ref, additive);
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
      this.onSeek?.(this._snapPlayhead(this._timeAt(e.clientX)));
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
   * Element-list marquee: press an unselected row (or Ctrl-press any row) and
   * drag across headers to select every row intersecting the band. Reordering
   * stays on an already-selected row, per the agreed gesture split.
   */
  _startElementMarquee(ev, header) {
    const hit = this._headerRows().find((x) => x.row === header);
    if (!hit) return;
    const { ref, kind, id } = hit;
    const additive = !!(ev.ctrlKey || ev.metaKey || ev.shiftKey);
    this._pickPool('element', ref, ev);
    this.propSel = null;
    this._selectPoolHost();
    this._paintSelection();
    this._startMarquee(ev, {
      scope: 'elements',
      additive,
      tap: () => { if (!additive && kind === 'cam') this._activateCamera(id); },
    });
  }

  /**
   * Drag a box over the lanes to select keyframe diamonds. The band ends at the
   * pointerup coordinates (never a stale last move), is clipped to the visible
   * lane area so diamonds hidden under the sticky name column cannot be caught,
   * and hits by rect intersection with a little tolerance instead of only the
   * diamond centre. A press without movement clears the selection; callers that
   * need a click action arm it through `_deferGesture` and only hand over once
   * the pointer really moved.
   *
   * `additive` (Ctrl/Cmd/Shift) toggles the diamonds in the band instead of
   * replacing the pool: unselected keys are added, selected keys are removed.
   * `scope: 'elements'` draws the same band over header rows; `tap` is the
   * no-movement action (camera activation when a plain camera row was pressed).
   */
  _startMarquee(ev, { slop = 3, at = null, additive = false, scope = 'keyframes', tap = null } = {}) {
    const start = { x: ev.clientX, y: ev.clientY };
    let last = at ? { x: at.x, y: at.y } : { ...start };
    let moved = !!at;
    const box = el('div', 'tl-marquee');
    box.hidden = !moved;
    this.inner.appendChild(box);

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

    /** Client-space band, clamped to the lane area right of the sticky gutter. */
    const bandRect = () => {
      const scrollRect = this.scroll.getBoundingClientRect();
      const band = padded(start, last);
      band.left = Math.max(band.left, scrollRect.left + (scope === 'elements' ? 0 : this._gutter()));
      band.right = Math.min(Math.max(band.left, band.right), scrollRect.right);
      band.top = Math.max(band.top, scrollRect.top);
      band.bottom = Math.min(Math.max(band.top, band.bottom), scrollRect.bottom);
      return band;
    };

    const draw = () => {
      const rect = this.inner.getBoundingClientRect();
      const band = bandRect();
      box.style.left = `${band.left - rect.left}px`;
      box.style.top = `${band.top - rect.top}px`;
      box.style.width = `${Math.max(0, band.right - band.left)}px`;
      box.style.height = `${Math.max(0, band.bottom - band.top)}px`;
    };

    const samePointer = (e) => !e || e.pointerId == null || e.pointerId === ev.pointerId;

    const update = (e) => {
      if (!samePointer(e)) return;
      last = { x: e.clientX, y: e.clientY };
      if (!moved && Math.hypot(last.x - start.x, last.y - start.y) > slop) moved = true;
      if (!moved) return;
      box.hidden = false;
      draw();
    };

    /** Refs of the diamonds intersecting the band; deduped and order-stable. */
    const hitRefs = () => {
      const band = bandRect();
      const tol = 2;
      const refs = [];
      const seen = new Set();
      if (scope === 'elements') {
        for (const hit of this._headerRows()) {
          const node = hit.row;
          if (!node.getClientRects().length) continue; // hidden by the filter
          const r = node.getBoundingClientRect();
          const inside = r.right + tol >= band.left && r.left - tol <= band.right
            && r.bottom + tol >= band.top && r.top - tol <= band.bottom;
          if (!inside || seen.has(hit.ref)) continue;
          seen.add(hit.ref);
          refs.push(hit.ref);
        }
        return refs;
      }
      this.inner.querySelectorAll('.tl-key').forEach((node) => {
        if (!node.getClientRects().length) return; // hidden by the filter
        const r = node.getBoundingClientRect();
        const hit = r.right + tol >= band.left && r.left - tol <= band.right
          && r.bottom + tol >= band.top && r.top - tol <= band.bottom;
        if (!hit) return;
        // A merged diamond contributes every axis keyed at its time.
        for (const ref of this._keyNodeRefs(node)) {
          if (seen.has(ref)) continue;
          seen.add(ref);
          refs.push(ref);
        }
      });
      return refs;
    };

    /** Take the keyframe pool and keep the primary key's host row selected. */
    const apply = () => {
      const hits = hitRefs();
      if (scope === 'elements') {
        const prev = additive && this.pool?.kind === 'element' ? this.pool.ids : [];
        let pool;
        if (!additive) {
          pool = hits.length
            ? normalizeSelection({ kind: 'element', ids: hits, primary: hits[hits.length - 1] })
            : emptySelection();
        } else {
          const before = new Set(prev);
          const ids = [...new Set([...prev, ...hits])];
          const primary = hits.find((ref) => !before.has(ref)) || this.pool?.primary || ids[0] || null;
          pool = normalizeSelection({ kind: 'element', ids, primary });
        }
        this.pool = pool;
        this.segmentId = null;
        this.propSel = null;
        this._selectPoolHost();
        this._paintSelection();
        return;
      }
      const ids = hits;
      const prev = additive && this.pool?.kind === 'keyframe' ? this.pool.ids : [];
      const set = new Set(prev);
      for (const id of ids) {
        if (additive && set.has(id)) set.delete(id);
        else set.add(id);
      }
      const list = [...set];
      const primaryId = additive
        ? (this.pool?.primary && set.has(this.pool.primary) ? this.pool.primary : (list[list.length - 1] || null))
        : (ids[0] || null);
      const primary = primaryId ? splitRef(primaryId) : null;
      this.pool = list.length
        ? normalizeSelection({ kind: 'keyframe', ids: list, primary: primaryId })
        : emptySelection();
      this.segmentId = null;
      this.propSel = null;
      if (!primary) {
        this.cameraSel = false;
        this.objectId = null;
        this.elementId = null;
        this.onSelect?.({ elementId: null, segmentId: null, objectId: null, camera: false, pool: this.pool });
        this._paintSelection();
        return;
      }
      const oneProp = list.every((id) => {
        const s = splitRef(id);
        return s && s.host === primary.host && s.path === primary.path;
      });
      this.cameraSel = primary.type === 'cam';
      this.elementId = primary.type === 'el' ? primary.id : null;
      this.objectId = primary.type === 'ob' ? primary.id : null;
      if (oneProp && primary.type === 'el') this.propSel = { elId: primary.id, path: primary.path };
      if (oneProp && primary.type === 'ob') this.propSel = { objId: primary.id, path: primary.path };
      if (primary.type === 'cam') this.onSelect?.({ camera: true, pool: this.pool });
      else if (primary.type === 'ob') this.onSelect?.({ objectId: primary.id, pool: this.pool });
      else this.onSelect?.({ elementId: primary.id, pool: this.pool });
      this._paintSelection();
    };

    /** Press without drag on an empty lane: clear the selection. */
    const clear = () => {
      this.pool = emptySelection();
      this.cameraSel = false;
      this.objectId = null;
      this.elementId = null;
      this.segmentId = null;
      this.propSel = null;
      this.onSelect?.({ elementId: null, segmentId: null, objectId: null, camera: false, pool: this.pool });
      this._paintSelection();
    };

    let done = false;
    const cleanup = () => {
      done = true;
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
      this.inner.removeEventListener('lostpointercapture', lost);
      box.remove();
      try {
        if (this.inner.hasPointerCapture(ev.pointerId)) this.inner.releasePointerCapture(ev.pointerId);
      } catch { /* synthetic pointer / already released */ }
    };

    const finish = (e) => {
      if (done || !samePointer(e)) return;
      if (e) last = { x: e.clientX, y: e.clientY };
      const dragged = moved;
      cleanup();
      if (!dragged) {
        if (tap) tap();
        else if (!additive) clear();
        return;
      }
      this._swallowNextClick();
      apply();
    };

    const cancel = () => {
      if (!done) cleanup();
    };

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };

    // A lost capture (window switch, pointer stolen) ends the gesture; the box
    // must not stay behind and no click should be synthesised from it.
    const lost = () => cancel();

    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
    this.inner.addEventListener('lostpointercapture', lost);

    // Keep receiving moves when the pointer leaves the window. Synthetic
    // pointers (capture runs, preview scripts) have nothing to capture and fall
    // back to the window listeners above.
    try {
      this.inner.setPointerCapture(ev.pointerId);
    } catch { /* no active pointer */ }
  }

  /**
   * Press and wait: a tap runs `onTap`, a drag past `slop` is offered to
   * `onDrag` first (keyframe diamonds move their selection horizontally) and
   * falls back to the marquee. Keyframe diamonds and section / property
   * gutters need both (click to select or toggle, drag to box-select).
   */
  _deferGesture(ev, { slop = 4, onTap = null, onDrag = null } = {}) {
    const start = { x: ev.clientX, y: ev.clientY };
    let handed = false;
    const samePointer = (e) => !e || e.pointerId == null || e.pointerId === ev.pointerId;
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
    };
    const move = (e) => {
      if (handed || !samePointer(e)) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= slop) return;
      handed = true;
      cleanup();
      if (onDrag?.(e)) return;
      this._startMarquee(ev, {
        at: { x: e.clientX, y: e.clientY },
        additive: !!(ev.ctrlKey || ev.metaKey || ev.shiftKey),
      });
    };
    const up = (e) => {
      if (!samePointer(e)) return;
      cleanup();
      if (!handed) onTap?.();
    };
    const cancel = () => cleanup();
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
  }

  /** A real drag can still synthesise a click; eat exactly that one. */
  _swallowNextClick() {
    if (this._clickSwallow) clearTimeout(this._clickSwallow.timer);
    const eat = (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(this._clickSwallow?.timer);
      this._clickSwallow = null;
    };
    this.inner.addEventListener('click', eat, { capture: true, once: true });
    this._clickSwallow = {
      timer: setTimeout(() => {
        this.inner.removeEventListener('click', eat, true);
        this._clickSwallow = null;
      }, 350),
    };
  }

  /**
   * Refs a `.tl-key` node stands for: exactly one for a real diamond, one per
   * keyed axis for a merged diamond on a collapsed transform row.
   */
  _keyNodeRefs(node) {
    const ref = keyframeRefOf(node);
    return ref ? [ref] : this._summaryRefs(node);
  }

  /**
   * Refs behind a merged diamond (`.tl-key-sum`). A collapsed transform row
   * draws one diamond per keyed time on the parent lane instead of one per axis
   * (docs/DESIGN-TRANSFORM-UNIFY.md §9.1), so that diamond has no ref of its
   * own: it stands for every axis that has a key at that time. The pool is
   * homogeneous in *kind* and may hold several refs of one host, so a click
   * takes them all — Delete, the curve panel and a drag then act on exactly the
   * keys the expanded sub-rows would have given one by one.
   */
  _summaryRefs(node) {
    if (!node?.classList?.contains('tl-key-sum')) return [];
    const t = Number(node.dataset.t);
    if (!Number.isFinite(t)) return [];
    const entry = this._xformRows.find((x) => x.lane === node.parentElement);
    const host = entry ? this._xformHost(entry) : null;
    if (!host) return [];
    const hostRef = entry.kind === 'cam' ? cameraRef(entry.id)
      : entry.kind === 'ob' ? objectRef(entry.id)
        : elementRef(entry.id);
    const refs = [];
    for (const ax of XF_AXES) {
      const path = xfAxisPath(entry.kind, entry.rowKey, ax);
      // Match the key's own (round-3) time, not "a key within tolerance": a
      // zoomed-out row must not hand the pool a ref that does not exist.
      const times = xfAxisKeyState(host, entry.kind, entry.rowKey, ax, t, this._tol()).times || [];
      const at = times.find((x) => Math.abs(x - t) <= 1e-3);
      if (at == null) continue;
      refs.push(keyframeRef(hostRef, path, at));
    }
    return refs;
  }

  /**
   * One pick over a keyframe node's refs. A plain pick replaces the pool, an
   * additive one toggles the whole set (all in -> all out) so a merged diamond
   * behaves like the group of keys it shows.
   */
  _pickKeyRefs(refs, ev) {
    const additive = !!(ev?.ctrlKey || ev?.metaKey || ev?.shiftKey);
    if (refs.length === 1) {
      this.pool = pickSelection(this.pool, 'keyframe', refs[0], additive);
      return;
    }
    if (!additive) {
      this.pool = normalizeSelection({ kind: 'keyframe', ids: refs, primary: refs[0] });
      return;
    }
    const cur = normalizeSelection(this.pool);
    const ids = cur.kind === 'keyframe' ? cur.ids : [];
    const has = new Set(ids);
    if (refs.every((ref) => has.has(ref))) {
      // Every key of the group is selected: drop them together.
      const left = ids.filter((ref) => !refs.includes(ref));
      const primary = has.has(cur.primary) && left.includes(cur.primary)
        ? cur.primary
        : left[left.length - 1];
      this.pool = left.length
        ? normalizeSelection({ kind: 'keyframe', ids: left, primary })
        : emptySelection();
      return;
    }
    const next = [...new Set([...ids, ...refs])];
    this.pool = normalizeSelection({
      kind: 'keyframe', ids: next, primary: refs.find((ref) => !has.has(ref)) || next[0],
    });
  }

  /** A tap on a diamond: pick its refs (additive toggles) and adopt its host. */
  _selectKeyNode(node, ev) {
    const refs = this._keyNodeRefs(node);
    if (!refs.length) return false;
    this._pickKeyRefs(refs, ev);
    // Follow the pool's primary, so an additive pick that emptied the pool does
    // not leave the previous key's property row highlighted.
    const primary = splitRef(this.pool.primary || '');
    if (primary?.type === 'el') this.propSel = { elId: primary.id, path: primary.path };
    else if (primary?.type === 'ob') this.propSel = { objId: primary.id, path: primary.path };
    else this.propSel = null;
    this._selectPoolHost();
    this._paintSelection();
    return true;
  }

  /**
   * A horizontal drag on a diamond moves the whole keyframe pool by whole
   * frames; a vertical drag keeps the old marquee gesture. An unselected
   * diamond is selected first (Ctrl/Shift still toggle), then its pool is
   * dragged: a multi-host pool keeps every key on its own host and track.
   * A merged diamond drags every axis keyed at its time. Returns false when the
   * press should fall back to the marquee.
   */
  _dragKeys(ev, node, at) {
    const refs = this._keyNodeRefs(node);
    if (!refs.length) return false;
    // Only horizontal movement changes time; a mostly-vertical drag is still a
    // box-select, like it was before keyframe dragging existed.
    const dx = at.clientX - ev.clientX;
    const dy = at.clientY - ev.clientY;
    if (Math.abs(dx) <= Math.abs(dy)) return false;
    const selected = this.pool?.kind === 'keyframe' && refs.some((ref) => this.pool.ids.includes(ref));
    if (!selected) {
      this._selectKeyNode(node, ev);
    }
    if (this.pool?.kind !== 'keyframe' || !this.pool.ids.length) return false;
    this._beginKeyframeDrag(ev, [...this.pool.ids], at.clientX);
    return true;
  }

  /**
   * One batch per drag, one undo step. The preview only writes `style.left` on
   * the diamonds that are on screen (no render per pointermove); the commit
   * recomputes the same frame-quantized times through core/keyframe-edit.js.
   * Esc / pointercancel restores the preview and commits nothing.
   */
  _beginKeyframeDrag(ev, refs, atClientX = null) {
    const list = [...new Set(refs.map(String))];
    if (!list.length) return false;
    this.onPause?.();
    const fps = this._fps();
    const pxPerFrame = Math.max(0.01, this.pps / fps);
    const startX = ev.clientX;
    const wanted = new Set(list);
    const nodes = [];
    this.inner.querySelectorAll('.tl-key').forEach((node) => {
      // A merged diamond previews through the first ref it shares with the
      // pool; every axis at that time moves by the same delta anyway.
      const ref = this._keyNodeRefs(node).find((r) => wanted.has(r));
      if (!ref) return;
      const t = Number(node.dataset.t);
      if (!Number.isFinite(t)) return;
      nodes.push({ ref, node, left: node.style.left });
    });
    for (const n of nodes) n.node.classList.add('dragging');

    const framesAt = (clientX) => Math.round((clientX - startX) / pxPerFrame);
    let lastFrames = null;
    let done = false;
    const samePointer = (e) => !e || e.pointerId == null || e.pointerId === ev.pointerId;

    const resetPreview = () => {
      for (const n of nodes) n.node.style.left = n.left;
    };
    const draw = (res) => {
      if (res.error || !res.deltaFrames || !res.moves.length) {
        resetPreview();
        return;
      }
      const byRef = new Map(res.moves.map((m) => [m.ref, m.to]));
      for (const n of nodes) {
        const to = byRef.get(n.ref);
        if (to != null) n.node.style.left = `${to * this.pps}px`;
      }
    };

    const cleanup = () => {
      done = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', down);
      window.removeEventListener('keydown', onKey, true);
      this.inner.removeEventListener('lostpointercapture', lost);
      for (const n of nodes) n.node.classList.remove('dragging');
      try {
        if (this.inner.hasPointerCapture(ev.pointerId)) this.inner.releasePointerCapture(ev.pointerId);
      } catch { /* synthetic pointer / already released */ }
    };

    const move = (e) => {
      if (done || !samePointer(e)) return;
      const frames = framesAt(e.clientX);
      if (frames === lastFrames) return;
      lastFrames = frames;
      draw(keyframeMoveOps(list, frames, this.project, fps));
    };

    const up = (e) => {
      if (done || !samePointer(e)) return;
      const frames = framesAt(e.clientX);
      cleanup();
      this._swallowNextClick();
      const res = keyframeMoveOps(list, frames, this.project, fps);
      if (res.error) {
        resetPreview();
        this.onToast?.(res.error, 'warn');
        return;
      }
      if (!res.ops.length) {
        resetPreview();
        return;
      }
      if (!this.onOp) {
        resetPreview();
        return;
      }
      const oldPool = this.pool;
      const remap = new Map(res.moves.map((m) => [m.ref, m.refNew]));
      // adopt the new refs before the op lands: applyProject() prunes keyframe
      // pool refs that no longer resolve, and the old times are about to vanish
      this.pool = normalizeSelection({
        kind: 'keyframe',
        ids: oldPool.ids.map((id) => remap.get(id) || id),
        primary: remap.get(oldPool.primary) || oldPool.primary,
      });
      this._selectPoolHost();
      const pending = this.onOp(res.batch);
      if (!pending?.then) return;
      pending.then((ok) => {
        if (ok) return; // applyProject() rebuilds the rows at the new times
        this.pool = oldPool;
        this._selectPoolHost();
        resetPreview();
      }).catch(() => {
        this.pool = oldPool;
        this._selectPoolHost();
        resetPreview();
      });
    };

    const down = () => {
      if (done) return;
      cleanup();
      resetPreview();
      this._swallowNextClick();
    };

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      down();
    };

    const lost = () => down();

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', down);
    window.addEventListener('keydown', onKey, true);
    this.inner.addEventListener('lostpointercapture', lost);
    try {
      this.inner.setPointerCapture(ev.pointerId);
    } catch { /* no active pointer */ }
    // The move that crossed the slop threshold was dispatched before these
    // listeners existed; preview it now so the diamond never lags one event.
    if (atClientX != null) {
      lastFrames = framesAt(atClientX);
      draw(keyframeMoveOps(list, lastFrames, this.project, fps));
    }
    return true;
  }

  /** A tap on a property gutter: pick the property and its host row. */
  _selectProperty(kind, id, path, ev) {
    const host = kind === 'cam' ? cameraRef(id) : kind === 'ob' ? objectRef(id) : elementRef(id);
    this._pickPool('property', propertyRef(host, path), ev);
    if (kind === 'ob') this.propSel = { objId: id, path };
    else if (kind === 'el') this.propSel = { elId: id, path };
    this._selectPoolHost();
    this._paintSelection();
  }

  _down(ev) {
    if (ev.button !== 0) return;
    const target = ev.target;
    // controls / fields handle themselves (focus, clicks); they never drag
    if (/INPUT|TEXTAREA|SELECT/.test(target.tagName || '') || target.closest('button, .tl-num, .tl-kf')) return;
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
    // A diamond is a click on release; a horizontal drag moves the keyframe
    // pool, any other drag still starts a marquee. The marquee may include
    // element keys (`data-el`), not just camera/3D ones. A merged diamond on a
    // collapsed transform row has no ref of its own but stands for every axis
    // keyed at that time, so it is a key surface too — it must never fall
    // through to the lane and clear the selection.
    const keyNode = target.closest?.('.tl-key');
    if (keyNode && (keyframeRefOf(keyNode) || keyNode.classList.contains('tl-key-sum'))) {
      ev.preventDefault();
      this._deferGesture(ev, {
        slop: 3,
        onTap: () => this._selectKeyNode(keyNode, ev),
        onDrag: (e) => this._dragKeys(ev, keyNode, e),
      });
      return;
    }
    // Section rows: a click anywhere on the row (gutter or lane) still toggles
    // the group, but a drag becomes a marquee instead.
    const sect = target.closest?.('.tl-sect');
    if (sect) {
      ev.preventDefault();
      this._deferGesture(ev, {
        slop: 3,
        onTap: () => { if (sect.dataset.sec) this._toggleSection(sect.dataset.sec); },
      });
      return;
    }
    ev.preventDefault();
    this._noSnap = ev.altKey;
    const blk = target.closest?.('.blk');
    const gutterEl = target.closest?.('.tl-gutter[data-id]');

    // ---- property rows: tap selects, drag box-selects keyframes ----
    const camPropGutter = target.closest?.('.tl-camprop[data-cam] .tl-gutter');
    if (camPropGutter) {
      const pr = camPropGutter.closest('.tl-camprop');
      this._deferGesture(ev, { onTap: () => this._selectProperty('cam', pr.dataset.cam, pr.dataset.path, ev) });
      return;
    }
    const elPropGutter = target.closest?.('.tl-elprop[data-el] .tl-gutter');
    if (elPropGutter) {
      const pr = elPropGutter.closest('.tl-elprop');
      this._deferGesture(ev, { onTap: () => this._selectProperty('el', pr.dataset.el, pr.dataset.path, ev) });
      return;
    }
    const propGutter = target.closest?.('.tl-prop[data-obj] .tl-gutter');
    if (propGutter) {
      const pr = propGutter.closest('.tl-prop');
      this._deferGesture(ev, { onTap: () => this._selectProperty('ob', pr.dataset.obj, pr.dataset.path, ev) });
      return;
    }
    // Any header row in the left list: press + drag vertically to reorder.
    // 2D rows change el.z, camera rows change cameraOrder, 3D/audio rows only
    // move in the display list. Click without movement keeps the old behaviour
    // (select / second click expands / camera activates).
    const head = target.closest?.('.tl-gutter')?.closest?.('.tl-camhead[data-cam], .tl-elhead[data-el], .tl-objhead[data-obj]');
    if (head) {
      const hit = this._headerRows().find((x) => x.row === head);
      const additive = !!(ev.ctrlKey || ev.metaKey || ev.shiftKey);
      const inPool = !!hit && this.pool?.kind === 'element' && this.pool.ids.includes(hit.ref);
      // Reorder only from an already-selected row; an unselected press-drag is
      // an element marquee (a plain tap still selects the row).
      if (!inPool || additive) this._startElementMarquee(ev, head);
      else this._startRowDrag(ev, head);
      return;
    }
    const objBlk = target.closest?.('.blk.ob');
    if (objBlk) {
      const id = objBlk.dataset.obj;
      const wasSelected = this.objectId === id && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
      this._pickPool('element', objectRef(id), ev);
      this._selectPoolHost();
      this._paintSelection();
      const item = this._obj(id);
      if (!item) return;
      const mode = target.classList.contains('handle-l') ? 'l'
        : target.classList.contains('handle-r') ? 'r' : 'move';
      const t0 = this._timeAt(ev.clientX);
      const orig = { start: item.start, duration: item.duration };
      let moved = false;
      const downX = ev.clientX, downY = ev.clientY;
      const move = (e) => {
        this._noSnap = e.altKey;
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 3) moved = true;
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
        const q = this._clipPreview(mode, ns, nd);
        ns = q.start; nd = q.duration;
        objBlk.style.left = `${ns * this.pps}px`;
        setClipWidth(objBlk, nd * this.pps);
        objBlk._ns = ns; objBlk._nd = nd;
      };
      const up = (e) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!moved && wasSelected && mode === 'move') {
          if (!(e?.detail > 1 && item.type === 'text')) this._toggleExpand(id);
          return;
        }
        const ns = objBlk._ns, nd = objBlk._nd;
        if (ns == null) return;
        const q = this._clipEdit(mode, ns, nd);
        if (Math.abs(q.start - orig.start) < 1e-4 && Math.abs(q.duration - orig.duration) < 1e-4) return;
        this.onOp?.(mode === 'move'
          ? { op: 'objectPatch', id, patch: { start: q.start } }
          : { op: 'objectPatch', id, patch: { start: q.start, duration: q.duration } });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    // ---- camera / segments / v2 ----
    if (blk?.classList.contains('cam')) {
      const cam = this._camById(blk.dataset.cam);
      if (cam) this._startCameraClipDrag(cam, blk, ev);
      return;
    }
    // camera property labels: tap selects the row, drag box-selects keyframes
    if (target.closest?.('.tl-camprop .tl-gutter')) {
      const row = target.closest('.tl-camprop');
      const camId = row.dataset.cam || this._activeCameraId();
      const path = row.dataset.path;
      this._deferGesture(ev, { onTap: () => {
        if (path) {
          this._selectProperty('cam', camId, path, ev);
          return;
        }
        this.pool = selectOne('element', cameraRef(camId));
        this.cameraSel = true;
        this.elementId = null; this.segmentId = null; this.objectId = null;
        this.onSelect?.({ camera: true, pool: this.pool });
        this._paintSelection();
      } });
      return;
    }
    if (target.closest?.('.tl-camhint .tl-gutter')) {
      this._activateCamera(this._activeCameraId());
      return;
    }

    if (blk) {
      const id = blk.dataset.id;
      const wasSelected = this.elementId === id && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
      this._pickPool('element', elementRef(id), ev);
      this.propSel = null;
      this._selectPoolHost();
      this._paintSelection();

      const p = this.project;
      const item = p.elements.find((e) => e.id === id);
      if (!item) return;
      const mode = target.classList.contains('handle-l') ? 'l'
        : target.classList.contains('handle-r') ? 'r' : 'move';
      const t0 = this._timeAt(ev.clientX);
      const orig = { start: item.start, duration: item.duration };
      const srcIn = Math.max(0, Number(item.srcIn) || 0);
      const rawSource = (item.type === 'video' || item.type === 'audio')
        ? Number(this.sourceDuration?.(item)) : NaN;
      const sourceLimit = !item.loop && Number.isFinite(rawSource) && rawSource > 0 ? rawSource : null;
      let moved = false;
      const downX = ev.clientX, downY = ev.clientY;

      const move = (e) => {
        this._noSnap = e.altKey;
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 3) moved = true;
        const t = this._timeAt(e.clientX);
        const dt = t - t0;
        let ns = orig.start, nd = orig.duration;
        let hitSource = false;
        if (mode === 'move') {
          ns = Math.max(0, this._snap(orig.start + dt));
        } else if (mode === 'r') {
          const end = this._snap(orig.start + orig.duration + dt);
          nd = Math.max(0.08, end - orig.start);
          if (sourceLimit) {
            const maxDur = Math.max(0.08, sourceLimit - srcIn);
            if (nd > maxDur + 1e-9) { nd = maxDur; hitSource = true; }
          }
        } else {
          let s = Math.min(orig.start + orig.duration - 0.08, Math.max(0, this._snap(orig.start + dt)));
          if (sourceLimit) {
            const minStart = Math.max(0, orig.start - srcIn);
            if (s < minStart) { s = minStart; hitSource = true; }
          }
          nd = Math.max(0.08, orig.start + orig.duration - s);
          if (sourceLimit) {
            const maxDur = Math.max(0.08, sourceLimit - (srcIn + (s - orig.start)));
            if (nd > maxDur + 1e-9) { nd = maxDur; hitSource = true; }
          }
          ns = s;
        }
        const q = this._clipPreview(mode, ns, nd, {
          maxDuration: mode === 'r' && sourceLimit ? Math.max(0.08, sourceLimit - srcIn) : null,
        });
        ns = q.start; nd = q.duration;
        blk.style.left = `${ns * this.pps}px`;
        setClipWidth(blk, nd * this.pps);
        blk._ns = ns; blk._nd = nd; blk._sourceHit = hitSource;
      };
      const up = (e) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!moved && wasSelected && mode === 'move') {
          if (!(e?.detail > 1 && item.type === 'text')) this._toggleElementExpand(id);
          return;
        }
        const hitSource = !!blk._sourceHit && moved;
        if (hitSource) this.onSourceLimit?.(mode === 'l' ? 'start' : 'end');
        const ns = blk._ns, nd = blk._nd;
        if (ns == null) return;
        const q = this._clipEdit(mode, ns, nd, {
          // The source end is not a frame boundary; it keeps its exact seconds.
          // A left trim only extends away from that limit, so it needs no cap.
          maxDuration: mode === 'r' && sourceLimit ? Math.max(0.08, sourceLimit - srcIn) : null,
        });
        if (Math.abs(q.start - orig.start) < 1e-4 && Math.abs(q.duration - orig.duration) < 1e-4) return;
        this.onOp?.(mode === 'move'
          ? { op: 'moveElement', id, start: q.start }
          : { op: 'moveElement', id, start: q.start, duration: q.duration });
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
    if (target.closest('.tl-track')) this._startMarquee(ev, { additive: !!(ev.ctrlKey || ev.metaKey || ev.shiftKey) });
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;
// Pending-edit key of one camera's 位置 row: one per camera, not one global.
const camPosEditKey = (camId) => `camera:position:${camId}`;

/**
 * Stable keyframe ref for a `.tl-key` diamond, or null when the node is not a
 * real key. Cameras tag diamonds with `data-cam`, 3D objects with `data-obj` and
 * 2D elements with `data-el` (there is no `data-id` on a diamond); every ref
 * must round-trip through core/selection.js so the pool and Delete agree.
 */
function keyframeRefOf(node) {
  if (!node?.classList?.contains('tl-key')) return null;
  if (node.classList.contains('tl-key-sum')) return null;
  const t = Number(node.dataset.t);
  if (!Number.isFinite(t)) return null;
  if (node.dataset.cam) return keyframeRef(cameraRef(node.dataset.cam), node.dataset.path || 'path', t);
  if (!node.dataset.path) return null;
  if (node.dataset.obj) return keyframeRef(objectRef(node.dataset.obj), node.dataset.path, t);
  if (node.dataset.el) return keyframeRef(elementRef(node.dataset.el), node.dataset.path, t);
  return null;
}

// ------------------------------------------------------------ row / clip helpers
const filterKey = (name, id) => `${name ?? ''} ${id ?? ''}`.toLowerCase();

function setEye(btn, visible, showTip, hideTip) {
  btn.classList.toggle('off', !visible);
  const want = visible ? 'eye' : 'eye-off';
  if (btn.dataset.icon !== want) {
    btn.dataset.icon = want;
    btn.replaceChildren(icon(want, 'ic-sm'));
  }
  const tip = visible ? hideTip : showTip;
  setTip(btn, tip);
  setAttr(btn, 'aria-label', tip);
  setAttr(btn, 'aria-pressed', String(!visible));
}

// ------------------------------------------------------------ cheap DOM writes
// Every row used to be rewritten in full on every frame. These helpers read
// first and only touch the DOM when the value really changed: an unchanged
// textContent still replaces the text node and forces the browser to re-lay
// out the row, which is exactly what cost ~40 ms per played frame.
function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function setTip(node, tip) {
  if (!node) return;
  const next = tip ?? '';
  if (node.dataset.tip !== next) node.dataset.tip = next;
}

function setAttr(node, name, value) {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * Inline style, written only when the value changes. The last value is cached
 * on the node because the browser normalises what it reads back ("#17d9ff"
 * comes back as "rgb(23, 217, 255)"), so comparing node.style.* never matches.
 */
function setStyle(node, prop, value) {
  if (!node) return;
  const cache = node.__vdmStyle || (node.__vdmStyle = {});
  if (cache[prop] === value) return;
  cache[prop] = value;
  node.style[prop] = value;
}

/** Value of a form control (input / select), written only when it changed. */
function setValue(node, value) {
  if (node && node.value !== value) node.value = value;
}

function eyeButton(visible, showTip, hideTip) {
  const b = h('button', { type: 'button', class: 'tl-objeye' });
  setEye(b, visible, showTip, hideTip);
  return b;
}

function caretButton(open, expandTip, collapseTip) {
  const tip = open ? collapseTip : expandTip;
  return h('button', {
    type: 'button', class: 'tl-objtoggle', 'aria-label': tip, 'aria-expanded': String(open), 'data-tip': tip,
  }, icon(open ? 'chevron-down' : 'chevron-right', 'ic-sm'));
}

/** ◆ toggle (glyph kept on purpose: keyframe symbol, DESIGN.md §5). */
function kfButton() {
  return h('button', { type: 'button', class: 'tl-kf', 'aria-label': '关键帧' }, '◆');
}

/** Paint one ◆ with the row/axis state (at playhead / has keys / empty). */
function paintKf(btn, st, { point = false, noKey = false, axis = null, label = '' } = {}) {
  if (!btn) return;
  const off = noKey;
  btn.disabled = off;
  btn.classList.toggle('off', off);
  btn.classList.toggle('on', !off && !!st.at);
  btn.classList.toggle('has', !off && !st.at && !!st.has);
  btn.classList.toggle('part', !off && !!st.partial);
  setText(btn, st.at ? '◆' : '◇');
  if (off) {
    setTip(btn, '2D 位置暂不逐轴打帧：屏幕运动写在中心点（运动路径 §5 待做）');
    return;
  }
  const what = axis ? `${label} ${axis.toUpperCase()}` : label;
  const where = point ? '轨迹点' : '关键帧';
  setTip(btn, st.at
    ? `${what}：删除当前帧${where}（Shift+点击也可）`
    : st.has
      ? `${what}：在当前时间打${where}（已有 ${(st.times || []).length} 个）`
      : `${what}：在当前时间打${where}`);
}

function clipHandles() {
  return [
    h('div', { class: 'handle handle-l', 'data-tip': '拖动左边界：改开始时间' }),
    h('div', { class: 'handle handle-r', 'data-tip': '拖动右边界：改结束时间' }),
  ];
}

/** Set a clip's pixel width; narrow clips drop their right-side meta. */
function setClipWidth(block, px) {
  const width = `${px}px`;
  if (block.style.width !== width) block.style.width = width;
  block.classList.toggle('narrow', px < CLIP_META_MIN);
}

function elementClipLabel(e) {
  const file = (e.src || '').split('/').pop();
  const label = e.type === 'text' ? String(e.style?.text || '').slice(0, 24)
    : e.type === 'audio' ? (e.name || file)
      : file;
  return label || e.id;
}

function elementClipTip(e, label) {
  const loop = isLooping(e) ? '\n循环播放，长度可超过素材本身' : '';
  if (e.type === 'text') return `${label}\n双击编辑文字内容`;
  if (e.type === 'audio') return `${label}\n拖动改时间；双击展开音量关键帧${loop}`;
  return `${label}${loop}`;
}

/** Looping video / audio may run past the source length (core/ops.js caps the rest). */
const isLooping = (e) => !!e.loop && (e.type === 'video' || e.type === 'audio');

/** Leading repeat icon on a looping clip (DESIGN.md §5: icons, not ↻ text). */
function setClipLoopMark(block, on) {
  const mark = block.querySelector(':scope > .blk-loop');
  if (!on) { mark?.remove(); return; }
  if (mark) return;
  const ic = icon('repeat', 'ic-sm blk-loop');
  block.insertBefore(ic, block.firstChild);
}
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const fmtTick = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { escapeHtml };
