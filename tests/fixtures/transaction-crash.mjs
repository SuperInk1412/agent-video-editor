import { projectService } from '../../engine/projects.js';
const [root, stage] = process.argv.slice(2);
const service = projectService(root, { checkpoint: async (current) => { if (current === stage) process.exit(17); } });
await service.transact({ expectedRev: 1, requestId: 'killed-writer', ops: [{ op: 'addElement', element: { type: 'solid', duration: 1 } }] });
