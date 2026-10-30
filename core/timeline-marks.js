// Timeline marks — where did a change set touch the project?
// docs/DESIGN-WP2.5-REVIEW.md §10.3 (WP2.5b): marks are typed, not one
// diamond on the smallest frame.
//
//   row    a whole-segment property changed (style.size, style.color …):
//          the host's timeline row gets a 2px bar and its clip an outline;
//   key    a keyframe changed: that diamond gets a ring;
//   ruler  something happened at a moment (a host was added / removed, its
//          start / duration / z moved): a diamond on the ruler frame.
//
// Applied records keep light marks (§10.3-2) until the user edits the same
// value by hand — an accepted entry whose recorded `after` no longer matches
// the current project is dropped here, so `refreshMarks` naturally forgets it.
//
// Pure ESM (no DOM, no node:*): the renderer paints the result, the unit tests
// read it.
import { roundT } from './selection.js';

/** Collections a mark can address, by the `kind` the diff uses. */
const HOSTS = { element: 'elements', camera: 'cameras', object: 'objects' };

/** Paths that move a host in time / in the layer stack: ruler marks, not rows. */
const TIME_PATHS = new Set(['start', 'duration', 'z']);

/** Keyframe object fields the diff addresses after the key's property path. */
const KEY_FIELDS = new Set(['value', 'ease', 'curve', 'v']);

const clampRate = (fps) => Math.max(1, Math.round(Number(fps) || 24));

const hostList = (project, kind) => {
  const name = HOSTS[kind];
  if (!name) return null;
  if (kind === 'object') return Array.isArray(project?.scene?.objects) ? project.scene.objects : null;
  return Array.isArray(project?.[name]) ? project[name] : null;
};

const findHost = (project, kind, id) => {
  const list = hostList(project, kind);
  return Array.isArray(list) ? list.find((host) => host?.id === id) || null : null;
};

/** Host start in seconds (cameras may not carry one). */
const hostStart = (host) => (Number.isFinite(Number(host?.start)) ? Number(host.start) : 0);

const stripField = (path) => {
  const parts = String(path || '').split('.');
  if (parts.length > 1 && KEY_FIELDS.has(parts[parts.length - 1])) parts.pop();
  return parts.join('.');
};

/**
 * Is this diff path a keyframe address? `keyframes[1.5].style.size.value` is
 * the element form; camera / object tracks are leaves like
 * `tracks.fov.0.v`, and a bare `keys[1].x` is the older shape.
 */
