// Legacy v2 behaviours on a v3 pose: motion presets and fades.
//
// Migrated 2D elements keep `obj.legacy = { motion, punch, fadeIn, fadeOut }`
// so the new renderer can reproduce the old look until those are re-authored as
// keyframes. Motion deltas are screen-space pixels; here they become metres.
import { motionDelta, fadeMul } from './evaluate.js';
import { PX_PER_M, basisFromDir } from './scene.js';
import { evalCamera, normalizeCamera } from './camera.js';

/**
 * @param {object} pose  result of core/scene.js objectPose()
 * @param {object} obj   migrated v3 object (needs start/duration/legacy)
 * @param {number} t
 * @param {object} meta  project meta (width/height/beats)
 */
export function applyLegacy(pose, obj, t, meta = {}) {
  const leg = obj?.legacy;
  if (!leg) return pose;
  if (leg.sourceCamera) {
    const camera = normalizeCamera(leg.sourceCamera);
    const evaluated = evalCamera({ camera, meta }, t);
    const delta = evaluated.look.map((value, i) => value - evaluated.pos[i]);
    const length = Math.hypot(...delta) || 1;
    const dir = delta.map((value) => value / length);
    return { ...pose, pivot: evaluated.pos, worldPos: evaluated.pos, position: [0, 0, 0],
      scale: evaluated.scale, opacity: evaluated.opacity, dir, roll: evaluated.roll,
      basis: basisFromDir(dir, evaluated.roll), camera: evaluated };
  }
  let { pivot, scale, roll, opacity } = pose;

  if (leg.motion || leg.punch) {
    const md = motionDelta(
      { motion: leg.motion, punch: leg.punch || 0, start: obj.start, duration: obj.duration },
      t,
      meta,
    );
    if (md.x || md.y || md.scale !== 1 || md.rotation) {
      // screen px -> world metres; screen y is down, world y is up
      pivot = [pivot[0] + md.x / PX_PER_M, pivot[1] - md.y / PX_PER_M, pivot[2]];
      scale = [scale[0] * md.scale, scale[1] * md.scale, scale[2]];
      roll -= md.rotation; // new roll is the negative of the old 2D rotation
    }
  }

  if (leg.fadeIn || leg.fadeOut) {
    opacity *= fadeMul(
      { start: obj.start, duration: obj.duration, fadeIn: leg.fadeIn, fadeOut: leg.fadeOut },
      t,
    );
  }

  return { ...pose, pivot, scale, roll, opacity };
}
