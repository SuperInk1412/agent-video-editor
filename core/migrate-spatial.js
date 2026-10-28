// Explicit 2D `transform` -> unified SpatialNode converter
// (PLAN-ui-round3 §2.3 / §2.3.2, docs/DESIGN-UNIFIED-SPACE.md).
//
// Pure ESM: no `node:*`, no I/O. `scripts/migrate-spatial.mjs` is the CLI shell.
// Nothing here runs on project load — old projects keep their `transform` until
// a caller explicitly asks for a migration. The renderer / editor / ops paths
// are untouched; this module only produces a new in-memory project document
// plus a plan (stats + data-level diff) the CLI can print or refuse to write.
//
// Legacy 2D element -> node
// -------------------------
//   pivot    = screenToWorld(meta, transform.x, transform.y, transform.z)
//   position = [0, 0, 0]
//   dir      = LEGACY_ELEMENT_DIR ([0, 0, 1], core/spatial.js)
//   roll     = transform.rotation
//   scale    = [transform.scale, transform.scale, 1]
//
// The old `transform` object and the old keyframe list are kept in `legacy`
// (`legacy.transform`, `legacy.keyframes`); the base `transform` field itself
// is never deleted so a rollback is a pure data restore.
//
// Keyframes
// ---------
// Only the spatial paths move; `transform.opacity` (opacity is not part of a
// SpatialNode), `style.*`, `fx.*` and `audio.*` keys stay untouched:
//
//   transform.x        -> pivot.x   (px / 100)
//   transform.y        -> pivot.y   (screenCenterY(meta) - px / 100)
//   transform.z        -> pivot.z   (metres, already world depth)
//   transform.scale    -> scale.x + scale.y (same value on both axes)
//   transform.rotation -> roll      (degrees, same sign)
//
// x/y keys go to `pivot.*`, not to `position.*`: the node applies its basis to
// `position` (`worldPos = pivot + basis · position`), so a screen-space x key on
// a rotated element would need a compensating y component. Independent scalar
// tracks cannot express that; keeping the whole placement in `pivot` keeps each
// axis independent and exactly equals what `legacyElementNode` sampled.
//
// Orientation sign — deliberate choice
// ------------------------------------
// `core/spatial.js::legacyElementNode` is the contract for a legacy 2D element
// and defines `roll = transform.rotation` (positive). `core/migrate.js` (the
// older v2 -> v3 *scene object* path) writes `-rotation` because it maps the
// pixel plane into a y-up scene object whose roll is read by that different
// renderer. This converter writes `el.node`, which the unified readers sample
// through core/spatial.js, so it must match `legacyElementNode` exactly or every
// preserve migration would flip its rotations. `compareElement` below verifies
// this at every key time on every plan (`diff.maxRoll`). If a future pixel
// golden disagrees, the sign belongs to the node reader / renderer, not to this
// one-shot data conversion.
import { PX_PER_M } from './scene.js';
import { screenCenterY, screenToWorld } from './space.js';
import { sampleTrack } from './time.js';
import { LEGACY_ELEMENT_DIR, isScreenParent, legacyElementNode } from './spatial.js';
import { normalizeSpatialNode, validateProject } from './schema.js';
import { isRecord } from './json.js';

export const SPATIAL_MIGRATION_VERSION = 1;
export const MIGRATION_MODES = Object.freeze(['preserve', 'world', 'hybrid']);
/** Paths that only exist on an already-migrated node (used as a corruption guard). */
const NODE_TRACK_PATHS = new Set([
  'pivot.x', 'pivot.y', 'pivot.z',
  'position.x', 'position.y', 'position.z',
  'scale.x', 'scale.y', 'scale.z',
  'dir.x', 'dir.y', 'dir.z',
  'roll',
]);
const SPATIAL_PATHS = new Set([
  'transform.x', 'transform.y', 'transform.z', 'transform.scale', 'transform.rotation',
]);

export class SpatialMigrationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'SpatialMigrationError';
    this.code = 'MIGRATION_INVALID';
    this.issues = issues;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function requireFinite(value, at) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new SpatialMigrationError(`${at}: expected a finite number, got ${JSON.stringify(value)}`);
  }
  return n;
}

function finiteOr(value, fallback, at) {
  return value === undefined || value === null ? fallback : requireFinite(value, at);
}

