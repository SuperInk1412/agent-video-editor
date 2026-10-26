// Property / element template registry — the parallel-development contract.
// Pure ESM, no DOM, no node:* imports: shared by the browser UI and Node engine.
//
// The UI, engine and Blender generator read these descriptors instead of
// hardcoding "FOV is a 1..360 number" in four places. New properties/elements
// add an entry here (plus the matching op/eval/render handler); they do not
// branch through the whole timeline/inspector/Blender code.
export const SCHEMA_VERSION = 1;

export const PROPERTY_TYPES = [
  'number', 'vec2', 'vec3', 'percent', 'boolean', 'enum', 'color', 'path3',
];

export const KEYABILITY = {
  none: false,
  frame: 'frame',
  shot: 'shot',
};

const CAMERA_OPS = { set: 'cameraSet', key: 'cameraParamKey', unkey: 'cameraParamUnkey' };

const prop = (id, spec) => ({ id, schemaVersion: SCHEMA_VERSION, ...spec });

export const GROUPS = {
  transform: {
    id: 'transform', label: '变换', order: 0, defaultOpen: true,
    summary: 'transform',
  },
  content: {
    id: 'content', label: '内容', order: 5, defaultOpen: true,
    summary: 'content',
  },
  lens: {
    id: 'lens', label: '镜头 / 构图', order: 10, defaultOpen: false,
    summary: 'camera.lens',
  },
  shake: {
    id: 'shake', label: '抖动', order: 20, defaultOpen: false,
    summary: 'camera.shake',
  },
  dofMb: {
    id: 'dofMb', label: '景深 / 模糊', order: 30, defaultOpen: false,
    summary: 'camera.dofMb',
  },
};

