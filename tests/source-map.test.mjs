// core/source-map.js — the HTML / CSS / SVG compiler (§7.1, §7.8.1, WP4.1).
//
// Pure unit tests: no browser, no font files. Text measurement and font
// metrics are injected, exactly like `application/source-service.js` does with
// the real files, so the expectations here are the compiler's own numbers.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_PATHS, WARNING_CODES,
  compileHtml, compileSvg, parseHtml, parseSvgPath, parseStylesheet, parseSelector,
  matchesSelector, parseCssColor, evalLength, evalTime, parseLinearGradient,
  gradientColorAt, cubicBezierCurve, decomposeMatrix, parseTransformList,
  substituteVars, splitCommaList,
} from '../core/source-map.js';
import { SOURCE_PATHS as EVAL_SOURCE_PATHS } from '../core/source-eval.js';

/** A deterministic stand-in for the IR's typesetting: CJK = 1em, else 0.6em. */
const measure = (text, style) => {
  let width = 0;
  for (const ch of String(text)) width += (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.6) * style.fontSize;
  const count = Array.from(String(text)).length;
  return width + Math.max(0, count - 1) * (style.letterSpacing || 0);
};

const FONTS = {
  families: ['SimHei', 'Consolas'],
  metrics: {
    simhei: { ascent: 0.86, descent: 0.14, lineGap: 0 },
    consolas: { ascent: 0.8, descent: 0.2, lineGap: 0 },
  },
};

/** Compile one inline page with the fixture defaults. */
function compile(files, opts = {}) {
  return compileHtml({ id: 'test-src', manifest: { runtime: 'html', entry: 'index.html' }, files }, {
    width: 1920, height: 1080, duration: 4, fonts: FONTS, measureText: measure, ...opts,
  });
}

const page = (body, css = '') => ({
  'index.html': `<!doctype html><html><head>${css ? '<link rel="stylesheet" href="style.css">' : ''}</head><body>${body}</body></html>`,
  ...(css ? { 'style.css': css } : {}),
});

const warningsOf = (out, code) => out.warnings.filter((warning) => warning.code === code);
const node = (out, id) => out.nodes.find((entry) => entry.id === id);
const element = (out, id) => out.elements.find((entry) => String(entry.id).endsWith(`_${id}`) && entry.source);

// ---------------------------------------------------------------- paths

test('SOURCE_PATHS is the frozen §7.8.1 set, re-exported from source-eval (§7.8.7 R1)', () => {
  assert.deepEqual([...SOURCE_PATHS], [...EVAL_SOURCE_PATHS]);
  assert.equal(SOURCE_PATHS.length, 14);
  for (const path of ['style.text', 'style.font', 'style.size', 'style.weight', 'style.color',
    'style.align', 'style.lineHeight', 'style.letterSpacing', 'src',
    'transform.x', 'transform.y', 'transform.scale', 'transform.rotation', 'transform.opacity']) {
    assert.ok(SOURCE_PATHS.includes(path), path);
  }
});

test('every warning the compiler can emit is in WARNING_CODES', () => {
  const out = compile(page('<p class="a" data-vdm-id="n_a">x</p>', 'p { color: red; unknown-prop: 1 }'));
  assert.ok(out.warnings.length > 0);
  for (const warning of out.warnings) assert.ok(WARNING_CODES.includes(warning.code), warning.code);
});

// ---------------------------------------------------------------- HTML

test('HTML: elements, attributes, comments, entities and raw text', () => {
  const { root } = parseHtml(`<!doctype html><!-- c --><div id="d" class="a b" data-x="1&amp;2">t &middot; u<br>v</div><style>p{}</style>`);
  const div = root.children.find((child) => child.tag === 'div');
  assert.equal(div.attrs.id, 'd');
  assert.equal(div.attrs.class, 'a b');
  assert.equal(div.attrs['data-x'], '1&2');
  const texts = div.children.filter((child) => child.type === 'text').map((child) => child.text).join('');
  assert.equal(texts, 't · uv');
  assert.equal(div.children.some((child) => child.tag === 'br'), true);
  assert.equal(root.children.some((child) => child.tag === 'style'), true);
});

