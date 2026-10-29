// Code layer in the preview (docs/DESIGN-BACKEND-V2.md §6.1/§6.2, WP3.3).
//
// Offscreen Electron probe over the REAL preview. Builds a throwaway project
// with one p5 code layer tilted in 3D and one opaque block in front of it, then
// asserts, by reading pixels back out of the WebGL canvas:
//
//   (a) the layer contributes pixels            (visible - hidden > 0)
//   (b) the block occludes it                   (0 differing pixels inside the
//                                                block's projected quad)
//   (c) two renders of one frame are identical  (byte-identical readPixels)
//   (d) one frame is fetched once               (the request key is deduped)
//   (e) a failing raster route does not break   (frame falls back to the last
//       the preview                              good frame; other items draw;
//                                                the page keeps running)
//
//   node scripts/check-code-layer-preview.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-code-preview');
const PROJECT = path.join(WORK, 'project');
const SOURCE_ID = 'src_rain';
const FRAME = 12; // t = 0.5 s at 24 fps

const MANIFEST = {
  format: 'vdm.source/1',
  id: SOURCE_ID,
  label: 'probe rain',
  runtime: 'p5',
  entry: 'sketch.js',
  libs: { p5: '1.9.4' },
  deterministic: true,
  params: [
    { id: 'density', type: 'number', default: 0.5, range: [0, 1], keyable: 'frame' },
    { id: 'tint', type: 'color', default: '#ff8800', keyable: 'frame' },
  ],
};

// Opaque magenta field + one orange band that moves every frame: "did it draw"
// is a colour test, and a stale (fallback) frame is obvious by the band height.
const SKETCH = `export default (p) => {
  p.setup = () => {
    const vdm = p.vdm;
    const [w, h] = vdm ? vdm.size : [1920, 1080];
    p.createCanvas(w, h);
    p.pixelDensity(1);
    p.noStroke();
  };
  p.draw = () => {
    const vdm = p.vdm;
    if (!vdm) return;
    const density = Math.max(0.05, Math.min(1, Number(vdm.param('density')) || 0.5));
    p.background(255, 0, 255);
    p.fill(vdm.param('tint') || '#ff8800');
    const bandH = p.height * 0.12 * (1 + density);
    const y = (vdm.frame % 5) * bandH;
    p.rect(0, y, p.width, bandH);
  };
};
`;

/** The throwaway project: one tilted code layer, one block in front, one marker. */
async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  const dir = path.join(PROJECT, 'sources', SOURCE_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'sketch.js'), SKETCH);

  const p = normalizeProject(createProject({ title: 'code preview probe', duration: 3, width: 1920, height: 1080 }));
  const ops = [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'sourceAdd', id: SOURCE_ID, manifest: MANIFEST, files: { 'sketch.js': SKETCH } },
    // the code layer: a full-frame plane, tilted, a little behind the origin
    {
      op: 'addElement',
      element: {
        id: 'el_rain', name: 'rain', type: 'code', start: 0, duration: 3, z: 2,
        node: { pivot: [0, 4.2, -2], position: [0, 0, 0], scale: [0.9, 0.9, 1], rotation: [12, 24, 0] },
        code: { source: SOURCE_ID, params: { density: 0.6, tint: '#ff8800' }, seed: 7, size: [960, 540], cache: 'live' },
        visible: true,
      },
    },
    // an opaque block 4 m in front of it: whatever the raster draws there must
    // lose the depth test (问题四 rule, carried by the IR's depth fields)
    {
      op: 'addElement',
      element: {
        id: 'el_wall', name: 'wall', type: 'solid', start: 0, duration: 3, z: 4,
        node: { pivot: [-1.6, 4.4, 2], position: [0, 0, 0], scale: [1, 1, 1], rotation: [0, 0, 0] },
        style: { w: 700, h: 520, fill: '#000000' },
        visible: true,
      },
    },
    // a green marker far to the left: "other items still draw" when the raster
    // route is broken
    {
      op: 'addElement',
      element: {
        id: 'el_marker', name: 'marker', type: 'solid', start: 0, duration: 3, z: 5,
        node: { pivot: [-6.4, 6.2, 3], position: [0, 0, 0], scale: [1, 1, 1], rotation: [0, 0, 0] },
        style: { w: 220, h: 220, fill: '#00ff00' },
        visible: true,
      },
    },
  ];
  applyOps(p, ops);
  await saveProject(PROJECT, p, { by: 'check-code-layer-preview' });
  return p;
}

