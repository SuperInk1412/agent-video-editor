// Feature routes: one file per feature, each exporting `register(router, ctx)`.
//
// server.js builds `ctx` and calls these in order; nothing else imports them.
// Adding an endpoint for a new feature means adding a file here (plus one import
// in server.js) instead of editing the route tree that every other work package
// also edits (docs/DESIGN-BACKEND-V2.md §10.4.3).
export { register as projectRoutes } from './projects.js';
export { register as mediaRoutes } from './media.js';
export { register as jobRoutes } from './jobs.js';
export { register as agentRoutes } from './agent.js';
export { register as changesetRoutes } from './changesets.js';
export { register as reportRoutes } from './reports.js';
export { register as measureRoutes } from './measure.js';
export { register as rasterRoutes, closeRasterPool } from './raster.js';
export { register as fontRoutes } from './font.js';
export { register as sourceRoutes } from './sources.js';
export { register as eventRoutes } from './events.js';
export { createRouter } from './router.js';
