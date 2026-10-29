// The `vdm` object injected into the sandbox plus the minimal drivers that turn
// one frame of user code into one canvas (§6.2).
//
// Runs *inside* the sandboxed page (served as `vdm-src://app/sdk.js`), so this
// file is browser-only: no `node:*`, no filesystem, no network.
//
// Contract (deterministic by construction):
//   - the canvas is cleared before every frame: frame N is a pure function of
//     (code, params, frame, size, seed), never of frame N-1;
//   - `Date.now`, `performance.now`, `requestAnimationFrame`, `Math.random` are
//     replaced for the duration of the frame (§5.2);
//   - fetch / XHR / WebSocket are not replaced — CSP `connect-src 'none'` makes
//     them fail loudly, which is what the sandbox test asserts.

import { RUNTIMES, SDK_VERSION } from './protocol.js';

export { RUNTIMES, SDK_VERSION };

/** Frozen clock base: 2025-01-01T00:00:00Z. `Date.now()` during frame N is this + t. */
export const FIXED_EPOCH = 1735689600000;

/** Where the vendored p5 lives (also listed in vendor/manifest.json). */
export const P5_URL = 'vdm-src://vendor/p5/p5.min.js';

// ---------------------------------------------------------------------------
// Deterministic numbers
// ---------------------------------------------------------------------------

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix integers into one 32 bit value (order matters, so it is a pure function). */
export function mix32(...values) {
  let h = 0x9e3779b9;
  for (const value of values) {
    const v = Number.isFinite(value) ? Math.trunc(value) : 0;
    h ^= Math.imul(v >>> 0, 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, seedable; identical on every engine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `vdm.random(i, k)` — a hash, not a stream: the same (i, k) always returns the
 * same number, whatever order the sketch asks in, and no state carries over
 * between frames. That is what makes random access to frame N exact.
 */
export function seededRandom(seed, frame, i = 0, k = 0) {
  return hashString(`${seed >>> 0}|${frame >>> 0}|${i}|${k}`) / 4294967296;
}

// ---------------------------------------------------------------------------
// Determinism shims (§5.2)
// ---------------------------------------------------------------------------

/**
 * Replace the wall clock and the animation loop for one frame.
 * Returns a restore function; always call it, even when user code throws.
 */
export function installDeterminism({ frame, fps, seed }) {
  const t = frame / fps;
  const fixedMs = FIXED_EPOCH + Math.round(t * 1000);
  const original = {
    dateNow: Date.now,
    perfNow: window.performance && window.performance.now,
    random: Math.random,
    raf: window.requestAnimationFrame,
    caf: window.cancelAnimationFrame,
  };
  const restore = [];
  const patch = (object, key, value) => {
    if (!object) return;
    const had = Object.prototype.hasOwnProperty.call(object, key);
    const before = object[key];
    try {
      object[key] = value;
    } catch {
      Object.defineProperty(object, key, { value, configurable: true, writable: true });
    }
    restore.push(() => {
      if (had) object[key] = before;
      else delete object[key];
    });
  };

  patch(Date, 'now', () => fixedMs);
  if (original.perfNow) patch(window.performance, 'now', () => t * 1000);
  patch(Math, 'random', mulberry32(mix32(seed, frame)));
  patch(window, 'requestAnimationFrame', () => 0); // never fires: no loop()/rAF driving
  patch(window, 'cancelAnimationFrame', () => {});

  return function restoreDeterminism() {
    for (const undo of restore.reverse()) undo();
  };
}

// ---------------------------------------------------------------------------
// vdm
// ---------------------------------------------------------------------------

/**
 * The object user code receives. Every field is a snapshot of this frame; the
 * object is frozen so a sketch cannot change what the next frame sees.
 */
export function createVdm({ runtime, frame, fps, size, params, seed, beat = null, volume = null }) {
  const width = size[0];
  const height = size[1];
  const frozen = Object.freeze({ ...params });
  return Object.freeze({
    sdk: SDK_VERSION,
    runtime,
    frame,
    t: frame / fps,
    fps,
    size: Object.freeze([width, height]),
    seed,
    params: frozen,
    /** Evaluated value of a manifest parameter; unknown names are a hard error. */
    param(name) {
      if (!Object.prototype.hasOwnProperty.call(frozen, name)) {
        throw new Error(`vdm.param('${name}')：manifest.params 里没有这个参数`);
      }
      return frozen[name];
    },
    /** Seeded, order independent random in [0, 1). */
    random(i = 0, k = 0) {
      return seededRandom(seed, frame, i, k);
    },
    /** Beat grid / audio envelope, as evaluated by the engine (null when absent). */
    beat,
    volume,
  });
}

// ---------------------------------------------------------------------------
// Colour + uniforms (GLSL runtime)
// ---------------------------------------------------------------------------

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` → [r, g, b] in 0..1, or null. */
export function parseColor(value) {
  if (Array.isArray(value) && value.length >= 3) return value.slice(0, 3).map(Number);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let match = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return [r, g, b];
  }
  match = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (match) {
    const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      const scale = parts.slice(0, 3).some((n) => n > 1) ? 255 : 1;
      return parts.slice(0, 3).map((n) => Math.min(1, Math.max(0, n / scale)));
    }
  }
  return null;
}

function uniformValueFor(type, gl, value) {
  switch (type) {
    case gl.FLOAT:
      return typeof value === 'number' ? value : Number(value);
    case gl.FLOAT_VEC2: {
      const array = Array.isArray(value) ? value : [value, value];
      return [Number(array[0]) || 0, Number(array[1]) || 0];
    }
    case gl.FLOAT_VEC3: {
      const color = parseColor(value);
      if (color) return color;
      const array = Array.isArray(value) ? value : [value, value, value];
      return [0, 1, 2].map((i) => Number(array[i]) || 0);
    }
    case gl.FLOAT_VEC4: {
      const color = parseColor(value);
      const base = color ? [...color, 1] : Array.isArray(value) ? value : [value, value, value, value];
      return [0, 1, 2, 3].map((i) => Number(base[i]) || 0);
    }
    case gl.INT:
    case gl.BOOL:
      return value ? 1 : 0;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Source loading helpers
// ---------------------------------------------------------------------------

const pick = (module, name) => {
  if (!module) return undefined;
  if (module[name] !== undefined) return module[name];
  const dflt = module.default;
  if (dflt && typeof dflt === 'object' && dflt[name] !== undefined) return dflt[name];
  return undefined;
};

function sourceFault(message, details = {}) {
  return Object.assign(new Error(message), { code: 'SOURCE_LOAD_FAILED', ...details });
}

// ---------------------------------------------------------------------------
// Driver: canvas2d
//
//   // sources/<id>/sketch.js
//   export function setup(ctx, vdm) {}      // optional, once per source load
//   export function draw(ctx, vdm) {}       // once per frame
// ---------------------------------------------------------------------------

function canvas2dDriver({ size }) {
  const canvas = document.createElement('canvas');
  canvas.width = size[0];
  canvas.height = size[1];
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: false });
  if (!ctx) throw sourceFault('canvas2d：无法创建 2D 画布');
  let draw = null;
  return {
    runtime: 'canvas2d',
    canvas,
    async load({ entryUrl, vdm }) {
      let module;
      try {
        module = await import(entryUrl);
      } catch (e) {
        throw sourceFault(`canvas2d：加载 ${entryUrl} 失败：${e.message}`, { cause: String(e) });
      }
      const setup = pick(module, 'setup');
      draw = pick(module, 'draw');
      if (typeof draw !== 'function') throw sourceFault('canvas2d：源需要导出 draw(ctx, vdm)');
      if (typeof setup === 'function') await setup(ctx, vdm);
    },
    render(vdm) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      draw(ctx, vdm);
      return canvas;
    },
    dispose() {},
  };
}

// ---------------------------------------------------------------------------
// Driver: p5 (instance mode, one draw per frame, no loop, no frameRate)
//
//   // sources/<id>/sketch.js
//   export default (p) => {
//     p.setup = () => p.createCanvas(vdm.size[0], vdm.size[1]);
//     p.draw = () => { ... };
//   };
// ---------------------------------------------------------------------------

let p5Loading = null;

function loadP5() {
  if (window.p5) return Promise.resolve(window.p5);
  if (p5Loading) return p5Loading;
  p5Loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = P5_URL;
    script.onload = () => (window.p5 ? resolve(window.p5) : reject(sourceFault('p5 脚本已加载但没有 window.p5')));
    script.onerror = () => reject(sourceFault(`p5 加载失败：${P5_URL}（vendor/ 是否完整？）`, { code: 'DEPENDENCY_MISSING' }));
    document.head.appendChild(script);
  });
  return p5Loading;
}

function p5Driver({ size, container }) {
  let instance = null;
  let canvas = null;
  let holder = null;
  return {
    runtime: 'p5',
    get canvas() { return canvas; },
    async load({ entryUrl, vdm, libs }) {
      const p5 = await loadP5();
      const wanted = libs && libs.p5;
      if (wanted && p5.VERSION !== wanted) {
        throw sourceFault(`manifest 要 p5 ${wanted}，vendor/ 里是 ${p5.VERSION}`, { code: 'DEPENDENCY_MISSING' });
      }
      let module;
      try {
        module = await import(entryUrl);
      } catch (e) {
        throw sourceFault(`p5：加载 ${entryUrl} 失败：${e.message}`, { cause: String(e) });
      }
      const sketch = pick(module, 'sketch') ?? module.default;
      if (typeof sketch !== 'function') throw sourceFault('p5：源需要 export default (p) => { ... }');

      holder = document.createElement('div');
      holder.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden';
      container.appendChild(holder);

      await new Promise((resolve, reject) => {
        let done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          if (error) reject(error);
          else resolve();
        };
        try {
          // p5 runs the sketch function and then setup() synchronously inside
          // the constructor; `pp.setup` is replaced so the frame size and the
          // no-loop policy win over whatever the sketch asked for.
          instance = new p5((pp) => {
            try {
              // The sketch function only receives the p5 instance, so the
              // frame's numbers ride on it: `p.vdm` is available from setup()
              // onwards and is replaced before every redraw (§6.2).
              pp.vdm = vdm;
              pp.pixelDensity(1);
              pp.noLoop();
              pp.loop = () => {}; // §6.2: loop() is a no-op in the sandbox
              pp.frameRate = () => {}; // §6.2: frameRate() is a no-op
              sketch(pp);
              const userSetup = pp.setup;
              pp.setup = function p5Setup() {
                try {
                  pp.pixelDensity(1);
                  if (typeof userSetup === 'function') userSetup.call(pp);
                  pp.noLoop();
                  if (pp.canvas) canvas = pp.canvas;
                  if (!canvas) canvas = pp.createCanvas(size[0], size[1]).elt;
                  else if (canvas.width !== size[0] || canvas.height !== size[1]) pp.resizeCanvas(size[0], size[1], true);
                  finish();
                } catch (e) {
                  finish(e);
                }
              };
            } catch (e) {
              finish(e);
            }
          }, holder);
        } catch (e) {
          finish(e);
        }
        // Defensive: a p5 build that (for whatever reason) never calls setup
        // must not hang the frame budget silently.
        if (!done && instance && instance.canvas) {
          canvas = instance.canvas;
          finish();
        }
      });
      if (!canvas) throw sourceFault('p5：没有画布（请在 setup() 里 createCanvas）');
      if (canvas.width !== size[0] || canvas.height !== size[1]) {
        throw sourceFault(`p5：画布尺寸是 ${canvas.width}x${canvas.height}，期望 ${size[0]}x${size[1]}`);
      }
    },
    render(vdm) {
      // The sketch function only receives the p5 instance, so this is the one
      // channel for the frame's numbers: `p.vdm.frame`, `p.vdm.param('…')`,
      // `p.vdm.random(…)`. Set before every redraw so `p.draw()` sees the
      // frame that is being rendered (§6.2).
      instance.vdm = vdm;
      instance.redraw();
      return canvas;
    },
    dispose() {
      try { instance?.remove(); } catch { /* already gone */ }
      try { holder?.remove(); } catch { /* already gone */ }
      instance = null;
      canvas = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Driver: glsl (one fragment shader + a fullscreen quad)
//
//   // sources/<id>/shader.frag (or a .js module exporting `frag`)
//   uniforms: u_time, u_resolution, u_frame, u_fps, u_seed, u_<param>
// ---------------------------------------------------------------------------

const QUAD_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** Fill in the boilerplate a fragment-only author should not have to write. */
export function prepareFragment(source) {
  const text = String(source || '');
  if (/#version\s+300\s+es/.test(text)) return text;
  const prologue = ['#version 300 es', 'precision highp float;'];
  if (/\bgl_FragColor\b/.test(text)) {
    prologue.push('layout(location = 0) out vec4 vdmFragColor;', '#define gl_FragColor vdmFragColor');
  }
  return `${prologue.join('\n')}\n${text}`;
}

function glslDriver({ size, shaderText }) {
  const canvas = document.createElement('canvas');
  canvas.width = size[0];
  canvas.height = size[1];
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true, // §5.3: we read the frame back in the same task
  });
  if (!gl) throw sourceFault('glsl：没有 WebGL2 上下文');

  const compile = (type, source, label) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || 'unknown';
      gl.deleteShader(shader);
      throw sourceFault(`glsl：${label} 编译失败：${log}`, { shaderLog: log, code: 'SOURCE_LOAD_FAILED' });
    }
    return shader;
  };

  let program = null;
  let uniforms = [];
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const draw = (vdm) => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const uniform of uniforms) {
      const { location, type, name } = uniform;
      if (name === 'u_time') gl.uniform1f(location, vdm.t);
      else if (name === 'u_frame') gl.uniform1f(location, vdm.frame);
      else if (name === 'u_fps') gl.uniform1f(location, vdm.fps);
      else if (name === 'u_seed') gl.uniform1f(location, vdm.seed >>> 0);
      else if (name === 'u_resolution') gl.uniform2f(location, canvas.width, canvas.height);
      else if (name.startsWith('u_')) {
        const key = name.slice(2);
        if (!Object.prototype.hasOwnProperty.call(vdm.params, key)) continue; // not a manifest param
        const value = uniformValueFor(type, gl, vdm.params[key]);
        if (value === null) continue;
        if (Array.isArray(value)) {
          if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
          else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
          else gl.uniform4f(location, value[0], value[1], value[2], value[3]);
        } else if (type === gl.INT || type === gl.BOOL) gl.uniform1i(location, value);
        else gl.uniform1f(location, value);
      }
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  return {
    runtime: 'glsl',
    canvas,
    async load({ entryUrl, module, vdm }) {
      let source = shaderText;
      if (!source) {
        let mod = module;
        if (!mod) {
          try {
            mod = await import(entryUrl);
          } catch (e) {
            throw sourceFault(`glsl：加载 ${entryUrl} 失败：${e.message}`, { cause: String(e) });
          }
        }
        source = pick(mod, 'frag');
        if (source === undefined) source = typeof mod.default === 'string' ? mod.default : undefined;
        if (typeof source === 'function') source = source(vdm);
      }
      if (typeof source !== 'string' || !source.trim()) throw sourceFault('glsl：源需要是片元着色器文本（.frag 或 export const frag）');
      const vertex = compile(gl.VERTEX_SHADER, QUAD_VERT, '顶点着色器');
      const fragment = compile(gl.FRAGMENT_SHADER, prepareFragment(source), '片元着色器');
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw sourceFault(`glsl：链接失败：${gl.getProgramInfoLog(program) || 'unknown'}`);
      }
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      uniforms = [];
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (!info) continue;
        uniforms.push({ name: info.name, type: info.type, location: gl.getUniformLocation(program, info.name) });
      }
    },
    render(vdm) {
      draw(vdm);
      return canvas;
    },
    dispose() {
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a driver for one source.
 * @param {object} input
 * @param {'canvas2d'|'p5'|'glsl'} input.runtime
 * @param {[number, number]} input.size
 * @param {string} input.entryUrl absolute `vdm-src://source/...` URL of the entry
 * @param {string} [input.shaderText] fragment source, when the pool already read it
 * @param {HTMLElement} input.container
 */
export function createDriver(input) {
  switch (input.runtime) {
    case 'canvas2d': return canvas2dDriver(input);
    case 'p5': return p5Driver(input);
    case 'glsl': return glslDriver(input);
    default:
      throw sourceFault(`不支持的 runtime：${input.runtime}（支持 ${RUNTIMES.join(' / ')}）`, { code: 'UNSUPPORTED_RUNTIME' });
  }
}

/** Turn `canvas.toDataURL()` into the payload the pool wants. */
export async function canvasPayload(canvas, { wantRgba = false } = {}) {
  const png = canvas.toDataURL('image/png');
  const comma = png.indexOf(',');
  if (comma < 0) throw new Error('canvas.toDataURL 没有返回数据');
  const payload = { png: png.slice(comma + 1), width: canvas.width, height: canvas.height };
  if (wantRgba) {
    const context = canvas.getContext('2d');
    if (!context) {
      // WebGL canvases: read through a 2D copy.
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx2d = copy.getContext('2d');
      ctx2d.drawImage(canvas, 0, 0);
      const data = ctx2d.getImageData(0, 0, copy.width, copy.height).data;
      payload.rgba = bytesToBase64(data);
    } else {
      payload.rgba = bytesToBase64(context.getImageData(0, 0, canvas.width, canvas.height).data);
    }
  }
  return payload;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
