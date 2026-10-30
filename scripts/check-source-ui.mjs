// Source marks and overlay / takeover switches (WP4.6a) — offscreen Electron probe.
//
// Builds a throwaway project with one source element (`el.source` bound to a
// `title-card` node) and one plain element, boots the real app, and checks the
// §3.1 / §7.2 R1 surface end to end:
//
//   (a) the inspector header badge `源 · title-card` (ids + undo-only tip), the
//       12×12 `i-source` mark on the timeline row (after the lock, before the
//       name, no row-height change) and on the outliner row;
//   (b) without a snapshot there are no switches at all — a source element
//       whose `sourceMode` names nothing shows nothing;
//   (c) after `setSourceSnapshots()` only the rows whose paths the source
//       really drives grow a switch, and the hover text of a ratio path says
//       that 叠加 means 相乘;
//   (d) one 接管 click writes the *flat* `sourceMode` table with a single `set`
//       op (rev + 1) and one `POST /api/undo` puts it back;
//   (e) 全部接管 from the inspector ⋯ menu and from a property row's
//       right-click menu is one transaction each (rev + 1, one undo);
//   (f) 全部叠加 writes the per-path defaults (`mul` for opacity, `add` for
//       text), and its undo returns to the takeover table it replaced;
//   (g) an element without a source grows none of these controls;
//   (h) no colour literal outside tokens.css (DESIGN.md §3 grep).
//
//   node scripts/check-source-ui.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_SNAPSHOT_VERSION } from '../core/version.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { saveProject } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-source-ui');
const PROJECT = path.join(WORK, 'project');
const PORT = '47321';
const ELEMENT = 'el_title';
const PLAIN = 'el_plain';
const HASH = `sha256:${'d'.repeat(64)}`;
// Paths the snapshot node carries — the only ones that may grow a switch.
const DRIVEN = ['style.text', 'style.size', 'transform.x', 'transform.y', 'transform.opacity'];

/** The compiled snapshot the app would get from `/api/sources` (WP4.6b). */
const SNAPSHOT = {
  version: SOURCE_SNAPSHOT_VERSION,
  source: 'title-card',
  compiler: { name: 'source-service', version: 1, runtime: 'html', entry: 'index.html' },
  builtAt: '2026-10-30T09:41:12.345Z',
  hash: HASH,
  nodes: [{
    id: 'h1',
    type: 'text',
    parent: null,
    props: {
      'style.text': '标题卡', 'style.size': 120, 'transform.x': 100, 'transform.y': 20, 'transform.opacity': 0.5,
    },
    tracks: [
      { t: 0, path: 'style.size', value: 120 },
      { t: 1, path: 'style.size', value: 180 },
    ],
  }],
};

