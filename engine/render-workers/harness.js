// Page bootstrap for the sandbox (`vdm-src://app/harness.html`).
//
// The host (Electron main process) calls these three entry points through
// `webContents.executeJavaScript`; everything they return must be JSON.
//   __vdmLoad(req)   -> load a source into the sandbox (compile / warm up)
//   __vdmRender(req) -> draw exactly one frame, return PNG + timing
//   __vdmPost(req)   -> apply screen effects to one PNG
//   __vdmProbe(req)  -> environment diagnostics for the WP3.1 acceptance tests
//
// Failures are returned as `{ ok: false, error }` (never thrown across the IPC
// boundary): a thrown exception loses its `code`, and the pool wants the code.

import {
  canvasPayload, createDriver, createVdm, installDeterminism, parseColor, SDK_VERSION,
} from './sdk.js';
import { createPostProcessor } from './post.js';
import { CSP } from './protocol.js';

const container = document.getElementById('host');
const state = { key: null, runtime: null, driver: null };
let postProcessor = null;

const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback);

function normalizeSize(size) {
  const width = positive(Array.isArray(size) && size[0], 0);
  const height = positive(Array.isArray(size) && size[1], 0);
  if (!width || !height) throw Object.assign(new Error('size 必须是 [宽, 高] 正整数'), { code: 'INVALID_ARGUMENT' });
  if (width > 8192 || height > 8192) throw Object.assign(new Error('size 超过 8192'), { code: 'INVALID_ARGUMENT' });
  return [width, height];
}

function disposeCurrent() {
  if (state.driver) {
    try { state.driver.dispose(); } catch { /* ignore */ }
  }
  state.driver = null;
  state.key = null;
  state.runtime = null;
  // p5/glsl leave their canvases behind; a fresh container keeps frames independent.
  container.replaceChildren();
}

const vdmFor = (req, { frame }) => createVdm({
  runtime: state.runtime,
  frame,
  fps: Number(req.fps) || 30,
  size: normalizeSize(req.size),
  params: req.params || {},
  seed: Number.isFinite(Number(req.seed)) ? Number(req.seed) : 0,
  beat: req.beat ?? null,
  volume: req.volume ?? null,
});

async function loadSource(req) {
  if (!req || typeof req !== 'object') throw Object.assign(new Error('load 需要请求对象'), { code: 'INVALID_ARGUMENT' });
  const size = normalizeSize(req.size);
  const key = String(req.key || req.sourceId || '');
  if (state.key === key && state.driver && state.runtime === req.runtime) return { cached: true, runtime: state.runtime };

  disposeCurrent();
  const driver = createDriver({
    runtime: req.runtime,
    size,
    entryUrl: req.entryUrl,
    shaderText: req.shaderText,
    container,
  });
  state.driver = driver;
  state.runtime = req.runtime;
  state.key = key;

  // Setup always sees frame 0: which frame happened to arrive first must never
  // change what the sketch bakes into its closure (that would break determinism).
  const vdm = vdmFor({ ...req, size }, { frame: 0 });
  const restore = installDeterminism({ frame: 0, fps: vdm.fps, seed: vdm.seed });
  try {
    await driver.load({ entryUrl: req.entryUrl, vdm, libs: (req.manifest && req.manifest.libs) || null });
  } finally {
    restore();
  }
  return { cached: false, runtime: state.runtime, canvas: driver.canvas ? [driver.canvas.width, driver.canvas.height] : null };
}

async function renderFrame(req) {
  if (!state.driver) throw Object.assign(new Error('渲染前必须先用 __vdmLoad 加载源'), { code: 'SOURCE_LOAD_FAILED' });
  const vdm = vdmFor(req, { frame: Math.floor(Number(req.frame)) });
  if (!Number.isFinite(vdm.frame) || vdm.frame < 0) throw Object.assign(new Error('frame 必须是非负整数'), { code: 'INVALID_ARGUMENT' });
  const start = performance.now();
  const restore = installDeterminism({ frame: vdm.frame, fps: vdm.fps, seed: vdm.seed });
  let canvas;
  try {
    canvas = state.driver.render(vdm);
  } finally {
    restore();
  }
  if (!canvas) throw Object.assign(new Error('runtime 没有返回画布'), { code: 'RENDER_FAILED' });
  const payload = await canvasPayload(canvas, { wantRgba: !!req.wantRgba });
  payload.frame = vdm.frame;
  payload.ms = Math.round((performance.now() - start) * 100) / 100;
  payload.runtime = state.runtime;
  payload.sdk = SDK_VERSION;
  return payload;
}

