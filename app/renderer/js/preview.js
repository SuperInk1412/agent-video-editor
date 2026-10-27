// Realtime preview: WebGL2 compositor that mirrors blender/vdm_build.py.
// Layers -> scene FBO -> bloom chain -> composite (CA, grain, scanlines, vignette, grade).
import { evalElement } from '/core/evaluate.js';
import { clamp } from '/core/time.js';
import { cameraTransform, evalCamera, cameraLayers } from '/core/camera.js';
import { Scene3D } from './preview3d.js';

const VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat3 u_mat;
uniform vec2 u_res;
// World mode (2D elements in the unified space, docs/DESIGN-UNIFIED-SPACE.md):
// canvas pixels -> project pixels -> metres on the screen plane at depth u_z,
// then the 3D camera. u_px2w = (canvas centre x, y, canvas px per project px,
// screen-plane centre height in metres).
uniform float u_world;
uniform mat4 u_vp;
uniform vec4 u_px2w;
uniform float u_z;
out vec2 v_uv;
void main(){
  vec3 p = u_mat * vec3(a_pos, 1.0);
  if (u_world > 0.5) {
    vec2 q = (p.xy - u_px2w.xy) / u_px2w.z;
    gl_Position = u_vp * vec4(q.x / 100.0, u_px2w.w - q.y / 100.0, u_z, 1.0);
  } else {
    vec2 ndc = vec2(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0);
    gl_Position = vec4(ndc, 0.0, 1.0);
  }
  v_uv = a_uv;
}`;

const FRAG_TEX = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec4 u_uv;
uniform float u_opacity;
uniform float u_glow;
void main(){
  vec2 uv = mix(u_uv.xy, u_uv.zw, v_uv);
  vec4 c = texture(u_tex, uv);
  vec3 rgb = c.rgb * (1.0 + u_glow * 2.4);
  outColor = vec4(rgb, c.a * u_opacity);
}`;

const FRAG_SHAPE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec4 u_color;
uniform vec2 u_size;
uniform float u_radius;
uniform float u_kind; // 0 rect, 1 ellipse
void main(){
  vec2 px = v_uv * u_size;
  float aa = 1.2;
  float d;
  if (u_kind > 0.5) {
    vec2 q = (v_uv - 0.5) * u_size;
    vec2 r = u_size * 0.5;
    d = length(q / max(r, vec2(0.001))) - 1.0;
    d *= min(r.x, r.y);
  } else {
    vec2 q = abs(px - u_size * 0.5) - (u_size * 0.5 - u_radius);
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
  }
  float a = 1.0 - smoothstep(-aa, aa, d);
  outColor = vec4(u_color.rgb, u_color.a * a);
}`;

const FRAG_FULL = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_flip;
void main(){
  outColor = texture(u_tex, vec2(v_uv.x, mix(v_uv.y, 1.0 - v_uv.y, u_flip)));
}`;

const FRAG_LAYER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_opacity;
void main(){
  // Scene FBOs are bottom-up; flip y once here, then the final composite flips
  // the accumulated scene back for the screen.
  vec4 c = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
  outColor = vec4(c.rgb, c.a * u_opacity);
}`;

const FRAG_BRIGHT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_threshold;
uniform float u_flip;
void main(){
  vec2 uv = vec2(v_uv.x, mix(v_uv.y, 1.0 - v_uv.y, u_flip));
  vec3 c = texture(u_tex, uv).rgb;
  float l = max(max(c.r, c.g), c.b);
  float k = smoothstep(u_threshold, u_threshold + 0.25, l);
  outColor = vec4(c * k, 1.0);
}`;

