// 源码视图 + 载入外部修改 (docs/DESIGN-WP3.6-4.6-UI.md §2.2 / §7.1 R1, WP3.6b) —
// offscreen Electron probe over the real window, the real watcher and the real
// transaction path.
//
// Builds a throwaway project with two canvas2d sources (one healthy, one whose
// entry file is missing from the registry), writes the `sources/<id>/` copy the
// way an external editor would find it, then drives the UI the way a person
// would:
//
//   (a) 查看源码 opens the read-only window: source name · runtime · manifest
//       version, the file list from `manifest.entry` + `files`, and a <pre>
//       whose text *is* the file, with line numbers
//   (b) Esc closes it
//   (c) while the app is open, the copy is rewritten from outside -> the
//       non-modal notice 源码已在外部修改 [载入] appears
//   (d) 载入 loads it: diff first, contract check, ONE transaction -> the
//       project text changes, rev +1, Ctrl+Z takes it back
//   (e) the window's own 载入外部修改 shows the +/- lines it wrote
//   (f) a source whose entry file is missing -> --danger line + 重新扫描
//   (g) 让 AI 改 fills the AI page's box; 在编辑器中打开 is wired to the desktop
//
// The external edit happens *while the app runs*: the Node side waits for the
// page's signal op (`codeParamSet glow true`) through /api/project, rewrites
// `sources/src_rain/main.js`, and the page waits for the notice.
//
//   node scripts/check-source-view.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';
import { sourceFiles } from '../core/code-layer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-source-view');
const PROJECT = path.join(WORK, 'project');
// A dedicated port: the app attaches to whatever engine is already listening.
const PORT = '47349';
const GOOD = 'src_rain';
const BAD = 'src_broken';
const CODE_EL = 'el_rain';
const BAD_EL = 'el_broken';
const ENTRY = 'main.js';

const MANIFEST = {
  format: 'vdm.source/1',
  id: GOOD,
  label: 'rain',
  runtime: 'canvas2d',
  entry: ENTRY,
  deterministic: true,
  params: [
    { id: 'density', label: '密度', type: 'number', default: 0.5, range: [0, 1], step: 0.01 },
    { id: 'glow', label: '发光', type: 'boolean', default: false },
  ],
};

const SKETCH = `export function draw(ctx, vdm) {
  const d = Number(vdm.param('density')) || 0.5;
  ctx.fillStyle = vdm.param('glow') ? '#ffd400' : '#17d9ff';
  ctx.fillRect(0, 0, vdm.size[0] * d, vdm.size[1]);
}
`;

// What the external editor saves: one changed line, one added line.
const EXTERNAL_SKETCH = `export function draw(ctx, vdm) {
  const d = Math.max(0, Math.min(1, Number(vdm.param('density')) || 0.5));
  ctx.fillStyle = vdm.param('glow') ? '#ffd400' : '#17d9ff';
  ctx.fillRect(0, 0, vdm.size[0] * d, vdm.size[1]);
  ctx.globalAlpha = 0.9;
}
`;

const BAD_MANIFEST = {
  format: 'vdm.source/1',
  id: BAD,
  label: 'broken',
  runtime: 'canvas2d',
  entry: ENTRY,
  deterministic: false,
  params: [],
};

