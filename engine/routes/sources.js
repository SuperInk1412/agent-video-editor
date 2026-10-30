// Compiled sources over HTTP (docs/DESIGN-BACKEND-V2.md §7.1 / §7.8, WP4.1 / WP4.3;
// source view §2.2 and 载入外部修改 §7.1 of docs/DESIGN-WP3.6-4.6-UI.md, WP3.6b).
//
//   GET  /api/sources                  registry + manifest + compile status
//   GET  /api/sources/<id>/base        base.json (§7.8.1) — 404 when missing/broken
//   GET  /api/sources/<id>/files       the `sources/<id>/` copy an editor writes
//   POST /api/sources/<id>/check       contract check of a candidate source
//   POST /api/sources/<id>/compile     compile + write base.json, change nothing
//   POST /api/sources/<id>/apply       upsert the compiled elements, one transaction
//   POST /api/sources/<id>/writeback   one edited value back into the source (§7.8.3)
//
// `compile` is deliberately *not* a project write: the snapshot lives under
// `.vdm/sources/<id>/` and §7.8.1 makes the compiler its only writer. `apply`
// and `writeback` go through the one op path (`ctx.transact`), so they are
// rev-checked, logged and undoable like every other edit.
//
// `files` / `check` are read-only on purpose: 载入外部修改 diffs the copy and
// then submits `sourceWrite` ops through /api/ops, so the write stays one
// transaction with one undo step (and this file gains no second write path).
//
// A `writeback` that cannot reach the source is **not** an error response:
// §7.8.3 returns `{ ok: false, fallback: 'editor-layer', reason }` with status
// 200 so the caller keeps the edit in the editor layer instead of losing it.
import {
  applyCompiled, checkSourceFiles, compileSource, elementForNode, listSources, readBase,
  readSourceCopy, writeBack, writeBackOps,
} from '../../application/source-service.js';
import { sourceRecord } from '../../core/code-layer.js';
import { isSourcePath } from '../../core/source-eval.js';

const SOURCE_ROUTE = /^\/api\/sources\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(compile|apply|base|files|check|writeback)$/;

