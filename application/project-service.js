import { applyOps } from '../core/ops.js';
import { createProject, assertValidProject, normalizeProject, cloneProject } from '../core/schema.js';
import { assertSafeData, isRecord } from '../core/json.js';
import { fault } from './errors.js';
import { EDIT_SCHEMA } from '../core/contracts.js';
import { validateContract } from './validate-contract.js';

export const content = (project) => {
  if (!project) return null;
  const copy = cloneProject(project);
  delete copy.rev;
  delete copy.meta.savedAt;
  return copy;
};

/** One application write path; repository supplies locking and crash recovery. */
export class ProjectService {
  constructor(repository, { plan } = {}) { this.repository = repository; this.plan = plan; }
  read() { return this.repository.read(); }
  history() { return this.repository.history(); }

  async transact(input, { actorId = 'local' } = {}) {
    assertSafeData(input);
    if (!isRecord(input)) throw fault('INVALID_ARGUMENT', 'transaction must be an object');
    const { expectedRev, requestId, dryRun = false } = input;
    if (expectedRev !== undefined && (!Number.isSafeInteger(expectedRev) || expectedRev < 0)) throw fault('INVALID_ARGUMENT', 'expectedRev must be a nonnegative integer');
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 200)) throw fault('INVALID_ARGUMENT', 'requestId must be a nonempty string of at most 200 characters');
    if (typeof dryRun !== 'boolean') throw fault('INVALID_ARGUMENT', 'dryRun must be boolean');
    if (typeof actorId !== 'string' || !actorId || actorId.length > 200) throw fault('INVALID_ARGUMENT', 'invalid actor identity');
    const command = JSON.parse(JSON.stringify(input.command || { type: 'ops', ops: input.ops }));
    const normalized = JSON.parse(JSON.stringify({ command, ...(expectedRev !== undefined ? { expectedRev } : {}) }));
    return this.repository.transaction({ requestId, dryRun, actorId, intent: normalized }, async ({ current, state, id, at }) => {
      if (expectedRev !== undefined && expectedRev !== (current?.rev || 0)) throw fault('REV_CONFLICT', 'project changed; read the latest revision before editing', { currentRev: current?.rev || 0 });
      if (!current && command.type !== 'initialize') throw fault('PROJECT_NOT_FOUND', 'project does not exist');
      let next = current ? cloneProject(current) : createProject(command.options);
      let ops, historyAction = 'edit';
      switch (command.type) {
        case 'initialize':
          if (current) throw fault('PROJECT_EXISTS', 'project already exists');
          ops = [{ op: 'restoreProject', project: { ...next, meta: { ...next.meta, ...(command.audio ? { audio: command.audio } : {}) } } }];
          break;
        case 'ops':
          ops = command.ops;
          if (!Array.isArray(ops) || !ops.length) throw fault('INVALID_ARGUMENT', 'ops must be a nonempty array');
          validateContract({ ops }, { ...EDIT_SCHEMA, required: ['ops'] });
          { const check = (list) => {
            for (const op of list) {
              if (op?.op === 'restoreProject' || op?.op === 'replaceTimeline') throw fault('OP_INVALID', 'snapshot operations require an explicit project command');
              if (op?.op === 'batch') check(op.ops || []);
            }
          }; check(ops); }
          break;
        case 'replace':
          ops = [{ op: 'restoreProject', project: assertValidProject(command.project) }];
          break;
        case 'plan':
          if (!this.plan) throw fault('INVALID_ARGUMENT', 'storyboard planning is unavailable');
          ops = this.plan(current, command.options || {});
          break;
        case 'undo': case 'redo': {
          const source = state[command.type];
          if (!source.length) throw fault('HISTORY_EMPTY', `nothing to ${command.type}`);
          const target = source.pop();
          state[command.type === 'undo' ? 'redo' : 'undo'].push(cloneProject(current));
          ops = [{ op: 'restoreProject', project: target }];
          historyAction = command.type;
          break;
        }
        default: throw fault('INVALID_ARGUMENT', `unknown project command ${command.type}`);
      }
      const applied = applyOps(next, ops);
      assertValidProject(next);
      normalizeProject(next); // restore runtime aliases after JSON cloning
      const didChange = JSON.stringify(content(current)) !== JSON.stringify(content(next));
      if (didChange) {
        next.rev = (current?.rev || 0) + 1;
        next.meta.savedAt = at;
        if (historyAction === 'edit') {
          if (current) state.undo.push(cloneProject(current));
          state.redo = [];
        }
        state.undo = state.undo.slice(-80);
        state.redo = state.redo.slice(-80);
        state.entries.push({ transactionId: id, actorId, requestId, command: command.type, beforeRev: current?.rev || 0, rev: next.rev, at, changedIds: applied.changed });
        state.entries = state.entries.slice(-500);
      } else next = current;
      const result = { transactionId: didChange ? id : null, requestId: requestId || null,
        beforeRev: current?.rev || 0, rev: next?.rev || 0, didChange, dryRun,
        changedIds: didChange ? applied.changed : [], opResults: applied.results,
        undo: state.undo.length, redo: state.redo.length };
      if (dryRun) { result.rev = current?.rev || 0; result.transactionId = null; }
      return { next, state, result };
    });
  }
}
