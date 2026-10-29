// 3D viewport for camera shots: instanced boxes from the SAME city json Blender uses.
// Draws into the preview's scene FBO so the existing post chain (bloom/grain/…) applies.
import { evalCameraWorldWithLinks, linksEvalOptions, objectWorldPoseWithLinks } from '/core/link-eval.js';
import { poseMatrix } from '/core/scene.js';
import { isText, mediaSpec, textSpec, fitPlane, mediaUrl, isFontFile, videoTime, MEDIA_TYPES } from '/core/objects-media.js';

const VERT = `#version 300 es
in vec3 a_corner;
in vec3 a_normal;
in vec3 a_pos;
in vec3 a_size;
in vec3 a_tint;
in vec4 a_extra;      // x=seed, y=emissive, z=kind, w=unused
uniform mat4 u_viewProj;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_tint;
out float v_seed;
out float v_emissive;
void main(){
  vec3 c = a_corner * a_size + a_pos + vec3(0.0, a_size.y * 0.5, 0.0);
  v_world = c;
  v_normal = a_normal;
  v_tint = a_tint;
  v_seed = a_extra.x;
  v_emissive = a_extra.y;
  gl_Position = u_viewProj * vec4(c, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
in vec3 v_tint;
in float v_seed;
in float v_emissive;
out vec4 fragColor;
uniform vec3 u_cam;
uniform vec3 u_sunDir;
uniform vec3 u_fogColor;
uniform float u_fogStart;
uniform float u_fogDepth;
uniform float u_fogStrength;
uniform vec3 u_windowColor;
uniform float u_windowGlow;
uniform float u_ambient;

float hash(vec3 p){
  vec3 q = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  q *= 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
// Blender renders with view_transform='Standard': scene colours are linear and
// get sRGB-encoded on output. Do the same here or the viewport reads ~4x darker
// than the render (a hex tint is a *display* colour, not a linear one).
vec3 srgb(vec3 c){
  c = max(c, vec3(0.0));
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, step(c, vec3(0.0031308)));
}
void main(){
  float dist = length(v_world - u_cam);
  vec3 lin;
  if (v_emissive > 0.5) {
    lin = v_tint * 2.2;
  } else {
    vec3 cell = v_world / vec3(2.6, 3.4, 2.6);
    vec3 f = abs(fract(cell) - 0.5);
    float pane = step(0.22, f.x) * step(0.22, f.y) * step(0.22, f.z);
    float n = hash(floor(cell) + v_seed);
    float lit = step(0.72, n);
    vec3 win = u_windowColor * (pane * lit * u_windowGlow);
    // same rig as blender/vdm_city.py: world ambient + a weak cool moon
    float amb = max(0.2, u_ambient) * 1.2;
    float ndl = max(dot(normalize(v_normal), normalize(u_sunDir)), 0.0);
    lin = v_tint * (amb + 0.14 * ndl) + win;
  }
  // Blender fogs with the Mist pass (start..depth, linear), not exp(-d); match it
  // or the preview reads much hazier than the render.
  float fog = clamp((dist - u_fogStart) / max(1.0, u_fogDepth), 0.0, 1.0) * u_fogStrength;
  lin = mix(lin, u_fogColor, clamp(fog, 0.0, 0.96));
  fragColor = vec4(srgb(lin), 1.0);
}`;

// Scene objects (timeline elements promoted to metres): one draw per object so
// rotation/scale/opacity stay exact. Same fog/light rig as the city.
const OBJ_VERT = `#version 300 es
in vec3 a_corner;
in vec3 a_normal;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform mat3 u_normalMat;
out vec3 v_world;
out vec3 v_normal;
void main(){
  vec4 w = u_model * vec4(a_corner, 1.0);
  v_world = w.xyz;
  v_normal = normalize(u_normalMat * a_normal);
  gl_Position = u_viewProj * w;
}`;

