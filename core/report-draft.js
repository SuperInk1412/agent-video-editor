// Report drafts — docs/DESIGN-WP2.5-REVIEW.md §10.4, WP2.5c.
//
// A report is how a human says "something is wrong here": a bag of attachments
// (elements, properties, keyframes, a time range, a screen region, a change set)
// plus symptom tags and one sentence. It is **not** an edit: it never enters the
// project, the undo history or a revision.
//
// The editor's selection pool (core/selection.js) stays homogeneous — it is the
// edit surface, and delete / move / the inspector all rely on that. A draft is
// deliberately heterogeneous, like attachments on a mail: everything in one
// place, nothing selected.
//
// Pure ESM, no DOM, no node:*: the renderer builds drafts, Node validates and
// stores them, and tests read the same functions.

export const REPORT_VERSION = 1;

/** Lifecycle of a stored report (§10.4-8). */
export const REPORT_STATUS = Object.freeze(['open', 'fixed', 'verified', 'dismissed']);

/**
 * What a draft can point at. §10.4-9 keeps cut points, audio/beats, global fx,
 * property links, code layers (R3), web sources (R4) and effect presets out of
 * this release; the data model does not grow for them until they can be shown.
 */
export const ATTACHMENT_KINDS = Object.freeze([
  'element', 'object', 'camera', 'property', 'keyframe', 'range', 'region', 'changeset',
]);

/** The user's words, not the engine's (§10.4-6). */
export const SYMPTOMS = Object.freeze([
  '看不见', '闪烁', '被挡住', '位置不对', '大小不对', '颜色不对', '没卡上拍', '预览和成片不一样', '其它',
]);

export const NOTE_MAX = 1000;
export const ATTACHMENT_MAX = 64;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message) => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });

