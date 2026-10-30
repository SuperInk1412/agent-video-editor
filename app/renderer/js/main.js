// VedioMaker renderer main: state, playback, selection, wiring.
import { Preview } from './preview.js';
import { objectSize, objectVisibleAt, sceneObjects } from './preview3d.js';
import { PathGizmo } from './pathgizmo.js';
import { Timeline } from './timeline.js';
import { CurvePanel, curvePathLabel } from './curvepanel.js';
import { Inspector } from './inspector.js';
import { AgentPanel } from './ai.js';
import { ReviewPanel } from './review.js';
import { PipelinePanel } from './pipeline.js';
import { LogPanel } from './logs.js';
import { ProjectsPanel } from './projects.js';
import { AssetsPanel, MEDIA_MIME } from './assets.js';
import { Outliner } from './outliner.js';
import { showMenu, hideMenu, initTooltips, icon, prefs } from './ui.js';
import { initLayout, markTab, Timecode, StatusBar, LogDrawer } from './shell.js';
import { frameStep, frameStart, frameWriteTime, lastFrameTime } from './timeline-math.js';
import { initCommands, register as registerCommand, dispatch as dispatchCommand, runCommand, openPalette, openShortcuts } from './commands.js';
import { marksFor } from '/core/timeline-marks.js';
import { pathPos, cameraTransform, cameraRange } from '/core/camera.js';
import { feedPlan, hiddenFeeds, normalizeFeed } from '/core/camfeed.js';
import { curveSegments } from '/core/curves.js';
import { ancestors, childrenOf } from '/core/hierarchy.js';
import {
  elementWorldNodeWithLinks, evalCameraWorldWithLinks, objectLocalPointWithLinks,
  objectLocalVectorWithLinks, objectWorldPoseWithLinks,
} from '/core/link-eval.js';
import { frameOf } from '/core/spatial.js';
import { objectPose } from '/core/scene.js';
import { objectPoseWithLinks, writeBackLocalValue } from '/core/links.js';
import { facingRotation } from '/core/rotation-ops.js';
import { rotationFromDirRoll } from '/core/rotation.js';
import { defaultCamera } from '/core/space.js';
import { newId } from '/core/schema.js';
import { sampleTrack } from '/core/time.js';
import { clearCompiledTracks } from '/core/tracks.js';
import { elementNodeAt } from './node-at.js';
import {
  emptySelection, normalizeSelection, selectOne, pickSelection, legacyFields, cameraRef, objectRef, elementRef, splitRef,
  keyframeExists, keyframeDeleteOps, deletableElementRefs,
} from '/core/selection.js';

const $ = (s) => document.querySelector(s);
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
const S = {
  project: null,
  time: 0,
  playing: false,
  selection: { segmentId: null, elementId: null, objectId: null, camera: false, pool: emptySelection() },
  media: [],
  sourceDurations: new Map(),
  mediaDrag: null,
  blender: null,
  agentAvailable: false,
  pipeline: null,
  render: null,
  renderScale: prefs.get('renderScale', 0.5) === 1 ? 1 : 0.5,
  dpr: Math.min(2, window.devicePixelRatio || 1),
  editMode: false,
  editCam: null,
  followCam: null,
  feedHints: false,
  viewMode: 'select',
  grid: true,
  keys: new Set(),
  soloCameras: new Set(),
  clipboard: null,
  loop: !!prefs.get('loop', false),
  safeArea: !!prefs.get('safeArea', false),
  // Change-set preview (WP2.5a): the shadow project on the stage, and the
  // `\` hold that temporarily points the stage back at the real project.
  previewShadow: null,
  previewHolding: false,
  readOnly: false,
};

let preview, timeline, inspector, agentPanel, review, pipelinePanel, logPanel, gizmo, projects, curvePanel;
// Property-link "转到父级" navigation stack (PLAN-ui-round3 §4.3). Jumping never
// writes the project and never touches Ctrl+Z; Alt+← / the inspector chip walks
// back through the panels the user came from.
const linkNavStack = [];
const LINK_NAV_MAX = 20;
let layout, timecodeUI, statusBar, logDrawer; // shell (shell.js)
let assetsPanel, outliner; // left column (assets.js / outliner.js)

// ---- error reporting: everything lands in .vdm/logs and the 日志 panel ----
const reportedErrors = new Set();
function reportError(where, err) {
  const msg = String(err?.message || err || 'unknown error');
  const stack = err?.stack ? String(err.stack).slice(0, 2000) : '';
  fetch('/api/log', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'error', source: 'renderer', msg: `${where}: ${msg}`, stack, url: location.href }),
  }).catch(() => {});
  if (!reportedErrors.has(msg)) {
    reportedErrors.add(msg);
    toast(`${where}: ${msg.slice(0, 140)}`, 'error');
  }
}
window.addEventListener('error', (e) => reportError('window.onerror', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('unhandledrejection', e.reason));

// ---------------------------------------------------------------- helpers
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `${r.status}`), j);
  return j;
}

// Ops are serialized: two quick edits (e.g. a camera dropdown and a field
// blur) must not race the atomic save. Concurrent POSTs otherwise clone the
// same base project and can lose one edit (or hit a Windows rename EPERM).
let opChain = Promise.resolve();
function op(...ops) {
  // A change-set preview shows a picture nothing is allowed to edit: every
  // write entry point (inspector, timeline, gizmo drag, shortcuts) ends here.
  if (S.previewShadow || S.readOnly) {
    toast('预览中不能编辑，先退出预览', 'warn');
    return Promise.resolve(null);
  }
  const run = async () => {
    try {
      const j = await post('/api/ops', { ops, expectedRev: S.project.rev, requestId: crypto.randomUUID() });
      if (j.project) applyProject(j.project, 'local');
      return j;
    } catch (e) {
      if (e.code === 'REV_CONFLICT') {
        const latest = await fetch('/api/project').then((response) => response.json()).catch(() => null);
        if (latest?.project) applyProject(latest.project, 'resync');
      }
      toast(`操作失败: ${e.message}`, 'error');
      return null;
    }
  };
  const p = opChain.then(run, run);
  opChain = p.catch(() => {});
  return p;
}

let toastTimer = [];
function toast(msg, level = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${level}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  toastTimer.push(setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, level === 'error' ? 5200 : 2600));
  if (toastTimer.length > 8) toastTimer.shift();
}

// ---------------------------------------------------------------- media length
// The timeline needs a synchronous source length while an edge is being
// dragged. New clips record it in meta, old ones are probed once; the preview's
// HTML media duration is a useful fallback while ffprobe is unavailable.
function sourceDurationOf(el) {
  if (!el || (el.type !== 'video' && el.type !== 'audio')) return null;
  const cached = S.sourceDurations.get(el.src);
  if (Number.isFinite(cached) && cached > 0) return cached;
  const live = preview?.sourceDuration?.(el);
  if (Number.isFinite(live) && live > 0) {
    S.sourceDurations.set(el.src, live);
    return live;
  }
  const recorded = Number(el.meta?.sourceDuration);
  if (Number.isFinite(recorded) && recorded > 0) {
    S.sourceDurations.set(el.src, recorded);
    return recorded;
  }
  return null;
}

async function probeSourceDuration(src) {
  if (!src) return null;
  const cached = S.sourceDurations.get(src);
  if (Number.isFinite(cached) && cached > 0) return cached;
  try {
    const res = await fetch(`/api/probe?src=${encodeURIComponent(src)}`);
    if (!res.ok) return null;
    const info = await res.json();
    const duration = Number(info.duration);
    if (Number.isFinite(duration) && duration > 0) {
      S.sourceDurations.set(src, duration);
      return duration;
    }
  } catch { /* ffprobe is optional; the HTML player may still know */ }
  return null;
}

function warmSourceDurations(p) {
  const seen = new Set();
  for (const el of p?.elements || []) {
    if (el.type !== 'video' && el.type !== 'audio') continue;
    if (!el.src || seen.has(el.src)) continue;
    seen.add(el.src);
    if (!S.sourceDurations.has(el.src)) void probeSourceDuration(el.src);
  }
}

// ---------------------------------------------------------------- context menu
// Items: { label, run, danger, disabled, title, sep, icon, kbd, group } — rendered by ui.js.
function hideContextMenu() {
  hideMenu();
}

function showContextMenu(x, y, items) {
  showMenu(x, y, items);
}

window.addEventListener('pointerdown', (e) => {
  const m = $('#ctxMenu');
  if (m && !m.hidden && !m.contains(e.target)) hideContextMenu();
}, true);

let worldTimer = null;
let worldKey = '';
let worldRequest = 0;
function syncWorld(p) {
  if (!p.camera) return;
  const key = JSON.stringify({ world: p.world, cameras: p.cameras, camera: p.camera,
    cameraOrder: p.cameraOrder, fps: p.meta.fps, duration: p.meta.duration,
    // A camera parented to a 3D object flies with that object's tracks, so the
    // corridor clearing changes when the parent animates: refetch then too.
    objects: p.scene?.objects || null });
  if (key === worldKey) return;
  const request = ++worldRequest;
  clearTimeout(worldTimer);
  worldTimer = setTimeout(async () => {
    try {
      const j = await fetch('/api/world').then((r) => r.json());
      if (j.city && request === worldRequest) { worldKey = key; preview.setCity(j.city); }
    } catch (e) { /* logged by the server when it fails */ }
  }, 250);
}

let migrationNoticeAt = '';

function applyProject(p, source) {
  if (source !== 'boot' && S.project && p.rev <= S.project.rev) return;
  // A real revision landed while previewing: the shadow is stale, so drop back
  // to the real project before this one is installed.
  if (S.previewShadow) exitPreview({ render: false });
  const prevDuration = S.project?.meta?.duration;
  // A fresh project (boot) invalidates every panel the back stack could restore.
  if (!S.project || source === 'boot') linkNavStack.length = 0;
  S.project = p;
  const migration = p?.meta?.ui?.migration;
  if (migration?.backupPending && migration.at && migration.at !== migrationNoticeAt) {
    migrationNoticeAt = migration.at;
    toast('旧项目已在内存升级（贴屏→投屏 / 父子 / 片段贴帧）；首次保存会先自动备份到 .vdm/backups/', 'info');
  }
  // JSON responses cannot preserve the server-side `camera` alias identity;
  // re-point it at the active stack entry so edits and reads share one object.
  if (p?.activeCameraId) p.camera = (p.cameras || []).find((c) => c.id === p.activeCameraId) || p.camera;
  syncWorld(p);
  if (S.selection.elementId && !p.elements.find((e) => e.id === S.selection.elementId)) S.selection.elementId = null;
  if (S.selection.segmentId && !p.segments.find((s) => s.id === S.selection.segmentId)) S.selection.segmentId = null;
  if (S.selection.objectId && !(p.scene?.objects || []).some((o) => o.id === S.selection.objectId)) S.selection.objectId = null;
  if (S.selection.pool) {
    const camIds = new Set((p.cameras || []).map((c) => c.id));
    const objIds = new Set((p.scene?.objects || []).map((o) => o.id));
    const elIds = new Set((p.elements || []).map((e) => e.id));
    const keyPool = S.selection.pool.kind === 'keyframe';
    const ids = S.selection.pool.ids.filter((ref) => {
      // keyframes also disappear when the key itself is deleted elsewhere
      if (keyPool) return keyframeExists(p, ref);
      const s = splitRef(ref);
      if (!s) return false;
      if (s.type === 'cam') return camIds.has(s.id);
      if (s.type === 'ob') return objIds.has(s.id);
      return elIds.has(s.id);
    });
    S.selection.pool = normalizeSelection({ ...S.selection.pool, ids });
    // The pool is the source of truth: after pruning, re-derive the legacy
    // fields so the inspector / transport never point at a host that just
    // disappeared (a Ctrl-mixed pool drops refs of any type).
    S.selection = { ...S.selection, ...legacyFields(S.selection.pool) };
  }
  if (gizmo) gizmo.objSel = gizmoObjectId(S.selection.objectId);
  preview.setProject(p);
  warmSourceDurations(p);
  if (S.soloCameras) {
    const ids = new Set((p.cameras || []).map((c) => c.id));
    for (const id of [...S.soloCameras]) if (!ids.has(id)) S.soloCameras.delete(id);
    preview.setSoloCameras(S.soloCameras);
  }
  timeline.setProject(p);
  timeline.setSoloCameras(S.soloCameras || new Set());
  timeline.setSelection(S.selection);
  inspector.render(p, S.selection, S.time);
  curvePanel?.setProject(p);
  outliner?.render(); assetsPanel?.syncProject();
  review?.setProject?.(p);
  updateProjectMeta(p);
  if (!p.camera && S.editMode) setEditMode(false);
  if (S.followCam && !cameraById(S.followCam)) S.followCam = null;
  if (S.editMode) { syncFollowCam(); syncViewControls(); }
  updateOverlay();
  if (prevDuration !== p.meta.duration || S.time > p.meta.duration) setTime(S.time);
}

// ---------------------------------------------------------------- time
/** Project frame rate (meta.fps, 24 before a project is loaded). */
const projectFps = () => S.project?.meta.fps || 24;

/**
 * The picture time of a wall-clock moment: the start of the frame containing
 * `t`, clamped to the project's **last existing frame**.
 *
 * Two clocks (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §五): the wall clock only
 * runs the transport (end of the project / the followed shot, looping, audio);
 * the picture — `S.time`, the playhead, the timecode and `preview.render` —
 * only ever sits on a frame boundary. An export renders `t = frame / fps`
 * (Blender, engine/shot.js), so a mid-frame picture is a state that exists
 * nowhere in the video: miku-swiss f46–f52 drew a lyric at the top right for
 * the last 0.99 frame of a shot that no export ever shows.
 *
 * `duration` is the *end boundary*, not a frame: a 5 s / 60 fps project has 300
 * frames (f0…f299, t = 0…4.9833). Parking the playhead on t = 5.0 put it on a
 * frame the video does not contain — clips are half-open `[start, start+dur)`,
 * so every object was invisible there (the "last frame loses everything" bug).
 */
function pictureTime(t) {
  const dur = S.project?.meta.duration || 12;
  const fps = projectFps();
  const last = lastFrameTime(dur, fps);
  const asked = Math.max(0, Math.min(last, Number(t) || 0));
  return Math.max(0, Math.min(last, frameStart(asked, fps)));
}

/**
 * Time to store for an edit made at the playhead. `S.time` is a frame start
 * (a float such as 0.23333…), and the project keeps times at 3 decimals: a
 * plain round would push 7/30 down to 0.233 (frame 6) and 23/24 to 0.958
 * (frame 22), putting the key / split one frame before the playhead.
 * frameWriteTime rounds the millisecond up, so the value stays inside its
 * frame and agrees with the inspector's ◆ (inspector.js::_keyTime).
 */
function writeTime(t = S.time) {
  return frameWriteTime(t, projectFps(), S.project?.meta.duration || 0);
}

function setTime(t, { seekAudio = true } = {}) {
  const dur = S.project?.meta.duration || 12;
  const asked = Math.max(0, Math.min(dur, Number(t) || 0));
  // A follow only owns the camera's shot. Seeking outside its range ends the
  // follow but keeps the eye on the near boundary frame (not on a stale pose).
  // The test is on the asked-for time: the snapped picture can sit up to one
  // frame before the shot's first frame, and that frame still belongs to it.
  detachFollowForSeek(asked);
  S.time = pictureTime(asked);
  timeline?.setTime(S.time);
  updateTimecode();
  // The status chip carries the out-of-frame ratio, which needs a projection
  // of the selection: refresh it when the user is looking, not every played
  // frame (pause() flushes it).
  if (!S.playing) updateSelectionInfo();
  if (seekAudio && S.playing) preview.setAudioTime(S.time);
  if (!S.playing) inspector.render(S.project, S.selection, S.time);
  if (S.followCam) syncViewControls();
}

function play() {
  if (!S.project) return;
  const follow = S.followCam ? cameraById(S.followCam) : null;
  if (follow) {
    const range = cameraRange(S.project, follow);
    // The end test is frame-precise: playback stops on the frame that contains
    // the clip's end (`pictureTime(range.end)`), so that frame *is* the end —
    // with a raw `< end` test Space after the auto-pause would look dead.
    if (S.time < range.start - 1e-6 || S.time >= pictureTime(range.end) - 1e-9) {
      if (range.end - range.start <= 1e-6) {
        toast('这个镜头没有可播放的时间段', 'warn');
        return;
      }
      // At the auto-pause point Space is the natural "watch it again".
      setTime(range.start);
    }
    // "At the end" is the last frame the transport can sit on: the end marker
    // itself when the duration is on the frame grid, otherwise the frame that
    // contains it (space must not look dead there).
  } else if (S.time >= pictureTime(S.project.meta.duration || 12) - 1e-9) S.time = 0;
  S.playing = true;
  S.playWall = performance.now();
  S.playFrom = S.time;
  preview.playing = true;
  preview.playAudio(S.time);
  setPlayButton(true);
}

function pause() {
  S.playing = false;
  preview.playing = false;
  preview.pauseAudio();
  setPlayButton(false);
  // Playback refreshes the property fields at ~11 Hz (timeline.js setTime
  // `live`); land on the exact value of the frame we stopped on.
  timeline?.flushValues();
  updateSelectionInfo();
}

function togglePlay() { S.playing ? pause() : play(); }

/**
 * ±1 frame on the frame grid (timeline-math.js frameStep), so repeated steps
 * cannot accumulate 1/fps float drift. The transport buttons keep playback
 * going (only the play anchor is reset); the keyboard commands pause first.
 */
function stepFrames(dir, { pauseFirst = false } = {}) {
  if (pauseFirst) pause();
  setTime(frameStep(S.time, dir, S.project?.meta.fps || 24));
  if (S.playing) { S.playFrom = S.time; S.playWall = performance.now(); }
}

// ---------------------------------------------------------------- selection
/**
 * Apply a selection. The pool is the source of truth: when one is present its
 * primary fills in `elementId / objectId / camera`, so a single element pool
 * can hold 2D elements, 3D objects and cameras at once. Explicit ids still win
 * (legacyFields) and the backfill never clears one, so older callers keep
 * working unchanged when they pass no pool.
 */
function select(sel = {}) {
  let pool;
  if (sel.pool) pool = normalizeSelection(sel.pool);
  else if (sel.camera && S.project?.camera) pool = selectOne('element', cameraRef(S.project.camera.id));
  else if (sel.objectId) pool = selectOne('element', objectRef(sel.objectId));
  else if (sel.elementId) pool = selectOne('element', elementRef(sel.elementId));
  else pool = emptySelection();
  const host = legacyFields(pool, {
    elementId: sel.elementId, objectId: sel.objectId, camera: sel.camera,
  });
  let segmentId;
  if (host.camera || host.objectId) segmentId = null;
  else {
    // An explicit `segmentId: null` clears the segment head; a caller that does
    // not mention the key at all keeps the current one (older call sites).
    segmentId = Object.prototype.hasOwnProperty.call(sel, 'segmentId')
      ? (sel.segmentId ?? null)
      : S.selection.segmentId;
    if (host.elementId) {
      const el = S.project?.elements?.find((e) => e.id === host.elementId);
      if (el?.segment) segmentId = el.segment;
    }
  }
  S.selection = { segmentId, ...host, pool };
  // The F2 drawer edits the live pool, not a snapshot: a selection made while
  // it is open retargets the panel in place (design §3).
  if (curvePanel?.isOpen()) curvePanel.setSelection?.(pool);
  if (gizmo) {
    // §10.5: a locked 3D object shows its outline but no draggable gizmo.
    gizmo.objSel = gizmoObjectId(S.selection.objectId);
    gizmo.objHover = null;
    gizmo.axisHover = null;
    gizmo.draw();
  }
  timeline.setSelection(S.selection);
  inspector.render(S.project, S.selection, S.time);
  outliner?.setSelection();
  updateOverlay();
  updateSelectionInfo();
}

/**
 * Snapshot the current panel/selection/timeline layout for the link-jump back
 * stack. Only view state is captured: no project data, no time, no ops.
 */
function snapshotLinkNav() {
  const sel = S.selection || {};
  return {
    selection: {
      segmentId: sel.segmentId ?? null,
      elementId: sel.elementId ?? null,
      objectId: sel.objectId ?? null,
      camera: !!sel.camera,
      pool: sel.pool ? {
        kind: sel.pool.kind,
        ids: [...(sel.pool.ids || [])],
        primary: sel.pool.primary ?? null,
      } : emptySelection(),
    },
    timeline: timeline ? {
      sections: { ...(timeline.sections || {}) },
      expanded: [...(timeline.expanded || [])],
      expandedEls: [...(timeline.expandedEls || [])],
      openCams: [...(timeline.openCams || [])],
      scrollTop: timeline.scroll?.scrollTop || 0,
      scrollLeft: timeline.scroll?.scrollLeft || 0,
    } : null,
  };
}

/** Restore a snapshot taken by snapshotLinkNav (no project write, no undo step). */
function restoreLinkNav(snap) {
  if (!snap) return false;
  select(snap.selection || {});
  const tl = snap.timeline;
  if (timeline && tl) {
    timeline.sections = { ...(tl.sections || {}) };
    timeline.expanded = new Set(tl.expanded || []);
    timeline.expandedEls = new Set(tl.expandedEls || []);
    timeline.openCams = new Set(tl.openCams || []);
    timeline.render(true);
    if (timeline.scroll) {
      timeline.scroll.scrollTop = Number(tl.scrollTop) || 0;
      timeline.scroll.scrollLeft = Number(tl.scrollLeft) || 0;
    }
  }
  return true;
}

const canGoBackLink = () => linkNavStack.length > 0;

/** Alt+← / inspector "← 返回": pop the last "转到父级" panel. */
function goBackLink() {
  const snap = linkNavStack.pop();
  if (!snap) return false;
  const active = document.activeElement;
  if (active && /INPUT|TEXTAREA|SELECT/.test(active.tagName || '')) active.blur();
  inspector?._flush();
  timeline?.flushPending?.();
  restoreLinkNav(snap);
  toast('已返回上一个属性面板');
  return true;
}

/**
 * Property-link "转到父级" (PLAN-ui-round3 §4.3): select the parent host, open
 * its property page and reveal the source row. Selecting a camera here only
 * shows its inspector/rows; it never activates the camera. This path writes
 * nothing to the project, so Ctrl+Z stays the global undo; the local back stack
 * (Alt+← / inspector chip) restores the panel the user came from.
 */
function jumpToLinkParent({ host, id, path } = {}) {
  if (!S.project || (host !== 'el' && host !== 'ob' && host !== 'cam') || id == null) return false;
  // Flush pending typing before the selection changes: an inspector debounce or
  // a timeline property debounce must land on the old host, not the new one.
  const active = document.activeElement;
  if (active && /INPUT|TEXTAREA|SELECT/.test(active.tagName || '')) active.blur();
  inspector?._flush();
  timeline?.flushPending?.();
  const ref = host === 'el' ? elementRef(id) : host === 'ob' ? objectRef(id) : cameraRef(id);
  // A jump that changes the panel is reversible. Same-host property reveals do
  // not push, so repeated clicks cannot grow a no-op stack.
  if (String(S.selection?.pool?.primary || '') !== String(ref)) {
    linkNavStack.push(snapshotLinkNav());
    if (linkNavStack.length > LINK_NAV_MAX) linkNavStack.shift();
  }
  const sel = { pool: selectOne('element', ref) };
  if (host === 'el') sel.elementId = id;
  else if (host === 'ob') sel.objectId = id;
  else sel.camera = true;
  select(sel);
  // Open the host's page (element / object group, camera property rows) and the
  // group that owns the source property, so revealProperty can find its row.
  if (host === 'el') timeline.expandedEls.add(String(id));
  else if (host === 'ob') timeline.expanded.add(String(id));
  else timeline.openCams.add(String(id));
  const source = String(path ?? '');
  if (host === 'cam') {
    if (source.startsWith('shake.')) timeline.sections.camShake = 'full';
    else if (source.startsWith('dof.')) timeline.sections.camDof = 'full';
    else if (source.startsWith('pivot.') || source.startsWith('scale.')
      || source.startsWith('rotation.') || source === 'opacity') timeline.sections.camPos = 'full';
    else timeline.sections.camMain = 'full';
  } else if (host === 'el' || host === 'ob') {
    timeline.sections.transform = 'full';
  }
  timeline.render(true);
  const kind = host === 'el' ? 'element' : host === 'ob' ? 'object' : 'camera';
  timeline.revealProperty({ kind, id: String(id) }, String(path ?? ''));
  return true;
}

// ---------------------------------------------------------------- inline text editor
// Double-click a text element (2D overlay or 3D text object) in the viewport or
// on the timeline. The editor is a transparent textarea placed on the projected
// text quad; the canvas itself keeps rendering the real typography, so typing
// changes the picture live. No panel and no second copy of the glyphs.
let inlineTextEdit = null;
let inlineTextUI = null;
const INLINE_TEXT_HINT = '在画面上直接改字 · Ctrl+Enter 保存 · Esc 取消 · 点空白处保存';

function textTarget(kind, id) {
  const target = kind === 'object'
    ? (S.project?.scene?.objects || []).find((o) => o.id === id)
    : (S.project?.elements || []).find((e) => e.id === id);
  if (!target || target.type !== 'text') return null;
  return { kind, id, target, text: String(target.style?.text ?? '') };
}

/** Homography from a w×h text box to the four projected corners, as CSS matrix3d. */
function homographyCss(points, w, h) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = points;
  const dx1 = x1 - x2, dx2 = x3 - x2;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(den) || Math.abs(den) < 1e-9) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const hh = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + hh * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + hh * y3;
  const f = y0;
  // Column-major matrix3d; destination = (x0..x3) in stage CSS pixels.
  const m = [
    a / w, d / w, 0, g / w,
    b / h, e / h, 0, hh / h,
    0, 0, 1, 0,
    c, f, 0, 1,
  ];
  if (!m.every(Number.isFinite)) return null;
  return `matrix3d(${m.map((v) => Number(v.toFixed(8))).join(',')})`;
}

/**
 * Projected text box for the in-place editor. 2D text comes from the same
 * layer corners as the selection outline; 3D text uses the object's plane
 * size/basis projected through the current camera.
 */
