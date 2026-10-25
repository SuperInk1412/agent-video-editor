// v2 (2D, pixels) -> v3 (metres, scene tree, 3D objects).
//
// Pixel side: 100 px = 1 m, screen y is down, layer order is `element.z`.
// World side: y is up, the 2D camera is orthographic at z=+10 m looking -Z,
// and layers are 1 cm apart so depth sorting matches the old z order.
import { evalCamera, normalizeCamera } from './camera.js';
import { PX_PER_M, normalizeScene } from './scene.js';

const M = (px) => Number(px || 0) / PX_PER_M;
const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;

/** Layer index -> metres in front of the ortho camera. */
const LAYER_M = 0.01;

export function migrateProject(p) {
  if (!p || p.sceneId) return p; // already v3
  const meta = p.meta || {};
  const objects = (p.elements || []).map((el) => migrateElement(el));
  const camera = p.camera ? migrateCamera(p.camera, meta) : defaultOrthoCamera(meta);
  if (camera) objects.unshift(camera);

  const scene = normalizeScene({
    name: meta.title || 'root',
    world: p.world || null,
    background: meta.background || '#05070d',
    cameraId: camera?.id || null,
    objects,
    annotations: (p.segments || []).map((s, i) => ({
      id: s.id || `anno_${i + 1}`,
      t: N(s.start),
      duration: N(s.duration),
      text: [s.name, s.intent].filter(Boolean).join(' — '),
    })),
  });

  return { ...p, units: 'm', sceneId: 'root', scenes: { root: scene } };
}

/** Project a world pivot through the legacy ortho camera, in project pixels. */
export function orthoScreen(meta, pivot) {
  const w = Number(meta?.width) || 1920;
  const h = Number(meta?.height) || 1080;
  const fw = w / PX_PER_M;
  const fh = h / PX_PER_M;
  return [(pivot[0] + fw / 2) * PX_PER_M, (fh / 2 - pivot[1]) * PX_PER_M];
}

// ---------------------------------------------------------------- elements

function groupKeys(keyframes) {
  const out = {};
  for (const k of keyframes || []) {
    if (!k || !k.path || !Number.isFinite(Number(k.t))) continue;
    (out[k.path] || (out[k.path] = [])).push(k);
  }
  return out;
}

function scalarTrack(keys, map) {
  return keys
    .map((k) => ({ t: N(k.t), v: map(k.value), ...(k.ease ? { ease: k.ease } : {}) }))
    .sort((a, b) => a.t - b.t);
}

function migrateElement(el) {
  const tr = el.transform || {};
  const byPath = groupKeys(el.keyframes);
  const tracks = {};

  // Per-axis scalar tracks keep the old per-axis eases exactly; vec3 tracks win
  // when both exist (see core/scene.js sampleAxes).
  if (byPath['transform.x']) tracks['pivot.x'] = scalarTrack(byPath['transform.x'], M);
  if (byPath['transform.y']) tracks['pivot.y'] = scalarTrack(byPath['transform.y'], (v) => -M(v));
  if (byPath['transform.z']) tracks['pivot.z'] = scalarTrack(byPath['transform.z'], M);
  if (byPath['transform.rotation']) tracks.roll = scalarTrack(byPath['transform.rotation'], (v) => -N(v));
  if (byPath['transform.opacity']) tracks.opacity = scalarTrack(byPath['transform.opacity'], N);
  if (byPath['transform.scale']) {
    const keys = scalarTrack(byPath['transform.scale'], N);
    tracks['scale.x'] = keys.map((k) => ({ ...k }));
    tracks['scale.y'] = keys.map((k) => ({ ...k }));
  }
  for (const path of ['style.text', 'style.size', 'style.color', 'fx.glow']) {
    if (!byPath[path]) continue;
    tracks[path] = scalarTrack(byPath[path], path === 'style.size' ? M : (v) => v);
  }

  const scale = Number.isFinite(Number(tr.scale)) ? Number(tr.scale) : 1;
  const obj = {
    id: el.id,
    type: el.type,
    name: el.name || el.id,
    start: N(el.start),
    duration: N(el.duration),
    visible: el.visible !== false,
    pivot: [M(tr.x), -M(tr.y), N(el.z) * LAYER_M],
    position: [0, 0, 0],
    scale: [scale, scale, 1],
    rot: { dir: [0, 0, 1], roll: -N(tr.rotation) },
    opacity: Math.min(1, Math.max(0, N(tr.opacity ?? 1))),
    tracks,
    style: convertStyle(el.style),
    src: el.src,
    segment: el.segment,
  };

  // Legacy behaviours we do not model yet: keep them on the object so the
  // switchover can apply them until they are re-authored as keyframes.
  const legacy = {};
  if (el.motion && el.motion.type && el.motion.type !== 'none') legacy.motion = el.motion;
  if (el.punch) legacy.punch = N(el.punch);
  if (el.fadeIn) legacy.fadeIn = N(el.fadeIn);
  if (el.fadeOut) legacy.fadeOut = N(el.fadeOut);
  if (el.fx && Object.keys(el.fx).length) legacy.fx = el.fx;
  if (Object.keys(legacy).length) obj.legacy = legacy;

  return obj;
}