const OBJ_FRAG = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
out vec4 fragColor;
uniform vec3 u_cam;
uniform vec3 u_color;
uniform float u_emissive;
uniform float u_alpha;
uniform vec3 u_sunDir;
uniform vec3 u_fogColor;
uniform float u_fogStart;
uniform float u_fogDepth;
uniform float u_fogStrength;
uniform float u_ambient;
vec3 srgb(vec3 c){
  c = max(c, vec3(0.0));
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, step(c, vec3(0.0031308)));
}
void main(){
  float amb = max(0.2, u_ambient) * 1.2;
  float ndl = max(dot(normalize(v_normal), normalize(u_sunDir)), 0.0);
  vec3 lin = u_color * (amb + 0.5 * ndl + u_emissive * 1.9);
  float dist = length(v_world - u_cam);
  float fog = clamp((dist - u_fogStart) / max(1.0, u_fogDepth), 0.0, 1.0) * u_fogStrength;
  lin = mix(lin, u_fogColor, clamp(fog, 0.0, 0.96));
  fragColor = vec4(srgb(lin), u_alpha);
}`;

// Image / video / text planes: unit quad, picture sampled as sRGB (-> linear),
// self-lit like Blender's emission material, same Mist-style fog.
const PLANE_VERT = `#version 300 es
in vec3 a_corner;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform vec4 u_uv;      // u0 v0 u1 v1
uniform vec2 u_shift;   // quad offset in quad units (text alignment)
out vec3 v_world;
out vec2 v_uv;
void main(){
  vec2 q = a_corner.xy + u_shift;
  vec4 w = u_model * vec4(q, 0.0, 1.0);
  v_world = w.xyz;
  v_uv = mix(u_uv.xy, u_uv.zw, a_corner.xy + 0.5);
  gl_Position = u_viewProj * w;
}`;

const PLANE_FRAG = `#version 300 es
precision highp float;
in vec3 v_world;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec3 u_cam;
uniform float u_emissive;
uniform float u_alpha;
uniform vec3 u_fogColor;
uniform float u_fogStart;
uniform float u_fogDepth;
uniform float u_fogStrength;
vec3 srgb(vec3 c){
  c = max(c, vec3(0.0));
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, step(c, vec3(0.0031308)));
}
void main(){
  vec4 t = texture(u_tex, v_uv);
  vec3 lin = t.rgb * u_emissive;
  float dist = length(v_world - u_cam);
  float fog = clamp((dist - u_fogStart) / max(1.0, u_fogDepth), 0.0, 1.0) * u_fogStrength;
  lin = mix(lin, u_fogColor, clamp(fog, 0.0, 0.96));
  float a = t.a * u_alpha;
  if (a < 0.003) discard;
  fragColor = vec4(srgb(lin), a);
}`;

// Fisheye composite: sample a world-space cubemap with equidistant rays, so a
// horizontal fov of 180..360 keeps working like Blender's FISHEYE_EQUIDISTANT.
const FISH_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FISH_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform samplerCube u_cube;
uniform vec3 u_fwd;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_fov;      // horizontal field of view, radians
uniform float u_aspect;
void main(){
  vec2 p = (v_uv - 0.5) * 2.0;
  p.x *= u_aspect;
  float r = length(p);
  float theta = (r / u_aspect) * (u_fov * 0.5);
  if (theta > 3.141592653589793) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float phi = atan(p.y, p.x);
  vec3 dir = u_fwd * cos(theta) + (u_right * cos(phi) + u_up * sin(phi)) * sin(theta);
  fragColor = vec4(texture(u_cube, dir).rgb, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Same transfer function as the shader, for values we bake on the CPU (sky).
const srgbEnc = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function hexRgb(c) {
  const s = String(c || '#000').replace('#', '');
  const h = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

const DRAWABLE = new Set(['solid', 'shape', 'text', 'image', 'video', 'container']);
const TEXT_PX = 128; // raster size of one em for text planes
// Empties are editor-only: a three-bar cross locator (never baked for Blender).
const LOCATOR_ARM = 1.2;
const LOCATOR_BAR = 0.06;
const LOCATOR_COLOR = [1, 0.78, 0.2];

/** Unit-cube sizes for the three bars of an empty's locator. */
function locatorBars(pose) {
  const s = (Math.abs(pose.scale[0]) + Math.abs(pose.scale[1]) + Math.abs(pose.scale[2])) / 3 || 1;
  return [0, 1, 2].map((a) => {
    const size = [LOCATOR_BAR, LOCATOR_BAR, LOCATOR_BAR];
    size[a] = LOCATOR_ARM * s;
    return size;
  });
}

/** Timeline elements promoted to 3D. Empty until the project gets a v3 scene. */
export function sceneObjects(project) {
  const s = project?.scene;
  return Array.isArray(s?.objects) ? s.objects : [];
}

/** Object time range: elements only exist between start and start+duration. */
export function objectVisibleAt(obj, t) {
  if (!obj || obj.visible === false) return false;
  const start = Number(obj.start) || 0;
  const dur = Number(obj.duration) || 0;
  return t >= start - 1e-6 && t < start + dur - 1e-6;
}

/** World scale of the unit cube for an object at time t. */
export function objectSize(obj, pose) {
  const g = obj?.geom && typeof obj.geom === 'object' ? obj.geom : {};
  return [
    Math.max(0.001, Number(g.w) || 2) * Math.abs(pose.scale[0] ?? 1),
    Math.max(0.001, Number(g.h) || 2) * Math.abs(pose.scale[1] ?? 1),
    Math.max(0.001, Number(g.d) || 2) * Math.abs(pose.scale[2] ?? 1),
  ];
}

function lookAt(eye, target, up, rollRad) {
  const f = norm(sub(target, eye));
  let s = norm(cross(f, up));
  let u = cross(s, f);
  if (rollRad) {
    const c = Math.cos(rollRad), si = Math.sin(rollRad);
    const s2 = [s[0] * c + u[0] * si, s[1] * c + u[1] * si, s[2] * c + u[2] * si];
    const u2 = [u[0] * c - s[0] * si, u[1] * c - s[1] * si, u[2] * c - s[2] * si];
    s = s2; u = u2;
  }
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
}

function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

const UNIT_CUBE = (() => {
  const v = [];
  const faces = [
    [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
    [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
    [[1, 0, 0], [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]],
    [[-1, 0, 0], [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]]],
    [[0, 1, 0], [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]]],
    [[0, -1, 0], [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]],
  ];
  for (const [nrm, quad] of faces) {
    const [a, b, c, d] = quad;
    for (const p of [a, b, c, a, c, d]) v.push(...p, ...nrm);
  }
  return new Float32Array(v);
})();

/**
 * Unit cylinder for `primitive: "cylinder"` solids: radius 0.5 (so `geom.w` /
 * `geom.d` are the diameter in x / z), height 1 (`geom.h`), smooth side normals
 * and flat caps. Same interleaved layout as UNIT_CUBE (position + normal, 24
 * bytes) so the object program and its lighting are shared.
 */
const UNIT_CYLINDER = (() => {
  const seg = 48;
  const v = [];
  const push = (p, n) => v.push(p[0], p[1], p[2], n[0], n[1], n[2]);
  const r = 0.5, hy = 0.5;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const n0 = [Math.cos(a0), 0, Math.sin(a0)];
    const n1 = [Math.cos(a1), 0, Math.sin(a1)];
    const b0 = [n0[0] * r, -hy, n0[2] * r];
    const b1 = [n1[0] * r, -hy, n1[2] * r];
    const t0 = [n0[0] * r, hy, n0[2] * r];
    const t1 = [n1[0] * r, hy, n1[2] * r];
    push(b0, n0); push(b1, n1); push(t1, n1);
    push(b0, n0); push(t1, n1); push(t0, n0);
    push([0, hy, 0], [0, 1, 0]); push(t0, [0, 1, 0]); push(t1, [0, 1, 0]);
    push([0, -hy, 0], [0, -1, 0]); push(b1, [0, -1, 0]); push(b0, [0, -1, 0]);
  }
  return { data: new Float32Array(v), count: v.length / 6 };
})();

export class Scene3D {
  constructor(gl) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'a_corner');
    gl.bindAttribLocation(p, 1, 'a_pos');
    gl.bindAttribLocation(p, 2, 'a_size');
    gl.bindAttribLocation(p, 3, 'a_tint');
    gl.bindAttribLocation(p, 4, 'a_extra');
    gl.bindAttribLocation(p, 5, 'a_normal');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      this.u[info.name] = gl.getUniformLocation(p, info.name);
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_CUBE, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 3, gl.FLOAT, false, 24, 12);
    this.instBuf = gl.createBuffer();
    gl.bindVertexArray(null);

    // fisheye program + fullscreen quad
    this.fishProg = gl.createProgram();
    gl.attachShader(this.fishProg, compile(gl, gl.VERTEX_SHADER, FISH_VERT));
    gl.attachShader(this.fishProg, compile(gl, gl.FRAGMENT_SHADER, FISH_FRAG));
    gl.bindAttribLocation(this.fishProg, 0, 'a_pos');
    gl.linkProgram(this.fishProg);
    if (!gl.getProgramParameter(this.fishProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.fishProg));
    this.fishU = {};
    const fn = gl.getProgramParameter(this.fishProg, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < fn; i++) {
      const info = gl.getActiveUniform(this.fishProg, i);
      this.fishU[info.name] = gl.getUniformLocation(this.fishProg, info.name);
    }
    this.fishVao = gl.createVertexArray();
    gl.bindVertexArray(this.fishVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);

    // ---- scene-object program (timeline elements in metres) ----
    this.objProg = gl.createProgram();
    gl.attachShader(this.objProg, compile(gl, gl.VERTEX_SHADER, OBJ_VERT));
    gl.attachShader(this.objProg, compile(gl, gl.FRAGMENT_SHADER, OBJ_FRAG));
    gl.bindAttribLocation(this.objProg, 0, 'a_corner');
    gl.bindAttribLocation(this.objProg, 1, 'a_normal');
    gl.linkProgram(this.objProg);
    if (!gl.getProgramParameter(this.objProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.objProg));
    this.objU = {};
    const on = gl.getProgramParameter(this.objProg, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < on; i++) {
      const info = gl.getActiveUniform(this.objProg, i);
      this.objU[info.name] = gl.getUniformLocation(this.objProg, info.name);
    }
    this.objVao = gl.createVertexArray();
    gl.bindVertexArray(this.objVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    // Same layout, cylinder vertices: `primitive: "cylinder"` solids draw this.
    this.cylVao = gl.createVertexArray();
    gl.bindVertexArray(this.cylVao);
    const cylBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cylBuf);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_CYLINDER.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);

    // ---- image / video / text planes ----
    this.planeProg = gl.createProgram();
    gl.attachShader(this.planeProg, compile(gl, gl.VERTEX_SHADER, PLANE_VERT));
    gl.attachShader(this.planeProg, compile(gl, gl.FRAGMENT_SHADER, PLANE_FRAG));
    gl.bindAttribLocation(this.planeProg, 0, 'a_corner');
    gl.linkProgram(this.planeProg);
    if (!gl.getProgramParameter(this.planeProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.planeProg));
    this.planeU = {};
    const pn = gl.getProgramParameter(this.planeProg, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < pn; i++) {
      const info = gl.getActiveUniform(this.planeProg, i);
      this.planeU[info.name] = gl.getUniformLocation(this.planeProg, info.name);
    }
    this.planeVao = gl.createVertexArray();
    gl.bindVertexArray(this.planeVao);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    this.media = new Map(); // object id -> {key, kind, tex, w, h, ready, video?, canvas?}
    this.fonts = new Map(); // font file -> css family ('' while loading)
    this.lastTime = null;
    this._planeSizes = new Map(); // object id -> last drawn quad size (picking)

    this.cube = null;
    this.count = 0;
    this.city = null;
    this.hash = null;
    this.ground = null;
  }

  /** instance layout: pos(3) size(3) tint(3) extra(4) = 13 floats */
  setCity(city) {
    if (!city || city.hash === this.hash) return;
    this.city = city;
    this.hash = city.hash;
    const data = [];
    for (const b of city.buildings) {
      data.push(b.x, 0, b.z, b.w, b.h, b.d, b.tint[0], b.tint[1], b.tint[2], b.seed, 0, 0, 0);
    }
    for (const n of city.neons) {
      data.push(n.x, n.y - n.h / 2, n.z, n.w, n.h, n.d, n.color[0], n.color[1], n.color[2], n.seed, 1, 0, 0);
    }
    this.count = city.buildings.length + city.neons.length;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.bindVertexArray(this.vao);
    const stride = 13 * 4;
    const attrs = [[1, 3, 0], [2, 3, 3], [3, 3, 6], [4, 4, 9]];
    for (const [loc, size, off] of attrs) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  _ensureCube(size) {
    const gl = this.gl;
    if (!this.cube) {
      this.cube = { tex: gl.createTexture(), fbo: gl.createFramebuffer(), depth: gl.createRenderbuffer(), size: 0 };
    }
    const c = this.cube;
    if (c.size === size) return c;
    c.size = size;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, c.tex);
    for (let i = 0; i < 6; i++) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, c.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, c.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return c;
  }

  _drawScene(vp, camPos, city, project, time) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.u_viewProj, false, vp);
    gl.uniform3f(this.u.u_cam, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(this.u.u_fogColor, city.fog.color[0], city.fog.color[1], city.fog.color[2]);
    gl.uniform1f(this.u.u_fogStart, Number(city.fog.start) || 30);
    gl.uniform1f(this.u.u_fogDepth, Number(city.fog.depth) || 700);
    gl.uniform1f(this.u.u_fogStrength, city.fog.strength == null ? 1 : Number(city.fog.strength));
    gl.uniform3f(this.u.u_windowColor, city.window.color[0], city.window.color[1], city.window.color[2]);
    gl.uniform1f(this.u.u_windowGlow, city.window.glow);
    gl.uniform1f(this.u.u_ambient, Math.max(0.25, city.ambient));
    gl.uniform3f(this.u.u_sunDir, -0.3, 0.55, 0.78);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.count);
    gl.bindVertexArray(null);
    this._drawObjects(project, time, camPos, vp, city);
    // 2D elements as world planes (set by preview.js for the current frame)
    if (this.onElements) this.onElements(vp, camPos);
  }

  /** One draw per timeline element; opaque first, then alpha-blended. */
  _drawObjects(project, time, camPos, vp, city) {
    const gl = this.gl;
    const all = sceneObjects(project);
    const evalOpts = linksEvalOptions(project);
    const objs = all.filter((o) => objectVisibleAt(o, time) && (DRAWABLE.has(o.type) || o.type === 'empty'));
    if (!objs.length) return;
    const opaque = [];
    const transparent = [];
    const planes = [];
    const poses = new Map();
    this._syncVideos(all, time);
    const boxItem = (pose, size) => {
      const { right: r, up: u, forward: f } = pose.basis;
      return {
        m: poseMatrix({ ...pose, scale: size }),
        nm: new Float32Array([
          r[0] / size[0], r[1] / size[0], r[2] / size[0],
          u[0] / size[1], u[1] / size[1], u[2] / size[1],
          f[0] / size[2], f[1] / size[2], f[2] / size[2],
        ]),
      };
    };
    for (const obj of objs) {
      const pose = objectWorldPoseWithLinks(project, obj, time, poses, evalOpts);
      if (obj.type === 'empty') {
        for (const size of locatorBars(pose)) {
          opaque.push({ ...boxItem(pose, size), col: LOCATOR_COLOR, alpha: 1, dist: 0, emissive: 1 });
        }
        continue;
      }
      if (pose.opacity <= 0.003) continue;
      if (MEDIA_TYPES.has(obj.type)) {
        const plane = this._planeItem(obj, pose, camPos);
        if (plane) planes.push(plane);
        continue;
      }
      const size = objectSize(obj, pose);
      const { m, nm } = boxItem(pose, size);
      const col = hexRgb(obj.style?.color || obj.style?.fill || '#8fe0ff');
      const alpha = pose.opacity * Math.max(0, Math.min(1, Number(obj.style?.opacity ?? 1)));
      const dist = Math.hypot(pose.worldPos[0] - camPos[0], pose.worldPos[1] - camPos[1], pose.worldPos[2] - camPos[2]);
      const item = {
        m, nm, col, alpha, dist,
        emissive: Math.max(0, Number(obj.style?.emissive) || 0),
        // `primitive: "cylinder"` is a real cylinder (docs/SPEC-OBJECTS.md);
        // everything else solid draws the unit cube, as it always has.
        mesh: obj.primitive === 'cylinder' ? 'cyl' : 'box',
      };
      if (alpha >= 0.999) opaque.push(item);
      else transparent.push(item);
    }
    transparent.sort((a, b) => b.dist - a.dist);

    gl.useProgram(this.objProg);
    gl.uniformMatrix4fv(this.objU.u_viewProj, false, vp);
    gl.uniform3f(this.objU.u_cam, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(this.objU.u_fogColor, city.fog.color[0], city.fog.color[1], city.fog.color[2]);
    gl.uniform1f(this.objU.u_fogStart, Number(city.fog.start) || 30);
    gl.uniform1f(this.objU.u_fogDepth, Number(city.fog.depth) || 700);
    gl.uniform1f(this.objU.u_fogStrength, city.fog.strength == null ? 1 : Number(city.fog.strength));
    gl.uniform1f(this.objU.u_ambient, Math.max(0.25, city.ambient));
    gl.uniform3f(this.objU.u_sunDir, -0.3, 0.55, 0.78);
    gl.bindVertexArray(this.objVao);
    gl.disable(gl.BLEND);
    for (const it of opaque) this._drawObject(it);
    if (transparent.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const it of transparent) this._drawObject(it);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    if (planes.length) this._drawPlanes(planes, camPos, vp, city);
  }

  // ---------------------------------------------------------------- media planes

  /** Quad size, uv and texture for an image/video/text object (null until loaded). */
  _planeItem(obj, pose, camPos) {
    const a = this._mediaAsset(obj);
    if (!a || !a.ready) return null;
    let qw, qh, uv, shift = [0, 0], emissive;
    if (isText(obj)) {
      const s = textSpec(obj);
      qw = (a.w / TEXT_PX) * s.size;
      qh = (a.h / TEXT_PX) * s.size;
      uv = [0, 0, 1, 1];
      // Blender's LEFT/RIGHT alignment anchors the text edge at the origin.
      shift = [s.align === 'left' ? 0.5 : s.align === 'right' ? -0.5 : 0, 0];
      emissive = s.emissive;
    } else {
      const m = mediaSpec(obj);
      ({ w: qw, h: qh, uv } = fitPlane(m.fit, a.w, a.h, m.w, m.h, m.uv));
      emissive = m.emissive;
    }
    const { right: r, up: u, forward: f } = pose.basis;
    const sx = Math.abs(pose.scale[0]) * qw, sy = Math.abs(pose.scale[1]) * qh;
    const p = pose.worldPos;
    // local X = -right so the picture reads unmirrored from the front (see objects-media.js)
    const m = new Float32Array([
      -r[0] * sx, -r[1] * sx, -r[2] * sx, 0,
      u[0] * sy, u[1] * sy, u[2] * sy, 0,
      f[0], f[1], f[2], 0,
      p[0], p[1], p[2], 1,
    ]);
    const alpha = pose.opacity * Math.max(0, Math.min(1, Number(obj.style?.opacity ?? 1)));
    const dist = Math.hypot(p[0] - camPos[0], p[1] - camPos[1], p[2] - camPos[2]);
    this._planeSizes.set(obj.id, [sx, sy]);
    return { m, uv, shift, tex: a.tex, emissive, alpha, dist };
  }

  _drawPlanes(planes, camPos, vp, city) {
    const gl = this.gl;
    const u = this.planeU;
    planes.sort((a, b) => b.dist - a.dist);
    gl.useProgram(this.planeProg);
    gl.uniformMatrix4fv(u.u_viewProj, false, vp);
    gl.uniform3f(u.u_cam, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(u.u_fogColor, city.fog.color[0], city.fog.color[1], city.fog.color[2]);
    gl.uniform1f(u.u_fogStart, Number(city.fog.start) || 30);
    gl.uniform1f(u.u_fogDepth, Number(city.fog.depth) || 700);
    gl.uniform1f(u.u_fogStrength, city.fog.strength == null ? 1 : Number(city.fog.strength));
    gl.uniform1i(u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.planeVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const it of planes) {
      gl.bindTexture(gl.TEXTURE_2D, it.tex);
      gl.uniformMatrix4fv(u.u_model, false, it.m);
      gl.uniform4f(u.u_uv, it.uv[0], it.uv[1], it.uv[2], it.uv[3]);
      gl.uniform2f(u.u_shift, it.shift[0], it.shift[1]);
      gl.uniform1f(u.u_emissive, it.emissive);
      gl.uniform1f(u.u_alpha, it.alpha);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  _newTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Upload as sRGB so the shader samples linear colour (like Blender's image colourspace). */
  _upload(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch { /* not ready */ }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _mediaAsset(obj) {
    const key = isText(obj) ? `text:${JSON.stringify(textSpec(obj))}` : `${obj.type}:${obj.src || ''}`;
    let a = this.media.get(obj.id);
    if (a && a.key === key) {
      if (a.kind === 'text' && !a.ready) this._rasterText(obj, a);
      return a;
    }
    if (a?.video) { a.video.pause(); a.video.removeAttribute('src'); a.video.load(); }
    if (a?.tex) this.gl.deleteTexture(a.tex);
    a = { key, kind: isText(obj) ? 'text' : obj.type, tex: null, w: 0, h: 0, ready: false };
    this.media.set(obj.id, a);
    if (a.kind === 'text') {
      this._rasterText(obj, a);
    } else if (a.kind === 'image' && obj.src) {
      const img = new Image();
      img.decoding = 'async';
      img.src = mediaUrl(obj.src);
      img.onload = () => {
        a.tex = this._newTexture();
        this._upload(a.tex, img);
        a.w = img.naturalWidth; a.h = img.naturalHeight; a.ready = true;
      };
    } else if (a.kind === 'video' && obj.src) {
      const v = document.createElement('video');
      v.src = mediaUrl(obj.src);
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.loop = false;
      v.crossOrigin = 'anonymous';
      a.video = v;
      v.addEventListener('loadeddata', () => {
        a.tex = this._newTexture();
        a.w = v.videoWidth; a.h = v.videoHeight; a.ready = true;
      });
    }
    return a;
  }

  /** CSS family for a project font file ('' while it loads). */
  _fontFamily(font) {
    if (!isFontFile(font)) return font;
    if (this.fonts.has(font)) return this.fonts.get(font);
    this.fonts.set(font, '');
    const family = `vdm-font-${this.fonts.size}`;
    const face = new FontFace(family, `url("${mediaUrl(font)}")`);
    face.load().then((f) => {
      document.fonts.add(f);
      this.fonts.set(font, family);
    }).catch(() => this.fonts.set(font, 'sans-serif'));
    return '';
  }

  _rasterText(obj, a) {
    const s = textSpec(obj);
    const family = this._fontFamily(s.font);
    if (!family) return; // wait for the font file
    const px = TEXT_PX;
    const lines = s.text.split('\n');
    const c = a.canvas || (a.canvas = document.createElement('canvas'));
    const ctx = c.getContext('2d');
    const font = `${px}px "${family}", sans-serif`;
    ctx.font = font;
    ctx.letterSpacing = `${s.tracking * px}px`;
    const widths = lines.map((l) => ctx.measureText(l).width);
    const lineH = s.lineHeight * px;
    const w = Math.max(1, Math.min(8192, Math.ceil(Math.max(...widths, 1))));
    const h = Math.max(1, Math.ceil(lineH * lines.length));
    c.width = w; c.height = h;
    ctx.font = font;
    ctx.letterSpacing = `${s.tracking * px}px`;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = s.color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = s.align;
    const x = s.align === 'left' ? 0 : s.align === 'right' ? w : w / 2;
    lines.forEach((l, i) => ctx.fillText(l, x, lineH * (i + 0.5)));
    if (!a.tex) a.tex = this._newTexture();
    this._upload(a.tex, c);
    a.w = w; a.h = h; a.ready = true;
  }

  /** Keep video planes on their source time; play along while the timeline plays. */
  _syncVideos(objs, time) {
    const dt = this.lastTime == null ? 0 : time - this.lastTime;
    this.lastTime = time;
    const playing = dt > 0 && dt < 0.25;
    for (const obj of objs) {
      if (obj.type !== 'video') continue;
      const a = this.media.get(obj.id);
      if (!a?.video || !a.ready) continue;
      const v = a.video;
      const live = objectVisibleAt(obj, time);
      const want = Math.min(videoTime(obj, time), Math.max(0, (v.duration || 1) - 0.05));
      if (live && playing) {
        v.playbackRate = mediaSpec(obj).rate;
        if (v.paused) v.play().catch(() => {});
        if (Math.abs(v.currentTime - want) > 0.35) v.currentTime = want;
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
      }
      if (live) this._upload(a.tex, v);
    }
  }

  _drawObject(it) {
    const gl = this.gl;
    const u = this.objU;
    gl.uniformMatrix4fv(u.u_model, false, it.m);
    gl.uniformMatrix3fv(u.u_normalMat, false, it.nm);
    gl.uniform3f(u.u_color, it.col[0], it.col[1], it.col[2]);
    gl.uniform1f(u.u_emissive, it.emissive);
    gl.uniform1f(u.u_alpha, it.alpha);
    if (it.mesh === 'cyl') {
      gl.bindVertexArray(this.cylVao);
      gl.drawArrays(gl.TRIANGLES, 0, UNIT_CYLINDER.count);
      gl.bindVertexArray(this.objVao);
      return;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }

  _cubeFaces(cam) {
    // World-axis face cameras; sampling a world direction then works directly.
    const faces = [
      { dir: [1, 0, 0], up: [0, -1, 0] },
      { dir: [-1, 0, 0], up: [0, -1, 0] },
      { dir: [0, 1, 0], up: [0, 0, 1] },
      { dir: [0, -1, 0], up: [0, 0, -1] },
      { dir: [0, 0, 1], up: [0, -1, 0] },
      { dir: [0, 0, -1], up: [0, -1, 0] },
    ];
    return faces.map((f) => {
      const target = [cam.pos[0] + f.dir[0], cam.pos[1] + f.dir[1], cam.pos[2] + f.dir[2]];
      return mul4(perspective(90, 1, 0.5, 6000), lookAt(cam.pos, target, f.up, 0));
    });
  }

  _drawFisheye(cam, city, W, H, project, time) {
    const gl = this.gl;
    const max = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) || 1024;
    const size = Math.min(1024, max);
    const cube = this._ensureCube(size);
    const sky = city.sky || [0.01, 0.02, 0.04];
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevViewport = gl.getParameter(gl.VIEWPORT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    const faces = this._cubeFaces(cam);
    for (let i = 0; i < 6; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, cube.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, cube.tex, 0);
      gl.viewport(0, 0, size, size);
      gl.clearColor(srgbEnc(sky[0]), srgbEnc(sky[1]), srgbEnc(sky[2]), 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      this._drawScene(faces[i], cam.pos, city, project, time);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);

    const f = norm(sub(cam.look, cam.pos));
    let right = norm(cross(f, [0, 1, 0]));
    let up = cross(right, f);
    const roll = ((cam.roll || 0) * Math.PI) / 180;
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const r2 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
      const u2 = [up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s];
      right = norm(r2);
      up = norm(u2);
    }

    gl.useProgram(this.fishProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube.tex);
    gl.uniform1i(this.fishU.u_cube, 0);
    gl.uniform3f(this.fishU.u_fwd, f[0], f[1], f[2]);
    gl.uniform3f(this.fishU.u_right, right[0], right[1], right[2]);
    gl.uniform3f(this.fishU.u_up, up[0], up[1], up[2]);
    gl.uniform1f(this.fishU.u_fov, (Math.min(360, Math.max(180, cam.fov)) * Math.PI) / 180);
    gl.uniform1f(this.fishU.u_aspect, W / H);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.fishVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  draw(project, time, W, H, overrideCam = null) {
    const gl = this.gl;
    const city = this.city;
    if (!city) return;
    const cam = overrideCam || evalCameraWorldWithLinks(project, time);
    this.lastCam = cam;
    this.lastW = W;
    this.lastH = H;
    this.lastVP = null;
    if (cam.fov >= 180) {
      this._drawFisheye(cam, city, W, H, project, time);
      return;
    }
    const aspect = W / H;
    // camera.fov is HORIZONTAL (same as Blender's sensor_fit=HORIZONTAL)
    const vfov = 2 * Math.atan(Math.tan((cam.fov * Math.PI / 180) / 2) / aspect) * 180 / Math.PI;
    const proj = perspective(vfov, aspect, 0.5, 6000);
    const view = lookAt(cam.pos, cam.look, [0, 1, 0], (cam.roll || 0) * Math.PI / 180);
    const vp = mul4(proj, view);
    this.lastVP = vp;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    const sky = city.sky || [0.01, 0.02, 0.04];
    gl.clearColor(srgbEnc(sky[0]), srgbEnc(sky[1]), srgbEnc(sky[2]), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._drawScene(vp, cam.pos, city, project, time);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
  }

  /** World -> canvas pixels for the camera of the last draw (null if behind). */
  projectPoint(p) {
    const m = this.lastVP;
    if (!m) return null;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 1e-6) return null;
    return {
      x: (x / w * 0.5 + 0.5) * this.lastW,
      y: (1 - (y / w * 0.5 + 0.5)) * this.lastH,
      w,
    };
  }

  /** Screen pixel -> world ray for the camera of the last draw. */
  ray(sx, sy) {
    const cam = this.lastCam;
    if (!cam || !this.lastVP || !this.lastW) return null;
    const aspect = this.lastW / this.lastH;
    const vfov = 2 * Math.atan(Math.tan((cam.fov * Math.PI / 180) / 2) / aspect);
    const f = norm(sub(cam.look, cam.pos));
    let right = norm(cross(f, [0, 1, 0]));
    let up = cross(right, f);
    const roll = ((cam.roll || 0) * Math.PI) / 180;
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const r2 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
      const u2 = [up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s];
      right = norm(r2);
      up = norm(u2);
    }
    const nx = (sx / this.lastW) * 2 - 1;
    const ny = 1 - (sy / this.lastH) * 2;
    const th = Math.tan(vfov / 2);
    const dir = norm([
      f[0] + right[0] * nx * th * aspect + up[0] * ny * th,
      f[1] + right[1] * nx * th * aspect + up[1] * ny * th,
      f[2] + right[2] * nx * th * aspect + up[2] * ny * th,
    ]);
    return { origin: cam.pos.slice(), dir };
  }

  /** Screen pixel -> point on the plane through `at` facing the active camera. */
  planeHit(sx, sy, at = null, normal = null) {
    const r = this.ray(sx, sy);
    const cam = this.lastCam;
    if (!r || !cam) return null;
    const point = at || cam.look;
    const n = normal || norm(sub(cam.look, cam.pos));
    const denom = dot(r.dir, n);
    if (Math.abs(denom) < 1e-6) return null;
    const t = dot(sub(point, r.origin), n) / denom;
    if (!Number.isFinite(t) || t <= 0) return null;
    return [r.origin[0] + r.dir[0] * t, r.origin[1] + r.dir[1] * t, r.origin[2] + r.dir[2] * t];
  }

  /** Screen pixel -> the closest timeline element (ray vs its oriented box). */
  pickObject(project, time, sx, sy) {
    const r = this.ray(sx, sy);
    if (!r) return null;
    let best = null;
    const all = sceneObjects(project);
    const poses = new Map();
    const evalOpts = linksEvalOptions(project);
    for (const obj of all) {
      const empty = obj.type === 'empty';
      if (!(DRAWABLE.has(obj.type) || empty) || !objectVisibleAt(obj, time)) continue;
      const pose = objectWorldPoseWithLinks(project, obj, time, poses, evalOpts);
      if (!empty && pose.opacity <= 0.003) continue;
      const size = empty ? locatorBars(pose).map((b, i) => b[i])
        : MEDIA_TYPES.has(obj.type) ? [...(this._planeSizes.get(obj.id) || [1, 1]), 0.05]
          : objectSize(obj, pose);
      const { right, up, forward } = pose.basis;
      const rel = sub(r.origin, pose.worldPos);
      const o = [dot(rel, right) / size[0], dot(rel, up) / size[1], dot(rel, forward) / size[2]];
      const d = [dot(r.dir, right) / size[0], dot(r.dir, up) / size[1], dot(r.dir, forward) / size[2]];
      let tmin = -Infinity, tmax = Infinity, miss = false;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-9) {
          if (o[a] < -0.5 || o[a] > 0.5) { miss = true; break; }
          continue;
        }
        let t1 = (-0.5 - o[a]) / d[a];
        let t2 = (0.5 - o[a]) / d[a];
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmax < tmin) { miss = true; break; }
      }
      if (miss || tmax < 0) continue;
      const t = tmin >= 0 ? tmin : 0;
      if (!best || t < best.dist) {
        best = {
          id: obj.id,
          dist: t,
          point: [r.origin[0] + r.dir[0] * t, r.origin[1] + r.dir[1] * t, r.origin[2] + r.dir[2] * t],
        };
      }
    }
    return best;
  }
}
