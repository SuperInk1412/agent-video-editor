// Rotation ball: drag a point on a sphere to set an element/object direction.
// Directions are unit vectors (`dir` tracks); key dots show existing direction
// keys. The widget is display-only — the inspector owns the op scheduling.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Fixed orthographic view of the ball, slightly from above/right.
const VIEW = norm([0.5, 0.36, 1]);
const RIGHT = norm(cross([0, 1, 0], VIEW));
const UP = cross(VIEW, RIGHT);

const SIZE = 168;
const R = SIZE * 0.44;

function projectDir(d) {
  return { x: dot(d, RIGHT), y: dot(d, UP), z: dot(d, VIEW) };
}

export class RotBall {
  constructor(host, { dir, keys = [], time = 0, onChange, onStart, onEnd } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rotball';
    this.canvas.width = SIZE * 2;
    this.canvas.height = SIZE * 2;
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE}px`;
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.dir = (Array.isArray(dir) ? dir : [0, 0, -1]).slice();
    this.keys = keys;
    this.time = time;
    this.onChange = onChange;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.dragging = false;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.onStart?.();
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this._move(e);
      e.preventDefault();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this._move(e);
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this._move(e);
      this.onEnd?.();
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', () => { if (this.dragging) { this.dragging = false; this.onEnd?.(); } });
    this.canvas.addEventListener('pointerleave', () => { /* keep dragging while captured */ });
    this.draw();
  }

  _dirAt(e) {
    const r = this.canvas.getBoundingClientRect();
    let x = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    let y = 1 - ((e.clientY - r.top) / Math.max(1, r.height)) * 2;
    const l = Math.hypot(x, y);
    const max = 0.97;
    if (l > max) { x = (x / l) * max; y = (y / l) * max; }
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    return norm([0, 1, 2].map((i) => RIGHT[i] * x + UP[i] * y + VIEW[i] * z));
  }

  _move(e) {
    this.dir = this._dirAt(e);
    this.draw();
    this.onChange?.(this.dir.slice());
  }

  _pt(d) {
    const p = projectDir(d);
    return { x: SIZE + p.x * R, y: SIZE - p.y * R, z: p.z };
  }

  _ring(axisA, axisB, color, width = 1) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const d = [0, 1, 2].map((k) => axisA[k] * Math.cos(a) + axisB[k] * Math.sin(a));
      const p = projectDir(d);
      if (p.z < -0.02) { pen = false; continue; }
      const x = SIZE + p.x * R;
      const y = SIZE - p.y * R;
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  }

  draw() {
    const ctx = this.ctx;
    const k = 2; // canvas is 2x for sharpness
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // ball body
    const bg = ctx.createRadialGradient(SIZE * 0.38, SIZE * 0.3, 8, SIZE * 0.5, SIZE * 0.5, R * 1.2);
    bg.addColorStop(0, '#132330');
    bg.addColorStop(1, '#080d13');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(23,217,255,.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // wireframe great circles
    this._ring(RIGHT, UP, 'rgba(23,217,255,.16)');
    this._ring(RIGHT, VIEW, 'rgba(23,217,255,.22)');
    this._ring(UP, VIEW, 'rgba(23,217,255,.22)');
    this._ring(norm([0.7, 0, 0.7]), UP, 'rgba(23,217,255,.10)');
    this._ring(norm([-0.7, 0, 0.7]), UP, 'rgba(23,217,255,.10)');

    // existing direction keys
    for (const key of this.keys) {
      if (!Array.isArray(key.v)) continue;
      const p = this._pt(key.v);
      const front = p.z >= -0.02;
      const px = front ? p.x : SIZE / 2 + (p.x - SIZE / 2) * 0.98;
      const py = front ? p.y : SIZE / 2 + (p.y - SIZE / 2) * 0.98;
      const at = Math.abs((key.t ?? -99) - this.time) < 0.05;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = at ? '#ffd166' : front ? 'rgba(94,231,255,.9)' : 'rgba(94,231,255,.35)';
      ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
      ctx.restore();
    }

    // current direction
    const p = this._pt(this.dir);
    const visible = p.z >= 0;
    const px = SIZE / 2 + (p.x - SIZE / 2) * (visible ? 1 : 0.98);
    const py = SIZE / 2 + (p.y - SIZE / 2) * (visible ? 1 : 0.98);
    ctx.strokeStyle = visible ? 'rgba(255,209,102,.7)' : 'rgba(255,209,102,.25)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, SIZE / 2);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.fillStyle = visible ? '#ffd166' : 'rgba(255,209,102,.45)';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#071018';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (visible) {
      ctx.strokeStyle = 'rgba(255,209,102,.35)';
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.stroke();
    }

    // caption
    ctx.fillStyle = 'rgba(160,180,196,.8)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('拖动 = 朝向', SIZE / 2, SIZE - 4);
  }
}
