// Command registry, shortcut dispatch, command palette (Ctrl+K) and shortcut
// sheet (?) — docs/DESIGN.md §2, §7. Every keyboard shortcut of the renderer is
// a registered command; the palette and the sheet read the same list.
//
// register({ id, title, group, keys?, keywords?, icon?, when?, run, ... })
//   group     '播放' | '编辑' | '视口' | '时间轴' | '面板'
//   keys      display + match spec: 'Ctrl+Shift+Z', 'ArrowUp', 'Shift+A', '?',
//             alternatives separated by ' / ' ('Delete / Backspace').
//   match(e)  optional custom key test (legacy shortcuts that ignore some
//             modifiers); `match: false` = keys are display-only (sheet only).
//   when()    true = can run; false / '原因' = blocked (palette dims the row and
//             toasts the reason; a key press falls through to later commands,
//             or toasts + consumes when `keyBlocked: 'toast'`).
//   run(e)    e is the KeyboardEvent (null from the palette). Return false to
//             say "not handled" so dispatch keeps looking (and the key's default
//             action stays). Commands call e?.preventDefault() themselves.
//   global    true = tried before the "typing in an input" check (F2, Ctrl+K).
//   palette   false = keep out of the palette; sheet: false = keep out of the sheet.
import { h, icon, prefs, hideMenu } from './ui.js';

export const GROUPS = ['播放', '编辑', '视口', '时间轴', '面板'];

const registry = [];
const byId = new Map();
let notify = (msg) => console.info(msg);

const MODS = new Set(['ctrl', 'shift', 'alt', 'meta', 'cmd']);

function parseSpec(keys) {
  if (!keys) return [];
  return String(keys).split(/\s+\/\s+/).map((combo) => {
    const parts = combo.split(/\+(?=.)/);
    const key = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    return {
      key,
      ctrl: mods.has('ctrl') || mods.has('meta') || mods.has('cmd'),
      shift: mods.has('shift'),
      alt: mods.has('alt'),
      // '?' and friends are produced with Shift; don't require the user to say so
      anyShift: key.length === 1 && !/[a-z0-9]/i.test(key),
    };
  }).filter((s) => s.key && !MODS.has(s.key.toLowerCase()));
}

function matchSpec(specs, e) {
  for (const s of specs) {
    if (s.ctrl !== !!(e.ctrlKey || e.metaKey)) continue;
    if (s.alt !== !!e.altKey) continue;
    if (!s.anyShift && s.shift !== !!e.shiftKey) continue;
    const k = String(e.key || '');
    if (s.key === 'Space' ? (e.code === 'Space' || k === ' ') : k.toLowerCase() === s.key.toLowerCase()) return true;
  }
  return false;
}

export function register(cmd) {
  if (!cmd?.id || byId.has(cmd.id)) throw new Error(`command id missing or duplicate: ${cmd?.id}`);
  const c = { ...cmd, _spec: parseSpec(cmd.keys) };
  registry.push(c);
  byId.set(c.id, c);
  return c;
}

export const commands = () => registry.slice();
export const getCommand = (id) => byId.get(id) || null;

/** true | reason string | false */
function check(c) {
  if (!c.when) return true;
  let v;
  try { v = c.when(); } catch { v = false; }
  return v === true || v === undefined ? true : (v || false);
}

const blockedText = (c, why) => (typeof why === 'string' && why ? why : `现在不能执行「${c.title}」`);

/** Run a command by id (palette, buttons, __vdm). Blocked -> toast the reason. */
export function runCommand(id) {
  const c = typeof id === 'string' ? byId.get(id) : id;
  if (!c?.run) return false;
  const ok = check(c);
  if (ok !== true) { notify(blockedText(c, ok), 'warn'); return false; }
  c.run(null);
  return true;
}

/**
 * Keyboard entry point, called from the global keydown handler in main.js.
 * phase 'global': only `global` commands (before the input-focus check);
 * phase 'normal': everything else, in registration order. Returns true when a
 * command consumed the event.
 */
