// Electron shell: boots the engine server in-process, then opens the editor window.
// The engine is a plain Node server, so the same UI also runs in a browser (`npm run web`).
import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../engine/server.js';
import { findProjectRoot } from '../../core/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let win = null;
let engine = null;
let startupError = null;

// headless-ish self check: electron app --capture=<png> [--at=<sec>] [--eval=<js>] [--delay=<ms>]
const argOf = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const captureTo = argOf('capture');

const requestedProject = process.argv.find((a) => a.startsWith('--project='))?.split('=')[1] || process.env.VDM_PROJECT || null;

function resolveRoot() {
  return requestedProject || path.join(REPO, 'projects', 'demo');
}

/** Restart the whole app (engine included) with another project directory. */
async function relaunchWith(dir) {
  const drop = ['--project=', '--capture=', '--at=', '--delay=', '--hold=', '--eval='];
  const args = process.argv.slice(1).filter((a) => !drop.some((p) => a.startsWith(p)));
  if (dir) args.push(`--project=${dir}`);
  try { await engine?.close(); } catch { /* ignore */ }
  app.relaunch({ args });
  app.exit(0);
}

ipcMain.handle('vdm:current', () => ({ root: engine?.info?.root || null, url: engine?.info?.url || null }));
ipcMain.handle('vdm:restart', (_e, dir) => relaunchWith(dir || engine?.info?.root));
ipcMain.handle('vdm:open-project', async (_e, dir) => {
  if (!dir) throw new Error('没有选择项目目录');
  const root = (await findProjectRoot(dir)) || null;
  if (!root) throw new Error('这个目录里没有 project.vdm.json');
  return relaunchWith(root);
});
ipcMain.handle('vdm:pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: path.join(REPO, 'projects'),
    title: '选择项目目录',
  });
  if (res.canceled || !res.filePaths?.length) return null;
  return (await findProjectRoot(res.filePaths[0])) || res.filePaths[0];
});

async function boot() {
  const wanted = path.resolve(resolveRoot());
  const root = (await findProjectRoot(wanted)) || wanted;
  try {
    engine = await startServer({ root, port: Number(process.env.VDM_PORT) || 47100 });
  } catch (e) {
    startupError = e;
    dialog.showErrorBox('VedioMaker 启动失败', `${e.message}\n\n项目目录: ${root}`);
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#08090d',
    title: 'VedioMaker',
    autoHideMenuBar: false,
    show: !captureTo,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: !!captureTo,
    },
  });

  win.loadURL(engine.info.url + (requestedProject ? '' : '?picker=1'));
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // local renders/frames open in the OS, never in a browser download manager
    try {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1' && engine) {
        const sub = u.pathname.startsWith('/renders/') ? ['renders', u.pathname.slice(9)]
          : u.pathname.startsWith('/frames/') ? ['frames', u.pathname.slice(8)] : null;
        if (sub) {
          shell.openPath(path.join(engine.info.root, '.vdm', sub[0], decodeURIComponent(sub[1])));
          return { action: 'deny' };
        }
      }
    } catch { /* fall through */ }
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  buildMenu();

  if (captureTo) {
    const at = Number(argOf('at', 0));
    const delay = Number(argOf('delay', 2200));
    const script = argOf('eval');
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((r) => setTimeout(r, delay));
        if (at > 0) await win.webContents.executeJavaScript(`window.__vdm && window.__vdm.setTime(${at})`);
        if (script) await win.webContents.executeJavaScript(script);
        const hold = Number(argOf('hold', 700));
        await new Promise((r) => setTimeout(r, hold));
        const img = await win.webContents.capturePage();
        await fsp.mkdir(path.dirname(captureTo), { recursive: true });
        await fsp.writeFile(captureTo, img.toPNG());
        const probe = await win.webContents.executeJavaScript('window.__probe || null').catch(() => null);
        if (typeof probe === 'string' && probe.startsWith('data:image/png;base64,')) {
          await fsp.writeFile(captureTo.replace(/\.png$/, '.probe.png'), Buffer.from(probe.split(',')[1], 'base64'));
        }
        const info = await win.webContents.executeJavaScript(`({ booted: !!window.__vdm, t: window.__vdm?.S?.time, sel: window.__vdm?.S?.selection, title: document.title, view: [window.innerWidth, window.innerHeight, window.devicePixelRatio], dbg: window.__dbg || null })`);
        console.log('[capture]', captureTo, JSON.stringify(info), 'content', JSON.stringify(win.getContentSize()), 'image', JSON.stringify(img.getSize()));
      } catch (e) {
        console.error('[capture] failed', e);
      } finally {
        app.quit();
      }
    });
  }
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开项目…',
          accelerator: 'CmdOrCtrl+O',
          click: () => win?.webContents.send('vdm:open-picker'),
        },
        {
          label: '快速重启',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => relaunchWith(engine?.info.root),
        },
        { type: 'separator' },
        {
          label: '打开项目文件夹',
          click: () => { if (engine) shell.openPath(engine.info.root); },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销输入' },
        { role: 'redo', label: '重做输入' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '原始大小' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '项目目录 / HTTP 地址',
          click: () => {
            if (!engine) return;
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'VedioMaker',
              message: `项目: ${engine.info.root}\n引擎: ${engine.info.url}\nCLI: node cli/vdm.js --project "${engine.info.root}"`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  try { await engine?.close(); } catch { /* ignore */ }
});
