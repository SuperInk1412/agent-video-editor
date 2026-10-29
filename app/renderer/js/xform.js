// Shared transform-row semantics (docs/DESIGN-TRANSFORM-UNIFY.md §9).
//
// The timeline and the inspector both render the same four rows:
//
//   pivot (中心点) -> position (位置) -> rotation (旋转) -> scale (缩放)
//
// Each row has three cells. Rotation / scale / pivot can be authored per axis;
// position is the motion path and keeps whole-point keys. Cameras store the
// centre in `center` (links call it `pivot.*`) and the flight path in `path`;
// 3D objects keep `pivot` / `position` / `scale` tracks; 2D nodes key
// `pivot.* / scale.* / rotation.*` on the element itself.
//
// This module is the single place that answers:
//   * display value per axis (links applied)
//   * local value / key path behind each axis
//   * whether a row is whole-vector, per-axis or path-keyed right now
//   * which ops a row's ◆ / a sub-row's ◆ must send
//
// It is renderer-only (no node:*), and it reads the project the panel last
// rendered so a pending op cannot make the row disagree with the preview.
import { cameraTransform, pathPos } from '/core/camera.js';
import { cameraRotationAt } from '/core/spatial.js';
import { objectPose } from '/core/scene.js';
import { rotationFromDirRoll } from '/core/rotation.js';
import { cameraValueWithLinks, objectPoseWithLinks, writeBackLocalValue } from '/core/links.js';
import { elementNodeAt } from './node-at.js';
import { effectiveElementRowValue } from './element-link-value.js';
import { cameraRowLinkPaths, elementRowLinkPaths, objectRowLinkPaths } from './link-menu.js';

export const XF_AXES = ['x', 'y', 'z'];
export const XF_ROWS = [
  { key: 'pivot', label: '中心点' },
  { key: 'position', label: '位置' },
  { key: 'rotation', label: '旋转' },
  { key: 'scale', label: '缩放' },
];

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;
const finiteKeys = (list) => (Array.isArray(list) ? list.filter((k) => Number.isFinite(Number(k?.t))) : []);

function elementKeys(el, path) {
  return finiteKeys((el?.keyframes || []).filter((k) => k.path === path));
}

function trackKeys(host, kind, path) {
  if (kind === 'el') return elementKeys(host, path);
  if (kind === 'ob') return finiteKeys(host?.tracks?.[path]);
  if (path === 'path') return finiteKeys(host?.path);
  return finiteKeys(host?.tracks?.[path]);
}

/** Local (unlinked) values in storage units. */
export function xfLocalValues(project, host, kind, t) {
  if (kind === 'cam') {
    const tr = cameraTransform(host, t);
    const rot = cameraRotationAt(host, t);
    return {
      pivot: tr.center.slice(),
      position: pathPos(host, t).slice(),
      rotation: rot.slice(),
      scale: tr.scale.slice(),
      opacity: num(tr.opacity, 1),
    };
  }
  if (kind === 'el') {
    const node = elementNodeAt(host, project?.meta || {}, t) || {};
    const rot = Array.isArray(node.rotation) ? node.rotation.slice() : rotationFromDirRoll(node.dir, node.roll);
    return {
      pivot: [0, 1, 2].map((i) => num(node.pivot?.[i], 0)),
      position: [0, 1, 2].map((i) => num(node.position?.[i], 0)),
      rotation: [0, 1, 2].map((i) => num(rot[i], 0)),
      scale: [0, 1, 2].map((i) => num(node.scale?.[i], 1)),
      opacity: num(host?.transform?.opacity, 1),
    };
  }
  const pose = objectPose(host, t);
  const rot = Array.isArray(pose.rotation) ? pose.rotation.slice() : rotationFromDirRoll(pose.dir, pose.roll);
  return {
    pivot: pose.pivot.slice(),
    position: pose.position.slice(),
    rotation: rot,
    scale: pose.scale.slice(),
    opacity: num(pose.opacity, 1),
  };
}

