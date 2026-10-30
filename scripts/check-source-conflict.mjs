// Source-merge conflicts in the 审阅 page + 脱离源码 (WP4.6b) — offscreen
// Electron probe, docs/DESIGN-WP3.6-4.6-UI.md §7.3 / §7.4 R1.
//
// Builds a throwaway project from the shared `html-title-card` fixture through
// the real services (`sourceAdd` → compile → apply → two editor edits → one
// `mergeSource` with two conflicting paths), so the 审阅 page gets a real
// `needs-decision` change set, then boots the app and checks:
//
//   (a) the merge's two conflicts show up in the change set (not a modal), one
//       row each with base / ours / theirs, the kind, and the update's intent;
//   (b) the default is 保留我的, 全部用源的 / 全部保留我的 flip every row, and
//       应用 writes the chosen sides as ONE transaction — the record leaves
//       needs-decision and one Ctrl+Z is back to the provisional (theirs) state;
//   (c) 脱离源码 from the timeline's right-click: `el.source` goes, the values
//       stay (the current frame is frozen), the toast says so and its [撤销]
//       restores the binding;
//   (d) a multi-selection detaches both elements in one transaction;
//   (e) 脱离整个源 from the inspector's ⋯ menu detaches every element of that
//       source, still one transaction;
//   (f) an element without a source grows no entry at all;
//   (g) no colour literal outside tokens.css (DESIGN.md §3 grep).
//
//   node scripts/check-source-conflict.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectService } from '../engine/projects.js';
import { ChangeSetService } from '../application/changeset-service.js';
import {
  applyCompiled, clearFontCache, compileSource, mergeSource, readBase,
} from '../application/source-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-source-conflict');
const PROJECT = path.join(WORK, 'project');
const PORT = '47331';
const SOURCE = 'html-title-card';
const PLAIN = 'el_plain';
const EDITOR_TEXT = '编辑器写的标题';
const SOURCE_TEXT = '源里改过的标题';
const EDITOR_COLOR = '#123456';
const SOURCE_COLOR = '#ffd400';
// The screenshot's second merge needs a value the base does not already carry.
const SECOND_TEXT = '源里又改了一次';
const SECOND_COLOR = '#00ff88';

const clone = (value) => JSON.parse(JSON.stringify(value));

/** `{ manifest, files }` of the shared fixture, as the registry stores it. */
async function fixture() {
  const dir = path.join(REPO, 'tests', 'fixtures', 'sources', SOURCE);
  const names = await fs.readdir(dir);
  const files = {};
  let manifest = null;
  for (const name of names) {
    const body = await fs.readFile(path.join(dir, name), 'utf8');
    if (name === 'manifest.json') manifest = JSON.parse(body);
    else files[name] = body;
  }
  return { manifest, files };
}

/**
 * The throwaway project: the fixture compiled + applied, one plain element, and
 * a real `needs-decision` merge with two `both-changed` conflicts.
 */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const service = projectService(PROJECT);
  await service.transact({
    command: { type: 'initialize', options: { title: 'source conflict probe', duration: 4, width: 960, height: 540 } },
  });
  await service.transact({
    ops: [{
      op: 'addElement',
      element: {
        id: PLAIN, name: '普通文字', type: 'text', start: 0, duration: 4, z: 1,
        style: { text: '普通文字', size: 64, color: '#a3adbd' },
      },
    }],
  });
  const { manifest, files } = await fixture();
  await service.transact({ ops: [{ op: 'sourceAdd', id: SOURCE, manifest, files }] });
  let project = await service.read();
  await compileSource({ project, sourceId: SOURCE, root: PROJECT });
  const applied = await applyCompiled({ project, sourceId: SOURCE, root: PROJECT });
  await service.transact({ ops: [applied.op] });

  project = await service.read();
  const byNode = (nodeId) => project.elements.find((el) => el.source?.id === SOURCE && el.source.node === nodeId);
  const kicker = byNode('n_kicker');
  const title = byNode('n_title');
  if (!kicker || !title) throw new Error('the fixture did not bind n_kicker / n_title');
  // The editor layer moves two paths the source moves too → two conflicts.
  await service.transact({
    ops: [
      { op: 'set', id: kicker.id, path: 'style.text', value: EDITOR_TEXT },
      { op: 'set', id: title.id, path: 'style.color', value: EDITOR_COLOR },
    ],
  });
  const base = await readBase({ root: PROJECT, sourceId: SOURCE });
  const theirs = clone(base.snapshot);
  theirs.nodes.find((node) => node.id === 'n_kicker').props['style.text'] = SOURCE_TEXT;
  theirs.nodes.find((node) => node.id === 'n_title').props['style.color'] = SOURCE_COLOR;
  const changesets = new ChangeSetService(service);
  const merged = await mergeSource({
    project: await service.read(), sourceId: SOURCE, root: PROJECT, theirs, changesets, actorId: 'probe',
  });
  if (merged.conflicts.length !== 2) {
    throw new Error(`expected 2 conflicts, got ${merged.conflicts.length}: ${JSON.stringify(merged.conflicts)}`);
  }
  clearFontCache();
  return { changesetId: merged.changesetId, kicker: kicker.id, title: title.id, conflicts: merged.conflicts };
}

