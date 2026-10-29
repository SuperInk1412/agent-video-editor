// Property links: a numeric property of one host follows a numeric property of
// another host (PLAN-ui-round3 §3.2–§3.3).
//
//   link = {
//     id: "lnk_1",
//     to: "pivot.y",                                  // property of the child host
//     from: { host: "el"|"ob"|"cam", id: "el_2", path: "pivot.x" },
//     combine: "add" | "mul",
//     bindParentValue: 0,                             // parent value when bound
//     enabled: true,
//   }
//
// Effective value of the child property at t:
//
//   add: eff = local + (parent(t) − bindParentValue)
//   mul: eff = local × parent(t) / bindParentValue      (ratio units: scale …)
//
// The parent value is resolved through the parent's own property links (the
// chain), but never through a spatial parent: links only see local property
// values. A disabled/missing parent, a cycle or a chain longer than
// MAX_LINK_DEPTH falls back to the local value instead of throwing, so broken
// data still renders. The graph is validated before a link is written
// (`wouldLinkCycle` / `linkChainDepth`), and shape validation is exposed through
// `linkIssues` / `projectLinkIssues` for core/schema.js.
//
// Only one host kind in the graph is forbidden: the `@live` screen lock. It is
// a render-time camera constraint, not a property value. Camera `position.*` is
// also rejected: it is path animation, not an authored scalar. Every other
// property path in the catalog below is a number in one unit family
// (length / angle / ratio / number); units are never auto-converted.
//
// Integration is deliberately one-sided: nothing in core/evaluate.js resolves
// links on its own. `elementOverlay` (2D `evalElement` consumers),
// `objectPoseWithLinks` and `cameraValueWithLinks` are the pure bridges; the
// picture producers call the wrappers in core/link-eval.js, which also thread
// the resolvers through spatial parents and the camera evaluator:
//
//   evalElement(el, t, meta, elementOverlay(project, el, t))      // core/evaluate.js
//   elementWorldNodeWithLinks(project, el, t)                     // 2D node viewport
//   objectWorldPoseWithLinks(project, obj, t)                     // 3D + shot bake
//   evalCameraWorldWithLinks(project, t, cam)                     // camera + shot bake
//   elementLinkOverlay / elementLinkOverlayTable(project, el, …)  // blender overlay
//
// This module imports no spatial module on purpose: core/spatial-parent.js →
// core/spatial.js → core/space.js → core/ops.js imports the op lists here, so a
// back-edge would be a TDZ cycle. core/link-eval.js sits above both.
import { isRecord, pathParts } from './json.js';
import { clamp, sampleTrack } from './time.js';
import { PX_PER_M, basisFromDir, objectPose, sampleAxes, sampleChannel } from './scene.js';
import { cameraParamValue, cameraTransform } from './camera.js';
import { dirRollFromRotation, rotationFromDirRoll } from './rotation.js';

/** Longest property-link chain (same limit as the spatial hierarchy). */
export const MAX_LINK_DEPTH = 32;
/** Most links a single host may carry. */
export const MAX_LINKS_PER_HOST = 64;
/** The legacy screen lock: a render constraint, never a property link source. */
export const SCREEN_PARENT = '@live';

/** Short host kinds used in link data (`from.host`). */
export const LINK_HOST_KINDS = Object.freeze(['el', 'ob', 'cam']);
/** Value families; a link may only connect equal units. */
export const LINK_UNITS = Object.freeze(['length', 'angle', 'ratio', 'number']);
/** `add` offsets, `mul` scales (default for ratios). */
export const LINK_COMBINES = Object.freeze(['add', 'mul']);

const HOST_ALIAS = Object.freeze({
  el: 'el', element: 'el', '2d': 'el',
  ob: 'ob', object: 'ob', '3d': 'ob',
  cam: 'cam', camera: 'cam',
});
const KIND_LABEL = Object.freeze({ el: 'element', ob: 'object', cam: 'camera' });

