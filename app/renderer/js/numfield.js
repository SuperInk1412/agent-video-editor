// Numeric field behaviour shared by the timeline and the inspector.
//
// Native <input type="number"> fights the user while typing ("0." gets eaten by
// the browser's value sanitizer, and any re-render that writes `value` throws
// the caret away). These fields are plain text inputs with three additions:
//
//   1. the display text is only rewritten while the field is *not* focused, so
//      partial input like "0." or "-" survives;
//   2. crosshair scrub: while dragging, horizontal movement changes the value
//      and vertical movement changes the gain. Down = finer, up = coarser, with
//      no modifier keys and no mode switch. Moving vertically (changing gear)
//      never changes the value, so hand tremor on the way out is harmless.
//   3. a tiny up/down spinner appears on hover and nudges by one step.
//
// On release the value snaps to a power-of-ten grid derived from the gain, so
// coarse drags land on 1/10/100 and fine drags can land on 0.0001.
//
// Percent fields set data-scale="100" + data-unit="%": the project keeps the
// 0..1 value (opacity) while the field shows 0..100%.

const DEFAULT_DECIMALS = 2;
const MAX_DECIMALS = 4;

// Gain range: from a tenth of the finest snap grid up to "the software limit"
// (a bounded field can be crossed with one short flick).
export const SCRUB_MIN_GAIN = 0.0001;
export const SCRUB_MAX_GAIN = 10000;
const SCRUB_SPAN = 500; // px of vertical travel for the whole gain range

/** Parse display text ("35%", " 1,5 ") into a plain number (NaN when invalid). */
export function parseValue(text) {
  if (text == null) return NaN;
  const cleaned = String(text).replace(/%/g, '').replace(/,/g, '.').trim();
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

const decimalsOf = (step) => {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(6, s.length - dot - 1);
};

/** Format a project value for display (scale + unit + sensible decimals). */
export function formatValue(value, { scale = 1, unit = '', step = 0.1, digits } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  const shown = v * scale;
  // Normal fields use two decimals; a fine scrub asks for more (max 4).
  const wanted = Number.isFinite(digits)
    ? Math.min(MAX_DECIMALS, Math.max(DEFAULT_DECIMALS, digits))
    : Math.max(DEFAULT_DECIMALS, decimalsOf(Math.abs(Number(step) * scale) || 0.01));
  const rounded = Number(shown.toFixed(wanted));
  return `${rounded}${unit}`;
}

/** Power-of-ten snap grid for a drag gain (0.0001 .. 10000). */
export function snapQuantum(gain) {
  const g = Number(gain);
  if (!Number.isFinite(g) || g <= 0) return SCRUB_MIN_GAIN;
  const q = 10 ** Math.round(Math.log10(g));
  return Math.min(SCRUB_MAX_GAIN, Math.max(SCRUB_MIN_GAIN, q));
}

/** Display decimals needed to show a snap grid (percent-aware, max 4). */
function digitsForGrid(inp, q) {
  const shown = Math.max(Math.abs(q) * scaleOf(inp), 1e-4);
  return Math.max(DEFAULT_DECIMALS, Math.min(MAX_DECIMALS, decimalsOf(shown)));
}

/**
 * Gain for a vertical offset from the press point. Down (positive) is finer,
 * up is coarser; 0 is the geometric middle of the range.
 */
export function gainAt(dy, gmin = SCRUB_MIN_GAIN, gmax = SCRUB_MAX_GAIN) {
  const t = Math.min(1, Math.max(0, 0.5 - Number(dy) / SCRUB_SPAN));
  return gmin * (gmax / gmin) ** t;
}

const scaleOf = (inp) => (Number(inp.dataset.scale) > 0 ? Number(inp.dataset.scale) : 1);
const unitOf = (inp) => inp.dataset.unit || '';
const stepOf = (inp) => {
  const n = Number(inp.step);
  return Number.isFinite(n) && n > 0 ? n : 0.1;
};

const clampTo = (inp, v) => {
  let out = Number(v);
  if (!Number.isFinite(out)) return out;
  const min = inp.min === '' || inp.min == null ? NaN : Number(inp.min);
  const max = inp.max === '' || inp.max == null ? NaN : Number(inp.max);
  if (Number.isFinite(min)) out = Math.max(min, out);
  if (Number.isFinite(max)) out = Math.min(max, out);
  return out;
};

/** Read the field as a project value (display / scale). */
export function readNumber(inp) {
  if (!inp) return NaN;
  return parseValue(inp.value) / scaleOf(inp);
}

/**
 * Write a project value into the field. Focused fields are skipped unless
 * `force` is set, which is what keeps typing (and the caret) intact when the
 * project re-renders underneath the user.
 */
export function writeNumber(inp, value, { force = false, digits } = {}) {
  if (!inp) return;
  if (!force && document.activeElement === inp) return;
  // An active crosshair drag owns the field even after it lost focus (the
  // pointer left the input); project updates must not overwrite the number
  // under the user's hand.
  if (!force && inp.dataset.nfHold === '1') return;
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  // Fine scrub leaves a preferred precision on the field; keep honouring it so
  // a re-render does not shorten 12.3456 back to 12.35.
  const preferred = digits ?? (inp.dataset.nfDigits ? Number(inp.dataset.nfDigits) : undefined);
  const text = formatValue(v, { scale: scaleOf(inp), unit: unitOf(inp), step: stepOf(inp), digits: preferred });
  if (inp.value !== text) inp.value = text;
}

// ---------------------------------------------------------------- spinner
// One floating spinner shared by every field: it is cheaper than injecting
// markup into each row (which would move the row layout around while hovering).
let spinner = null;
let spinnerInput = null;
let spinnerKey = '';
let hideTimer = 0;

function ensureSpinner() {
  if (spinner) return spinner;
  spinner = document.createElement('div');
  spinner.className = 'nf-spin';
  spinner.hidden = true;
  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'nf-up';
  up.textContent = '▴';
  up.title = '增加（步长）';
  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'nf-dn';
  down.textContent = '▾';
  down.title = '减少（步长）';
  for (const [btn, sign] of [[up, 1], [down, -1]]) {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (spinnerInput) nudge(spinnerInput, sign);
    });
  }
  spinner.append(up, down);
  spinner.addEventListener('pointerenter', () => { clearTimeout(hideTimer); });
  spinner.addEventListener('pointerleave', () => hideSoon());
  document.body.appendChild(spinner);
  return spinner;
}

