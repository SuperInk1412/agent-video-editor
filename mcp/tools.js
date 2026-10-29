import { EDIT_SCHEMA, OP_SCHEMA } from '../core/contracts.js';
import { validateContract } from '../application/validate-contract.js';
import { errorData, fault } from '../application/errors.js';
import { assertSafeData } from '../core/json.js';
import { ChangeSetService, CHANGESET_STATUS } from '../application/changeset-service.js';
import { projectService } from '../engine/projects.js';
import {
  coverage as inspectCoverage, cutEdges as inspectCutEdges, diff as inspectDiff,
  stackAt as inspectStackAt,
} from '../application/inspect-service.js';

const string = { type: 'string', minLength: 1, maxLength: 512 };
const integer = { type: 'integer', minimum: 0 };
const number = { type: 'number' };
const point = { type: 'array', items: number, minItems: 2, maxItems: 2 };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pagination = { offset: integer, limit: { type: 'integer', minimum: 1, maximum: 500 } };
const editOptions = { expectedRev: integer, requestId: { ...string, maxLength: 200 }, dryRun: { type: 'boolean' } };
const tool = (name, description, inputSchema, method, readOnly = true, transform = (v) => v) => ({
  name, description, inputSchema, outputSchema: { type: 'object' },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false }, method, transform,
});
/**
 * A measurement tool: read-only, answered by application/inspect-service.js on
 * the project the runtime hands back. It never goes through the edit path, so it
 * costs no revision and cannot conflict with the editor.
 */
const inspectTool = (name, description, inputSchema, inspect) => ({
  name, description, inputSchema, outputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inspect,
});
/**
 * A change set tool (docs/DESIGN-BACKEND-V2.md §8.1, WP2.2). It runs on this
 * project's own folder — `application/changeset-service.js` over the same
 * ProjectService the runtime uses, taking the project lock per transaction —
 * because a change set also keeps a record beside the journal. Writing one is a
 * normal edit: one transaction, one revision, the same LOCKED rule as
 * `vdm_project_apply_ops`.
 */
