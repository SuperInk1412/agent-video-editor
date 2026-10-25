// 3D viewport for camera shots: instanced boxes from the SAME city json Blender uses.
// Draws into the preview's scene FBO so the existing post chain (bloom/grain/…) applies.
import { evalCamera } from '/core/camera.js';

const VERT = `#version 300 es
in vec3 a_corner;
in vec3 a_pos;
in vec3 a_size;
in vec3 a_tint;
in vec4 a_extra;      // x=seed, y=emissive, z=kind, w=unused
uniform mat4 u_viewProj;
out vec3 v_world;
out vec3 v_tint;
out float v_seed;
out float v_emissive;
void main(){
  vec3 c = a_corner * a_size + a_pos + vec3(0.0, a_size.y * 0.5, 0.0);
  v_world = c;
  v_tint = a_tint;
  v_seed = a_extra.x;
  v_emissive = a_extra.y;
  gl_Position = u_viewProj * vec4(c, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_tint;
in float v_seed;
in float v_emissive;
out vec4 fragColor;
uniform vec3 u_cam;
uniform vec3 u_fogColor;
uniform float u_fogDensity;
uniform vec3 u_windowColor;
uniform float u_windowGlow;
uniform float u_ambient;

float hash(vec3 p){
  vec3 q = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  q *= 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
void main(){
  float dist = length(v_world - u_cam);
  vec3 col;
  if (v_emissive > 0.5) {
    col = v_tint * 2.2;
  } else {
    vec3 cell = v_world / vec3(2.6, 3.4, 2.6);
    vec3 f = abs(fract(cell) - 0.5);
    float pane = step(0.22, f.x) * step(0.22, f.y) * step(0.22, f.z);
    float n = hash(floor(cell) + v_seed);
    float lit = step(0.72, n);
    vec3 win = u_windowColor * (pane * lit * u_windowGlow);
    float shade = 0.55 + 0.45 * clamp(v_world.y / 160.0, 0.0, 1.0);
    col = v_tint * u_ambient * shade + win;
  }
  float fog = 1.0 - exp(-u_fogDensity * dist);
  col = mix(col, u_fogColor, clamp(fog, 0.0, 0.96));
  fragColor = vec4(col, 1.0);
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
  for (const [, quad] of faces) {
    const [a, b, c, d] = quad;
    v.push(...a, ...b, ...c, ...a, ...c, ...d);
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
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    this.instBuf = gl.createBuffer();
    gl.bindVertexArray(null);
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

  draw(project, time, W, H) {
    const gl = this.gl;
    const city = this.city;
    if (!city) return;
    const cam = evalCamera(project, time);
    const aspect = W / H;
    // camera.fov is HORIZONTAL (same as Blender's sensor_fit=HORIZONTAL)
    const vfov = 2 * Math.atan(Math.tan((cam.fov * Math.PI / 180) / 2) / aspect) * 180 / Math.PI;
    const proj = perspective(vfov, aspect, 0.5, 6000);
    const view = lookAt(cam.pos, cam.look, [0, 1, 0], (cam.roll || 0) * Math.PI / 180);
    const vp = mul4(proj, view);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    const sky = city.sky || [0.01, 0.02, 0.04];
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.u_viewProj, false, vp);
    gl.uniform3f(this.u.u_cam, cam.pos[0], cam.pos[1], cam.pos[2]);
    gl.uniform3f(this.u.u_fogColor, city.fog.color[0], city.fog.color[1], city.fog.color[2]);
    gl.uniform1f(this.u.u_fogDensity, city.fog.density);
    gl.uniform3f(this.u.u_windowColor, city.window.color[0], city.window.color[1], city.window.color[2]);
    gl.uniform1f(this.u.u_windowGlow, city.window.glow);
    gl.uniform1f(this.u.u_ambient, Math.max(0.25, city.ambient));

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.count);
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
  }
}
