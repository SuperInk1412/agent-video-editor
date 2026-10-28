// One parent kind for every host (docs/DESIGN-CAMFEED-PARENTS.md §3).
//
// The spatial parent (`el.parent` / `obj.frameParent` / `cam.frameParent`,
// mode "world") is the only placement parent. This module adds what the old
// 3D parent (`obj.parent`, core/hierarchy.js W1) had on top of it:
//
//   strength      {rot, scale}  0..1 base values on the parent record
//   strengthKeys  {rot: [{t, v, ease}], scale: [...]}  keyframes on the record
//
// and retires the old kind:
//   - `migrateLegacyParents(project)` turns `obj.parent` into `obj.frameParent`
//     (same bind, switches, strength and keys: the picture does not change);
//   - the old `objectParent*` ops are kept as names but write spatial parents.
//
// Pure ESM, no `node:*`.
import { isRecord } from './json.js';
import { applySpatialParentOp } from './spatial-parent.js';
import { STRENGTH_TRACKS, unparentKeep } from './hierarchy.js';

export const PARENT_STRENGTH_OP_KINDS = ['spatialParentKey', 'spatialParentUnkey'];
/** Old 3D parent op names, now written as spatial parents. */
export const LEGACY_PARENT_OP_KINDS = ['objectParent', 'objectUnparent', 'objectParentKey', 'objectParentUnkey'];

const CHANNELS = ['rot', 'scale'];
const r4 = (v) => Math.round(Number(v) * 1e4) / 1e4;
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;

function findHost(project, id) {
  const key = String(id ?? '');
  const el = (project.elements || []).find((e) => String(e.id) === key);
  if (el) return { kind: 'element', host: el };
  const ob = (project.scene?.objects || []).find((o) => String(o.id) === key);
  if (ob) return { kind: 'object', host: ob };
  const cam = (project.cameras || []).find((c) => String(c.id) === key);
  if (cam) return { kind: 'camera', host: cam };
  return null;
}

const recordOf = ({ kind, host }) => {
  const rec = kind === 'element' ? host.parent : host.frameParent;
  return isRecord(rec) && rec.id && rec.mode === 'world' ? rec : null;
};

/** Old `obj.parent` (no `mode`) of a 3D object, or null. */
const legacyParent = (obj) => (isRecord(obj?.parent) && obj.parent.id && obj.parent.mode !== 'world' ? obj.parent : null);

/**
 * Convert one object's old parent into a spatial parent, in place. An object
 * that already has a spatial parent keeps it; its old parent is flattened into
 * its own values at t = 0 (both cannot be expressed by one record). Returns
 * 'migrated' | 'flattened' | null.
 */
export function migrateObjectParent(project, obj) {
  const old = legacyParent(obj);
  if (!old) return null;
  const objects = project.scene?.objects || [];
  if (isRecord(obj.frameParent) && obj.frameParent.id) {
    unparentKeep(objects, obj, 0);
    return 'flattened';
  }
  const bind = isRecord(old.bind) ? old.bind : {};
  const inh = isRecord(old.inherit) ? old.inherit : {};
  const record = {
    id: String(old.id),
    mode: 'world',
    inherit: { pos: inh.pos !== false, rot: inh.rot !== false, scale: inh.scale !== false },
    bind: {
      pivot: Array.isArray(bind.pos) ? bind.pos.map(r6) : [0, 0, 0],
      basis: Array.isArray(bind.basis) && bind.basis.length === 3 ? bind.basis.map((v) => v.map(r6)) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      scale: Array.isArray(bind.scale) ? bind.scale.map(r6) : [1, 1, 1],
    },
  };
  const strength = {};
  for (const ch of CHANNELS) {
    const v = Number(old.strength?.[ch]);
    if (Number.isFinite(v) && v < 1) strength[ch] = r4(Math.max(0, v));
  }
  if (Object.keys(strength).length) record.strength = strength;
  const keys = {};
  for (const ch of CHANNELS) {
    const track = obj.tracks?.[STRENGTH_TRACKS[ch]];
    if (Array.isArray(track) && track.length) keys[ch] = track.map((k) => ({ ...k }));
  }
  if (Object.keys(keys).length) record.strengthKeys = keys;
  obj.frameParent = record;
  delete obj.parent;
  if (obj.tracks) for (const name of Object.values(STRENGTH_TRACKS)) delete obj.tracks[name];
  return 'migrated';
}

