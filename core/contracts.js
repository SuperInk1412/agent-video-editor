import { OP_KINDS } from './ops.js';
import { ELEMENT_TYPES } from './schema.js';

const string = { type: 'string', minLength: 1, maxLength: 512 };
const number = { type: 'number' };
const time = { type: 'number', minimum: 0 };
const object = { type: 'object' };
const vector = (size) => ({ type: 'array', items: number, minItems: size, maxItems: size });
const nullableId = { type: ['string', 'null'] };
const parentChannel = { enum: ['rot', 'scale'] };
const parentStrength = { type: 'object', properties: { rot: number, scale: number }, additionalProperties: false };
const property = { ...string, description: 'Dotted property path. 2D positions are project pixels, y down; 3D positions are metres, y up.' };
const linkHostKind = { enum: ['el', 'ob', 'cam', 'element', 'object', 'camera'] };
const linkFrom = {
  type: 'object',
  required: ['host', 'id', 'path'],
  properties: { host: linkHostKind, id: string, path: property },
  additionalProperties: false,
};
const definitions = {
  addElement: [{ element: { ...object, required: ['type'], properties: { type: { enum: ELEMENT_TYPES }, start: time, duration: { type: 'number', exclusiveMinimum: 0 }, loop: { type: 'boolean' } } } }, ['element']],
  updateElement: [{ id: string, patch: object }, ['id', 'patch']],
  set: [{ id: string, path: property, value: {} }, ['id', 'path', 'value']],
  removeElement: [{ id: string }, ['id']],
  duplicateElement: [{ id: string, start: time, offset: number }, ['id']],
  moveElement: [{ id: string, start: time, duration: { type: 'number', exclusiveMinimum: 0 }, z: number, segment: { type: ['string', 'null'] }, keys: { enum: ['shift', 'keep'] } }, ['id']],
  splitElement: [{ id: string, at: time }, ['id', 'at']],
  splitAt: [{ at: time, id: string, ids: { type: 'array', items: string } }, ['at']],
  reorder: [{ id: string, z: number, delta: number }, ['id']],
  addSegment: [{ segment: object }, ['segment']],
  updateSegment: [{ id: string, patch: object }, ['id', 'patch']],
  removeSegment: [{ id: string }, ['id']],
  setMeta: [{ path: property, value: {} }, ['path', 'value']],
  setFx: [{ fx: object }, ['fx']],
  keySet: [{ id: string, path: property, t: time, value: {}, ease: string, curve: { type: ['object', 'null'] } }, ['id', 'path', 't', 'value']],
  keyRemove: [{ id: string, path: property, t: time }, ['id', 'path']],
  keyCurve: [{ host: { enum: ['element', 'object', 'camera'] }, id: string, path: property,
    from: time, to: time, curve: { type: ['object', 'null'] } }, ['id', 'path', 'from', 'to', 'curve']],
  batch: [{ ops: { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/op' } } }, ['ops']],
  cameraKey: [{ id: string, t: time, pos: vector(3), look: { anyOf: [vector(3), { type: 'null' }] }, fov: { type: ['number', 'null'] }, ease: string, out: vector(3), in: vector(3), speed: {} }, ['t', 'pos']],
  cameraRemove: [{ id: string, t: time }, ['t']],
  cameraSet: [{ id: string, patch: object }, ['patch']],
  cameraPath: [{ id: string, path: { type: 'array', items: object } }, ['path']],
  cameraPatch: [{ id: string, patch: object }, ['id', 'patch']],
  cameraParamKey: [{ id: string, path: property, t: time, v: {}, value: {}, ease: string, curve: { type: ['object', 'null'] } }, ['path', 't']],
  cameraParamUnkey: [{ id: string, path: property, t: time }, ['path', 't']],
  worldSet: [{ patch: object }, ['patch']],
  addCamera: [{ camera: object, index: { type: 'integer', minimum: 0 } }, []],
  removeCamera: [{ id: string }, ['id']],
  reorderCamera: [{ id: string, index: { type: 'integer', minimum: 0 } }, ['id', 'index']],
  activateCamera: [{ id: string }, ['id']],
  objectAdd: [{ object }, ['object']],
  objectRemove: [{ id: string }, ['id']],
  objectPatch: [{ id: string, patch: object }, ['id', 'patch']],
  objectKey: [{ id: string, path: property, t: time, v: {}, value: {}, ease: string, curve: { type: ['object', 'null'] }, out: vector(3), in: vector(3), speed: {} }, ['id', 'path', 't']],
  objectUnkey: [{ id: string, path: property, t: time }, ['id', 'path', 't']],
  objectParent: [{ id: string, parent: nullableId, t: time,
    inherit: { type: 'object', properties: { pos: { type: 'boolean' }, rot: { type: 'boolean' }, scale: { type: 'boolean' } }, additionalProperties: false },
    strength: parentStrength }, ['id', 'parent']],
  objectUnparent: [{ id: string, t: time }, ['id']],
  objectParentKey: [{ id: string, channel: parentChannel, t: time, v: number, value: number, ease: string }, ['id', 'channel', 't']],
  objectParentUnkey: [{ id: string, channel: parentChannel, t: time }, ['id', 'channel', 't']],
  elementParent: [{ id: string, parent: nullableId, t: time }, ['id', 'parent']],
  elementUnparent: [{ id: string, t: time }, ['id']],
  spatialParent: [{ id: string, parent: string, t: time,
    inherit: { type: 'object', properties: { pos: { type: 'boolean' }, rot: { type: 'boolean' }, scale: { type: 'boolean' } }, additionalProperties: false },
    strength: { type: 'object', properties: { rot: { type: 'number' }, scale: { type: 'number' } }, additionalProperties: false } }, ['id', 'parent']],
  spatialParentKey: [{ id: string, channel: parentChannel, t: time, v: number, value: number, ease: string }, ['id', 'channel', 't']],
  spatialParentUnkey: [{ id: string, channel: parentChannel, t: time }, ['id', 'channel', 't']],
  spatialUnparent: [{ id: string }, ['id']],
  propLink: [{
    host: linkHostKind, id: string, to: property, from: linkFrom,
    combine: { enum: ['add', 'mul'] }, t: time, enabled: { type: 'boolean' }, bindParentValue: number,
  }, ['id', 'to', 'from']],
  propLinkPatch: [{ host: linkHostKind, id: string, to: property, patch: object, t: time }, ['id', 'to', 'patch']],
  propUnlink: [{ host: linkHostKind, id: string, to: property }, ['id', 'to']],
};

export const PUBLIC_OPS = OP_KINDS.filter((op) => Object.hasOwn(definitions, op));
export const OP_SCHEMA = { oneOf: PUBLIC_OPS.map((op) => ({ type: 'object', required: ['op', ...definitions[op][1]],
  properties: { op: { const: op }, ...definitions[op][0] }, additionalProperties: false })) };
export const EDIT_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['expectedRev', 'requestId', 'ops'], properties: {
    expectedRev: { type: 'integer', minimum: 0 }, requestId: { type: 'string', minLength: 1, maxLength: 200 }, dryRun: { type: 'boolean' },
    ops: { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/op' } },
  }, $defs: { op: OP_SCHEMA } };
