// Change set review panel (WP2.5a) — offscreen Electron probe.
//
// Builds a throwaway project with one text element, proposes a change set from
// Node through the REAL services (`projectService` + `ChangeSetService`), then
// boots the app and asserts the review page against the DOM and the project:
//
//   (a) the 审阅 tab exists and shows the proposed change set
//   (b) accepting it posts `action:'apply'`, bumps rev by one and writes 150
//   (c) `全部不要` (revert) restores the injected project content
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

/** Canonical project text: the content without the fields every write stamps. */
function canonical(project) {
  const copy = JSON.parse(JSON.stringify(project));
  delete copy.rev;
  if (copy.meta) delete copy.meta.savedAt;
  return JSON.stringify(copy);
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Content hash of `project.vdm.json`, computed here in Node. */
async function fileContentHash() {
  const raw = await fs.readFile(path.join(PROJECT, 'project.vdm.json'), 'utf8');
  return sha(canonical(JSON.parse(raw)));
}

/** The throwaway project: one 2D text element, then one proposed change set. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const p = normalizeProject(createProject({ title: 'review probe', duration: 4, width: 960, height: 540 }));
  const ops = [
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
  ];
  applyOps(p, ops);
  await saveProject(PROJECT, p, { by: 'check-review-ui' });

  const service = projectService(PROJECT);
  const changesets = new ChangeSetService(service);
  const record = await changesets.propose({
    actorId: 'agent:dsh',
    intent: '把 01 词2 幻想 改成 150 号字',
    ops: [
      { op: 'set', id: ELEMENT, path: 'style.size', value: TO },
      { op: 'set', id: ELEMENT, path: 'style.color', value: '#ffd400' },
    ],
  });
  return { record };
}

// Runs inside the editor. Everything is read off the real DOM; the result lands
// in window.__dbg and comes back through the `[capture]` line.
const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 12000) => {
    for (let i = 0; i < ms / 50; i++) { try { if (fn()) return true; } catch { /* keep waiting */ } await sleep(50); }
    return false;
  };
  const app = window.__vdm;
  const out = { errors: [] };
  try {
    out.hasReview = !!app.review;
    await waitFor(() => app.review && app.review.records && app.review.records.length > 0);
    out.records = app.review ? app.review.records.length : 0;
    const tab = document.querySelector('[data-tabs="right"] [data-tab="review"]');
    out.tab = !!tab;
    tab.click();
    out.tabVisible = document.querySelector('#panelReview').hidden === false;
    out.tabSelected = tab.getAttribute('aria-selected') === 'true';
    out.rows = document.querySelectorAll('#panelReview .rv-cs').length;
    out.rowText = (document.querySelector('#panelReview .rv-cs') || {}).textContent || '';
    out.beforeRev = app.S.project.rev;
    out.beforeSize = app.S.project.elements.find((e) => e.id === '${ELEMENT}').style.size;
    /* Content before any accept: Node compares the file hash with this. */
    out.baseline = JSON.stringify((() => {
      const copy = JSON.parse(JSON.stringify(app.S.project));
      delete copy.rev;
      if (copy.meta) delete copy.meta.savedAt;
      return copy;
    })());
    const accept = document.querySelector('#panelReview [data-action="accept"]');
    out.hasAccept = !!accept;
    accept.click();
    out.applied = await waitFor(() => app.S.project.rev === out.beforeRev + 1);
    out.afterRev = app.S.project.rev;
    out.afterSize = app.S.project.elements.find((e) => e.id === '${ELEMENT}').style.size;
    out.listAfterApply = document.querySelectorAll('#panelReview .rv-cs').length;
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

async function main() {
  const { record } = await build();
  const script = probe.replace(/\n\s*/g, ' ');
  const shot = path.join(WORK, 'shot.png');
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${shot}`, '--delay=3600', '--hold=700',
    `--eval=${script}`,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error('[review-ui] the probe returned nothing');
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  const d = payload.dbg;
  if (d.errors?.length) {
    console.error(`[review-ui] probe error: ${d.errors.join('\n')}`);
    process.exit(1);
  }
  check(d.hasReview, 'the review panel is mounted', `window.__vdm.review=${d.hasReview}`);
  check(d.tab && d.tabVisible && d.tabSelected, 'the 审阅 tab opens #panelReview', `visible=${d.tabVisible} selected=${d.tabSelected}`);
  check(d.records === 1 && d.rows === 1, 'the proposed change set is listed', `${d.records} record(s), ${d.rows} row(s): ${d.rowText}`);
  check(d.hasAccept && d.afterRev === d.beforeRev + 1, 'accept bumps rev by one', `rev ${d.beforeRev} → ${d.afterRev}`);
  check(d.beforeSize === FROM && d.afterSize === TO, 'accept writes the proposed value', `字号 ${d.beforeSize} → ${d.afterSize}`);

  // Node-side: revert the whole set and compare the project file content with
  // what the page saw before accepting (booting normalises a project — the
  // default camera and world — so the pre-boot file is not the baseline).
  const service = projectService(PROJECT);
  const changesets = new ChangeSetService(service);
  const reverted = await changesets.revert({ id: record.id, actorId: 'ui' });
  const after = await fileContentHash();
  const before = sha(d.baseline || '');
  check(reverted.status === 'reverted', 'revert marks the record reverted', `status=${reverted.status}`);
  check(!!d.baseline && after === before, 'revert restores the project content', `hash ${before} → ${after}`);

  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`[review-ui] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[review-ui] PASS (${checks.length}/${checks.length})`);
}

main().catch((e) => { console.error('[review-ui]', e.stack || e.message); process.exit(1); });
