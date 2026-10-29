// Contract single source (docs/DESIGN-BACKEND-V2.md §8.4, WP2.3).
//
// Everything an agent, a tool schema or a doc needs to know about the editing
// surface lives here and nowhere else:
//
//   OP_CONTRACTS       one contract per public op: JSON Schema, required
//                      fields, units, a one-line summary and a validating example
//   PROPERTY_PATHS     every addressable project field: host, type, unit,
//                      default value, whether the evaluator samples a keyframe
//                      at that path ("keyable") and whether a property link may
//                      reference it ("linkable")
//   DOCUMENT_DEFAULTS  what addElement / addCamera / objectAdd fill in
//   UNITS              the unit vocabulary used by the two tables above
//   EDIT_SCHEMA, OP_SCHEMA, CHANGESET_APPLY_SCHEMA
//                      the JSON Schema the MCP tools publish; mcp/tools.js
//                      imports these instead of writing op fields by hand
//
// `scripts/gen-contracts.mjs` renders docs/AGENT-PROTOCOL.md, docs/CONTRACTS.md
// and mcp/contracts.generated.json from this module. tests/contracts.test.mjs
// fails when the generated files, the published MCP tool schemas or the real
// op/link/template/schema modules drift apart, and when a generated file is
// edited by hand (`node scripts/gen-contracts.mjs --check`).
//
// The JSON Schema constraints below are the ones WP2.2 / WP3.2 grew; WP2.3
// moved the documentation (descriptions, units, defaults, examples) next to
// them and did not change a single constraint: the refactor was diffed against
// a pre-WP2.3 snapshot with every `description` stripped — 52/52 op variants and
// EDIT_SCHEMA came out identical.
//
// Pure ESM: no DOM, no node:* — the browser and Node share it like every other
// core module.
import { CAMERA_TRACK_DIMS, OP_KINDS } from './ops.js';
import { AUDIO_VOLUME_PATH } from './audio.js';
import { LINK_UNITS } from './links.js';
import {
  DEFAULT_FX, DEFAULT_MOTION, DEFAULT_SPATIAL_NODE, DEFAULT_STYLE, DEFAULT_TRANSFORM, ELEMENT_TYPES,
} from './schema.js';
import { PROPERTIES as TEMPLATE_PROPERTIES } from './templates.js';

/** Bumped when the shape of a generated file changes (not on every op). */
export const CONTRACT_VERSION = 3;

// ---------------------------------------------------------------- units
//
// One vocabulary, referenced by both the op fields and the property paths.
// `symbol` is what the docs print; `description` is what an agent needs to
// interpret a number without reading the evaluator.

export const UNITS = Object.freeze({
  m: { label: '米', symbol: 'm', description: '世界坐标米；画面平面在 z = 0，y 向上，100 项目像素 = 1 米。' },
  'project-px': { label: '项目像素', symbol: 'px', description: '项目画幅像素（1920×1080 的工程里 100 px = 1 m）。' },
  s: { label: '秒', symbol: 's', description: '项目绝对时间；关键帧的 t 不是元素内的相对时间。' },
  deg: { label: '度', symbol: '°', description: '角度。' },
  ratio: { label: '倍率', symbol: '×', description: '1 = 原值；用于缩放、透明度、音量。' },
  hz: { label: '赫兹', symbol: 'Hz', description: '频率。' },
  normalized: { label: '归一化', symbol: '0..1', description: '画幅内的归一化坐标；画面中心是 0.5。' },
  'f-stop': { label: '光圈值', symbol: 'f', description: '光圈 f 值，越大越虚化。' },
  number: { label: '数值', symbol: '', description: '无量纲数值。' },
  dir: { label: '方向', symbol: 'xyz', description: '单位方向向量（模长 1）。' },
  any: { label: '由源声明', symbol: '', description: '单位由源码 manifest 的 param.type 决定，core 不换算。' },
  value: { label: '随属性', symbol: '', description: '单位随 path 指向的属性。' },
  boolean: { label: '开关', symbol: '', description: 'true / false。' },
});

// ---------------------------------------------------------------- schema atoms

const string = { type: 'string', minLength: 1, maxLength: 512 };
const number = { type: 'number' };
const time = { type: 'number', minimum: 0 };
const object = { type: 'object' };
const vector = (size) => ({ type: 'array', items: number, minItems: size, maxItems: size });
const nullableId = { type: ['string', 'null'] };
const parentChannel = { enum: ['rot', 'scale'] };
const parentStrength = { type: 'object', properties: { rot: number, scale: number }, additionalProperties: false };
const property = {
  ...string,
  description: '点号属性路径。2D 位置是项目像素、y 向下；3D 位置是米、y 向上。允许的路径见 PROPERTY_PATHS。',
};
const linkHostKind = { enum: ['el', 'ob', 'cam', 'element', 'object', 'camera'] };
const linkFrom = {
  type: 'object',
  required: ['host', 'id', 'path'],
  properties: { host: linkHostKind, id: string, path: property },
  additionalProperties: false,
};
const inherit = {
  type: 'object',
  properties: { pos: { type: 'boolean' }, rot: { type: 'boolean' }, scale: { type: 'boolean' } },
  additionalProperties: false,
};

/** One op field: JSON Schema + description + unit (unit lives outside the schema). */
const f = (schema, description, unit = null) => ({ schema: description ? { ...schema, description } : { ...schema }, unit });

// Shared field annotations. A name here is the default; an op overrides it when
// the same name means something else for that op.
const S = {
  id: f(string, '宿主 id：2D 元素 el_*、相机 cam_*、3D 物体 ob_*（propLink 里是子宿主）。个别 op 另有说明。'),
  path: f(property, '属性路径（点号分隔）。', null),
  value: f({}, '写入的值；类型与单位由 path 指向的属性决定。', 'value'),
  patch: f(object, '要合并进宿主的字段（深度合并；id 不可改）。', null),
  t: f(time, '项目绝对时间（秒，≥ 0）。', 's'),
  ease: f(string, '缓动名（linear / easeInOut / inExpo / outExpo …，见 core/curves.js）；省略时保留原有缓动。'),
  curve: f({ type: ['object', 'null'] }, '值曲线对象；null 表示清除。省略时保留原有曲线。'),
  v: f({}, '写入的值（与 value 等价，v 是时间线/相机轨道的旧名字）。', 'value'),
};

// ---------------------------------------------------------------- op contracts
//
// `group` drives the doc sections; `summary` is the one-line table cell;
// `description` is the paragraph an agent may need; `example` must validate
// against the op schema (tests/contracts.test.mjs runs validateContract on it).