export const PROPERTIES = {
  // ---- base transform (all elements) ----
  'transform.center': prop('transform.center', {
    label: '中心点', group: 'transform', type: 'vec3', unit: 'm',
    default: [0, 0, 0], keyable: KEYABILITY.frame, value: 'center',
    channel: { kind: 'vec3', path: 'center' },
    row: 'vec3',
  }),
  'transform.position': prop('transform.position', {
    label: '位置', group: 'transform', type: 'vec3', unit: 'm',
    default: [0, 0, 0], keyable: KEYABILITY.frame, value: 'position',
    channel: { kind: 'vec3', path: 'position' },
    row: 'vec3',
  }),
  'transform.opacity': prop('transform.opacity', {
    label: '透明度', group: 'transform', type: 'percent',
    default: 1, keyable: KEYABILITY.frame, value: 'opacity',
    channel: { kind: 'scalar', path: 'opacity' },
    row: 'percent',
  }),
  'transform.scale': prop('transform.scale', {
    label: '缩放', group: 'transform', type: 'vec3',
    default: [1, 1, 1], keyable: KEYABILITY.frame, value: 'scale',
    channel: { kind: 'vec3', path: 'scale' },
    row: 'vec3', z: 'kept',
  }),
  'element.visible': prop('element.visible', {
    label: '可见', group: null, type: 'boolean', default: true,
    keyable: KEYABILITY.none, value: 'visible', row: 'eye',
  }),

  // ---- 3D solid content ----
  'solid.primitive': prop('solid.primitive', {
    label: '图元', group: 'content', type: 'enum', default: 'box',
    options: ['box', 'cylinder', 'pen'], keyable: KEYABILITY.none,
    value: 'primitive', row: 'select',
  }),
  'solid.geom': prop('solid.geom', {
    label: '几何', group: 'content', type: 'vec3', unit: 'm',
    default: [2, 2, 2], keyable: KEYABILITY.none, value: 'geom',
    row: 'vec3',
  }),
  'solid.color': prop('solid.color', {
    label: '颜色', group: 'content', type: 'color', default: '#17d9ff',
    keyable: KEYABILITY.none, value: 'style.color', row: 'color',
  }),

  // ---- camera: path is the transform "position" ----
  'camera.path': prop('camera.path', {
    label: '位置', group: 'transform', type: 'path3', unit: 'm',
    default: [], keyable: KEYABILITY.frame, value: 'path',
    channel: { kind: 'path', path: 'path' },
    ops: { key: 'cameraKey', remove: 'cameraRemove' },
    row: 'path3',
  }),
  'camera.picturePivot': prop('camera.picturePivot', {
    label: '画面中心', group: 'transform', type: 'vec2', unit: 'normalized',
    default: [0.5, 0.5], keyable: KEYABILITY.frame, value: 'picturePivot',
    channel: { kind: 'vec2', path: 'picturePivot' },
    ops: CAMERA_OPS, row: 'vec2',
  }),
  'camera.pictureOffset': prop('camera.pictureOffset', {
    label: '画面位置', group: 'transform', type: 'vec2', unit: 'normalized',
    default: [0, 0], keyable: KEYABILITY.frame, value: 'pictureOffset',
    channel: { kind: 'vec2', path: 'pictureOffset' },
    ops: CAMERA_OPS, row: 'vec2',
  }),

  // ---- camera: lens / composition ----
  'camera.fov': prop('camera.fov', {
    label: '视场角 FOV', group: 'lens', type: 'number', unit: '°',
    default: 62, range: [1, 360], step: 1,
    keyable: KEYABILITY.frame, value: 'fov',
    channel: { kind: 'scalar', path: 'fov' }, ops: CAMERA_OPS,
    row: 'number', badge: 'fisheye', hint: '≥180° 自动切等距鱼眼；Blender 用 Cycles',
  }),
  'camera.lookAhead': prop('camera.lookAhead', {
    label: '看向前方', group: 'lens', type: 'number', unit: 'm',
    default: 90, range: [2, 500], step: 5,
    keyable: KEYABILITY.frame, value: 'lookAhead',
    channel: { kind: 'scalar', path: 'lookAhead' }, ops: CAMERA_OPS, row: 'number',
  }),
  'camera.bankGain': prop('camera.bankGain', {
    label: '转弯侧倾', group: 'lens', type: 'number',
    default: 1.2, range: [0, 4], step: 0.1,
    keyable: KEYABILITY.frame, value: 'bankGain',
    channel: { kind: 'scalar', path: 'bankGain' }, ops: CAMERA_OPS, row: 'number',
  }),
  'camera.maxRoll': prop('camera.maxRoll', {
    label: '最大侧倾', group: 'lens', type: 'number', unit: '°',
    default: 32, range: [0, 60], step: 1,
    keyable: KEYABILITY.frame, value: 'maxRoll',
    channel: { kind: 'scalar', path: 'maxRoll' }, ops: CAMERA_OPS, row: 'number',
  }),
  'camera.roll': prop('camera.roll', {
    label: '手动 roll', group: 'lens', type: 'number', unit: '°',
    default: 0, range: [-60, 60], step: 1,
    keyable: KEYABILITY.frame, value: 'roll',
    channel: { kind: 'scalar', path: 'roll' }, ops: CAMERA_OPS, row: 'number',
  }),

  // ---- camera: shake ----
  'camera.shake.amp': prop('camera.shake.amp', {
    label: '抖动幅度', group: 'shake', type: 'number', unit: 'm',
    default: 0.6, range: [0, 5], step: 0.05,
    keyable: KEYABILITY.frame, value: 'shake.amp',
    channel: { kind: 'scalar', path: 'shake.amp' }, ops: CAMERA_OPS, row: 'number',
  }),
  'camera.shake.freq': prop('camera.shake.freq', {
    label: '抖动频率', group: 'shake', type: 'number', unit: 'Hz',
    default: 1.6, range: [0.1, 8], step: 0.1,
    keyable: KEYABILITY.frame, value: 'shake.freq',
    channel: { kind: 'scalar', path: 'shake.freq' }, ops: CAMERA_OPS, row: 'number',
  }),
  'camera.shake.speedGain': prop('camera.shake.speedGain', {
    label: '随速度增强', group: 'shake', type: 'number',
    default: 1, range: [0, 2], step: 0.1,
    keyable: KEYABILITY.frame, value: 'shake.speedGain',
    channel: { kind: 'scalar', path: 'shake.speedGain' }, ops: CAMERA_OPS, row: 'number',
  }),
  'camera.shake.seed': prop('camera.shake.seed', {
    label: '随机种子', group: 'shake', type: 'number',
    default: 7, step: 1, keyable: KEYABILITY.shot, value: 'shake.seed',
    row: 'number', badge: '整段',
  }),

  // ---- camera: DOF + motion blur (C-b) ----
  'camera.dof.enabled': prop('camera.dof.enabled', {
    label: '景深', group: 'dofMb', type: 'boolean', default: false,
    keyable: KEYABILITY.frame, value: 'dof.enabled',
    channel: { kind: 'boolean', path: 'dof.enabled' }, ops: CAMERA_OPS, row: 'select',
  }),
  'camera.dof.fstop': prop('camera.dof.fstop', {
    label: '光圈 f', group: 'dofMb', type: 'number',
    default: 2.8, range: [0.5, 32], step: 0.2,
    keyable: KEYABILITY.frame, value: 'dof.fstop',
    channel: { kind: 'scalar', path: 'dof.fstop' }, ops: CAMERA_OPS, row: 'number',
  }),
  'camera.motionBlur.enabled': prop('camera.motionBlur.enabled', {
    label: '运动模糊', group: 'dofMb', type: 'boolean', default: true,
    keyable: KEYABILITY.shot, value: 'motionBlur.enabled',
    row: 'select', badge: '整段',
  }),
  'camera.motionBlur.shutter': prop('camera.motionBlur.shutter', {
    label: '快门角', group: 'dofMb', type: 'number',
    default: 0.5, range: [0, 1], step: 0.05,
    keyable: KEYABILITY.shot, value: 'motionBlur.shutter',
    row: 'number', badge: '整段',
  }),
};

