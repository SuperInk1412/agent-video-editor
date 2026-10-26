// Opt-in compiled snapshots. Mutable callers keep the reference implementation;
// revision snapshots can compile once without per-frame filtering and sorting.
let compiled = new WeakMap();
export function compileTrack(keys, kind = 'channel') {
  if (!Array.isArray(keys)) return;
  let entry = compiled.get(keys);
  if (!entry) { entry = {}; compiled.set(keys, entry); }
  if (kind === 'element') {
    const paths = new Map();
    for (const key of keys) { if (!paths.has(key.path)) paths.set(key.path, []); paths.get(key.path).push(key); }
    for (const track of paths.values()) track.sort((a, b) => a.t - b.t);
    entry.element = paths;
  } else entry.channel = keys.filter((k) => k && Number.isFinite(Number(k.t)) && k.v !== undefined && k.v !== null).slice().sort((a, b) => Number(a.t) - Number(b.t));
}
export function compiledTrack(keys, kind) { return compiled.get(keys)?.[kind]; }
export function clearCompiledTracks() { compiled = new WeakMap(); }
export function compileProject(project) {
  for (const element of project.elements || []) compileTrack(element.keyframes, 'element');
  for (const object of [...project.cameras || [], ...project.scene?.objects || []]) for (const keys of Object.values(object.tracks || {})) compileTrack(keys);
  return project;
}

/** Return the segment beginning at the last key before t; exact key semantics stay at callers. */
export function segmentIndex(keys, t, inclusiveEnd = false) {
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inclusiveEnd ? keys[mid + 1].t < t : keys[mid + 1].t <= t) lo = mid + 1; else hi = mid;
  }
  return Math.min(lo, keys.length - 2);
}