/** Display values (property links applied) in the same units. */
export function xfValues(project, host, kind, t) {
  const local = xfLocalValues(project, host, kind, t);
  if (kind === 'cam') {
    return {
      pivot: XF_AXES.map((ax, i) => num(cameraValueWithLinks(project, host, `pivot.${ax}`, t), local.pivot[i])),
      position: local.position,
      rotation: XF_AXES.map((ax, i) => num(cameraValueWithLinks(project, host, `rotation.${ax}`, t), local.rotation[i])),
      scale: XF_AXES.map((ax, i) => num(cameraValueWithLinks(project, host, `scale.${ax}`, t), local.scale[i])),
      opacity: num(cameraValueWithLinks(project, host, 'opacity', t), local.opacity),
    };
  }
  if (kind === 'el') {
    const axis = (row, i) => num(
      effectiveElementRowValue(project, host, `${row}.${XF_AXES[i]}`, t, local[row][i]),
      local[row][i],
    );
    return {
      pivot: [0, 1, 2].map((i) => axis('pivot', i)),
      position: [0, 1, 2].map((i) => axis('position', i)),
      rotation: [0, 1, 2].map((i) => axis('rotation', i)),
      scale: [0, 1, 2].map((i) => axis('scale', i)),
      opacity: num(effectiveElementRowValue(project, host, 'transform.opacity', t, local.opacity), local.opacity),
    };
  }
  const pose = objectPoseWithLinks(project, host, t);
  const rot = Array.isArray(pose.rotation) ? pose.rotation.slice() : rotationFromDirRoll(pose.dir, pose.roll);
  return {
    pivot: pose.pivot.slice(),
    position: pose.position.slice(),
    rotation: rot,
    scale: pose.scale.slice(),
    opacity: num(pose.opacity, 1),
  };
}

/**
 * How this row is keyed right now.
 *   'axis'   three independent scalar tracks (the §9 target)
 *   'vector' one key stores all three values (pre-migration camera/object)
 *   'path'   camera flight path: one point stores all three values
 *   'base'   not keyable yet (2D position before the motion-path work)
 */
export function xfMode(host, kind, rowKey) {
  if (rowKey === 'position') {
    if (kind === 'cam') return 'path';
    if (kind === 'ob') return 'vector';
    return 'base';
  }
  if (rowKey === 'rotation') return 'axis';
  if (kind === 'cam') {
    const vectorName = rowKey === 'pivot' ? 'center' : 'scale';
    if (trackKeys(host, kind, vectorName).length) return 'vector';
    return XF_AXES.some((ax) => trackKeys(host, kind, `${vectorName}.${ax}`).length) ? 'axis' : 'vector';
  }
  if (kind === 'ob') {
    if (trackKeys(host, kind, rowKey).length) return 'vector';
    return 'axis';
  }
  return 'axis';
}

/** Key path of one axis. */
export function xfAxisPath(kind, rowKey, axis) {
  if (kind === 'cam' && rowKey === 'pivot') return `center.${axis}`;
  return `${rowKey}.${axis}`;
}

/** The one-path form of a vector row. */
export function xfVectorPath(kind, rowKey) {
  if (kind === 'cam') return rowKey === 'pivot' ? 'center' : rowKey;
  return rowKey;
}

/** Property-link target paths for the row's `↳` menu. */
export function xfLinkPaths(kind, host, rowKey) {
  if (rowKey === 'rotation') return XF_AXES.map((ax) => `rotation.${ax}`);
  // A camera's flight path is animation, not a linkable scalar (§9.1).
  if (kind === 'cam' && rowKey === 'position') return [];
  if (kind === 'cam') return cameraRowLinkPaths(rowKey === 'pivot' ? 'center' : rowKey);
  if (kind === 'ob') return objectRowLinkPaths(rowKey);
  if (kind === 'el') {
    if (!rowKey || rowKey === 'position') return [];
    return XF_AXES.map((ax) => elementRowLinkPaths(host, `${rowKey}.${ax}`)[0]).filter(Boolean);
  }
  return [];
}

/** Property-link target path of one sub-row axis (or null). */
export function xfAxisLinkPath(kind, host, rowKey, axis) {
  if (rowKey === 'rotation') return `rotation.${axis}`;
  if (kind === 'cam') {
    const paths = xfLinkPaths(kind, host, rowKey);
    const i = XF_AXES.indexOf(axis);
    return paths[i] || null;
  }
  if (kind === 'ob') return `${rowKey}.${axis}`;
  if (kind === 'el') return elementRowLinkPaths(host, `${rowKey}.${axis}`)[0] || null;
  return null;
}

function axisAt(host, kind, path, t, tol) {
  return trackKeys(host, kind, path).some((k) => Math.abs(Number(k.t) - t) <= tol);
}