const isNum = (v) => (typeof v === 'number'
  ? Number.isFinite(v)
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const num = (v, d = 0) => (isNum(v) ? Number(v) : d);
const at0 = (t) => (isNum(t) ? Number(t) : 0);
const roundT = (t) => Math.round(Math.max(0, at0(t)) * 1000) / 1000;
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;

/** Screen-plane centre in world metres (mirrors core/space.js::screenCenterY). */
const screenCenterY = (meta) => (Number(meta?.height) || 1080) / PX_PER_M / 2;

function invalid(message) {
  const e = new Error(message);
  e.code = 'OP_INVALID';
  throw e;
}

/** `el`/`element`/`2d` … -> short kind. Throws for unknown host kinds. */
export function normalizeHostKind(value) {
  const kind = HOST_ALIAS[String(value ?? '').trim().toLowerCase()];
  if (!kind) invalid(`unknown link host ${value} (use el|ob|cam)`);
  return kind;
}

const hostKindOrNull = (value) => HOST_ALIAS[String(value ?? '').trim().toLowerCase()] || null;

// ---------------------------------------------------------------- type catalog
//
// A target is `{ path, unit, combine }`, where `combine` is the default for a
// new link: ratios (scale, opacity, volume) multiply and everything else adds.

const target = (path, unit) => Object.freeze({
  path,
  unit,
  combine: unit === 'ratio' ? 'mul' : 'add',
});

// Code parameters (§6.1): `code.params.<name>` is a plain number whose meaning
// (pixels, seconds, 0..1 …) is declared by the source manifest, which core
// cannot read. They therefore carry `unit: 'any'` and may link to any numeric
// channel. Nothing else is allowed to skip the unit check.
const ANY_UNIT = 'any';
const CODE_PARAM_PREFIX = 'code.params.';
const CODE_PARAM_RE = /^code\.params\.[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CODE_PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const unitsCompatible = (a, b) => a === b || a === ANY_UNIT || b === ANY_UNIT;
const codeParamTarget = (path) => Object.freeze({ path, unit: ANY_UNIT, combine: 'add' });

/** Parameter names a code element currently carries (base values only). */
function codeParamNames(host) {
  const params = isRecord(host?.code?.params) ? host.code.params : {};
  return Object.keys(params).filter((name) => CODE_PARAM_NAME_RE.test(name)).sort();
}

/** Element targets, plus one target per parameter when the host is a code layer. */
function elementTargets(host) {
  const base = isRecord(host?.node) ? NODE_ELEMENT_TARGETS : LEGACY_ELEMENT_TARGETS;
  if (!isRecord(host) || host.type !== 'code') return base;
  const names = codeParamNames(host);
  if (!names.length) return base;
  return [...base, ...names.map((name) => codeParamTarget(`${CODE_PARAM_PREFIX}${name}`))];
}

const NODE_TARGETS = Object.freeze([
  target('pivot.x', 'length'), target('pivot.y', 'length'), target('pivot.z', 'length'),
  target('position.x', 'length'), target('position.y', 'length'), target('position.z', 'length'),
  target('roll', 'angle'),
  target('rotation.x', 'angle'), target('rotation.y', 'angle'), target('rotation.z', 'angle'),
  target('scale.x', 'ratio'), target('scale.y', 'ratio'), target('scale.z', 'ratio'),
  target('opacity', 'ratio'),
]);

const ELEMENT_EXTRA_TARGETS = Object.freeze([
  target('style.size', 'length'),
  target('fx.glow', 'number'),
  target('audio.volume', 'ratio'),
]);

/** Legacy 2D elements: uniform scale, placement lives in `transform.*`. */
const LEGACY_ELEMENT_TARGETS = Object.freeze([
  target('pivot.x', 'length'), target('pivot.y', 'length'), target('pivot.z', 'length'),
  target('roll', 'angle'),
  target('scale.x', 'ratio'), target('scale.y', 'ratio'),
  target('opacity', 'ratio'),
  ...ELEMENT_EXTRA_TARGETS,
]);

const NODE_ELEMENT_TARGETS = Object.freeze([...NODE_TARGETS, ...ELEMENT_EXTRA_TARGETS]);

const CAMERA_TARGETS = Object.freeze([
  target('pivot.x', 'length'), target('pivot.y', 'length'), target('pivot.z', 'length'),
  target('roll', 'angle'),
  target('rotation.x', 'angle'), target('rotation.y', 'angle'), target('rotation.z', 'angle'),
  target('scale.x', 'ratio'), target('scale.y', 'ratio'), target('scale.z', 'ratio'),
  target('opacity', 'ratio'),
  target('fov', 'angle'),
  target('maxRoll', 'angle'),
  target('lookAhead', 'length'),
  target('bankGain', 'number'),
  target('dof.fstop', 'number'),
  target('shake.amp', 'number'),
  target('shake.freq', 'number'),
  target('shake.speedGain', 'number'),
  target('shake.seed', 'number'),
]);

/**
 * Linkable properties of a host, in UI order. `host` is needed for 2D elements:
 * a migrated element (`el.node`) exposes the full node model, a legacy one only
 * the fields it can write back into `transform.*`. Camera `position.*` is
 * intentionally absent (it is path animation).
 */
export function linkTargets(kind, host = null) {
  const k = normalizeHostKind(kind);
  if (k === 'cam') return CAMERA_TARGETS;
  if (k === 'ob') return NODE_TARGETS;
  return elementTargets(host);
}

/** Target descriptor for a host property, or null when it is not linkable. */
export function findLinkTarget(kind, host, path) {
  const key = path == null ? '' : String(path);
  if (!key) return null;
  // A code parameter that has no base value yet is still linkable: the source
  // manifest is the contract, and `vdm source check` reports unknown names.
  if (hostKindOrNull(kind) === 'el' && host?.type === 'code' && CODE_PARAM_RE.test(key)) return codeParamTarget(key);
  return linkTargets(kind, host).find((t) => t.path === key) || null;
}

// ---------------------------------------------------------------- host lookup

const elementList = (p) => (Array.isArray(p?.elements) ? p.elements.filter(isRecord) : []);
const objectList = (p) => (Array.isArray(p?.scene?.objects) ? p.scene.objects.filter(isRecord) : []);

function cameraList(p) {
  const list = (Array.isArray(p?.cameras) ? p.cameras : []).filter(isRecord);
  const legacy = isRecord(p?.camera) ? p.camera : null;
  if (legacy && !list.includes(legacy) && !list.some((c) => c && legacy.id != null && String(c.id) === String(legacy.id))) {
    list.push(legacy);
  }
  return list;
}

/** `[[kind, hosts[]], …]` for every linkable host in the project. */
export function linkHosts(project) {
  return [
    ['el', elementList(project)],
    ['ob', objectList(project)],
    ['cam', cameraList(project)],
  ];
}

/** Host by kind + id, or null. */
export function findHost(project, kind, id) {
  const key = id == null ? '' : String(id);
  if (!key) return null;
  const k = normalizeHostKind(kind);
  const list = k === 'el' ? elementList(project) : k === 'ob' ? objectList(project) : cameraList(project);
  return list.find((host) => String(host.id ?? '') === key) || null;
}

function findAnyHost(project, id) {
  const key = id == null ? '' : String(id);
  if (!key) return null;
  for (const [kind, hosts] of linkHosts(project)) {
    const host = hosts.find((h) => String(h.id ?? '') === key);
    if (host) return { kind, host, id: key };
  }
  return null;
}

/** Ref of a host object that is not necessarily part of the project. */
const hostRefFor = (kind, host) => ({ kind: normalizeHostKind(kind), host, id: String(host?.id ?? '') });

/**
 * Normalise a host reference. Accepted shapes:
 *   - host id string: resolved across elements, objects and cameras
 *   - `{ host:'el'|'ob'|'cam', id }` (a link's `from` also works)
 *   - `{ kind, host }` (an explicit host object, project membership not required)
 *   - a host object that belongs to the project (resolved by id)
 * Returns `{ kind, host, id }` or null.
 */
export function findLinkHost(project, ref) {
  if (typeof ref === 'string' || typeof ref === 'number') return findAnyHost(project, String(ref));
  if (!isRecord(ref)) return null;
  if (isRecord(ref.host) && ref.kind != null) {
    const kind = hostKindOrNull(ref.kind);
    return kind ? { kind, host: ref.host, id: String(ref.host.id ?? '') } : null;
  }
  const id = ref.id != null ? String(ref.id) : '';
  const kindValue = ref.host ?? ref.kind;
  if (kindValue != null) {
    const kind = hostKindOrNull(kindValue);
    if (!kind) return null;
    if (id) {
      const declared = findHost(project, kind, id);
      if (declared) {
        const actual = findAnyHost(project, id);
        return actual && actual.host === declared ? actual : { kind, host: declared, id };
      }
      return findAnyHost(project, id);
    }
    return null;
  }
  return id ? findAnyHost(project, id) : null;
}

// ---------------------------------------------------------------- link data

/** `{ host, id, path }` from any link source shape, or null when unusable. */
function normalizeFrom(raw) {
  if (!isRecord(raw)) return null;
  const kind = hostKindOrNull(raw.host);
  const id = raw.id != null ? String(raw.id) : '';
  const path = raw.path != null ? String(raw.path) : '';
  if (!kind || !id || !path || id === SCREEN_PARENT) return null;
  return { kind, id, path };
}

const sameFrom = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id && a.path === b.path;

/**
 * One normalised link. `{ strict: true }` throws OP_INVALID instead of dropping
 * unusable data (ops validate; loading is tolerant). Unknown fields are dropped
 * so the stored document stays predictable.
 */
export function normalizeLink(raw, opts = {}) {
  const strict = opts.strict === true;
  const drop = (message) => (strict ? invalid(message) : null);
  if (!isRecord(raw)) return drop('property link must be an object');
  const id = raw.id != null ? String(raw.id) : '';
  if (!id || id.length > 128) return drop('property link id must be a nonempty string of at most 128 characters');
  const to = raw.to != null ? String(raw.to) : '';
  if (!to) return drop('property link needs a target path');
  try { pathParts(to); } catch (e) { return drop(e.message); }
  const from = isRecord(raw.from) ? raw.from : null;
  if (!from) return drop('property link needs from {host,id,path}');
  if (from.id != null && String(from.id) === SCREEN_PARENT) return drop('@live is a screen lock, not a property link source');
  const source = normalizeFrom(from);
  if (!source) return drop('property link source needs host, id and path');
  try { pathParts(source.path); } catch (e) { return drop(e.message); }
  const combine = raw.combine === undefined || raw.combine === null
    ? (findLinkTarget(source.kind, null, source.path)?.combine ?? 'add')
    : String(raw.combine);
  if (!LINK_COMBINES.includes(combine)) return drop('property link combine must be add or mul');
  if (raw.bindParentValue === undefined && strict) return drop('property link bindParentValue is required');
  if (raw.bindParentValue !== undefined && !isNum(raw.bindParentValue)) return drop('property link bindParentValue must be a finite number');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return drop('property link enabled must be boolean');
  return {
    id,
    to,
    from: { host: source.kind, id: source.id, path: source.path },
    combine,
    bindParentValue: isNum(raw.bindParentValue) ? Number(raw.bindParentValue) : 0,
    enabled: raw.enabled !== false,
  };
}

/** Array normaliser: one link per target path, invalid entries dropped (or thrown in strict mode). */
export function normalizeLinks(raw, opts = {}) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    if (opts.strict === true) invalid('links must be an array');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const link = normalizeLink(entry, opts);
    if (!link) continue;
    if (seen.has(link.to)) {
      if (opts.strict === true) invalid(`duplicate property link for ${link.to}`);
      continue;
    }
    seen.add(link.to);
    out.push(link);
    if (out.length >= MAX_LINKS_PER_HOST) {
      if (opts.strict === true) invalid(`at most ${MAX_LINKS_PER_HOST} property links per host`);
      break;
    }
  }
  return out;
}