const changeSetTool = (name, description, inputSchema, changeset, readOnly = true) => ({
  name, description, inputSchema, outputSchema: { type: 'object' },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
  changeset,
});
const actorSchema = { type: 'string', minLength: 1, maxLength: 200 };
/** `apply` takes a stored proposal (id) or a new one (ops, same shape as an edit). */
const changeSetApplySchema = {
  type: 'object', additionalProperties: false, $defs: EDIT_SCHEMA.$defs,
  properties: {
    id: string,
    ops: { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/op' } },
    actorId: actorSchema,
    intent: { type: 'string', maxLength: 512 },
    expectedRev: integer,
    requestId: { ...string, maxLength: 200 },
    dryRun: { type: 'boolean' },
  },
};

export const TOOLS = [
  tool('vdm_capabilities', 'Read supported project models, edit operations, render limits and installed Blender availability.', schema(), 'capabilities'),
  tool('vdm_project_read', 'Read a revision-bound project section. Use summary first, then elements/cameras/objects with pagination; expectedRev prevents mixing revisions.', schema({ section: { enum: ['summary', 'project', 'elements', 'segments', 'cameras', 'objects', 'world'] }, segmentId: string, from: number, to: number, expectedRev: integer, ...pagination }), 'project.query'),
  tool('vdm_context_read', 'Read evaluated context at an absolute project time, including nearby beats, 2D elements, cameras, world and 3D objects.', schema({ time: { ...number, minimum: 0 }, segmentId: string }), 'project.context'),
  tool('vdm_project_apply_ops', 'Atomically edit the project. Read current rev first; submit expectedRev and a unique requestId. Reuse identical input when retrying. dryRun validates without committing. 2D units: pixels, y down; 3D: metres, y up; keyframe t: absolute seconds.', EDIT_SCHEMA, 'project.transact', false),
  tool('vdm_history_list', 'Read durable global project history and available undo/redo counts.', schema(), 'project.history'),
  tool('vdm_history_undo', 'Undo the most recent global transaction with a revision precondition. This can undo another editor’s most recent change.', schema(editOptions, ['expectedRev', 'requestId']), 'project.transact', false, (v) => ({ ...v, command: { type: 'undo' } })),
  tool('vdm_history_redo', 'Redo the most recently undone global transaction with a revision precondition.', schema(editOptions, ['expectedRev', 'requestId']), 'project.transact', false, (v) => ({ ...v, command: { type: 'redo' } })),
  tool('vdm_media_list', 'List available project media using relative paths and bounded pagination.', schema(pagination), 'media.list'),
  tool('vdm_media_probe', 'Probe duration, codecs, size and frame rate of a file inside the project.', schema({ src: string }, ['src']), 'media.probe'),
  tool('vdm_media_import', 'Copy files from the project or configured import directories into media/. Sources outside server-authorized roots are rejected.', schema({ files: { type: 'array', minItems: 1, maxItems: 100, items: string } }, ['files']), 'media.import', false),
  tool('vdm_render_submit', 'Queue a real Blender still or video from the specified revision. Returns jobId immediately after capturing inputs; poll job_get. Retrying identical requestId reuses the same job.', schema({
    kind: { enum: ['still', 'video'] }, time: { ...number, minimum: 0 }, from: { ...number, minimum: 0 }, to: { ...number, minimum: 0 },
    scale: { type: 'number', exclusiveMinimum: 0, maximum: 2 }, samples: { type: 'integer', minimum: 1, maximum: 512 }, crf: { type: 'number', minimum: 0, maximum: 51 }, expectedRev: integer, requestId: { ...string, maxLength: 200 },
  }, ['kind', 'expectedRev', 'requestId']), 'job.submit', false),
  tool('vdm_job_get', 'Read a render job by id, including sourceRev, stage, progress, error and artifact metadata.', schema({ id: string }, ['id']), 'job.get'),
  tool('vdm_job_list', 'List render jobs owned by this project runtime.', schema(), 'job.list'),
  tool('vdm_job_cancel', 'Request cancellation of a specific job. cancelling means its worker is still exiting; poll until cancelled. Completed jobs remain completed.', schema({ id: string }, ['id']), 'job.cancel', false),
  tool('vdm_artifact_read', 'Read completed artifact metadata; image=true returns a PNG image to inspect visually, limited to 8 MiB.', schema({ id: string, image: { type: 'boolean' } }, ['id']), 'artifact.read'),
  // Measurements over the frame IR (docs/DESIGN-BACKEND-V2.md §8.2, WP2.1).
  // Same functions as `vdm inspect …`, so both entries report the same numbers.
  inspectTool('vdm_inspect_stack', 'Read the far-to-near 2D draw order and per-item depth of one frame (core/layers.js::orderLayers, the renderer rule), plus which item owns a pixel. point is [x, y] in project pixels; omit it for the frame centre. Text boxes are estimated from the IR when not measured.', schema({
    time: { ...number, minimum: 0 }, camera: string, point,
  }, ['time']), 'stack'),
  inspectTool('vdm_inspect_coverage', 'Read per-frame coverage of one pixel and/or one item: which items cover the sampled point and who is in front. focus=<elementId> adds quad samples for that item (on screen / unoccluded). Geometry only: it cannot count rendered pixels.', schema({
    from: integer, to: integer, camera: string, focus: string, point, grid: { type: 'integer', minimum: 1, maximum: 31 },
  }, ['from', 'to']), 'coverage'),
  inspectTool('vdm_inspect_cut_edges', 'List element edges that miss a camera cut by less than maxGapFrames (default 1) — a tail that lives a fraction of a frame into the next shot is what space-bar playback shows and the export never draws. includeSpans also lists elements crossing a cut (normal for plates and audio).', schema({
    maxGapFrames: { ...number, minimum: 0, maximum: 100 }, includeSpans: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 1000 },
  }), 'cut_edges'),
  inspectTool('vdm_inspect_diff', 'Diff two project revisions as changed[{id,kind,path,before,after}] (docs/DESIGN-BACKEND-V2.md §8.3) for a change report. Omit one side to compare it with the live project; rev and meta.savedAt are ignored by default. before/after are full project objects (vdm_project_read section=project).', schema({
    before: { type: 'object' }, after: { type: 'object' }, ignore: { type: 'array', items: string, maxItems: 32 }, limit: { type: 'integer', minimum: 1, maximum: 10000 },
  }), 'diff'),
  // Change sets (docs/DESIGN-BACKEND-V2.md §8.1, WP2.2). A change set groups the
  // transactions of one accepted edit, keeps the §8.3 diff of what it changed and
  // can be reverted one property at a time without forcing a conflict.
  changeSetTool('vdm_changeset_list', 'List change sets newest first: id, actorId, intent, status, baseRev/rev, transaction ids, how many properties changed and how many decisions a revert left. Read-only.', schema({
    status: { enum: [...CHANGESET_STATUS] }, actorId: actorSchema, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: integer,
  }), 'list'),
  changeSetTool('vdm_changeset_show', 'Read one change set: status, the changed[{id,kind,path,before,after}] list from the §8.3 diff, counts, verification status and revert decisions. Read-only; ops are summarised as opsCount.', schema({
    id: string, limit: { type: 'integer', minimum: 1, maximum: 5000 },
  }, ['id']), 'show'),
  changeSetTool('vdm_changeset_apply', 'Apply one change set. Either id (a stored proposal, applied at its base revision) or ops (a new change set: same op contract as vdm_project_apply_ops) plus actorId and intent. expectedRev is a precondition, requestId makes a retry replay, dryRun validates and writes nothing. A host with locked:true rejects actorId agent:* with code LOCKED; ui/human/local may write it. Returns id, status, baseRev, rev, transactions, changed[] and the report.', changeSetApplySchema, 'apply', false),
  changeSetTool('vdm_changeset_revert', 'Revert a change set — the whole group by default, one entry with index (changed[] first, then added[], then removed[]) or with entityId and/or path. Only properties nobody touched since are inverted; a changed property, a deleted key or a deleted host becomes a decision in report.decisions and the status becomes needs-decision. dryRun reports the plan and writes nothing.', schema({
    id: string, index: integer, entityId: string, path: string, actorId: actorSchema,
    expectedRev: integer, requestId: { ...string, maxLength: 200 }, dryRun: { type: 'boolean' },
  }, ['id']), 'revert', false),
];

