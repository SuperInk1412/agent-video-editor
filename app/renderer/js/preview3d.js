// 3D viewport for camera shots: instanced boxes from the SAME city json Blender uses.
// Draws into the preview's scene FBO so the existing post chain (bloom/grain/…) applies.
import { evalCamera } from '/core/camera.js';

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

  _drawScene(vp, camPos, city) {
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

  _drawFisheye(cam, city, W, H) {
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
      this._drawScene(faces[i], cam.pos, city);
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
    const cam = overrideCam || evalCamera(project, time);
    this.lastCam = cam;
    this.lastW = W;
    this.lastH = H;
    this.lastVP = null;
    if (cam.fov >= 180) {
      this._drawFisheye(cam, city, W, H);
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
    this._drawScene(vp, cam.pos, city);
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
}
