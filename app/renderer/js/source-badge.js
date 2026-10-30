// Source marks (WP4.6a, docs/DESIGN-WP3.6-4.6-UI.md §3.1 + §7.2 R1).
//
// One place answers the three questions the UI asks about a source element:
//
//   * does it come from a compiled source, and what is that source called —
//     the `源 · title-card` badge in the inspector header (§3.1) and the 12×12
//     `i-source` mark on a timeline / outliner row;
//   * which properties does the source *really* drive — a snapshot node's
//     `props` / `tracks` plus whatever `el.sourceMode` already names. The
//     overlay/takeover switch only appears on those rows (§7.2 R1), so this
//     list is the gate;
//   * what the mark says on hover, including the one-way door of §7.4 R1:
//     脱离后不再跟随源码更新，只能用撤销恢复.
//
// Snapshots: core never reads `.vdm/`, and neither does this module. The app
// hands the compiled snapshots in through `setSourceSnapshots()` — that is the
// seam WP4.6b's `GET /api/sources` fills. Without a snapshot the badge still
// works (the binding lives in the project document, so the mark is a pure read)
// and the switch falls back to the paths `el.sourceMode` already names, exactly
// as §7.2 R1 spells out: "源快照有该路径或 el.sourceMode 已有".
import { cachedSnapshot, sourceNodeAt, SOURCE_PATHS } from '../../../core/source-eval.js';
import { h, icon } from './ui.js';

/** Hover tail every source mark carries (§7.4 R1: no re-attach, undo only). */
export const SOURCE_RECOVER_TIP = '脱离后不再跟随源码更新，只能用撤销恢复';

// ---------------------------------------------------------------- snapshots
// source id -> raw snapshot, as handed in by the app. Never a file read here:
// the renderer has no filesystem and the engine owns `.vdm/sources/`.
const SNAPSHOTS = new Map();

/**
 * Replace the session's compiled snapshots. Called by the app when it learns
 * them (WP4.6b's `/api/sources`) and by the Electron probe
 * `scripts/check-source-ui.mjs`; a missing id simply means "no snapshot yet".
 *
 * @param {Record<string, object>|null} map  source id -> raw §7.8.1 snapshot
 */
export function setSourceSnapshots(map) {
  SNAPSHOTS.clear();
  if (!map || typeof map !== 'object') return;
  for (const [id, snapshot] of Object.entries(map)) {
    if (snapshot && typeof snapshot === 'object') SNAPSHOTS.set(String(id), snapshot);
  }
}

/** The session's raw snapshots (diagnostics / probes). */
export function sourceSnapshots() {
  return Object.fromEntries(SNAPSHOTS);
}

/** The normalised snapshot of a source id, or `null` (validated once, §7.8.1). */
export function sourceSnapshotOf(id) {
  const key = String(id ?? '');
  const raw = key ? SNAPSHOTS.get(key) : null;
  return raw ? cachedSnapshot(raw) : null;
}

// ---------------------------------------------------------------- bindings
/** True for an element that carries a usable `el.source` binding (§7.8.2). */
export function hasSource(el) {
  return !!(el && el.source && typeof el.source.id === 'string' && el.source.id);
}

export const sourceIdOf = (el) => (hasSource(el) ? el.source.id : '');
export const sourceNodeIdOf = (el) => (hasSource(el) && typeof el.source.node === 'string' ? el.source.node : '');

/** Display name of the source: `manifest.label` when the registry has one, else the id. */
export function sourceLabel(project, el) {
  const id = sourceIdOf(el);
  if (!id) return '';
  const entries = Array.isArray(project?.sources) ? project.sources : [];
  const entry = entries.find((record) => record && record.id === id);
  const label = entry?.manifest?.label ?? entry?.manifest?.title;
  return typeof label === 'string' && label.trim() ? label.trim() : id;
}

/** The snapshot node this element is bound to, or `null` (no snapshot yet). */
export function sourceNodeOf(el) {
  if (!hasSource(el)) return null;
  const snapshot = sourceSnapshotOf(el.source.id);
  return snapshot ? sourceNodeAt(snapshot, sourceNodeIdOf(el)) : null;
}

/**
 * Paths the source drives for this element, in `SOURCE_PATHS` order:
 * a `props` baseline or a `tracks` animation on the snapshot node, plus every
 * path `el.sourceMode` already names (a switch the user set before the
 * snapshot was known must not disappear). `[]` when the element has no source.
 */
export function sourceDrivenPaths(el) {
  if (!hasSource(el)) return [];
  const node = sourceNodeOf(el);
  const table = el.sourceMode && typeof el.sourceMode === 'object' ? el.sourceMode : {};
  const tracks = node && Array.isArray(node.tracks) ? node.tracks : [];
  const out = [];
  for (const path of SOURCE_PATHS) {
    const driven = !!node && (Object.hasOwn(node.props || {}, path)
      || tracks.some((key) => key && key.path === path));
    if (driven || Object.hasOwn(table, path)) out.push(path);
  }
  return out;
}

/** True when the source drives `path` for this element (§7.2 R1 gate). */
export const sourceDrives = (el, path) => sourceDrivenPaths(el).includes(String(path));
// ---------------------------------------------------------------- tooltips
/** Header-badge hover: the ids plus the one-way door (§3.1 + §7.4 R1). */
export function sourceTip(project, el) {
  if (!hasSource(el)) return '';
  return `源：${sourceIdOf(el)}\n节点：${sourceNodeIdOf(el) || '—'}\n${SOURCE_RECOVER_TIP}`;
}

/** Row-mark hover: what the mark means and what happens when the source goes. */
export function sourceMarkTip(project, el) {
  if (!hasSource(el)) return '';
  return `来自源码 ${sourceLabel(project, el)} · 节点 ${sourceNodeIdOf(el) || '—'}\n跟随源码更新\n${SOURCE_RECOVER_TIP}`;
}

// ---------------------------------------------------------------- marks
/**
 * `源 · title-card` for the inspector header, or `null` for an element that
 * does not come from a source. Placed right after the element name (§3.1).
 */
export function sourceBadge(project, el) {
  if (!hasSource(el)) return null;
  return h('span', { class: 'insp-src', 'data-tip': sourceTip(project, el) },
    `源 · ${sourceLabel(project, el)}`);
}

/**
 * 12×12 `i-source` mark for a timeline / outliner row, or `null`. It takes the
 * name's front slot only (`cls` names the owner's class), so no row height and
 * no button order changes (§3.1).
 */
export function sourceMark(project, el, cls = 'tl-src') {
  if (!hasSource(el)) return null;
  return h('span', { class: cls, 'aria-hidden': 'true', 'data-tip': sourceMarkTip(project, el) },
    icon('source'));
}