/** `['a,b', ['c']]` -> `['a', 'b', 'c']` (stable, deduplicated). */
function selectionList(values) {
  const out = [];
  for (const value of values || []) {
    for (const part of String(value).split(',')) {
      const id = part.trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

function elementTags(el) {
  const tags = [];
  for (const source of [el?.meta?.tags, el?.meta?.tag, el?.tags, el?.tag]) {
    if (typeof source === 'string') tags.push(source);
    else if (Array.isArray(source)) tags.push(...source.filter((tag) => typeof tag === 'string'));
  }
  return tags;
}

const matchesTags = (el, wanted) => elementTags(el).some((tag) => wanted.includes(tag));

/** The `{ path -> value }[]` a legacy spatial key becomes, or null to keep it. */
function spatialTargets(path, value, meta) {
  switch (path) {
    case 'transform.x': return [['pivot.x', value / PX_PER_M]];
    case 'transform.y': return [['pivot.y', screenCenterY(meta) - value / PX_PER_M]];
    case 'transform.z': return [['pivot.z', value]];
    case 'transform.scale': return [['scale.x', value], ['scale.y', value]];
    case 'transform.rotation': return [['roll', value]];
    default: return null;
  }
}

/** Old keyframe list -> node keyframe list. Non-spatial keys are copied verbatim. */
function convertKeyframes(el, meta, at) {
  const keys = Array.isArray(el.keyframes) ? el.keyframes : [];
  const out = [];
  const byPath = {};
  let rewritten = 0;
  let kept = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!isRecord(key) || !SPATIAL_PATHS.has(key.path)) {
      out.push(clone(key));
      kept++;
      continue;
    }
    const value = requireFinite(key.value, `${at}.keyframes[${i}].value`);
    const targets = spatialTargets(key.path, value, meta);
    byPath[key.path] = (byPath[key.path] || 0) + 1;
    rewritten++;
    for (const [path, next] of targets) out.push({ ...clone(key), path, value: next });
  }
  return { out, byPath, rewritten, kept, total: keys.length };
}

/** The legacy 2D plane as a SpatialNode (core/spatial.js::legacyElementNode). */
function nodeFromTransform(el, meta, at) {
  const tr = isRecord(el.transform) ? el.transform : {};
  const x = finiteOr(tr.x, 0, `${at}.transform.x`);
  const y = finiteOr(tr.y, 0, `${at}.transform.y`);
  const z = finiteOr(tr.z, 0, `${at}.transform.z`);
  const scale = finiteOr(tr.scale, 1, `${at}.transform.scale`);
  const rotation = finiteOr(tr.rotation, 0, `${at}.transform.rotation`);
  return {
    pivot: screenToWorld(meta, x, y, z),
    position: [0, 0, 0],
    dir: LEGACY_ELEMENT_DIR.slice(),
    roll: rotation,
    scale: [scale, scale, 1],
  };
}

function legacyBlock(before, mode) {
  const legacy = isRecord(before.legacy) ? clone(before.legacy) : {};
  if (before.transform !== undefined) legacy.transform = clone(before.transform);
  if (Array.isArray(before.keyframes) && before.keyframes.length) {
    legacy.keyframes = clone(before.keyframes);
  }
  legacy.spatial = { version: SPATIAL_MIGRATION_VERSION, mode };
  return legacy;
}

/**
 * Sample a migrated element's node at `t`: base `node` values overridden by the
 * node keyframe paths written by this converter. Exported for the CLI diff and
 * for tests; it is deliberately not wired into the renderer here.
 */
export function migratedNodeAt(el, t = null) {
  const source = isRecord(el) ? el : {};
  const base = normalizeSpatialNode(source.node);
  const at = t == null ? null : Number(t);
  const sample = (path, fallback) => (at != null && Number.isFinite(at)
    ? sampleTrack(source.keyframes, path, at, fallback)
    : fallback);
  return {
    pivot: [
      sample('pivot.x', base.pivot[0]),
      sample('pivot.y', base.pivot[1]),
      sample('pivot.z', base.pivot[2]),
    ],
    position: base.position.slice(),
    dir: base.dir.slice(),
    roll: sample('roll', base.roll),
    scale: [
      sample('scale.x', base.scale[0]),
      sample('scale.y', base.scale[1]),
      sample('scale.z', base.scale[2]),
    ],
  };
}

const maxAbs = (a, b) => a.reduce((max, v, i) => Math.max(max, Math.abs(v - b[i])), 0);

/**
 * Data-level golden between an old element and its migrated copy: samples the
 * legacy derivation (core/spatial.js) against the new node/keyframes at the
 * element start/middle/end and at every migrated key time. This proves the
 * conversion is exact without rendering a frame; pixel golden still belongs to
 * the render branch.
 */
function compareElement(before, after, meta) {
  const times = new Set();
  const start = Number(before.start) || 0;
  const duration = Number(before.duration) || 0;
  times.add(start);
  times.add(start + duration / 2);
  times.add(start + Math.max(0, duration - 1e-6));
  for (const key of before.keyframes || []) {
    if (isRecord(key) && SPATIAL_PATHS.has(key.path) && Number.isFinite(Number(key.t))) {
      times.add(Number(key.t));
    }
  }
  const result = { samples: 0, maxPivot: 0, maxScale: 0, maxRoll: 0, worstT: null, mismatches: [] };
  for (const t of times) {
    const oldNode = legacyElementNode(before, meta, t);
    const newNode = migratedNodeAt(after, t);
    const pivot = maxAbs(oldNode.pivot, newNode.pivot);
    const scale = maxAbs(oldNode.scale, newNode.scale);
    const roll = Math.abs(oldNode.roll - newNode.roll);
    result.samples++;
    if (pivot > result.maxPivot) { result.maxPivot = pivot; result.worstT = t; }
    result.maxScale = Math.max(result.maxScale, scale);
    result.maxRoll = Math.max(result.maxRoll, roll);
    if (pivot > 1e-9 || scale > 1e-9 || roll > 1e-9) {
      result.mismatches.push({ t, pivot, scale, roll });
    }
  }
  return result;
}

function releaseScreenParent(el, stats) {
  const parent = clone(el.parent);
  const legacy = isRecord(el.legacy) ? clone(el.legacy) : {};
  if (legacy.parent === undefined) legacy.parent = parent;
  el.legacy = legacy;
  delete el.parent;
  stats.screenParentReleased++;
}

function blankStats(mode, total) {
  return {
    mode,
    total,
    converted: 0,
    alreadyNode: 0,
    skipped: 0,
    fromScreenParent: 0,
    fromFree: 0,
    screenParentKept: 0,
    screenParentReleased: 0,
    freeAfter: 0,
    keyframes: { total: 0, rewritten: 0, kept: 0, output: 0, byPath: {} },
  };
}

/**
 * Plan an explicit 2D -> SpatialNode migration. Does not mutate `project` and
 * does not touch the filesystem.
 *
 * options:
 *   mode  'preserve' | 'world' | 'hybrid'   (default 'preserve')
 *   ids   string[] | string                  element ids to convert (hybrid needs this or tags)
 *   tags  string[] | string                  elements carrying meta.tag/meta.tags/tag/tags
 *
 * Returns `{ mode, version, project, stats, changes, diff, issues }`:
 *   - project: the migrated clone (do not write when `issues.length > 0`)
 *   - stats:   element/keyframe counters (134/47/87 shape for miku)
 *   - changes: one compact record per visited element
 *   - diff:    data-level legacy-vs-node golden (maxPivot/maxScale/maxRoll)
 *   - issues:  validateProject(project) problems ([] means safe to write)
 *
 * mode semantics:
 *   preserve  every selected legacy element becomes a fixed XY-plane node;
 *             `@live` keeps its screen parent so the 47 locked elements stay
 *             locked.
 *   world     same conversion, but screen parents are removed (the old parent
 *             object is preserved at legacy.parent) — all planes are free world
 *             planes.
 *   hybrid    only `ids` / `tags` become nodes; everything else keeps the old
 *             transform and keyframes. A selected `@live` element keeps its
 *             screen parent (use world to release it).
 */
export function planSpatialMigration(project, options = {}) {
  const mode = options.mode == null ? 'preserve' : String(options.mode);
  if (!MIGRATION_MODES.includes(mode)) {
    throw new SpatialMigrationError(`unknown mode "${mode}" (expected ${MIGRATION_MODES.join(', ')})`);
  }
  const ids = selectionList(options.ids);
  const tags = selectionList(options.tags);
  if (mode === 'hybrid' && ids.length === 0 && tags.length === 0) {
    throw new SpatialMigrationError('hybrid mode needs at least one element id or tag (--ids / --tag)');
  }
  if (!isRecord(project)) throw new SpatialMigrationError('project must be an object');

  const source = clone(project);
  const inputIssues = validateProject(source);
  if (inputIssues.length) {
    throw new SpatialMigrationError(
      `input project is invalid (${inputIssues.length} issue${inputIssues.length === 1 ? '' : 's'})`,
      inputIssues,
    );
  }

  const work = clone(source);
  const meta = isRecord(work.meta) ? work.meta : {};
  const elements = Array.isArray(work.elements) ? work.elements : [];
  const byId = new Map(elements.map((el) => [String(el?.id), el]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new SpatialMigrationError(`unknown element id${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }
  const tagMatches = tags.length ? elements.filter((el) => matchesTags(el, tags)) : [];
  if (tags.length && tagMatches.length === 0) {
    throw new SpatialMigrationError(`no element is tagged ${tags.map((tag) => `"${tag}"`).join(' or ')}`);
  }

  const selected = ids.length || tags.length
    ? new Set([...ids, ...tagMatches.map((el) => String(el.id))])
    : null;

  const stats = blankStats(mode, elements.length);
  const changes = [];
  const diff = {
    samples: 0,
    elements: 0,
    maxPivot: 0,
    maxScale: 0,
    maxRoll: 0,
    worstT: null,
    exact: true,
    mismatches: [],
  };

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const id = String(el.id);
    if (selected && !selected.has(id)) { stats.skipped++; continue; }

    const before = clone(el);
    const screenBefore = isScreenParent(el.parent);

    if (isRecord(el.node)) {
      // Already migrated: never rewrite the node or its keyframes. This is what
      // makes a second run a byte-for-byte no-op.
      stats.alreadyNode++;
      changes.push({ id, node: false, parent: screenBefore ? 'kept' : null, keyframes: null });
    } else {
      const mixed = (Array.isArray(el.keyframes) ? el.keyframes : [])
        .find((key) => isRecord(key) && NODE_TRACK_PATHS.has(key.path));
      if (mixed) {
        throw new SpatialMigrationError(
          `element ${id} has no node but already has node keyframe path "${mixed.path}"`,
        );
      }
      const at = `elements[${i}] (${id})`;
      const node = nodeFromTransform(el, meta, at);
      const keys = convertKeyframes(el, meta, at);
      el.node = node;
      el.keyframes = keys.out;
      el.legacy = legacyBlock(before, mode);
      stats.converted++;
      if (screenBefore) stats.fromScreenParent++;
      else stats.fromFree++;
      stats.keyframes.total += keys.total;
      stats.keyframes.rewritten += keys.rewritten;
      stats.keyframes.kept += keys.kept;
      stats.keyframes.output += keys.out.length;
      for (const [path, count] of Object.entries(keys.byPath)) {
        stats.keyframes.byPath[path] = (stats.keyframes.byPath[path] || 0) + count;
      }
      changes.push({ id, node: true, parent: screenBefore ? 'kept' : null, keyframes: keys.byPath });

      const itemDiff = compareElement(before, el, meta);
      diff.samples += itemDiff.samples;
      diff.elements++;
      if (itemDiff.maxPivot > diff.maxPivot) {
        diff.maxPivot = itemDiff.maxPivot;
        diff.worstT = itemDiff.worstT;
      }
      diff.maxScale = Math.max(diff.maxScale, itemDiff.maxScale);
      diff.maxRoll = Math.max(diff.maxRoll, itemDiff.maxRoll);
      for (const mismatch of itemDiff.mismatches) {
        if (diff.mismatches.length < 20) diff.mismatches.push({ id, ...mismatch });
      }
    }

    if (mode === 'world' && screenBefore && isScreenParent(el.parent)) {
      releaseScreenParent(el, stats);
      changes[changes.length - 1].parent = 'removed';
    }
  }

  stats.screenParentKept = elements.filter((el) => isScreenParent(el?.parent)).length;
  stats.freeAfter = elements.filter((el) => !el?.parent || String(el.parent.id ?? '') === '').length;
  diff.exact = diff.maxPivot <= 1e-9 && diff.maxScale <= 1e-9 && diff.maxRoll <= 1e-9
    && diff.mismatches.length === 0;

  return {
    mode,
    version: SPATIAL_MIGRATION_VERSION,
    project: work,
    stats,
    changes,
    diff,
    issues: validateProject(work),
  };
}