const OP_DEFS = {
  addElement: {
    group: 'element',
    summary: '新建 2D 元素',
    description: '分配 id、补全默认字段并插入元素数组（同 z 时新元素在最上面）。type 取 ELEMENT_TYPES。',
    example: { op: 'addElement', element: { type: 'text', start: 0, duration: 3, style: { text: '锈梦', size: 140, color: '#ffd400' } } },
    required: ['element'],
    fields: {
      element: f({
        ...object,
        required: ['type'],
        properties: { type: { enum: ELEMENT_TYPES }, start: time, duration: { type: 'number', exclusiveMinimum: 0 }, loop: { type: 'boolean' } },
      }, '元素对象：至少给 type；其余字段与 updateElement 的 patch 相同，缺省值见 DOCUMENT_DEFAULTS。'),
    },
  },
  updateElement: {
    group: 'element',
    summary: '深合并元素字段',
    description: '把 patch 深度合并进元素。id 不可改；改 src 会丢掉旧的素材时长缓存；改 z 会重排元素数组。',
    example: { op: 'updateElement', id: 'el_title', patch: { style: { text: '锈梦', size: 150 }, locked: true } },
    required: ['id', 'patch'],
    fields: { id: S.id, patch: S.patch },
  },
  set: {
    group: 'element',
    summary: '写一个元素属性',
    description: '按点号路径写元素字段（写入前把字符串形式的数字/布尔/JSON 转成真值）。不影响关键帧。',
    example: { op: 'set', id: 'el_title', path: 'style.color', value: '#ffd400' },
    required: ['id', 'path', 'value'],
    fields: { id: S.id, path: S.path, value: S.value },
  },
  removeElement: {
    group: 'element',
    summary: '删除元素',
    description: '删除元素，并把它作为宿主的属性链接一并摘除（子元素保留自己的本地值）。',
    example: { op: 'removeElement', id: 'el_title' },
    required: ['id'],
    fields: { id: S.id },
  },
  duplicateElement: {
    group: 'element',
    summary: '复制元素',
    description: '深拷贝并换新 id；start 缺省是「原起点 + offset」，关键帧整体平移。',
    required: ['id'],
    fields: {
      id: S.id,
      start: f(time, '副本起点（秒）；省略时用原起点 + offset。', 's'),
      offset: f(number, '相对原起点的偏移（秒）。', 's'),
    },
  },
  moveElement: {
    group: 'element',
    summary: '移动 / 裁剪元素（相机片段同用）',
    description: '只改 start 时关键帧跟着整体平移；start + duration 一起改是左裁剪（内容在时间上不动）。keys 可强制平移或保留关键帧。相机片段也走这个 op。',
    example: { op: 'moveElement', id: 'el_title', start: 1.2, duration: 2.4, segment: 'seg_1', keys: 'shift' },
    required: ['id'],
    fields: {
      id: S.id,
      start: f(time, '新起点（秒）。', 's'),
      duration: f({ type: 'number', exclusiveMinimum: 0 }, '新时长（秒）；和 start 一起给就是左裁剪。', 's'),
      z: f(number, '新的层序（越大越靠前）。'),
      segment: f({ type: ['string', 'null'] }, '分镜 id；null = 不归属任何分镜。'),
      keys: f({ enum: ['shift', 'keep'] }, '关键帧处理：shift = 跟时间一起平移，keep = 不动（裁剪时默认）。'),
    },
  },
  splitElement: {
    group: 'element',
    summary: '在某一刻切开一个元素',
    description: '切成左右两段，右段换新 id；关键帧、曲线、素材入点按切点重新分配。切点必须落在元素内部（留 0.02 s 余量）。',
    required: ['id', 'at'],
    fields: { id: S.id, at: f(time, '切点（项目秒）。', 's') },
  },
  splitAt: {
    group: 'element',
    summary: '在播放头一次切开所有相关元素',
    description: 'UI 的剪刀（Ctrl+D）：把跨过 at 的元素全部切开，一次撤销。',
    required: ['at'],
    fields: {
      at: f(time, '切点（项目秒）。', 's'),
      id: f(string, '只切这一个元素（可选）。'),
      ids: f({ type: 'array', items: string }, '只切这些元素（可选）。'),
    },
  },
  reorder: {
    group: 'element',
    summary: '改层序',
    description: 'z 与 delta 二选一：给 z 就设成它，否则在当前 z 上加 delta（默认 +1）。',
    required: ['id'],
    fields: {
      id: S.id,
      z: f(number, '目标层序。'),
      delta: f(number, '相对层序增量（没给 z 时使用，默认 +1）。'),
    },
  },
  addSegment: {
    group: 'segment',
    summary: '新建分镜',
    description: '分镜是时间上的标注（标题、意图、状态），不剪辑画面。',
    example: { op: 'addSegment', segment: { name: '开场', start: 0, duration: 4, intent: 'establishing' } },
    required: ['segment'],
    fields: { segment: f(object, '分镜对象：{ id?, name?, start?, duration?, intent?, status? }，status 取 draft|previewed|approved。') },
  },
  updateSegment: {
    group: 'segment',
    summary: '改分镜',
    description: '深合并 patch；也可以直接给 start / duration。',
    required: ['id', 'patch'],
    fields: { id: S.id, patch: S.patch },
  },
  removeSegment: {
    group: 'segment',
    summary: '删分镜',
    description: '删掉分镜；原本属于它的元素保留，segment 置空。',
    required: ['id'],
    fields: { id: S.id },
  },
  setMeta: {
    group: 'meta',
    summary: '写工程级字段',
    description: '按点号路径写 meta（fps、beats、background、title …）。',
    example: { op: 'setMeta', path: 'fps', value: 24 },
    required: ['path', 'value'],
    fields: { path: f(property, 'meta 内的字段路径，例如 fps / beats / background。'), value: S.value },
  },
  setFx: {
    group: 'meta',
    summary: '改画面级效果',
    description: '合并进 meta.fx（bloom / ca / grain / vignette / scanline / grade / contrast / saturation / shake）。',
    example: { op: 'setFx', fx: { bloom: 0.6, vignette: 0.4 } },
    required: ['fx'],
    fields: { fx: f(object, '画面效果字段；缺省值见 DOCUMENT_DEFAULTS.fx。') },
  },
  keySet: {
    group: 'keyframe',
    summary: '在某一时刻写一个关键帧',
    description: 't 是项目绝对时间。同一 path + t 覆盖旧键；省略 curve 时保留该时刻原有的曲线。',
    example: { op: 'keySet', id: 'el_title', path: 'style.size', t: 1.6, value: 150, ease: 'outExpo' },
    required: ['id', 'path', 't', 'value'],
    fields: { id: S.id, path: S.path, t: S.t, value: S.value, ease: S.ease, curve: S.curve },
  },
  keyRemove: {
    group: 'keyframe',
    summary: '删关键帧（带 t 删一个，不带清整条轨）',
    description: '带 t 只删那一个键；不带 t 清空整条 path 的轨（旧的删除手势）。',
    required: ['id', 'path'],
    fields: { id: S.id, path: S.path, t: f(time, '只删这一时刻的键；省略则清空整条轨。', 's') },
  },
  keyCurve: {
    group: 'keyframe',
    summary: '给一段关键帧区间挂值曲线',
    description: '曲线存在左键上，控制 [from, to) 这段的插值。相机 host=camera + path=path 时是相机路径的弧长重定时。CURVE=null 清除。',
    required: ['id', 'path', 'from', 'to', 'curve'],
    fields: {
      host: f({ enum: ['element', 'object', 'camera'] }, '键所在宿主类型，默认 element。'),
      id: S.id,
      path: S.path,
      from: f(time, '区间左端（秒），必须正好有一个键。', 's'),
      to: f(time, '区间右端（秒），必须正好有一个键。', 's'),
      curve: S.curve,
    },
  },
  batch: {
    group: 'batch',
    summary: '一次提交多个 op',
    description: '顺序执行同一批 op，任一失败整批不生效；返回每个 op 的结果与合并后的 changed。',
    example: { op: 'batch', ops: [
      { op: 'keySet', id: 'el_title', path: 'style.size', t: 1.5, value: 150 },
      { op: 'keySet', id: 'el_title', path: 'style.size', t: 2.5, value: 120 },
    ] },
    required: ['ops'],
    fields: { ops: f({ type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/op' } }, '要顺序执行的 op 列表（同一事务）。') },
  },
  cameraKey: {
    group: 'camera',
    summary: '写相机路径关键帧',
    description: '相机位置是路径动画：每个键是「时刻 + 位置 + 可选 look/fov/切线/速度」。省略 id 时写活动相机。',
    example: { op: 'cameraKey', id: 'cam_1', t: 0, pos: [0, 5.4, 20], look: [0, 5.4, 0] },
    required: ['t', 'pos'],
    fields: {
      id: S.id,
      t: S.t,
      pos: f(vector(3), '相机位置（世界米）。', 'm'),
      look: f({ anyOf: [vector(3), { type: 'null' }] }, '看向的目标点（世界米）；null = 用切线决定朝向。', 'm'),
      fov: f({ type: ['number', 'null'] }, '这一时刻的视场角；null = 用相机自身的 fov。', 'deg'),
      ease: S.ease,
      out: f(vector(3), '出切线（贝塞尔把手，世界米）。', 'm'),
      in: f(vector(3), '入切线（贝塞尔把手，世界米）。', 'm'),
      speed: f({}, '速度折线 [[u, v], …]（u 0..1，v 倍速）；null 清除。'),
    },
  },
  cameraRemove: {
    group: 'camera',
    summary: '删相机路径关键帧',
    description: '删掉 t 时刻的路径键；同时清掉落在它上面的跨键曲线。省略 id 时用活动相机。',
    required: ['t'],
    fields: { id: S.id, t: S.t },
  },
  cameraSet: {
    group: 'camera',
    summary: '深合并相机字段',
    description: '改相机的整段属性（名字、fov、shake、dof …）。会重新夹紧画面构图字段并重排路径。',
    example: { op: 'cameraSet', id: 'cam_1', patch: { fov: 60, shake: { amp: 0.2 } } },
    required: ['patch'],
    fields: { id: S.id, patch: S.patch },
  },
  cameraPath: {
    group: 'camera',
    summary: '整体替换相机路径',
    description: '从视口拖拽时整条写回；不合法（pos 不是三元）的关键点被丢弃。',
    required: ['path'],
    fields: { id: S.id, path: f({ type: 'array', items: object }, '路径关键点数组：{ t, pos, look?, fov?, ease?, out?, in?, speed?, curve?, spanTo? }。') },
  },
  cameraPatch: {
    group: 'camera',
    summary: '按 id 深合并相机',
    description: '和 cameraSet 相同，但 id 必填且必须存在。',
    required: ['id', 'patch'],
    fields: { id: S.id, patch: S.patch },
  },
  cameraParamKey: {
    group: 'camera',
    summary: '相机参数关键帧',
    description: '给相机的一个参数打帧（fov / center / shake.amp …）。path 必须在相机轨道表里，否则报错。',
    example: { op: 'cameraParamKey', id: 'cam_1', path: 'fov', t: 0, v: 62 },
    required: ['path', 't'],
    fields: {
      id: S.id,
      path: f(property, '相机轨道路径，取值见 PROPERTY_PATHS 里 host=cam 且 keyable 的行。'),
      t: S.t,
      v: S.v,
      value: S.value,
      ease: S.ease,
      curve: S.curve,
    },
  },
  cameraParamUnkey: {
    group: 'camera',
    summary: '删相机参数关键帧',
    description: '删 t 时刻的相机参数键；轨道空了就删掉轨道。',
    required: ['path', 't'],
    fields: { id: S.id, path: S.path, t: S.t },
  },
  worldSet: {
    group: 'meta',
    summary: '深合并 world',
    description: '城市/天空等世界字段（source、background、city …）。',
    required: ['patch'],
    fields: { patch: S.patch },
  },
  addCamera: {
    group: 'camera',
    summary: '新建相机',
    description: '插入相机栈（默认最上面）并设为活动相机；没有给 id 时分配 cam_*。',
    required: [],
    fields: {
      camera: f(object, '相机对象：{ id?, name?, fov?, center?, path?, shake?, dof?, … }。'),
      index: f({ type: 'integer', minimum: 0 }, '插入到相机栈的位置（0 = 最上），默认 0。'),
    },
  },
  removeCamera: {
    group: 'camera',
    summary: '删相机',
    description: '从相机栈移除；活动相机被删时改选栈顶；它作为链接宿主的链接一并摘除。',
    required: ['id'],
    fields: { id: S.id },
  },
  reorderCamera: {
    group: 'camera',
    summary: '调整相机栈顺序',
    description: '在相机栈里把相机移到 index（越靠前越在上层）。',
    required: ['id', 'index'],
    fields: { id: S.id, index: f({ type: 'integer', minimum: 0 }, '目标位置（0 = 栈顶）。') },
  },
  activateCamera: {
    group: 'camera',
    summary: '切换活动相机',
    description: '活动相机是预览与导出的主眼。',
    required: ['id'],
    fields: { id: S.id },
  },
  objectAdd: {
    group: 'object',
    summary: '新建 3D 物体',
    description: '在根场景里建物体；id 不冲突时沿用，否则分配 ob_*。start/duration 会被工程时长夹紧。',
    example: { op: 'objectAdd', object: { type: 'solid', primitive: 'box', geom: { w: 1, h: 1, d: 1 }, pivot: [0, 5.4, 0] } },
    required: ['object'],
    fields: { object: f(object, '物体对象：{ id?, type?, name?, geom?, pivot?, rotation?, scale?, style?, start?, duration? }。') },
  },
  objectRemove: {
    group: 'object',
    summary: '删 3D 物体',
    description: '从根场景移除，并摘除它作为宿主的属性链接。',
    required: ['id'],
    fields: { id: S.id },
  },
  objectPatch: {
    group: 'object',
    summary: '深合并 3D 物体',
    description: '改物体字段后会重新归一化（几何、旋转、不透明度夹紧）；id 与 tracks 不能用 patch 改。',
    required: ['id', 'patch'],
    fields: { id: S.id, patch: S.patch },
  },
  objectKey: {
    group: 'object',
    summary: '3D 物体关键帧',
    description: 'path 取物体轨道（pivot / position / scale / dir / roll / rotation.x / opacity …）；向量轨可带切线或速度折线。',
    example: { op: 'objectKey', id: 'ob_1', path: 'pivot.x', t: 1, v: 0.5 },
    required: ['id', 'path', 't'],
    fields: {
      id: S.id,
      path: f(property, '物体轨道路径，取值见 PROPERTY_PATHS 里 host=ob 且 keyable 的行。'),
      t: S.t,
      v: S.v,
      value: S.value,
      ease: S.ease,
      curve: S.curve,
      out: f(vector(3), '出切线（只对向量轨有效，世界米）。', 'm'),
      in: f(vector(3), '入切线（只对向量轨有效，世界米）。', 'm'),
      speed: f({}, '速度折线 [[u, v], …]；null 清除。'),
    },
  },
  objectUnkey: {
    group: 'object',
    summary: '删 3D 物体关键帧',
    description: '删 t 时刻的键；轨道空了就删掉轨道。',
    required: ['id', 'path', 't'],
    fields: { id: S.id, path: S.path, t: S.t },
  },
  objectParent: {
    group: 'parent',
    summary: '3D 物体挂父级（旧式）',
    description: '旧的对象父子关系；新数据请用 spatialParent / objectParent 的等价空间父级。',
    required: ['id', 'parent'],
    fields: {
      id: S.id,
      parent: f(nullableId, '父物体 id；null = 解除（和 objectUnparent 等价）。'),
      t: S.t,
      inherit: f(inherit, '继承哪些分量（pos / rot / scale），缺省全继承。'),
      strength: f(parentStrength, '父级影响强度 { rot, scale }，0..1 之间。'),
    },
  },
  objectUnparent: {
    group: 'parent',
    summary: '解除 3D 物体父级',
    description: '解绑父级，物体保留解绑那一刻的世界姿态。',
    required: ['id'],
    fields: { id: S.id, t: S.t },
  },
  objectParentKey: {
    group: 'parent',
    summary: '父级强度关键帧（旧式）',
    description: '给 rot / scale 两个继承通道打强度键（0..1）。',
    required: ['id', 'channel', 't'],
    fields: {
      id: S.id,
      channel: f(parentChannel, '通道：rot 或 scale。'),
      t: S.t,
      v: f(number, '强度（0..1）。'),
      value: f(number, '强度（0..1），与 v 等价。'),
      ease: S.ease,
    },
  },
  objectParentUnkey: {
    group: 'parent',
    summary: '删父级强度关键帧（旧式）',
    description: '删 t 时刻的通道键。',
    required: ['id', 'channel', 't'],
    fields: { id: S.id, channel: f(parentChannel, '通道：rot 或 scale。'), t: S.t },
  },
  elementParent: {
    group: 'parent',
    summary: '2D 元素挂父级',
    description: '元素跟随父宿主的世界变换；null 等于 elementUnparent。',
    required: ['id', 'parent'],
    fields: {
      id: f(string, '子元素 id。'),
      parent: f(nullableId, '父宿主 id（元素 / 相机 / 3D 物体）；null = 解除。'),
      t: S.t,
    },
  },
  elementUnparent: {
    group: 'parent',
    summary: '解除 2D 元素父级',
    description: '解绑父级，元素保留解绑那一刻的世界姿态。',
    required: ['id'],
    fields: { id: f(string, '元素 id。'), t: S.t },
  },
  spatialParent: {
    group: 'parent',
    summary: '挂空间父级（元素 / 相机 / 物体通用）',
    description: '统一的父级入口：父宿主可以是元素、相机或 3D 物体，支持继承开关与强度。',
    example: { op: 'spatialParent', id: 'el_2', parent: 'el_1' },
    required: ['id', 'parent'],
    fields: {
      id: f(string, '子宿主 id。'),
      parent: f(string, '父宿主 id。'),
      t: S.t,
      inherit: f(inherit, '继承哪些分量，缺省全继承。'),
      strength: f(parentStrength, '父级影响强度 { rot, scale }。'),
    },
  },
  spatialUnparent: {
    group: 'parent',
    summary: '解除空间父级',
    description: '解绑父级，宿主保留解绑那一刻的世界姿态。',
    required: ['id'],
    fields: { id: f(string, '子宿主 id。') },
  },
  spatialParentKey: {
    group: 'parent',
    summary: '父级强度关键帧',
    description: '给 rot / scale 两个继承通道打强度键（0..1）。',
    required: ['id', 'channel', 't'],
    fields: {
      id: f(string, '子宿主 id。'),
      channel: f(parentChannel, '通道：rot 或 scale。'),
      t: S.t,
      v: f(number, '强度（0..1）。'),
      value: f(number, '强度（0..1），与 v 等价。'),
      ease: S.ease,
    },
  },
  spatialParentUnkey: {
    group: 'parent',
    summary: '删父级强度关键帧',
    description: '删 t 时刻的通道键。',
    required: ['id', 'channel', 't'],
    fields: { id: f(string, '子宿主 id。'), channel: f(parentChannel, '通道：rot 或 scale。'), t: S.t },
  },
  propLink: {
    group: 'link',
    summary: '属性链接：子属性跟父属性',
    description: 'add 是加偏移，mul 是乘比例（比率单位默认 mul）。单位必须同族，代码参数（code.params.*）例外。',
    example: { op: 'propLink', host: 'el', id: 'el_2', to: 'pivot.x', from: { host: 'el', id: 'el_1', path: 'pivot.x' }, combine: 'add' },
    required: ['id', 'to', 'from'],
    fields: {
      host: f(linkHostKind, '子宿主类型（el / ob / cam）；默认 el。'),
      id: f(string, '子宿主 id。'),
      to: f(property, '子宿主的属性路径（属性路径表里 linkable 的行）。'),
      from: f(linkFrom, '父属性引用 { host, id, path }；host 可写别名 element/object/camera。'),
      combine: f({ enum: ['add', 'mul'] }, '叠加方式：add 加偏移，mul 乘比例；缺省按单位（比率默认 mul）。'),
      t: S.t,
      enabled: f({ type: 'boolean' }, '关掉后子属性回到本地值（链接保留）。'),
      bindParentValue: f(number, '绑定时父属性的值：之后按父值相对这个点的变化叠加。'),
    },
  },
  propLinkPatch: {
    group: 'link',
    summary: '改属性链接',
    description: '深合并这条链接的字段（combine / enabled / bindParentValue / t …）。',
    required: ['id', 'to', 'patch'],
    fields: {
      host: f(linkHostKind, '子宿主类型；默认 el。'),
      id: f(string, '子宿主 id。'),
      to: f(property, '子属性路径。'),
      patch: S.patch,
      t: S.t,
    },
  },
  propUnlink: {
    group: 'link',
    summary: '解除属性链接',
    description: '删掉子属性上的链接，子属性保留当前本地值。',
    required: ['id', 'to'],
    fields: {
      host: f(linkHostKind, '子宿主类型；默认 el。'),
      id: f(string, '子宿主 id。'),
      to: f(property, '子属性路径。'),
    },
  },
  sourceAdd: {
    group: 'source',
    summary: '注册 / 替换代码图层源',
    description: '源清单（manifest）与文本文件都存在工程文档里，sources/<id>/ 由它派生。manifest 会被校验（runtime / entry / params），id 就是目录名。',
    example: { op: 'sourceAdd', id: 'dot_pulse', manifest: { runtime: 'canvas2d', entry: 'main.js', params: [{ id: 'radius', type: 'number', range: [0, 1] }] }, files: { 'main.js': 'export function draw(vdm) {}' } },
    required: ['id', 'manifest'],
    fields: {
      id: f({ type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, '源 id，同时是目录名：字母数字开头，允许 - 和 _。'),
      manifest: f({ type: 'object', required: ['runtime', 'entry'] }, '源清单 { runtime: canvas2d|p5|glsl, entry, params?, deterministic?, libs? }。'),
      files: f({ type: 'object', additionalProperties: { type: 'string' } }, '文本文件表 { 相对路径: 内容 }；manifest.json 由 manifest 字段生成，不要放进来。'),
    },
  },
  sourceWrite: {
    group: 'source',
    summary: '改写源里的一个文件',
    description: '只改文本文件；改 manifest 用 sourceAdd。内容相同则不算变更。',
    required: ['id', 'path', 'content'],
    fields: {
      id: S.id,
      path: f({ type: 'string', minLength: 1, maxLength: 200 }, '源内的相对路径；不允许 .. 或绝对路径。'),
      content: f({ type: 'string', maxLength: 2000000 }, '文件全文。'),
    },
  },
  sourceRemove: {
    group: 'source',
    summary: '删掉一个源',
    description: '还有 code 元素在用这个源时拒绝删除。',
    required: ['id'],
    fields: { id: S.id },
  },
  codeParamSet: {
    group: 'source',
    summary: '改代码图层的参数',
    description: '按 manifest 声明的类型转换并按 range 夹紧；参数已打帧时写到 t 时刻的键上。',
    example: { op: 'codeParamSet', id: 'el_code', name: 'radius', value: 0.5, t: 1 },
    required: ['id', 'name'],
    fields: {
      id: f(string, 'code 元素 id。'),
      name: f({ type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' }, '参数名（manifest.params[].id）。'),
      value: f({}, '参数值；类型按 manifest 声明转换。', 'any'),
      v: f({}, '参数值（与 value 等价）。', 'any'),
      t: f(time, '参数已打帧时写到这个时间的键上（秒）。', 's'),
    },
  },
};

// ---------------------------------------------------------------- op schema

/** Public ops: every OP_KINDS entry that has a contract here. */
export const PUBLIC_OPS = Object.freeze(OP_KINDS.filter((op) => Object.hasOwn(OP_DEFS, op)));

const variantOf = (op) => {
  const { fields, required } = OP_DEFS[op];
  const properties = { op: { const: op, description: `操作类型：${op}` } };
  for (const [name, entry] of Object.entries(fields)) properties[name] = entry.schema;
  return { type: 'object', required: ['op', ...required], properties, additionalProperties: false };
};

export const OP_SCHEMA = Object.freeze({ oneOf: PUBLIC_OPS.map(variantOf) });

/** One contract row per public op: schema + doc metadata + field rows. */
export const OP_CONTRACTS = Object.freeze(Object.fromEntries(PUBLIC_OPS.map((op) => {
  const def = OP_DEFS[op];
  const fields = Object.entries(def.fields).map(([name, entry]) => ({
    name,
    required: def.required.includes(name),
    type: entry.schema.type ?? (entry.schema.enum ? 'enum' : entry.schema.anyOf ? 'mixed' : 'any'),
    enum: entry.schema.enum ?? null,
    unit: entry.unit,
    description: entry.schema.description ?? '',
  }));
  return [op, Object.freeze({
    op,
    group: def.group,
    summary: def.summary,
    description: def.description,
    required: Object.freeze([...def.required]),
    fields: Object.freeze(fields),
    example: def.example ?? null,
    schema: Object.freeze(variantOf(op)),
  })];
})));

/** Doc sections, in order. */
export const OP_GROUPS = Object.freeze([
  { id: 'element', title: '元素（2D）', description: '时间线上的 2D 元素：文字、图片、视频、图形、音频、摄像机画面、代码图层。' },
  { id: 'keyframe', title: '关键帧', description: '元素/物体/相机参数都走同一套关键帧写法；t 是项目绝对时间。' },
  { id: 'segment', title: '分镜', description: '分镜是时间标注，不参与求值。' },
  { id: 'meta', title: '工程级', description: '工程 meta、画面效果与 world。' },
  { id: 'camera', title: '相机', description: '相机栈、路径动画与相机参数轨道。' },
  { id: 'object', title: '3D 物体', description: '根场景里的 3D 物体（solid / shape / text / image / video / container / empty / camera / audio）。' },
  { id: 'parent', title: '父子级', description: '元素、相机、物体都能挂空间父级；旧的对象父级 op 仍然保留。' },
  { id: 'link', title: '属性链接', description: '一个宿主的数值属性跟随另一个宿主的数值属性。' },
  { id: 'source', title: '代码图层源', description: 'sources/<id>/ 由工程文档里的源清单派生。' },
  { id: 'batch', title: '批量', description: '一次提交多个 op。' },
]);

// ---------------------------------------------------------------- request schema

export const EXPECTED_REV = { type: 'integer', minimum: 0, description: '读取时的项目 rev；运行时的当前 rev 不同就返回 REV_CONFLICT。' };
export const REQUEST_ID = { type: 'string', minLength: 1, maxLength: 200, description: '唯一请求 id：毫秒级重试复用同一个事务，不同输入复用会返回 REQUEST_ID_CONFLICT。' };
export const DRY_RUN = { type: 'boolean', description: '只校验不提交：不写盘、不占 rev、不消耗 requestId。' };
export const ACTOR_ID = { type: 'string', minLength: 1, maxLength: 200, description: '写入者身份（ui / human / cli / agent:*）；agent:* 写锁定宿主会被拒绝（LOCKED）。' };

/** The three edit-transaction preconditions shared by every editing tool. */
export const EDIT_BASELINE = Object.freeze({ expectedRev: EXPECTED_REV, requestId: REQUEST_ID, dryRun: DRY_RUN });

/** An ops array that references the embedded op contract (`$defs.op`). */
export const EDIT_OPS_ARRAY = Object.freeze({
  type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/op' },
  description: '要提交的 op 列表：原子、按顺序、任一失败整批不生效。',
});

export const EDIT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['expectedRev', 'requestId', 'ops'],
  properties: { ...EDIT_BASELINE, ops: EDIT_OPS_ARRAY },
  $defs: { op: OP_SCHEMA },
});

/**
 * `vdm_changeset_apply`: either a stored proposal (`id`) or a new one
 * (`ops`), plus the actor/intent that will be recorded.
 */
export const CHANGESET_APPLY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  $defs: { op: OP_SCHEMA },
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 512, description: '已存在（dryRun 预演过）的变更集 id；与 ops 二选一。' },
    ops: EDIT_OPS_ARRAY,
    actorId: ACTOR_ID,
    intent: { type: 'string', maxLength: 512, description: '一句人话说明这次改动的目的，记进变更集。' },
    expectedRev: EXPECTED_REV,
    requestId: REQUEST_ID,
    dryRun: DRY_RUN,
  },
});

