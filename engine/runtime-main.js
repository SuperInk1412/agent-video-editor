import { startServer } from './server.js';
const index = process.argv.indexOf('--project');
try {
  const runtime = await startServer({ root: process.argv[index + 1], port: 0, attach: false });
  let exiting = false;
  const close = async () => { if (exiting) return; exiting = true; await runtime.close(); process.exit(0); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} catch (e) { console.error(e.message); process.exitCode = 1; }
