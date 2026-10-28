// Screen lock (贴屏) retirement (docs/DESIGN-TRANSFORM-UNIFY.md §1.2).
//
// A screen-locked element (`el.parent = {id: camera | '@live', kind: 'camera',
// bind: {pos, basis}}`) rode the camera rigidly: world(t) = now(t) · bind⁻¹ · x.
// A spatial parent to that camera with the same bind pose is the same map, so
// each lock becomes spatial parents to the shot cameras:
//
//   '@live'      the element is split at every shot cut inside its window and
//                each piece is parented to the camera on air in that piece
//   camera id    one piece, parented to that camera
//
// No camera feeds and no full-screen rig are created. A project saved with the
// earlier HUD-rig migration (ob_hud / cam_hud / el_feed_*) is first turned back
// into locks, then migrated as above.
//
// Exact, including the lock's pull-in toward the lens (kept through the bind
// scale, so nothing in the scene covers the element). A shot whose FOV is
// animated scales its subtitles, as the lock did; the report lists those shots.
//
// Pure ESM, no `node:*`.
import { applyOps } from './ops.js';
import { cameraAtTime, cameraLayers, cameraRange, evalCamera } from './camera.js';
import { isRecord } from './json.js';

/** Metres in front of the lens the retired lock drew its elements (render only). */
const SCREEN_LOCK_DEPTH = 1;

const isLock = (el) => isRecord(el?.parent) && el.parent.id && el.parent.mode !== 'world';
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;

const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Lens basis [right, up, forward] of a camera looking from pos to look (roll 0). */
function lensBasis(pos, look) {
  const f = norm(sub(look, pos));
  let r = cross(f, [0, 1, 0]);
  if (Math.hypot(...r) < 1e-9) r = [1, 0, 0];
  r = norm(r);
  return [r, cross(r, f), f];
}

/**
 * Undo the earlier HUD-rig migration (in place): the rig, its camera and its
 * feeds are removed and the elements under it become '@live' locks again,
 * bound to the HUD camera's pose relative to the rig. Returns how many
 * elements were restored.
 */
export function undoHudRig(project) {
  const objects = project.scene?.objects || [];
  const rig = objects.find((o) => o.type === 'empty' && String(o.id).startsWith('ob_hud') && o.name === 'HUD 机位');
  if (!rig) return 0;
  const cams = project.cameras || [];
  const hud = cams.find((c) => String(c.id).startsWith('cam_hud') && c.frameParent?.id === rig.id);
  const under = (el) => el.parent?.mode === 'world' && el.parent.id === rig.id;
  const feeds = (project.elements || []).filter((el) => under(el) && el.type === 'camfeed' && String(el.id).startsWith('el_feed_'));
  const locked = (project.elements || []).filter((el) => under(el) && !feeds.includes(el));
  // The HUD camera sat at the lock's bind pose relative to the rig at the origin.
  const key = hud?.path?.[0];
  const pos = key?.pos || [0, (Number(project.meta?.height) || 1080) / 200, 20];
  const look = key?.look || [pos[0], pos[1], pos[2] - 20];
  const bind = { pos: pos.map(r6), basis: lensBasis(pos, look).map((v) => v.map(r6)), depth: r6(Math.hypot(...sub(look, pos))) };
  for (const el of locked) el.parent = { id: '@live', kind: 'camera', bind };
  project.elements = (project.elements || []).filter((el) => !feeds.includes(el));
  if (hud) {
    project.cameras = cams.filter((c) => c !== hud);
    if (Array.isArray(project.cameraOrder)) project.cameraOrder = project.cameraOrder.filter((id) => id !== hud.id);
    if (project.activeCameraId === hud.id) project.activeCameraId = project.cameraOrder?.[0] || project.cameras[0]?.id || null;
    project.camera = project.cameras.find((c) => c.id === project.activeCameraId) || project.cameras[0] || null;
  }
  project.scene.objects = objects.filter((o) => o !== rig);
  for (const c of project.cameras || []) delete c.output;
  return locked.length;
}

