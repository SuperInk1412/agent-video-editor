// 代码图层的检查器分区 (docs/DESIGN-WP3.6-4.6-UI.md §2.1/§2.3, WP3.6a) —
// offscreen Electron probe over the real panel and the real stage.
//
// Builds a throwaway project with two canvas2d code layers (one healthy, one
// that reads the wall clock) and drives the UI the way a person would:
//
//   (a) select the code element  ->  「代码图层」section appears, one row per
//       manifest parameter, ◆ only on the keyable ones
//   (b) drag the range slider    ->  exactly one rev bump, value lands, Ctrl+Z
//       takes it back
//   (c) click ◆                  ->  `code.params.<name>` key at the playhead
//   (d) 查看源码                  ->  the WP3.6b stub toast (button is wired)
//   (e) the render row           ->  实时 + a measured frame time once the PNG
//       arrives; `—` for what the preview cannot see (cache hits)
//   (f) a bad source             ->  a --danger line + 查看详情 at the top
//   (g) `/api/raster` pointed at a dead route -> the --warn 圆点 (waiting) and
//       the --text-3 方块 (previous frame) appear in the edit viewport, and
//       playing / the shot view never draw them
//   (h) the saved project        ->  the value and the keyframe are really there
//
//   node scripts/check-code-ui.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-code-ui');
const PROJECT = path.join(WORK, 'project');
// A dedicated port: the app attaches to whatever engine is already listening.
const PORT = '47331';
const CODE_EL = 'el_rain';
const BAD_EL = 'el_bad';
const GOOD = 'src_rain';
const BAD = 'src_clock';
const PARAMS = 5;
const KEYABLE = 'density,tint';
const DENSITY = 0.75;

const MANIFEST = {
  format: 'vdm.source/1',
  id: GOOD,
  label: 'rain',
  runtime: 'canvas2d',
  entry: 'main.js',
  deterministic: true,
  params: [
    { id: 'density', label: '密度', group: 'shape', type: 'number', default: 0.5, range: [0, 1], step: 0.01, keyable: 'frame' },
    { id: 'tint', label: '颜色', group: 'style', type: 'color', default: '#ff8800', keyable: 'frame' },
    { id: 'glow', label: '发光', type: 'boolean', default: false },
    { id: 'mode', label: '模式', type: 'enum', default: 'a', options: ['a', 'b', 'c'] },
    // no label: the row falls back to the parameter id
    { id: 'speed', type: 'number', default: 1 },
  ],
};

const SKETCH = `export function draw(ctx, vdm) {
  const density = Math.max(0.05, Math.min(1, Number(vdm.param('density')) || 0.5));
  ctx.fillStyle = vdm.param('tint') || '#ff8800';
  ctx.fillRect(0, 0, vdm.size[0] * density, vdm.size[1]);
}
`;

// The bad source: the static half of `vdm source check` flags Date.now().
const BAD_MANIFEST = {
  format: 'vdm.source/1',
  id: BAD,
  label: 'clock',
  runtime: 'canvas2d',
  entry: 'main.js',
  deterministic: false,
  params: [],
};
const BAD_SKETCH = `export function draw(ctx, vdm) {
  ctx.fillStyle = Date.now() % 2 ? '#224466' : '#446622';
  ctx.fillRect(0, 0, vdm.size[0], vdm.size[1]);
}
`;

