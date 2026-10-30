// Wire protocol, sandbox policy and URL builders shared by both sides of the
// RenderWorkerPool: Node (pool.js / host.js) and the sandboxed page (harness.js).
//
// This module is deliberately dependency free and DOM free so that the page can
// import it over `vdm-src://app/protocol.js` and pure Node tests can import it
// directly (`import ... from '../engine/render-workers/protocol.js'`).

/** Custom scheme owned by the sandbox. Nothing else is reachable from the page. */
export const SRC_SCHEME = 'vdm-src';

/** Bumped whenever the rasteriser changes in a way that invalidates pixels. */
export const RUNTIME_VERSION = 'vdm-rw/1';
/** Bumped whenever the injected `vdm` object changes shape or semantics. */
export const SDK_VERSION = 'vdm-sdk/1';

/** Runtimes the sandbox can drive (§6.1; `three`/`manim` are later work packages). */
export const RUNTIMES = Object.freeze(['canvas2d', 'p5', 'glsl']);

/** Per-frame wall clock budget (§5.3): live preview 200 ms, export 2 s. */
export const DEFAULT_TIMEOUT_MS = 200;
export const DEFAULT_EXPORT_TIMEOUT_MS = 2000;
/** Loading + setup of a source (module eval, p5 boot) gets its own budget. */
export const DEFAULT_LOAD_TIMEOUT_MS = 4000;
/** How long the pool waits for the Electron host to report ready. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 20000;

/** Files the `vdm-src://app/` host may serve. Anything else is a 403. */
export const APP_FILES = ['harness.html', 'harness.js', 'sdk.js', 'post.js', 'png16.js', 'protocol.js'];

/** CSP for every page in the sandbox: no network of any kind, no eval. */
export const CSP = [
  "default-src 'none'",
  'script-src vdm-src:',
  "style-src 'unsafe-inline' vdm-src:",
  'img-src vdm-src: data: blob:',
  'font-src vdm-src: data:',
  'media-src vdm-src:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ');

/** Extensions a source directory may expose to the page. Everything else is 403. */
export const SOURCE_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

export const contentTypeOf = (file) => {
  const dot = String(file).lastIndexOf('.');
  if (dot < 0) return null;
  return SOURCE_TYPES[String(file).slice(dot).toLowerCase()] || null;
};

// ---------------------------------------------------------------------------
// URL builders. `vdm-src://<host>/<path>`:
//   app/<file>            engine/render-workers/<file> (harness only, allowlist)
//   vendor/<path>         vendor/<path> (p5 and friends, allowlist + licences)
//   source/<id>/<path>    <projectRoot>/sources/<id>/<path>
//   frames/<name>         the directory a `post` job registered for this call
// ---------------------------------------------------------------------------

export const appUrl = (file) => `${SRC_SCHEME}://app/${file}`;
export const vendorUrl = (path) => `${SRC_SCHEME}://vendor/${path}`;
export const sourceUrl = (id, path = '') => `${SRC_SCHEME}://source/${id}/${path}`;

/** Source ids are directory names, not paths: keep them boring. */
export function isSafeSourceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

/**
 * Lexical check for a path relative to some allowlisted directory.
 * Rejects traversal, absolute paths (POSIX and Windows), separators that the
 * OS would fold differently, empty segments, NUL bytes and dot sequences.
 * Returns a normalised `a/b/c` string.
 */
export function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel) throw relativeFault(rel, 'empty path');
  if (rel.includes('\0')) throw relativeFault(rel, 'NUL byte');
  if (rel.includes('\\')) throw relativeFault(rel, 'backslash');
  if (rel.startsWith('/')) throw relativeFault(rel, 'absolute path');
  if (/^[A-Za-z]:/.test(rel)) throw relativeFault(rel, 'drive letter');
  const parts = rel.split('/');
  for (const part of parts) {
    if (!part) throw relativeFault(rel, 'empty segment');
    if (part === '.' || part === '..') throw relativeFault(rel, 'dot segment');
  }
  return parts.join('/');
}

function relativeFault(rel, why) {
  return Object.assign(new Error(`forbidden path "${rel}": ${why}`), {
    code: 'PATH_OUTSIDE_SCOPE', status: 403,
  });
}

// ---------------------------------------------------------------------------
// Host <-> pool framing. Every protocol line is prefixed so stray writes from
// Chromium / third party code on stdout can never be mistaken for a message.
// ---------------------------------------------------------------------------

export const MESSAGE_PREFIX = '\u0001VDMRW1\u0001';

export function encodeMessage(message) {
  return MESSAGE_PREFIX + JSON.stringify(message) + '\n';
}

/**
 * Incremental decoder: feed raw chunks, get parsed messages, ignore anything
 * that does not carry the prefix (Chromium sometimes writes to stdout).
 */
export function createMessageDecoder(onMessage, onNoise = null) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        if (!line.startsWith(MESSAGE_PREFIX)) {
          if (onNoise) onNoise(line);
          continue;
        }
        let message;
        try {
          message = JSON.parse(line.slice(MESSAGE_PREFIX.length));
        } catch (e) {
          if (onNoise) onNoise(`bad json: ${e.message}`);
          continue;
        }
        onMessage(message);
      }
    },
    /** Bytes held because the line is still incomplete (diagnostics only). */
    get pending() { return buffer.length; },
  };
}