const baseTransform = {
  center: 'transform.center',
  position: 'transform.position',
  opacity: 'transform.opacity',
  scale: 'transform.scale',
};

export const ELEMENTS = {
  camera: {
    type: 'camera', schemaVersion: SCHEMA_VERSION, label: '相机', idPrefix: 'cam_',
    color: '#c9a6ff', groups: ['transform', 'lens', 'shake', 'dofMb'],
    properties: [
      'camera.path', 'transform.center', 'camera.picturePivot', 'camera.pictureOffset',
      'transform.opacity', 'transform.scale',
      'camera.fov', 'camera.lookAhead', 'camera.bankGain', 'camera.maxRoll', 'camera.roll',
      'camera.shake.amp', 'camera.shake.freq', 'camera.shake.speedGain', 'camera.shake.seed',
      'camera.dof.enabled', 'camera.dof.fstop', 'camera.motionBlur.enabled', 'camera.motionBlur.shutter',
      'element.visible',
    ],
    transform: {
      center: 'transform.center', position: 'camera.path',
      opacity: 'transform.opacity', scale: 'transform.scale',
      picturePivot: 'camera.picturePivot', pictureOffset: 'camera.pictureOffset',
    },
    ops: {
      set: 'cameraSet', key: 'cameraParamKey', unkey: 'cameraParamUnkey',
      pathKey: 'cameraKey', pathRemove: 'cameraRemove',
    },
    layer: { stack: true, blend: 'alpha', order: 'timeline', timer: 'top-over-bottom', solo: 'viewport' },
    eval: { module: 'core/camera.js', fn: 'evalCamera' },
    bake: { module: 'engine/shot.js', fn: 'bakeCameraTrack' },
    preview: { renderer: 'camera3d', post: 'layerQuad' },
    blender: { builder: 'blender/vdm_city.py', panorama: 'FISHEYE_EQUIDISTANT', layers: 'compositor' },
    timeline: { block: 'camera', positionRow: 'camera.path', keyableGroups: ['transform', 'lens', 'shake', 'dofMb'] },
    create: {
      tool: 'create-camera',
      source: 'current-viewport',
      at: 'playhead',
      pathKeys: 1,
      look: true,
      stack: 'top',
      active: true,
    },
  },
  solid: {
    type: 'solid', schemaVersion: SCHEMA_VERSION, label: '3D 物体', idPrefix: 'ob_',
    color: '#17d9ff', groups: ['content', 'transform'],
    properties: [
      'transform.position', 'transform.center', 'transform.opacity', 'transform.scale',
      'solid.primitive', 'solid.geom', 'solid.color', 'element.visible',
    ],
    transform: baseTransform,
    ops: { set: 'objectPatch', key: 'objectKey', unkey: 'objectUnkey' },
    primitives: ['box', 'cylinder', 'pen'],
    eval: { module: 'core/scene.js', fn: 'objectPose' },
    bake: { module: 'engine/shot.js', fn: 'bakeObjects' },
    preview: { renderer: 'object3d' },
    blender: { builder: 'blender/vdm_city.py', objects: '_build_objects' },
    timeline: { block: 'object', positionRow: 'transform.position' },
    create: { tool: 'create-3d' },
  },
  empty: {
    type: 'empty', schemaVersion: SCHEMA_VERSION, label: '空元素', idPrefix: 'emp_',
    color: '#8a93a5', groups: ['transform'],
    properties: ['transform.position', 'transform.center', 'transform.opacity', 'transform.scale', 'element.visible'],
    transform: baseTransform,
    ops: { set: 'objectPatch', key: 'objectKey', unkey: 'objectUnkey' },
    preview: { renderer: 'empty' },
    timeline: { block: 'empty', positionRow: 'transform.position' },
    parenting: { transformAffectsChildren: true, rotationViaParent: true },
    create: { tool: 'create-empty' },
  },
};

