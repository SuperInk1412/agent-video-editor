#!/usr/bin/env node
// Generate the agent-facing contract documents (docs/DESIGN-BACKEND-V2.md §8.4,
// WP2.3):
//
//   docs/AGENT-PROTOCOL.md      the editing protocol an agent reads
//   docs/CONTRACTS.md           the human-readable field tables
//   mcp/contracts.generated.json  the machine-readable snapshot
//
// Everything is rendered from core/contracts.js, the single source. Usage:
//
//   node scripts/gen-contracts.mjs            # write the three files
//   node scripts/gen-contracts.mjs --check    # exit 1 when disk differs
//   node scripts/gen-contracts.mjs --check --root <dir>
//
// `--check` prints a per-file diff summary (added/removed line counts and the
// first changed lines) and is what tests/contracts.test.mjs + CI run. Generated
// files must never be edited by hand.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_VERSION, DOCUMENT_DEFAULTS, EDIT_SCHEMA, CHANGESET_APPLY_SCHEMA, KEYABLE_PATHS, LEGACY_PATHS,
  LINKABLE_PATHS, LINK_UNIT_FAMILIES, LOCKABLE_HOSTS, OP_CONTRACTS, OP_GROUPS, PROPERTY_PATHS,
  PROPERTY_PATHS_BY_HOST, PUBLIC_OPS, TOOL_SCHEMAS, UNITS,
} from '../core/contracts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SELF = fileURLToPath(import.meta.url);
const GENERATED_BY = 'scripts/gen-contracts.mjs';
const MARKER = `<!-- 此段由 ${GENERATED_BY} 生成，勿手改。契约源：core/contracts.js -->`;
const LEGACY_BEGIN = '<!-- gen:legacy-begin — 旧字段名区块（tests/contracts.test.mjs 用它证明旧字段名只在里面出现） -->';
const LEGACY_END = '<!-- gen:legacy-end -->';
const BANNER = `<!-- 此文件由 ${GENERATED_BY} 生成，勿手改。契约源：core/contracts.js（CONTRACT_VERSION ${CONTRACT_VERSION}）。\n     重生成：node scripts/gen-contracts.mjs　校验：node scripts/gen-contracts.mjs --check -->`;

const FILES = [
  { file: 'docs/AGENT-PROTOCOL.md', render: renderProtocol },
  { file: 'docs/CONTRACTS.md', render: renderContractsDoc },
  { file: 'mcp/contracts.generated.json', render: renderJson },
];

/** Generated paths, relative to the repo root (exported for the test/CI). */
export const GENERATED_FILES = Object.freeze(FILES.map((entry) => entry.file));

// ---------------------------------------------------------------- helpers

const HOST_WRITE_OPS = { el: 'keySet', ob: 'objectKey', cam: 'cameraParamKey（位置用 cameraKey）' };
const HOST_LABEL = { el: '2D 元素', ob: '3D 物体', cam: '相机' };

const HOSTS = [
  { id: 'el', title: HOST_LABEL.el, table: 'el' },
  { id: 'ob', title: HOST_LABEL.ob, table: 'ob' },
  { id: 'cam', title: HOST_LABEL.cam, table: 'cam' },
];

const cell = (value) => {
  const text = value === null || value === undefined ? '—' : String(value);
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
};
const table = (headers, rows) => [
  `| ${headers.map(cell).join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
].join('\n');

const unit = (id) => {
  if (!id) return '—';
  const symbol = UNITS[id]?.symbol || '';
  if (symbol) return symbol;
  return id === 'number' || id === 'boolean' ? '—' : id;
};
const fmtValue = (value) => {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? "''" : `\`${value}\``;
  if (Array.isArray(value) || (typeof value === 'object')) return `\`${JSON.stringify(value)}\``;
  return String(value);
};
const required = (value) => (value ? '✔' : '');
const yes = (value) => (value ? '✔' : '—');

/** Human text of an enum field: the options, then the prose description. */
const fieldDescription = (row) => (row.enum ? `取值：${row.enum.join(' / ')}。${row.description}` : row.description);

/** Pretty JSON with short arrays/objects inlined (keeps the protocol readable). */
const pretty = (value, indent = 0, width = 72) => {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== 'object' || indent + flat.length <= width) return flat;
  const pad = ' '.repeat(indent + 2);
  const close = ' '.repeat(indent);
  if (Array.isArray(value)) return `[\n${value.map((item) => pad + pretty(item, indent + 2, width)).join(',\n')}\n${close}]`;
  const entries = Object.entries(value).map(([key, item]) => `${pad}${JSON.stringify(key)}: ${pretty(item, indent + 2, width)}`);
  return `{\n${entries.join(',\n')}\n${close}}`;
};

