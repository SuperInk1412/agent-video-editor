import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pruneCache } from '../engine/cache.js';

test('cache pruning honors budget and cannot remove history, render artifacts or source media', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-gc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['.vdm/cache/src/one', '.vdm/cache/src/two', '.vdm/renders', 'media']) await fs.mkdir(path.join(root, directory), { recursive: true });
  for (const file of ['.vdm/cache/src/one/a.png', '.vdm/cache/src/two/b.png', '.vdm/transactions.json', '.vdm/renders/master.mp4', 'media/source.mp4']) await fs.writeFile(path.join(root, file), 'retained');
  const preview = await pruneCache(root, { maxBytes: 8, dryRun: true });
  assert.equal(preview.removed.length, 1);
  assert.equal((await fs.readdir(path.join(root, '.vdm/cache/src'))).length, 2);
  const result = await pruneCache(root, { maxBytes: 0 });
  assert.equal(result.bytesAfter, 0);
  for (const file of ['.vdm/transactions.json', '.vdm/renders/master.mp4', 'media/source.mp4']) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), 'retained');
});
