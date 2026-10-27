import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './storage.js';
import { fault } from '../application/errors.js';
import { readPath } from './path-policy.js';

/** Only regenerable cache entries are eligible; jobs, history and artifacts stay. */
export async function pruneCache(root, { maxBytes = 1024 * 1024 * 1024, dryRun = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || typeof dryRun !== 'boolean') throw fault('INVALID_ARGUMENT', 'invalid cache budget');
  const cache = await readPath(root, path.relative(root, paths(root).cache));
  const measure = async (file) => {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size;
    let size = 0;
    for (const name of await fs.readdir(file)) size += await measure(path.join(file, name));
    return size;
  };
  const entries = [];
  for (const name of await fs.readdir(cache).catch(() => [])) {
    const directory = path.join(cache, name);
    const stat = await fs.lstat(directory);
    const candidates = ['src', 'frames', 'jobs'].includes(name) && stat.isDirectory()
      ? (await fs.readdir(directory)).map((child) => path.join(directory, child)) : [directory];
    for (const file of candidates) {
      const meta = await fs.lstat(file);
      if (!meta.isSymbolicLink()) entries.push({ file, bytes: await measure(file), at: meta.mtimeMs });
    }
  }
  entries.sort((a, b) => a.at - b.at);
  const bytesBefore = entries.reduce((sum, item) => sum + item.bytes, 0);
  let bytesAfter = bytesBefore;
  const removed = [];
  for (const item of entries) {
    if (bytesAfter <= maxBytes) break;
    if (!dryRun) await fs.rm(item.file, { recursive: true, force: true });
    bytesAfter -= item.bytes;
    removed.push({ path: path.relative(cache, item.file), bytes: item.bytes });
  }
  return { bytesBefore, bytesAfter, maxBytes, dryRun, removed };
}