/** The throwaway project: a healthy code layer, a broken one, a 2D backdrop. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  for (const [id, manifest, sketch] of [[GOOD, MANIFEST, SKETCH], [BAD, BAD_MANIFEST, BAD_SKETCH]]) {
    const dir = path.join(PROJECT, 'sources', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(dir, 'main.js'), sketch);
  }

  const p = normalizeProject(createProject({ title: 'code ui probe', duration: 4, fps: 24, width: 960, height: 540 }));
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    {
      op: 'addElement',
      element: {
        id: 'el_bg', name: '底色', type: 'solid', start: 0, duration: 4, z: 0,
        style: { w: 960, h: 540, fill: '#101820' }, visible: true,
      },
    },
    { op: 'sourceAdd', id: GOOD, manifest: MANIFEST, files: { 'main.js': SKETCH } },
    { op: 'sourceAdd', id: BAD, manifest: BAD_MANIFEST, files: { 'main.js': BAD_SKETCH } },
    {
      op: 'addElement',
      element: {
        id: CODE_EL, name: 'rain', type: 'code', start: 0, duration: 4, z: 1,
        node: { pivot: [0, 3.6, 0], position: [0, 0, 0], scale: [0.9, 0.9, 1], rotation: [0, 0, 0] },
        code: { source: GOOD, params: { density: 0.5, tint: '#ff8800', glow: false, mode: 'a', speed: 1 }, seed: 5, size: [480, 270], cache: 'live' },
        visible: true,
      },
    },
    {
      op: 'addElement',
      element: {
        id: BAD_EL, name: 'clock', type: 'code', start: 0, duration: 4, z: 2,
        node: { pivot: [0, 1.4, 0], position: [0, 0, 0], scale: [0.4, 0.4, 1], rotation: [0, 0, 0] },
        code: { source: BAD, params: {}, seed: 1, size: [320, 180], cache: 'live' },
        visible: true,
      },
    },
  ]);
  await saveProject(PROJECT, p, { by: 'check-code-ui' });
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
  const sec = () => q('#panelInsp section.sec[data-sec="code:代码图层"]');
  const elem = (id) => app.S.project.elements.find((e) => e.id === id);
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  /* A token's computed colour, so a fill / text colour can be compared with it
     regardless of hex / rgb notation. */
  const tokenRgb = (name) => {
    const probeEl = document.createElement('span');
    probeEl.style.color = 'var(' + name + ')';
    document.body.appendChild(probeEl);
    const value = getComputedStyle(probeEl).color;
    probeEl.remove();
    return value;
  };
  const ctrlZ = () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
  };
  try {
    await waitFor(() => app && app.S && app.S.project);
    out.title = document.title;

    /* (a) select the code element: the section appears with one row per param */
    app.setTime(0);
    app.select({ elementId: '${CODE_EL}' });
    out.section = await waitFor(() => !!sec(), 5000);
    const S = sec();
    out.sectionTitle = text(q('.sec-name', S));
    out.rows = qa('.prop[data-code-param]', S).length;
    out.declared = app.S.project.sources.find((s) => s.id === '${GOOD}').manifest.params.length;
    out.rowNames = qa('.prop[data-code-param]', S).map((r) => r.dataset.codeParam).join(',');
    out.rowLabels = qa('.prop[data-code-param]', S).map((r) => text(q('label', r))).join(',');
    out.kfRows = qa('.prop[data-code-param] .kf-btn', S).map((b) => b.closest('.prop').dataset.codeParam).join(',');
    out.sourceText = text(q('.code-src', S));
    out.runtime = text(q('.code-rt', S));
    out.hasViewSource = !!q('[data-action="code-view-source"]', S);
    out.hasSlider = !!q('.prop[data-code-param="density"] .code-range', S);
    const kinds = { range: '.code-range', color: '.color-ctl', boolean: 'input[type=checkbox]', enum: 'select' };
    out.controls = qa('.prop[data-code-param]', S).map((r) => {
      for (const k of Object.keys(kinds)) if (q(kinds[k], r)) return r.dataset.codeParam + ':' + k;
      return r.dataset.codeParam + ':number';
    }).join(',');

    /* (d) 查看源码 is wired to the WP3.6b stub */
    q('[data-action="code-view-source"]', S).click();
    out.viewToast = await waitFor(() => text(q('#toasts')).indexOf('源码视图即将提供') >= 0, 3000);

    /* (e) the render row: 实时 + a measured frame time, — for what we cannot see */
    out.runLive = await waitFor(() => text(q('.code-run', sec())).indexOf('实时') >= 0, 15000);
    out.runText = text(q('.code-run', sec())).trim();
    out.runState = text(q('.code-run-state', sec()));
    out.runMs = text(q('.code-run-num', sec()));

    /* (b) one slider drag = one rev, then Ctrl+Z */
    const rev0 = app.S.project.rev;
    const before = elem('${CODE_EL}').code.params.density;
    const slider = q('.prop[data-code-param="density"] .code-range', sec());
    const slide = (v) => { slider.value = String(v); slider.dispatchEvent(new Event('input', { bubbles: true })); };
    slide(0.6); slide(0.7); slider.value = String(${DENSITY}); slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    out.dragSettled = await waitFor(() => app.S.project.rev === rev0 + 1, 5000);
    out.dragRevDelta = app.S.project.rev - rev0;
    out.dragValue = elem('${CODE_EL}').code.params.density;
    ctrlZ();
    /* Undo restores the previous snapshot and its rev keeps counting, so the
       value (not the rev number) is what proves Ctrl+Z took the drag back. */
    out.undoBack = await waitFor(() => elem('${CODE_EL}').code.params.density === before, 6000);
    out.undoValue = elem('${CODE_EL}').code.params.density;

    /* (c) ◆ writes a real keyframe at the playhead */
    app.setTime(0);
    await sleep(120);
    const kfBtn = q('.prop[data-code-param="density"] .kf-btn', sec());
    out.kfBefore = kfBtn ? kfBtn.dataset.state : null;
    kfBtn.click();
    out.keyWritten = await waitFor(() => (elem('${CODE_EL}').keyframes || []).some((k) => k.path === 'code.params.density' && Math.abs(Number(k.t)) < 1e-6), 5000);
    const key = (elem('${CODE_EL}').keyframes || []).find((k) => k.path === 'code.params.density');
    out.keyValue = key ? key.value : null;
    out.keyTime = key ? key.t : null;
    await sleep(150);
    out.kfAfter = q('.prop[data-code-param="density"] .kf-btn', sec()) ? q('.prop[data-code-param="density"] .kf-btn', sec()).dataset.state : null;

    /* (c2) 右键「把当前值设为默认」writes the source manifest's default */
    const modeSelect = q('.prop[data-code-param="mode"] select', sec());
    modeSelect.value = 'c';
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    out.modeEdited = await waitFor(() => elem('${CODE_EL}').code.params.mode === 'c', 5000);
    const menuRev = app.S.project.rev;
    q('.prop[data-code-param="mode"]', sec()).dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 320, clientY: 320,
    }));
    out.menuOpen = await waitFor(() => !!q('#ctxMenu') && !q('#ctxMenu').hidden, 3000);
    const menuItem = qa('#ctxMenu button').find((b) => text(b).indexOf('把当前值设为默认') >= 0);
    out.menuItem = !!menuItem;
    out.defaultBefore = (() => {
      const src = app.S.project.sources.find((s) => s.id === '${GOOD}');
      const decl = (src.manifest.params || []).find((p) => p.id === 'mode');
      return decl ? decl.default : null;
    })();
    if (menuItem) menuItem.click();
    out.defaultWritten = await waitFor(() => {
      const src = app.S.project.sources.find((s) => s.id === '${GOOD}');
      const decl = (src.manifest.params || []).find((p) => p.id === 'mode');
      return !!decl && decl.default === 'c';
    }, 6000);
    out.defaultAfter = (() => {
      const src = app.S.project.sources.find((s) => s.id === '${GOOD}');
      const decl = (src.manifest.params || []).find((p) => p.id === 'mode');
      return decl ? decl.default : null;
    })();
    out.defaultRevDelta = app.S.project.rev - menuRev;
    out.defaultKeptParam = elem('${CODE_EL}').code.params.mode;

    /* (f) a source that reads the wall clock gets the --danger line */
    app.select({ elementId: '${BAD_EL}' });
    out.badSection = await waitFor(() => !!q('.code-check', sec()), 5000);
    const check = q('.code-check', sec());
    out.checkText = text(q('.code-check-text', sec()));
    out.checkColour = check ? getComputedStyle(check).color : null;
    out.dangerToken = tokenRgb('--danger');
    out.checkLineColour = getComputedStyle(q('.code-check-text', sec())).color;
    out.hasDetail = !!q('[data-action="source-check-detail"]', sec());
    q('[data-action="source-check-detail"]', sec()).click();
    out.detailToast = await waitFor(() => text(q('#toasts')).indexOf('源码检查') >= 0, 3000);
    out.badRows = qa('.prop[data-code-param]', sec()).length;

    /* (g) the stage marks: edit viewport + paused only */
    app.select({ elementId: '${CODE_EL}' });
    app.setEditMode(true);
    app.setTime(0);
    out.marksClearLive = await waitFor(() => q('#codeMarks').hasAttribute('hidden'), 15000);

    /* (g1) previous frame: a new frame with a dead raster route, old texture kept */
    const realEndpoint = app.preview.rasterEndpoint;
    app.preview.rasterEndpoint = '/api/raster-dead';
    app.setTime(1 / 24);
    out.fallbackMark = await waitFor(() => !!q('#codeMarks .code-mark.fallback'), 8000);
    const square = q('#codeMarks .code-mark.fallback');
    if (square) {
      const r = square.getBoundingClientRect();
      out.fallbackSize = [Math.round(r.width), Math.round(r.height)];
      out.fallbackTip = square.dataset.tip;
      out.fallbackFill = getComputedStyle(square).fill;
      out.text3Token = tokenRgb('--text-3');
      /* the mark sits on the element's own projected corner: compare with the
         selection polygon of the very same (fallback) layer */
      const selPoly = q('#selPoly');
      const raw = selPoly ? selPoly.getAttribute('points') || '' : '';
      const pts = raw.trim() ? raw.trim().split(' ').filter(Boolean).map((p) => p.split(',').map(Number)) : [];
      if (pts.length) {
        const minX = Math.min(...pts.map((p) => p[0]));
        const minY = Math.min(...pts.map((p) => p[1]));
        /* canvas pixels, the same units as the points above: the mark's centre
           is half a mark inside the element's top-left corner. */
        out.markHalf = Number(square.getAttribute('width')) / 2;
        out.markOffset = [
          Number(square.getAttribute('x')) + out.markHalf - minX,
          Number(square.getAttribute('y')) + out.markHalf - minY,
        ].map((v) => Math.round(v));
      }
    }
    out.marksPausedOnly = !q('#codeMarks').hasAttribute('hidden');
    app.play();
    await sleep(160);
    out.marksWhilePlaying = !q('#codeMarks').hasAttribute('hidden');
    app.pause();
    await sleep(160);
    out.marksAfterPause = !q('#codeMarks').hasAttribute('hidden');

    /* (g2) waiting for the first frame: a new channel, nothing to fall back to */
    app.setTime(0);
    await app.op({ op: 'codeParamSet', id: '${CODE_EL}', name: 'glow', value: true });
    out.waitMark = await waitFor(() => !!q('#codeMarks .code-mark.waiting'), 8000);
    const dot = q('#codeMarks .code-mark.waiting');
    if (dot) {
      const r = dot.getBoundingClientRect();
      out.waitSize = [Math.round(r.width), Math.round(r.height)];
      out.waitTip = dot.dataset.tip;
      out.waitFill = getComputedStyle(dot).fill;
      out.warnToken = tokenRgb('--warn');
    }

    /* (g3) the shot view never draws them */
    app.setEditMode(false);
    await sleep(250);
    out.marksInShotView = !q('#codeMarks').hasAttribute('hidden');

    /* (g4) the route comes back: the mark disappears once the frame arrives */
    app.preview.rasterEndpoint = realEndpoint;
    app.setEditMode(true);
    await app.op({ op: 'codeParamSet', id: '${CODE_EL}', name: 'glow', value: false });
    out.marksRecovered = await waitFor(() => q('#codeMarks').hasAttribute('hidden'), 15000);

    /* final screenshot: the panel scrolled to the section, edit viewport,
       paused, with the --warn mark of a channel that has no frame yet */
    app.preview.rasterEndpoint = '/api/raster-dead';
    await app.op({ op: 'codeParamSet', id: '${CODE_EL}', name: 'mode', value: 'b' });
    app.select({ elementId: '${CODE_EL}' });
    app.setTime(0);
    out.finalMark = await waitFor(() => !!q('#codeMarks .code-mark.waiting'), 8000);
    await waitFor(() => !!sec(), 3000);
    if (sec()) sec().scrollIntoView({ block: 'end' });
    if (q('#toasts')) q('#toasts').replaceChildren();
    await sleep(250);
    out.finalRows = qa('.prop[data-code-param]', sec()).length;
    out.finalRun = text(q('.code-run', sec())).trim();
    out.finalRunState = text(q('.code-run-state', sec()));
    out.glow = elem('${CODE_EL}').code.params.glow;
    out.mode = elem('${CODE_EL}').code.params.mode;
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
  console.log(`[code-ui] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function main() {
  await build();
  const shot = path.join(WORK, 'shot.png');
  const script = probe.replace(/\n\s*/g, ' ');
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${shot}`, '--delay=3200', '--hold=900',
    `--eval=${script}`,
  ], { env: { ...process.env, VDM_PORT: PORT } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error('[code-ui] the probe returned nothing');
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  const d = payload.dbg;
  if (d.errors?.length) {
    console.error(`[code-ui] probe error: ${d.errors.join('\n')}`);
    process.exit(1);
  }

  const rgb = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const near12 = (size) => Array.isArray(size) && Math.abs(size[0] - 12) <= 1.5 && Math.abs(size[1] - 12) <= 1.5;
  check(d.section && d.sectionTitle === '代码图层', '选中代码图层后出现「代码图层」分区', `title=${d.sectionTitle}`);
  check(d.rows === PARAMS && d.rows === d.declared, '参数行数 = manifest 参数数', `${d.rows}/${d.declared} · ${d.rowNames}`);
  check(d.kfRows === KEYABLE, '◆ 只出现在 keyable 参数上', `${d.kfRows || '(none)'}`);
  check(d.rowLabels === '密度,颜色,发光,模式,speed', '参数行用 label，没有 label 用 id', d.rowLabels);
  check(d.controls === 'density:range,tint:color,glow:boolean,mode:enum,speed:number',
    '控件按 manifest type：range / color / boolean / enum / number', d.controls);
  check(flat(d.sourceText).includes('rain') && d.runtime.includes('canvas2d'), '源行显示 label + runtime', `${flat(d.sourceText)} · ${d.runtime}`);
  check(d.hasViewSource && d.viewToast, '查看源码 已接线（本包 toast 占位）', `button=${d.hasViewSource} toast=${d.viewToast}`);
  check(d.runLive && d.runState === '实时' && /\d+\.\d ms\/帧/.test(d.runMs),
    '渲染行：实时 + 最近帧耗时', flat(d.runText));
  check(flat(d.runText).includes('缓存命中 —'), '渲染行：预览看不到缓存命中时显示 —', flat(d.runText));
  check(d.dragSettled && d.dragRevDelta === 1, '一次拖动 = 一次 rev = 一次撤销', `rev +${d.dragRevDelta}, 值 ${d.dragValue}`);
  check(d.dragValue === DENSITY, '拖动把值写进工程', `density=${d.dragValue}`);
  check(d.undoBack && d.undoValue === 0.5, 'Ctrl+Z 退回拖动前的值', `density=${d.undoValue}`);
  check(d.kfBefore === 'none' && d.keyWritten && d.kfAfter === 'on', '◆ 在播放头写入关键帧', `path=code.params.density t=${d.keyTime} value=${d.keyValue} state=${d.kfBefore}→${d.kfAfter}`);
  check(d.modeEdited && d.menuOpen && d.menuItem, '参数行右键有「把当前值设为默认」', `menu=${d.menuOpen} item=${d.menuItem}`);
  check(d.defaultWritten && d.defaultAfter === 'c' && d.defaultBefore === 'a' && d.defaultRevDelta === 1,
    '「设为默认」把当前值写回 manifest（一次撤销）', `default ${d.defaultBefore} → ${d.defaultAfter}, rev +${d.defaultRevDelta}, 元素值 ${d.defaultKeptParam}`);
  check(d.defaultKeptParam === 'c', '设默认不改现有元素的值', `mode=${d.defaultKeptParam}`);
  check(d.badSection && flat(d.checkText).includes('这个源没通过检查') && d.hasDetail,
    '坏源：分区顶部 --danger 行 + 查看详情', flat(d.checkText));
  check(rgb(d.checkColour) === rgb(d.dangerToken) && rgb(d.checkLineColour) === rgb(d.dangerToken),
    '坏源那一行用 --danger', `line=${d.checkColour} token=${d.dangerToken}`);
  check(d.detailToast, '查看详情 已接线（本包 toast 占位）', `toast=${d.detailToast}`);
  check(d.fallbackMark && near12(d.fallbackSize),
    'fallback：12×12 --text-3 方块', `${JSON.stringify(d.fallbackSize)} fill=${d.fallbackFill} · ${d.fallbackTip}`);
  check(rgb(d.fallbackFill) === rgb(d.text3Token), '方块颜色来自 --text-3 token', `fill=${d.fallbackFill}`);
  check(Array.isArray(d.markOffset) && Math.abs(d.markOffset[0] - d.markHalf) <= 1 && Math.abs(d.markOffset[1] - d.markHalf) <= 1,
    '角标跟着元素的屏幕坐标（中心在选中框左上角，内缩半格）',
    `offset=${JSON.stringify(d.markOffset)} 半格=${d.markHalf}（画布像素）`);
  check(d.waitMark && near12(d.waitSize),
    '等待首帧：12×12 --warn 圆点', `${JSON.stringify(d.waitSize)} fill=${d.waitFill} · ${d.waitTip}`);
  check(rgb(d.waitFill) === rgb(d.warnToken), '圆点颜色来自 --warn token', `fill=${d.waitFill}`);
  check(d.marksPausedOnly && !d.marksWhilePlaying && d.marksAfterPause,
    '角标只在暂停态画（播放时消失，暂停回来）', `paused=${d.marksPausedOnly} playing=${d.marksWhilePlaying} back=${d.marksAfterPause}`);
  check(!d.marksInShotView, '镜头视角不画角标', `shotView=${d.marksInShotView}`);
  check(d.marksRecovered, '路由恢复后角标消失', `hidden=${d.marksRecovered}`);
  check(d.finalRows === PARAMS && d.finalRunState === '等待首帧' && d.finalMark,
    '截图态：分区 + 等待首帧（--warn）行与角标', `${d.finalRows} rows · ${flat(d.finalRun)} · mark=${d.finalMark}`);

  // The file on disk is the source of truth for (b), (c) and (c2).
  const saved = JSON.parse(await fs.readFile(path.join(PROJECT, 'project.vdm.json'), 'utf8'));
  const el = (saved.elements || []).find((e) => e.id === CODE_EL) || {};
  const key = (el.keyframes || []).find((k) => k.path === 'code.params.density') || null;
  const savedSource = (saved.sources || []).find((s) => s.id === GOOD) || {};
  const modeDecl = (savedSource.manifest?.params || []).find((p) => p.id === 'mode') || null;
  check(el.code?.params?.glow === false && el.code?.params?.mode === 'b',
    '参数写盘（glow false、mode b）', `glow=${el.code?.params?.glow} mode=${el.code?.params?.mode}`);
  check(key && Math.abs(Number(key.t)) < 1e-6 && Number(key.value) === 0.5,
    '关键帧写盘：code.params.density @0', JSON.stringify(key));
  check(modeDecl?.default === 'c', '默认值写盘：manifest.params.mode.default = c', `default=${modeDecl?.default}`);

  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`[code-ui] FAIL (${checks.length - failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[code-ui] PASS (${checks.length}/${checks.length})`);
}

main().catch((e) => { console.error('[code-ui]', e.stack || e.message); process.exit(1); });