/** The throwaway project + the copy an external editor would see. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const p = normalizeProject(createProject({ title: 'source view probe', duration: 4, fps: 24, width: 960, height: 540 }));
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    {
      op: 'addElement',
      element: {
        id: 'el_bg', name: '底色', type: 'solid', start: 0, duration: 4, z: 0,
        style: { w: 960, h: 540, fill: '#101820' }, visible: true,
      },
    },
    { op: 'sourceAdd', id: GOOD, manifest: MANIFEST, files: { [ENTRY]: SKETCH } },
    // No main.js in the registry: the entry file is missing (a broken source).
    { op: 'sourceAdd', id: BAD, manifest: BAD_MANIFEST, files: { 'notes.md': '这个源还没有入口文件\n' } },
    {
      op: 'addElement',
      element: {
        id: CODE_EL, name: 'rain', type: 'code', start: 0, duration: 4, z: 1,
        node: { pivot: [0, 3.6, 0], position: [0, 0, 0], scale: [0.9, 0.9, 1], rotation: [0, 0, 0] },
        code: { source: GOOD, params: { density: 0.5, glow: false }, seed: 5, size: [480, 270], cache: 'bake' },
        visible: true,
      },
    },
    {
      op: 'addElement',
      element: {
        id: BAD_EL, name: 'broken', type: 'code', start: 0, duration: 4, z: 2,
        node: { pivot: [0, 1.4, 0], position: [0, 0, 0], scale: [0.4, 0.4, 1], rotation: [0, 0, 0] },
        code: { source: BAD, params: {}, seed: 1, size: [320, 180], cache: 'bake' },
        visible: true,
      },
    },
  ]);
  await saveProject(PROJECT, p, { by: 'check-source-view' });
  // The copy exactly as `sourceFiles()` derives it, so the watch starts clean.
  for (const file of sourceFiles(p, GOOD)) {
    const target = path.join(PROJECT, 'sources', GOOD, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
  return p;
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
  const flat = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim();
  const modal = () => q('[data-role="source-view"]');
  const visible = () => !!modal() && !modal().hasAttribute('hidden');
  const sec = () => q('#panelInsp section.sec[data-sec="code:代码图层"]');
  const elem = (id) => app.S.project.elements.find((e) => e.id === id);
  const sourceText = (id, file) => {
    const record = (app.S.project.sources || []).find((s) => s.id === id);
    return record && record.files ? (record.files[file] || '') : '';
  };
  const tokenRgb = (name) => {
    const el = document.createElement('span');
    el.style.color = 'var(' + name + ')';
    document.body.appendChild(el);
    const value = getComputedStyle(el).color;
    el.remove();
    return value;
  };
  const rgb = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const key = (k, extra) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true }, extra || {})));
  const ctrlZ = () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    key('z', { ctrlKey: true });
  };
  try {
    await waitFor(() => app && app.S && app.S.project);
    out.title = document.title;

    out.stage = 'a';
    /* (a) open the window from the inspector's 查看源码 */
    app.setTime(0);
    app.select({ elementId: '${CODE_EL}' });
    out.section = await waitFor(() => !!q('[data-action="code-view-source"]', sec()), 8000);
    q('[data-action="code-view-source"]', sec()).click();
    out.opened = await waitFor(() => visible() && qa('[data-action="source-file"]', modal()).length > 0 && !!q('.srcv-text', modal()), 8000);
    out.name = flat(text(q('[data-role="name"]', modal())));
    out.runtime = flat(text(q('.srcv-rt', modal())));
    out.version = flat(text(q('[data-role="version"]', modal())));
    out.files = qa('[data-action="source-file"]', modal()).map((b) => b.dataset.file).join(',');
    out.preText = text(q('.srcv-text', modal()));
    out.preMatchesSource = out.preText === sourceText('${GOOD}', '${ENTRY}');
    const gutter = text(q('.srcv-ln', modal())).trim().split('\\n');
    out.lineNumbers = [gutter[0], gutter[gutter.length - 1]].join('..');
    out.lineCount = gutter.length;
    out.fileLines = out.preText.split('\\n').length - 1;
    out.meta = flat(text(q('[data-role="meta"]', modal())));
    out.hashShown = /sha256:[0-9a-f]{8}/.test(out.meta);
    out.metaBytes = /\\d+(\\.\\d+)? (B|KB)/.test(out.meta);
    out.checkText = flat(text(q('[data-role="check"]', modal())));
    out.hasOpenEditor = !!q('[data-action="source-open"]', modal());
    out.hasAI = !!q('[data-action="source-ai"]', modal());
    out.hasRecheck = !!q('[data-action="source-recheck"]', modal());
    out.hasLoad = !!q('[data-action="source-load"]', modal());
    out.loadLabel = flat(text(q('[data-action="source-load"]', modal())));
    out.copyBadge = flat(text(q('[data-role="copy"]', modal())));

    out.stage = 'b';
    /* (b) Esc closes it */
    key('Escape');
    out.escClosed = await waitFor(() => !visible(), 5000);

    out.stage = 'c';
    /* (c) the watch: nothing yet, then an external edit appears as a notice */
    out.bannerBefore = !q('#sourceBanner') || q('#sourceBanner').hasAttribute('hidden');
    await app.op({ op: 'codeParamSet', id: '${CODE_EL}', name: 'glow', value: true });
    out.signalRev = app.S.project.rev;
    out.banner = await waitFor(() => !!q('#sourceBanner') && !q('#sourceBanner').hasAttribute('hidden'), 30000);
    const banner = q('#sourceBanner');
    out.bannerText = flat(text(q('.sb-text', banner)));
    out.bannerSource = flat(text(q('.sb-src', banner)));
    out.bannerStat = flat(text(q('.sb-stat', banner)));
    out.bannerLoad = !!q('[data-action="source-load-now"]', banner);

    out.stage = 'd';
    /* (d) [载入] loads the copy: one transaction, +1 rev, Ctrl+Z takes it back */
    const revBefore = app.S.project.rev;
    q('[data-action="source-load-now"]', banner).click();
    out.loaded = await waitFor(() => sourceText('${GOOD}', '${ENTRY}').indexOf('globalAlpha') >= 0, 15000);
    out.loadRevDelta = app.S.project.rev - revBefore;
    out.loadedText = sourceText('${GOOD}', '${ENTRY}');
    ctrlZ();
    out.undoBack = await waitFor(() => sourceText('${GOOD}', '${ENTRY}') === '${SKETCH.replace(/\n/g, '\\n').replace(/'/g, "\\'")}', 8000);
    out.undoText = sourceText('${GOOD}', '${ENTRY}');

    out.stage = 'e';
    /* (e) the window's own 载入外部修改: diff rows with +/- and line numbers */
    app.select({ elementId: '${CODE_EL}' });
    await waitFor(() => !!q('[data-action="code-view-source"]', sec()), 5000);
    q('[data-action="code-view-source"]', sec()).click();
    out.reopened = await waitFor(() => visible() && !!q('.srcv-text', modal()), 8000);
    out.preAfterUndo = text(q('.srcv-text', modal()));
    const revModal = app.S.project.rev;
    q('[data-action="source-load"]', modal()).click();
    out.diffShown = await waitFor(() => !!q('.srcv-diffrows .srcv-drow', modal()), 15000);
    out.diffTitle = flat(text(q('.srcv-diff-title', modal())));
    out.diffNote = flat(text(q('.srcv-diff-note', modal())));
    out.diffRows = qa('.srcv-diffrows .srcv-drow', modal()).length;
    out.diffAdds = qa('.srcv-diffrows .srcv-drow.add', modal()).length;
    out.diffDels = qa('.srcv-diffrows .srcv-drow.del', modal()).length;
    const addRow = q('.srcv-diffrows .srcv-drow.add', modal());
    const delRow = q('.srcv-diffrows .srcv-drow.del', modal());
    out.addNums = addRow ? qa('.srcv-dnum', addRow).map((n) => text(n)).join('|') : '';
    out.delNums = delRow ? qa('.srcv-dnum', delRow).map((n) => text(n)).join('|') : '';
    out.addLine = addRow ? flat(text(q('.srcv-dtext', addRow))) : '';
    out.delLine = delRow ? flat(text(q('.srcv-dtext', delRow))) : '';
    out.diffText = qa('.srcv-diffrows .srcv-drow', modal()).map((row) => flat(text(row))).join(' / ');
    out.loadedAgain = app.S.project.rev === revModal + 1 && sourceText('${GOOD}', '${ENTRY}').indexOf('globalAlpha') >= 0;
    out.modalRevDelta = app.S.project.rev - revModal;
    /* Ctrl+Z inside the modal: the window forwards it, the app's own key
       handler ignores keys while a modal is open */
    ctrlZ();
    out.modalUndo = await waitFor(() => sourceText('${GOOD}', '${ENTRY}').indexOf('globalAlpha') < 0, 8000);
    out.modalUndoText = sourceText('${GOOD}', '${ENTRY}');
    /* leave the diff pane showing what the last load wrote */
    q('[data-action="source-load"]', modal()).click();
    out.finalLoaded = await waitFor(() => sourceText('${GOOD}', '${ENTRY}').indexOf('globalAlpha') >= 0, 15000);
    out.finalDiff = !!q('.srcv-diffrows .srcv-drow.add', modal());
    out.finalDiffTitle = flat(text(q('.srcv-diff-title', modal())));

    out.stage = 'g';
    /* (g) 让 AI 改 fills the AI page's box */
    q('[data-action="source-ai"]', modal()).click();
    out.aiClosed = await waitFor(() => !visible(), 5000);
    out.aiTab = !q('#panelAI') || !q('#panelAI').hasAttribute('hidden');
    out.aiDraft = (() => { const box = q('#panelAI textarea'); return box ? box.value : ''; })();
    out.aiHasSource = out.aiDraft.indexOf('${GOOD}') >= 0;
    out.desktopBridge = !!(window.vdmDesktop && typeof window.vdmDesktop.openSource === 'function');

    out.stage = 'f';
    /* (f) a source whose entry file is missing: danger line + 重新扫描 */
    out.stage = 'f1-select';
    app.select({ elementId: '${BAD_EL}' });
    out.badSection = await waitFor(() => !!q('[data-action="code-view-source"]', sec()), 8000);
    out.stage = 'f2-click';
    q('[data-action="code-view-source"]', sec()).click();
    out.badOpened = await waitFor(() => visible() && !!q('.srcv-error', modal()), 8000);
    out.stage = 'f3-read';
    const err = q('.srcv-error', modal());
    out.badError = flat(text(q('.srcv-error-text', modal())));
    out.badDanger = err ? getComputedStyle(q('.srcv-error-text', modal())).color : null;
    out.dangerToken = tokenRgb('--danger');
    out.badHasRescan = !!q('[data-action="source-rescan"]', modal());
    out.badCheck = flat(text(q('[data-role="check"]', modal())));
    out.badFiles = qa('[data-action="source-file"]', modal()).map((b) => b.dataset.file).join(',');
    out.badPre = text(q('.srcv-text', modal()));
    out.stage = 'f4-rescan';
    q('[data-action="source-rescan"]', modal()).click();
    out.rescanKept = await waitFor(() => !!q('.srcv-error', modal()), 8000) && flat(text(q('.srcv-error-text', modal()))).indexOf('main.js') >= 0;
    key('Escape');
    out.closedAgain = await waitFor(() => !visible(), 5000);

    out.stage = 'final';
    /* final screenshot: the good source, the diff of the external edit, loaded.
       Undo first (the copy still differs) so the load has something to show. */
    app.select({ elementId: '${CODE_EL}' });
    await waitFor(() => !!q('[data-action="code-view-source"]', sec()), 5000);
    q('[data-action="code-view-source"]', sec()).click();
    await waitFor(() => visible() && qa('[data-action="source-file"]', modal()).length > 0, 8000);
    ctrlZ();
    await waitFor(() => sourceText('${GOOD}', '${ENTRY}').indexOf('globalAlpha') < 0, 8000);
    q('[data-action="source-load"]', modal()).click();
    out.finalShotLoaded = await waitFor(() => sourceText('${GOOD}', '${ENTRY}').indexOf('globalAlpha') >= 0
      && !!q('.srcv-diffrows .srcv-drow.add', modal()), 15000);
    if (q('#toasts')) q('#toasts').replaceChildren();
    await sleep(250);
    out.finalMeta = flat(text(q('[data-role="meta"]', modal())));
    out.finalFiles = qa('[data-action="source-file"]', modal()).map((b) => b.dataset.file).join(',');
    out.finalTitle = flat(text(q('.srcv-diff-title', modal())));
    out.finalRows = qa('.srcv-diffrows .srcv-drow', modal()).length;
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
})()`;

/** `fetch` against the engine the app is attached to. */
async function api(route) {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`);
  if (!response.ok) throw new Error(`${route} -> ${response.status}`);
  return response.json();
}

