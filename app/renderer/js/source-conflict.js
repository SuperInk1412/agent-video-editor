// Source-merge conflicts in the 审阅 page (WP4.6b, docs/DESIGN-WP3.6-4.6-UI.md
// §7.3 R1).
//
// A `needs-decision` change set written by `application/source-service.js::
// mergeSource` carries `merge = { sourceId, hash, conflicts }`; every conflict
// is the six-field record of §7.8.4:
//
//   { nodeId, path, base, ours, theirs, kind }
//
// with `path: null` for the node-level kinds (`node-deleted`, `node-collision`,
// `type-changed`) and a node summary `{ type, props, tracks }` as the value
// there. §7.3 R1: no modal — one row per conflict in the change set, the three
// sides, the intent of the update that caused it, and one radio pair
// `保留我的` / `用源的` (default 保留我的, so closing the panel decides nothing).
//
// This module is pure data + ops: `conflictRows()` is what the panel prints,
// `conflictOps()` is what 应用 submits. The merge already wrote `theirs`
// provisionally (§7.8.4), so 用源的 usually asks for the value that is already
// there; both choices are written explicitly anyway, because the project may
// have moved on since the merge and the op list is what makes 应用 one
// transaction (one Ctrl+Z back to the provisional state).
import { SOURCE_FIELD_OF_PATH } from '/core/source-eval.js';

/** The two decisions of §7.3 R1. The stored/ops side never sees a third. */
export const OURS = 'ours';
export const THEIRS = 'theirs';

/** §7.8.4 kinds in the user's words (a closed set: core/source-merge.js). */
const KIND_LABEL = {
  'both-changed': '两边都改了',
  'node-deleted': '源里删掉了节点',
  'node-collision': '源里新增的节点和已有元素撞了',
  'type-changed': '节点类型变了',
};

/**
 * §7.8.1 paths the contract tables do not name with these keys (they speak
 * `pivot.x` / `opacity` for the element layer), so the conflict row can use the
 * inspector's words instead of `transform.x`.
 */
const PATH_LABEL = {
  'style.text': '文字内容',
  'style.font': '字体',
  'style.size': '字号',
  'style.weight': '字重',
  'style.color': '颜色',
  'style.align': '对齐',
  'style.lineHeight': '行高',
  'style.letterSpacing': '字距',
  src: '素材',
  'transform.x': '横向位置',
  'transform.y': '纵向位置',
  'transform.scale': '缩放',
  'transform.rotation': '旋转',
  'transform.opacity': '不透明度',
};

export const conflictKindLabel = (kind) => KIND_LABEL[String(kind)] || String(kind || '冲突');
export const conflictPathLabel = (path) => (path ? (PATH_LABEL[String(path)] || String(path)) : '整个节点');

/** True for the node-level kinds whose value is a `{ type, props, tracks }` summary. */
export const isNodeConflict = (conflict) => !conflict?.path;

/**
 * One side of a conflict as text. Scalars print like the review page's values,
 * a track is a count (it is one value, §7.8.4), and a node summary is its type
 * plus how much it carries.
 */
export function conflictValueText(value) {
  if (value === null || value === undefined) return '无';
  if (Array.isArray(value)) return `${value.length} 个关键帧`;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '—';
  if (typeof value === 'string') return value === '' ? '空' : value;
  if (typeof value === 'object') {
    const type = typeof value.type === 'string' ? value.type : '节点';
    const props = value.props && typeof value.props === 'object' ? Object.keys(value.props).length : 0;
    const tracks = Array.isArray(value.tracks) ? value.tracks.length : 0;
    return `${type} · ${props} 个属性 · ${tracks} 条关键帧`;
  }
  return String(value);
}

/** The element a conflict's node is bound to, or null (deleted / detached since). */
export function elementOfConflict(project, merge, conflict) {
  const sourceId = String(merge?.sourceId ?? '');
  const nodeId = String(conflict?.nodeId ?? '');
  if (!sourceId || !nodeId) return null;
  return (project?.elements || []).find((el) => el?.source?.id === sourceId && el?.source?.node === nodeId) || null;
}

/**
 * What the panel renders: one entry per conflict, in the record's order.
 * `element` is null when the binding is gone; the row then says so and 应用
 * skips it (there is nothing to write). The intent of the update that caused
 * the conflict lives on the record (`record.intent`), not on `merge`.
 */