/** [[start, end, cameraId], ...] pieces of [t0, t1) by the camera on air ('@live'). */
function livePieces(project, t0, t1) {
  const cuts = new Set([t0, t1]);
  for (const c of cameraLayers(project)) {
    const r = cameraRange(project, c);
    for (const t of [r.start, r.end]) if (t > t0 + 1e-6 && t < t1 - 1e-6) cuts.add(r6(t));
  }
  const times = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < times.length - 1; i++) {
    const cam = cameraAtTime(project, (times[i] + times[i + 1]) / 2);
    if (!cam) continue;
    const last = out[out.length - 1];
    if (last && last[2] === cam.id) last[1] = times[i + 1];
    else out.push([times[i], times[i + 1], cam.id]);
  }
  return out;
}

/** Does a camera's FOV change inside [t0, t1)? (subtitles on it change size) */
function fovMoves(project, camId, t0, t1) {
  const cam = (project.cameras || []).find((c) => c.id === camId);
  if (!cam) return false;
  const solo = { ...project, camera: cam, cameras: [cam], cameraOrder: [cam.id], activeCameraId: cam.id };
  const f0 = evalCamera(solo, t0).fov;
  for (let i = 1; i <= 8; i++) if (Math.abs(evalCamera(solo, t0 + ((t1 - t0) * i) / 8).fov - f0) > 1e-3) return true;
  return false;
}

/**
 * Convert every screen lock of `project` in place. Returns null when there is
 * none, otherwise { elements, pieces, restoredHud, fovShots: [camera ids] }.
 */
export function migrateScreenLocks(project) {
  const restoredHud = undoHudRig(project);
  const locked = (project.elements || []).filter(isLock);
  if (!locked.length) return restoredHud ? { elements: 0, pieces: 0, restoredHud, fovShots: [] } : null;
  let pieces = 0;
  const fovShots = new Set();
  for (const el of locked) {
    const lock = el.parent;
    const b = isRecord(lock.bind) ? lock.bind : {};
    // The lock drew the element pulled toward the lens (scaled by
    // SCREEN_LOCK_DEPTH / depth about the camera), which keeps it in front of
    // the scene. A bind scale of depth / SCREEN_LOCK_DEPTH with scale
    // inheritance is the same map, so occlusion matches too.
    const pull = Math.max(1e-3, Number(b.depth) || 20) / SCREEN_LOCK_DEPTH;
    const bind = {
      pivot: Array.isArray(b.pos) ? b.pos.map(r6) : [0, (Number(project.meta?.height) || 1080) / 200, 20],
      basis: Array.isArray(b.basis) && b.basis.length === 3 ? b.basis.map((v) => v.map(r6)) : [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
      scale: [pull, pull, pull].map(r6),
    };
    delete el.parent;
    const start = Number(el.start) || 0;
    const end = start + (Number(el.duration) || 0);
    const parts = lock.id === '@live' ? livePieces(project, start, end) : [[start, end, String(lock.id)]];
    // Split at the cuts, last cut first so the left part keeps the id.
    const ids = [el.id];
    const cuts = parts.slice(1).map((p) => p[0]);
    for (const at of cuts.slice().reverse()) {
      const { element } = applyOps(project, [{ op: 'splitElement', id: el.id, at }]).results?.[0]
        || { element: null };
      if (element) ids.splice(1, 0, element.id);
    }
    // ids now follow the parts left to right (each split inserted its right half).
    parts.forEach(([t0, t1, cam], i) => {
      const host = (project.elements || []).find((x) => x.id === ids[i]);
      if (!host) return;
      host.parent = { id: cam, mode: 'world', inherit: { pos: true, rot: true, scale: true }, bind };
      if (fovMoves(project, cam, t0, t1)) fovShots.add(cam);
      pieces++;
    });
  }
  return { elements: locked.length, pieces, restoredHud, fovShots: [...fovShots] };
}