/** Shape problems of a raw `links` array (used by core/schema.js::validateProject). */
export function linkIssues(links, at = 'links') {
  const issues = [];
  const push = (path, msg) => issues.push({ path, msg });
  if (links === undefined) return issues;
  if (!Array.isArray(links)) { push(at, 'must be an array'); return issues; }
  const seen = new Set();
  links.forEach((link, i) => {
    const loc = `${at}[${i}]`;
    if (!isRecord(link)) { push(loc, 'must be an object'); return; }
    if (typeof link.id !== 'string' || !link.id || link.id.length > 128) push(`${loc}.id`, 'must be a nonempty string of at most 128 characters');
    if (typeof link.to !== 'string' || !link.to) push(`${loc}.to`, 'must be a nonempty property path');
    else {
      try { pathParts(link.to); } catch (e) { push(`${loc}.to`, e.message); }
      if (seen.has(link.to)) push(`${loc}.to`, `duplicate link for ${link.to}`);
      seen.add(link.to);
    }
    if (!isRecord(link.from)) push(`${loc}.from`, 'must be an object');
    else {
      if (!hostKindOrNull(link.from.host)) push(`${loc}.from.host`, 'must be el, ob or cam');
      if (typeof link.from.id !== 'string' || !link.from.id) push(`${loc}.from.id`, 'must be a nonempty host id');
      else if (link.from.id === SCREEN_PARENT) push(`${loc}.from.id`, '@live is a screen lock, not a property link source');
      if (typeof link.from.path !== 'string' || !link.from.path) push(`${loc}.from.path`, 'must be a nonempty property path');
      else { try { pathParts(link.from.path); } catch (e) { push(`${loc}.from.path`, e.message); } }
    }
    if (!LINK_COMBINES.includes(link.combine)) push(`${loc}.combine`, 'must be add or mul');
    if (!isNum(link.bindParentValue)) push(`${loc}.bindParentValue`, 'must be a finite number');
    if (link.enabled !== undefined && typeof link.enabled !== 'boolean') push(`${loc}.enabled`, 'must be boolean');
  });
  return issues;
}

// ---------------------------------------------------------------- graph
//
// Every link is an edge from (child host, to) to (parent host, from.path); the
// parent's own links continue the chain. Disabled links stay in the graph for
// validation (enabling one must not silently create a cycle), but they are
// skipped when values are resolved.

const nodeKeyOf = (kind, host, path) => `${kind}:${host?.id ?? '?'}:${path}`;

/** Any link for a target path (enabled or not): graph edges. */
function findAnyLink(host, path) {
  const links = Array.isArray(host?.links) ? host.links : [];
  const key = String(path ?? '');
  return links.find((link) => isRecord(link) && String(link.to ?? '') === key) || null;
}

/** The active link for a target path, or null. */
function activeLink(host, path) {
  const link = findAnyLink(host, path);
  return link && link.enabled !== false ? link : null;
}

function followSource(project, link) {
  const from = normalizeFrom(link?.from);
  if (!from) return null;
  const declared = findHost(project, from.kind, from.id);
  if (declared) return { kind: from.kind, host: declared, path: from.path };
  const any = findAnyHost(project, from.id);
  return any ? { kind: any.kind, host: any.host, path: from.path } : null;
}

/**
 * Links that sit above `host.path` (the node's own link excluded).
 * Returns the chain length; `Infinity` when the graph loops.
 */
export function linkChainDepth(project, host, path) {
  const ref = findLinkHost(project, host);
  if (!ref) return 0;
  const seen = new Set();
  let kind = ref.kind;
  let current = ref.host;
  let currentPath = String(path ?? '');
  let depth = 0;
  while (true) {
    const key = nodeKeyOf(kind, current, currentPath);
    if (seen.has(key)) return Infinity;
    seen.add(key);
    const link = findAnyLink(current, currentPath);
    if (!link) return depth;
    depth += 1;
    const next = followSource(project, link);
    if (!next) return depth;
    kind = next.kind;
    current = next.host;
    currentPath = next.path;
  }
}

/**
 * True when adding `child.to -> from` would close a loop in the property graph.
 * `child` is a host ref/id, `from` a `{host,id,path}` source.
 */
export function wouldLinkCycle(project, child, to, from) {
  const childRef = findLinkHost(project, child);
  const parentRef = findLinkHost(project, from);
  if (!childRef || !parentRef) return false;
  const parentPath = String(from?.path ?? '');
  const seen = new Set([nodeKeyOf(childRef.kind, childRef.host, String(to ?? ''))]);
  let kind = parentRef.kind;
  let current = parentRef.host;
  let currentPath = parentPath;
  for (let guard = 0; guard <= MAX_LINK_DEPTH + 1; guard += 1) {
    if (!current) return false;
    const key = nodeKeyOf(kind, current, currentPath);
    if (seen.has(key)) return true;
    seen.add(key);
    const link = findAnyLink(current, currentPath);
    if (!link) return false;
    const next = followSource(project, link);
    if (!next) return false;
    kind = next.kind;
    current = next.host;
    currentPath = next.path;
  }
  return false;
}

/** Graph problems of a whole project (unknown hosts/paths, units, cycles, depth). */
export function projectLinkIssues(project) {
  const issues = [];
  const push = (path, msg) => issues.push({ path, msg });
  for (const [kind, hosts, at] of [
    ['el', elementList(project), 'elements'],
    ['ob', objectList(project), 'scene.objects'],
    ['cam', cameraList(project), 'cameras'],
  ]) {
    hosts.forEach((host, i) => {
      const links = Array.isArray(host?.links) ? host.links : [];
      if (!links.length) return;
      links.forEach((link, j) => {
        if (!isRecord(link)) return; // shape issues come from linkIssues()
        const loc = `${at}[${i}].links[${j}]`;
        const to = typeof link.to === 'string' ? link.to : '';
        const target = to ? findLinkTarget(kind, host, to) : null;
        if (to && !target) {
          push(`${loc}.to`, `${KIND_LABEL[kind]} ${host.id ?? i} has no linkable property ${to}`);
        }
        const from = normalizeFrom(link.from);
        if (!from) return; // shape issue / @live, already reported
        const sourceKind = from.kind;
        let sourceHost = findHost(project, sourceKind, from.id);
        if (!sourceHost) {
          const any = findAnyHost(project, from.id);
          if (!any) { push(`${loc}.from.id`, `unknown host ${from.id}`); return; }
          push(`${loc}.from.host`, `host ${from.id} is a ${KIND_LABEL[any.kind]}, not a ${KIND_LABEL[sourceKind]}`);
          sourceHost = any.host;
        }
        const sourceTarget = findLinkTarget(sourceKind, sourceHost, from.path);
        if (!sourceTarget) {
          push(`${loc}.from.path`, `${KIND_LABEL[sourceKind]} ${sourceHost.id ?? from.id} has no readable property ${from.path}`);
          return;
        }
        if (target && !unitsCompatible(target.unit, sourceTarget.unit)) {
          push(loc, `unit mismatch: ${to} is ${target.unit}, ${from.path} is ${sourceTarget.unit}`);
        }
        if (!target) return;
        if (wouldLinkCycle(project, { host: kind, id: String(host.id ?? '') }, to, link.from)) {
          push(loc, 'property link cycle');
          return;
        }
        if (linkChainDepth(project, { host: kind, id: String(host.id ?? '') }, to) > MAX_LINK_DEPTH) {
          push(loc, `property link chain deeper than ${MAX_LINK_DEPTH}`);
        }
      });
    });
  }
  return issues;
}