test('HTML: unknown tags warn, <script> is reported as not executed', () => {
  const out = compile(page('<section data-vdm-id="n_s">s</section><my-widget></my-widget><script>1</script>'));
  assert.ok(warningsOf(out, 'unsupported-tag').some((w) => w.message.includes('my-widget')));
  assert.equal(warningsOf(out, 'script-not-executed').length, 1);
});

test('HTML: an invalid or duplicate data-vdm-id is reported, not compiled twice', () => {
  const out = compile(page('<p data-vdm-id="1bad">a</p><p data-vdm-id="ok">b</p><p data-vdm-id="ok">c</p>'));
  assert.equal(warningsOf(out, 'node-id-invalid').length, 1);
  assert.equal(warningsOf(out, 'duplicate-node-id').length, 1);
  assert.deepEqual(out.nodes.map((entry) => entry.id), ['ok']);
});

test('HTML: a node with element children is a warning (containers are not compiled)', () => {
  const out = compile(page('<div data-vdm-id="n_box"><span>x</span></div>'));
  assert.equal(warningsOf(out, 'container-node-unsupported').length, 1);
  assert.equal(out.nodes.length, 0);
  assert.equal(warningsOf(out, 'empty-node').length, 1);
});

test('HTML: <img> cannot enter the media pipeline yet and is reported', () => {
  const out = compile(page('<img data-vdm-id="n_img" src="a.png">'));
  assert.equal(warningsOf(out, 'image-unsupported').length, 1);
});

// ---------------------------------------------------------------- CSS

test('CSS: selector subset (tag / class / id / descendant / child / comma / nth-child)', () => {
  const sheet = parseStylesheet('div p, .a > .b, #c .d, li:nth-child(-n + 2) { color: red }');
  assert.equal(sheet.rules.length, 1);
  const selectors = sheet.rules[0].selectors;
  assert.equal(selectors.length, 4);
  assert.deepEqual(selectors[0].specificity, [0, 0, 2]);
  assert.deepEqual(selectors[1].specificity, [0, 2, 0]);
  assert.deepEqual(selectors[2].specificity, [1, 1, 0]);
  // :nth-child matching
  const html = '<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>';
  const { root } = parseHtml(html);
  const list = root.children.find((child) => child.tag === 'ul');
  const nth = parseSelector('li:nth-child(-n + 2)');
  const matched = list.children.filter((child) => matchesSelector(nth, child)).map((child) => child.children[0].text);
  assert.deepEqual(matched, ['a', 'b']);
});

test('CSS: unsupported selectors and media queries are reported', () => {
  const sheet = parseStylesheet('p:hover { color: red }\n@media (max-width: 1px) { p { color: blue } }');
  assert.equal(sheet.rules.length, 0);
  assert.ok(sheet.warnings.some((warning) => warning.code === 'unsupported-pseudo-class'));
  assert.ok(sheet.warnings.some((warning) => warning.code === 'media-query-ignored'));
});

