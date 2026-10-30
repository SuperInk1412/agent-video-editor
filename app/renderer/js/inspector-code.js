// Inspector · 代码图层 section (docs/DESIGN-WP3.6-4.6-UI.md §2.1, WP3.6a).
//
// A `code` element keeps the ordinary element panel (section order 20) and
// gains this one after it (order 40): the source row with the 查看源码 entry,
// one row per manifest parameter, the render state, and — when the source trips
// the static part of the contract check — a --danger line on top.
//
// Nothing here knows about the render pool. A value goes through
// `codeParamSet`, ◆ through `keySet` / `keyRemove` (the same keyframe semantics
// as every other property, so a key written here is the key the whole app
// reads), and 把当前值设为默认 through `sourceAdd` — the only op that may rewrite
// `manifest.json` (`sourceWrite` refuses it by contract). One drag of the
// slider is one op via the panel's debounced commit, hence one Ctrl+Z.
//
// The source view and the full `vdm source check` belong to WP3.6b: their two
// entry points are wired here and toast a stub until it lands.
import { registerInspectorSection } from './inspector.js';
import { h, showMenu } from './ui.js';
import { writeNumber } from './numfield.js';
import {
  codeManifest, codeParamPath, codeParamsAt, coerceParamValue,
  scanSourceFiles, sourceFiles, sourceParams, sourceRecord,
} from '/core/code-layer.js';

/** Manifest types drawn as a number box (with a slider when `range` is given). */
const NUMBER_TYPES = new Set(['number', 'int', 'length', 'percent', 'angle']);
/** Status word of the render row; the tooltip says what it means. */
const RUN_TEXT = { live: '实时', bake: '烘焙', waiting: '等待首帧', fallback: '上一帧', none: '—' };
const RUN_TIP = {
  live: '实时：预览按需渲染这一帧',
  bake: '烘焙：只显示已缓存的帧，不为预览现渲',
  waiting: '等待首帧：这一帧还没到，画面上暂时什么都没有',
  fallback: '上一帧：这一帧迟到或失败，画面显示同通道最近一帧',
  none: '这一帧的画面里没有这个图层',
};
const SOURCE_STUB = '源码视图即将提供';

const toast = (insp, msg, level = 'info') => insp.opts.onToast?.(msg, level);
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const titleOf = (err) => String(err?.message || err?.name || err?.id || '契约检查失败');

/** `[min, max]` of a parameter, or null when it has no usable range. */
function rangeOf(decl) {
  const raw = Array.isArray(decl?.range) ? decl.range : null;
  if (!raw || raw.length < 2) return null;
  const [min, max] = raw.map(Number);
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? [min, max] : null;
}

/** Slider / scrub step: the manifest's own `step`, else ~100 stops across the range. */
function stepOf(decl) {
  const own = Number(decl?.step);
  if (Number.isFinite(own) && own > 0) return own;
  if (decl?.type === 'int') return 1;
  const range = rangeOf(decl);
  if (!range) return 0.01;
  const raw = (range[1] - range[0]) / 100;
  return Number(Math.min(1, Math.max(0.001, raw)).toFixed(3));
}

/** Half a frame: the tolerance the ◆ uses for "this frame already has a key". */
const tolOf = (project) => 0.5 / (Number(project?.meta?.fps) || 24);

function keyAt(el, path, t, tol) {
  return (Array.isArray(el?.keyframes) ? el.keyframes : [])
    .find((k) => k && k.path === path && Math.abs(Number(k.t) - t) <= tol) || null;
}

/** ◆ state: 'on' (key at the playhead) / 'anim' (keys elsewhere) / 'none'. */
function keyState(el, path, t, tol) {
  const keys = Array.isArray(el?.keyframes) ? el.keyframes : [];
  if (keys.some((k) => k && k.path === path && Math.abs(Number(k.t) - t) <= tol)) return 'on';
  return keys.some((k) => k && k.path === path) ? 'anim' : 'none';
}

