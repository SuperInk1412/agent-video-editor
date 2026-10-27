// Shared UI primitives: h(), icon(), token(), tooltips, menus, prefs (docs/DESIGN.md §2, §5, §10).
// Pure ES module, no deps; safe to import from any renderer file.

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------- h()
function append(n, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') {
      if (typeof v === 'string') n.style.cssText = v;
      else for (const [p, pv] of Object.entries(v)) {
        if (p.startsWith('--')) n.style.setProperty(p, pv);
        else n.style[p] = pv;
      }
    } else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  append(n, children);
  return n;
}

// ---------------------------------------------------------------- icon()
// icon('play') / icon('i-play') -> <svg class="ic"><use href="#i-play"/></svg>
export function icon(name, cls = '') {
  const id = String(name).replace(/^#?(i-)?/, '');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `ic ${cls}` : 'ic');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.appendChild(use);
  return svg;
}

// ---------------------------------------------------------------- token()
// CSS custom property value for canvas painters; empty results are not cached
// (stylesheets may still be loading).
const tokenCache = new Map();
export function token(name) {
  const key = String(name).startsWith('--') ? String(name) : `--${name}`;
  let v = tokenCache.get(key);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(key).trim();
    if (v) tokenCache.set(key, v);
  }
  return v;
}
token.clear = () => tokenCache.clear();

// ---------------------------------------------------------------- kbd
// 'Ctrl+Shift+Z' -> <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Z</kbd>; ' / ' separates alternatives.
function kbdNodes(spec) {
  const out = [];
  String(spec).split(/\s+\/\s+/).forEach((combo, i) => {
    if (i) out.push(document.createTextNode(' / '));
    for (const k of combo.split(/\+(?=.)/)) if (k) out.push(h('kbd', {}, k));
  });
  return out;
}

// ---------------------------------------------------------------- tooltips
// One delegated listener for [data-tip] (+ optional data-kbd). 450 ms delay,
// single instance, below the target (flips above), hidden on pointerdown/scroll/keydown.
const TIP_DELAY = 450;
let tipEl = null;
let tipTimer = 0;
let tipTarget = null;
let tipMuted = null; // element clicked while hovered: no tip until the pointer leaves it
let tipsOn = false;

function tipNode() {
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = 0;
  tipTarget = null;
  if (tipEl && !tipEl.hidden) {
    tipEl.hidden = true;
    tipEl.classList.remove('show');
  }
}

function showTip(target) {
  const text = target.dataset.tip;
  if (!target.isConnected || !text) return;
  const el = tipNode();
  el.replaceChildren(text);
  if (target.dataset.kbd) el.appendChild(h('span', { class: 'tip-kbd' }, kbdNodes(target.dataset.kbd)));
  el.classList.remove('show');
  el.hidden = false;
  el.style.left = '0px';
  el.style.top = '0px';
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6));
  let top = r.bottom + 6;
  if (top + ht > innerHeight - 6) top = Math.max(6, r.top - ht - 6);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.classList.add('show');
}

export function initTooltips() {
  if (tipsOn) return;
  tipsOn = true;
  document.addEventListener('pointerover', (e) => {
    const t = e.target?.closest?.('[data-tip]') || null;
    if (t === tipTarget || t === tipMuted) return;
    hideTip();
    if (!t || e.pointerType === 'touch') return;
    tipTarget = t;
    tipTimer = setTimeout(() => { tipTimer = 0; if (tipTarget === t) showTip(t); }, TIP_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget;
    if (tipMuted && !(to && tipMuted.contains(to))) tipMuted = null;
    if (tipTarget && !(to && tipTarget.contains(to))) hideTip();
  });
  window.addEventListener('pointerdown', () => { tipMuted = tipTarget; hideTip(); }, true);
  window.addEventListener('keydown', hideTip, true);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);
}

// ---------------------------------------------------------------- menu
// items: { label, run, danger, disabled, title, icon, kbd } | { sep: true } | { group: '标签' }
// opts: { anchor: Element (drop below it, flip above), onClose: fn }
let menu = null; // { el, buttons, act, opts, onKey, onDown, onResize }

function menuNode() {
  let m = document.getElementById('ctxMenu');
  if (!m) {
    m = h('div', { id: 'ctxMenu', class: 'ctx-menu', hidden: true });
    document.body.appendChild(m);
  }
  return m;
}