const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_dir;
void main(){
  vec3 sum = vec3(0.0);
  float w[5];
  w[0] = 0.227027; w[1] = 0.194594; w[2] = 0.121621; w[3] = 0.054054; w[4] = 0.016216;
  sum += texture(u_tex, v_uv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    sum += texture(u_tex, v_uv + u_dir * float(i)).rgb * w[i];
    sum += texture(u_tex, v_uv - u_dir * float(i)).rgb * w[i];
  }
  outColor = vec4(sum, 1.0);
}`;

const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomAmount;
uniform float u_ca;
uniform float u_grain;
uniform float u_scan;
uniform float u_vignette;
uniform float u_grade;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_time;
uniform float u_flip;

float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
void main(){
  vec2 uv = vec2(v_uv.x, mix(v_uv.y, 1.0 - v_uv.y, u_flip));
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  vec3 col;
  if (u_ca > 0.001) {
    vec2 off = d * u_ca * 0.012 * (0.4 + r2);
    col.r = texture(u_scene, uv + off).r;
    col.g = texture(u_scene, uv).g;
    col.b = texture(u_scene, uv - off).b;
  } else {
    col = texture(u_scene, uv).rgb;
  }
  vec3 bloom = texture(u_bloom, uv).rgb;
  col += bloom * u_bloomAmount;

  // grade
  vec3 warm = col * vec3(1.06, 1.0, 0.92);
  vec3 cool = col * vec3(0.92, 1.0, 1.07);
  col = mix(col, u_grade >= 0.0 ? warm : cool, abs(u_grade) * 0.9);

  // contrast / saturation
  col = (col - 0.5) * (1.0 + u_contrast) + 0.5;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, u_saturation);

  // scanlines
  if (u_scan > 0.001) {
    float line = mod(floor(uv.y * 900.0), 3.0);
    col *= 1.0 - (line < 0.5 ? 0.18 : 0.0) * u_scan;
  }

  // film grain
  if (u_grain > 0.001) {
    float n = hash(uv * vec2(1920.0, 1080.0) + fract(u_time * 7.13) * 91.7) - 0.5;
    col += n * u_grain * 0.35;
  }

  // vignette
  if (u_vignette > 0.001) {
    float v = smoothstep(0.95, 0.25, length(d * vec2(1.0, 1.15)) * 1.25);
    col *= mix(1.0, v, u_vignette);
  }

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const fullscreenQuad = (gl) => {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]), gl.STATIC_DRAW);
  return buf;
};

function compile(gl, vsSrc, fsSrc) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.bindAttribLocation(p, 1, 'a_uv');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, u };
}

// column-major 3x3 helpers
const M3 = {
  id: () => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  mul: (a, b) => {
    const o = new Float32Array(9);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        o[c * 3 + r] = a[0 * 3 + r] * b[c * 3 + 0] + a[1 * 3 + r] * b[c * 3 + 1] + a[2 * 3 + r] * b[c * 3 + 2];
      }
    }
    return o;
  },
  T: (x, y) => new Float32Array([1, 0, 0, 0, 1, 0, x, y, 1]),
  S: (x, y) => new Float32Array([x, 0, 0, 0, y, 0, 0, 0, 1]),
  R: (rad) => new Float32Array([Math.cos(rad), Math.sin(rad), 0, -Math.sin(rad), Math.cos(rad), 0, 0, 0, 1]),
  apply: (m, x, y) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]],
  invert: (m) => {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C || 1e-9;
    return new Float32Array([
      A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ]);
  },
};

function hexRgb(c) {
  const s = String(c || '#000').replace('#', '');
  const h = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function coverUV(iw, ih, fw, fh) {
  if (!iw || !ih) return [0, 0, 1, 1];
  const ia = iw / ih, fa = fw / fh;
  if (ia > fa) {
    const f = fa / ia;
    return [(1 - f) / 2, 0, 1 - (1 - f) / 2, 1];
  }
  const f = ia / fa;
  return [0, (1 - f) / 2, 1, 1 - (1 - f) / 2];
}

const BLEND = {
  normal: (gl) => { gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); },
  add: (gl) => { gl.blendFunc(gl.SRC_ALPHA, gl.ONE); },
  screen: (gl) => { gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); },
  multiply: (gl) => { gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); },
};

export class Preview {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false });
    if (!this.gl) throw new Error('WebGL2 not available');
    this.project = null;
    this.assets = new Map(); // id -> {kind, img/video, tex, key}
    this.textCache = new Map();
    this.sceneFBO = null;
    this.layerFBO = null;
    this.bloomFBO = [null, null];
    this.time = 0;
    this.layers = [];
    this.soloCameras = new Set();
    this.audioEl = null;
    this.scene3d = new Scene3D(this.gl);
    this.editMode = false;
    this.editCam = null;
    this._initGL();
  }

  _initGL() {
    const gl = this.gl;
    this.prog = {
      tex: compile(gl, VERT, FRAG_TEX),
      layer: compile(gl, VERT, FRAG_LAYER),
      shape: compile(gl, VERT, FRAG_SHAPE),
      full: compile(gl, VERT, FRAG_FULL),
      bright: compile(gl, VERT, FRAG_BRIGHT),
      blur: compile(gl, VERT, FRAG_BLUR),
      comp: compile(gl, VERT, FRAG_COMPOSITE),
    };
    this.quad = fullscreenQuad(gl);
    // unit quad (0..1) with uv
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    this.vao = vao;
  }

  setCity(city) {
    this.scene3d?.setCity(city);
  }

  setProject(p) {
    const changedAudio = this.project?.meta?.audio?.src !== p.meta.audio?.src;
    this.project = p;
    if (changedAudio || !this.audioEl) this._setupAudio();
    for (const el of p.elements) this._ensureAsset(el);
  }

  /** Viewport-only camera solo; final renders still use every visible camera. */
  setSoloCameras(ids) {
    this.soloCameras = ids instanceof Set ? ids : new Set(ids || []);
  }

  _setupAudio() {
    const src = this.project?.meta?.audio?.src;
    if (!src) { this.audioEl = null; return; }
    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.preload = 'auto';
      this.audioEl.crossOrigin = 'anonymous';
    }
    const url = `/media/${src.replace(/^media\//, '')}`;
    if (this.audioEl.src !== new URL(url, location.href).href) this.audioEl.src = url;
  }

  getAudio() { return this.audioEl; }

  _ensureAsset(el) {
    if (el.type !== 'image' && el.type !== 'video') return;
    if (!el.src) return;
    const key = `${el.type}:${el.src}`;
    let a = this.assets.get(el.id);
    if (a && a.key === key) return;
    if (a?.tex) this.gl.deleteTexture(a.tex);
    const gl = this.gl;
    if (el.type === 'image') {
      const img = new Image();
      img.decoding = 'async';
      img.src = `/media/${el.src.replace(/^media\//, '')}`;
      a = { kind: 'image', key, img, tex: null, ready: false };
      img.onload = () => {
        a.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        a.ready = true;
      };
    } else {
      const v = document.createElement('video');
      v.src = `/media/${el.src.replace(/^media\//, '')}`;
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.loop = false;
      v.crossOrigin = 'anonymous';
      a = { kind: 'video', key, video: v, tex: null, ready: false };
      v.addEventListener('loadeddata', () => {
        a.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        a.ready = true;
      });
    }
    this.assets.set(el.id, a);
  }

  resize(cssW, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(cssW * dpr));
    const h = Math.max(2, Math.round(cssH * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this._rebuildTargets();
    return true;
  }

  _rebuildTargets() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const mk = (tw, th) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, tw, th);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      return { fb, tex, depth, w: tw, h: th };
    };
    for (const f of [this.sceneFBO, this.layerFBO, ...(this.bloomFBO || [])]) {
      if (!f) continue;
      gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex);
      if (f.depth) gl.deleteRenderbuffer(f.depth);
    }
    this.sceneFBO = mk(w, h);
    this.layerFBO = mk(w, h);
    const hw = Math.max(2, Math.round(w / 2)), hh = Math.max(2, Math.round(h / 2));
    this.bloomFBO = [mk(hw, hh), mk(hw, hh)];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // text textures depend on pixel scale
    this.textCache.clear();
  }

  _textTexture(el, st, style) {
    const gl = this.gl;
    const px = this.canvas.width / (this.project?.meta.width || 1920);
    const size = Math.max(4, st.size * px);
    const font = `${style.weight || 400} ${size}px "${style.font || 'SimHei'}", "Microsoft YaHei", sans-serif`;
    const text = String(st.text ?? style.text ?? ' ');
    const key = `${text}|${font}|${st.color}|${style.align}|${style.lineHeight}|${style.letterSpacing}|${style.shadow}|${style.stroke}|${style.strokeWidth}|${px.toFixed(3)}`;
    let entry = this.textCache.get(el.id);
    if (entry && entry.key === key) return entry;
    const lines = text.split('\n');
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    meas.letterSpacing = `${(Number(style.letterSpacing) || 0) * px}px`;
    const lineH = size * (Number(style.lineHeight) || 1.18);
    let maxW = 0;
    for (const l of lines) maxW = Math.max(maxW, meas.measureText(l || ' ').width);
    const pad = Math.max(8, size * 0.35);
    const w = Math.ceil(maxW + pad * 2);
    const h = Math.ceil(lineH * lines.length + pad * 2);
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, w); cv.height = Math.max(2, h);
    const ctx = cv.getContext('2d');
    ctx.font = font;
    ctx.letterSpacing = `${(Number(style.letterSpacing) || 0) * px}px`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center';
    const tx = style.align === 'left' ? pad : style.align === 'right' ? w - pad : w / 2;
    const col = st.color || style.color || '#ffffff';
    if (Number(style.shadow) > 0) {
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = Number(style.shadow) * px * 1.6;
      ctx.shadowOffsetY = Number(style.shadow) * px * 0.5;
    }
    if (style.stroke && Number(style.strokeWidth) > 0) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = Number(style.strokeWidth) * px;
      lines.forEach((l, i) => ctx.strokeText(l, tx, pad + lineH * (i + 0.5)));
    }
    ctx.fillStyle = col;
    lines.forEach((l, i) => ctx.fillText(l, tx, pad + lineH * (i + 0.5)));

    let tex = entry?.tex;
    if (!tex) tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    entry = { key, tex, w: cv.width, h: cv.height, canvas: cv };
    this.textCache.set(el.id, entry);
    return entry;
  }

  /** Cameras that contribute to the viewport, in timeline order (top -> bottom). */
  _cameraLayers() {
    return cameraLayers(this.project, this.soloCameras);
  }

  /** Full-frame picture transform: scale around pivot, then offset. */
  _cameraLayerMatrix(tr, W, H) {
    const pivot = tr.picturePivot || [0.5, 0.5];
    const offset = tr.pictureOffset || [0, 0];
    const px = Number(pivot[0]) * W;
    const py = Number(pivot[1]) * H;
    const sx = Number(tr.scale?.[0]);
    const sy = Number(tr.scale?.[1]);
    return M3.mul(
      M3.T(Number(offset[0]) * W, Number(offset[1]) * H),
      M3.mul(
        M3.T(px, py),
        M3.mul(M3.S(sx, sy), M3.mul(M3.T(-px, -py), M3.S(W, H))),
      ),
    );
  }

  /**
   * Render every visible camera into a layer FBO and alpha-over them from the
   * bottom of the timeline stack to the top. `cameraOrder` is top -> bottom, so
   * the loop is reversed; the top camera is drawn last and covers the rest.
   */
  _drawCameraStack(p, t, W, H, cams) {
    const gl = this.gl;
    const layer = this.layerFBO;
    if (!layer) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let active = null;
    for (const cam of cams.slice().reverse()) {
      const tr = cameraTransform(cam, t);
      const sx = Number(tr.scale?.[0]);
      const sy = Number(tr.scale?.[1]);
      if (!(tr.opacity > 0.002) || Math.abs(sx) < 1e-4 || Math.abs(sy) < 1e-4) continue;
      const state = evalCamera({ camera: cam }, t);
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fb);
      gl.viewport(0, 0, layer.w, layer.h);
      this.scene3d.draw(p, t, layer.w, layer.h, state);
      if (cam.id === p.activeCameraId) {
        active = {
          cam: this.scene3d.lastCam,
          vp: this.scene3d.lastVP,
          w: this.scene3d.lastW,
          h: this.scene3d.lastH,
        };
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fb);
      gl.viewport(0, 0, W, H);
      const pr = this.prog.layer;
      gl.useProgram(pr.program);
      gl.uniformMatrix3fv(pr.u.u_mat, false, this._cameraLayerMatrix(tr, W, H));
      gl.uniform2f(pr.u.u_res, W, H);
      gl.uniform1f(pr.u.u_opacity, tr.opacity);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.tex);
      gl.uniform1i(pr.u.u_tex, 0);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }
    gl.disable(gl.BLEND);
    // Keep the active camera's matrices for picking / gizmo projection even
    // when it is not the last layer drawn.
    if (active) {
      this.scene3d.lastCam = active.cam;
      this.scene3d.lastVP = active.vp;
      this.scene3d.lastW = active.w;
      this.scene3d.lastH = active.h;
    }
  }

  /** compute draw list for time t (also used for hit testing) */
  computeLayers(t) {
    const p = this.project;
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    const S = W / (p.meta.width || 1920);
    const cx = W / 2, cy = H / 2;
    const out = [];
    for (const el of p.elements) {
      if (el.visible === false) continue;
      if (t < el.start - 1e-6 || t >= el.start + el.duration - 1e-6) continue;
      const st = evalElement(el, t, p.meta);
      if (st.opacity <= 0.002) continue;
      const rot = (st.rotation || 0) * Math.PI / 180;
      if (el.type === 'text') {
        const tt = this._textTexture(el, st, el.style);
        const w = tt.w, h = tt.h;
        const M = M3.mul(
          M3.mul(M3.mul(M3.T(cx + st.x * S, cy + st.y * S), M3.R(rot)), M3.S(st.scale, st.scale)),
          M3.mul(M3.T(-w / 2, -h / 2), M3.S(w, h)),
        );
        out.push({ el, st, kind: 'tex', tex: tt.tex, uv: [0, 0, 1, 1], M, w, h, blend: el.style.blend });
      } else if (el.type === 'image' || el.type === 'video') {
        const a = this.assets.get(el.id);
        if (!a || !a.ready || !a.tex) continue;
        let iw = 0, ih = 0;
        if (a.kind === 'image') { iw = a.img.naturalWidth; ih = a.img.naturalHeight; }
        else { iw = a.video.videoWidth; ih = a.video.videoHeight; }
        const uv = el.style.fit === 'stretch' ? [0, 0, 1, 1] : coverUV(iw, ih, p.meta.width, p.meta.height);
        const w = W, h = H;
        const M = M3.mul(
          M3.mul(M3.mul(M3.T(cx + st.x * S, cy + st.y * S), M3.R(rot)), M3.S(st.scale, st.scale)),
          M3.mul(M3.T(-w / 2, -h / 2), M3.S(w, h)),
        );
        out.push({ el, st, kind: 'tex', tex: a.tex, uv, M, w, h, blend: el.style.blend, asset: a });
      } else if (el.type === 'solid' || el.type === 'shape') {
        const bw = (Number(el.style.w) || p.meta.width) * S;
        const bh = (Number(el.style.h) || p.meta.height) * S;
        const w = bw, h = bh;
        const M = M3.mul(
          M3.mul(M3.mul(M3.T(cx + st.x * S, cy + st.y * S), M3.R(rot)), M3.S(st.scale, st.scale)),
          M3.mul(M3.T(-w / 2, -h / 2), M3.S(w, h)),
        );
        const col = hexRgb(el.style.fill || el.style.color || '#ffffff');
        out.push({ el, st, kind: 'shape', M, w, h, color: [...col, st.opacity], radius: (Number(el.style.radius) || 0) * S, shape: el.style.shape === 'ellipse' ? 1 : 0, blend: el.style.blend });
      }
    }
    out.sort((a, b) => a.el.z - b.el.z);
    return out;
  }

  render(t) {
    const gl = this.gl;
    const p = this.project;
    if (!p) return;
    this.time = t;
    const W = this.canvas.width, H = this.canvas.height;

    // ---- sync videos ----
    for (const [id, a] of this.assets) {
      if (a.kind !== 'video' || !a.ready) continue;
      const el = p.elements.find((e) => e.id === id);
      if (!el) continue;
      const active = t >= el.start && t < el.start + el.duration;
      const local = Math.max(0, t - el.start + (Number(el.srcIn) || 0));
      const v = a.video;
      if (active) {
        if (Math.abs(v.currentTime - local) > 0.16 && !this.playing) v.currentTime = Math.min(local, Math.max(0, (v.duration || 1) - 0.05));
        else if (Math.abs(v.currentTime - local) > 0.35) v.currentTime = local;
        if (this.playing && v.paused) v.play().catch(() => {});
        if (!this.playing && !v.paused) v.pause();
      } else if (!v.paused) v.pause();
      if (a.tex) {
        gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); } catch { /* not ready */ }
      }
    }

    // ---- scene pass ----
    const cams = this._cameraLayers();
    const is3d = !!(this.scene3d.city && cams.length);
    const layers = this.computeLayers(t);
    this.layers = layers;
    this.layersAt = t;
    this._worldMode = is3d;
    if (is3d) {
      // 2D elements are flat planes in the world: Scene3D calls back after its
      // own objects with the camera's view-projection, so they are drawn in the
      // editor view, every camera layer and every fisheye face alike.
      this.scene3d.onElements = layers.length
        ? (vp, camPos) => this._drawLayers(layers, W, H, { vp, camPos, meta: p.meta })
        : null;
      if (this.editMode) {
        // Editing keeps the free editor camera; the camera stack is a shot
        // preview feature. The path gizmo projects with this same camera.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fb);
        gl.viewport(0, 0, W, H);
        gl.clearDepth(1);
        this.scene3d.draw(p, t, W, H, this.editCam);
      } else {
        this._drawCameraStack(p, t, W, H, cams);
      }
      this.scene3d.onElements = null;
    } else {
      // no world loaded yet: the flat 2D path
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fb);
      gl.viewport(0, 0, W, H);
      const bg = hexRgb(p.meta.background || '#000000');
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this._drawLayers(layers, W, H, null);
    }

    const fx = p.meta.fx || {};
    const bloom = clamp(Number(fx.bloom) || 0, 0, 3);
    this._postAndComposite(p, t, W, H, fx, bloom);
  }

  /**
   * 2D element layers. `world` = {vp, camPos, meta} draws them as planes in the
   * 3D space (depth-tested against the 3D objects, no depth writes, far to
   * near; equal depth keeps the layer order); null draws them flat on screen.
   */
  _drawLayers(layers, W, H, world) {
    const gl = this.gl;
    let list = layers;
    if (world) {
      const cyW = (Number(world.meta?.height) || 1080) / 200;
      const S = W / (Number(world.meta?.width) || 1920);
      const c = world.camPos;
      const dist = (L) => {
        const x = (L.st.x || 0) / 100, y = cyW - (L.st.y || 0) / 100, z = L.st.z || 0;
        return Math.hypot(x - c[0], y - c[1], z - c[2]);
      };
      list = layers.map((L, i) => ({ L, i, d: dist(L) }))
        .sort((a, b) => (Math.abs(a.d - b.d) > 1e-6 ? b.d - a.d : a.i - b.i))
        .map((e) => e.L);
      for (const pr of [this.prog.tex, this.prog.shape]) {
        gl.useProgram(pr.program);
        gl.uniform1f(pr.u.u_world, 1);
        gl.uniformMatrix4fv(pr.u.u_vp, false, world.vp);
        gl.uniform4f(pr.u.u_px2w, W / 2, H / 2, S, cyW);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    {
      for (const layer of list) {
        const b = BLEND[layer.blend] || BLEND.normal;
        b(gl);
        if (layer.kind === 'tex') {
          const pr = this.prog.tex;
          gl.useProgram(pr.program);
          gl.uniformMatrix3fv(pr.u.u_mat, false, layer.M);
          gl.uniform2f(pr.u.u_res, W, H);
          if (world) gl.uniform1f(pr.u.u_z, layer.st.z || 0);
          gl.uniform4fv(pr.u.u_uv, new Float32Array(layer.uv));
          gl.uniform1f(pr.u.u_opacity, layer.st.opacity);
          gl.uniform1f(pr.u.u_glow, layer.st.glow || layer.el.fx?.glow || 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, layer.tex);
          gl.uniform1i(pr.u.u_tex, 0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } else {
          const pr = this.prog.shape;
          gl.useProgram(pr.program);
          gl.uniformMatrix3fv(pr.u.u_mat, false, layer.M);
          gl.uniform2f(pr.u.u_res, W, H);
          if (world) gl.uniform1f(pr.u.u_z, layer.st.z || 0);
          gl.uniform4fv(pr.u.u_color, new Float32Array(layer.color));
          gl.uniform2f(pr.u.u_size, layer.w, layer.h);
          gl.uniform1f(pr.u.u_radius, layer.radius);
          gl.uniform1f(pr.u.u_kind, layer.shape);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
      }
      gl.bindVertexArray(null);
    }
    if (world) {
      for (const pr of [this.prog.tex, this.prog.shape]) {
        gl.useProgram(pr.program);
        gl.uniform1f(pr.u.u_world, 0); // the same programs draw flat debug blits
      }
      // hand the 3D renderer its state back (the fisheye clears depth per face)
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  _postAndComposite(p, t, W, H, fx, bloom) {
    const gl = this.gl;

    // ---- bloom chain ----
    if (bloom > 0.001) {
      const half = this.bloomFBO[0], tmp = this.bloomFBO[1];
      gl.disable(gl.BLEND);
      // bright
      gl.bindFramebuffer(gl.FRAMEBUFFER, half.fb);
      gl.viewport(0, 0, half.w, half.h);
      this._pass(this.prog.bright, (pr) => {
        gl.uniform1i(pr.u.u_tex, 0);
        gl.uniform1f(pr.u.u_threshold, 0.55);
        gl.uniform1f(pr.u.u_flip, 1.0);
      }, this.sceneFBO.tex, half.w, half.h);
      // blur h
      gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fb);
      gl.viewport(0, 0, tmp.w, tmp.h);
      this._pass(this.prog.blur, (pr) => {
        gl.uniform1i(pr.u.u_tex, 0);
        gl.uniform2f(pr.u.u_dir, 1.6 / tmp.w, 0);
      }, half.tex, tmp.w, tmp.h);
      // blur v
      gl.bindFramebuffer(gl.FRAMEBUFFER, half.fb);
      gl.viewport(0, 0, half.w, half.h);
      this._pass(this.prog.blur, (pr) => {
        gl.uniform1i(pr.u.u_tex, 0);
        gl.uniform2f(pr.u.u_dir, 0, 1.6 / half.h);
      }, tmp.tex, half.w, half.h);
    }

    // ---- composite to screen ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    const pr = this.prog.comp;
    gl.useProgram(pr.program);
    gl.uniformMatrix3fv(pr.u.u_mat, false, M3.S(W, H));
    gl.uniform2f(pr.u.u_res, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneFBO.tex);
    gl.uniform1i(pr.u.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomFBO[0].tex);
    gl.uniform1i(pr.u.u_bloom, 1);
    gl.uniform1f(pr.u.u_bloomAmount, bloom);
    gl.uniform1f(pr.u.u_ca, Number(fx.ca) || 0);
    gl.uniform1f(pr.u.u_grain, Number(fx.grain) || 0);
    gl.uniform1f(pr.u.u_scan, Number(fx.scanline) || 0);
    gl.uniform1f(pr.u.u_vignette, Number(fx.vignette) || 0);
    gl.uniform1f(pr.u.u_grade, Number(fx.grade) || 0);
    gl.uniform1f(pr.u.u_contrast, Number(fx.contrast) || 0);
    gl.uniform1f(pr.u.u_saturation, Number.isFinite(Number(fx.saturation)) ? Number(fx.saturation) : 1);
    gl.uniform1f(pr.u.u_time, t);
    gl.uniform1f(pr.u.u_flip, 1.0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  _pass(prog, setUniforms, tex, w, h) {
    const gl = this.gl;
    gl.useProgram(prog.program);
    gl.uniformMatrix3fv(prog.u.u_mat, false, M3.S(w, h));
    gl.uniform2f(prog.u.u_res, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    setUniforms(prog);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /**
   * The four corners of a 2D layer in canvas pixels. In world mode they are
   * projected through the last 3D view-projection, so picking follows a moved
   * camera instead of the flat screen-space matrix.
   */
  _layerCorners(L) {
    const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => M3.apply(L.M, u, v));
    const s3 = this.scene3d;
    if (!this._worldMode || !s3?.lastVP) return pts;
    const W = this.canvas.width, H = this.canvas.height;
    const meta = this.project?.meta || {};
    const S = W / (Number(meta.width) || 1920);
    const cyW = (Number(meta.height) || 1080) / 200;
    const z = Number(L.st?.z) || 0;
    const out = [];
    for (const [x, y] of pts) {
      const qx = (x - W / 2) / S;
      const qy = (y - H / 2) / S;
      const p = s3.projectPoint([qx / 100, cyW - qy / 100, z]);
      if (!p) return null;
      out.push([p.x * W / Math.max(1, s3.lastW), p.y * H / Math.max(1, s3.lastH)]);
    }
    return out;
  }

  /** canvas-space hit test -> topmost element id */
  hitTest(cx, cy, t) {
    const layers = (this.layers && this.layersAt === t) ? this.layers : this.computeLayers(t);
    if (this._worldMode && this.scene3d?.lastVP) {
      const s3 = this.scene3d;
      const meta = this.project?.meta || {};
      const cyW = (Number(meta.height) || 1080) / 200;
      const cam = s3.lastCam?.pos || [0, 0, 20];
      // Nearest layer wins. Equal distance keeps the higher 2D layer on top.
      const list = layers.map((L, i) => ({
        L, i,
        d: Math.hypot((L.st.x || 0) / 100 - cam[0], cyW - (L.st.y || 0) / 100 - cam[1], (L.st.z || 0) - cam[2]),
      })).sort((a, b) => (Math.abs(a.d - b.d) > 1e-6 ? a.d - b.d : b.i - a.i));
      for (const { L } of list) {
        const poly = this._layerCorners(L);
        if (poly && pointInPoly(cx, cy, poly)) return L.el.id;
      }
      return null;
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const inv = M3.invert(L.M);
      const [u, v] = M3.apply(inv, cx, cy);
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return L.el.id;
    }
    return null;
  }

  /** select rectangle in canvas space for the current layers */
  layerRects() {
    return (this.layers || []).map((L) => {
      const pts = this._layerCorners(L);
      if (!pts) return null;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return { id: L.el.id, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }).filter(Boolean);
  }

  /** debug: the exact 2D canvas used as a text texture */
  debugTextTexture(id) {
    const el = this.project?.elements.find((e) => e.id === id);
    if (!el) return null;
    const st = evalElement(el, this.time, this.project.meta);
    const entry = this._textTexture(el, st, el.style);
    return entry?.canvas ? entry.canvas.toDataURL('image/png') : null;
  }

  debugBlitTex(tex, w, h, x = 0, y = 0) {
    const gl = this.gl, pr = this.prog.tex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0.04, 0.04, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pr.program);
    gl.uniformMatrix3fv(pr.u.u_mat, false, M3.mul(M3.T(x, y), M3.S(w, h)));
    gl.uniform2f(pr.u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform4fv(pr.u.u_uv, new Float32Array([0, 0, 1, 1]));
    gl.uniform1f(pr.u.u_opacity, 1);
    gl.uniform1f(pr.u.u_glow, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(pr.u.u_tex, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** debug: blit a cached text texture 1:1 to check upload vs geometry */
  debugBlit(id, x = 40, y = 40) {
    const e = this.textCache.get(id);
    if (!e) return null;
    const gl = this.gl, pr = this.prog.tex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0.04, 0.04, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pr.program);
    gl.uniformMatrix3fv(pr.u.u_mat, false, M3.mul(M3.T(x, y), M3.S(e.w, e.h)));
    gl.uniform2f(pr.u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform4fv(pr.u.u_uv, new Float32Array([0, 0, 1, 1]));
    gl.uniform1f(pr.u.u_opacity, 1);
    gl.uniform1f(pr.u.u_glow, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.uniform1i(pr.u.u_tex, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    return { w: e.w, h: e.h };
  }

  capture() {
    this.render(this.time);
    return this.canvas.toDataURL('image/png');
  }

  playAudio(at) {
    const a = this.audioEl;
    if (!a) return;
    const offset = Number(this.project.meta.audio?.offset) || 0;
    try { a.currentTime = Math.max(0, at + offset); } catch { /* not ready */ }
    a.play().catch(() => {});
  }

  pauseAudio() { this.audioEl?.pause(); }

  setAudioTime(at) {
    const a = this.audioEl;
    if (!a) return;
    const offset = Number(this.project.meta.audio?.offset) || 0;
    try { a.currentTime = Math.max(0, at + offset); } catch { /* ignore */ }
  }
}

/** Even-odd point-in-polygon test for projected layer corners. */
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