function placeSpinner(inp) {
  const el = ensureSpinner();
  // a pending "hide" (e.g. scheduled by the pointerdown that focused the field)
  // must not kill the spinner we are about to show
  clearTimeout(hideTimer);
  const r = inp.getBoundingClientRect();
  el.style.left = `${Math.round(r.right - 12)}px`;
  el.style.top = `${Math.round(r.top + 2)}px`;
  el.style.height = `${Math.max(12, Math.round(r.height - 4))}px`;
  el.hidden = false;
  spinnerInput = inp;
  spinnerKey = fieldKey(inp);
}

function hideSoon() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!spinner) return;
    spinner.hidden = true;
    spinnerInput = null;
  }, 140);
}

function hideNow() {
  clearTimeout(hideTimer);
  if (spinner) spinner.hidden = true;
  spinnerInput = null;
}

// One pair of window listeners for every field. Scrolling (including the
// timeline's own scroller, caught in the capture phase) moves the field under
// the floating spinner, so follow it instead of hiding it — hiding made the
// triangles "randomly" unclickable while typing/scrolling.
let globalBound = false;
function followSpinner() {
  if (!spinner || spinner.hidden) return;
  const input = spinnerInput;
  if (input?.isConnected) placeSpinner(input);
  else hideNow();
}
function bindGlobal() {
  if (globalBound) return;
  globalBound = true;
  window.addEventListener('scroll', followSpinner, true);
  window.addEventListener('resize', followSpinner);
}

// ---------------------------------------------------------------- nudge / scrub
function emit(inp) {
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}

// Rebuilds (project ops) replace the input node; the floating spinner is kept
// in place, so nudges must look up whichever field sits under it now.
function fieldKey(inp) {
  const row = inp.closest('.tl-row, .fld');
  if (!row) return '';
  const label = row.querySelector('.tl-plabel, label')?.textContent?.trim() || '';
  const parts = [row.dataset.cam, row.dataset.obj, row.dataset.path, label].filter(Boolean);
  return `${parts.join('|')}#${[...row.querySelectorAll('input._nf')].indexOf(inp)}`;
}

function liveField(inp) {
  if (inp?.isConnected) return inp;
  if (!spinner || spinner.hidden) return null;
  const r = spinner.getBoundingClientRect();
  const el = document.elementFromPoint(r.left - 6, r.top + r.height / 2);
  const cand = el?.tagName === 'INPUT' ? el : el?.querySelector?.('input');
  return cand && cand._numField && fieldKey(cand) === spinnerKey ? cand : null;
}

/** Find the field that replaced `key` after a row rebuild. */
function findFieldByKey(key) {
  if (!key) return null;
  for (const el of document.querySelectorAll('input._nf')) {
    if (el._numField && fieldKey(el) === key) return el;
  }
  return null;
}

function nudge(inp, sign) {
  const target = liveField(inp);
  if (!target) { hideNow(); return; }
  const cur = readNumber(target);
  const next = clampTo(target, (Number.isFinite(cur) ? cur : 0) + sign * stepOf(target));
  writeNumber(target, next, { force: true });
  emit(target);
  target.dispatchEvent(new Event('change', { bubbles: true }));
  // the op may rebuild the row; keep the spinner on the fresh node
  placeSpinner(target);
}

/**
 * Wire a numeric input. Safe to call twice (returns the same controller).
 *
 * Crosshair drag: horizontal = value, vertical = gain (down finer, up
 * coarser). The value only ever moves on horizontal travel, so pulling the
 * pointer away to reach a fine gear cannot disturb it; small sideways jitter
 * is swallowed by a 2px dead zone.
 */