// ---------------------------------------------------------------- local values
//
// One reader/writer per host kind. Readers never mutate; writers keep keyframes
// (update the key at t, or insert one on an already keyed track) and only touch
// base values for unkeyed properties.

const VEC_GROUPS = new Set(['pivot', 'position', 'scale']);
const groupFallback = (group) => (group === 'scale' ? [1, 1, 1] : [0, 0, 0]);

function objectLocal(obj, path, t) {
  if (!isRecord(obj)) return null;
  const tracks = isRecord(obj.tracks) ? obj.tracks : {};
  const dot = path.indexOf('.');
  const group = dot < 0 ? path : path.slice(0, dot);
  const axis = dot < 0 ? '' : path.slice(dot + 1);
  if (VEC_GROUPS.has(group)) {
    const i = 'xyz'.indexOf(axis);
    if (i < 0) return null;
    const value = sampleAxes(tracks, group, t, obj[group] ?? groupFallback(group))[i];
    return isNum(value) ? Number(value) : null;
  }
  if (path === 'roll') return num(sampleChannel(tracks.roll, t, num(obj.rot?.roll, 0)), 0);
  if (path.startsWith('rotation.')) {
    const i = 'xyz'.indexOf(path.slice(9));
    if (i < 0) return null;
    const pose = objectPose(obj, t);
    const base = Array.isArray(pose.rotation) ? pose.rotation : rotationFromDirRoll(pose.dir, pose.roll);
    const value = sampleChannel(tracks[path], t, base[i]);
    return isNum(value) ? Number(value) : null;
  }
  if (path === 'opacity') return num(sampleChannel(tracks.opacity, t, num(obj.opacity, 1)), 1);
  return null;
}

function cameraLocal(cam, path, t) {
  if (!isRecord(cam)) return null;
  const st = cameraTransform(cam, t);
  if (path.startsWith('pivot.')) {
    const i = 'xyz'.indexOf(path.slice(6));
    return i < 0 ? null : num(st.center[i], 0);
  }
  if (path.startsWith('scale.')) {
    const i = 'xyz'.indexOf(path.slice(6));
    return i < 0 ? null : num(st.scale[i], 1);
  }
  if (path === 'opacity') return num(st.opacity, 1);
  if (path.startsWith('rotation.')) {
    const i = 'xyz'.indexOf(path.slice(9));
    if (i < 0) return null;
    const base = Array.isArray(cam.rotation) ? cam.rotation : [0, 0, 0];
    const value = sampleChannel(cam?.tracks?.[path], t, base[i]);
    return isNum(value) ? Number(value) : null;
  }
  // position.* resolves to null on purpose: the camera position is path
  // animation (PLAN-ui-round3 §3.3), not a linkable scalar.
  if (['roll', 'fov', 'maxRoll', 'lookAhead', 'bankGain', 'dof.fstop'].includes(path)
    || path.startsWith('shake.')) {
    const value = cameraParamValue(cam, path, t);
    return isNum(value) ? Number(value) : null;
  }
  return null;
}

function elementLocal(el, meta, path, t) {
  if (!isRecord(el)) return null;
  const keys = Array.isArray(el.keyframes) ? el.keyframes : [];
  const tr = isRecord(el.transform) ? el.transform : {};
  if (path === 'opacity') return num(sampleTrack(keys, 'transform.opacity', t, num(tr.opacity, 1)), 1);
  if (path === 'style.size') return num(sampleTrack(keys, 'style.size', t, num(el.style?.size, 96)), 96);
  if (path === 'fx.glow') return num(sampleTrack(keys, 'fx.glow', t, num(el.fx?.glow, 0)), 0);
  if (path === 'audio.volume') return num(sampleTrack(keys, 'audio.volume', t, num(el.volume, 1)), 1);
  if (path.startsWith(CODE_PARAM_PREFIX)) {
    // Code parameters (§6.1): the element stores the current value, keyframes
    // live at `code.params.<name>`. Property links are numeric, so only numeric
    // parameters resolve here; strings / booleans / colours are sampled by
    // core/code-layer.js::codeParamsAt (which steps them at the key).
    const name = path.slice(CODE_PARAM_PREFIX.length);
    const base = isRecord(el.code?.params) ? el.code.params[name] : undefined;
    if (typeof base !== 'number' || !Number.isFinite(base)) return null;
    return num(sampleTrack(keys, path, t, base), base);
  }
  const node = isRecord(el.node) ? el.node : null;
  if (node) {
    // Migrated 2D element: `el.node` is the transform source, node channels are
    // element keyframes (`pivot.z`, `position.x`, `scale.x`, `roll`, …) as
    // PLAN-ui-round3 §2.3 converts them.
    if (path === 'roll') return num(sampleTrack(keys, 'roll', t, num(node.roll, 0)), 0);
    if (path.startsWith('rotation.')) {
      const i = 'xyz'.indexOf(path.slice(9));
      if (i < 0) return null;
      const base = Array.isArray(node.rotation) ? node.rotation : rotationFromDirRoll(node.dir, node.roll);
      return num(sampleTrack(keys, path, t, base[i]), base[i]);
    }
    const dot = path.indexOf('.');
    const group = dot < 0 ? path : path.slice(0, dot);
    const axis = dot < 0 ? '' : path.slice(dot + 1);
    if (!VEC_GROUPS.has(group)) return null;
    const i = 'xyz'.indexOf(axis);
    if (i < 0) return null;
    const fallback = groupFallback(group)[i];
    const base = Array.isArray(node[group]) && isNum(node[group][i]) ? Number(node[group][i]) : fallback;
    return num(sampleTrack(keys, path, t, base), fallback);
  }
  // Legacy 2D element: read the same node view core/spatial.js::legacyElementNode
  // derives (kept local so this module does not import schema/space and create
  // an import cycle; tests/links.test.mjs cross-checks both).
  const get = (property, fallback) => sampleTrack(keys, property, t, fallback);
  if (path === 'pivot.x' || path === 'pivot.y' || path === 'pivot.z') {
    const x = num(get('transform.x', tr.x), 0);
    const y = num(get('transform.y', tr.y), 0);
    const z = num(get('transform.z', tr.z), 0);
    if (path === 'pivot.x') return x / PX_PER_M;
    if (path === 'pivot.y') return screenCenterY(meta) - y / PX_PER_M;
    return z;
  }
  if (path === 'roll') return num(get('transform.rotation', tr.rotation), 0);
  if (path === 'scale.x' || path === 'scale.y') return num(get('transform.scale', tr.scale), 1);
  return null;
}

function localValue(project, kind, host, path, t) {
  const value = kind === 'el'
    ? elementLocal(host, project?.meta || {}, path, t)
    : kind === 'ob'
      ? objectLocal(host, path, t)
      : cameraLocal(host, path, t);
  return isNum(value) ? Number(value) : null;
}

function upsertElementKey(el, path, t, value) {
  const keys = Array.isArray(el.keyframes) ? el.keyframes : (el.keyframes = []);
  const index = keys.findIndex((k) => isRecord(k) && k.path === path && Math.abs(Number(k.t) - t) < 1e-4);
  const old = index >= 0 ? keys[index] : null;
  const key = { t: roundT(t), path, value, ease: old?.ease || 'easeInOut' };
  if (old?.curve) key.curve = old.curve;
  if (index >= 0) keys[index] = key; else keys.push(key);
  keys.sort((a, b) => Number(a.t) - Number(b.t));
}

function setElementValue(el, track, t, value, setBase) {
  const keyed = Array.isArray(el.keyframes) && el.keyframes.some((k) => isRecord(k) && k.path === track);
  if (keyed) upsertElementKey(el, track, t, value);
  else setBase(value);
}

