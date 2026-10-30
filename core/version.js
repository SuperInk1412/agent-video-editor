// Versions have separate lifecycles; editing rev is never a format version.
export const PROJECT_SCHEMA = 'vdm.project/1';
export const EDIT_SEMANTICS_VERSION = 1;
export const SCENE_MODEL_VERSION = 3;
export const RENDER_PLAN_VERSION = 3;
// Source compile snapshots (`.vdm/sources/<id>/base.json`): the frozen shape in
// docs/DESIGN-BACKEND-V2.md §7.8. Bump it when the snapshot format changes; old
// snapshots are recompiled, never migrated silently.
export const SOURCE_SNAPSHOT_VERSION = 1;
