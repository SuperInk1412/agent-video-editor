// Screen lock (贴屏) retirement (docs/DESIGN-CAMFEED-PARENTS.md §2).
//
// A screen-locked element (`el.parent = {id: camera | '@live', kind: 'camera'}`)
// rode the live camera so it stayed put on screen. The same picture is built
// from camera feeds instead — a HUD rig far from the scene:
//
//   ob_hud (empty, x = HUD_OFFSET)
//    ├─ cam_hud   static, the lock's bind pose, output, top of the stack
//    ├─ camfeed × N   one per original shot (its clip), full frame, below the HUD
//    └─ the formerly locked elements, at their own transforms
//   original cameras -> output: false (they only feed now)
//
// Every child hangs off ob_hud through a spatial parent bound with the rig at
// the origin, then the rig moves to HUD_OFFSET, so all of it can be moved later.
//
// Exact when the binds share one pose and the shots keep the bind's FOV and a
// default picture transform (the usual case, e.g. projects/miku-swiss); the
// report lists what was approximated.
//
// Pure ESM, no `node:*`.
import { applyOps } from './ops.js';
import { cameraLayers, cameraRange } from './camera.js';
import { defaultCamera } from './space.js';
import { isRecord } from './json.js';

export const HUD_OFFSET = 20000; // metres along +x: beyond every camera's far plane

const isLock = (el) => isRecord(el?.parent) && el.parent.id && el.parent.mode !== 'world';

const unique = (base, taken) => {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
};

function allIds(project) {
  return new Set([
    ...(project.elements || []).map((e) => e.id),
    ...(project.scene?.objects || []).map((o) => o.id),
    ...(project.cameras || []).map((c) => c.id),
    ...(project.segments || []).map((s) => s.id),
  ].map(String));
}

const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;
const samePose = (a, b) => [a.pos, ...a.basis].flat().every((v, i) => Math.abs(v - [b.pos, ...b.basis].flat()[i]) < 1e-6);

/**
 * Convert every screen lock of `project` (in place). Returns null when there is
 * none, otherwise a report:
 *   { elements, feeds, hudCamera, rig, approximations: [text...] }
 */
export function migrateScreenLocks(project) {
  const locked = (project.elements || []).filter(isLock);
  if (!locked.length) return null;
  const meta = project.meta || {};
  const notes = [];
  const binds = locked.map((el) => {
    const b = el.parent.bind || {};
    return {
      pos: Array.isArray(b.pos) ? b.pos.map(Number) : [0, (Number(meta.height) || 1080) / 200, 20],
      basis: Array.isArray(b.basis) && b.basis.length === 3 ? b.basis.map((v) => v.map(Number)) : [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
      depth: Number(b.depth) || 20,
    };
  });
  const bind = binds[0];
  const odd = binds.filter((b) => !samePose(b, bind)).length;
  if (odd) notes.push(`${odd} 个贴屏元素的绑定机位与第一个不同，统一按第一个机位放置`);
  const specific = locked.filter((el) => el.parent.id !== '@live').length;
  const shots = cameraLayers(project).filter((c) => c.output !== false);
  if (specific && shots.length > 1) notes.push(`${specific} 个元素原来绑定在某一台相机上，现在在所有镜头里都钉在画面上`);
  for (const c of shots) {
    const pp = c.picturePivot || [0.5, 0.5];
    const po = c.pictureOffset || [0, 0];
    const sc = c.scale || [1, 1, 1];
    const tr = c.tracks || {};
    if (Math.abs(pp[0] - 0.5) > 1e-6 || Math.abs(pp[1] - 0.5) > 1e-6 || Math.abs(po[0]) > 1e-6 || Math.abs(po[1]) > 1e-6
      || Math.abs(sc[0] - 1) > 1e-6 || Math.abs(sc[1] - 1) > 1e-6
      || ['scale', 'picturePivot', 'pictureOffset', 'opacity'].some((k) => Array.isArray(tr[k]) && tr[k].length)) {
      notes.push(`相机 ${c.name || c.id} 的画面变换没有带到投屏上`);
    }
  }

  for (const el of locked) delete el.parent;

  const taken = allIds(project);
  const rig = unique('ob_hud', taken); taken.add(rig);
  const cam = unique('cam_hud', taken); taken.add(cam);
  const fwd = bind.basis[2];
  const look = bind.pos.map((v, i) => r6(v + fwd[i] * bind.depth));
  const base = defaultCamera(meta);
  const duration = Number(meta.duration) || 0;
  const zMin = Math.min(0, ...(project.elements || []).map((e) => Number(e.z) || 0));

  const ops = [
    { op: 'objectAdd', object: { id: rig, type: 'empty', name: 'HUD 机位', pivot: [0, 0, 0] } },
    { op: 'addCamera', index: 0, camera: {
      ...base, id: cam, name: 'HUD 相机', output: true,
      path: [{ t: 0, pos: bind.pos.map(r6), look }],
    } },
  ];
  const feeds = [];
  shots.forEach((c, i) => {
    const r = cameraRange(project, c);
    const start = Math.max(0, r.start);
    const end = Math.min(duration || r.end, r.end);
    if (!(end > start)) return;
    const id = unique(`el_feed_${c.id}`, taken); taken.add(id);
    feeds.push(id);
    ops.push({ op: 'addElement', element: {
      id, type: 'camfeed', name: `投屏 · ${c.name || c.id}`, start, duration: r6(end - start),
      z: zMin - 1 - i, feed: { camera: c.id, delay: 0 }, style: { fit: 'stretch' },
      transform: { opacity: Number.isFinite(Number(c.opacity)) ? Number(c.opacity) : 1 },
    } });
    ops.push({ op: 'cameraPatch', id: c.id, patch: { output: false } });
  });
  for (const id of [cam, ...feeds, ...locked.map((el) => el.id)]) ops.push({ op: 'spatialParent', id, parent: rig, t: 0 });
  ops.push({ op: 'objectPatch', id: rig, patch: { pivot: [HUD_OFFSET, 0, 0] } });
  ops.push({ op: 'activateCamera', id: cam });
  applyOps(project, ops);
  return { elements: locked.length, feeds: feeds.length, hudCamera: cam, rig, approximations: notes };
}