function isKeyframePath(path) {
  const p = String(path || '');
  if (p.startsWith('keyframes[') || p.startsWith('keyframes.')) return true;
  if (/^keys(\[|\.|$)/.test(p) || /\.keys(\[|\.)/.test(p)) return true;
  // 3D objects and camera parameters store keys in `tracks[path][i]`, so the
  // diff addresses them as `tracks.fov.0.v` / `tracks.pivot.0.t`.
  if (p.startsWith('tracks.')) return true;
  // A camera's flight path is an array: `path.0.pos`.
  if (/^path\.\d+/.test(p)) return true;
  return p.split('.').includes('t');
}

/**
 * `{ t, path }` for a keyframe diff entry, or null when the time is not in the
 * path (the caller records it in `skipped`). `path` is the property path a
 * `.tl-key` diamond carries in `data-path`.
 */
function keyframeOf(entry, host) {
  const path = String(entry?.path || '');
  const direct = /^(?:keyframes|keys)\[([^\]]+)\](?:\.(.*))?$/.exec(path);
  if (direct) {
    const t = Number(direct[1]);
    if (!Number.isFinite(t)) return null;
    return { t: roundT(t), path: stripField(direct[2] || '') };
  }
  // `tracks.<property>.<index>[.<field>]` — the index is not a time, so read it
  // off the host's track (the project is the authority, not the diff).
  const track = /^tracks\.(.+?)\.(\d+)(?:\.(.*))?$/.exec(path);
  if (track) {
    const keys = host?.tracks?.[track[1]];
    const key = Array.isArray(keys) ? keys[Number(track[2])] : null;
    const t = Number(key?.t);
    if (!Number.isFinite(t)) return null;
    return { t: roundT(t), path: track[1] };
  }
  // A camera's flight path is `path.<index>.<field>`.
  const flight = /^path\.(\d+)(?:\.(.*))?$/.exec(path);
  if (flight) {
    const key = host?.path?.[Number(flight[1])];
    const t = Number(key?.t);
    if (!Number.isFinite(t)) return null;
    return { t: roundT(t), path: 'path' };
  }
  // A bare `….t` leaf: the value itself is the time.
  const parts = path.split('.');
  if (parts.includes('t')) {
    const value = Number(entry?.after ?? entry?.before);
    if (!Number.isFinite(value)) return null;
    return { t: roundT(value), path: stripField(path) };
  }
  return null;
}

const same = (a, b) => {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' && typeof right !== 'object') return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

/** Walk a dotted path (`tracks.fov.0.v`); `{ ok, value }` (`ok:false` = unknown). */
function readDotted(root, path) {
  let cursor = root;
  for (const part of String(path || '').split('.')) {
    if (part === '') return { ok: false };
    if (cursor === null || cursor === undefined) return { ok: true, value: null };
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return { ok: false };
      cursor = cursor[Number(part)];
    } else if (typeof cursor === 'object') {
      if (!Object.hasOwn(cursor, part)) return { ok: true, value: null };
      cursor = cursor[part];
    } else {
      return { ok: false };
    }
  }
  return { ok: true, value: cursor === undefined ? null : cursor };
}

/** Current value of one diff address; `ok:false` when the address is unknown. */
function readPath(host, path) {
  const p = String(path || '');
  const match = /^keyframes\[([^\]]+)\](?:\.(.*))?$/.exec(p);
  if (!match) return readDotted(host, p);
  const t = roundT(Number(match[1]));
  const rest = match[2] || '';
  const keys = Array.isArray(host?.keyframes) ? host.keyframes : [];
  const near = keys.filter((key) => roundT(Number(key?.t)) === t);
  if (!near.length) return { ok: true, value: null };
  if (!rest) return { ok: true, value: near };
  let best = null;
  for (const key of near) {
    const keyPath = String(key?.path ?? '');
    if (rest !== keyPath && !rest.startsWith(`${keyPath}.`)) continue;
    if (!best || keyPath.length > String(best.path ?? '').length) best = key;
  }
  if (!best) return { ok: true, value: null };
  const keyPath = String(best.path ?? '');
  if (rest === keyPath) return { ok: true, value: best };
  const field = rest.slice(keyPath.length + 1);
  return { ok: true, value: best[field] === undefined ? null : best[field] };
}

/** The frame a mark sits on: `Math.round(seconds * fps)`, never negative. */
const frameOf = (seconds, rate) => Math.max(0, Math.round((Number(seconds) || 0) * rate));

/**
 * Marks for `records` against the current `project`.
 *
 * @param {Array<object>} records change set records (`proposed` / `applied` /
 *   `needs-decision`; anything else, e.g. `reverted`, is ignored)
 * @param {object} project the current project
 * @param {{ fps?: number }} [options] ruler rounding rate (default 24)
 * @returns {{ rows: object[], keys: object[], ruler: object[], accepted: object, skipped: object[] }}
 *   `rows` / `keys` / `ruler` are the pending marks; `accepted` holds the
 *   applied ones (`{ rows, keys, ruler }`) so they can be painted faintly.
 *   `skipped` explains every entry that could not be placed.
 */