function inlineTextGeometry(kind, id, text) {
  const canvas = preview?.canvas;
  const stage = $('#stageBox');
  if (!canvas || !stage || !S.project) return null;
  const cr = canvas.getBoundingClientRect();
  const br = stage.getBoundingClientRect();
  if (!(cr.width > 0 && cr.height > 0 && canvas.width > 0 && canvas.height > 0)) return null;
  const toStage = (x, y) => [
    cr.left - br.left + x * (cr.width / canvas.width),
    cr.top - br.top + y * (cr.height / canvas.height),
  ];
  const meta = S.project.meta || {};
  const styleOf = (o) => o?.style || {};
  const textLines = Math.max(1, String(text ?? '').split('\n').length);

  if (kind === 'element') {
    const layer = (preview.layers || []).find((L) => L.el?.id === id);
    if (!layer || layer.kind !== 'tex') return null;
    const rect = preview.textContentRect?.(layer) || [0, 0, 1, 1];
    const corners = preview._layerCorners(layer, rect);
    if (!corners || corners.length !== 4) return null;
    const pts = corners.map(([x, y]) => toStage(x, y));
    if (!pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return null;
    const style = styleOf(layer.el);
    const st = layer.st || {};
    const fontPx = Math.max(1, (Number(st.size) || 96) * (canvas.width / (Number(meta.width) || 1920)));
    const lineH = fontPx * Math.max(0.1, Number(style.lineHeight) || 1.18);
    const srcW = Math.max(1, (Number(layer.w) || 1) * (rect[2] - rect[0]));
    const srcH = Math.max(1, (Number(layer.h) || lineH * textLines) * (rect[3] - rect[1]));
    return {
      pts,
      w: srcW,
      h: srcH,
      fontPx,
      lineH,
      pad: 0,
      align: style.align || 'center',
      weight: style.weight || 400,
      family: style.font || 'SimHei',
      letterSpacing: (Number(style.letterSpacing) || 0) * fontPx,
    };
  }

  const s3 = preview.scene3d;
  const obj = (S.project.scene?.objects || []).find((o) => o.id === id);
  if (!obj || obj.type !== 'text' || !s3?.projectPoint) return null;
  const pose = objectWorldPoseWithLinks(S.project, obj, S.time);
  const size = s3._planeSizes?.get(obj.id);
  const asset = s3.media?.get(obj.id);
  if (!pose || !size || !asset?.w || !asset?.h) return null;
  const [sx, sy] = size;
  const p = pose.worldPos, right = pose.basis.right, up = pose.basis.up;
  const hw = sx / 2, hh = sy / 2;
  const worldPts = [
    [p[0] - right[0] * hw + up[0] * hh, p[1] - right[1] * hw + up[1] * hh, p[2] - right[2] * hw + up[2] * hh],
    [p[0] + right[0] * hw + up[0] * hh, p[1] + right[1] * hw + up[1] * hh, p[2] + right[2] * hw + up[2] * hh],
    [p[0] + right[0] * hw - up[0] * hh, p[1] + right[1] * hw - up[1] * hh, p[2] + right[2] * hw - up[2] * hh],
    [p[0] - right[0] * hw - up[0] * hh, p[1] - right[1] * hw - up[1] * hh, p[2] - right[2] * hw - up[2] * hh],
  ];
  const projected = worldPts.map((wp) => s3.projectPoint(wp));
  if (projected.some((q) => !q || !Number.isFinite(q.x) || !Number.isFinite(q.y))) return null;
  const pts = projected.map((q) => toStage(
    q.x * canvas.width / Math.max(1, s3.lastW),
    q.y * canvas.height / Math.max(1, s3.lastH),
  ));
  const style = styleOf(obj);
  const fontPx = 128; // preview3d's text raster is one em = 128 px
  return {
    pts,
    w: asset.w,
    h: asset.h,
    fontPx,
    lineH: fontPx * Math.max(0.1, Number(style.lineHeight) || 1.2),
    pad: 0,
    align: style.align || 'center',
    weight: 400,
    family: preview.scene3d._fontFamily?.(style.font) || style.font || 'SimHei',
    letterSpacing: (Number(style.tracking) || 0) * fontPx,
  };
}

function applyInlineTextGeometry(geom) {
  const ui = inlineTextUI;
  if (!ui || !geom) return false;
  const m = homographyCss(geom.pts, geom.w, geom.h);
  if (!m) return false;
  const a = ui.area;
  a.style.width = `${geom.w}px`;
  a.style.height = `${geom.h}px`;
  a.style.padding = `${geom.pad}px`;
  a.style.fontSize = `${geom.fontPx}px`;
  a.style.lineHeight = `${geom.lineH}px`;
  a.style.fontFamily = geom.family;
  a.style.fontWeight = String(geom.weight);
  a.style.letterSpacing = `${geom.letterSpacing}px`;
  a.style.textAlign = geom.align === 'left' ? 'left' : geom.align === 'right' ? 'right' : 'center';
  a.style.transform = m;
  a.scrollTop = 0;
  a.scrollLeft = 0;
  ui.layer.hidden = false;
  return true;
}

function refreshInlineTextGeometry() {
  if (!inlineTextEdit) return false;
  const geom = inlineTextGeometry(inlineTextEdit.kind, inlineTextEdit.id, inlineTextUI?.area.value ?? '');
  return geom ? applyInlineTextGeometry(geom) : false;
}

function ensureInlineTextUI() {
  if (inlineTextUI) return inlineTextUI;
  const layer = $('#inlineTextLayer');
  const area = $('#inlineTextArea');
  const hint = $('#stageHint');
  if (!layer || !area) return null;
  if (hint && !hint.dataset.normal) hint.dataset.normal = hint.textContent;
  area.addEventListener('input', () => {
    if (!inlineTextEdit) return;
    const target = textTarget(inlineTextEdit.kind, inlineTextEdit.id)?.target;
    if (!target) return;
    target.style = { ...(target.style || {}), text: area.value };
    preview?.render(S.time);
    refreshInlineTextGeometry();
  });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeInlineText(false);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      closeInlineText(true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      closeInlineText(true);
    }
  });
  area.addEventListener('blur', () => {
    // Clicking outside is handled on pointerdown (earlier); this also covers
    // Tab / window focus changes without leaving an invisible editor behind.
    const state = inlineTextEdit;
    setTimeout(() => {
      if (inlineTextEdit && inlineTextEdit === state) closeInlineText(true);
    }, 0);
  });
  document.addEventListener('pointerdown', (e) => {
    if (inlineTextEdit && !layer.contains(e.target)) closeInlineText(true);
  }, true);
  window.addEventListener('resize', () => {
    if (inlineTextEdit) refreshInlineTextGeometry();
  });
  inlineTextUI = { layer, area, hint };
  return inlineTextUI;
}

function closeInlineText(save) {
  const state = inlineTextEdit;
  if (!state) return;
  const ui = inlineTextUI;
  const value = ui?.area.value ?? state.original;
  inlineTextEdit = null;
  if (ui) {
    ui.layer.hidden = true;
    ui.area.value = '';
    if (ui.hint) ui.hint.textContent = ui.hint.dataset.normal || '';
    ui.area.blur();
  }
  const target = textTarget(state.kind, state.id)?.target || state.target;
  if (!target) return;
  if (!save) {
    target.style = { ...(target.style || {}), text: state.original };
    preview?.render(S.time);
    return;
  }
  target.style = { ...(target.style || {}), text: value };
  if (value === state.original) {
    preview?.render(S.time);
    return;
  }
  op(state.kind === 'object'
    ? { op: 'objectPatch', id: state.id, patch: { style: { text: value } } }
    : { op: 'updateElement', id: state.id, patch: { style: { text: value } } });
}

/** Enter in-place editing for a 2D text element or 3D text object. */
function openTextEditor(kind, id, ev = null) {
  const found = textTarget(kind, id);
  if (!found) return false;
  if (inlineTextEdit) closeInlineText(true);
  const ui = ensureInlineTextUI();
  if (!ui) return false;
  pause();
  const start = Number(found.target.start) || 0;
  const end = start + Math.max(0, Number(found.target.duration) || 0);
  if (S.time < start - 1e-6 || S.time >= end - 1e-6) {
    setTime(Math.min(Math.max(0, start + 0.001), Math.max(0, end - 0.001)));
  }
  select(kind === 'object' ? { objectId: id } : { elementId: id });
  preview?.render(S.time);
  const geom = inlineTextGeometry(kind, id, found.text);
  if (!geom) {
    toast('当前画面看不到这个文字，先把播放头或镜头移到它可见的位置', 'warn');
    return false;
  }
  inlineTextEdit = { kind, id, target: found.target, original: found.text };
  ui.area.value = found.text;
  if (!applyInlineTextGeometry(geom)) {
    inlineTextEdit = null;
    return false;
  }
  if (ui.hint) ui.hint.textContent = INLINE_TEXT_HINT;
  ui.area.focus({ preventScroll: true });
  const caret = ui.area.value.length;
  ui.area.setSelectionRange(caret, caret);
  return true;
}


// ---------------------------------------------------------------- value curve