function writeNodeField(node, path, value) {
  if (path === 'roll') { node.roll = value; return; }
  if (path.startsWith('rotation.')) {
    const i = 'xyz'.indexOf(path.slice(9));
    if (i < 0) return;
    const base = Array.isArray(node.rotation)
      ? node.rotation.slice()
      : rotationFromDirRoll(node.dir, node.roll);
    base[i] = value;
    node.rotation = base;
    return;
  }
  const dot = path.indexOf('.');
  const group = dot < 0 ? path : path.slice(0, dot);
  const i = 'xyz'.indexOf(dot < 0 ? '' : path.slice(dot + 1));
  if (!VEC_GROUPS.has(group) || i < 0) return;
  const fallback = groupFallback(group);
  const arr = Array.isArray(node[group]) ? node[group].slice() : fallback.slice();
  arr[i] = value;
  node[group] = arr;
}

function writeElementLocal(el, meta, path, t, value) {
  if (!isRecord(el)) return false;
  const node = isRecord(el.node) ? el.node : null;
  if (path === 'opacity') {
    setElementValue(el, 'transform.opacity', t, clamp(value), (v) => {
      el.transform = isRecord(el.transform) ? el.transform : {};
      el.transform.opacity = v;
    });
    return true;
  }
  if (path === 'style.size') {
    setElementValue(el, 'style.size', t, value, (v) => {
      el.style = isRecord(el.style) ? el.style : {};
      el.style.size = v;
    });
    return true;
  }
  if (path === 'fx.glow') {
    setElementValue(el, 'fx.glow', t, value, (v) => {
      el.fx = isRecord(el.fx) ? el.fx : {};
      el.fx.glow = v;
    });
    return true;
  }
  if (path === 'audio.volume') {
    setElementValue(el, 'audio.volume', t, clamp(value), (v) => { el.volume = v; });
    return true;
  }
  if (path.startsWith(CODE_PARAM_PREFIX)) {
    const name = path.slice(CODE_PARAM_PREFIX.length);
    if (!CODE_PARAM_NAME_RE.test(name)) return false;
    el.code = isRecord(el.code) ? el.code : { source: '', params: {}, seed: 0, size: null, cache: 'live' };
    el.code.params = isRecord(el.code.params) ? el.code.params : {};
    setElementValue(el, path, t, value, (v) => { el.code.params[name] = v; });
    return true;
  }
  if (node) {
    setElementValue(el, path, t, value, (v) => writeNodeField(node, path, v));
    return true;
  }
  const tr = isRecord(el.transform) ? (el.transform = el.transform || {}) : (el.transform = {});
  if (path === 'pivot.x') {
    setElementValue(el, 'transform.x', t, value * PX_PER_M, (v) => { tr.x = v; });
    return true;
  }
  if (path === 'pivot.y') {
    setElementValue(el, 'transform.y', t, (screenCenterY(meta) - value) * PX_PER_M, (v) => { tr.y = v; });
    return true;
  }
  if (path === 'pivot.z') {
    setElementValue(el, 'transform.z', t, value, (v) => { tr.z = v; });
    return true;
  }
  if (path === 'roll') {
    setElementValue(el, 'transform.rotation', t, value, (v) => { tr.rotation = v; });
    return true;
  }
  if (path === 'scale.x' || path === 'scale.y') {
    setElementValue(el, 'transform.scale', t, value, (v) => { tr.scale = v; });
    return true;
  }
  return false;
}

function upsertChannelKey(tracks, name, t, value) {
  const list = Array.isArray(tracks[name]) ? tracks[name] : (tracks[name] = []);
  const index = list.findIndex((k) => isRecord(k) && Math.abs(Number(k.t) - t) < 1e-4);
  const old = index >= 0 ? list[index] : null;
  const key = { t: roundT(t), v: Array.isArray(value) ? value.slice() : value };
  if (old?.ease) key.ease = old.ease;
  if (old?.curve) key.curve = old.curve;
  if (index >= 0) list[index] = key; else list.push(key);
  list.sort((a, b) => Number(a.t) - Number(b.t));
}

function setChannelValue(tracks, name, t, value, setBase) {
  if (Array.isArray(tracks[name]) && tracks[name].length) upsertChannelKey(tracks, name, t, value);
  else setBase(value);
  return true;
}

function writeObjectVec(obj, tracks, group, axis, t, value) {
  const i = 'xyz'.indexOf(axis);
  if (i < 0) return false;
  const fallback = groupFallback(group);
  const base = Array.isArray(obj[group]) ? obj[group].slice() : fallback.slice();
  if (Array.isArray(tracks[group]) && tracks[group].length) {
    const sampled = sampleAxes(tracks, group, t, base);
    const next = [sampled[0], sampled[1], sampled[2]];
    next[i] = value;
    upsertChannelKey(tracks, group, t, next);
    return true;
  }
  if (Array.isArray(tracks[`${group}.${axis}`]) && tracks[`${group}.${axis}`].length) {
    upsertChannelKey(tracks, `${group}.${axis}`, t, value);
    return true;
  }
  base[i] = value;
  obj[group] = base;
  return true;
}

function writeObjectLocal(obj, path, t, value) {
  if (!isRecord(obj)) return false;
  const tracks = isRecord(obj.tracks) ? obj.tracks : (obj.tracks = {});
  if (path === 'roll') {
    return setChannelValue(tracks, 'roll', t, value, (v) => {
      obj.rot = { ...(isRecord(obj.rot) ? obj.rot : {}), roll: v };
    });
  }
  if (path.startsWith('rotation.')) {
    const i = 'xyz'.indexOf(path.slice(9));
    if (i < 0) return false;
    if (Array.isArray(tracks[path]) && tracks[path].length) {
      upsertChannelKey(tracks, path, t, value);
      return true;
    }
    const pose = objectPose(obj, t);
    const base = Array.isArray(obj.rotation)
      ? obj.rotation.slice()
      : rotationFromDirRoll(pose.dir, pose.roll);
    base[i] = value;
    obj.rotation = base;
    return true;
  }
  if (path === 'opacity') {
    const v = clamp(value);
    return setChannelValue(tracks, 'opacity', t, v, (nv) => { obj.opacity = nv; });
  }
  const dot = path.indexOf('.');
  const group = dot < 0 ? path : path.slice(0, dot);
  if (!VEC_GROUPS.has(group)) return false;
  return writeObjectVec(obj, tracks, group, path.slice(dot + 1), t, value);
}

function writeCameraVec(cam, tracks, group, axis, t, value) {
  const i = 'xyz'.indexOf(axis);
  if (i < 0) return false;
  const defaults = group === 'scale' ? [1, 1, 1] : [0, 0, 0];
  const base = Array.isArray(cam[group]) ? cam[group].slice() : defaults.slice();
  if (Array.isArray(tracks[group]) && tracks[group].length) {
    const sampled = sampleAxes(tracks, group, t, base);
    const next = [sampled[0], sampled[1], sampled[2]];
    next[i] = value;
    upsertChannelKey(tracks, group, t, next);
    return true;
  }
  if (Array.isArray(tracks[`${group}.${axis}`]) && tracks[`${group}.${axis}`].length) {
    upsertChannelKey(tracks, `${group}.${axis}`, t, value);
    return true;
  }
  base[i] = value;
  cam[group] = base;
  return true;
}