/** One-line contract failure on top of the section (§2.1) + its 查看详情 entry. */
function checkLine(insp, errors) {
  const first = errors[0];
  const more = errors.length > 1 ? ` 等 ${errors.length} 处` : '';
  return h('div', { class: 'code-check', role: 'status' },
    h('span', { class: 'code-check-text', 'data-tip': errors.map(titleOf).join('\n') },
      `这个源没通过检查：${first?.name || first?.id || '契约失败'}${more}`),
    h('button', {
      type: 'button', class: 'btn ghost mini', 'data-action': 'source-check-detail',
      'data-tip': '检查结果\nWP3.6b 的源码视图会显示完整清单',
      onclick: () => toast(insp, `源码检查：${titleOf(first).slice(0, 180)}${more ? `（共 ${errors.length} 处）` : ''}`, 'error'),
    }, '查看详情'));
}

/** 源 row: `rain · p5 1.9.4` + runtime badge + 查看源码 (§2.1). */
function sourceRow(insp, manifest, sourceId) {
  const label = String(manifest?.label ?? '') || String(manifest?.id ?? '') || sourceId || '（未指定源）';
  const runtime = typeof manifest?.runtime === 'string' ? manifest.runtime : '';
  const lib = runtime && isRecord(manifest.libs) ? String(manifest.libs[runtime] ?? '') : '';
  const ctl = h('div', { class: 'code-src' },
    h('span', {
      class: `code-src-name${sourceId ? '' : ' dim'}`,
      'data-tip': sourceId ? `${label}（${sourceId}）` : '这个元素还没有源',
    }, label),
    runtime ? h('span', { class: 'code-rt', 'data-tip': `运行时 ${runtime}${lib ? ` ${lib}` : ''}` }, `${runtime}${lib ? ` ${lib}` : ''}`) : null,
    h('button', {
      type: 'button', class: 'btn ghost mini', 'data-action': 'code-view-source',
      'data-tip': '查看源码（只读）\nWP3.6b 提供',
      onclick: () => toast(insp, SOURCE_STUB),
    }, '查看源码'));
  return insp._row('源', ctl, null, 'w-full');
}

/** Render-state row (§2.1): live / bake / waiting (--warn) / fallback (--text-3). */
function renderRow(insp, el, time) {
  const state = h('span', { class: 'code-run-state' }, '—');
  const ms = h('span', {
    class: 'code-run-num',
    'data-tip': '最近一帧从请求到到达用了多久（光栅器渲染 + PNG 传输）',
  }, '—');
  const hit = h('span', {
    class: 'code-run-num',
    'data-tip': '缓存命中：预览这侧看不到光栅器是否命中（接口只回传图像）',
  }, '缓存命中 —');
  const node = h('span', { class: 'code-run' },
    state, h('span', { class: 'code-run-sep' }, '·'), ms,
    h('span', { class: 'code-run-sep' }, '·'), hit);
  const paint = () => {
    const st = insp.opts.rasterState?.(el, insp.opts.getTime?.() ?? time) || null;
    const status = st?.status || 'none';
    state.textContent = RUN_TEXT[status] || '—';
    state.className = `code-run-state${status === 'waiting' ? ' warn' : status === 'fallback' ? ' muted' : ''}`;
    state.dataset.tip = RUN_TIP[status] || '';
    ms.textContent = Number.isFinite(st?.ms) ? `${Number(st.ms).toFixed(1)} ms/帧` : '—';
  };
  paint();
  // The picture of a code layer arrives asynchronously: the row has to repaint
  // without a new revision (render loop → Inspector.syncLive).
  insp._live.push(paint);
  return insp._row('渲染', node, null, 'w-full');
}

/**
 * One manifest parameter as a property row (§2.1 exact list): number (with a
 * slider when the manifest gives `range`), colour, boolean, enum; strings,
 * fonts and vec2/vec3 get the closest plain control so every declared
 * parameter still owns exactly one row.
 */