function setAct(i) {
  if (!menu) return;
  menu.buttons.forEach((b, j) => b.classList.toggle('act', j === i));
  menu.act = i;
}

function moveAct(dir) {
  const bs = menu.buttons;
  if (!bs.length) return;
  let i = menu.act < 0 ? (dir > 0 ? -1 : bs.length) : menu.act;
  for (let n = 0; n < bs.length; n++) {
    i = (i + dir + bs.length) % bs.length;
    if (bs[i].getAttribute('aria-disabled') !== 'true') { setAct(i); return; }
  }
}

export function hideMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) m.hidden = true;
  if (!menu) return;
  const { onKey, onDown, onResize, opts } = menu;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('pointerdown', onDown, true);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('blur', onResize);
  menu = null;
  opts?.onClose?.();
}

export function showMenu(x, y, items, opts = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  hideMenu();
  hideTip();
  const m = menuNode();
  m.classList.add('menu');
  m.setAttribute('role', 'menu');
  m.replaceChildren();
  const withIcons = list.some((it) => it.icon);
  const buttons = [];
  for (const it of list) {
    if (it.sep) { m.appendChild(h('div', { class: 'menu-sep ctx-sep', role: 'separator' })); continue; }
    if (it.group != null && it.label == null) { m.appendChild(h('div', { class: 'menu-group' }, it.group)); continue; }
    const b = h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : null },
      withIcons ? h('span', { class: 'mi-ic' }, it.icon ? icon(it.icon) : null) : null,
      h('span', { class: 'mi-label' }, it.label ?? ''),
      it.kbd ? h('span', { class: 'mi-kbd' }, kbdNodes(it.kbd)) : null);
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    if (it.title) b.dataset.tip = it.title;
    const idx = buttons.length;
    b.addEventListener('pointerenter', () => setAct(it.disabled ? -1 : idx));
    b.addEventListener('click', () => {
      if (it.disabled) return;
      hideMenu();
      it.run?.();
    });
    buttons.push(b);
    m.appendChild(b);
  }
  m.onpointerleave = () => setAct(-1);

  const onKey = (e) => {
    if (!menu) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') moveAct(e.key === 'ArrowDown' ? 1 : -1);
    else if (e.key === 'Enter') { if (menu.act >= 0) menu.buttons[menu.act].click(); }
    else if (e.key === 'Escape') hideMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e) => { if (!m.contains(e.target)) hideMenu(); };
  const onResize = () => hideMenu();
  menu = { el: m, buttons, act: -1, opts, onKey, onDown, onResize };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onResize);

  // place: at (x, y) or under opts.anchor; flip when it would leave the viewport
  m.hidden = false;
  m.style.left = '0px';
  m.style.top = '0px';
  const r = m.getBoundingClientRect();
  let left = x;
  let top = y;
  let flipTop = y - r.height;
  if (opts.anchor) {
    const a = opts.anchor.getBoundingClientRect();
    left = a.left;
    top = a.bottom + 4;
    flipTop = a.top - r.height - 4;
  }
  if (left + r.width > innerWidth - 8) left = (opts.anchor ? opts.anchor.getBoundingClientRect().right : x) - r.width;
  if (top + r.height > innerHeight - 8) top = flipTop;
  m.style.left = `${Math.round(Math.max(6, Math.min(left, innerWidth - r.width - 8)))}px`;
  m.style.top = `${Math.round(Math.max(6, Math.min(top, innerHeight - r.height - 8)))}px`;
  return m;
}

// ---------------------------------------------------------------- prefs
// UI-only preferences in localStorage['vdm.ui.v1'] (one JSON object). Never project data.
const PREFS_KEY = 'vdm.ui.v1';
let prefCache = null;

function loadPrefs() {
  if (prefCache) return prefCache;
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    prefCache = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    prefCache = {};
  }
  return prefCache;
}

export const prefs = {
  get(key, dflt) {
    const v = loadPrefs()[key];
    return v === undefined ? dflt : v;
  },
  set(key, value) {
    const p = loadPrefs();
    if (value === undefined) delete p[key];
    else p[key] = value;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: keep in memory */ }
    return value;
  },
};
