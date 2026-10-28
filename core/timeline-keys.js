// Keyed-row helpers for the timeline's "keyed only" pass (U). They answer two
// questions without touching the DOM:
//
//   * does a host row carry any keyframe the timeline can draw?
//   * which property groups must stay open to show those rows?
//
// Only properties the timeline already has rows for count. An element whose
// only key is inspector-only (`style.color`, `fx.glow`, …) must not make U
// invent a lane for it, so the row tables below are the single source of truth
// shared with the renderer's group builders.
//
// Pure ESM: the browser renderer and the Node tests share this module.

import { splitRef } from './selection.js';

const AX = ['x', 'y', 'z'];
const hasKeys = (list) => Array.isArray(list) && list.length > 0;

const EL_TRANSFORM = [
  // Legacy 2D rows.
  'transform.x', 'transform.y', 'transform.z', 'transform.scale', 'transform.rotation', 'transform.opacity',
  // Migrated node rows (core/migrate-spatial.js rewrites x/y/z/scale/rotation).
  'pivot.x', 'pivot.y', 'pivot.z', 'position.x', 'position.y', 'position.z',
  'scale.x', 'scale.y', 'scale.z', 'roll',
  'rotation.x', 'rotation.y', 'rotation.z',
];
const EL_AUDIO = ['audio.volume'];
const OB_TRANSFORM = ['pivot', 'position', 'scale', 'rotation.x', 'rotation.y', 'rotation.z', 'opacity'];
// Camera groups mirror the timeline's camera row builders. `path` keys are the
// 位置 row of the 变换 group.
const CAM_GROUPS = {
  camPos: ['center', 'picturePivot', 'pictureOffset', 'opacity', 'scale'],
  camRot: ['rotation.x', 'rotation.y', 'rotation.z'],
  camMain: ['fov', 'lookAhead', 'bankGain', 'maxRoll', 'roll'],
  camShake: ['shake.amp', 'shake.freq', 'shake.speedGain'],
  camDof: ['dof.enabled', 'dof.fstop'],
};

export const CAMERA_GROUPS = ['camPos', 'camRot', 'camMain', 'camShake', 'camDof'];

const collect = (keyed, paths, groups, group, list) => {
  for (const path of list) {
    if (!keyed.has(path)) continue;
    paths.add(path);
    groups.add(group);
  }
};

/** Keyed state of a 2D element: transform rows plus the audio volume row. */
export function elementHostKeys(el) {
  const keyed = new Set((el?.keyframes || []).map((k) => String(k?.path ?? '')).filter(Boolean));
  const paths = new Set();
  const groups = new Set();
  collect(keyed, paths, groups, 'transform', EL_TRANSFORM);
  collect(keyed, paths, groups, 'audio', EL_AUDIO);
  return { keyed: paths.size > 0, paths, groups };
}

/** Keyed state of a 3D object. Content rows (geometry / colour) are not keyable. */
export function objectHostKeys(o) {
  const tracks = o?.tracks || {};
  const paths = new Set();
  for (const path of OB_TRANSFORM) {
    // `_propKeys` treats `pivot` + `pivot.x/y/z` as one row.
    if (hasKeys(tracks[path]) || AX.some((a) => hasKeys(tracks[`${path}.${a}`]))) paths.add(path);
  }
  const groups = new Set(paths.size ? ['transform'] : []);
  return { keyed: paths.size > 0, paths, groups };
}

/** Keyed state of a camera: the path keys plus every parameter track group. */
export function cameraHostKeys(cam) {
  const tracks = cam?.tracks || {};
  const paths = new Set();
  const groups = new Set();
  if (hasKeys(cam?.path)) {
    paths.add('path');
    groups.add('camPos');
  }
  for (const group of CAMERA_GROUPS) {
    for (const path of CAM_GROUPS[group]) {
      if (!hasKeys(tracks[path])) continue;
      paths.add(path);
      groups.add(group);
    }
  }
  return { keyed: paths.size > 0, paths, groups };
}

/**
 * Keyed state of one pool ref (`el:id` / `ob:id` / `cam:id`). Property and
 * keyframe refs anchor to their host. Null when the host is gone (stale pool).
 */
export function hostKeys(project, ref) {
  const s = splitRef(ref);
  if (!s) return null;
  if (s.type === 'el') {
    const e = (project?.elements || []).find((x) => x.id === s.id);
    return e ? { ref: s.host, type: 'el', id: s.id, ...elementHostKeys(e) } : null;
  }
  if (s.type === 'ob') {
    const o = (project?.scene?.objects || []).find((x) => x.id === s.id);
    return o ? { ref: s.host, type: 'ob', id: s.id, ...objectHostKeys(o) } : null;
  }
  const cam = (project?.cameras || []).find((x) => x.id === s.id)
    || (project?.camera?.id === s.id ? project.camera : null);
  return cam ? { ref: s.host, type: 'cam', id: s.id, ...cameraHostKeys(cam) } : null;
}

/** Keyed hosts of a homogeneous element pool, in pool order (stale refs dropped). */
export function poolHostKeys(project, pool) {
  if (pool?.kind !== 'element') return [];
  const out = [];
  for (const ref of pool.ids || []) {
    const state = hostKeys(project, ref);
    if (state) out.push(state);
  }
  return out;
}

/** Section keys the keyed-only pass must keep open for one host state. */
export function keyedSections(state) {
  return state?.keyed ? [...state.groups] : [];
}