async function postFrame(req) {
  if (!req || typeof req.dataUrl !== 'string' || !req.dataUrl.startsWith('data:image/png;base64,')) {
    throw Object.assign(new Error('post 需要 dataUrl（data:image/png;base64,…）'), { code: 'INVALID_ARGUMENT' });
  }
  if (!postProcessor) postProcessor = createPostProcessor();
  const start = performance.now();
  const out = await postProcessor.post(req.dataUrl, req.screenFx || {}, { time: Number(req.time) || 0 });
  const comma = out.indexOf(',');
  return { png: out.slice(comma + 1), ms: Math.round((performance.now() - start) * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Sandbox diagnostics (WP3.1 acceptance item 2). Nothing here is needed to
// render a frame: the tests ask the *inside* of the sandbox what it can reach,
// and get the CSP violation that stopped it.
// ---------------------------------------------------------------------------

async function probe(req = {}) {
  const violations = [];
  const onViolation = (event) => {
    violations.push({
      directive: event.effectiveDirective || event.violatedDirective,
      blocked: event.blockedURI,
    });
  };
  document.addEventListener('securitypolicyviolation', onViolation);

  const attempt = async (name, run) => {
    const before = violations.length;
    const record = { name };
    try {
      record.value = await run();
      record.blocked = false;
    } catch (e) {
      record.blocked = true;
      record.error = String((e && e.message) || e);
    }
    record.violations = violations.slice(before);
    return record;
  };

  const results = {};
  results.environment = {
    href: location.href,
    secureContext: window.isSecureContext,
    process: typeof process,
    require: typeof require,
    module: typeof module,
    global: typeof global,
    electron: typeof window.electron,
    preload: typeof window.vdmPreload,
    cspMeta: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || null,
    expectedCsp: CSP,
  };
  results.checks = [];
  results.checks.push(await attempt('fetch-network', () => fetch('http://127.0.0.1:47100/api/state').then((r) => `HTTP ${r.status}`)));
  results.checks.push(await attempt('fetch-file', () => fetch('file:///C:/Windows/win.ini').then((r) => `HTTP ${r.status}`)));
  results.checks.push(await attempt('xhr-file', () => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'file:///C:/Windows/win.ini');
    xhr.onload = () => resolve(`status ${xhr.status}`);
    xhr.onerror = () => reject(new Error('xhr error event'));
    xhr.send();
  })));
  results.checks.push(await attempt('websocket', () => new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:47100/ws');
    socket.onopen = () => resolve('connected');
    socket.onerror = () => reject(new Error('websocket error event'));
    setTimeout(() => reject(new Error('websocket timeout')), 1500);
  })));
  results.checks.push(await attempt('img-file', () => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(`loaded ${image.naturalWidth}x${image.naturalHeight}`);
    image.onerror = () => reject(new Error('image error event'));
    image.src = 'file:///C:/Windows/win.ini';
  })));
  results.checks.push(await attempt('script-file', () => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'file:///C:/Windows/win.ini';
    script.onload = () => resolve('loaded');
    script.onerror = () => reject(new Error('script error event'));
    document.head.appendChild(script);
  })));
  if (req.sourceId) {
    results.checks.push(await attempt('fetch-source-escape', () => fetch(`vdm-src://source/${req.sourceId}/../../../../package.json`).then((r) => `HTTP ${r.status}`)));
    results.checks.push(await attempt('import-source-escape', () => import(`vdm-src://source/${req.sourceId}/../../package.json`).then(() => 'imported')));
    results.checks.push(await attempt('fetch-own-manifest', () => fetch(`vdm-src://source/${req.sourceId}/manifest.json`).then((r) => `HTTP ${r.status}`)));
  }
  results.violations = violations;
  document.removeEventListener('securitypolicyviolation', onViolation);
  return results;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const guard = (name, fn) => async (req) => {
  try {
    return { ok: true, value: await fn(req || {}) };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: (e && e.code) || (name === 'load' ? 'SOURCE_LOAD_FAILED' : 'RENDER_FAILED'),
        message: String((e && e.message) || e),
        stack: String((e && e.stack) || '').slice(0, 4000),
      },
    };
  }
};

window.__vdmLoad = guard('load', loadSource);
window.__vdmRender = guard('render', renderFrame);
window.__vdmPost = guard('post', postFrame);
window.__vdmProbe = guard('probe', probe);
window.__vdmReady = { sdk: SDK_VERSION, csp: CSP, colors: !!parseColor('#ff8800') };
window.__vdmDispose = () => { disposeCurrent(); postProcessor?.dispose?.(); postProcessor = null; };
