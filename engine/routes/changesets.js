// Change sets (WP2.2 / WP2.5a): the review panel's read and write surface.
//
//   GET  /api/changesets          list (status / actorId / limit / offset / detail=1)
//   GET  /api/changesets/<id>     one record with its diff
//   POST /api/changesets          { action: propose | preview | apply | revert | revert-one }
//
// Every write goes through ChangeSetService over the one write path, as actorId
// 'ui' (a human pressed the button, so a locked element does not block it).
import { fault } from '../../application/errors.js';

export function register(router, ctx) {
  const { json, readBody, changesets, projects, adoptDisk, broadcast } = ctx;

  router.get('/api/changesets', async (req, res, { url }) => {
    const status = url.searchParams.get('status') || undefined;
    const actorId = url.searchParams.get('actorId') || undefined;
    const limit = url.searchParams.get('limit') || undefined;
    const offset = url.searchParams.get('offset') || undefined;
    // detail=1 returns full records (changed[]), not just the counts.
    const detail = url.searchParams.get('detail') === '1';
    return json(res, 200, { ok: true, ...await changesets.list({ status, actorId, limit, offset, detail }) });
  });
  router.getMatch(/^\/api\/changesets\/([A-Za-z0-9_.-]+)$/, async (req, res, { url, params }) => {
    return json(res, 200, { ok: true, changeset: await changesets.show(params[1], { limit: url.searchParams.get('limit') || undefined }) });
  });
  router.post('/api/changesets', async (req, res) => {
    const body = await readBody(req);
    const action = String(body.action || '');
    const actorId = 'ui';
    if (action === 'preview') {
      const preview = await changesets.preview({
        id: body.id, ops: body.ops, actorId,
        expectedRev: body.expectedRev, includeProject: body.includeProject === true,
      });
      return json(res, 200, { ok: true, ...preview });
    }
    let record;
    if (action === 'propose') {
      record = await changesets.propose({ ops: body.ops, actorId, intent: body.intent });
      broadcast('changeset', { action, record });
      return json(res, 200, { ok: true, changeset: record });
    }
    if (action === 'apply') {
      record = await changesets.apply({ id: body.id, ops: body.ops, actorId, intent: body.intent, expectedRev: body.expectedRev, requestId: body.requestId });
    } else if (action === 'revert') {
      record = await changesets.revert({ id: body.id, actorId, expectedRev: body.expectedRev });
    } else if (action === 'revert-one') {
      record = await changesets.revertOne({ id: body.id, actorId, index: body.index, entityId: body.entityId, path: body.path, expectedRev: body.expectedRev });
    } else {
      throw fault('INVALID_ARGUMENT', 'changeset action must be propose | preview | apply | revert | revert-one');
    }
    const fresh = await projects.read();
    adoptDisk(fresh, 'changeset', { transactionId: record.transactions?.[0] });
    broadcast('changeset', { action, record });
    return json(res, 200, { ok: true, changeset: record, project: fresh });
  });
}
