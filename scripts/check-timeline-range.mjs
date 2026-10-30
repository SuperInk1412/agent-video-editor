// Time range selection on the timeline (docs/DESIGN-WP2.5-REVIEW.md §10.6,
// WP2.5d).
//
// Offscreen Electron probe over the real timeline: builds a throwaway 10 s /
// 24 fps project, then, inside the editor, drives real PointerEvents on the
// ruler and the real I / O / Esc keys, and asserts:
//
//   (a) Shift+pointerdown on .tl-ruler takes the range branch (the scrub and
//       zoom handlers are counted and must not run) and the .tl-range band
//       spans f144–f153 within 1px;
//   (b) the playhead does not move during that drag (time and timecode text);
//   (c) a plain drag on the ruler still seeks (time and timecode text move);
//   (d) I then O set the range to the playhead frame (f144–f153);
//   (e) the first Esc clears the range only, the second one clears the
//       selection — and the × button exists with its "清除范围（Esc）" title.
//
//   node scripts/check-timeline-range.mjs [--keep]
//
// The screenshot stays at .scratch/check-timeline-range/shot.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-timeline-range');
const PROJECT = path.join(WORK, 'project');
const SHOT = path.join(WORK, 'shot.png');
const PORT = '47314';
const FPS = 24;
const FROM = 144; // 6.000 s
const TO = 153; // 6.375 s

/** The throwaway project: two 2D elements, one 3D object (for the Esc test). */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const p = normalizeProject(createProject({
    title: 'timeline range probe', duration: 10, fps: FPS, width: 1280, height: 720,
  }));
  applyOps(p, [
    {
      op: 'addElement',
      element: {
        id: 'el_a', name: 'a', type: 'solid', start: 0, duration: 10, z: 1,
        style: { w: 900, h: 500, fill: '#1d3a5c' }, visible: true,
      },
    },
    {
      op: 'addElement',
      element: {
        id: 'el_b', name: 'b', type: 'solid', start: 2, duration: 5, z: 2,
        style: { w: 420, h: 260, fill: '#3c2a66' }, visible: true,
      },
    },
    {
      op: 'objectAdd',
      object: {
        id: 'ob_probe', name: 'probe box', start: 0, duration: 10,
        pivot: [0, 2, 0], geom: { w: 1.4, h: 1.4, d: 1.4 },
      },
    },
  ]);
  await saveProject(PROJECT, p, { by: 'check-timeline-range' });
  return p;
}

