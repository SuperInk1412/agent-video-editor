// Property-link UI (PLAN-ui-round3 §3.2, §4.2–§4.3): one `↳` button per
// linkable property row, a menu of same-unit source properties, and the
// unlink / jump-to-parent actions.
//
// The menu is built on the shared `showMenu` primitive (ui.js) and writes only
// through the ops the caller hands in (`onOp` -> core/ops.js). Nothing here
// touches project JSON directly: opening a menu is a pure read, and picking an
// item is exactly one `propLink` / `propUnlink` op (one undo step).
//
//   openLinkMenu({ project, hostKind, id, to, paths, labels, anchor, x, y, t,
//                  onOp, onJump, toast })
//
// `to` is the child property path (`pivot.x`, `roll`, …) or an array of paths
// when one row edits several properties (a 3D pivot row). `paths` / `labels`
// are accepted as aliases so a row can pass its axes explicitly.
//
// The source list is the core/links.js catalog: every linkable property of
// every 2D element, 3D object and camera, filtered to the child's unit. The
// exact same property of the same host (a self-link) is excluded, camera path
// `position.*` is absent from the catalog on purpose, and a source that would
// close a cycle is listed but disabled with the reason.
import { isRecord } from '../../../core/json.js';
import {
  SCREEN_PARENT,
  findHost,
  findLinkTarget,
  linkHosts,
  linkTargets,
  normalizeHostKind,
  wouldLinkCycle,
} from '../../../core/links.js';
import { showMenu } from './ui.js';

const KIND_WORD = Object.freeze({ el: '元素', ob: '3D', cam: '相机' });
const UNIT_WORD = Object.freeze({
  length: '长度', angle: '角度', ratio: '比例', number: '数值',
});

/** Human labels for every path in the core/links.js catalog. */
export const LINK_PROP_LABELS = Object.freeze({
  'pivot.x': '中心点 X', 'pivot.y': '中心点 Y', 'pivot.z': '中心点 Z',
  'position.x': '位置 X', 'position.y': '位置 Y', 'position.z': '位置 Z',
  roll: '旋转°',
  'rotation.x': '旋转 X°', 'rotation.y': '旋转 Y°', 'rotation.z': '旋转 Z°',
  'scale.x': '缩放 X', 'scale.y': '缩放 Y', 'scale.z': '缩放 Z',
  opacity: '不透明度',
  'style.size': '字号', 'fx.glow': '辉光', 'audio.volume': '音量',
  fov: '视场角 FOV', maxRoll: '最大侧倾°', lookAhead: '看向前方', bankGain: '转弯侧倾',
  'dof.fstop': '光圈 f',
  'shake.amp': '抖动幅度', 'shake.freq': '抖动频率', 'shake.speedGain': '随速度增强', 'shake.seed': '随机种子',
});

export const linkPropLabel = (path) => LINK_PROP_LABELS[String(path ?? '')] || String(path ?? '');
export const linkUnitLabel = (unit) => UNIT_WORD[unit] || String(unit || '');
const kindOf = (value) => {
  try { return normalizeHostKind(value); } catch { return null; }
};

function safeFindHost(project, kind, id) {
  const k = kindOf(kind);
  if (!project || !k || id == null) return null;
  try { return findHost(project, k, id); } catch { return null; }
}

/** `元素「名字」` / `3D「名字」` / `相机「名字」`, falling back to the raw id. */
export function linkHostLabel(project, kind, id) {
  const k = kindOf(kind);
  const host = safeFindHost(project, k, id);
  const name = host?.name || (id != null ? String(id) : '');
  if (!k) return name || '未知宿主';
  return `${KIND_WORD[k]}「${name || '未命名'}」`;
}

/** The active link for a child property path (`enabled` or not), or null. */
export function linkOf(host, path) {
  const key = String(path ?? '');
  if (!key || !Array.isArray(host?.links)) return null;
  return host.links.find((link) => isRecord(link) && String(link.to ?? '') === key) || null;
}

/** `enabled !== false` — a disabled link still counts for the menu but not for lit state. */
export const isLinkEnabled = (link) => !!link && link.enabled !== false;

/** `元素「A」 · 中心点 Y` from a stored link. */
export function linkSourceLabel(project, link) {
  const from = isRecord(link?.from) ? link.from : null;
  if (!from) return '（无效父级）';
  return `${linkHostLabel(project, from.host, from.id)} · ${linkPropLabel(from.path)}`;
}

/** Right-click / menu jump payload for a stored link. */
export function linkJumpTarget(link, to = null) {
  const from = isRecord(link?.from) ? link.from : null;
  if (!from) return null;
  return { host: from.host, id: String(from.id ?? ''), path: String(from.path ?? ''), to: to == null ? null : String(to) };
}

/** Links carried by a host: `{ count, links, hosts }` or null. */
export function linkSummary(project, host) {
  const links = (Array.isArray(host?.links) ? host.links : []).filter(isRecord);
  if (!links.length) return null;
  const hosts = [];
  for (const link of links) {
    const label = linkSourceLabel(project, link);
    if (!hosts.includes(label)) hosts.push(label);
  }
  return { count: links.length, links, hosts };
}

