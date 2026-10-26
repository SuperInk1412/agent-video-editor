// Tiny file logger: JSONL per day under <project>/.vdm/logs/.
// The UI reads the tail through /api/logs; the terminal gets the same lines.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LEVEL_TAG = { info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

export function createLogger({ dir, name = 'vdm', echo = true }) {
  const logsDir = path.join(dir, '.vdm', 'logs');
  fsp.mkdir(logsDir, { recursive: true }).catch(() => {});
  const day = () => new Date().toISOString().slice(0, 10);
  const fileFor = (d = day()) => path.join(logsDir, `${name}-${d}.log`);
  const listeners = new Set();

  const write = (level, msg, meta) => {
    const rec = { ts: new Date().toISOString(), level, msg: String(msg) };
    if (meta && typeof meta === 'object') {
      const m = {};
      for (const [k, v] of Object.entries(meta)) {
        if (v === undefined) continue;
        m[k] = typeof v === 'string' ? v.slice(0, 4000) : v;
      }
      if (Object.keys(m).length) rec.meta = m;
    }
    fs.appendFile(fileFor(), JSON.stringify(rec) + '\n', () => {});
    if (echo) {
      const line = `[vdm ${LEVEL_TAG[level] || 'info'}] ${rec.msg}`;
      const extra = rec.meta ? ' ' + JSON.stringify(rec.meta).slice(0, 400) : '';
      console.error(line + extra);
    }
    for (const fn of listeners) { try { fn(rec); } catch { /* ignore */ } }
    return rec;
  };

  return {
    logsDir,
    fileFor,
    info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x),
    error: (m, x) => write('error', m, x),
    debug: (m, x) => write('debug', m, x),
    onLine: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    async tail(lines = 200) {
      try {
        const raw = await fsp.readFile(fileFor(), 'utf8');
        return raw.trim().split('\n').slice(-lines).filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
