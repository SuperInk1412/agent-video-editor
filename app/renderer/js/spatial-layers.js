// Re-export of core/layers.js (docs/DESIGN-BACKEND-V2.md WP0.1).
//
// The 2D-layer math (plane grouping, draw order, picking depth, plane matrices)
// moved into core/ so the frame IR builds the same picture the renderer does —
// core/ must not import the renderer, so the renderer imports core instead.
// This file stays so every existing `./spatial-layers.js` import (preview,
// engine/element-bake.js, tests) keeps working unchanged.
export * from '../../../core/layers.js';