// ---------------------------------------------------------------- row paths
//
// A timeline inspector row edits one or more linkable targets. These helpers
// translate the row path used by the UI into the core/links.js target paths
// (a legacy 2D element writes `transform.*` but links `pivot.*` / `roll` /
// `scale.*` — never `transform.*` in the link data).

/** Linkable target paths of a 2D element row (`transform.x`, `audio.volume`, …). */
export function elementRowLinkPaths(el, rowPath) {
  const path = String(rowPath ?? '');
  // A node element can expose the node paths directly (unified four-attribute
  // rows: pivot.* / position.* / scale.* / roll / opacity).
  if (isRecord(el?.node) && /^(pivot|position|scale|rotation)\.[xyz]$|^roll$|^opacity$/.test(path)) return [path];
  switch (path) {
    case 'transform.x': return ['pivot.x'];
    case 'transform.y': return ['pivot.y'];
    case 'transform.z': return ['pivot.z'];
    case 'transform.scale': return ['scale.x'];
    case 'transform.rotation': return ['roll'];
    case 'transform.opacity': return ['opacity'];
    case 'audio.volume': return ['audio.volume'];
    default: return [];
  }
}

/** Linkable target paths of a 3D object timeline row (`pivot`, `position`, …). */
export function objectRowLinkPaths(rowPath) {
  const path = String(rowPath ?? '');
  if (path === 'pivot' || path === 'position' || path === 'scale') {
    return ['x', 'y', 'z'].map((axis) => `${path}.${axis}`);
  }
  if (path === 'opacity') return ['opacity'];
  if (path === 'roll') return ['roll'];
  if (/^rotation\.[xyz]$/.test(path)) return [path];
  return [];
}

/** Linkable target paths of a camera timeline row (`center`, `scale`, `fov`, …). */
export function cameraRowLinkPaths(rowPath) {
  const path = String(rowPath ?? '');
  if (path === 'center') return ['pivot.x', 'pivot.y', 'pivot.z'];
  if (path === 'scale') return ['scale.x', 'scale.y', 'scale.z'];
  // Scalar camera rows use the target path as their row path; findLinkTarget
  // filters out rows the catalog does not allow (path position, dof.enabled).
  return path ? [path] : [];
}

// ---------------------------------------------------------------- sources

const sameSource = (link, kind, id, path) => {
  const from = isRecord(link?.from) ? link.from : null;
  return !!from && from.host === kind && String(from.id ?? '') === String(id) && String(from.path ?? '') === path;
};

/**
 * Same-unit source properties grouped by host, in menu order.
 * Each candidate is `{ kind, id, name, label, targets }`; a target is
 * `{ path, label, combine, current, cycle }`. `current` marks the child's
 * existing source (so the menu can show a check and keep it disabled), `cycle`
 * marks a source that would close the property chain.
 *
 * `@live` is never a property source (it is the legacy screen lock), and a host
 * may not link a property to itself.
 */