export function listTools() { return TOOLS.map(({ method, transform, inspect, changeset, ...entry }) => entry); }

/** The measurement half of callTool: the pure service runs on the live project. */
function runInspect(kind, project, input) {
  if (kind === 'stack') {
    return inspectStackAt(project, input.time, { camera: input.camera, point: input.point });
  }
  if (kind === 'coverage') {
    return inspectCoverage(project, {
      f0: input.from, f1: input.to, camera: input.camera, focus: input.focus, point: input.point, grid: input.grid,
    });
  }
  if (kind === 'cut_edges') {
    return inspectCutEdges(project, {
      maxGapFrames: input.maxGapFrames, includeSpans: input.includeSpans, limit: input.limit,
    });
  }
  if (kind === 'diff') {
    if (input.before === undefined && input.after === undefined) {
      throw fault('INVALID_ARGUMENT', 'vdm_inspect_diff needs before and/or after (the other side defaults to the live project)');
    }
    return inspectDiff(input.before ?? project, input.after ?? project, { limit: input.limit, ignore: input.ignore });
  }
  throw fault('INVALID_ARGUMENT', `unknown inspect tool ${kind}`);
}

/**
 * The change set half of callTool. It needs the project root the runtime
 * reports in `.vdm/app.json`; without one there is nothing to commit against.
 */
