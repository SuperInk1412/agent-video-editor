// The engine's live surface: SSE, runtime attach, world/state snapshots and the
// audio / storyboard / capture actions the renderer fires at the playhead.
//
//   GET  /api/runtime         this engine's root + instance id (the attach handshake)
//   POST /api/rpc             the runtime credential protocol (Bearer token)
//   *    /api/events          the SSE stream (method-agnostic, as before)
//   GET  /api/world           the baked city, cached by a hash of the world config
//   *    /api/state           everything the status bar needs (method-agnostic, as before)
//   POST /api/beats           analyse the project audio and write beats/tempo
//   POST /api/plan            auto storyboard from the media folder
//   POST /api/capture         store a PNG the user captured from the stage
//
// `/api/rpc` used to switch on `method` inside the one big handler; that switch
// is kept verbatim so the wire contract cannot drift.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { blenderVersion } from '../blender.js';
import { findManim, manimVersion } from '../manim.js';
import { analyzeBeats } from '../beats.js';
import { STYLE_PRESETS } from '../storyboard.js';
import { CLI_PATH, findDsh } from '../agent.js';
import { pruneCache } from '../cache.js';
import { readPath } from '../path-policy.js';
import { hashOf } from '../media.js';
import { compute } from '../compute.js';
import { readSelection, contextAt } from '../../application/queries.js';
import { OP_KINDS } from '../../core/ops.js';
import { PROJECT_SCHEMA, EDIT_SEMANTICS_VERSION, RENDER_PLAN_VERSION } from '../../core/version.js';

/**
 * §6.4 (WP5.2): a manim source is optional. `null` means the runtime is not
 * installed, so the editor can grey out the manim entry points (D5).
 */
async function manimCapability() {
  const bin = findManim();
  if (!bin) return null;
  return { bin, version: await manimVersion(bin).catch(() => null) };
}