// Runs inside the editor: everything is read off the real DOM and the real
// project, the result lands in window.__dbg and comes back through `[capture]`.
// No template literals and no `//` comments inside: the script is collapsed to
// one line and passed through --eval.
const probeFor = (built) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => {
    for (let i = 0; i < ms / 50; i++) { try { if (fn()) return true; } catch (e) { } await sleep(50); }
    return false;
  };
  for (let i = 0; i < 400; i++) { if (window.__vdm) break; await sleep(50); }
  const app = window.__vdm;
  const out = { errors: [] };
  const q = (s, root) => (root || document).querySelector(s);
  const qa = (s, root) => Array.prototype.slice.call((root || document).querySelectorAll(s));
  const text = (node) => (node ? node.textContent : '');
  const flat = (node) => text(node).replace(/\\s+/g, ' ').trim();
  const el = (id) => app.S.project.elements.find((e) => e.id === id);
  const menuItems = () => qa('#ctxMenu [role="menuitem"]').map((b) => text(b).trim());
  const clickMenu = (needle) => {
    const b = qa('#ctxMenu [role="menuitem"]').find((n) => text(n).indexOf(needle) >= 0);
    if (b) b.click();
    return !!b;
  };
  const undo = async () => (await fetch('/api/undo', { method: 'POST' })).ok;
  const contextMenuOn = (node) => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  const clipOf = (id) => q('#timeline .blk.el[data-id="' + id + '"]');
  /* The world matrix the frame IR would draw for one element (§7.8.2: a node
     element folds the source delta into pixelMatrixOf). The preview itself
     never receives snapshots, so the IR is asked directly — that is the picture
     Blender and the IR agree on. */
  const irWorld = async (snapshots, id) => {
    const mod = await import('/core/frame-ir.js');
    const fps = Number(app.S.project.meta?.fps) || 24;
    const frame = Math.round((Number(app.S.time) || 0) * fps);
    const ir = mod.buildFrameIR(app.S.project, frame, { fps, camera: 'live', sourceSnapshots: snapshots, cache: null });
    const item = (ir.items || []).find((it) => it.id === id);
    return item ? JSON.stringify(item.world) : null;
  };
  const bound = () => app.S.project.elements.filter((e) => e.source && e.source.id === '${SOURCE}');
  const KICKER = '${built.kicker}';
  const TITLE = '${built.title}';
  const CS = '${built.changesetId}';
  try {
    await waitFor(() => app.S.project && app.review && app.review.records.length >= 1);
    /* the compiled snapshot the app gets from GET /api/sources (the seam
       WP4.6a left): without it the preview draws the editor layer only */
    const baseResp0 = await (await fetch('/api/sources/${SOURCE}/base')).json();
    if (baseResp0 && baseResp0.snapshot) app.setSourceSnapshots({ '${SOURCE}': baseResp0.snapshot });
    app.setTime(0);
    app.switchRightTab('review');
    await app.review.focus(CS);
    out.rows = (await waitFor(() => qa('#panelReview .rv-cf').length === 2)) ? qa('#panelReview .rv-cf').length : 0;
    const rows = qa('#panelReview .rv-cf');
    out.rowTexts = rows.map(flat);
    out.row0 = out.rowTexts[0] || '';
    out.sides = rows.map((row) => qa('.rv-cf-side', row).length);
    out.kinds = rows.map((row) => flat(q('.rv-cf-kind', row)));
    out.hasIntent = out.rowTexts.every((line) => line.indexOf('这次源更新') >= 0 && line.indexOf('合并源') >= 0);
    out.defaultOurs = rows.length === 2 && rows.every((row) => q('input[value="ours"]', row).checked);
    out.footButtons = qa('#panelReview .rv-foot-row button').map((b) => text(b).trim());
    out.noModal = !q('#reviewCompare') && !q('.modal .rv-cf');

    /* ---- 全部用源的 / 全部保留我的 flip every row ---- */
    q('#panelReview [data-action="cf-all-theirs"]').click();
    await sleep(150);
    out.allTheirs = qa('#panelReview .rv-cf').every((row) => q('input[value="theirs"]', row).checked);
    q('#panelReview [data-action="cf-all-ours"]').click();
    await sleep(150);
    out.allOurs = qa('#panelReview .rv-cf').every((row) => q('input[value="ours"]', row).checked);

    /* ---- row 0 保留我的, row 1 用源的, then 应用 = one transaction ---- */
    const fresh = () => qa('#panelReview .rv-cf');
    fresh()[1].querySelector('input[value="theirs"]').click();
    await sleep(120);
    out.row0KeepsMine = fresh()[0].querySelector('input[value="ours"]').checked;
    out.row1UsesSource = fresh()[1].querySelector('input[value="theirs"]').checked;
    out.kickerBefore = el(KICKER).style.text;
    out.titleBefore = el(TITLE).style.color;
    const rev0 = app.S.project.rev;
    q('#panelReview [data-action="cf-apply"]').click();
    out.applied = await waitFor(() => app.S.project.rev === rev0 + 1 && el(KICKER).style.text === '${EDITOR_TEXT}', 10000);
    out.revApply = app.S.project.rev;
    out.kickerAfter = el(KICKER).style.text;
    out.titleAfter = el(TITLE).style.color;
    out.recordApplied = await waitFor(() => {
      const record = app.review.records.find((r) => r.id === CS);
      return !!record && record.status === 'applied';
    }, 8000);
    out.decisionToast = qa('#toasts .toast').map(flat).join(' | ');

    /* ---- one Ctrl+Z = back to the provisional (theirs) merge state ---- */
    out.undoDecision = await undo();
    out.backToTheirs = await waitFor(() => el(KICKER).style.text === '${SOURCE_TEXT}', 8000);
    out.titleBack = el(TITLE).style.color;

    /* ---- 脱离源码: timeline right-click, values stay, toast undo ---- */
    app.switchRightTab('insp');
    app.select({ elementId: KICKER });
    await waitFor(() => q('#panelInsp .insp-head'));
    /* half a second in, where the source's own y track moves the element: the
       picture is what 脱离 must keep, not just the JSON fields */
    app.setTime(0.5);
    await sleep(150);
    const snaps = { '${SOURCE}': baseResp0.snapshot };
    out.worldBefore = await irWorld(snaps, KICKER);
    out.localYBefore = el(KICKER).transform.y;
    out.nodeBefore = JSON.stringify(el(KICKER).node);
    contextMenuOn(clipOf(KICKER));
    await sleep(200);
    out.clipMenu = menuItems();
    out.hasDetach = out.clipMenu.indexOf('脱离源码') >= 0;
    const revDetach = app.S.project.rev;
    clickMenu('脱离源码');
    out.detached = await waitFor(() => !el(KICKER).source, 8000);
    out.detachOneTransaction = app.S.project.rev === revDetach + 1;
    out.frozenY = el(KICKER).transform.y;
    out.nodeAfter = JSON.stringify(el(KICKER).node);
    out.worldAfter = await irWorld(snaps, KICKER);
    out.pictureKept = !!out.worldBefore && out.worldBefore === out.worldAfter;
    out.sourceModeGone = el(KICKER).sourceMode === undefined;
    out.detachToast = qa('#toasts .toast').map(flat).join(' | ');
    const undoBtn = qa('#toasts .toast .toast-act').pop();
    out.toastUndoLabel = undoBtn ? text(undoBtn).trim() : '';
    if (undoBtn) undoBtn.click();
    out.restored = await waitFor(() => !!el(KICKER).source, 8000);

    /* ---- multi-selection: two elements, one transaction ---- */
    app.select({
      elementId: TITLE,
      pool: { kind: 'element', ids: ['el:' + KICKER, 'el:' + TITLE], primary: 'el:' + TITLE },
    });
    await sleep(200);
    const revMulti = app.S.project.rev;
    contextMenuOn(clipOf(TITLE));
    await sleep(200);
    out.multiMenu = menuItems();
    clickMenu('脱离源码');
    out.multiDetached = await waitFor(() => !el(KICKER).source && !el(TITLE).source, 8000);
    out.multiOneTransaction = app.S.project.rev === revMulti + 1;
    await undo();
    await waitFor(() => !!el(KICKER).source && !!el(TITLE).source, 8000);

    /* ---- 脱离整个源: the inspector ⋯ menu ---- */
    app.select({ elementId: KICKER });
    await sleep(250);
    const more = q('#panelInsp .insp-actions button[aria-label="源码操作"]');
    out.hasMore = !!more;
    if (more) more.click();
    await sleep(200);
    out.moreMenu = menuItems();
    out.moreHasWhole = out.moreMenu.indexOf('脱离整个源') >= 0;
    out.wholeCount = bound().length;
    const revWhole = app.S.project.rev;
    clickMenu('脱离整个源');
    out.wholeDetached = await waitFor(() => bound().length === 0, 10000);
    out.wholeOneTransaction = app.S.project.rev === revWhole + 1;

    /* ---- an element without a source has no entry ---- */
    app.select({ elementId: '${PLAIN}' });
    await sleep(250);
    out.plainMore = !q('#panelInsp .insp-actions button[aria-label="源码操作"]');
    contextMenuOn(clipOf('${PLAIN}'));
    await sleep(200);
    out.plainMenu = menuItems();
    out.plainNoDetach = out.plainMenu.indexOf('脱离源码') < 0;
    out.plainNoMark = !q('#panelLayers .ol-row[data-ref="el:${PLAIN}"] .ol-src');

    /* ---- screenshot: a fresh needs-decision merge, action bar on screen ---- */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await undo();
    await waitFor(() => bound().length > 0, 8000);
    app.switchRightTab('insp');
    await app.op({ op: 'set', id: KICKER, path: 'style.text', value: '${EDITOR_TEXT}' });
    await app.op({ op: 'set', id: TITLE, path: 'style.color', value: '${EDITOR_COLOR}' });
    const baseResp = await (await fetch('/api/sources/${SOURCE}/base')).json();
    const next = JSON.parse(JSON.stringify(baseResp.snapshot));
    next.nodes.find((n) => n.id === 'n_kicker').props['style.text'] = '${SECOND_TEXT}';
    next.nodes.find((n) => n.id === 'n_title').props['style.color'] = '${SECOND_COLOR}';
    const mergeResp = await (await fetch('/api/sources/${SOURCE}/merge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theirs: next, actorId: 'probe' }),
    })).json();
    out.shotMerge = { ok: mergeResp.ok, error: mergeResp.error, conflicts: (mergeResp.conflicts || []).length };
    app.switchRightTab('review');
    await app.review.refresh();
    await app.review.focus(mergeResp.changesetId);
    app.setTime(0.5);
    await sleep(400);
    out.shotRows = qa('#panelReview .rv-cf').length;
    out.shotFoot = qa('#panelReview .rv-foot-row button').map((b) => text(b).trim());
    out.shotNeedsDecision = (app.review.records.find((r) => r.id === mergeResp.changesetId) || {}).status === 'needs-decision';
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
  console.log(`[source-conflict] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function boot(script, capture) {
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${capture}`, '--delay=3200', '--hold=900',
    `--eval=${script.replace(/\n\s*/g, ' ')}`,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error('[source-conflict] the probe returned nothing');
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  if (payload.dbg.errors?.length) {
    console.error(`[source-conflict] probe error: ${payload.dbg.errors.join('\n')}`);
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
    const body = await fs.readFile(path.join(dir, name), 'utf8');
    body.split('\n').forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) bad.push(`${name}:${i + 1} ${line.trim()}`);
    });
  }
  return { names, bad };
}