function paramRow({ insp, project, el, decl, value, sourceId }) {
  const name = String(decl.id);
  const path = codeParamPath(name);
  const label = String(decl.label ?? '') || name;
  const keyable = decl.keyable === 'frame' || decl.keyable === 'shot';
  const tol = tolOf(project);
  const keyTime = () => insp._keyTime();
  // The op replaces the project object; keep asking the panel for the live one
  // so ◆ sees the keys the file has now (a key may arrive from CLI / agent ops).
  const host = () => insp._last?.project?.elements.find((e) => e.id === el.id) || el;
  const liveProject = () => insp._last?.project || project;
  let current = value === undefined ? decl.default : value;

  const write = (v) => {
    current = coerceParamValue(decl.type, v);
    insp._commit(`code:${el.id}:${name}`, {
      op: 'codeParamSet', id: el.id, name, value: current, t: keyTime(),
    });
  };

  const kf = keyable ? insp._kfButton(
    () => keyState(host(), path, keyTime(), tol),
    () => insp.opts.onOp({ op: 'keySet', id: el.id, path, t: keyTime(), value: current }),
    () => {
      const key = keyAt(host(), path, keyTime(), tol);
      if (key) insp.opts.onOp({ op: 'keyRemove', id: el.id, path, t: key.t });
    },
  ) : null;

  /** 右键：把当前值写回源 manifest 的 default（§7.1；一次可撤销的写源）。 */
  const setDefault = () => {
    const record = sourceRecord(liveProject(), sourceId);
    if (!record) { toast(insp, '源不在工程里，改不了默认值', 'warn'); return; }
    const declared = Array.isArray(record.manifest?.params) ? record.manifest.params : [];
    if (!declared.some((p) => String(p?.id) === name)) { toast(insp, `manifest 里没有参数 ${name}`, 'warn'); return; }
    const manifest = {
      ...record.manifest,
      params: declared.map((p) => (String(p?.id) === name ? { ...p, default: current } : p)),
    };
    // `sourceAdd` 是唯一能重写 manifest.json 的 op；`sourceWrite` 只写文本文件
    // （契约里明确拒绝 manifest.json），一次 op 仍然只是一次撤销。
    insp.opts.onOp({ op: 'sourceAdd', id: record.id, manifest, files: { ...(record.files || {}) } });
    toast(insp, `已把「${label}」的当前值设为默认（Ctrl+Z 撤销）`, 'success');
  };
  const menu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    insp._flush();
    showMenu(ev.clientX, ev.clientY, [
      {
        label: '把当前值设为默认',
        title: '写进源 manifest 的 default：以后新建的元素用这个值，现有元素不变',
        run: setDefault,
      },
    ]);
  };

  const type = String(decl.type ?? (typeof current === 'number' ? 'number' : 'string'));
  let ctl = null;
  let cls = 'w-full';

  if (NUMBER_TYPES.has(type)) {
    const range = rangeOf(decl);
    const step = stepOf(decl);
    // A `percent` parameter is stored 0..1 and shown ×100, so the input's own
    // min / max / step must be in display units too (numfield clamps the text).
    const percent = type === 'percent';
    const disp = percent ? 100 : 1;
    let slider = null;
    const box = insp._num({
      value: Number(current), step: step * disp,
      min: range ? range[0] * disp : undefined, max: range ? range[1] * disp : undefined,
      percent, aria: label,
      onChange: (v) => {
        if (slider) slider.value = String(v);
        write(v);
      },
    });
    if (range) {
      const input = box.querySelector('input');
      slider = h('input', {
        type: 'range', class: 'code-range',
        min: String(range[0]), max: String(range[1]), step: String(step),
        'aria-label': `${label} 滑杆`, 'data-tip': `${label}：${range[0]} – ${range[1]}`,
      });
      slider.value = String(Number(current));
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        if (input) writeNumber(input, v, { force: true });
        write(v);
      });
      // 松手才落 op：拖动过程里的 input 全部合并成一次撤销
      slider.addEventListener('change', () => insp._flush());
      ctl = h('span', { class: 'code-num' }, slider, box);
    } else {
      ctl = box;
      cls = 'w-half';
    }
  } else if (type === 'color') {
    ctl = insp._color(label, String(current ?? ''), write);
    cls = 'w-half';
  } else if (type === 'boolean') {
    const box = h('input', { type: 'checkbox', checked: !!current, 'aria-label': label });
    box.addEventListener('change', () => write(!!box.checked));
    ctl = h('span', { class: 'chk' }, box);
    cls = 'w-third';
  } else if (type === 'enum') {
    const options = Array.isArray(decl.options) ? decl.options : [];
    const select = h('select', { 'aria-label': label }, ...options.map((option) => {
      const v = isRecord(option) ? option.value : option;
      const text = isRecord(option) ? (option.label ?? option.value) : option;
      return h('option', { value: String(v), selected: String(v) === String(current) }, String(text));
    }));
    select.addEventListener('change', () => write(select.value));
    ctl = select;
  } else if (type === 'vec2' || type === 'vec3') {
    const length = type === 'vec3' ? 3 : 2;
    const base = Array.isArray(current) ? current.map(Number) : [];
    while (base.length < length) base.push(0);
    const items = base.slice(0, length).map((n, i) => ({
      axis: 'xyz'[i], value: n, step: stepOf(decl),
      onChange: (v) => {
        const next = (Array.isArray(current) ? current.slice() : base.slice()).slice(0, length);
        while (next.length < length) next.push(0);
        next[i] = v;
        write(next);
      },
    }));
    const row = insp._vec({ label, items, kfNode: kf });
    row.dataset.codeParam = name;
    row.addEventListener('contextmenu', menu);
    return row;
  } else {
    const box = h('input', { type: 'text', 'aria-label': label, spellcheck: 'false' });
    box.value = current === undefined || current === null ? '' : String(current);
    box.addEventListener('input', () => write(box.value));
    box.addEventListener('blur', () => insp._flush());
    ctl = box;
    cls = 'w-full';
  }

  const row = insp._row(label, ctl, kf, cls, null, false, path);
  row.dataset.codeParam = name;
  row.dataset.keyable = keyable ? '1' : '0';
  row.addEventListener('contextmenu', menu);
  return row;
}