/** `id:unit …` — the compact field list of the op table. */
const opFieldList = (contract) => contract.fields
  .map((field) => {
    const unitText = field.unit && field.unit !== 'value' ? `:${unit(field.unit)}` : '';
    return `${field.name}${unitText}${field.required ? '*' : ''}`;
  })
  .join(' ');

const asJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Human name of a tool schema, decided by identity with the contract exports. */
const schemaLabel = (schema) => (schema === EDIT_SCHEMA ? 'EDIT_SCHEMA' : schema === CHANGESET_APPLY_SCHEMA ? 'CHANGESET_APPLY_SCHEMA' : '?');

const legacyStatus = (row) => (row.status === 'kept' ? '沿用旧名（仍生效）' : '已废弃（仅旧工程）');

// ---------------------------------------------------------------- AGENT-PROTOCOL

function renderProtocol() {
  const lines = [];
  const push = (...entries) => lines.push(...entries);
  const trackRow = (row) => [
    row.path, unit(row.unit), fmtValue(row.default), yes(row.keyable), yes(row.linkable), row.description,
  ];

  push(`# 剪辑 Agent 协议 — 在 VedioMaker 项目里工作`, '', BANNER, '');
  push('你在一个 **VedioMaker 项目目录**里（含 `project.vdm.json` 与 `media/`），职责是**改时间线**，不是改代码。',
    '本文件不是手写的：它由 `core/contracts.js` 渲染，所以这里列出的 op、字段、单位、默认值就是引擎真正接受的东西。',
    '如果本文与代码不一致，以 `core/contracts.js` 为准，并跑 `node scripts/gen-contracts.mjs --check`（它应当报错）。', '');

  push('## 1. 两种工作方式', '');
  push(`- **MCP 工具**（推荐）：\`vdm_project_apply_ops\` 提交 op 批次，\`vdm_changeset_apply\` 把一次编辑记成变更集，`,
    '  `vdm_inspect_*` 量一帧，`vdm_render_submit` 出真图。工具 schema 与本文件同源。',
    '- **回一个 JSON 对象**（没有 shell / MCP 时）：对象里放 `note` 与 `ops`，引擎会校验、加锁、落盘、进撤销栈；',
    '  校验失败时整批不生效，错误会显示给用户。', '');
  push('```json', pretty({
    note: '标题改成锈梦、150 号，并卡在 1.6 s',
    ops: [
      { op: 'set', id: 'el_title', path: 'style.color', value: '#ffd400' },
      { op: 'keySet', id: 'el_title', path: 'style.size', t: 1.6, value: 150, ease: 'outExpo' },
    ],
  }), '```', '');

  push('## 2. 可用 ops', '', MARKER, '');
  push('`*` = 必填字段；`:m` / `:s` / `:deg` / `:px` 是单位。批里所有 op 同一事务，任一失败整批不生效。', '');
  for (const group of OP_GROUPS) {
    const ops = PUBLIC_OPS.filter((op) => OP_CONTRACTS[op].group === group.id);
    if (!ops.length) continue;
    push(`### ${group.title}`, '', group.description, '');
    push(table(['op', '作用', '必填', '字段（单位）'], ops.map((op) => {
      const contract = OP_CONTRACTS[op];
      return [op, contract.summary, contract.fields.filter((field) => field.required).map((field) => field.name).join(', ') || '—', opFieldList(contract)];
    })), '');
  }

  push('### 常用示例', '', MARKER, '');
  for (const op of ['addElement', 'set', 'keySet', 'moveElement', 'cameraKey', 'cameraParamKey', 'objectKey', 'propLink', 'spatialParent', 'sourceAdd', 'codeParamSet', 'batch']) {
    const example = OP_CONTRACTS[op]?.example;
    if (!example) continue;
    push(`**\`${op}\`** — ${OP_CONTRACTS[op].summary}`, '', '```json', pretty(example), '```', '');
  }

  push('## 3. 属性路径（可打帧的轨道）', '', MARKER, '');
  push('路径是点号分隔的字符串。`pivot.x` 用米（100 项目像素 = 1 米，y 向上，画面中心 y = 画幅高 / 200），',
    '`style.size` 用项目像素，`rotation.*` / `roll` 用度。相机 `path` 用 `cameraKey` 写，不是 `keySet`。', '');
  for (const host of HOSTS) {
    const rows = PROPERTY_PATHS_BY_HOST[host.table].filter((row) => row.keyable && row.kind !== 'field');
    if (!rows.length) continue;
    push(`### ${host.title}（path 用在 \`${HOST_WRITE_OPS[host.id]}\`）`, '');
    push(table(['path', '单位', '默认', '可打帧', '可链接', '说明'], rows.map(trackRow)), '');
    push(`可链接路径（\`propLink\` 的 \`to\` / \`from.path\`）：${LINKABLE_PATHS[host.table].map((p) => `\`${p}\``).join('、') || '—'}`, '');
  }

  push('## 4. 文档字段（`set` / `updateElement` / `objectPatch`）', '', MARKER, '');
  push('不是关键帧轨道，直接改值；写字符串形式的数字会被转成数字。默认值是新建时的填充值。', '');
  for (const host of HOSTS) {
    const rows = PROPERTY_PATHS_BY_HOST[host.table].filter((row) => row.kind === 'field');
    if (!rows.length) continue;
    push(`### ${host.title}`, '');
    push(table(['字段', '单位', '默认', '说明'], rows.map((row) => [row.path, unit(row.unit), fmtValue(row.default), fieldDescription(row)])), '');
  }

  push('## 5. 关键帧的写法', '', MARKER, '');
  push(`- \`t\` 是**项目绝对时间**（秒），不是元素内的相对时间；\`fps\` 在 \`meta.fps\`。`,
    '- 同一 `path` + `t` 覆盖旧键；省略 `curve` 时保留原本的曲线，`curve: null` 才清除。',
    '- `keyRemove` 带 `t` 只删那一个键，不带 `t` 清空整条轨。',
    '- 想给一段区间加缓动曲线：`keyCurve { id, path, from, to, curve }`（曲线存在左键上）。',
    '- 相机参数（`fov` / `center` / `shake.amp` …）用 `cameraParamKey`，相机位置用 `cameraKey`；3D 物体用 `objectKey`。',
    '- 淡入淡出优先用 `fadeIn` / `fadeOut` 字段；要手打透明度关键帧，用 §9 里标注「沿用旧名（仍生效）」的那一条轨道。',
    `- 可打帧的轨道：2D 元素 ${KEYABLE_PATHS.el.length} 条、3D 物体 ${KEYABLE_PATHS.ob.length} 条、相机 ${KEYABLE_PATHS.cam.length} 条（完整列表见 §3）；`,
    '  其余字段只能改值，不能打帧。', '');

  push('## 6. 属性链接的写法', '', MARKER, '');
  push('- `propLink` 让一个宿主的数值属性跟随另一个宿主的数值属性；`host` 取 `el` / `ob` / `cam`。',
    `- 可被链接的路径：2D 元素 ${LINKABLE_PATHS.el.length} 条、3D 物体 ${LINKABLE_PATHS.ob.length} 条、相机 ${LINKABLE_PATHS.cam.length} 条（每节末尾列出）。`,
    `- \`combine: add\` 是加偏移，\`mul\` 是乘比例（比率单位默认 \`mul\`）；单位必须同族：${LINK_UNIT_FAMILIES.join(' / ')}（代码参数是 \`any\`）。`,
    '- 代码图层的 `code.params.<name>` 是唯一允许跨单位的例外（单位由 manifest 声明）。',
    '- 写之前引擎会查环与链深（上限 32 层）；父宿主被删时链接自动摘除，子宿主保留本地值。', '');

  push('## 7. 锁定与变更集', '', MARKER, '');
  push(`- \`locked: true\` 的宿主（${LOCKABLE_HOSTS.map((host) => HOST_LABEL[host]).join(' / ')}）：\`actorId\` 以 \`agent:\` 开头的写入一律返回 \`LOCKED\`，\`ui\` / \`human\` / \`cli\` 照常可写。`,
    '- 改锁定状态的 op 本身也受这条规则约束（agent 不能给自己解锁）。',
    '- 一次被接受的编辑用 `vdm_changeset_apply` 记成变更集：带 `expectedRev`、`requestId`、`dryRun`，语义与 `vdm_project_apply_ops` 相同。',
    '- `vdm_changeset_revert` 只撤销「现在仍等于该变更集写下的值」的属性；别人改过的属性进 `report.decisions`，不会强行覆盖。', '');

  push('## 8. 规则', '');
  push('1. **留在被指定的分镜里**（除非用户要求整片）。',
    '2. 先看 `meta.beats`：让改动落在拍点上（元素起点 / 关键帧时间对齐 beats）。',
    '3. 少而准：先 `dryRun`，再提交；改完能一句话说清。',
    '4. 不要编造元素 id；只用清单里有的，或者 `addElement` 新建。',
    '5. 不要手写整个 `project.vdm.json`，不要动 `media/` 与 `.vdm/` 之外的文件。',
    '6. 文字要短（1920×1080 上 6–12 个字最稳），字号 80–200 之间。',
    '7. 想确认效果就要求重新出图；你看的截图是预览（近似），Blender 才是最终观感。',
    '8. 锁定（`locked`）不是建议而是边界：被拒绝时报告给用户，不要绕路。', '');

  push(LEGACY_BEGIN, '');
  push('## 9. 旧字段名（不推荐给新元素，唯一仍生效的已标注）', '', MARKER, '');
  push('下面这些路径名沿用了旧的 2D 变换字段。`已废弃` 的几条只对没有迁移过的老工程生效——写在新元素上不会改变画面，',
    '新元素一律用 §3 的节点字段（`pivot.*` / `rotation.*` / `roll` / `scale.*`）。`沿用旧名` 的一条是例外：',
    '它仍然是唯一的实现，可以继续用。本节是全文唯一出现 `transform.*` 的地方，且已明确标注状态，不是推荐写法。', '');
  push(table(['host', 'path', '单位', '状态', '说明'], LEGACY_PATHS.map((row) => [
    row.host, row.path, unit(row.unit), legacyStatus(row), row.description,
  ])), '');
  push(LEGACY_END, '');

  push('## 10. 生成与校验', '', MARKER, '');
  push(`- 本文件由 \`${GENERATED_BY}\` 从 \`core/contracts.js\` 生成（CONTRACT_VERSION ${CONTRACT_VERSION}），**不要手改**。`,
    '- 重生成：`node scripts/gen-contracts.mjs`；校验：`node scripts/gen-contracts.mjs --check`（不一致时非零退出并打印 diff 摘要）。',
    '- 同源生成物：`docs/CONTRACTS.md`（人读字段表）、`mcp/contracts.generated.json`（机读快照）。',
    `- 当前规模：${PUBLIC_OPS.length} 个公开 op、${PUBLIC_OPS.reduce((n, op) => n + OP_CONTRACTS[op].fields.length, 0)} 个 op 字段、${PROPERTY_PATHS.length} 条属性路径。`, '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------- CONTRACTS.md

function renderContractsDoc() {
  const lines = [];
  const push = (...entries) => lines.push(...entries);
  push('# 契约字段表（由 `core/contracts.js` 生成）', '', BANNER, '');
  push('这是 WP2.3「契约单一来源」的人读版本。`mcp/tools.js`、`docs/AGENT-PROTOCOL.md` 与',
    '`mcp/contracts.generated.json` 都来自同一个模块；改契约只改 `core/contracts.js`，然后重生成。', '');
  push(`- 公开 op：**${PUBLIC_OPS.length}**（\`OP_KINDS\` 里除去 \`restoreProject\` / \`replaceTimeline\` 两个内部 op）`,
    `- op 字段：**${PUBLIC_OPS.reduce((n, op) => n + OP_CONTRACTS[op].fields.length, 0)}**`,
    `- 属性路径：**${PROPERTY_PATHS.length}**（可打帧 ${KEYABLE_PATHS.el.length} el / ${KEYABLE_PATHS.ob.length} ob / ${KEYABLE_PATHS.cam.length} cam；`,
    `  可链接 ${LINKABLE_PATHS.el.length} el / ${LINKABLE_PATHS.ob.length} ob / ${LINKABLE_PATHS.cam.length} cam）`, '');

  push('## 单位', '', MARKER, '');
  push(table(['unit', '名称', '符号', '说明'], Object.entries(UNITS).map(([id, entry]) => [id, entry.label, entry.symbol || '—', entry.description])), '');

  push('## op 契约', '', MARKER, '');
  push('`必填` 含 `op` 之外的所有必填字段；`属性` 列标出每个字段的单位（— = 无单位 / 随属性）。', '');
  for (const group of OP_GROUPS) {
    const ops = PUBLIC_OPS.filter((op) => OP_CONTRACTS[op].group === group.id);
    if (!ops.length) continue;
    push(`### ${group.title}`, '', group.description, '');
    for (const op of ops) {
      const c = OP_CONTRACTS[op];
      push(`#### \`${op}\` — ${c.summary}`, '', c.description, '');
      push(table(['字段', '类型', '单位', '必填', '说明'], c.fields.map((field) => [
        field.name, field.enum ? `enum(${field.enum.join(' / ')})` : field.type, unit(field.unit), required(field.required), field.description,
      ])), '');
      if (c.example) push('```json', JSON.stringify(c.example, null, 2), '```', '');
    }
  }

  push('## 属性路径', '', MARKER, '');
  push('`kind`：`track` = 求值器采样的关键帧轨道；`field` = 文档字段；`link` = 只作为属性链接端点的写法。',
    '`keyable` = 打这个路径的帧会改变画面；`linkable` = `propLink` 可以引用它。', '');
  for (const host of HOSTS) {
    push(`### ${host.title}（host = \`${host.id}\`）`, '');
    push(table(['路径', 'kind', '类型', '单位', '默认', '可打帧', '可链接', 'legacy', '说明'],
      PROPERTY_PATHS_BY_HOST[host.id].map((row) => [
        row.path, row.kind, row.enum ? `enum(${row.enum.join(' / ')})` : row.type, unit(row.unit),
        fmtValue(row.default), yes(row.keyable), yes(row.linkable), row.legacy ? '是' : '—', row.description,
      ])), '');
  }

  push('## 已废弃路径（仅旧工程）', '', MARKER, '');
  push(table(['host', 'path', '单位', '说明'], LEGACY_PATHS.map((row) => [row.host, row.path, unit(row.unit), row.description])), '');

  push('## 新建时的默认值', '', MARKER, '');
  push('`addElement` / `addCamera` / `objectAdd` 实际写入的缺省值。', '');
  push(table(['类别', '字段', '默认值'], Object.entries(DOCUMENT_DEFAULTS).flatMap(([kind, defaults]) => Object.entries(defaults).map(([key, value]) => [kind, key, fmtValue(value)]))), '');

  push('## 生成的 JSON Schema', '', MARKER, '');
  push('`mcp/tools.js` 直接引用这些对象，不复制字段：', '');
  push(table(['导出', '用在哪里'], [
    ['EDIT_SCHEMA', '`vdm_project_apply_ops` 的 inputSchema（含 `$defs.op`）、`vdm://project/schema` 资源'],
    ['CHANGESET_APPLY_SCHEMA', '`vdm_changeset_apply` 的 inputSchema（`id` 或 `ops` 二选一）'],
    ['EDIT_BASELINE', '`expectedRev` / `requestId` / `dryRun`，`vdm_history_undo|redo` 也用它'],
    ['ACTOR_ID', '`vdm_changeset_*` 的 actorId 字段'],
    ['OP_SCHEMA', '`vdm://project/schema` 资源里的单 op 联合'],
  ]), '');
  push('工具名 → schema 的对照由 `TOOL_SCHEMAS` 导出：', '');
  push(table(['工具', 'schema'], Object.entries(TOOL_SCHEMAS).map(([name, schema]) => [name, `\`${schemaLabel(schema)}\`（$defs.op 内嵌）`])), '');

  push('## 生成与校验', '', MARKER, '');
  push(`- 重生成：\`node scripts/gen-contracts.mjs\``,
    '- 校验：`node scripts/gen-contracts.mjs --check`（不一致时非零退出并打印 diff 摘要）',
    `- 生成器：\`${GENERATED_BY}\`；契约版本：\`CONTRACT_VERSION ${CONTRACT_VERSION}\``, '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------- JSON snapshot

function renderJson() {
  const fieldsOf = (contract) => contract.fields.map((field) => ({
    name: field.name, type: field.type, unit: field.unit, required: field.required, enum: field.enum, description: field.description,
  }));
  const snapshot = {
    contractVersion: CONTRACT_VERSION,
    generatedBy: GENERATED_BY,
    source: 'core/contracts.js',
    counts: {
      publicOps: PUBLIC_OPS.length,
      opFields: PUBLIC_OPS.reduce((n, op) => n + OP_CONTRACTS[op].fields.length, 0),
      propertyPaths: PROPERTY_PATHS.length,
      keyable: Object.fromEntries(Object.entries(KEYABLE_PATHS).map(([host, list]) => [host, list.length])),
      linkable: Object.fromEntries(Object.entries(LINKABLE_PATHS).map(([host, list]) => [host, list.length])),
      legacyPaths: LEGACY_PATHS.length,
    },
    units: UNITS,
    opGroups: OP_GROUPS,
    ops: Object.fromEntries(PUBLIC_OPS.map((op) => {
      const contract = OP_CONTRACTS[op];
      return [op, {
        group: contract.group,
        summary: contract.summary,
        description: contract.description,
        required: contract.required,
        fields: fieldsOf(contract),
        example: contract.example,
      }];
    })),
    propertyPaths: PROPERTY_PATHS.map((row) => ({
      host: row.host,
      path: row.path,
      kind: row.kind,
      type: row.type,
      unit: row.unit,
      default: row.default,
      keyable: row.keyable,
      linkable: row.linkable,
      legacy: row.legacy,
      label: row.label,
      description: row.description,
    })),
    legacyPaths: LEGACY_PATHS,
    defaults: DOCUMENT_DEFAULTS,
    editSchema: EDIT_SCHEMA,
    changesetApplySchema: CHANGESET_APPLY_SCHEMA,
  };
  return asJson(snapshot);
}

// ---------------------------------------------------------------- diff + main

/** Line diff via LCS; returns { added, removed, hunks: [{ a, b }] } for the summary. */
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i += 1; j += 1; continue; }
    const startA = i;
    const startB = j;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) break;
      if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { j += 1; hunks.push({ type: '+', line: b[j - 1], at: startB }); } else if (i < n) { i += 1; hunks.push({ type: '-', line: a[i - 1], at: startA }); }
    }
  }
  const added = hunks.filter((hunk) => hunk.type === '+').length;
  const removed = hunks.filter((hunk) => hunk.type === '-').length;
  return { added, removed, hunks };
}

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function printDiffSummary(file, expected, actual, io) {
  const diff = lineDiff(actual ?? '', expected);
  io.out(`  ${file}: 与生成结果不一致（+${diff.added} −${diff.removed} 行）`);
  const shown = diff.hunks.slice(0, 12);
  for (const hunk of shown) io.out(`    ${hunk.type} ${hunk.line.slice(0, 160)}`);
  if (diff.hunks.length > shown.length) io.out(`    … 还有 ${diff.hunks.length - shown.length} 行差异`);
}

