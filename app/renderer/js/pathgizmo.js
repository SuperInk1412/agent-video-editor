// 3D viewport gizmo: camera motion path, draggable nodes, bezier handles, grid.
// Draws on a transparent canvas sitting on top of the WebGL stage; the stage
// owns pointer events, this module only knows how to draw and hit-test.
import { evalCamera, pathPos } from '/core/camera.js';

const CYAN = '#17d9ff';
const YELLOW = '#ffd166';
const ORANGE = '#ff9f43';
const GREEN = '#4ade80';

export class PathGizmo {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts; // { project, time, editMode, grid, project(world), stage() }
    this.sel = -1;
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

    // handles of the selected node
    if (this.sel >= 0 && this.sel < keys.length) {
      const key = keys[this.sel];
      const prev = keys[this.sel - 1] || key;
      const next = keys[this.sel + 1] || key;
      this._handle(ctx, key, prev, next, 'out', ORANGE, k);
      this._handle(ctx, key, prev, next, 'in', GREEN, k);
    }

    // nodes
    keys.forEach((key, i) => {
      const s = this.project(key.pos);
      if (!s) return;
      const active = i === this.sel;
      const hot = this.hover?.kind === 'node' && this.hover.index === i;
      const r = (active || hot ? 5.4 : 4.2);
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fillStyle = active ? YELLOW : '#071018';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = active ? YELLOW : CYAN;
      ctx.stroke();
      if (active || hot) {
        ctx.fillStyle = 'rgba(207,226,242,.9)';
        ctx.font = `${10 * k}px ui-monospace, monospace`;
        ctx.fillText(`${key.t.toFixed(2)}s`, s[0] + 8 * k, s[1] - 7 * k);
      }
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
