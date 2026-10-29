import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withLock, paths, loadProject, atomicJson } from './storage.js';
import { assertUnlockedWrite, assertValidProject } from '../core/schema.js';
import { fault } from '../application/errors.js';

const stable = (value) => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item;
});
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');
const empty = () => ({ version: 1, head: null, undo: [], redo: [], entries: [], receipts: {} });

// A change set owns the transactions it commits
// (application/changeset-service.js). The write path itself is not told about
// it, so the id rides in an async context instead of a new transact() argument:
// whoever commits inside `withChangeSet(id, …)` gets it stamped on the journal
// entry, atomically with the commit.
const changeSetContext = new AsyncLocalStorage();

/** Bind the transactions committed inside `fn` to a change set id. */
export function withChangeSet(changesetId, fn) {
  if (typeof changesetId !== 'string' || !changesetId) throw fault('INVALID_ARGUMENT', 'change set id must be a nonempty string');
  return changeSetContext.run({ changesetId }, fn);
}

/** The change set id of the transaction being committed, if any. */
export const currentChangeSetId = () => changeSetContext.getStore()?.changesetId ?? null;

/** Newest change set records kept on disk; the oldest fall out first. */
export const CHANGESET_KEEP = 100;
export const CHANGESET_BYTES = 4 * 1024 * 1024;

function boundChangeSets(records) {
  const keep = [];
  let bytes = 0;
  for (let i = 0; i < records.length && keep.length < CHANGESET_KEEP; i++) {
    const size = JSON.stringify(records[i]).length * 2;
    if (keep.length && bytes + size > CHANGESET_BYTES) break;
    keep.push(records[i]);
    bytes += size;
  }
  return keep;
}

export class ProjectRepository {
  constructor(root, { checkpoint = async () => {} } = {}) {
    this.root = path.resolve(root);
    this.paths = paths(root);
    this.stateFile = path.join(this.paths.vdm, 'transactions.json');
    this.changeSetsFile = path.join(this.paths.vdm, 'changesets.json');
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
    const validState = (value) => value?.version === 1 && Array.isArray(value.undo) && Array.isArray(value.redo)
      && Array.isArray(value.entries) && value.receipts && typeof value.receipts === 'object' && !Array.isArray(value.receipts);
    if (state?.version !== 1 || (!state.pending && !validState(state))) throw fault('UNKNOWN_COMMIT_STATE', 'unsupported or malformed transaction journal');
    let current = await this.load();
    if (state.pending) {
      const pending = state.pending;
      if (!validState(pending.state) || hash(pending.project) !== pending.afterHash) throw fault('UNKNOWN_COMMIT_STATE', 'invalid prepared transaction');
      try { assertValidProject(pending.project); } catch { throw fault('UNKNOWN_COMMIT_STATE', 'invalid prepared project snapshot'); }
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
  history({ changesetId } = {}) {
    return withLock(this.root, async () => {
      const { state, current } = await this.restore();
      const entries = changesetId === undefined || changesetId === null
        ? state.entries
        : state.entries.filter((entry) => entry.changesetId === changesetId);
      return { rev: current?.rev || 0, undo: state.undo.length, redo: state.redo.length, entries };
    });
  }
  /** Newest first. A damaged registry reads as empty; the journal keeps the ids. */
  async readChangeSets() {
    let raw;
    try { raw = JSON.parse(await fs.readFile(this.changeSetsFile, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return []; throw e; }
    const list = Array.isArray(raw?.changesets) ? raw.changesets : [];
    return list.filter((record) => record && typeof record.id === 'string');
  }
  changesets() {
    return withLock(this.root, async () => this.readChangeSets());
  }
  async changeset(id) {
    if (typeof id !== 'string' || !id) throw fault('INVALID_ARGUMENT', 'change set id must be a nonempty string');
    return (await this.changesets()).find((record) => record.id === id) || null;
  }
  /** Upsert by id and re-bound the registry (newest first). */
  saveChangeset(record) {
    if (!record || typeof record.id !== 'string' || !record.id) throw fault('INVALID_ARGUMENT', 'change set record needs an id');
    return withLock(this.root, async () => {
      const list = await this.readChangeSets();
      const at = list.findIndex((item) => item.id === record.id);
      if (at >= 0) list.splice(at, 1);
      list.unshift(record);
      const keep = boundChangeSets(list);
      await atomicJson(this.changeSetsFile, { version: 1, changesets: keep });
      return record;
    });
  }
  transaction({ requestId, actorId, dryRun, intent, changesetId = currentChangeSetId() }, run) {
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
      // Element locks (D4): an agent may not write a host a human locked. The
      // check runs on the prepared snapshots, before anything is written.
      assertUnlockedWrite(current, output.next, { actorId });
      if (dryRun) return { ...output.result, replayed: false, project: output.next };
      // The entry is pushed by the project service; tag it with the change set
      // that asked for it so `history({changesetId})` can find it later.
      if (changesetId && output.result.didChange) {
        const entry = state.entries.find((item) => item.transactionId === output.result.transactionId);
        if (entry) entry.changesetId = changesetId;
      }
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
