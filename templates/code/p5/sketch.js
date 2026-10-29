// 起步模板 · p5（instance 模式）—— 运行时每帧调一次 draw，loop() / frameRate() 被沙箱忽略。
//
// 契约（docs/DESIGN-BACKEND-V2.md §5.2 / §6.2）：
//   - `export default (p) => { ... }`，在 p.setup / p.draw 里画；
//   - 当前帧的 `vdm` 挂在实例上：`p.vdm.param('名字')` / `p.vdm.t` / `p.vdm.random(i, k)`；
//   - 不要用 Date.now / performance.now / Math.random / fetch，也不要用 p5 的
//     loadImage / loadFont（沙箱没有网络和本机文件）；`vdm source check` 会扫出来；
//   - p.clear() 让底透明，叠在别的图层上才不会变成一块不透明的板子。
export default (p) => {
  const fallback = { density: 0.5, count: 9, speed: 0.6, tint: '#ffd166' };

  const params = () => {
    const vdm = p.vdm;
    if (!vdm) return fallback;
    return {
      density: vdm.param('density'),
      count: Math.max(2, Math.round(vdm.param('count'))),
      speed: vdm.param('speed'),
      tint: vdm.param('tint'),
    };
  };

  p.setup = () => {
    const vdm = p.vdm;
    const [w, h] = vdm ? vdm.size : [640, 360];
    p.createCanvas(w, h);
    p.pixelDensity(1);
    p.noStroke();
  };

  p.draw = () => {
    const vdm = p.vdm;
    if (!vdm) return;
    const { density, count, speed, tint } = params();
    const step = Math.min(p.width, p.height) / count;
    const ox = (p.width - step * count) / 2;
    const oy = (p.height - step * count) / 2;
    const t = vdm.t * speed;

    p.clear();
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        if (vdm.random(i, j) > density) continue;
        const phase = (t * 0.6 + vdm.random(i, j + 64)) % 1;
        const alpha = 0.2 + 0.7 * phase;
        p.fill(tint);
        p.drawingContext.globalAlpha = alpha;
        p.circle(ox + (i + 0.5) * step, oy + (j + 0.5) * step, step * (0.24 + 0.76 * phase));
      }
    }
    p.drawingContext.globalAlpha = 1;
  };
};
