// Change sets — docs/DESIGN-BACKEND-V2.md §8.1 (WP2.2).
//
// One accepted edit = one change set: the ops somebody asked for, the
// transaction(s) that committed them, the §8.3 difference report generated from
// the before/after projects by `inspect-service.js::diff` (never a second
// implementation), and a status:
//
//   proposed ──apply──▶ applied ──revert──▶ reverted
//      └──revert (discard)──▶ reverted      │
//                             conflict ─────┴──▶ needs-decision
//
// `preview()` runs the ops on an in-memory copy: no disk write, no revision, no
// journal growth — a shadow project. `revert()` inverts one property at a time
// and only when nobody touched it since; a property that changed, a key that
// vanished or a host that was deleted becomes a decision in `report.decisions`,
// never a forced write. `revertOne()` inverts a single entry.
//
// Writes go through `ProjectService.transact()` (P6: every write is a
// transaction) inside `withChangeSet(id, …)`, so `.vdm/transactions.json` records
// `changesetId` on exactly the transactions this change set committed.
import { randomUUID } from 'node:crypto';
import { applyOps } from '../core/ops.js';
import {
  assertUnlockedWrite, assertValidProject, cloneProject, normalizeProject,
} from '../core/schema.js';
import { pruneLinksForHost } from '../core/links.js';
import { assertSafeData } from '../core/json.js';
import { EDIT_SCHEMA } from '../core/contracts.js';
import { validateContract } from './validate-contract.js';
import { content } from './project-service.js';
import { diff } from './inspect-service.js';
import { fault } from './errors.js';
import { withChangeSet } from '../engine/project-repository.js';

export const CHANGESET_VERSION = 1;
export const CHANGESET_STATUS = Object.freeze(['proposed', 'applied', 'reverted', 'needs-decision']);

/** Entries kept inside one stored report. `truncated` says when it bit. */
const STORE_LIMIT = 5000;
/** Per-entry outcomes kept on a revert record. */
const OUTCOME_LIMIT = 500;
/**
 * Editor bookkeeping, not content: `loadProject` re-stamps the migration note
 * (and its `at`) on every read of a project the current code still upgrades, so
 * it would otherwise show up as a change in every report. `rev` and
 * `meta.savedAt` are already ignored by `diff` itself.
 */
const IGNORE_PATHS = ['meta.ui.migration'];

const clone = (value) => JSON.parse(JSON.stringify(value));
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** JSON with sorted keys: two bodies are equal when this string is. */
const stable = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
  : item));
const same = (a, b) => stable(a === undefined ? null : a) === stable(b === undefined ? null : b);

const KEYED_KINDS = { element: 'elements', camera: 'cameras', object: 'objects', segment: 'segments' };

/** The mutable array holding one kind of host, or null. */
function hostList(project, kind) {
  if (!project || !KEYED_KINDS[kind]) return null;
  if (kind === 'element') return Array.isArray(project.elements) ? project.elements : null;
  if (kind === 'camera') return Array.isArray(project.cameras) ? project.cameras : null;
  if (kind === 'segment') return Array.isArray(project.segments) ? project.segments : null;
  return Array.isArray(project.scene?.objects) ? project.scene.objects : null;
}

function findHost(project, kind, id) {
  const list = hostList(project, kind);
  return Array.isArray(list) ? list.find((host) => host?.id === id) || null : null;
}

function actorOf(input) {
  const actorId = input?.actorId ?? 'local';
  if (typeof actorId !== 'string' || !actorId || actorId.length > 200) throw fault('INVALID_ARGUMENT', 'invalid actor identity');
  return actorId;
}