function timesOf(host, kind, path) {
  return [...new Set(trackKeys(host, kind, path).map((k) => round3(k.t)))].sort((a, b) => a - b);
}

/** Key state of the whole row (the row-head ◆). */
export function xfKeyState(host, kind, rowKey, t, tol) {
  const mode = xfMode(host, kind, rowKey);
  if (mode === 'path') {
    const times = timesOf(host, kind, 'path');
    return { mode, at: times.some((x) => Math.abs(x - t) <= tol), has: times.length > 0, times };
  }
  if (mode === 'vector') {
    const path = xfVectorPath(kind, rowKey);
    const times = timesOf(host, kind, path);
    return { mode, at: times.some((x) => Math.abs(x - t) <= tol), has: times.length > 0, times };
  }
  if (mode === 'axis') {
    const lists = XF_AXES.map((ax) => timesOf(host, kind, xfAxisPath(kind, rowKey, ax)));
    const times = [...new Set(lists.flat())].sort((a, b) => a - b);
    const atList = lists.map((list) => list.some((x) => Math.abs(x - t) <= tol));
    return {
      mode,
      at: atList.every(Boolean),
      partial: atList.some(Boolean) && !atList.every(Boolean),
      has: times.length > 0,
      times,
      axisTimes: lists,
    };
  }
  return { mode, at: false, has: false, times: [] };
}

/** Key state of one expanded X/Y/Z sub-row. */
export function xfAxisKeyState(host, kind, rowKey, axis, t, tol) {
  const mode = xfMode(host, kind, rowKey);
  if (mode === 'base' || rowKey === 'position') {
    return { at: false, has: false, times: [] };
  }
  const path = xfAxisPath(kind, rowKey, axis);
  const times = timesOf(host, kind, path);
  return { at: times.some((x) => Math.abs(x - t) <= tol), has: times.length > 0, times, path };
}

/** Write one axis value back to the local (unlinked) channel; returns the local value. */
function localAxis(project, host, kind, rowKey, axis, value, t) {
  if (kind === 'cam') {
    const link = rowKey === 'pivot' ? `pivot.${axis}` : `${rowKey}.${axis}`;
    const back = writeBackLocalValue(project, { host: 'cam', id: host.id }, link, t, value);
    return num(back, value);
  }
  if (kind === 'ob') {
    const back = writeBackLocalValue(project, { host: 'ob', id: host.id }, `${rowKey}.${axis}`, t, value);
    return num(back, value);
  }
  const back = writeBackLocalValue(project, { host: 'el', id: host.id }, `${rowKey}.${axis}`, t, value);
  return num(back, value);
}

function keyOp(kind, host, path, t, value) {
  if (kind === 'cam') return { op: 'cameraParamKey', id: host.id, path, t, v: round3(value) };
  if (kind === 'ob') return { op: 'objectKey', id: host.id, path, t, v: round3(value) };
  return { op: 'keySet', id: host.id, path, t, value: round3(value) };
}

function unkeyOp(kind, host, path, t) {
  if (kind === 'cam') return { op: 'cameraParamUnkey', id: host.id, path, t };
  if (kind === 'ob') return { op: 'objectUnkey', id: host.id, path, t };
  return { op: 'keyRemove', id: host.id, path, t };
}

/** Batch or single op, matching the ops contract. */
export function bundleOps(ops) {
  const list = (ops || []).filter(Boolean);
  if (!list.length) return null;
  return list.length === 1 ? list[0] : { op: 'batch', ops: list };
}

function firstKeyAt(host, kind, path, t, tol) {
  return trackKeys(host, kind, path).find((k) => Math.abs(Number(k.t) - t) <= tol) || null;
}

