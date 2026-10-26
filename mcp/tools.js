import { EDIT_SCHEMA, OP_SCHEMA } from '../core/contracts.js';
import { validateContract } from '../application/validate-contract.js';
import { errorData, fault } from '../application/errors.js';
import { assertSafeData } from '../core/json.js';

const string = { type: 'string', minLength: 1, maxLength: 512 };
const integer = { type: 'integer', minimum: 0 };
const number = { type: 'number' };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pagination = { offset: integer, limit: { type: 'integer', minimum: 1, maximum: 500 } };
const editOptions = { expectedRev: integer, requestId: { ...string, maxLength: 200 }, dryRun: { type: 'boolean' } };
const tool = (name, description, inputSchema, method, readOnly = true, transform = (v) => v) => ({
  name, description, inputSchema, outputSchema: { type: 'object' },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false }, method, transform,
});

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
];

export function listTools() { return TOOLS.map(({ method, transform, ...entry }) => entry); }

export async function callTool(client, name, input = {}) {
  const entry = TOOLS.find((item) => item.name === name);
  if (!entry) throw fault('UNKNOWN_TOOL', `unknown tool ${name}`);
  try {
    assertSafeData(input);
    validateContract(input, entry.inputSchema);
    let result = await client.call(entry.method, entry.transform(input));
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
