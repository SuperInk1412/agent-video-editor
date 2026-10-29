// The hidden Electron window that does the rasterising (§5.3).
//
// Everything a sandboxed page can reach is decided here:
//   - the custom scheme `vdm-src://` is the only origin the page can load from;
//   - that scheme serves exactly three hosts: `app` (this directory, allowlist),
//     `vendor` (pinned libraries from vendor/manifest.json) and
//     `source/<id>` (one source directory under `<project>/sources/`);
//   - the document carries a CSP that forbids every network fetch;
//   - a frame that runs longer than its budget is killed, not waited for.
//
// This module is imported by the Electron host process only, so it may import
// `electron`; `pool.js` (plain Node) never imports it.

import { BrowserWindow, app, protocol, session } from 'electron';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import {
  APP_FILES, CSP, SRC_SCHEME, appUrl, contentTypeOf, safeRelative,
} from './protocol.js';
import { workerFault } from './errors.js';

const SANDBOX_PARTITION = 'vdm-sandbox';

/** Must be called before `app.whenReady()`. */
export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SRC_SCHEME,
    privileges: {
      standard: true,
      secure: true, // a secure context: crypto.subtle, no MixedContent surprises
      supportFetchAPI: true,
      corsEnabled: true, // module scripts are CORS requests
      stream: true,
      bypassCSP: false,
    },
  }]);
}

/**
 * Software rasterisation by default: the pixels a frame produces must not depend
 * on the GPU that happens to be installed (§13 "不同显卡上 Chromium 光栅结果有
 * 细微差异"). `VDM_RENDER_GPU=1` opts back into the hardware path for speed.
 */
export function applyCommandLineSwitches(env = process.env) {
  const hardware = String(env.VDM_RENDER_GPU || '') === '1';
  if (hardware) return { gl: 'hardware' };
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader'); // software WebGL in Chromium 136
  app.disableHardwareAcceleration();
  return { gl: 'swiftshader' };
}

/** True when `child` is inside `base` (both absolute, already realpath'd). */
const isWithin = (base, child) => {
  const rel = path.relative(base, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

/**
 * Build the `vdm-src://` handler. `realpath` containment is checked on every
 * request, so a junction/symlink inside `sources/<id>/` cannot escape the
 * sandbox either.
 */
export function createProtocolHandler({ appDir, repoRoot, sourcesRoot, vendorManifest }) {
  const appFiles = new Set(APP_FILES);
  const vendorFiles = new Set();
  for (const [lib, info] of Object.entries((vendorManifest && vendorManifest.libs) || {})) {
    for (const file of (info && info.files) || []) vendorFiles.add(`${lib}/${file}`);
  }
  const appDirReal = fss.realpathSync(appDir);

  const headers = (type, extra = {}) => ({
    'content-type': type,
    // module scripts from another vdm-src host are CORS requests
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });

  return async function handleRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400, headers: headers('text/plain') });
    }
    const host = url.host;
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    if (host === 'app') {
      if (!appFiles.has(relPath)) return new Response(`unknown app file: ${relPath}`, { status: 403, headers: headers('text/plain') });
      const file = path.join(appDirReal, relPath);
      if (!fss.existsSync(file)) return new Response('not found', { status: 404, headers: headers('text/plain') });
      const type = contentTypeOf(relPath) || 'application/octet-stream';
      return new Response(await fs.readFile(file), {
        status: 200,
        headers: headers(type, { 'content-security-policy': CSP }),
      });
    }

    if (host === 'vendor') {
      let rel;
      try {
        rel = safeRelative(relPath);
      } catch {
        return new Response('forbidden', { status: 403, headers: headers('text/plain') });
      }
      if (!vendorFiles.has(rel)) return new Response(`not a vendored file: ${rel}`, { status: 403, headers: headers('text/plain') });
      const rootReal = fss.realpathSync(path.join(repoRoot, 'vendor'));
      const file = path.join(rootReal, rel);
      if (!fss.existsSync(file)) return new Response('not found', { status: 404, headers: headers('text/plain') });
      const real = fss.realpathSync(file);
      if (!isWithin(rootReal, real)) return new Response('forbidden', { status: 403, headers: headers('text/plain') });
      return new Response(await fs.readFile(real), {
        status: 200,
        headers: headers(contentTypeOf(rel) || 'application/octet-stream'),
      });
    }

    if (host === 'source') {
      const slash = relPath.indexOf('/');
      if (slash <= 0) return new Response('forbidden', { status: 403, headers: headers('text/plain') });
      const id = relPath.slice(0, slash);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) return new Response('bad source id', { status: 403, headers: headers('text/plain') });
      let rel;
      try {
        rel = safeRelative(relPath.slice(slash + 1));
      } catch {
        return new Response('forbidden', { status: 403, headers: headers('text/plain') });
      }
      const type = contentTypeOf(rel);
      if (!type) return new Response(`extension not served: ${rel}`, { status: 403, headers: headers('text/plain') });
      let dirReal;
      try {
        dirReal = fss.realpathSync(path.join(sourcesRoot, id));
      } catch {
        return new Response(`no such source: ${id}`, { status: 404, headers: headers('text/plain') });
      }
      if (!isWithin(sourcesRoot, dirReal)) return new Response('forbidden', { status: 403, headers: headers('text/plain') });
      const file = path.join(dirReal, rel);
      if (!fss.existsSync(file)) return new Response('not found', { status: 404, headers: headers('text/plain') });
      const real = fss.realpathSync(file);
      if (!isWithin(dirReal, real)) return new Response('forbidden', { status: 403, headers: headers('text/plain') });
      return new Response(await fs.readFile(real), { status: 200, headers: headers(type) });
    }

    return new Response(`unknown host: ${host}`, { status: 403, headers: headers('text/plain') });
  };
}

