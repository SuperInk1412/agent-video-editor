// 报告草稿与报告分区 (WP2.5c) — offscreen Electron probe.
//
// Builds a throwaway project in Node, then boots the app and drives the real
// UI the way a person would:
//
//   (a) select an element -> Shift+R opens the draft with one attachment
//   (b) a time range + a second Shift+R appends the range (2 attachments)
//   (c) 闪烁 + one sentence + 提交 writes `.vdm/reports/<id>.json` with the
//       attachments / tags / note / frame / measures the spec asks for
//   (d) the 报告 section lists it and 重新测量 updates status + verification
//   (e) the AI page gains a report card (a record, not a run)
//   (f) Shift+drag in the viewport adds a `region` attachment (project pixels)
//   (g) 取消 / Esc write nothing (exactly one report file survives)
//
// Two boots: run 1 ends with the draft panel open (`shot.png`), run 2 shows the
// 审阅 page's 报告 section (`report.png`).
//
//   node scripts/check-report-ui.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-report-ui');
const PROJECT = path.join(WORK, 'project');
const PORT = '47321';
const ELEMENT = 'el_title';
const NOTE = '第二段字幕整段在闪';
const RANGE = { from: 144, to: 153 };
const FRAME = 150;
const FPS = 24;
const W = 960;
const H = 540;

/** The throwaway project: one text element over a flat background, 8s long. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const p = normalizeProject(createProject({ title: 'report probe', duration: 8, fps: FPS, width: W, height: H }));
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    {
      op: 'addElement',
      element: {
        id: ELEMENT, name: '01 词2 幻想', type: 'text', start: 0, duration: 8, z: 1,
        node: { pivot: [0, 3.4, 0], position: [0, 0, 0], scale: [1, 1, 1], rotation: [0, 0, 0] },
        style: { text: '锈梦', size: 230, color: '#e3e8f0', font: 'SimHei', align: 'center' },
        visible: true,
      },
    },
    {
      op: 'addElement',
      element: {
        id: 'el_bg', name: '底色', type: 'solid', start: 0, duration: 8, z: 0,
        style: { w: W, h: H, fill: '#102030' }, visible: true,
      },
    },
  ]);
  await saveProject(PROJECT, p, { by: 'check-report-ui' });
}

/** `rp_*.json` files under `.vdm/reports`, newest first. */
async function reportFiles() {
  const dir = path.join(PROJECT, '.vdm', 'reports');
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => /^rp_[0-9a-f]{16}\.json$/.test(name));
  return names;
}