export function attachNumberField(inp) {
  if (inp._numField) return inp._numField;
  inp.type = 'text';
  inp.inputMode = 'decimal';
  inp.autocomplete = 'off';
  inp.spellcheck = false;
  inp.classList.add('_nf');


  let node = inp; // the DOM node for this field; rows may rebuild it mid-drag
  let drag = null;

  const hold = (el) => {
    if (!el) return;
    el.dataset.nfHold = '1';
    if (drag?.digits != null) {
      el.dataset.nfDigits = String(drag.digits);
      writeNumber(el, drag.value, { force: true, digits: drag.digits });
    }
  };

  /** Current node for this field; follows a rebuild by field key. */
  const live = () => {
    if (node.isConnected) return node;
    const next = findFieldByKey(drag?.key);
    if (!next) return null;
    node = next;
    if (drag) hold(next);
    return next;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    hideSoon();
    // Make the spinner reachable the moment the field is clicked into (the
    // focus event alone is unreliable in offscreen/iframe cases).
    placeSpinner(inp);
    // Focus the field so the timeline/inspector keep the rows alive; the drag
    // drops the focus again as soon as the pointer leaves the field.
    try { inp.focus({ preventScroll: true }); } catch { /* ignore */ }
    node = inp;
    // y0 stays fixed for the whole drag (it is the gain reference); lastX/lastY
    // give per-event movement so a gear change is not confused with a value edit.
    drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      accX: 0,
      value: readNumber(inp),
      moved: false,
      edited: false,
      lastEmit: 0,
      digits: null,
      key: fieldKey(inp),
    };
    hold(inp);
    // Listeners live only while a drag is possible: timeline rows are rebuilt
    // on every project change, so permanent window listeners would pile up on
    // detached inputs.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };

  const onPointerMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const el = live();
    if (!el) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      document.body.classList.add('nf-scrubbing');
      window.getSelection?.()?.removeAllRanges?.();
      try { el.setPointerCapture(drag.id); } catch { /* ignore */ }
    }
    e.preventDefault();
    // Once the pointer leaves the field, drop the caret/focus: a blinking "|"
    // over the number makes it hard to read what is changing.
    const r = el.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) {
      if (document.activeElement === el) el.blur();
      window.getSelection?.()?.removeAllRanges?.();
    }
    const ddx = e.clientX - drag.lastX;
    const ddy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    const gain = gainAt(dy);
    // Vertical movement is a gear change: swallow sideways jitter that comes
    // with it instead of applying it to the value.
    if (Math.abs(ddy) > Math.abs(ddx) * 2) {
      drag.accX = 0;
      return;
    }
    drag.accX += ddx;
    if (Math.abs(drag.accX) < 2) return; // dead zone: shake, not an edit
    const stepX = drag.accX;
    drag.accX = 0;
    if (!Number.isFinite(drag.value)) drag.value = 0;
    const target = live();
    if (!target) return;
    drag.value = clampTo(target, drag.value + stepX * gain);
    drag.edited = true;
    const digits = digitsForGrid(target, snapQuantum(gain));
    drag.digits = digits;
    target.dataset.nfDigits = String(digits);
    writeNumber(target, drag.value, { force: true, digits });
    // One save per ~60ms is plenty for live preview; the final value is sent
    // on pointerup.
    const now = performance.now();
    if (now - drag.lastEmit > 60) { drag.lastEmit = now; emit(target); }
  };

  const endDrag = (e) => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    if (!drag) return;
    const moved = drag.moved;
    const edited = drag.edited;
    const gain = gainAt(e.clientY - drag.y0);
    let value = drag.value;
    const el = live() || node;
    drag = null;
    document.body.classList.remove('nf-scrubbing');
    try { inp.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (el) {
      el.dataset.nfHold = '';
      delete el.dataset.nfHold;
      if (moved && edited) {
        // snap to the current gear's power-of-ten grid
        const q = snapQuantum(gain);
        const digits = digitsForGrid(el, q);
        el.dataset.nfDigits = String(digits);
        if (Number.isFinite(value)) value = Math.round(value / q) * q;
        writeNumber(el, clampTo(el, value), { force: true, digits });
        emit(el);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  };
  inp.addEventListener('pointerdown', onPointerDown);
  inp.addEventListener('pointerenter', () => { placeSpinner(inp); });
  inp.addEventListener('pointerleave', hideSoon);
  // Keep the spinner reachable while the field is being edited: clicking a
  // triangle must not require leaving the text cursor first.
  inp.addEventListener('focus', () => { placeSpinner(inp); });
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    nudge(inp, e.key === 'ArrowUp' ? 1 : -1);
  });
  inp.addEventListener('blur', () => {
    hideSoon();
    const v = readNumber(inp);
    if (Number.isFinite(v)) writeNumber(inp, clampTo(inp, v), { force: true });
  });
  bindGlobal();

  const api = {
    read: () => readNumber(inp),
    write: (v) => writeNumber(inp, v, { force: true }),
  };
  inp._numField = api;
  return api;
}