async function main() {
  const built = await build();
  const shot = path.join(WORK, 'shot.png');
  const d = await boot(probeFor(built), shot);

  check(d.rows === 2, 'the needs-decision change set shows both conflicts as rows (§7.3 R1)',
    `${d.rows} row(s) · ${JSON.stringify(d.rowTexts)}`);
  check(d.sides?.length === 2 && d.sides.every((n) => n === 3),
    'every conflict row has base / ours / theirs', `columns per row: ${JSON.stringify(d.sides)}`);
  check(d.kinds?.length === 2 && d.kinds.every((k) => !!k),
    'every row names the kind in the user\'s words', JSON.stringify(d.kinds));
  check(d.hasIntent, 'every row shows the intent of this source update', (d.row0 || '').slice(0, 200));
  check(d.defaultOurs, 'the default decision is 保留我的', `rows=${d.rows}`);
  check(Array.isArray(d.footButtons) && d.footButtons[0] === '全部保留我的'
    && d.footButtons[1] === '全部用源的' && /^应用 \(\d+\)$/.test(d.footButtons[2] || ''),
    'the bottom bar offers 全部保留我的 / 全部用源的 / 应用', JSON.stringify(d.footButtons));
  check(d.noModal, 'the conflicts are not a modal', `modal=${!d.noModal}`);

  check(d.allTheirs && d.allOurs, '全部用源的 / 全部保留我的 flip every row',
    `theirs=${d.allTheirs} ours=${d.allOurs}`);
  check(d.row0KeepsMine && d.row1UsesSource, 'a single row keeps its own choice',
    `row0 保留我的=${d.row0KeepsMine} row1 用源的=${d.row1UsesSource}`);
  check(d.applied && d.kickerAfter === EDITOR_TEXT,
    '应用 writes 保留我的 for the row that kept it (one transaction)',
    `rev+1=${d.applied} kicker="${d.kickerAfter}" (was "${d.kickerBefore}")`);
  check(d.titleAfter === SOURCE_COLOR, '应用 keeps 用源的 for the row that took the source',
    `title=${d.titleAfter} (editor ${EDITOR_COLOR}, source ${SOURCE_COLOR})`);
  check(d.recordApplied, 'the merge record leaves needs-decision', `applied=${d.recordApplied}`);
  check(d.undoDecision && d.backToTheirs && d.titleBack === SOURCE_COLOR,
    'one undo is back to the provisional (theirs) merge state',
    `kicker="${d.kickerAfter}" → undo → "${SOURCE_TEXT}"`);

  check(d.hasDetach && (d.clipMenu || []).some((item) => item.indexOf('脱离源码') >= 0),
    'the timeline right-click offers 脱离源码', JSON.stringify(d.clipMenu));
  check(d.detached && d.detachOneTransaction, '脱离源码 drops el.source in one transaction',
    `source gone=${d.detached} rev+1=${d.detachOneTransaction}`);
  check(d.nodeBefore !== d.nodeAfter && /pivot/.test(d.nodeBefore || ''),
    'the freeze folds the source delta into the node (a node element ignores transform.*)',
    `${d.nodeBefore} → ${d.nodeAfter}`);
  check(d.sourceModeGone, 'el.sourceMode goes with the binding', `gone=${d.sourceModeGone}`);
  check(d.pictureKept, 'the frame IR draws the same world matrix before and after the detach',
    `same=${d.pictureKept} world=${(d.worldBefore || '').slice(0, 80)}`);
  check(Math.abs(d.frozenY - d.localYBefore) > 0.5,
    'the frozen frame value becomes the local value (the source moved y by then)',
    `y ${d.localYBefore} → ${d.frozenY}`);
  check(/已脱离源码，当前画面已保留/.test(d.detachToast || '') && d.toastUndoLabel === '撤销',
    'the toast says 已脱离源码，当前画面已保留 with a 撤销 button',
    `toast="${d.detachToast}" button="${d.toastUndoLabel}"`);
  check(d.restored, 'the toast\'s 撤销 restores the binding', `restored=${d.restored}`);

  check(d.multiDetached && d.multiOneTransaction,
    'a multi-selection detaches both elements in one transaction',
    `detached=${d.multiDetached} rev+1=${d.multiOneTransaction} menu=${JSON.stringify(d.multiMenu)}`);
  check(d.hasMore && d.moreHasWhole, 'the inspector ⋯ menu offers 脱离整个源', JSON.stringify(d.moreMenu));
  check(d.wholeDetached && d.wholeOneTransaction && d.wholeCount > 2,
    '脱离整个源 detaches every element of that source in one transaction',
    `${d.wholeCount} element(s) · gone=${d.wholeDetached} rev+1=${d.wholeOneTransaction}`);
  check(d.plainMore && d.plainNoDetach && d.plainNoMark,
    'an element without a source gets no entry (right-click, ⋯, mark)',
    `⋯=${d.plainMore} menu=${d.plainNoDetach} mark=${d.plainNoMark}`);
  check(d.shotRows === 2 && d.shotNeedsDecision && (d.shotFoot || [])[2]?.startsWith('应用'),
    'the screenshot ends on a fresh needs-decision merge with its action bar',
    `${d.shotRows} row(s) · ${JSON.stringify(d.shotFoot)}`);

  const { names, bad } = await colourLiterals();
  check(bad.length === 0, 'no colour literal outside tokens.css (DESIGN.md §3)',
    bad.length ? bad.slice(0, 3).join(' | ') : `${names.length} file(s) clean`);

  const shots = await fs.readdir(WORK).catch(() => []);
  check(shots.includes('shot.png'), 'the screenshot was written', shots.filter((n) => n.endsWith('.png')).join(', '));

  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length) {
    console.log(`[source-conflict] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[source-conflict] PASS (${checks.length}/${checks.length})`);
}

main().catch((e) => { console.error('[source-conflict]', e.stack || e.message); process.exit(1); });
