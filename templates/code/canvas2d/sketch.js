// 起步模板 · canvas2d —— 一帧 = (代码, 参数, 帧号, 尺寸, 种子) 的纯函数。
//
// 契约（docs/DESIGN-BACKEND-V2.md §5.2 / §6.2）：
//   - 导出 draw(ctx, vdm)，运行时每帧调用一次；画布每帧先被清空，不要依赖上一帧。
//   - 参数一律用 vdm.param('名字')，随机一律用 vdm.random(i, k)。
//   - 不要用 Date.now / performance.now / Math.random / fetch / XMLHttpRequest，
//     `vdm source check` 会把这些扫出来。
//   - 画面要留透明区域（alpha < 1），否则叠在别人上面就是一块不透明的板子。
export function draw(ctx, vdm) {
  const [w, h] = vdm.size;
  const density = vdm.param('density');
  const count = Math.max(2, Math.round(vdm.param('count')));
  const speed = vdm.param('speed');
  const tint = vdm.param('tint');
  const t = vdm.t * speed;

  const step = Math.min(w, h) / count;
  const ox = (w - step * count) / 2;
  const oy = (h - step * count) / 2;
  ctx.fillStyle = tint;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      if (vdm.random(i, j) > density) continue;
      const phase = (t * 0.6 + vdm.random(i, j + 64)) % 1;
      const x = ox + (i + 0.5) * step;
      const y = oy + (j + 0.5) * step;
      const r = step * (0.12 + 0.38 * phase);
      ctx.globalAlpha = 0.2 + 0.7 * phase;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
