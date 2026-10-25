// Dev launcher: finds a usable Electron binary (no npm install needed) and boots the app.
// `node scripts/dev.mjs`            -> Electron window
// `node scripts/dev.mjs --web`      -> engine server + browser tab
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const webMode = argv.includes('--web');

const ELECTRON_CANDIDATES = [
  process.env.VDM_ELECTRON,
  path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
  'E:/Software/KTUM6/resources/app/node_modules/electron/dist/electron.exe',
  'C:/Program Files/Electron/electron.exe',
].filter(Boolean);

function findElectron() {
  for (const c of ELECTRON_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const project = (() => {
  const i = argv.indexOf('--project');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return path.join(REPO, 'projects', 'demo');
})();

if (webMode) {
  const port = Number(process.env.VDM_PORT || 47100);
  const child = spawn(process.execPath, [path.join(REPO, 'engine', 'server.js'), '--project', project, '--port', String(port), '--open'], {
    cwd: REPO, stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const exe = findElectron();
  if (!exe) {
    console.error('[vdm] 没找到 Electron。设置环境变量 VDM_ELECTRON 指向 electron.exe，或运行 `node scripts/dev.mjs --web` 用浏览器打开。');
    process.exit(1);
  }
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') { i++; continue; }
    if (argv[i].startsWith('--project=')) continue;
    passthrough.push(argv[i]);
  }
  const args = [REPO, `--project=${project}`, ...passthrough];
  const child = spawn(exe, args, {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, VDM_PROJECT: project, ELECTRON_ENABLE_LOGGING: '1' },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