export function register(router, ctx) {
  const { json, readBody, transact, getProject, broadcast } = ctx;

  /**
   * §7.8.3's degradation, on request (`fallback: 'editor-layer'`): keep the
   * value in the editor layer and take the path over, in one transaction. The
   * source is not touched — "失败时源、元素、快照都不动" refers to the *source*
   * transaction; this is the caller's documented follow-up (§7.4 "自动降级为
   * 编辑器层，不会丢失修改").
   */
  async function editorLayerFallback({ sourceId, nodeId, path, value, body }) {
    const element = elementForNode({ project: getProject(), sourceId, nodeId });
    if (!element) return null;
    const override = isSourcePath(path);
    const ops = [{ op: 'set', id: element.id, path, value }];
    if (override) ops.push({ op: 'set', id: element.id, path: 'sourceMode', value: { ...(element.sourceMode || {}), [path]: 'override' } });
    const transaction = await transact({ ops, ...ctx.transactionOptions(body) });
    broadcast('sources', { action: 'writeback-fallback', source: sourceId, node: nodeId, path, rev: transaction.rev });
    return { element: element.id, override, transaction };
  }

  /** Every registered source, its manifest and whether base.json is usable. */
  router.get('/api/sources', async (req, res) => {
    const listed = await listSources({ project: getProject(), root: ctx.root });
    return json(res, 200, { ok: true, ...listed });
  });

  /** base.json of one source, validated (§7.8.1 "版本与降级"), or the disk copy. */
  router.getMatch(SOURCE_ROUTE, async (req, res, { params }) => {
    const sourceId = params[1];
    const action = params[2];
    if (action === 'files') {
      const copy = await readSourceCopy({ root: ctx.root, sourceId });
      // A source nobody opened in an editor outside the app has no copy at all:
      // that is a state the UI shows, not an error the fetch should throw on.
      return json(res, 200, { ok: copy.ok, ...copy });
    }
    if (action !== 'base') {
      return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `GET /api/sources/<id>/${action} 不支持（compile / apply / check / writeback 用 POST）` });
    }
    const base = await readBase({ root: ctx.root, sourceId });
    return json(res, base.ok ? 200 : 404, {
      ok: base.ok, source: sourceId, snapshot: base.snapshot, problems: base.problems,
    });
  });

  /** Compile one source, check a candidate, or apply the compiled elements. */
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
    if (action === 'check') {
      const body = await readBody(req);
      const registered = sourceRecord(getProject(), sourceId);
      const runtime = String(registered?.manifest?.runtime ?? '') || null;
      let files = Array.isArray(body.files) ? body.files : null;
      let manifest = body.manifest === undefined ? undefined : body.manifest;
      let manifestText = typeof body.manifestText === 'string' ? body.manifestText : (body.manifestText === null ? null : undefined);
      let scannedAt = null;
      // No candidate in the body: check the on-disk copy, which is what
      // 载入外部修改 is about.
      if (!files) {
        const copy = await readSourceCopy({ root: ctx.root, sourceId });
        files = copy.files;
        scannedAt = copy.scannedAt;
        if (manifest === undefined) manifest = copy.manifest;
        if (manifestText === undefined) manifestText = copy.manifestText;
      }
      // A copy without manifest.json does not change the manifest: the check
      // then runs against the registered one (the project keeps it).
      if ((manifest === undefined || manifest === null) && (manifestText === undefined || manifestText === null)) {
        manifest = registered?.manifest ?? null;
      }
      const verdict = checkSourceFiles({
        sourceId,
        manifest: manifest === undefined ? null : manifest,
        manifestText: manifestText === undefined ? null : manifestText,
        files,
        runtime,
      });
      return json(res, 200, { ok: verdict.ok, ...verdict, copy: scannedAt ? { scannedAt } : null });
    }
    if (action === 'apply') {
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
    }
    if (action !== 'writeback') {
      return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `POST /api/sources/<id>/${action} 不支持` });
    }
    // ---- write back one value (§7.8.3, WP4.3) ----
    const body = await readBody(req);
    const nodeId = body.nodeId ?? body.node;
    const written = await writeBack({
      project: getProject(),
      sourceId,
      nodeId,
      path: body.path,
      value: body.value,
      actorId: typeof body.actorId === 'string' ? body.actorId : null,
      root: ctx.root,
    });
    if (!written.ok) {
      const wantsFallback = body.fallback === 'editor-layer' || body.fallback === true;
      const editorLayer = wantsFallback
        ? await editorLayerFallback({ sourceId, nodeId, path: written.path, value: written.value, body })
        : null;
      return json(res, 200, {
        ...written, source: sourceId, node: nodeId,
        ...(editorLayer ? { editorLayer } : {}),
      });
    }
    // Steps (1)+(2) of §7.8.3's transaction: the source text and the element
    // mirror, one op list = one rev = one undo step.
    const ops = writeBackOps({ project: getProject(), sourceId, nodeId, result: written });
    const transaction = await transact({ ops, ...ctx.transactionOptions(body) }, 'ui');
    // Step (3): refresh base.json + hash. Allowed to lag (§7.8.3), so a compile
    // problem is reported, not turned into a failed write-back.
    let compiled = null;
    try {
      const fresh = await compileSource({ project: getProject(), sourceId, root: ctx.root });
      compiled = { hash: fresh.hash, builtAt: fresh.builtAt, base: fresh.base, nodes: fresh.nodes.length };
    } catch (error) {
      compiled = { error: error.message };
    }
    broadcast('sources', { action: 'writeback', source: sourceId, node: nodeId, path: written.path, rev: transaction.rev });
    return json(res, 200, {
      ...written, source: sourceId, node: nodeId, transaction, compiled,
      project: await ctx.projects.read(),
    });
  });
}
