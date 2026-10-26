// Cross-platform PATH lookup without shelling out to `where` / `which`
// (`where` is Windows-only, and `which` is not guaranteed on minimal Linux).
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (isWin) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of `name` on PATH (honouring PATHEXT on Windows), or null. */
export function which(name, { env = process.env } = {}) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return isExecutable(name) ? path.resolve(name) : null;
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin
    ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

/** First candidate that exists and is executable. */
export function firstExecutable(candidates) {
  for (const c of candidates) {
    if (c && isExecutable(c)) return c;
  }
  return null;
}
