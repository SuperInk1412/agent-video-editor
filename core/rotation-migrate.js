// Three-axis rotation migration (docs/DESIGN-TRANSFORM-UNIFY.md §2, step 2c).
//
// Turns every older orientation field into `rotation` / 'rotation.x|y|z':
//
//   legacy 2D element     -> SpatialNode first (core/migrate-spatial.js,
//                            preserve: pixel-identical), then as below
//   node  dir + roll      -> node.rotation; 'roll' keys -> 'rotation.z' keys
//   object rot + dir/roll -> obj.rotation; 'roll' track -> 'rotation.z';
//                            a keyed 'dir' becomes x/y/z keys at the key times
//                            (per-axis in between instead of spherical —
//                            listed in the report)
//   camera roll           -> cam.rotation [0, 0, roll]; 'roll' track ->
//                            'rotation.z' (the camera offset's z is the old roll)
//   links to / from 'roll' -> 'rotation.z'
//
// Static orientations and roll-only animation are exact: with the dir fixed,
// roll is a turn about the facing axis, which is exactly z.
//
// Runs on open (engine/storage.js) behind ROTATION_MIGRATION.
//
// Pure ESM, no `node:*`.
import { isRecord } from './json.js';
import { objectPose } from './scene.js';
import { planSpatialMigration } from './migrate-spatial.js';
import { normalizeRotation, rotationFromDirRoll, rotationFromBasis, rotationMatrix } from './rotation.js';

/** On: the UI edits rotation.x/y/z (2b) and new data is written that way (core/rotation-ops.js). */
export const ROTATION_MIGRATION = true;

const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;
const AXES = ['x', 'y', 'z'];

/** Shift `v` by whole turns so it is the nearest to `prev` (no 359 -> -1 jumps). */
const unwrap = (v, prev) => (prev == null ? v : v + 360 * Math.round((prev - v) / 360));

/**
 * 'roll' links become 'rotation.z' links. A tilted host's z is its roll plus a
 * constant (z0, from its facing direction), so a link reading such a source
 * shifts its bind value by the same constant to keep the delta.
 */
function renameLinks(host, z0, report) {
  for (const link of Array.isArray(host?.links) ? host.links : []) {
    if (!isRecord(link)) continue;
    if (link.to === 'roll') { link.to = 'rotation.z'; report.links++; }
    if (isRecord(link.from) && link.from.path === 'roll') {
      link.from.path = 'rotation.z';
      const shift = z0.get(String(link.from.id)) || 0;
      if (shift && Number.isFinite(Number(link.bindParentValue))) {
        link.bindParentValue = r6(Number(link.bindParentValue) + (link.combine === 'mul' ? 0 : shift));
      }
      report.links++;
    }
  }
}

/** z - roll of a node / object facing (0 unless the facing is near vertical). */
function rollOffset(dir, roll) {
  return rotationFromDirRoll(dir, roll)[2] - (Number(roll) || 0);
}

function migrateNode(el, report) {
  const node = el.node;
  if (Array.isArray(node.rotation)) return;
  const base = rotationFromDirRoll(node.dir || [0, 0, 1], node.roll || 0);
  node.rotation = base.map(r6);
  const z0 = base[2] - (Number(node.roll) || 0); // 0 except for near-vertical dirs
  for (const key of Array.isArray(el.keyframes) ? el.keyframes : []) {
    if (key?.path === 'roll') { key.path = 'rotation.z'; key.value = r6(Number(key.value) + z0); }
  }
  delete node.dir;
  delete node.roll;
  report.nodes++;
}

function migrateObject(obj, report) {
  if (Array.isArray(obj.rotation)) return;
  const tr = obj.tracks || (obj.tracks = {});
  const dirKeys = Array.isArray(tr.dir) ? tr.dir : [];
  const rollKeys = Array.isArray(tr.roll) ? tr.roll : [];
  const rest = objectPose({ ...obj, tracks: {} }, 0);
  const base = rotationFromDirRoll(rest.dir, rest.roll).map(r6);
  if (dirKeys.length) {
    // Sample the old orientation at every key time of either channel (before
    // `rotation` exists: objectPose prefers it once it is set).
    const times = [...new Set([...dirKeys, ...rollKeys].map((k) => r6(k.t)))].sort((a, b) => a - b);
    const keys = { x: [], y: [], z: [] };
    let prev = null;
    for (const t of times) {
      const pose = objectPose(obj, t);
      const rot = rotationFromBasis(pose.basis).map((v, i) => unwrap(v, prev?.[i]));
      prev = rot;
      const dk = dirKeys.find((k) => Math.abs(k.t - t) < 1e-6);
      const rk = rollKeys.find((k) => Math.abs(k.t - t) < 1e-6);
      AXES.forEach((a, i) => {
        const ease = (i < 2 ? dk : rk || dk)?.ease;
        keys[a].push({ t, v: r6(rot[i]), ...(ease ? { ease } : {}) });
      });
    }
    for (const a of AXES) tr[`rotation.${a}`] = keys[a];
    report.approximated.push(obj.id);
  } else if (rollKeys.length) {
    const z0 = base[2] - (Number(obj.rot?.roll) || 0);
    tr['rotation.z'] = rollKeys.map((k) => ({ ...k, v: r6(Number(k.v) + z0) }));
  }
  obj.rotation = base;
  delete tr.dir;
  delete tr.roll;
  delete obj.rot;
  report.objects++;
}

