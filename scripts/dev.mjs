// Dev launcher: finds a usable Electron binary (no npm install needed) and boots the app.
// `node scripts/dev.mjs`            -> Electron window
// `node scripts/dev.mjs --web`      -> engine server + browser tab
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../engine/storage.js';
import { which, firstExecutable } from '../engine/which.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const webMode = argv.includes('--web');

const ELECTRON_CANDIDATES = [
  process.env.VDM_ELECTRON,
  path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.join(REPO, 'node_modules', 'electron', 'dist', 'electron'),
  path.join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  'E:/Software/KTUM6/resources/app/node_modules/electron/dist/electron.exe',
  'C:/Program Files/Electron/electron.exe',
  '/Applications/Electron.app/Contents/MacOS/Electron',
].filter(Boolean);

function findElectron() {
  return firstExecutable(ELECTRON_CANDIDATES) || which('electron');
}

// --project > where you stood when launching > pick a project in the app
// `npm start` runs the script from the package root, so cwd is the repo even
// when you launched from projects/<name> — INIT_CWD keeps the real directory.
const explicitProject = await (async () => {
  const i = argv.indexOf('--project');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  for (const start of [process.cwd(), process.env.INIT_CWD]) {
    const found = start ? await findProjectRoot(start) : null;
    if (found) return found;
  }
  return null;
})();
const project = explicitProject || path.join(REPO, 'projects', 'demo');
console.log(`[vdm] opening ${project}${explicitProject ? '' : '（应用里选择项目）'}`);

if (webMode) {
  const port = Number(process.env.VDM_PORT || 47100);
  const child = spawn(process.execPath, [path.join(REPO, 'engine', 'server.js'), '--project', project, '--port', String(port), '--open'], {
    cwd: REPO, stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const exe = findElectron();
  if (!exe) {
    console.error('[vdm] 没找到 Electron。把 electron 加进 PATH，或设置 VDM_ELECTRON 指向 Electron 可执行文件，或运行 `node scripts/dev.mjs --web` 用浏览器打开。');
    process.exit(1);
  }
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') { i++; continue; }
    if (argv[i].startsWith('--project=')) continue;
    passthrough.push(argv[i]);
  }
  const args = [REPO, ...(explicitProject ? [`--project=${project}`] : []), ...passthrough];
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  if (explicitProject) env.VDM_PROJECT = project;
  const child = spawn(exe, args, {
    cwd: REPO,
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