/** Install the handler on the dedicated in-memory session. */
export async function installProtocol({ appDir, repoRoot, sourcesRoot, vendorManifest }) {
  const sandboxSession = session.fromPartition(SANDBOX_PARTITION);
  const handler = createProtocolHandler({ appDir, repoRoot, sourcesRoot, vendorManifest });
  sandboxSession.protocol.handle(SRC_SCHEME, handler);
  // No permission prompt can ever be approved from a hidden window.
  sandboxSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  sandboxSession.setPermissionCheckHandler(() => false);
  return sandboxSession;
}

/** The page may not open windows, navigate away or spawn file pickers. */
function harden(contents, onConsole) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${SRC_SCHEME}://app/`)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '');
    const severity = typeof event?.level === 'string' ? event.level : level === 3 ? 'error' : level === 2 ? 'warning' : 'info';
    if (onConsole) onConsole({ severity, text });
  });
}

/**
 * One sandbox window: created once, reused for many frames. After a timeout the
 * window is destroyed and must be created again (`host.js` does that).
 */
export class SandboxWindow {
  constructor(options) {
    this.options = options;
    this.win = null;
    this.ready = false;
    this.dead = false;
    /** Last page console errors: a sandbox that fails to boot explains itself here. */
    this.pageErrors = [];
  }

  async open() {
    const { width = 640, height = 360, onConsole = null, loadTimeoutMs = 15000 } = this.options;
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
        enableWebSQL: false,
        webgl: true,
        partition: SANDBOX_PARTITION,
      },
    });
    this.win = win;
    const collect = (entry) => {
      if (entry.severity === 'error') {
        this.pageErrors.push(entry.text);
        if (this.pageErrors.length > 20) this.pageErrors.shift();
      }
      if (onConsole) onConsole(entry);
    };
    harden(win.webContents, collect);
    win.on('closed', () => {
      this.dead = true;
      this.win = null;
    });
    await win.loadURL(appUrl('harness.html'));
    // `did-finish-load` fires after module evaluation, but poll anyway: a p5
    // build that loads asynchronously must not be able to race the first frame.
    const started = Date.now();
    for (;;) {
      const ok = await win.webContents.executeJavaScript('!!window.__vdmRender && !!window.__vdmReady').catch(() => false);
      if (ok) break;
      if (Date.now() - started > loadTimeoutMs) {
        this.kill();
        throw workerFault('SOURCE_LOAD_FAILED', `渲染沙箱没有在预算内就绪${this.pageErrors.length ? `：${this.pageErrors.slice(-3).join(' | ')}` : ''}`, {
          pageErrors: this.pageErrors.slice(-10),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.ready = true;
    return this;
  }

  get alive() {
    return !this.dead && !!this.win && !this.win.isDestroyed();
  }

  /**
   * Run one expression in the page with a hard budget. On timeout the renderer
   * is crashed and the window destroyed: a sketch stuck in `while(true)` must
   * cost one frame, not the engine.
   */
  async execute(expression, { timeoutMs, label = 'frame' } = {}) {
    if (!this.alive) throw workerFault('WORKER_CRASHED', '渲染窗口已销毁');
    const win = this.win;
    const work = win.webContents.executeJavaScript(expression).then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error }),
    );
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    });
    const result = await Promise.race([work, timeout]);
    if (timer) clearTimeout(timer);
    if (!result.settled) {
      this.kill();
      throw workerFault('RENDER_TIMEOUT', `${label} 超过 ${timeoutMs} ms，渲染进程已终止`, { timeoutMs, phase: label });
    }
    if (result.error) throw workerFault('RENDER_FAILED', String(result.error.message || result.error), { phase: label });
    return result.value;
  }

  /** Destroy the window and its renderer process. Never throws. */
  kill() {
    this.dead = true;
    const win = this.win;
    this.win = null;
    if (!win) return;
    try { win.webContents.forcefullyCrashRenderer(); } catch { /* already gone */ }
    try { win.destroy(); } catch { /* already gone */ }
  }
}
