import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, PROPERTIES, GROUPS, ELEMENTS, TOOLS, TOOLBAR,
  SELECTION, CAMERA_STACK, PICTURE_TRANSFORM, KEYABILITY,
  getProperty, getElement, elementProperties, groupProperties, keyableProperties,
} from '../core/templates.js';

test('template registry: schema version and unique ids', () => {
  assert.equal(SCHEMA_VERSION, 1);
  const ids = Object.keys(PROPERTIES);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(PROPERTIES[id].id, id, id);
  const types = Object.keys(ELEMENTS);
  assert.equal(new Set(types).size, types.length);
  for (const t of types) assert.equal(ELEMENTS[t].type, t, t);
  const toolIds = TOOLS.map((t) => t.id);
  assert.equal(new Set(toolIds).size, toolIds.length);
});

test('template registry: every element property exists and groups resolve', () => {
  for (const [type, el] of Object.entries(ELEMENTS)) {
    assert.equal(el.schemaVersion, SCHEMA_VERSION, type);
    assert.ok(el.groups.length > 0, type);
    for (const group of el.groups) assert.ok(GROUPS[group], `${type}/${group}`);
    for (const id of el.properties) assert.ok(PROPERTIES[id], `${type}/${id}`);
    for (const id of el.properties) {
      const prop = PROPERTIES[id];
      if (prop.group != null) assert.ok(el.groups.includes(prop.group), `${type}/${id} group`);
    }
    assert.ok(el.ops && el.ops.set, type);
  }
});

test('template registry: camera transform is world center + relative path + picture 2D', () => {
  const cam = ELEMENTS.camera;
  assert.equal(cam.transform.center, 'transform.center');
  assert.equal(cam.transform.position, 'camera.path');
  assert.equal(cam.transform.opacity, 'transform.opacity');
  assert.equal(cam.transform.scale, 'transform.scale');
  assert.equal(cam.transform.picturePivot, 'camera.picturePivot');
  assert.equal(cam.transform.pictureOffset, 'camera.pictureOffset');
  const rows = groupProperties('camera', 'transform').map((p) => p.label);
  assert.deepEqual(rows, ['位置', '中心点', '画面中心', '画面位置', '透明度', '缩放']);
  const path = PROPERTIES['camera.path'];
  assert.equal(path.type, 'path3');
  assert.equal(path.keyable, KEYABILITY.frame);
  assert.equal(path.channel.kind, 'path');
  assert.equal(PROPERTIES['camera.picturePivot'].unit, 'normalized');
  assert.deepEqual(PROPERTIES['camera.picturePivot'].default, [0.5, 0.5]);
  assert.deepEqual(PICTURE_TRANSFORM.origin, [0.5, 0.5]);
});

test('template registry: no rotation in the base transform', () => {
  for (const id of Object.keys(PROPERTIES)) {
    assert.ok(!/rotation|朝向/.test(id), id);
  }
  for (const el of Object.values(ELEMENTS)) {
    assert.ok(!el.properties.some((id) => /rotation|朝向/.test(id)), el.type);
  }
});

test('template registry: camera groups default state', () => {
  const cam = ELEMENTS.camera;
  assert.deepEqual(cam.groups, ['transform', 'lens', 'shake', 'dofMb']);
  assert.equal(GROUPS.transform.defaultOpen, true);
  assert.equal(GROUPS.lens.defaultOpen, false);
  assert.equal(GROUPS.shake.defaultOpen, false);
  assert.equal(GROUPS.dofMb.defaultOpen, false);
});

test('template registry: C-b keyability (DOF frame, shutter/seed shot)', () => {
  assert.equal(PROPERTIES['camera.dof.enabled'].keyable, KEYABILITY.frame);
  assert.equal(PROPERTIES['camera.dof.fstop'].keyable, KEYABILITY.frame);
  assert.equal(PROPERTIES['camera.motionBlur.enabled'].keyable, KEYABILITY.shot);
  assert.equal(PROPERTIES['camera.motionBlur.shutter'].keyable, KEYABILITY.shot);
  assert.equal(PROPERTIES['camera.shake.seed'].keyable, KEYABILITY.shot);
  const frame = keyableProperties('camera', KEYABILITY.frame).map((p) => p.id);
  const shot = keyableProperties('camera', KEYABILITY.shot).map((p) => p.id);
  assert.ok(frame.includes('camera.dof.fstop'));
  assert.ok(!frame.includes('camera.motionBlur.shutter'));
  assert.ok(shot.includes('camera.motionBlur.shutter'));
  assert.ok(shot.includes('camera.shake.seed'));
});