export async function generate({ root = ROOT } = {}) {
  const rendered = FILES.map((entry) => ({ ...entry, content: entry.render() }));
  return { root, rendered };
}

/** Line-ending tolerant compare: git may check generated files out as CRLF. */
const sameText = (actual, expected) => actual !== null && actual.replace(/\r\n/g, '\n') === expected;

export async function check({ root = ROOT, io = { out: (line) => console.log(line), error: (line) => console.error(line) } } = {}) {
  const { rendered } = await generate({ root });
  let failed = 0;
  for (const entry of rendered) {
    const file = path.join(root, entry.file);
    const actual = await readIfPresent(file);
    if (sameText(actual, entry.content)) {
      io.out(`  ok   ${entry.file}`);
      continue;
    }
    failed += 1;
    if (actual === null) io.out(`  missing ${entry.file}`);
    else printDiffSummary(entry.file, entry.content, actual, io);
  }
  if (failed) {
    io.error(`✗ 契约生成物与 core/contracts.js 不一致（${failed}/${rendered.length} 个文件）。`);
    io.error('  跑 `node scripts/gen-contracts.mjs` 重新生成；生成的三个文件都不允许手改。');
    return 1;
  }
  io.out(`✓ 契约生成物一致（${rendered.length} 个文件，contract v${CONTRACT_VERSION}）。`);
  return 0;
}

async function write({ root = ROOT, io = { out: (line) => console.log(line) } } = {}) {
  const { rendered } = await generate({ root });
  for (const entry of rendered) {
    const file = path.join(root, entry.file);
    const actual = await readIfPresent(file);
    if (sameText(actual, entry.content)) {
      io.out(`  unchanged ${entry.file}`);
      continue;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entry.content);
    const bytes = Buffer.byteLength(entry.content);
    io.out(`  wrote     ${entry.file} (${bytes} bytes)`);
  }
  return 0;
}

async function main(argv) {
  const args = argv.slice(2);
  let checkOnly = false;
  let root = ROOT;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--check') checkOnly = true;
    else if (arg === '--root') { root = path.resolve(args[i + 1] || ''); i += 1; }
    else if (arg === '--help' || arg === '-h') { console.log('usage: node scripts/gen-contracts.mjs [--check] [--root <dir>]'); return 0; }
    else { console.error(`unknown argument ${arg}`); return 2; }
  }
  return checkOnly ? check({ root }) : write({ root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`gen-contracts failed: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
