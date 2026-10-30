// Measurements (WP2.1): the report tool's pure read model.
//
//   POST /api/measure  { kind: stackAt | coverage | cutEdges | pxAt | diff | pixelCoverage }
//
// Read-only: nothing here writes the project, bumps a rev or touches a file.
import { stackAt, coverage, cutEdges, diff, pxAt, pixelCoverage } from '../../application/inspect-service.js';
import { fault } from '../../application/errors.js';

export function register(router, ctx) {
  const { json, readBody, projects } = ctx;

  router.post('/api/measure', async (req, res) => {
    const body = await readBody(req);
    const kind = String(body.kind || '');
    const fresh = await projects.read();
    const pick = (...keys) => Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
    let result;
    if (kind === 'stackAt') result = stackAt(fresh, body.t, pick('frame', 'point', 'camera', 'measureText'));
    else if (kind === 'coverage') result = coverage(fresh, pick('f0', 'f1', 'from', 'to', 'point', 'focus', 'camera', 'grid', 'measureText'));
    else if (kind === 'cutEdges') result = cutEdges(fresh);
    else if (kind === 'pxAt') result = pxAt(fresh, pick('x', 'y', 'frame', 'time', 'camera', 'measureText'));
    else if (kind === 'diff') result = diff(body.before, body.after, pick('limit'));
    else if (kind === 'pixelCoverage') result = await pixelCoverage(ctx.root, pick('elementId', 'element', 'f0', 'f1', 'from', 'to', 'camera'));
    else throw fault('INVALID_ARGUMENT', 'measure kind must be stackAt | coverage | cutEdges | pxAt | diff | pixelCoverage');
    return json(res, 200, { ok: true, kind, result });
  });
}
