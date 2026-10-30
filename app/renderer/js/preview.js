// Realtime preview: WebGL2 compositor that mirrors blender/vdm_build.py.
// Layers -> scene FBO -> bloom chain -> composite (CA, grain, scanlines, vignette, grade).
//
// The draw list is the frame IR (docs/DESIGN-BACKEND-V2.md §4, WP0.2): every
// 2D layer arrives as one world quad (`items[].world` + `size`), so placement,
// visibility, blend order and the depth flag are all decided in core/, not here.
// The two placement paths the renderer used to carry are gone:
//
// - a node / parented element's `world` is `core/frame-ir.js::elementPixelMatrix`;
// - a legacy screen-space element's `world` is the same-shaped matrix derived
//   from its screen placement (`screenPixelMatrix`), with the local +y axis
//   flipped so both kinds sample `uv = (lx + 0.5, 0.5 - ly)`;
// - both are drawn through the 4x4 branch of VERT (`u_world > 1.5`), so the
//   picture cannot depend on which shape a layer started life as.
//
// What stays here is what is genuinely a renderer concern: resolving content
// into GPU resources (text rasters, media textures, camera-feed targets),
// texture resolution choices (`_textZoom`, `_textTexture`) and the post chain.
//
// Code layers (`raster` items, WP3.3) are the one kind whose picture is not
// resolved here: the pixels come from the single rasteriser on the Node side
// (`engine/render-workers/pool.js`, §5) through `GET /api/raster`, and this file
// only fetches, uploads and caches them. The request is asynchronous, so a
// raster item draws nothing until its PNG has arrived, the next frame is
// prefetched while playing, and a late (> 300 ms) or failed frame falls back to
// the last frame of the same channel that did arrive.
import { evalElement } from '/core/evaluate.js';
import { elementOverlay } from '/core/links.js';
import { cameraParamResolver, evalCameraWorldWithLinks } from '/core/link-eval.js';
import { cameraTransform, cameraLayers } from '/core/camera.js';
import { audioElements, audioVolume } from '/core/audio.js';
import { Scene3D } from './preview3d.js';
import { feedPlan, hiddenFeeds, normalizeFeed } from '/core/camfeed.js';
import { clearCompiledTracks, compileProject } from '/core/tracks.js';
import {
  layerOriginDistance, layerRayDepth, orderLayers,
} from './spatial-layers.js';
import { buildFrameIR, itemModelMatrix, mediaUVOf, IRCache, PIXEL_M } from '/core/frame-ir.js';
import { POST_GLSL_PATH, normalizeScreenFx, parsePostGlsl } from '/core/screen-fx.js';

// Screen effects (§5.4, WP3.5): the bloom / CA / grain / vignette / scanline /
// grade / contrast / saturation shaders are not written in this file. They live
// in `app/renderer/shaders/post.glsl`, which the render pool
// (`engine/render-workers/post.js`) compiles from as well — one implementation
// for the preview and the Blender export (D2). This module only builds the
// programs and feeds the passes; a change to the picture is a change to that
// file.
const POST_SHADERS = parsePostGlsl(await fetch(`/${POST_GLSL_PATH}`, { cache: 'no-cache' })
  .then((response) => {
    if (!response.ok) throw new Error(`post.glsl：HTTP ${response.status}`);
    return response.text();
  }));

/** How long a raster frame may be outstanding before the preview shows the last one (§WP3.3). */
const RASTER_BUDGET_MS = 300;
/** Live raster textures kept uploaded. Evicted oldest first; never a picture source of truth. */
const RASTER_MAX_TEXTURES = 24;
/** …and a byte budget, so a 1920x1080 layer cannot pin hundreds of MB of VRAM. */
const RASTER_MAX_BYTES = 64 * 1024 * 1024;
/** Raster requests in flight at once (the current frame plus next-frame prefetch). */
const RASTER_MAX_INFLIGHT = 2;
/** Uploaded text meshes kept on the GPU (a keystroke makes a new one). */
const MESH_MAX_BUFFERS = 96;

/** JSON with sorted keys, so one parameter set is one request key. */
function stableParams(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableParams).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableParams(value[k])}`).join(',')}}`;
}


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

// Text meshes (docs/DESIGN-BACKEND-V2.md §4.4 v4, WP1.3): the IR carries the
// glyph vertices of every text item, so the preview draws the same triangles
// Blender does instead of rasterising a canvas and putting it on a quad. The
// vertex buffer holds quad-local coordinates (`x/size[0] - 0.5`,
// `0.5 - y/size[1]`), so this program is one `u_model` away from the world.
const VERT_MESH = `#version 300 es
in vec2 a_pos;
uniform mat4 u_vp;
uniform mat4 u_model;
out vec2 v_pos;
void main(){
  gl_Position = u_vp * (u_model * vec4(a_pos, 0.0, 1.0));
  v_pos = a_pos;
}`;

const FRAG_MESH = `#version 300 es
precision highp float;
in vec2 v_pos;
out vec4 outColor;
uniform vec3 u_color;
uniform float u_opacity;
uniform float u_glow;
uniform float u_aCut;   // see FRAG_TEX: a see-through plane owns no pixel
void main(){
  float a = u_opacity;
  if (a < u_aCut) discard;
  outColor = vec4(u_color * (1.0 + u_glow * 2.4), a);
}`;