async function runChangeSet(client, action, input) {
  const root = client?.info?.root ?? client?.root ?? null;
  if (typeof root !== 'string' || !root) {
    throw fault('RUNTIME_UNAVAILABLE', 'change set tools need a project runtime (its info carries the project root)');
  }
  const service = new ChangeSetService(projectService(root));
  const actorId = input.actorId ?? 'agent:mcp';
  if (action === 'list') return service.list({ status: input.status, actorId: input.actorId, limit: input.limit, offset: input.offset });
  if (action === 'show') return service.show(input.id, { limit: input.limit });
  if (action === 'apply') {
    if (input.id !== undefined && input.ops !== undefined) throw fault('INVALID_ARGUMENT', 'vdm_changeset_apply takes either id or ops, not both');
    if (input.id === undefined && input.ops === undefined) throw fault('INVALID_ARGUMENT', 'vdm_changeset_apply needs id (a stored proposal) or ops (a new change set)');
    return service.apply({ ...input, actorId });
  }
  if (action === 'revert') {
    const payload = { id: input.id, expectedRev: input.expectedRev, requestId: input.requestId, actorId, dryRun: input.dryRun, path: input.path, entityId: input.entityId, index: input.index };
    const one = input.index !== undefined || input.entityId !== undefined || input.path !== undefined;
    return one ? service.revertOne(payload) : service.revert(payload);
  }
  throw fault('INVALID_ARGUMENT', `unknown change set tool ${action}`);
}

export async function callTool(client, name, input = {}) {
  const entry = TOOLS.find((item) => item.name === name);
  if (!entry) throw fault('UNKNOWN_TOOL', `unknown tool ${name}`);
  try {
    assertSafeData(input);
    validateContract(input, entry.inputSchema);
    let result = entry.inspect
      ? runInspect(entry.inspect, await client.call('project.read'), input)
      : entry.changeset
        ? await runChangeSet(client, entry.changeset, input)
        : await client.call(entry.method, entry.transform(input));
    if (Array.isArray(result)) result = { items: result };
    // Editing snapshots stay on the runtime; avoid returning the full project
    // for every small operation, especially on retried requests.
    if (entry.method === 'project.transact') { const { project, ...transaction } = result; result = transaction; }
    const blocks = [];
    if (name === 'vdm_render_submit') result = { ...result, jobId: result.id };
    if (name === 'vdm_artifact_read' && result.base64) {
      const { base64, ...artifact } = result;
      blocks.push({ type: 'image', mimeType: artifact.mimeType, data: base64 });
      result = artifact;
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }, ...blocks], structuredContent: result, isError: false };
  } catch (e) {
    const error = { error: errorData(e) };
    return { content: [{ type: 'text', text: JSON.stringify(error) }], structuredContent: error, isError: true };
  }
}

export const resourceDefinitions = [
  { uri: 'vdm://project/summary', name: 'project-summary', mimeType: 'application/json', description: 'Current project revision and summary' },
  { uri: 'vdm://project/schema', name: 'edit-schema', mimeType: 'application/json', description: 'Supported atomic editing contract' },
];

export async function readResource(client, uri) {
  if (uri === 'vdm://project/schema') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ edit: EDIT_SCHEMA, op: OP_SCHEMA }) }] };
  if (uri === 'vdm://project/summary') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.call('project.query', { section: 'summary' })) }] };
  const match = /^vdm:\/\/artifacts\/(job-[\da-f-]+)$/.exec(uri);
  if (!match) throw fault('INVALID_ARGUMENT', 'unknown resource URI');
  const artifact = await client.call('artifact.read', { id: match[1], image: true });
  return { contents: [{ uri, mimeType: artifact.mimeType, blob: artifact.base64 }] };
}
