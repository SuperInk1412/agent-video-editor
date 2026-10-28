// Realtime preview: WebGL2 compositor that mirrors blender/vdm_build.py.
// Layers -> scene FBO -> bloom chain -> composite (CA, grain, scanlines, vignette, grade).
//
// 2D layers have two placement paths (PLAN-ui-round3 §2.5, task S2):
//
// - legacy (`el.node` absent): the original screen path. `u_px2w` + `u_z` lift
//   the canvas-space quad onto the fixed camera-facing plane at `transform.z`,
//   exactly as before this branch (the 907b9ec picture must not change).
// - node (`el.node` present): `core/spatial.js::elementNode` / `frameOf` give
//   the layer a world position + basis (`dir`/`roll`) + scale. A full 4x4 quad
//   matrix replaces the placement, so the texture can face any direction and
//   still be depth-tested against the 3D scene.
//
// Why a new vertex branch instead of reusing preview3d.js::planeProg: that
// program bakes scene-object lighting/fog/srgb and uploads sRGB textures, while
// 2D layers share the compositor's straight-alpha/glow path and canvas-space
// text rasters. Reusing FRAG_TEX / FRAG_SHAPE keeps solid/shape/ellipse/radius
// drawing identical; only the vertex placement differs.
import { evalElement, motionDelta } from '/core/evaluate.js';
import { elementOverlay } from '/core/links.js';
import { cameraParamResolver, elementWorldNodeWithLinks, evalCameraWorldWithLinks, linksEvalOptions } from '/core/link-eval.js';
import { clamp } from '/core/time.js';
import { cameraTransform, cameraLayers } from '/core/camera.js';
import { audioElements, audioVolume } from '/core/audio.js';
import { elementWorldParent } from '/core/spatial-parent.js';
import { frameOf } from '/core/spatial.js';
import { basisFromDir } from '/core/scene.js';
import { Scene3D } from './preview3d.js';
import { feedPlan, hiddenFeeds, normalizeFeed, programProject } from '/core/camfeed.js';
import { clearCompiledTracks, compileProject } from '/core/tracks.js';
import {
  mul4, nodePlaneMatrix, orderLayers, planeOfFrame, transformPlane,
} from './spatial-layers.js';

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

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
uniform mat4 u_carry;   // camera-parented elements: the camera's motion since binding (identity otherwise)
uniform mat4 u_model;   // node planes (u_world > 1.5): unit quad -> world (spatial-layers.js)
out vec2 v_uv;
void main(){
  vec3 p = u_mat * vec3(a_pos, 1.0);
  v_uv = a_uv;
  if (u_world > 1.5) {
    // Node plane: the quad has a real world basis (dir + roll), so it is drawn
    // with a 4x4 model instead of the screen-plane 2x3 matrix. a_pos/a_uv are
    // 0..1, hence the -0.5 local offset; v is flipped because world y is up
    // while textures keep v = 0 at the picture top.
    gl_Position = u_vp * (u_model * vec4(a_pos - 0.5, 0.0, 1.0));
    v_uv = vec2(a_uv.x, 1.0 - a_uv.y);
  } else if (u_world > 0.5) {
    vec2 q = (p.xy - u_px2w.xy) / u_px2w.z;
    gl_Position = u_vp * (u_carry * vec4(q.x / 100.0, u_px2w.w - q.y / 100.0, u_z, 1.0));
  } else {
    vec2 ndc = vec2(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0);
    gl_Position = vec4(ndc, 0.0, 1.0);
  }
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
    // Camera feeds (core/camfeed.js): per source camera a {cur, prev} pair of
    // targets; `prev` holds the previous frame for delay-1 feeds.
    this.feedTargets = new Map();
    this._feedPlan = null;
    this._feedT = null;
    this._viewer = null; // camera id whose picture is being drawn (null = editor view)
    this.time = 0;
    this.layers = [];
    this.soloCameras = new Set();
    this.audioEl = null;
    this.elementAudio = new Map(); // element id -> HTMLAudioElement
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
    clearCompiledTracks();
    compileProject(p);
    const live = new Map(p.elements.map((element) => [element.id, element]));
    for (const [id, asset] of this.assets) if (!live.has(id) || !['image', 'video'].includes(live.get(id).type)) {
      this._releaseAsset(asset); this.assets.delete(id);
    }
    for (const [id, entry] of this.textCache) if (!live.has(id) || live.get(id).type !== 'text') {
      this.gl.deleteTexture(entry.tex); this.textCache.delete(id);
    }
    if (changedAudio || !this.audioEl) this._setupAudio();
    this._syncElementAudioPlayers(p);
    // Audio elements supersede the legacy soundtrack. Keep the old player
    // around for projects that have no audio elements yet.
    if (this.elementAudio.size) this.audioEl?.pause();
    for (const el of p.elements) this._ensureAsset(el);
  }

  /** Full source length of a 2D media element once its player is ready. */
  sourceDuration(el) {
    if (!el) return null;
    if (el.type === 'video') {
      const v = this.assets.get(el.id)?.video;
      if (v && Number.isFinite(v.duration) && v.duration > 0) return v.duration;
    } else if (el.type === 'audio') {
      const a = this.elementAudio.get(el.id);
      if (a && Number.isFinite(a.duration) && a.duration > 0) return a.duration;
    }
    const recorded = Number(el.meta?.sourceDuration);
    return Number.isFinite(recorded) && recorded > 0 ? recorded : null;
  }

  /** Create / retarget one HTMLAudioElement per audio element. */
  _syncElementAudioPlayers(project) {
    const wanted = new Set();
    for (const el of audioElements(project)) {
      if (!el.src) continue;
      wanted.add(el.id);
      let a = this.elementAudio.get(el.id);
      if (!a) {
        a = new Audio();
        a.preload = 'auto';
        a.loop = false;
        a.crossOrigin = 'anonymous';
        this.elementAudio.set(el.id, a);
      }
      if (a._vdmSrc !== el.src) {
        a.pause();
        a.src = `/media/${String(el.src).replace(/^media\//, '')}`;
        a._vdmSrc = el.src;
      }
    }
    for (const [id, a] of this.elementAudio) {
      if (wanted.has(id)) continue;
      a.pause();
      a.removeAttribute('src');
      a.load();
      this.elementAudio.delete(id);
    }
  }

  /**
   * Keep every sound element at the right source time and volume. called from
   * render() every frame, so volume keyframes follow the playhead immediately.
   */
  _syncElementAudio(t, playing) {
    if (!this.elementAudio.size) return;
    const els = new Map((this.project?.elements || []).map((e) => [e.id, e]));
    for (const [id, a] of this.elementAudio) {
      const el = els.get(id);
      if (!el || el.type !== 'audio' || el.visible === false) { a.pause(); continue; }
      const start = Number(el.start) || 0;
      const end = start + Math.max(0, Number(el.duration) || 0);
      const live = t >= start - 1e-6 && t < end - 1e-6;
      const vol = audioVolume(el, t);
      try { a.volume = Math.max(0, Math.min(1, vol)); } catch { /* old engine */ }
      if (!live) {
        if (!a.paused) a.pause();
        continue;
      }
      const source = el.loop ? this.sourceDuration(el) : null;
      let want = Math.max(0, (Number(el.srcIn) || 0) + (t - start));
      if (el.loop && source) want = ((want % source) + source) % source;
      if (!playing) {
        if (!a.paused) a.pause();
        if (Math.abs(a.currentTime - want) > 0.02) {
          try { a.currentTime = want; } catch { /* not ready */ }
        }
        continue;
      }
      if (a.paused) {
        try { a.currentTime = want; } catch { /* not ready */ }
        a.play().catch(() => {});
      } else if (Math.abs(a.currentTime - want) > 0.25) {
        try { a.currentTime = want; } catch { /* ignore */ }
      }
    }
  }

  /** Viewport-only camera solo; final renders still use every visible camera. */
  setSoloCameras(ids) {
    this.soloCameras = ids instanceof Set ? ids : new Set(ids || []);
  }

  _setupAudio() {
    const src = this.project?.meta?.audio?.src;
    if (!src || this.project?.meta?.audioMigrated) {
      this.audioEl?.pause();
      this.audioEl?.removeAttribute('src');
      this.audioEl?.load();
      this.audioEl = null;
      return;
    }
    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.preload = 'auto';
      this.audioEl.crossOrigin = 'anonymous';
    }
    const url = `/media/${src.replace(/^media\//, '')}`;
    if (this.audioEl.src !== new URL(url, location.href).href) this.audioEl.src = url;
  }

  getAudio() { return this.audioEl; }

  _releaseAsset(asset) {
    asset.disposed = true;
    if (asset.img) asset.img.onload = null;
    if (asset.video) { asset.video.pause(); asset.video.removeAttribute('src'); asset.video.load(); }
    if (asset.tex) this.gl.deleteTexture(asset.tex);
  }

  _ensureAsset(el) {
    if (el.type !== 'image' && el.type !== 'video') return;
    if (!el.src) return;
    const key = `${el.type}:${el.src}`;
    let a = this.assets.get(el.id);
    if (a && a.key === key) return;
    if (a) this._releaseAsset(a);
    const gl = this.gl;
    if (el.type === 'image') {
      const img = new Image();
      img.decoding = 'async';
      img.src = `/media/${el.src.replace(/^media\//, '')}`;
      a = { kind: 'image', key, img, tex: null, ready: false };
      img.onload = () => {
        if (a.disposed) return;
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
        if (a.disposed) return;
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
    const mk = (tw, th) => this._mkTarget(tw, th);
    for (const f of [this.sceneFBO, this.layerFBO, ...(this.bloomFBO || [])]) this._freeTarget(f);
    this._clearFeedTargets();
    this.sceneFBO = mk(w, h);
    this.layerFBO = mk(w, h);
    const hw = Math.max(2, Math.round(w / 2)), hh = Math.max(2, Math.round(h / 2));
    this.bloomFBO = [mk(hw, hh), mk(hw, hh)];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // text textures depend on pixel scale
    for (const entry of this.textCache.values()) gl.deleteTexture(entry.tex);
    this.textCache.clear();
  }

  _freeTarget(f) {
    if (!f) return;
    const gl = this.gl;
    gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex);
    if (f.depth) gl.deleteRenderbuffer(f.depth);
  }

  _clearFeedTargets() {
    for (const pair of this.feedTargets.values()) { this._freeTarget(pair.cur); this._freeTarget(pair.prev); }
    this.feedTargets.clear();
    this._feedT = null;
  }

  /** The {cur, prev} targets of a source camera, created at canvas size on demand. */
  _feedTarget(camId) {
    let pair = this.feedTargets.get(camId);
    const w = this.canvas.width, h = this.canvas.height;
    if (!pair) {
      pair = { cur: this._mkTarget(w, h), prev: this._mkTarget(w, h), drawn: false, ready: false };
      this.feedTargets.set(camId, pair);
    }
    return pair;
  }

  _mkTarget(tw, th) {
    const gl = this.gl;
    {
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
    }
  }

  _textTexture(el, st, style, zoom = 1) {
    const gl = this.gl;
    // `zoom` rasterises sharper than the default framing needs (camera close-ups);
    // the entry's w / h stay in canvas units so the layer matrix is unchanged.
    const px = (this.canvas.width / (this.project?.meta.width || 1920)) * zoom;
    const size = Math.max(4, st.size * px);
    const font = `${style.weight || 400} ${size}px "${style.font || 'SimHei'}", "Microsoft YaHei", sans-serif`;
    const text = String(st.text ?? style.text ?? ' ');
    const key = `${text}|${font}|${st.color}|${style.align}|${style.lineHeight}|${style.letterSpacing}|${style.shadow}|${style.stroke}|${style.strokeWidth}|${px.toFixed(3)}|z${zoom}`;
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
    const limit = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096);
    if (zoom > 1 && Math.max(w, h) > limit) {
      return this._textTexture(el, st, style, Math.max(1, Math.floor((zoom * limit) / Math.max(w, h) * 4) / 4));
    }
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
    // mipmaps: a close-up raster shown small (camera pulling back) stays clean
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    entry = { key, tex, w: cv.width, h: cv.height, canvas: cv, zoom };
    this.textCache.set(el.id, entry);
    return entry;
  }

  /** Cameras that contribute to the viewport, in timeline order (top -> bottom). */
  /** Cameras on screen at t (camera clips: only those whose start/duration covers t). */
  _cameraLayers(t = this.time) {
    // Feed-only cameras (output:false) never reach the picture (core/camfeed.js).
    return cameraLayers(programProject(this.project), this.soloCameras, t);
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
    const param = cameraParamResolver(p);
    for (const cam of cams.slice().reverse()) {
      const tr = cameraTransform(cam, t, { param });
      const sx = Number(tr.scale?.[0]);
      const sy = Number(tr.scale?.[1]);
      if (!(tr.opacity > 0.002) || Math.abs(sx) < 1e-4 || Math.abs(sy) < 1e-4) continue;
      const state = evalCameraWorldWithLinks(p, t, cam);
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fb);
      gl.viewport(0, 0, layer.w, layer.h);
      this._viewer = cam.id;
      this.scene3d.draw(p, t, layer.w, layer.h, state);
      this._viewer = null;
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

  /** Camera states of the feed sources whose feed is on screen at t. */
  _liveFeedCameras(p, t) {
    const ids = new Set((p.elements || [])
      .filter((el) => el.type === 'camfeed' && el.visible !== false
        && t >= el.start - 1e-6 && t < el.start + el.duration - 1e-6)
      .map((el) => normalizeFeed(el.feed).camera));
    return (p.cameras || []).filter((c) => ids.has(c.id)).map((c) => evalCameraWorldWithLinks(p, t, c));
  }

  /** Layers the camera being drawn may film: its hidden live feeds removed. */
  _visibleLayers(layers) {
    if (!this._viewer || !this._feedPlan) return layers;
    const skip = hiddenFeeds(this._feedPlan, this._viewer);
    return skip.size ? layers.filter((L) => !(L.feed && skip.has(L.el.id))) : layers;
  }

  /** Texture a feed layer shows now: the source's current or previous frame. */
  _feedTexture(feed) {
    const pair = this.feedTargets.get(feed.camera);
    if (!pair) return null;
    if (feed.delay === 1) return pair.ready ? pair.prev.tex : null;
    return pair.drawn ? pair.cur.tex : null;
  }

  /**
   * Render every feed source camera into its own target before the picture,
   * dependencies first (core/camfeed.js::feedPlan). A new time first swaps
   * cur/prev so delay-1 feeds read the previous frame; re-rendering the same
   * time keeps the previous frame. The targets hold the raw camera picture:
   * the post chain runs once, on the final composite.
   */
  _renderFeeds(p, t, layers) {
    const plan = feedPlan(p);
    this._feedPlan = plan;
    // Only sources with a feed on screen now are drawn (a cut sequence turned
    // into feeds has one live source at a time); the others free their targets.
    const live = new Set((p.elements || [])
      .filter((el) => el.type === 'camfeed' && el.visible !== false
        && t >= el.start - 1e-6 && t < el.start + el.duration - 1e-6)
      .map((el) => normalizeFeed(el.feed).camera));
    const sources = plan.sources.filter((id) => live.has(id));
    if (!sources.length) {
      if (this.feedTargets.size) this._clearFeedTargets();
      return;
    }
    const gl = this.gl;
    for (const id of [...this.feedTargets.keys()]) {
      if (sources.includes(id)) continue;
      const pair = this.feedTargets.get(id);
      this._freeTarget(pair.cur); this._freeTarget(pair.prev);
      this.feedTargets.delete(id);
    }
    if (this._feedT !== t) {
      // `prev` becomes the last drawn frame; `cur` is redrawn below.
      for (const pair of this.feedTargets.values()) {
        [pair.cur, pair.prev] = [pair.prev, pair.cur];
        pair.ready = pair.drawn;
        pair.drawn = false;
      }
    }
    this._feedT = t;
    const keep = { cam: this.scene3d.lastCam, vp: this.scene3d.lastVP, w: this.scene3d.lastW, h: this.scene3d.lastH };
    const W = this.canvas.width, H = this.canvas.height;
    this.scene3d.onElements = layers.length
      ? (vp, camPos) => this._drawLayers(this._visibleLayers(layers), W, H, { vp, camPos, meta: p.meta })
      : null;
    for (const id of sources) {
      const cam = (p.cameras || []).find((c) => c.id === id);
      if (!cam) continue;
      const pair = this._feedTarget(id);
      gl.bindFramebuffer(gl.FRAMEBUFFER, pair.cur.fb);
      gl.viewport(0, 0, pair.cur.w, pair.cur.h);
      gl.clearColor(0, 0, 0, 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      this._viewer = id;
      this.scene3d.draw(p, t, pair.cur.w, pair.cur.h, evalCameraWorldWithLinks(p, t, cam));
      this._viewer = null;
      pair.drawn = true;
    }
    this.scene3d.onElements = null;
    Object.assign(this.scene3d, { lastCam: keep.cam, lastVP: keep.vp, lastW: keep.w, lastH: keep.h });
  }

  /**
   * Compute the draw list for time t (also used for hit testing).
   *
   * Every layer keeps the legacy screen data (`M`, `w`, `h`, `uv`, `blend`) so
   * the old path and the selection overlay stay untouched. An element whose
   * `el.node` exists additionally carries the world plane (`node.frame`) that
   * the node placement path draws and picks with; `el.z` stays the 2D layer
   * order and never moves into `node.pivot.z` (PLAN §2.5).
   */
  computeLayers(t) {
    const p = this.project;
    const nodeOpts = linksEvalOptions(p);
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    const S = W / (p.meta.width || 1920);
    const cx = W / 2, cy = H / 2;
    const cyW = (Number(p.meta?.height) || 1080) / 200;
    const out = [];
    // the camera this frame is seen through (text is rasterised for its close-ups)
    const cam = this.scene3d.city ? (this.editMode && this.editCam ? this.editCam : evalCameraWorldWithLinks(p, t)) : null;
    // Feed sources on screen now also film the text: rasterise for the closest view.
    const feedCams = cam ? this._liveFeedCameras(p, t) : [];
    const zoomFor = (el, st, nodeFrame) => feedCams.reduce(
      (z, c) => Math.max(z, this._textZoom(el, st, c, nodeFrame)), this._textZoom(el, st, cam, nodeFrame));
    for (const el of p.elements) {
      if (el.visible === false) continue;
      if (t < el.start - 1e-6 || t >= el.start + el.duration - 1e-6) continue;
      const st = evalElement(el, t, p.meta, elementOverlay(p, el, t));
      if (st.opacity <= 0.002) continue;
      const rot = (st.rotation || 0) * Math.PI / 180;
      // Unified space: el.node is the placement source of truth (core/spatial.js).
      // A partial node falls back to the legacy derivation for missing fields,
      // so it can never move an element by accident. node-at.js samples the
      // migrated `pivot.* / scale.* / roll` keyframes on top of the base node
      // (S4 convention, same reading as migrate-spatial.js::migratedNodeAt).
      // A spatial parent (core/spatial-parent.js) carries the whole node chain,
      // so a parented 2D layer also enters this world-plane path — including a
      // legacy layer whose node is derived from its transform; an unparented
      // legacy layer keeps the old screen path untouched.
      const worldParent = !!elementWorldParent(el);
      const nodeFrame = (el.node || worldParent) ? frameOf(elementWorldNodeWithLinks(p, el, t, nodeOpts)) : null;
      const push = (L) => {
        if (nodeFrame) L.node = { frame: nodeFrame };
        out.push(L);
      };
      if (el.type === 'text') {
        const tt = this._textTexture(el, st, el.style, zoomFor(el, st, nodeFrame));
        const w = tt.w / tt.zoom, h = tt.h / tt.zoom;
        const M = M3.mul(
          M3.mul(M3.mul(M3.T(cx + st.x * S, cy + st.y * S), M3.R(rot)), M3.S(st.scale, st.scale)),
          M3.mul(M3.T(-w / 2, -h / 2), M3.S(w, h)),
        );
        push({ el, st, kind: 'tex', tex: tt.tex, uv: [0, 0, 1, 1], M, w, h, blend: el.style.blend });
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
        push({ el, st, kind: 'tex', tex: a.tex, uv, M, w, h, blend: el.style.blend, asset: a });
      } else if (el.type === 'camfeed') {
        // The texture is the source camera's target, bound per draw
        // (_feedTexture): the source is only rendered later in the frame.
        const feed = normalizeFeed(el.feed);
        const w = W, h = H;
        const M = M3.mul(
          M3.mul(M3.mul(M3.T(cx + st.x * S, cy + st.y * S), M3.R(rot)), M3.S(st.scale, st.scale)),
          M3.mul(M3.T(-w / 2, -h / 2), M3.S(w, h)),
        );
        // Targets are bottom-up: flip v.
        push({ el, st, kind: 'tex', tex: null, feed, uv: [0, 1, 1, 0], M, w, h, blend: el.style.blend });
      } else if (el.type === 'solid' || el.type === 'shape') {
        const bw = (Number(el.style.w) || p.meta.width) * S;
        const bh = (Number(el.style.h) || p.meta.height) * S;
        const w = bw, h = bh;
        const M = M3.mul(
          M3.mul(M3.mul(M3.T(cx + st.x * S, cy + st.y * S), M3.R(rot)), M3.S(st.scale, st.scale)),
          M3.mul(M3.T(-w / 2, -h / 2), M3.S(w, h)),
        );
        const col = hexRgb(el.style.fill || el.style.color || '#ffffff');
        push({ el, st, kind: 'shape', M, w, h, color: [...col, st.opacity], radius: (Number(el.style.radius) || 0) * S, shape: el.style.shape === 'ellipse' ? 1 : 0, blend: el.style.blend });
      }
    }
    out.sort((a, b) => a.el.z - b.el.z);
    // World plane of every layer for the shared draw / pick ordering (§2.5).
    // Node layers use the SpatialNode frame; legacy layers keep the exact point
    // + [0,0,1] normal the old _planeDist used, so the old picture keeps its
    // order (a carried layer's raw normal is kept unscaled on purpose: the
    // screen-locked pull-in must keep sorting those layers in front).
    for (const L of out) {
      L.plane = L.node
        ? planeOfFrame(L.node.frame)
        : { p: [(L.st.x || 0) / 100, cyW - (L.st.y || 0) / 100, L.st.z || 0], n: [0, 0, 1] };
    }
    // Node placement (world matrix) for node layers; legacy layers never get one.
    for (const L of out) if (L.node) this._nodePlane(L, t, S, p.meta);
    return out;
  }

  /**
   * World quad matrix of a node layer (task 5): the SpatialNode placement
   * replaces `transform.x/y/z/rotation/scale`, while evalElement still owns
   * opacity/fades/text content and motion/punch come from `motionDelta`.
   * Motion is applied inside the plane — screen px along the plane's unrolled
   * axes, extra roll around the normal, size multiplier — so nothing is added
   * twice.
   */
  _nodePlane(L, t, S, meta) {
    const frame = L.node.frame;
    const d = motionDelta(L.el, t, meta);
    // Unrolled plane axes: the legacy screen path translates before rotating,
    // so a node's own roll must not rotate its motion direction.
    const base = basisFromDir(frame.basis[2], 0);
    const dx = (Number(d.x) || 0) / 100; // project px -> metres
    const dy = -(Number(d.y) || 0) / 100; // canvas y points down, world y up
    const offset = [
      -base.right[0] * dx + base.up[0] * dy,
      -base.right[1] * dx + base.up[1] * dy,
      -base.right[2] * dx + base.up[2] * dy,
    ];
    // Canvas pixels are sized for the default framing (100 px = 1 m at the
    // screen plane), then the node scale expands the geometry.
    const pxToM = 1 / (100 * S);
    const width = L.w * pxToM * Math.abs(Number(frame.scale[0]) || 1);
    const height = L.h * pxToM * Math.abs(Number(frame.scale[1]) || 1);
    const plane = nodePlaneMatrix(frame, width, height, { offset, roll: d.rotation, scale: d.scale });
    L.node.w = plane.w;
    L.node.h = plane.h;
    L.node.model = plane.model;
  }

  render(t) {
    const gl = this.gl;
    const p = this.project;
    if (!p) return;
    this.time = t;
    this._syncElementAudio(t, !!this.playing);
    const W = this.canvas.width, H = this.canvas.height;

    // ---- sync videos ----
    for (const [id, a] of this.assets) {
      if (a.kind !== 'video' || !a.ready) continue;
      const el = p.elements.find((e) => e.id === id);
      if (!el) continue;
      const active = t >= el.start && t < el.start + el.duration;
      const source = this.sourceDuration(el);
      let local = Math.max(0, t - el.start + (Number(el.srcIn) || 0));
      if (el.loop && source) local = ((local % source) + source) % source;
      const pastEnd = !el.loop && source && local >= source - 1e-6;
      const v = a.video;
      if (active && !pastEnd) {
        if (this.playing) {
          if (el.loop && source && v.ended) {
            try { v.currentTime = local; } catch { /* not ready */ }
            v.play().catch(() => {});
          } else if (v.paused) {
            v.play().catch(() => {});
          } else if (Math.abs(v.currentTime - local) > 0.35) {
            try { v.currentTime = local; } catch { /* not ready */ }
          }
        } else {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - local) > 0.16) {
            try { v.currentTime = Math.min(local, Math.max(0, (v.duration || source || 1) - 0.05)); } catch { /* not ready */ }
          }
        }
      } else if (!v.paused) v.pause();
      if (a.tex) {
        gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); } catch { /* not ready */ }
      }
    }

    // ---- scene pass ----
    const cams = this._cameraLayers(t);
    const is3d = !!(this.scene3d.city && cams.length);
    const layers = this.computeLayers(t);
    this.layers = layers;
    this.layersAt = t;
    this._worldMode = is3d;
    if (is3d) {
      // 2D elements are flat planes in the world: Scene3D calls back after its
      // own objects with the camera's view-projection, so they are drawn in the
      // editor view, every camera layer and every fisheye face alike.
      this._renderFeeds(p, t, layers);
      this.scene3d.onElements = layers.length
        ? (vp, camPos) => this._drawLayers(this._visibleLayers(layers), W, H, { vp, camPos, meta: p.meta })
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
   *
   * Node layers (`layer.node.model`) use the world-plane branch, every other
   * layer keeps the legacy screen path. `u_world` selects the branch in VERT:
   * 0 = flat screen blit, 1 = legacy screen plane, 2 = node world plane.
   */
  _drawLayers(layers, W, H, world) {
    const gl = this.gl;
    let list = layers;
    if (world) {
      const cyW = (Number(world.meta?.height) || 1080) / 200;
      const S = W / (Number(world.meta?.width) || 1920);
      // Same ordering as hitTest (spatial-layers.js): distance from the camera to
      // each element's PLANE, far first; on one plane `el.z` decides, so a
      // full-screen backdrop stays behind the type from any viewing angle.
      list = orderLayers(layers, world.camPos);
      for (const pr of [this.prog.tex, this.prog.shape]) {
        gl.useProgram(pr.program);
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
        // A feed whose source was not rendered (flat path, missing camera) is skipped.
        if (layer.feed && !this._feedTexture(layer.feed)) continue;
        const b = BLEND[layer.blend] || BLEND.normal;
        b(gl);
        const nodeMode = !!world && !!layer.node?.model;
        const mode = nodeMode ? 2 : (world ? 1 : 0);
        if (layer.kind === 'tex') {
          const pr = this.prog.tex;
          gl.useProgram(pr.program);
          gl.uniformMatrix3fv(pr.u.u_mat, false, layer.M);
          gl.uniform2f(pr.u.u_res, W, H);
          gl.uniform1f(pr.u.u_world, mode);
          if (nodeMode) gl.uniformMatrix4fv(pr.u.u_model, false, layer.node.model);
          else if (world) {
            gl.uniform1f(pr.u.u_z, layer.st.z || 0);
            gl.uniformMatrix4fv(pr.u.u_carry, false, layer.carry || IDENTITY4);
          }
          gl.uniform4fv(pr.u.u_uv, new Float32Array(layer.uv));
          gl.uniform1f(pr.u.u_opacity, layer.st.opacity);
          gl.uniform1f(pr.u.u_glow, layer.st.glow || layer.el.fx?.glow || 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, layer.feed ? this._feedTexture(layer.feed) : layer.tex);
          gl.uniform1i(pr.u.u_tex, 0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } else {
          // Solid/shape keeps the existing SDF fragment shader (rect / rounded
          // rect / ellipse) — only its quad placement is swapped, so a node
          // element gets a real world orientation without a second shape path.
          const pr = this.prog.shape;
          gl.useProgram(pr.program);
          gl.uniformMatrix3fv(pr.u.u_mat, false, layer.M);
          gl.uniform2f(pr.u.u_res, W, H);
          gl.uniform1f(pr.u.u_world, mode);
          if (nodeMode) gl.uniformMatrix4fv(pr.u.u_model, false, layer.node.model);
          else if (world) {
            gl.uniform1f(pr.u.u_z, layer.st.z || 0);
            gl.uniformMatrix4fv(pr.u.u_carry, false, layer.carry || IDENTITY4);
          }
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
   * camera instead of the flat screen-space matrix. Node layers use their world
   * quad matrix (which already carries a camera parent), legacy layers keep the
   * canvas-space matrix + screen-plane conversion.
   */
  _layerCorners(L, rect = [0, 0, 1, 1]) {
    const [u0, v0, u1, v1] = rect;
    const s3 = this.scene3d;
    if (L.node?.model) {
      // Node plane: uv rect -> local quad (a_pos - 0.5) -> world -> pixels. The
      // v axis is flipped (world y is up, texture v = 0 is the picture top) so
      // the corner order stays top-left, top-right, bottom-right, bottom-left.
      if (!this._worldMode || !s3?.lastVP) return null;
      const W = this.canvas.width, H = this.canvas.height;
      const m = L.node.model;
      const out = [];
      for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
        const lx = u - 0.5, ly = 0.5 - v;
        const w = [
          m[0] * lx + m[4] * ly + m[12],
          m[1] * lx + m[5] * ly + m[13],
          m[2] * lx + m[6] * ly + m[14],
        ];
        const p = s3.projectPoint(w);
        if (!p) return null;
        out.push([p.x * W / Math.max(1, s3.lastW), p.y * H / Math.max(1, s3.lastH)]);
      }
      return out;
    }
    const pts = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]
      .map(([u, v]) => M3.apply(L.M, u, v));
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
      let w = [qx / 100, cyW - qy / 100, z];
      const p = s3.projectPoint(w);
      if (!p) return null;
      out.push([p.x * W / Math.max(1, s3.lastW), p.y * H / Math.max(1, s3.lastH)]);
    }
    return out;
  }

  /**
   * How much larger than in the default framing a text element appears through
   * `cam` (distance to its plane, fov change, its own scale), rounded up to a
   * few levels so a camera move re-rasterises only now and then. Screen-locked
   * elements are pulled in and keep their screen size, so they stay at 1.
   * Node layers measure from their world frame instead of the fixed screen plane.
   */
  _textZoom(el, st, cam, nodeFrame = null) {
    if (!cam || el.parent) return 1;
    const meta = this.project?.meta || {};
    const cyW = (Number(meta.height) || 1080) / 200;
    const point = nodeFrame
      ? nodeFrame.pos
      : [(st.x || 0) / 100, cyW - (st.y || 0) / 100, st.z || 0];
    const scaleRef = nodeFrame
      ? Math.max(1, Math.abs(Number(nodeFrame.scale?.[0]) || 1), Math.abs(Number(nodeFrame.scale?.[1]) || 1))
      : Math.max(1, Math.abs(st.scale || 1));
    const f = [cam.look[0] - cam.pos[0], cam.look[1] - cam.pos[1], cam.look[2] - cam.pos[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    const depth = ((point[0] - cam.pos[0]) * f[0] + (point[1] - cam.pos[1]) * f[1] + (point[2] - cam.pos[2]) * f[2]) / fl;
    if (!(depth > 0.05)) return 1;
    const halfDefault = Math.atan(((Number(meta.width) || 1920) / 200) / 20);
    const halfNow = ((Number(cam.fov) || 51.282) * Math.PI) / 360;
    const z = (20 / depth) * (Math.tan(halfDefault) / Math.tan(halfNow)) * scaleRef;
    for (const level of [1, 1.5, 2, 3, 4, 6, 8]) if (z <= level * 1.05) return level;
    return 8;
  }

  /** canvas-space hit test -> topmost element id */
  hitTest(cx, cy, t) {
    const layers = (this.layers && this.layersAt === t) ? this.layers : this.computeLayers(t);
    if (this._worldMode && this.scene3d?.lastVP) {
      const meta = this.project?.meta || {};
      const cyW = (Number(meta.height) || 1080) / 200;
      const camPos = this.scene3d.lastCam?.pos || [0, cyW, 20];
      // Same order as _drawLayers (spatial-layers.js), walked backwards: nearest
      // plane first and, on one plane, the top el.z layer first — picking and
      // the picture can never disagree about which layer is on top.
      const list = orderLayers(layers, camPos);
      for (let i = list.length - 1; i >= 0; i--) {
        const L = list[i];
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

  /**
   * UV sub-rect of a text layer that covers the actual line boxes instead of
   * the raster's empty padding. Used by the selection outline and the in-place
   * editor so the light-blue box hugs the words.
   */
  _textContentRect(L) {
    if (!L?.el || L.el.type !== 'text' || !L.st) return [0, 0, 1, 1];
    const style = L.el.style || {};
    const meta = this.project?.meta || {};
    const w = Number(L.w) || 1;
    const h = Number(L.h) || 1;
    const lines = String(L.st.text ?? style.text ?? '').split('\n').length;
    const fontPx = Math.max(1, (Number(L.st.size) || 96) * (this.canvas.width / (Number(meta.width) || 1920)));
    const lineH = fontPx * Math.max(0.1, Number(style.lineHeight) || 1.18);
    const pad = Math.max(0, (h - lineH * lines) / 2);
    if (pad * 2 >= w || pad * 2 >= h) return [0, 0, 1, 1];
    return [pad / w, pad / h, 1 - pad / w, 1 - pad / h];
  }

  /** Public alias for the in-place editor geometry. */
  textContentRect(L) { return this._textContentRect(L); }

  /** Projected quad of every 2D layer, in canvas pixels (perspective-aware). */
  layerPolygons(tightText = false) {
    return (this.layers || []).map((L) => {
      const rect = tightText ? this._textContentRect(L) : [0, 0, 1, 1];
      const points = this._layerCorners(L, rect);
      return points ? { id: L.el.id, points } : null;
    }).filter(Boolean);
  }

  /** debug: the exact 2D canvas used as a text texture */
  debugTextTexture(id) {
    const el = this.project?.elements.find((e) => e.id === id);
    if (!el) return null;
    const st = evalElement(el, this.time, this.project.meta, elementOverlay(this.project, el, this.time));
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
    if (this.elementAudio.size) {
      this._syncElementAudio(at, true);
      return;
    }
    const a = this.audioEl;
    if (!a) return;
    const offset = Number(this.project.meta.audio?.offset) || 0;
    try { a.currentTime = Math.max(0, at + offset); } catch { /* not ready */ }
    a.play().catch(() => {});
  }

  pauseAudio() {
    for (const a of this.elementAudio.values()) a.pause();
    this.audioEl?.pause();
  }

  setAudioTime(at) {
    if (this.elementAudio.size) {
      this._syncElementAudio(at, !!this.playing);
      return;
    }
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
