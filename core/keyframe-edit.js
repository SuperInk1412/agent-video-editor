// Frame-quantized keyframe moves, shared by the timeline and the Node tests.
//
// Pure ESM: the renderer imports this module; it must never import renderer
// code. The frame helpers below are a core copy of
// app/renderer/js/timeline-math.js::frameIndex / frameKeyTimeForFrame (the
// integer-frame store-time fix, round-3 plan §5.1), so a drag preview and the
// ops it commits agree exactly. tests/keyframe-edit.test.mjs cross-checks the
// copy against timeline-math.
//
// A ref is `cam:id:path:t` / `ob:id:path:t` / `el:id:path:t` (core/selection.js).
// A move only changes time, never host or path:
//
//   element       keyRemove(old t) + keySet(new t)          value / ease / curve
//   camera path   cameraRemove(old t) + cameraKey(new t)    pos / look / fov / …
//   camera param  cameraParamUnkey + cameraParamKey         v / ease / curve
//   3D object     objectUnkey + objectKey per real track     value / ease / handles
//
// One drag returns every op inside one `batch`: one save, one undo step.
// Conflicts (two keys of one track landing on the same time, or on an
// unselected key) reject the whole move with `{ ops: [], error }` instead of
// letting an op silently overwrite a key.
import {
  splitRef, keyframeHost, objectKeyTracks, keyframeRef, roundT,
} from './selection.js';

// Round one key apart is 1e-4 s in core/selection.js and core/ops.js; keep the
// same tolerance so "the key at t" means the same thing everywhere.
const TIME_EPS = 1e-4;
// In frame units: `123/30 * 30` is 122.99999999999999 in IEEE. Copied from
// timeline-math.js together with the helpers below.
const FRAME_EPS = 1e-6;

const HOST_LABEL = { el: '元素', ob: '3D 对象', cam: '相机' };
const CURVE_HOST = { el: 'element', ob: 'object', cam: 'camera' };

const near = (a, b) => Math.abs(Number(a) - Number(b)) <= TIME_EPS;
const isNum = (v) => Number.isFinite(Number(v));
const keyTime = (key) => roundT(Number(key.t));

/** 24 default, at least 1 fps, integer (same rule as timeline-math.js). */
export function normalizeFps(fps) {
  return Math.max(1, Math.round(Number(fps) || 24));
}

/**
 * Frame number under `t`; clamps at 0 and floors with a frame-unit epsilon.
 * Core copy of timeline-math.js::frameIndex — keep the two in sync.
 */
export function frameIndex(t, fps) {
  const rate = normalizeFps(fps);
  const time = Math.max(0, Number(t) || 0);
  return Math.max(0, Math.floor(time * rate + FRAME_EPS));
}

/**
 * Time to store for frame `frame` so frameIndex(time, fps) still answers
 * `frame` after 3-decimal rounding: round the millisecond *up* (7/30 → 0.234,
 * not 0.233 which frameIndex reads as frame 6). Core copy of
 * timeline-math.js::frameKeyTimeForFrame.
 */
export function frameKeyTimeForFrame(frame, fps) {
  const rate = normalizeFps(fps);
  const f = Math.max(0, Math.floor(Number(frame) || 0));
  return Math.ceil((f * 1000) / rate) / 1000;
}

const emptyResult = (error = null) => ({
  ops: [], batch: null, moves: [], deltaFrames: 0, error,
});

const trackKeyOf = (type, id, path) => `${type}:${id}:${path}`;

/** Remember every real op track a ref touches, with the track's full key list. */
function ensureTrack(tracks, type, id, path, all) {
  const key = trackKeyOf(type, id, path);
  let track = tracks.get(key);
  if (!track) {
    track = { key, type, id, path, all: Array.isArray(all) ? all : [], moved: new Map() };
    tracks.set(key, track);
  }
  return track;
}

/** A moved key is identified by object identity: one pivot dot can cover 4 tracks. */
function markMoved(track, key, ref) {
  let entry = track.moved.get(key);
  if (!entry) {
    entry = { key, t: keyTime(key), newT: null, refs: new Set() };
    track.moved.set(key, entry);
  }
  entry.refs.add(ref);
}

const trackLabel = (track) => `${HOST_LABEL[track.type] || track.type} ${track.id} · ${track.path}`;

