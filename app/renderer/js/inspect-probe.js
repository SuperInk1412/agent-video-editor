// In-page pixel probe for `vdm inspect coverage --mode pixel` (WP2.1 follow-up).
//
// Renders one frame twice through the real preview — once with the element
// visible, once with it hidden — and counts the pixels it contributes. That is
// the number the FIX document reports ("歌词像素 1857–9850"), which the
// geometric coverage can only approximate.
//
// Loaded by an `--eval` string inside the offscreen app; the result lands in
// window.__dbg and comes back through the `[capture]` line.
export async function pixelCoverage(opts = {}) {
  const app = window.__vdm;
  if (!app?.preview) return { error: 'NO_PREVIEW' };
  const p = app.preview;
  const project = app.S.project;
  const fps = Number(project?.meta?.fps) || 24;
  const elementId = opts.elementId;
  const el = (project?.elements || []).find((e) => e.id === elementId);
  if (!el) return { error: 'ELEMENT_NOT_FOUND', elementId };
  const frames = Array.isArray(opts.frames) && opts.frames.length ? opts.frames : [0];

  app.pause?.();
  if (opts.camera) p.soloCameras = new Set([opts.camera]);
  const W = p.canvas.width;
  const H = p.canvas.height;
  const gl = p.gl;
  const read = () => {
    const buf = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  // The IR cache is keyed by revision; hiding an element does not bump the rev,
  // so the cache must be dropped or the second render would replay the first.
  const dropCache = () => { try { p._irCache?.clear(); } catch { /* ignore */ } };

  const rows = [];
  for (const frame of frames) {
    const t = frame / fps;
    p.render(t);
    const withEl = read();
    el.visible = false;
    dropCache();
    p.render(t);
    const without = read();
    el.visible = true;
    dropCache();

    let pixels = 0;
    let maxChannel = 0;
    let sum = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let i = 0; i < withEl.length; i += 4) {
      const d = Math.max(
        Math.abs(withEl[i] - without[i]),
        Math.abs(withEl[i + 1] - without[i + 1]),
        Math.abs(withEl[i + 2] - without[i + 2]),
        Math.abs(withEl[i + 3] - without[i + 3]),
      );
      if (!d) continue;
      pixels += 1;
      sum += d;
      if (d > maxChannel) maxChannel = d;
      const px = (i / 4) % W;
      const py = H - 1 - Math.floor(i / 4 / W); // readPixels is bottom-up
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    rows.push({
      frame,
      t: Math.round(t * 1e6) / 1e6,
      pixels,
      ratio: pixels / (W * H),
      maxChannel,
      meanChannel: pixels ? sum / pixels : 0,
      bbox: pixels ? [minX, minY, maxX, maxY] : null,
    });
  }
  return {
    fps,
    size: [W, H],
    camera: opts.camera || null,
    elementId,
    elementType: el.type,
    frames: rows,
  };
}
