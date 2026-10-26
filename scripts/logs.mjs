// Tail the current project log from the terminal.
//   node scripts/logs.mjs [--project projects/demo] [--lines 100] [--follow]
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const val = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const project = path.resolve(val('--project', path.join(REPO, 'projects', 'demo')));
const root = (await findProjectRoot(project)) || project;
const lines = Number(val('--lines', 80));
const follow = argv.includes('--follow');
const dir = path.join(root, '.vdm', 'logs');

const paint = (raw) => {
  const C = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', debug: '\x1b[2m' };
  return raw.split('\n').filter(Boolean).map((line) => {
    try {
      const r = JSON.parse(line);
      const meta = r.meta ? ' \x1b[2m' + JSON.stringify(r.meta).slice(0, 300) + '\x1b[0m' : '';
      const t = String(r.ts).slice(11, 19);
      return `\x1b[2m${t}\x1b[0m ${(C[r.level] || '')}${String(r.level).toUpperCase().padEnd(5)}\x1b[0m ${r.msg}${meta}`;
    } catch {
      return line;
    }
  }).join('\n');
};

async function newest() {
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.log')).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

const file = await newest();
if (!file) {
  console.log(`no logs in ${dir} — start the engine first`);
  process.exit(0);
}
const raw = await fs.readFile(file, 'utf8');
console.log(paint(raw.trim().split('\n').slice(-lines).join('\n')));
console.log(`\x1b[2m--- ${file}${follow ? ' (following)' : ''}\x1b[0m`);

if (follow) {
  let size = (await fs.stat(file)).size;
  const timer = setInterval(async () => {
    try {
      const st = await fs.stat(file);
      if (st.size > size) {
        const fh = await fs.open(file, 'r');
        const buf = Buffer.alloc(st.size - size);
        await fh.read(buf, 0, buf.length, size);
        await fh.close();
        size = st.size;
        process.stdout.write(paint(buf.toString('utf8')));
      }
    } catch { /* file rotated */ }
  }, 800);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
}