/** Ops for the row-head ◆ (keys every axis of the row together). */
export function xfKeyOps(project, host, kind, rowKey, t) {
  const mode = xfMode(host, kind, rowKey);
  const local = xfLocalValues(project, host, kind, t)[rowKey].slice();
  if (mode === 'path') {
    return [{ op: 'cameraKey', id: host.id, t: round3(t), pos: local.map(round3) }];
  }
  if (mode === 'vector') {
    const path = xfVectorPath(kind, rowKey);
    // Local values are what a key stores; links are applied only for display.
    const value = local.map((v) => round3(v));
    return [kind === 'cam'
      ? { op: 'cameraParamKey', id: host.id, path, t, v: value }
      : { op: 'objectKey', id: host.id, path, t, v: value }];
  }
  if (mode === 'axis') {
    const ops = XF_AXES.map((ax, i) => keyOp(kind, host, xfAxisPath(kind, rowKey, ax), t, local[i]));
    // A first rotation key needs a full base triple; otherwise the other two
    // axes read 0 and the pose jumps on the way to the key.
    if (rowKey === 'rotation') {
      if (kind === 'el' && !Array.isArray(host.node?.rotation)) {
        ops.unshift({ op: 'updateElement', id: host.id, patch: { node: { ...(host.node || {}), rotation: local.map(round3) } } });
      } else if (kind === 'ob' && !Array.isArray(host.rotation)) {
        ops.unshift({ op: 'objectPatch', id: host.id, patch: { rotation: local.map(round3) } });
      }
    }
    return ops;
  }
  return [];
}

/** Ops for a row-head Shift+click (removes every axis key at the playhead). */
export function xfUnkeyOps(project, host, kind, rowKey, t, tol) {
  const mode = xfMode(host, kind, rowKey);
  if (mode === 'path') {
    const k = firstKeyAt(host, kind, 'path', t, tol);
    return k ? [{ op: 'cameraRemove', id: host.id, t: k.t }] : [];
  }
  if (mode === 'vector') {
    const path = xfVectorPath(kind, rowKey);
    const k = firstKeyAt(host, kind, path, t, tol);
    return k ? [unkeyOp(kind, host, path, k.t)] : [];
  }
  if (mode === 'axis') {
    const ops = [];
    for (const ax of XF_AXES) {
      const path = xfAxisPath(kind, rowKey, ax);
      const k = firstKeyAt(host, kind, path, t, tol);
      if (k) ops.push(unkeyOp(kind, host, path, k.t));
    }
    return ops;
  }
  return [];
}

/** Ops for one sub-row ◆. Falls back to the whole vector pre-migration. */
export function xfAxisKeyOps(project, host, kind, rowKey, axis, t) {
  if (rowKey === 'position') return [];
  const mode = xfMode(host, kind, rowKey);
  if (mode === 'axis') {
    const i = XF_AXES.indexOf(axis);
    const localArr = xfLocalValues(project, host, kind, t)[rowKey];
    const ops = [keyOp(kind, host, xfAxisPath(kind, rowKey, axis), t, localArr[i])];
    if (rowKey === 'rotation') {
      if (kind === 'el' && !Array.isArray(host.node?.rotation)) {
        ops.unshift({ op: 'updateElement', id: host.id, patch: { node: { ...(host.node || {}), rotation: localArr.map(round3) } } });
      } else if (kind === 'ob' && !Array.isArray(host.rotation)) {
        ops.unshift({ op: 'objectPatch', id: host.id, patch: { rotation: localArr.map(round3) } });
      }
    }
    return ops;
  }
  // Pre-migration vector tracks: a single axis cannot be keyed alone, so this
  // becomes a whole-row key (the button tooltip says so).
  return xfKeyOps(project, host, kind, rowKey, t);
}

/** Ops for a sub-row ◆ in the "key at playhead" state. */
export function xfAxisUnkeyOps(project, host, kind, rowKey, axis, t, tol) {
  if (rowKey === 'position') return [];
  const mode = xfMode(host, kind, rowKey);
  if (mode === 'axis') {
    const path = xfAxisPath(kind, rowKey, axis);
    const k = firstKeyAt(host, kind, path, t, tol);
    return k ? [unkeyOp(kind, host, path, k.t)] : [];
  }
  return xfUnkeyOps(project, host, kind, rowKey, t, tol);
}

/**
 * Ops for typing a value into one cell.
 * With a track present the edit lands on a key at the playhead; otherwise it
 * changes the base value (same rule as the old rows).
 */
