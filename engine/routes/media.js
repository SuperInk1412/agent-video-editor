// Media library + the renderer's log sink.
//
//   GET  /api/media    the library list
//   POST /api/import   copy files from an allowed import root
//   POST /api/upload   stream one raw body into media/ (bounded, atomic name)
//   GET  /api/probe    ffprobe one project-relative file
//   GET  /api/logs     tail the engine log
//   POST /api/log      a line from the renderer
//
// The upload path is the only place a request body lands on disk by streaming;
// it writes `.upload-<uuid>` beside the target and hard-links the final name, so
// a half-finished body is never visible and two equal names never overwrite.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { readPath } from '../path-policy.js';
import { probeMedia, fileExists } from '../media.js';

/** Publish a complete temporary file under a human-readable name, never replacing one. */
async function publishMedia(temporary, directory, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 0; ; i++) {
    const name = i ? `${stem}-${i}${ext}` : filename;
    try {
      // Same-directory hard link publishes a complete file atomically without
      // replacing another upload that chose the same human-readable name.
      await fsp.link(temporary, path.join(directory, name));
      return name;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

export function register(router, ctx) {
  const { json, readBody, log, media, root, uploadLimit } = ctx;

  router.get('/api/media', async (req, res) => {
    const result = await media.list({ limit: 500 });
    return json(res, 200, { ...result, media: result.items });
  });
  router.post('/api/import', async (req, res) => json(res, 200, await media.import(await readBody(req))));

  router.post('/api/upload', async (req, res, { url }) => {
    const rawName = String(url.searchParams.get('name') || `upload-${Date.now()}.bin`);
    const ext = path.extname(rawName);
    const base = path.basename(rawName, ext).replace(/[^\w.\- ()一-龥]/g, '_').slice(0, 80);
    await fsp.mkdir(path.join(root, 'media'), { recursive: true });
    const mediaDir = await readPath(root, 'media');
    let name;
    const temporary = path.join(mediaDir, `.upload-${randomUUID()}`);
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      done(size > uploadLimit ? Object.assign(new Error('upload too large'), { status: 413 }) : null, chunk);
    } });
    const failed = (error) => limit.destroy(error);
    const aborted = () => failed(new Error('upload aborted'));
    req.once('error', failed);
    req.once('aborted', aborted);
    limit.once('error', () => { req.unpipe(limit); req.resume(); });
    try {
      req.pipe(limit);
      await streamPipeline(limit, fs.createWriteStream(temporary, { flags: 'wx' }));
      name = await publishMedia(temporary, mediaDir, `${base}${ext}`);
    } finally {
      req.off('error', failed);
      req.off('aborted', aborted);
      await fsp.rm(temporary, { force: true });
    }
    const dest = path.join(mediaDir, name);
    let info = null;
    try { info = await probeMedia(dest); } catch { /* not media */ }
    return json(res, 200, { imported: [{ path: `media/${name}`, name, info }] });
  });

  router.get('/api/probe', async (req, res, { url }) => {
    const src = url.searchParams.get('src');
    if (!src) return json(res, 400, { error: 'src required' });
    const file = await readPath(root, src);
    if (!(await fileExists(file))) return json(res, 404, { error: 'not found' });
    return json(res, 200, await probeMedia(file));
  });

  // ---------------- logs ----------------
  router.get('/api/logs', async (req, res, { url }) => {
    const n = Math.min(2000, Math.max(10, Number(url.searchParams.get('lines') || 300)));
    const lines = await log.tail(n);
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { records.push({ ts: new Date().toISOString(), level: 'info', msg: line }); }
    }
    return json(res, 200, { file: log.fileFor(), records });
  });

  router.post('/api/log', async (req, res) => {
    const body = await readBody(req);
    const level = ['info', 'warn', 'error', 'debug'].includes(body.level) ? body.level : 'info';
    log[level](String(body.msg || 'renderer report').slice(0, 4000), { source: body.source || 'renderer', stack: body.stack ? String(body.stack).slice(0, 2000) : undefined, url: body.url });
    return json(res, 200, { ok: true });
  });
}
