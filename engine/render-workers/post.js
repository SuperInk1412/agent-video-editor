// Screen effects (§5.4): apply the preview's composite stack to a rendered frame.
//
// Runs inside the sandboxed page (`vdm-src://app/post.js`).
//
// The shader bodies are **not** in this file. `engine/render-workers/pool.js`
// reads `app/renderer/shaders/post.glsl` — the one implementation, shared with
// `app/renderer/js/preview.js` — parses it with `core/screen-fx.js` and hands
// the four sources in with every request (`shaders`). This file only compiles
// them and runs the passes, so the preview and the Blender export cannot drift
// (WP3.5 / decision D2).
//
// Bit depth: Blender writes 16-bit PNGs and this pass keeps them 16-bit. A
// browser cannot decode a 16-bit PNG (`Image` always gives 8 bits), so the
// bytes are decoded by `./png16.js`, uploaded as float samples, composited into
// an RGBA16F target and encoded back to a 16-bit PNG. Without
// `EXT_color_buffer_float` the chain falls back to the 8-bit canvas (the
// preview's own path) and returns an 8-bit PNG; `depth` in the result says
// which happened, and `pool.post` logs it.
//
// Orientation: the preview's scene FBO is bottom-up in memory (its layers draw
// v = 0 at the top of the target), so a PNG — which is top-down — is uploaded
// bottom-up, and `quad.vert` uses the preview's pass orientation (v = 0 at the
// top of the target). Every pass then is the preview's pass, `u_flip` included.
// The 16-bit path reads the bottom-up target back and reverses the rows,
// because a PNG is top-down; the 8-bit fallback draws to a canvas, which
// `toDataURL` turns back into a top-down PNG.
//
// Alpha: preview composites onto an opaque screen (`u_keepAlpha = 0`), a raster
// frame keeps its own alpha (`u_keepAlpha = 1`), so a transparent code layer
// stays transparent.

import { decodePng, encodePng16 } from './png16.js';

const SHADER_KEYS = ['vert', 'bright', 'blur', 'composite'];

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

function makeProgram(gl, vertex, fragment) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
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

/**
 * One render target. `float` picks RGBA16F — the widest linear-filterable
 * float format WebGL2 guarantees, and 11 bits of mantissa is already three
 * more than an 8-bit canvas can carry.
 */
function makeTarget(gl, width, height, float) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA, width, height, 0, gl.RGBA,
    float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
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

