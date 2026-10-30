// Compiled sources over HTTP (docs/DESIGN-BACKEND-V2.md §7.1 / §7.8, WP4.1).
//
//   GET  /api/sources                  registry + manifest + compile status
//   GET  /api/sources/<id>/base        base.json (§7.8.1) — 404 when missing/broken
//   POST /api/sources/<id>/compile     compile + write base.json, change nothing
//   POST /api/sources/<id>/apply       upsert the compiled elements, one transaction
//
// `compile` is deliberately *not* a project write: the snapshot lives under
// `.vdm/sources/<id>/` and §7.8.1 makes the compiler its only writer. `apply`
// goes through the one op path (`ctx.transact`), so it is rev-checked, logged
// and undoable like every other edit.
import { applyCompiled, compileSource, listSources, readBase } from '../../application/source-service.js';

const SOURCE_ROUTE = /^\/api\/sources\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(compile|apply|base)$/;

export function register(router, ctx) {
  const { json, readBody, transact, getProject, broadcast } = ctx;

  /** Every registered source, its manifest and whether base.json is usable. */
  router.get('/api/sources', async (req, res) => {
    const listed = await listSources({ project: getProject(), root: ctx.root });
    return json(res, 200, { ok: true, ...listed });
  });

  /** base.json of one source, validated (§7.8.1 "版本与降级"). */
  router.getMatch(SOURCE_ROUTE, async (req, res, { params }) => {
    const sourceId = params[1];
    const action = params[2];
    if (action !== 'base') {
      return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `GET /api/sources/<id>/${action} 不支持（compile / apply 用 POST）` });
    }
    const base = await readBase({ root: ctx.root, sourceId });
    return json(res, base.ok ? 200 : 404, {
      ok: base.ok, source: sourceId, snapshot: base.snapshot, problems: base.problems,
    });
  });

  /** Compile one source: writes base.json, touches no project state. */
  router.postMatch(SOURCE_ROUTE, async (req, res, { params }) => {
    const sourceId = params[1];
    const action = params[2];
    if (action === 'compile') {
      const compiled = await compileSource({ project: getProject(), sourceId, root: ctx.root });
      broadcast('sources', { action: 'compile', source: sourceId, hash: compiled.hash });
      return json(res, 200, {
        ok: true,
        source: compiled.source,
        runtime: compiled.runtime,
        entry: compiled.entry,
        hash: compiled.hash,
        builtAt: compiled.builtAt,
        compiler: compiled.compiler,
        base: compiled.base,
        nodes: compiled.nodes,
        elements: compiled.elements,
        warnings: compiled.warnings,
      });
    }
    if (action !== 'apply') {
      return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `POST /api/sources/<id>/${action} 不支持` });
    }
    const body = await readBody(req);
    const applied = await applyCompiled({ project: getProject(), sourceId, root: ctx.root });
    const result = await transact({ ops: [applied.op], ...ctx.transactionOptions(body) }, 'ui');
    broadcast('sources', { action: 'apply', source: sourceId, hash: applied.hash, rev: result.rev });
    return json(res, 200, {
      ok: true,
      source: sourceId,
      hash: applied.hash,
      elements: applied.elements.length,
      base: applied.base,
      transaction: result,
      project: await ctx.projects.read(),
    });
  });
}
