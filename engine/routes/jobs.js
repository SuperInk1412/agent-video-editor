// Render jobs: stills, videos and the job list.
//
//   POST /api/still          one preview frame, waits for the job, returns the artifact
//   POST /api/render         submit a video render, returns the job id + live state
//   POST /api/render/cancel  cancel the active job
//   GET  /api/jobs           every job this engine knows about
export function register(router, ctx) {
  const { json, readBody, jobs, renderState } = ctx;

  router.post('/api/still', async (req, res) => {
    const body = await readBody(req);
    const submitted = await jobs.submit({ kind: 'still', time: body.time ?? 0, scale: body.scale ?? 0.5,
      samples: body.samples ?? 8, expectedRev: body.expectedRev, requestId: body.requestId });
    const completed = await jobs.wait(submitted.id);
    if (completed.status !== 'succeeded') throw Object.assign(new Error(completed.error?.message || completed.status), completed.error || {});
    return json(res, 200, completed.artifact);
  });
  router.post('/api/render', async (req, res) => {
    const body = await readBody(req);
    const submitted = await jobs.submit({ kind: 'video', from: body.from ?? 0, to: body.to ?? ctx.getProject().meta.duration,
      scale: body.scale ?? 1, crf: body.crf ?? 18, expectedRev: body.expectedRev, requestId: body.requestId });
    return json(res, 200, { ok: true, jobId: submitted.id, state: renderState });
  });
  router.post('/api/render/cancel', async (req, res) => {
    const body = await readBody(req);
    const id = body.id || jobs.active?.id || renderState.jobId;
    return json(res, 200, { ok: true, ...(id ? { job: await jobs.cancel(id) } : {}) });
  });
  router.get('/api/jobs', async (req, res) => json(res, 200, { jobs: await jobs.list() }));
}
