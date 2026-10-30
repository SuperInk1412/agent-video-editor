// 共享夹具 · p5-rain（docs/DESIGN-BACKEND-V2.md §10.4.6，WP4.0）
//
// 契约（§5.2 / §6.2）：
//   - `export default (p) => { ... }`，实例模式；运行时每帧调一次 draw；
//   - 参数一律 `p.vdm.param('名字')`，随机一律 `p.vdm.random(i, k)`，时间一律 `p.vdm.t`；
//   - 不读挂钟、不用无种子随机、不调 loop() / frameRate() / loadImage（静态扫描会抓）。
//
// 一帧 = (参数, 帧号, 尺寸, 种子) 的纯函数：雨丝位置只由 vdm.random 的 (i, k) 与 vdm.t 决定。
// p.clear() 让底透明，叠在别的图层上不会变成一块不透明的板子。
export default (p) => {
  const fallback = { density: 0.55, speed: 1, tint: '#9fd8ff' };
  const DROPS = 220; // 固定条数：多出来的那部分由 density 过滤掉

  const params = () => {
    const vdm = p.vdm;
    if (!vdm) return fallback;
    return {
      density: vdm.param('density'),
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
    const { density, speed, tint } = params();
    const t = vdm.t * speed;

    p.clear();
    p.fill(tint);
    for (let i = 0; i < DROPS; i++) {
      if (vdm.random(i, 5) > density) continue;
      const x = vdm.random(i, 1) * p.width;
      const len = 12 + vdm.random(i, 3) * 46;
      const fall = 0.35 + 0.4 * vdm.random(i, 4);
      // 相位在 0..1，按 (相位 + t·速度) 取小数部分，落到 -len .. height：
      // 一直往下落，越出画面就从顶上重新进来。
      const y = ((vdm.random(i, 2) + t * fall) % 1) * (p.height + len) - len;
      p.drawingContext.globalAlpha = 0.25 + 0.5 * vdm.random(i, 6);
      p.rect(x, y, 2, len);
    }
    p.drawingContext.globalAlpha = 1;
  };
};