// Runs inside the editor. Everything is measured off the real canvas; the
// result lands in window.__dbg and comes back through the `[capture]` line.
const probe = (frame) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__vdm;
  const out = { frame: ${frame}, errors: [] };
  try {
    const p = app.preview;
    const fps = Number(app.S.project.meta.fps) || 24;
    const t = ${frame} / fps;
    const t2 = (${frame} + 1) / fps;
    const t3 = (${frame} + 28) / fps;
    app.pause();
    p.playing = false;
    app.setTime(t);
    const W = p.canvas.width;
    const H = p.canvas.height;
    const gl = p.gl;
    out.size = [W, H];
    const read = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const buf = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const diffPixels = (a, b, inside) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
        if (!d) continue;
        if (inside) {
          const px = (i / 4) % W;
          const py = H - 1 - Math.floor(i / 4 / W);
          if (!inside(px, py)) continue;
        }
        n += 1;
      }
      return n;
    };
    const rasterish = (buf) => {
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        if (r > 200 && b > 200 && g < 70) n += 1; /* magenta field */
        else if (r > 200 && g > 90 && g < 190 && b < 70) n += 1; /* orange band */
      }
      return n;
    };
    const greenish = (buf) => {
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) if (buf[i] < 80 && buf[i + 1] > 180 && buf[i + 2] < 80) n += 1;
      return n;
    };
    const sameBuffer = (a, b) => diffPixels(a, b, null) === 0;

    /* 1. wait for this frame's PNG (the request is asynchronous) */
    let ready = false;
    for (let i = 0; i < 160; i++) {
      p.render(t);
      const drawn = (p.layers || []).some((L) => L.raster && !L.raster.stale);
      if (drawn) { ready = true; break; }
      await sleep(50);
    }
    out.ready = ready;
    out.statsReady = p.rasterStats();
    if (!ready) throw new Error('the raster never arrived');

    /* 2. (a) contribution + (b) occlusion */
    const withLayer = read();
    const drawnPixels = (() => { const s = p.layers.find((L) => L.raster && !L.raster.stale); return s ? 1 : 0; })();
    const wall = (p.layerPolygons() || []).find((poly) => poly.id === 'el_wall');
    const rain = (p.layerPolygons() || []).find((poly) => poly.id === 'el_rain');
    if (!wall || !rain) throw new Error('the probe quad did not project (no polygons)');
    const centroid = (poly) => poly.reduce((acc, pt) => [acc[0] + pt[0] / poly.length, acc[1] + pt[1] / poly.length], [0, 0]);
    const shrink = (poly, k) => {
      const c = centroid(poly);
      return poly.map((pt) => [c[0] + (pt[0] - c[0]) * k, c[1] + (pt[1] - c[1]) * k]);
    };
    const inPoly = (poly) => (x, y) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    };
    const wallPoly = shrink(wall.points, 0.86);
    const wallTest = inPoly(wallPoly);
    const el = app.S.project.elements.find((e) => e.id === 'el_rain');
    const hidden = (() => {
      el.visible = false;
      p._irCache.clear();
      p.render(t);
      const buf = read();
      el.visible = true;
      p._irCache.clear();
      p.render(t);
      return buf;
    })();
    out.contribution = diffPixels(withLayer, hidden, null);
    out.occludedContribution = diffPixels(withLayer, hidden, wallTest);
    out.rasterPixels = rasterish(withLayer);
    out.wallPixels = (() => {
      let n = 0;
      for (let i = 0; i < withLayer.length; i += 4) {
        const px = (i / 4) % W;
        const py = H - 1 - Math.floor(i / 4 / W);
        if (!wallTest(px, py)) continue;
        const r = withLayer[i], g = withLayer[i + 1], b = withLayer[i + 2];
        if (r > 200 && b > 200 && g < 70) n += 1;
      }
      return n;
    })();
    out.drawnLayers = drawnPixels;
    out.wallQuadPixels = (() => {
      let n = 0;
      for (let i = 0; i < withLayer.length; i += 4) {
        const px = (i / 4) % W;
        const py = H - 1 - Math.floor(i / 4 / W);
        if (wallTest(px, py)) n += 1;
      }
      return n;
    })();

    /* 3. (c) determinism + (d) one request per frame */
    const requestsBefore = p.rasterStats().requests;
    p.render(t);
    const again1 = read();
    p.render(t);
    const again2 = read();
    out.deterministic = sameBuffer(again1, again2) && sameBuffer(withLayer, again1);
    out.requestsForOneFrame = p.rasterStats().requests - requestsBefore;

    /* 4. (e) the raster route fails: fall back to the last good frame */
    const realFetch = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).indexOf('/api/raster') >= 0) return Promise.resolve(new Response('probe: broken route', { status: 500 }));
      return realFetch(url, options);
    };
    app.setTime(t2);
    p.render(t2);
    await sleep(150);
    p.render(t2);
    const broken = read();
    out.fallbackIsLastGood = sameBuffer(withLayer, broken);
    out.statsBroken = p.rasterStats();

    /* 5. a frame that never loaded, with the route still broken */
    p._clearRasterState();
    const requestsAfterClear = p.rasterStats().requests;
    app.setTime(t3);
    p.render(t3);
    await sleep(150);
    p.render(t3);
    const empty = read();
    out.brokenFrameRasterPixels = rasterish(empty);
    out.brokenFrameGreenPixels = greenish(empty);
    out.brokenFrameRequests = p.rasterStats().requests - requestsAfterClear;
    out.alive = typeof p.render === 'function' && app.S.project.elements.length === 3;
    window.fetch = realFetch;

    /* 6. depth, not paint order: tilt the raster so its plane crosses the block's
       plane. The near half must show through the block's quad and the far half
       must stay hidden — a painter's-order renderer would give one colour for the
       whole quad, whichever order it picked. */
    el.node.pivot = [0, 4.2, 1.8];
    el.node.rotation = [10, 30, 0];
    p._irCache.clear();
    for (let i = 0; i < 160; i++) {
      p.render(t);
      if ((p.layers || []).some((L) => L.raster && !L.raster.stale)) break;
      await sleep(50);
    }
    p.render(t);
    const crossed = read();
    const wallCross = (p.layerPolygons() || []).find((poly) => poly.id === 'el_wall');
    const crossTest = inPoly(shrink(wallCross.points, 0.86));
    out.depthFront = 0;
    out.depthBack = 0;
    const rainCross = (p.layerPolygons() || []).find((poly) => poly.id === 'el_rain');
    const round = (poly) => poly ? poly.map((pt) => [Math.round(pt[0]), Math.round(pt[1])]) : null;
    out.rainPoly = round(rainCross && rainCross.points);
    out.wallPoly = round(wallCross && wallCross.points);
    out.camera = p._ir && p._ir.camera && p._ir.camera.pos;
    out.rainPlane = (() => { const L = (p.layers || []).find((x) => x.id === 'el_rain'); return L ? L.plane : null; })();
    for (let i = 0; i < crossed.length; i += 4) {
      const px = (i / 4) % W;
      const py = H - 1 - Math.floor(i / 4 / W);
      if (!crossTest(px, py)) continue;
      const r = crossed[i], g = crossed[i + 1], b = crossed[i + 2];
      const isRaster = (r > 200 && b > 200 && g < 70) || (r > 200 && g > 90 && g < 190 && b < 70);
      if (isRaster) out.depthFront += 1;
      else out.depthBack += 1;
    }
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
  console.log(`[code-preview] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
};

async function main() {
  await build();
  const script = probe(FRAME).replace(/\n\s*/g, ' ');
  // A dedicated port: the app attaches to an engine that is already listening
  // on VDM_PORT, and a leftover one from another check would serve its project.
  const result = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${path.join(WORK, 'shot.png')}`, `--at=${FRAME / 24}`, '--delay=3200', '--hold=200',
    `--eval=${script}`,
  ], { env: { ...process.env, VDM_PORT: '47313' } });
  const payload = parseCapture(result.stdout);
  if (!payload || !payload.dbg) {
    console.error('[code-preview] the probe returned nothing');
    console.error((result.stderr || result.stdout).slice(-3000));
    process.exit(1);
  }
  const d = payload.dbg;
  console.log(`[code-preview] canvas ${d.size?.join('x')} · frame ${d.frame} · requests ${d.statsReady?.requests ?? '-'} · textures ${d.statsReady?.textures ?? '-'}`);
  if (d.errors?.length) {
    console.error(`[code-preview] probe error: ${d.errors.join('\n')}`);
    process.exit(1);
  }
  check(d.ready, 'the raster arrived asynchronously', `ready=${d.ready}`);
  check(d.contribution > 0, 'the code layer contributes pixels', `${d.contribution} px differ with it hidden`);
  check(d.occludedContribution === 0, 'the front block occludes it', `${d.occludedContribution} differing px inside the block's quad (${d.rasterPixels} raster px on screen)`);
  check(d.deterministic, 'two renders of one frame are identical', `${d.contribution} px contribution, buffers equal`);
  check(d.requestsForOneFrame === 0, 'one frame is requested once', `${d.requestsForOneFrame} extra requests for a re-render`);
  check(d.occludedContribution === 0 && d.wallQuadPixels > 0, 'the block quad really occludes', `${d.wallQuadPixels} px inside the block quad, ${d.wallPixels} of them raster`);
  check(d.depthFront > 0 && d.depthBack > 0, 'occlusion is the depth test, not paint order', `a crossed plane shows ${d.depthFront} near px and ${d.depthBack} hidden px inside one quad`);
  check(d.fallbackIsLastGood, 'a failed route falls back to the last good frame', `picture equal to frame ${FRAME}`);
  check(d.brokenFrameRasterPixels === 0 && d.brokenFrameGreenPixels > 0 && d.alive, 'a broken route does not break the preview',
    `raster px ${d.brokenFrameRasterPixels}, other item px ${d.brokenFrameGreenPixels}, ${d.brokenFrameRequests} failed request(s)`);
  if (d.rainPoly) console.log(`[code-preview] rain ${JSON.stringify(d.rainPoly)} plane ${JSON.stringify(d.rainPlane)} cam ${JSON.stringify(d.camera)}`);
  if (d.wallPoly) console.log(`[code-preview] wall ${JSON.stringify(d.wallPoly)}`);
  const failed = checks.filter((c) => !c.ok);
  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  if (failed.length) {
    console.log(`[code-preview] FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[code-preview] PASS (${checks.length}/${checks.length})`);
}

main().catch((e) => { console.error('[code-preview]', e.stack || e.message); process.exit(1); });
