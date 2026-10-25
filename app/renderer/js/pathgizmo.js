// 3D viewport gizmo: camera motion path, draggable nodes, bezier handles, grid.
// Draws on a transparent canvas sitting on top of the WebGL stage; the stage
// owns pointer events, this module only knows how to draw and hit-test.
import { evalCamera, pathPos } from '/core/camera.js';

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
    this.hover = null;
  }

  resize() {
    const stage = this.opts.stage();
    if (!stage) return;
    this.canvas.width = stage.width;
    this.canvas.height = stage.height;
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
      const s = this.project(pathPos(cam, t));
      if (!s) { pen = false; continue; }
      if (pen) ctx.lineTo(s[0], s[1]); else { ctx.moveTo(s[0], s[1]); pen = true; }
    }
    ctx.stroke();

    const time = this.opts.time();
    if (time >= t0 && time <= t1) {
      const now = this.project(pathPos(cam, time));
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
      const s = this.project(key.pos);
      if (!s) return;
      ctx.beginPath();
      ctx.arc(s[0], s[1], 6, 0, Math.PI * 2);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = active ? YELLOW : 'rgba(23,217,255,.7)';
      ctx.stroke();
    });
  }

  _handle(ctx, key, prev, next, kind, color, k) {
    const self = this;
    const h = this.handle(key, kind, prev, next);
    const a = this.project(key.pos);
    const b = this.project(h);
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
        if (dist(this.handle(key, kind, prev, next)) <= 9) return { kind, index: this.sel };
      }
    }
    let best = null;
    cam.path.forEach((key, i) => {
      const d = dist(key.pos);
      if (d <= 10 && (!best || d < best.d)) best = { kind: 'node', index: i, d };
    });
    return best ? { kind: best.kind, index: best.index } : null;
  }

  /** World position of node / handle for the drag start. */
  handleWorld(index, kind) {
    const cam = this.camera();
    const key = cam?.path?.[index];
    if (!key) return null;
    if (kind === 'node') return key.pos.slice();
    const prev = cam.path[index - 1] || key;
    const next = cam.path[index + 1] || key;
    return this.handle(key, kind, prev, next);
  }
}

/** Camera state of the shot at time t (used when entering edit mode). */
export function shotCamera(project, t) {
  return evalCamera(project, t);
}
