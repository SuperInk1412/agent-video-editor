// Overlay / takeover switches (WP4.6a, docs/DESIGN-WP3.6-4.6-UI.md §3.2 + §7.2 R1).
//
// For an element with `el.source`, every property row whose value the source
// really drives gets a two-state switch at the right end of the label:
//
//   叠加 (overlay, default)  the source value plus the local delta
//   接管 (takeover)          the local value wins; a source update no longer
//                            touches this property (`sourceMode[path]='override'`)
//
// R1 rules this module implements:
//
//   * only rows the source actually drives get a switch — `sourceDrivenPaths()`
//     in source-badge.js is the gate, a row without a driven path keeps its old
//     look and its right-click menu says nothing about sources;
//   * the icons carry the state and the hover spells the effect out, including
//     "叠加=相乘" for the ratio properties (opacity / scale);
//   * a user's first edit of a source-driven property stays in overlay: overlay
//     *is* the path default (`add` / `mul`), so nothing is written implicitly —
//     the only writer of `override` is this module, on an explicit click;
//   * the inspector's ⋯ menu and a property row's right-click menu both offer
//     全部叠加 / 全部接管 as one transaction.
//
// Writes go through `onOp` -> main.js::op() -> core/ops.js, never to the project
// object. `el.sourceMode` is a *flat* table keyed by the whole path
// (`'transform.x'`), and a dotted `set` path would nest it (`{transform:{x:…}}`,
// which core then drops), so one switch click writes the whole table with a
// single `set sourceMode` op: one op = one Ctrl+Z, and clearing an entry is
// possible at all.
import { defaultSourceMode, isNumericSourcePath, sourceModeOf } from '../../../core/source-eval.js';
import { h, icon, showMenu } from './ui.js';
import { hasSource, sourceDrivenPaths } from './source-badge.js';

/** UI state names (§3.2). The stored value of `takeover` is `'override'`. */
export const OVERLAY = 'overlay';
export const TAKEOVER = 'takeover';

const RATIO_PATHS = new Set(['transform.scale', 'transform.opacity']);
const DEFAULT_TAKEOVER = 'override';

/** The `el.sourceMode` value a path stores in overlay: its unit default. */
export const overlayMode = (path) => defaultSourceMode(path);

/** The `el.sourceMode` value a path stores in takeover. */
export const takeoverMode = () => DEFAULT_TAKEOVER;

/**
 * The mode one row shows: `takeover` only when *every* path the row displays is
 * already `override` (a half-taken-over vector row stays on 叠加, which is what
 * clicking it would set).
 */
export function rowSourceMode(el, paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  if (!list.length || !hasSource(el)) return OVERLAY;
  return list.every((path) => sourceModeOf(el, path) === DEFAULT_TAKEOVER) ? TAKEOVER : OVERLAY;
}

/**
 * The `sourceMode` table after switching `paths` to `mode`. Always the complete
 * table, because that is what one `set` op writes.
 */
export function sourceModeTable(el, paths, mode) {
  const table = { ...(el && el.sourceMode && typeof el.sourceMode === 'object' ? el.sourceMode : {}) };
  for (const path of paths || []) {
    table[path] = mode === TAKEOVER ? takeoverMode() : overlayMode(path);
  }
  return table;
}

/**
 * One `set` op that switches `paths` to `mode` — the row switch's write. `null`
 * for an element without a source or a row without paths (never writes).
 */
export function sourceModeOp(el, paths, mode) {
  if (!hasSource(el) || !Array.isArray(paths) || !paths.length) return null;
  if (mode !== OVERLAY && mode !== TAKEOVER) return null;
  return { op: 'set', id: el.id, path: 'sourceMode', value: sourceModeTable(el, paths, mode) };
}

/**
 * 全部叠加 / 全部接管 for the whole element: every path the source drives, one
 * transaction. It is a `batch` even with a single element so a multi-selection
 * (WP4.6b's 多选脱离 / 整个源) can add its elements to the same undo step.
 */
export function sourceAllOp(el, mode) {
  const paths = sourceDrivenPaths(el);
  if (!paths.length) return null;
  const op = sourceModeOp(el, paths, mode);
  return op ? { op: 'batch', ops: [op] } : null;
}