function text(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

const int = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const round3 = (v) => Math.round(Number(v) * 1e3) / 1e3 + 0;
const round2 = (v) => Math.round(Number(v) * 1e2) / 1e2 + 0;

/**
 * One attachment, validated. `ref` is the stable address the UI uses to paint,
 * jump and remove it; `label` is what a human reads. Extra fields are per kind:
 *
 *   range     from, to            integer frames, both inclusive
 *   region    frame, rect         project pixels [x, y, w, h], y down
 *   property  host, path          host ref (`el_1`) + contract path (`style.size`)
 *   keyframe  host, path, t       t in project seconds (the contract's unit)
 */
export function normalizeAttachment(input) {
  if (!isObj(input)) throw bad('attachment must be an object');
  const kind = String(input.kind || '');
  if (!ATTACHMENT_KINDS.includes(kind)) throw bad(`unknown attachment kind: ${kind}`);
  const ref = text(input.ref, 300);
  if (!ref) throw bad('attachment needs a ref');
  const out = { kind, ref, label: text(input.label, 200) || ref };

  if (kind === 'range') {
    const from = int(input.from);
    const to = int(input.to);
    if (from == null || to == null) throw bad('range attachment needs integer from/to');
    out.from = Math.min(from, to);
    out.to = Math.max(from, to);
  } else if (kind === 'region') {
    const frame = int(input.frame);
    const rect = Array.isArray(input.rect) ? input.rect.map(Number) : null;
    if (frame == null || !rect || rect.length !== 4 || !rect.every(Number.isFinite)) {
      throw bad('region attachment needs frame and rect [x, y, w, h]');
    }
    out.frame = frame;
    out.rect = rect.map(round2);
  } else if (kind === 'property' || kind === 'keyframe') {
    out.host = text(input.host, 100);
    out.path = text(input.path, 200);
    if (!out.host || !out.path) throw bad(`${kind} attachment needs host and path`);
    if (kind === 'keyframe') {
      const t = Number(input.t);
      if (!Number.isFinite(t)) throw bad('keyframe attachment needs t');
      out.t = round3(t);
    }
  }
  return out;
}

/** A fresh draft, or `input` normalised: unknown kinds/tags are dropped, not thrown. */
export function normalizeDraft(input = {}) {
  const attachments = [];
  const seen = new Set();
  for (const raw of Array.isArray(input?.attachments) ? input.attachments : []) {
    let attachment;
    try {
      attachment = normalizeAttachment(raw);
    } catch {
      continue;
    }
    const key = `${attachment.kind}:${attachment.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attachments.push(attachment);
    if (attachments.length >= ATTACHMENT_MAX) break;
  }
  const tags = [];
  for (const raw of Array.isArray(input?.tags) ? input.tags : []) {
    const tag = text(raw, 40);
    if (SYMPTOMS.includes(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return { version: REPORT_VERSION, attachments, tags, note: text(input?.note, NOTE_MAX) };
}

export const createDraft = (input = {}) => normalizeDraft(input);

/** Append (or move to the end) one attachment; the same kind+ref never doubles. */
export function addAttachment(draft, attachment) {
  const base = normalizeDraft(draft);
  const next = normalizeAttachment(attachment);
  const key = `${next.kind}:${next.ref}`;
  const rest = base.attachments.filter((item) => `${item.kind}:${item.ref}` !== key);
  return { ...base, attachments: [...rest, next].slice(-ATTACHMENT_MAX) };
}

/** Drop one attachment by ref; an unknown ref leaves the draft unchanged. */
export function removeAttachment(draft, ref) {
  const base = normalizeDraft(draft);
  return { ...base, attachments: base.attachments.filter((item) => item.ref !== String(ref)) };
}

export function setTags(draft, tags) {
  const base = normalizeDraft(draft);
  return { ...base, tags: normalizeDraft({ ...base, tags }).tags };
}

export function setNote(draft, note) {
  const base = normalizeDraft(draft);
  return { ...base, note: text(note, NOTE_MAX) };
}

/** One line for the AI card and the report list: "报告 f150 · 闪烁 · 2 个附件". */
export function draftSummary(draft) {
  const d = normalizeDraft(draft);
  const first = d.attachments[0];
  const where = first?.kind === 'range' ? `f${first.from}–f${first.to}`
    : first?.kind === 'region' ? `f${first.frame} 区域`
      : first?.kind === 'keyframe' ? `关键帧 f${Math.round((first.t || 0) * 24)}`
        : first ? first.label : '无附件';
  const symptoms = d.tags.length ? d.tags.join(' / ') : '未标症状';
  return {
    title: `报告 ${where}`,
    subtitle: `${symptoms} · ${d.attachments.length} 个附件`,
    line: `报告 ${where} · ${symptoms} · ${d.attachments.length} 个附件`,
  };
}

/**
 * What to measure for this draft (§10.4-7 table), as descriptors the service
 * executes. Stable ids let a re-measure replace the same rows.
 *
 *   frame       this frame's item (world, size, opacity, camera, mode)
 *   coverage    per-frame visibility + occluders, for 看不见 / 闪烁
 *   stackAt     what is in front at a point, for 被挡住 on a region
 *   pairs       who is in front between two or more elements
 *   beatGap     frames to the nearest beat, for 没卡上拍 on a keyframe
 *   cutEdges    cut points inside the range
 *   blenderDiff background: render a Blender frame and diff it (needs a job)
 */
export function measurePlan(draft, { frame = 0, fps = 24, range = null } = {}) {
  const d = normalizeDraft(draft);
  const plan = [];
  const byKind = (kind) => d.attachments.filter((a) => a.kind === kind);
  const elements = byKind('element');
  const keys = byKind('keyframe');
  const regions = byKind('region');
  const ranges = byKind('range');
  const has = (...tags) => d.tags.some((tag) => tags.includes(tag));
  const span = ranges[0] || range || null;
  const f0 = span ? span.from : Math.max(0, Math.round(frame) - 10);
  const f1 = span ? span.to : Math.max(0, Math.round(frame) + 10);

  for (const element of elements) {
    plan.push({ id: `frame:${element.ref}`, kind: 'frame', opts: { frame, elementId: element.ref } });
  }
  if (elements.length && has('看不见', '闪烁')) {
    for (const element of elements) {
      plan.push({ id: `coverage:${element.ref}`, kind: 'coverage', opts: { f0, f1, focus: element.ref } });
    }
  }
  if (regions.length && has('被挡住')) {
    for (const region of regions) {
      const [x, y, w, h] = region.rect;
      plan.push({ id: `stack:${region.ref}`, kind: 'stackAt', opts: { frame: region.frame, point: [round2(x + w / 2), round2(y + h / 2)] } });
    }
  }
  if (elements.length >= 2) {
    plan.push({ id: 'pairs', kind: 'pairs', opts: { frame, ids: elements.map((a) => a.ref) } });
  }
  if (keys.length && has('没卡上拍')) {
    for (const key of keys) {
      plan.push({ id: `beat:${key.ref}`, kind: 'beatGap', opts: { t: key.t, fps } });
    }
  }
  if (span) plan.push({ id: 'cuts', kind: 'cutEdges', opts: {} });
  if (has('预览和成片不一样')) {
    plan.push({ id: 'blender', kind: 'blenderDiff', opts: { frame }, pending: true });
  }
  return plan;
}

/** True when every attachment a measurement needs is still in the draft. */
export function planMatches(plan, draft) {
  const d = normalizeDraft(draft);
  const refs = new Set(d.attachments.map((a) => a.ref));
  return (Array.isArray(plan) ? plan : []).every((step) => {
    const focus = step?.opts?.focus || step?.opts?.elementId;
    return !focus || refs.has(focus);
  });
}