/** Schema of every tool that carries the op contract, by tool name. */
export const TOOL_SCHEMAS = Object.freeze({
  vdm_project_apply_ops: EDIT_SCHEMA,
  vdm_changeset_apply: CHANGESET_APPLY_SCHEMA,
});

// ---------------------------------------------------------------- property paths
//
// One row per addressable field. `host`:
//   el  = 2D element (el.*)         keyframes: el.keyframes[] (flat list)
//   ob  = 3D object (scene.objects) keyframes: ob.tracks[path]
//   cam = camera                    keyframes: cam.tracks[path] (+ cam.path)
//
// `kind`:
//   track = keyframe path the evaluator samples for that host
//   field = document field written by set / updateElement / objectPatch / cameraSet
//   link  = only meaningful as a property-link endpoint (different spelling)
//
// `keyable`  = a key at this path changes the evaluated result
// `linkable` = propLink may use it as `to` / `from.path`
// `legacy`   = still read for old projects, but new elements never write it

const P = (host, id, type, unit, dflt, opts) => ({
  host, path: id, type, unit, default: dflt, kind: 'field', keyable: false, linkable: false, legacy: false, ...opts,
});

const node = DEFAULT_SPATIAL_NODE;
const nodeAxisDefault = (group, i) => node[group][i];

