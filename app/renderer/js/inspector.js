// Inspector: edit the selected element down to the details (or project fx when nothing is selected).
import { evalElement } from '/core/evaluate.js';
import { evalCamera } from '/core/camera.js';
import { objectPose } from '/core/scene.js';
import { RotBall } from './rotball.js';
import { SpeedCurve, SPEED_PRESETS } from './speedcurve.js';
import { escapeHtml } from './timeline.js';

const MOTIONS = ['none', 'in', 'out', 'left', 'right', 'up', 'down', 'drift', 'shake'];
const FONTS = ['SimHei', 'Microsoft YaHei', 'Arial', 'Impact', 'Bahnschrift', 'Consolas'];
const EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth', 'outExpo', 'inOutCubic', 'outBack'];

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export class Inspector {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.debounce = new Map();
    this.lastRenderKey = '';
  }

  _commit(key, op, delay = 180) {
    const prev = this.debounce.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.debounce.delete(key);
      this.opts.onOp(op);
    }, delay);
    this.debounce.set(key, t);
  }

  _flush() {
    for (const [, t] of this.debounce) clearTimeout(t);
    this.debounce.clear();
  }

  render(project, sel, time) {
    this._last = { project, sel, time };
    const active = document.activeElement;
    if (this._ballDragging || this._speedDragging) return;
    if (this.root.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active?.tagName || '')) return;
    const key = `${project.rev}|${sel?.camera ? 'cam' : ''}|${sel?.elementId}|${sel?.objectId}|${sel?.segmentId}|${Math.round(time * 10)}`;
    if (key === this.lastRenderKey) return;
    this.lastRenderKey = key;
    this.root.innerHTML = '';
    const object = (project.scene?.objects || []).find((o) => o.id === sel?.objectId);
    const element = project.elements.find((e) => e.id === sel?.elementId);
    if (object) this._renderObject(project, object, time);
    else if (element) this._renderElement(project, element, time);
    else if (sel?.segmentId) this._renderSegment(project, sel.segmentId);
    else if (project.camera) this._renderCamera(project, time);
    else this._renderProject(project);
  }

  // ---------- shared bits ----------
  _section(title, ...kids) {
    const s = h('div', { class: 'sec' }, h('div', { class: 'sec-title' }, title), ...kids);
    return s;
  }

  _field({ label, value, type = 'number', step = 0.01, min, max, path, kf, options, onChange, placeholder, span = 2 }) {
    let input;
    if (type === 'select') {
      input = h('select', {}, ...options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return h('option', { value: v, selected: String(v) === String(value) }, l);
      }));
    } else if (type === 'textarea') {
      input = h('textarea', { rows: 2, placeholder: placeholder || '' }); input.value = value ?? '';
    } else if (type === 'color') {
      input = h('input', { type: 'color', value: value || '#ffffff' });
    } else if (type === 'checkbox') {
      input = h('input', { type: 'checkbox', checked: !!value });
    } else {
      input = h('input', { type: type === 'text' ? 'text' : 'number', step: type === 'text' ? null : step, min, max, placeholder: placeholder || '' });
      input.value = value ?? '';
    }
    const emit = () => {
      const v = type === 'checkbox' ? input.checked
        : type === 'number' ? (input.value === '' ? null : Number(input.value))
          : input.value;
      if (v == null || (type === 'number' && Number.isNaN(v))) return;
      onChange(v);
    };
    if (type === 'select') input.addEventListener('change', emit);
    else if (type === 'checkbox' || type === 'color') input.addEventListener('change', emit);
    else input.addEventListener('input', emit);
    input.addEventListener('blur', () => this._flush());

    const kfBtn = kf ? h('button', {
      class: 'kf-btn', title: '在当前时间记录关键帧（Shift+点击删除）',
      onclick: (e) => {
        if (e.shiftKey) this.opts.onOp({ op: 'keyRemove', id: this._elId, path });
        else this.opts.onOp({ op: 'keySet', id: this._elId, path, t: Math.round(this.opts.getTime() * 1000) / 1000, value: this.opts.getTimeValue(path) });
      },
    }, '◆') : null;
    return h('div', { class: `fld span${span}` }, h('label', {}, label), input, kfBtn);
  }

  _refresh() {
    if (!this._last) return;
    this.lastRenderKey = '';
    this.render(this._last.project, this._last.sel, this._last.time);
  }

  _renderElement(project, el, time) {
    this._elId = el.id;
    const st = evalElement(el, time, project.meta);
    const typeLabel = { image: '图片', video: '视频', text: '文字', shape: '形状', solid: '色块' }[el.type] || el.type;
    const head = h('div', { class: 'insp-head' },
      h('div', { class: 'insp-kind' }, typeLabel),
      h('div', { class: 'insp-id' }, el.id),
      h('div', { class: 'insp-actions' },
        h('button', { class: 'mini', onclick: () => this.opts.onOp({ op: 'duplicateElement', id: el.id, start: Math.round((el.start + el.duration) * 1000) / 1000 }) }, '复制'),
        h('button', { class: 'mini danger', onclick: () => { if (confirm(`删除 ${el.name}?`)) this.opts.onOp({ op: 'removeElement', id: el.id }); } }, '删除'),
      ),
    );
    this.root.appendChild(head);

    const set = (path, patch) => this._commit(`${el.id}:${path}`, { op: 'updateElement', id: el.id, patch });
    const setPath = (path) => (v) => this._commit(`${el.id}:${path}`, { op: 'set', id: el.id, path, value: v });

    this.root.appendChild(this._section('基础',
      this._field({ label: '名称', type: 'text', value: el.name, onChange: (v) => set('name', { name: v }) }),
      this._field({
        label: '所属分镜', type: 'select', value: el.segment || '', options: [{ value: '', label: '—' }, ...project.segments.map((s) => ({ value: s.id, label: `${s.name} (${s.start.toFixed(1)}s)` }))],
        onChange: (v) => set('segment', { segment: v || null }),
      }),
      this._field({ label: '开始 (s)', value: round(el.start), step: 0.01, min: 0, onChange: (v) => this._commit(`${el.id}:start`, { op: 'moveElement', id: el.id, start: v }) }),
      this._field({ label: '时长 (s)', value: round(el.duration), step: 0.01, min: 0.05, onChange: (v) => this._commit(`${el.id}:dur`, { op: 'moveElement', id: el.id, duration: v }) }),
      this._field({ label: '层级 z', value: el.z, step: 1, onChange: (v) => this._commit(`${el.id}:z`, { op: 'moveElement', id: el.id, z: v }) }),
      this._field({ label: '淡入 (s)', value: el.fadeIn || 0, step: 0.05, min: 0, onChange: (v) => set('fade', { fadeIn: v }) }),
      this._field({ label: '淡出 (s)', value: el.fadeOut || 0, step: 0.05, min: 0, onChange: (v) => set('fade', { fadeOut: v }) }),
    ));

    this.root.appendChild(this._section('变换',
      this._field({ label: 'X', value: round(st.x), kf: true, path: 'transform.x', onChange: (v) => set('tr', { transform: { x: v } }) }),
      this._field({ label: 'Y', value: round(st.y), kf: true, path: 'transform.y', onChange: (v) => set('tr', { transform: { y: v } }) }),
      this._field({ label: '缩放', value: round(st.scale, 3), step: 0.01, kf: true, path: 'transform.scale', onChange: (v) => set('tr', { transform: { scale: v } }) }),
      this._field({ label: '旋转°', value: round(st.rotation, 2), step: 0.5, kf: true, path: 'transform.rotation', onChange: (v) => set('tr', { transform: { rotation: v } }) }),
      this._field({ label: '不透明度', value: round(st.opacity, 3), step: 0.01, min: 0, max: 1, kf: true, path: 'transform.opacity', onChange: (v) => set('tr', { transform: { opacity: v } }) }),
      this._field({ label: '跟随节拍', value: el.punch || 0, step: 0.05, min: 0, max: 2, onChange: (v) => set('punch', { punch: v }) }),
    ));

    this.root.appendChild(this._section('运动',
      this._field({
        label: '预设', type: 'select', value: el.motion?.type || 'none',
        options: MOTIONS.map((m) => ({ value: m, label: ({ none: '无', in: '推近', out: '拉远', left: '左移', right: '右移', up: '上移', down: '下移', drift: '漂移', shake: '手持抖动' })[m] })),
        onChange: (v) => set('motion.type', { motion: { ...el.motion, type: v } }),
      }),
      this._field({ label: '幅度', value: el.motion?.amount || 0, step: 0.01, min: 0, max: 1, onChange: (v) => set('motion.amount', { motion: { ...el.motion, amount: v } }) }),
    ));

    if (el.type === 'text') {
      this.root.appendChild(this._section('文字',
        this._field({ label: '内容', type: 'textarea', span: 3, value: el.style.text, onChange: (v) => set('style.text', { style: { text: v } }) }),
        this._field({ label: '字体', type: 'select', value: el.style.font, options: FONTS, onChange: (v) => set('style.font', { style: { font: v } }) }),
        this._field({ label: '字号', value: el.style.size, step: 1, kf: true, path: 'style.size', onChange: (v) => set('style.size', { style: { size: v } }) }),
        this._field({ label: '颜色', type: 'color', value: el.style.color, onChange: (v) => set('style.color', { style: { color: v } }) }),
        this._field({
          label: '对齐', type: 'select', value: el.style.align, options: [{ value: 'center', label: '居中' }, { value: 'left', label: '左' }, { value: 'right', label: '右' }],
          onChange: (v) => set('style.align', { style: { align: v } }),
        }),
        this._field({ label: '字距', value: el.style.letterSpacing || 0, step: 1, onChange: (v) => set('style.ls', { style: { letterSpacing: v } }) }),
        this._field({ label: '行高', value: el.style.lineHeight || 1.18, step: 0.02, onChange: (v) => set('style.lh', { style: { lineHeight: v } }) }),
        this._field({ label: '阴影', value: el.style.shadow || 0, step: 0.1, min: 0, max: 4, onChange: (v) => set('style.sh', { style: { shadow: v } }) }),
        this._field({ label: '字重', value: el.style.weight || 400, step: 100, onChange: (v) => set('style.w', { style: { weight: v } }) }),
      ));
    } else if (el.type === 'image' || el.type === 'video') {
      this.root.appendChild(this._section('画面',
        this._field({
          label: '适配', type: 'select', value: el.style.fit, options: [{ value: 'cover', label: '填满裁剪' }, { value: 'stretch', label: '拉伸' }],
          onChange: (v) => set('style.fit', { style: { fit: v } }),
        }),
        this._field({ label: '素材', type: 'text', span: 3, value: el.src || '', onChange: (v) => set('src', { src: v }) }),
        this._field({ label: '源入点 (s)', value: el.srcIn || 0, step: 0.05, onChange: (v) => set('srcIn', { srcIn: v }) }),
      ));
    } else {
      this.root.appendChild(this._section('形状',
        this._field({
          label: '类型', type: 'select', value: el.style.shape, options: [{ value: 'rect', label: '矩形' }, { value: 'ellipse', label: '椭圆' }],
          onChange: (v) => set('style.shape', { style: { shape: v } }),
        }),
        this._field({ label: '填充', type: 'color', value: el.style.fill, onChange: (v) => set('style.fill', { style: { fill: v } }) }),
        this._field({ label: '宽 (px)', value: el.style.w || project.meta.width, step: 10, onChange: (v) => set('style.w', { style: { w: v } }) }),
        this._field({ label: '高 (px)', value: el.style.h || project.meta.height, step: 10, onChange: (v) => set('style.h', { style: { h: v } }) }),
        this._field({ label: '圆角', value: el.style.radius || 0, step: 1, onChange: (v) => set('style.r', { style: { radius: v } }) }),
      ));
    }

    this.root.appendChild(this._section('效果',
      this._field({ label: '辉光', value: el.fx?.glow || 0, step: 0.05, min: 0, max: 2, kf: true, path: 'fx.glow', onChange: (v) => set('fx.glow', { fx: { ...el.fx, glow: v } }) }),
      this._field({
        label: '混合', type: 'select', value: el.style.blend || 'normal',
        options: [{ value: 'normal', label: '正常' }, { value: 'add', label: '相加' }, { value: 'screen', label: '滤色' }],
        onChange: (v) => set('style.blend', { style: { blend: v } }),
      }),
    ));

    this._renderKeyframes(project, el, time);
  }

  // ---------------------------------------------------------------- 3D object
  _renderObject(project, obj, time) {
    const id = obj.id;
    const pose = objectPose(obj, time);
    const tNow = () => Math.round(this.opts.getTime() * 1000) / 1000;
    const key = (path, v) => this.opts.onOp({ op: 'objectKey', id, path, t: tNow(), v });
    const patch = (tag, p) => this._commit(`${id}:${tag}`, { op: 'objectPatch', id, patch: p });

    this.root.appendChild(h('div', { class: 'insp-head' },
      h('div', { class: 'insp-kind' }, '3D 元素'),
      h('div', { class: 'insp-id' }, id),
      h('div', { class: 'insp-actions' },
        h('button', {
          class: 'mini', title: '在当前时间记录位置关键帧',
          onclick: () => this.opts.onOp({ op: 'objectKey', id, path: 'pivot', t: tNow(), v: pose.pivot.map(round) }),
        }, '打点'),
        h('button', {
          class: 'mini', title: '复制这个元素（含关键帧）',
          onclick: async () => {
            const copy = JSON.parse(JSON.stringify(obj));
            copy.id = `ob_${Date.now().toString(36)}`;
            copy.name = `${obj.name || '元素'} 副本`;
            copy.pivot = [copy.pivot[0] + 10, copy.pivot[1], copy.pivot[2]];
            const res = await this.opts.onOp({ op: 'objectAdd', object: copy });
            if (res) this.opts.onSelect?.({ objectId: copy.id });
          },
        }, '复制'),
        h('button', {
          class: 'mini danger',
          onclick: () => { if (confirm(`删除 ${obj.name || id}?`)) this.opts.onOp({ op: 'objectRemove', id }); },
        }, '删除'),
      ),
    ));

    this.root.appendChild(this._section('基础',
      this._field({ label: '名称', type: 'text', value: obj.name, onChange: (v) => patch('name', { name: v }) }),
      this._field({
        label: '颜色', type: 'color', value: obj.style?.color || '#17d9ff',
        onChange: (v) => patch('color', { style: { ...(obj.style || {}), color: v } }),
      }),
      this._field({ label: '起点 (s)', value: round(obj.start), step: 0.01, min: 0, onChange: (v) => patch('start', { start: v }) }),
      this._field({ label: '时长 (s)', value: round(obj.duration), step: 0.01, min: 0.05, onChange: (v) => patch('dur', { duration: v }) }),
    ));

    const vec = (label, arr, path) => {
      const cur = arr.map((v) => Math.round(v * 1000) / 1000);
      const inputs = cur.map((v, i) => {
        const inp = h('input', { type: 'number', step: 0.1 });
        inp.value = v;
        inp.addEventListener('input', () => { cur[i] = Number(inp.value) || 0; key(path, cur); });
        inp.addEventListener('blur', () => this._flush());
        return inp;
      });
      return h('div', { class: 'fld span2' }, h('label', {}, label), ...inputs,
        h('button', {
          class: 'kf-btn', title: `在当前时间记录${label}（Shift+点击删除）`,
          onclick: (e) => {
            if (e.shiftKey) this.opts.onOp({ op: 'objectUnkey', id, path, t: tNow() });
            else key(path, cur);
          },
        }, '◆'));
    };

    this.root.appendChild(this._section('变换（m）',
      vec('位置', pose.pivot, 'pivot'),
      vec('几何偏移', pose.position, 'position'),
      vec('缩放', pose.scale, 'scale'),
      this._field({
        label: '不透明度', value: Math.round(pose.opacity * 1000) / 1000, step: 0.01, min: 0, max: 1,
        onChange: (v) => key('opacity', v),
      }),
      this._field({
        label: '绕轴自转°', value: Math.round(pose.roll * 10) / 10, step: 1,
        onChange: (v) => key('roll', v),
      }),
      h('div', { class: 'row-btns' },
        h('button', {
          class: 'mini', title: '让元素正面朝向当前镜头（在当前时间写方向关键帧）',
          onclick: () => {
            const cam = this.opts.getViewCam?.();
            if (!cam) return;
            const d = [cam.pos[0] - pose.worldPos[0], cam.pos[1] - pose.worldPos[1], cam.pos[2] - pose.worldPos[2]];
            const l = Math.hypot(d[0], d[1], d[2]) || 1;
            key('dir', d.map((v) => v / l));
          },
        }, '面向镜头'),
        h('button', {
          class: 'mini', title: '把盒子底面放到 y=0（在当前时间写位置关键帧）',
          onclick: () => key('pivot', [pose.pivot[0], (Number(obj.geom?.h) || 2) / 2, pose.pivot[2]]),
        }, '落地'),
        h('button', {
          class: 'mini', title: '删除播放头这一帧的位置关键帧',
          onclick: () => this.opts.onOp({ op: 'objectUnkey', id, path: 'pivot', t: tNow() }),
        }, '删本帧'),
      ),
      h('div', { class: 'hint' }, '在视口里拖动元素会自动在播放头打位置关键帧；◆ 记录当前值。'),
    ));

    const g = obj.geom || {};
    this.root.appendChild(this._section('几何（m）',
      this._field({ label: '宽', value: g.w ?? 2, step: 0.1, min: 0.01, onChange: (v) => patch('gw', { geom: { ...g, w: v } }) }),
      this._field({ label: '高', value: g.h ?? 2, step: 0.1, min: 0.01, onChange: (v) => patch('gh', { geom: { ...g, h: v } }) }),
      this._field({ label: '厚', value: g.d ?? 2, step: 0.1, min: 0.01, onChange: (v) => patch('gd', { geom: { ...g, d: v } }) }),
    ));

    const dirKeys = (obj.tracks?.dir || []).filter((k) => Array.isArray(k.v));
    const ballHost = h('div', { class: 'rotball-wrap' });
    new RotBall(ballHost, {
      dir: pose.dir,
      keys: dirKeys,
      time,
      onStart: () => { this._ballDragging = true; },
      onEnd: () => { this._ballDragging = false; },
      onChange: (d) => this._commit(`${id}:dir`, { op: 'objectKey', id, path: 'dir', t: tNow(), v: d }, 90),
    });
    this.root.appendChild(this._section('朝向（球面）',
      ballHost,
      h('div', { class: 'hint' }, '拖动球面上的点改朝向；小菱形是已有的方向关键帧。'),
    ));

    const rows = [];
    for (const [path, list] of Object.entries(obj.tracks || {})) {
      for (const k of list || []) rows.push({ path, k });
    }
    rows.sort((a, b) => a.k.t - b.k.t);
    const kfList = h('div', { class: 'kf-list' });
    if (!rows.length) kfList.appendChild(h('div', { class: 'hint' }, '还没有关键帧：拖动元素或点 ◆。'));
    for (const { path, k } of rows) {
      const open = this._speedOpen && this._speedOpen.id === id
        && this._speedOpen.path === path && Math.abs(this._speedOpen.t - k.t) < 1e-3;
      const row = h('div', { class: `kf-row ${Math.abs(k.t - time) < 0.05 ? 'at' : ''}`, style: 'grid-template-columns: 46px 1fr 1fr 58px 26px 22px' },
        h('button', {
          class: 'kf-t', title: '跳到这个关键帧', style: 'background:none;border:0;color:inherit;cursor:pointer;padding:0;text-align:left',
          onclick: () => this.opts.onSeek?.(k.t),
        }, k.t.toFixed(2)),
        h('span', { class: 'kf-p' }, path),
        h('span', { class: 'kf-v' }, Array.isArray(k.v) ? k.v.map((n) => round(n, 2)).join(', ') : String(k.v)),
        h('select', {
          class: 'kf-ease', title: '到下一关键帧的 ease 预设（该键有速度曲线时被忽略）',
          onchange: (e) => this.opts.onOp({ op: 'objectKey', id, path, t: k.t, v: k.v, ease: e.target.value }),
        }, ...EASES.map((x) => h('option', { value: x, selected: (k.ease || 'easeInOut') === x }, x))),
        h('button', {
          class: `mini ${open ? 'on' : ''}`, title: '编辑这一段的速度曲线',
          onclick: () => { this._speedOpen = open ? null : { id, path, t: k.t }; this._refresh(); },
        }, '∿'),
        h('button', { class: 'mini danger', onclick: () => this.opts.onOp({ op: 'objectUnkey', id, path, t: k.t }) }, '×'),
      );
      kfList.appendChild(row);
      if (open) {
        const wrap = h('div', { class: 'speed-wrap' });
        new SpeedCurve(wrap, {
          points: k.speed,
          onStart: () => { this._speedDragging = true; },
          onEnd: () => { this._speedDragging = false; },
          onChange: (pts) => this._commit(
            `${id}:speed:${path}:${k.t}`,
            { op: 'objectKey', id, path, t: k.t, v: k.v, speed: pts },
            90,
          ),
        });
        const setPreset = (pts) => this.opts.onOp({ op: 'objectKey', id, path, t: k.t, v: k.v, speed: pts });
        wrap.appendChild(h('div', { class: 'row-btns' },
          h('button', { class: 'mini', onclick: () => setPreset(SPEED_PRESETS.linear) }, '匀速'),
          h('button', { class: 'mini', onclick: () => setPreset(SPEED_PRESETS.easeIn) }, '慢入'),
          h('button', { class: 'mini', onclick: () => setPreset(SPEED_PRESETS.easeOut) }, '慢出'),
          h('button', { class: 'mini', onclick: () => setPreset(SPEED_PRESETS.punch) }, '冲击'),
          h('button', { class: 'mini', onclick: () => this.opts.onOp({ op: 'objectKey', id, path, t: k.t, v: k.v, speed: null }) }, '清除'),
        ));
        kfList.appendChild(wrap);
      }
    }
    this.root.appendChild(this._section(`关键帧 (${rows.length})`, kfList));
  }

  _renderKeyframes(project, el, time) {
    const kfs = [...(el.keyframes || [])].sort((a, b) => a.t - b.t);
    const list = h('div', { class: 'kf-list' });
    if (!kfs.length) list.appendChild(h('div', { class: 'hint' }, '还没有关键帧。点字段右边的 ◆ 在当前时间记录。'));
    for (const k of kfs) {
      list.appendChild(h('div', { class: `kf-row ${Math.abs(k.t - time) < 0.05 ? 'at' : ''}` },
        h('span', { class: 'kf-t' }, k.t.toFixed(2) + 's'),
        h('span', { class: 'kf-p' }, k.path),
        h('span', { class: 'kf-v' }, String(k.value).slice(0, 14)),
        h('select', {
          class: 'kf-ease',
          onchange: (e) => this.opts.onOp({ op: 'keySet', id: el.id, path: k.path, t: k.t, value: k.value, ease: e.target.value }),
        }, ...EASES.map((e) => h('option', { value: e, selected: e === k.ease }, e))),
        h('button', { class: 'mini', onclick: () => this.opts.onOp({ op: 'keySet', id: el.id, path: k.path, t: round(time), value: k.value, ease: k.ease }) }, '在此'),
        h('button', { class: 'mini danger', onclick: () => this.opts.onOp({ op: 'keyRemove', id: el.id, path: k.path }) }, '×'),
      ));
    }
    this.root.appendChild(this._section(`关键帧 (${kfs.length})`, list));
  }

  _renderCamera(project, time) {
    const cam = project.camera;
    const st = evalCamera(project, time);
    this.root.appendChild(h('div', { class: 'insp-head' },
      h('div', { class: 'insp-kind' }, '镜头'),
      h('div', { class: 'insp-id' }, `${cam.path.length} 关键点`),
      h('div', { class: 'insp-actions' },
        h('button', { class: 'mini', onclick: () => this.opts.onOp({ op: 'cameraKey', t: round(time), pos: st.pos.map(round) }) }, '在此打点'),
        h('button', { class: 'mini', onclick: () => this.opts.onRenderAll?.() }, '渲染'),
      ),
    ));

    const setCam = (patch) => this._commit('cam', { op: 'cameraSet', patch });
    this.root.appendChild(this._section('相机',
      this._field({ label: '视场角 FOV', value: cam.fov, step: 1, min: 1, max: 360, onChange: (v) => setCam({ fov: v }) }),
      h('div', { class: 'hint' }, '≥180° 自动切等距鱼眼（可到 360°）；Blender 侧用 Cycles 渲这一档。'),
      this._field({ label: '看向前方 (m)', value: cam.lookAhead, step: 5, min: 2, max: 500, onChange: (v) => setCam({ lookAhead: v }) }),
      this._field({ label: '转弯侧倾', value: cam.bankGain, step: 0.1, min: 0, max: 4, onChange: (v) => setCam({ bankGain: v }) }),
      this._field({ label: '最大侧倾°', value: cam.maxRoll, step: 1, min: 0, max: 60, onChange: (v) => setCam({ maxRoll: v }) }),
      this._field({ label: '手动 roll°', value: cam.roll || 0, step: 1, min: -60, max: 60, onChange: (v) => setCam({ roll: v }) }),
    ));

    this.root.appendChild(this._section('抖动 / 景深 / 模糊',
      this._field({ label: '抖动幅度', value: cam.shake.amp, step: 0.05, min: 0, max: 5, onChange: (v) => setCam({ shake: { ...cam.shake, amp: v } }) }),
      this._field({ label: '抖动频率', value: cam.shake.freq, step: 0.1, min: 0.1, max: 8, onChange: (v) => setCam({ shake: { ...cam.shake, freq: v } }) }),
      this._field({ label: '随速度增强', value: cam.shake.speedGain, step: 0.1, min: 0, max: 2, onChange: (v) => setCam({ shake: { ...cam.shake, speedGain: v } }) }),
      this._field({ label: '随机种子', value: cam.shake.seed, step: 1, onChange: (v) => setCam({ shake: { ...cam.shake, seed: v } }) }),
      this._field({ label: '景深', type: 'select', value: String(!!cam.dof.enabled), options: [{ value: 'false', label: '关' }, { value: 'true', label: '开' }], onChange: (v) => setCam({ dof: { ...cam.dof, enabled: v === 'true' } }) }),
      this._field({ label: '光圈 f', value: cam.dof.fstop, step: 0.2, min: 0.5, max: 32, onChange: (v) => setCam({ dof: { ...cam.dof, fstop: v } }) }),
      this._field({ label: '运动模糊', type: 'select', value: String(!!cam.motionBlur.enabled), options: [{ value: 'true', label: '开' }, { value: 'false', label: '关' }], onChange: (v) => setCam({ motionBlur: { ...cam.motionBlur, enabled: v === 'true' } }) }),
      this._field({ label: '快门角', value: cam.motionBlur.shutter, step: 0.05, min: 0, max: 1, onChange: (v) => setCam({ motionBlur: { ...cam.motionBlur, shutter: v } }) }),
    ));

    const keys = [...cam.path].sort((a, b) => a.t - b.t);
    const rows = h('div', { class: 'kf-list' });
    for (const k of keys) {
      const open = this._speedOpen && this._speedOpen.id === 'camera'
        && this._speedOpen.path === 'pos' && Math.abs(this._speedOpen.t - k.t) < 1e-3;
      const withSpeed = (pts) => keys.map((x) => (x === k ? { ...x, speed: pts } : x));
      const row = h('div', { class: `kf-row ${Math.abs(k.t - time) < 0.08 ? 'at' : ''}`, style: 'grid-template-columns: 46px 1fr 1fr 1fr 58px 26px 22px' },
        h('button', {
          class: 'kf-t', title: '跳到这个关键点', style: 'background:none;border:0;color:inherit;cursor:pointer;padding:0;text-align:left',
          onclick: () => this.opts.onSeek?.(k.t),
        }, k.t.toFixed(2)),
        h('input', { class: 'kf-ease', type: 'number', step: 1, value: round(k.pos[0]) }),
        h('input', { class: 'kf-ease', type: 'number', step: 1, value: round(k.pos[1]) }),
        h('input', { class: 'kf-ease', type: 'number', step: 1, value: round(k.pos[2]) }),
        h('select', {
          class: 'kf-ease', title: '这一段到下一关键点的 ease 预设（有速度曲线时被忽略）',
          onchange: (e) => this.opts.onOp({ op: 'cameraPath', path: keys.map((x) => (x === k ? { ...x, ease: e.target.value } : x)) }),
        }, ...EASES.map((x) => h('option', { value: x, selected: (k.ease || 'easeInOut') === x }, x))),
        h('button', {
          class: `mini ${open ? 'on' : ''}`, title: '编辑这一段的速度曲线',
          onclick: () => { this._speedOpen = open ? null : { id: 'camera', path: 'pos', t: k.t }; this._refresh(); },
        }, '∿'),
        h('button', { class: 'mini danger', onclick: () => this.opts.onOp({ op: 'cameraRemove', t: k.t }) }, '×'),
      );
      const inputs = row.querySelectorAll('input');
      inputs.forEach((inp, axis) => {
        inp.addEventListener('change', () => {
          const pos = k.pos.slice();
          pos[axis] = Number(inp.value) || 0;
          this.opts.onOp({ op: 'cameraKey', t: k.t, pos, look: k.look || null, fov: k.fov ?? null });
        });
      });
      rows.appendChild(row);
      if (open) {
        const wrap = h('div', { class: 'speed-wrap' });
        new SpeedCurve(wrap, {
          points: k.speed,
          onStart: () => { this._speedDragging = true; },
          onEnd: () => { this._speedDragging = false; },
          onChange: (pts) => this._commit(`cam:speed:${k.t}`, { op: 'cameraPath', path: withSpeed(pts) }, 90),
        });
        const preset = (pts) => this.opts.onOp({ op: 'cameraPath', path: withSpeed(pts) });
        wrap.appendChild(h('div', { class: 'row-btns' },
          h('button', { class: 'mini', onclick: () => preset(SPEED_PRESETS.linear) }, '匀速'),
          h('button', { class: 'mini', onclick: () => preset(SPEED_PRESETS.easeIn) }, '慢入'),
          h('button', { class: 'mini', onclick: () => preset(SPEED_PRESETS.easeOut) }, '慢出'),
          h('button', { class: 'mini', onclick: () => preset(SPEED_PRESETS.punch) }, '冲击'),
          h('button', { class: 'mini', onclick: () => this.opts.onOp({ op: 'cameraPath', path: withSpeed(null) }) }, '清除'),
        ));
        rows.appendChild(wrap);
      }
    }
    this.root.appendChild(this._section(`轨道关键点 (${keys.length})`, rows,
      h('div', { class: 'hint' }, '每行是 x / y / z（米）；下拉框是该段到下一关键点的速度曲线。')));

    const w = project.world;
    const setW = (patch) => this._commit('world', { op: 'worldSet', patch });
    this.root.appendChild(this._section('世界',
      this._field({ label: 'seed', value: w.seed, step: 1, onChange: (v) => setW({ seed: v }) }),
      h('div', { class: 'row-btns' }, h('button', { class: 'mini', onclick: () => setW({ seed: Math.floor(Math.random() * 9999) }) }, '换一座城')),
      this._field({ label: '航线避让', type: 'select', value: String(!!w.corridor.enabled), options: [{ value: 'true', label: '开' }, { value: 'false', label: '关' }], onChange: (v) => setW({ corridor: { ...w.corridor, enabled: v === 'true' } }) }),
      this._field({ label: '避让半径 (m)', value: w.corridor.radius, step: 1, min: 0, max: 120, onChange: (v) => setW({ corridor: { ...w.corridor, radius: v } }) }),
      h('div', { class: 'hint' }, '航线穿过或擦到的楼会被清掉，换 seed 也不会把塔吊在无人机航线上。'),
      this._field({ label: '街区 (m)', value: w.grid.block, step: 2, onChange: (v) => setW({ grid: { ...w.grid, block: v } }) }),
      this._field({ label: '街道 (m)', value: w.grid.street, step: 2, onChange: (v) => setW({ grid: { ...w.grid, street: v } }) }),
      this._field({ label: '密度', value: w.density, step: 0.02, min: 0, max: 1, onChange: (v) => setW({ density: v }) }),
      this._field({ label: '最低楼高', value: w.height.min, step: 2, onChange: (v) => setW({ height: { ...w.height, min: v } }) }),
      this._field({ label: '最高楼高', value: w.height.max, step: 5, onChange: (v) => setW({ height: { ...w.height, max: v } }) }),
      this._field({ label: '亮窗比例', value: w.window.density, step: 0.02, min: 0, max: 1, onChange: (v) => setW({ window: { ...w.window, density: v } }) }),
      this._field({ label: '窗光强度', value: w.window.glow, step: 0.1, onChange: (v) => setW({ window: { ...w.window, glow: v } }) }),
      this._field({ label: '霓虹强度', value: w.neon.glow, step: 0.1, onChange: (v) => setW({ neon: { ...w.neon, glow: v } }) }),
      this._field({ label: '雾开始 (m)', value: w.fog.start ?? 30, step: 5, min: 0, max: 500, onChange: (v) => setW({ fog: { ...w.fog, start: v } }) }),
      this._field({ label: '雾深度 (m)', value: w.fog.depth ?? 700, step: 25, min: 10, max: 5000, onChange: (v) => setW({ fog: { ...w.fog, depth: v } }) }),
      this._field({ label: '雾强度', value: w.fog.strength ?? 1, step: 0.05, min: 0, max: 1, onChange: (v) => setW({ fog: { ...w.fog, strength: v } }) }),
    ));
  }

  _renderSegment(project, id) {
    const s = project.segments.find((x) => x.id === id);
    if (!s) return;
    this.root.appendChild(h('div', { class: 'insp-head' },
      h('div', { class: 'insp-kind' }, '分镜'), h('div', { class: 'insp-id' }, s.id)));
    const set = (patch) => this._commit(`${s.id}:seg`, { op: 'updateSegment', id: s.id, patch });
    this.root.appendChild(this._section('分镜',
      this._field({ label: '名称', type: 'text', value: s.name, onChange: (v) => set({ name: v }) }),
      this._field({ label: '意图 / 台词', type: 'textarea', span: 3, value: s.intent, onChange: (v) => set({ intent: v }) }),
      this._field({ label: '开始 (s)', value: round(s.start), onChange: (v) => this._commit(`${s.id}:st`, { op: 'updateSegment', id: s.id, patch: { start: v } }) }),
      this._field({ label: '时长 (s)', value: round(s.duration), onChange: (v) => this._commit(`${s.id}:du`, { op: 'updateSegment', id: s.id, patch: { duration: v } }) }),
      this._field({
        label: '状态', type: 'select', value: s.status, options: ['draft', 'previewed', 'approved'],
        onChange: (v) => set({ status: v }),
      }),
    ));
    const kids = project.elements.filter((e) => e.segment === s.id);
    this.root.appendChild(this._section(`本段元素 (${kids.length})`,
      h('div', { class: 'chip-list' }, ...kids.map((k) => h('button', {
        class: 'chip', onclick: () => this.opts.onSelect({ elementId: k.id, segmentId: s.id }),
      }, `${k.id} ${k.type === 'text' ? JSON.stringify(String(k.style.text).slice(0, 10)) : ''}`)))));
    this.root.appendChild(h('div', { class: 'insp-actions wide' },
      h('button', { class: 'mini', onclick: () => this.opts.onRenderSegment(s.id) }, '渲染本段'),
      h('button', { class: 'mini', onclick: () => this.opts.onAskAI(s.id) }, '让 AI 改这段'),
    ));
  }

  _renderProject(project) {
    const fx = project.meta.fx || {};
    this.root.appendChild(h('div', { class: 'insp-head' },
      h('div', { class: 'insp-kind' }, '项目'), h('div', { class: 'insp-id' }, project.meta.title)));
    const setMeta = (path) => (v) => this._commit(`meta:${path}`, { op: 'setMeta', path, value: v });
    const setFx = (k) => (v) => this._commit(`fx:${k}`, { op: 'setFx', fx: { [k]: v } });

    this.root.appendChild(this._section('项目',
      this._field({ label: '标题', type: 'text', value: project.meta.title, onChange: setMeta('title') }),
      this._field({ label: '时长 (s)', value: round(project.meta.duration), onChange: setMeta('duration') }),
      this._field({ label: '背景色', type: 'color', value: project.meta.background, onChange: setMeta('background') }),
      this._field({ label: '帧率', type: 'text', value: String(project.meta.fps), onChange: setMeta('fps') }),
    ));

    this.root.appendChild(this._section('画面效果',
      this._field({ label: '辉光 bloom', value: fx.bloom, step: 0.05, min: 0, max: 2, onChange: setFx('bloom') }),
      this._field({ label: '色散 ca', value: fx.ca, step: 0.02, min: 0, max: 1, onChange: setFx('ca') }),
      this._field({ label: '颗粒 grain', value: fx.grain, step: 0.01, min: 0, max: 1, onChange: setFx('grain') }),
      this._field({ label: '暗角 vignette', value: fx.vignette, step: 0.02, min: 0, max: 1, onChange: setFx('vignette') }),
      this._field({ label: '扫描线 scanline', value: fx.scanline, step: 0.02, min: 0, max: 1, onChange: setFx('scanline') }),
      this._field({ label: '冷暖 grade', value: fx.grade, step: 0.02, min: -1, max: 1, onChange: setFx('grade') }),
      this._field({ label: '对比 contrast', value: fx.contrast, step: 0.02, min: -1, max: 1, onChange: setFx('contrast') }),
      this._field({ label: '饱和 saturation', value: fx.saturation, step: 0.02, min: 0, max: 2, onChange: setFx('saturation') }),
    ));

    this.root.appendChild(this._section('音频与节拍',
      h('div', { class: 'fld span3' }, h('label', {}, '音频'), h('div', { class: 'ro' }, project.meta.audio?.src || '（未设置）')),
      this._field({ label: '偏移 (s)', value: project.meta.audio?.offset || 0, step: 0.01, onChange: (v) => this._commit('audio:off', { op: 'setMeta', path: 'audio.offset', value: v }) }),
      this._field({ label: '增益 dB', value: project.meta.audio?.gain || 0, step: 0.5, onChange: (v) => this._commit('audio:gain', { op: 'setMeta', path: 'audio.gain', value: v }) }),
      h('div', { class: 'fld span3' },
        h('label', {}, `节拍 ${project.meta.tempo || 0} bpm · ${project.meta.beats.length} 个`),
        h('div', { class: 'row-btns' },
          h('button', { class: 'mini', onclick: () => this.opts.analyzeBeats() }, '重新分析节拍'),
        )),
    ));

    this.root.appendChild(h('div', { class: 'hint pad' }, '选中元素后可以逐项编辑；点画面里的元素或时间线里的色块。'));
  }
}

const round = (v, d = 2) => {
  const p = Math.pow(10, d);
  return Math.round(Number(v) * p) / p;
};