test('CSS: values — colors, lengths, calc, clamp, min/max, var()', () => {
  assert.deepEqual(parseCssColor('#ff5c7a'), { r: 255, g: 92, b: 122, a: 1 });
  assert.deepEqual(parseCssColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseCssColor('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.equal(parseCssColor('not-a-color'), null);
  const ctx = { vw: 1920, vh: 1080, fontSize: 20, percent: 1000, rootFontSize: 16 };
  assert.equal(evalLength('12px', ctx), 12);
  assert.equal(evalLength('10%', ctx), 100);
  assert.equal(evalLength('50vw', ctx), 960);
  assert.equal(evalLength('2em', ctx), 40);
  assert.ok(Math.abs(evalLength('clamp(12px, 1.7vh, 22px)', ctx) - 18.36) < 1e-9);
  assert.equal(evalLength('min(100vw, 1920px)', ctx), 1920);
  assert.equal(evalLength('max(2px, 0.35vh)', ctx), 3.78);
  assert.equal(evalLength('calc(100% - 20px)', ctx), 980);
  assert.equal(evalLength('auto', ctx), null);
  // A leading sign is part of the number, not an operator (CSS allows both).
  assert.equal(evalLength('-100%', ctx), -1000);
  assert.equal(evalLength('calc(-10px + 4px)', ctx), -6);
  const percentTranslate = parseTransformList('translateX(-100%)', { w: 500, h: 20, fontSize: 16 }, ctx);
  assert.deepEqual(percentTranslate.warnings, []);
  assert.deepEqual(percentTranslate.matrix, [1, 0, 0, 1, -500, 0]);
  assert.equal(evalTime('0.9s'), 0.9);
  assert.equal(evalTime('600ms'), 0.6);
  assert.equal(evalTime('calc(0.9s / 2)'), 0.45);
  assert.equal(evalTime('calc(2 * 0.35s)'), 0.7);
  assert.equal(substituteVars('calc(0.9s / var(--speed, 1))', { '--speed': '2' }), 'calc(0.9s / 2)');
  assert.deepEqual(splitCommaList('a, rgba(1, 2, 3), b'), ['a', 'rgba(1, 2, 3)', 'b']);
});

test('CSS: cascade order, specificity and inherited properties', () => {
  const out = compile(
    page('<div class="wrap"><p class="k" data-vdm-id="n_k">hi</p></div>',
      'body { color: #112233; font-size: 20px }\n.k { color: #445566 }\np { color: #778899; font-size: 30px }'),
  );
  const props = node(out, 'n_k').props;
  assert.equal(props['style.color'], '#445566', 'class beats tag');
  assert.equal(props['style.size'], 30, 'tag sets the font size');
});

test('CSS: a property outside the subset is reported with its value', () => {
  const out = compile(page('<p data-vdm-id="n_a">x</p>', 'p { color: red; filter: blur(2px); unknown-thing: 3 }'));
  const codes = warningsOf(out, 'unsupported-property').map((warning) => warning.message);
  assert.ok(codes.some((message) => message.includes('unknown-thing')));
});

// ---------------------------------------------------------------- styles → props

test('text node: the §7.8.1 props are filled from the computed style', () => {
  const out = compile(page('<p class="t" data-vdm-id="n_t">歌词 ABC</p>',
    'body { font-family: "SimHei"; color: #eef4ff }\n.t { font-size: 40px; font-weight: 600; line-height: 1.32; letter-spacing: 2px; text-align: left }'));
  const props = node(out, 'n_t').props;
  assert.equal(props['style.text'], '歌词 ABC');
  assert.equal(props['style.font'], 'SimHei');
  assert.equal(props['style.size'], 40);
  assert.equal(props['style.weight'], 600);
  assert.equal(props['style.lineHeight'], 1.32);
  assert.equal(props['style.letterSpacing'], 2);
  assert.equal(props['style.align'], 'left');
  assert.equal(props['style.color'], '#eef4ff');
  const el = element(out, 'n_t');
  assert.deepEqual(el.style.text, '歌词 ABC');
  assert.deepEqual(el.source, { id: 'test-src', node: 'n_t' });
});

test('text node: text-transform, translucent colour → opacity, and align', () => {
  const out = compile(page('<p class="t" data-vdm-id="n_t">abc</p>',
    '.t { text-transform: uppercase; color: rgba(255, 255, 255, 0.5); text-align: center; font-size: 20px }'));
  const props = node(out, 'n_t').props;
  assert.equal(props['style.text'], 'ABC');
  assert.equal(props['style.color'], '#ffffff');
  assert.equal(props['transform.opacity'], 0.5);
  assert.equal(props['style.align'], 'center');
});

test('solid node: box size and fill are element fields, position is a source path', () => {
  const out = compile(page('<span class="rule" data-vdm-id="n_rule"></span>',
    'body { margin: 0 }\n.rule { display: block; width: 38%; height: 4px; background: #ff5c7a }'));
  const el = element(out, 'n_rule');
  assert.equal(el.type, 'solid');
  assert.equal(el.style.w, Math.round(0.38 * 1920 * 1000) / 1000);
  assert.equal(el.style.h, 4);
  assert.equal(el.style.fill, '#ff5c7a');
  const props = node(out, 'n_rule').props;
  assert.equal(props['transform.x'], 0.38 * 1920 / 2 - 960);
  assert.equal(Object.keys(props).some((path) => path.startsWith('style.')), false, 'solids carry no text paths');
  assert.equal(props['transform.opacity'], 1);
});

test('layout: a flex column with gap and justify-content: center', () => {
  const out = compile(page(
    '<main class="stage"><p data-vdm-id="n_1">a</p><p data-vdm-id="n_2">b</p></main>',
    'html, body { margin: 0 }\n.stage { display: flex; flex-direction: column; justify-content: center; gap: 40px; height: 1000px; padding: 0 100px }\n'
    + 'p { margin: 0; font-size: 20px; line-height: 2 }',
  ));
  // Two 40 px line boxes + 40 px gap = 120, centred in 1000 → first top = 440.
  const first = node(out, 'n_1').props;
  const second = node(out, 'n_2').props;
  assert.equal(first['transform.y'], 440 + 20 - 540);
  assert.equal(second['transform.y'], 520 + 20 - 540);
  // text-align: start → the text starts at the content box's left edge (100).
  const measured = measure('a', { fontSize: 20, letterSpacing: 0 });
  assert.equal(first['transform.x'], 100 + measured / 2 - 960);
});

test('layout: percent padding and border-box are resolved in layout', () => {
  const out = compile(page(
    '<main class="stage"><p data-vdm-id="n_1">a</p></main>',
    'html, body { margin: 0 }\n* { box-sizing: border-box }\n.stage { width: 1000px; padding: 0 10%; }\np { margin: 0; font-size: 20px; line-height: 1 }',
  ));
  const x = node(out, 'n_1').props['transform.x'];
  const measured = measure('a', { fontSize: 20, letterSpacing: 0 });
  assert.equal(x, 192 + measured / 2 - 960);
});

test('layout: a grid with place-items: center centres its single child', () => {
  const out = compile(page(
    '<main class="stage"><p data-vdm-id="n_1">a</p></main>',
    'html, body { margin: 0; height: 1080px }\n.stage { display: grid; place-items: center; width: 100%; height: 100% }\np { margin: 0; font-size: 20px; line-height: 1; width: 200px }',
  ));
  const props = node(out, 'n_1').props;
  assert.equal(props['transform.x'], 860 + measure('a', { fontSize: 20, letterSpacing: 0 }) / 2 - 960, 'centred horizontally');
  assert.equal(props['transform.y'], 0, 'centred vertically');
});

test('layout: position: absolute honours left / top', () => {
  const out = compile(page(
    '<main class="stage"><p data-vdm-id="n_1">a</p></main>',
    'html, body { margin: 0 }\n.stage { position: relative; width: 1920px; height: 1080px }\n'
    + 'p { position: absolute; left: 100px; top: 200px; margin: 0; font-size: 20px; line-height: 1 }',
  ));
  const measured = measure('a', { fontSize: 20, letterSpacing: 0 });
  const props = node(out, 'n_1').props;
  assert.equal(props['transform.x'], 100 + measured / 2 - 960);
  assert.equal(props['transform.y'], 200 + 10 - 540);
});

// ---------------------------------------------------------------- animation

test('@keyframes → tracks: absolute seconds, baseline at t = 0, cubic-bezier → curve', () => {
  const out = compile(page('<p class="t" data-vdm-id="n_t">x</p>',
    '.t { font-size: 20px; line-height: 1; opacity: 0; animation: rise 1s cubic-bezier(0.22, 0.61, 0.36, 1) 0.5s both }\n'
    + '@keyframes rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }'));
  const record = node(out, 'n_t');
  const opacity = record.tracks.filter((key) => key.path === 'transform.opacity');
  assert.equal(opacity.length, 2);
  assert.equal(opacity[0].t, 0.5);
  assert.equal(opacity[0].value, 0);
  assert.equal(opacity[1].t, 1.5);
  assert.equal(opacity[1].value, 1);
  assert.ok(Array.isArray(opacity[0].curve), 'timing function became a curve');
  assert.equal(opacity[0].curve.length, 9);
  assert.equal(opacity[0].curve[0][0], 0);
  assert.ok(Math.abs(opacity[0].curve[4][1] - 0.5) < 0.4);
  assert.equal(record.props['transform.opacity'], 0, 'baseline is the value at t = 0');
  const y = record.tracks.filter((key) => key.path === 'transform.y');
  assert.equal(y.length, 2);
  assert.equal(y[0].value, record.props['transform.y'], 'the baseline is the t = 0 value');
  assert.ok(Math.abs(y[1].value - (record.props['transform.y'] - 10)) < 1e-6, 'translateY is a delta against the layout');
  // §7.8.2: a zero baseline under `mul` is recorded as `add` so the animation survives.
  assert.equal(element(out, 'n_t').sourceMode['transform.opacity'], 'add');
  assert.equal(element(out, 'n_t').sourceMode['transform.y'], undefined);
});

test('@keyframes: uniform scale, rotation sign and iteration-count', () => {
  const out = compile(page('<p class="t" data-vdm-id="n_t">x</p>',
    '.t { font-size: 20px; line-height: 1; transform: scale(0.5); animation: grow 1s linear 0s 2 both }\n'
    + '@keyframes grow { from { transform: scale(0.5) rotate(10deg) } to { transform: scale(1) rotate(0deg) } }'));
  const record = node(out, 'n_t');
  const scale = record.tracks.filter((key) => key.path === 'transform.scale');
  assert.equal(scale.length, 4);
  assert.deepEqual(scale.map((key) => key.value), [0.5, 1, 0.5, 1]);
  assert.ok(scale[1].t <= 1 && scale[2].t >= 1, 'the iteration boundary keeps both values');
  const rotation = record.tracks.filter((key) => key.path === 'transform.rotation');
  // CSS rotate(10deg) is clockwise on screen; the element's `transform.rotation`
  // is counter-clockwise (§7.8.1 "符号差异由 4.1 换算").
  assert.deepEqual(rotation.map((key) => key.value), [-10, 0, -10, 0]);
  assert.equal(record.props['transform.scale'], 0.5, 'baseline mirrors the static transform');
});

test('@keyframes: unsupported motion (translateZ / rotateX) is reported, not faked', () => {
  const out = compile(page('<p class="t" data-vdm-id="n_t">x</p>',
    '.t { font-size: 20px; animation: fly 1s linear both }\n@keyframes fly { from { transform: translateZ(-10px) rotateX(20deg) } to { transform: none } }'));
  assert.ok(warningsOf(out, 'unsupported-transform').length >= 1);
  assert.equal(node(out, 'n_t').tracks.filter((key) => key.path === 'transform.x').length, 2, 'the translatable parts still compile');
});

test('@keyframes: an unknown property inside the keyframes is reported', () => {
  const out = compile(page('<p class="t" data-vdm-id="n_t">x</p>',
    '.t { font-size: 20px; animation: k 1s linear both }\n@keyframes k { from { background-color: red } to { background-color: blue } }'));
  assert.ok(warningsOf(out, 'unsupported-keyframe-property').length >= 1);
});

test('@keyframes: a missing @keyframes block is reported', () => {
  const out = compile(page('<p class="t" data-vdm-id="n_t">x</p>', '.t { animation: nope 1s linear both }'));
  assert.ok(warningsOf(out, 'unsupported-animation').some((warning) => warning.message.includes('nope')));
});

test('transform helpers: parse, non-uniform warning, decompose to element space', () => {
  const box = { w: 100, h: 50 };
  const ctx = { vw: 1920, vh: 1080, fontSize: 16, rootFontSize: 16 };
  const parsed = parseTransformList('translate(10px, 20%) rotate(90deg) scale(2)', box, ctx);
  assert.deepEqual(parsed.warnings, []);
  const decomposed = decomposeMatrix(parsed.matrix);
  assert.equal(decomposed.uniform, true);
  assert.ok(Math.abs(decomposed.scale - 2) < 1e-9);
  assert.ok(Math.abs(decomposed.rotation + 90) < 1e-9, 'element rotation is the CSS angle negated');
  const nonUniform = parseTransformList('scale(2, 1)', box, ctx);
  assert.ok(nonUniform.warnings.some((warning) => warning.includes('非等比')));
});

test('cubic-bezier sampling: monotonic u, endpoints fixed', () => {
  const curve = cubicBezierCurve([0.22, 0.61, 0.36, 1]);
  assert.equal(curve[0][0], 0);
  assert.equal(curve[curve.length - 1][0], 1);
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i][0] > curve[i - 1][0]);
  assert.ok(curve[curve.length - 1][1] <= 1.001);
});

