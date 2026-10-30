// The edit agent and the timeline context it reads.
//
//   POST /api/agent          start a run with a task + selection (+ frames)
//   POST /api/agent/cancel   stop the run
//   POST /api/agent/approve  the plan gate / AgentLoop (WP2.4) is not wired yet
//   GET  /api/agent/state    running / runId
//   GET  /api/context        what the playhead sees, for the agent prompt
import fsp from 'node:fs/promises';
import path from 'node:path';
import { summarizeProject } from '../storyboard.js';

export function register(router, ctx) {
  const { json, readBody, agent, jobs, paths: p } = ctx;

  router.post('/api/agent', async (req, res) => {
    if (agent.running) return json(res, 409, { error: 'agent already running' });
    const body = await readBody(req);
    const selection = body.selection || {};
    const frames = [];
    if (Array.isArray(body.frames)) {
      const dir = path.join(p.vdm, 'agent', 'frames', `run-${Date.now()}`);
      await fsp.mkdir(dir, { recursive: true });
      for (const f of body.frames) {
        const m = /^data:image\/png;base64,(.+)$/s.exec(f.dataUrl || '');
        if (!m) continue;
        const file = path.join(dir, `${String(f.label || frames.length).replace(/[^\w-]/g, '')}.png`);
        await fsp.writeFile(file, Buffer.from(m[1], 'base64'));
        frames.push(file);
      }
    }
    if (body.stillFrames) {
      for (const t of body.stillFrames) {
        const file = path.join(p.frames, `agent-${Date.now()}-${Math.round(t * 100)}.png`);
        const submitted = await jobs.submit({ kind: 'still', time: t, scale: 0.5, samples: 6 });
        const completed = await jobs.wait(submitted.id);
        if (completed.artifact) frames.push(completed.artifact.path);
      }
    }
    const project = ctx.getProject();
    const summary = summarizeProject(project, { segmentId: selection.segmentId, time: body.time ?? 0 });
    const contextFile = await agent.writeContext({
      project, selection, frames,
      extra: { summary, playhead: body.time ?? 0, requestedAt: new Date().toISOString() },
    });
    try {
      const r = await agent.start({ task: body.task, contextFile, frames, selection, project });
      return json(res, 200, { ok: true, ...r, contextFile, frames });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  });

  router.post('/api/agent/cancel', async (req, res) => {
    return json(res, 200, { ok: agent.cancel() });
  });
  // The plan gate of AgentLoop (WP2.4) is not reachable from this server
  // yet: the loop transport needs a dsh adapter that speaks its tool
  // protocol. Answer honestly instead of hanging the approve button.
  router.post('/api/agent/approve', async (req, res) => {
    return json(res, 404, { error: 'no plan is awaiting approval', code: 'NO_PENDING_PLAN' });
  });
  router.get('/api/agent/state', async (req, res) => {
    return json(res, 200, { ok: true, running: agent.running, runId: agent.runId });
  });

  // ---------------- timeline context for the agent --------------
  router.get('/api/context', async (req, res, { url }) => {
    const segmentId = url.searchParams.get('segment');
    const time = Number(url.searchParams.get('time') || 0);
    return json(res, 200, summarizeProject(ctx.getProject(), { segmentId, time }));
  });
}