const FRAG_TEX = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec4 u_uv;
uniform float u_opacity;
uniform float u_glow;
// 2D planes own the depth buffer (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §四):
// a fragment below this alpha is not part of the picture and must not own a
// pixel — a text quad is mostly empty padding, and without the cut its rect
// would occlude everything behind it. 0 = the legacy paths, which never cut.
uniform float u_aCut;
void main(){
  vec2 uv = mix(u_uv.xy, u_uv.zw, v_uv);
  vec4 c = texture(u_tex, uv);
  float a = c.a * u_opacity;
  if (a < u_aCut) discard;
  vec3 rgb = c.rgb * (1.0 + u_glow * 2.4);
  outColor = vec4(rgb, a);
}`;

const FRAG_SHAPE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec4 u_color;
uniform vec2 u_size;
uniform float u_radius;
uniform float u_kind; // 0 rect, 1 ellipse
uniform float u_aCut; // see FRAG_TEX
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
  float edge = 1.0 - smoothstep(-aa, aa, d);
  float a = u_color.a * edge;
  if (a < u_aCut) discard;
  outColor = vec4(u_color.rgb, a);
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

// The effect shaders (bright / blur / composite) are not here: they are the
// sections of app/renderer/shaders/post.glsl, parsed into POST_SHADERS above.

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

/** Length of one column of an IR world matrix (metres per project pixel). */
const colLen = (m, i) => Math.hypot(m[i], m[i + 1], m[i + 2]);

function hexRgb(c) {
  const s = String(c || '#000').replace('#', '');
  const h = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
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
    // Text meshes (§4.4 v4, WP1.3): the font bytes come from `/api/font`, the
    // parsed fonts / triangulated glyphs / mesh records live in these three
    // maps (`opts.textCache` of core/frame-ir.js), and the GPU buffers are
    // created once per mesh id. Without the bytes the IR keeps `mesh: null` and
    // text falls back to the canvas raster below (`_textTexture`).
    this.fontBytes = new Map();     // font name -> Uint8Array
    this.fontMap = {};              // the same bytes as `opts.fonts` of the IR
    this.fontPending = new Map();   // font name -> Promise
    this.fontFailed = new Set();    // font name -> 404 / 403; not asked again
    this.fontEndpoint = '/api/font';
    this.textGeometry = { fonts: new Map(), glyphs: new Map(), meshes: new Map() };
    this.meshGpu = new Map();       // mesh id -> { vao, vbo, ibo, count, used }
    this._meshTick = 0;             // LRU stamp for `meshGpu`
    this.meshStats = { draws: 0, builds: 0 };
    // Frame IR for the current revision (core/frame-ir.js::IRCache): one
    // build per frame, shared by render() and hitTest().
    this._irCache = new IRCache();
    this._ir = null;
    // Code layers (§5/§6, WP3.3): one texture per (source, frame, size, params,
    // seed), the last completed frame per channel as the late/failed fallback,
    // and the requests still in flight. `rasterEndpoint` is the one door to the
    // rasteriser; a probe can point it elsewhere to exercise the failure path.
    this.rasterEndpoint = '/api/raster';
    this.rasterTextures = new Map();   // request key -> { tex, w, h, channel, used }
    this.rasterLast = new Map();       // channel -> request key of its last completed frame
    this.rasterPending = new Map();    // request key -> { startedAt, channel, url }
    this.rasterFailed = new Set();     // request keys that will not be asked again
    this.rasterRequests = 0;
    // What one frame of a channel cost to arrive, for the inspector's render
    // row (WP3.6a). Measured here because `/api/raster` answers with a bare
    // PNG: the round trip is the only number this side can honestly report.
    this.rasterTiming = new Map();     // channel -> { ms, frame }
    this._rasterTick = 0;              // LRU stamp for the texture map
    this._rasterGen = 0;               // bumped when a new revision lands
    this._hasCodeLayers = false;
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
      mesh: compile(gl, VERT_MESH, FRAG_MESH),
      full: compile(gl, VERT, FRAG_FULL),
      bright: compile(gl, VERT, POST_SHADERS.bright),
      blur: compile(gl, VERT, POST_SHADERS.blur),
      comp: compile(gl, VERT, POST_SHADERS.composite),
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

  /**
   * Swap the project the viewport draws without touching GPU resources
   * (docs/DESIGN-WP2.5-REVIEW.md §11.3). `setProject` is wrong for a change-set
   * preview: it would drop every image/video texture and audio player, and the
   * shadow shares all of them with the real project (same `src`). Only the
   * draw list is rebuilt: a new frame-IR cache, the shadow's keyframe arrays
   * compiled, and new elements' assets loaded. Exit = `setOverlay(realProject)`.
   */
  setOverlay(p) {
    if (!p) return;
    this.project = p;
    this._irCache = new IRCache();
    this._ir = null;
    // The shadow is a parsed copy: its keyframe arrays are new objects, so
    // they are compiled here. Entries for the real project stay valid (they
    // are keyed by the array itself), so no `clearCompiledTracks()` — the
    // timeline keeps sampling the real project while this overlay is on.
    compileProject(p);
    this._hasCodeLayers = (p.elements || []).some((element) => element.type === 'code');
    for (const el of p.elements || []) this._ensureAsset(el);
  }

  setProject(p) {
    const changedAudio = this.project?.meta?.audio?.src !== p.meta.audio?.src;
    this.project = p;
    // A new revision invalidates every cached frame (core/frame-ir.js::IRCache
    // serves only the revision it was built at).
    this._irCache = new IRCache();
    this._ir = null;
    clearCompiledTracks();
    compileProject(p);
    // A source may have been edited, and the request key does not hash the
    // source files (the pool does), so a new revision drops every raster
    // texture: a stale picture is worse than one frame that has to reload.
    this._hasCodeLayers = (p.elements || []).some((element) => element.type === 'code');
    this._clearRasterState();
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
    return cameraLayers(this.project, this.soloCameras, t);
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
   * The frame IR this time draws (docs/DESIGN-BACKEND-V2.md §4). One build per
   * frame and revision: `render()` and `hitTest()` share it, and a revision the
   * cache has already seen costs one Map lookup. `setProject` hands in a fresh
   * cache, so an edit never draws a stale frame.
   */
  _frameIR(t) {
    const p = this.project;
    const fps = Number(p.meta?.fps) || 24;
    const frame = Math.round((Number(t) || 0) * fps);
    this._ensureFonts();
    return buildFrameIR(p, frame, {
      fps,
      camera: 'live',
      edit: (this.editMode && this.editCam) ? { cam: this.editCam, mode: true } : null,
      soloCameras: this.soloCameras,
      cache: this._irCache,
      city: this.scene3d?.city || null,
      // Text meshes (§4.4 v4, WP1.3): the bytes fetched from `/api/font` decide
      // whether a text item gets `content.mesh`; the caches keep one parse and
      // one triangulation per font / glyph for the whole session.
      fonts: this.fontMap,
      textCache: this.textGeometry,
    });
  }

  // ---------------------------------------------------------------- text meshes

  /*
   * `this.fontMap` is the `opts.fonts` map the IR reads: font name -> bytes. It
   * is a live object (`buildFrameIR` enumerates its keys for the per-character
   * fallback chain), so a font that lands after a frame was drawn appears on the
   * next one — the IR cache is cleared when that happens, in `_fetchFont`.
   */

  /** Ask for every font this project's text uses that is not known yet. */
  _ensureFonts() {
    const p = this.project;
    if (!p) return;
    for (const el of p.elements || []) {
      if (el.type !== 'text' || el.visible === false) continue;
      const name = String(el.style?.font || 'SimHei');
      if (this.fontBytes.has(name) || this.fontFailed.has(name) || this.fontPending.has(name)) continue;
      this._fetchFont(name);
    }
  }

  _fetchFont(name) {
    // `fetch` of a font file is a plain byte request: no DOM, no canvas. A
    // family name and a project path take the same query (the server resolves
    // both against its whitelist).
    const url = `${this.fontEndpoint}?font=${encodeURIComponent(name)}`;
    const task = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`font ${res.status}`);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        this.fontBytes.set(name, bytes);
        this.fontMap[name] = bytes;
        // A frame built without the font is a frame with the old text path: drop
        // it so the next render (the idle loop redraws within 100 ms) uses the
        // mesh. `meshes` is keyed by content hash, so it can stay.
        this._irCache.clear();
      } catch {
        this.fontFailed.add(name);
      } finally {
        this.fontPending.delete(name);
      }
    })();
    this.fontPending.set(name, task);
  }

  /** True when every font this project needs has been fetched (or given up on). */
  fontsReady() {
    this._ensureFonts();
    return this.fontPending.size === 0;
  }

  /** Promise that settles when the font requests in flight are done. */
  async whenFontsReady() {
    while (this.fontPending.size) await Promise.all([...this.fontPending.values()]);
    return this.fontsReady();
  }

  /** GPU buffers of one IR mesh (positions in quad-local coordinates). */
  _meshGpuFor(id, mesh) {
    const hit = this.meshGpu.get(id);
    if (hit) { hit.used = ++this._meshTick; return hit; }
    const gl = this.gl;
    const size = Array.isArray(mesh.size) ? mesh.size : [1, 1];
    const w = Number(size[0]) || 1;
    const h = Number(size[1]) || 1;
    const verts = mesh.vertices || [];
    const local = new Float32Array(verts.length);
    for (let i = 0; i + 1 < verts.length; i += 2) {
      local[i] = verts[i] / w - 0.5;
      local[i + 1] = 0.5 - verts[i + 1] / h;
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, local, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(mesh.indices || []), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
    const entry = { vao, vbo, ibo, count: (mesh.indices || []).length, used: ++this._meshTick };
    this.meshGpu.set(id, entry);
    this.meshStats.builds += 1;
    // Typing changes the text, so mesh ids come and go: keep the uploaded set
    // bounded (oldest upload first) instead of growing for the whole session.
    if (this.meshGpu.size > MESH_MAX_BUFFERS) this._evictMeshes();
    return entry;
  }

  _evictMeshes() {
    const gl = this.gl;
    const byAge = [...this.meshGpu.entries()].sort((a, b) => a[1].used - b[1].used);
    const drop = byAge.slice(0, Math.max(1, byAge.length - MESH_MAX_BUFFERS));
    for (const [id, entry] of drop) {
      gl.deleteVertexArray(entry.vao);
      gl.deleteBuffer(entry.vbo);
      gl.deleteBuffer(entry.ibo);
      this.meshGpu.delete(id);
    }
  }

  // ---------------------------------------------------------------- code layers
  //
  // A `raster` item is "one frame of one code source": the IR carries the
  // request (source, params of THIS frame, seed, raster size, live|bake), and
  // this renderer only turns the answer into a texture. Nothing here evaluates
  // user code — the rasteriser on the Node side is the single implementation
  // (§5, P4).

  /** Request key of one raster frame: the same pixels are the same key. */
  _rasterKey(item, frame) {
    const c = item.content || {};
    const size = c.size || item.size || [0, 0];
    return `${c.source?.id || ''}|${frame}|${size[0]}x${size[1]}|${Number(c.seed) || 0}|${stableParams(c.params || {})}`;
  }

  /** One channel = (source, raster size, seed, params): its last frame is the fallback. */
  _rasterChannel(item) {
    const c = item.content || {};
    const size = c.size || item.size || [0, 0];
    return `${c.source?.id || ''}|${size[0]}x${size[1]}|${Number(c.seed) || 0}|${stableParams(c.params || {})}`;
  }

  /** The URL the rasteriser answers for this item (§WP3.3 route contract). */
  _rasterUrl(item, frame) {
    const c = item.content || {};
    const size = c.size || item.size || [0, 0];
    const query = new URLSearchParams({
      source: String(c.source?.id || ''),
      frame: String(frame),
      w: String(size[0]),
      h: String(size[1]),
      params: stableParams(c.params || {}),
      seed: String(Number(c.seed) || 0),
    });
    if (c.mode === 'bake') query.set('mode', 'bake');
    return `${this.rasterEndpoint}?${query.toString()}`;
  }

  /**
   * Ask for one raster frame, at most once per key. `prefetch` requests stay
   * under RASTER_MAX_INFLIGHT so a 30 fps timeline cannot flood the pool.
   * A finished request uploads its PNG as one texture (bitmap closed right
   * after the upload, so nothing leaks per frame).
   */
  _requestRaster(item, frame, { prefetch = false } = {}) {
    const source = item.content?.source?.id;
    if (!source) return null; // nothing to ask for: the layer draws nothing
    const key = this._rasterKey(item, frame);
    if (this.rasterTextures.has(key) || this.rasterPending.has(key) || this.rasterFailed.has(key)) return null;
    if (prefetch) {
      if (this.rasterPending.size >= RASTER_MAX_INFLIGHT) return null;
    }
    const entry = {
      startedAt: performance.now(), frame,
      channel: this._rasterChannel(item), url: this._rasterUrl(item, frame), gen: this._rasterGen,
    };
    this.rasterPending.set(key, entry);
    this.rasterRequests += 1;
    fetch(entry.url, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`raster ${response.status}`);
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        // A revision may have landed while this was in flight: the pixels
        // belong to the old source, so they are dropped, not drawn.
        if (entry.gen !== this._rasterGen) {
          if (typeof bitmap.close === 'function') bitmap.close();
          return;
        }
        this.rasterPending.delete(key);
        this._uploadRaster(key, entry, bitmap);
      })
      .catch(() => {
        this.rasterPending.delete(key);
        // Not retried: a frame that failed falls back to the last good one, and
        // repeating it every render would hammer a broken route.
        this.rasterFailed.add(key);
      });
    return null;
  }

  /** Upload one arrived PNG frame and make it the channel's fallback. */
  _uploadRaster(key, entry, bitmap) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ms = Math.round((performance.now() - entry.startedAt) * 10) / 10;
    const record = {
      tex, w: bitmap.width, h: bitmap.height,
      channel: entry.channel, used: ++this._rasterTick, frame: entry.frame,
    };
    if (typeof bitmap.close === 'function') bitmap.close();
    this.rasterTextures.set(key, record);
    this.rasterLast.set(entry.channel, key);
    // §WP3.6a: one number for the inspector — what the last arrived frame of
    // this channel cost. A new frame replaces it, so the row never shows a
    // number that belongs to a different picture.
    this.rasterTiming.set(entry.channel, { ms, frame: entry.frame });
    this._trimRasterTextures();
    return record;
  }

  /** Oldest textures go first (count and bytes); a channel's fallback frame is never evicted. */
  _trimRasterTextures() {
    let bytes = 0;
    for (const record of this.rasterTextures.values()) bytes += (record.w || 0) * (record.h || 0) * 4;
    if (this.rasterTextures.size <= RASTER_MAX_TEXTURES && bytes <= RASTER_MAX_BYTES) return;
    const keep = new Set(this.rasterLast.values());
    for (const [key, record] of this.rasterTextures) {
      if (this.rasterTextures.size <= RASTER_MAX_TEXTURES && bytes <= RASTER_MAX_BYTES) break;
      if (keep.has(key)) continue;
      bytes -= (record.w || 0) * (record.h || 0) * 4;
      this.gl.deleteTexture(record.tex);
      this.rasterTextures.delete(key);
    }
  }

  /**
   * The texture this raster item draws now, or null when it has nothing honest
   * to show: its own frame before the PNG arrived, and no earlier frame of the
   * same channel to stand in. A pending request older than RASTER_BUDGET_MS is
   * treated as late, which is when the previous frame takes over.
   */
  _rasterFor(item, frame, { request = true } = {}) {
    const key = this._rasterKey(item, frame);
    const ready = this.rasterTextures.get(key);
    if (ready) {
      ready.used = ++this._rasterTick;
      return ready;
    }
    if (request) this._requestRaster(item, frame);
    const pending = this.rasterPending.get(key);
    const late = !pending || performance.now() - pending.startedAt > RASTER_BUDGET_MS;
    if (!late) return null;
    const fallback = this.rasterTextures.get(this.rasterLast.get(this._rasterChannel(item)));
    return fallback ? { ...fallback, stale: true } : null;
  }

  /**
   * During playback, ask one frame ahead: a raster is rendered on the Node side
   * (~tens of ms) and waiting for it inside the frame would stall the timeline.
   * Building the next IR here is cheap and hands the same object to the next
   * render through the IR cache.
   */
  _prefetchRasters() {
    if (!this.playing || !this._hasCodeLayers || !this._ir) return;
    if (this.rasterPending.size >= RASTER_MAX_INFLIGHT) return;
    const p = this.project;
    const fps = Number(p.meta?.fps) || 24;
    const next = buildFrameIR(p, Number(this._ir.frame) + 1, {
      fps,
      camera: 'live',
      edit: (this.editMode && this.editCam) ? { cam: this.editCam, mode: true } : null,
      soloCameras: this.soloCameras,
      cache: this._irCache,
      city: this.scene3d?.city || null,
    });
    for (const item of next.items) {
      if (item.kind !== 'raster') continue;
      if (this.rasterPending.size >= RASTER_MAX_INFLIGHT) break;
      this._requestRaster(item, next.frame, { prefetch: true });
    }
  }

  /** Drop every raster texture / request (a new revision, or a teardown). */
  _clearRasterState() {
    const gl = this.gl;
    this._rasterGen += 1; // responses still in flight belong to the old files
    for (const record of this.rasterTextures.values()) if (record.tex) gl.deleteTexture(record.tex);
    this.rasterTextures.clear();
    this.rasterLast.clear();
    this.rasterPending.clear();
    this.rasterFailed.clear();
    this.rasterTiming.clear();
  }

  /**
   * What one code layer's picture is doing at time `t` (WP3.6a: the inspector's
   * render row and the stage mark, docs/DESIGN-WP3.6-4.6-UI.md §2.1/§2.3).
   *
   * Read-only on purpose: it never asks for a frame, so a panel repaint (or the
   * paused stage repainting at 10 fps) cannot flood the rasteriser — the render
   * loop stays the one place that requests.
   *
   *   status 'live'     the frame on screen is this frame, rendered on demand
   *          'bake'     cache-only layer (`code.cache: "bake"`); it only ever
   *                     shows cached frames, so nothing is "late" here
   *          'waiting'  nothing honest to draw yet: no first frame, or the
   *                     request failed and there is no earlier frame to stand in
   *          'fallback' the last good frame of this channel stands in
   *          'none'     the element is not in this frame's picture at all
   *
   * `quad` is the item's four corners in canvas pixels even when it has no
   * layer entry yet (a waiting item is dropped from the draw list, which is
   * exactly when the stage mark needs the corner).
   */
  rasterStateOf(elementId, t) {
    if (!this.project) return null;
    const id = String(elementId ?? '');
    if (!id) return null;
    const at = Number.isFinite(Number(t)) ? Number(t) : 0;
    const ir = this._frameIR(at);
    const item = ir.items.find((it) => it.kind === 'raster' && String(it.id) === id) || null;
    if (!item) return { status: 'none', mode: null, frame: ir.frame, quad: null, ms: null, shownFrame: null };
    const mode = item.content?.mode === 'bake' ? 'bake' : 'live';
    const size = Array.isArray(item.size) && item.size.length >= 2 ? item.size : null;
    const quad = size ? this._layerCorners({ model: itemModelMatrix(item, [size[0], size[1]]) }) : null;
    const key = this._rasterKey(item, ir.frame);
    const channel = this._rasterChannel(item);
    const timing = this.rasterTiming.get(channel) || null;
    const out = {
      status: mode === 'bake' ? 'bake' : 'live',
      mode, frame: ir.frame, quad,
      ms: Number.isFinite(timing?.ms) ? timing.ms : null,
      shownFrame: null,
      stale: false,
    };
    if (this.rasterTextures.has(key)) return { ...out, shownFrame: ir.frame };
    // A bake layer reads the disk cache and nothing else (§6.1): a miss is the
    // mode working as asked, not a layer that is late.
    if (mode === 'bake') return out;
    const pending = this.rasterPending.get(key);
    const late = !pending || performance.now() - pending.startedAt > RASTER_BUDGET_MS;
    const lastKey = this.rasterLast.get(channel);
    const last = lastKey ? this.rasterTextures.get(lastKey) : null;
    if (last && (late || this.rasterFailed.has(key))) {
      return { ...out, status: 'fallback', stale: true, shownFrame: Number.isFinite(last.frame) ? last.frame : null };
    }
    return { ...out, status: 'waiting' };
  }

  /** Diagnostics for probes: how much raster state is live right now. */
  rasterStats() {
    return {
      textures: this.rasterTextures.size,
      pending: this.rasterPending.size,
      failed: this.rasterFailed.size,
      requests: this.rasterRequests,
      channels: this.rasterLast.size,
      last: [...this.rasterLast.entries()],
    };
  }

  /**
   * Draw list for time t, straight from the frame IR (WP0.2).
   *
   * The renderer no longer decides what is visible, where a quad sits, which
   * pixel it owns or what its content is — it only resolves content into GPU
   * resources (a text raster, the media texture, a camera-feed target) and
   * hands each item to `_drawLayers`. Layer objects keep the shape the rest of
   * the renderer reads: `el` (the project element), `st` (the IR's sampled text
   * / opacity state), `w`/`h` in canvas pixels and `model` (the item's world
   * quad, core/frame-ir.js::itemModelMatrix).
   */
  computeLayers(t, { request = true } = {}) {
    const p = this.project;
    if (!p) return [];
    const ir = this._frameIR(t);
    this._ir = ir;
    const W = this.canvas.width, H = this.canvas.height;
    const meta = p.meta || {};
    const S = W / (Number(meta.width) || 1920);
    const cyW = (Number(meta.height) || 1080) / 200;
    const els = new Map((p.elements || []).map((e) => [e.id, e]));
    // Feed sources on screen now also film the text: rasterise for the closest
    // view. A texture-resolution decision (not picture data), hence it stays
    // here; every judgement about *what* is drawn comes from the IR.
    const feedCams = this.scene3d?.city ? this._liveFeedCameras(p, t) : [];
    const out = [];
    for (const item of ir.items) {
      const el = els.get(item.id);
      if (!el) continue;
      const c = item.content || {};
      // Length of the world columns = the plane's scale (metres per pixel).
      const scale = [colLen(item.world, 0), colLen(item.world, 4)];
      const layer = {
        id: item.id,
        item,
        el,
        z: item.z,
        plane: item.plane,
        src: item.src,
        blend: item.blend,
        opacity: item.opacity,
        glow: Number(c.glow) || 0,
        depth: item.depth,
        uv: c.uv || [0, 0, 1, 1],
        st: {
          text: c.text,
          size: c.fontSize,
          opacity: item.opacity,
          x: Number(item.plane.p[0]) * 100,
          y: (cyW - Number(item.plane.p[1])) * 100,
          z: Number(item.plane.p[2]),
          scale: Math.max(scale[0], scale[1]) / PIXEL_M,
          glow: Number(c.glow) || 0,
        },
      };
      if (item.kind === 'text') {
        // v4: the IR carries the glyph mesh and its typeset box (§4.4, WP1.3).
        // Draw the vertices — the same triangles Blender builds. A text item
        // without a mesh (no font bytes, or a style the mesh path does not
        // cover: shadow / stroke) keeps the pre-v4 canvas raster.
        const mesh = c.mesh ? ir.meshes?.[c.mesh] : null;
        if (mesh) {
          layer.kind = 'mesh';
          layer.mesh = mesh;
          layer.meshId = c.mesh;
          // Colour and opacity come from the *item*, never from the mesh record:
          // the mesh id deliberately leaves colour out of its key, so a colour
          // change (or a colour keyframe) keeps the same triangles but must
          // repaint. `mesh.color` is only the snapshot the mesh was built with.
          layer.color = hexRgb(c.color);
          layer.opacity = Number(item.opacity) || 0;
          layer.quad = [item.size[0], item.size[1]];
          layer.w = item.size[0] * S;
          layer.h = item.size[1] * S;
        } else {
          // Typesetting for the fallback still happens here (pre-v4 behaviour).
          const style = {
            font: c.font,
            weight: c.weight,
            align: c.align,
            lineHeight: c.lineHeight,
            letterSpacing: c.letterSpacing,
            shadow: c.shadow,
            stroke: c.stroke,
            strokeWidth: c.strokeWidth,
          };
          const zoom = this._textZoomFor(layer, feedCams, ir);
          const tt = this._textTexture(el, { size: c.fontSize, text: c.text, color: c.color }, style, zoom);
          layer.kind = 'tex';
          layer.tex = tt.tex;
          layer.quad = [tt.w / tt.zoom / S, tt.h / tt.zoom / S];
          layer.w = tt.w / tt.zoom;
          layer.h = tt.h / tt.zoom;
        }
      } else if (item.kind === 'image' || item.kind === 'video') {
        const a = this.assets.get(item.id);
        if (!a || !a.ready || !a.tex) continue;
        let iw = 0, ih = 0;
        if (a.kind === 'image') { iw = a.img.naturalWidth; ih = a.img.naturalHeight; }
        else { iw = a.video.videoWidth; ih = a.video.videoHeight; }
        layer.kind = 'tex';
        layer.tex = a.tex;
        layer.asset = a;
        // The project has no intrinsic media size yet, so the IR leaves `uv`
        // null: the loaded media supplies the size and the one exported rule
        // (core/frame-ir.js::mediaUVOf) supplies the rect (WP4.1 writes the
        // size into the element and the IR starts carrying it).
        if (!c.uv) layer.uv = mediaUVOf(c.fit, iw, ih, [meta.width, meta.height]) || [0, 0, 1, 1];
        layer.quad = [item.size[0], item.size[1]];
        layer.w = item.size[0] * S;
        layer.h = item.size[1] * S;
      } else if (item.kind === 'camfeed') {
        // The texture is the source camera's target, bound per draw by
        // _drawLayers: the source is only rendered later in the frame, so a
        // layer built here must not capture a texture yet (that is exactly why
        // the delay-1 feed used to show nothing).
        layer.feed = c.feed;
        layer.kind = 'tex';
        // The source target is bottom-up, so its image space is flipped: the IR
        // carries uv in image space and this is where the texture lies.
        layer.uv = [0, 1, 1, 0];
        layer.quad = [item.size[0], item.size[1]];
        layer.w = item.size[0] * S;
        layer.h = item.size[1] * S;
      } else if (item.kind === 'raster') {
        // A code layer (§6.1). The pixels are not here yet — the request is
        // asynchronous, so this item contributes nothing this frame instead of
        // drawing the wrong frame. Once the PNG is in, it is one texture that
        // fills the quad (the IR's `content.size` only says how sharp it is).
        const got = this._rasterFor(item, ir.frame, { request });
        if (!got) continue;
        layer.kind = 'tex';
        layer.tex = got.tex;
        layer.uv = [0, 0, 1, 1];
        layer.quad = [item.size[0], item.size[1]];
        layer.w = item.size[0] * S;
        layer.h = item.size[1] * S;
        layer.raster = { stale: !!got.stale, frame: ir.frame };
      } else if (item.kind === 'solid' || item.kind === 'shape') {
        layer.kind = 'shape';
        layer.color = [...c.fill, item.opacity];
        layer.radius = (Number(c.radius) || 0) * S;
        layer.shape = c.ellipse ? 1 : 0;
        layer.quad = [item.size[0], item.size[1]];
        layer.w = item.size[0] * S;
        layer.h = item.size[1] * S;
      } else {
        continue;
      }
      layer.model = itemModelMatrix(item, layer.quad);
      out.push(layer);
    }
    return out;
  }

  /**
   * Text raster scale: how much larger than the default framing the element
   * appears through the frame's camera (and any camera feeding a screen), so a
   * close-up stays sharp. Fed the IR's own numbers so it cannot drift from the
   * picture; the level list and the "no world yet" shortcut are unchanged.
   */
  _textZoomFor(layer, feedCams, ir) {
    if (!this.scene3d?.city) return 1; // the flat fallback never zoomed
    const el = layer.el;
    const st = layer.st;
    // Every IR quad is described like a node plane, so one branch of _textZoom
    // serves both kinds: `pos` is the plane origin, `scale` the quad scale.
    const nodeFrame = { pos: layer.plane.p, scale: [st.scale, st.scale, 1] };
    const cam = { pos: ir.camera.pos, look: ir.camera.look, fov: ir.camera.fov };
    let zoom = this._textZoom(el, st, cam, nodeFrame);
    for (const c of feedCams) zoom = Math.max(zoom, this._textZoom(el, st, c, nodeFrame));
    return zoom;
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
    // Next frame's code-layer raster, one frame ahead (no-op without code layers).
    this._prefetchRasters();
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
      this._drawLayers(layers, W, H, this._flatWorld(W, H));
    }

    // Screen effects: one normalisation for the preview and the export
    // (core/screen-fx.js), so a project cannot mean two different things.
    this._postAndComposite(p, t, W, H, normalizeScreenFx(p.meta.fx));
  }

  /**
   * 2D element layers, every one of them a world quad from the frame IR
   * (WP0.2). `world` = {vp, camPos, meta} or {flat: true, vp, camPos, meta}
   * when no 3D snapshot has arrived yet; both use the same vertex path, so the
   * picture only depends on the IR.
   *
   * `item.depth.write` says whether an opaque fragment owns the depth buffer
   * (问题四's rule, now carried by the IR): the depth-only pass discards below
   * `item.depth.cut` so a glyph keeps its anti-aliased rim, then the colour
   * pass blends at u_aCut 0. Legacy screen-space items never wrote depth and
   * still don't, so their stacking behaviour is untouched.
   *
   * Blending order: the IR's `drawOrder` is the main eye's; a camera-feed source
   * draws its own picture through its own eye, so the list is re-ordered here
   * with the same rule (core/layers.js::orderLayers) and the eye's position.
   */
  _drawLayers(layers, W, H, world) {
    const gl = this.gl;
    let list = layers;
    if (world) {
      list = orderLayers(layers, world.camPos);
      for (const pr of [this.prog.tex, this.prog.shape, this.prog.mesh]) {
        gl.useProgram(pr.program);
        gl.uniformMatrix4fv(pr.u.u_vp, false, world.vp);
      }
      if (!world.flat) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
      }
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
        const mode = world ? 2 : 0;
        // A see-through plane (transform.opacity below the cut) never owns a
        // pixel: writing depth there would cut a hole into the stack behind it
        // while still blending, so it stays sorting-only (方案 §四 风险).
        const ownsDepth = !!world && !!layer.depth?.write;
        const pr = layer.kind === 'tex' ? this.prog.tex : layer.kind === 'mesh' ? this.prog.mesh : this.prog.shape;
        if (layer.kind === 'tex') {
          gl.useProgram(pr.program);
          gl.uniform2f(pr.u.u_res, W, H);
          gl.uniform1f(pr.u.u_world, mode);
          if (mode) gl.uniformMatrix4fv(pr.u.u_model, false, layer.model);
          gl.uniform4fv(pr.u.u_uv, new Float32Array(layer.uv));
          gl.uniform1f(pr.u.u_opacity, layer.opacity);
          gl.uniform1f(pr.u.u_glow, layer.glow);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, layer.feed ? this._feedTexture(layer.feed) : layer.tex);
          gl.uniform1i(pr.u.u_tex, 0);
        } else if (layer.kind === 'mesh') {
          // The glyph triangles of a text item: one VBO per mesh id, positioned
          // by the same `u_model` the textured quads use, so a text plane and a
          // picture plane cannot diverge.
          const gpu = this._meshGpuFor(layer.meshId, layer.mesh);
          gl.useProgram(pr.program);
          if (mode) gl.uniformMatrix4fv(pr.u.u_model, false, layer.model);
          gl.uniform3f(pr.u.u_color, layer.color[0], layer.color[1], layer.color[2]);
          gl.uniform1f(pr.u.u_opacity, layer.opacity);
          gl.uniform1f(pr.u.u_glow, layer.glow);
          if (ownsDepth) {
            // Same two-pass recipe as a textured plane: the depth-only pass
            // claims the pixel, the colour pass at u_aCut 0 draws it.
            gl.colorMask(false, false, false, false);
            gl.depthMask(true);
            gl.uniform1f(pr.u.u_aCut, layer.depth.cut);
            gl.bindVertexArray(gpu.vao);
            gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_INT, 0);
            gl.colorMask(true, true, true, true);
            gl.depthMask(false);
          }
          gl.uniform1f(pr.u.u_aCut, 0);
          gl.bindVertexArray(gpu.vao);
          gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_INT, 0);
          gl.bindVertexArray(this.vao);
          this.meshStats.draws += 1;
          continue;
        } else {
          // Solid/shape keeps the existing SDF fragment shader (rect / rounded
          // rect / ellipse) — only its quad placement comes from the IR.
          gl.useProgram(pr.program);
          gl.uniform2f(pr.u.u_res, W, H);
          gl.uniform1f(pr.u.u_world, mode);
          if (mode) gl.uniformMatrix4fv(pr.u.u_model, false, layer.model);
          gl.uniform4fv(pr.u.u_color, new Float32Array(layer.color));
          gl.uniform2f(pr.u.u_size, layer.w, layer.h);
          gl.uniform1f(pr.u.u_radius, layer.radius);
          gl.uniform1f(pr.u.u_kind, layer.shape);
        }
        if (ownsDepth) {
          // Depth-only pass: only the parts that really are the picture claim
          // the pixel. Colour comes from the pass below at u_aCut 0, so a glyph
          // keeps its anti-aliased rim instead of a one-bit edge.
          gl.colorMask(false, false, false, false);
          gl.depthMask(true);
          gl.uniform1f(pr.u.u_aCut, layer.depth.cut);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.colorMask(true, true, true, true);
          gl.depthMask(false);
          gl.uniform1f(pr.u.u_aCut, 0);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
      if (!world.flat) gl.disable(gl.DEPTH_TEST);
    }
  }

  /**
   * Screen-space view of the same IR quads while no 3D snapshot has arrived
   * yet (the world request is debounced): the world -> canvas map the old
   * screen path used, written as one projection matrix so there is still a
   * single draw path.
   */
  _flatWorld(W, H) {
    const meta = this.project?.meta || {};
    const S = W / (Number(meta.width) || 1920);
    const cyW = (Number(meta.height) || 1080) / 200;
    const sx = 100 * S;
    return {
      flat: true,
      meta,
      camPos: this._ir?.camera?.pos || [0, cyW, 20],
      vp: new Float32Array([
        (2 * sx) / W, 0, 0, 0,
        0, (2 * sx) / H, 0, 0,
        0, 0, 0, 0,
        0, -(cyW * 2 * sx) / H, 0, 1,
      ]),
    };
  }

  _postAndComposite(p, t, W, H, fx) {
    const gl = this.gl;
    const bloom = fx.bloom;

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
    gl.uniform1f(pr.u.u_ca, fx.ca);
    gl.uniform1f(pr.u.u_grain, fx.grain);
    gl.uniform1f(pr.u.u_scan, fx.scanline);
    gl.uniform1f(pr.u.u_vignette, fx.vignette);
    gl.uniform1f(pr.u.u_grade, fx.grade);
    gl.uniform1f(pr.u.u_contrast, fx.contrast);
    gl.uniform1f(pr.u.u_saturation, fx.saturation);
    gl.uniform1f(pr.u.u_time, t);
    gl.uniform1f(pr.u.u_flip, 1.0);
    // The preview draws to an opaque screen: alpha = 1 exactly, as before WP3.5.
    gl.uniform1f(pr.u.u_keepAlpha, 0);
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
   * The four corners of an IR quad in canvas pixels. `model` is the item's
   * world quad; `rect` is a uv sub-rectangle (the tight text box). In world
   * mode the corners go through the last 3D view-projection so picking follows
   * a moved camera; with no 3D snapshot they go through the same world ->
   * canvas map the flat draw uses.
   */
  _layerCorners(L, rect = [0, 0, 1, 1]) {
    const m = L?.model;
    if (!m) return null;
    const [u0, v0, u1, v1] = rect;
    const W = this.canvas.width, H = this.canvas.height;
    const s3 = this.scene3d;
    const world = [];
    for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
      const lx = u - 0.5, ly = 0.5 - v;
      world.push([
        m[0] * lx + m[4] * ly + m[12],
        m[1] * lx + m[5] * ly + m[13],
        m[2] * lx + m[6] * ly + m[14],
      ]);
    }
    if (this._worldMode && s3?.lastVP) {
      const out = [];
      for (const w of world) {
        const p = s3.projectPoint(w);
        if (!p) return null;
        out.push([p.x * W / Math.max(1, s3.lastW), p.y * H / Math.max(1, s3.lastH)]);
      }
      return out;
    }
    const meta = this.project?.meta || {};
    const S = W / (Number(meta.width) || 1920);
    const cyW = (Number(meta.height) || 1080) / 200;
    return world.map(([x, y]) => [W / 2 + x * 100 * S, H / 2 - (y - cyW) * 100 * S]);
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

  /** canvas-space hit test -> topmost element id (the same rule as the picture) */
  hitTest(cx, cy, t) {
    // One implementation: the top of the same stack `hitTestAll` returns. The
    // locked-host pass-through (WP2.5b §10.5) needs the whole stack, so picking
    // never grew a second rule.
    return this.hitTestAll(cx, cy, t)[0] ?? null;
  }

  /**
   * Every layer under the cursor, front to back (the order the picture draws
   * them). Used by viewport picking to skip a locked host and take the first
   * unlocked one below it; ids are deduped, first occurrence wins.
   */
  hitTestAll(cx, cy, t) {
    // Picking never asks the rasteriser for new frames (that would spend the
    // budget on a hover), it only places the items that already have pixels.
    const layers = (this.layers && this.layersAt === t) ? this.layers : this.computeLayers(t, { request: false });
    if (this._worldMode && this.scene3d?.lastVP) {
      const camPos = this.scene3d.lastCam?.pos || [0, (Number(this.project?.meta?.height) || 1080) / 200, 20];
      const ray = this.scene3d.ray(cx, cy);
      // Nearest plane under the cursor, exactly like the depth-tested picture
      // (§四 4): the pixel's own distance decides, never the draw order, so
      // picking agrees with what is on screen even where the sort is wrong for
      // blending. Equal distances mean one plane, whose top `el.z` is what
      // _drawLayers filled last.
      const hits = [];
      for (const L of layers) {
        const poly = this._layerCorners(L);
        if (!poly || !pointInPoly(cx, cy, poly)) continue;
        const d = (ray && layerRayDepth(L, ray)) ?? layerOriginDistance(L, camPos);
        hits.push({ L, d });
      }
      hits.sort((a, b) => (a.d - b.d) || (Number(b.L.z) - Number(a.L.z)));
      return uniqueIds(hits.map((hit) => hit.L));
    }
    // No 3D picture yet: the topmost quad under the cursor (no depth buffer).
    const out = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const poly = this._layerCorners(L);
      if (poly && pointInPoly(cx, cy, poly)) out.push(L);
    }
    return uniqueIds(out);
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

/** Ids of the layers in draw order, first occurrence wins (no duplicate rows). */
function uniqueIds(layers) {
  const out = [];
  const seen = new Set();
  for (const layer of layers) {
    if (!layer?.id || seen.has(layer.id)) continue;
    seen.add(layer.id);
    out.push(layer.id);
  }
  return out;
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
