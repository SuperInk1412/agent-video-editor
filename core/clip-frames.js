// Frame-align existing clip windows (start + end), without touching keyframes.
//
// Older projects were authored before the timeline stored frame-quantized
// times: a 30 fps project can contain 1.68s / 0.397s clip spans, camera clip
// ranges copied from those, and HUD/camfeed clips derived from camera ranges.
// Once the timeline started snapping drags, those untouched clips still had
// off-grid heads/tails. This pass runs on load, is idempotent, and moves each
// clip's start and end to the nearest frame boundary; the duration is
// recomputed so both edges stay on the grid.
//
// Keyframes are deliberately left alone (they are absolute timeline times and
// the plan forbids bulk-rewriting old keys). Audio clip windows are included:
// a sub-frame shift keeps the mix deterministic and the same rule for every
// timeline block is easier to reason about.
import { frameKeyTimeForFrame, normalizeFps } from './keyframe-edit.js';

const round3 = (v) => Math.round(Number(v) * 1000) / 1000;

/** Time of the nearest frame boundary (stored as the frame's left edge + ceil ms). */
function snapTime(t, fps) {
  const rate = normalizeFps(fps);
  const frames = Math.round(Math.max(0, Number(t) || 0) * rate);
  return frameKeyTimeForFrame(frames, rate);
}

/**
 * Align every element / 3D object / camera clip window to the project's frame
 * grid. Returns the number of hosts changed (0 = already aligned).
 */
export function snapClipFrames(project) {
  if (!project || typeof project !== 'object') return 0;
  const fps = normalizeFps(project.meta?.fps);
  const frame = 1 / fps;
  let changed = 0;
  const fix = (host) => {
    if (!host || typeof host !== 'object') return;
    const rawStart = Number(host.start);
    const rawDuration = Number(host.duration);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawDuration)) return;
    const start = snapTime(rawStart, fps);
    let end = snapTime(rawStart + rawDuration, fps);
    if (end <= start + 1e-9) end = frameKeyTimeForFrame(Math.round(start * fps) + 1, fps);
    const duration = round3(end - start);
    if (Math.abs(start - rawStart) <= 1e-9 && Math.abs(duration - rawDuration) <= 1e-9) return;
    host.start = start;
    host.duration = duration;
    changed++;
  };
  for (const el of project.elements || []) fix(el);
  for (const obj of project.scene?.objects || []) fix(obj);
  for (const cam of project.cameras || []) fix(cam);
  if (project.camera) fix(project.camera);
  return changed;
}