/** The throwaway project: one source element, one plain element. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const p = createProject({ title: 'source ui probe', duration: 4, width: 960, height: 540 });
  p.elements.push({
    id: ELEMENT, name: '标题卡', type: 'text', start: 0, duration: 4, z: 2,
    source: { id: 'title-card', node: 'h1' },
    style: { text: '标题卡', size: 120, color: '#e3e8f0' },
    visible: true,
  });
  p.elements.push({
    id: PLAIN, name: '普通文字', type: 'text', start: 0, duration: 4, z: 1,
    style: { text: '普通文字', size: 64, color: '#a3adbd' },
    visible: true,
  });
  await saveProject(PROJECT, normalizeProject(p), { by: 'check-source-ui' });
}

// Runs inside the editor: everything is read off the real DOM and the real
// project, the result lands in window.__dbg and comes back through `[capture]`.
// No template literals and no `//` comments inside: the script is collapsed to
// one line and passed through --eval.
const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 12000) => {
    for (let i = 0; i < ms / 50; i++) { try { if (fn()) return true; } catch (e) { } await sleep(50); }
    return false;
  };
  for (let i = 0; i < 400; i++) { if (window.__vdm) break; await sleep(50); }
  const app = window.__vdm;
  const out = { errors: [] };
  const q = (s, root) => (root || document).querySelector(s);
  const qa = (s, root) => Array.prototype.slice.call((root || document).querySelectorAll(s));
  const text = (node) => (node ? node.textContent : '');
  const el = () => app.S.project.elements.find((e) => e.id === '${ELEMENT}');
  const sm = () => el().sourceMode || {};
  const modeString = () => (el().sourceMode === undefined ? 'none' : JSON.stringify(el().sourceMode));
  const rowOf = (label) => qa('#panelInsp .prop').find((row) => text(q('label', row)).indexOf(label) >= 0);
  const sw = (label, mode) => {
    const row = rowOf(label);
    return row ? q('.src-mode-btn[data-mode="' + mode + '"]', row) : null;
  };
  const menuItems = () => qa('#ctxMenu [role="menuitem"]').map((b) => text(b));
  const menuOpen = () => { const m = q('#ctxMenu'); return !!m && m.hidden === false; };
  const clickMenu = (needle) => {
    const b = qa('#ctxMenu [role="menuitem"]').find((n) => text(n).indexOf(needle) >= 0);
    if (b) b.click();
    return !!b;
  };
  const undo = async () => (await fetch('/api/undo', { method: 'POST' })).ok;
  const contextMenuOn = (node) => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  const driven = ${JSON.stringify(DRIVEN)};
  try {
    await waitFor(() => app.S.project && app.S.project.elements.length >= 2);
    app.setTime(0);
    app.select({ elementId: '${ELEMENT}' });
    await waitFor(() => q('#panelInsp .insp-head'));

    /* ---- (a) marks: header badge, timeline row, outliner row ---- */
    const badge = q('#panelInsp .insp-head .insp-src');
    out.badgeText = text(badge).trim();
    out.badgeTip = badge ? String(badge.dataset.tip || '') : '';
    out.badgeAfterName = !!badge && !!badge.previousElementSibling
      && badge.previousElementSibling.classList.contains('insp-name');
    const tlRow = q('#timeline .tl-elhead[data-el="${ELEMENT}"]');
    const tlMark = tlRow ? q('.tl-src', tlRow) : null;
    const plainTlRow = q('#timeline .tl-elhead[data-el="${PLAIN}"]');
    out.tlMark = !!tlMark;
    out.tlMarkTip = tlMark ? String(tlMark.dataset.tip || '') : '';
    out.tlMarkAfterLock = !!tlMark && !!tlMark.previousElementSibling
      && tlMark.previousElementSibling.classList.contains('tl-lock');
    out.rowHeights = [tlRow ? tlRow.getBoundingClientRect().height : 0,
      plainTlRow ? plainTlRow.getBoundingClientRect().height : 0];
    const olRow = q('#panelLayers .ol-row[data-ref="el:${ELEMENT}"]');
    out.olMark = !!(olRow && q('.ol-src', olRow));

    /* ---- (b) a binding alone paints no switch ---- */
    out.switchesBefore = qa('#panelInsp .src-mode').length;
    out.modeBefore = modeString();

    /* ---- (c) after the snapshot: only driven rows, ratio tip says 相乘 ---- */
    app.setSourceSnapshots({ 'title-card': ${JSON.stringify(SNAPSHOT)} });
    await sleep(250);
    const rows = qa('#panelInsp .prop[data-source-path]');
    out.switchRows = rows.map((r) => r.dataset.sourcePath + '=' + (q('.src-mode', r) ? 'on' : 'off'));
    out.switchesAfter = qa('#panelInsp .src-mode').length;
    out.switchOnlyDriven = rows.filter((r) => q('.src-mode', r)).every((r) => r.dataset.sourcePath.split(/\\s+/)
      .every((p) => driven.indexOf(p) >= 0));
    out.labelsWithSwitch = qa('#panelInsp .prop.has-src').map((r) => text(q('label', r)).trim());
    out.hasPosSwitch = !!sw('位置', 'overlay');
    out.hasOpacitySwitch = !!sw('不透明度', 'overlay');
    out.hasTextSwitch = !!sw('内容', 'overlay');
    out.hasSizeSwitch = !!sw('字号', 'overlay');
    out.scaleHasNoSwitch = !sw('缩放', 'overlay');
    out.ratioTip = sw('不透明度', 'overlay') ? String(sw('不透明度', 'overlay').dataset.tip || '') : '';
    out.textTip = sw('内容', 'overlay') ? String(sw('内容', 'overlay').dataset.tip || '') : '';
    out.takeoverTip = sw('不透明度', 'takeover') ? String(sw('不透明度', 'takeover').dataset.tip || '') : '';
    out.overlayPressed = sw('不透明度', 'overlay') ? sw('不透明度', 'overlay').getAttribute('aria-pressed') : null;

    /* ---- (c2) a first edit of a driven property stays in overlay ---- */
    const sizeRow = rowOf('字号');
    const sizeInput = sizeRow ? q('input', sizeRow) : null;
    if (sizeInput) {
      sizeInput.value = '150';
      sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(600);
    }
    out.editedSize = el().style.size === 150;
    out.editKeepsOverlay = el().sourceMode === undefined;
    const sizeOverlay = sw('字号', 'overlay');
    out.editOverlayPressed = !!sizeOverlay && sizeOverlay.getAttribute('aria-pressed') === 'true';
    out.editUndo = await undo();
    out.sizeRestored = await waitFor(() => el().style.size !== 150);

    /* ---- (d) one 接管 click = one flat-table write, one undo ---- */
    const rev0 = app.S.project.rev;
    sw('不透明度', 'takeover').click();
    out.tookOver = await waitFor(() => sm()['transform.opacity'] === 'override');
    out.flatTable = !!el().sourceMode && el().sourceMode.transform === undefined;
    out.takeoverRev = app.S.project.rev === rev0 + 1;
    out.takeoverTable = modeString();
    out.takeoverPressed = await waitFor(() => {
      const b = sw('不透明度', 'takeover');
      return !!b && b.getAttribute('aria-pressed') === 'true';
    });
    out.undo1 = await undo();
    out.undoRestored = await waitFor(() => el().sourceMode === undefined || sm()['transform.opacity'] !== 'override');
    out.overlayBack = await waitFor(() => {
      const b = sw('不透明度', 'overlay');
      return !!b && b.getAttribute('aria-pressed') === 'true';
    });

    /* ---- (e) ⋯ menu: 全部叠加 / 全部接管, one transaction ---- */
    const more = q('#panelInsp .insp-actions button[aria-label="源码操作"]');
    out.hasMore = !!more;
    if (more) more.click();
    await sleep(200);
    out.menuItems = menuItems();
    const rev1 = app.S.project.rev;
    out.menuClickedAll = clickMenu('全部接管');
    out.allTakeover = await waitFor(() => driven.every((p) => sm()[p] === 'override'));
    out.allOneTransaction = app.S.project.rev === rev1 + 1;
    out.allTable = modeString();
    out.undo2 = await undo();
    out.allUndone = await waitFor(() => el().sourceMode === undefined || Object.keys(el().sourceMode).length === 0);

    /* ---- (f) the row right-click is the second entry ---- */
    contextMenuOn(rowOf('不透明度'));
    await sleep(200);
    out.rowMenuItems = menuItems();
    const rev2 = app.S.project.rev;
    out.rowClickedAll = clickMenu('全部接管');
    out.rowTakeover = await waitFor(() => sm()['transform.x'] === 'override' && sm()['transform.opacity'] === 'override');
    out.rowOneTransaction = app.S.project.rev === rev2 + 1;
    contextMenuOn(rowOf('不透明度'));
    await sleep(200);
    out.rowOverlayClicked = clickMenu('全部叠加');
    out.overlayDefaults = await waitFor(() => sm()['transform.opacity'] === 'mul' && sm()['style.text'] === 'add');
    out.overlayTable = modeString();
    out.undo3 = await undo();
    out.overlayUndoBack = await waitFor(() => sm()['style.text'] === 'override');
    out.undo4 = await undo();
    out.overlayUndone = await waitFor(() => el().sourceMode === undefined || Object.keys(el().sourceMode).length === 0);

    /* ---- (g) an element without a source grows no new control ---- */
    app.select({ elementId: '${PLAIN}' });
    await sleep(250);
    out.plainBadge = !q('#panelInsp .insp-src');
    out.plainSwitches = qa('#panelInsp .src-mode').length === 0;
    out.plainMore = !q('#panelInsp .insp-actions button[aria-label="源码操作"]');
    out.plainTl = !q('#timeline .tl-elhead[data-el="${PLAIN}"] .tl-src');
    out.plainOl = !q('#panelLayers .ol-row[data-ref="el:${PLAIN}"] .ol-src');
    const plainRow = q('#panelInsp .prop');
    if (plainRow) contextMenuOn(plainRow);
    await sleep(200);
    out.plainMenuOpen = menuOpen();

    /* ---- leave the source element on screen for the screenshot ---- */
    out.finalMode = modeString();
    app.select({ elementId: '${ELEMENT}' });
    app.setTime(1);
    await sleep(250);
    out.shotSwitches = qa('#panelInsp .src-mode').length;
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
})()`;

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
      else if (ch === '\\\\') escaped = true;
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
  console.log(`[source-ui] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function boot(script, capture) {
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${capture}`, '--delay=3200', '--hold=700',
    `--eval=${script.replace(/\n\s*/g, ' ')}`,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error('[source-ui] the probe returned nothing');
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  if (payload.dbg.errors?.length) {
    console.error(`[source-ui] probe error: ${payload.dbg.errors.join('\n')}`);
    process.exit(1);
  }
  return payload.dbg;
}

/** DESIGN.md §3: no colour literal outside tokens.css. */
async function colourLiterals() {
  const dir = path.join(REPO, 'app', 'renderer', 'css');
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.css') && n !== 'tokens.css').sort();
  const bad = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) bad.push(`${name}:${i + 1} ${line.trim()}`);
    });
  }
  return { names, bad };
}

async function main() {
  await build();
  const shot = path.join(WORK, 'shot.png');
  const d = await boot(probe, shot);

  check(d.badgeText === '源 · title-card', 'the header badge says 源 · <label>', `"${d.badgeText}"`);
  check(d.badgeAfterName && /title-card/.test(d.badgeTip) && /h1/.test(d.badgeTip) && /撤销/.test(d.badgeTip),
    'the badge follows the name and its tip names the ids + undo only',
    `afterName=${d.badgeAfterName} tip="${d.badgeTip}"`);
  check(d.tlMark && d.tlMarkAfterLock && /撤销/.test(d.tlMarkTip),
    'the timeline row shows the 12×12 source mark after the lock', `mark=${d.tlMark} afterLock=${d.tlMarkAfterLock}`);
  check(d.rowHeights[0] === d.rowHeights[1] && d.rowHeights[0] > 0,
    'the mark does not change the row height', `heights ${d.rowHeights.join(' / ')}`);
  check(d.olMark, 'the outliner row shows the same mark', `mark=${d.olMark}`);

  check(d.switchesBefore === 0 && d.modeBefore === 'none',
    'a binding without a snapshot paints no switch (§7.2 R1)', `switches=${d.switchesBefore} sourceMode=${d.modeBefore}`);
  check(d.switchesAfter >= 3 && d.switchOnlyDriven && d.hasPosSwitch && d.hasOpacitySwitch
    && d.hasTextSwitch && d.hasSizeSwitch,
    'only the rows the source really drives grow a switch',
    `${d.switchesAfter} switch(es) · ${d.labelsWithSwitch.join(' / ')} · rows ${d.switchRows.join(', ')}`);
  check(d.scaleHasNoSwitch, 'a row the source does not drive keeps its old look (缩放)', `缩放 switch=${!d.scaleHasNoSwitch}`);
  check(/相乘/.test(d.ratioTip) && /本地值/.test(d.textTip) && /覆盖/.test(d.takeoverTip),
    'the hover spells out the effect, 叠加=相乘 for a ratio path',
    `ratio="${d.ratioTip.split('\n')[0]}"`);
  check(d.overlayPressed === 'true', 'the default state is 叠加 (lit)', `aria-pressed=${d.overlayPressed}`);
  check(d.editedSize && d.editKeepsOverlay && d.editOverlayPressed && d.editUndo && d.sizeRestored,
    'the first edit of a driven property lands in 叠加 and writes no override (§7.2 R1)',
    `edited=${d.editedSize} sourceMode=${d.editKeepsOverlay} 叠加 lit=${d.editOverlayPressed}`);

  check(d.tookOver && d.flatTable && d.takeoverRev,
    '接管 writes the flat sourceMode table with one `set` op (rev + 1)',
    `table=${d.takeoverTable} flat=${d.flatTable} rev+1=${d.takeoverRev}`);
  check(d.takeoverPressed, 'the switch repaints into 接管', `pressed=${d.takeoverPressed}`);
  check(d.undo1 && d.undoRestored && d.overlayBack,
    'one undo puts the property back to 叠加', `undo=${d.undo1} restored=${d.undoRestored} overlay=${d.overlayBack}`);

  // WP4.6b appended 脱离源码 / 脱离整个源 (§7.4 R1): the first two entries and
  // their order are what this probe pins.
  check(d.hasMore && Array.isArray(d.menuItems) && d.menuItems.length >= 2
    && d.menuItems[0].includes('全部叠加') && d.menuItems[1].includes('全部接管')
    && d.menuItems[2] === '脱离源码' && d.menuItems[3] === '脱离整个源',
    'the inspector ⋯ menu offers 全部叠加 / 全部接管, then 脱离源码 / 脱离整个源',
    `${JSON.stringify(d.menuItems)}`);
  check(d.menuClickedAll && d.allTakeover && d.allOneTransaction,
    '全部接管 takes over every driven path in one transaction',
    `all=${d.allTakeover} rev+1=${d.allOneTransaction} table=${d.allTable}`);
  check(d.undo2 && d.allUndone, 'one undo reverts the whole 全部接管', `undo=${d.undo2} cleared=${d.allUndone}`);

  check(Array.isArray(d.rowMenuItems) && d.rowMenuItems.length === 4
    && d.rowMenuItems[0].includes('这个属性') && d.rowMenuItems[1].includes('这个属性')
    && d.rowMenuItems[2].includes('全部叠加') && d.rowMenuItems[3].includes('全部接管'),
    'a property row right-click is the second entry (row + element)', `${JSON.stringify(d.rowMenuItems)}`);
  check(d.rowClickedAll && d.rowTakeover && d.rowOneTransaction,
    '全部接管 from the row menu is one transaction too', `taken=${d.rowTakeover} rev+1=${d.rowOneTransaction}`);
  check(d.rowOverlayClicked && d.overlayDefaults,
    '全部叠加 writes the per-path default (mul for a ratio, add for text)', `table=${d.overlayTable}`);
  check(d.undo3 && d.overlayUndoBack && d.undo4 && d.overlayUndone,
    'each step of the undo chain restores the previous table', `takeover back=${d.overlayUndoBack} cleared=${d.overlayUndone}`);

  check(d.plainBadge && d.plainSwitches && d.plainMore,
    'an element without a source gets no badge, switch or ⋯ button',
    `badge=${d.plainBadge} switches=${d.plainSwitches} more=${d.plainMore}`);
  check(d.plainTl && d.plainOl, 'nor a source mark on its timeline / outliner row', `timeline=${d.plainTl} outliner=${d.plainOl}`);
  check(!d.plainMenuOpen, 'nor a source context menu on its property rows', `menu open=${d.plainMenuOpen}`);
  check(d.finalMode === 'none', 'the probe left no sourceMode behind', `sourceMode=${d.finalMode}`);
  check(d.shotSwitches >= 3, 'the screenshot run ends with the switches on screen', `${d.shotSwitches} switch(es)`);

  const { names, bad } = await colourLiterals();
  check(bad.length === 0, 'no colour literal outside tokens.css (DESIGN.md §3)',
    bad.length ? bad.slice(0, 3).join(' | ') : `${names.length} file(s) clean`);

  const shots = await fs.readdir(WORK).catch(() => []);
  check(shots.includes('shot.png'), 'the screenshot was written', shots.filter((n) => n.endsWith('.png')).join(', '));

  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length) {
    console.log(`[source-ui] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[source-ui] PASS (${checks.length}/${checks.length})`);
}

main().catch((e) => { console.error('[source-ui]', e.stack || e.message); process.exit(1); });