const toBase64 = (bytes) => {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

const fromBase64 = (text) => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * A reusable post-processor. One instance owns one WebGL2 context and one
 * full-size + two half-size targets; `post()` may be called once per frame.
 * `shaders` is the parsed `post.glsl` (`core/screen-fx.js::parsePostGlsl`).
 */
export function createPostProcessor({ shaders } = {}) {
  if (!shaders) throw new Error('post：缺少共享着色器（post.glsl）');
  for (const key of SHADER_KEYS) {
    if (typeof shaders[key] !== 'string' || !shaders[key]) throw new Error(`post：共享着色器缺少 ${key}`);
  }
  let canvas = null;
  let gl = null;
  let programs = null;
  let quad = null;
  let full = null;
  let half = null;
  let tmp = null;
  let sourceTexture = null;
  let float = false;
  let depth = 16;

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
    float = !!gl.getExtension('EXT_color_buffer_float');
    depth = float ? 16 : 8;
    programs = {
      bright: makeProgram(gl, shaders.vert, shaders.bright),
      blur: makeProgram(gl, shaders.vert, shaders.blur),
      comp: makeProgram(gl, shaders.vert, shaders.composite),
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
      full = makeTarget(gl, width, height, float);
      const halfWidth = Math.max(1, Math.floor(width / 2));
      const halfHeight = Math.max(1, Math.floor(height / 2));
      half = makeTarget(gl, halfWidth, halfHeight, float);
      tmp = makeTarget(gl, halfWidth, halfHeight, float);
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

  /** Upload straight RGBA samples: float for the 16-bit path, bytes otherwise. */
  const upload = (image) => {
    if (!sourceTexture) sourceTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    const pixels = image.width * image.height * 4;
    // bottom-up, like the preview's scene FBO: row 0 of the texture is the last
    // row of the PNG
    const row = image.width * 4;
    if (float) {
      const samples = new Float32Array(pixels);
      for (let y = 0; y < image.height; y++) {
        const source = y * row;
        const target = (image.height - 1 - y) * row;
        for (let i = 0; i < row; i++) samples[target + i] = image.data[source + i] / 65535;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, image.width, image.height, 0, gl.RGBA, gl.FLOAT, samples);
    } else {
      const samples = new Uint8Array(pixels);
      for (let y = 0; y < image.height; y++) {
        const source = y * row;
        const target = (image.height - 1 - y) * row;
        for (let i = 0; i < row; i++) samples[target + i] = image.data[source + i] >> 8;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, samples);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  const bloomChain = (fx) => {
    if (!((Number(fx.bloom) || 0) > 0.001)) return;
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
  };

  const composite = (fx, time) => {
    bindQuad(programs.comp);
    bindTexture(0, sourceTexture, programs.comp.uniforms.u_scene);
    bindTexture(1, half.texture, programs.comp.uniforms.u_bloom);
    gl.uniform1f(programs.comp.uniforms.u_bloomAmount, Number(fx.bloom) || 0);
    gl.uniform1f(programs.comp.uniforms.u_ca, Number(fx.ca) || 0);
    gl.uniform1f(programs.comp.uniforms.u_grain, Number(fx.grain) || 0);
    gl.uniform1f(programs.comp.uniforms.u_scan, Number(fx.scanline) || 0);
    gl.uniform1f(programs.comp.uniforms.u_vignette, Number(fx.vignette) || 0);
    gl.uniform1f(programs.comp.uniforms.u_grade, Number(fx.grade) || 0);
    gl.uniform1f(programs.comp.uniforms.u_contrast, Number(fx.contrast) || 0);
    gl.uniform1f(programs.comp.uniforms.u_saturation, Number.isFinite(Number(fx.saturation)) ? Number(fx.saturation) : 1);
    gl.uniform1f(programs.comp.uniforms.u_time, time);
    gl.uniform1f(programs.comp.uniforms.u_flip, 1.0);
    gl.uniform1f(programs.comp.uniforms.u_keepAlpha, 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  return {
    /**
     * Composite one PNG (data URL or bare base64) and return
     * `{ png: base64, depth, ms }` — a 16-bit PNG when the GL context can
     * render into a float target, an 8-bit one otherwise.
     */
    async post(png, screenFx = {}, { time = 0 } = {}) {
      const started = performance.now();
      ensureContext();
      const fx = screenFx || {};
      const text = typeof png === 'string' && png.startsWith('data:') ? png.slice(png.indexOf(',') + 1) : String(png || '');
      if (!text) throw new Error('post：没有输入帧');
      const image = await decodePng(fromBase64(text));
      ensureSize(image.width, image.height);

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      upload(image);
      bloomChain(fx);

      // composite: into the float target when there is one, else the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, float ? full.framebuffer : null);
      gl.viewport(0, 0, image.width, image.height);
      composite(fx, time);

      let bytes;
      if (float) {
        const pixels = image.width * image.height * 4;
        const samples = new Float32Array(pixels);
        gl.readPixels(0, 0, image.width, image.height, gl.RGBA, gl.FLOAT, samples);
        const out = new Uint16Array(pixels);
        // The target is bottom-up (GL); a PNG is top-down.
        for (let y = 0; y < image.height; y++) {
          const source = (image.height - 1 - y) * image.width * 4;
          const target = y * image.width * 4;
          for (let i = 0; i < image.width * 4; i++) {
            const value = samples[source + i];
            out[target + i] = value <= 0 ? 0 : value >= 1 ? 65535 : Math.round(value * 65535);
          }
        }
        bytes = await encodePng16({ width: image.width, height: image.height, data: out });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        const dataUrl = canvas.toDataURL('image/png');
        bytes = fromBase64(dataUrl.slice(dataUrl.indexOf(',') + 1));
      }
      return {
        png: toBase64(bytes),
        depth,
        ms: Math.round((performance.now() - started) * 100) / 100,
      };
    },
    dispose() {
      try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
      gl = null;
      canvas = null;
    },
  };
}
