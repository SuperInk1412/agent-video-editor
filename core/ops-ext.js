// Extension point for operations that do not belong in the core switch.
//
// `core/ops.js` falls back to `applyExtOp()` when it meets an unknown op kind,
// so feature modules (hierarchy, presets, media objects, …) can add operations
// without editing the big switch or the existing case names.
//
// Contract:
//   - export `EXT_OP_KINDS` (string[]) so OP_KINDS/CLI/docs stay in sync;
//   - `applyExtOp(project, op, api)` returns `{ changed: [ids...] }` when it
//     handled the op, or `null` to let core report "unknown op";
//   - do NOT import `core/ops.js` from here (that would be a cycle). Use the
//     `api` helpers instead:
//       { fail, deepMerge, getPath, setPath, newId, coerceValue,
//         findElement, findObject, findCamera }
//
// Ops added here obey the same rules as core ops: mutate the project in place,
// return the ids that changed, and stay deterministic.

import { HIERARCHY_OP_KINDS, applyHierarchyOp, ELEMENT_PARENT_OP_KINDS, applyElementParentOp } from './hierarchy.js';
import { LEGACY_PARENT_OP_KINDS, PARENT_STRENGTH_OP_KINDS, applyParentStrengthOp } from './parent-strength.js';

// The old 3D parent op names (objectParent, …) now write spatial parents
// (core/parent-strength.js); HIERARCHY_OP_KINDS keeps listing them.
export const EXT_OP_KINDS = [...new Set([...HIERARCHY_OP_KINDS, ...ELEMENT_PARENT_OP_KINDS, ...PARENT_STRENGTH_OP_KINDS])];

/**
 * @param {object} project
 * @param {object} op
 * @param {{fail:Function,deepMerge:Function,getPath:Function,setPath:Function,newId:Function,coerceValue:Function,findElement:Function,findObject:Function,findCamera:Function}} api
 * @returns {{changed: string[]}|null}
 */
export function applyExtOp(project, op, api) {
  if (LEGACY_PARENT_OP_KINDS.includes(op?.op) || PARENT_STRENGTH_OP_KINDS.includes(op?.op)) return applyParentStrengthOp(project, op, api);
  if (HIERARCHY_OP_KINDS.includes(op?.op)) return applyHierarchyOp(project, op, api);
  if (ELEMENT_PARENT_OP_KINDS.includes(op?.op)) return applyElementParentOp(project, op, api);
  return null;
}