function writeCameraLocal(cam, path, t, value) {
  if (!isRecord(cam)) return false;
  const tracks = isRecord(cam.tracks) ? cam.tracks : (cam.tracks = {});
  if (path.startsWith('pivot.')) return writeCameraVec(cam, tracks, 'center', path.slice(6), t, value);
  if (path.startsWith('scale.')) return writeCameraVec(cam, tracks, 'scale', path.slice(6), t, value);
  if (path === 'opacity') {
    const v = clamp(value);
    return setChannelValue(tracks, 'opacity', t, v, (nv) => { cam.opacity = nv; });
  }
  if (path === 'roll') return setChannelValue(tracks, 'roll', t, value, (v) => { cam.roll = v; });
  if (path.startsWith('rotation.')) {
    const i = 'xyz'.indexOf(path.slice(9));
    if (i < 0) return false;
    if (Array.isArray(tracks[path]) && tracks[path].length) {
      upsertChannelKey(tracks, path, t, value);
      return true;
    }
    const base = Array.isArray(cam.rotation) ? cam.rotation.slice() : [0, 0, 0];
    base[i] = value;
    cam.rotation = base;
    return true;
  }
  if (path === 'fov') {
    const v = clamp(value, 1, 360);
    // A path key may carry fov; writing a track key overrides it without
    // rewriting the camera path (which needs a position).
    const pathKeyed = (Array.isArray(cam.path) ? cam.path : []).some((k) => isRecord(k) && k.fov != null);
    if (pathKeyed || (Array.isArray(tracks.fov) && tracks.fov.length)) {
      upsertChannelKey(tracks, 'fov', t, v);
      return true;
    }
    cam.fov = v;
    return true;
  }
  if (path === 'maxRoll') {
    const v = clamp(value, 0, 60);
    return setChannelValue(tracks, 'maxRoll', t, v, (nv) => { cam.maxRoll = nv; });
  }
  if (path === 'lookAhead') {
    return setChannelValue(tracks, 'lookAhead', t, Math.max(1, value), (v) => { cam.lookAhead = v; });
  }
  if (path === 'bankGain') return setChannelValue(tracks, 'bankGain', t, value, (v) => { cam.bankGain = v; });
  if (path === 'dof.fstop') {
    const v = clamp(value, 0.5, 32);
    return setChannelValue(tracks, 'dof.fstop', t, v, (nv) => {
      cam.dof = { ...(isRecord(cam.dof) ? cam.dof : {}), fstop: nv };
    });
  }
  if (path.startsWith('shake.')) {
    const channel = path.slice(6);
    const v = channel === 'amp' || channel === 'speedGain'
      ? Math.max(0, value)
      : channel === 'freq' ? Math.max(0.1, value) : value;
    return setChannelValue(tracks, path, t, v, (nv) => {
      cam.shake = { ...(isRecord(cam.shake) ? cam.shake : {}), [channel]: nv };
    });
  }
  return false;
}

function writeLocalValue(project, kind, host, path, t, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  if (kind === 'el') return writeElementLocal(host, project?.meta || {}, path, t, v);
  if (kind === 'ob') return writeObjectLocal(host, path, t, v);
  return writeCameraLocal(host, path, t, v);
}

// ---------------------------------------------------------------- resolution

const contributionFor = (local, link, parentValue) => {
  const bind = isNum(link.bindParentValue) ? Number(link.bindParentValue) : 0;
  if (link.combine === 'mul') {
    if (Math.abs(bind) < 1e-9) return 0;
    return local * (parentValue / bind - 1);
  }
  return parentValue - bind;
};

function parentOf(project, link, t, ctx) {
  const source = followSource(project, link);
  if (!source) return null;
  if (!findLinkTarget(source.kind, source.host, source.path)) return null;
  return effectiveValue(project, source.kind, source.host, source.path, t, {
    depth: ctx.depth + 1,
    visiting: ctx.visiting,
    ids: ctx.ids,
  });
}

function nodeKey(ctx, kind, host, path) {
  if (!ctx.ids.has(host)) ctx.ids.set(host, ctx.ids.size + 1);
  return `${kind}#${ctx.ids.get(host)}:${path}`;
}

function effectiveValue(project, kind, host, path, t, ctx) {
  const local = localValue(project, kind, host, path, t);
  if (local == null) return null;
  if (ctx.depth >= MAX_LINK_DEPTH) return local;
  const key = nodeKey(ctx, kind, host, path);
  if (ctx.visiting.has(key)) return local;
  const link = activeLink(host, path);
  if (!link) return local;
  ctx.visiting.add(key);
  const parent = parentOf(project, link, t, ctx);
  ctx.visiting.delete(key);
  return parent == null ? local : local + contributionFor(local, link, parent);
}

const newContext = () => ({ depth: 0, visiting: new Set(), ids: new Map() });

function effectiveFor(project, ref, path, t) {
  const at = at0(t);
  return effectiveValue(project, ref.kind, ref.host, String(path), at, newContext());
}

/** Value stored on the host at t, ignoring the host's own links. */
export function resolveLocalValue(project, host, path, t) {
  const ref = findLinkHost(project, host);
  if (!ref) return null;
  return localValue(project, ref.kind, ref.host, String(path), at0(t));
}

/**
 * Effective value at t: local value plus the chain of property links.
 * Returns null for paths that are not linkable on that host.
 */
export function resolveEffectiveValue(project, host, path, t) {
  const ref = findLinkHost(project, host);
  if (!ref) return null;
  return effectiveFor(project, ref, path, at0(t));
}

/**
 * Numeric add-delta a link contributes at t (0 when disabled, missing or
 * unlinkable). `opts.local` skips re-sampling the child's local value.
 */
export function linkContribution(project, host, link, t, opts = {}) {
  const ref = findLinkHost(project, host);
  if (!ref || !isRecord(link) || link.enabled === false) return 0;
  const path = String(link.to ?? '');
  const local = isNum(opts.local) ? Number(opts.local) : localValue(project, ref.kind, ref.host, path, at0(t));
  if (local == null) return 0;
  const ctx = newContext();
  ctx.visiting.add(nodeKey(ctx, ref.kind, ref.host, path));
  const parent = parentOf(project, link, at0(t), ctx);
  return parent == null ? 0 : contributionFor(local, link, parent);
}

/**
 * Inverse of `resolveEffectiveValue` for the host's single link on `path`:
 * the local value an editor must store so the effective value becomes
 * `effective` at t. Returns null when the link cannot be inverted (mul on a
 * zero parent ratio).
 */
export function writeBackLocalValue(project, host, path, t, effective) {
  const ref = findLinkHost(project, host);
  const eff = Number(effective);
  if (!ref || !Number.isFinite(eff)) return null;
  const key = String(path);
  if (!findLinkTarget(ref.kind, ref.host, key)) return null;
  const link = activeLink(ref.host, key);
  if (!link) return eff;
  const local = localValue(project, ref.kind, ref.host, key, at0(t));
  if (local == null) return null;
  const ctx = newContext();
  ctx.visiting.add(nodeKey(ctx, ref.kind, ref.host, key));
  const parent = parentOf(project, link, at0(t), ctx);
  if (parent == null) return eff;
  if (link.combine === 'mul') {
    const bind = Number(link.bindParentValue);
    if (!Number.isFinite(bind) || Math.abs(bind) < 1e-9) return eff;
    const ratio = parent / bind;
    return Math.abs(ratio) < 1e-12 ? null : eff / ratio;
  }
  const bind = isNum(link.bindParentValue) ? Number(link.bindParentValue) : 0;
  return eff - (parent - bind);
}

// ---------------------------------------------------------------- eval bridges
//
// Pure adapters: they never mutate the project and never pick a renderer. The
// preview/bake/timeline opt in by calling them (see the TODO at the top).

const hasLink = (host, path) => Array.isArray(host?.links)
  && host.links.some((link) => isRecord(link) && link.enabled !== false && link.to === path);

/**
 * Effective `evalElement` fields, in legacy units (x/y in project pixels, z in
 * metres, rotation in degrees, uniform scale).
 *
 * Legacy 2D elements get every linked channel. A migrated element (`el.node`)
 * renders its placement through the node model (core/link-eval.js::
 * elementNodeWithLinks), so only the non-node fields it still reads through
 * `evalElement` are returned here: opacity, style.size and fx.glow.
 */
