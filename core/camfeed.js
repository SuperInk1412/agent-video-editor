// Camera feeds: a 2D element (`type: "camfeed"`) that shows what a camera sees.
//
// Pure ESM, no `node:*` (shared by the renderer, the engine and the tests).
// Design: docs/DESIGN-CAMFEED-PARENTS.md.
//
//   el.feed = { camera: <camera id>, delay: 0 | 1 }
//
// - delay 0 (live): the element shows the source camera's picture of the same
//   frame. The source camera never sees its own live feed; when live feeds
//   would form a cycle across cameras (A films B's feed, B films A's feed) the
//   lower camera in `cameraOrder` loses sight of the higher one's feed.
// - delay 1 (previous frame): everyone can see it, the source camera included;
//   it shows the source picture of the previous frame (black on the first).
//
// Visibility is decided once per project, not per time, so the preview and the
// Blender pre-passes always agree on who films what.
//
// Which camera reaches the final picture is decided by the camera stack alone
// (order, clip range, visibility, opacity), never by feeds: a hidden camera or
// one outside its clip still feeds (docs/DESIGN-TRANSFORM-UNIFY.md §1.1).

export const FEED_TYPE = 'camfeed';
export const FEED_DELAYS = [0, 1];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Canonical feed record; unknown delays fall back to live. */
export function normalizeFeed(feed) {
  const f = isObj(feed) ? feed : {};
  const delay = Number(f.delay) === 1 ? 1 : 0;
  return { camera: f.camera == null ? '' : String(f.camera), delay };
}

/** Validation issues for an element's feed record ([] when fine). */
export function feedIssues(el, at = 'element') {
  const out = [];
  if (el?.type !== FEED_TYPE) return out;
  if (!isObj(el.feed)) return [{ path: `${at}.feed`, msg: 'camfeed element needs feed {camera, delay}' }];
  if (typeof el.feed.camera !== 'string' || !el.feed.camera) out.push({ path: `${at}.feed.camera`, msg: 'must be a camera id' });
  if (el.feed.delay !== undefined && !FEED_DELAYS.includes(el.feed.delay)) out.push({ path: `${at}.feed.delay`, msg: 'must be 0 or 1' });
  return out;
}

export const isFeed = (el) => el?.type === FEED_TYPE;

function cameraList(project) {
  if (Array.isArray(project?.cameras) && project.cameras.length) return project.cameras;
  return project?.camera ? [project.camera] : [];
}

function cameraOrderOf(project) {
  const cams = cameraList(project);
  const order = Array.isArray(project?.cameraOrder) && project.cameraOrder.length
    ? project.cameraOrder.filter((id) => cams.some((c) => c.id === id))
    : [];
  for (const c of cams) if (!order.includes(c.id)) order.push(c.id);
  return order;
}

/** Feed elements of a project whose source camera exists (hidden ones skipped). */
export function feedElements(project) {
  const ids = new Set(cameraList(project).map((c) => c.id));
  return (project?.elements || []).filter((el) => isFeed(el)
    && el.visible !== false
    && ids.has(normalizeFeed(el.feed).camera));
}

/**
 * Who films which feed. Returns
 *   { sources: camera ids to render before the picture, dependencies first,
 *     hidden: Map<cameraId, Set<elementId>> live feeds a camera must not draw }
 *
 * A camera that is not in `hidden` (e.g. the editor's free view) draws every feed.
 */
export function feedPlan(project) {
  const order = cameraOrderOf(project);
  const rank = new Map(order.map((id, i) => [id, i]));
  const feeds = feedElements(project);
  const live = feeds.filter((el) => normalizeFeed(el.feed).delay === 0);
  const sourcesOf = new Set(feeds.map((el) => normalizeFeed(el.feed).camera));

  // Candidate edges viewer -> source, one per (viewer camera, live feed).
  // Higher cameras (smaller rank) claim their edges first, so in a mutual pair
  // the lower camera renders first and cannot see the higher one's live feed.
  const edges = new Map(order.map((id) => [id, new Set()]));
  const hidden = new Map(order.map((id) => [id, new Set()]));
  const reaches = (from, to) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop();
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of edges.get(n) || []) stack.push(m);
    }
    return false;
  };
  const byRank = live.slice().sort((a, b) => (rank.get(normalizeFeed(a.feed).camera) ?? 0)
    - (rank.get(normalizeFeed(b.feed).camera) ?? 0) || String(a.id).localeCompare(String(b.id)));
  for (const viewer of order) {
    for (const el of byRank) {
      const src = normalizeFeed(el.feed).camera;
      if (src === viewer || reaches(src, viewer)) {
        hidden.get(viewer).add(el.id);
        continue;
      }
      edges.get(viewer).add(src);
    }
  }

  // Sources in dependency order (a source after everything it films live).
  const sources = [];
  const done = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    done.add(id);
    for (const dep of edges.get(id) || []) if (sourcesOf.has(dep)) visit(dep);
    sources.push(id);
  };
  for (const id of order) if (sourcesOf.has(id)) visit(id);
  return { sources, hidden };
}

/** Live feeds camera `camId` must skip under `plan` (empty set for unknown viewers). */
export function hiddenFeeds(plan, camId) {
  return plan?.hidden?.get(camId) || new Set();
}

/**
 * The project as source camera `camId` sees it: that camera alone, live for the
 * whole project (its clip range only limits where it is cut into the picture,
 * not what it films), and visible even when it is feed-only.
 */
export function sourceProject(project, camId) {
  const cam = cameraList(project).find((c) => c.id === camId);
  if (!cam) return null;
  const solo = { ...cam, visible: true };
  delete solo.start;
  delete solo.duration;
  return { ...project, cameras: [solo], cameraOrder: [solo.id], activeCameraId: solo.id, camera: solo };
}

/** Elements as camera `camId` films them: its hidden live feeds removed. */
export function elementsFor(project, plan, camId) {
  const skip = hiddenFeeds(plan, camId);
  if (!skip.size) return project.elements || [];
  return (project.elements || []).filter((el) => !skip.has(el.id));
}