export function dispatch(e, { phase = 'normal' } = {}) {
  for (const c of registry) {
    if (!c.run || c.match === false) continue;
    if ((phase === 'global') !== !!c.global) continue;
    const hit = typeof c.match === 'function' ? c.match(e) : matchSpec(c._spec, e);
    if (!hit) continue;
    const ok = check(c);
    if (ok !== true) {
      if (c.keyBlocked === 'toast') {
        e.preventDefault();
        notify(blockedText(c, ok), 'info');
        return true;
      }
      continue;
    }
    if (c.run(e) === false) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- kbd rendering
// Same splitting as ui.js tooltips (' / ' alternatives, '+' combos), plus
// arrow/escape names shown as symbols.
const KEY_LABEL = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };

export function kbdNodes(spec) {
  const out = [];
  String(spec).split(/\s+\/\s+/).forEach((combo, i) => {
    if (i) out.push(document.createTextNode(' / '));
    for (const k of combo.split(/\+(?=.)/)) if (k) out.push(h('kbd', {}, KEY_LABEL[k] || k));
  });
  return out;
}

/** 'Shift+ArrowLeft' -> 'Shift+←' (for data-kbd attributes). */
export const kbdText = (spec) => String(spec || '').replace(/ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Escape/g, (k) => KEY_LABEL[k]);

// ---------------------------------------------------------------- overlays
let overlay = null; // { kind, el, close }

const topModal = () => [...document.querySelectorAll('.modal:not([hidden])')].pop() || null;

export function closeOverlay() {
  if (!overlay) return false;
  overlay.close();
  return true;
}

export const overlayOpen = () => overlay?.kind || null;

function mountOverlay(kind, el, { onKey, focus } = {}) {
  closeOverlay();
  hideMenu();
  const opener = document.activeElement;
  const keyHandler = (e) => {
    if (topModal() !== el) return;
    if (onKey?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  const close = () => {
    if (overlay?.el !== el) return;
    overlay = null;
    window.removeEventListener('keydown', keyHandler, true);
    el.remove();
    if (opener && opener.isConnected && typeof opener.focus === 'function' && opener !== document.body) opener.focus();
  };
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  window.addEventListener('keydown', keyHandler, true);
  document.body.appendChild(el);
  overlay = { kind, el, close };
  (focus || el.querySelector('button, input'))?.focus();
  return close;
}

// ---------------------------------------------------------------- command palette
const RECENT_MAX = 5;
const recentIds = () => {
  const v = prefs.get('recentCommands', []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
};
function noteRecent(id) {
  prefs.set('recentCommands', [id, ...recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX));
}

function paletteItems(query) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = registry.filter((c) => c.run && c.palette !== false);
  const hits = words.length
    ? list.filter((c) => {
      const hay = `${c.title} ${c.keywords || ''} ${c.group || ''} ${c.id}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    : list;
  const recent = recentIds();
  const rank = (c) => { const i = recent.indexOf(c.id); return i < 0 ? RECENT_MAX : i; };
  return hits
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => ({ c: x.c, recent: x.r < RECENT_MAX }));
}

export function openPalette() {
  if (overlay?.kind === 'palette') { closeOverlay(); return; }
  const input = h('input', {
    type: 'text', class: 'cmdk-input', placeholder: '搜索命令', 'aria-label': '搜索命令',
    autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cmdkList',
  });
  const list = h('div', { id: 'cmdkList', class: 'cmdk-list', role: 'listbox', 'aria-label': '命令' });
  const card = h('div', { class: 'modal-card cmdk', role: 'dialog', 'aria-modal': 'true', 'aria-label': '命令面板' },
    h('div', { class: 'cmdk-search' }, icon('search', 'ic-sm'), input),
    list);
  const el = h('div', { class: 'modal cmdk-modal' }, card);
  let rows = [];
  let act = 0;

  const setAct = (i, scroll = true) => {
    if (!rows.length) { act = -1; input.removeAttribute('aria-activedescendant'); return; }
    act = (i + rows.length) % rows.length;
    rows.forEach((r, j) => {
      r.node.classList.toggle('act', j === act);
      r.node.setAttribute('aria-selected', j === act ? 'true' : 'false');
    });
    input.setAttribute('aria-activedescendant', rows[act].node.id);
    if (scroll) rows[act].node.scrollIntoView({ block: 'nearest' });
  };

  const exec = (c) => {
    close();
    const ok = check(c);
    if (ok !== true) { notify(blockedText(c, ok), 'warn'); return; }
    noteRecent(c.id);
    c.run(null);
  };

  const fill = () => {
    const items = paletteItems(input.value);
    let shownRecent = false;
    list.replaceChildren();
    rows = [];
    items.forEach(({ c, recent }, i) => {
      if (recent && !shownRecent && !input.value.trim()) {
        shownRecent = true;
        list.appendChild(h('div', { class: 'cmdk-label' }, '最近使用'));
      } else if (!recent && shownRecent && !input.value.trim() && !list.querySelector('.cmdk-label-all')) {
        list.appendChild(h('div', { class: 'cmdk-label cmdk-label-all' }, '全部命令'));
      }
      const ok = check(c);
      const node = h('div', {
        id: `cmdk-${i}`, class: ok === true ? 'cmdk-row' : 'cmdk-row off', role: 'option', 'aria-selected': 'false',
        'aria-disabled': ok === true ? null : 'true',
      },
      h('span', { class: 'cmdk-ic' }, c.icon ? icon(c.icon) : null),
      h('span', { class: 'cmdk-title' }, c.title),
      ok === true ? null : h('span', { class: 'cmdk-why' }, blockedText(c, ok)),
      h('span', { class: 'cmdk-group' }, c.group || ''),
      c.keys ? h('span', { class: 'cmdk-kbd' }, kbdNodes(c.keys)) : null);
      const idx = rows.length;
      node.addEventListener('pointermove', () => { if (act !== idx) setAct(idx, false); });
      node.addEventListener('click', () => exec(c));
      rows.push({ c, node });
      list.appendChild(node);
    });
    if (!rows.length) list.appendChild(h('div', { class: 'cmdk-empty' }, '没有匹配的命令'));
    setAct(0);
  };

  input.addEventListener('input', fill);
  const close = mountOverlay('palette', el, {
    focus: input,
    onKey: (e) => {
      if (e.key === 'Escape') { close(); return true; }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { close(); return true; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { setAct(act + (e.key === 'ArrowDown' ? 1 : -1)); return true; }
      if (e.key === 'Enter') { if (rows[act]) exec(rows[act].c); return true; }
      if (e.key === 'Tab') { input.focus(); return true; }
      return false;
    },
  });
  fill();
}

// ---------------------------------------------------------------- shortcut sheet
export function openShortcuts() {
  if (overlay?.kind === 'sheet') { closeOverlay(); return; }
  const groups = GROUPS.map((g) => ({
    g, rows: registry.filter((c) => c.group === g && c.keys && c.sheet !== false),
  })).filter((x) => x.rows.length);
  const body = h('div', { class: 'kbs-body' }, groups.map(({ g, rows }) => h('section', { class: 'kbs-group' },
    h('h3', { class: 'kbs-title' }, g),
    h('table', { class: 'kbs-table' }, h('tbody', {}, rows.map((c) => h('tr', {},
      h('td', { class: 'kbs-keys' }, kbdNodes(c.keys)),
      h('td', { class: 'kbs-act' }, c.sheetTitle || c.title))))))));
  let close = () => {};
  const x = h('button', {
    type: 'button', class: 'icon-btn modal-x', 'aria-label': '关闭', 'data-tip': '关闭', 'data-kbd': 'Esc',
    onClick: () => close(),
  }, icon('x'));
  const card = h('div', { class: 'modal-card kbs', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'kbsTitle' },
    h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, h('strong', { id: 'kbsTitle' }, '快捷键')), x),
    body);
  const el = h('div', { class: 'modal kbs-modal' }, card);
  close = mountOverlay('sheet', el, {
    focus: x,
    onKey: (e) => {
      if (e.key === 'Escape' || (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey)) { close(); return true; }
      if (e.key === 'Tab') { x.focus(); return true; }
      return false;
    },
  });
}

// ---------------------------------------------------------------- init
let inited = false;
export function initCommands({ toast } = {}) {
  if (toast) notify = toast;
  if (inited) return;
  inited = true;
  document.addEventListener('vdm:command-palette', () => openPalette());
  document.addEventListener('vdm:shortcuts', () => openShortcuts());
}