export function elementOverlay(project, el, t) {
  if (!isRecord(el)) return null;
  if (!Array.isArray(el.links) || !el.links.length) return null;
  const node = isRecord(el.node);
  const ref = hostRefFor('el', el);
  const cy = screenCenterY(project?.meta || {});
  const value = (path) => effectiveFor(project, ref, path, t);
  const out = {};
  if (!node) {
    if (hasLink(el, 'pivot.x')) out.x = value('pivot.x') * PX_PER_M;
    if (hasLink(el, 'pivot.y')) out.y = (cy - value('pivot.y')) * PX_PER_M;
    if (hasLink(el, 'pivot.z')) out.z = value('pivot.z');
    if (hasLink(el, 'scale.x')) out.scale = value('scale.x');
    else if (hasLink(el, 'scale.y')) out.scale = value('scale.y');
    if (hasLink(el, 'roll')) out.rotation = value('roll');
  }
  if (hasLink(el, 'opacity')) out.opacity = value('opacity');
  if (hasLink(el, 'style.size')) out.size = value('style.size');
  if (hasLink(el, 'fx.glow')) out.glow = value('fx.glow');
  for (const key of Object.keys(out)) if (!Number.isFinite(out[key])) delete out[key];
  return Object.keys(out).length ? out : null;
}

/** `objectPose(obj, t)` with the object's linked channels replaced by their effective values. */
export function objectPoseWithLinks(project, obj, t) {
  const pose = objectPose(obj, t);
  if (!isRecord(obj) || !Array.isArray(obj.links) || !obj.links.length) return pose;
  const ref = hostRefFor('ob', obj);
  const value = (path) => effectiveFor(project, ref, path, t);
  const out = { ...pose, pivot: pose.pivot.slice(), position: pose.position.slice(), scale: pose.scale.slice() };
  let moved = false;
  for (const [group, list] of [['pivot', out.pivot], ['position', out.position], ['scale', out.scale]]) {
    for (let i = 0; i < 3; i += 1) {
      const path = `${group}.${'xyz'[i]}`;
      if (!hasLink(obj, path)) continue;
      const v = value(path);
      if (Number.isFinite(v)) { list[i] = v; moved = true; }
    }
  }
  if (hasLink(obj, 'roll')) {
    const v = value('roll');
    if (Number.isFinite(v)) { out.roll = v; moved = true; }
  }
  if (['rotation.x', 'rotation.y', 'rotation.z'].some((p) => hasLink(obj, p))) {
    const base = Array.isArray(out.rotation) ? out.rotation.slice() : rotationFromDirRoll(out.dir, out.roll);
    for (let i = 0; i < 3; i += 1) {
      const path = `rotation.${'xyz'[i]}`;
      if (!hasLink(obj, path)) continue;
      const v = value(path);
      if (Number.isFinite(v)) { base[i] = v; moved = true; }
    }
    out.rotation = base;
    const rr = dirRollFromRotation(base);
    out.dir = rr.dir;
    out.roll = rr.roll;
  }
  if (hasLink(obj, 'opacity')) {
    const v = value('opacity');
    if (Number.isFinite(v)) out.opacity = clamp(v);
  }
  if (moved) {
    out.basis = basisFromDir(out.dir, out.roll);
    const basis = out.basis;
    out.worldPos = [
      out.pivot[0] + basis.right[0] * out.position[0] + basis.up[0] * out.position[1] + basis.forward[0] * out.position[2],
      out.pivot[1] + basis.right[1] * out.position[0] + basis.up[1] * out.position[1] + basis.forward[1] * out.position[2],
      out.pivot[2] + basis.right[2] * out.position[0] + basis.up[2] * out.position[1] + basis.forward[2] * out.position[2],
    ];
  }
  return out;
}

/** `cameraParamValue(cam, path, t)` with the camera's links applied. */
export function cameraValueWithLinks(project, cam, path, t) {
  const key = String(path);
  if (!isRecord(cam)) return null;
  const ref = hostRefFor('cam', cam);
  const value = effectiveFor(project, ref, key, t);
  return value == null ? cameraLocal(cam, key, at0(t)) : value;
}

// ---------------------------------------------------------------- ops
//
// Dispatched from core/ops.js (same contract as the core switch): mutate the
// project in place, return `{ changed }`, throw OP_INVALID on bad input. One
// op = one undo step: a bind or a re-bind never spans several ops.

export const LINK_OP_KINDS = Object.freeze(['propLink', 'propLinkPatch', 'propUnlink']);

function childRef(project, op, fail) {
  const id = op.id == null ? '' : String(op.id);
  if (!id) fail(`${op.op} needs id`);
  if (op.host != null) {
    const kind = normalizeHostKind(op.host);
    const host = findHost(project, kind, id);
    if (!host) fail(`no ${KIND_LABEL[kind]} ${id}`);
    return { kind, host };
  }
  const ref = findAnyHost(project, id);
  if (!ref) fail(`no host ${id}`);
  return { kind: ref.kind, host: ref.host };
}

function sourceRef(project, raw, fail) {
  if (!isRecord(raw)) fail('property link needs from {host,id,path}');
  const kind = normalizeHostKind(raw.host);
  const id = raw.id == null ? '' : String(raw.id);
  if (!id) fail('property link from.id is required');
  if (id === SCREEN_PARENT) fail('@live is a screen lock, not a property link source');
  const host = findHost(project, kind, id);
  if (!host) fail(`no ${KIND_LABEL[kind]} ${id} for the property link`);
  const path = raw.path == null ? '' : String(raw.path);
  const target = findLinkTarget(kind, host, path);
  if (!target) {
    if (kind === 'cam' && path.startsWith('position.')) {
      fail('camera position is path animation, not a property link source');
    }
    fail(`${KIND_LABEL[kind]} ${id} has no readable property ${path}`);
  }
  return { kind, host, id, path, target };
}

function checkCandidate(project, child, to, parent, fail) {
  if (wouldLinkCycle(project, { host: child.kind, id: String(child.host.id ?? '') }, to, {
    host: parent.kind, id: String(parent.host.id ?? ''), path: parent.path,
  })) {
    fail(`property link ${to} would create a cycle`);
  }
  const depth = 1 + linkChainDepth(project, { host: parent.kind, id: String(parent.host.id ?? '') }, parent.path);
  if (depth > MAX_LINK_DEPTH) fail(`property link chain deeper than ${MAX_LINK_DEPTH}`);
}

function parentValueAt(project, parent, t) {
  const ref = findLinkHost(project, { host: parent.kind, id: String(parent.host.id ?? '') });
  if (!ref) return null;
  return effectiveFor(project, ref, parent.path, t);
}

function nextLinkId(links) {
  const used = new Set((Array.isArray(links) ? links : []).map((l) => (isRecord(l) ? String(l.id ?? '') : '')).filter(Boolean));
  let i = 1;
  while (used.has(`lnk_${i}`)) i += 1;
  return `lnk_${i}`;
}

function putLink(host, to, link) {
  const links = Array.isArray(host.links) ? host.links : (host.links = []);
  const index = links.findIndex((l) => isRecord(l) && String(l.to ?? '') === to);
  if (index >= 0) links[index] = link; else links.push(link);
  return link;
}

