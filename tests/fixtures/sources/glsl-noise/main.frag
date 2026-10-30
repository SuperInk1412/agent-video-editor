// 共享夹具 · glsl-noise（docs/DESIGN-BACKEND-V2.md §10.4.6，WP4.0）
//
// 契约（§5.2 / §6.2）：只写片元着色器，全屏四边形由运行时提供。
//   - 运行时注入 u_time（秒）、u_resolution（像素）、u_frame / u_fps / u_seed，
//     manifest 里的每个参数自动变成同名 uniform：u_<名字>；
//   - 画面只能是 (u_time, 参数, u_resolution, 种子) 的函数：不读随机、不依赖上一帧；
//   - 输出 alpha 留透明区域，叠在别的图层上才好看。
//
// 噪声用 fract 哈希，不用 sin：同机重复渲染逐像素相同；跨机器仍可能有 1 ulp 级差异
// （和模板的精度说明一样，成片在本机内一致）。
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_scale;
uniform vec3 u_tint;

// 2D 哈希：把格子坐标压到 0..1，同一个格子永远同一个数。
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// 值噪声：四个角做平滑插值。
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 res = max(u_resolution, vec2(1.0));
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = (uv - 0.5) * u_scale;
  float t = u_time * u_speed;

  // 两次域扭曲，让噪声慢慢流动而不是整体平移。
  vec2 warp = vec2(valueNoise(p + vec2(0.0, t * 0.35)),
                   valueNoise(p + vec2(5.2, -t * 0.28)));
  float v = valueNoise(p * 2.0 + warp * 1.8 + vec2(t * 0.15, 0.0));

  vec3 col = u_tint * (0.25 + 0.85 * v);
  float dist = length(uv - 0.5);
  float fade = 1.0 - smoothstep(0.15, 0.62, dist);
  gl_FragColor = vec4(col * fade, fade * (0.35 + 0.65 * v));
}
