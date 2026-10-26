import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

/** Keep CPU-heavy baking and audio analysis away from HTTP / MCP dispatch. */
export function compute(task, payload, { signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./compute.js', import.meta.url), { workerData: { task, payload } });
    let settled = false, abortTimer;
    const abort = () => {
      if (task === 'beats') {
        worker.postMessage('cancel');
        // Decode cancellation can kill ffmpeg cooperatively; once FFT is
        // running no child remains, so a blocked CPU worker can be terminated.
        abortTimer = setTimeout(() => { void worker.terminate(); }, 1000);
      }
      else { void worker.terminate(); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(abortTimer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (signal?.aborted) reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
      else if (error) reject(Object.assign(new Error(error.message), error));
      else resolve(result);
    };
    worker.on('message', (message) => finish(message.error, message.result));
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => { if (!settled) finish({ message: `compute worker exited ${code}`, code: 'WORKER_FAILED' }); });
    if (signal?.aborted) abort();
  });
}

if (!isMainThread && workerData?.task) {
  void (async () => {
  const controller = new AbortController();
  parentPort.on('message', (message) => { if (message === 'cancel') controller.abort(); });
  try {
    let result;
    switch (workerData.task) {
      case 'shot': result = (await import('./shot.js')).buildShot(workerData.payload.project, workerData.payload.options); break;
      case 'world': result = (await import('./shot.js')).worldSnapshot(workerData.payload); break;
      case 'beats': result = await (await import('./beats.js')).analyzeBeatsLocal(workerData.payload.file, { ...workerData.payload.options, signal: controller.signal }); break;
      default: throw new Error('unknown compute task');
    }
    parentPort.postMessage({ result });
  } catch (e) { parentPort.postMessage({ error: { message: e.message, code: e.code || 'COMPUTE_FAILED' } }); }
  parentPort.close();
  })();
}
