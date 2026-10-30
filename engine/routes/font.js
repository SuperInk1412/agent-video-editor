// The bytes of one font file, for the preview's text meshes (§4.4 v4, WP1.3).
//
//   GET /api/font?font=<family or project-relative path>   ->  font/ttf | font/otf | font/collection
//
// `core/glyphs.js` parses them in the renderer; this route is the only way a
// browser can reach a font file.
//
// Read-only and narrow: a file has to live inside `fontDirs` (the OS font
// directories plus this project's media / assets / fonts) and end in
// `.ttf` / `.otf` / `.ttc`; everything else is 403. `.ttc` is in the list on
// purpose — the CJK face Windows ships ("Microsoft YaHei") is a collection.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fontDirs, resolveFontFile } from '../shot.js';

export function register(router, ctx) {
  const { json } = ctx;

  router.get('/api/font', async (req, res, { url }) => {
    const requested = String(url.searchParams.get('font') || url.searchParams.get('path') || '').trim();
    if (!requested) return json(res, 400, { error: 'font 必填', code: 'INVALID_ARGUMENT' });
    const file = resolveFontFile(requested, ctx.root);
    if (!file) return json(res, 404, { error: `找不到字体：${requested}`, code: 'FONT_NOT_FOUND' });
    const absolute = path.resolve(file);
    const allowed = fontDirs(ctx.root).some((dir) => {
      const root = path.resolve(dir);
      return absolute === root || absolute.startsWith(root + path.sep);
    });
    if (!allowed) return json(res, 403, { error: '字体目录不在白名单', code: 'ACCESS_DENIED' });
    if (!/\.(ttf|otf|ttc)$/i.test(absolute)) return json(res, 403, { error: '只允许 .ttf / .otf / .ttc', code: 'ACCESS_DENIED' });
    let bytes;
    try {
      bytes = await fsp.readFile(absolute);
    } catch (e) {
      return json(res, 404, { error: `读不到字体：${path.basename(absolute)}`, code: 'FONT_NOT_FOUND' });
    }
    const type = /\.ttc$/i.test(absolute) ? 'font/collection' : /\.otf$/i.test(absolute) ? 'font/otf' : 'font/ttf';
    res.writeHead(200, {
      'content-type': type,
      // A font file is immutable content; the mesh id hashes it, so a changed
      // file is a different mesh anyway.
      'cache-control': 'public, max-age=86400',
      'content-length': bytes.length,
    });
    return res.end(bytes);
  });
}
