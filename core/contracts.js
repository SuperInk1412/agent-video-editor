import { OP_KINDS } from './ops.js';

const string = { type: 'string', minLength: 1, maxLength: 512 };
const number = { type: 'number' };
const time = { type: 'number', minimum: 0 };
const object = { type: 'object' };
const vector = (size) => ({ type: 'array', items: number, minItems: size, maxItems: size });
const property = { ...string, description: 'Dotted property path. 2D positions are project pixels, y down; 3D positions are metres, y up.' };
const definitions = {
  addElement: [{ element: { ...object, required: ['type'], properties: { type: { enum: ['image', 'video', 'text', 'solid', 'shape'] }, start: time, duration: { type: 'number', exclusiveMinimum: 0 } } } }, ['element']],
  updateElement: [{ id: string, patch: object }, ['id', 'patch']],
  set: [{ id: string, path: property, value: {} }, ['id', 'path', 'value']],
  removeElement: [{ id: string }, ['id']],
  duplicateElement: [{ id: string, start: time, offset: number }, ['id']],
  moveElement: [{ id: string, start: time, duration: { type: 'number', exclusiveMinimum: 0 }, z: number, segment: { type: ['string', 'null'] }, keys: { enum: ['shift', 'keep'] } }, ['id']],
  splitElement: [{ id: string, at: time }, ['id', 'at']],
  reorder: [{ id: string, z: number, delta: number }, ['id']],
  addSegment: [{ segment: object }, ['segment']],
  updateSegment: [{ id: string, patch: object }, ['id', 'patch']],
  removeSegment: [{ id: string }, ['id']],
  setMeta: [{ path: property, value: {} }, ['path', 'value']],
  setFx: [{ fx: object }, ['fx']],
  keySet: [{ id: string, path: property, t: time, value: {}, ease: string }, ['id', 'path', 't', 'value']],
  keyRemove: [{ id: string, path: property, t: time }, ['id', 'path']],
  batch: [{ ops: { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/op' } } }, ['ops']],
  cameraKey: [{ id: string, t: time, pos: vector(3), look: { anyOf: [vector(3), { type: 'null' }] }, fov: { type: ['number', 'null'] }, ease: string, out: vector(3), in: vector(3), speed: {} }, ['t', 'pos']],
  cameraRemove: [{ id: string, t: time }, ['t']],
  cameraSet: [{ id: string, patch: object }, ['patch']],
  cameraPath: [{ id: string, path: { type: 'array', items: object } }, ['path']],
  cameraPatch: [{ id: string, patch: object }, ['id', 'patch']],
  cameraParamKey: [{ id: string, path: property, t: time, v: {}, value: {}, ease: string }, ['path', 't']],
  cameraParamUnkey: [{ id: string, path: property, t: time }, ['path', 't']],
  worldSet: [{ patch: object }, ['patch']],
  addCamera: [{ camera: object, index: { type: 'integer', minimum: 0 } }, []],
  removeCamera: [{ id: string }, ['id']],
  reorderCamera: [{ id: string, index: { type: 'integer', minimum: 0 } }, ['id', 'index']],
  activateCamera: [{ id: string }, ['id']],
  objectAdd: [{ object }, ['object']],
  objectRemove: [{ id: string }, ['id']],
  objectPatch: [{ id: string, patch: object }, ['id', 'patch']],
  objectKey: [{ id: string, path: property, t: time, v: {}, value: {}, ease: string, out: vector(3), in: vector(3), speed: {} }, ['id', 'path', 't']],
  objectUnkey: [{ id: string, path: property, t: time }, ['id', 'path', 't']],
};

export const PUBLIC_OPS = OP_KINDS.filter((op) => Object.hasOwn(definitions, op));
export const OP_SCHEMA = { oneOf: PUBLIC_OPS.map((op) => ({ type: 'object', required: ['op', ...definitions[op][1]],
  properties: { op: { const: op }, ...definitions[op][0] }, additionalProperties: false })) };
export const EDIT_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['expectedRev', 'requestId', 'ops'], properties: {
    expectedRev: { type: 'integer', minimum: 0 }, requestId: { type: 'string', minLength: 1, maxLength: 200 }, dryRun: { type: 'boolean' },
    ops: { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/op' } },
  }, $defs: { op: OP_SCHEMA } };
