// Screen effects — the one implementation (WP3.5, docs/DESIGN-BACKEND-V2.md §5.4).
//
// This file is the single source of truth for bloom / chromatic aberration /
// grain / vignette / scanline / grade / contrast / saturation. Two consumers
// build their programs from it and from nowhere else:
//
//   app/renderer/js/preview.js      fetches /app/renderer/shaders/post.glsl and
//                                   compiles bright/blur/composite into its own
//                                   WebGL2 context (the realtime viewport);
//   engine/render-workers/pool.js   reads the same file with fs and hands the
//                                   parsed sources to the sandbox page
//                                   (engine/render-workers/post.js), which
//                                   applies them to a rendered frame for the
//                                   Blender export (the film).
//
// Neither side may carry a shader body of its own: a change here changes both
// pictures in the same commit, which is the point of WP3.5 (D2).
//
// Sections are delimited by `// ==== <name> ====`. `core/screen-fx.js` parses
// them; `tests/post-shaders.test.mjs` pins the set.
//
// The two paths differ only in how a pass is fed, never in what it computes:
// the preview draws the composite into its canvas (RGBA8, opaque), the export
// draws it into an RGBA16F target and writes a 16-bit PNG. `u_keepAlpha` is
// the one switch: 0 keeps the preview's opaque screen (its canvas has no
// alpha channel anyway), 1 carries the frame's own alpha through, so a raster
// layer stays transparent.
//
// `u_flip` is 1.0 in both paths: the scene texture is uploaded bottom-up (a
// scene FBO is bottom-up; a PNG is flipped on upload), so every pass samples it
// with the same y flip the preview has always used. `quad.vert` draws the same
// screen orientation the preview's post passes get from `VERT` + `u_mat` (v = 0
// at the top of the target), which is what makes `u_flip` mean the same thing
// on both sides — a plain NDC quad would mirror the bloom against the scene.

// ==== quad.vert ====
#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // v = 0 at the top of the target, exactly like preview's post passes.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}

// ==== bright.frag ====
#version 300 es
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
}

// ==== blur.frag ====
#version 300 es
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
}

// ==== composite.frag ====
#version 300 es
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
uniform float u_keepAlpha;

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

  // 0: the preview's opaque screen (alpha = 1, exactly as before WP3.5).
  // 1: a raster frame keeps its own alpha, so a transparent layer stays so.
  float alpha = mix(1.0, texture(u_scene, uv).a, u_keepAlpha);
  outColor = vec4(clamp(col, 0.0, 1.0), alpha);
}
