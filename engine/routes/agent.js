// The edit agent: one `AgentLoop` run at a time (WP2.5e).
//
//   POST /api/agent          start a run (`{ task }`; selection + time become context)
//   POST /api/agent/approve  approve the plan the loop is waiting on (`{ planId }`)
//   POST /api/agent/cancel   ask the loop to stop between steps
//   GET  /api/agent/state    running / runId / the loop state
//   GET  /api/context        what the playhead sees, for the agent prompt
//
// `ctx.agent` is the `AgentLoop` the engine creates lazily (engine/server.js
// picks its transport), so every write the agent makes is a change set
// (WP2.2) and a big plan stops at `awaiting-approval` until a human approves
// it (WP2.4). The old one-shot `AgentRunner` is gone; reverting the WP2.5e
// deletion commit is the way back.
import { summarizeProject } from '../storyboard.js';

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The state `GET /api/agent/state` returns. The log is capped because it grows
 * with every turn; the arrays the review panel needs are passed through as-is.
 */
export function publicState(state) {
  if (!state) return null;
  return {
    runId: state.runId,
    version: state.version,
    status: state.status,
    task: state.task,
    actorId: state.actorId,
    mode: state.mode,
    approval: state.approval,
    context: state.context ?? null,
    scope: state.scope,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    rev: state.rev,
    plan: state.plan,
    approved: state.approved,
    changesets: state.changesets,
    applyLog: state.applyLog,
    stills: state.stills,
    measurements: state.measurements,
    rejections: state.rejections,
    contract: state.contract,
    beats: state.beats,
    finalText: state.finalText,
    steps: state.steps,
    planPhase: state.planPhase,
    log: (state.log || []).slice(-200),
  };
}

/** What a `run` / `approve` response carries: status and evidence, not the report. */
function runSummary(result) {
  return {
    runId: result.runId,
    status: result.status,
    task: result.task,
    agentText: result.agentText ?? null,
    revision: result.revision,
    plan: result.plan,
    approved: result.approved ?? null,
    changesets: (result.changesets || []).map((row) => ({
      id: row.id,
      action: row.action ?? null,
      status: row.status,
      baseRev: row.baseRev ?? null,
      rev: row.rev ?? null,
      opsCount: row.opsCount ?? null,
      changed: (row.changed || []).length,
    })),
    stills: (result.stills || []).length,
    measurements: (result.measurements || []).length,
    rejections: (result.rejections || []).length,
    contract: result.contract,
    verification: result.report?.verificationSummary ?? null,
    mismatch: result.report?.mismatch ?? null,
    reportPath: result.reportPath ?? null,
  };
}

const AGENT_STATUS = {
  INVALID_ARGUMENT: 400, TOO_MANY_OPS: 400, OP_INVALID: 400, AGENT_LOOP_LIMIT: 400,
  AGENT_UNAVAILABLE: 503,
};

/** One place that maps a loop/transport error onto the JSON error contract. */
export function errorResponse(json, res, error) {
  const code = error?.code || 'INTERNAL_ERROR';
  const status = AGENT_STATUS[code]
    || (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500);
  return json(res, status, { error: error?.message || String(error), code });
}

export function register(router, ctx) {
  const { json, readBody } = ctx;
  const loop = () => ctx.agent;

  router.post('/api/agent', async (req, res) => {
    const body = await readBody(req);
    const agent = loop();
    if (agent.running) return json(res, 409, { error: 'agent already running', code: 'AGENT_RUNNING' });
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    if (!task) return json(res, 400, { error: 'a run needs a task', code: 'INVALID_ARGUMENT' });
    // The loop reads the project itself; the request only contributes what the
    // playhead saw (selection / time), which the transport gets as context.
    const context = {
      selection: isRecord(body.selection) ? body.selection : {},
      time: Number.isFinite(Number(body.time)) ? Number(body.time) : 0,
      ...(Array.isArray(body.frames) ? { frames: body.frames.length } : {}),
    };
    try {
      const result = await agent.run({ task, context });
      return json(res, 200, { ok: true, ...runSummary(result) });
    } catch (error) {
      return errorResponse(json, res, error);
    }
  });

  router.post('/api/agent/approve', async (req, res) => {
    const body = await readBody(req);
    const agent = loop();
    if (agent.running) return json(res, 409, { error: 'agent already running', code: 'AGENT_RUNNING' });
    const state = agent.state;
    if (!state || state.status !== 'awaiting-approval') {
      return json(res, 404, { error: 'no plan is awaiting approval', code: 'NO_PENDING_PLAN' });
    }
    const planId = typeof body.planId === 'string' && body.planId ? body.planId : null;
    if (planId && state.plan?.id && planId !== state.plan.id) {
      return json(res, 404, { error: `plan ${planId} is not awaiting approval (${state.plan.id})`, code: 'NO_PENDING_PLAN' });
    }
    try {
      const result = await agent.approve({ planId });
      return json(res, 200, { ok: true, ...runSummary(result) });
    } catch (error) {
      return errorResponse(json, res, error);
    }
  });

  router.post('/api/agent/cancel', async (req, res) => {
    const agent = loop();
    const cancelled = agent.cancel('user');
    return json(res, 200, { ok: cancelled, running: agent.running, runId: agent.runId, status: agent.state?.status ?? null });
  });

  router.get('/api/agent/state', async (req, res) => {
    const agent = loop();
    return json(res, 200, {
      ok: true,
      running: agent.running,
      runId: agent.runId,
      transport: agent.agent?.name ?? null,
      state: publicState(agent.state),
    });
  });

  // ---------------- timeline context for the agent --------------
  router.get('/api/context', async (req, res, { url }) => {
    const segmentId = url.searchParams.get('segment');
    const time = Number(url.searchParams.get('time') || 0);
    return json(res, 200, summarizeProject(ctx.getProject(), { segmentId, time }));
  });
}
