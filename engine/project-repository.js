import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withLock, paths, loadProject, atomicJson } from './storage.js';
import { cloneProject } from '../core/schema.js';
import { fault } from '../application/errors.js';

const stable = (value) => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item;
});
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');
const empty = () => ({ version: 1, head: null, undo: [], redo: [], entries: [], receipts: {} });

export class ProjectRepository {
  constructor(root, { checkpoint = async () => {} } = {}) {
    this.root = path.resolve(root);
    this.paths = paths(root);
    this.stateFile = path.join(this.paths.vdm, 'transactions.json');
    this.checkpoint = checkpoint;
  }
  async load() {
    try { return await loadProject(this.root); }
    catch (e) { if (e.message.startsWith('no project.vdm.json')) return null; throw e; }
  }
  async restore() {
    let state;
    try { state = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw fault('UNKNOWN_COMMIT_STATE', 'transaction journal is unreadable'); state = empty(); }
    let current = await this.load();
    if (state.pending) {
      const pending = state.pending;
      if (hash(current) !== pending.beforeHash && hash(current) !== pending.afterHash) throw fault('UNKNOWN_COMMIT_STATE', 'project does not match either side of pending commit');
      if (hash(current) === pending.beforeHash) await atomicJson(this.paths.file, pending.project);
      current = await this.load();
      state = pending.state;
      await atomicJson(this.stateFile, state);
    }
    // External compatible writers are visible to the same durable global history.
    if (current && state.head && !isDeepStrictEqual(current, state.head)) {
      state.undo.push(state.head);
      state.undo = state.undo.slice(-80);
      state.redo = [];
      state.entries.push({ transactionId: randomUUID(), actorId: 'disk', command: 'external', beforeRev: state.head.rev, rev: current.rev, at: new Date().toISOString(), changedIds: ['project'] });
      state.entries = state.entries.slice(-500);
    }
    state.head = current;
    return { current, state };
  }
  read() {
    return withLock(this.root, async () => {
      const { current } = await this.restore();
      if (!current) throw fault('PROJECT_NOT_FOUND', 'project does not exist');
      return current;
    });
  }
  history() {
    return withLock(this.root, async () => {
      const { state, current } = await this.restore();
      return { rev: current?.rev || 0, undo: state.undo.length, redo: state.redo.length, entries: state.entries };
    });
  }
  transaction({ requestId, actorId, dryRun, intent }, run) {
    return withLock(this.root, async () => {
      const { current, state } = await this.restore();
      const requestKey = requestId ? hash([actorId, requestId]) : null;
      const digest = hash(intent);
      const receipt = requestKey && state.receipts[requestKey];
      if (receipt && !dryRun) {
        if (receipt.digest !== digest) throw fault('REQUEST_ID_CONFLICT', 'requestId was already used for different input', { requestId });
        return { ...receipt.result, replayed: true, project: current };
      }
      const id = randomUUID();
      const output = await run({ current, state, id, at: new Date().toISOString() });
      if (dryRun) return { ...output.result, replayed: false, project: output.next };
      state.head = output.next;
      if (requestKey) state.receipts[requestKey] = { digest, result: output.result };
      const pending = { beforeHash: hash(current), afterHash: hash(output.next), project: output.next, state };
      // Prepared record contains the exact allocated IDs, result and history.
      // Recovery rolls forward the validated snapshot, never reruns operations.
      await atomicJson(this.stateFile, { version: 1, pending });
      await this.checkpoint('prepared');
      if (output.result.didChange) await atomicJson(this.paths.file, output.next);
      await this.checkpoint('project');
      await atomicJson(this.stateFile, state);
      await this.checkpoint('committed');
      return { ...output.result, replayed: false, project: output.next };
    });
  }
}