/** The section body; registered once, painted for every selected code element. */
function renderSection({ insp, project, element, time }) {
  const el = element;
  const sourceId = String(el.code?.source ?? '');
  const manifest = codeManifest(project, el);
  const declared = sourceParams(project, sourceId);
  const values = codeParamsAt(project, el, time);
  const body = [];

  // Static half of `vdm source check` (§6.3-1): the renderer has the registered
  // files, so a sketch that reads the wall clock is called out right here —
  // before anyone asks the render pool why the frame is not deterministic.
  const scan = sourceId && manifest ? scanSourceFiles(sourceFiles(project, sourceId), { runtime: manifest.runtime }) : null;
  if (scan?.errors?.length) body.push(checkLine(insp, scan.errors));

  body.push(sourceRow(insp, manifest, sourceId));

  if (!sourceId) {
    body.push(h('div', { class: 'hint code-note' }, '这个元素还没有源：先在源里加一个 code 元素，或填 code.source'));
  } else if (!manifest) {
    body.push(h('div', { class: 'hint code-note' }, '找不到这个源的 manifest：参数要在源里声明'));
  } else if (!declared.length) {
    body.push(h('div', { class: 'hint code-note' }, '这个源没有声明参数'));
  } else {
    for (const decl of declared) {
      if (!isRecord(decl) || !decl.id) continue;
      body.push(paramRow({
        insp, project, el, decl, sourceId,
        value: values[String(decl.id)],
      }));
    }
  }

  body.push(renderRow(insp, el, time));
  insp.root.appendChild(insp._sec('代码图层', {}, ...body));
}

registerInspectorSection({
  id: 'code',
  order: 40,
  when: (sel) => !!sel.isElement && sel.element?.type === 'code',
  render: (ctx) => renderSection(ctx),
});
