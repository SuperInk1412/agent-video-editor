// Screen effects (§5.4): apply the preview's composite stack to a raster frame.
//
// Runs inside the sandboxed page (`vdm-src://app/post.js`).
//
// The shader bodies below are the ones currently living in
// `app/renderer/js/preview.js` (FRAG_BRIGHT / FRAG_BLUR / FRAG_COMPOSITE), copied
// verbatim so the two paths cannot drift while WP3.5 has not extracted them into
// `app/renderer/shaders/post.glsl` yet. **WP3.5 deletes this duplication** and
// imports the shared source from both sides — this file is the temporary home
// (§5.4, WP3.5). The only intentional difference is the alpha channel: preview
// composites onto an opaque screen (`alpha = 1`), `pool.post` keeps the input
// alpha so a rasterised code layer stays transparent.
//
// Orientation: the input PNG is a normal top-down image; it is uploaded with
// UNPACK_FLIP_Y = true so the texture is bottom-up like preview's scene FBO, and
// every pass then uses preview's exact `u_flip` convention.

const QUAD_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
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

  // preview draws to the screen (opaque); a raster layer must stay transparent.
  float alpha = texture(u_scene, uv).a;
  outColor = vec4(clamp(col, 0.0, 1.0), alpha);
}`;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Normalise `screenFx` the same way preview does (`_postAndComposite`). */
export function normalizeScreenFx(fx = {}) {
  return {
    bloom: Math.min(3, Math.max(0, num(fx.bloom))),
    ca: num(fx.ca),
    grain: num(fx.grain),
    scanline: num(fx.scanline),
    vignette: num(fx.vignette),
    grade: num(fx.grade),
    contrast: num(fx.contrast),
    saturation: fx.saturation === undefined || fx.saturation === null || fx.saturation === '' ? 1 : num(fx.saturation, 1),
  };
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图像加载失败（${src.slice(0, 64)}…）`));
    image.src = src;
  });

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`post 着色器编译失败：${log}`);
  }
  return shader;
}

function makeProgram(gl, fragment) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, QUAD_VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`post 着色器链接失败：${gl.getProgramInfoLog(program)}`);
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms, attrib: gl.getAttribLocation(program, 'a_pos') };
}

function makeTarget(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`post 帧缓冲不完整：0x${status.toString(16)}`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer, width, height };
}

/**
 * A reusable post-processor. One instance owns one WebGL2 context and one
 * full-size + two half-size targets; `post()` may be called once per frame.
 */
export function createPostProcessor() {
  let canvas = null;
  let gl = null;
  let programs = null;
  let quad = null;
  let full = null;
  let half = null;
  let tmp = null;
  let sourceTexture = null;

  const ensureContext = () => {
    if (gl) return gl;
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('post：没有 WebGL2 上下文');
    programs = {
      bright: makeProgram(gl, FRAG_BRIGHT),
      blur: makeProgram(gl, FRAG_BLUR),
      comp: makeProgram(gl, FRAG_COMPOSITE),
    };
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    return gl;
  };

  const ensureSize = (width, height) => {
    if (!full || full.width !== width || full.height !== height) {
      for (const target of [full, half, tmp]) {
        if (!target) continue;
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
      full = makeTarget(gl, width, height);
      const halfWidth = Math.max(1, Math.floor(width / 2));
      const halfHeight = Math.max(1, Math.floor(height / 2));
      half = makeTarget(gl, halfWidth, halfHeight);
      tmp = makeTarget(gl, halfWidth, halfHeight);
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  const bindQuad = (program) => {
    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(program.attrib);
    gl.vertexAttribPointer(program.attrib, 2, gl.FLOAT, false, 0, 0);
  };

  const bindTexture = (unit, texture, location) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  };

  return {
    /** Composite one PNG data URL and return the resulting PNG data URL. */
    async post(pngDataUrl, screenFx = {}, { time = 0 } = {}) {
      ensureContext();
      const fx = normalizeScreenFx(screenFx);
      const image = await loadImage(pngDataUrl);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) throw new Error('post：输入帧尺寸为 0');
      ensureSize(width, height);

      if (!sourceTexture) sourceTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // bottom-up, like preview's scene FBO
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);

      if (fx.bloom > 0.001) {
        // bright pass: full -> half
        gl.bindFramebuffer(gl.FRAMEBUFFER, half.framebuffer);
        gl.viewport(0, 0, half.width, half.height);
        bindQuad(programs.bright);
        bindTexture(0, sourceTexture, programs.bright.uniforms.u_tex);
        gl.uniform1f(programs.bright.uniforms.u_threshold, 0.55);
        gl.uniform1f(programs.bright.uniforms.u_flip, 1.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // blur h: half -> tmp
        gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.framebuffer);
        gl.viewport(0, 0, tmp.width, tmp.height);
        bindQuad(programs.blur);
        bindTexture(0, half.texture, programs.blur.uniforms.u_tex);
        gl.uniform2f(programs.blur.uniforms.u_dir, 1.6 / tmp.width, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // blur v: tmp -> half
        gl.bindFramebuffer(gl.FRAMEBUFFER, half.framebuffer);
        gl.viewport(0, 0, half.width, half.height);
        bindQuad(programs.blur);
        bindTexture(0, tmp.texture, programs.blur.uniforms.u_tex);
        gl.uniform2f(programs.blur.uniforms.u_dir, 0, 1.6 / half.height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // composite to the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      bindQuad(programs.comp);
      bindTexture(0, sourceTexture, programs.comp.uniforms.u_scene);
      bindTexture(1, half.texture, programs.comp.uniforms.u_bloom);
      gl.uniform1f(programs.comp.uniforms.u_bloomAmount, fx.bloom);
      gl.uniform1f(programs.comp.uniforms.u_ca, fx.ca);
      gl.uniform1f(programs.comp.uniforms.u_grain, fx.grain);
      gl.uniform1f(programs.comp.uniforms.u_scan, fx.scanline);
      gl.uniform1f(programs.comp.uniforms.u_vignette, fx.vignette);
      gl.uniform1f(programs.comp.uniforms.u_grade, fx.grade);
      gl.uniform1f(programs.comp.uniforms.u_contrast, fx.contrast);
      gl.uniform1f(programs.comp.uniforms.u_saturation, fx.saturation);
      gl.uniform1f(programs.comp.uniforms.u_time, time);
      gl.uniform1f(programs.comp.uniforms.u_flip, 1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      return canvas.toDataURL('image/png');
    },
    dispose() {
      try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
      gl = null;
      canvas = null;
    },
  };
}

/** The shader sources, exported for the tests (drift guard against preview.js). */
export const SHADERS = Object.freeze({ QUAD_VERT, FRAG_BRIGHT, FRAG_BLUR, FRAG_COMPOSITE });