export function marksFor(records, project, { fps = 24 } = {}) {
  const rate = clampRate(fps);
  const rows = new Map();
  const keys = new Map();
  const ruler = new Map();
  const aRows = new Map();
  const aKeys = new Map();
  const aRuler = new Map();
  const skipped = [];

  const addRow = (map, entry) => {
    const key = `${entry.kind}:${entry.id}`;
    if (!map.has(key)) map.set(key, { id: entry.id, kind: entry.kind, bar: true, outline: true });
  };
  const addKey = (map, entry) => {
    const key = `${entry.kind}:${entry.id}:${entry.path}:${roundT(entry.t)}`;
    if (!map.has(key)) map.set(key, { id: entry.id, kind: entry.kind, path: entry.path, t: roundT(entry.t) });
  };
  const addRuler = (map, frame) => {
    const at = map.get(frame);
    if (at) at.count += 1;
    else map.set(frame, { frame, count: 1 });
  };

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const status = String(record.status || '');
    const ack = status === 'applied';
    if (!ack && status !== 'proposed' && status !== 'needs-decision') continue;
    const changed = Array.isArray(record.changed) ? record.changed : [];
    const added = Array.isArray(record.added) ? record.added : [];
    const removed = Array.isArray(record.removed) ? record.removed : [];
    if (!changed.length && !added.length && !removed.length) continue;
    const rRows = ack ? aRows : rows;
    const rKeys = ack ? aKeys : keys;
    const rRuler = ack ? aRuler : ruler;

    for (const entry of changed) {
      if (!entry || typeof entry !== 'object') continue;
      const kind = String(entry.kind || '');
      const id = entry.id == null ? null : String(entry.id);
      const path = String(entry.path || '');
      if (!HOSTS[kind] || !id) {
        // Project-level leaves (`kind: 'project'`) have no timeline row.
        if (kind && kind !== 'project') skipped.push({ recordId: record.id, kind, id, path, reason: 'no timeline host for this kind' });
        continue;
      }
      const host = findHost(project, kind, id);
      if (!host) {
        skipped.push({ recordId: record.id, kind, id, path, reason: 'host no longer exists' });
        continue;
      }
      // §10.3-2: an accepted mark goes away once the user edits that value.
      if (ack && entry.after !== undefined) {
        const current = readPath(host, path);
        if (current.ok && !same(entry.after, current.value)) {
          skipped.push({ recordId: record.id, kind, id, path, reason: 'changed by hand after the change set' });
          continue;
        }
      }
      if (isKeyframePath(path)) {
        const key = keyframeOf(entry, host);
        if (!key) {
          skipped.push({ recordId: record.id, kind, id, path, reason: 'no keyframe time in this path' });
          continue;
        }
        addKey(rKeys, { id, kind, path: key.path, t: key.t });
        continue;
      }
      if (TIME_PATHS.has(path)) {
        const before = Number(entry.before);
        const after = Number(entry.after);
        const at = path === 'start' && Number.isFinite(before) && Number.isFinite(after)
          ? Math.min(before, after)
          : hostStart(host);
        addRuler(rRuler, frameOf(at, rate));
        continue;
      }
      addRow(rRows, { id, kind });
    }

    for (const entry of added) {
      if (!entry || typeof entry !== 'object') continue;
      const kind = String(entry.kind || '');
      const id = entry.id == null ? null : String(entry.id);
      if (!HOSTS[kind] || !id) continue;
      const host = findHost(project, kind, id);
      if (!host) {
        skipped.push({ recordId: record.id, kind, id, path: '', reason: 'host no longer exists' });
        continue;
      }
      addRuler(rRuler, frameOf(Number(entry.object?.start ?? hostStart(host)), rate));
    }

    for (const entry of removed) {
      if (!entry || typeof entry !== 'object') continue;
      const kind = String(entry.kind || '');
      const id = entry.id == null ? null : String(entry.id);
      if (!HOSTS[kind] || !id) continue;
      // A removed host is *expected* to be gone: the mark is the moment it left.
      addRuler(rRuler, frameOf(Number(entry.object?.start ?? 0), rate));
    }
  }

  // A pending mark is what the user still has to look at: when the same place
  // is also marked as applied, keep only the pending one.
  for (const key of rows.keys()) aRows.delete(key);
  for (const key of keys.keys()) aKeys.delete(key);
  for (const frame of ruler.keys()) aRuler.delete(frame);

  const byT = (a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id));
  return {
    rows: [...rows.values()],
    keys: [...keys.values()].sort(byT),
    ruler: [...ruler.values()].sort((a, b) => a.frame - b.frame),
    accepted: {
      rows: [...aRows.values()],
      keys: [...aKeys.values()].sort(byT),
      ruler: [...aRuler.values()].sort((a, b) => a.frame - b.frame),
    },
    skipped,
  };
}

export default marksFor;
