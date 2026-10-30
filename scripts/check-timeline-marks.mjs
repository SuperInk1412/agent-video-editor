// Timeline marks + element locks (docs/DESIGN-WP2.5-REVIEW.md §10.3 / §10.5,
// WP2.5b).
//
// Offscreen Electron probe over the real timeline and viewport:
//
//   Node side: build a throwaway 10 s / 24 fps project, propose three change
//   sets through `ChangeSetService` (a whole-segment property, a keyframe, a
//   start move) and classify them with `core/timeline-marks.js`.
//   Electron side: inject those marks, then assert
//
//   (1) the hit row carries the 2px `.tl-ai-bar` and the clip outline;
//   (2) the hit keyframe diamond carries `.tl-key-ai` (same size, ring only);
//   (3) the ruler diamond sits on the frame `marksFor` reported (±1px);
//   (4) clicking it calls `switchRightTab('review')` and seeks to that frame;
//   (5) the row lock icon writes `locked: true`, and Ctrl+Z puts it back;
//   (6) a click on a locked element passes through to the first unlocked one;
//   (7) a row marquee skips the locked row and says so;
//   (8) (Node side) `ChangeSetService.apply({ actorId: 'agent:dsh' })` on the
//       locked element throws `LOCKED`.
//
//   node scripts/check-timeline-marks.mjs [--keep]
//
// The screenshot stays at .scratch/check-timeline-marks/shot.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';
import { projectService } from '../engine/projects.js';
import { ChangeSetService } from '../application/changeset-service.js';
import { marksFor } from '../core/timeline-marks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-timeline-marks');
const PROJECT = path.join(WORK, 'project');
const SHOT = path.join(WORK, 'shot.png');
const PORT = '47315';
const FPS = 24;
const RULER_FRAME = 24; // el_b start 2.0 s -> 1.0 s = f24 (the smaller of before / after)

/** The throwaway project: a big back block, an overlapping front block, a side block. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const p = normalizeProject(createProject({
    title: 'timeline marks probe', duration: 10, fps: FPS, width: 1280, height: 720,
  }));
  applyOps(p, [
    {
      op: 'addElement',
      element: {
        // Unified-space element: its transform rows (pivot / position / …) are
        // the ones a keyframe lands on, so the diamond has a `pivot.x` path.
        id: 'el_a', name: 'a 底板', type: 'solid', start: 0, duration: 10, z: 1,
        node: { pivot: [0, 3.6, 0], position: [0, 0, 0], dir: [0, 0, -1], scale: [1, 1, 1] },
        // An existing key, so the proposed change modifies a diamond that is
        // already on screen (a proposal never writes the key into the project).
        keyframes: [{ t: 1.5, path: 'pivot.x', value: 0, ease: 'easeInOut' }],
        style: { w: 900, h: 500, fill: '#1d3a5c' }, visible: true,
      },
    },
    {
      op: 'addElement',
      element: {
        id: 'el_b', name: 'b 前景', type: 'solid', start: 2, duration: 5, z: 2,
        style: { w: 420, h: 260, fill: '#3c2a66' }, visible: true,
      },
    },
    {
      op: 'addElement',
      element: {
        id: 'el_c', name: 'c 侧边', type: 'solid', start: 4, duration: 2, z: 3,
        transform: { x: 300, y: 0 }, style: { w: 200, h: 120, fill: '#2a6644' }, visible: true,
      },
    },
  ]);
  await saveProject(PROJECT, p, { by: 'check-timeline-marks' });
  return p;
}

/** Pre-seed three proposed change sets and classify them (no project write). */
async function seed() {
  const service = projectService(PROJECT);
  const changesets = new ChangeSetService(service);
  const project = await service.read();
  const records = [
    await changesets.propose({
      actorId: 'agent:dsh', intent: '底板加粗',
      ops: [{ op: 'set', id: 'el_a', path: 'style.size', value: 150 }],
    }),
    await changesets.propose({
      actorId: 'agent:dsh', intent: '给底板横向位置打一个键',
      ops: [{ op: 'keySet', id: 'el_a', path: 'pivot.x', t: 1.5, value: 1.2 }],
    }),
    await changesets.propose({
      actorId: 'agent:dsh', intent: '前景整体前移',
      ops: [{ op: 'set', id: 'el_b', path: 'start', value: 1 }],
    }),
  ];
  return { service, changesets, project, records, marks: marksFor(records, project, { fps: FPS }) };
}