test('template registry: camera lens/shake/dof properties and labels', () => {
  const lens = groupProperties('camera', 'lens').map((p) => p.label);
  assert.deepEqual(lens, ['视场角 FOV', '看向前方', '转弯侧倾', '最大侧倾', '手动 roll']);
  const shake = groupProperties('camera', 'shake').map((p) => p.label);
  assert.deepEqual(shake, ['抖动幅度', '抖动频率', '随速度增强', '随机种子']);
  const dof = groupProperties('camera', 'dofMb').map((p) => p.label);
  assert.deepEqual(dof, ['景深', '光圈 f', '运动模糊', '快门角']);
  assert.equal(PROPERTIES['camera.fov'].range[0], 1);
  assert.equal(PROPERTIES['camera.fov'].range[1], 360);
  assert.equal(PROPERTIES['camera.fov'].badge, 'fisheye');
});

test('template registry: elements share the base transform', () => {
  for (const type of ['camera', 'solid', 'empty']) {
    assert.ok(ELEMENTS[type].transform.center, type);
    assert.ok(ELEMENTS[type].transform.position, type);
    assert.ok(ELEMENTS[type].transform.opacity, type);
    assert.ok(ELEMENTS[type].transform.scale, type);
  }
  assert.equal(ELEMENTS.solid.transform.position, 'transform.position');
  assert.equal(ELEMENTS.solid.transform.center, 'transform.center');
  assert.deepEqual(ELEMENTS.solid.primitives, ['box', 'cylinder', 'pen']);
  assert.ok(ELEMENTS.solid.properties.includes('solid.geom'));
  assert.ok(ELEMENTS.solid.properties.includes('solid.color'));
});

test('template registry: toolbar and create tools', () => {
  assert.equal(TOOLBAR.placement, 'app-header-left');
  assert.equal(TOOLBAR.orientation, 'horizontal');
  const cam = TOOLS.find((t) => t.id === 'create-camera');
  assert.equal(cam.element, 'camera');
  const cube = TOOLS.find((t) => t.id === 'create-3d');
  assert.equal(cube.element, 'solid');
  assert.equal(cube.longPress, true);
  assert.deepEqual(cube.submenu.map((s) => s.label), ['立方体', '圆柱', '钢笔']);
  const select = TOOLS.find((t) => t.id === 'select');
  assert.equal(select.kind, 'select');
});

test('template registry: homogeneous selection pool and U states', () => {
  assert.deepEqual(SELECTION.kinds, ['element', 'property', 'keyframe']);
  assert.equal(SELECTION.homogeneous, true);
  assert.equal(SELECTION.aggregate.element, 'all-properties');
  assert.equal(SELECTION.aggregate.group, 'group-properties');
  assert.equal(SELECTION.aggregate.reverse, 'expand-to-properties');
  assert.equal(SELECTION.keyframe.mixable, false);
  assert.equal(SELECTION.keyframe.requiresClear, true);
  assert.equal(SELECTION.keyframe.marquee, 'B');
  assert.equal(SELECTION.u.pool, 'element');
  assert.deepEqual(SELECTION.u.groups, ['full', 'keyed', 'collapsed']);
});

test('template registry: camera stack order, add, and solo scope', () => {
  assert.equal(CAMERA_STACK.list, 'cameras');
  assert.equal(CAMERA_STACK.order, 'cameraOrder');
  assert.equal(CAMERA_STACK.active, 'activeCameraId');
  assert.equal(CAMERA_STACK.timelineOrder, 'top-over-bottom');
  assert.equal(CAMERA_STACK.blend, 'alpha');
  assert.equal(CAMERA_STACK.solo.scope, 'viewport');
  assert.equal(CAMERA_STACK.add.source, 'toolbar-only');
  assert.equal(CAMERA_STACK.add.position, 'top');
  assert.equal(CAMERA_STACK.add.active, true);
  assert.equal(ELEMENTS.camera.layer.stack, true);
  assert.equal(ELEMENTS.camera.layer.solo, 'viewport');
  assert.equal(ELEMENTS.camera.create.source, 'current-viewport');
  assert.equal(ELEMENTS.camera.create.stack, 'top');
  assert.equal(ELEMENTS.camera.create.active, true);
});

test('template registry: lookup helpers', () => {
  assert.equal(getProperty('camera.fov').label, '视场角 FOV');
  assert.equal(getProperty('nope'), null);
  assert.equal(getElement('camera').label, '相机');
  assert.equal(getElement('nope'), null);
  assert.ok(elementProperties('camera').every((p) => p && p.id));
  assert.deepEqual(groupProperties('camera', 'transform').map((p) => p.id), [
    'camera.path', 'transform.center', 'camera.picturePivot', 'camera.pictureOffset',
    'transform.opacity', 'transform.scale',
  ]);
  assert.ok(keyableProperties('camera', KEYABILITY.frame).length > 0);
});
