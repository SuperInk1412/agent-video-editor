// Change set review panel (WP2.5a) — offscreen Electron probe.
//
// Builds a throwaway project and three proposed change sets through the REAL
// services (`projectService` + `ChangeSetService`) in Node, then boots the app
// and checks the 审阅 page end to end:
//
//   (a) the tab dot, the opened tab and the proposed list
//   (b) human-readable rows: element names + contract labels, no `cs_`/`el_`/`style.`
//   (c) 采纳选中 bumps rev by one; `撤回` on one row (revert-one) puts it back
//   (d) 全部不要 marks the record reverted and the project content returns to
//       the pre-accept content (hash computed here, in Node)
//   (e) 在画面里预览 leaves rev / the file untouched; the stage pixels equal
//       "really applied" and, with `\` held, the pre-apply pixels
//   (f) the 对比 modal opens and its two snapshots differ
//   (g) editing is refused while previewing and works again after exit
//
// A second boot enters the preview and writes `.scratch/check-review-ui/
// preview.png`; run 1 ends in the normal state and writes `shot.png`.
//
//   node scripts/check-review-ui.mjs [--keep]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';
import { projectService } from '../engine/projects.js';
import { ChangeSetService } from '../application/changeset-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-review-ui');
const PROJECT = path.join(WORK, 'project');
const PORT = '47317';
const ELEMENT = 'el_title';
const FROM = 230;
const TO = 150;
const INTENT_A = '把 01 词2 幻想 改成 150 号字';
const INTENT_B = '把标题换成青色';
const INTENT_C = '把标题字号放大到 200';
const INTENT_D = '把标题改成金色';
const HUMAN_COLOR = '#123456';

