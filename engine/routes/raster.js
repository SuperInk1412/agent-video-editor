// Raster frames of code layers (docs/DESIGN-BACKEND-V2.md §5/§6, WP3.3).
//
//   GET /api/raster?source=<id>&frame=<n>&w=<px>&h=<px>&params=<json>&seed=<n>
//                                  [&mode=live|bake]   ->  image/png, no-store
//
// The preview never runs user code: one frame of a `code` source comes out of
// the single rasteriser — engine/render-workers/pool.js — through this route.
// The pool is spawned lazily on the first request and closed with the server
// (`closeRasterPool`), which is why it lives in `ctx.rasterPool`, not at module
// scope: two engines in one process must not share one worker pool.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSafeSourceId } from '../../core/code-layer.js';
import { createRenderPool } from '../render-workers/pool.js';
import { cacheKey, readCachedFrame, readManifest, resolveParams, runtimeKey, sourceSnapshot } from '../render-workers/cache.js';

/** HTTP status for a raster failure: the pool's own code->status table, else 500. */
const rasterStatus = (e) => e.status || (e.code === 'RASTER_NOT_CACHED' ? 404 : 500);

/**
 * Cache-only lookup for `mode=bake`: the key the pool would use, without
 * ever rendering (`bake` means "show cached frames only", §6.1).
 */
async function cachedRasterPath(ctx, { source, frame, fps, size, seed, params }) {
  const dir = path.join(ctx.root, 'sources', source);
  try {
    const [read, snapshot, versions] = await Promise.all([
      readManifest(dir, source), sourceSnapshot(dir), runtimeKey({ repoRoot: ctx.appDir }),
    ]);
    const key = cacheKey({
      snapshot, manifestRaw: read.raw, params: resolveParams(read.manifest, params),
      size, seed, frame, fps, versions,
    });
    const hit = await readCachedFrame(ctx.root, key, frame);
    return hit ? hit.pngPath : null;
  } catch {
    return null;
  }
}

/** Close the pool this engine opened, if any. Called from server close. */
export async function closeRasterPool(state) {
  const pool = state.current;
  state.current = null;
  if (pool) await pool.close().catch(() => {});
}

export function register(router, ctx) {
  const { json, log } = ctx;
  const poolFor = () => (ctx.rasterPool.current ||= createRenderPool({ root: ctx.root }));

  /**
   * One PNG of one code-layer frame, `image/png` + `Cache-Control: no-store`.
   * `live` renders on demand (the pool's own cache answers a repeat), `bake`
   * only reads `.vdm/cache/raster/` and 404s on a miss.
   */
  router.get('/api/raster', async (req, res, { url }) => {
    const q = url.searchParams;
    const fail = (status, code, error) => json(res, status, { error, code });
    const source = String(q.get('source') || '');
    if (!isSafeSourceId(source)) return fail(400, 'INVALID_ARGUMENT', 'source 必须是源 id（[A-Za-z0-9][A-Za-z0-9_-]{0,63}）');
    const frame = Number(q.get('frame') ?? 0);
    if (!Number.isInteger(frame) || frame < 0) return fail(400, 'INVALID_ARGUMENT', 'frame 必须是非负整数');
    const meta = ctx.getProject()?.meta || {};
    const dim = (name, fallback) => {
      const raw = q.get(name);
      const value = raw === null ? Number(fallback) : Number(raw);
      return Number.isInteger(value) && value > 0 && value <= 8192 ? value : null;
    };
    const width = dim('w', Number(meta.width) || 1920);
    const height = dim('h', Number(meta.height) || 1080);
    if (!width || !height) return fail(400, 'INVALID_ARGUMENT', 'w / h 必须是 1..8192 的整数');
    const fps = Number(q.get('fps') ?? (Number(meta.fps) || 24));
    if (!Number.isFinite(fps) || fps <= 0) return fail(400, 'INVALID_ARGUMENT', 'fps 必须是正数');
    const seed = Number(q.get('seed') ?? 0);
    if (!Number.isFinite(seed)) return fail(400, 'INVALID_ARGUMENT', 'seed 必须是数字');
    let params = {};
    const rawParams = q.get('params');
    if (rawParams) {
      try {
        params = JSON.parse(rawParams);
      } catch {
        return fail(400, 'INVALID_ARGUMENT', 'params 必须是 URL 编码的 JSON 对象');
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return fail(400, 'INVALID_ARGUMENT', 'params 必须是 JSON 对象');
      }
    }
    const mode = q.get('mode') === 'bake' ? 'bake' : 'live';
    const size = [width, height];
    try {
      let pngPath;
      if (mode === 'bake') {
        pngPath = await cachedRasterPath(ctx, { source, frame, fps, size, seed, params });
        if (!pngPath) return fail(404, 'RASTER_NOT_CACHED', `没有缓存的帧：${source} f${frame}`);
      } else {
        const out = await poolFor().render({
          sourceId: source, frame, fps, size, seed, params, useCache: true,
        });
        pngPath = out.pngPath;
      }
      const png = await fsp.readFile(pngPath);
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': png.length,
      });
      return res.end(png);
    } catch (e) {
      const status = rasterStatus(e);
      log[status >= 500 ? 'error' : 'warn']('raster frame failed', {
        source, frame, mode, size, error: e.message, code: e.code || null, hint: e.hint || undefined,
      });
      return fail(status, e.code || 'RASTER_FAILED', e.message);
    }
  });
}
