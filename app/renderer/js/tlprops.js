// Property panel on the left of the timeline: edits the selected 3D element and
// keeps its values in sync with the playhead (sampled tracks, not base values).
import { objectPose } from '/core/scene.js';

const AXES = ['x', 'y', 'z'];
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;

function el(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function numInput(step = 0.1, cls = '') {
  const i = document.createElement('input');
  i.type = 'number';
  i.step = String(step);
  if (cls) i.className = cls;
  return i;
}

export class TimelineProps {
  /**
   * @param {HTMLElement} root
   * @param {{onOp:Function, getTime:Function, onPause?:Function}} opts
   */
  constructor(root, { onOp, getTime, onPause } = {}) {
    this.root = root;
    this.onOp = onOp;
    this.getTime = getTime || (() => 0);
    this.onPause = onPause;
    this.project = null;
    this.sel = null;
    this.objId = null;
    this.objType = null;
    this.pose = null;
    this.inp = {}; // path -> array of inputs (vec) / input (scalar)
    this.key = {}; // path -> key button
    this._pending = new Map();
    this.editTimes = {};
    this.root.classList.add('tl-props');
    this._placeholder();
  }

  // ------------------------------------------------------------ public
  setProject(p) {
    this._flushAll();
    this.project = p;
    this._sync();
  }

  setSelection(sel) {
    this._flushAll();
    this.sel = sel;
    this._sync();
  }

  setTime(t) {
    this._flushAll();
    this.time = t;
    this._syncValues(true);
  }

  // ------------------------------------------------------------ internals
  _obj() {
    const id = this.sel?.objectId;
    if (!id) return null;
    return (this.project?.scene?.objects || []).find((o) => o.id === id) || null;
  }

  _sync() {
    const obj = this._obj();
    if (!obj) {
      this.objId = null;
      this._placeholder();
      return;
    }
    if (obj.id !== this.objId || obj.type !== this.objType || !this.body) {
      this._build(obj);
    }
    this._syncValues();
  }

  _placeholder() {
    this.root.innerHTML = '';
    this.body = null;
    this.inp = {};
    this.key = {};
    const empty = el('div', 'tp-empty');
    empty.innerHTML = '<div class="tp-empty-ico">◈</div><div>在视口或时间轴选中一个 3D 元素<br>这里编辑它的属性</div>';
    this.root.appendChild(empty);
  }

  _section(text, hint = '') {
    const s = el('div', 'tp-sec');
    s.appendChild(el('span', '', text));
    if (hint) s.appendChild(el('em', '', hint));
    return s;
  }

  _numBox(axis, step) {
    const box = el('span', 'tp-num');
    const a = el('i', axis === 'w' || axis === 'h' || axis === 'd' ? 'axis-d' : `axis-${axis}`, axis.toUpperCase());
    box.appendChild(a);
    const inp = numInput(step);
    box.appendChild(inp);
    return { box, inp };
  }

  _vecRow(path, label, title) {
    const row = el('div', 'tp-row');
    const lab = el('label', '', label);
    lab.title = title || '';
    row.appendChild(lab);
    const inputs = [];
    for (const ax of AXES) {
      const { box, inp } = this._numBox(ax, 0.1);
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this.editTimes[path] = round3(this.getTime());
        this._schedule(path, () => this._commitVec(path));
      });
      inp.addEventListener('blur', () => { this._flush(path); this._syncValues(); });
      inputs.push(inp);
      row.appendChild(box);
    }
    const kf = el('button', 'tp-key', '◆');
    kf.addEventListener('click', () => this._toggleKey(path));
    row.appendChild(kf);
    this.inp[path] = inputs;
    this.key[path] = kf;
    return row;
  }

  _geomRow() {
    const row = el('div', 'tp-row');
    row.appendChild(el('label', '', '几何'));
    const inputs = [];
    for (const [ax, step] of [['w', 0.1], ['h', 0.1], ['d', 0.1]]) {
      const { box, inp } = this._numBox(ax, step);
      inp.addEventListener('focus', () => this.onPause?.());
      inp.addEventListener('input', () => {
        this.editTimes.geom = round3(this.getTime());
        this._schedule('geom', () => this._commitGeom());
      });
      inp.addEventListener('blur', () => { this._flush('geom'); this._syncValues(); });
      inputs.push(inp);
      row.appendChild(box);
    }
    row.appendChild(el('span', 'tp-keyspace'));
    this.inp.geom = inputs;
    return row;
  }

  _opacityRow() {
    const row = el('div', 'tp-row');
    row.appendChild(el('label', '', '不透明度'));
    const { box, inp } = this._numBox('', 0.01);
    box.classList.add('tp-scalar');
    inp.min = '0';
    inp.max = '1';
    inp.addEventListener('focus', () => this.onPause?.());
    inp.addEventListener('input', () => {
      this.editTimes.opacity = round3(this.getTime());
      this._schedule('opacity', () => this._commitScalar('opacity', 'opacity'));
    });
    inp.addEventListener('blur', () => { this._flush('opacity'); this._syncValues(); });
    row.appendChild(box);
    const kf = el('button', 'tp-key', '◆');
    kf.addEventListener('click', () => this._toggleKey('opacity'));
    row.appendChild(kf);
    this.inp.opacity = inp;
    this.key.opacity = kf;
    return row;
  }

  _colorRow() {
    const row = el('div', 'tp-row');
    row.appendChild(el('label', '', '颜色'));
    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'tp-color';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'tp-hex';
    hex.spellcheck = false;
    color.addEventListener('input', () => {
      this.editTimes.color = round3(this.getTime());
      this._schedule('color', () => this._commitColor(color.value, hex));
    });
    color.addEventListener('blur', () => { this._flush('color'); this._syncValues(); });
    hex.addEventListener('change', () => {
      const v = String(hex.value || '').trim();
      if (/^#?[0-9a-f]{6}$/i.test(v)) {
        const norm = v.startsWith('#') ? v : `#${v}`;
        this._commitColor(norm, color);
      } else {
        this._syncValues();
      }
    });
    row.appendChild(color);
    hex.style.gridColumn = 'span 2';
    row.appendChild(hex);
    row.appendChild(el('span', 'tp-keyspace'));
    this.inp.color = color;
    this.inp.hex = hex;
    return row;
  }

  _build(obj) {
    this.root.innerHTML = '';
    this.objId = obj.id;
    this.objType = obj.type;
    this.inp = {};
    this.key = {};

    const head = el('div', 'tp-head');
    head.appendChild(el('span', 'tp-badge', '3D'));
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'tp-name';
    name.spellcheck = false;
    name.title = '元素名称';
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (v) this.onOp({ op: 'objectPatch', id: obj.id, patch: { name: v } });
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    head.appendChild(name);
    const eye = el('button', 'tp-eye', '◉');
    eye.title = '显示 / 隐藏';
    eye.addEventListener('click', () => {
      const cur = this._obj();
      if (!cur) return;
      this.onOp({ op: 'objectPatch', id: cur.id, patch: { visible: cur.visible === false } });
    });
    head.appendChild(eye);
    this.inp.name = name;
    this.inp.eye = eye;
    this.root.appendChild(head);

    this.body = el('div', 'tp-body');
    this.body.appendChild(this._section('内容'));
    this.body.appendChild(this._geomRow());
    this.body.appendChild(this._colorRow());
    this.body.appendChild(this._section('变换', 'm / 倍'));
    this.body.appendChild(this._vecRow('pivot', '中心点', '世界坐标中的旋转/拖拽中心（pivot）'));
    this.body.appendChild(this._vecRow('position', '位置', '几何体相对中心点的偏移（position）'));
    this.body.appendChild(this._vecRow('scale', '缩放', '绕几何中心缩放'));
    this.body.appendChild(this._opacityRow());
    const hint = el('div', 'tp-hint');
    hint.innerHTML = '拖播放头实时同步 · <b>◆</b> 打帧/删帧';
    this.body.appendChild(hint);
    this.root.appendChild(this.body);
    this._syncValues();
  }

  _syncValues(force = false) {
    const obj = this._obj();
    if (!obj || !this.body) return;
    const t = Number(this.getTime()) || 0;
    const pose = objectPose(obj, t);
    this.pose = pose;
    const set = (inp, v) => {
      if (!inp) return;
      if (!force && document.activeElement === inp) return;
      const n = round2(v);
      if (inp.value !== String(n)) inp.value = String(n);
    };
    ['pivot', 'position', 'scale'].forEach((path, i) => {
      const arr = path === 'pivot' ? pose.pivot : path === 'position' ? pose.position : pose.scale;
      (this.inp[path] || []).forEach((inp, ax) => set(inp, arr[ax]));
    });
    set(this.inp.opacity, pose.opacity);
    const geom = obj.geom || {};
    ['w', 'h', 'd'].forEach((ax, i) => set((this.inp.geom || [])[i], Number(geom[ax]) || 2));
    if (this.inp.name && document.activeElement !== this.inp.name && this.inp.name.value !== obj.name) {
      this.inp.name.value = obj.name || obj.id;
    }
    const color = String(obj.style?.color || obj.style?.fill || '#17d9ff');
    if (this.inp.color && document.activeElement !== this.inp.color && this.inp.color.value !== color) {
      this.inp.color.value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#17d9ff';
    }
    if (this.inp.hex && document.activeElement !== this.inp.hex) this.inp.hex.value = color;
    if (this.inp.eye) this.inp.eye.classList.toggle('off', obj.visible === false);

    for (const path of ['pivot', 'position', 'scale', 'opacity']) {
      const btn = this.key[path];
      if (!btn) continue;
      const track = obj.tracks?.[path] || [];
      const sub = ['x', 'y', 'z'].some((a) => (obj.tracks?.[`${path}.${a}`] || []).length > 0);
      const at = track.some((k) => Math.abs(k.t - t) < 1e-3);
      const has = track.length > 0 || sub;
      btn.classList.toggle('on', at);
      btn.classList.toggle('has', !at && has);
      btn.title = at ? '删除这一帧' : has ? `在当前时间打帧（轨道已有 ${track.length} 帧）` : '在当前时间打帧';
    }
  }

  _hasTrack(obj, path) {
    if ((obj.tracks?.[path] || []).length) return true;
    return ['x', 'y', 'z'].some((a) => (obj.tracks?.[`${path}.${a}`] || []).length > 0);
  }

  // ---- edits: with tracks -> key at the playhead, otherwise base value ----
  _commitVec(path) {
    const obj = this._obj();
    const inputs = this.inp[path];
    if (!obj || !inputs) return;
    const v = inputs.map((i) => Number(i.value));
    if (v.some((n) => !Number.isFinite(n))) return;
    const t = this.editTimes[path] ?? round3(this.getTime());
    if (this._hasTrack(obj, path)) {
      this.onOp({ op: 'objectKey', id: obj.id, path, t, v });
    } else {
      this.onOp({ op: 'objectPatch', id: obj.id, patch: { [path]: v } });
    }
  }

  _commitScalar(path, base) {
    const obj = this._obj();
    const inp = this.inp[path];
    if (!obj || !inp) return;
    const v = Number(inp.value);
    if (!Number.isFinite(v)) return;
    const t = this.editTimes[path] ?? round3(this.getTime());
    if (this._hasTrack(obj, path)) this.onOp({ op: 'objectKey', id: obj.id, path, t, v });
    else this.onOp({ op: 'objectPatch', id: obj.id, patch: { [base]: Math.max(0, Math.min(1, v)) } });
  }

  _commitGeom() {
    const obj = this._obj();
    const [w, h, d] = (this.inp.geom || []).map((i) => Number(i.value));
    if (!obj || ![w, h, d].every(Number.isFinite)) return;
    this.onOp({
      op: 'objectPatch', id: obj.id,
      patch: { geom: { ...(obj.geom || {}), w: Math.max(0.01, w), h: Math.max(0.01, h), d: Math.max(0.01, d) } },
    });
  }

  _commitColor(value, other) {
    const obj = this._obj();
    if (!obj) return;
    this.onOp({ op: 'objectPatch', id: obj.id, patch: { style: { ...(obj.style || {}), color: value } } });
    if (other && document.activeElement !== other) other.value = value;
  }

  _toggleKey(path) {
    const obj = this._obj();
    if (!obj) return;
    this.onPause?.();
    const t = round3(this.getTime());
    const track = obj.tracks?.[path] || [];
    const at = track.some((k) => Math.abs(k.t - t) < 1e-3);
    if (at) {
      this.onOp({ op: 'objectUnkey', id: obj.id, path, t });
      return;
    }
    const pose = objectPose(obj, t);
    const v = path === 'opacity' ? pose.opacity : pose[path];
    this.onOp({ op: 'objectKey', id: obj.id, path, t, v });
  }

  _schedule(key, fn) {
    this._flush(key);
    const timer = setTimeout(() => {
      this._pending.delete(key);
      fn();
    }, 110);
    this._pending.set(key, { timer, fn });
  }

  _flush(key) {
    const p = this._pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(key);
    p.fn();
  }

  _flushAll() {
    for (const key of [...this._pending.keys()]) this._flush(key);
  }
}
