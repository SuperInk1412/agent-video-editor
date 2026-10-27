import { fault, errorData } from './errors.js';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/** A single runtime owns this queue; each job owns its abort controller. */
export class JobService {
  constructor(repository, execute, onEvent = () => {}) {
    this.repository = repository; this.execute = execute; this.onEvent = onEvent;
    this.jobs = new Map(); this.active = null; this.closing = false;
    this.chain = Promise.resolve(); this.waiters = new Set();
  }
  serial(fn) { const run = this.chain.then(fn); this.chain = run.catch(() => {}); return run; }
  async start() {
    for (const job of await this.repository.list()) {
      if (!TERMINAL.has(job.status)) { job.status = 'interrupted'; job.error = { code: 'INTERRUPTED', message: 'runtime exited before task completion' }; await this.repository.save(job); }
      this.jobs.set(job.id, job);
    }
    return this;
  }
  async publish(job) {
    job.updatedAt = new Date().toISOString();
    await this.repository.save(job);
    this.onEvent(structuredClone(job));
    for (const fn of this.waiters) fn();
  }
  submit(input, actorId = 'local') {
    return this.serial(async () => {
      if (this.closing) throw fault('RUNTIME_UNAVAILABLE', 'runtime is shutting down');
      const existing = this.repository.retry([...this.jobs.values()], input, actorId);
      if (existing) return structuredClone(existing);
      const job = await this.repository.create(input, actorId);
      this.jobs.set(job.id, job);
      await this.publish(job);
      this.drain();
      return structuredClone(job);
    });
  }
  async get(id) {
    await this.chain;
    const job = this.jobs.get(id);
    if (!job) throw fault('JOB_NOT_FOUND', 'unknown job');
    return structuredClone(job);
  }
  async list() { await this.chain; return [...this.jobs.values()].map((job) => structuredClone(job)); }
  cancel(id) {
    return this.serial(async () => {
      const job = this.jobs.get(id);
      if (!job) throw fault('JOB_NOT_FOUND', 'unknown job');
      if (TERMINAL.has(job.status)) return structuredClone(job);
      job.status = this.active?.id === id ? 'cancelling' : 'cancelled';
      this.active?.id === id && this.active.abort.abort();
      await this.publish(job);
      return structuredClone(job);
    });
  }
  drain() {
    if (this.active || this.closing) return;
    const job = [...this.jobs.values()].find((item) => item.status === 'queued');
    if (!job) return;
    const abort = new AbortController();
    const active = { id: job.id, abort };
    this.active = active;
    active.done = (async () => {
      try {
        await this.serial(async () => { job.status = 'preparing'; await this.publish(job); });
        const artifact = await this.execute(job, { signal: abort.signal,
          onProgress: (event) => {
            if (abort.signal.aborted || TERMINAL.has(job.status)) return;
            if (event.stage === 'frame') { job.progress = event.frame; job.total = event.total; }
            else if (['preparing', 'rendering', 'encoding'].includes(event.stage)) job.status = event.stage;
            this.onEvent(structuredClone(job));
          },
        });
        await this.serial(async () => {
          if (abort.signal.aborted) job.status = 'cancelled';
          else { job.status = 'succeeded'; job.artifact = artifact; }
          await this.publish(job);
        });
      } catch (e) {
        await this.serial(async () => {
          job.status = abort.signal.aborted ? 'cancelled' : 'failed';
          if (job.status === 'failed') job.error = errorData(e);
          await this.publish(job);
        });
      } finally { this.active = null; this.drain(); }
    })();
    // Persist failures are observable and must never become unhandled promises.
    active.done.catch((e) => { job.status = 'failed'; job.error = errorData(e); this.active = null; this.onEvent(structuredClone(job)); for (const fn of this.waiters) fn(); });
  }
  async wait(id) {
    for (;;) {
      const job = await this.get(id);
      if (TERMINAL.has(job.status)) return job;
      await new Promise((resolve) => {
        const changed = () => { this.waiters.delete(changed); resolve(); };
        this.waiters.add(changed);
        if (TERMINAL.has(this.jobs.get(id)?.status)) changed();
      });
    }
  }
  async close() {
    this.closing = true;
    await this.serial(async () => {
      for (const job of this.jobs.values()) if (job.status === 'queued') { job.status = 'cancelled'; await this.publish(job); }
      this.active?.abort.abort();
    });
    await this.active?.done;
    await this.chain;
  }
}