/** 2D element: the node model every new element gets (core/rotation-ops.js). */
const ELEMENT_TRACKS = [
  P('el', 'pivot.x', 'number', 'm', node.pivot[0], { kind: 'track', keyable: true, linkable: true,
    label: '横向位置', description: '世界米（100 px = 1 m）。画面中心 x = 0。' }),
  P('el', 'pivot.y', 'number', 'm', node.pivot[1], { kind: 'track', keyable: true, linkable: true,
    label: '纵向位置', description: '世界米，y 向上。1080 工程里画面中心 y = 5.4，画面下缘 y = 0。' }),
  P('el', 'pivot.z', 'number', 'm', node.pivot[2], { kind: 'track', keyable: true, linkable: true,
    label: '纵深', description: '世界米；z 越大越靠近默认相机（相机在 z = 20 看向 -Z）。' }),
  P('el', 'scale.x', 'number', 'ratio', node.scale[0], { kind: 'track', keyable: true, linkable: true,
    label: '横向缩放', description: '倍率，1 = 原尺寸。' }),
  P('el', 'scale.y', 'number', 'ratio', node.scale[1], { kind: 'track', keyable: true, linkable: true,
    label: '纵向缩放', description: '倍率，1 = 原尺寸。' }),
  P('el', 'scale.z', 'number', 'ratio', node.scale[2], { kind: 'track', keyable: true, linkable: true,
    label: '深度缩放', description: '倍率；平面元素的 z 缩放不改变画面尺寸，只影响子级。' }),
  P('el', 'rotation.x', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true,
    label: '绕 X 旋转', description: '度；三轴旋转与 roll 互斥（有 rotation 时以它为准）。' }),
  P('el', 'rotation.y', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true,
    label: '绕 Y 旋转', description: '度。' }),
  P('el', 'rotation.z', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true,
    label: '绕 Z 旋转（平面内）', description: '度；和 roll 是同一件事的三轴写法。' }),
  P('el', 'roll', 'number', 'deg', node.roll, { kind: 'track', keyable: true, linkable: true,
    label: '侧倾（平面内旋转）', description: '度；元素没有 rotation 时用这条轨。' }),
  P('el', 'position.x', 'number', 'm', node.position[0], { kind: 'track', keyable: false, linkable: true,
    label: '父级空间偏移 X', description: '米。属性链接与父级链会读写它；2D 元素自身的渲染不采样这条轨（见 CONTRACTS.md 已知遗留）。' }),
  P('el', 'position.y', 'number', 'm', node.position[1], { kind: 'track', keyable: false, linkable: true,
    label: '父级空间偏移 Y', description: '米；同上。' }),
  P('el', 'position.z', 'number', 'm', node.position[2], { kind: 'track', keyable: false, linkable: true,
    label: '父级空间偏移 Z', description: '米；同上。' }),
  P('el', 'style.size', 'number', 'project-px', DEFAULT_STYLE.size, { kind: 'track', keyable: true, linkable: true,
    label: '字号', description: '文字字号，项目像素；其他元素不使用。' }),
  P('el', 'style.text', 'string', null, DEFAULT_STYLE.text, { kind: 'track', keyable: true,
    label: '文字内容', description: '字符串轨：关键帧在离散时刻切换文本，不插值。' }),
  P('el', 'style.color', 'color', null, DEFAULT_STYLE.color, { kind: 'track', keyable: true,
    label: '颜色', description: '文字/图形颜色；颜色轨在关键帧处离散切换。' }),
  P('el', 'fx.glow', 'number', 'number', 0, { kind: 'track', keyable: true, linkable: true,
    label: '发光', description: '元素级辉光强度（0 起，常用 0..2）。' }),
  P('el', 'fx.blur', 'number', 'number', 0, { kind: 'track', keyable: true,
    label: '模糊', description: '元素级模糊强度（无量纲）。' }),
  P('el', AUDIO_VOLUME_PATH, 'number', 'ratio', 1, { kind: 'track', keyable: true, linkable: true,
    label: '音量', description: '音频线性音量 0..1；音频自动化按线性段插值（core/audio.js::audioVolume）。' }),
];

