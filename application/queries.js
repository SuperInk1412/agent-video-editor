import { evalElement } from '../core/evaluate.js';
import { objectPose } from '../core/scene.js';
import { evalCamera } from '../core/camera.js';
import { fault } from './errors.js';

export function readSelection(project, { section = 'summary', segmentId, from, to, offset = 0, limit = 100, expectedRev } = {}) {
  if (expectedRev !== undefined && project.rev !== expectedRev) throw fault('REV_CONFLICT', 'query revision changed', { currentRev: project.rev });
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fault('INVALID_ARGUMENT', 'pagination requires offset >= 0 and limit 1..500');
  if (section === 'project') return { rev: project.rev, project };
  if (section === 'summary') return { rev: project.rev, meta: project.meta, counts: { segments: project.segments.length, elements: project.elements.length, cameras: project.cameras.length, objects: project.scene?.objects?.length || 0 } };
  if (section === 'world') return { rev: project.rev, world: project.world };
  const sources = { segments: project.segments, elements: project.elements, cameras: project.cameras, objects: project.scene?.objects || [] };
  let entries = sources[section];
  if (!entries) throw fault('INVALID_ARGUMENT', 'unknown project section');
  for (const value of [from, to]) if (value !== undefined && !Number.isFinite(value)) throw fault('INVALID_ARGUMENT', 'query times must be finite');
  if (segmentId) entries = entries.filter((item) => section === 'segments' ? item.id === segmentId : item.segment === segmentId || !item.segment);
  if (from !== undefined) entries = entries.filter((item) => item.start === undefined || item.start + item.duration > from);
  if (to !== undefined) entries = entries.filter((item) => item.start === undefined || item.start < to);
  return { rev: project.rev, items: entries.slice(offset, offset + limit), total: entries.length,
    nextOffset: offset + limit < entries.length ? offset + limit : null };
}

export function contextAt(project, { time = 0, segmentId } = {}) {
  if (!Number.isFinite(time) || time < 0 || time > project.meta.duration) throw fault('INVALID_ARGUMENT', 'context time must be inside project duration');
  return { rev: project.rev, title: project.meta.title, time, duration: project.meta.duration, fps: project.meta.fps,
    units: { elements: 'pixels, y down', objects: 'metres, y up', keyframes: 'absolute project seconds' },
    beats: project.meta.beats.filter((t) => t >= time - 3 && t <= time + 3),
    segments: project.segments.filter((s) => segmentId ? s.id === segmentId : time >= s.start && time < s.start + s.duration),
    elements: project.elements.filter((e) => !segmentId || !e.segment || e.segment === segmentId).slice(0, 100).map((e) => ({ ...e, evaluated: evalElement(e, time, project.meta) })),
    cameras: project.cameras.slice(0, 20).map((camera) => ({ id: camera.id, name: camera.name, evaluated: evalCamera({ ...project, camera, cameras: [], activeCameraId: null }, time) })),
    objects: (project.scene?.objects || []).slice(0, 100).map((object) => ({ ...object, evaluated: objectPose(object, time) })),
    world: project.world };
}
