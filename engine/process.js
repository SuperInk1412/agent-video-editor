import { spawn } from 'node:child_process';

export const cancelled = () => Object.assign(new Error('cancelled'), { code: 'CANCELLED' });

/** All workers share cancellation, bounded output and actual process-exit waits. */
export function runProcess(executable, args, { cwd, signal, timeout = 0, onStdout, onLog, maxOutput = 400000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
    let output = '', stderr = '', failure, timer;
    const terminate = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (e) { if (e.code !== 'ESRCH') failure ||= e; }
    };
    const abort = () => { failure = cancelled(); terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (timeout) timer = setTimeout(() => { failure = Object.assign(new Error('worker timed out'), { code: 'WORKER_TIMEOUT' }); terminate(); }, timeout);
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-maxOutput);
      try { onStdout?.(chunk); } catch (e) { failure = e; terminate(); }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-maxOutput);
      try { onLog?.(String(chunk)); } catch (e) { failure = e; terminate(); }
    });
    child.on('error', (e) => { failure = e; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) {
        const error = failure || Object.assign(new Error(`worker exited ${code}`), { code: 'WORKER_FAILED' });
        error.log = (stderr || output).slice(-4000);
        reject(error);
      } else resolve({ code, stdout: output, stderr });
    });
  });
}
