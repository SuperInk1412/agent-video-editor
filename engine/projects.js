import { ProjectService } from '../application/project-service.js';
import { ProjectRepository } from './project-repository.js';
import { autoStoryboard } from './storyboard.js';

export function projectService(root, options) {
  return new ProjectService(new ProjectRepository(root, options), {
    plan(current, options) {
      const project = JSON.parse(JSON.stringify(current));
      const ops = [{ op: 'replaceTimeline', elements: [], segments: [] }];
      if (options.duration != null) {
        project.meta.duration = options.duration;
        ops.push({ op: 'setMeta', path: 'duration', value: options.duration });
      }
      return [...ops, ...autoStoryboard({ project, ...options }).ops];
    },
  });
}