const mul3 = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const rz3 = (deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };

// The manual roll turns the camera frame before the rotation offset
// (core/rotation.js::applyCameraRotation): Rz(roll) · R(x, y, 0) · Rz(z).
// Cameras from before step 2b have no offset, so it is just z = roll. A camera
// edited since can carry both: a static roll folds exactly into new x / y and a
// z shift unless x / y are keyed; a keyed roll folds only when the camera is
// not tilted. Anything else keeps its roll, which still applies at runtime.
function migrateCamera(cam, report) {
  const tr = cam.tracks || (cam.tracks = {});
  const keyed = (p) => Array.isArray(tr[p]) && tr[p].length > 0;
  if (Array.isArray(cam.rotation) && cam.roll === undefined && !keyed('roll')) return;
  const rot = normalizeRotation(cam.rotation);
  const roll = Number(cam.roll) || 0;
  const xyKeyed = keyed('rotation.x') || keyed('rotation.y');
  if (keyed('roll')) {
    if (rot[0] || rot[1] || xyKeyed || keyed('rotation.z')) return;
    tr['rotation.z'] = tr.roll.map((k) => ({ ...k, v: r6(Number(k.v) + rot[2]) }));
    delete tr.roll;
  } else if (roll) {
    if (xyKeyed) return;
    const K = mul3(rz3(roll), rotationMatrix([rot[0], rot[1], 0]));
    const [x, y, zz] = rotationFromBasis({ forward: [K[0][2], K[1][2], K[2][2]], up: [K[0][1], K[1][1], K[2][1]] });
    rot[0] = x; rot[1] = y; rot[2] -= zz;
    if (keyed('rotation.z')) tr['rotation.z'] = tr['rotation.z'].map((k) => ({ ...k, v: r6(Number(k.v) - zz) }));
  }
  cam.rotation = rot.map(r6);
  delete cam.roll;
  report.cameras++;
}

/**
 * Migrate a project in place (or return the migrated project when the 2D node
 * conversion had to build a new one). Returns `{ project, report }`; `report`
 * counts what changed and lists `approximated` object ids.
 */
export function migrateRotations(input) {
  const report = { elementsToNode: 0, nodes: 0, objects: 0, cameras: 0, links: 0, approximated: [] };
  let project = input;
  // 1. legacy 2D elements -> SpatialNode (pixel-identical preserve conversion)
  const legacy = (project.elements || []).filter((el) => el.type !== 'audio' && !isRecord(el.node)).map((el) => String(el.id));
  if (legacy.length) {
    const plan = planSpatialMigration(project, { mode: 'hybrid', ids: legacy });
    if (plan.issues?.length) throw new Error(`2D node conversion failed: ${plan.issues[0].path} ${plan.issues[0].msg}`);
    project = plan.project;
    report.elementsToNode = plan.stats.converted;
  }
  // 2. the roll -> z offset of every source, before the old fields go away
  const z0 = new Map();
  for (const el of project.elements || []) {
    if (isRecord(el.node) && !Array.isArray(el.node.rotation)) z0.set(String(el.id), rollOffset(el.node.dir || [0, 0, 1], el.node.roll));
  }
  for (const obj of project.scene?.objects || []) {
    if (!Array.isArray(obj.rotation)) z0.set(String(obj.id), rollOffset(obj.rot?.dir || [0, 0, -1], obj.rot?.roll));
  }
  // 3. orientations -> rotation
  for (const el of project.elements || []) if (isRecord(el.node)) migrateNode(el, report);
  for (const obj of project.scene?.objects || []) migrateObject(obj, report);
  for (const cam of project.cameras || []) migrateCamera(cam, report);
  for (const host of [...(project.elements || []), ...(project.scene?.objects || []), ...(project.cameras || [])]) renameLinks(host, z0, report);
  if (project.camera && !(project.cameras || []).includes(project.camera)) migrateCamera(project.camera, report);
  return { project, report };
}

