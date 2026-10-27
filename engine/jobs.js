import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { JobService } from '../application/job-service.js';
import { fault } from '../application/errors.js';
import { assertSafeData, isRecord } from '../core/json.js';
import { atomicJson, paths } from './storage.js';
import { readPath } from './path-policy.js';
import { renderStill, renderVideo } from './blender.js';
import { hashFile, mimeOf } from './media.js';

const digest = (input) => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(input).sort().map((key) => [key, input[key]])))).digest('hex');

export async function createJobService(root, projects, onEvent, { execute } = {}) {
  const p = paths(root), directory = path.join(p.vdm, 'jobs');
  await fs.mkdir(directory, { recursive: true });
  const file = (id, name) => {
    if (typeof id !== 'string' || !/^job-[\da-f-]+$/.test(id)) throw fault('JOB_NOT_FOUND', 'unknown job');
    return path.join(directory, id, name);
  };
  const repository = {
    async list() {
      const jobs = [];
      for (const name of await fs.readdir(directory)) {
        if (!/^job-[\da-f-]+$/.test(name)) continue;
        try { jobs.push(JSON.parse(await fs.readFile(file(name, 'job.json'), 'utf8'))); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    save(job) { return atomicJson(file(job.id, 'job.json'), job); },
    retry(jobs, input, actorId) {
      assertSafeData(input);
      if (!isRecord(input)) throw fault('INVALID_ARGUMENT', 'render input must be an object');
      const fields = new Set(['kind', 'time', 'from', 'to', 'scale', 'samples', 'crf', 'expectedRev', 'requestId']);
      if (Object.keys(input).some((key) => !fields.has(key))) throw fault('INVALID_ARGUMENT', 'unknown render parameter');
      if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200)) throw fault('INVALID_ARGUMENT', 'invalid requestId');
      const found = input.requestId && jobs.find((j) => j.actorId === actorId && j.requestId === input.requestId);
      if (found && found.inputHash !== digest(input)) throw fault('REQUEST_ID_CONFLICT', 'requestId already used for another render');
      return found;
    },
    async create(input, actorId) {
      const project = await projects.read();
      if (input.expectedRev !== undefined && input.expectedRev !== project.rev) throw fault('REV_CONFLICT', 'project changed before render submission', { currentRev: project.rev });
      const kind = input.kind || 'still';
      if (!['still', 'video'].includes(kind)) throw fault('INVALID_ARGUMENT', 'render kind must be still or video');
      const options = { time: input.time ?? 0, from: input.from ?? 0, to: input.to ?? project.meta.duration,
        scale: input.scale ?? 0.5, samples: input.samples ?? 8, crf: input.crf ?? 18 };
      for (const [key, value] of Object.entries(options)) if (!Number.isFinite(value)) throw fault('INVALID_ARGUMENT', `${key} must be finite`);
      if (options.scale <= 0 || options.scale > 2 || options.samples < 1 || options.samples > 512 || !Number.isInteger(options.samples) || options.crf < 0 || options.crf > 51) throw fault('INVALID_ARGUMENT', 'render quality parameters are outside supported ranges');
      if (kind === 'still' ? options.time < 0 || options.time > project.meta.duration : options.from < 0 || options.to <= options.from || options.to > project.meta.duration) throw fault('INVALID_ARGUMENT', 'render time is outside project duration');
      const id = `job-${randomUUID()}`, work = path.join(directory, id);
      await fs.mkdir(path.join(work, 'inputs'), { recursive: true });
      const sources = new Map();
      try {
        const mediaTypes = new Set(['image', 'video', 'audio']);
        const entries = [
          ...project.elements.filter((entry) => mediaTypes.has(entry.type)),
          ...(project.scene?.objects || []).filter((entry) => mediaTypes.has(entry.type)),
          ...(project.meta.audio ? [project.meta.audio] : []),
        ];
        for (const entry of entries) {
          if (!entry.src) continue;
          if (!sources.has(entry.src)) {
            const src = await readPath(root, entry.src);
            const fingerprint = await hashFile(src);
            const target = path.join(work, 'inputs', fingerprint + path.extname(src));
            await fs.copyFile(src, target);
            if (await hashFile(target) !== fingerprint) throw fault('SOURCE_CHANGED', 'source changed during snapshot capture');
            sources.set(entry.src, { digest: fingerprint, path: path.relative(root, target).split(path.sep).join('/') });
          }
          entry.src = sources.get(entry.src).path;
        }
        await atomicJson(file(id, 'project.json'), project);
        return { id, actorId, requestId: input.requestId || null, inputHash: digest(input), kind, options, duration: project.meta.duration,
          sourceRev: project.rev, status: 'queued', progress: 0,
          total: kind === 'still' ? 1 : Math.round((options.to - options.from) * project.meta.fps),
          createdAt: new Date().toISOString(), sources: [...sources].map(([src, info]) => ({ src, ...info })) };
      } catch (e) { await fs.rm(work, { recursive: true, force: true }); throw e; }
    },
  };
  const jobs = new JobService(repository, execute || (async (job, callbacks) => {
    const project = JSON.parse(await fs.readFile(file(job.id, 'project.json'), 'utf8'));
    const out = path.join(job.kind === 'still' ? p.frames : p.renders, `${job.id}.${job.kind === 'still' ? 'png' : 'mp4'}`);
    const options = { dir: root, project, out, ...job.options, ...callbacks };
    if (job.kind === 'still') await renderStill(options); else await renderVideo(options);
    return { id: job.id, jobId: job.id, sourceRev: job.sourceRev, kind: job.kind, path: out,
      url: `/${job.kind === 'still' ? 'frames' : 'renders'}/${path.basename(out)}`,
      mimeType: mimeOf(out), size: (await fs.stat(out)).size, digest: await hashFile(out) };
  }), onEvent);
  await jobs.start();
  jobs.artifact = async (id, { image = false } = {}) => {
    const job = await jobs.get(id);
    if (job.status !== 'succeeded' || !job.artifact) throw fault('ARTIFACT_NOT_FOUND', 'job has no completed artifact');
    const artifact = { ...job.artifact };
    if (image) {
      const file = await readPath(p.frames, path.basename(artifact.path));
      const actual = await fs.stat(file);
      if (artifact.mimeType !== 'image/png' || actual.size > 8 * 1024 * 1024) throw fault('INVALID_ARGUMENT', 'inline image must be a PNG of at most 8 MiB');
      artifact.base64 = (await fs.readFile(file)).toString('base64');
    }
    return artifact;
  };
  return jobs;
}