// Runs inside the editor. Everything is measured off the real DOM; the result
// lands in window.__dbg and comes back through the `[capture]` line.
const probe = () => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: {}, values: {}, errors: [] };
  try {
    for (let i = 0; i < 120 && !window.__vdm; i++) await sleep(50);
    const app = window.__vdm;
    if (!app) throw new Error('the editor never booted');
    const fps = Number(app.S.project.meta.fps) || 24;
    const tl = app.timeline;
    app.pause();
    app.setTime(0);

    const ruler = document.querySelector('.tl-ruler');
    const track = ruler && ruler.querySelector('.tl-track');
    if (!ruler || !track) throw new Error('no .tl-ruler / .tl-track in the DOM');
    const tc = () => (document.querySelector('#timecode') || {}).textContent || '';
    /* Invert timeline._timeAt(): ruler x -> time -> frame, no layout assumptions. */
    const clientX = (f) => {
      const rect = tl.scroll.getBoundingClientRect();
      return rect.left - tl.scroll.scrollLeft + tl._gutter() + (f / fps) * tl.pps;
    };
    const pt = (type, f, extra) => new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, composed: true,
      pointerId: 7, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: clientX(f), clientY: ruler.getBoundingClientRect().top + 8,
    }, extra || {}));
    const key = (k, code) => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: k, code: code, bubbles: true, cancelable: true,
    }));

    /* the shell hook (main.js onRangeChange) must arrive through the options */
    const rangeHook = typeof tl.onRangeChange === 'function';
    let rangeHookCalls = 0;
    if (rangeHook) {
      const realHook = tl.onRangeChange;
      tl.onRangeChange = function (r) { rangeHookCalls += 1; return realHook(r); };
    }

    /* (a) Shift+pointerdown on the ruler is a range drag, never a scrub */
    let rangeCalls = 0;
    let scrubCalls = 0;
    let zoomCalls = 0;
    const realRange = tl._startRangeDrag;
    const realScrub = tl._startScrub;
    const realZoom = tl._startZoomDrag;
    tl._startRangeDrag = function () { rangeCalls += 1; return realRange.apply(this, arguments); };
    /* The scrub / zoom stubs still call through: if the modifier check leaked, */
    /* the real scrub would move the playhead and (b) would catch it. */
    tl._startScrub = function () { scrubCalls += 1; return realScrub.apply(this, arguments); };
    tl._startZoomDrag = function () { zoomCalls += 1; return realZoom.apply(this, arguments); };

    const timeBefore = app.S.time;
    const tcBefore = tc();
    track.dispatchEvent(pt('pointerdown', ${FROM}, { shiftKey: true }));
    window.dispatchEvent(pt('pointermove', 148, { shiftKey: true }));
    window.dispatchEvent(pt('pointermove', ${TO}, { shiftKey: true }));
    window.dispatchEvent(pt('pointerup', ${TO}));
    const timeAfter = app.S.time;
    const tcAfter = tc();
    tl._startRangeDrag = realRange;
    tl._startScrub = realScrub;
    tl._startZoomDrag = realZoom;

    const range = tl.getRange();
    const band = document.querySelector('.tl-range');
    const bandX = document.querySelector('.tl-range-x');
    const pps = tl.pps;
    const expected = { left: (${FROM} / fps) * pps, width: ((${TO} - ${FROM} + 1) / fps) * pps };
    out.values.drag = { rangeCalls, scrubCalls, zoomCalls, timeBefore, timeAfter, tcBefore, tcAfter };
    out.values.range = range;
    out.values.pps = pps;
    out.values.expected = expected;
    out.values.band = band ? {
      left: parseFloat(band.style.left), width: parseFloat(band.style.width),
      offsetLeft: band.offsetLeft, offsetWidth: band.offsetWidth,
      rectLeftInTrack: band.getBoundingClientRect().left - track.getBoundingClientRect().left,
      rectWidth: band.getBoundingClientRect().width,
      trackWidth: track.getBoundingClientRect().width,
    } : null;
    out.checks.rangeBranch = rangeCalls === 1 && scrubCalls === 0 && zoomCalls === 0;
    out.checks.playheadHeld = timeBefore === timeAfter && tcBefore === tcAfter;
    out.checks.rangeChangeWired = rangeHook && rangeHookCalls > 0;
    out.checks.rangeIs144to153 = !!range && range.from === ${FROM} && range.to === ${TO};
    out.checks.bandDrawn = !!band;
    out.checks.bandGeometry = !!band
      && Math.abs(parseFloat(band.style.left) - expected.left) <= 1
      && Math.abs(parseFloat(band.style.width) - expected.width) <= 1
      && Math.abs((band.getBoundingClientRect().left - track.getBoundingClientRect().left) - expected.left) <= 1;
    out.checks.rangeXButton = !!bandX && bandX.getAttribute('title') === '清除范围（Esc）'
      && bandX.getBoundingClientRect().width === 16 && bandX.getBoundingClientRect().height === 16;

    /* (b) a plain drag on the ruler still seeks */
    const seekBefore = app.S.time;
    const tcSeekBefore = tc();
    track.dispatchEvent(pt('pointerdown', 60));
    window.dispatchEvent(pt('pointermove', 72));
    window.dispatchEvent(pt('pointerup', 72));
    const seekAfter = app.S.time;
    const tcSeekAfter = tc();
    out.values.plainDrag = { before: seekBefore, after: seekAfter, tcBefore: tcSeekBefore, tcAfter: tcSeekAfter };
    out.checks.plainDragSeeks = Math.abs(seekAfter - 72 / fps) < 0.001 && tcSeekAfter !== tcSeekBefore;

    /* (d) I then O take the playhead frame */
    tl.clearRange();
    app.setTime(${FROM} / fps);
    key('I', 'KeyI');
    await sleep(30);
    const afterI = tl.getRange();
    app.setTime(${TO} / fps);
    key('O', 'KeyO');
    await sleep(30);
    const afterO = tl.getRange();
    out.values.keys = { afterI, afterO, time: app.S.time };
    out.checks.keyRange = !!afterI && afterI.from === ${FROM} && afterI.to === ${FROM}
      && !!afterO && afterO.from === ${FROM} && afterO.to === ${TO};

    /* the band's × clears the range on its own (no Esc, no selection change) */
    bandX.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(20);
    const afterX = tl.getRange();
    out.values.rangeX = { afterX, bandGone: !document.querySelector('.tl-range') };
    out.checks.rangeXClears = !afterX && out.values.rangeX.bandGone;
    tl.setRange({ from: ${FROM}, to: ${TO} });

    /* (e) Esc clears the range first, the selection second */
    app.select({ objectId: 'ob_probe' });
    const selBefore = app.S.selection.objectId;
    key('Escape', 'Escape');
    await sleep(20);
    const rangeAfterFirst = tl.getRange();
    const selAfterFirst = app.S.selection.objectId;
    const bandAfterFirst = !!document.querySelector('.tl-range');
    key('Escape', 'Escape');
    await sleep(20);
    const selAfterSecond = app.S.selection.objectId;
    out.values.esc = { selBefore, rangeAfterFirst, selAfterFirst, bandAfterFirst, selAfterSecond };
    out.checks.escClearsRangeFirst = !!selBefore && !rangeAfterFirst
      && selAfterFirst === selBefore && !bandAfterFirst;
    out.checks.escThenSelection = !selAfterSecond;

    /* leave a visible band for the screenshot; the playhead sits on the in
       point, so the band edge must land on the playhead line (an independent
       reference for "left = frame 144") */
    tl.setRange({ from: ${FROM}, to: ${TO} });
    app.setTime(${FROM} / fps);
    out.values.finalRange = tl.getRange();
    const endBand = document.querySelector('.tl-range');
    const endX = document.querySelector('.tl-range-x');
    const head = document.querySelector('.tl-playhead');
    out.values.final = endBand && head ? {
      bandLeft: endBand.getBoundingClientRect().left,
      bandRight: endBand.getBoundingClientRect().right,
      bandWidth: endBand.getBoundingClientRect().width,
      playheadLeft: head.getBoundingClientRect().left,
      xCenter: endX ? endX.getBoundingClientRect().left + endX.getBoundingClientRect().width / 2 : null,
    } : null;
    out.values.finalBand = !!endBand;
    out.checks.bandOnPlayheadFrame = !!out.values.final
      && Math.abs(out.values.final.bandLeft - out.values.final.playheadLeft) <= 1.5;
    out.checks.rangeXOnBandEdge = !!out.values.final && out.values.final.xCenter != null
      && Math.abs(out.values.final.xCenter - out.values.final.bandRight) <= 1.5;
    out.checks.alive = !!window.__vdm && !!document.querySelector('#timeline');
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
})()`;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

/** Pull the JSON object out of the `[capture] <png> {json}` line. */
function parseCapture(stdout) {
  const line = stdout.split('\n').find((l) => l.includes('[capture]'));
  if (!line) return null;
  const start = line.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(line.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const checks = [];
const check = (ok, label, detail) => {
  checks.push({ ok: !!ok, label, detail });
  console.log(`[timeline-range] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function main() {
  await build();
  const script = probe().replace(/\n\s*/g, ' ');
  // A dedicated port: the app attaches to an engine already listening on
  // VDM_PORT, and a leftover one would serve another project.
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${SHOT}`, `--at=${FROM / FPS}`, '--delay=3200', '--hold=500',
    `--eval=${script}`,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error('[timeline-range] the probe returned nothing');
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  const d = payload.dbg;
  const v = d.values || {};
  console.log(`[timeline-range] captured ${payload.dbg ? 'dbg' : 'no dbg'} · ${JSON.stringify(v.drag || {})}`);
  console.log(`[timeline-range] expected left/width ${JSON.stringify(v.expected)} · band ${JSON.stringify(v.band)}`);
  if (d.errors?.length) {
    console.error(`[timeline-range] probe error: ${d.errors.join('\n')}`);
    process.exit(1);
  }
  const c = d.checks || {};
  const drag = v.drag || {};
  check(c.rangeBranch, 'Shift+pointerdown on .tl-ruler is the range branch',
    `range=${drag.rangeCalls} scrub=${drag.scrubCalls} zoom=${drag.zoomCalls} (both stubs counted, neither ran)`);
  check(c.rangeIs144to153, 'the drag selected integer frames 144–153', JSON.stringify(v.range));
  check(c.bandDrawn, 'the .tl-range band exists', v.band ? `left ${v.band.left}px width ${v.band.width}px` : 'missing');
  check(c.bandGeometry, 'the band spans f144–f153 within 1px',
    `left ${v.band?.left}→${Math.round(v.expected?.left)} width ${v.band?.width}→${Math.round(v.expected?.width)} pps ${v.pps}`);
  check(c.playheadHeld, 'the range drag never seeks', `time ${drag.timeBefore}→${drag.timeAfter} tc "${drag.tcBefore}"→"${drag.tcAfter}"`);
  check(c.rangeChangeWired, 'onRangeChange reaches the shell', `${drag.rangeCalls} drag(s), hook called`);
  check(c.plainDragSeeks, 'a plain ruler drag still seeks', `time ${v.plainDrag?.before}→${v.plainDrag?.after} tc "${v.plainDrag?.tcBefore}"→"${v.plainDrag?.tcAfter}"`);
  check(c.keyRange, 'I then O set the range to the playhead frames', JSON.stringify(v.keys));
  check(c.rangeXButton, 'the band carries a 16×16 × with the clear title', 'title="清除范围（Esc）"');
  check(c.rangeXClears, 'the × clears the range', JSON.stringify(v.rangeX));
  check(c.escClearsRangeFirst, 'the first Esc clears the range only', JSON.stringify(v.esc));
  check(c.escThenSelection, 'the second Esc clears the selection', `selection ${v.esc?.selAfterFirst}→${v.esc?.selAfterSecond}`);
  check(c.bandOnPlayheadFrame, 'the band starts on the f144 playhead line',
    `band ${v.final?.bandLeft} vs playhead ${v.final?.playheadLeft}`);
  check(c.rangeXOnBandEdge, 'the × sits on the band\'s right edge',
    `× ${v.final?.xCenter} vs edge ${v.final?.bandRight}`);
  check(c.alive, 'the editor is still alive', `final range ${JSON.stringify(v.finalRange)} band=${v.finalBand}`);
  if (!process.argv.includes('--keep')) console.log(`[timeline-range] project + screenshot kept in ${path.relative(REPO, WORK)}`);
  const failed = checks.filter((x) => !x.ok);
  if (failed.length) {
    console.log(`[timeline-range] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[timeline-range] PASS (${checks.length}/${checks.length}) · shot ${path.relative(REPO, SHOT)}`);
}

main().catch((e) => { console.error('[timeline-range]', e.stack || e.message); process.exit(1); });
