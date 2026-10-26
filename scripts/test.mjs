import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = new URL('../tests/', import.meta.url);
const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.test.mjs')).sort()
  .map((name) => fileURLToPath(new URL(name, directory)));
// Node 20 does not expand quoted filename globs. Enumerate without a shell so
// the advertised minimum version runs exactly the same suite as newer Node.
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