/** Every keyed property of a host that has at least two keys, as panel tracks. */
function curveTracksFor(host, id) {
  const tracks = [];
  if (host === 'element') {
    const el = S.project.elements.find((e) => e.id === id);
    if (!el) return tracks;
    const byPath = new Map();
    for (const k of el.keyframes || []) {
      if (!byPath.has(k.path)) byPath.set(k.path, []);
      byPath.get(k.path).push(k);
    }
    for (const [path, keys] of byPath) {
      const segments = curveSegments(keys);
      if (segments.length) tracks.push({ path, label: curvePathLabel(path), segments });
    }
  } else {
    const obj = host === 'object'
      ? (S.project.scene?.objects || []).find((o) => o.id === id)
      : (S.project.cameras || []).find((c) => c.id === id);
    if (!obj) return tracks;
    if (host === 'camera' && Array.isArray(obj.path) && obj.path.length >= 2) {
      tracks.push({
        path: 'path',
        label: curvePathLabel('path'),
        segments: curveSegments(obj.path),
      });
    }
    for (const [path, keys] of Object.entries(obj.tracks || {})) {
      if (host === 'camera' && path === 'path') continue;
      const segments = curveSegments(keys);
      if (segments.length) tracks.push({ path, label: curvePathLabel(path), segments });
    }
  }
  return tracks.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Open the F2 curve drawer.
 * A keyframe pool decides what the panel is about: the host that owns most of
 * the pool, and inside it every selected key (across property tracks). The
 * drawer opens on the track with the most selected keys and lists the others
 * in its property picker, so a selection is never silently retargeted.
 * Without a pool it falls back to the selected element/object/camera.
 */
function openCurvePanel() {
  if (!curvePanel || !S.project) return;
  const pool = S.selection.pool;
  let host = null;
  let id = null;
  let wantedPath = null;
  let selected = null;

  if (pool?.kind === 'keyframe' && pool.ids.length) {
    const parts = pool.ids
      .map((ref) => splitRef(ref))
      .filter((p) => p && p.path && p.t != null && Number.isFinite(Number(p.t)));
    if (parts.length) {
      // One drawer edits one host: keep the host that owns most of the pool.
      const byHost = new Map();
      for (const p of parts) {
        const key = `${p.type}:${p.id}`;
        if (!byHost.has(key)) byHost.set(key, []);
        byHost.get(key).push(p);
      }
      let best = null;
      for (const list of byHost.values()) if (!best || list.length > best.length) best = list;
      const first = best[0];
      host = first.type === 'cam' ? 'camera' : first.type === 'ob' ? 'object' : 'element';
      id = first.id;
      const seen = new Set();
      selected = [];
      for (const p of best) {
        const t = Math.round(Number(p.t) * 1000) / 1000;
        const key = `${p.path}:${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push({ path: p.path, t });
      }
      const counts = new Map();
      for (const s of selected) counts.set(s.path, (counts.get(s.path) || 0) + 1);
      wantedPath = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  }
  if (!host) {
    // fall back to the current selection so F2 is never a silent no-op
    if (S.selection.camera && S.project.camera) { host = 'camera'; id = S.project.camera.id; }
    else if (S.selection.objectId) { host = 'object'; id = S.selection.objectId; }
    else if (S.selection.elementId) { host = 'element'; id = S.selection.elementId; }
  }
  if (!host || !id) {
    toast('先选中一个元素/物体/相机，或选中关键帧', 'warn');
    return;
  }
  const tracks = curveTracksFor(host, id);
  if (!tracks.length) {
    toast('这个对象还没有两个以上关键帧可以连成曲线', 'warn');
    return;
  }
  let index = tracks.findIndex((t) => t.path === wantedPath);
  // The busiest selected track may have no segment (a single key); prefer the
  // other selected tracks over opening an unrelated one.
  if (index < 0 && selected?.length) {
    const paths = new Set(selected.map((s) => s.path));
    index = tracks.findIndex((t) => paths.has(t.path));
  }
  if (index < 0 && host === 'camera') index = tracks.findIndex((t) => t.path === 'path');
  if (index < 0) index = 0;
  // Design §6: opening the drawer stops playback and brings the edit range into
  // view — the row, then the selected seconds, without touching the zoom.
  if (S.playing) pause();
  timeline.reveal({ kind: host, id });
  if (selected?.length) revealTimeRange(selected.map((s) => s.t));
  curvePanel.open({ host, id, tracks, index, selected });
}

/**
 * Scroll the timeline so `times` are visible, centring them when they fit.
 * Zoom is untouched: only `scrollLeft` moves (design §6, F2 open).
 */
function revealTimeRange(times) {
  const list = (times || []).map(Number).filter(Number.isFinite);
  if (!timeline || !list.length) return;
  const pps = Number(timeline.pps) || 60;
  const view = timeline.scroll.clientWidth - (timeline._gutter?.() || 340) - 24;
  if (!(view > 80)) return;
  const x0 = Math.min(...list) * pps;
  const x1 = Math.max(...list) * pps;
  const left = timeline.scroll.scrollLeft;
  if (x0 >= left && x1 <= left + view) return;
  const room = view - (x1 - x0);
  timeline.scroll.scrollLeft = Math.max(0, room > 0 ? x0 - room / 2 : x0 - 40);
}

function toggleCurvePanel() {
  if (!curvePanel) return;
  if (curvePanel.isOpen()) curvePanel.close();
  else openCurvePanel();
}

const additiveEvent = (e) => !!(e?.ctrlKey || e?.metaKey || e?.shiftKey);

/** Normalized client rect from two points. */
function clientRect(a, b) {
  return {
    left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
    top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
  };
}

const pointInRect = (p, r) => p[0] >= r.left && p[0] <= r.right && p[1] >= r.top && p[1] <= r.bottom;

/** Proper segment intersection (rect edges vs a projected quad edge). */
function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
  const on = (p, q, r) => Math.abs(cross(p, q, r)) < 1e-9
    && r[0] >= Math.min(p[0], q[0]) && r[0] <= Math.max(p[0], q[0])
    && r[1] >= Math.min(p[1], q[1]) && r[1] <= Math.max(p[1], q[1]);
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a[1] > p[1]) !== (b[1] > p[1]))
      && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] + 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}

/** Marquee hit: any vertex inside, any rect corner inside the quad, or an edge crossing. */
function polyRectHit(points, rect) {
  if (!Array.isArray(points) || points.length < 3) return false;
  if (points.some((p) => pointInRect(p, rect))) return true;
  const corners = [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]];
  if (corners.some((p) => pointInPoly(p, points))) return true;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let k = 0; k < 4; k += 1) if (segmentsCross(a, b, corners[k], corners[(k + 1) % 4])) return true;
  }
  return false;
}

/** Canvas-space bounding box of a 3D object's current world box. */
function objectScreenRect(obj) {
  const s3 = preview?.scene3d;
  if (!s3?.lastVP || !s3.lastW || !s3.lastH) return null;
  const pose = objectWorldPoseWithLinks(S.project, obj, S.time);
  const size = objectSize(obj, pose);
  const basis = pose.basis;
  const half = size.map((v) => v / 2);
  const pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const w = [
      pose.worldPos[0] + basis.right[0] * half[0] * sx + basis.up[0] * half[1] * sy + basis.forward[0] * half[2] * sz,
      pose.worldPos[1] + basis.right[1] * half[0] * sx + basis.up[1] * half[1] * sy + basis.forward[1] * half[2] * sz,
      pose.worldPos[2] + basis.right[2] * half[0] * sx + basis.up[2] * half[1] * sy + basis.forward[2] * half[2] * sz,
    ];
    const p = s3.projectPoint(w);
    if (!p) continue;
    pts.push([p.x * preview.canvas.width / s3.lastW, p.y * preview.canvas.height / s3.lastH]);
  }
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/**
 * Every unlocked 2D element / 3D object intersecting the canvas-space rect,
 * plus how many locked hosts were skipped (§10.5: a marquee never catches a
 * locked host; the count is what the status toast reports).
 */
function viewportHitRefs(rect) {
  const refs = [];
  let locked = 0;
  for (const poly of preview.layerPolygons(true)) {
    if (!polyRectHit(poly.points, rect)) continue;
    if (hostLocked('element', poly.id)) { locked += 1; continue; }
    refs.push(elementRef(poly.id));
  }
  if (preview.scene3d?.lastVP) {
    for (const obj of sceneObjects(S.project)) {
      if (!objectVisibleAt(obj, S.time)) continue;
      const r = objectScreenRect(obj);
      if (r && r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom) {
        if (obj.locked === true) locked += 1;
        else refs.push(objectRef(obj.id));
      }
    }
  }
  return { refs: [...new Set(refs)], locked };
}

/** Element refs currently in the selection (legacy single fields when no pool). */
function selectedHostRefs() {
  const pool = S.selection.pool;
  if (pool?.kind === 'element') return [...pool.ids];
  const out = [];
  if (S.selection.elementId) out.push(elementRef(S.selection.elementId));
  if (S.selection.objectId) out.push(objectRef(S.selection.objectId));
  return out;
}

/**
 * Drop the whole selection: the pool (2D elements / 3D objects / cameras /
 * properties / keyframes), the legacy element / object / camera fields, the
 * segment head and — through `select` — the timeline's property row. One entry
 * point so every "click empty space" path clears exactly the same things.
 */
function clearSelection() {
  select({ pool: emptySelection(), elementId: null, objectId: null, camera: false, segmentId: null });
}

// ---------------------------------------------------------------- locks (WP2.5b)
// docs/DESIGN-WP2.5-REVIEW.md §10.5: locked = not pickable / not draggable in
// the viewport, and an agent's write is refused (`LOCKED`); a human can still
// select it from the timeline / outliner and edit it in the inspector.
/** Is one host locked? `kind` is 'element' | 'camera' | 'object'. */
function hostLocked(kind, id) {
  if (!id) return false;
  const host = kind === 'camera' ? cameraById(id)
    : kind === 'object' ? (S.project?.scene?.objects || []).find((o) => o.id === id)
      : S.project?.elements?.find((e) => e.id === id);
  return host?.locked === true;
}

/** The 3D object whose move gizmo may be drawn: never a locked one (§10.5). */
function gizmoObjectId(id) {
  return id && !hostLocked('object', id) ? id : null;
}

/** Topmost unlocked 2D element under the cursor (a locked one is transparent). */
function unlockedElementAt(sx, sy) {
  return preview.hitTestAll(sx, sy, S.time).find((id) => !hostLocked('element', id)) || null;
}

/** The host a lock menu item / palette command acts on (selection primary). */
function lockTarget() {
  const pool = S.selection.pool;
  const ref = pool?.kind === 'element' ? pool.primary : null;
  if (ref) {
    const r = splitRef(ref);
    if (r) return { kind: r.type === 'cam' ? 'camera' : r.type === 'ob' ? 'object' : 'element', id: r.id };
  }
  if (S.selection.elementId) return { kind: 'element', id: S.selection.elementId };
  if (S.selection.objectId) return { kind: 'object', id: S.selection.objectId };
  const camId = S.selection.camera ? selectedCameraId() : null;
  return camId ? { kind: 'camera', id: camId } : null;
}

/** Lock / unlock one host. One op = one Ctrl+Z, whichever way it flips. */
function toggleLock(kind, id) {
  const locked = !hostLocked(kind, id);
  const patch = { locked };
  const single = kind === 'camera' ? { op: 'cameraPatch', id, patch }
    : kind === 'object' ? { op: 'objectPatch', id, patch }
      : { op: 'updateElement', id, patch };
  toast(locked
    ? '已锁定：视口里不能点选拖动，AI 不能修改'
    : '已解锁：视口里可以点选拖动，AI 可以修改', 'info');
  return op(single);
}

/** 锁定 / 解锁 menu item; the palette command carries the same title. */
function lockMenuItem(kind, id) {
  const locked = hostLocked(kind, id);
  return {
    label: '锁定 / 解锁',
    icon: locked ? 'lock-open' : 'lock',
    title: locked ? '已锁定：视口里不能点选拖动，AI 不能修改' : '锁定后 agent 不能改这个元素',
    run: () => { toggleLock(kind, id); },
  };
}

// ---------------------------------------------------------------- change-set marks (WP2.5b)
// docs/DESIGN-WP2.5-REVIEW.md §10.3: main.js owns the read, core/timeline-marks.js
// the classification, the timeline only paints. Refetched after every `project`
// / `changeset` event (debounced), because an accepted mark must disappear once
// the user edits the value it recorded.
let marksTimer = 0;
let marksRequest = 0;
/**
 * Read the last 50 change sets and hand the marks to the timeline. A failed
 * read (an engine without the WP2.5a route, a reconnecting SSE) leaves the
 * current marks alone instead of wiping them. Returns the marks for probes.
 */
function refreshMarks({ immediate = false } = {}) {
  clearTimeout(marksTimer);
  const run = async () => {
    const request = ++marksRequest;
    let payload = null;
    try {
      // detail=1: the marks need changed[] (which property, before, after),
      // not the counts a summary carries.
      const res = await fetch('/api/changesets?limit=50&detail=1');
      if (res.ok) payload = await res.json();
    } catch { /* engine without the route: keep what is painted */ }
    if (request !== marksRequest) return null;
    if (!payload) return null;
    const records = Array.isArray(payload.changesets) ? payload.changesets : [];
    const marks = marksFor(records, S.project, { fps: S.project?.meta?.fps || 24 });
    timeline?.setMarks?.(marks);
    return marks;
  };
  if (immediate) return run();
  marksTimer = setTimeout(run, 200);
  return null;
}

/**
 * One viewport pick (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §二): the topmost
 * unlocked 2D element / 3D object under the cursor, or — on empty canvas —
 * nothing at all. A locked host is passed through (WP2.5b §10.5); when
 * everything under the cursor is locked nothing gets selected.
 * Ctrl/Cmd/Shift keeps whatever is selected; a plain click clears everything
 * (`clearSelection`). There is deliberately no implicit fallback to "the
 * segment under the playhead" or "the camera": a camera is picked by clicking
 * the camera gizmo or its timeline row, a segment by clicking its bar.
 *
 * Module scope on purpose: `beginViewportMarquee` (the press-release path) and
 * the two pointerdown / pointerup branches share this picking code, and the
 * marquee used to call a `const selectAt` that only existed inside `boot()` —
 * a ReferenceError, so a click on empty canvas did nothing at all.
 */
function selectAt(sx, sy, ev) {
  const additive = additiveEvent(ev);
  // §10.5: a locked host is transparent to a viewport click — take the first
  // unlocked layer below it, then a 3D object. When everything under the
  // cursor is locked nothing gets selected (the lock is lifted in the timeline).
  const stack = preview.hitTestAll(sx, sy, S.time);
  const id = stack.find((candidate) => !hostLocked('element', candidate)) || null;
  const pick = id ? null : preview.scene3d?.pickObject(S.project, S.time, sx, sy);
  const obj = pick && !hostLocked('object', pick.id) ? pick : null;
  if (id || obj) {
    const kind = id ? 'el' : 'ob';
    const host = id || obj.id;
    if (additive) {
      // One element pool for 2D / 3D / cameras; picking a selected ref again
      // removes it (pickSelection toggles inside the same pool).
      const ref = kind === 'el' ? elementRef(host) : objectRef(host);
      select({ pool: pickSelection(S.selection.pool, 'element', ref, true) });
    } else if (kind === 'el') select({ elementId: host });
    else select({ objectId: host });
    return;
  }
  if (additive) return; // Ctrl-click on empty space keeps the current selection
  if (stack.length || pick) {
    toast('这里的元素都锁定了：在时间线或大纲里选中后可以解锁', 'info');
  }
  clearSelection();
}

/**
 * Rubber-band selection over the stage. Only starts from empty canvas: a press
 * on an element/handle keeps its move gesture. Plain drag replaces the pool,
 * Ctrl/Cmd/Shift adds the box contents; a press without movement goes through
 * `selectAt`, i.e. a plain click on empty canvas clears the selection.
 */
function beginViewportMarquee(ev, additive = additiveEvent(ev)) {
  const stage = $('#stage');
  const stageBox = $('#stageBox');
  const canvas = preview.canvas;
  if (!stage || !stageBox || !canvas) return;
  const start = { x: ev.clientX, y: ev.clientY };
  let last = { ...start };
  let moved = false;
  const box = document.createElement('div');
  box.className = 'stage-marquee';
  stageBox.appendChild(box);
  const place = () => {
    const r = stageBox.getBoundingClientRect();
    const band = clientRect(start, last);
    box.style.left = `${band.left - r.left}px`;
    box.style.top = `${band.top - r.top}px`;
    box.style.width = `${Math.max(0, band.right - band.left)}px`;
    box.style.height = `${Math.max(0, band.bottom - band.top)}px`;
  };
  const canvasRect = () => {
    const r = canvas.getBoundingClientRect();
    const kx = canvas.width / Math.max(1, r.width);
    const ky = canvas.height / Math.max(1, r.height);
    const band = clientRect(start, last);
    return {
      left: (band.left - r.left) * kx, right: (band.right - r.left) * kx,
      top: (band.top - r.top) * ky, bottom: (band.bottom - r.top) * ky,
    };
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onKey, true);
    box.remove();
  };
  const move = (e) => {
    last = { x: e.clientX, y: e.clientY };
    if (!moved && Math.hypot(last.x - start.x, last.y - start.y) > 3) moved = true;
    if (moved) place();
  };
  const up = (e) => {
    if (e) last = { x: e.clientX, y: e.clientY };
    const dragged = moved;
    cleanup();
    if (!dragged) {
      selectAt((start.x - canvas.getBoundingClientRect().left) * canvas.width / Math.max(1, canvas.getBoundingClientRect().width),
        (start.y - canvas.getBoundingClientRect().top) * canvas.height / Math.max(1, canvas.getBoundingClientRect().height), ev);
      return;
    }
    const { refs: hits, locked } = viewportHitRefs(canvasRect());
    // §10.5: the box never catches a locked host; say how many it passed over.
    if (locked) toast(`已跳过 ${locked} 个锁定元素`, 'info');
    const prev = additive && S.selection.pool?.kind === 'element' ? S.selection.pool.ids : [];
    if (!additive) {
      select({ pool: hits.length ? normalizeSelection({ kind: 'element', ids: hits, primary: hits[0] }) : emptySelection() });
      return;
    }
    if (!hits.length) return;
    const ids = [...new Set([...prev, ...hits])];
    const existing = new Set(prev);
    const primary = hits.find((ref) => !existing.has(ref)) || S.selection.pool?.primary || ids[0];
    select({ pool: normalizeSelection({ kind: 'element', ids, primary }) });
  };
  const cancel = () => cleanup();
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', onKey, true);
}

function updateOverlay() {
  const box = $('#selBox');
  const poly = $('#selPoly');
  const label = $('#selLabel');
  if (!box || !poly || !label || !preview || !S.project) {
    const fh = document.getElementById('feedHints');
    if (fh) fh.toggleAttribute('hidden', true);
    return;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  let extra = document.getElementById('selExtra');
  if (!extra) {
    extra = document.createElementNS(SVG, 'g');
    extra.id = 'selExtra';
    box.appendChild(extra);
  }
  extra.replaceChildren();
  const W = preview.canvas.width, H = preview.canvas.height;
  box.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const refs = selectedHostRefs();
  const polys = new Map(preview.layerPolygons(true).map((p) => [p.id, p.points]));
  const objects = new Map(sceneObjects(S.project).map((o) => [o.id, o]));
  const primaryEl = S.selection.elementId;
  const primaryObj = S.selection.objectId;
  let drawn = 0;

  const showPointPoly = (points) => {
    if (!points?.length) return;
    poly.setAttribute('points', points.map((p) => `${p[0]},${p[1]}`).join(' '));
    poly.setAttribute('visibility', 'visible');
    const scale = $('#stage').clientWidth / Math.max(1, W);
    const top = points.reduce((a, b) => (b[1] < a[1] ? b : a), points[0]);
    const el = S.project.elements.find((e) => e.id === primaryEl);
    label.textContent = el?.name || primaryEl;
    label.style.display = 'block';
    label.style.left = `${Math.max(2, top[0] * scale)}px`;
    label.style.top = `${Math.max(14, top[1] * scale)}px`;
    drawn += 1;
  };
  const inCanvas = (points) => {
    if (!points?.length) return false;
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    return Math.max(...xs) > 0 && Math.min(...xs) < W && Math.max(...ys) > 0 && Math.min(...ys) < H;
  };
  if (primaryEl && polys.has(primaryEl) && inCanvas(polys.get(primaryEl))) showPointPoly(polys.get(primaryEl));
  else {
    poly.setAttribute('points', '');
    poly.setAttribute('visibility', 'hidden');
    label.style.display = 'none';
  }

  // Every other selected 2D element / 3D object gets the same outline; the
  // primary one is already #selPoly (or gets a slightly stronger rect below).
  for (const ref of refs) {
    const s = splitRef(ref);
    if (!s) continue;
    if (s.type === 'el') {
      if (s.id === primaryEl) continue;
      const points = polys.get(s.id);
      if (!points || !inCanvas(points)) continue;
      const p = document.createElementNS(SVG, 'polygon');
      p.setAttribute('points', points.map((q) => `${q[0]},${q[1]}`).join(' '));
      p.setAttribute('class', 'sel-extra');
      extra.appendChild(p);
      drawn += 1;
    } else if (s.type === 'ob') {
      const obj = objects.get(s.id);
      const r = obj ? objectScreenRect(obj) : null;
      if (!r || r.right <= 0 || r.left >= W || r.bottom <= 0 || r.top >= H) continue;
      const rect = document.createElementNS(SVG, 'rect');
      rect.setAttribute('x', String(r.left));
      rect.setAttribute('y', String(r.top));
      rect.setAttribute('width', String(Math.max(1, r.right - r.left)));
      rect.setAttribute('height', String(Math.max(1, r.bottom - r.top)));
      rect.setAttribute('class', s.id === primaryObj ? 'sel-extra primary' : 'sel-extra');
      extra.appendChild(rect);
      drawn += 1;
    }
  }
  box.style.display = drawn ? 'block' : 'none';
  if (!drawn) label.style.display = 'none';
  updateFeedHints();
}

/** F3 overlay: outline every camfeed plane in the current view and name its source. */
function updateFeedHints() {
  const svg = document.getElementById('feedHints');
  if (!svg) return;
  if (!S.feedHints || !S.project || !preview?.layers?.length) {
    svg.toggleAttribute('hidden', true);
    svg.replaceChildren();
    return;
  }
  const W = preview.canvas.width;
  const H = preview.canvas.height;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const polys = new Map(preview.layerPolygons(true).map((p) => [p.id, p.points]));
  const cams = new Map((S.project.cameras || []).map((c) => [c.id, c]));
  const viewer = preview.editMode ? null : (S.project.activeCameraId || S.project.camera?.id || null);
  const hidden = viewer ? hiddenFeeds(feedPlan(S.project), viewer) : new Set();
  const stage = $('#stage');
  const cssScale = stage?.clientWidth ? stage.clientWidth / Math.max(1, W) : 1;
  const font = Math.min(30, Math.max(10, 12 / Math.max(0.05, cssScale)));
  const frag = document.createDocumentFragment();
  for (const el of S.project.elements || []) {
    if (el.type !== 'camfeed' || el.visible === false || hidden.has(el.id)) continue;
    const points = polys.get(el.id);
    if (!points?.length) continue;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    if (Math.max(...xs) <= 0 || Math.min(...xs) >= W || Math.max(...ys) <= 0 || Math.min(...ys) >= H) continue;
    const feed = normalizeFeed(el.feed);
    const delay = feed.delay === 1;
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    shape.setAttribute('points', points.map((p) => `${p[0]},${p[1]}`).join(' '));
    shape.setAttribute('class', `feed-hint-poly${delay ? ' delay' : ''}`);
    frag.appendChild(shape);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', String(Math.max(4, Math.min(...xs))));
    text.setAttribute('y', String(Math.max(font, Math.min(...ys) - 6)));
    text.setAttribute('font-size', String(font));
    text.setAttribute('class', `feed-hint-label${delay ? ' delay' : ''}`);
    const cam = cams.get(feed.camera);
    text.textContent = `投屏 · ${cam?.name || feed.camera || '未指定来源'}${delay ? ' · 上一帧' : ''}`;
    frag.appendChild(text);
  }
  svg.replaceChildren(frag);
  svg.toggleAttribute('hidden', !svg.childNodes.length);
}

const SEL_TYPE = {
  text: ['文字', 'text'], image: ['图片', 'image'], video: ['视频', 'video'], shape: ['色块', 'shape'],
  solid: ['色块', 'solid'], audio: ['声音', 'audio'],
};
const OBJ_TYPE = { solid: '3D 物体', empty: '空元素', image: '3D 图片', video: '3D 视频', text: '3D 文字' };

/** Transport selection summary: type badge + name; 3D objects keep path / world position in the tip. */
/**
 * Share of a 3D object's projected bounding box that falls outside the picture
 * at `t`, measured through the **shot** camera (the picture, not the editor
 * view). 0 = fully inside, 1 = nothing of it on screen. Used for the status-bar
 * hint: the safe-area overlay shows the frame, but nothing said the subject had
 * slid out of it.
 */
function objectOutOfFrame(project, obj, t) {
  const corners = gizmo?.objectCorners?.(obj, t);
  const cam = evalCameraWorldWithLinks(project, t);
  if (!corners?.length || !cam) return 0;
  const f = v3norm(v3sub(cam.look, cam.pos));
  let right = v3norm([-f[2], 0, f[0]]);
  let up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
  const roll = ((Number(cam.roll) || 0) * Math.PI) / 180;
  if (roll) {
    const c = Math.cos(roll), s = Math.sin(roll);
    const r2 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
    const u2 = [up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s];
    right = r2;
    up = u2;
  }
  const aspect = (Number(project.meta?.width) || 1920) / Math.max(1, Number(project.meta?.height) || 1080);
  const th = Math.tan((Math.min(179, Math.max(1, Number(cam.fov) || 62)) * Math.PI) / 360);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of corners) {
    const v = v3sub(p, cam.pos);
    const z = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    if (z <= 1e-3) return 1; // straddles the lens: treat as out
    const nx = (v[0] * right[0] + v[1] * right[1] + v[2] * right[2]) / (z * th * aspect);
    const ny = (v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / (z * th);
    const sx = 0.5 + nx / 2;
    const sy = 0.5 - ny / 2;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const w = maxX - minX, h = maxY - minY;
  if (!(w > 1e-6) || !(h > 1e-6)) return 0;
  const insideW = Math.max(0, Math.min(1, maxX) - Math.max(0, minX));
  const insideH = Math.max(0, Math.min(1, maxY) - Math.max(0, minY));
  return Math.max(0, Math.min(1, 1 - (insideW * insideH) / (w * h)));
}

function updateSelectionInfo() {
  const node = $('#selInfo');
  if (!node) return;
  const badge = $('#selType');
  const name = $('#selName');
  const show = (label, cls, text, tip = '') => {
    node.hidden = false;
    if (badge.textContent !== label) badge.textContent = label;
    badge.className = `badge ${cls}`;
    if (name.textContent !== text) name.textContent = text;
    if (tip) node.dataset.tip = tip; else delete node.dataset.tip;
  };
  const p = S.project;
  const sel = S.selection;
  const obj = (p?.scene?.objects || []).find((o) => o.id === sel.objectId);
  if (obj) {
    const chain = ancestors(p, obj.id).reverse().map((o) => o.name || o.id);
    const path = [...chain, obj.name || obj.id].join(' › ');
    const pose = objectWorldPoseWithLinks(p, obj, S.time);
    const world = pose.worldPos.map((v) => (Math.round(Number(v) * 100) / 100).toFixed(2)).join(', ');
    const kids = childrenOf(p, obj.id).length;
    const note = obj.parent?.id ? '\n手柄和轨迹按世界位置显示；时间轴属性仍是本地值' : '';
    // Subject slid out of the picture: the safe frame shows the boundary, but
    // nothing told the user the thing they are editing is mostly off screen.
    const out = objectOutOfFrame(p, obj, S.time);
    const warn = out > 0.05 ? ` · 出画 ${Math.round(out * 100)}%` : '';
    const warnTip = out > 0.05
      ? `\n主体有 ${Math.round(out * 100)}% 在画面外（镜头视角的画面）；拖相机或改相机路径点重新取景`
      : '';
    show(OBJ_TYPE[obj.type] || '3D', 'badge-object', `${obj.name || obj.id}${warn}`,
      `${path} · 世界 ${world}${kids ? ` · ${kids} 子级` : ''}${warnTip}${note}`);
    return;
  }
  const el = sel.elementId ? (p?.elements || []).find((e) => e.id === sel.elementId) : null;
  if (el) {
    const [label, cls] = SEL_TYPE[el.type] || [el.type || '元素', ''];
    show(label, cls ? `badge-${cls}` : '', el.name || el.id, el.id);
    return;
  }
  const pool = sel.pool;
  // The pool primary is the host the transport badge names, even in a mixed
  // cam / ob / el selection.
  const primary = pool?.kind ? splitRef(pool.primary) : null;
  const camId = primary?.type === 'cam'
    ? primary.id
    : (!pool?.ids?.length && sel.camera ? (p?.activeCameraId || p?.camera?.id) : null);
  const cam = camId ? ((p?.cameras || []).find((c) => c.id === camId) || (p?.camera?.id === camId ? p.camera : null)) : null;
  if (cam) {
    show('相机', 'badge-camera', cam.name || cam.id, cam.id);
    return;
  }
  if (pool?.kind === 'keyframe' && pool.ids.length) {
    show('关键帧', 'badge-accent', `${pool.ids.length} 个`);
    return;
  }
  node.hidden = true;
}

function fitStage() {
  if (!preview || !S.project) return;
  const wrap = $('#stageWrap');
  const box = $('#stageBox');
  const availW = Math.max(120, wrap.clientWidth - 28);
  const availH = Math.max(80, wrap.clientHeight - 28);
  const ar = (S.project.meta.width || 16) / (S.project.meta.height || 9);
  let w = availW, h = w / ar;
  if (h > availH) { h = availH; w = h * ar; }
  box.style.width = `${Math.round(w)}px`;
  box.style.height = `${Math.round(h)}px`;
  preview.resize(w, h);
  gizmo?.resize();
  preview.render(S.time);
  gizmo?.draw();
  updateOverlay();
}

// ---------------------------------------------------------------- 3D viewport
const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));
const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3len = (a) => Math.hypot(a[0], a[1], a[2]);
const v3norm = (a) => { const l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Parameter along the line `p + a*s` closest to a screen ray (axis drags). */
function axisClosestS(ray, p, a) {
  if (!ray) return null;
  const d = ray.dir;
  const w = [ray.origin[0] - p[0], ray.origin[1] - p[1], ray.origin[2] - p[2]];
  const b = a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  const c = a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
  const e = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const tRay = (b * c - e) / denom;
  return c + b * tRay;
}

function cameraById(id) {
  if (id == null) return null;
  const p = S.project;
  return (p?.cameras || []).find((c) => c.id === id) || (p?.camera?.id === id ? p.camera : null);
}

/**
 * Keep the free editor camera on the followed camera's current pose. The edit
 * viewport still draws through `S.editCam`, so picking and dragging keep
 * working; the camera path gizmo is hidden while following (pathgizmo.js).
 */
function syncFollowCam() {
  if (!S.followCam || !S.editMode || !S.project) return false;
  const cam = cameraById(S.followCam);
  if (!cam) { S.followCam = null; syncViewControls(); return false; }
  const c = evalCameraWorldWithLinks(S.project, S.time, cam);
  S.editCam = {
    pos: c.pos.slice(), look: c.look.slice(),
    roll: Number(c.roll) || 0, fov: Number(c.fov) || 50,
  };
  preview.editCam = S.editCam;
  return true;
}

/** Stop following without moving the view: it is already at the camera pose. */
function stopFollow() {
  if (!S.followCam) return false;
  S.followCam = null;
  syncViewControls();
  if (preview && S.project) {
    preview.render(S.time);
    gizmo?.draw();
    updateOverlay();
  }
  return true;
}

/**
 * Seeking outside the followed camera's clip ends the follow. The eye stays on
 * the nearest boundary frame (start or end) so the picture does not silently
 * show a camera path outside the shot. Exactly `end` is still inside: that is
 * where the play-within-the-shot auto-pauses.
 */
function detachFollowForSeek(t) {
  if (!S.followCam) return false;
  const cam = cameraById(S.followCam);
  if (!cam) { S.followCam = null; syncViewControls(); return false; }
  const range = cameraRange(S.project, cam);
  if (t >= range.start - 1e-6 && t <= range.end + 1e-6) return false;
  const at = t < range.start ? range.start : range.end;
  const c = evalCameraWorldWithLinks(S.project, at, cam);
  S.editCam = {
    pos: c.pos.slice(), look: c.look.slice(),
    roll: Number(c.roll) || 0, fov: Number(c.fov) || 50,
  };
  if (preview) preview.editCam = S.editCam;
  S.followCam = null;
  if (S.playing) pause();
  syncViewControls();
  toast(`已离开镜头「${cam.name || cam.id}」，跟随结束`, 'info');
  return true;
}

/** Enter edit-select mode and lock the viewport to camera `id` over time. */
function followCamera(id, { selectHost = false } = {}) {
  const cam = cameraById(id);
  if (!cam) { toast('找不到这台相机', 'warn'); return false; }
  if (!S.editMode) setEditMode(true);
  setViewMode('select');
  if (selectHost) {
    const ref = cameraRef(cam.id);
    select({ pool: normalizeSelection({ kind: 'element', ids: [ref], primary: ref }) });
  }
  S.followCam = cam.id;
  const range = cameraRange(S.project, cam);
  // Frame-precise like play(): the frame containing the clip's end belongs to
  // the shot, so entering a follow there starts the shot over instead of
  // parking on its last frame.
  if (S.time < range.start - 1e-6 || S.time >= pictureTime(range.end) - 1e-9) {
    setTime(range.start);
    if (S.playing) {
      S.playFrom = S.time;
      S.playWall = performance.now();
      preview.setAudioTime(S.time);
    }
  }
  syncFollowCam();
  preview.render(S.time);
  gizmo?.draw();
  updateOverlay();
  syncViewControls();
  return true;
}

/**
 * Fly the free editor camera in front of a camfeed plane. This is a one-shot
 * move, never a follow; it keeps the feed inside the same time range.
 */
function flyToFeed(id) {
  const el = S.project?.elements?.find((e) => e.id === id && e.type === 'camfeed');
  if (!el) return false;
  if (!S.editMode) setEditMode(true);
  else setViewMode('select');
  S.followCam = null;
  const start = Number(el.start) || 0;
  const end = start + (Number(el.duration) || 0);
  if (S.time < start - 1e-6 || S.time >= end - 1e-6) setTime(start);
  const frame = frameOf(elementWorldNodeWithLinks(S.project, el, S.time));
  const fwd = frame.basis[2];
  const cur = S.editCam?.pos || evalCameraWorldWithLinks(S.project, S.time).pos;
  const side = (cur[0] - frame.pos[0]) * fwd[0]
    + (cur[1] - frame.pos[1]) * fwd[1]
    + (cur[2] - frame.pos[2]) * fwd[2] >= 0 ? 1 : -1;
  const fov = Number(S.editCam?.fov) || 50;
  // A 2D plane's world width is its project-pixel width / 100 m, multiplied by
  // the node scale (same rule as preview.js::_nodePlane). Using frame.scale
  // alone would put the camera 1 m in front of a full-screen feed.
  const meta = S.project.meta || {};
  // camfeed layers are always full-frame (preview.js uses W/H for the layer),
  // so the plane size is the project frame size times the node scale.
  const pxW = Number(meta.width) || 1920;
  const pxH = Number(meta.height) || 1080;
  const size = Math.max(0.5, (Math.max(pxW, pxH) / 100)
    * Math.max(Math.abs(frame.scale[0]) || 1, Math.abs(frame.scale[1]) || 1));
  const dist = Math.max(1.2, (size / 2) / Math.tan((fov * Math.PI) / 360) * 1.25);
  const pos = frame.pos.map((v, i) => v + fwd[i] * dist * side);
  S.editCam = { pos, look: frame.pos.slice(), roll: 0, fov };
  preview.editCam = S.editCam;
  preview.render(S.time);
  gizmo?.draw();
  updateOverlay();
  syncViewControls();
  toast(`已飞到「${el.name || el.id}」前`, 'info');
  return true;
}

/**
 * Free editor camera for entering 编辑视角: a little behind the shot camera and
 * slightly above it, looking the same way. It used to copy the lens exactly, so
 * the first look was indistinguishable from 镜头视角 and the shot frustum was
 * drawn right on top of the eye. Following a camera (F5) still sits exactly on
 * it — that path sets `S.editCam` itself.
 */
function editorCamFrom(shot) {
  const look = shot.look.slice();
  const fwd = v3norm(v3sub(look, shot.pos));
  const dist = Math.max(1e-3, v3len(v3sub(look, shot.pos)));
  const back = Math.min(12, Math.max(3, dist * 0.35));
  const lift = Math.min(2.5, back * 0.25);
  return {
    pos: [shot.pos[0] - fwd[0] * back, shot.pos[1] - fwd[1] * back + lift, shot.pos[2] - fwd[2] * back],
    look,
    roll: 0,
    fov: shot.fov,
  };
}

function setEditMode(on) {
  if (on && !S.project?.camera) { toast('这个项目没有相机'); return; }
  S.followCam = null;
  S.editMode = !!on;
  preview.editMode = S.editMode;
  if (S.editMode) {
    const c = evalCameraWorldWithLinks(S.project, S.time);
    S.editCam = editorCamFrom(c);
    preview.editCam = S.editCam;
  } else {
    S.editCam = null;
    preview.editCam = null;
  }
  document.body.classList.toggle('look-mode', S.editMode);
  setViewMode('select');
  preview.render(S.time);
  gizmo?.draw();
}

/** Edit viewport modes: 'select' (pick / drag / context menu) or 'move' (camera). */
function setViewMode(mode) {
  S.viewMode = mode === 'move' ? 'move' : 'select';
  // Moving the camera is the explicit way out of a follow. The eye is already
  // on the followed camera's pose, so the free camera starts exactly there.
  if (S.viewMode === 'move') S.followCam = null;
  syncViewControls();
  document.body.classList.toggle('body-move', S.editMode && S.viewMode === 'move');
  const stage = $('#stage');
  if (stage) stage.style.cursor = S.editMode && S.viewMode === 'move' ? 'grab' : 'default';
}

function orbitEdit(dx, dy) {
  const cam = S.editCam;
  if (!cam) return;
  const target = cam.look.slice();
  const v = v3sub(cam.pos, target);
  const dist = v3len(v) || 1;
  let yaw = Math.atan2(v[0], v[2]);
  let pitch = Math.asin(clampNum(v[1] / dist, -1, 1));
  yaw -= dx * 0.006;
  pitch = clampNum(pitch + dy * 0.006, -1.45, 1.45);
  const cp = Math.cos(pitch);
  cam.pos = [
    target[0] + Math.sin(yaw) * cp * dist,
    target[1] + Math.sin(pitch) * dist,
    target[2] + Math.cos(yaw) * cp * dist,
  ];
}

function flyEdit(dt) {
  const cam = S.editCam;
  if (!cam || !S.editMode || S.viewMode !== 'move') return;
  const k = S.keys;
  const boost = k.has('ShiftLeft') || k.has('ShiftRight');
  const speed = (boost ? 180 : 45) * dt;
  const f = v3norm(v3sub(cam.look, cam.pos));
  const r = v3norm(v3cross(f, [0, 1, 0]));
  const up = [0, 1, 0];
  const m = [0, 0, 0];
  const add = (v, s) => { m[0] += v[0] * s; m[1] += v[1] * s; m[2] += v[2] * s; };
  if (k.has('KeyW')) add(f, 1);
  if (k.has('KeyS')) add(f, -1);
  if (k.has('KeyD')) add(r, 1);
  if (k.has('KeyA')) add(r, -1);
  if (k.has('KeyE')) add(up, 1);
  if (k.has('KeyQ')) add(up, -1);
  const l = v3len(m);
  if (l < 1e-6) return;
  const step = m.map((v) => (v / l) * speed);
  cam.pos = cam.pos.map((v, i) => v + step[i]);
  cam.look = cam.look.map((v, i) => v + step[i]);
}

function dollyEdit(factor) {
  const cam = S.editCam;
  if (!cam) return;
  const d = v3sub(cam.pos, cam.look).map((v) => v * factor);
  cam.pos = cam.look.map((v, i) => v + d[i]);
}

function commitCameraPath() {
  if (S.project?.camera) op({ op: 'cameraPath', path: S.project.camera.path });
}

// ---------------------------------------------------------------- panels
const MEDIA_KIND_RE = [
  ['image', /\.(png|jpe?g|webp|gif|avif)$/i],
  ['video', /\.(mp4|webm|mov|m4v)$/i],
  ['audio', /\.(m4a|mp3|wav|flac|ogg|aac|opus)$/i],
];

/** 'image' | 'video' | 'audio' | null from a media/ path. */
function mediaKind(path) {
  const p = String(path || '');
  return MEDIA_KIND_RE.find(([, re]) => re.test(p))?.[0] || null;
}

/** Pick an image or video from media/ in a small modal (null when cancelled). */
function pickMedia(kind) {
  const label = kind === 'video' ? '视频' : '图片';
  const svgIcon = (id, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  return new Promise((resolve) => {
    let settled = false;
    const opener = document.activeElement;
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card dlg mpick-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'mpickTitle');
    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('div');
    title.className = 'modal-title';
    const strong = document.createElement('strong');
    strong.id = 'mpickTitle';
    strong.textContent = `选择${label}`;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '只列出 media/ 里的素材';
    title.append(strong, hint);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn modal-x';
    close.setAttribute('aria-label', '关闭');
    close.dataset.tip = '关闭';
    close.dataset.kbd = 'Esc';
    close.innerHTML = svgIcon('x');
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'dlg-body mpick-body';
    const searchBox = document.createElement('div');
    searchBox.className = 'mpick-search';
    searchBox.innerHTML = svgIcon('search', 'ic ic-sm');
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = '按文件名搜索';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('aria-label', `搜索${label}`);
    searchBox.append(search);
    const scroll = document.createElement('div');
    scroll.className = 'mpick-scroll';
    body.append(searchBox, scroll);
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const footHint = document.createElement('span');
    footHint.className = 'mpick-foot-hint';
    footHint.innerHTML = '<kbd>Enter</kbd><span>或双击选择</span>';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn lg';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn lg';
    ok.textContent = '选择';
    ok.disabled = true;
    foot.append(footHint, spacer, cancel, ok);
    card.append(head, body, foot);
    modal.append(card);
    document.body.append(modal);

    let list = [];
    let cards = []; // [{ m, item }] currently shown
    let act = -1;
    const setAct = (i) => {
      act = i;
      cards.forEach((c, j) => {
        c.item.classList.toggle('act', j === i);
        c.item.setAttribute('aria-selected', j === i ? 'true' : 'false');
      });
      if (cards[i]) cards[i].item.scrollIntoView({ block: 'nearest' });
      ok.disabled = !cards[i];
    };

    const finish = (m) => {
      if (settled) return;
      settled = true;
      modal.remove();
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
      resolve(m || null);
    };
    const onKey = (e) => {
      if ([...document.querySelectorAll('.modal:not([hidden])')].pop() !== modal) return;
      const n = cards.length;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        const c = cards[act >= 0 ? act : (n === 1 ? 0 : -1)];
        if (!c) return;
        finish(c.m);
      } else if (step && n && !(e.target === search && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
        setAct(act < 0 ? 0 : Math.max(0, Math.min(n - 1, act + step)));
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    close.onclick = () => finish(null);
    cancel.onclick = () => finish(null);
    ok.onclick = () => { if (cards[act]) finish(cards[act].m); };
    modal.addEventListener('pointerdown', (e) => { if (e.target === modal) finish(null); });

    const note = (text) => {
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = text;
      scroll.replaceChildren(d);
    };
    const renderGrid = () => {
      const q = search.value.trim().toLowerCase();
      const shown = q ? list.filter((m) => String(m.name).toLowerCase().includes(q)) : list;
      cards = [];
      act = -1;
      ok.disabled = true;
      if (!shown.length) { note(`没有文件名包含「${search.value.trim()}」的${label}`); return; }
      const grid = document.createElement('div');
      grid.className = 'media-grid mpick-grid';
      grid.setAttribute('role', 'listbox');
      shown.forEach((m, i) => {
        const item = document.createElement('div');
        item.className = 'media-card';
        item.title = m.name;
        item.setAttribute('role', 'option');
        if (kind === 'image') {
          const img = document.createElement('img');
          img.src = `/${m.path}`;
          img.loading = 'lazy';
          img.alt = '';
          item.append(img);
        } else {
          const fileIcon = document.createElement('div');
          fileIcon.className = 'fileicon';
          fileIcon.innerHTML = svgIcon('video');
          item.append(fileIcon);
        }
        const cap = document.createElement('div');
        cap.className = 'media-cap';
        cap.textContent = m.name;
        item.append(cap);
        item.onclick = () => setAct(i);
        item.ondblclick = () => finish(m);
        cards.push({ m, item });
        grid.append(item);
      });
      scroll.replaceChildren(grid);
      if (cards.length === 1) setAct(0);
    };
    search.addEventListener('input', () => { if (list.length) renderGrid(); });
    search.focus();

    note('读取素材…');
    fetch('/api/media').then((r) => r.json()).then((j) => {
      if (settled) return;
      list = (j.media || []).filter((m) => mediaKind(m.path) === kind);
      if (!list.length) {
        note(`media/ 里还没有${label}。先在左侧「媒体」面板导入。`);
        return;
      }
      renderGrid();
    }).catch((e) => {
      if (settled) return;
      note(`读取失败：${e.message}`);
    });
  });
}

/**
 * Add a media file to the timeline. `start` = null means "at the playhead's
 * frame-left time"; a drop passes the ghost's snapped left edge. Audio becomes
 * a normal audio element, images/videos become 2D layers.
 */
function addMediaFile(m, kind, start = null) {
  if (kind === 'audio') return addAudioAt(m, start);
  if (kind === 'image' || kind === 'video') return addMediaAt(m, kind === 'video', start);
  toast('只能把图片、视频和声音放进时间线', 'warn');
  return null;
}

/**
 * Timeline drop target + drag preview for cards dragged from 资源. The ghost's
 * left edge is the prospective clip start: it is frame-snapped while dragging
 * and reused verbatim on drop (never recomputed from the pointer), with a width
 * of the prospective duration (probed source length, or 5s until the probe
 * resolves). Ghost is a pointer-events:none floating preview in the track area.
 */
let mediaDropApi = null;
function initMediaDrop() {
  const tl = $('#timeline');
  if (!tl) return null;
  const isMedia = (e) => [...(e.dataTransfer?.types || [])].includes(MEDIA_MIME);
  let drag = null; // { m, kind, duration, pointer:{x,y}, start }
  let ghost = null;

  const clearGhost = () => {
    ghost?.remove();
    ghost = null;
    tl.classList.remove('media-drop');
  };
  const clear = () => {
    clearGhost();
    drag = null;
    S.mediaDrag = null;
  };

  const paint = () => {
    if (!drag?.pointer) return;
    const at = timeline.frameStart(timeline._timeAt(drag.pointer.x));
    drag.start = at;
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'tl-drop-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.innerHTML = '<span class="tl-drop-ghost-label"></span>';
      timeline.inner.appendChild(ghost);
    }
    const dur = Number(drag.duration) > 0 ? Number(drag.duration) : 5;
    ghost.style.left = `${timeline._trackX(at)}px`;
    ghost.style.width = `${Math.max(3, dur * timeline.pps)}px`;
    const inner = timeline.inner.getBoundingClientRect();
    ghost.style.top = `${Math.max(0, drag.pointer.y - inner.top - 14)}px`;
    const label = ghost.firstChild;
    if (label) label.textContent = `${at.toFixed(2)}s · ${dur.toFixed(2)}s`;
  };

  const begin = (m, kind) => {
    if (!m || (kind !== 'image' && kind !== 'video' && kind !== 'audio')) return;
    // The source length is only known after probing; the ghost starts at 5s and
    // grows once the probe lands (setData is not readable during dragover).
    drag = { m, kind, duration: 5, pointer: null, start: null };
    S.mediaDrag = drag;
    if (kind === 'image') return;
    const mine = drag;
    probeSourceDuration(m.path).then((d) => {
      if (drag !== mine || !(d > 0)) return;
      mine.duration = d;
      if (mine.pointer) paint();
    }).catch(() => {});
  };

  tl.addEventListener('dragover', (e) => {
    if (!isMedia(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!drag) drag = { m: null, kind: null, duration: 5, pointer: null, start: null };
    drag.pointer = { x: e.clientX, y: e.clientY };
    tl.classList.add('media-drop');
    paint();
  });
  tl.addEventListener('dragleave', (e) => {
    if (!isMedia(e)) return;
    if (!tl.contains(e.relatedTarget)) clearGhost();
  });
  tl.addEventListener('drop', (e) => {
    if (!isMedia(e)) return;
    e.preventDefault();
    const path = e.dataTransfer.getData(MEDIA_MIME);
    const m = drag?.m || (S.media || []).find((x) => x.path === path);
    const kind = drag?.kind || (m ? mediaKind(m.path) : null);
    const start = drag?.start ?? null;
    clear();
    if (!m || !kind) return;
    addMediaFile(m, kind, start);
  });
  window.addEventListener('dragend', clear);
  return { begin, end: clear };
}

async function setSoundtrack(m) {
  if (S.project.meta.audio?.src === m.path) { toast('已经是当前配乐'); return; }
  const prev = S.project.meta.audio || {};
  const gain = Number(prev.gain) || 0;
  const volume = Math.max(0, Math.min(1, 10 ** (gain / 20)));
  const total = Math.max(0.05, Number(S.project.meta.duration) || 12);
  const sourceDuration = await probeSourceDuration(m.path);
  const songDuration = sourceDuration ? Math.max(0.05, Math.min(total, sourceDuration)) : total;
  const current = (S.project.elements || []);
  const song = current.find((e) => e.type === 'audio' && e.meta?.fromSoundtrack)
    || current.find((e) => e.type === 'audio' && e.src === m.path);
  const ops = [
    { op: 'setMeta', path: 'audio', value: { src: m.path, offset: 0, gain } },
    { op: 'setMeta', path: 'audioMigrated', value: true },
  ];
  if (song) {
    ops.push({
      op: 'updateElement', id: song.id,
      patch: {
        src: m.path, name: m.name, start: 0, duration: songDuration, srcIn: 0, volume,
        ...(sourceDuration ? { meta: { ...(song.meta || {}), sourceDuration } } : {}),
      },
    });
  } else {
    ops.push({
      op: 'addElement',
      element: {
        type: 'audio', name: m.name, src: m.path, start: 0, duration: songDuration,
        srcIn: 0, volume, meta: { fromSoundtrack: true, ...(sourceDuration ? { sourceDuration } : {}) },
      },
    });
  }
  const j = await op(...ops);
  if (!j) return;
  assetsPanel?.syncProject();
  toast('已设为配乐，正在分析节拍…');
  try {
    const b = await post('/api/beats', {});
    toast(`配乐节拍 ${b.tempo} bpm · ${b.beats.length} 拍`, 'success');
  } catch (e) { toast(`节拍分析失败: ${e.message}`, 'error'); }
}

/** segment under time t, if any */
const segmentAt = (t) => S.project.segments.find((s) => t >= s.start && t < s.start + s.duration) || null;

// Insertions are serialized: a rapid double-click on an asset plans its row
// against the project the previous insert produced, so the persisted
// timelineOrder / z values cannot race each other. Duplicates are never blocked.
let insertionChain = Promise.resolve();

/**
 * The ONE insertion path for newly created timeline rows: 2D elements (toolbar
 * text/shape, asset quick add, media drop, audio add) and 3D objects. The new
 * row goes one row above the current selection — or the top row when nothing
 * is selected — and its order is persisted in `meta.ui.timelineOrder` in the
 * same batch as the add. For 2D, `el.z` is planned from the resulting display
 * slot (midpoint, or a whole-stack renumber). The project grows automatically
 * (`syncDuration`), so no start/duration is clamped to the old length.
 *
 * One `batch` op = one rev = one undo step. The caller gets the new id after
 * it has been selected, revealed and the inspector has switched to 属性.
 *
 * @param {object} o
 * @param {object|Function} [o.element]  2D payload (no id/start/duration/z)
 * @param {object|Function} [o.object]   3D payload (no id/start/duration)
 * @param {number} [o.start]  start time; null = playhead's frame-left time
 * @param {number} [o.duration=5]  clip length (media passes the source length)
 * @param {string} [o.note]  toast text; a duration-extension note is appended
 * @param {'success'|'info'|'warn'} [o.level]
 * @returns {Promise<string|null>} new element / object id
 */
function insertTimelineRow(o = {}) {
  const pending = insertionChain.then(() => insertTimelineRowNow(o), () => insertTimelineRowNow(o));
  insertionChain = pending.catch(() => {});
  return pending;
}

async function insertTimelineRowNow({
  element = null, object = null, start = null, duration = 5, note = '', level = 'success',
} = {}) {
  if (!S.project || !timeline || (!element && !object)) return null;
  const p = S.project;
  const at = start == null ? timeline.playheadStart() : Math.max(0, Number(start) || 0);
  const dur = Math.max(0.001, Number(duration) || 5);
  const before = Number(p.meta.duration) || 0;
  const build = (v) => (typeof v === 'function' ? v(at) : { ...v });
  let id;
  let ref;
  let plan;
  let ops;

  if (element) {
    const taken = new Set([...p.elements.map((e) => e.id), ...p.segments.map((s) => s.id)]);
    id = newId('el', taken);
    ref = elementRef(id);
    plan = timeline.rowInsertPlan(ref);
    const payload = { ...build(element), id, start: at, duration: dur };
    // Audio rows are display-only in the stack; all other 2D rows must land on
    // the z slot that matches their display rank.
    const zPlan = payload.type === 'audio'
      ? { z: null, ops: [] }
      : timeline.planElementInsertion(payload, plan.order);
    if (zPlan.z != null) payload.z = zPlan.z;
    ops = [
      { op: 'addElement', element: payload },
      ...zPlan.ops,
      { op: 'setMeta', path: 'ui.timelineOrder', value: plan.order },
    ];
  } else {
    const taken = new Set((p.scene?.objects || []).map((o) => o.id));
    id = newId('ob', taken);
    ref = objectRef(id);
    plan = timeline.rowInsertPlan(ref);
    // objectAdd clamps start/duration to the current project total, so extend
    // the duration first inside the same batch.
    ops = [
      { op: 'setMeta', path: 'duration', value: Math.max(before, at + dur) },
      { op: 'objectAdd', object: { ...build(object), id, start: at, duration: dur } },
      { op: 'setMeta', path: 'ui.timelineOrder', value: plan.order },
    ];
  }

  const j = await op({ op: 'batch', ops });
  if (!j) return null;
  if (element) select({ elementId: id });
  else select({ objectId: id });
  switchRightTab('insp');
  timeline.afterInsertRow({ index: plan.index, ref });
  const grew = (Number(S.project.meta.duration) || 0) > before + 1e-6;
  const parts = [note, grew ? `项目时长延长到 ${S.project.meta.duration.toFixed(2)}s` : ''].filter(Boolean);
  if (parts.length) toast(parts.join(' · '), note ? level : 'info');
  return id;
}

/**
 * Text / colour block at the playhead, inserted above the selected row. Starts
 * at the frame-left display time and runs 5s; the project extends to fit.
 */
async function add2DElement(kind, start = null) {
  if (!S.project) return null;
  const element = (at) => {
    const base = {
      segment: segmentAt(at)?.id || null,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, fadeIn: 0.2, fadeOut: 0.2,
    };
    return kind === 'text'
      ? { ...base, type: 'text', name: '文字', style: { text: '新文字', size: 120, color: '#ffffff', align: 'center' } }
      : { ...base, type: 'shape', name: '色块', style: { shape: 'rect', fill: '#ff2a4d', w: 640, h: 120, radius: 0 } };
  };
  const id = await insertTimelineRow({ element, start, duration: 5 });
  if (id && kind === 'text') {
    const ta = $('#panelInsp textarea');
    if (ta) { ta.focus(); ta.select(); }
  }
  return id;
}

// ---------------------------------------------------------------- clipboard
// The clipboard is persisted in localStorage so Ctrl+C in one project still
// works after the app restarts into another one. It carries a list of items in
// layer order; paste re-times the group to the playhead and lets the current
// project assign fresh ids.
const CLIPBOARD_KEY = 'vdm.clipboard.v1';
const clipRound = (v) => Math.round(Number(v) * 1000) / 1000;

function readClipboard() {
  try {
    const j = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) || 'null');
    if (j?.v === 1 && Array.isArray(j.items) && j.items.length) return j;
  } catch { /* local storage disabled or corrupt */ }
  if (S.clipboard?.v === 1 && Array.isArray(S.clipboard.items) && S.clipboard.items.length) return S.clipboard;
  return null;
}

function storeClipboard(payload) {
  S.clipboard = payload;
  try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(payload)); }
  catch { /* clipboard is best-effort; still usable in this session */ }
}

/** Copy selected 2D elements and/or 3D objects, preserving their order. */
function copySelection(onlyElementIds = null) {
  if (!S.project) return false;
  const refs = onlyElementIds
    ? onlyElementIds.map((id) => splitRef(`el:${id}`)).filter(Boolean)
    : (S.selection.pool?.kind === 'element' ? S.selection.pool.ids.map(splitRef).filter(Boolean) : []);
  const elIds = new Set(onlyElementIds || refs.filter((r) => r.type === 'el').map((r) => r.id));
  const obIds = new Set(onlyElementIds ? [] : refs.filter((r) => r.type === 'ob').map((r) => r.id));
  if (!elIds.size && S.selection.elementId && !onlyElementIds) elIds.add(S.selection.elementId);
  if (!obIds.size && S.selection.objectId && !onlyElementIds) obIds.add(S.selection.objectId);

  const elements = S.project.elements
    .filter((e) => elIds.has(e.id))
    .sort((a, b) => a.z - b.z || a.start - b.start)
    .map((e) => ({ kind: 'element', data: JSON.parse(JSON.stringify(e)) }));
  const objects = (S.project.scene?.objects || [])
    .filter((o) => obIds.has(o.id))
    .map((o) => ({ kind: 'object', data: JSON.parse(JSON.stringify(o)) }));
  const items = [...elements, ...objects];
  if (!items.length) {
    toast('先选中要复制的元素', 'warn');
    return false;
  }
  storeClipboard({
    v: 1,
    source: S.project.meta?.title || '',
    at: Date.now(),
    items,
  });
  toast(`已复制 ${items.length} 个元素（Ctrl+V 粘贴，可跨项目）`, 'success');
  return true;
}

/** Paste the persisted clipboard at the playhead, keeping relative timing. */
async function pasteClipboard() {
  const clip = readClipboard();
  if (!clip) {
    toast('剪贴板里没有元素', 'warn');
    return null;
  }
  if (!S.project) return null;
  const items = clip.items.filter((it) => it?.data && (it.kind === 'element' || it.kind === 'object'));
  if (!items.length) return null;

  const startOf = (it) => Number(it.data.start) || 0;
  const durOf = (it) => Math.max(0.05, Number(it.data.duration) || 1);
  const minStart = Math.min(...items.map(startOf));
  const maxEnd = Math.max(...items.map((it) => startOf(it) + durOf(it)));
  const total = Number(S.project.meta.duration) || 12;
  let offset = S.time - minStart;
  offset = Math.min(offset, total - maxEnd);
  offset = Math.max(offset, -minStart);
  offset = clipRound(offset);

  const used = new Set([
    ...S.project.elements.map((e) => e.id),
    ...(S.project.scene?.objects || []).map((o) => o.id),
  ]);
  const stamp = Date.now().toString(36);
  let serial = 0;
  const freshId = (prefix) => {
    let id = `${prefix}_clip_${stamp}_${serial++}`;
    while (used.has(id)) id += 'x';
    used.add(id);
    return id;
  };
  const objectItems = items.filter((it) => it.kind === 'object');
  const objectIds = new Map(objectItems.map((it) => [it.data.id, freshId('ob')]));
  const ops = [];
  const refs = [];
  const elIds = [];

  for (const it of items) {
    const start = clipRound(Math.max(0, startOf(it) + offset));
    if (it.kind === 'element') {
      const el = JSON.parse(JSON.stringify(it.data));
      el.id = freshId('el');
      el.start = start;
      el.duration = clipRound(Math.max(0.05, Math.min(durOf(it), Math.max(0.05, total - start))));
      el.segment = segmentAt(start)?.id || null;
      delete el.z;
      delete el.parent;
      el.keyframes = (el.keyframes || []).map((k) => ({ ...k, t: clipRound(Number(k.t) + offset) }));
      if (Array.isArray(el.motion?.span)) el.motion.span = el.motion.span.map((v) => clipRound(Number(v) + offset));
      ops.push({ op: 'addElement', element: el });
      refs.push(elementRef(el.id));
      elIds.push(el.id);
    } else {
      const obj = JSON.parse(JSON.stringify(it.data));
      obj.id = objectIds.get(it.data.id) || freshId('ob');
      obj.start = start;
      obj.duration = clipRound(Math.max(0.05, Math.min(durOf(it), Math.max(0.05, total - start))));
      if (obj.parent?.id) {
        const pid = objectIds.get(obj.parent.id);
        if (pid) obj.parent = { ...obj.parent, id: pid };
        else delete obj.parent;
      }
      for (const keys of Object.values(obj.tracks || {})) {
        for (const k of keys || []) if (Number.isFinite(Number(k.t))) k.t = clipRound(Number(k.t) + offset);
      }
      ops.push({ op: 'objectAdd', object: obj });
      refs.push(objectRef(obj.id));
    }
  }

  const j = await op(...ops);
  if (!j) return null;
  if (refs.length) {
    const pool = { kind: 'element', ids: refs, primary: refs[0] };
    if (elIds.length) select({ elementId: elIds[0], pool });
    else select({ objectId: refs[0].slice(3), pool });
  }
  toast(`已粘贴 ${items.length} 个元素${clip.source ? `（来自 ${clip.source}）` : ''}`, 'success');
  return j;
}

/**
 * Add an image / video at `start` (null = playhead frame-left). Video length is
 * the probed source duration, image is always 5s, unknown source length falls
 * back to 5s. No 4s cap, no fit-inside-project clamp: the project extends.
 */
async function addMediaAt(m, isVid, start = null) {
  if (!S.project) return null;
  const sourceDuration = isVid ? await probeSourceDuration(m.path) : null;
  const duration = isVid && sourceDuration ? sourceDuration : 5;
  const element = (at) => ({
    type: isVid ? 'video' : 'image', name: m.name, src: m.path,
    segment: segmentAt(at)?.id || null,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    style: { fit: 'cover' }, motion: { type: 'in', amount: 0.08 },
    fadeIn: 0.2, fadeOut: 0.2,
    ...(sourceDuration ? { meta: { sourceDuration } } : {}),
  });
  return insertTimelineRow({
    element, start, duration,
    note: isVid && !sourceDuration ? `未能读取「${m.name}」的时长，按 5s 加入` : '',
    level: isVid && !sourceDuration ? 'warn' : 'success',
  });
}

/**
 * Add a sound file as a normal timeline element at the playhead (or start).
 * Repeated adds are allowed (no source de-duplication): the row goes above the
 * selection like any other new row, duration = source length (unknown → 5s).
 */
async function addAudioAt(m, start = null) {
  if (!S.project) return null;
  const sourceDuration = await probeSourceDuration(m.path);
  const duration = sourceDuration || 5;
  const element = () => ({
    type: 'audio', name: m.name, src: m.path, srcIn: 0, volume: 1,
    ...(sourceDuration ? { meta: { sourceDuration } } : {}),
  });
  return insertTimelineRow({
    element, start, duration,
    note: sourceDuration ? `声音已加入时间线：${m.name}` : `未能读取「${m.name}」的时长，按 5s 加入`,
    level: sourceDuration ? 'success' : 'warn',
  });
}

function switchRightTab(name) {
  // the log list moved to the status-bar drawer; keep the old tab name working
  if (name === 'logs') { logDrawer?.open(); return; }
  if (!['insp', 'ai', 'review', 'pipe'].includes(name)) name = 'insp';
  markTab(document.querySelector('[data-tabs="right"]'), name);
  $('#panelInsp').hidden = name !== 'insp';
  $('#panelAI').hidden = name !== 'ai';
  $('#panelReview').hidden = name !== 'review';
  $('#panelPipe').hidden = name !== 'pipe';
  prefs.set('rightTab', name);
}

function switchLeftTab(name) {
  if (!['media', 'layers'].includes(name)) name = 'media';
  markTab(document.querySelector('[data-tabs="left"]'), name);
  $('#panelMedia').hidden = name !== 'media';
  $('#panelLayers').hidden = name !== 'layers';
  prefs.set('leftTab', name);
}

// ---------------------------------------------------------------- change set preview (WP2.5a)
// Accepting a change set is one transaction; before that, the review page can
// show the result without writing anything: `/api/changesets {preview}` returns
// the shadow at the *current* revision and the viewport draws it through
// `preview.setOverlay` (textures / audio players are shared, §11.3). Everything
// editable keeps reading S.project and refuses writes while the shadow is on.
async function applyChangeset(id, expectedRev = S.project?.rev) {
  const j = await post('/api/changesets', { action: 'apply', id, expectedRev });
  if (j.project) applyProject(j.project, 'changeset');
  return j;
}

async function revertChangeset(id, expectedRev = S.project?.rev) {
  const j = await post('/api/changesets', { action: 'revert', id, expectedRev });
  if (j.project) applyProject(j.project, 'changeset');
  return j;
}

async function revertChangesetEntry(id, selector) {
  const j = await post('/api/changesets', { action: 'revert-one', id, ...selector });
  if (j.project) applyProject(j.project, 'changeset');
  return j;
}

/** Show one proposed change set on the stage without writing the project. */
async function enterPreview(record) {
  if (!record?.id) return null;
  if (S.previewShadow?.id === record.id) return S.previewShadow;
  if (S.previewShadow) exitPreview({ render: false });
  try {
    const j = await post('/api/changesets', {
      action: 'preview', id: record.id, includeProject: true, expectedRev: S.project.rev,
    });
    if (!j.project) throw new Error('预览没有返回工程');
    S.previewShadow = { id: record.id, project: j.project, intent: record.intent || '', record };
    S.readOnly = true;
    preview.setOverlay(j.project);
    inspector?.setReadOnly?.(true);
    showPreviewBanner(record);
    preview.render(S.time);
    gizmo?.draw();
    return S.previewShadow;
  } catch (e) {
    toast(`预览失败: ${e.message}`, 'error');
    return null;
  }
}

/** Back to the real project: the only way out of the preview. */
function exitPreview({ render = true } = {}) {
  if (!S.previewShadow) return;
  review?.closeCompare?.();
  S.previewShadow = null;
  S.previewHolding = false;
  S.readOnly = false;
  preview.setOverlay(S.project);
  inspector?.setReadOnly?.(false);
  hidePreviewBanner();
  if (render) {
    preview.render(S.time);
    gizmo?.draw();
  }
}

function showPreviewBanner(record) {
  const banner = $('#previewBanner');
  if (!banner) return;
  banner.hidden = false;
  banner.classList.remove('holding');
  const text = banner.querySelector('.pb-text');
  if (text) text.title = record?.intent || '';
}

function hidePreviewBanner() {
  const banner = $('#previewBanner');
  if (!banner) return;
  banner.hidden = true;
  banner.classList.remove('holding');
}

/** Hold `\`: the stage shows the real project while the key is down. */
function setPreviewHold(on) {
  if (!S.previewShadow || S.previewHolding === on) return;
  S.previewHolding = on;
  $('#previewBanner')?.classList.toggle('holding', on);
  preview.setOverlay(on ? S.project : S.previewShadow.project);
  preview.render(S.time);
}

/** Row click on the review page: select the host, seek, show the property. */
function jumpToChange({ kind, id, path, frame }) {
  if (!S.project) return;
  if (kind === 'element' && S.project.elements.some((e) => e.id === id)) select({ elementId: id });
  else if (kind === 'object' && (S.project.scene?.objects || []).some((o) => o.id === id)) select({ objectId: id });
  else if (kind === 'camera') select({ camera: true });
  if (Number.isFinite(frame)) {
    pause();
    setTime(frame / projectFps());
  }
  switchRightTab('insp');
  requestAnimationFrame(() => inspector?.highlight?.(path));
}

/** Left = real project, right = shadow, both the current frame (§10.2-4). */
function captureCompare({ frame } = {}) {
  if (!S.previewShadow) return null;
  const real = S.project;
  const shadow = S.previewShadow.project;
  preview.setOverlay(real);
  const before = preview.capture();
  preview.setOverlay(shadow);
  const after = preview.capture();
  preview.setOverlay(S.previewHolding ? real : shadow);
  preview.render(S.time);
  return {
    before,
    after,
    frame: Number.isFinite(frame) ? frame : Math.round(S.time * projectFps()),
    revBefore: real.rev,
    revAfter: real.rev + 1,
  };
}

// ---------------------------------------------------------------- shell: top bar, stage toolbar, transport
function updateProjectMeta(p) {
  const m = p.meta;
  const meta = `${m.width}×${m.height} · ${m.fps}fps · ${m.duration.toFixed(1)}s · rev ${p.rev}`;
  $('#projTitle').textContent = m.title;
  const pb = $('#btnProject');
  if (pb) pb.dataset.tip = `${m.title || '项目'}\n${meta}`;
  if (statusBar) statusBar.setMeta(meta); else $('#projMeta').textContent = meta;
  const sm = $('#stageMeta');
  if (sm) sm.textContent = `${m.width}×${m.height} · ${m.fps}fps`;
  const sa = $('#safeArea');
  if (sa && m.width && m.height) {
    const W = m.width, H = m.height;
    sa.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const r = (k) => [W * (1 - k) / 2, H * (1 - k) / 2, W * k, H * k];
    const [ax, ay, aw, ah] = r(0.93);
    const [tx, ty, tw, th] = r(0.90);
    const set = (el, x, y, w, hh) => { el?.setAttribute('x', x); el?.setAttribute('y', y); el?.setAttribute('width', w); el?.setAttribute('height', hh); };
    set(sa.querySelector('.sa-action'), ax, ay, aw, ah);
    set(sa.querySelector('.sa-title'), tx, ty, tw, th);
    const c = Math.min(W, H) * 0.04;
    sa.querySelector('.sa-cross')?.setAttribute('d', `M${W / 2 - c} ${H / 2}H${W / 2 + c}M${W / 2} ${H / 2 - c}V${H / 2 + c}`);
  }
  updateTimecode();
  syncViewControls();
}

/** The one place that writes the transport time readout. */
function updateTimecode(t = S.time) {
  timecodeUI?.update(t);
  const d = $('#tcDuration');
  const dur = S.project?.meta.duration || 0;
  const txt = `/ ${formatDuration(dur)}`;
  if (d && d.textContent !== txt) d.textContent = txt;
}
const formatDuration = (sec) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${((cs % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};

function setPlayButton(playing) {
  const b = $('#btnPlay');
  if (!b) return;
  b.classList.toggle('on', playing);
  b.replaceChildren(icon(playing ? 'pause' : 'play'));
  b.setAttribute('aria-label', playing ? '暂停' : '播放');
}

/** Top-bar view segment, stage-toolbar badge / [选择|移动], grid weakening. */
function syncViewControls() {
  const seg = $('#viewSeg');
  if (seg) {
    seg.hidden = !S.project?.camera;
    $('#btnViewEdit')?.setAttribute('aria-pressed', S.editMode ? 'true' : 'false');
    $('#btnViewCam')?.setAttribute('aria-pressed', S.editMode ? 'false' : 'true');
  }
  const badge = $('#viewBadge');
  if (badge) badge.hidden = S.editMode;
  const vm = $('#viewMode');
  if (vm) {
    vm.hidden = !S.editMode;
    vm.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === S.viewMode ? 'true' : 'false'));
  }
  const followHint = $('#followHint');
  if (followHint) {
    const cam = S.followCam ? cameraById(S.followCam) : null;
    followHint.hidden = !cam;
    if (cam) {
      const range = cameraRange(S.project, cam);
      const atEnd = S.time >= range.end - 1e-6;
      followHint.textContent = atEnd
        ? `跟随 ${cam.name || cam.id} · 末尾 ×`
        : `跟随 ${cam.name || cam.id} ×`;
      followHint.dataset.tip = atEnd
        ? '已到镜头末尾；按空格从镜头起点重播；点击脱离，保持当前视角'
        : '正在跟随这台相机；点击脱离，保持当前视角（切移动模式也会脱离）';
    }
  }
  syncGridButton();
}

function setGrid(on) {
  S.grid = !!on;
  syncGridButton();
  gizmo?.draw();
}

function syncGridButton() {
  const b = $('#btnGrid');
  if (!b) return;
  b.setAttribute('aria-pressed', S.grid ? 'true' : 'false');
  b.classList.toggle('inactive', !S.editMode);
  b.dataset.tip = S.editMode ? '网格' : '网格\n只在编辑视口显示（Tab 进入）';
}

function setSafeArea(on) {
  S.safeArea = !!on;
  prefs.set('safeArea', S.safeArea);
  const sa = $('#safeArea');
  sa?.toggleAttribute('hidden', !S.safeArea); // SVG: no .hidden property
  $('#btnSafe')?.setAttribute('aria-pressed', S.safeArea ? 'true' : 'false');
}

function setLoop(on) {
  S.loop = !!on;
  prefs.set('loop', S.loop);
  const b = $('#btnLoop');
  if (b) {
    b.classList.toggle('on', S.loop);
    b.setAttribute('aria-pressed', S.loop ? 'true' : 'false');
  }
}

/** Render actions: one place for the top bar, its ▾ menu, the status bar and __vdm. */
const renderActions = {
  async still(t = S.time) {
    toast(`Blender 渲染 ${t.toFixed(2)}s …`);
    try { await post('/api/still', { time: t, scale: 1 }); toast('预览帧完成', 'success'); } catch (e) { toast(e.message, 'error'); }
  },
  async master() {
    if (!S.project) return;
    try { await post('/api/render', { from: 0, to: S.project.meta.duration, scale: S.renderScale }); toast('开始渲染成片'); } catch (e) { toast(e.message, 'error'); }
  },
  /** Selected segment, else the segment under the playhead. */
  async segment() {
    const p = S.project;
    if (!p) return;
    const segs = p.segments || [];
    const s = segs.find((x) => x.id === S.selection.segmentId)
      || segs.find((x) => S.time >= x.start && S.time < x.start + x.duration);
    if (!s) { toast('播放头处没有分镜段', 'warn'); return; }
    const from = s.start, to = s.start + s.duration;
    try { await post('/api/render', { from, to, scale: S.renderScale }); toast(`开始渲染 ${from.toFixed(1)}–${to.toFixed(1)}s`); } catch (e) { toast(e.message || '渲染启动失败', 'error'); }
  },
  async cancel() {
    try { await post('/api/render/cancel', {}); toast('已请求取消渲染'); } catch (e) { toast(e.message, 'error'); }
  },
  getScale: () => S.renderScale,
  setScale(v) {
    S.renderScale = Number(v) === 1 ? 1 : 0.5;
    prefs.set('renderScale', S.renderScale);
    pipelinePanel?.setScale?.(S.renderScale);
    return S.renderScale;
  },
};

function renderMenuItems() {
  const running = !!S.render?.running;
  return [
    { group: '分辨率' },
    { label: '50%', icon: S.renderScale === 0.5 ? 'check' : null, run: () => renderActions.setScale(0.5) },
    { label: '100%', icon: S.renderScale === 1 ? 'check' : null, run: () => renderActions.setScale(1) },
    { sep: true },
    { label: '渲染当前段', icon: 'film', run: () => renderActions.segment() },
    {
      label: '取消渲染', icon: 'stop', danger: running, disabled: !running,
      title: running ? '' : '没有进行中的渲染', run: () => renderActions.cancel(),
    },
  ];
}

// ---------------------------------------------------------------- boot
async function boot() {
  initTooltips();
  // shell first so the grid has its persisted sizes before the first fit
  layout = initLayout();
  logDrawer = new LogDrawer({ onOpen: () => { statusBar?.resetLogCount(); logPanel?.refresh(true); } });
  statusBar = new StatusBar({ onCancelRender: () => renderActions.cancel(), onToggleLogs: () => logDrawer.toggle() });
  statusBar.setConnection('warn');
  const state = await fetch('/api/state').then((r) => r.json());
  S.project = state.project;
  S.pipeline = state.pipeline;
  S.render = state.render;
  S.agentAvailable = state.agent.available;
  S.blender = state.blender;

  const canvas = $('#stage');
  preview = new Preview(canvas);
  preview.setProject(S.project);
  preview.playing = false;
  gizmo = new PathGizmo($('#gizmo'), {
    project: () => S.project,
    time: () => S.time,
    editMode: () => S.editMode,
    grid: () => S.grid,
    following: () => !!S.followCam,
    visible: () => !S.previewShadow && (S.editMode || !!S.selection.camera || !!S.selection.objectId),
    projectPoint: (p) => preview.scene3d.projectPoint(p),
    viewCam: () => preview.scene3d.lastCam,
    stage: () => canvas,
  });
  gizmo.resize();

  // Element actions live on the timeline header (⋯) now that the basics moved left.
  const duplicateObject = (o) => {
    const copy = JSON.parse(JSON.stringify(o));
    copy.id = `ob_${Date.now().toString(36)}`;
    copy.name = `${o.name || '元素'} 副本`;
    copy.pivot = [copy.pivot[0] + 10, copy.pivot[1], copy.pivot[2]];
    return op({ op: 'objectAdd', object: copy }).then((j) => {
      if (j) select({ objectId: copy.id });
      return copy.id;
    });
  };

  /** Delete a scene object; a parent asks how to treat its direct children. */
  const requestObjectDelete = (o) => {
    if (!o) return;
    const kids = childrenOf(S.project, o.id);
    const descendants = [];
    const walk = (id, depth = 1) => {
      for (const cid of childrenOf(S.project, id)) {
        descendants.push({ id: cid, depth });
        walk(cid, depth + 1);
      }
    };
    walk(o.id);
    const name = o.name || o.id;
    if (!kids.length) {
      if (confirm(`删除 ${name}?`)) op({ op: 'objectRemove', id: o.id });
      return;
    }
    const at = writeTime();
    const opener = document.activeElement;
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card dlg del-dialog';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'objDelTitle');
    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('div');
    title.className = 'modal-title';
    const strong = document.createElement('strong');
    strong.id = 'objDelTitle';
    strong.textContent = `删除父级「${name}」`;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = `当前 ${at.toFixed(2)}s`;
    title.append(strong, hint);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn modal-x';
    close.setAttribute('aria-label', '关闭');
    close.dataset.tip = '关闭';
    close.dataset.kbd = 'Esc';
    close.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-x"/></svg>';
    head.append(title, close);

    const body = document.createElement('div');
    body.className = 'dlg-body';
    const desc = document.createElement('div');
    desc.textContent = `它有 ${descendants.length} 个后代元素：`;
    const list = document.createElement('div');
    list.className = 'del-list mono';
    const objs = S.project.scene?.objects || [];
    for (const kid of descendants) {
      const row = document.createElement('div');
      row.textContent = `${'— '.repeat(kid.depth - 1)}${objs.find((x) => x.id === kid.id)?.name || kid.id}`;
      list.append(row);
    }
    const note = document.createElement('div');
    note.className = 'dlg-note';
    note.textContent = '只删父级会先在当前播放头保住直接子元素的位置；父级有动画时，其它时刻会按子元素自己的动画走。';
    body.append(desc, list, note);

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'btn lg';
    keep.textContent = `只删父级（${kids.length} 子级保位）`;
    keep.dataset.tip = '直接子元素在当前帧保持画面位置';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'btn lg danger';
    all.textContent = `父子一起删（${descendants.length + 1}）`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn lg';
    cancel.textContent = '取消';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    foot.append(spacer, cancel, keep, all);
    card.append(head, body, foot);
    modal.append(card);
    document.body.append(modal);

    let settled = false;
    const finish = (mode) => {
      if (settled) return;
      settled = true;
      modal.remove();
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
      if (mode === 'keep') {
        const ops = kids.map((id) => ({ op: 'objectUnparent', id, t: at }));
        ops.push({ op: 'objectRemove', id: o.id });
        op(...ops).then((j) => {
          if (j) {
            select({});
            toast(`已删除父级；${kids.length} 个直接子元素在当前帧保位`, 'success');
          }
        });
      } else if (mode === 'all') {
        const ops = descendants.map((k) => ({ op: 'objectRemove', id: k.id }));
        ops.push({ op: 'objectRemove', id: o.id });
        op(...ops).then((j) => {
          if (j) { select({}); toast(`已删除「${name}」及 ${descendants.length} 个后代元素`, 'success'); }
        });
      }
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish('cancel');
    };
    window.addEventListener('keydown', onKey, true);
    close.onclick = () => finish('cancel');
    cancel.onclick = () => finish('cancel');
    keep.onclick = () => finish('keep');
    all.onclick = () => finish('all');
    modal.addEventListener('pointerdown', (e) => { if (e.target === modal) finish('cancel'); });
    cancel.focus();
  };

  const elementMenu = (id, x, y) => {
    const o = (S.project.scene?.objects || []).find((ob) => ob.id === id);
    if (!o) return;
    const kidsCount = childrenOf(S.project, id).length;
    const at = writeTime();
    const pose = objectWorldPoseWithLinks(S.project, o, S.time);
    const cam = (S.editMode && S.editCam) ? S.editCam : evalCameraWorldWithLinks(S.project, S.time);
    showContextMenu(x, y, [
      { label: '选中元素', icon: 'pointer', run: () => select({ objectId: id }) },
      {
        label: '面向镜头（在播放头打方向键）',
        icon: 'camera',
        run: () => {
          const d = [cam.pos[0] - pose.worldPos[0], cam.pos[1] - pose.worldPos[1], cam.pos[2] - pose.worldPos[2]];
          const l = Math.hypot(d[0], d[1], d[2]) || 1;
          const local = objectLocalVectorWithLinks(S.project, o, at, d.map((v) => v / l));
          // Three axis keys (docs/DESIGN-TRANSFORM-UNIFY.md §2): face `local`
          // and keep the current roll, each axis unwrapped near the current
          // angle. A first key also needs the base rotation, or the other axes
          // snap to 0 before/after this key.
          const linked = objectPoseWithLinks(S.project, o, at);
          const cur = Array.isArray(linked.rotation)
            ? linked.rotation
            : rotationFromDirRoll(linked.dir, linked.roll);
          const next = facingRotation(local, cur);
          const ops = [];
          if (!Array.isArray(o.rotation)) {
            const base = objectPose(o, at);
            ops.push({
              op: 'objectPatch',
              id,
              patch: {
                rotation: (Array.isArray(base.rotation)
                  ? base.rotation
                  : rotationFromDirRoll(base.dir, base.roll)).slice(),
              },
            });
          }
          ['x', 'y', 'z'].forEach((axis, i) => {
            const back = writeBackLocalValue(S.project, { host: 'ob', id }, `rotation.${axis}`, at, next[i]);
            const v = Number.isFinite(back) ? back : next[i];
            ops.push({ op: 'objectKey', id, path: `rotation.${axis}`, t: at, v: Math.round(v * 1e6) / 1e6 });
          });
          op(...ops);
        },
      },
      {
        label: '落地（在播放头打位置键）',
        icon: 'keyframe',
        run: () => {
          const h = Number(o.geom?.h) || 2;
          const worldPivot = [pose.pivot[0], h / 2, pose.pivot[2]];
          const local = objectLocalPointWithLinks(S.project, o, at, worldPivot);
          op({ op: 'objectKey', id, path: 'pivot', t: at, v: local.map((v) => Math.round(v * 100) / 100) });
        },
      },
      { label: '复制（含关键帧）', icon: 'copy', run: () => { duplicateObject(o); } },
      { sep: true },
      lockMenuItem('object', id),
      { sep: true },
      {
        label: kidsCount ? `删除父级…（${kidsCount} 子级）` : '删除元素', danger: true, icon: 'trash', kbd: 'Delete',
        run: () => requestObjectDelete(o),
      },
    ]);
  };
  const selected2D = () => {
    const pool = S.selection.pool;
    const ids = pool?.kind === 'element'
      ? pool.ids.map(splitRef).filter((r) => r?.type === 'el').map((r) => r.id)
      : [];
    if (!ids.length && S.selection.elementId) ids.push(S.selection.elementId);
    return [...new Set(ids)];
  };

  const selectedCameraId = () => {
    const pool = S.selection.pool;
    const ids = pool?.kind === 'element'
      ? pool.ids.map(splitRef).filter((r) => r?.type === 'cam').map((r) => r.id)
      : [];
    if (ids.length) return ids[0];
    return S.selection.camera && pool?.kind === 'element'
      ? (S.project?.activeCameraId || S.project?.camera?.id || null)
      : null;
  };

  /**
   * Cut one camera clip at the playhead. The right half becomes active (the
   * op does that), so the viewport stays continuous at the cut.
   */
  function splitCameraAtPlayhead(camId = null) {
    if (!S.project) return null;
    const id = camId || selectedCameraId();
    const cam = (S.project.cameras || []).find((c) => c.id === id);
    if (!cam) {
      toast('没有选中相机', 'warn');
      return null;
    }
    const at = writeTime();
    const range = cameraRange(S.project, cam);
    const can = at > range.start + 0.02 && at < range.end - 0.02;
    if (!can) {
      toast(`播放头不在镜头范围内（${range.start.toFixed(2)}–${range.end.toFixed(2)}s）`, 'warn');
      return null;
    }
    return op({ op: 'splitElement', id, at }).then((j) => {
      if (!j) return;
      const rightId = S.project?.activeCameraId;
      if (rightId) select({ camera: true, pool: selectOne('element', cameraRef(rightId)) });
      toast(`已在 ${at.toFixed(2)}s 切开镜头「${cam.name || cam.id}」`, 'success');
    });
  }

  /**
   * Cut at the playhead. With a selection, only the selected 2D elements that
   * cross the line are cut; with no selection, every crossing element is cut.
   * Each right half is inserted directly above its source by splitAt. A
   * selected camera is cut with the same key (its clip goes through
   * splitElement's camera branch).
   */
  function splitAtPlayhead(onlyIds = null) {
    if (!S.project) return null;
    if (!onlyIds) {
      const camId = selectedCameraId();
      if (camId) return splitCameraAtPlayhead(camId);
    }
    const at = writeTime();
    const selected = onlyIds ? onlyIds.filter(Boolean) : selected2D();
    const crosses = (e) => at > e.start + 0.02 && at < e.start + e.duration - 0.02;
    if (selected.length) {
      const ids = selected.filter((id) => {
        const el = S.project.elements.find((e) => e.id === id);
        return el && crosses(el);
      });
      if (!ids.length) {
        toast('播放头不在选中的元素范围内（或离两端太近）', 'warn');
        return null;
      }
      return op({ op: 'splitAt', at, ids }).then((j) => {
        if (!j) return;
        const rights = (j.changed || []).filter(Boolean);
        if (rights.length) {
          const pool = { kind: 'element', ids: rights.map(elementRef), primary: elementRef(rights[0]) };
          select({ elementId: rights[0], pool });
        }
        toast(`已在 ${at.toFixed(2)}s 切开 ${ids.length} 个元素`, 'success');
      });
    }
    if (S.selection.objectId || S.selection.camera) {
      toast('只能切开 2D 素材', 'warn');
      return null;
    }
    if (!S.project.elements.some(crosses)) {
      toast('红线没有经过可切开的元素', 'warn');
      return null;
    }
    return op({ op: 'splitAt', at }).then((j) => {
      if (!j) return;
      const rights = (j.changed || []).filter(Boolean);
      if (rights.length) {
        const pool = { kind: 'element', ids: rights.map(elementRef), primary: elementRef(rights[0]) };
        select({ elementId: rights[0], pool });
      }
      toast(`已在 ${at.toFixed(2)}s 切开 ${rights.length} 个元素`, 'success');
    });
  }

  /** Split one media element at the playhead and keep the right half selected. */
  const splitElementAt = (id) => splitAtPlayhead([id]);
  const toggleElementLoop = async (el) => {
    const loop = el.loop !== true;
    const patch = { loop };
    const source = sourceDurationOf(el) || await probeSourceDuration(el.src);
    if (source) {
      patch.meta = { ...(el.meta || {}), sourceDuration: source };
      if (!loop) {
        const max = Math.max(0.08, source - Math.max(0, Number(el.srcIn) || 0));
        if (el.duration > max + 1e-6) {
          patch.duration = Math.round(max * 1000) / 1000;
          toast('已关闭循环，长度收回到素材结尾', 'info');
        }
      }
    }
    op({ op: 'updateElement', id: el.id, patch });
  };
  const clipMenu = (id, x, y) => {
    const el = S.project?.elements?.find((e) => e.id === id);
    if (!el) return;
    const at = writeTime();
    const can = at > el.start + 0.02 && at < el.start + el.duration - 0.02;
    const isMedia = el.type === 'video' || el.type === 'audio';
    const feedSource = el.type === 'camfeed' ? normalizeFeed(el.feed).camera : '';
    const feedCam = feedSource ? cameraById(feedSource) : null;
    showContextMenu(x, y, [
      ...(el.type === 'camfeed' ? [{
        label: '跟随投屏来源', icon: 'camera', kbd: 'F5',
        disabled: !feedSource,
        title: feedSource ? `来源相机：${feedCam?.name || feedSource}` : '这块投屏还没有选择来源相机',
        run: () => followCamera(feedSource, { selectHost: true }),
      }] : []),
      {
        label: can ? `在播放头切分（${at.toFixed(2)}s）` : '在播放头切分（播放头不在素材内）',
        icon: 'scissors', kbd: 'S / Ctrl+D',
        disabled: !can,
        title: can ? '快捷键 Ctrl+D / S' : `素材范围 ${el.start.toFixed(2)}–${(el.start + el.duration).toFixed(2)}s`,
        run: () => { splitElementAt(id); },
      },
      { sep: true },
      { label: '选中素材', icon: 'pointer', run: () => select({ elementId: id }) },
      {
        label: '复制（Ctrl+C）',
        icon: 'copy', kbd: 'Ctrl+C',
        run: () => { copySelection([id]); },
      },
      ...(isMedia ? [{
        // a checkbox item: the check icon marks the on state (no ✓ text prefix)
        label: '开启循环', icon: el.loop ? 'check' : 'repeat',
        title: el.loop ? '关闭后长度最多到素材结尾' : '允许把长度拉到素材结尾之后，循环播放',
        run: () => toggleElementLoop(el),
      }] : []),
      { sep: true },
      lockMenuItem('element', el.id),
      { sep: true },
      {
        label: '删除素材',
        danger: true, icon: 'trash', kbd: 'Delete',
        run: () => {
          if (confirm(`删除 ${el.name || id}?`)) op({ op: 'removeElement', id });
        },
      },
    ]);
  };
  const cameraMenu = (id, x, y) => {
    const cam = (S.project.cameras || []).find((c) => c.id === id);
    if (!cam) return;
    const solo = S.soloCameras;
    const checked = solo.has(id);
    // A camfeed element shows this camera's picture; it is a normal 2D element
    // (move/scale/keyframes/spatial parent all work). Default clip = the camera
    // clip range, or the whole project when the camera is unbounded.
    const createCamfeed = async () => {
      const range = cameraRange(S.project, cam);
      const beforeIds = new Set(S.project.elements.map((e) => e.id));
      const created = await op({
        op: 'addElement',
        element: {
          type: 'camfeed',
          feed: { camera: cam.id, delay: 0 },
          start: range.start,
          duration: Math.max(0.08, range.duration || S.project.meta.duration),
        },
      });
      const element = created?.element
        || S.project.elements.find((e) => !beforeIds.has(e.id) && e.type === 'camfeed');
      if (element?.id) select({ elementId: element.id });
    };
    showContextMenu(x, y, [
      {
        label: checked ? '✓ 单独查看该相机（们）' : '单独查看该相机（们）',
        icon: checked ? 'eye-off' : 'eye',
        run: () => {
          if (checked) solo.delete(id); else solo.add(id);
          timeline.setSoloCameras(solo);
          preview.setSoloCameras(solo);
          preview.render(S.time);
        },
      },
      { label: '激活相机', icon: 'camera', run: () => { op({ op: 'activateCamera', id }); select({ camera: true }); } },
      { label: '跟随此相机', icon: 'camera', kbd: 'F5', run: () => { followCamera(id, { selectHost: true }); } },
      { label: '创建投屏元素', icon: 'film', run: () => { createCamfeed(); } },
      (() => {
        const at = writeTime();
        const range = cameraRange(S.project, cam);
        const can = at > range.start + 0.02 && at < range.end - 0.02;
        return {
          label: can ? `在播放头切分镜头（${at.toFixed(2)}s）` : '在播放头切分镜头（播放头不在镜头内）',
          icon: 'scissors', kbd: 'S / Ctrl+D',
          disabled: !can,
          title: can ? '快捷键 S / Ctrl+D' : `镜头范围 ${range.start.toFixed(2)}–${range.end.toFixed(2)}s`,
          run: () => splitCameraAtPlayhead(id),
        };
      })(),
      { sep: true },
      lockMenuItem('camera', cam.id),
      { sep: true },
      {
        label: '删除相机', danger: true, icon: 'trash',
        run: () => { if (confirm(`删除 ${cam.name || id}?`)) op({ op: 'removeCamera', id }); },
      },
    ]);
  };

  // Debounce for the range readout (a drag changes the range every frame).
  let rangeLogTimer = 0;
  timeline = new Timeline($('#timeline'), {
    // A scrub while playing keeps the transport running from the frame it
    // lands on; S.time is the snapped picture time, so the wall clock has to
    // restart there too (restarting from a raw `t` would make the next tick
    // jump between two frames).
    onSeek: (t) => {
      setTime(t);
      if (S.playing) {
        S.playFrom = S.time;
        S.playWall = performance.now();
        preview.setAudioTime(S.time);
      }
    },
    onSelect: (sel) => select(sel),
    onOp: (o) => op(o),
    onPause: () => pause(),
    onElementMenu: (id, x, y) => elementMenu(id, x, y),
    onCameraMenu: (id, x, y) => cameraMenu(id, x, y),
    onClipMenu: (id, x, y) => clipMenu(id, x, y),
    sourceDuration: (el) => sourceDurationOf(el),
    onSourceLimit: (side) => toast(side === 'start'
      ? '左边界不能早于素材开头'
      : '已到素材结尾；右键该素材勾选「开启循环」后可继续拉长', 'info'),
    onToast: (msg, level = 'info') => toast(msg, level),
    onLinkJump: (jump) => jumpToLinkParent(jump),
    onSplit: () => splitAtPlayhead(),
    onTextEdit: (kind, id, ev) => openTextEditor(kind, id, ev),
    onToggleCurves: () => toggleCurvePanel(),
    isCurvesOpen: () => !!curvePanel?.isOpen(),
    // The range is interface state (docs/DESIGN-WP2.5-REVIEW.md §10.6) and the
    // status bar has no slot of its own for it — #projMeta belongs to the
    // project — so it reports to the console only, debounced so a drag logs
    // once instead of once per frame. No new UI is invented for it.
    onRangeChange: (r) => {
      clearTimeout(rangeLogTimer);
      rangeLogTimer = setTimeout(() => {
        if (r) console.info(`时间范围 f${r.from}–f${r.to}（${r.to - r.from + 1} 帧）`);
        else console.info('时间范围已清除');
      }, 300);
    },
  });
  timeline.setProject(S.project);

  curvePanel = new CurvePanel($('#timeline'), {
    getTimeline: () => timeline,
    getProject: () => S.project,
    onOp: (o) => op(o),
    toast,
    // Live path-curve drag: the panel temporarily mutates the in-memory camera
    // path; redraw the stage and timeline without a round-trip/rev bump.
    onLivePreview: () => {
      timeline.render(true);
      preview.render(S.time);
      gizmo?.draw();
    },
    onSelect: (pool) => select({ elementId: null, segmentId: null, objectId: null, camera: false, pool }),
  });
  // keep the F2 drawer's x axis glued to the timeline while zooming/scrolling
  timeline.onViewChange = () => { if (curvePanel?.isOpen()) curvePanel.draw(); };
  // ...and its playhead line glued to the timeline's on every seek / playback tick
  timeline.onTimeChange = () => curvePanel?.syncTime();

  inspector = new Inspector($('#panelInsp'), {
    onOp: (o) => op(o),
    getTime: () => S.time,
    // The inspector's ↳ reuses the timeline drag wire and target highlighting.
    onStartParentDrag: (ev, kind, host, btn) => timeline._startParentDrag(ev, kind, host, btn),
    onLinkJump: (jump) => jumpToLinkParent(jump),
    canGoBack: () => canGoBackLink(),
    onBack: () => goBackLink(),
    onToast: (msg, level = 'info') => toast(msg, level),
    onFollowCamera: (id) => followCamera(id, { selectHost: true }),
    onFlyToFeed: (id) => flyToFeed(id),
    // ◆ records what the property is at the playhead (its keyed value, or the base)
    getTimeValue: (path) => {
      const el = S.project.elements.find((e) => e.id === S.selection.elementId);
      if (!el) return 0;
      // Node elements key pivot.* / position.* / scale.* / roll; read the same
      // sampled node the preview draws so ◆ stores the value that is on screen.
      if (el.node) {
        const node = elementNodeAt(el, S.project.meta, S.time);
        if (path === 'roll') return node.roll;
        const dot = path.indexOf('.');
        if (dot > 0) {
          const group = path.slice(0, dot);
          const i = 'xyz'.indexOf(path.slice(dot + 1));
          if (i >= 0 && group === 'rotation') {
            const rot = Array.isArray(node.rotation)
              ? node.rotation
              : rotationFromDirRoll(node.dir, node.roll);
            if (Number.isFinite(Number(rot[i]))) return Number(rot[i]);
          } else if (i >= 0 && Array.isArray(node[group]) && Number.isFinite(Number(node[group][i]))) {
            return Number(node[group][i]);
          }
        }
      }
      const [a, b] = path.split('.');
      const base = a === 'transform' ? el.transform?.[b] : a === 'style' ? el.style?.[b] : a === 'fx' ? el.fx?.[b] : undefined;
      return sampleTrack(el.keyframes, path, S.time, base ?? 0);
    },
    onSelect: (sel) => select(sel),
    onSeek: (t) => { pause(); setTime(t); },
    analyzeBeats: async () => {
      toast('分析节拍中…');
      try { const j = await post('/api/beats', {}); toast(`${j.tempo} bpm · ${j.beats.length} 拍`, 'success'); } catch (e) { toast(e.message, 'error'); }
    },
    onRenderAll: async () => {
      try { await post('/api/render', { from: 0, to: S.project.meta.duration, scale: S.renderScale }); toast('开始渲染镜头'); } catch (e) { toast(e.message, 'error'); }
    },
    onRenderSegment: (id) => {
      const s = S.project.segments.find((x) => x.id === id);
      if (s) post('/api/render', { from: s.start, to: s.start + s.duration, scale: S.renderScale }).then(() => toast('开始渲染')).catch((e) => toast(e.message, 'error'));
    },
    onAskAI: (id) => {
      S.selection = { segmentId: id, elementId: null, objectId: null, camera: false, pool: emptySelection() };
      switchRightTab('ai');
      toast('在右侧写下让 AI 改什么');
    },
  });

  agentPanel = new AgentPanel($('#panelAI'), {
    getProject: () => S.project,
    getSelection: () => S.selection,
    getTime: () => S.time,
    captureAt: (t) => { preview.render(t); const d = preview.capture(); preview.render(S.time); return d; },
    toast,
    // A change-set card in the conversation jumps to its rows in 审阅 (§10.1-2).
    onOpenReview: (id) => { switchRightTab('review'); review.focus(id); },
  });
  agentPanel.setState({ available: S.agentAvailable, running: false });

  // 审阅 (WP2.5a): change sets come from the engine, not the AI panel's map.
  // Writes stay here so the panel never fetches a write route (DESIGN.md §10).
  review = new ReviewPanel($('#panelReview'), {
    getProject: () => S.project,
    getFps: () => projectFps(),
    toast,
    apply: (id) => applyChangeset(id),
    revert: (id) => revertChangeset(id),
    revertOne: (id, selector) => revertChangesetEntry(id, selector),
    enterPreview: (record) => enterPreview(record),
    exitPreview: () => exitPreview(),
    isPreviewing: () => !!S.previewShadow,
    previewId: () => S.previewShadow?.id || null,
    compare: (opts) => captureCompare(opts),
    onJump: (target) => jumpToChange(target),
    retryAI: (intent) => { switchRightTab('ai'); agentPanel.setDraft(intent); },
  });
  review.mount($('#panelReview'));

  logPanel = new LogPanel($('#panelLogs'), { toast });

  pipelinePanel = new PipelinePanel($('#panelPipe'), {
    getProject: () => S.project,
    getSelection: () => S.selection,
    getTime: () => S.time,
    getRenderScale: () => S.renderScale,
    renderActions,
    toast,
  });
  pipelinePanel.set(state);

  // tabs (persisted); 图层 (#panelLayers) is filled by the outliner
  document.querySelectorAll('[data-tabs="right"] button').forEach((b) => b.onclick = () => switchRightTab(b.dataset.tab));
  document.querySelectorAll('[data-tabs="left"] button').forEach((b) => b.onclick = () => switchLeftTab(b.dataset.tab));
  switchRightTab(prefs.get('rightTab', 'insp'));
  switchLeftTab(prefs.get('leftTab', 'media'));
  assetsPanel = new AssetsPanel($('#panelMedia'), {
    getProject: () => S.project,
    mediaKind,
    onAdd: (m, kind) => addMediaFile(m, kind),
    onSoundtrack: (m) => setSoundtrack(m),
    onList: (list) => { S.media = list; },
    onDragStart: (m, kind) => mediaDropApi?.begin(m, kind),
    onDragEnd: () => mediaDropApi?.end(),
    menu: (x, y, items) => showContextMenu(x, y, items),
    toast,
  });
  assetsPanel.refresh();
  outliner = new Outliner($('#panelLayers'), {
    getProject: () => S.project,
    getSelection: () => S.selection,
    getTime: () => S.time,
    select: (sel) => select(sel),
    activateCamera: (id) => timeline._activateCamera(id), // same path as a camera row click on the timeline
    reveal: (ref) => timeline.reveal?.(ref),
    seek: (t) => { pause(); setTime(t); },
  });
  mediaDropApi = initMediaDrop();
  statusBar.setCapabilities({ blender: S.blender, ffmpeg: state.ffmpeg, ai: S.agentAvailable });
  if (S.render) statusBar.setRender(S.render, { initial: true });

  // transport
  timecodeUI = new Timecode($('#timecode'), {
    getFps: () => S.project?.meta.fps || 24,
    onSeek: (t) => { pause(); setTime(t); },
  });
  $('#btnPlay').onclick = togglePlay;
  $('#btnFirst').onclick = () => { pause(); setTime(0); };
  $('#btnLast').onclick = () => { pause(); setTime(S.project?.meta.duration || 0); };
  $('#btnLoop').onclick = () => setLoop(!S.loop);
  $('#btnHelp').onclick = () => document.dispatchEvent(new CustomEvent('vdm:shortcuts'));

  // preview banner: accept / discard the change set being previewed, or leave.
  $('#pbExit').onclick = () => exitPreview();
  $('#pbAccept').onclick = async () => {
    const id = S.previewShadow?.id;
    if (!id) return;
    exitPreview();
    await review.accept(id);
  };
  $('#pbDiscard').onclick = async () => {
    const id = S.previewShadow?.id;
    if (!id) return;
    exitPreview();
    await review.discard(id);
  };
  setLoop(S.loop);
  setPlayButton(false);
  $('#btnPrev').onclick = () => stepFrames(-1);
  $('#btnNext').onclick = () => stepFrames(1);
  $('#btnUndo').onclick = async () => { try { const j = await post('/api/undo', {}); applyProject(j.project, 'undo'); } catch (e) { toast('没有可撤销的操作'); } };
  $('#btnRedo').onclick = async () => { try { const j = await post('/api/redo', {}); applyProject(j.project, 'redo'); } catch (e) { toast('没有可重做的操作'); } };
  $('#btnStill').onclick = () => renderActions.still(S.time);
  $('#btnRender').onclick = () => renderActions.master();
  $('#btnRenderMenu').onclick = (e) => showMenu(0, 0, renderMenuItems(), { anchor: e.currentTarget.parentElement });
  $('#btnViewEdit').onclick = () => { if (!S.editMode) setEditMode(true); };
  $('#btnViewCam').onclick = () => { if (S.editMode) setEditMode(false); };
  $('#followHint').onclick = () => { stopFollow(); };
  $('#btnCommand').onclick = () => document.dispatchEvent(new CustomEvent('vdm:command-palette'));
  // stage toolbar
  $('#viewMode').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setViewMode(b.dataset.mode); });
  $('#btnGrid').onclick = () => setGrid(!S.grid);
  $('#btnSafe').onclick = () => setSafeArea(!S.safeArea);
  setSafeArea(S.safeArea);
  syncViewControls();

  // Add a 3D element in front of the editing camera, then select it so it can
  // be dragged (which keys its pivot at the playhead). Besides primitives this
  // creates empty / image / video / 3D-text scene objects.
  const addSceneElement = async (kind = 'box') => {
    if (!S.project) return null;
    if (kind === 'pen') { toast('钢笔建模工具下一步接', 'warn'); return null; }
    let media = null;
    if (kind === 'image' || kind === 'video') {
      media = await pickMedia(kind);
      if (!media) return null;
    }
    if (!S.editMode) setEditMode(true);
    const c = S.editCam || evalCameraWorldWithLinks(S.project, S.time);
    const fwd = v3norm(v3sub(c.look, c.pos));
    const right = v3norm(v3cross(fwd, [0, 1, 0]));
    const up = v3cross(right, fwd);
    const n = (S.project.scene?.objects?.length || 0) + 1;
    // stagger new elements so they do not stack at the same spot
    const ox = ((n - 1) % 3 - 1) * 9;
    const oy = -Math.floor((n - 1) / 3) * 5;
    const dist = kind === 'image' || kind === 'video' ? 26 : kind === 'text' ? 24 : 30;
    const base = [c.pos[0] + fwd[0] * dist, c.pos[1] + fwd[1] * dist, c.pos[2] + fwd[2] * dist];
    const pivot = base.map((v, i) => Math.round((v + right[i] * ox + up[i] * oy) * 100) / 100);
    const labels = { box: '立方体', cylinder: '圆柱', empty: '空元素', image: '图片', video: '视频', text: '3D 文字' };
    const label = labels[kind] || '立方体';
    // Images/text are single-sided: turn their front towards the camera that
    // is placing them, otherwise the viewport/Blender show a mirrored back.
    const facing = { dir: fwd.map((v) => -v), roll: 0 };
    const common = { name: `${label} ${n}`, pivot };
    let object;
    if (kind === 'empty') {
      object = { ...common, type: 'empty', geom: { w: 1, h: 1, d: 1 } };
    } else if (kind === 'image' || kind === 'video') {
      object = {
        ...common, type: kind, name: media.name, src: media.path, srcIn: 0, rate: 1, rot: facing,
        geom: { w: 10, h: 5.6, d: 0.1 },
        style: { fit: 'contain', uv: [0, 0, 1, 1], emissive: 1, opacity: 1 },
      };
    } else if (kind === 'text') {
      object = {
        ...common, type: 'text', geom: { w: 4, h: 2, d: 0.2 }, rot: facing,
        style: {
          text: '新文字', size: 2.4, color: '#ffffff', font: 'SimHei', align: 'center',
          tracking: 0, lineHeight: 1.2, extrude: 0.08, emissive: 1,
        },
      };
    } else {
      object = {
        ...common,
        type: 'solid', primitive: kind,
        geom: kind === 'cylinder' ? { w: 4, h: 6, d: 4 } : { w: 8, h: 4, d: 0.5 },
        style: { color: '#17d9ff', emissive: 1 },
      };
    }
    const tips = {
      empty: '已添加空元素；可把其它元素挂到它下面',
      image: '已添加图片平面；属性面板「内容」里可换素材和适配',
      video: '已添加视频平面；属性面板「内容」里可换素材、入点和速度',
      text: '已添加 3D 文字；属性面板「内容」里可改文字、字号和字体',
    };
    // Same insertion path as 2D rows: playhead start, 5s, above the selection,
    // one batch that also extends the project and persists the row order.
    const id = await insertTimelineRow({
      object,
      start: timeline.playheadStart(),
      duration: 5,
      note: tips[kind] || `已添加${label}；拖动它会在当前时间打位置关键帧`,
    });
    if (!id) return null;
    if (kind === 'text') {
      const ta = $('#panelInsp textarea');
      if (ta) { ta.focus(); ta.select(); }
    }
    return id;
  };

  const createCamera = async () => {
    if (!S.project) return null;
    let view = (S.editMode && S.editCam)
      || (S.project.camera ? evalCameraWorldWithLinks(S.project, S.time) : null)
      || preview.scene3d.lastCam;
    if (!view) {
      // Unified space guarantees a default camera on load/create, but keep a
      // stable fallback for an old in-memory project.
      const dc = defaultCamera(S.project.meta);
      view = { pos: dc.path[0].pos.slice(), look: dc.path[0].look.slice(), fov: dc.fov, roll: 0 };
    }
    const rnd = (v) => Math.round(v * 100) / 100;
    const at = writeTime();
    const cam = {
      name: `相机 ${(S.project.cameras?.length || 0) + 1}`,
      fov: view.fov ?? 62,
      roll: view.roll ?? 0,
      center: [0, 0, 0],
      path: [{ t: at, pos: view.pos.map(rnd), look: view.look.map(rnd) }],
    };
    const j = await op({ op: 'addCamera', camera: cam });
    if (!j) return null;
    select({ camera: true });
    toast('已从当前视口新建相机并激活', 'success');
    return j.project?.activeCameraId || null;
  };

  // top-left tools: select / new camera / new 3D (long-press submenu)
  const tool3DMenu = $('#tool3DMenu');
  const hideToolMenu = () => { if (tool3DMenu) tool3DMenu.hidden = true; };
  $('#toolSelect').onclick = () => {
    $('#toolSelect').classList.add('on');
    if (!S.editMode && S.project?.camera) setEditMode(true);
    setViewMode('select');
  };
  $('#toolCamera').onclick = () => { hideToolMenu(); createCamera(); };
  $('#toolText').onclick = () => { hideToolMenu(); add2DElement('text'); };
  $('#toolShape').onclick = () => { hideToolMenu(); add2DElement('shape'); };
  $('#tool3D').onclick = (e) => {
    e.stopPropagation();
    if (tool3DMenu) tool3DMenu.hidden = !tool3DMenu.hidden;
  };
  tool3DMenu?.querySelectorAll('button').forEach((b) => {
    const kind = b.dataset.primitive || b.dataset.add;
    b.onclick = () => { hideToolMenu(); addSceneElement(kind); };
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('.tool-wrap')) hideToolMenu();
  });

  projects = new ProjectsPanel({ toast });
  $('#btnProject').onclick = (e) => showMenu(0, 0, [
    { label: '打开项目…', icon: 'folder', kbd: 'Ctrl+O', run: () => projects.open() },
    { label: '新建项目…', icon: 'plus', run: () => projects.newProject() },
    window.vdmDesktop ? { label: '打开文件夹…', icon: 'folder', run: () => projects.browse() } : null,
    { sep: true },
    { label: '重启引擎', icon: 'refresh', kbd: 'Ctrl+Shift+R', run: () => projects.restart() },
  ], { anchor: e.currentTarget });

  // ---------- 3D viewport: path nodes, handles, orbit, look ----------
  const stageXY = (e) => {
    const r = canvas.getBoundingClientRect();
    const kx = canvas.width / Math.max(1, r.width);
    const ky = canvas.height / Math.max(1, r.height);
    return { sx: (e.clientX - r.left) * kx, sy: (e.clientY - r.top) * ky, cx: e.clientX, cy: e.clientY };
  };
  let drag = null;
  /** Column-major 4x4 * point (used for the screen-lock carry). */
  const applyMat4 = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
  /** Inverse of a column-major 3x3 linear block applied to v. */
  const invertMat3 = (m, v) => {
    const a = m[0], b = m[4], c = m[8];
    const d = m[1], e = m[5], f = m[9];
    const g = m[2], h = m[6], i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return v.slice();
    const k = 1 / det;
    return [
      k * (e * i - f * h) * v[0] + k * (c * h - b * i) * v[1] + k * (b * f - c * e) * v[2],
      k * (f * g - d * i) * v[0] + k * (a * i - c * g) * v[1] + k * (c * d - a * f) * v[2],
      k * (d * h - e * g) * v[0] + k * (b * g - a * h) * v[1] + k * (a * e - b * d) * v[2],
    ];
  };
  // Write a value straight into the in-memory track so the viewport previews a
  // drag before the op lands (the op rewrites the same key on pointerup).
  const setLiveKey = (obj, path, v) => {
    const t = writeTime();
    const tracks = obj.tracks || (obj.tracks = {});
    const list = tracks[path] || (tracks[path] = []);
    const k = list.find((x) => Math.abs(x.t - t) < 1e-3);
    const val = Array.isArray(v) ? v.slice() : v;
    if (k) k.v = val;
    else { list.push({ t, v: val }); list.sort((a, b) => a.t - b.t); }
  };
  // Ctrl while dragging snaps to half a metre.
  const snap3 = (v, e) => (e?.ctrlKey ? v.map((n) => Math.round(n * 2) / 2) : v);
  const camCenter = (cam, t) => cameraTransform(cam, t).center;
  const camWorldKey = (cam, key) => v3add(camCenter(cam, key.t), key.pos);

  // ---- 2D element values / viewport drag ----
  const elPathBase = (el, path) => {
    const prop = path.slice(path.lastIndexOf('.') + 1);
    const v = path.startsWith('transform.') ? el?.transform?.[prop] : undefined;
    return v == null ? ((prop === 'scale' || prop === 'opacity') ? 1 : 0) : Number(v);
  };
  const elValue = (el, path, t) => sampleTrack(el?.keyframes, path, t, elPathBase(el, path));
  const elKeyed = (el, path) => (el?.keyframes || []).some((k) => k.path === path);
  /** Live write for a viewport drag: keys stay keys, unkeyed values move the base. */
  const setElLive = (el, path, t, value) => {
    const prop = path.slice(path.lastIndexOf('.') + 1);
    if (elKeyed(el, path)) {
      const list = el.keyframes || (el.keyframes = []);
      const at = Math.round(t * 1000) / 1000;
      const k = list.find((x) => x.path === path && Math.abs(x.t - at) < 1e-3);
      if (k) k.value = value;
      else {
        list.push({ t: at, path, value, ease: 'easeInOut' });
        list.sort((a, b) => a.t - b.t);
      }
      return;
    }
    el.transform = { ...(el.transform || {}), [prop]: value };
  };

  const nodeMenu = (index) => {
    const key = S.project.camera?.path?.[index];
    if (!key) return [];
    const items = [
      { label: `跳到 ${key.t.toFixed(2)}s`, run: () => setTime(key.t) },
      { label: '删除这个关键点', danger: true, run: () => { gizmo.sel = -1; op({ op: 'cameraRemove', t: key.t }); } },
    ];
    if (key.in || key.out) {
      items.push({
        label: '重置曲线手柄',
        run: () => { key.in = null; key.out = null; commitCameraPath(); gizmo.draw(); },
      });
    }
    items.push({ sep: true });
    items.push({ label: '选中相机', run: () => select({ camera: true }) });
    items.push({ label: '切换到移动相机 (Alt)', run: () => setViewMode('move') });
    return items;
  };
  const canvasMenu = () => [
    { label: '选中相机', run: () => select({ camera: true }) },
    {
      label: '在当前时间打点',
      run: () => {
        const pos = pathPos(S.project.camera, S.time).map((v) => Math.round(v * 100) / 100);
        op({ op: 'cameraKey', t: writeTime(), pos });
      },
    },
    { sep: true },
    { label: '切换到移动相机 (Alt)', run: () => setViewMode('move') },
  ];
  // Right-click on the live lens (a time with no key): key it here, or grab it.
  const liveMenu = () => [
    {
      label: '在当前时间打点',
      run: () => {
        const pos = pathPos(S.project.camera, S.time).map((v) => Math.round(v * 100) / 100);
        op({ op: 'cameraKey', t: writeTime(), pos });
      },
    },
    {
      label: '视口对齐到当前镜头',
      run: () => {
        if (!S.editCam) return;
        const c = evalCameraWorldWithLinks(S.project, S.time);
        S.editCam = { pos: c.pos.slice(), look: c.look.slice(), roll: c.roll || 0, fov: c.fov };
        preview.editCam = S.editCam;
        preview.render(S.time);
        gizmo.draw();
      },
    },
    { label: '选中相机', run: () => select({ camera: true }) },
    { sep: true },
    { label: '切换到移动相机 (Alt)', run: () => setViewMode('move') },
  ];

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!S.editMode || S.viewMode !== 'select') return;
    const { sx, sy } = stageXY(e);
    const hit = gizmo?.hit(sx, sy);
    const live = hit ? null : gizmo?.hitLive(sx, sy);
    if (hit) {
      gizmo.sel = hit.index;
      const key = S.project.camera?.path?.[hit.index];
      if (key) { setTime(key.t); select({ camera: true }); }
      gizmo.draw();
      showContextMenu(e.clientX, e.clientY, nodeMenu(hit.index));
    } else if (live) {
      gizmo.liveSel = true;
      gizmo.sel = -1;
      select({ camera: true });
      gizmo.draw();
      showContextMenu(e.clientX, e.clientY, liveMenu());
    } else {
      showContextMenu(e.clientX, e.clientY, canvasMenu());
    }
  });

  /**
   * Select and start dragging a 2D element on its depth plane. Used both by the
   * edit viewport and by the normal camera preview, so a new colour block can
   * be moved without first pressing Tab.
   *
   * Parented ("screen-locked") elements are rendered through a carry matrix
   * (camera motion + pull-in scale). We intersect the pointer ray with the
   * rendered plane and invert that matrix's linear part, so dragging a HUD
   * element follows the picture under camera rotation/zoom instead of the old
   * world plane at z.
   */
  const begin2DElementDrag = (elId, sx, sy, cx, cy, ev) => {
    const el = S.project.elements.find((e) => e.id === elId);
    const wasSelected = S.selection.elementId === elId
      && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
    select({ elementId: elId });
    if (!el) return false;
    pause();
    const z = elValue(el, 'transform.z', S.time);
    const elX = elValue(el, 'transform.x', S.time);
    const elY = elValue(el, 'transform.y', S.time);
    const cyW = (Number(S.project.meta.height) || 1080) / 200;
    // Screen lock is retired: every 2D element is a world plane. Drag on the
    // page plane (x right, y up) at its depth.
    const center = [elX / 100, cyW - elY / 100, z];
    const normal = [0, 0, 1];
    const hit = preview.scene3d?.planeHit(sx, sy, center, normal);
    if (hit) {
      drag = {
        kind: 'element', id: elId, z, hit, center, normal,
        elX, elY,
        x: elX,
        y: elY,
        keyedX: elKeyed(el, 'transform.x'),
        keyedY: elKeyed(el, 'transform.y'),
        backup: JSON.stringify(el),
        startCx: cx, startCy: cy,
        wasSelected,
      };
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
      updateOverlay();
      ev.preventDefault();
      return true;
    }
    drag = { kind: 'click', x: cx, y: cy };
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
    ev.preventDefault();
    return true;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    hideContextMenu();
    // Previewing shows a project that does not exist on disk: no drag may
    // mutate it in memory (the commit would be refused anyway).
    if (S.previewShadow) return;
    const { sx, sy, cx, cy } = stageXY(e);
    if (!S.editMode) {
      if (e.button === 0) {
        // §10.5: a locked element is transparent — the click lands on the first
        // unlocked one below it (or starts a marquee when there is none).
        const elId = unlockedElementAt(sx, sy);
        if (elId) {
          if (e.ctrlKey || e.metaKey || e.shiftKey) selectAt(sx, sy, e);
          else begin2DElementDrag(elId, sx, sy, cx, cy, e);
          return;
        }
        beginViewportMarquee(e);
      }
      return;
    }
    if (S.viewMode === 'move') {
      drag = { kind: e.button === 2 ? 'look' : 'orbit', button: e.button, x: cx, y: cy, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      e.preventDefault();
      return;
    }
    if (e.button === 2) return; // context menu
    const hit = gizmo?.hit(sx, sy);
    if (hit) {
      gizmo.sel = hit.index;
      gizmo.liveSel = false;
      const key = S.project.camera?.path?.[hit.index];
      const ac = preview.scene3d.lastCam;
      const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
      let other = null;
      let oppLen = 0;
      if (key && (hit.kind === 'out' || hit.kind === 'in')) {
        other = hit.kind === 'out' ? 'in' : 'out';
        const ow = gizmo.handleWorld(hit.index, other);
        const own = gizmo.handleWorld(hit.index, 'node');
        if (ow && own) oppLen = Math.hypot(ow[0] - own[0], ow[1] - own[1], ow[2] - own[2]);
      }
      drag = { kind: hit.kind, index: hit.index, other, oppLen, normal, x: cx, y: cy, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      if (hit.kind === 'node' && key) setTime(key.t);
      gizmo.draw();
      e.preventDefault();
      return;
    }
    const live = gizmo?.hitLive(sx, sy);
    if (live) {
      gizmo.liveSel = true;
      gizmo.sel = -1;
      select({ camera: true });
      pause();
      const ac = preview.scene3d.lastCam;
      const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
      drag = { kind: 'live', normal, x: cx, y: cy, moved: false, created: false, index: -1 };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      gizmo.draw();
      e.preventDefault();
      return;
    }
    // dragged pivot key of the selected element (edit its motion path in 3D)
    const okey = gizmo?.hitObjectKey(sx, sy);
    if (okey) {
      const obj = (S.project.scene?.objects || []).find((o) => o.id === gizmo.objSel);
      const key = obj?.tracks?.pivot?.[okey.index];
      if (obj && key) {
        pause();
        setTime(okey.t);
        select({ objectId: obj.id });
        const ac = preview.scene3d.lastCam;
        const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
        const pose = objectWorldPoseWithLinks(S.project, obj, okey.t);
        drag = {
          kind: 'objkey', id: obj.id, index: okey.index, keyT: okey.t,
          normal, hit: okey.world, world0: pose.pivot.slice(),
          pivot: key.v.slice(), backup: JSON.stringify(obj), x: cx, y: cy, moved: false,
        };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        gizmo.draw();
        e.preventDefault();
        return;
      }
    }
    // rotation ring: drag around the projected X/Y/Z ring at the pivot
    const rot = gizmo?.hitObjectRotation(sx, sy);
    if (rot) {
      const obj = (S.project.scene?.objects || []).find((o) => o.id === gizmo.objSel);
      if (obj) {
        pause();
        select({ objectId: obj.id });
        const pose = objectWorldPoseWithLinks(S.project, obj, S.time);
        const startRot = Array.isArray(pose.rotation)
          ? pose.rotation.slice()
          : rotationFromDirRoll(pose.dir, pose.roll);
        const k = gizmo.scale;
        const angle = Math.atan2(sy / k - rot.center[1], sx / k - rot.center[0]);
        gizmo.rotHover = rot.axis;
        drag = {
          kind: 'objrot', id: obj.id, axis: rot.axis, center: rot.center,
          startAngle: angle, lastAngle: angle, total: 0, startRot, next: startRot.slice(),
          keyed: (obj.tracks?.[`rotation.${rot.axis}`] || []).length > 0,
          backup: JSON.stringify(obj), x: cx, y: cy, moved: false,
        };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        gizmo.draw();
        e.preventDefault();
        return;
      }
    }
    // move-gizmo arrow: constrained drag along one world axis
    const ax = gizmo?.hitObjectAxis(sx, sy);
    if (ax) {
      const obj = (S.project.scene?.objects || []).find((o) => o.id === gizmo.objSel);
      if (obj) {
        const axisVec = [ax.axis === 'x' ? 1 : 0, ax.axis === 'y' ? 1 : 0, ax.axis === 'z' ? 1 : 0];
        const s0 = axisClosestS(preview.scene3d.ray(sx, sy), ax.pivot, axisVec);
        if (s0 != null) {
          pause();
          select({ objectId: obj.id });
          gizmo.axisHover = ax.axis;
          drag = {
            kind: 'objaxis', id: obj.id, axis: axisVec, p0: ax.pivot.slice(),
            s0, pivot: ax.pivot.slice(), backup: JSON.stringify(obj), x: cx, y: cy, moved: false,
          };
          try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
          gizmo.draw();
          e.preventDefault();
          return;
        }
      }
    }
    // 2D element in the 3D viewport: drag it on its own depth plane. The
    // screen delta is mapped to metres at the element's z, then back to pixels.
    // A locked element is passed through (§10.5).
    const elId = unlockedElementAt(sx, sy);
    if (elId) {
      begin2DElementDrag(elId, sx, sy, cx, cy, e);
      return;
    }
    // timeline element in the 3D scene: pick it and start a keyed move
    const pick = preview.scene3d?.pickObject(S.project, S.time, sx, sy);
    if (pick && !hostLocked('object', pick.id)) {
      const obj = (S.project.scene?.objects || []).find((o) => o.id === pick.id);
      const wasSelected = S.selection.objectId === pick.id
        && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      select({ objectId: pick.id });
      if (obj) {
        const ac = preview.scene3d.lastCam;
        const normal = ac ? v3norm(v3sub(ac.look, ac.pos)) : [0, 0, -1];
        const pose = objectWorldPoseWithLinks(S.project, obj, S.time);
        drag = {
          kind: 'object', id: obj.id, normal, hit: pick.point,
          world0: pose.pivot.slice(), pivot: pose.pivot.slice(),
          backup: JSON.stringify(obj), x: cx, y: cy, moved: false, wasSelected,
        };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        gizmo.draw();
        e.preventDefault();
        return;
      }
    }
    gizmo.objHover = null;
    gizmo.draw();
    beginViewportMarquee(e);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (drag) clearCompiledTracks();
    const { sx, sy, cx, cy } = stageXY(e);
    const r2 = (v) => Math.round(v * 100) / 100;
    if (!drag) {
      if (S.editMode) {
        if (S.viewMode === 'move') { canvas.style.cursor = 'grab'; return; }
        const hit = gizmo?.hit(sx, sy) || gizmo?.hitLive(sx, sy) || gizmo?.hitObjectKey(sx, sy);
        const axHit = hit ? null : gizmo?.hitObjectAxis(sx, sy);
        const rotHit = (hit || axHit) ? null : gizmo?.hitObjectRotation(sx, sy);
        const obj = (hit || axHit || rotHit) ? null : preview.scene3d?.pickObject(S.project, S.time, sx, sy);
        const elHit = (hit || axHit || rotHit || obj) ? null : unlockedElementAt(sx, sy);
        const hoverId = obj?.id || null;
        if (gizmo && (gizmo.objHover !== hoverId || gizmo.axisHover !== (axHit?.axis || null)
          || gizmo.rotHover !== (rotHit?.axis || null))) {
          gizmo.objHover = hoverId;
          gizmo.axisHover = axHit?.axis || null;
          gizmo.rotHover = rotHit?.axis || null;
          gizmo.draw();
        }
        canvas.style.cursor = hit || axHit || rotHit || obj || elHit ? 'pointer' : 'default';
        return;
      }
      const hit = S.selection.camera ? gizmo?.hit(sx, sy) : null;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      return;
    }
    if (drag.kind === 'look') {
      const dx = cx - drag.x, dy = cy - drag.y;
      drag.x = cx; drag.y = cy;
      if (S.editCam) {
        if (drag.button === 2) S.editCam.roll = clampNum(S.editCam.roll + dx * 0.25, -180, 180);
        else S.editCam.fov = clampNum(S.editCam.fov + dy * 0.2, 1, 360);
        preview.render(S.time);
        gizmo.draw();
      }
      return;
    }
    if (drag.kind === 'orbit') {
      const dx = cx - drag.x, dy = cy - drag.y;
      drag.x = cx; drag.y = cy;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      orbitEdit(dx, dy);
      preview.render(S.time);
      gizmo.draw();
      return;
    }
    if (drag.kind === 'element') {
      if (Math.abs(cx - drag.startCx) + Math.abs(cy - drag.startCy) < 3) return;
      const w = preview.scene3d?.planeHit(sx, sy, drag.center, drag.normal);
      if (!w) return;
      const el = S.project.elements.find((x) => x.id === drag.id);
      if (!el) return;
      // World delta on the page plane; x right / y up map straight to the
      // element's transform values now that no camera carry is folded in.
      const d = [w[0] - drag.hit[0], w[1] - drag.hit[1], w[2] - drag.hit[2]];
      const nx = drag.elX + d[0] * 100;
      const ny = drag.elY - d[1] * 100;
      const t = writeTime();
      setElLive(el, 'transform.x', t, nx);
      setElLive(el, 'transform.y', t, ny);
      drag.x = nx; drag.y = ny; drag.moved = true;
      preview.render(S.time);
      timeline?.setTime(S.time);
      updateOverlay();
      updateSelectionInfo();
      return;
    }
    if (drag.kind === 'click') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) > 3) drag.moved = true;
      return;
    }
    if (drag.kind === 'live') {
      if (!drag.created && Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 4) return;
      if (!drag.created) {
        const cam = S.project.camera;
        const t = writeTime();
        let key = cam.path.find((k) => Math.abs(k.t - t) < 1e-3);
        if (!key) {
          key = { t, pos: pathPos(cam, t).slice(), look: null, fov: null, ease: 'easeInOut', out: null, in: null };
          cam.path.push(key);
          cam.path.sort((a, b) => a.t - b.t);
        }
        const idx = cam.path.indexOf(key);
        if (e.shiftKey) {
          const prev = cam.path[idx - 1] || key;
          const next = cam.path[idx + 1] || key;
          const out = [
            (next.pos[0] - prev.pos[0]) / 6,
            (next.pos[1] - prev.pos[1]) / 6,
            (next.pos[2] - prev.pos[2]) / 6,
          ].map(r2);
          key.out = out;
          key.in = out.map((v) => -v);
        }
        drag.created = true;
        drag.index = idx;
        // the new node becomes the selection so its handles show right away
        gizmo.sel = idx;
        gizmo.liveSel = false;
      }
      const key = S.project.camera?.path?.[drag.index];
      if (!key) return;
      const w = preview.scene3d.planeHit(sx, sy, camWorldKey(S.project.camera, key), drag.normal);
      if (!w) return;
      key.pos = snap3(v3sub(w, camCenter(S.project.camera, key.t)).map(r2), e);
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      return;
    }
    if (drag.kind === 'objkey') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 3) return;
      const w = preview.scene3d.planeHit(sx, sy, drag.hit, drag.normal);
      if (!w) return;
      const obj = (S.project.scene?.objects || []).find((o) => o.id === drag.id);
      if (!obj) return;
      const target = snap3([
        r2(drag.world0[0] + w[0] - drag.hit[0]),
        r2(drag.world0[1] + w[1] - drag.hit[1]),
        r2(drag.world0[2] + w[2] - drag.hit[2]),
      ], e);
      drag.pivot = objectLocalPointWithLinks(S.project, obj, drag.keyT, target).map(r2);
      const key = obj.tracks?.pivot?.[drag.index];
      if (key) key.v = drag.pivot.slice();
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      updateSelectionInfo();
      timeline?.setTime(S.time);
      return;
    }
    if (drag.kind === 'objrot') {
      const k = gizmo?.scale || 1;
      const angle = Math.atan2(sy / k - drag.center[1], sx / k - drag.center[0]);
      let dA = angle - drag.lastAngle;
      if (dA > Math.PI) dA -= Math.PI * 2;
      if (dA < -Math.PI) dA += Math.PI * 2;
      drag.total += dA;
      drag.lastAngle = angle;
      if (Math.abs(drag.total) < 1e-4) return;
      const obj = (S.project.scene?.objects || []).find((o) => o.id === drag.id);
      if (!obj) return;
      const next = drag.startRot.slice();
      const i = 'xyz'.indexOf(drag.axis);
      next[i] = Math.round((drag.startRot[i] + (drag.total * 180) / Math.PI) * 100) / 100;
      drag.next = next;
      if (drag.keyed) setLiveKey(obj, `rotation.${drag.axis}`, next[i]);
      else obj.rotation = next;
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      updateSelectionInfo();
      return;
    }
    if (drag.kind === 'objaxis') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 2) return;
      const s = axisClosestS(preview.scene3d.ray(sx, sy), drag.p0, drag.axis);
      if (s == null) return;
      const delta = s - drag.s0;
      const obj = (S.project.scene?.objects || []).find((o) => o.id === drag.id);
      if (!obj) return;
      const target = snap3([
        r2(drag.p0[0] + drag.axis[0] * delta),
        r2(drag.p0[1] + drag.axis[1] * delta),
        r2(drag.p0[2] + drag.axis[2] * delta),
      ], e);
      drag.pivot = objectLocalPointWithLinks(S.project, obj, S.time, target).map(r2);
      setLiveKey(obj, 'pivot', drag.pivot);
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      updateSelectionInfo();
      timeline?.setTime(S.time);
      return;
    }
    if (drag.kind === 'object') {
      if (Math.abs(cx - drag.x) + Math.abs(cy - drag.y) < 3) return;
      const w = preview.scene3d.planeHit(sx, sy, drag.hit, drag.normal);
      if (!w) return;
      const obj = (S.project.scene?.objects || []).find((o) => o.id === drag.id);
      if (!obj) return;
      const target = snap3([
        r2(drag.world0[0] + w[0] - drag.hit[0]),
        r2(drag.world0[1] + w[1] - drag.hit[1]),
        r2(drag.world0[2] + w[2] - drag.hit[2]),
      ], e);
      drag.pivot = objectLocalPointWithLinks(S.project, obj, S.time, target).map(r2);
      setLiveKey(obj, 'pivot', drag.pivot);
      drag.moved = true;
      preview.render(S.time);
      gizmo.draw();
      updateSelectionInfo();
      timeline?.setTime(S.time);
      return;
    }
    const key = S.project.camera?.path?.[drag.index];
    if (!key) return;
    const world = camWorldKey(S.project.camera, key);
    const w = preview.scene3d.planeHit(sx, sy, world, drag.normal);
    if (!w) return;
    if (drag.kind === 'node') {
      key.pos = snap3(v3sub(w, camCenter(S.project.camera, key.t)).map(r2), e);
    } else {
      const v = [w[0] - world[0], w[1] - world[1], w[2] - world[2]];
      key[drag.kind] = v.map(r2);
      // default keeps the two handles collinear; Shift frees the dragged one
      if (!e.shiftKey && drag.other) {
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        const opp = drag.oppLen || l;
        key[drag.other] = [(-v[0] / l) * opp, (-v[1] / l) * opp, (-v[2] / l) * opp].map(r2);
      }
    }
    drag.moved = true;
    preview.render(S.time);
    gizmo.draw();
  });

  const endDrag = (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === 'node' || d.kind === 'out' || d.kind === 'in') {
      if (d.moved) commitCameraPath();
      gizmo.draw();
    } else if (d.kind === 'live') {
      if (d.created) commitCameraPath();
      gizmo.draw();
    } else if (d.kind === 'object') {
      if (d.moved && d.pivot) {
        op({
          op: 'objectKey', id: d.id, path: 'pivot',
          t: writeTime(), v: d.pivot,
        });
      } else if (d.wasSelected && !e?.ctrlKey && !e?.metaKey && !e?.shiftKey) {
        const obj = (S.project.scene?.objects || []).find((o) => o.id === d.id);
        if (!(e?.detail > 1 && obj?.type === 'text')) timeline?.toggleExpanded(d.id, 'object');
      }
      gizmo.draw();
    } else if (d.kind === 'objkey') {
      if (d.moved && d.pivot) {
        op({ op: 'objectKey', id: d.id, path: 'pivot', t: d.keyT, v: d.pivot });
      }
      gizmo.draw();
    } else if (d.kind === 'objrot') {
      if (d.moved && d.next) {
        const t = writeTime();
        if (d.keyed) {
          op({ op: 'objectKey', id: d.id, path: `rotation.${d.axis}`, t, v: d.next['xyz'.indexOf(d.axis)] });
        } else {
          op({ op: 'objectPatch', id: d.id, patch: { rotation: d.next } });
        }
      }
      gizmo.rotHover = null;
      gizmo.draw();
    } else if (d.kind === 'objaxis') {
      if (d.moved && d.pivot) {
        op({
          op: 'objectKey', id: d.id, path: 'pivot',
          t: writeTime(), v: d.pivot,
        });
      }
      gizmo.draw();
    } else if (d.kind === 'element') {
      if (d.moved) {
        const t = writeTime();
        const rx = Math.round(d.x * 100) / 100;
        const ry = Math.round(d.y * 100) / 100;
        const patch = {};
        const ops = [];
        if (d.keyedX) ops.push({ op: 'keySet', id: d.id, path: 'transform.x', t, value: rx });
        else patch.x = rx;
        if (d.keyedY) ops.push({ op: 'keySet', id: d.id, path: 'transform.y', t, value: ry });
        else patch.y = ry;
        if (Object.keys(patch).length) ops.push({ op: 'updateElement', id: d.id, patch: { transform: patch } });
        if (ops.length === 1) op(ops[0]);
        else if (ops.length > 1) op({ op: 'batch', ops });
      } else if (d.wasSelected && !e?.ctrlKey && !e?.metaKey && !e?.shiftKey) {
        const el = S.project.elements.find((x) => x.id === d.id);
        if (!(e?.detail > 1 && el?.type === 'text')) timeline?.toggleExpanded(d.id, 'element');
      }
      gizmo.draw();
      updateOverlay();
    } else if (d.kind === 'click' && !d.moved) {
      const { sx, sy } = stageXY(e);
      gizmo.sel = -1;
      gizmo.liveSel = false;
      gizmo.draw();
      selectAt(sx, sy, e);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  function cancelObjectDrag() {
    const d = drag;
    if (!d?.backup) return false;
    drag = null;
    const back = JSON.parse(d.backup);
    const target = d.kind === 'element'
      ? S.project?.elements?.find((x) => x.id === d.id)
      : (S.project?.scene?.objects || []).find((o) => o.id === d.id);
    if (target) {
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, back);
    }
    preview.render(S.time);
    timeline?.render(true);
    inspector?.render(S.project, S.selection, S.time);
    gizmo.draw();
    updateOverlay();
    updateSelectionInfo();
    return true;
  }
  canvas.addEventListener('pointercancel', () => { cancelObjectDrag(); drag = null; });

  // double-click a handle to drop it back to the automatic Catmull tangent;
  // double-click text (2D overlay or 3D text object) to edit its content
  canvas.addEventListener('dblclick', (e) => {
    if (S.editMode && S.viewMode === 'select') {
      const { sx, sy } = stageXY(e);
      const hit = gizmo?.hit(sx, sy);
      if (hit && (hit.kind === 'out' || hit.kind === 'in')) {
        const key = S.project.camera?.path?.[hit.index];
        if (!key) return;
        key[hit.kind] = null;
        commitCameraPath();
        gizmo.draw();
        return;
      }
    }
    const { sx, sy } = stageXY(e);
    const elId = unlockedElementAt(sx, sy);
    const el = elId ? S.project.elements.find((x) => x.id === elId) : null;
    if (el?.type === 'text') {
      openTextEditor('element', el.id, e);
      return;
    }
    // A camfeed is a normal 2D element, but double-clicking it is the shortcut
    // into its source camera. The topmost element wins, so text on the feed
    // still opens the text editor (DESIGN-TRANSFORM-UNIFY §1.4).
    if (el?.type === 'camfeed') {
      const source = normalizeFeed(el.feed).camera;
      if (source) { followCamera(source, { selectHost: true }); return; }
    }
    const pick = preview.scene3d?.pickObject(S.project, S.time, sx, sy);
    const obj = pick ? (S.project.scene?.objects || []).find((o) => o.id === pick.id) : null;
    if (obj?.type === 'text') openTextEditor('object', obj.id, e);
  });

  canvas.addEventListener('wheel', (e) => {
    if (!S.editMode || S.viewMode !== 'move') return;
    e.preventDefault();
    dollyEdit(Math.exp(e.deltaY * 0.0012));
    preview.render(S.time);
    gizmo.draw();
  }, { passive: false });

  // ---------- commands & keyboard (docs/DESIGN.md §7; registry in commands.js) ----------
  // Registration order = shortcut-sheet order. Key sets are disjoint, so the
  // order does not change which command a key reaches.
  initCommands({ toast });
  const anyCtrl = (e) => !!(e.ctrlKey || e.metaKey);
  const stepTime = (dt) => { pause(); setTime(S.time + dt); };

  // ↑/↓: the keyframe dots the timeline draws — 2D element `keyframes`, 3D
  // object tracks, camera path + parameter tracks — of the selection's hosts
  // (a selected property: only that property), or of everything.
  const keyTimesForJump = () => {
    const p = S.project;
    if (!p) return [];
    const cams = p.cameras?.length ? p.cameras : (p.camera ? [p.camera] : []);
    const objs = p.scene?.objects || [];
    const els = p.elements || [];
    const times = new Set();
    const addList = (list) => {
      for (const k of list || []) if (Number.isFinite(Number(k?.t))) times.add(Math.round(Number(k.t) * 1000) / 1000);
    };
    const addTracks = (tracks, path) => {
      for (const [name, list] of Object.entries(tracks || {})) {
        if (path == null || name === path || name.startsWith(`${path}.`)) addList(list);
      }
    };
    const addHost = (type, id, path = null) => {
      if (type === 'el') {
        addList((els.find((x) => x.id === id)?.keyframes || []).filter((k) => path == null || k.path === path));
      } else if (type === 'ob') {
        addTracks(objs.find((x) => x.id === id)?.tracks, path);
      } else if (type === 'cam') {
        const c = cams.find((x) => x.id === id) || (p.camera?.id === id ? p.camera : null);
        if (!c) return;
        if (path == null || path === 'path') addList(c.path);
        if (path !== 'path') addTracks(c.tracks, path);
      }
    };
    const pool = S.selection.pool;
    const refs = (pool?.ids || []).map(splitRef).filter(Boolean);
    if (refs.length) for (const r of refs) addHost(r.type, r.id, pool.kind === 'property' ? r.path : null);
    else if (S.selection.elementId) addHost('el', S.selection.elementId);
    else if (S.selection.objectId) addHost('ob', S.selection.objectId);
    else if (S.selection.camera && p.camera) addHost('cam', p.camera.id);
    else {
      for (const e of els) addHost('el', e.id);
      for (const o of objs) addHost('ob', o.id);
      for (const c of cams) addHost('cam', c.id);
    }
    return [...times].sort((a, b) => a - b);
  };
  const jumpKey = (dir, e) => {
    // keyboard focus inside the open 3D ▾ menu: arrows move between its items
    if (e && tool3DMenu && !tool3DMenu.hidden && tool3DMenu.contains(document.activeElement)) {
      e.preventDefault();
      const bs = [...tool3DMenu.querySelectorAll('button')];
      bs[(bs.indexOf(document.activeElement) + dir + bs.length) % bs.length]?.focus();
      return;
    }
    e?.preventDefault();
    pause();
    const ts = keyTimesForJump();
    const t = S.time;
    const hit = dir > 0 ? ts.find((x) => x > t + 1e-4) : ts.filter((x) => x < t - 1e-4).pop();
    if (hit != null) setTime(hit);
  };
  const hasSelection = () => !!(S.selection.elementId || S.selection.objectId || S.selection.camera || S.selection.pool?.ids?.length);

  // global: tried before the "typing in an input" check
  registerCommand({
    id: 'escape.drag', title: '取消拖动', group: '视口', keys: 'Escape', global: true, palette: false, sheet: false,
    when: () => !!drag,
    run: (e) => { if (drag && cancelObjectDrag()) { e?.preventDefault(); return; } return false; },
  });

  // 播放
  registerCommand({
    id: 'play.toggle', title: '播放 / 暂停', group: '播放', keys: 'Space', icon: 'play', keywords: 'play pause',
    match: (e) => e.code === 'Space',
    run: (e) => { e?.preventDefault(); togglePlay(); },
  });
  registerCommand({
    id: 'play.prevFrame', title: '上一帧', sheetTitle: '上一帧（Shift：后退 1s）', group: '播放', keys: 'ArrowLeft',
    icon: 'step-back', keywords: 'previous frame step back',
    match: (e) => e.key === 'ArrowLeft' && !e.altKey,
    run: (e) => { e?.preventDefault(); if (e?.shiftKey) stepTime(-1); else stepFrames(-1, { pauseFirst: true }); },
  });
  registerCommand({
    id: 'play.nextFrame', title: '下一帧', sheetTitle: '下一帧（Shift：前进 1s）', group: '播放', keys: 'ArrowRight',
    icon: 'step-fwd', keywords: 'next frame step forward',
    match: (e) => e.key === 'ArrowRight',
    run: (e) => { e?.preventDefault(); if (e?.shiftKey) stepTime(1); else stepFrames(1, { pauseFirst: true }); },
  });
  registerCommand({
    id: 'play.back1s', title: '后退 1 秒', group: '播放', keys: 'Shift+ArrowLeft', sheet: false, match: false,
    keywords: 'back second', run: () => stepTime(-1),
  });
  registerCommand({
    id: 'play.fwd1s', title: '前进 1 秒', group: '播放', keys: 'Shift+ArrowRight', sheet: false, match: false,
    keywords: 'forward second', run: () => stepTime(1),
  });
  registerCommand({
    id: 'play.first', title: '首帧', group: '播放', keys: 'Home', icon: 'skip-start', keywords: 'first start home',
    match: (e) => e.key === 'Home',
    run: () => { pause(); setTime(0); },
  });
  registerCommand({
    id: 'play.last', title: '末帧', group: '播放', keys: 'End', icon: 'skip-end', keywords: 'last end',
    match: (e) => e.key === 'End',
    run: () => { pause(); setTime(S.project?.meta.duration || 12); },
  });
  registerCommand({
    id: 'play.prevKey', title: '上一个关键帧', sheetTitle: '上一个关键帧（有选中时只看选中对象）', group: '播放', keys: 'ArrowUp',
    icon: 'keyframe', keywords: 'previous keyframe key',
    run: (e) => jumpKey(-1, e),
  });
  registerCommand({
    id: 'play.nextKey', title: '下一个关键帧', sheetTitle: '下一个关键帧（有选中时只看选中对象）', group: '播放', keys: 'ArrowDown',
    icon: 'keyframe', keywords: 'next keyframe key',
    run: (e) => jumpKey(1, e),
  });
  registerCommand({
    id: 'play.loop', title: '循环播放', group: '播放', keys: 'L', icon: 'repeat', keywords: 'loop repeat',
    match: (e) => e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey && !e.altKey,
    run: () => { setLoop(!S.loop); toast(S.loop ? '循环播放：开' : '循环播放：关'); },
  });

  // 编辑
  registerCommand({
    id: 'edit.undo', title: '撤销', group: '编辑', keys: 'Ctrl+Z', icon: 'undo', keywords: 'undo',
    match: (e) => anyCtrl(e) && e.key.toLowerCase() === 'z' && !e.shiftKey,
    run: (e) => { e?.preventDefault(); $('#btnUndo').click(); },
  });
  registerCommand({
    id: 'edit.redo', title: '重做', group: '编辑', keys: 'Ctrl+Shift+Z', icon: 'redo', keywords: 'redo',
    match: (e) => anyCtrl(e) && e.key.toLowerCase() === 'z' && e.shiftKey,
    run: (e) => { e?.preventDefault(); $('#btnRedo').click(); },
  });
  registerCommand({
    id: 'edit.copy', title: '复制选中元素', group: '编辑', keys: 'Ctrl+C', icon: 'copy', keywords: 'copy',
    match: (e) => anyCtrl(e) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString(),
    run: (e) => { e?.preventDefault(); copySelection(); },
  });
  registerCommand({
    id: 'edit.paste', title: '粘贴元素', group: '编辑', keys: 'Ctrl+V', keywords: 'paste',
    match: (e) => anyCtrl(e) && e.key.toLowerCase() === 'v',
    when: () => (readClipboard() ? true : '剪贴板里没有复制的元素'),
    run: (e) => { e?.preventDefault(); pasteClipboard(); },
  });

  /**
   * Everything Delete may remove right now: host refs of the element pool
   * (`el:` / `ob:` / `cam:`), or the legacy single-selection fields. The pool
   * owns the rule (core/selection.js) so a property / keyframe pool can never
   * fall back to the element behind it.
   */
  const deletableRefs = () => deletableElementRefs(S.project, S.selection);

  /**
   * Remove every picked element in ONE batch (one save, one Ctrl+Z step).
   * `el:` -> removeElement, `cam:` -> removeCamera, `ob:` -> objectRemove.
   * A lone 3D object keeps the parent-aware dialog; once several refs are in
   * play, children of a deleted parent are unparented at the playhead (the
   * dialog's "keep in place" policy) so nothing dangles.
   */
  const deleteRefs = (refs) => {
    const splits = refs.map(splitRef).filter(Boolean);
    if (splits.length === 1 && splits[0].type === 'ob') {
      const obj = (S.project?.scene?.objects || []).find((o) => o.id === splits[0].id);
      if (obj) requestObjectDelete(obj);
      return;
    }
    const at = writeTime();
    const ops = [];
    let cams = 0;
    for (const s of splits) {
      if (s.type === 'el') ops.push({ op: 'removeElement', id: s.id });
      else if (s.type === 'cam') { ops.push({ op: 'removeCamera', id: s.id }); cams += 1; }
    }
    const obs = splits.filter((s) => s.type === 'ob').map((s) => s.id);
    for (const id of obs) {
      for (const kid of childrenOf(S.project, id)) ops.push({ op: 'objectUnparent', id: kid, t: at });
    }
    for (const id of obs) ops.push({ op: 'objectRemove', id });
    if (!ops.length) return;
    select({});
    op(ops.length === 1 ? ops[0] : { op: 'batch', ops }).then((j) => {
      if (!j) return;
      // Silent for a single clip (it visibly leaves the timeline); multi and
      // camera deletes say what happened and how to take it back.
      if (refs.length > 1) toast(`已删除 ${refs.length} 个元素 · Ctrl+Z 可撤销`, 'success');
      else if (cams) toast('已删除相机 · Ctrl+Z 可撤销', 'success');
    });
  };
  registerCommand({
    id: 'edit.delete', title: '删除选中', sheetTitle: '删除选中（关键帧优先；多选一次删完）', group: '编辑', keys: 'Delete / Backspace',
    icon: 'trash', keywords: 'delete remove',
    match: (e) => e.key === 'Delete' || e.key === 'Backspace',
    keyBlocked: 'toast',
    when: () => {
      const pool = S.selection.pool;
      if (pool?.kind === 'keyframe') return pool.ids.length ? true : '先选中要删除的关键帧或元素';
      // A property row is a pointer into the host, not the host itself:
      // deleting it must never remove the element it belongs to.
      if (pool?.kind === 'property') return '选中的是属性行——Delete 只删元素、相机或关键帧';
      return deletableRefs().length ? true : '先选中要删除的元素或关键帧';
    },
    run: (e) => {
      const pool = S.selection.pool;
      // A keyframe pool wins over the host the key belongs to: Delete removes
      // the selected keyframes, not the whole camera/object.
      if (pool?.kind === 'keyframe' && pool.ids.length) {
        const ops = keyframeDeleteOps(pool.ids, S.project);
        if (ops.length) {
          e?.preventDefault();
          select({});
          op(ops.length === 1 ? ops[0] : { op: 'batch', ops });
        }
        return;
      }
      const refs = deletableRefs();
      if (!refs.length) return;
      e?.preventDefault();
      deleteRefs(refs);
    },
  });
  registerCommand({
    id: 'edit.split', title: '切开选中', sheetTitle: '在播放头切开选中元素 / 相机', group: '编辑', keys: 'S',
    icon: 'scissors', keywords: 'split cut',
    match: (e) => e.key === 's' && !e.ctrlKey,
    when: () => (S.selection.elementId || selectedCameraId() ? true : '先选中元素或相机'),
    run: (e) => {
      e?.preventDefault();
      if (S.selection.elementId) splitElementAt(S.selection.elementId);
      else splitCameraAtPlayhead(selectedCameraId());
    },
  });
  registerCommand({
    id: 'edit.splitAll', title: '在播放头切开', sheetTitle: '在播放头切开（无选中时切开所有跨线元素）', group: '编辑', keys: 'Ctrl+D',
    icon: 'scissors', keywords: 'split cut all playhead',
    match: (e) => anyCtrl(e) && e.key.toLowerCase() === 'd',
    run: (e) => { e?.preventDefault(); splitAtPlayhead(); },
  });
  registerCommand({ id: 'add.text', title: '新建文字', group: '编辑', icon: 'text', keywords: 'new text add', run: () => $('#toolText').click() });
  registerCommand({ id: 'add.shape', title: '新建色块', group: '编辑', icon: 'square', keywords: 'new shape solid add', run: () => $('#toolShape').click() });
  registerCommand({ id: 'add.camera', title: '新建相机', group: '编辑', icon: 'camera', keywords: 'new camera add', run: () => $('#toolCamera').click() });
  for (const [kind, title, ic, kw] of [
    ['box', '新建立方体', 'box', 'cube box 3d'], ['cylinder', '新建圆柱', 'cylinder', 'cylinder 3d'],
    ['empty', '新建空元素', 'empty', 'empty null 3d'], ['image', '新建图片…', 'image', 'image picture 3d'],
    ['video', '新建视频…', 'video', 'video 3d'], ['text', '新建 3D 文字', 'text', 'text 3d'],
  ]) {
    registerCommand({ id: `add.3d.${kind}`, title, group: '编辑', icon: ic, keywords: `new add ${kw}`, run: () => addSceneElement(kind) });
  }
  registerCommand({ id: 'edit.deselect', title: '清除选中', group: '编辑', keywords: 'deselect clear selection', when: () => hasSelection() || '没有选中的对象', run: () => clearSelection() });
  // 锁定 / 解锁 (WP2.5b §10.5): same title as the timeline / viewport menus.
  registerCommand({
    id: 'edit.toggleLock', title: '锁定 / 解锁', group: '编辑', icon: 'lock',
    keywords: 'lock unlock pin protect agent',
    when: () => !!lockTarget() || '先选中一个元素',
    run: () => { const target = lockTarget(); if (target) toggleLock(target.kind, target.id); },
  });

  // 视口
  registerCommand({
    id: 'view.toggleEdit', title: '编辑视口 / 镜头视角', group: '视口', keys: 'Tab', icon: 'camera', keywords: 'edit viewport camera view',
    match: (e) => e.key === 'Tab',
    run: (e) => { e?.preventDefault(); setEditMode(!S.editMode); },
  });
  registerCommand({
    id: 'view.follow', title: '跟随选中的相机', group: '视口', keys: 'F5', icon: 'camera',
    keywords: 'follow camera feed tracking', keyBlocked: 'toast',
    match: (e) => e.key === 'F5',
    when: () => !!selectedCameraId() || '先选中一台相机',
    run: (e) => { e?.preventDefault(); followCamera(selectedCameraId()); },
  });
  registerCommand({
    id: 'view.feedHints', title: '高亮投屏（按住）', sheetTitle: '按住高亮投屏', group: '视口',
    keys: 'F3', match: false, palette: false,
  });
  registerCommand({
    id: 'view.selectMove', title: '选择 / 移动', sheetTitle: '编辑视口内 选择 / 移动', group: '视口', keys: 'Alt', icon: 'move',
    keywords: 'select move orbit fly',
    match: (e) => e.key === 'Alt' && !e.repeat,
    when: () => S.editMode || '先按 Tab 进编辑视口',
    keyBlocked: 'toast',
    run: (e) => { e?.preventDefault(); setViewMode(S.viewMode === 'select' ? 'move' : 'select'); },
  });
  registerCommand({
    id: 'view.fly', title: '移动态飞行', sheetTitle: '移动态飞行（+Shift 加速；这些键此时不触发 S 切开等快捷键）', group: '视口', keys: 'W / A / S / D / Q / E',
    match: false, palette: false,
  });
  registerCommand({
    id: 'view.grid', title: '网格', group: '视口', keys: 'G', icon: 'grid', keywords: 'grid',
    match: (e) => e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey,
    run: () => setGrid(!S.grid),
  });
  registerCommand({
    id: 'view.selectTool', title: '选择工具', group: '视口', keys: 'V', icon: 'pointer', keywords: 'select tool pointer',
    run: (e) => { e?.preventDefault(); $('#toolSelect').click(); },
  });
  registerCommand({
    id: 'view.addMenu', title: '添加菜单（3D）', sheetTitle: '添加菜单（3D ▾；移动态下不响应）', group: '视口', keys: 'Shift+A', icon: 'cube',
    keywords: 'add 3d menu new',
    when: () => !(S.editMode && S.viewMode === 'move') || '移动态下 Shift+A 让给飞行，先按 Alt 回选择',
    run: (e) => {
      e?.preventDefault();
      if (!tool3DMenu) return;
      tool3DMenu.hidden = false;
      tool3DMenu.querySelector('button')?.focus();
    },
  });
  registerCommand({ id: 'view.safeArea', title: '安全框', group: '视口', icon: 'safe-frame', keywords: 'safe area frame', run: () => setSafeArea(!S.safeArea) });

  // 时间轴
  registerCommand({
    id: 'tl.keyedOnly', title: '只看带键属性', group: '时间轴', keys: 'U', icon: 'filter', keywords: 'keyed filter properties',
    match: (e) => e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey && !e.altKey,
    run: (e) => { if (timeline?.applyKeyedFilter()) { e?.preventDefault(); return; } return false; },
  });
  registerCommand({
    id: 'nav.backLink', title: '返回上一个属性面板', sheetTitle: '返回上一个属性面板（属性父级跳转后）', group: '面板', keys: 'Alt+←',
    icon: 'step-back', keywords: 'back return parent link panel',
    match: (e) => e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft',
    run: (e) => { if (!goBackLink()) return false; e?.preventDefault(); },
  });
  registerCommand({
    id: 'tl.curves', title: '曲线面板', group: '时间轴', keys: 'F2', icon: 'curve', keywords: 'curve graph editor', global: true,
    match: (e) => e.key === 'F2',
    // F2 works even while a value field is focused (it is not a text key).
    run: (e) => { e?.preventDefault(); toggleCurvePanel(); },
  });
  registerCommand({
    id: 'tl.filter', title: '聚焦时间轴筛选框', group: '时间轴', keys: 'Ctrl+F', icon: 'search', keywords: 'filter find search timeline',
    run: (e) => { e?.preventDefault(); timeline?.focusFilter?.(); },
  });
  registerCommand({
    id: 'tl.zoom', title: '缩放 / 适应', group: '时间轴', keys: 'Ctrl+滚轮 / Ctrl+拖标尺 / 双击标尺', match: false, palette: false,
  });
  // 时间范围（WP2.5d）：界面状态，不写工程、不进撤销（docs/DESIGN-WP2.5-REVIEW.md §10.6）。
  // I / O take the playhead's frame, like Premiere / Resolve; flying in move
  // mode owns the single-key keys, so the range keys stay quiet there.
  const rangeFps = () => Number(S.project?.meta.fps) || 24;
  const rangeKeyIdle = () => !(S.editMode && S.viewMode === 'move') || '移动态下不设置范围';
  registerCommand({
    id: 'range.in', title: '设置范围起点', group: '时间轴', keys: 'I', keywords: 'range in start mark',
    when: rangeKeyIdle,
    run: (e) => {
      if (!timeline) return false;
      e?.preventDefault();
      timeline.setRangeIn(Math.round(S.time * rangeFps()));
    },
  });
  registerCommand({
    id: 'range.out', title: '设置范围终点', group: '时间轴', keys: 'O', keywords: 'range out end mark',
    when: rangeKeyIdle,
    run: (e) => {
      if (!timeline) return false;
      e?.preventDefault();
      timeline.setRangeOut(Math.round(S.time * rangeFps()));
    },
  });

  // 面板
  registerCommand({
    id: 'ui.palette', title: '命令面板', group: '面板', keys: 'Ctrl+K', icon: 'command', keywords: 'command palette', global: true, palette: false,
    run: (e) => { e?.preventDefault(); openPalette(); },
  });
  registerCommand({
    id: 'ui.shortcuts', title: '快捷键速查', group: '面板', keys: '?', icon: 'help', keywords: 'shortcuts keys help',
    run: (e) => { e?.preventDefault(); openShortcuts(); },
  });
  registerCommand({
    id: 'proj.open', title: '打开项目', group: '面板', keys: 'Ctrl+O', icon: 'folder', keywords: 'open project',
    match: (e) => anyCtrl(e) && !e.shiftKey && e.key.toLowerCase() === 'o',
    run: (e) => { e?.preventDefault(); projects.open(); },
  });
  registerCommand({ id: 'proj.new', title: '新建项目', group: '面板', icon: 'plus', keywords: 'new project', run: () => projects.newProject() });
  registerCommand({
    id: 'proj.browse', title: '打开文件夹', group: '面板', icon: 'folder', keywords: 'open folder browse',
    when: () => !!window.vdmDesktop || '只有桌面版能打开文件夹', run: () => projects.browse(),
  });
  registerCommand({
    id: 'proj.restart', title: '重启引擎', group: '面板', keys: 'Ctrl+Shift+R', icon: 'refresh', keywords: 'restart engine reload',
    match: (e) => anyCtrl(e) && e.shiftKey && e.key.toLowerCase() === 'r',
    run: (e) => { e?.preventDefault(); projects.restart(); },
  });
  registerCommand({
    id: 'ui.escape', title: '逐层退出', sheetTitle: '逐层退出（菜单 → 曲线面板 → 范围 → 选中 → 移动态 → 编辑视口）', group: '面板', keys: 'Escape',
    palette: false,
    match: (e) => e.key === 'Escape',
    run: (e) => {
      if (tool3DMenu && !tool3DMenu.hidden) { hideToolMenu(); $('#tool3D')?.focus(); e?.preventDefault(); return; }
      if (logDrawer?.close()) { e?.preventDefault(); return; }
      if (curvePanel?.isOpen()) { curvePanel.close(); e?.preventDefault(); return; }
      const menu = $('#ctxMenu');
      if (menu && !menu.hidden) { hideContextMenu(); return; }
      // The range clears before the selection (§10.6-3): one Escape undoes the
      // range only, the next one goes back to the usual layering.
      if (timeline?.getRange()) { timeline.clearRange(); e?.preventDefault(); return; }
      if (gizmo?.objSel) { clearSelection(); return; }
      if (S.editMode && S.viewMode === 'move') { setViewMode('select'); return; }
      if (S.editMode) { setEditMode(false); return; }
      return false;
    },
  });
  registerCommand({ id: 'render.master', title: '渲染成片', group: '面板', icon: 'film', keywords: 'render export master', run: () => renderActions.master() });
  registerCommand({ id: 'render.still', title: '预览帧', group: '面板', icon: 'photo', keywords: 'still frame render preview blender', run: () => renderActions.still(S.time) });
  registerCommand({ id: 'render.segment', title: '渲染当前段', group: '面板', icon: 'film', keywords: 'render segment', run: () => renderActions.segment() });
  registerCommand({
    id: 'render.cancel', title: '取消渲染', group: '面板', icon: 'stop', keywords: 'cancel render stop',
    when: () => !!S.render?.running || '没有进行中的渲染', run: () => renderActions.cancel(),
  });
  registerCommand({ id: 'render.scale50', title: '渲染分辨率 50%', group: '面板', keywords: 'render scale resolution half', run: () => renderActions.setScale(0.5) });
  registerCommand({ id: 'render.scale100', title: '渲染分辨率 100%', group: '面板', keywords: 'render scale resolution full', run: () => renderActions.setScale(1) });
  registerCommand({ id: 'ui.toggleLeft', title: '切换左栏', group: '面板', icon: 'chevron-left', keywords: 'left sidebar panel collapse', run: () => layout?.setCollapsed('left') });
  registerCommand({ id: 'ui.toggleRight', title: '切换右栏', group: '面板', icon: 'chevron-right', keywords: 'right sidebar panel collapse', run: () => layout?.setCollapsed('right') });
  for (const [side, tab, title, ic, kw] of [
    ['right', 'insp', '属性', 'sliders', 'inspector properties'], ['right', 'ai', 'AI', 'sparkles', 'ai agent chat'],
    ['right', 'review', '审阅', 'check', 'change set review changesets'],
    ['right', 'pipe', '渲染', 'film', 'render pipeline'], ['left', 'media', '资源', 'assets', 'media assets'],
    ['left', 'layers', '图层', 'layers', 'layers outliner'],
  ]) {
    registerCommand({
      id: `tab.${tab}`, title: `切到${title}`, group: '面板', icon: ic, keywords: `tab ${kw}`,
      run: () => {
        if (layout?.state?.[`${side}Collapsed`]) layout.setCollapsed(side, false);
        if (side === 'right') switchRightTab(tab); else switchLeftTab(tab);
      },
    });
  }
  registerCommand({ id: 'ui.logs', title: '日志', group: '面板', icon: 'terminal', keywords: 'logs log drawer', run: () => logDrawer.toggle() });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal:not([hidden])')) return;
    if (dispatchCommand(e, { phase: 'global' })) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    S.keys.add(e.code);
    // In fly mode WASD/QE (+Shift) belong to the editor camera only: S must not
    // also split at the playhead (key repeat would toast every failed split),
    // nor A / Shift+A / E reach their commands. Ctrl/⌘ combos (Ctrl+D…) still do.
    if (S.editMode && S.viewMode === 'move' && FLY_KEYS.has(e.code) && !e.ctrlKey && !e.metaKey) return;
    dispatchCommand(e);
  });

  // Hold `\` in a change-set preview: the stage shows the real project until
  // the key comes up (§10.2-4). Not while typing, not with a modifier.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backslash' || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '') || e.target?.isContentEditable) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    if (!S.previewShadow) return;
    e.preventDefault();
    setPreviewHold(true);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Backslash' || !S.previewHolding) return;
    setPreviewHold(false);
  });
  window.addEventListener('blur', () => {
    if (S.previewHolding) setPreviewHold(false);
  });

  // F3 is a hold-to-inspect key, not a command: show every camfeed plane while
  // it is down, including in the normal camera view (before Tab).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F3' || e.repeat) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    e.preventDefault();
    S.feedHints = true;
    updateOverlay();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'F3') return;
    S.feedHints = false;
    updateOverlay();
  });
  window.addEventListener('keyup', (e) => S.keys.delete(e.code));
  window.addEventListener('blur', () => {
    S.keys.clear();
    if (S.feedHints) { S.feedHints = false; updateOverlay(); }
  });

  // events
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => statusBar.setConnection('ok'));
  es.addEventListener('error', () => statusBar.setConnection(es.readyState === EventSource.CLOSED ? 'danger' : 'warn'));
  es.addEventListener('hello', async () => {
    const latest = await fetch('/api/project').then((response) => response.json()).catch(() => null);
    if (latest?.project) applyProject(latest.project, 'resync');
  });
  es.addEventListener('project', (e) => {
    const d = JSON.parse(e.data);
    applyProject(d.project, d.source);
    // A new revision can change (or invalidate) an accepted mark.
    refreshMarks();
  });
  // A change set was proposed / applied / reverted: refetch the marks (200ms).
  es.addEventListener('changeset', () => refreshMarks());
  es.addEventListener('render', (e) => {
    const d = JSON.parse(e.data);
    S.render = d;
    pipelinePanel.setRender(d);
    statusBar.setRender(d);
    if (d.done) toast('渲染完成', 'success');
    if (d.error) toast(`渲染失败: ${d.error}`, 'error');
  });
  es.addEventListener('agent', (e) => agentPanel.handleEvent(JSON.parse(e.data)));
  // A change set landed (agent, CLI, MCP or another window): the 审阅 list and
  // the AI card both read this one event, no polling (§10.2-1).
  es.addEventListener('changeset', (e) => {
    let data = null;
    try { data = JSON.parse(e.data); } catch { return; }
    agentPanel?.handleEvent?.({ type: 'changeset', action: data.action, record: data.record });
    review?.refresh?.();
  });
  es.addEventListener('pipeline', (e) => { S.pipeline = JSON.parse(e.data); pipelinePanel.set({ pipeline: S.pipeline, render: S.render }); });
  es.addEventListener('toast', (e) => { const d = JSON.parse(e.data); toast(d.message, d.level); });
  es.addEventListener('beats', () => toast('节拍已更新', 'success'));
  es.addEventListener('log', (e) => {
    try {
      const rec = JSON.parse(e.data);
      logPanel.append(rec);
      if (!logDrawer.isOpen()) statusBar.noteLog(rec);
    } catch { /* ignore */ }
  });

  // resize
  const ro = new ResizeObserver(() => fitStage());
  ro.observe($('#stageWrap'));
  // splitters resize the timeline without a window resize: re-layout it (and the F2 drawer)
  const tro = new ResizeObserver(() => {
    timeline.render(true);
    if (curvePanel?.isOpen()) curvePanel.draw();
  });
  tro.observe($('#timeline'));
  applyProject(S.project, 'boot');
  fitStage();
  setTime(0);
  // Change-set marks for the project we just opened (no-op on an engine that
  // does not serve /api/changesets yet: the fetch fails and paints nothing).
  refreshMarks({ immediate: true });
  if (new URLSearchParams(location.search).get('picker') === '1') {
    setTimeout(() => projects?.open(), 350);
  }

  // playback loop
  let last = performance.now();
  let lastDraw = 0;
  const loop = (now) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (S.playing) {
      // Two clocks (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §五). `clock` is the
      // wall clock since the play anchor: it alone decides whether the project
      // (or the followed shot) ended and when to wrap, and it is what the audio
      // runs on. Everything the eye sees is `pictureTime(clock)` — the frame
      // under the wall clock, so playback shows exactly the frames an export
      // renders instead of inventing a state between two of them.
      const clock = S.playFrom + (now - S.playWall) / 1000;
      const projectEnd = S.project?.meta.duration || 12;
      // Following a camera stops with its clip, even when loop is on: the
      // point of the follow is to watch that camera's shot, not the project.
      const cam = S.followCam ? cameraById(S.followCam) : null;
      const followEnd = cam ? Math.min(projectEnd, cameraRange(S.project, cam).end) : null;
      const limit = followEnd ?? projectEnd;
      if (clock >= limit) {
        if (S.loop && !cam) {
          // wrap to 0 and keep playing
          S.playFrom = 0;
          S.playWall = now;
          S.time = 0;
          timeline.setTime(0);
          updateTimecode(0);
          preview.playAudio(0);
        } else { setTime(limit); pause(); }
      } else {
        S.time = pictureTime(clock);
        timeline.setTime(S.time, { live: true });
        updateTimecode(S.time);
      }
    }
    if (S.project && (S.playing || S.editMode || now - lastDraw > 100)) {
      lastDraw = now;
      if (S.editMode) {
        syncFollowCam();
        flyEdit(dt);
      }
      preview.render(S.time);
      gizmo?.draw();
      updateOverlay();
      updateSelectionInfo();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__vdm = {
    S, preview, timeline, inspector, gizmo, projects, op, toast, curvePanel,
    openCurvePanel: () => openCurvePanel(),
    setTime: (t) => setTime(t),
    select: (s) => select(s),
    setEditMode: (on) => setEditMode(on),
    setViewMode: (m) => setViewMode(m),
    followCamera: (id) => followCamera(id),
    stopFollow: () => stopFollow(),
    flyToFeed: (id) => flyToFeed(id),
    setFeedHints: (on) => { S.feedHints = !!on; updateOverlay(); },
    selectedCameraId: () => selectedCameraId(),
    runCommand: (id) => runCommand(id),
    addElement: addSceneElement,
    add2DElement: (kind) => add2DElement(kind),
    addMediaFile: (m, kind, start) => addMediaFile(m, kind, start),
    pause: () => pause(),
    play: () => play(),
    // Change-set marks (WP2.5b): probes can force a refetch or read the result.
    refreshMarks: (opts) => refreshMarks({ immediate: true, ...(opts || {}) }),
    marksFor: (records, project = S.project) => marksFor(records, project, { fps: S.project?.meta?.fps || 24 }),
    renderActions,
    agentPanel, review, pipelinePanel, logPanel,
    layout,
    statusBar,
    logDrawer,
    setLoop: (on) => setLoop(on),
    setSafeArea: (on) => setSafeArea(on),
    setGrid: (on) => setGrid(on),
    switchRightTab: (n) => switchRightTab(n),
    switchLeftTab: (n) => switchLeftTab(n),
    enterPreview: (record) => enterPreview(record),
    exitPreview: () => exitPreview(),
    captureCompare: (opts) => captureCompare(opts),
    jumpToChange: (target) => jumpToChange(target),
  };
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f66;padding:24px">启动失败: ${e.message}\n${e.stack}</pre>`;
});
