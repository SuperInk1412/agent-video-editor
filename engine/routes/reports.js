// Reports (WP2.5c): a file under `.vdm/reports/`, never project state, never a
// revision, never an undo step. The measurements are the WP2.1 ones.
//
//   GET  /api/reports                    list
//   POST /api/reports                    create from a draft
//   POST /api/reports/<id>/remeasure     re-run the measurements at the current rev
//   GET  /api/reports/<id>               read one
import { createReport, listReports, readReport, remeasureReport, saveReport } from '../../application/report-service.js';

export function register(router, ctx) {
  const { json, readBody, projects, broadcast } = ctx;

  router.get('/api/reports', async (req, res, { url }) => {
    return json(res, 200, { ok: true, ...await listReports(ctx.root, { limit: url.searchParams.get('limit') || undefined }) });
  });
  router.post('/api/reports', async (req, res) => {
    const body = await readBody(req);
    const report = createReport({
      project: await projects.read(), draft: body.draft ?? body,
      frame: body.frame, fps: body.fps, camera: body.camera, mode: body.mode,
    });
    await saveReport(ctx.root, report);
    broadcast('report', { action: 'create', report });
    return json(res, 200, { ok: true, report });
  });
  router.postMatch(/^\/api\/reports\/([A-Za-z0-9_.-]+)\/remeasure$/, async (req, res, { params }) => {
    const report = await remeasureReport({ root: ctx.root, project: await projects.read(), id: params[1] });
    broadcast('report', { action: 'remeasure', report });
    return json(res, 200, { ok: true, report });
  });
  router.getMatch(/^\/api\/reports\/([A-Za-z0-9_.-]+)$/, async (req, res, { params }) => {
    return json(res, 200, { ok: true, report: await readReport(ctx.root, params[1]) });
  });
}
