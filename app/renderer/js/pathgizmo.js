// 3D viewport gizmo: camera motion path, draggable nodes, bezier handles, grid.
// Draws on a transparent canvas sitting on top of the WebGL stage; the stage
// owns pointer events, this module only knows how to draw and hit-test.
import { evalCamera, pathPos, cameraTransform } from '/core/camera.js';
import { worldPose, childrenOf, parentIdOf } from '/core/hierarchy.js';

const CYAN = '#17d9ff';
const YELLOW = '#ffd166';
const ORANGE = '#ff9f43';
const GREEN = '#4ade80';

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class PathGizmo {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts; // { project, time, editMode, grid, project(world), stage() }
    this.sel = -1;
    this.liveSel = false;
    this.objSel = null;
    this.objHover = null;
    this.axisHover = null;
    this.hover = null;
  }

  resize() {
    const stage = this.opts.stage();
    if (!stage) return;
    this.canvas.width = stage.width;
    this.canvas.height = stage.height;
  }

  /** World pose of a scene object (parent chain included). */
  _worldPose(obj, time) {
    return worldPose(this.opts.project(), obj, time);
  }

  get scale() {
    const r = this.canvas.getBoundingClientRect();
    return this.canvas.width / Math.max(1, r.width);
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
  }

  camera() {
    const p = this.opts.project();
    return p?.camera || null;
  }

  /** Pose of the shot camera at the playhead (shake disabled). */
  liveState() {
    const project = this.opts.project();
    if (!project?.camera) return null;
    return evalCamera(this.clean(project), this.opts.time());
  }

  /** A path key already sits on the playhead (the live camera would double it). */
  keyAtTime() {
    const cam = this.camera();
    const t = this.opts.time();
    return !!cam?.path?.some((k) => Math.abs(k.t - t) < 1e-3);
  }

  /** The live frustum is only drawn when the editor camera is away from it. */
  liveVisible() {
    const st = this.liveState();
    const vc = this.opts.viewCam?.();
    if (!st || !vc) return false;
    if (this.keyAtTime()) return false;
    return Math.hypot(st.pos[0] - vc.pos[0], st.pos[1] - vc.pos[1], st.pos[2] - vc.pos[2]) > 2.5;
  }

  /** Hit test the live camera body (edit mode, select mode). */
  hitLive(sx, sy) {
    if (!this.opts.editMode() || !this.liveVisible()) return null;
    const st = this.liveState();
    const p = this.project(st.pos);
    if (!p) return null;
    const k = this.scale;
    const d = Math.hypot(p[0] - sx / k, p[1] - sy / k);
    return d <= 14 ? { kind: 'live', pos: st.pos } : null;
  }

  project(p) {
    const s = this.opts.projectPoint(p);
    if (!s) return null;
    return [s.x / this.scale, s.y / this.scale, s.w];
  }

  /** Auto handle = Catmull-Rom tangent, same rule as core/camera.js. */
  handle(key, kind, prev, next) {
    const explicit = key[kind];
    if (Array.isArray(explicit) && explicit.length === 3) {
      return [key.pos[0] + explicit[0], key.pos[1] + explicit[1], key.pos[2] + explicit[2]];
    }
    const a = (next || key).pos;
    const b = (prev || key).pos;
    // out_i = (next - prev)/6 ; in_i = -(next - prev)/6
    const s = kind === 'out' ? 1 : -1;
    return [
      key.pos[0] + (a[0] - b[0]) / 6 * s,
      key.pos[1] + (a[1] - b[1]) / 6 * s,
      key.pos[2] + (a[2] - b[2]) / 6 * s,
    ];
  }

  /** World position of a path key: center(t) + relative path position. */
  worldKey(cam, key) {
    const center = cameraTransform(cam, key.t).center;
    return add3(center, key.pos);
  }

  /** World position of a bezier handle (also center + relative handle). */
  worldHandle(cam, key, kind, prev, next) {
    const center = cameraTransform(cam, key.t).center;
    return add3(center, this.handle(key, kind, prev, next));
  }

  /** Project copy with shake disabled, so the gizmo never jitters. */
  clean(project) {
    const cam = project?.camera;
    if (!cam) return project;
    return { ...project, camera: { ...cam, shake: { ...(cam.shake || {}), amp: 0 } } };
  }

  basis(st) {
    const f = norm3(sub3(st.look, st.pos));
    let r = norm3(cross3(f, [0, 1, 0]));
    let u = cross3(r, f);
    const roll = ((st.roll || 0) * Math.PI) / 180;
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const r2 = [r[0] * c + u[0] * s, r[1] * c + u[1] * s, r[2] * c + u[2] * s];
      const u2 = [u[0] * c - r[0] * s, u[1] * c - r[1] * s, u[2] * c - r[2] * s];
      r = norm3(r2);
      u = norm3(u2);
    }
    return { f, r, u };
  }

  /** Camera glyph: full frustum for the live camera, FOV wedge for path keys. */
  glyph(ctx, project, t, { main = false, selected = false } = {}) {
    const st = evalCamera(project, t);
    if (!st) return;
    const { f, r, u } = this.basis(st);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const fov = Math.min(179, Math.max(1, st.fov));
    const depth = main ? 14 : 5.5;
    const halfW = Math.tan((fov * Math.PI) / 360) * depth;
    const halfH = halfW / aspect;
    const apex = this.project(st.pos);
    if (!apex) return;
    const center = add3(st.pos, mul3(f, depth));
    const color = main
      ? (selected ? 'rgba(255,209,102,.95)' : 'rgba(255,255,255,.9)')
      : selected ? 'rgba(255,209,102,.95)' : 'rgba(23,217,255,.42)';
    const k = this.scale;
    ctx.strokeStyle = color;
    ctx.lineWidth = main ? 1.5 : selected ? 1.2 : 1;

    if (main) {
      const corners = [
        add3(add3(center, mul3(r, halfW)), mul3(u, halfH)),
        add3(add3(center, mul3(r, -halfW)), mul3(u, halfH)),
        add3(add3(center, mul3(r, -halfW)), mul3(u, -halfH)),
        add3(add3(center, mul3(r, halfW)), mul3(u, -halfH)),
      ].map((p) => this.project(p));

      // small camera body behind the apex
      const b1 = this.project(add3(st.pos, add3(mul3(f, -2.2), mul3(r, 1.1))));
      const b2 = this.project(add3(st.pos, add3(mul3(f, -2.2), mul3(r, -1.1))));
      if (b1 && b2) {
        ctx.beginPath();
        ctx.moveTo(apex[0], apex[1]);
        ctx.lineTo(b1[0], b1[1]);
        ctx.lineTo(b2[0], b2[1]);
        ctx.closePath();
        ctx.fillStyle = selected ? 'rgba(255,209,102,.24)' : 'rgba(255,255,255,.16)';
        ctx.fill();
        ctx.stroke();
      }
      for (const c of corners) {
        if (!c) continue;
        ctx.beginPath(); ctx.moveTo(apex[0], apex[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      }
      if (corners.every(Boolean)) {
        ctx.beginPath();
        corners.forEach((c, i) => (i ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1])));
        ctx.closePath();
        ctx.stroke();
      }
      const upEnd = this.project(add3(st.pos, add3(mul3(f, 3), mul3(u, 2.6))));
      if (upEnd) { ctx.beginPath(); ctx.moveTo(apex[0], apex[1]); ctx.lineTo(upEnd[0], upEnd[1]); ctx.stroke(); }
      const labelAt = this.project(add3(center, mul3(u, halfH + 2)));
      if (labelAt) {
        ctx.fillStyle = selected ? 'rgba(255,209,102,.95)' : 'rgba(255,255,255,.92)';
        ctx.font = `${11 * k}px ui-monospace, monospace`;
        const txt = st.fov >= 180 ? 'FOV 360° · 鱼眼' : `FOV ${Math.round(st.fov)}°`;
        ctx.fillText(txt, labelAt[0] + 6 * k, labelAt[1] - 5 * k);
      }
      if (selected) {
        ctx.beginPath();
        ctx.arc(apex[0], apex[1], 9, 0, Math.PI * 2);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      return;
    }

    // node glyph: a small, semi-transparent camera with its own frustum.
    // Size follows the view distance so it stays readable at any zoom.
    const vc = this.opts.viewCam?.();
    const dist = vc ? Math.hypot(st.pos[0] - vc.pos[0], st.pos[1] - vc.pos[1], st.pos[2] - vc.pos[2]) : 120;
    const nDepth = Math.min(45, Math.max(0.6, dist * 0.028));
    const nHalfW = Math.tan((fov * Math.PI) / 360) * nDepth;
    const nHalfH = nHalfW / aspect;
    const nCenter = add3(st.pos, mul3(f, nDepth));
    const nCorners = [
      add3(add3(nCenter, mul3(r, nHalfW)), mul3(u, nHalfH)),
      add3(add3(nCenter, mul3(r, -nHalfW)), mul3(u, nHalfH)),
      add3(add3(nCenter, mul3(r, -nHalfW)), mul3(u, -nHalfH)),
      add3(add3(nCenter, mul3(r, nHalfW)), mul3(u, -nHalfH)),
    ].map((p) => this.project(p));

    const bw = nDepth * 0.16;
    const b1 = this.project(add3(st.pos, add3(mul3(f, -nDepth * 0.28), mul3(r, bw))));
    const b2 = this.project(add3(st.pos, add3(mul3(f, -nDepth * 0.28), mul3(r, -bw))));
    if (b1 && b2) {
      ctx.beginPath();
      ctx.moveTo(apex[0], apex[1]);
      ctx.lineTo(b1[0], b1[1]);
      ctx.lineTo(b2[0], b2[1]);
      ctx.closePath();
      ctx.fillStyle = selected ? 'rgba(255,209,102,.20)' : 'rgba(23,217,255,.08)';
      ctx.fill();
      ctx.stroke();
    }
    for (const c of nCorners) {
      if (!c) continue;
      ctx.beginPath(); ctx.moveTo(apex[0], apex[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
    }
    if (nCorners.every(Boolean)) {
      ctx.beginPath();
      nCorners.forEach((c, i) => (i ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1])));
      ctx.closePath();
      ctx.stroke();
    }
    if (selected) {
      const label = this.project(add3(nCenter, mul3(u, nHalfH + nDepth * 0.25)));
      if (label) {
        ctx.fillStyle = 'rgba(255,209,102,.95)';
        ctx.font = `${10 * k}px ui-monospace, monospace`;
        ctx.fillText(`${t.toFixed(1)}s · ${Math.round(st.fov)}°`, label[0] + 5 * k, label[1] - 4 * k);
      }
    }
  }

  draw() {
    this.clear();
    const ctx = this.ctx;
    const project = this.opts.project();
    if (!project || this.opts.visible?.() === false) return;
    const time = this.opts.time();
    this._sceneObjects(ctx, project, time);
    const cam = this.camera();
    if (!cam || !Array.isArray(cam.path) || !cam.path.length) return;
    const k = this.scale;

    if (this.opts.editMode() && this.opts.grid()) this._grid(ctx, k);

    const keys = cam.path;
    // path polyline
    const t0 = keys[0].t, t1 = keys[keys.length - 1].t;
    const step = Math.max(0.02, (t1 - t0) / 480);
    ctx.strokeStyle = 'rgba(23,217,255,.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let pen = false;
    for (let t = t0; t <= t1 + 1e-6; t += step) {
      const world = add3(cameraTransform(cam, t).center, pathPos(cam, t));
      const s = this.project(world);
      if (!s) { pen = false; continue; }
      if (pen) ctx.lineTo(s[0], s[1]); else { ctx.moveTo(s[0], s[1]); pen = true; }
    }
    ctx.stroke();

    // Equal-time dots reveal the span curve's speed: tighter = slower.
    if (keys.some((key) => key.curve && Number.isFinite(Number(key.spanTo)))) {
      const dots = 42;
      ctx.fillStyle = 'rgba(255,209,102,.85)';
      for (let i = 0; i <= dots; i++) {
        const t = t0 + ((t1 - t0) * i) / dots;
        const world = add3(cameraTransform(cam, t).center, pathPos(cam, t));
        const s = this.project(world);
        if (s) ctx.fillRect(s[0] - 1.6, s[1] - 1.6, 3.2, 3.2);
      }
    }

    if (time >= t0 && time <= t1) {
      const world = add3(cameraTransform(cam, time).center, pathPos(cam, time));
      const now = this.project(world);
      if (now) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(now[0], now[1], 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(now[0], now[1], 6, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // camera orientation + fov at each key; the live frustum only once the
    // editor camera has moved away from the lens (otherwise we are inside it)
    const clean = this.clean(project);
    keys.forEach((key, i) => this.glyph(ctx, clean, key.t, { selected: i === this.sel }));
    if (this.opts.editMode() && this.liveVisible()) {
      this.glyph(ctx, clean, time, { main: true, selected: this.liveSel });
    }

    // handles of the selected node
    if (this.sel >= 0 && this.sel < keys.length) {
      const key = keys[this.sel];
      const prev = keys[this.sel - 1] || key;
      const next = keys[this.sel + 1] || key;
      this._handle(ctx, key, prev, next, 'out', ORANGE, k);
      this._handle(ctx, key, prev, next, 'in', GREEN, k);
    }

    // nodes: the mini cameras are the markers; only selected/hovered gets a ring
    keys.forEach((key, i) => {
      const active = i === this.sel;
      const hot = this.hover?.kind === 'node' && this.hover.index === i;
      if (!active && !hot) return;
      const s = this.project(this.worldKey(cam, key));
      if (!s) return;
      ctx.beginPath();
      ctx.arc(s[0], s[1], 6, 0, Math.PI * 2);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = active ? YELLOW : 'rgba(23,217,255,.7)';
      ctx.stroke();
    });
  }

  _handle(ctx, key, prev, next, kind, color, k) {
    const cam = this.camera();
    const a = this.project(this.worldKey(cam, key));
    const b = this.project(this.worldHandle(cam, key, kind, prev, next));
    if (!a || !b) return;
    const explicit = Array.isArray(key[kind]);
    ctx.strokeStyle = explicit ? color : 'rgba(255,255,255,.28)';
    ctx.lineWidth = explicit ? 1.4 : 1;
    ctx.setLineDash(explicit ? [] : [4, 4]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = explicit ? color : 'rgba(255,255,255,.45)';
    ctx.fillRect(b[0] - 3.2, b[1] - 3.2, 6.4, 6.4);
    ctx.strokeStyle = '#071018'; ctx.lineWidth = 1;
    ctx.strokeRect(b[0] - 3.2, b[1] - 3.2, 6.4, 6.4);
  }

  /** Eight world corners of a timeline element at time t. */
  objectCorners(obj, time) {
    const pose = this._worldPose(obj, time);
    const g = obj.geom && typeof obj.geom === 'object' ? obj.geom : {};
    const hx = 0.5 * Math.max(0.001, Number(g.w) || 2) * Math.abs(pose.scale[0] || 1);
    const hy = 0.5 * Math.max(0.001, Number(g.h) || 2) * Math.abs(pose.scale[1] || 1);
    const hz = 0.5 * Math.max(0.001, Number(g.d) || 2) * Math.abs(pose.scale[2] || 1);
    const { right: r, up: u, forward: f } = pose.basis;
    const c = pose.worldPos;
    const out = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          out.push([
            c[0] + r[0] * hx * sx + u[0] * hy * sy + f[0] * hz * sz,
            c[1] + r[1] * hx * sx + u[1] * hy * sy + f[1] * hz * sz,
            c[2] + r[2] * hx * sx + u[2] * hy * sy + f[2] * hz * sz,
          ]);
        }
      }
    }
    return out;
  }

  /** Editor-only locator for an empty: three short world-space bars, no box. */
  _emptyMarker(ctx, obj, time, color, label) {
    const k = this.scale;
    const pose = this._worldPose(obj, time);
    const c = this.project(pose.worldPos);
    if (!c) return;
    const s = (Math.abs(pose.scale[0]) + Math.abs(pose.scale[1]) + Math.abs(pose.scale[2])) / 3 || 1;
    const arm = 1.2 * s;
    const axes = [pose.basis.right, pose.basis.up, pose.basis.forward];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const a of axes) {
      const p0 = this.project([pose.worldPos[0] - a[0] * arm, pose.worldPos[1] - a[1] * arm, pose.worldPos[2] - a[2] * arm]);
      const p1 = this.project([pose.worldPos[0] + a[0] * arm, pose.worldPos[1] + a[1] * arm, pose.worldPos[2] + a[2] * arm]);
      if (!p0 || !p1) continue;
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(c[0] - 2, c[1] - 2, 4, 4);
    if (label) {
      ctx.font = `${10.5 * k}px ui-monospace, monospace`;
      ctx.fillText(label, c[0] + 8 * k, c[1] - 8 * k);
    }
  }

  /** Dashed leaders between the selected object and its parent/direct children. */
  _kinLines(ctx, project, active, time) {
    const objs = project.scene?.objects || [];
    const live = (o) => time >= (Number(o.start) || 0) - 1e-6 && time < (Number(o.start) || 0) + (Number(o.duration) || 0) - 1e-6;
    const targets = [];
    const pid = parentIdOf(active);
    if (pid) {
      const p = objs.find((o) => o.id === pid);
      if (p && live(p)) targets.push(p);
    }
    for (const id of childrenOf(project, active.id)) {
      const c = objs.find((o) => o.id === id);
      if (c && live(c)) targets.push(c);
    }
    if (!targets.length) return;
    const from = this.project(this._worldPose(active, time).worldPos);
    if (!from) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,209,102,.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (const t of targets) {
      const p = this.project(this._worldPose(t, time).worldPos);
      if (!p) continue;
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,209,102,.5)';
      ctx.fillRect(p[0] - 1.7, p[1] - 1.7, 3.4, 3.4);
    }
    ctx.restore();
  }

  /** Projected wireframe for the selected/hovered element. */
  _objectBox(ctx, obj, time, color, label) {
    if (obj.type === 'empty') { this._emptyMarker(ctx, obj, time, color, label); return; }
    const k = this.scale;
    const pts = this.objectCorners(obj, time).map((c) => this.project(c));
    if (pts.some((p) => !p)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      for (const bit of [1, 2, 4]) {
        if (i & bit) continue;
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[i | bit][0], pts[i | bit][1]);
      }
    }
    ctx.stroke();
    ctx.fillStyle = color;
    for (const p of pts) ctx.fillRect(p[0] - 1.6, p[1] - 1.6, 3.2, 3.2);
    if (label) {
      const top = pts.slice().sort((a, b) => a[1] - b[1])[0];
      ctx.font = `${10.5 * k}px ui-monospace, monospace`;
      ctx.fillStyle = color;
      ctx.fillText(label, top[0] + 6 * k, top[1] - 6 * k);
    }
  }

  _sceneObjects(ctx, project, time) {
    const objs = Array.isArray(project.scene?.objects) ? project.scene.objects : [];
    if (!objs.length) return;
    const live = (o) => time >= (Number(o.start) || 0) - 1e-6 && time < (Number(o.start) || 0) + (Number(o.duration) || 0) - 1e-6;
    const active = objs.find((o) => o.id === this.objSel && live(o));
    const hover = objs.find((o) => o.id === this.objHover && live(o));
    if (hover && hover !== active) this._objectBox(ctx, hover, time, 'rgba(23,217,255,.55)', null);
    if (active) {
      this._kinLines(ctx, project, active, time);
      for (const id of childrenOf(project, active.id)) {
        const child = objs.find((o) => o.id === id);
        if (child && live(child)) this._objectBox(ctx, child, time, 'rgba(255,209,102,.18)', null);
      }
      this._objectMotion(ctx, active, time);
      this._objectBox(ctx, active, time, 'rgba(255,209,102,.95)', active.name || active.id);
      this._objectAxes(ctx, active, time);
    }
  }

  /** Axis length for the move gizmo: ~72 CSS px at the current view distance. */
  _axisLen(pose) {
    const vc = this.opts.viewCam?.();
    const dist = vc ? Math.hypot(
      pose.pivot[0] - vc.pos[0], pose.pivot[1] - vc.pos[1], pose.pivot[2] - vc.pos[2],
    ) : 40;
    const fov = Math.max(5, Math.min(179, Number(vc?.fov) || 62));
    const w = this.canvas.width / Math.max(1, this.scale);
    const worldPerPx = (2 * Math.tan((fov * Math.PI) / 360) * dist) / Math.max(1, w);
    return Math.max(0.5, Math.min(40, worldPerPx * 72));
  }

  _axisPoint(pose, axis, len) {
    return [
      pose.pivot[0] + (axis === 'x' ? len : 0),
      pose.pivot[1] + (axis === 'y' ? len : 0),
      pose.pivot[2] + (axis === 'z' ? len : 0),
    ];
  }

  /** X/Y/Z arrows at the selected element's pivot (drag one to move on that axis). */
  _objectAxes(ctx, obj, time) {
    const pose = this._worldPose(obj, time);
    const p0 = this.project(pose.pivot);
    if (!p0) return;
    const k = this.scale;
    const len = this._axisLen(pose);
    const COLORS = { x: '#ff5c7a', y: '#4ade80', z: '#5aa9ff' };
    for (const axis of ['x', 'y', 'z']) {
      const p1 = this.project(this._axisPoint(pose, axis, len));
      if (!p1) continue;
      const active = this.axisHover === axis;
      const color = COLORS[axis];
      ctx.strokeStyle = active ? '#ffffff' : color;
      ctx.lineWidth = active ? 2.4 : 1.4;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l;
      const s = active ? 8 : 6;
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p1[0] - ux * s - uy * s * 0.5, p1[1] - uy * s + ux * s * 0.5);
      ctx.lineTo(p1[0] - ux * s + uy * s * 0.5, p1[1] - uy * s - ux * s * 0.5);
      ctx.closePath();
      ctx.fillStyle = active ? '#ffffff' : color;
      ctx.fill();
      ctx.font = `${9.5 * k}px ui-monospace, monospace`;
      ctx.fillStyle = active ? '#ffffff' : color;
      ctx.fillText(axis.toUpperCase(), p1[0] + 5 * k, p1[1] - 4 * k);
    }
  }

  /** Hit test the move-gizmo arrows (outer 80% only, so the box stays grabbable). */
  hitObjectAxis(sx, sy) {
    const project = this.opts.project();
    const obj = (project?.scene?.objects || []).find((o) => o.id === this.objSel);
    if (!obj) return null;
    const time = this.opts.time();
    const start = Number(obj.start) || 0;
    if (time < start - 1e-6 || time >= start + (Number(obj.duration) || 0)) return null;
    const pose = this._worldPose(obj, time);
    const p0 = this.project(pose.pivot);
    if (!p0) return null;
    const k = this.scale;
    const len = this._axisLen(pose);
    let best = null;
    for (const axis of ['x', 'y', 'z']) {
      const p1 = this.project(this._axisPoint(pose, axis, len));
      if (!p1) continue;
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const l2 = dx * dx + dy * dy;
      if (l2 < 1) continue;
      const t = Math.max(0.3, Math.min(1.05, ((sx / k - p0[0]) * dx + (sy / k - p0[1]) * dy) / l2));
      const d = Math.hypot(p0[0] + dx * t - sx / k, p0[1] + dy * t - sy / k);
      if (d <= 7 && (!best || d < best.d)) best = { axis, d, len, pivot: pose.pivot };
    }
    return best;
  }

  /** Sampled world path + pivot key nodes of the selected element. */
  objectMotion(obj, time) {
    const start = Number(obj.start) || 0;
    const end = start + (Number(obj.duration) || 0);
    const pts = [];
    const n = 96;
    for (let i = 0; i <= n; i++) {
      const t = start + (end - start) * (i / n);
      const pose = this._worldPose(obj, t);
      pts.push({ t, world: pose.worldPos, s: this.project(pose.worldPos) });
    }
    const keys = (obj.tracks?.pivot || [])
      .map((k, i) => {
        if (!Array.isArray(k.v)) return null;
        const pose = this._worldPose(obj, k.t);
        return { index: i, t: k.t, v: k.v, world: pose.worldPos, s: this.project(pose.worldPos) };
      })
      .filter(Boolean);
    return { pts, keys };
  }

  _objectMotion(ctx, obj, time) {
    const m = this.objectMotion(obj, time);
    ctx.strokeStyle = 'rgba(74,222,128,.55)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    let pen = false;
    for (const pt of m.pts) {
      if (!pt.s) { pen = false; continue; }
      if (pen) ctx.lineTo(pt.s[0], pt.s[1]);
      else { ctx.moveTo(pt.s[0], pt.s[1]); pen = true; }
    }
    ctx.stroke();
    for (const k of m.keys) {
      if (!k.s) continue;
      ctx.save();
      ctx.translate(k.s[0], k.s[1]);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = Math.abs(k.t - time) < 0.05 ? '#ffd166' : 'rgba(74,222,128,.95)';
      ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
      ctx.strokeStyle = '#071018';
      ctx.lineWidth = 1;
      ctx.strokeRect(-3.4, -3.4, 6.8, 6.8);
      ctx.restore();
    }
    const pose = this._worldPose(obj, time);
    const s = this.project(pose.worldPos);
    if (s) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(s[0], s[1], 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Hit test a pivot key node of the selected element. Only the key under the
   *  playhead is grabbable, so dragging the box elsewhere still makes a new key. */
  hitObjectKey(sx, sy) {
    const project = this.opts.project();
    const obj = (project?.scene?.objects || []).find((o) => o.id === this.objSel);
    if (!obj) return null;
    const k = this.scale;
    const time = this.opts.time();
    let best = null;
    for (const [i, key] of (obj.tracks?.pivot || []).entries()) {
      if (!Array.isArray(key.v) || Math.abs(key.t - time) > 0.05) continue;
      const pose = this._worldPose(obj, key.t);
      const p = this.project(pose.worldPos);
      if (!p) continue;
      const d = Math.hypot(p[0] - sx / k, p[1] - sy / k);
      if (d <= 11 && (!best || d < best.d)) best = { index: i, t: key.t, world: pose.worldPos, pivot: pose.pivot, d };
    }
    return best;
  }

  _grid(ctx, k) {
    const half = 600, step = 50;
    ctx.lineWidth = 1;
    for (let v = -half; v <= half; v += step) {
      const segs = [
        [[v, 0, -half], [v, 0, half]],
        [[-half, 0, v], [half, 0, v]],
      ];
      for (const [pa, pb] of segs) {
        const a = this.project(pa);
        const b = this.project(pb);
        if (!a || !b) continue;
        ctx.strokeStyle = v === 0 ? 'rgba(120,170,200,.28)' : 'rgba(120,170,200,.10)';
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
  }

  /** Hit test in stage drawing-buffer pixels. */
  hit(sx, sy) {
    const cam = this.camera();
    if (!cam || !cam.path?.length) return null;
    const k = this.scale;
    const dist = (p) => {
      const s = this.project(p);
      if (!s) return Infinity;
      return Math.hypot(s[0] - sx / k, s[1] - sy / k);
    };
    if (this.sel >= 0 && this.sel < cam.path.length) {
      const key = cam.path[this.sel];
      const prev = cam.path[this.sel - 1] || key;
      const next = cam.path[this.sel + 1] || key;
      for (const kind of ['out', 'in']) {
        if (dist(this.worldHandle(cam, key, kind, prev, next)) <= 9) return { kind, index: this.sel };
      }
    }
    let best = null;
    cam.path.forEach((key, i) => {
      const d = dist(this.worldKey(cam, key));
      if (d <= 10 && (!best || d < best.d)) best = { kind: 'node', index: i, d };
    });
    return best ? { kind: best.kind, index: best.index } : null;
  }

  /** World position of node / handle for the drag start. */
  handleWorld(index, kind) {
    const cam = this.camera();
    const key = cam?.path?.[index];
    if (!key) return null;
    if (kind === 'node') return this.worldKey(cam, key);
    const prev = cam.path[index - 1] || key;
    const next = cam.path[index + 1] || key;
    return this.worldHandle(cam, key, kind, prev, next);
  }
}

/** Camera state of the shot at time t (used when entering edit mode). */
export function shotCamera(project, t) {
  return evalCamera(project, t);
}