/**
 * Element paths that only exist as property-link endpoints. `opacity` is the
 * link spelling (core/links.js writes it into the `transform.opacity` track);
 * a key written at `opacity` is not sampled by the evaluator, so it is not
 * `keyable`.
 */
const ELEMENT_LINK_PATHS = [
  P('el', 'opacity', 'number', 'ratio', 1, { kind: 'link', linkable: true, linkAlias: 'transform.opacity',
    label: '透明度', description: '属性链接用的写法；链接写入的值落到唯一生效的透明度轨道（旧名字，见 LEGACY_PATHS）。' }),
];

/** 2D element: document fields an agent writes with set / updateElement. */
const ELEMENT_FIELDS = [
  P('el', 'id', 'string', null, '', { label: '元素 id', description: 'el_*；不可修改（只能新建）。' }),
  P('el', 'type', 'enum', null, ELEMENT_TYPES[0], { enum: ELEMENT_TYPES, label: '元素类型', description: '文字 / 图片 / 视频 / 图形 / 音频 / 摄像机画面 / 代码图层之一。' }),
  P('el', 'name', 'string', null, '', { label: '名字', description: '时间线与检查器里显示的名字。' }),
  P('el', 'src', 'string', null, '', { label: '素材路径', description: 'image / video / audio 的媒体相对路径（media/ 下）。' }),
  P('el', 'start', 'number', 's', 0, { label: '起点', description: '项目绝对时间（秒）。' }),
  P('el', 'duration', 'number', 's', 1, { label: '时长', description: '秒；媒体会被素材时长夹紧。' }),
  P('el', 'z', 'number', 'number', 0, { label: '层序', description: '越大越靠前；同 z 按元素数组顺序。' }),
  P('el', 'segment', 'string', null, null, { label: '所属分镜', description: '分镜 id 或 null。' }),
  P('el', 'visible', 'boolean', null, true, { label: '可见', description: 'false 后不参与渲染与测量。' }),
  P('el', 'locked', 'boolean', null, false, { label: '锁定', description: 'true 后 agent 身份（agent:*）的写入返回 LOCKED；人和 ui 仍可改。' }),
  P('el', 'loop', 'boolean', null, false, { label: '循环', description: '视频/音频素材循环填满时间块。' }),
  P('el', 'fadeIn', 'number', 's', 0, { label: '淡入', description: '秒。' }),
  P('el', 'fadeOut', 'number', 's', 0, { label: '淡出', description: '秒。' }),
  P('el', 'punch', 'number', 'number', 0, { label: '节拍冲击', description: '0..1；按 meta.beats 做缩放脉冲。' }),
  P('el', 'srcIn', 'number', 's', 0, { label: '素材入点', description: '从素材的第几秒开始用（秒）。' }),
  P('el', 'volume', 'number', 'ratio', 1, { label: '基础音量', description: '0..1；关键帧在 audio.volume 轨上。' }),
  P('el', 'motion.type', 'enum', null, DEFAULT_MOTION.type, { enum: ['none', 'in', 'out', 'left', 'right', 'up', 'down', 'drift', 'shake'], label: '运动预设', description: '叠加在关键帧之上的预设位移。' }),
  P('el', 'motion.amount', 'number', 'ratio', DEFAULT_MOTION.amount, { label: '运动强度', description: '0..1。' }),
  P('el', 'motion.dir', 'enum', null, DEFAULT_MOTION.dir, { enum: ['in', 'out'], label: '运动方向', description: '预设朝向。' }),
  P('el', 'style.fit', 'enum', null, DEFAULT_STYLE.fit, { enum: ['cover', 'contain', 'stretch'], label: '填充方式', description: '图片/视频在平面上的取景方式；contain 实际按 cover 裁（见 §4.4）。' }),
  P('el', 'style.font', 'string', null, DEFAULT_STYLE.font, { label: '字体', description: '字体族名。' }),
  P('el', 'style.weight', 'number', 'number', DEFAULT_STYLE.weight, { label: '字重', description: '100..900。' }),
  P('el', 'style.align', 'enum', null, DEFAULT_STYLE.align, { enum: ['left', 'center', 'right'], label: '对齐', description: '文字对齐。' }),
  P('el', 'style.lineHeight', 'number', 'ratio', DEFAULT_STYLE.lineHeight, { label: '行高', description: '倍率。' }),
  P('el', 'style.letterSpacing', 'number', 'project-px', DEFAULT_STYLE.letterSpacing, { label: '字距', description: '项目像素。' }),
  P('el', 'style.shadow', 'number', 'number', DEFAULT_STYLE.shadow, { label: '投影', description: '0..1 的文字投影强度。' }),
  P('el', 'style.shape', 'enum', null, DEFAULT_STYLE.shape, { enum: ['rect', 'ellipse'], label: '形状', description: 'shape 元素用。' }),
  P('el', 'style.fill', 'color', null, DEFAULT_STYLE.fill, { label: '填充色', description: '图形/物体的填充色。' }),
  P('el', 'style.radius', 'number', 'project-px', DEFAULT_STYLE.radius, { label: '圆角', description: '项目像素。' }),
  P('el', 'style.stroke', 'color', null, DEFAULT_STYLE.stroke, { label: '描边色', description: '空字符串 = 无描边。' }),
  P('el', 'style.strokeWidth', 'number', 'project-px', DEFAULT_STYLE.strokeWidth, { label: '描边宽度', description: '项目像素。' }),
  P('el', 'node.pivot', 'vec3', 'm', [...node.pivot], { label: '节点位置', description: 'el.node.pivot（米）；关键帧请用 pivot.x/y/z。' }),
  P('el', 'node.rotation', 'vec3', 'deg', [0, 0, 0], { label: '节点旋转', description: 'el.node.rotation（度）；关键帧请用 rotation.x/y/z。' }),
  P('el', 'node.roll', 'number', 'deg', node.roll, { label: '节点侧倾', description: 'el.node.roll（度）；关键帧请用 roll。' }),
  P('el', 'node.scale', 'vec3', 'ratio', [...node.scale], { label: '节点缩放', description: 'el.node.scale；关键帧请用 scale.x/y/z。' }),
  P('el', 'node.position', 'vec3', 'm', [...node.position], { label: '节点偏移', description: 'el.node.position（父级空间，米）；关键帧请用 position.x/y/z。' }),
  P('el', 'code.source', 'string', null, '', { label: '代码源 id', description: 'code 元素引用的源（sources/<id>/）。' }),
  P('el', 'code.params.<name>', 'any', 'any', null, { kind: 'track', keyable: true, linkable: true,
    label: '代码参数', description: 'manifest.params[].id 声明的参数；类型与单位由源声明。' }),
];