// ---------------------------------------------------------------- background

test('page background: solid layers and a linear-gradient approximated by solid bands', () => {
  const out = compile(page('<main data-vdm-id="n_x"></main>',
    'html, body { margin: 0; background: #06070c }\nmain { width: 1920px; height: 1080px; background: linear-gradient(115deg, rgba(255, 92, 122, 0.16), rgba(6, 7, 12, 0) 46%), #06070c }'));
  const gradient = parseLinearGradient('linear-gradient(115deg, rgba(255, 92, 122, 0.16), rgba(6, 7, 12, 0) 46%)', { vw: 1920, vh: 1080 }, 'x', { add() {} });
  assert.equal(gradient.angle, 115);
  assert.equal(gradient.stops.length, 2);
  assert.equal(gradient.stops[1].position, 0.46);
  const mid = gradientColorAt(gradient, 0.2);
  assert.ok(mid.a > 0 && mid.a < 0.16);
  assert.ok(warningsOf(out, 'background-gradient-approximated').length >= 1);
  const bands = out.elements.filter((el) => !el.source && el.type === 'solid');
  assert.ok(bands.length >= 8, `expected background bands, got ${bands.length}`);
  for (const band of bands) {
    assert.match(band.style.fill, /^#[0-9a-f]{6}$/);
    assert.ok(band.style.w > 1000 && band.style.h > 0);
  }
  // Bands all sit below the compiled nodes.
  const text = out.elements.filter((el) => el.source);
  assert.ok(bands.every((band) => band.z < text[0].z));
});

test('page background: a non-covering background is reported, not compiled', () => {
  const out = compile(page('<main data-vdm-id="n_x"><div class="card">c</div></main>',
    'html, body { margin: 0; background: #000 }\nmain { width: 1920px; height: 1080px; background: #000 }\n.card { width: 100px; height: 100px; background: #fff }'));
  assert.ok(warningsOf(out, 'background-not-compiled').some((warning) => warning.message.includes('<div>')));
});

// ---------------------------------------------------------------- SVG

test('SVG path: M/L/H/V/C/Q/Z and relative commands', () => {
  const parsed = parseSvgPath('M10 10 L20 10 H30 V20 C30 30 20 30 10 30 Q0 30 0 20 Z');
  assert.equal(parsed.closed, true);
  assert.deepEqual(parsed.segments.map((segment) => segment.cmd), ['M', 'L', 'L', 'L', 'C', 'Q', 'Z']);
  assert.deepEqual(parsed.bbox, { minX: 0, minY: 10, maxX: 30, maxY: 30 });
  const relative = parseSvgPath('m10 10 l5 0 l0 5 z');
  assert.equal(relative.closed, true);
  assert.deepEqual(relative.segments.map((segment) => segment.to), [[10, 10], [15, 10], [15, 15], [10, 10]]);
  const curve = parseSvgPath('M0 0 C10 0 10 10 20 10');
  assert.deepEqual(curve.segments[1].points, [[10, 0], [10, 10], [20, 10]]);
  const quad = parseSvgPath('M0 0 Q5 5 10 0');
  assert.equal(quad.segments[1].cmd, 'Q');
  const bad = parseSvgPath('M0 0 L');
  assert.ok(bad.error);
});

test('SVG compile: rect / circle / ellipse map onto solid / shape', () => {
  const out = compileSvg({ id: 'icons', manifest: { runtime: 'svg', entry: 'icons.svg' }, files: {
    'icons.svg': '<svg width="1920" height="1080" viewBox="0 0 1920 1080">'
      + '<rect id="bar" x="100" y="200" width="300" height="40" fill="#ff5c7a" rx="4"/>'
      + '<circle id="dot" cx="500" cy="220" r="20" fill="#9fd8ff"/>'
      + '<ellipse id="oval" cx="700" cy="220" rx="60" ry="30" fill="#ffffff"/>'
      + '</svg>',
  } }, { width: 1920, height: 1080, duration: 4 });
  assert.deepEqual(out.nodes.map((entry) => entry.id), ['bar', 'dot', 'oval']);
  const bar = out.elements.find((el) => el.source.node === 'bar');
  assert.equal(bar.type, 'solid');
  assert.deepEqual([bar.style.w, bar.style.h, bar.style.fill, bar.style.radius], [300, 40, '#ff5c7a', 4]);
  assert.equal(bar.transform.x, 100 + 150 - 960);
  assert.equal(bar.transform.y, 200 + 20 - 540);
  const dot = out.elements.find((el) => el.source.node === 'dot');
  assert.equal(dot.type, 'shape');
  assert.equal(dot.style.shape, 'ellipse');
  assert.deepEqual([dot.style.w, dot.style.h], [40, 40]);
  const oval = out.elements.find((el) => el.source.node === 'oval');
  assert.deepEqual([oval.style.w, oval.style.h], [120, 60]);
});

test('SVG compile: path / polygon are parsed but reported as not drawable', () => {
  const out = compileSvg({ id: 'icons', manifest: { runtime: 'svg', entry: 'icons.svg' }, files: {
    'icons.svg': '<svg width="100" height="100" viewBox="0 0 100 100">'
      + '<path id="p" d="M0 0 L10 0 L10 10 Z" fill="#fff"/>'
      + '<polygon id="poly" points="0,0 10,0 10,10" fill="#fff"/>'
      + '<rect id="ok" width="10" height="10" fill="#fff"/>'
      + '</svg>',
  } }, { width: 1920, height: 1080 });
  assert.deepEqual(out.nodes.map((entry) => entry.id), ['ok']);
  assert.ok(warningsOf(out, 'path-not-drawable').length >= 1);
  assert.ok(warningsOf(out, 'polygon-not-drawable').length >= 1);
});

test('SVG compile: viewBox scaling and a non-uniform viewBox are reported', () => {
  const out = compileSvg({ id: 'icons', manifest: { runtime: 'svg', entry: 'icons.svg' }, files: {
    'icons.svg': '<svg width="200" height="100" viewBox="0 0 100 100"><rect id="box" width="10" height="10" fill="#fff"/></svg>',
  } }, { width: 1920, height: 1080 });
  const box = out.elements.find((el) => el.source.node === 'box');
  assert.equal(box.style.w, 20, 'x scale applied');
  assert.ok(warningsOf(out, 'svg-viewbox').length >= 1);
});

// ---------------------------------------------------------------- empty / limits

test('a source with nothing to compile says so instead of producing an empty success', () => {
  const out = compile(page('<div class="stage">no nodes here</div>', '.stage { width: 1920px; height: 1080px }'));
  assert.equal(out.nodes.length, 0);
  assert.equal(warningsOf(out, 'empty-node').length, 1);
});

test('missing entry / missing metrics are reported, never silently estimated', () => {
  assert.throws(() => compileHtml({ id: 'x', files: {} }, { measureText: measure }), /不在 files 里/);
  const out = compileHtml({ id: 'x', files: { 'index.html': '<p data-vdm-id="n">a</p>' } }, {});
  assert.ok(warningsOf(out, 'text-measure-fallback').length >= 1);
  assert.ok(warningsOf(out, 'font-unverified').length >= 1);
});
