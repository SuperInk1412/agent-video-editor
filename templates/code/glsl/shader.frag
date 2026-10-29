// 起步模板 · glsl —— 只写片元着色器，全屏四边形由运行时提供。
//
// 契约（docs/DESIGN-BACKEND-V2.md §5.2 / §6.2）：
//   - 运行时注入 u_time（秒）、u_resolution（像素）、u_frame、u_fps、u_seed；
//     manifest 里声明的每个参数自动变成同名 uniform：u_<名字>。
//   - 画面只能是 (u_time, 参数, u_resolution, 种子) 的函数：不要用随机（没有来源），
//     也不要依赖上一帧（没有状态）。
//   - 输出 alpha 留透明区域，叠在别的图层上才好看。
//   - 精度：默认 precision highp float；某些显卡上的 highp 只有 24 位尾数，
//     sin/大量迭代会有 1 ulp 级差异，跨机器复现时注意（视频导出在本机内一致）。
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform float u_grid;
uniform vec3 u_tint;

void main() {
  vec2 res = max(u_resolution, vec2(1.0));
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / min(res.x, res.y);
  float r = length(p);
  float phase = u_time * u_speed * 3.0;
  float rings = 0.5 + 0.5 * sin(r * u_grid * 6.2831853 - phase);
  float fade = smoothstep(0.62, 0.12, r);
  vec3 col = u_tint * (0.25 + 0.75 * rings);
  gl_FragColor = vec4(col * fade, fade);
}