/** 3D object tracks. Whole-vector and per-axis spellings both work. */
const OBJECT_TRACKS = [
  P('ob', 'pivot', 'vec3', 'm', [...node.pivot], { kind: 'track', keyable: true, label: '位置', description: '世界米；也可以按 pivot.x / pivot.y / pivot.z 打标量帧。' }),
  P('ob', 'pivot.x', 'number', 'm', 0, { kind: 'track', keyable: true, linkable: true, label: '横向位置', description: '世界米。' }),
  P('ob', 'pivot.y', 'number', 'm', 0, { kind: 'track', keyable: true, linkable: true, label: '纵向位置', description: '世界米，y 向上。' }),
  P('ob', 'pivot.z', 'number', 'm', 0, { kind: 'track', keyable: true, linkable: true, label: '纵深', description: '世界米。' }),
  P('ob', 'position', 'vec3', 'm', [...node.position], { kind: 'track', keyable: true, label: '几何偏移', description: '在物体自身基向量下的偏移（米）；也可按 position.x/y/z 打帧。' }),
  P('ob', 'position.x', 'number', 'm', 0, { kind: 'track', keyable: true, linkable: true, label: '偏移 X', description: '米。' }),
  P('ob', 'position.y', 'number', 'm', 0, { kind: 'track', keyable: true, linkable: true, label: '偏移 Y', description: '米。' }),
  P('ob', 'position.z', 'number', 'm', 0, { kind: 'track', keyable: true, linkable: true, label: '偏移 Z', description: '米。' }),
  P('ob', 'scale', 'vec3', 'ratio', [...node.scale], { kind: 'track', keyable: true, label: '缩放', description: '倍率；也可按 scale.x/y/z 打帧。' }),
  P('ob', 'scale.x', 'number', 'ratio', 1, { kind: 'track', keyable: true, linkable: true, label: '横向缩放', description: '倍率。' }),
  P('ob', 'scale.y', 'number', 'ratio', 1, { kind: 'track', keyable: true, linkable: true, label: '纵向缩放', description: '倍率。' }),
  P('ob', 'scale.z', 'number', 'ratio', 1, { kind: 'track', keyable: true, linkable: true, label: '深度缩放', description: '倍率。' }),
  P('ob', 'dir', 'vec3', 'dir', [...node.dir], { kind: 'track', keyable: true, label: '朝向', description: '单位方向向量（旧式旋转）。' }),
  P('ob', 'roll', 'number', 'deg', node.roll, { kind: 'track', keyable: true, linkable: true, label: '侧倾', description: '度。' }),
  P('ob', 'rotation.x', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true, label: '绕 X 旋转', description: '度。' }),
  P('ob', 'rotation.y', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true, label: '绕 Y 旋转', description: '度。' }),
  P('ob', 'rotation.z', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true, label: '绕 Z 旋转', description: '度。' }),
  P('ob', 'opacity', 'number', 'ratio', 1, { kind: 'track', keyable: true, linkable: true, label: '不透明度', description: '0..1。' }),
];