export const TOOLBAR = {
  placement: 'app-header-left',
  orientation: 'horizontal',
  longPress: true,
};

export const TOOLS = [
  { id: 'select', label: '选择', order: 0, kind: 'select' },
  { id: 'create-camera', label: '新建相机', order: 10, kind: 'create', element: 'camera' },
  {
    id: 'create-3d', label: '新建 3D 物体', order: 20, kind: 'create', element: 'solid',
    longPress: true,
    submenu: [
      { primitive: 'box', label: '立方体' },
      { primitive: 'cylinder', label: '圆柱' },
      { primitive: 'pen', label: '钢笔' },
    ],
  },
];

export const SELECTION = {
  kinds: ['element', 'property', 'keyframe'],
  homogeneous: true,
  aggregate: {
    element: 'all-properties',
    group: 'group-properties',
    reverse: 'expand-to-properties',
  },
  keyframe: {
    mixable: false,
    requiresClear: true,
    marquee: 'B',
  },
  u: {
    pool: 'element',
    groups: ['full', 'keyed', 'collapsed'],
  },
};

export const CAMERA_STACK = {
  list: 'cameras',
  order: 'cameraOrder',
  active: 'activeCameraId',
  blend: 'alpha',
  timelineOrder: 'top-over-bottom',
  background: 'black',
  visibility: 'visible',
  add: { source: 'toolbar-only', position: 'top', active: true },
  solo: { scope: 'viewport', menu: 'cameraContext' },
};

export const PICTURE_TRANSFORM = {
  units: 'normalized',
  origin: [0.5, 0.5],
  pivot: 'camera.picturePivot',
  offset: 'camera.pictureOffset',
  scale: 'transform.scale',
  opacity: 'transform.opacity',
  order: ['pivot', 'offset', 'scale', 'opacity'],
  z: 'kept-unused',
};

/** Resolve helpers used by UI/engine/tests. */
export function getProperty(id) {
  return PROPERTIES[id] || null;
}

export function getElement(type) {
  return ELEMENTS[type] || null;
}

export function elementProperties(elementType) {
  const el = getElement(elementType);
  if (!el) return [];
  return el.properties.map(getProperty).filter(Boolean);
}

export function groupProperties(elementType, groupId) {
  return elementProperties(elementType).filter((p) => p.group === groupId);
}

export function keyableProperties(elementType, keyable = KEYABILITY.frame) {
  return elementProperties(elementType).filter((p) => p.keyable === keyable);
}
