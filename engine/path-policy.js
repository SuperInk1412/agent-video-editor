import fs from 'node:fs/promises';
import path from 'node:path';

export const pathDenied = () => Object.assign(new Error('path is outside the allowed directory'), { code: 'PATH_OUTSIDE_SCOPE', status: 403 });

export function isWithin(base, file) {
  const rel = path.relative(path.resolve(base), path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Check lexical containment AND symlinks. Missing paths remain a normal 404. */
export async function readPath(base, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw pathDenied();
  const file = path.resolve(base, relative);
  if (!isWithin(base, file)) throw pathDenied();
  const [root, real] = await Promise.all([fs.realpath(base), fs.realpath(file)]);
  if (!isWithin(root, real)) throw pathDenied();
  return real;
}

/** Permit new output files only beneath a real, scoped parent directory. */
export async function writePath(base, input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw pathDenied();
  const file = path.isAbsolute(input) ? path.resolve(input) : path.resolve(base, input);
  if (!isWithin(base, file)) throw pathDenied();
  const root = await fs.realpath(base);
  let parent = file;
  for (;;) {
    try {
      const real = await fs.realpath(parent);
      if (!isWithin(root, real)) throw pathDenied();
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      parent = path.dirname(parent);
    }
  }
  return file;
}