function convertStyle(style = {}) {
  const s = { ...style };
  for (const k of ['size', 'w', 'h', 'radius']) {
    if (Number.isFinite(Number(s[k]))) s[k] = M(s[k]);
  }
  return s;
}

// ---------------------------------------------------------------- camera

function defaultOrthoCamera(meta) {
  return {
    id: '__ortho_cam',
    type: 'camera',
    name: '2D 相机',
    start: 0,
    duration: N(meta?.duration) || 12,
    pivot: [0, 0, 10],
    position: [0, 0, 0],
    scale: [1, 1, 1],
    rot: { dir: [0, 0, -1], roll: 0 },
    opacity: 1,
    camera: {
      projection: 'ortho',
      orthoScale: (Number(meta?.width) || 1920) / PX_PER_M,
      near: 0.1,
      far: 100,
    },
  };
}

function dirOf(st) {
  const d = [st.look[0] - st.pos[0], st.look[1] - st.pos[1], st.look[2] - st.pos[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [r6(d[0] / l), r6(d[1] / l), r6(d[2] / l)];
}

/**
 * The old camera is a Catmull-Rom path with a derived look direction and bank.
 * Positions migrate exactly (same curve, same eases). Direction/roll are baked
 * at the original keys plus segment midpoints, because they were derived from
 * the path rather than authored.
 */
function migrateCamera(cam, meta) {
  const keySource = (cam.path || []).slice().sort((a, b) => a.t - b.t);
  if (!keySource.length) return null;
  // Shake is a live modifier, not part of the path: sample the clean camera so
  // the baked keys sit exactly on the old curve.
  const clean = normalizeCamera({ ...cam, shake: { ...(cam.shake || {}), amp: 0 } });
  const project = { camera: clean, meta };

  const tAt = (i) => N(keySource[i].t);
  const pivotKeys = [];
  const dirKeys = [];
  const rollKeys = [];
  const fovKeys = [];

  for (let i = 0; i < keySource.length; i++) {
    const t = tAt(i);
    const st = evalCamera(project, t);
    const k = keySource[i];
    pivotKeys.push({
      t,
      v: st.pos.map(r6),
      ...(k.ease ? { ease: k.ease } : {}),
      ...(Array.isArray(k.out) && k.out.length === 3 ? { out: k.out.map(Number) } : {}),
      ...(Array.isArray(k.in) && k.in.length === 3 ? { in: k.in.map(Number) } : {}),
    });
    dirKeys.push({ t, v: dirOf(st) });
    rollKeys.push({ t, v: r6(st.roll) });
    if (k.fov != null) fovKeys.push({ t, v: r6(st.fov) });
  }
  for (let i = 0; i < keySource.length - 1; i++) {
    const t = (tAt(i) + tAt(i + 1)) / 2;
    const st = evalCamera(project, t);
    dirKeys.push({ t, v: dirOf(st) });
    rollKeys.push({ t, v: r6(st.roll) });
  }

  return {
    id: cam.id || '__camera',
    type: 'camera',
    name: '相机',
    start: 0,
    duration: N(meta?.duration) || 12,
    pivot: pivotKeys[0].v,
    position: [0, 0, 0],
    scale: [1, 1, 1],
    rot: { dir: dirKeys[0].v, roll: rollKeys[0].v },
    opacity: 1,
    tracks: {
      pivot: pivotKeys,
      dir: dirKeys,
      roll: rollKeys,
      ...(fovKeys.length ? { 'camera.fov': fovKeys } : {}),
    },
    legacy: { shake: cam.shake || null },
    camera: {
      projection: 'perspective',
      fov: N(cam.fov) || 62,
      near: N(cam.near) || 0.5,
      far: N(cam.far) || 5000,
      lookAhead: N(cam.lookAhead),
      dof: cam.dof || null,
      motionBlur: cam.motionBlur || null,
    },
  };
}