const newId = () => `cs_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

// --------------------------------------------------------------- leaf paths
// `diff` addresses a property with `<key>[<sub>].<key>…` and, for keyframes,
// `keyframes[<t>].<property path>[.<field>]`. Everything else (path lists,
// pivots, links) is a whole leaf, because a change set replaces it whole.
const splitPath = (path) => String(path).split('.').filter((part) => part.length > 0);

function getAt(object, keys) {
  let cursor = object;
  for (const key of keys) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return { found: false };
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cursor.length) return { found: false };
      cursor = cursor[Number(key)];
    } else {
      if (!Object.hasOwn(cursor, key)) return { found: false };
      cursor = cursor[key];
    }
    if (cursor === undefined) return { found: false };
  }
  return { found: true, value: cursor };
}

function setAt(object, keys, value) {
  let cursor = object;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cursor === null || typeof cursor !== 'object') return false;
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cursor.length) return false;
      cursor = cursor[Number(key)];
    } else {
      if (!isRecord(cursor[key]) && !Array.isArray(cursor[key])) return false;
      cursor = cursor[key];
    }
  }
  const last = keys[keys.length - 1];
  if (cursor === null || typeof cursor !== 'object') return false;
  if (Array.isArray(cursor)) {
    if (!/^(0|[1-9]\d*)$/.test(last) || Number(last) > cursor.length) return false;
    cursor[Number(last)] = value;
    return true;
  }
  cursor[last] = value;
  return true;
}

function deleteAt(object, keys) {
  let cursor = object;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cursor === null || typeof cursor !== 'object') return false;
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cursor.length) return false;
      cursor = cursor[Number(key)];
    } else {
      if (!Object.hasOwn(cursor, key)) return false;
      cursor = cursor[key];
    }
  }
  const last = keys[keys.length - 1];
  if (cursor === null || typeof cursor !== 'object') return false;
  if (Array.isArray(cursor)) {
    if (!/^(0|[1-9]\d*)$/.test(last) || Number(last) >= cursor.length) return false;
    cursor.splice(Number(last), 1);
    return true;
  }
  if (!Object.hasOwn(cursor, last)) return false;
  delete cursor[last];
  return true;
}

/** `keyframes[4.2].style.size` → the key at t≈4.2 whose property is longest-prefix. */
const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

function locateKeyframe(host, path) {
  if (typeof path !== 'string' || !path.startsWith('keyframes[')) return null;
  const match = /^keyframes\[([^\]]+)\](?:\.(.*))?$/.exec(path);
  if (!match) return null;
  const t = Number(match[1]);
  if (!Number.isFinite(t)) return null;
  const rest = match[2] || '';
  const keys = Array.isArray(host?.keyframes) ? host.keyframes : [];
  // `diff` prints the key time rounded to 3 decimals (the same rounding ops
  // apply), so match on that value instead of on the raw float.
  const near = (key) => Math.abs(round3(key?.t) - t) <= 1e-9;
  let index = -1;
  let keyPath = '';
  for (let i = 0; i < keys.length; i++) {
    if (!near(keys[i])) continue;
    if (index < 0) { index = i; keyPath = String(keys[i].path ?? ''); }
    if (rest === '') break;
    const candidate = String(keys[i].path ?? '');
    if ((rest === candidate || rest.startsWith(`${candidate}.`)) && candidate.length >= keyPath.length) {
      index = i;
      keyPath = candidate;
    }
  }
  return { t, rest, keys, index, keyPath, field: rest && rest.startsWith(`${keyPath}.`) ? rest.slice(keyPath.length + 1) : null };
}

const looksLikeKey = (value) => isRecord(value) && Number.isFinite(Number(value.t)) && typeof value.path === 'string';

// ------------------------------------------------------------- revert planning
/** Every entry a revert can address: attribute changes first, then whole hosts. */
function revertEntries(record) {
  const out = [];
  for (const entry of record.changed || []) out.push({ section: 'changed', entry });
  for (const entry of record.added || []) out.push({ section: 'added', entry });
  for (const entry of record.removed || []) out.push({ section: 'removed', entry });
  return out;
}

function selectEntries(list, selector, length) {
  if (!selector) return list;
  if (selector.index !== undefined) {
    if (!Number.isInteger(selector.index) || selector.index < 0 || selector.index >= length) {
      throw fault('INVALID_ARGUMENT', `index ${selector.index} is outside the change set (${length} entries)`);
    }
    return [list[selector.index]];
  }
  const matched = list.filter((item) => (selector.entityId === undefined || item.entry.id === selector.entityId)
    && (selector.path === undefined || item.entry.path === selector.path));
  if (!matched.length) throw fault('INVALID_ARGUMENT', 'no change set entry matches that entityId/path');
  if (matched.length > 1) throw fault('INVALID_ARGUMENT', `${matched.length} entries match; pass index`);
  return matched;
}

const describe = (item) => ({
  section: item.section,
  kind: item.entry.kind ?? null,
  id: item.entry.id ?? null,
  path: item.entry.path ?? null,
});

/** Invert one attribute change on `project` (in place). */
function invertLeaf(project, entry, base) {
  const kind = entry.kind || 'element';
  const host = kind === 'project' ? project : findHost(project, kind, entry.id);
  if (!host) return { ...base, status: 'conflict', reason: 'host-deleted' };
  const kf = locateKeyframe(host, entry.path);
  if (kf) return invertKeyframe(host, kf, entry, base);
  const keys = splitPath(entry.path);
  if (!keys.length) return { ...base, status: 'conflict', reason: 'unreadable-path' };
  const current = getAt(host, keys);
  const value = current.found ? current.value : null;
  const write = () => (entry.before === null && entry.change === 'added'
    ? deleteAt(host, keys)
    : setAt(host, keys, entry.before));
  if (entry.change === 'removed') {
    if (!current.found) return write() ? { ...base, status: 'reverted' } : { ...base, status: 'conflict', reason: 'unwritable-path' };
    if (same(current.value, entry.before)) return { ...base, status: 'already' };
    return { ...base, status: 'conflict', reason: 'changed-since', expected: null, current: current.value };
  }
  // modified / added: the recorded "after" is what this change set wrote.
  if (current.found && same(current.value, entry.after)) {
    return write() ? { ...base, status: 'reverted' } : { ...base, status: 'conflict', reason: 'unwritable-path' };
  }
  // Already back to the old value (possibly because the change set was reverted
  // one entry at a time): nothing to do, and not a conflict.
  if (same(value, entry.before)) return { ...base, status: 'already' };
  if (!current.found) return { ...base, status: 'conflict', reason: 'path-deleted', expected: entry.after };
  return { ...base, status: 'conflict', reason: 'changed-since', expected: entry.after, current: current.value };
}

function invertKeyframe(host, loc, entry, base) {
  if (!Array.isArray(host.keyframes)) host.keyframes = [];
  // Whole-key add / remove (keyframeChanges keeps the key object for those).
  if (looksLikeKey(entry.before) || looksLikeKey(entry.after)) {
    const wanted = looksLikeKey(entry.before) ? entry.before : entry.after;
    if (loc.index < 0) {
      if (!looksLikeKey(entry.before)) return { ...base, status: 'already' };
      host.keyframes.push(clone(entry.before));
      host.keyframes.sort((a, b) => Number(a.t) - Number(b.t));
      return { ...base, status: 'reverted' };
    }
    const current = host.keyframes[loc.index];
    if (!same(current, wanted)) return { ...base, status: 'conflict', reason: 'changed-since', expected: wanted, current };
    if (looksLikeKey(entry.before)) return { ...base, status: 'already' };
    host.keyframes.splice(loc.index, 1);
    return { ...base, status: 'reverted' };
  }
  if (loc.index < 0) return { ...base, status: 'conflict', reason: 'key-deleted', expected: entry.after };
  const key = host.keyframes[loc.index];
  const field = loc.field;
  if (!field) return { ...base, status: 'conflict', reason: 'unreadable-path' };
  const found = Object.hasOwn(key, field);
  const value = found ? key[field] : null;
  if (entry.change === 'removed') {
    if (!found) { key[field] = entry.before; return { ...base, status: 'reverted' }; }
    if (same(key[field], entry.before)) return { ...base, status: 'already' };
    return { ...base, status: 'conflict', reason: 'changed-since', expected: null, current: key[field] };
  }
  if (found && same(key[field], entry.after)) {
    if (entry.change === 'added') delete key[field];
    else key[field] = entry.before;
    return { ...base, status: 'reverted' };
  }
  if (same(value, entry.before)) return { ...base, status: 'already' };
  if (!found) return { ...base, status: 'conflict', reason: 'path-deleted', expected: entry.after };
  return { ...base, status: 'conflict', reason: 'changed-since', expected: entry.after, current: key[field] };
}

/** Undo a whole host the change set created. */
function removeAddedHost(project, entry, base) {
  const list = hostList(project, entry.kind);
  if (!Array.isArray(list)) return { ...base, status: 'conflict', reason: 'no-host-collection' };
  const at = list.findIndex((host) => host?.id === entry.id);
  if (at < 0) return { ...base, status: 'already' };
  if (entry.object && !same(list[at], entry.object)) {
    return { ...base, status: 'conflict', reason: 'host-modified', expected: entry.object, current: list[at] };
  }
  list.splice(at, 1);
  pruneLinksForHost(project, entry.id);
  return { ...base, status: 'reverted' };
}

/** Put back a host the change set deleted. Incoming links were pruned then and
 *  are restored by their own entries (the `links` leaf of the linking host). */
function restoreRemovedHost(project, entry, base) {
  const list = hostList(project, entry.kind);
  if (!Array.isArray(list)) return { ...base, status: 'conflict', reason: 'no-host-collection' };
  if (!entry.object) return { ...base, status: 'conflict', reason: 'no-snapshot' };
  const at = list.findIndex((host) => host?.id === entry.id);
  if (at >= 0) {
    return same(list[at], entry.object) ? { ...base, status: 'already' } : { ...base, status: 'conflict', reason: 'id-reused' };
  }
  const index = Number.isInteger(entry.index) && entry.index >= 0 ? Math.min(entry.index, list.length) : list.length;
  list.splice(index, 0, clone(entry.object));
  return { ...base, status: 'reverted' };
}

function invertOne(project, item) {
  const base = describe(item);
  if (item.section === 'added') return removeAddedHost(project, item.entry, base);
  if (item.section === 'removed') return restoreRemovedHost(project, item.entry, base);
  return invertLeaf(project, item.entry, base);
}

/**
 * Build the inverted project and the per-entry outcome, without writing.
 * Entries return one of: reverted | already | conflict(reason, expected, current).
 */
function planRevert(project, record, selector) {
  if (!isRecord(project)) throw fault('INVALID_ARGUMENT', 'revert needs the current project');
  const all = revertEntries(record);
  const selected = selectEntries(all, selector, all.length);
  const next = cloneProject(project);
  const outcomes = selected.map((item) => invertOne(next, item));
  const reverted = outcomes.filter((outcome) => outcome.status === 'reverted').length;
  if (reverted) {
    if (Array.isArray(next.elements)) next.elements.sort((a, b) => a.z - b.z || a.start - b.start);
    normalizeProject(next);
    assertValidProject(next);
  }
  return {
    next,
    outcomes,
    writes: reverted > 0,
    counts: {
      reverted,
      already: outcomes.filter((outcome) => outcome.status === 'already').length,
      conflict: outcomes.filter((outcome) => outcome.status === 'conflict').length,
    },
  };
}

const decisionOf = (outcome, at) => ({
  kind: 'conflict',
  section: outcome.section,
  id: outcome.id,
  path: outcome.path,
  reason: outcome.reason,
  ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
  ...(outcome.current !== undefined ? { current: outcome.current } : {}),
  at,
});

function errorReason(error) {
  if (error?.code === 'REV_CONFLICT') return 'rev-conflict';
  if (error?.code === 'LOCKED') return 'locked';
  return 'rejected';
}

// --------------------------------------------------------------------- service
export class ChangeSetService {
  /**
   * @param service an `application/project-service.js::ProjectService` — the
   *   only write path (P6). `preview()` never calls it.
   */
  constructor(service, { now = () => new Date().toISOString() } = {}) {
    if (!service || typeof service.transact !== 'function' || typeof service.read !== 'function') {
      throw fault('INVALID_ARGUMENT', 'ChangeSetService needs a project service');
    }
    this.service = service;
    this.now = now;
  }

  get repository() { return this.service.repository; }

  // ---------------------------------------------------------------- proposals
  /**
   * Run `ops` on an in-memory copy of the current project. Nothing is written:
   * no project file, no revision, no journal entry, no change set record.
   */
  async preview(input = {}) {
    // A stored proposal previews at its own base revision unless the caller
    // says otherwise: "what would accepting it now do" passes expectedRev.
    if (input?.id !== undefined) {
      const record = await this.get(input.id);
      const simulated = await this.simulate({
        ops: record.ops, actorId: actorOf(input), expectedRev: input.expectedRev ?? record.baseRev,
      });
      return this.previewResponse(record, simulated, input);
    }
    const simulated = await this.simulate(input);
    return this.previewResponse(null, simulated, input);
  }

  /** Record a proposal (`status: proposed`) without touching the project. */
  async propose(input = {}) {
    const simulated = await this.simulate(input);
    const record = this.recordOf(simulated, {
      id: newId(), actorId: actorOf(input), intent: input.intent, ops: input.ops, status: 'proposed',
    });
    await this.repository.saveChangeset(record);
    return this.publicRecord(record);
  }

  /**
   * Commit a change set. `{ id }` applies a stored proposal at its base
   * revision; `{ ops, actorId, intent }` records and applies a new one in one
   * call. `dryRun` returns the preview and writes nothing.
   */
  async apply(input = {}) {
    if (!isRecord(input)) throw fault('INVALID_ARGUMENT', 'apply needs an object');
    const actorId = actorOf(input);
    const dryRun = input.dryRun === true;
    const hasId = typeof input.id === 'string' && input.id.length > 0;
    const hasOps = input.ops !== undefined;
    if (input.id !== undefined && !hasId) throw fault('INVALID_ARGUMENT', 'id must be a nonempty string');
    if (hasId && hasOps) throw fault('INVALID_ARGUMENT', 'apply takes either id or ops, not both');
    if (!hasId && !hasOps) throw fault('INVALID_ARGUMENT', 'apply needs id (a stored proposal) or ops (a new change set)');

    if (hasId) {
      const record = await this.get(input.id);
      if (record.status === 'reverted') throw fault('INVALID_ARGUMENT', `change set ${record.id} was already reverted; propose a new one`);
      if (record.status === 'applied') return { ...this.publicRecord(record), alreadyApplied: true };
      const simulated = await this.simulate({ ops: record.ops, actorId, expectedRev: input.expectedRev ?? record.baseRev });
      if (dryRun) return { ...this.previewResponse(record, simulated, input), dryRun: true };
      return this.commit(record, { actorId, requestId: input.requestId, expectedRev: simulated.before.rev, before: simulated.before });
    }

    const simulated = await this.simulate({ ops: input.ops, actorId, expectedRev: input.expectedRev });
    if (dryRun) return { ...this.previewResponse(null, simulated, input), dryRun: true };
    const record = this.recordOf(simulated, {
      id: newId(), actorId, intent: input.intent, ops: input.ops, status: 'proposed',
    });
    await this.repository.saveChangeset(record);
    return this.commit(record, { actorId, requestId: input.requestId, expectedRev: simulated.before.rev, before: simulated.before });
  }

  // -------------------------------------------------------------- decisions
  /**
   * Turn a committed change set into `status: 'needs-decision'` and attach the
   * decisions a human still has to make (WP4.4: source merge conflicts,
   * §7.8.4 "谁决定：人"). Nothing is written to the project: the transaction
   * that already ran keeps its provisional values (for a merge, `theirs`), and
   * `merge` is stored verbatim so a UI can offer `base` / `ours` / `theirs`.
   */
  async needsDecision(input = {}) {
    if (!isRecord(input)) throw fault('INVALID_ARGUMENT', 'needsDecision needs an object');
    const id = input.id;
    if (typeof id !== 'string' || !id) throw fault('INVALID_ARGUMENT', 'needsDecision needs a change set id');
    if (input.decisions !== undefined && !Array.isArray(input.decisions)) {
      throw fault('INVALID_ARGUMENT', 'decisions must be an array');
    }
    if (input.merge !== undefined && !isRecord(input.merge)) throw fault('INVALID_ARGUMENT', 'merge must be an object');
    const record = await this.get(id);
    if (record.status === 'reverted') throw fault('INVALID_ARGUMENT', `change set ${id} was already reverted`);
    const at = this.now();
    const decisions = (input.decisions || []).map((entry) => {
      if (!isRecord(entry)) throw fault('INVALID_ARGUMENT', 'each decision must be an object');
      return {
        kind: typeof entry.kind === 'string' && entry.kind ? entry.kind : 'conflict',
        reason: String(entry.reason ?? 'conflict'),
        id: entry.id ?? null,
        path: entry.path ?? null,
        ...(entry.message ? { message: String(entry.message) } : {}),
        at: entry.at ?? at,
      };
    });
    Object.assign(record, { status: 'needs-decision', updatedAt: at });
    record.report = record.report || {};
    record.report.decisions = [...(record.report.decisions || []), ...decisions];
    if (input.merge !== undefined) record.merge = input.merge;
    await this.repository.saveChangeset(record);
    return this.publicRecord(record);
  }

  // ------------------------------------------------------------------- revert
  /** Revert the whole change set, inverting only the untouched properties. */
  async revert(input = {}) {
    return this.revertEntries(input, null);
  }

  /** Revert one entry: `{ index }`, or `{ entityId, path }` to pick it by address. */
  async revertOne(input = {}) {
    const selector = input.index !== undefined
      ? { index: input.index }
      : (input.entityId !== undefined || input.path !== undefined ? { entityId: input.entityId, path: input.path } : null);
    if (!selector) throw fault('INVALID_ARGUMENT', 'revertOne needs index, or entityId and/or path');
    // Validate the address even when the record is already reverted, so a typo
    // never reports success.
    const entries = revertEntries(await this.get(input.id));
    selectEntries(entries, selector, entries.length);
    return this.revertEntries(input, selector);
  }

  async revertEntries(input, selector) {
    if (!isRecord(input)) throw fault('INVALID_ARGUMENT', 'revert needs an object');
    const actorId = actorOf(input);
    const record = await this.get(input.id);
    const dryRun = input.dryRun === true;

    // A proposal never wrote anything: rejecting it is a status change only.
    if (record.status === 'proposed') {
      if (selector) throw fault('INVALID_ARGUMENT', 'this change set was never applied; revert it as a whole to discard it');
      const decisions = [{ kind: 'info', reason: 'never-applied', id: null, path: null, at: this.now() }];
      if (dryRun) return { dryRun: true, id: record.id, status: record.status, writes: false, entries: [], conflicts: [], decisions };
      Object.assign(record, { status: 'reverted', updatedAt: this.now(), revertedAt: this.now() });
      record.revert = { at: this.now(), rev: null, transactions: [], reverted: 0, already: 0, conflicts: 0, entries: [], decisions };
      record.report.decisions = decisions;
      await this.repository.saveChangeset(record);
      return this.publicRecord(record);
    }
    if (record.status === 'reverted') return { ...this.publicRecord(record), alreadyReverted: true };
    if (record.recovered) {
      throw fault('INVALID_ARGUMENT', `change set ${record.id} lost its record; only its transactions survived, so what it changed is unknown`);
    }
    if (record.report?.truncated) {
      throw fault('INVALID_ARGUMENT', 'this change set was stored truncated; it cannot be reverted safely');
    }

    const before = await this.service.read();
    if (input.expectedRev !== undefined && input.expectedRev !== before.rev) {
      throw fault('REV_CONFLICT', 'project changed; read the latest revision before reverting', { currentRev: before.rev });
    }
    const plan = planRevert(before, record, selector);
    const decisions = plan.outcomes.filter((outcome) => outcome.status === 'conflict')
      .slice(0, OUTCOME_LIMIT).map((outcome) => decisionOf(outcome, this.now()));
    if (dryRun) {
      return {
        dryRun: true, id: record.id, status: record.status, currentRev: before.rev, writes: plan.writes,
        counts: plan.counts, entries: plan.outcomes.slice(0, OUTCOME_LIMIT), conflicts: decisions,
      };
    }

    if (!plan.writes) {
      this.finishRevert(record, { before, plan, decisions, tx: null, partial: selector !== null });
      await this.repository.saveChangeset(record);
      return this.publicRecord(record);
    }

    let tx;
    try {
      tx = await withChangeSet(record.id, () => this.service.transact({
        expectedRev: before.rev,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        command: { type: 'replace', project: plan.next },
      }, { actorId }));
    } catch (error) {
      Object.assign(record, { status: 'needs-decision', updatedAt: this.now() });
      record.report.decisions = [...decisions, {
        kind: 'conflict', reason: errorReason(error), message: error.message, id: null, path: null, at: this.now(),
      }];
      await this.repository.saveChangeset(record);
      throw error;
    }
    this.finishRevert(record, { before, plan, decisions, tx, partial: selector !== null });
    await this.repository.saveChangeset(record);
    return this.publicRecord(record);
  }

  finishRevert(record, { before, plan, decisions, tx, partial = false }) {
    const counts = plan.counts;
    // A one-entry revert leaves the rest of the change set applied, so the
    // status only becomes `reverted` when every entry is back to its old value
    // — either because this call undid the whole group or because the last
    // outstanding entry went through.
    let complete = counts.conflict === 0;
    if (partial && complete) {
      const after = tx?.project ?? plan.next;
      complete = planRevert(after, record, null).outcomes.every((outcome) => outcome.status === 'already');
    }
    Object.assign(record, {
      updatedAt: this.now(),
      status: counts.conflict ? 'needs-decision' : (complete ? 'reverted' : record.status),
      ...(complete ? { revertedAt: this.now() } : {}),
    });
    record.revert = {
      at: this.now(),
      rev: tx ? tx.rev : before.rev,
      transactions: tx?.transactionId ? [tx.transactionId] : [],
      partial,
      reverted: counts.reverted,
      already: counts.already,
      conflicts: counts.conflict,
      entries: plan.outcomes.slice(0, OUTCOME_LIMIT),
      decisions,
    };
    record.report.decisions = decisions;
  }

  // -------------------------------------------------------------------- reads
  /**
   * Newest-first summaries by default. `detail: true` returns the full public
   * records instead — the review panel and the timeline marks need `changed[]`
   * (which property, before, after), not just the counts.
   */
  async list({ status, actorId, limit = 50, offset = 0, detail = false } = {}) {
    if (status !== undefined && !CHANGESET_STATUS.includes(status)) {
      throw fault('INVALID_ARGUMENT', `status must be one of ${CHANGESET_STATUS.join(', ')}`);
    }
    const all = await this.repository.changesets();
    const matching = all.filter((record) => (status === undefined || record.status === status)
      && (actorId === undefined || record.actorId === actorId));
    const size = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)));
    const start = Math.max(0, Math.round(Number(offset) || 0));
    return {
      version: CHANGESET_VERSION,
      total: matching.length,
      count: Math.max(0, Math.min(size, matching.length - start)),
      changesets: matching.slice(start, start + size)
        .map((record) => (detail ? this.publicRecord(record) : this.summary(record))),
    };
  }

  async show(id, { limit = 200 } = {}) {
    const record = await this.get(id);
    const size = Math.max(1, Math.min(5000, Math.round(Number(limit) || 200)));
    const changed = Array.isArray(record.changed) ? record.changed : [];
    return {
      ...this.publicRecord(record),
      changed: changed.slice(0, size),
      changedTotal: changed.length,
      truncated: changed.length > size,
    };
  }

  /** Read one record; a lost registry is rebuilt from the journal's changesetId. */
  async get(id) {
    if (typeof id !== 'string' || !id) throw fault('INVALID_ARGUMENT', 'change set id must be a nonempty string');
    const record = await this.repository.changeset(id);
    if (record) return record;
    const { entries } = await this.repository.history({ changesetId: id });
    if (!entries.length) throw fault('CHANGESET_NOT_FOUND', `no change set ${id}`);
    return {
      version: CHANGESET_VERSION, id, status: 'applied', recovered: true,
      actorId: entries[entries.length - 1].actorId, intent: '', baseRev: entries[0].beforeRev,
      rev: entries[entries.length - 1].rev, transactions: entries.map((entry) => entry.transactionId),
      changed: [], added: [], removed: [],
      report: {
        version: 1, equal: false, before: { rev: entries[0].beforeRev, title: null },
        after: { rev: entries[entries.length - 1].rev, title: null }, total: 0, truncated: false,
        counts: { changed: 0, added: 0, removed: 0, byKind: {} }, added: [], removed: [],
        verification: { status: 'unverified', verified: 0, unverified: 0, skipped: 0, note: 'record lost; only the journal entries remain' },
        decisions: [{ kind: 'info', reason: 'registry-lost', id: null, path: null, at: this.now() }],
      },
    };
  }

  // ----------------------------------------------------------------- internals
  /** The shadow run every entry point shares; writes nothing. */
  async simulate({ ops, actorId = 'local', expectedRev } = {}) {
    if (!Array.isArray(ops) || !ops.length) throw fault('INVALID_ARGUMENT', 'a change set needs a nonempty ops array');
    assertSafeData(ops);
    validateContract({ ops }, { ...EDIT_SCHEMA, required: ['ops'] });
    assertEditableOps(ops);
    const before = await this.service.read();
    if (expectedRev !== undefined && expectedRev !== before.rev) {
      throw fault('REV_CONFLICT', 'project changed; read the latest revision before editing', { currentRev: before.rev });
    }
    const after = cloneProject(before);
    normalizeProject(after);
    applyOps(after, ops);
    assertValidProject(after);
    normalizeProject(after);
    // Locked hosts (D4): agents get LOCKED here, before a record exists, so a
    // refused proposal leaves no trace.
    assertUnlockedWrite(before, after, { actorId });
    const didChange = stable(content(before)) !== stable(content(after));
    const report = diff(before, after, { limit: STORE_LIMIT, ignore: IGNORE_PATHS });
    return { before, after, didChange, report };
  }

  previewResponse(record, simulated, input = {}) {
    const { before, after, didChange, report } = simulated;
    const afterRev = before.rev + (didChange ? 1 : 0);
    const response = {
      version: CHANGESET_VERSION,
      id: record?.id ?? null,
      status: record?.status ?? 'proposed',
      actorId: record?.actorId ?? actorOf(input),
      intent: record?.intent ?? String(input.intent ?? ''),
      baseRev: before.rev,
      rev: before.rev,
      afterRev,
      equal: !didChange,
      changed: report.changed,
      added: report.added,
      removed: report.removed,
      report: reportOf(report, { afterRev, decisions: record?.report?.decisions ?? [] }),
    };
    if (input.includeProject) response.project = after;
    return response;
  }

  recordOf(simulated, { id, actorId, intent, ops, status }) {
    const { before, after, didChange, report } = simulated;
    const at = this.now();
    const record = {
      version: CHANGESET_VERSION,
      id,
      actorId,
      intent: String(intent ?? '').slice(0, 512),
      status,
      createdAt: at,
      updatedAt: at,
      baseRev: before.rev,
      rev: null,
      afterRev: before.rev + (didChange ? 1 : 0),
      transactions: [],
      ops: clone(ops),
      changed: report.changed,
      added: enrich(report.added, after),
      removed: enrich(report.removed, before),
      report: reportOf(report, { afterRev: before.rev + (didChange ? 1 : 0) }),
    };
    return record;
  }

  async commit(record, { actorId, expectedRev, requestId, before }) {
    let tx;
    try {
      tx = await withChangeSet(record.id, () => this.service.transact({
        expectedRev,
        ...(requestId ? { requestId } : {}),
        ops: record.ops,
      }, { actorId }));
    } catch (error) {
      Object.assign(record, { status: 'needs-decision', updatedAt: this.now() });
      record.report.decisions = [...(record.report.decisions || []), {
        kind: 'conflict', reason: errorReason(error), message: error.message, id: null, path: null, at: this.now(),
      }];
      await this.repository.saveChangeset(record);
      throw error;
    }
    Object.assign(record, {
      status: 'applied',
      updatedAt: this.now(),
      appliedAt: this.now(),
      baseRev: before.rev,
      rev: tx.rev,
      transactions: tx.transactionId ? [tx.transactionId] : [],
      replayed: tx.replayed === true,
      noop: !tx.didChange,
    });
    if (!tx.replayed) {
      const report = diff(before, tx.project, { limit: STORE_LIMIT, ignore: IGNORE_PATHS });
      record.changed = report.changed;
      record.added = enrich(report.added, tx.project);
      record.removed = enrich(report.removed, before);
      record.report = reportOf(report, { afterRev: tx.rev, decisions: record.report.decisions || [] });
    }
    await this.repository.saveChangeset(record);
    return this.publicRecord(record);
  }

  /** The record as stored, minus the ops payload (the changed[] list is the summary). */
  publicRecord(record) {
    const { ops, ...rest } = record;
    return { ...rest, opsCount: Array.isArray(ops) ? ops.length : 0 };
  }

  summary(record) {
    return {
      id: record.id,
      actorId: record.actorId,
      intent: record.intent,
      status: record.status,
      baseRev: record.baseRev ?? null,
      rev: record.rev ?? null,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      transactions: Array.isArray(record.transactions) ? record.transactions : [],
      counts: {
        changed: Array.isArray(record.changed) ? record.changed.length : 0,
        added: Array.isArray(record.added) ? record.added.length : 0,
        removed: Array.isArray(record.removed) ? record.removed.length : 0,
      },
      decisions: record.report?.decisions?.length || 0,
      revert: record.revert
        ? { rev: record.revert.rev ?? null, reverted: record.revert.reverted, already: record.revert.already, conflicts: record.revert.conflicts, at: record.revert.at ?? null }
        : null,
    };
  }
}

/** Snapshot operations rewrite history wholesale; the edit path rejects them. */
function assertEditableOps(ops) {
  for (const op of ops) {
    if (op?.op === 'restoreProject' || op?.op === 'replaceTimeline') {
      throw fault('OP_INVALID', 'snapshot operations require an explicit project command');
    }
    if (op?.op === 'batch') assertEditableOps(op.ops || []);
  }
}

/** Whole hosts keep their body (and old index) so a revert can verify them. */
function enrich(entries, project) {
  return (entries || []).map((entry) => {
    const list = hostList(project, entry.kind);
    const at = Array.isArray(list) ? list.findIndex((host) => host?.id === entry.id) : -1;
    return { ...entry, index: at >= 0 ? at : null, object: at >= 0 ? clone(list[at]) : null };
  });
}

/** §8.3 report: the diff plus what has actually been verified (nothing yet). */
function reportOf(result, { afterRev, decisions = [] } = {}) {
  const { changed, ...rest } = result;
  return {
    ...rest,
    ...(afterRev !== undefined && rest.after ? { after: { ...rest.after, rev: afterRev } } : {}),
    verification: {
      status: 'unverified',
      verified: 0,
      unverified: changed.length,
      skipped: (rest.added?.length || 0) + (rest.removed?.length || 0),
      note: 'no evidence is attached here: render the affected frames (vdm_render_submit) and measure them (vdm_inspect_*), then record the result; this service never marks its own work verified',
    },
    decisions,
  };
}

/** `new ChangeSetService(projectService(root))` — one service per project root. */
export const changesetService = (service, options) => new ChangeSetService(service, options);
