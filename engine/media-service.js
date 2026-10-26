import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPath, isWithin, pathDenied } from './path-policy.js';
import { probeMedia } from './media.js';
import { fault } from '../application/errors.js';

export function mediaService(root, importRoots = []) {
  return {
    async list({ offset = 0, limit = 100 } = {}) {
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fault('INVALID_ARGUMENT', 'invalid media pagination');
      const items = [];
      const walk = async (directory) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
          if (entry.name.startsWith('.')) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile()) items.push({ name: entry.name, path: path.relative(root, file).split(path.sep).join('/'), size: (await fs.stat(file)).size });
        }
      };
      const directory = await readPath(root, 'media').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
      if (directory) await walk(directory);
      items.sort((a, b) => a.path.localeCompare(b.path));
      return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
    },
    async probe({ src }) { return probeMedia(await readPath(root, src)); },
    async import({ files }) {
      if (!Array.isArray(files) || !files.length || files.length > 100 || !files.every((f) => typeof f === 'string')) throw fault('INVALID_ARGUMENT', 'files must contain 1..100 paths');
      const sources = await Promise.all(files.map(async (input) => {
        const absolute = path.resolve(root, input);
        const base = [root, ...importRoots].find((candidate) => isWithin(candidate, absolute));
        if (!base) throw pathDenied();
        return readPath(base, path.relative(base, absolute));
      }));
      await fs.mkdir(path.join(root, 'media'), { recursive: true });
      const directory = await readPath(root, 'media');
      const imported = [];
      for (const src of sources) {
        const temporary = path.join(directory, `.import-${randomUUID()}`);
        let name = path.basename(src);
        try {
          await fs.copyFile(src, temporary, fs.constants.COPYFILE_EXCL);
          for (let i = 0; ; i++) {
            const ext = path.extname(src);
            name = i ? `${path.basename(src, ext)}-${i}${ext}` : path.basename(src);
            try { await fs.link(temporary, path.join(directory, name)); break; }
            catch (e) { if (e.code !== 'EEXIST') throw e; }
          }
        } finally { await fs.rm(temporary, { force: true }); }
        imported.push({ name, path: `media/${name}` });
      }
      return { imported };
    },
  };
}