export function xfSetAxisOps(project, host, kind, rowKey, axis, value, t, tol) {
  if (rowKey === 'position' && kind === 'cam') return [];
  const i = XF_AXES.indexOf(axis);
  if (i < 0) return [];
  const mode = xfMode(host, kind, rowKey);
  const local = num(localAxis(project, host, kind, rowKey, axis, value, t), value);
  if (mode === 'axis') {
    const path = xfAxisPath(kind, rowKey, axis);
    if (trackKeys(host, kind, path).length) {
      const ops = [keyOp(kind, host, path, t, local)];
      if (rowKey === 'rotation') {
        const localRot = xfLocalValues(project, host, kind, t).rotation;
        if (kind === 'el' && !Array.isArray(host.node?.rotation)) {
          ops.unshift({ op: 'updateElement', id: host.id, patch: { node: { ...(host.node || {}), rotation: localRot.map(round3) } } });
        } else if (kind === 'ob' && !Array.isArray(host.rotation)) {
          ops.unshift({ op: 'objectPatch', id: host.id, patch: { rotation: localRot.map(round3) } });
        }
      }
      return ops;
    }
    return [baseOp(project, host, kind, rowKey, i, local, t)];
  }
  if (mode === 'vector') {
    const path = xfVectorPath(kind, rowKey);
    const arr = xfLocalValues(project, host, kind, t)[rowKey].slice();
    arr[i] = local;
    if (trackKeys(host, kind, path).length) {
      return [kind === 'cam'
        ? { op: 'cameraParamKey', id: host.id, path, t, v: arr.map(round3) }
        : { op: 'objectKey', id: host.id, path, t, v: arr.map(round3) }];
    }
    return [baseOp(project, host, kind, rowKey, i, local, t)];
  }
  if (mode === 'base') return [baseOp(project, host, kind, rowKey, i, local, t)];
  return [];
}

/** Base-value op for one axis (all three array slots kept in sync). */
function baseOp(project, host, kind, rowKey, axisIndex, value, t) {
  const arr = xfLocalValues(project, host, kind, t)[rowKey].slice();
  arr[axisIndex] = value;
  if (kind === 'cam') {
    const field = rowKey === 'pivot' ? 'center' : rowKey;
    return { op: 'cameraSet', id: host.id, patch: { [field]: arr.map(round3) } };
  }
  if (kind === 'ob') return { op: 'objectPatch', id: host.id, patch: { [rowKey]: arr.map(round3) } };
  const node = { ...(host.node || {}) };
  if (rowKey === 'rotation' && !Array.isArray(node.rotation)) {
    node.rotation = arr.map(round3);
  } else {
    node[rowKey] = arr.map(round3);
  }
  return { op: 'updateElement', id: host.id, patch: { node } };
}

/** Opacity row (a single scalar, outside the four transform rows). */
export function xfOpacityOps(project, host, kind, value, t, atPlayhead = false) {
  const back = writeBackLocalValue(project, { host: kind, id: host.id }, 'opacity', t, value);
  const local = Math.max(0, Math.min(1, num(back, value)));
  if (atPlayhead) {
    if (kind === 'cam') return [{ op: 'cameraParamKey', id: host.id, path: 'opacity', t, v: local }];
    if (kind === 'ob') return [{ op: 'objectKey', id: host.id, path: 'opacity', t, v: local }];
    return [{ op: 'keySet', id: host.id, path: 'transform.opacity', t, value: local }];
  }
  if (kind === 'cam') return [{ op: 'cameraSet', id: host.id, patch: { opacity: local } }];
  if (kind === 'ob') return [{ op: 'objectPatch', id: host.id, patch: { opacity: local } }];
  return [{ op: 'updateElement', id: host.id, patch: { transform: { ...(host.transform || {}), opacity: local } } }];
}

/** Key state of the opacity row. */
export function xfOpacityKeyState(host, kind, t, tol) {
  const path = kind === 'el' ? 'transform.opacity' : 'opacity';
  const times = timesOf(host, kind, path);
  return { at: times.some((x) => Math.abs(x - t) <= tol), has: times.length > 0, times };
}

/** Remove the opacity key at the playhead (one op). */
export function xfOpacityUnkeyOps(host, kind, t, tol) {
  const path = kind === 'el' ? 'transform.opacity' : 'opacity';
  const list = trackKeys(host, kind, path);
  const k = list.find((x) => Math.abs(Number(x.t) - t) <= tol);
  if (!k) return [];
  if (kind === 'cam') return [{ op: 'cameraParamUnkey', id: host.id, path, t: k.t }];
  if (kind === 'ob') return [{ op: 'objectUnkey', id: host.id, path, t: k.t }];
  return [{ op: 'keyRemove', id: host.id, path, t: k.t }];
}
