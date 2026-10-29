// Error codes for the RenderWorkerPool. Every failure leaves the pool as a plain
// object with a `code`, never a bare exception (§12: "不要抛裸异常").

export const ERROR_CODES = {
  /** No usable Electron binary / host, or this Node build cannot rasterise. */
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  /** The frame exceeded its budget and the renderer was killed. */
  RENDER_TIMEOUT: 'RENDER_TIMEOUT',
  /** Loading / compiling the source failed or timed out. */
  SOURCE_LOAD_FAILED: 'SOURCE_LOAD_FAILED',
  /** User code threw while drawing this frame. */
  RENDER_FAILED: 'RENDER_FAILED',
  /** The host process died while a request was in flight. */
  WORKER_CRASHED: 'WORKER_CRASHED',
  /** Pool was closed (or closed while a request was in flight). */
  POOL_CLOSED: 'POOL_CLOSED',
  /** Unknown / missing runtime. */
  UNSUPPORTED_RUNTIME: 'UNSUPPORTED_RUNTIME',
  /** Source id or path is not allowed by the sandbox policy. */
  PATH_OUTSIDE_SCOPE: 'PATH_OUTSIDE_SCOPE',
  /** sources/<id>/manifest.json is missing or unreadable. */
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SOURCE_INVALID: 'SOURCE_INVALID',
  /** Bad arguments (missing fields, bad sizes, unknown runtime override...). */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** Anything unexpected (a bug in the pool or in the harness). */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

const STATUS = {
  DEPENDENCY_MISSING: 503,
  RENDER_TIMEOUT: 504,
  SOURCE_LOAD_FAILED: 422,
  RENDER_FAILED: 500,
  WORKER_CRASHED: 503,
  POOL_CLOSED: 409,
  UNSUPPORTED_RUNTIME: 400,
  PATH_OUTSIDE_SCOPE: 403,
  SOURCE_NOT_FOUND: 404,
  SOURCE_INVALID: 422,
  INVALID_ARGUMENT: 400,
  INTERNAL_ERROR: 500,
};

/**
 * Build a pool error. `details` is copied onto the error so callers (and the
 * report in the tests) can read e.g. `err.frame`, `err.timeoutMs`, `err.hint`.
 */
export function workerFault(code, message, details = {}) {
  const err = new Error(message);
  err.name = 'RenderWorkerError';
  err.code = ERROR_CODES[code] ? code : ERROR_CODES.INTERNAL_ERROR;
  err.status = STATUS[err.code] || 500;
  err.renderWorker = true;
  Object.assign(err, details);
  return err;
}

export const isWorkerFault = (err) => !!(err && err.renderWorker === true);

/** Serialise an error for the host <-> pool wire (Error objects do not survive JSON). */
export function errorPayload(err, fallbackCode = 'INTERNAL_ERROR') {
  const code = (err && err.code) || fallbackCode;
  const details = {};
  for (const [key, value] of Object.entries(err || {})) {
    if (['name', 'message', 'code', 'status', 'stack', 'renderWorker'].includes(key)) continue;
    if (value === undefined || typeof value === 'function') continue;
    details[key] = value;
  }
  return {
    code: ERROR_CODES[code] ? code : ERROR_CODES.INTERNAL_ERROR,
    message: String((err && err.message) || err || 'unknown render worker error'),
    ...details,
  };
}

/** Rebuild an error from the wire payload. */
export function errorFromPayload(payload, fallbackMessage = 'render worker failed') {
  const code = (payload && payload.code) || 'INTERNAL_ERROR';
  const { code: _c, message, ...details } = payload || {};
  return workerFault(code, String(message || fallbackMessage), details);
}

/** The one error the pure-Node path must produce (§10.2 WP3.1 acceptance 4). */
export function dependencyMissing(reason, details = {}) {
  return workerFault(
    'DEPENDENCY_MISSING',
    `RenderWorkerPool 需要 Electron（本机 dist，零 npm 依赖）：${reason}`,
    details,
  );
}