async function readReports() {
  const dir = path.join(PROJECT, '.vdm', 'reports');
  const names = await reportFiles();
  const out = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (text) out.push(JSON.parse(text));
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

// Runs inside the editor. Collapsed to one line and passed through --eval, so
// no template literals and no `//` comments: only strings and expressions.
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
  const shiftR = (target) => (target || window).dispatchEvent(new KeyboardEvent('keydown', {
    key: 'R', code: 'KeyR', shiftKey: true, bubbles: true, cancelable: true,
  }));
  const draft = () => (app.S.reportDraft ? app.S.reportDraft.draft : null);
  const kinds = () => ((draft() && draft().attachments) || []).map((a) => a.kind);
  const panel = () => q('[data-region="report-draft"]');
  try {
    await waitFor(() => app.review && app.S.project);
    await sleep(300);

    /* (a) select -> Shift+R -> one element attachment */
    app.setTime(0);
    app.select({ elementId: '${ELEMENT}' });
    await sleep(120);
    /* typing a capital R in a field must not open the draft (§10.7-6) */
    const typing = document.createElement('input');
    document.body.appendChild(typing);
    typing.focus();
    shiftR(typing);
    await sleep(150);
    out.typingIgnored = !app.S.reportDraft;
    typing.remove();
    app.select({ elementId: '${ELEMENT}' });
    await sleep(80);
    out.cmdFound = !!q('#panelReview') && typeof app.report === 'object';
    shiftR();
    out.opened = await waitFor(() => app.S.reportDraft && app.S.reportDraft.open);
    out.panelVisible = !!panel() && panel().hidden === false;
    out.att1 = kinds().join(',');
    out.count1 = (draft() && draft().attachments.length) || 0;
    out.chip1 = text(q('.rd-chip-label'));
    out.count1Text = text(q('.rd-count'));

    /* (b) range + second Shift+R -> the range is appended */
    app.timeline.setRange({ from: ${RANGE.from}, to: ${RANGE.to} });
    app.setTime(${FRAME} / ${FPS});
    await sleep(120);
    shiftR();
    await sleep(200);
    out.count2 = (draft() && draft().attachments.length) || 0;
    out.kinds2 = kinds().join(',');
    const rangeAtt = ((draft() && draft().attachments) || []).find((a) => a.kind === 'range');
    out.rangeAtt = rangeAtt ? [rangeAtt.from, rangeAtt.to] : null;

    /* (c) 闪烁 + one sentence + submit */
    const chip = qa('.rd-syms .chip').find((node) => text(node) === '闪烁');
    out.hasSymptom = !!chip;
    chip.click();
    const note = q('.rd-note');
    note.value = '${NOTE}';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    const submit = q('[data-action="submit-report"]');
    out.submitEnabled = !!submit && !submit.disabled;
    submit.click();
    out.submitted = await waitFor(() => !app.report.isOpen(), 4000);
    out.aiCard = await waitFor(() => !!q('#panelAI .msg-report'), 4000);
    const card = q('#panelAI .msg-report');
    out.cardId = card ? card.dataset.reportId : null;
    out.cardLine = text(card && q('.msg-report-line', card)).replace(/\\\\s+/g, ' ');
    out.cardBadge = text(card && q('.msg-badge', card));

    /* (d) 审阅 page: the 报告 section lists the report, 重新测量 updates it */
    document.querySelector('[data-tabs="right"] [data-tab="review"]').click();
    out.reviewRows = await waitFor(() => qa('#panelReview .rv-report').length > 0, 6000);
    const row = () => qa('#panelReview .rv-report')[0] || null;
    out.rowText = text(row()).replace(/\\\\s+/g, ' ');
    out.rowStatus = text(q('.rv-status', row()));
    out.hasRemeasure = !!q('[data-action="remeasure-report"]', row());
    q('.rv-report-main', row()).click();
    await sleep(200);
    out.jumped = Math.abs(app.S.time - ${FRAME} / ${FPS}) < 0.001 && app.S.selection.elementId === '${ELEMENT}';

    /* hide the element: coverage must fail and the row must say so */
    await app.op({ op: 'set', id: '${ELEMENT}', path: 'visible', value: false });
    q('[data-action="remeasure-report"]', row()).click();
    out.remeasureFailed = await waitFor(() => {
      const note = q('.rv-report-note', row());
      return !!note && text(note).indexOf('仍有 1 项未通过') >= 0;
    }, 8000);
    out.noteAfterFail = text(q('.rv-report-note', row()));
    out.statusAfterFail = text(q('.rv-status', row()));

    /* visible again: the same plan now passes and verifies */
    await app.op({ op: 'set', id: '${ELEMENT}', path: 'visible', value: true });
    q('[data-action="remeasure-report"]', row()).click();
    out.remeasurePassed = await waitFor(() => text(q('.rv-status', row())) === '已验证', 8000);
    out.noteAfterPass = text(q('.rv-report-note', row()));
    out.statusAfterPass = text(q('.rv-status', row()));

    /* (e) the AI card jumps to the 报告 section */
    document.querySelector('[data-tabs="right"] [data-tab="ai"]').click();
    await sleep(150);
    q('#panelAI .msg-report').click();
    out.cardJump = await waitFor(() => q('#panelReview').hidden === false && !!q('#panelReview .rv-report.hl'), 4000);

    /* (f) 取消 writes nothing, then a region attachment stays on screen */
    document.querySelector('[data-tabs="right"] [data-tab="insp"]').click();
    app.select({ elementId: '${ELEMENT}' });
    shiftR();
    await waitFor(() => app.report.isOpen());
    out.cancelDraftKinds = kinds().join(',');
    q('[data-action="cancel-report"]').click();
    out.cancelled = await waitFor(() => !app.report.isOpen());
    shiftR();
    await waitFor(() => app.report.isOpen());
    const canvas = app.preview.canvas;
    const rect = canvas.getBoundingClientRect();
    const x0 = rect.left + rect.width * 0.25, y0 = rect.top + rect.height * 0.28;
    const x1 = rect.left + rect.width * 0.62, y1 = rect.top + rect.height * 0.66;
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: x0, clientY: y0, button: 0, buttons: 1, shiftKey: true, pointerId: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: x1, clientY: y1, buttons: 1, pointerId: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: x1, clientY: y1, button: 0, pointerId: 1,
    }));
    out.regionAdded = await waitFor(() => kinds().indexOf('region') >= 0, 3000);
    const region = ((draft() && draft().attachments) || []).find((a) => a.kind === 'region');
    out.region = region ? { rect: region.rect, frame: region.frame, label: region.label, ref: region.ref } : null;
    out.regionSane = !!region
      && region.rect.length === 4
      && region.rect[2] >= 100 && region.rect[2] <= ${W}
      && region.rect[3] >= 60 && region.rect[3] <= ${H}
      && region.rect[0] >= 0 && region.rect[1] >= 0
      && region.rect[0] + region.rect[2] <= ${W} && region.rect[1] + region.rect[3] <= ${H};
    out.draftKinds = kinds().join(',');
    out.draftOpenAtEnd = app.report.isOpen();

    /* a property row and a keyframe become attachments too (§10.4-1) */
    const propRef = 'el:${ELEMENT}:style.size';
    app.select({ pool: { kind: 'property', ids: [propRef], primary: propRef } });
    shiftR();
    await sleep(150);
    const prop = ((draft() && draft().attachments) || []).find((a) => a.kind === 'property');
    out.propAtt = prop ? [prop.host, prop.path, prop.label] : null;
    const cam = (app.S.project.cameras || [])[0];
    const keyT = cam && cam.path && cam.path.length ? cam.path[0].t : null;
    if (keyT != null) {
      const kfRef = 'cam:' + cam.id + ':path:' + keyT;
      app.select({ pool: { kind: 'keyframe', ids: [kfRef], primary: kfRef } });
      shiftR();
      await sleep(150);
      const kf = ((draft() && draft().attachments) || []).find((a) => a.kind === 'keyframe');
      out.kfAtt = kf ? [kf.host, kf.path, kf.t] : null;
    }
    out.withExtras = kinds().join(',');
    /* the chip × removes them again (the draft keeps the rest) */
    for (const kind of ['property', 'keyframe']) {
      const chip = q('.rd-chip.' + kind);
      if (chip) q('.rd-chip-x', chip).click();
    }
    await sleep(120);
    out.afterRemove = kinds().join(',');

    /* hover a chip: the timeline highlights the host row */
    const chipEl = q('.rd-chip.element');
    if (chipEl) chipEl.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    out.rowHighlight = await waitFor(() => !!q('#timeline .tl-report-hl'), 1500);
    if (chipEl) chipEl.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    await sleep(150);
    out.rowHighlightCleared = !q('#timeline .tl-report-hl');

    /* Escape closes the draft without writing */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const note2 = q('.rd-note');
    if (note2) { note2.focus(); note2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }
    out.escClosed = await waitFor(() => !app.report.isOpen(), 2000);
    /* leave the panel open with an element, the range and a region for the shot */
    app.timeline.setRange({ from: ${RANGE.from}, to: ${RANGE.to} });
    app.select({ elementId: '${ELEMENT}' });
    shiftR();
    await waitFor(() => app.report.isOpen());
    await sleep(80);
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: x0, clientY: y0, button: 0, buttons: 1, shiftKey: true, pointerId: 2,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: x1, clientY: y1, buttons: 1, pointerId: 2,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: x1, clientY: y1, button: 0, pointerId: 2,
    }));
    await sleep(250);
    out.finalKinds = kinds().join(',');
    out.finalPanel = !!panel() && panel().hidden === false;
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
})()`;

// Run 2: show the 审阅 page's 报告 section for the screenshot.
const reviewProbe = `(async () => {
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
  try {
    await waitFor(() => app.review);
    await waitFor(() => app.review.reports.length > 0, 8000);
    document.querySelector('[data-tabs="right"] [data-tab="review"]').click();
    out.rows = await waitFor(() => qa('#panelReview .rv-report').length > 0, 6000);
    out.count = qa('#panelReview .rv-report').length;
    out.text = (qa('#panelReview .rv-report')[0] || {}).textContent || '';
    const section = q('#panelReview .rv-reports');
    if (section) section.scrollIntoView({ block: 'end' });
    await sleep(200);
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
  console.log(`[report-ui] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function boot(script, capture) {
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${capture}`, '--delay=3600', '--hold=700',
    `--eval=${script.replace(/\n\s*/g, ' ')}`,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error(`[report-ui] ${path.basename(capture)}: the probe returned nothing`);
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  if (payload.dbg.errors?.length) {
    console.error(`[report-ui] probe error: ${payload.dbg.errors.join('\n')}`);
    process.exit(1);
  }
  return payload.dbg;
}

async function main() {
  await build();
  const shot = path.join(WORK, 'shot.png');
  const reportShot = path.join(WORK, 'report.png');
  const d = await boot(probe, shot);

  check(d.typingIgnored, 'Shift+R in a text field types an R instead of opening the draft', `draft=${d.typingIgnored ? 'closed' : 'opened'}`);
  check(d.opened && d.panelVisible, 'Shift+R opens the draft panel', `open=${d.opened} visible=${d.panelVisible}`);
  check(d.count1 === 1 && d.att1 === 'element', 'the pressed selection is attached', `${d.count1} attachment(s): ${d.att1} · ${d.chip1} · ${d.count1Text}`);
  check(d.count2 === 2 && d.kinds2 === 'element,range' && d.rangeAtt?.[0] === RANGE.from && d.rangeAtt?.[1] === RANGE.to,
    'a second Shift+R appends the time range', `${d.count2} attachment(s): ${d.kinds2} · range ${JSON.stringify(d.rangeAtt)}`);
  check(d.hasSymptom && d.submitEnabled && d.submitted, 'a symptom + one sentence submit the draft', `symptom=${d.hasSymptom} enabled=${d.submitEnabled} submitted=${d.submitted}`);
  check(d.aiCard && d.cardLine?.includes('01 词2 幻想') && d.cardLine?.includes('闪烁 · 2 个附件'), 'the AI page gains a report card', `${d.cardBadge} · ${d.cardLine}`);
  check(d.reviewRows && d.rowText?.includes('报告 f150') && d.rowText?.includes('闪烁') && d.rowText?.includes('2 个附件'),
    'the 审阅 page lists the report', d.rowText?.slice(0, 120));
  check(d.rowStatus === '待处理' && d.hasRemeasure, 'a fresh report is 待处理 and has 重新测量', `status=${d.rowStatus} button=${d.hasRemeasure}`);
  check(d.jumped, 'a report row seeks to its frame and selects the element', `t=${FRAME / FPS}s`);
  check(d.remeasureFailed && d.noteAfterFail?.includes('仍有 1 项未通过') && d.statusAfterFail === '待处理',
    '重新测量 keeps a still-broken report open', `${d.statusAfterFail} · ${d.noteAfterFail}`);
  check(d.remeasurePassed && d.statusAfterPass === '已验证' && !d.noteAfterPass,
    '重新测量 verifies a fixed report', `${d.statusAfterPass} · note=${d.noteAfterPass || '(badge only)'}`);
  check(d.cardJump, 'the AI report card jumps to the 报告 section', `highlighted=${d.cardJump}`);
  check(d.cancelled, '取消 drops the draft', `cancelled=${d.cancelled} (draft was ${d.cancelDraftKinds})`);
  check(d.regionAdded && d.regionSane, 'Shift+drag adds a region attachment in project pixels',
    `rect=${JSON.stringify(d.region?.rect)} frame=${d.region?.frame} label=${d.region?.label}`);
  check(d.propAtt?.[0] === ELEMENT && d.propAtt?.[1] === 'style.size' && d.propAtt?.[2]?.includes('字号'),
    'a property row becomes a property attachment', JSON.stringify(d.propAtt));
  check(d.kfAtt?.[0] && d.kfAtt?.[1] === 'path' && Number.isFinite(d.kfAtt?.[2]),
    'a keyframe becomes a keyframe attachment', JSON.stringify(d.kfAtt));
  check(d.afterRemove === 'element,range,region', 'the chip × removes one attachment', `${d.withExtras} → ${d.afterRemove}`);
  check(d.rowHighlight && d.rowHighlightCleared, 'hovering an attachment chip highlights its timeline row', `lit=${d.rowHighlight} cleared=${d.rowHighlightCleared}`);
  check(d.escClosed, 'Escape closes the draft', `closed=${d.escClosed}`);
  check(d.finalPanel && d.finalKinds?.includes('element') && d.finalKinds?.includes('range') && d.finalKinds?.includes('region'),
    'the screenshot run leaves the draft open with attachments', `kinds=${d.finalKinds}`);

  // One file, exactly the fields §10.4-7 asks for.
  const files = await reportFiles();
  const reports = await readReports();
  const report = reports[0] || null;
  const kindsOnDisk = (report?.attachments || []).map((a) => a.kind).join(',');
  check(files.length === 1, 'exactly one report file was written (cancel + Esc wrote nothing)', `${files.length} file(s): ${files.join(', ')}`);
  check(report && report.id === d.cardId, 'the card names the stored report', `${report?.id} vs ${d.cardId}`);
  check(kindsOnDisk === 'element,range' && report?.attachments?.[1]?.from === RANGE.from && report?.attachments?.[1]?.to === RANGE.to,
    'the file carries both attachments', kindsOnDisk);
  check((report?.tags || []).length === 1 && report.tags[0] === '闪烁', 'the file carries the symptom', JSON.stringify(report?.tags));
  check(report?.note === NOTE, 'the file carries the sentence', report?.note);
  check(report?.frame === FRAME && report?.fps === FPS, 'the file records the frame', `frame=${report?.frame} fps=${report?.fps}`);
  check(report?.mode === 'preview' && !!report?.camera, 'the file records camera + mode', `${report?.mode} · ${report?.camera}`);
  const coverage = (report?.measures || []).find((m) => m.kind === 'coverage');
  check(!!coverage && coverage.frameCount === RANGE.to - RANGE.from + 1,
    'the measures include a per-frame coverage over the range',
    `frameCount=${coverage?.frameCount} f0=${coverage?.f0} f1=${coverage?.f1} · ${(report?.measures || []).length} measure(s)`);
  check(report?.status === 'verified' && (report?.verification?.passed || []).length > 0,
    'the last re-measure marked the report verified', `status=${report?.status} passed=${(report?.verification?.passed || []).join(',')}`);

  const r = await boot(reviewProbe, reportShot);
  check(r.rows && r.count >= 1 && String(r.text).includes('报告 f150'), 'the screenshot run lists the report', `${r.count} row(s) · ${String(r.text).replace(/\s+/g, ' ').slice(0, 120)}`);
  const after = await reportFiles();
  check(after.length === 1, 'the review run wrote no extra report', `${after.length} file(s)`);

  const shots = await fs.readdir(WORK).catch(() => []);
  check(shots.includes('shot.png') && shots.includes('report.png'), 'both screenshots were written', shots.filter((n) => n.endsWith('.png')).join(', '));

  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length) {
    console.log(`[report-ui] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[report-ui] PASS (${checks.length}/${checks.length})`);
}

main().catch((e) => { console.error('[report-ui]', e.stack || e.message); process.exit(1); });