/** Hover text of the 叠加 state, with the "叠加=相乘" note where it applies (§7.2 R1). */
export function overlayTip(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const ratio = list.length > 0 && list.every((path) => RATIO_PATHS.has(path));
  const numeric = list.length > 0 && list.every((path) => isNumericSourcePath(path));
  const effect = ratio ? '源值 × 本地值（比例属性叠加=相乘）'
    : numeric ? '源值 + 本地增量（数值相加）'
      : '没改过时跟随源码，改过就用本地值';
  return `叠加（默认）：${effect}\n点击 = 一次撤销`;
}

/** Hover text of the 接管 state. */
export function takeoverTip() {
  return '接管：本地值完全覆盖源码，源更新不再改这个属性\n点击 = 一次撤销';
}

// ---------------------------------------------------------------- switch
/**
 * The 20px two-state switch (§3.2 / §7.2 R1): two 10px icons, the current state
 * in `--source`, the other in `--text-3`. `getEl()` re-reads the element so two
 * quick clicks never write a table computed from a stale render. `opts.disabled`
 * makes it a read-only indicator — the change-set preview shows the shadow
 * project on the stage, so a switch there must not offer a write (WP2.5a).
 */
export function sourceModeSwitch(getEl, paths, onOp, opts = {}) {
  const state = () => rowSourceMode(getEl(), paths);
  const make = (mode, iconName, label, tip) => {
    const btn = h('button', {
      type: 'button', class: 'src-mode-btn', 'data-mode': mode,
      'aria-label': label, 'aria-pressed': 'false', 'data-tip': tip, disabled: opts.disabled === true,
    }, icon(iconName));
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (opts.disabled) return;
      const el = getEl();
      const op = sourceModeOp(el, paths, mode);
      if (!op) return;
      if (rowSourceMode(el, paths) === mode) return; // already there: no empty op
      onOp?.(op);
    });
    return btn;
  };
  const box = h('span', { class: 'src-mode', role: 'group', 'aria-label': '叠加 / 接管' },
    make(OVERLAY, 'overlay', '叠加', overlayTip(paths)),
    make(TAKEOVER, 'takeover', '接管', takeoverTip()));
  const paint = () => {
    const now = state();
    for (const btn of box.children) {
      const on = btn.dataset.mode === now;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  paint();
  box.paint = paint;
  return box;
}

// ---------------------------------------------------------------- menus
/**
 * 全部叠加 / 全部接管 menu items for one element (§7.2 R1). Both entries are
 * present but disabled — with the reason in the tooltip — until a snapshot says
 * what the source drives, so a menu never offers an empty transaction.
 */
export function sourceMenuItems(getEl, onOp, toast) {
  const driven = () => sourceDrivenPaths(getEl());
  const reason = '还没载入源快照：等源编译完成后才能切换';
  const run = (mode) => {
    const el = getEl();
    const op = sourceAllOp(el, mode);
    if (!op) return;
    onOp?.(op);
    toast?.(mode === TAKEOVER
      ? '已全部接管：源更新不再改这个元素的属性（Ctrl+Z 撤销）'
      : '已全部叠加：跟随源码 + 本地增量（Ctrl+Z 撤销）', 'success');
  };
  return [
    {
      label: '全部叠加',
      icon: 'overlay',
      disabled: driven().length === 0,
      title: driven().length === 0 ? reason : '所有源属性回到叠加：跟随源码，本地修改叠加在上面（比例属性=相乘）',
      run: () => run(OVERLAY),
    },
    {
      label: '全部接管',
      icon: 'takeover',
      disabled: driven().length === 0,
      title: driven().length === 0 ? reason : '所有源属性都用本地值，源更新不再改它们',
      run: () => run(TAKEOVER),
    },
  ];
}

/**
 * The inspector header's `⋯` action for a source element (§7.2 R1: the ⋯ menu
 * is the first entry, the property row's right-click menu the second).
 */
export function sourceHeaderAction(getEl, onOp, toast) {
  const el = getEl();
  if (!hasSource(el)) return null;
  return {
    icon: 'more',
    label: '源码操作',
    tip: '源码操作：全部叠加 / 全部接管',
    run: (ev) => {
      const rect = ev?.currentTarget?.getBoundingClientRect?.();
      const items = sourceMenuItems(getEl, onOp, toast);
      showMenu(rect ? rect.left : (ev?.clientX ?? 0), rect ? rect.bottom + 2 : (ev?.clientY ?? 0), items);
    },
  };
}

// ---------------------------------------------------------------- decoration
/** Rows whose right-click menu offers the source entries (any row of the element). */
const ROW_MENU_SKIP = 'input, select, textarea, button';

/**
 * Paint the switches onto the property panel the inspector just rendered and
 * give every row the second right-click entry. Called at the end of
 * `Inspector._renderElement`; returns how many rows got a switch (a test /
 * probe can assert "only driven rows" without walking the DOM again).
 *
 * Rows opt in with `data-source-path="transform.x transform.y"` (set by
 * `_row` from the `srcPaths` argument of `_field` / `_vec` / `_xfRow`), so a
 * row that shows several axes gets one switch for the whole row.
 */
export function decorateSourceRows(insp, project, el) {
  if (!insp?.root || !hasSource(el)) return 0;
  const id = el.id;
  const getEl = () => (insp._last?.project?.elements || []).find((e) => e.id === id) || el;
  const onOp = (op) => {
    insp._flush?.();
    insp.opts?.onOp?.(op);
  };
  const toast = (msg, level) => insp.opts?.onToast?.(msg, level);
  const driven = new Set(sourceDrivenPaths(el));
  let count = 0;
  for (const row of insp.root.querySelectorAll('.prop[data-source-path]')) {
    const paths = String(row.dataset.sourcePath || '').split(/\s+/).filter(Boolean);
    const hit = paths.filter((path) => driven.has(path));
    const label = row.querySelector(':scope > label');
    if (!hit.length || !label) continue;
    // §3.2: a property row that already has a property parent keeps its old look
    // this round — two drivers on one value is WP4.6b's writeback question.
    if (label.querySelector('.parent-mark')) continue;
    row.classList.add('has-src');
    label.appendChild(sourceModeSwitch(getEl, hit, onOp, { disabled: insp.readOnly === true }));
    count += 1;
  }
  // Second entry (§7.2 R1): right-click on any property row of a source element.
  // The row-scoped pair is added when this row has a switch, the element-wide
  // pair always — the same handlers the ⋯ menu uses, so both are one transaction.
  for (const row of insp.root.querySelectorAll('.prop')) {
    row.addEventListener('contextmenu', (ev) => {
      if (ev.target.closest?.(ROW_MENU_SKIP)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const linked = !!row.querySelector(':scope > label .parent-mark');
      const paths = String(row.dataset.sourcePath || '').split(/\s+/).filter(Boolean)
        .filter((path) => driven.has(path));
      const items = [];
      if (paths.length && !linked) {
        items.push(
          { label: `这个属性：叠加（${paths.length > 1 ? `${paths.length} 个轴` : paths[0]}）`, icon: 'overlay', title: overlayTip(paths), run: () => { const op = sourceModeOp(getEl(), paths, OVERLAY); if (op) onOp(op); } },
          { label: '这个属性：接管', icon: 'takeover', title: takeoverTip(), run: () => { const op = sourceModeOp(getEl(), paths, TAKEOVER); if (op) onOp(op); } },
          { sep: true },
        );
      }
      items.push(...sourceMenuItems(getEl, onOp, toast));
      showMenu(ev.clientX, ev.clientY, items);
    });
  }
  return count;
}

/** Rows the panel decorated for this element (diagnostics / probe). */
export function sourceRowCount(insp, el) {
  if (!insp?.root || !hasSource(el)) return 0;
  const driven = new Set(sourceDrivenPaths(el));
  let n = 0;
  for (const row of insp.root.querySelectorAll('.prop[data-source-path]')) {
    const paths = String(row.dataset.sourcePath || '').split(/\s+/).filter(Boolean);
    if (paths.some((path) => driven.has(path))) n += 1;
  }
  return n;
}