/** Wait until the page reaches the signal op, then rewrite the copy from outside. */
async function stageExternalEdit() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const body = await api('/api/project');
      const el = (body.project?.elements || []).find((entry) => entry.id === CODE_EL);
      if (el?.code?.params?.glow === true) {
        const file = path.join(PROJECT, 'sources', GOOD, ENTRY);
        await fs.writeFile(file, EXTERNAL_SKETCH);
        return { ok: true, rev: body.project.rev };
      }
    } catch { /* engine not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ok: false };
}

const checks = [];
const check = (ok, label, detail) => {
  checks.push({ ok: !!ok, label, detail });
  console.log(`[source-view] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

/** Pull the JSON object out of the `[capture] <png> {json}` line. */
function parseCapture(stdout) {
  const line = stdout.split('\n').find((entry) => entry.includes('[capture]'));
  if (!line) return null;
  const start = line.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < line.length; i += 1) {
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

async function main() {
  await build();
  const shot = path.join(WORK, 'shot.png');
  const script = probe.replace(/\n\s*/g, ' ');
  const child = spawn(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${shot}`, '--delay=3400', '--hold=900',
    `--eval=${script}`,
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, VDM_PORT: PORT } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));

  const staged = await Promise.race([
    stageExternalEdit(),
    closed.then(() => ({ ok: false, exited: true })),
  ]);
  const code = await closed;
  const payload = parseCapture(stdout);
  if (!payload || !payload.dbg) {
    console.error('[source-view] the probe returned nothing');
    console.error((stderr || stdout).slice(-4000));
    process.exit(1);
  }
  const d = payload.dbg;
  if (d.errors?.length) {
    console.error(`[source-view] probe error (stage ${d.stage || '?'}): ${d.errors.join('\n')}`);
    const partial = { ...d };
    delete partial.errors;
    console.error(`[source-view] partial: ${JSON.stringify(partial).slice(0, 4000)}`);
    console.error((stderr || stdout).slice(-3000));
    process.exit(1);
  }
  check(staged.ok, '外部编辑发生在应用运行期间（页面发信号后 Node 才改副本）', `signal rev=${staged.rev}`);

  // (a) the window
  check(d.opened && d.name === 'rain' && d.runtime === 'canvas2d',
    '查看源码 打开只读源码视图：源名 + runtime', `${d.name} · ${d.runtime}`);
  check(d.version === 'vdm.source/1 · src_rain', '顶部显示 manifest 版本与源 id', d.version);
  check(d.files === 'main.js', '左侧文件列表 = manifest.entry + files 键', `files=${d.files}`);
  check(d.preMatchesSource && d.preText.trim().endsWith('}'),
    '<pre> 文本就是源文件正文', `${d.preText.length} 字符，与工程正文一致=${d.preMatchesSource}`);
  check(d.lineNumbers === `1..${d.lineCount}` && d.lineCount === d.fileLines,
    '右侧行号与文件行数一致', `${d.lineNumbers} · ${d.lineCount} 行`);
  check(d.metaBytes && d.hashShown, '底部状态条：文件大小 + 哈希前 8 位', d.meta);
  check(/检查通过/.test(d.checkText), '底部状态条：上次检查时间与结果', d.checkText);
  check(d.hasOpenEditor && d.hasAI && d.hasRecheck && d.hasLoad && d.loadLabel === '载入外部修改',
    '四个按钮齐全，载入按钮叫「载入外部修改」而不是刷新', `load=${d.loadLabel} open=${d.hasOpenEditor} ai=${d.hasAI} recheck=${d.hasRecheck}`);
  check(d.copyBadge === '副本一致', '打开时副本与工程一致', d.copyBadge);
  check(d.escClosed, 'Esc 关闭模态', `closed=${d.escClosed}`);

  // (c) the watch
  check(d.bannerBefore, '没有外部修改时不打扰', `hidden=${d.bannerBefore}`);
  check(d.banner && d.bannerText === '源码已在外部修改' && d.bannerLoad,
    '外部改副本后出现非模态提示「源码已在外部修改 [载入]」', `${d.bannerText} · 源 ${d.bannerSource} · ${d.bannerStat}`);
  check(d.bannerSource === 'rain' && /^\+\d+ −\d+$/.test(d.bannerStat),
    '提示里写清是哪个源、改了多少行', `${d.bannerSource} ${d.bannerStat}`);

  // (d) the one-transaction load
  check(d.loaded && d.loadRevDelta === 1, '点载入：工程 sources 正文变化且 rev 只 +1', `rev +${d.loadRevDelta}`);
  check(d.loadedText.includes('ctx.globalAlpha = 0.9;'), '载入的正文就是副本的正文', `${d.loadedText.split('\n').length} 行`);
  check(d.undoBack, 'Ctrl+Z 回退这次载入', `undo=${d.undoBack}`);

  // (e) the window's own load with the diff
  check(d.reopened && d.preAfterUndo.indexOf('globalAlpha') < 0, '撤销后窗口显示工程正文（真值）', `${d.preAfterUndo.length} 字符`);
  check(d.diffShown && /已载入外部修改/.test(d.diffTitle) && /来源 外部编辑器/.test(d.diffTitle),
    '窗口内载入后显示 diff，并写明来源「外部编辑器」', `${d.diffTitle} · ${d.diffNote}`);
  check(d.diffAdds === 2 && d.diffDels === 1, 'diff 显示 +/- 行数', `+${d.diffAdds} −${d.diffDels}（${d.diffRows} 行含上下文）`);
  check(/^\d+\|$/.test(d.delNums) && /^\|\d+$/.test(d.addNums),
    'diff 行带旧/新行号（删除只有旧号，新增只有新号）', `−${d.delNums} +${d.addNums}`);
  check(d.delLine.includes('const d = Number(') && d.addLine.includes('Math.max(0, Math.min(1, Number('),
    'diff 行文本就是改动的那两行', `−${d.delLine.slice(0, 48)} +${d.addLine.slice(0, 48)}`);
  check(d.loadedAgain && d.modalRevDelta === 1, '窗口内载入也是一次事务（rev +1）', `rev +${d.modalRevDelta}`);
  check(d.modalUndo, '模态里 Ctrl+Z 也能撤销（窗口转发）', `undo=${d.modalUndo}`);

  // (f) the broken source
  check(d.badOpened && /找不到 main.js/.test(d.badError) && d.badHasRescan,
    '坏源：--danger 行「找不到 main.js」+ 重新扫描', d.badError);
  check(d.badDanger && d.badDanger === d.dangerToken, '错误行用 --danger', `${d.badDanger} vs ${d.dangerToken}`);
  check(/检查失败/.test(d.badCheck) && d.badFiles === 'main.js,notes.md',
    '坏源的状态条说检查失败，文件列表仍列出入口', `${d.badCheck} · files=${d.badFiles}`);
  check(d.badPre === '', '缺失的入口文件右侧是空的（不编造内容）', `pre=${JSON.stringify(d.badPre)}`);
  check(d.rescanKept, '重新扫描后错误态仍在（还没修好）', `kept=${d.rescanKept}`);
  check(d.closedAgain, 'Esc 再次关闭', `closed=${d.closedAgain}`);

  // (g) 让 AI 改 + 在编辑器中打开
  check(d.aiClosed && d.aiTab && d.aiHasSource && /请改源码/.test(d.aiDraft),
    '让 AI 改：关闭窗口、切到 AI 页、输入框有意图', `tab=${d.aiTab} draft=${d.aiDraft.slice(0, 40)}`);
  check(d.hasOpenEditor && d.desktopBridge, '在编辑器中打开 接在桌面桥上（不真的开程序）', `bridge=${d.desktopBridge}`);

  check(d.finalShotLoaded && d.finalRows >= 3 && /已载入外部修改 · 来源 外部编辑器/.test(d.finalTitle),
    '截图态：源码视图 + diff（外部编辑器的改动已载入）', `${d.finalTitle} · ${d.finalRows} 行 · ${d.finalMeta}`);

  // The file on disk is the source of truth for (d).
  const saved = JSON.parse(await fs.readFile(path.join(PROJECT, 'project.vdm.json'), 'utf8'));
  const rain = (saved.sources || []).find((source) => source.id === GOOD) || {};
  const broken = (saved.sources || []).find((source) => source.id === BAD) || {};
  check(String(rain.files?.[ENTRY] || '').includes('ctx.globalAlpha = 0.9;'),
    '工程文件写盘：sources[src_rain].files.main.js = 副本正文', `${String(rain.files?.[ENTRY] || '').split('\n').length} 行`);
  check(!(broken.files?.[ENTRY]), '坏源没有被写入任何入口文件', `files=${Object.keys(broken.files || {}).join(',')}`);

  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length) {
    console.log(`[source-view] FAIL (${checks.length - failed.length}/${checks.length})`);
    process.exit(1);
  }
  if (code !== 0) console.log(`[source-view] note: electron exited ${code}`);
  console.log(`[source-view] PASS (${checks.length}/${checks.length})`);
}

main().catch((error) => { console.error('[source-view]', error.stack || error.message); process.exit(1); });
