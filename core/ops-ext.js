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

export const EXT_OP_KINDS = [];

/**
 * @param {object} project
 * @param {object} op
 * @param {{fail:Function,deepMerge:Function,getPath:Function,setPath:Function,newId:Function,coerceValue:Function,findElement:Function,findObject:Function,findCamera:Function}} api
 * @returns {{changed: string[]}|null}
 */
export function applyExtOp(project, op, api) {
  switch (op?.op) {
    // case 'exampleOp': { ... return { changed: [...] }; }
    default:
      return null;
  }
}