const OBJECT_FIELDS = [
  P('ob', 'id', 'string', null, '', { label: '物体 id', description: 'ob_*。' }),
  P('ob', 'type', 'enum', null, 'solid', { enum: ['solid', 'shape', 'text', 'image', 'video', 'container', 'empty', 'camera', 'audio'], label: '物体类型', description: '只有可画类型进帧 IR。' }),
  P('ob', 'name', 'string', null, '', { label: '名字', description: '显示名。' }),
  P('ob', 'start', 'number', 's', 0, { label: '起点', description: '项目绝对时间（秒）。' }),
  P('ob', 'duration', 'number', 's', 1, { label: '时长', description: '秒。' }),
  P('ob', 'visible', 'boolean', null, true, { label: '可见', description: 'false 后不参与渲染。' }),
  P('ob', 'locked', 'boolean', null, false, { label: '锁定', description: 'agent:* 身份的写入返回 LOCKED。' }),
  P('ob', 'geom.w', 'number', 'm', 2, { label: '宽', description: '米。' }),
  P('ob', 'geom.h', 'number', 'm', 2, { label: '高', description: '米。' }),
  P('ob', 'geom.d', 'number', 'm', 2, { label: '深', description: '米。' }),
  P('ob', 'style.color', 'color', null, '#17d9ff', { label: '颜色', description: '物体基色。' }),
  P('ob', 'style.emissive', 'number', 'number', 0, { label: '自发光', description: '0..1。' }),
];

/**
 * Camera tracks: exactly `CAMERA_TRACK_DIMS` (ops.js) plus the path keys
 * (`cameraKey`). Labels/units/defaults come from core/templates.js where the
 * template registry has a row for the same channel; the test cross-checks.
 */
const CAMERA_TRACKS = [
  P('cam', 'center', 'vec3', 'm', [...node.pivot], { kind: 'track', keyable: true, label: '中心点', description: '相机位置（世界米）；旧式 path 之外的整段偏移，也可写作 pivot.x 做属性链接。' }),
  P('cam', 'scale', 'vec3', 'ratio', [1, 1, 1], { kind: 'track', keyable: true, label: '缩放', description: '倍率；只影响子级，不改变取景。' }),
  P('cam', 'picturePivot', 'vec2', 'normalized', [0.5, 0.5], { kind: 'track', keyable: true, label: '画面中心', description: '归一化 0..1。' }),
  P('cam', 'pictureOffset', 'vec2', 'normalized', [0, 0], { kind: 'track', keyable: true, label: '画面位置', description: '归一化 -1..1。' }),
  P('cam', 'opacity', 'number', 'ratio', 1, { kind: 'track', keyable: true, linkable: true, label: '透明度', description: '0..1；< 0.002 时整层不画。' }),
  P('cam', 'fov', 'number', 'deg', 62, { kind: 'track', keyable: true, linkable: true, label: '视场角 FOV', description: '度；≥ 180 自动切等距鱼眼。' }),
  P('cam', 'lookAhead', 'number', 'm', 90, { kind: 'track', keyable: true, linkable: true, label: '看向前方', description: '米；路径朝向的前瞻距离。' }),
  P('cam', 'bankGain', 'number', 'ratio', 1.2, { kind: 'track', keyable: true, linkable: true, label: '转弯侧倾', description: '倍率。' }),
  P('cam', 'maxRoll', 'number', 'deg', 32, { kind: 'track', keyable: true, linkable: true, label: '最大侧倾', description: '度。' }),
  P('cam', 'roll', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true, label: '侧倾', description: '度；相机自身 roll，与路径转向无关。' }),
  P('cam', 'rotation.x', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true, label: '绕 X 旋转', description: '度；三轴旋转偏移。' }),
  P('cam', 'rotation.y', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true, label: '绕 Y 旋转', description: '度。' }),
  P('cam', 'rotation.z', 'number', 'deg', 0, { kind: 'track', keyable: true, linkable: true, label: '绕 Z 旋转', description: '度。' }),
  P('cam', 'shake.amp', 'number', 'm', 0.6, { kind: 'track', keyable: true, linkable: true, label: '抖动幅度', description: '米。' }),
  P('cam', 'shake.freq', 'number', 'hz', 1.6, { kind: 'track', keyable: true, linkable: true, label: '抖动频率', description: 'Hz。' }),
  P('cam', 'shake.speedGain', 'number', 'ratio', 1, { kind: 'track', keyable: true, linkable: true, label: '随速度增强', description: '倍率 0..2。' }),
  P('cam', 'shake.seed', 'number', 'number', 7, { kind: 'track', keyable: false, linkable: true, label: '随机种子', description: '整段镜头属性（templates 标为 shot 级），不能逐帧打。' }),
  P('cam', 'dof.enabled', 'boolean', null, false, { kind: 'track', keyable: true, linkable: false, label: '景深', description: '开关。' }),
  P('cam', 'dof.fstop', 'number', 'f-stop', 2.8, { kind: 'track', keyable: true, linkable: true, label: '光圈 f', description: '0.5..32。' }),
  P('cam', 'path', 'path3', 'm', [], { kind: 'track', keyable: true, label: '相机路径', description: '相机位置动画：用 cameraKey / cameraRemove 写，不是普通参数轨道。' }),
  // Link-only spellings: property links address the camera's node channels.
  P('cam', 'pivot.x', 'number', 'm', 0, { kind: 'link', linkable: true, linkAlias: 'center', label: '中心点 X', description: '属性链接用的写法，映射到 center。' }),
  P('cam', 'pivot.y', 'number', 'm', 0, { kind: 'link', linkable: true, linkAlias: 'center', label: '中心点 Y', description: '属性链接用的写法，映射到 center。' }),
  P('cam', 'pivot.z', 'number', 'm', 0, { kind: 'link', linkable: true, linkAlias: 'center', label: '中心点 Z', description: '属性链接用的写法，映射到 center。' }),
  P('cam', 'scale.x', 'number', 'ratio', 1, { kind: 'link', linkable: true, linkAlias: 'scale', label: '横向缩放', description: '属性链接用的写法，映射到 scale。' }),
  P('cam', 'scale.y', 'number', 'ratio', 1, { kind: 'link', linkable: true, linkAlias: 'scale', label: '纵向缩放', description: '属性链接用的写法，映射到 scale。' }),
  P('cam', 'scale.z', 'number', 'ratio', 1, { kind: 'link', linkable: true, linkAlias: 'scale', label: '深度缩放', description: '属性链接用的写法，映射到 scale。' }),
];