/** Canonical project text: the content without the fields every write stamps. */
function canonical(project) {
  const copy = JSON.parse(JSON.stringify(project));
  delete copy.rev;
  if (copy.meta) delete copy.meta.savedAt;
  return JSON.stringify(copy);
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Content hash of `project.vdm.json`, computed here in Node. */
async function fileHash() {
  const raw = await fs.readFile(path.join(PROJECT, 'project.vdm.json'), 'utf8');
  return { hash: sha(canonical(JSON.parse(raw))), rev: JSON.parse(raw).rev };
}

async function changeSetsFile() {
  const raw = await fs.readFile(path.join(PROJECT, '.vdm', 'changesets.json'), 'utf8');
  return JSON.parse(raw);
}

/** The throwaway project: one text element, one flat background, 3 proposals. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const p = normalizeProject(createProject({ title: 'review probe', duration: 4, width: 960, height: 540 }));
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    {
      op: 'addElement',
      element: {
        id: ELEMENT, name: '01 词2 幻想', type: 'text', start: 0, duration: 4, z: 1,
        node: { pivot: [0, 3.4, 0], position: [0, 0, 0], scale: [1, 1, 1], rotation: [0, 0, 0] },
        style: { text: '锈梦', size: FROM, color: '#e3e8f0', font: 'SimHei', align: 'center' },
        visible: true,
      },
    },
    { op: 'addElement', element: { id: 'el_bg', name: '底色', type: 'solid', start: 0, duration: 4, z: 0, style: { w: 1920, h: 1080, fill: '#102030' }, visible: true } },
  ]);
  await saveProject(PROJECT, p, { by: 'check-review-ui' });

  const service = projectService(PROJECT);
  const changesets = new ChangeSetService(service);
  const a = await changesets.propose({
    actorId: 'agent:dsh',
    intent: INTENT_A,
    ops: [
      { op: 'set', id: ELEMENT, path: 'style.size', value: TO },
      { op: 'set', id: ELEMENT, path: 'style.color', value: '#ffd400' },
      { op: 'set', id: ELEMENT, path: 'start', value: 0.5 },
      { op: 'keySet', id: ELEMENT, path: 'style.size', t: 1, value: 190 },
      { op: 'keySet', id: ELEMENT, path: 'style.size', t: 2, value: 120 },
    ],
  });
  const b = await changesets.propose({
    actorId: 'agent:dsh',
    intent: INTENT_B,
    ops: [{ op: 'set', id: ELEMENT, path: 'style.color', value: '#17d9ff' }],
  });
  const c = await changesets.propose({
    actorId: 'cli',
    intent: INTENT_C,
    ops: [{ op: 'set', id: ELEMENT, path: 'style.size', value: 200 }],
  });
  const d = await changesets.propose({
    actorId: 'agent:dsh',
    intent: INTENT_D,
    ops: [{ op: 'set', id: ELEMENT, path: 'style.color', value: '#ffd400' }],
  });
  return { a, b, c, d };
}

// Runs inside the editor (run 1). Everything is read off the real DOM and the
// real WebGL canvas; the result lands in window.__dbg and comes back through
// the `[capture]` line. No template literals and no `//` comments inside: the
// script is collapsed to one line and passed through --eval.
const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => {
    for (let i = 0; i < ms / 50; i++) { try { if (fn()) return true; } catch { /* keep waiting */ } await sleep(50); }
    return false;
  };
  for (let i = 0; i < 400; i++) { if (window.__vdm) break; await sleep(50); }
  const app = window.__vdm;
  const out = { errors: [] };
  const q = (s, root) => (root || document).querySelector(s);
  const qa = (s, root) => Array.prototype.slice.call((root || document).querySelectorAll(s));
  const text = (node) => (node ? node.textContent : '');
  const el = () => app.S.project.elements.find((e) => e.id === '${ELEMENT}');
  const base = (prop) => el()[prop] === undefined ? el().style[prop] : el()[prop];
  const stageHash = () => {
    const p = app.preview;
    p.render(app.S.time);
    const gl = p.gl, cv = p.canvas, W = cv.width, H = cv.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  const canvasHash = (cv) => {
    const data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < data.length; i += 4) {
      h ^= data[i]; h = Math.imul(h, 16777619);
      h ^= data[i + 1]; h = Math.imul(h, 16777619);
      h ^= data[i + 2]; h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const rowOf = (needle) => qa('#panelReview .rv-cs').find((node) => text(node).indexOf(needle) >= 0);
  const openByIntent = async (needle) => {
    let cs = rowOf(needle);
    if (!cs) return null;
    const exp = q('.rv-exp', cs);
    if (exp.getAttribute('aria-expanded') !== 'true') exp.click();
    await waitFor(() => {
      const now = rowOf(needle);
      return !!(now && qa('.rv-row', now).length > 0);
    });
    return rowOf(needle);
  };
  try {
    await waitFor(() => app.review && app.review.records.length >= 3);
    await sleep(400);
    const dot = q('[data-tabs="right"] [data-tab="review"] .tab-dot');
    out.dot = !!dot && !dot.hidden && dot.getAttribute('aria-label') === '有待审阅的变更集';
    const tab = q('[data-tabs="right"] [data-tab="review"]');
    tab.click();
    out.tabVisible = q('#panelReview').hidden === false;
    out.tabSelected = tab.getAttribute('aria-selected') === 'true';

    const csListed = rowOf('${INTENT_A}');
    out.listCount = qa('#panelReview .rv-cs').length;
    out.hasA = !!csListed;
    out.idA = csListed ? csListed.dataset.id : null;
    const csA = await openByIntent('${INTENT_A}');
    out.rowCount = qa('.rv-row', csA).length;
    out.defaultAccept = text(q('#panelReview [data-action="accept-selected"]')).replace(/s+/g, '');
    const panelText = text(csA);
    out.noIds = !/(cs_|el_|style\\.)/.test(panelText);
    out.hasName = panelText.indexOf('01 词2 幻想') >= 0;
    out.hasLabels = ['字号', '颜色', '起点'].every((label) => panelText.indexOf(label) >= 0);
    out.hasFrames = /f\\d+\\s*→\\s*f\\d+/.test(panelText);
    out.hasKeyframes = /关键帧 \\d+ 条/.test(panelText);
    out.idsInTitle = qa('[title]', csA).some((node) => {
      const tip = node.getAttribute('title') || '';
      return tip.indexOf('el_title') >= 0 || tip.indexOf('cs_') >= 0;
    });
    out.textSample = panelText.replace(/\\s+/g, ' ').slice(0, 220);

    out.baseline = JSON.stringify((() => {
      const copy = JSON.parse(JSON.stringify(app.S.project));
      delete copy.rev;
      if (copy.meta) delete copy.meta.savedAt;
      return copy;
    })());
    out.rev0 = app.S.project.rev;
    out.size0 = base('size');
    out.start0 = el().start;

    /* ---- accept: one checkbox = one row, then 采纳选中 (1) ---- */
    const rows = qa('.rv-row', csA);
    for (const row of rows) {
      const box = q('.rv-check', row);
      if (!box || box.disabled) continue;
      const keep = text(row).indexOf('字号') >= 0 && text(row).indexOf('关键帧') < 0;
      if (box.checked !== keep) box.click();
    }
    const acceptSelected = q('#panelReview [data-action="accept-selected"]');
    out.acceptLabel = text(acceptSelected).replace(/\\s+/g, '');
    acceptSelected.click();
    out.accepted = await waitFor(() => app.S.project.rev === out.rev0 + 1);
    out.rev1 = app.S.project.rev;
    out.size1 = base('size');
    out.start1 = el().start;

    /* ---- revert-one through the applied row's 撤回 ---- */
    out.refreshed = await waitFor(() => {
      const row = rowOf('${INTENT_A}');
      return row && text(row).indexOf('已应用') >= 0;
    });
    const csA2 = await openByIntent('${INTENT_A}');
    const sizeRow = qa('.rv-row', csA2).find((row) => text(row).indexOf('字号') >= 0 && text(row).indexOf('关键帧') < 0);
    out.hasSizeRow = !!sizeRow;
    const revertBtn = sizeRow && q('[data-action="row-revert"]', sizeRow);
    out.hasRevertOne = !!revertBtn;
    if (revertBtn) revertBtn.click();
    out.revertedOne = await waitFor(() => base('size') === ${FROM}, 4000);
    if (!out.revertedOne) {
      /* a late refresh can replace the row between query and click: retry on the fresh node */
      for (let attempt = 0; attempt < 10 && !out.revertedOne; attempt++) {
        const again = await openByIntent('${INTENT_A}');
        const row = qa('.rv-row', again).find((node) => text(node).indexOf('字号') >= 0 && text(node).indexOf('关键帧') < 0);
        const button = row && q('[data-action="row-revert"]', row);
        if (button) button.click();
        out.revertedOne = await waitFor(() => base('size') === ${FROM}, 2000);
      }
    }
    out.sizeAfterRevertOne = base('size');

    /* ---- 全部不要: whole record back to the proposed state, then reverted ---- */
    await waitFor(() => app.review.records.some((record) => record.id === out.idA));
    const csA3 = rowOf('${INTENT_A}');
    csA3.querySelector('.rv-cs-head').click();
    await sleep(150);
    const rejectAll = q('#panelReview [data-action="reject-all"]');
    out.rejectEnabled = !!rejectAll && !rejectAll.disabled;
    rejectAll.click();
    out.rejected = await waitFor(() => {
      const record = app.review.records.find((entry) => entry.id === out.idA);
      return record && record.status === 'reverted';
    });
    out.revAfterReject = app.S.project.rev;

    /* ---- preview of B: stage pixels, file untouched, backslash hold ---- */
    app.setTime(0);
    await sleep(120);
    out.hash0 = stageHash();
    const csBListed = rowOf('${INTENT_B}');
    out.idB = csBListed ? csBListed.dataset.id : null;
    const csB = await openByIntent('${INTENT_B}');
    const prevBtn = q('[data-action="preview"]', csB);
    out.hasPreviewButton = !!prevBtn;
    const compareBefore = q('#panelReview [data-action="compare"]');
    out.compareDisabledBefore = !!compareBefore && compareBefore.disabled;
    prevBtn.click();
    out.previewOn = await waitFor(() => app.S.previewShadow && app.S.previewShadow.id === out.idB);
    out.previewBanner = !q('#previewBanner').hidden;
    out.gizmoHidden = !!app.gizmo && app.gizmo.opts.visible() === false;
    const fields = qa('#panelInsp input, #panelInsp select, #panelInsp textarea');
    out.inspectorReadOnly = fields.length > 0 && fields.every((field) => field.disabled);
    out.previewRev = app.S.project.rev;
    out.previewSavedAt = app.S.project.meta.savedAt || null;
    out.hashPreview = stageHash();
    out.previewDiffers = out.hashPreview !== out.hash0;

    /* compare modal, while the shadow is on the stage */
    const compare = q('#panelReview [data-action="compare"]');
    out.compareEnabled = !!compare && !compare.disabled;
    compare.click();
    out.compareOpen = await waitFor(() => {
      const left = q('#reviewCompare .cmp-canvas.cmp-left');
      return left && left.width > 0 && left.height > 0;
    });
    const leftCv = q('#reviewCompare .cmp-canvas.cmp-left');
    const rightCv = q('#reviewCompare .cmp-canvas.cmp-right');
    out.compareSizes = [leftCv.width, leftCv.height, rightCv.width, rightCv.height];
    out.compareHashes = [canvasHash(leftCv), canvasHash(rightCv)];
    out.compareDiffers = out.compareHashes[0] !== out.compareHashes[1];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    out.compareClosed = await waitFor(() => !q('#reviewCompare'));

    /* hold the backslash key to see the real project, release to return */
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backslash', bubbles: true, cancelable: true }));
    await sleep(120);
    out.holding = app.S.previewHolding === true;
    out.hashHold = stageHash();
    out.holdEqualsReal = out.hashHold === out.hash0;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backslash', bubbles: true, cancelable: true }));
    await sleep(120);
    out.hashRelease = stageHash();
    out.releaseEqualsShadow = out.hashRelease === out.hashPreview;

    /* editing is refused while the shadow is on the stage */
    const revPreview = app.S.project.rev;
    const refused = await app.op({ op: 'set', id: '${ELEMENT}', path: 'style.size', value: 999 });
    out.opRefused = refused === null && app.S.project.rev === revPreview && base('size') === ${FROM};
    out.sizeWhilePreview = base('size');

    q('#pbExit').click();
    out.exited = await waitFor(() => !app.S.previewShadow);
    out.hashAfterExit = stageHash();
    out.exitEqualsReal = out.hashAfterExit === out.hash0;

    /* really apply B: the preview must have shown exactly this picture */
    await app.review.apply(out.idB);
    out.appliedReal = await waitFor(() => app.S.project.rev === out.previewRev + 1);
    out.hashApplied = stageHash();
    out.appliedEqualsPreview = out.hashApplied === out.hashPreview;

    /* undo it again so the probe leaves the project where it started */
    await app.review.discard(out.idB);
    out.revertedB = await waitFor(() => app.S.project.rev > out.previewRev + 1);
    out.hashBack = stageHash();
    out.backToStart = out.hashBack === out.hash0;

    /* after the preview a write is allowed again */
    const wrote = await app.op({ op: 'set', id: '${ELEMENT}', path: 'style.size', value: 999 });
    out.writable = !!wrote && base('size') === 999;
    const undo = await fetch('/api/undo', { method: 'POST' });
    out.undoOk = undo.ok;
    out.undone = await waitFor(() => base('size') === ${FROM});
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
})()`;

// Runs inside the editor (run 3): the "stale proposal" path. A human edit after
// the proposal greys the row, `全部采纳` refuses to overwrite it, `仍然采纳`
// applies at the current revision, and the row click / AI card link jump to
// the right places.
const staleProbe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => {
    for (let i = 0; i < ms / 50; i++) { try { if (fn()) return true; } catch { /* keep waiting */ } await sleep(50); }
    return false;
  };
  for (let i = 0; i < 400; i++) { if (window.__vdm) break; await sleep(50); }
  const app = window.__vdm;
  const out = { errors: [] };
  const q = (s, root) => (root || document).querySelector(s);
  const qa = (s, root) => Array.prototype.slice.call((root || document).querySelectorAll(s));
  const text = (node) => (node ? node.textContent : '');
  const color = () => app.S.project.elements.find((e) => e.id === '${ELEMENT}').style.color;
  const rowOf = (needle) => qa('#panelReview .rv-cs').find((node) => text(node).indexOf(needle) >= 0);
  const openByIntent = async (needle) => {
    let row = rowOf(needle);
    if (!row) return null;
    const exp = q('.rv-exp', row);
    if (exp.getAttribute('aria-expanded') !== 'true') exp.click();
    await waitFor(() => {
      const now = rowOf(needle);
      return !!(now && qa('.rv-row', now).length > 0);
    });
    return rowOf(needle);
  };
  try {
    await waitFor(() => app.review && app.review.records.length >= 4);
    /* the human changes the very property D proposes, after D was proposed */
    const rev0 = app.S.project.rev;
    await app.op({ op: 'set', id: '${ELEMENT}', path: 'style.color', value: '${HUMAN_COLOR}' });
    out.humanEdit = await waitFor(() => app.S.project.rev === rev0 + 1 && color() === '${HUMAN_COLOR}');
    document.querySelector('[data-tabs="right"] [data-tab="review"]').click();
    await sleep(300);
    const cs = await openByIntent('${INTENT_D}');
    out.idD = cs ? cs.dataset.id : null;
    out.stale = await waitFor(() => {
      const row = rowOf('${INTENT_D}');
      return !!(row && q('.rv-row[data-state="stale"]', row));
    });
    const staleRow = q('.rv-row[data-state="stale"]', rowOf('${INTENT_D}'));
    out.staleText = text(staleRow).replace(/\\s+/g, ' ');
    out.staleSaysNow = out.staleText.indexOf('你之后改过这里') >= 0 && out.staleText.indexOf('${HUMAN_COLOR}') >= 0;

    /* 全部采纳 refuses: the human value is never overwritten silently */
    const revStale = app.S.project.rev;
    const acceptAll = q('#panelReview [data-action="accept-all"]');
    out.acceptAllDisabled = !!acceptAll && acceptAll.disabled;
    acceptAll.click();
    await sleep(300);
    out.refused = app.S.project.rev === revStale && color() === '${HUMAN_COLOR}';
    out.errorLine = text(q('#panelReview .rv-err')).indexOf('先逐条确认') >= 0;

    /* 让 AI 重新做: the intent lands in the AI box */
    q('.rv-row[data-state="stale"] [data-action="redo"]').click();
    await sleep(200);
    const task = q('#panelAI textarea.agent-task');
    out.redoDraft = !!task && task.value === '${INTENT_D}';
    document.querySelector('[data-tabs="right"] [data-tab="review"]').click();
    await sleep(200);

    /* a row click selects the host, seeks and highlights the inspector row */
    const again = await openByIntent('${INTENT_D}');
    q('.rv-row[data-state="stale"] .rv-main', again).click();
    await sleep(250);
    out.jumped = !q('#panelInsp').hidden && app.S.selection.elementId === '${ELEMENT}';
    out.highlighted = await waitFor(() => !!q('#panelInsp .prop.hl'), 2500);

    /* 仍然采纳 applies the set at the CURRENT revision */
    const revBefore = app.S.project.rev;
    const still = q('.rv-row[data-state="stale"] [data-action="still-accept"]');
    out.hasStillAccept = !!still;
    still.click();
    out.stillApplied = await waitFor(() => app.S.project.rev === revBefore + 1 && color() === '#ffd400');

    /* the applied card in the AI stream links back to these rows */
    document.querySelector('[data-tabs="right"] [data-tab="ai"]').click();
    out.aiLink = await waitFor(() => !!q('#panelAI [data-action="open-review"]'), 4000);
    out.aiLogCount = app.agentPanel ? app.agentPanel.log.length : -1;
    out.aiMsgCount = qa('#panelAI .msg').length;
    const link = q('#panelAI [data-action="open-review"]');
    if (link) link.click();
    out.linkOpenedReview = await waitFor(() => q('#panelReview').hidden === false, 4000);

    /* put the project back: discard D (reverts to its recorded before) */
    await app.review.discard(out.idD);
    out.discarded = await waitFor(() => {
      const record = app.review.records.find((entry) => entry.id === out.idD);
      return !!record && record.status === 'reverted';
    });
    out.colorAfter = color();
    /* The undo of a stale set restores what the human had, not the AI's before:
       applying at the current revision re-records the diff. */
    out.finalContent = JSON.stringify((() => {
      const copy = JSON.parse(JSON.stringify(app.S.project));
      delete copy.rev;
      if (copy.meta) delete copy.meta.savedAt;
      return copy;
    })());
    out.finalAccept = text(q('#panelReview [data-action="accept-selected"]')).replace(/s+/g, '');
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
})()`;

// Runs inside the editor (run 4): open the preview of C and leave it on screen
// so the --capture screenshot shows the banner and the shadow picture.
const previewProbe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 400; i++) { if (window.__vdm) break; await sleep(50); }
  const app = window.__vdm;
  const out = { errors: [] };
  try {
    for (let i = 0; i < 300; i++) { if (app.review && app.review.records.length >= 1) break; await sleep(50); }
    document.querySelector('[data-tabs="right"] [data-tab="review"]').click();
    const findRow = () => Array.prototype.slice.call(document.querySelectorAll('#panelReview .rv-cs'))
      .find((node) => node.textContent.indexOf('${INTENT_C}') >= 0) || document.querySelector('#panelReview .rv-cs');
    const first = findRow();
    out.id = first ? first.dataset.id : null;
    const exp = first.querySelector('.rv-exp');
    if (exp.getAttribute('aria-expanded') !== 'true') exp.click();
    let button = null;
    for (let i = 0; i < 200; i++) {
      const now = findRow();
      button = now && now.querySelector('[data-action="preview"]');
      if (button) break;
      await sleep(50);
    }
    button.click();
    out.previewing = false;
    for (let i = 0; i < 200; i++) { if (app.S.previewShadow) { out.previewing = true; break; } await sleep(50); }
    out.banner = !document.querySelector('#previewBanner').hidden;
    await sleep(300);
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
  console.log(`[review-ui] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function boot(script, capture, extra = []) {
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${capture}`, '--delay=3600', '--hold=700',
    `--eval=${script.replace(/\n\s*/g, ' ')}`,
    ...extra,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error(`[review-ui] ${path.basename(capture)}: the probe returned nothing`);
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  if (payload.dbg.errors?.length) {
    console.error(`[review-ui] probe error: ${payload.dbg.errors.join('\n')}`);
    process.exit(1);
  }
  return payload.dbg;
}

async function main() {
  const { a, b, c, d: dSet } = await build();
  const shot = path.join(WORK, 'shot.png');
  const preview = path.join(WORK, 'preview.png');
  const d = await boot(probe, shot);

  check(d.dot, 'the 审阅 tab shows a dot for a proposed set', `dot=${d.dot}`);
  check(d.tabVisible && d.tabSelected, 'the 审阅 tab opens #panelReview', `visible=${d.tabVisible} selected=${d.tabSelected}`);
  check(d.listCount >= 3 && d.hasA, 'the proposed change set is listed', `${d.listCount} row(s), A=${d.hasA} (${d.idA})`);
  check(d.rowCount >= 4 && d.hasKeyframes, 'rows are grouped and keyframes merged', `${d.rowCount} row(s), merged=${d.hasKeyframes}`);
  check(d.noIds && d.hasName && d.hasLabels && d.idsInTitle,
    'rows use element names + Chinese labels, ids only in tooltips',
    `noIds=${d.noIds} name=${d.hasName} labels=${d.hasLabels} tips=${d.idsInTitle} · ${d.textSample}`);
  check(d.hasFrames, 'times are frames, not seconds', `f… → f… in the rows: ${d.hasFrames}`);
  check(d.defaultAccept === '采纳选中 (4)', 'every fresh row is checked by default', `label=${d.defaultAccept}`);
  check(d.accepted && d.acceptLabel === '采纳选中(1)' && d.rev1 === d.rev0 + 1 && d.size1 === TO,
    '采纳选中 applies one transaction', `${d.acceptLabel} · rev ${d.rev0} → ${d.rev1} · 字号 ${d.size0} → ${d.size1}`);
  check(d.start1 === 0.5, 'the whole set is applied (start too)', `start ${d.start0} → ${d.start1}`);
  check(d.revertedOne && d.sizeAfterRevertOne === FROM, '撤回 on one row reverts just that entry', `字号 back to ${d.sizeAfterRevertOne}`);
  check(d.rejectEnabled && d.rejected, '全部不要 reverts the whole record', `status reverted=${d.rejected}`);

  const file = await fileHash();
  const sets = await changeSetsFile();
  const recordA = (sets.changesets || []).find((record) => record.id === a.id);
  const recordB = (sets.changesets || []).find((record) => record.id === b.id);
  check(recordA?.status === 'reverted', '`.vdm/changesets.json` says reverted', `A status=${recordA?.status}`);
  check(recordB?.status === 'reverted', 'the pixel probe set was reverted too', `B status=${recordB?.status}`);
  check(file.hash === sha(d.baseline || '') && file.rev > d.rev0,
    'project content is back to the pre-accept content', `hash ${sha(d.baseline || '')} → ${file.hash} · rev ${file.rev}`);

  check(d.previewOn && d.previewBanner, '在画面里预览 enters the shadow preview', `shadow=${d.previewOn} banner=${d.previewBanner}`);
  check(d.compareDisabledBefore, '对比 is disabled without a shadow', `disabled=${d.compareDisabledBefore}`);
  check(d.gizmoHidden && d.inspectorReadOnly, 'the preview hides the gizmo and disables the inspector',
    `gizmo hidden=${d.gizmoHidden} inspector read-only=${d.inspectorReadOnly}`);
  check(d.previewRev === d.revAfterReject, 'previewing writes nothing (rev unchanged)', `rev ${d.revAfterReject} → ${d.previewRev}`);
  check(d.previewDiffers && d.hashPreview !== d.hash0, 'the previewed picture differs from the real one', `hash ${d.hash0} → ${d.hashPreview}`);
  check(d.holding && d.holdEqualsReal, 'holding \\ shows the real project', `hold hash ${d.hashHold} === ${d.hash0}`);
  check(d.releaseEqualsShadow, 'releasing \\ returns to the shadow', `hash ${d.hashRelease} === ${d.hashPreview}`);
  check(d.compareOpen && d.compareSizes[0] > 0 && d.compareDiffers,
    'the 对比 modal shows two different snapshots', `sizes ${d.compareSizes.join('x')} hashes ${d.compareHashes.join(' / ')}`);
  check(d.compareClosed, 'Escape closes the 对比 modal', `closed=${d.compareClosed}`);
  check(d.opRefused && d.sizeWhilePreview === FROM, 'editing is refused during the preview', `op=null, 字号 stays ${d.sizeWhilePreview}`);
  check(d.exited && d.exitEqualsReal, '退出预览 restores the real picture', `hash ${d.hashAfterExit} === ${d.hash0}`);
  check(d.appliedReal && d.appliedEqualsPreview, 'the preview equals the really applied picture', `hash ${d.hashApplied} === ${d.hashPreview}`);
  check(d.revertedB && d.backToStart, 'reverting the applied set restores the picture', `hash ${d.hashBack} === ${d.hash0}`);
  check(d.writable && d.undone, 'editing works again after the preview', `op wrote ${d.sizeWhilePreview === FROM ? '999' : '?'} then undone`);

  // A later boot edits the property D proposed and checks the 过期 path; the
  // human value must never be overwritten silently.
  const stale = await boot(staleProbe, path.join(WORK, 'stale.png'));
  check(stale.humanEdit, 'a human can still edit after a proposal', `color → ${HUMAN_COLOR}`);
  check(stale.stale && stale.staleSaysNow, 'the stale row says what the human has now', stale.staleText.slice(0, 120));
  check(stale.acceptAllDisabled === false && stale.refused && stale.errorLine,
    '全部采纳 refuses to overwrite a stale proposal', `rev unchanged=${stale.refused} note=${stale.errorLine}`);
  check(stale.redoDraft, '让 AI 重新做 puts the intent in the AI box', `draft=${stale.redoDraft}`);
  check(stale.jumped && stale.highlighted, 'a row click selects, seeks and highlights the property', `selected=${stale.jumped} highlighted=${stale.highlighted}`);
  check(stale.hasStillAccept && stale.stillApplied, '仍然采纳 applies at the current revision', `applied=${stale.stillApplied}`);
  check(stale.aiLink && stale.linkOpenedReview, 'the AI card links back to the review rows', `link=${stale.aiLink} opened=${stale.linkOpenedReview} log=${stale.aiLogCount} msgs=${stale.aiMsgCount}`);
  check(stale.discarded, 'the stale set can still be discarded', `status reverted=${stale.discarded}`);
  check(stale.finalAccept === '采纳选中 (1)', 'the footer follows the next pending set after a revert', `label=${stale.finalAccept}`);
  const afterStale = await fileHash();
  check(stale.colorAfter === HUMAN_COLOR, 'the human value survives the stale accept + undo', `color after=${stale.colorAfter}`);
  check(afterStale.hash === sha(stale.finalContent || ''), 'the file holds exactly the project the page ended on', `hash ${afterStale.hash}`);
  const recordD = (await changeSetsFile()).changesets?.find((record) => record.id === dSet.id);
  check(recordD?.status === 'reverted', 'the stale set is recorded as reverted', `D status=${recordD?.status}`);

  // A second boot enters the preview of C and captures the preview state; the
  // change-set preview must leave the project file exactly as it was.
  const before = await fileHash();
  const p = await boot(previewProbe, preview);
  const after = await fileHash();
  check(p.previewing && p.banner, 'the preview screenshot run shows the banner', `previewing=${p.previewing} banner=${p.banner}`);
  check(after.hash === before.hash && after.rev === before.rev,
    'the preview run left project.vdm.json untouched', `rev ${before.rev} → ${after.rev}, hash ${before.hash} → ${after.hash}`);
  const pending = (await changeSetsFile()).changesets?.find((record) => record.id === c.id);
  check(pending?.status === 'proposed', 'the untouched proposal is still proposed', `C status=${pending?.status}`);

  const shots = await fs.readdir(WORK).catch(() => []);
  check(shots.includes('shot.png') && shots.includes('preview.png'), 'both screenshots were written', shots.filter((n) => n.endsWith('.png')).join(', '));

  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length) {
    console.log(`[review-ui] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[review-ui] PASS (${checks.length}/${checks.length})`);
}

main().catch((e) => { console.error('[review-ui]', e.stack || e.message); process.exit(1); });