// Runs inside the editor. Everything is measured off the real DOM; the result
// lands in window.__dbg and comes back through the `[capture]` line.
const probe = (marks) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: {}, values: {}, errors: [] };
  const $ = (s) => document.querySelector(s);
  try {
    for (let i = 0; i < 160 && !window.__vdm; i++) await sleep(50);
    const app = window.__vdm;
    if (!app) throw new Error('the editor never booted');
    const tl = app.timeline;
    const fps = Number(app.S.project.meta.fps) || 24;
    app.pause();
    app.setTime(0);

    /* The engine of this branch has no /api/changesets route yet (that is
       WP2.5a); the marks are the real marksFor() result computed in Node from
       the real records, injected through the public setMarks(). */
    const MARKS = ${JSON.stringify(marks)};
    tl.setMarks(MARKS);
    await sleep(60);

    /* (1) the hit row: 2px bar in the name column + thin outline on the clip */
    const rowA = $('.tl-elhead[data-el="el_a"]');
    const gutterA = rowA && rowA.querySelector('.tl-gutter');
    const bar = gutterA && gutterA.querySelector(':scope > .tl-ai-bar');
    const outline = rowA && rowA.querySelector('.tl-track > .tl-ai-outline');
    const clipA = rowA && rowA.querySelector('.tl-track > .blk');
    const barRect = bar && bar.getBoundingClientRect();
    const gutterRect = gutterA && gutterA.getBoundingClientRect();
    const outRect = outline && outline.getBoundingClientRect();
    const clipRect = clipA && clipA.getBoundingClientRect();
    out.values.row = {
      bar: barRect && { left: barRect.left, width: barRect.width, height: barRect.height },
      gutterLeft: gutterRect && gutterRect.left,
      outline: outRect && { left: outRect.left, width: outRect.width },
      clip: clipRect && { left: clipRect.left, width: clipRect.width },
    };
    out.checks.rowBar = !!bar && Math.abs(barRect.width - 2) <= 0.6
      && Math.abs(barRect.left - gutterRect.left) <= 1 && barRect.height >= 20;
    out.checks.clipOutline = !!outline
      && Math.abs(outRect.left - clipRect.left) <= 1.5
      && Math.abs(outRect.width - clipRect.width) <= 1.5;

    /* (2) the keyframe ring: open the element + its pivot sub-rows so the
       per-axis diamonds exist */
    tl.expandedEls.add('el_a');
    tl._xformOpen.add('el:el_a:pivot');
    tl.render(true);
    tl.setMarks(MARKS);
    await sleep(60);
    const key = $('.tl-key[data-el="el_a"][data-path="pivot.x"][data-t="1.5"]');
    const keyStyle = key && getComputedStyle(key);
    out.values.key = key ? { cls: key.className, shadow: keyStyle.boxShadow, offsetWidth: key.offsetWidth } : null;
    out.checks.keyRing = !!key && key.classList.contains('tl-key-ai')
      && key.offsetWidth === 7
      && /2px/.test(keyStyle.boxShadow || '')
      && /181, 140, 255/.test(keyStyle.boxShadow || '');

    /* (3) the ruler diamond on the frame marksFor reported */
    const diamond = $('.tl-ruler .tl-ai-ruler');
    const diamondLeft = diamond ? parseFloat(diamond.style.left) : null;
    const expectedLeft = (MARKS.ruler[0].frame / fps) * tl.pps;
    out.values.ruler = {
      frame: MARKS.ruler[0].frame, left: diamondLeft, expectedLeft, pps: tl.pps,
      title: diamond && diamond.getAttribute('title'), z: diamond && getComputedStyle(diamond).zIndex,
      playheadZ: getComputedStyle($('.tl-playhead-layer')).zIndex,
    };
    out.checks.rulerDiamond = !!diamond && Math.abs(diamondLeft - expectedLeft) <= 1;
    out.checks.rulerTitle = !!diamond
      && (diamond.getAttribute('title') || '').includes('AI 改动 · f' + MARKS.ruler[0].frame);
    out.checks.rulerBelowPlayhead = !!diamond
      && Number(out.values.ruler.z) < Number(out.values.ruler.playheadZ);

    /* (4) clicking the diamond opens the review page on that frame */
    const tabCalls = [];
    const realTab = app.switchRightTab;
    app.switchRightTab = (n) => { tabCalls.push(String(n)); return realTab(n); };
    diamond.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(80);
    app.switchRightTab = realTab;
    const timeAfterClick = app.S.time;
    out.values.click = { tabCalls, time: timeAfterClick, reviewPanel: !!$('#panelReview') };
    out.checks.rulerClick = tabCalls.includes('review');
    out.checks.rulerSeek = Math.abs(timeAfterClick - MARKS.ruler[0].frame / fps) <= 1 / fps + 1e-6;
    /* the mark sits on the same frame the playhead now stands on */
    const headNode = $('.tl-playhead');
    const dRect = diamond.getBoundingClientRect();
    const hRect = headNode.getBoundingClientRect();
    out.values.align = { diamondCenter: dRect.left + dRect.width / 2, playheadCenter: hRect.left + hRect.width / 2 };
    out.checks.rulerOnPlayheadFrame = Math.abs(out.values.align.diamondCenter - out.values.align.playheadCenter) <= 1.5;

    /* (5) the row lock icon writes locked:true, Ctrl+Z puts it back */
    const lockA = $('.tl-elhead[data-el="el_a"] .tl-lock');
    const lockTip = lockA && (lockA.dataset.tip || '');
    lockA.click();
    await sleep(500);
    const p1 = await fetch('/api/project').then((r) => r.json());
    const lockedA = p1.project.elements.find((e) => e.id === 'el_a')?.locked === true;
    const iconOn = $('.tl-elhead[data-el="el_a"] .tl-lock');
    app.select({ elementId: 'el_a' });
    await sleep(150);
    const head = $('.insp-head');
    const headActions = [...document.querySelectorAll('.insp-actions .icon-btn')].map((n) => n.getAttribute('aria-label'));
    out.values.lock = {
      tip: lockTip, lockedA,
      iconClass: iconOn && iconOn.className,
      iconOpacity: iconOn && getComputedStyle(iconOn).opacity,
      iconColor: iconOn && getComputedStyle(iconOn).color,
      headClass: head && head.className,
      headBg: head && getComputedStyle(head).backgroundColor,
      headActions,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(600);
    const p2 = await fetch('/api/project').then((r) => r.json());
    const unlockedA = p2.project.elements.find((e) => e.id === 'el_a')?.locked !== true;
    out.values.lockUndo = { unlockedA, rev: [p1.project.rev, p2.project.rev] };
    out.checks.lockOn = lockedA;
    out.checks.lockTip = /锁定后 agent 不能改这个元素/.test(lockTip || '');
    out.checks.lockIconVisible = !!iconOn && iconOn.classList.contains('on')
      && out.values.lock.iconOpacity === '1'
      && out.values.lock.iconColor === 'rgb(255, 209, 102)';
    out.checks.inspectorLock = !!head && head.classList.contains('is-locked')
      && /255, 209, 102/.test(out.values.lock.headBg || '')
      && headActions[0] === '解锁';
    out.checks.lockUndo = unlockedA;

    /* (6) clicking a locked front element passes through to the one below */
    $('.tl-elhead[data-el="el_b"] .tl-lock').click();
    await sleep(500);
    const p3 = await fetch('/api/project').then((r) => r.json());
    const lockedB = p3.project.elements.find((e) => e.id === 'el_b')?.locked === true;
    app.setTime(3); /* both blocks are on screen at 3 s (el_b runs 2–7 s) */
    await sleep(300);
    const canvas = app.preview.canvas;
    const cr = canvas.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const stack = app.preview.hitTestAll(canvas.width / 2, canvas.height / 2, app.S.time);
    app.select({ elementId: null, objectId: null, camera: false });
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true, pointerId: 11, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons: 1, clientX: cx, clientY: cy,
    }));
    await sleep(80);
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0,
      clientX: cx, clientY: cy,
    }));
    await sleep(80);
    out.values.through = { lockedB, stack, selected: app.S.selection.elementId };
    out.checks.frontIsLocked = lockedB && stack[0] === 'el_b' && stack.includes('el_a');
    out.checks.clickThrough = app.S.selection.elementId === 'el_a';

    /* (7) the row marquee skips the locked row (3 rows in the box, 1 locked) */
    const rowC = $('.tl-elhead[data-el="el_c"]');
    const rowA2 = $('.tl-elhead[data-el="el_a"]');
    const gutC = rowC.querySelector('.tl-gutter').getBoundingClientRect();
    const gutA = rowA2.querySelector('.tl-gutter').getBoundingClientRect();
    const x = gutC.left + 40;
    const y0 = gutC.top + gutC.height / 2;
    const y1 = gutA.top + gutA.height - 2;
    rowC.querySelector('.tl-gutter').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true, pointerId: 21, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y0,
    }));
    await sleep(30);
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 21, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: x, clientY: y1,
    }));
    await sleep(30);
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 21, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0,
      clientX: x, clientY: y1,
    }));
    await sleep(120);
    const pool = app.S.selection.pool;
    const ids = pool?.ids || [];
    const toastTexts = [...document.querySelectorAll('.toast')].map((n) => n.textContent);
    out.values.marquee = { ids, kind: pool?.kind, toastTexts };
    out.checks.marqueeSkipsLocked = pool?.kind === 'element' && ids.length === 2
      && !ids.includes('el:el_b') && ids.includes('el:el_a') && ids.includes('el:el_c');
    out.checks.marqueeToast = toastTexts.some((t) => (t || '').includes('跳过 1'));

    /* (8) the marks survive a rebuild (a project event re-renders the rows) */
    tl.render(true);
    await sleep(60);
    out.checks.marksSurviveRender = !!$('.tl-elhead[data-el="el_a"] .tl-gutter > .tl-ai-bar')
      && !!$('.tl-ruler .tl-ai-ruler');

    /* (8b) an applied mark is painted faintly (40%) */
    tl.setMarks({
      rows: [], keys: [], ruler: [],
      accepted: { rows: [{ id: 'el_c', kind: 'element', bar: true, outline: true }], keys: [], ruler: [] },
    });
    await sleep(60);
    const ackBar = $('.tl-elhead[data-el="el_c"] .tl-gutter > .tl-ai-bar');
    const ackOutline = $('.tl-elhead[data-el="el_c"] .tl-track > .tl-ai-outline');
    out.values.accepted = {
      cls: ackBar && ackBar.className,
      opacity: ackBar && getComputedStyle(ackBar).opacity,
      outlineCls: ackOutline && ackOutline.className,
    };
    out.checks.acceptedFaint = !!ackBar && ackBar.classList.contains('is-ack')
      && out.values.accepted.opacity === '0.4'
      && !!ackOutline && ackOutline.classList.contains('is-ack');
    tl.setMarks(MARKS);
    await sleep(60);

    /* a readable final state for the screenshot: playhead on the ruler mark,
       the locked row visible, the marks painted */
    app.setTime(MARKS.ruler[0].frame / fps);
    await sleep(200);
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
  console.log(`[timeline-marks] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function main() {
  await build();
  const { project, records, marks } = await seed();

  // Node-side classification: the marks the renderer will paint.
  const row = marks.rows.find((entry) => entry.id === 'el_a' && entry.kind === 'element');
  const key = marks.keys.find((entry) => entry.id === 'el_a' && entry.path === 'pivot.x');
  check(!!row && row.bar && row.outline, 'marksFor: the property change marks the element row', JSON.stringify(row));
  check(!!key && key.t === 1.5, 'marksFor: the keyframe change marks the diamond', JSON.stringify(key));
  check(marks.ruler.length === 1 && marks.ruler[0].frame === RULER_FRAME,
    'marksFor: the start move marks the earlier frame', JSON.stringify(marks.ruler));
  check(marks.accepted.rows.length === 0 && marks.accepted.keys.length === 0,
    'marksFor: proposals are pending, not accepted', `records ${records.map((r) => r.status).join('/')}`);
  check(project.elements.find((e) => e.id === 'el_b').start === 2,
    'propose never writes the project', `el_b.start ${project.elements.find((e) => e.id === 'el_b').start}`);

  const script = probe(marks).replace(/\n\s*/g, ' ');
  // A dedicated port: the app attaches to an engine already listening on
  // VDM_PORT, and a leftover one would serve another project.
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${SHOT}`, '--at=1', '--delay=3200', '--hold=600',
    `--eval=${script}`,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error('[timeline-marks] the probe returned nothing');
    console.error((result.stderr || result.stdout).slice(-4000));
    process.exit(1);
  }
  const d = payload.dbg;
  const v = d.values || {};
  if (d.errors?.length) {
    console.error(`[timeline-marks] probe error: ${d.errors.join('\n')}`);
    process.exit(1);
  }
  const c = d.checks || {};
  console.log(`[timeline-marks] row ${JSON.stringify(v.row)}`);
  console.log(`[timeline-marks] key ${JSON.stringify(v.key)} · ruler ${JSON.stringify(v.ruler)}`);
  console.log(`[timeline-marks] click ${JSON.stringify(v.click)} · lock ${JSON.stringify(v.lock)}`);
  console.log(`[timeline-marks] through ${JSON.stringify(v.through)} · marquee ${JSON.stringify(v.marquee)}`);

  check(c.rowBar, 'the hit row carries the 2px .tl-ai-bar in the name column',
    `bar ${v.row?.bar?.width}px at ${v.row?.bar?.left} vs gutter ${v.row?.gutterLeft}`);
  check(c.clipOutline, 'the hit clip carries the .tl-ai-outline',
    `outline ${v.row?.outline?.width}px at ${v.row?.outline?.left} vs clip ${v.row?.clip?.width}px at ${v.row?.clip?.left}`);
  check(c.keyRing, 'the hit keyframe diamond carries .tl-key-ai without growing',
    `class "${v.key?.cls}" offsetWidth ${v.key?.offsetWidth} shadow "${v.key?.shadow}"`);
  check(c.rulerDiamond, 'the ruler diamond sits on the marked frame (±1px)',
    `f${v.ruler?.frame} at ${v.ruler?.left}px vs ${v.ruler?.expectedLeft}px (pps ${v.ruler?.pps})`);
  check(c.rulerTitle, 'the ruler diamond explains itself in the title', `title "${v.ruler?.title}"`);
  check(c.rulerBelowPlayhead, 'the ruler diamond stays below the playhead layer',
    `diamond z ${v.ruler?.z} < playhead ${v.ruler?.playheadZ}`);
  check(c.rulerClick, 'clicking the ruler diamond opens the review page', `switchRightTab(${JSON.stringify(v.click?.tabCalls)})`);
  check(c.rulerSeek, 'clicking the ruler diamond seeks to its frame',
    `time ${v.click?.time} → ${RULER_FRAME / FPS}`);
  check(c.rulerOnPlayheadFrame, 'the ruler diamond sits on the playhead line of its frame',
    `diamond ${v.align?.diamondCenter} vs playhead ${v.align?.playheadCenter}`);
  check(c.lockOn, 'the timeline lock icon writes locked:true', `tip "${v.lock?.tip}"`);
  check(c.lockTip, 'the lock tooltip explains the lock', `tip "${v.lock?.tip}"`);
  check(c.lockIconVisible, 'a locked row keeps the lock icon visible in --edit',
    `class "${v.lock?.iconClass}" opacity ${v.lock?.iconOpacity} color ${v.lock?.iconColor}`);
  check(c.inspectorLock, 'the inspector header is tinted and the lock comes before copy / delete',
    `class "${v.lock?.headClass}" bg ${v.lock?.headBg} actions ${JSON.stringify(v.lock?.headActions)}`);
  check(c.lockUndo, 'Ctrl+Z puts the lock back', `rev ${JSON.stringify(v.lockUndo?.rev)} unlocked ${v.lockUndo?.unlockedA}`);
  check(c.frontIsLocked, 'the front element is locked and still on top',
    `locked ${v.through?.lockedB} stack ${JSON.stringify(v.through?.stack)}`);
  check(c.clickThrough, 'a click on the locked front element selects the one below',
    `selected ${v.through?.selected}`);
  check(c.marqueeSkipsLocked, 'the row marquee skips the locked row',
    `ids ${JSON.stringify(v.marquee?.ids)}`);
  check(c.marqueeToast, 'the marquee reports how many locked rows it skipped',
    `toasts ${JSON.stringify(v.marquee?.toastTexts)}`);
  check(c.marksSurviveRender, 'the marks survive a full timeline rebuild', 'bar + ruler diamond still in the DOM');
  check(c.acceptedFaint, 'an applied mark is painted faintly (40%)',
    `class "${v.accepted?.cls}" opacity ${v.accepted?.opacity} outline "${v.accepted?.outlineCls}"`);
  check(c.alive, 'the editor is still alive', 'timeline mounted');

  // (8) the file on disk: el_a unlocked again, el_b still locked.
  const saved = JSON.parse(await fs.readFile(path.join(PROJECT, 'project.vdm.json'), 'utf8'));
  const elA = saved.elements.find((e) => e.id === 'el_a');
  const elB = saved.elements.find((e) => e.id === 'el_b');
  check(elA?.locked !== true, 'project.vdm.json: el_a is unlocked after Ctrl+Z', `locked ${elA?.locked}`);
  check(elB?.locked === true, 'project.vdm.json: el_b is still locked', `locked ${elB?.locked}`);

  // (8) an agent write on the locked element is refused.
  const service = projectService(PROJECT);
  const locked = new ChangeSetService(service);
  let lockedError = null;
  try {
    await locked.apply({
      actorId: 'agent:dsh', intent: 'try to edit a locked element',
      ops: [{ op: 'updateElement', id: 'el_b', patch: { style: { size: 200 } } }],
    });
  } catch (e) {
    lockedError = e;
  }
  check(lockedError?.code === 'LOCKED', 'an agent write on the locked element throws LOCKED',
    lockedError ? `${lockedError.code}: ${lockedError.message}` : 'no error — the write went through');

  // A human may still write it (the inspector path uses actorId 'ui').
  let uiError = null;
  try {
    await locked.apply({
      actorId: 'ui', intent: 'human unlocks it',
      ops: [{ op: 'updateElement', id: 'el_b', patch: { locked: false } }],
    });
  } catch (e) {
    uiError = e;
  }
  check(!uiError, 'a human (actorId ui) can still unlock it', uiError ? String(uiError.message) : 'ok');

  if (!process.argv.includes('--keep')) console.log(`[timeline-marks] project + screenshot kept in ${path.relative(REPO, WORK)}`);
  const failed = checks.filter((x) => !x.ok);
  if (failed.length) {
    console.log(`[timeline-marks] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[timeline-marks] PASS (${checks.length}/${checks.length}) · shot ${path.relative(REPO, SHOT)}`);
}

main().catch((e) => { console.error('[timeline-marks]', e.stack || e.message); process.exit(1); });
