// Speed-curve editor: per-segment timing on a keyframe (`key.speed`), the
// design's "[u,v] polyline integrated into arc length" control. The widget is
// display-only; the inspector schedules the ops and keeps the row open.

const W = 236;
const H = 92;
const PAD = 14;
const VMAX = 3;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function defaults() {
  return [[0, 1], [0.5, 1], [1, 1]];
}

function normalize(points) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [clamp(Number(p[0]), 0, 1), clamp(Number(p[1]), 0, VMAX)])
    .sort((a, b) => a[0] - b[0]);
  return pts.length >= 2 ? pts : defaults();
}

export const SPEED_PRESETS = {
  linear: [[0, 1], [1, 1]],
  easeIn: [[0, 0.12], [0.5, 0.6], [1, 1]],
  easeOut: [[0, 1], [0.5, 0.6], [1, 0.12]],
  punch: [[0, 2.4], [0.55, 0.35], [1, 1]],
};

export class SpeedCurve {
  constructor(host, { points, onChange, onStart, onEnd } = {}) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'speedcurve';
    this.canvas.width = W * 2;
    this.canvas.height = H * 2;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.points = normalize(points);
    this.onChange = onChange;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.drag = null;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = this._at(e);
      let best = -1, bd = 16;
      this.points.forEach((pt, i) => {
        const d = Math.hypot(this._x(pt[0]) - p.x, this._y(pt[1]) - p.y);
        if (d < bd) { bd = d; best = i; }
      });
      if (best < 0) return;
      this.drag = { index: best, x: p.x, y: p.y };
      this.onStart?.();
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.draw();
      e.preventDefault();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = this._at(e);
      const i = this.drag.index;
      const last = this.points.length - 1;
      const v = clamp(this._v(p.y), 0, VMAX);
      if (i > 0 && i < last) {
        const u = clamp(this._u(p.x), this.points[i - 1][0] + 0.05, this.points[i + 1][0] - 0.05);
        this.points[i] = [Math.round(u * 100) / 100, Math.round(v * 100) / 100];
      } else {
        this.points[i] = [this.points[i][0], Math.round(v * 100) / 100];
      }
      this.points.sort((a, b) => a[0] - b[0]);
      this.draw();
      this.onChange?.(this.points.map((pt) => pt.slice()));
    });
    const end = () => {
      if (!this.drag) return;
      this.drag = null;
      this.onEnd?.();
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.draw();
  }

  setPoints(points) {
    this.points = normalize(points);
    this.draw();
  }

  _u(x) { return clamp((x - PAD) / (W - PAD * 2), 0, 1); }
  _v(y) { return clamp((H - PAD - y) / (H - PAD * 2), 0, 1) * VMAX; }
  _x(u) { return PAD + u * (W - PAD * 2); }
  _y(v) { return H - PAD - (v / VMAX) * (H - PAD * 2); }
  _at(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * W,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * H,
    };
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1016';
    ctx.fillRect(0, 0, W, H);
    // grid: quarters + baseline v=1
    ctx.strokeStyle = 'rgba(120,170,200,.14)';
    ctx.lineWidth = 1;
    for (const u of [0.25, 0.5, 0.75]) {
      ctx.beginPath(); ctx.moveTo(this._x(u), PAD); ctx.lineTo(this._x(u), H - PAD); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120,170,200,.26)';
    ctx.beginPath(); ctx.moveTo(PAD, this._y(1)); ctx.lineTo(W - PAD, this._y(1)); ctx.stroke();
    ctx.fillStyle = 'rgba(140,160,180,.6)';
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText('1.0×', 2, this._y(1) - 2);

    // curve
    const pts = this.points;
    ctx.beginPath();
    ctx.moveTo(this._x(pts[0][0]), this._y(pts[0][1]));
    for (const p of pts.slice(1)) ctx.lineTo(this._x(p[0]), this._y(p[1]));
    ctx.strokeStyle = '#5ee7ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // area fill
    ctx.lineTo(this._x(pts[pts.length - 1][0]), H - PAD);
    ctx.lineTo(this._x(pts[0][0]), H - PAD);
    ctx.closePath();
    ctx.fillStyle = 'rgba(23,217,255,.08)';
    ctx.fill();

    // draggable points
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(this._x(p[0]), this._y(p[1]), 3.6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd166';
      ctx.fill();
      ctx.strokeStyle = '#071018';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(140,160,180,.55)';
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText('速度曲线（相对值）', PAD, H - 4);
  }
}
