// 共享夹具 · canvas2d-bars（docs/DESIGN-BACKEND-V2.md §10.4.6，WP4.0）
//
// 契约（§5.2 / §6.2）：`export function draw(ctx, vdm)`，运行时每帧调一次，
// 画布每帧先被清空、不要依赖上一帧。参数用 `vdm.param()`，随机用 `vdm.random(i, k)`。
// 一帧 = (代码, 参数, 帧号, 尺寸, 种子) 的纯函数；不留不透明底板，alpha 交给调用方。
export function draw(ctx, vdm) {
  const [w, h] = vdm.size;
  const count = Math.max(3, Math.round(vdm.param('count')));
  const speed = vdm.param('speed');
  const tint = vdm.param('tint');
  const gap = Math.max(4, Math.round(w * 0.004));
  const bar = (w - gap * (count + 1)) / count;
  const t = vdm.t * speed;

  ctx.fillStyle = tint;
  for (let i = 0; i < count; i++) {
    // 每条一根固定相位 + 一个固定拍点，全部来自带种子的哈希。
    const seedA = vdm.random(i, 11);
    const seedB = vdm.random(i, 23);
    const pulse = 0.5 + 0.5 * Math.sin(t * (1.4 + 2.6 * seedA) + seedB * Math.PI * 2);
    const value = 0.12 + 0.78 * (0.35 * seedA + 0.65 * pulse);
    const height = Math.max(2, value * h);
    const x = gap + i * (bar + gap);
    ctx.globalAlpha = 0.45 + 0.5 * pulse;
    ctx.fillRect(x, h - height, bar, height);
  }

  // 底线：让空画面也有一个可辨认的锚点，顺便测半透明叠加。
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, h - 2, w, 2);
  ctx.globalAlpha = 1;
}