export function linkSourceChoices(project, hostKind, id, to) {
  const kind = kindOf(hostKind);
  const child = safeFindHost(project, kind, id);
  if (!kind || !child || !project) return [];
  const childPath = String(to ?? '');
  const childTarget = findLinkTarget(kind, child, childPath);
  if (!childTarget) return [];
  const childId = String(child.id ?? id ?? '');
  const childLink = linkOf(child, childPath);
  const out = [];
  for (const [sourceKind, hosts] of linkHosts(project)) {
    for (const host of hosts) {
      const hostId = String(host?.id ?? '');
      if (!hostId || hostId === SCREEN_PARENT) continue;
      const targets = [];
      for (const target of linkTargets(sourceKind, host)) {
        if (target.unit !== childTarget.unit) continue;
        if (sourceKind === kind && hostId === childId && target.path === childPath) continue;
        targets.push({
          path: target.path,
          label: linkPropLabel(target.path),
          unit: target.unit,
          combine: target.combine,
          current: sameSource(childLink, sourceKind, hostId, target.path),
          cycle: wouldLinkCycle(project, { host: kind, id: childId }, childPath, {
            host: sourceKind, id: hostId, path: target.path,
          }),
        });
      }
      if (!targets.length) continue;
      out.push({
        kind: sourceKind,
        id: hostId,
        host,
        name: host.name || hostId,
        label: linkHostLabel(project, sourceKind, hostId),
        targets,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- menu

const roundT = (t) => Math.round(Math.max(0, Number(t) || 0) * 1000) / 1000;

/**
 * Open the property-link menu for a child property (or a row of properties).
 * Menus are nested two levels (host -> property) once more than one host can be
 * a source, so a large project does not dump hundreds of entries at once.
 * Returns false when the property is not linkable.
 */
export function openLinkMenu({
  project, hostKind, id, to, paths, labels, anchor = null, x = 0, y = 0, t = 0,
  onOp, onJump, toast,
} = {}) {
  const kind = kindOf(hostKind);
  const host = safeFindHost(project, kind, id);
  if (!project || !kind || !host) {
    toast?.('属性链接：找不到这个宿主', 'warn');
    return false;
  }
  const raw = Array.isArray(paths) && paths.length ? paths : (Array.isArray(to) ? to : [to]);
  const list = [];
  raw.forEach((entry, i) => {
    const path = String(entry ?? '');
    if (!path || !findLinkTarget(kind, host, path)) return;
    list.push({ path, label: (Array.isArray(labels) ? labels[i] : null) || linkPropLabel(path) });
  });
  if (!list.length) {
    toast?.('属性链接：这个属性不能设置属性父级', 'warn');
    return false;
  }

  const show = (items) => showMenu(anchor ? 0 : x, anchor ? 0 : y, items, anchor ? { anchor } : {});
  const runOp = (op) => {
    try {
      const result = onOp?.(op);
      if (result && typeof result.then === 'function') {
        result.catch((e) => toast?.(`属性链接失败：${e.message}`, 'error'));
      }
    } catch (e) {
      toast?.(`属性链接失败：${e.message}`, 'error');
    }
  };
  const jump = (link, childPath) => {
    const target = linkJumpTarget(link, childPath);
    if (target) onJump?.(target);
  };

  const sourceTargets = (childPath, unit) => {
    const items = [];
    const current = linkOf(host, childPath);
    if (current) {
      items.push({ group: '当前属性父级' });
      items.push({
        label: `转到父级：${linkSourceLabel(project, current)}`, icon: 'pointer',
        title: '选中父级宿主并在时间轴展开（不改项目、不激活相机）',
        run: () => jump(current, childPath),
      });
      items.push({
        label: '解除链接', icon: 'x',
        title: '只删属性链接；这个属性的本地值保持不变',
        run: () => runOp({ op: 'propUnlink', host: kind, id: String(host.id), to: childPath }),
      });
      items.push({ sep: true });
      items.push({ group: '更换父级' });
    } else {
      items.push({ group: `选择父级宿主（同单位：${linkUnitLabel(unit)}）` });
    }
    const choices = linkSourceChoices(project, kind, host.id, childPath);
    if (!choices.length) {
      items.push({ label: '没有同单位的可链接属性', disabled: true });
      return items;
    }
    if (choices.length === 1) return items.concat(propertyItems(choices[0], childPath, unit));
    for (const choice of choices) {
      items.push({
        label: choice.label,
        title: `${choice.targets.length} 个同单位属性`,
        run: () => show(propertyItems(choice, childPath, unit)),
      });
    }
    return items;
  };

  const propertyItems = (choice, childPath, unit) => {
    const items = [{ group: `${choice.label} · ${linkUnitLabel(unit)}` }];
    for (const target of choice.targets) {
      items.push({
        label: `${target.label}${target.current ? '（当前）' : target.cycle ? '（会成环）' : ''}`,
        disabled: target.current,
        title: target.cycle
          ? '这个方向会形成属性循环，不能链接'
          : target.current
            ? '已经是当前父级属性'
            : `链接到 ${choice.label} · ${target.label}`,
        run: () => {
          // Same unit but incompatible: say why instead of silently doing nothing.
          if (target.cycle) { toast?.('这个方向会形成属性循环，不能链接', 'warn'); return; }
          runOp({
            op: 'propLink',
            host: kind,
            id: String(host.id),
            to: childPath,
            from: { host: choice.kind, id: choice.id, path: target.path },
            t: roundT(t),
          });
        },
      });
    }
    return items;
  };

  const openFor = (childPath, label) => {
    const target = findLinkTarget(kind, host, childPath);
    show(sourceTargets(childPath, target?.unit || 'number'));
  };

  if (list.length > 1) {
    const items = [{ group: '属性父级' }];
    for (const entry of list) {
      const current = linkOf(host, entry.path);
      items.push({
        label: current
          ? `${entry.label} ← ${linkSourceLabel(project, current)}`
          : `${entry.label}（未链接）`,
        icon: current ? 'check' : null,
        title: current ? '转到 / 解除这个属性的父级' : `链接 ${entry.label} 到另一个属性`,
        run: () => openFor(entry.path, entry.label),
      });
    }
    const linked = list.filter((entry) => linkOf(host, entry.path));
    if (linked.length) {
      items.push({ sep: true }, { group: '已链接' });
      for (const entry of linked) {
        const current = linkOf(host, entry.path);
        items.push({
          label: `转到父级：${entry.label} → ${linkSourceLabel(project, current)}`, icon: 'pointer',
          title: '选中父级宿主并在时间轴展开',
          run: () => jump(current, entry.path),
        });
        items.push({
          label: `解除链接：${entry.label}`, icon: 'x',
          title: '只删链接，本地值保持不变',
          run: () => runOp({ op: 'propUnlink', host: kind, id: String(host.id), to: entry.path }),
        });
      }
    }
    show(items);
    return true;
  }

  openFor(list[0].path, list[0].label);
  return true;
}