export function register(router, ctx) {
  const { json, readBody, projects, jobs, media, broadcast, toast, transact, transactionOptions } = ctx;

  router.get('/api/runtime', async (req, res) => {
    return json(res, 200, { root: ctx.root, instanceId: ctx.instanceId, version: 1 });
  });

  router.post('/api/rpc', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${ctx.token}`) return json(res, 403, { error: 'runtime credential required', code: 'ACCESS_DENIED' });
    const { method, params = {} } = await readBody(req);
    let result;
    switch (method) {
      case 'project.read': result = await projects.read(); break;
      case 'project.query': result = readSelection(await projects.read(), params); break;
      case 'project.context': result = contextAt(await projects.read(), params); break;
      case 'project.transact': result = await transact(params, 'local'); break;
      case 'project.history': result = await projects.history(); break;
      case 'job.submit': result = await jobs.submit(params); break;
      case 'job.get': result = await jobs.get(params.id); break;
      case 'job.list': result = await jobs.list(); break;
      case 'job.cancel': result = await jobs.cancel(params.id); break;
      case 'job.wait': result = await jobs.wait(params.id); break;
      case 'artifact.read': result = await jobs.artifact(params.id, params); break;
      case 'media.list': result = await media.list(params); break;
      case 'media.probe': result = await media.probe(params); break;
      case 'media.import': result = await media.import(params); break;
      case 'cache.prune': result = await jobs.serial(async () => {
        if (jobs.active || [...jobs.jobs.values()].some((job) => job.status === 'queued')) throw Object.assign(new Error('cannot prune cache while render jobs are pending'), { code: 'JOB_BUSY', status: 409 });
        return pruneCache(ctx.root, params);
      }); break;
      case 'capabilities': result = { projectSchema: PROJECT_SCHEMA, semanticsVersion: EDIT_SEMANTICS_VERSION, renderPlanVersion: RENDER_PLAN_VERSION,
        ops: OP_KINDS.filter((op) => !['restoreProject', 'replaceTimeline'].includes(op)),
        models: ['elements', 'cameras', 'scene.objects'], sceneTree: 'experimental, read-only',
        rendering: { concurrency: 1, backend: 'Blender', textLayout: 'approximate preview parity' },
        blender: await blenderVersion().catch(() => null),
        manim: await manimCapability(), revision: ctx.getProject().rev }; break;
      case 'runtime.stop': result = { ok: true }; setImmediate(() => { void ctx.closeRuntime(); }); break;
      default: return json(res, 400, { error: 'unknown runtime method', code: 'INVALID_ARGUMENT' });
    }
    return json(res, 200, result);
  });

  // ---------------- SSE ----------------
  router.any('/api/events', async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    ctx.clients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ root: ctx.root, rev: ctx.getProject().rev })}\n\n`);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
    req.on('close', () => { clearInterval(ping); ctx.clients.delete(res); });
    return;
  });

  // ---------------- 3D world (shared by viewport + blender) ----------------
  router.get('/api/world', async (req, res) => {
    const snapshot = ctx.getProject();
    const cache = ctx.worldCache;
    const key = hashOf({ world: snapshot.world, cameras: snapshot.cameras, cameraOrder: snapshot.cameraOrder,
      // The corridor clearing depends on where the cameras fly, and a
      // camera parented to a 3D object flies with that object's tracks —
      // without `scene.objects` here, animating the parent left every open
      // window on the old city while a fresh one baked the right one.
      scene: snapshot.scene?.objects || null,
      fps: snapshot.meta.fps, duration: snapshot.meta.duration });
    if (!cache.promise || key !== cache.key) {
      cache.key = key;
      cache.promise = compute('world', snapshot);
      cache.promise.catch(() => { if (cache.key === key) cache.promise = null; });
    }
    const city = await cache.promise;
    return json(res, 200, { hash: city.hash, city, rev: snapshot.rev });
  });

  // ---------------- state ----------------
  router.any('/api/state', async (req, res) => {
    const project = ctx.getProject();
    let blender = null;
    try { blender = await blenderVersion(); } catch { /* not installed */ }
    const dsh = await findDsh();
    // The agent loop is created lazily; a broken transport configuration must
    // not take the whole status bar down with it.
    const agentState = { available: !!dsh, running: false, runId: null };
    try {
      const agent = ctx.agent;
      agentState.running = agent.running;
      agentState.runId = agent.runId;
      agentState.transport = agent.agent?.name ?? null;
    } catch (error) {
      agentState.error = error.message;
    }
    // ffmpeg availability for the status bar; probed once per engine process
    return json(res, 200, {
      root: ctx.root,
      project,
      rev: project.rev,
      cli: CLI_PATH,
      blender,
      ffmpeg: await ctx.ffmpegAvailable(),
      agent: agentState,
      render: ctx.renderState,
      pipeline: ctx.pipeline,
      styles: Object.keys(STYLE_PRESETS),
      version: '0.1.0',
    });
  });

  // ---------------- audio / storyboard ----------------
  router.post('/api/beats', async (req, res) => {
    const body = await readBody(req);
    const project = ctx.getProject();
    const rel = body.src || project.meta.audio?.src;
    if (!rel) return json(res, 400, { error: 'no audio' });
    const file = await readPath(ctx.root, rel);
    toast('分析节拍中…');
    const result = await analyzeBeats(file, { duration: body.duration || null, fps: project.meta.fps });
    const ops = [
      { op: 'setMeta', path: 'beats', value: result.beats },
      { op: 'setMeta', path: 'tempo', value: result.tempo },
    ];
    if (!project.meta.audio) ops.push({ op: 'setMeta', path: 'audio', value: { src: rel, offset: 0, gain: 0 } });
    if (body.setDuration) ops.push({ op: 'setMeta', path: 'duration', value: Math.round(result.duration * 1000) / 1000 });
    await transact({ ...transactionOptions(body), ops }, 'beats');
    broadcast('beats', result);
    return json(res, 200, result);
  });

  router.post('/api/plan', async (req, res) => {
    const body = await readBody(req);
    const chosen = body.media || (await (async () => {
      const dir = path.join(ctx.root, 'media');
      try { return (await fsp.readdir(dir)).filter((f) => /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(f)).sort().map((f) => `media/${f}`); } catch { return []; }
    })());
    const opts = {
      media: chosen, style: body.style || 'neon', brief: body.brief || '',
      seed: body.seed ?? 7, maxSegments: body.maxSegments || 12, duration: body.duration || null,
    };
    const tx = await transact({ ...transactionOptions(body), command: { type: 'plan', options: opts } }, 'plan');
    const saved = tx.project, made = { segments: saved.segments.length, elements: saved.elements.length };
    ctx.setStep('storyboard', { status: 'done', detail: `${made.segments} 个分镜 · ${made.elements} 个元素` });
    ctx.addArtifact({ kind: 'storyboard', label: `自动分镜 · ${made.segments} 段`, detail: opts.style });
    return json(res, 200, { ok: true, project: saved, steps: made.segments });
  });

  // ---------------- capture (what the user sees) ----------------
  router.post('/api/capture', async (req, res) => {
    const body = await readBody(req);
    const m = /^data:image\/png;base64,(.+)$/s.exec(body.dataUrl || '');
    if (!m) return json(res, 400, { error: 'dataUrl must be a png data url' });
    const dir = path.join(ctx.paths.vdm, 'frames');
    await fsp.mkdir(dir, { recursive: true });
    const name = `cap-${Date.now()}${body.label ? '-' + String(body.label).replace(/[^\w-]/g, '') : ''}.png`;
    const file = path.join(dir, name);
    await fsp.writeFile(file, Buffer.from(m[1], 'base64'));
    const art = { kind: 'still', label: body.label || '预览帧', time: body.time ?? null, path: file, url: `/frames/${name}` };
    ctx.addArtifact(art);
    return json(res, 200, art);
  });
}
