import { withLock } from '../../engine/storage.js';
await withLock(process.argv[2], async () => {
  console.log('LOCKED');
  await new Promise((resolve) => process.stdin.once('data', resolve));
});