/** Upgrade every old 3D parent of a project (load time). Returns counts. */
export function migrateLegacyParents(project) {
  const out = { migrated: 0, flattened: 0 };
  // Parents before children is not needed: records only reference ids, and a
  // flatten reads the old chain, so convert children of old parents first.
  const objects = (project?.scene?.objects || []).slice();
  const depth = (o) => {
    let d = 0;
    let cur = o;
    const seen = new Set();
    while (legacyParent(cur) && d < 64 && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = objects.find((x) => x.id === cur.parent.id);
      d++;
    }
    return d;
  };
  objects.sort((a, b) => depth(b) - depth(a));
  for (const obj of objects) {
    const r = migrateObjectParent(project, obj);
    if (r) out[r]++;
  }
  return out;
}

function writeKey(rec, ch, t, v, ease) {
  rec.strengthKeys = isRecord(rec.strengthKeys) ? rec.strengthKeys : {};
  const list = Array.isArray(rec.strengthKeys[ch]) ? rec.strengthKeys[ch].filter((k) => Math.abs(k.t - t) > 1e-4) : [];
  list.push({ t, v, ...(ease ? { ease: String(ease) } : {}) });
  list.sort((a, b) => a.t - b.t);
  rec.strengthKeys[ch] = list;
}

function removeKey(rec, ch, t) {
  if (!isRecord(rec.strengthKeys) || !Array.isArray(rec.strengthKeys[ch])) return false;
  const before = rec.strengthKeys[ch].length;
  rec.strengthKeys[ch] = rec.strengthKeys[ch].filter((k) => Math.abs(k.t - t) > 1e-4);
  if (!rec.strengthKeys[ch].length) delete rec.strengthKeys[ch];
  if (!Object.keys(rec.strengthKeys).length) delete rec.strengthKeys;
  return before !== (rec.strengthKeys?.[ch]?.length ?? 0);
}

/**
 * spatialParentKey   {id, channel:'rot'|'scale', t, v:0..1, ease?}  key the strength
 * spatialParentUnkey {id, channel, t}                              remove that key
 * objectParent / objectUnparent / objectParentKey / objectParentUnkey
 *                    old names: same arguments, written as spatial parents
 */
export function applyParentStrengthOp(project, op, api) {
  const fail = api?.fail || ((m) => { throw new Error(m); });
  const kind = op?.op;
  if (LEGACY_PARENT_OP_KINDS.includes(kind)) {
    const found = findHost(project, op.id);
    if (found?.kind === 'object') migrateObjectParent(project, found.host);
    if (kind === 'objectParent') {
      if (op.parent == null || op.parent === '') return applySpatialParentOp(project, { op: 'spatialUnparent', id: op.id }, api);
      return applySpatialParentOp(project, {
        op: 'spatialParent', id: op.id, parent: op.parent, t: op.t, inherit: op.inherit, strength: op.strength,
      }, api);
    }
    if (kind === 'objectUnparent') return applySpatialParentOp(project, { op: 'spatialUnparent', id: op.id }, api);
    return applyParentStrengthOp(project, { ...op, op: kind === 'objectParentKey' ? 'spatialParentKey' : 'spatialParentUnkey' }, api);
  }
  if (!PARENT_STRENGTH_OP_KINDS.includes(kind)) return null;
  const found = findHost(project, op.id);
  if (!found) fail(`no element, object or camera ${op.id}`);
  const rec = recordOf(found);
  if (!rec) fail(`${op.id} has no spatial parent`);
  const ch = String(op.channel || '');
  if (!CHANNELS.includes(ch)) fail(`${kind} channel must be rot|scale`);
  const t = Number(op.t);
  if (!Number.isFinite(t)) fail(`${kind} needs t`);
  if (kind === 'spatialParentKey') {
    const raw = Number(op.v ?? op.value);
    if (!Number.isFinite(raw)) fail('spatialParentKey needs v (0..1)');
    writeKey(rec, ch, r6(t), r4(Math.max(0, Math.min(1, raw))), op.ease);
  } else if (!removeKey(rec, ch, t)) {
    fail(`no ${ch} strength key at ${t}`);
  }
  return { changed: [String(found.host.id)] };
}