function propLink(project, op, fail) {
  const child = childRef(project, op, fail);
  const to = op.to == null ? '' : String(op.to);
  const target = findLinkTarget(child.kind, child.host, to);
  if (!target) {
    if (child.kind === 'cam' && to.startsWith('position.')) {
      fail('camera position is path animation, not a property link target');
    }
    fail(`${KIND_LABEL[child.kind]} ${child.host.id} has no linkable property ${to}`);
  }
  const parent = sourceRef(project, op.from, fail);
  if (!unitsCompatible(target.unit, parent.target.unit)) {
    fail(`property link units differ: ${to} is ${target.unit}, ${parent.path} is ${parent.target.unit}`);
  }
  const t = roundT(op.t);
  const links = Array.isArray(child.host.links) ? child.host.links : [];
  const existing = links.find((l) => isRecord(l) && String(l.to ?? '') === to) || null;
  const combine = op.combine != null ? String(op.combine) : (existing?.combine || target.combine);
  if (!LINK_COMBINES.includes(combine)) fail('combine must be add or mul');
  const enabled = op.enabled !== undefined ? op.enabled !== false : (existing ? existing.enabled !== false : true);
  const sameSource = existing ? sameFrom(normalizeFrom(existing.from), parent) : false;
  // Binding / re-parenting re-zeroes the contribution at `t` and bakes the
  // effective value that was on screen into the local value (one op = one undo).
  // Re-sending the same source/combine stays idempotent: the bind is kept.
  const rebind = !existing || !sameSource || existing.combine !== combine;
  const autoBind = op.bindParentValue === undefined && rebind;
  const before = autoBind && existing ? effectiveFor(project, hostRefFor(child.kind, child.host), to, t) : null;
  let bind;
  if (op.bindParentValue !== undefined) {
    bind = Number(op.bindParentValue);
    if (!Number.isFinite(bind)) fail('bindParentValue must be a finite number');
  } else if (autoBind) {
    const value = parentValueAt(project, parent, t);
    if (value == null) fail(`cannot bind ${to}: ${KIND_LABEL[parent.kind]} ${parent.id}.${parent.path} has no value at t=${t}`);
    bind = value;
  } else {
    bind = Number(existing.bindParentValue);
    if (!Number.isFinite(bind)) bind = 0;
  }
  if (combine === 'mul' && Math.abs(bind) < 1e-9) {
    fail(`mul link needs a nonzero parent value at bind (${parent.path} is ${bind})`);
  }
  if (enabled) checkCandidate(project, child, to, parent, fail);
  const link = putLink(child.host, to, {
    id: existing?.id || nextLinkId(links),
    to,
    from: { host: parent.kind, id: parent.id, path: parent.path },
    combine,
    bindParentValue: r6(bind),
    enabled,
  });
  if (autoBind && existing && before != null) {
    if (!writeLocalValue(project, child.kind, child.host, to, t, before)) {
      fail(`cannot write ${to} on ${KIND_LABEL[child.kind]} ${child.host.id}`);
    }
  }
  return { changed: [String(child.host.id ?? op.id)], link };
}

function propLinkPatch(project, op, fail) {
  const child = childRef(project, op, fail);
  const to = op.to == null ? '' : String(op.to);
  const links = Array.isArray(child.host.links) ? child.host.links : null;
  const index = links ? links.findIndex((l) => isRecord(l) && String(l.to ?? '') === to) : -1;
  if (index < 0) fail(`no property link ${to} on ${KIND_LABEL[child.kind]} ${child.host.id}`);
  const existing = links[index];
  const patch = op.patch;
  if (!isRecord(patch)) fail('propLinkPatch needs a patch object');
  for (const key of Object.keys(patch)) {
    if (!['from', 'combine', 'enabled', 'bindParentValue', 't'].includes(key)) fail(`propLinkPatch cannot patch ${key}`);
  }
  if (patch.from !== undefined && !isRecord(patch.from)) fail('patch.from must be an object');
  const fromRaw = patch.from !== undefined ? { ...existing.from, ...patch.from } : existing.from;
  const parent = sourceRef(project, fromRaw, fail);
  const target = findLinkTarget(child.kind, child.host, to);
  if (!target) fail(`${KIND_LABEL[child.kind]} ${child.host.id} has no linkable property ${to}`);
  if (!unitsCompatible(target.unit, parent.target.unit)) {
    fail(`property link units differ: ${to} is ${target.unit}, ${parent.path} is ${parent.target.unit}`);
  }
  const combine = patch.combine !== undefined ? String(patch.combine) : existing.combine;
  if (!LINK_COMBINES.includes(combine)) fail('combine must be add or mul');
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') fail('patch.enabled must be boolean');
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled !== false;
  const t = roundT(patch.t !== undefined ? patch.t : op.t);
  const sourceChanged = !sameFrom(normalizeFrom(existing.from), parent);
  const rebind = patch.bindParentValue === undefined && (sourceChanged || existing.combine !== combine);
  const before = rebind && enabled ? effectiveFor(project, hostRefFor(child.kind, child.host), to, t) : null;
  let bind = Number(existing.bindParentValue);
  if (patch.bindParentValue !== undefined) {
    bind = Number(patch.bindParentValue);
    if (!Number.isFinite(bind)) fail('bindParentValue must be a finite number');
  } else if (rebind) {
    const value = parentValueAt(project, parent, t);
    if (value == null) fail(`cannot rebind ${to}: ${KIND_LABEL[parent.kind]} ${parent.id}.${parent.path} has no value at t=${t}`);
    bind = value;
  }
  if (!Number.isFinite(bind)) bind = 0;
  if (combine === 'mul' && Math.abs(bind) < 1e-9) {
    fail(`mul link needs a nonzero parent value at bind (${parent.path} is ${bind})`);
  }
  if (enabled) checkCandidate(project, child, to, parent, fail);
  const link = {
    id: existing.id,
    to,
    from: { host: parent.kind, id: parent.id, path: parent.path },
    combine,
    bindParentValue: r6(bind),
    enabled,
  };
  links[index] = link;
  if (rebind && enabled && before != null) {
    if (!writeLocalValue(project, child.kind, child.host, to, t, before)) {
      fail(`cannot write ${to} on ${KIND_LABEL[child.kind]} ${child.host.id}`);
    }
  }
  return { changed: [String(child.host.id ?? op.id)], link };
}

function propUnlink(project, op, fail) {
  const child = childRef(project, op, fail);
  const to = op.to == null ? '' : String(op.to);
  if (!to) fail('propUnlink needs to');
  const links = Array.isArray(child.host.links) ? child.host.links : [];
  const next = links.filter((link) => !(isRecord(link) && String(link.to ?? '') === to));
  if (next.length === links.length) return { changed: [] };
  if (next.length) child.host.links = next; else delete child.host.links;
  return { changed: [String(child.host.id ?? op.id)] };
}

/** `core/ops.js` handler for LINK_OP_KINDS; returns null for other ops. */
export function applyLinkOp(project, op, api = {}) {
  const fail = typeof api?.fail === 'function' ? api.fail : invalid;
  if (!isRecord(op)) return null;
  if (op.op === 'propLink') return propLink(project, op, fail);
  if (op.op === 'propLinkPatch') return propLinkPatch(project, op, fail);
  if (op.op === 'propUnlink') return propUnlink(project, op, fail);
  return null;
}

/**
 * Delete every link that reads from `hostId` (host deletion). The link is
 * dropped, never baked: the child keeps its local value and therefore falls
 * back to it (PLAN-ui-round3 §3.2 "解除只删 link，本地值不变").
 */
export function pruneLinksForHost(project, hostId) {
  const id = hostId == null ? '' : String(hostId);
  if (!id) return 0;
  let removed = 0;
  for (const [, hosts] of linkHosts(project)) {
    for (const host of hosts) {
      if (!host || !Array.isArray(host.links) || !host.links.length) continue;
      const next = host.links.filter((link) => !(isRecord(link) && isRecord(link.from) && String(link.from.id) === id));
      if (next.length === host.links.length) continue;
      removed += host.links.length - next.length;
      if (next.length) host.links = next; else delete host.links;
    }
  }
  return removed;
}