/**
 * Move every keyframe in `refs` by `deltaFrames` whole frames.
 *
 * @param {string[]} refs         keyframe refs (`el:id:path:t`, …)
 * @param {number}   deltaFrames  integer frames; fractional input is truncated
 * @param {object}   project      current project (read only)
 * @param {number}   fps          project frame rate (default 24)
 * @returns {{ops: object[], batch: object|null, moves: object[], deltaFrames: number,
 *            error: string|null}}
 *   `moves` maps one input ref to `{ ref, refNew, t, to, type, id, path }` so the
 *   caller can preview and re-point its selection. `deltaFrames` is the effective
 *   (edge-clamped) delta. On any conflict `ops` is empty and `error` explains it.
 */
export function keyframeMoveOps(refs, deltaFrames, project, fps = 24) {
  const list = Array.isArray(refs) ? [...new Set(refs.map((r) => String(r)))] : [];
  if (!list.length) return emptyResult();
  const wanted = Math.trunc(Number(deltaFrames));
  if (!Number.isFinite(wanted) || wanted === 0) return emptyResult();

  const rate = normalizeFps(fps);
  const duration = Number(project?.meta?.duration);
  const tracks = new Map();
  // ref -> { ref, type, id, host, path(row), t, tracks:[...] }
  const byRef = new Map();

  for (const ref of list) {
    const s = splitRef(ref);
    if (!s || s.path == null || s.t == null) continue;
    const host = keyframeHost(project, s);
    if (!host) continue;
    const t = s.t;
    const hit = [];
    if (s.type === 'el') {
      const all = (host.keyframes || []).filter((k) => k.path === s.path);
      const key = all.find((k) => near(k.t, t));
      if (!key) continue;
      const track = ensureTrack(tracks, 'el', host.id, s.path, all);
      markMoved(track, key, ref);
      hit.push(track);
    } else if (s.type === 'ob') {
      // A pivot row's dot can stand for pivot + pivot.x/y/z at the same time.
      for (const name of objectKeyTracks(host, s.path, t)) {
        const all = host.tracks?.[name];
        if (!Array.isArray(all)) continue;
        const key = all.find((k) => near(k.t, t));
        if (!key) continue;
        const track = ensureTrack(tracks, 'ob', host.id, name, all);
        markMoved(track, key, ref);
        hit.push(track);
      }
      if (!hit.length) continue;
    } else if (s.path === 'path') {
      const all = host.path || [];
      const key = all.find((k) => near(k.t, t));
      if (!key) continue;
      const track = ensureTrack(tracks, 'cam', host.id, 'path', all);
      markMoved(track, key, ref);
      hit.push(track);
    } else {
      const all = host.tracks?.[s.path];
      if (!Array.isArray(all)) continue;
      const key = all.find((k) => near(k.t, t));
      if (!key) continue;
      const track = ensureTrack(tracks, 'cam', host.id, s.path, all);
      markMoved(track, key, ref);
      hit.push(track);
    }
    if (!byRef.has(ref)) {
      byRef.set(ref, { ref, type: s.type, id: host.id, host: s.host, path: s.path, t, tracks: hit });
    }
  }
  if (!byRef.size) return emptyResult();

  // Clamp the *delta*, not each landed time: a group stays evenly spaced and
  // stops as a block when its first/last key reaches 0 or the project end.
  let minFrame = Infinity;
  let maxFrame = -Infinity;
  for (const m of byRef.values()) {
    const f = frameIndex(m.t, rate);
    if (f < minFrame) minFrame = f;
    if (f > maxFrame) maxFrame = f;
  }
  const maxAllowed = Number.isFinite(duration) && duration >= 0 ? frameIndex(duration, rate) : null;
  const lo = -minFrame;
  const hi = maxAllowed == null ? Infinity : maxAllowed - maxFrame;
  const delta = Math.max(lo, Math.min(wanted, hi));
  if (delta === 0) return emptyResult();

  const newTime = (t) => {
    const next = frameKeyTimeForFrame(frameIndex(t, rate) + delta, rate);
    return duration > 0 ? Math.min(next, duration) : next;
  };

  const removes = [];
  const sets = [];
  const curves = [];

  for (const track of tracks.values()) {
    const entries = [...track.moved.values()];
    if (!entries.length) continue;

    // Camera path spans own the timing of their inner keys: moving any key of
    // a span (or into one) would silently retime the others, so v1 refuses.
    if (track.type === 'cam' && track.path === 'path') {
      const spans = [];
      for (const k of track.all) {
        if (!k.curve || !isNum(k.spanTo)) continue;
        const a = Number(k.t);
        const b = Number(k.spanTo);
        if (b > a + TIME_EPS) spans.push([a, b]);
      }
      for (const entry of entries) {
        if (entry.key.curve || isNum(entry.key.spanTo)) {
          return emptyResult(`相机路径的曲线段暂不支持移动关键帧（${track.id}）`);
        }
        for (const [a, b] of spans) {
          if (entry.t >= a - TIME_EPS && entry.t <= b + TIME_EPS) {
            return emptyResult(`相机路径的曲线段暂不支持移动关键帧（${track.id}）`);
          }
          entry.newT = newTime(entry.t);
          if (entry.newT >= a - TIME_EPS && entry.newT <= b + TIME_EPS) {
            return emptyResult(`相机路径的曲线段暂不支持移动关键帧（${track.id}）`);
          }
        }
      }
    }

    for (const entry of entries) {
      if (entry.newT == null) entry.newT = newTime(entry.t);
    }

    // One track cannot hold two keys at the same time: selected keys may not
    // collapse onto each other or onto a key that stays behind.
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (near(entries[i].newT, entries[j].newT)) {
          return emptyResult(`关键帧移动冲突：${trackLabel(track)} 有多个键落在 ${entries[i].newT.toFixed(3)}s`);
        }
      }
    }
    for (const key of track.all) {
      if (track.moved.has(key)) continue;
      const landed = entries.find((entry) => near(entry.newT, key.t));
      if (landed) {
        return emptyResult(`关键帧移动冲突：${trackLabel(track)} 在 ${keyTime(key).toFixed(3)}s 已有关键帧`);
      }
    }

    for (const entry of entries) {
      const key = entry.key;
      if (track.type === 'el') {
        removes.push({ op: 'keyRemove', id: track.id, path: track.path, t: entry.t });
        const next = { op: 'keySet', id: track.id, path: track.path, t: entry.newT, value: key.value };
        if (key.ease != null) next.ease = key.ease;
        sets.push(next);
      } else if (track.type === 'ob') {
        removes.push({ op: 'objectUnkey', id: track.id, path: track.path, t: entry.t });
        const next = { op: 'objectKey', id: track.id, path: track.path, t: entry.newT, v: key.v };
        if (key.ease != null) next.ease = key.ease;
        if (Array.isArray(key.out)) next.out = key.out;
        if (Array.isArray(key.in)) next.in = key.in;
        if (Array.isArray(key.speed)) next.speed = key.speed;
        sets.push(next);
      } else if (track.path === 'path') {
        removes.push({ op: 'cameraRemove', id: track.id, t: entry.t });
        const next = {
          op: 'cameraKey',
          id: track.id,
          t: entry.newT,
          pos: key.pos,
          look: key.look ?? null,
          fov: key.fov ?? null,
        };
        if (key.ease != null) next.ease = key.ease;
        if (Array.isArray(key.out) && key.out.length === 3) next.out = key.out;
        if (Array.isArray(key.in) && key.in.length === 3) next.in = key.in;
        if (Array.isArray(key.speed)) next.speed = key.speed;
        sets.push(next);
      } else {
        removes.push({ op: 'cameraParamUnkey', id: track.id, path: track.path, t: entry.t });
        const next = { op: 'cameraParamKey', id: track.id, path: track.path, t: entry.newT, v: key.v };
        if (key.ease != null) next.ease = key.ease;
        sets.push(next);
      }
    }

    // Value curves live on the left key of a segment. keySet / cameraParamKey
    // cannot carry them (they only inherit from a key at the *new* time), so
    // re-attach each moved curve to the segment that follows it after the move.
    if (!(track.type === 'cam' && track.path === 'path')) {
      for (const entry of entries) {
        if (!entry.key.curve) continue;
        const finals = track.all.map((k) => (track.moved.has(k) ? track.moved.get(k).newT : keyTime(k)));
        const next = finals
          .filter((t) => t > entry.newT + TIME_EPS)
          .sort((a, b) => a - b)[0];
        if (next == null) {
          return emptyResult(`关键帧带曲线，移动后没有下一段（${trackLabel(track)}）`);
        }
        curves.push({
          op: 'keyCurve',
          host: CURVE_HOST[track.type],
          id: track.id,
          path: track.path,
          from: entry.newT,
          to: next,
          curve: entry.key.curve,
        });
      }
    }
  }

  const moves = [...byRef.values()].map((m) => {
    const to = newTime(m.t);
    return {
      ref: m.ref,
      refNew: keyframeRef(m.host, m.path, to),
      type: m.type,
      id: m.id,
      path: m.path,
      t: m.t,
      to,
    };
  });
  const ops = [...removes, ...sets, ...curves];
  if (!ops.length) return emptyResult();
  return {
    ops,
    batch: { op: 'batch', ops },
    moves,
    deltaFrames: delta,
    error: null,
  };
}