export function conflictRows(merge, project) {
  const conflicts = Array.isArray(merge?.conflicts) ? merge.conflicts : [];
  return conflicts.map((conflict, index) => ({
    index,
    key: `cf${index}`,
    conflict,
    element: elementOfConflict(project, merge, conflict),
    kindLabel: conflictKindLabel(conflict?.kind),
    pathLabel: conflictPathLabel(conflict?.path),
    base: conflictValueText(conflict?.base),
    ours: conflictValueText(conflict?.ours),
    theirs: conflictValueText(conflict?.theirs),
  }));
}

/** One track value as `keyRemove` + one `keySet` per key (the whole array wins). */
function trackOps(el, path, keys) {
  const ops = [{ op: 'keyRemove', id: el.id, path }];
  for (const key of keys) {
    if (!key || !Number.isFinite(Number(key.t))) continue;
    ops.push({
      op: 'keySet', id: el.id, path, t: Number(key.t), value: key.value,
      ...(key.ease ? { ease: key.ease } : {}),
      ...(key.curve ? { curve: key.curve } : {}),
    });
  }
  return ops;
}

/** A node summary (`{ type, props, tracks }`) written onto the element. */
function nodeOps(el, summary) {
  if (!summary || typeof summary !== 'object') return [];
  const ops = [];
  if (typeof summary.type === 'string' && summary.type && summary.type !== el.type) {
    ops.push({ op: 'set', id: el.id, path: 'type', value: summary.type });
  }
  for (const [path, value] of Object.entries(summary.props || {})) {
    const field = SOURCE_FIELD_OF_PATH[path];
    if (!field) continue;
    ops.push({ op: 'set', id: el.id, path: field.filter(Boolean).join('.'), value });
  }
  const byPath = new Map();
  for (const key of Array.isArray(summary.tracks) ? summary.tracks : []) {
    if (!key?.path) continue;
    if (!byPath.has(key.path)) byPath.set(key.path, []);
    byPath.get(key.path).push(key);
  }
  for (const [path, keys] of byPath) ops.push(...trackOps(el, path, keys));
  return ops;
}

/**
 * The ops for one conflict. `null` means "nothing to write" (the choice already
 * holds — 用源的 on a path the merge provisionally wrote, 保留我的 on a node the
 * merge left alone); `[]` with `skipped` says the element is gone.
 */
function conflictOp(merge, conflict, choice, project) {
  const el = elementOfConflict(project, merge, conflict);
  if (!el) return { ops: [], skipped: true };
  if (isNodeConflict(conflict)) {
    // Node-level: the merge already took `theirs` for `type-changed` and kept
    // `ours` for `node-collision`; `node-deleted` left the element in place
    // (§7.8.4: `sourceApply` upserts, it never removes).
    if (choice === THEIRS) {
      if (conflict.kind === 'node-deleted') return { ops: [{ op: 'removeElement', id: el.id }] };
      if (conflict.kind === 'node-collision') return { ops: nodeOps(el, conflict.theirs) };
      return { ops: [] };
    }
    if (conflict.kind === 'type-changed') return { ops: nodeOps(el, conflict.ours) };
    return { ops: [] };
  }
  const value = choice === THEIRS ? conflict.theirs : conflict.ours;
  const field = SOURCE_FIELD_OF_PATH[conflict.path];
  if (!field) return { ops: [] };
  if (Array.isArray(value)) return { ops: trackOps(el, conflict.path, value) };
  return { ops: [{ op: 'set', id: el.id, path: field.filter(Boolean).join('.'), value }] };
}

/**
 * 应用: the ops for the chosen sides, as one `batch`-free list (the caller sends
 * them as one transaction). `decisions` is the audit trail stored on the record.
 *
 * @param {object} project
 * @param {{sourceId?: string, conflicts?: object[]}} merge
 * @param {Array<'ours'|'theirs'>} choices aligned with `merge.conflicts`
 * @returns {{ ops: object[], decisions: object[], skipped: number }}
 */
export function conflictOps(project, merge, choices) {
  const conflicts = Array.isArray(merge?.conflicts) ? merge.conflicts : [];
  const ops = [];
  const decisions = [];
  let skipped = 0;
  conflicts.forEach((conflict, index) => {
    const choice = choices?.[index] === THEIRS ? THEIRS : OURS;
    decisions.push({ index, nodeId: conflict?.nodeId ?? null, path: conflict?.path ?? null, choice });
    const result = conflictOp(merge, conflict, choice, project);
    if (result.skipped) { skipped += 1; return; }
    ops.push(...result.ops);
  });
  return { ops, decisions, skipped };
}

/** How many of `conflicts` still have an element to write (the footer count). */
export function writableConflicts(merge, project) {
  const conflicts = Array.isArray(merge?.conflicts) ? merge.conflicts : [];
  return conflicts.filter((conflict) => !!elementOfConflict(project, merge, conflict)).length;
}