const CAMERA_FIELDS = [
  P('cam', 'id', 'string', null, '', { label: '相机 id', description: 'cam_*。' }),
  P('cam', 'name', 'string', null, '', { label: '名字', description: '显示名。' }),
  P('cam', 'focal', 'number', 'project-px', 0, { label: '焦距（保留）', description: '历史字段，取景由 fov 决定。' }),
  P('cam', 'near', 'number', 'm', 0.1, { label: '近裁剪面', description: '米。' }),
  P('cam', 'far', 'number', 'm', 1000, { label: '远裁剪面', description: '米。' }),
  P('cam', 'motionBlur.enabled', 'boolean', null, false, { label: '运动模糊', description: '整段镜头属性。' }),
  P('cam', 'motionBlur.shutter', 'number', 'ratio', 0.5, { label: '快门角', description: '0..1（整段镜头属性）。' }),
  P('cam', 'locked', 'boolean', null, false, { label: '锁定', description: 'agent:* 身份的写入返回 LOCKED；人和 ui 仍可改。' }),
];

/** Every addressable path, in doc order. */
export const PROPERTY_PATHS = Object.freeze([
  ...ELEMENT_TRACKS, ...ELEMENT_LINK_PATHS, ...ELEMENT_FIELDS, ...OBJECT_TRACKS, ...OBJECT_FIELDS, ...CAMERA_TRACKS, ...CAMERA_FIELDS,
].map((row) => Object.freeze({
  required: false, enum: null, description: '', label: row.path, linkAlias: null, legacy: false, ...row,
})));

const byHost = (host) => PROPERTY_PATHS.filter((row) => row.host === host);
export const PROPERTY_PATHS_BY_HOST = Object.freeze({ el: byHost('el'), ob: byHost('ob'), cam: byHost('cam') });

/** Paths whose keyframes the evaluator samples, per host. */
export const KEYABLE_PATHS = Object.freeze(Object.fromEntries(
  ['el', 'ob', 'cam'].map((host) => [host, Object.freeze(byHost(host).filter((row) => row.keyable).map((row) => row.path))]),
));

/** Paths a property link may reference, per host. */
export const LINKABLE_PATHS = Object.freeze(Object.fromEntries(
  ['el', 'ob', 'cam'].map((host) => [host, Object.freeze(byHost(host).filter((row) => row.linkable).map((row) => row.path))]),
));

/** Value families a property link may connect; re-exported so the docs quote links.js. */
export const LINK_UNIT_FAMILIES = LINK_UNITS;

/** Hosts that can be locked (`locked: true` refuses `agent:*` writes). */
export const LOCKABLE_HOSTS = Object.freeze(PROPERTY_PATHS.filter((row) => row.path === 'locked').map((row) => row.host));

/**
 * Old paths. `status: 'deprecated'` means new elements must not use it (the
 * evaluator only reads it for projects that were never migrated,
 * core/spatial.js::legacyElementNode). `status: 'kept'` means the name was
 * never migrated and is still the only implementation — documented here so the
 * agent protocol has exactly one place where `transform.*` appears.
 */
export const LEGACY_PATHS = Object.freeze([
  { host: 'el', path: 'transform.x', unit: 'project-px', status: 'deprecated', description: '旧 2D 横向位置（像素，y 向下）；新元素改用 pivot.x（米）。' },
  { host: 'el', path: 'transform.y', unit: 'project-px', status: 'deprecated', description: '旧 2D 纵向位置（像素，y 向下）；新元素改用 pivot.y（米）。' },
  { host: 'el', path: 'transform.z', unit: 'm', status: 'deprecated', description: '旧深度（米）；新元素改用 pivot.z。' },
  { host: 'el', path: 'transform.scale', unit: 'ratio', status: 'deprecated', description: '旧统一缩放；新元素改用 scale.x / scale.y。' },
  { host: 'el', path: 'transform.rotation', unit: 'deg', status: 'deprecated', description: '旧平面旋转；新元素改用 roll 或 rotation.z。' },
  { host: 'el', path: 'transform.opacity', unit: 'ratio', status: 'kept', description: '透明度：名字沿用旧字段，但它是唯一生效的透明度轨道（新元素也一样）。淡入淡出也可以改用 fadeIn / fadeOut 字段。' },
]);

// ---------------------------------------------------------------- defaults

/** What the create ops fill in (docs/CONTRACTS.md prints this table). */
export const DOCUMENT_DEFAULTS = Object.freeze({
  element: Object.freeze({
    transform: Object.freeze({ ...DEFAULT_TRANSFORM }),
    style: Object.freeze({ ...DEFAULT_STYLE }),
    fx: Object.freeze({ ...DEFAULT_FX }),
    motion: Object.freeze({ ...DEFAULT_MOTION }),
    node: Object.freeze({ ...node }),
    start: 0,
    duration: 1,
    z: 'max+1',
    visible: true,
    locked: false,
    loop: false,
    fadeIn: 0,
    fadeOut: 0,
    punch: 0,
    srcIn: 0,
    volume: 1,
  }),
  object: Object.freeze({ pivot: [0, 0, 0], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], opacity: 1, geom: { w: 2, h: 2, d: 2 }, type: 'solid' }),
  camera: Object.freeze({
    center: [0, 0, 0],
    scale: [1, 1, 1],
    opacity: 1,
    roll: 0,
    fov: '计算：按画幅填满画面（1920×1080 约 51.28°，core/space.js::defaultFov）',
    motionBlur: { enabled: false, shutter: 0.5 },
    shake: { amp: 0 },
  }),
});

/** Camera/object rows whose template entry the test can cross-check. */
export const TEMPLATE_CHANNELS = Object.freeze(TEMPLATE_PROPERTIES);
