// Source view + external-change watch (docs/DESIGN-WP3.6-4.6-UI.md §2.2 and
// the §7.1 revision R1, WP3.6b).
//
// The window is **read only** (§7.1): no editor, no syntax highlighting, no
// manifest defaults. What it does:
//
//   left   `manifest.entry` + `files` keys of the registered source;
//   right  that file's text with line numbers, selectable, never editable;
//   foot   size, sha256 (first 8), last contract check and its verdict.
//
// The interesting button is not 刷新 but **载入外部修改**: an external editor
// writes `sources/<id>/`, the project registry is the truth, so loading is a
// transaction and never a file read:
//
//   1. diff the copy against `project.sources[]` (core/source-diff.js);
//   2. run the contract check on the candidate (POST /sources/<id>/check —
//      the half of `vdm source check` that needs no frame);
//   3. only if it passes: one transaction of `sourceWrite` ops (or one
//      `sourceAdd` when manifest.json itself changed), so Ctrl+Z takes the
//      whole load back.
//
// A watch polls the copies (2.5 s, paused while the page is hidden) and raises
// a non-modal notice — `源码已在外部修改` + [载入] — the moment one differs.
import { h } from './ui.js';
import {
  SOURCE_MANIFEST, isSafeSourceId, manifestIssues, scanSourceFiles, sourceFiles, sourceRecord,
} from '/core/code-layer.js';
import { diffSummary, sourceFileDiff, LOADABLE_STATUSES } from '/core/source-diff.js';

/** How often the watch looks at `sources/<id>/` (§7.1: poll, no SSE needed). */
export const WATCH_INTERVAL = 2500;

/** Only files a load would write: a deletion in the copy is never applied. */
const loadableSummary = (diff) => diffSummary(diff, { statuses: LOADABLE_STATUSES });

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (value === undefined || value === null ? '' : String(value));
const bytesOf = (value) => new TextEncoder().encode(String(value ?? '')).length;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const timeOf = (iso) => {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
};

/** JSON fetch that keeps the engine's error body (`.code`, `.error`) attached. */
async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.error || `${response.status} ${response.statusText}`), body);
  }
  return body;
}

/** First 8 hex digits of the file's sha256 (`sha256:ab12cd34`), or null. */
async function shortHash(content) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The registry side: what the project says about this source
// ---------------------------------------------------------------------------

/**
 * Contract check of the **registered** source (the project is the truth): the
 * same static rules the load check runs server-side, so 检查 / 重新检查 agree
 * with what 载入外部修改 would say about the same text.
 */
export function registryCheck(project, sourceId) {
  const at = new Date().toISOString();
  const record = sourceRecord(project, sourceId);
  if (!record) return { at, ok: false, problems: [`工程里没有源 ${sourceId}`], files: [], entry: '', manifest: null, scan: null };
  const manifest = isRecord(record.manifest) ? record.manifest : null;
  const files = sourceFiles(project, sourceId);
  const problems = [];
  if (!manifest) problems.push('没有 manifest.json');
  else for (const issue of manifestIssues(manifest)) problems.push(`${issue.path} ${issue.msg}`);
  const entry = text(manifest?.entry);
  if (entry && !files.some((file) => file.path === entry)) problems.push(`找不到 ${entry}`);
  const scan = scanSourceFiles(files, { runtime: manifest?.runtime ?? null });
  for (const error of scan.errors) problems.push(error.message);
  return { at, ok: problems.length === 0, problems, files, entry, manifest, scan };
}

/** Files the list shows: `manifest.entry` first, then `files` keys (§2.2). */
export function sourceFileList(project, sourceId) {
  const record = sourceRecord(project, sourceId);
  const manifest = isRecord(record?.manifest) ? record.manifest : null;
  const entry = text(manifest?.entry);
  const names = Object.keys(isRecord(record?.files) ? record.files : {}).filter((rel) => rel !== SOURCE_MANIFEST).sort();
  const out = [];
  if (entry) out.push(entry);
  for (const name of names) if (!out.includes(name)) out.push(name);
  return out;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {() => object} deps.getProject        live project
 * @param {(msg: string, level?: string) => void} deps.toast
 * @param {(ops: Array) => Promise<any>} deps.op one transaction through main.js::op
 * @param {(intent: string) => void} deps.setAIDraft   fill the AI page's box
 * @param {(payload: object) => Promise<any>} deps.openInEditor  desktop bridge
 * @param {() => void} [deps.undo] / [deps.redo]  Ctrl+Z / Ctrl+Shift+Z
 */
export function createSourceView(deps) {
  const state = {
    open: false,
    sourceId: '',
    file: '',
    files: [],
    registry: null,
    copy: null,
    diff: null,
    summary: null,
    hash8: null,
    panel: null, // { tone, title, note, problems[], diff, verdict }
    busy: false,
    opener: null,
  };

  const modal = h('div', { class: 'modal srcv-modal', hidden: true, 'data-role': 'source-view' });
  const card = h('div', {
    class: 'modal-card srcv-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'srcvTitle',
  });
  modal.append(card);
  document.body.append(modal);

  const label = () => {
    const record = sourceRecord(deps.getProject(), state.sourceId);
    const manifest = isRecord(record?.manifest) ? record.manifest : null;
    return text(manifest?.label) || state.sourceId || '源';
  };

  /**
   * Load the copy into the project — the one pipeline behind both entries
   * (the modal's button and the watch's [载入]). Returns what happened.
   */
  async function loadExternal(sourceId, { quiet = false } = {}) {
    const id = text(sourceId) || state.sourceId;
    const project = deps.getProject();
    if (!sourceRecord(project, id)) return { ok: false, reason: 'missing', message: `工程里没有源 ${id}` };
    let copy;
    try {
      copy = await fetchJson(`/api/sources/${encodeURIComponent(id)}/files`);
    } catch (error) {
      return { ok: false, reason: 'fetch', message: `读不到 sources/${id}/：${error.message}` };
    }
    if (copy.missing) {
      return { ok: false, reason: 'no-copy', message: `sources/${id}/ 不存在：还没有外部副本`, copy };
    }
    const before = sourceFiles(project, id);
    const after = (Array.isArray(copy.files) ? copy.files : []).map(({ path, content }) => ({ path, content }));
    const diff = sourceFileDiff(before, after);
    const summary = loadableSummary(diff);
    if (summary.empty) return { ok: false, reason: 'no-change', message: '副本和工程一致，没有可载入的修改', diff, summary, copy };
    let verdict;
    try {
      verdict = await fetchJson(`/api/sources/${encodeURIComponent(id)}/check`, {
        method: 'POST',
        body: JSON.stringify({
          files: after,
          manifestText: typeof copy.manifestText === 'string' ? copy.manifestText : null,
        }),
      });
    } catch (error) {
      return { ok: false, reason: 'check', message: `契约检查失败：${error.message}`, diff, summary, copy };
    }
    if (!verdict.ok) return { ok: false, reason: 'check', message: '没通过契约检查，没有写入', diff, summary, copy, verdict };
    const plan = loadOps(project, id, copy, diff);
    if (!plan.ops.length) {
      return {
        ok: false,
        reason: plan.error ? 'check' : 'no-change',
        message: plan.error || '没有需要写入的文件',
        diff, summary, copy, verdict,
      };
    }
    const result = await deps.op(plan.ops);
    if (!result) return { ok: false, reason: 'write', message: '写入失败（工程在别处被改过？）', diff, summary, copy, verdict, plan };
    return { ok: true, kind: plan.kind, ops: plan.ops, count: plan.ops.length, diff, summary, copy, verdict, result, quiet };
  }

  /**
   * Ops that carry the copy into the registry. `manifest.json` cannot go
   * through `sourceWrite` (the contract refuses it: only `sourceAdd` may
   * rewrite the manifest), so a changed manifest becomes one `sourceAdd` that
   * keeps the files the copy does not mention.
   */
  function loadOps(project, sourceId, copy, diff) {
    const record = sourceRecord(project, sourceId);
    const copyFiles = (Array.isArray(copy.files) ? copy.files : [])
      .filter((file) => file && typeof file.path === 'string' && file.path !== SOURCE_MANIFEST);
    const manifestEntry = diff.files.find((file) => file.path === SOURCE_MANIFEST);
    const manifestChanged = !!manifestEntry && manifestEntry.status !== 'same';
    if (manifestChanged) {
      const manifest = parseManifest(copy);
      if (!manifest) return { kind: 'sourceAdd', ops: [], error: 'manifest.json 解析失败，没有写入' };
      const files = { ...(isRecord(record?.files) ? record.files : {}) };
      for (const file of copyFiles) files[file.path] = file.content;
      return { kind: 'sourceAdd', ops: [{ op: 'sourceAdd', id: sourceId, manifest, files }] };
    }
    const ops = copyFiles
      .filter((file) => isLoaded(diff, file.path))
      .map((file) => ({ op: 'sourceWrite', id: sourceId, path: file.path, content: file.content }));
    return { kind: 'sourceWrite', ops };
  }

  const isLoaded = (diff, path) => {
    const entry = diff.files.find((file) => file.path === path);
    return !!entry && (entry.status === 'changed' || entry.status === 'added');
  };

  const parseManifest = (copy) => {
    if (typeof copy?.manifestText !== 'string') return null;
    try {
      const parsed = JSON.parse(copy.manifestText);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  /** Re-read the registry and the copy, then repaint. */
  async function refresh({ panel = state.panel } = {}) {
    const project = deps.getProject();
    const sourceId = state.sourceId;
    state.registry = registryCheck(project, sourceId);
    state.files = sourceFileList(project, sourceId);
    if (!state.files.includes(state.file)) state.file = state.files[0] || '';
    let copy = null;
    try {
      copy = await fetchJson(`/api/sources/${encodeURIComponent(sourceId)}/files`);
    } catch (error) {
      copy = { ok: false, files: [], problems: [error.message], missing: false };
    }
    state.copy = copy;
    const before = sourceFiles(project, sourceId);
    const after = (Array.isArray(copy?.files) ? copy.files : []).map(({ path, content }) => ({ path, content }));
    state.diff = sourceFileDiff(before, after);
    state.summary = loadableSummary(state.diff);
    state.panel = panel || null;
    state.hash8 = null;
    render();
    const content = currentText();
    const hash = await shortHash(content);
    if (state.open && hash !== state.hash8) {
      state.hash8 = hash;
      render();
    }
  }

  const currentText = () => {
    const registry = state.registry;
    const file = (registry?.files || []).find((entry) => entry.path === state.file);
    return file ? file.content : '';
  };

  // ------------------------------------------------------------------ render

  function render() {
    if (!state.open) return;
    const project = deps.getProject();
    const record = sourceRecord(project, state.sourceId);
    const manifest = isRecord(record?.manifest) ? record.manifest : null;
    const runtime = text(manifest?.runtime);
    const version = text(manifest?.format) || 'manifest.json';
    const title = h('div', { class: 'modal-title srcv-title' },
      h('strong', { id: 'srcvTitle', 'data-role': 'name' }, label()),
      runtime ? h('span', { class: 'srcv-rt', 'data-tip': `运行时 ${runtime}` }, runtime) : null,
      h('span', { class: 'srcv-ver mono', 'data-role': 'version', 'data-tip': 'manifest.json 的 format / 源 id' }, `${version} · ${state.sourceId || '—'}`));

    const busy = state.busy;
    const actions = h('div', { class: 'srcv-actions' },
      h('button', {
        type: 'button', class: 'btn ghost mini', 'data-action': 'source-open', disabled: busy,
        'data-tip': '用系统默认程序打开 sources/<id>/<file>\n外面改了以后点「载入外部修改」',
        onclick: () => openInEditor(),
      }, '在编辑器中打开'),
      h('button', {
        type: 'button', class: 'btn ghost mini', 'data-action': 'source-ai',
        'data-tip': '把「改这份源」的意图填进 AI 页输入框',
        onclick: () => askAI(),
      }, '让 AI 改'),
      h('button', {
        type: 'button', class: 'btn ghost mini', 'data-action': 'source-recheck', disabled: busy,
        'data-tip': '重新跑静态契约检查（不改任何文件）',
        onclick: () => recheck(),
      }, '重新检查'),
      h('button', {
        type: 'button', class: 'icon-btn modal-x', 'aria-label': '关闭', 'data-action': 'source-close',
        'data-tip': '关闭', 'data-kbd': 'Esc', onclick: () => close(),
      }, '×'));
    const head = h('div', { class: 'modal-head srcv-head' }, title, actions);

    const errorLine = state.registry && !state.registry.ok ? h('div', { class: 'srcv-error', role: 'status' },
      h('span', { class: 'srcv-error-text' }, state.registry?.problems?.[0] || '源有问题'),
      state.registry?.problems?.length > 1
        ? h('span', { class: 'srcv-error-more', 'data-tip': state.registry.problems.join('\n') }, `等 ${state.registry.problems.length} 处`)
        : null,
      h('button', {
        type: 'button', class: 'btn ghost mini', 'data-action': 'source-rescan',
        'data-tip': '重新读工程和 sources/<id>/，再跑一次检查',
        onclick: () => recheck(),
      }, '重新扫描')) : null;

    const body = h('div', { class: 'srcv-body' }, filesPane(), state.panel ? diffPane() : codePane());

    const foot = h('div', { class: 'srcv-foot' },
      h('span', { class: 'srcv-meta mono', 'data-role': 'meta' }, metaText()),
      h('span', { class: 'srcv-check', 'data-role': 'check' },
        state.registry
          ? (state.registry.ok ? `检查通过 · ${timeOf(state.registry.at)}` : `检查失败 · ${timeOf(state.registry.at)}`)
          : '检查中…'),
      h('span', { class: 'srcv-spacer' }),
      loadBadge(),
      h('button', {
        type: 'button', class: 'btn mini primary', 'data-action': 'source-load', disabled: busy,
        'data-tip': '对比 sources/<id>/ 与工程正文，跑契约检查，通过后一次事务写入（Ctrl+Z 撤销）',
        onclick: () => runLoad(),
      }, busy ? '载入中…' : '载入外部修改'));

    card.replaceChildren(...[head, errorLine, body, foot].filter(Boolean));
  }

  const metaText = () => {
    const content = currentText();
    const bytes = bytesOf(content);
    const hash = state.hash8 ? `sha256:${state.hash8}` : 'sha256:…';
    return `${state.file || '（没有文件）'} · ${fmtBytes(bytes)} · ${hash}`;
  };

  /** `副本 +3 −1` / `副本一致` / `副本不存在` next to the load button. */
  function loadBadge() {
    const summary = state.summary || { changedFiles: 0, added: 0, removed: 0 };
    if (state.copy?.missing) return h('span', { class: 'srcv-dirty muted', 'data-role': 'copy' }, '副本不存在');
    if (!summary.changedFiles) return h('span', { class: 'srcv-dirty muted', 'data-role': 'copy' }, '副本一致');
    return h('span', { class: 'srcv-dirty', 'data-role': 'copy', 'data-tip': summary.paths.join('、') },
      `副本 +${summary.added} −${summary.removed}`);
  }

  function filesPane() {
    const rows = state.files.map((path) => {
      const dirty = isLoaded(state.diff, path);
      const missing = (state.registry?.files || []).every((file) => file.path !== path);
      return h('button', {
        type: 'button',
        class: `srcv-file${path === state.file ? ' on' : ''}${dirty ? ' dirty' : ''}${missing ? ' missing' : ''}`,
        'data-action': 'source-file', 'data-file': path,
        'data-tip': missing ? `${path}（工程里没有这个文件）` : `${path}${dirty ? '\n副本里改过' : ''}`,
        onclick: () => selectFile(path),
      }, h('span', { class: 'srcv-file-name' }, path), dirty ? h('span', { class: 'srcv-dot', 'aria-hidden': 'true' }) : null);
    });
    if (!rows.length) rows.push(h('div', { class: 'srcv-file-empty' }, '这个源没有文件'));
    return h('div', { class: 'srcv-files', role: 'listbox', 'aria-label': '源文件' }, ...rows);
  }

  function codePane() {
    const content = currentText();
    const count = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const numbers = count ? Array.from({ length: count }, (_v, i) => String(i + 1)).join('\n') : '';
    return h('div', { class: 'srcv-pane', 'data-role': 'code' },
      h('div', { class: 'srcv-code' },
        h('pre', { class: 'srcv-ln', 'aria-hidden': 'true' }, numbers),
        h('pre', { class: 'srcv-text', 'data-role': 'text', tabindex: '0', 'aria-label': `${state.file} 只读` }, content)));
  }

  function diffPane() {
    const panel = state.panel;
    const head = h('div', { class: 'srcv-diff-head' },
      h('span', { class: `srcv-diff-title ${panel.tone || ''}` }, panel.title || '外部修改'),
      panel.note ? h('span', { class: 'srcv-diff-note' }, panel.note) : null,
      h('span', { class: 'srcv-spacer' }),
      h('button', {
        type: 'button', class: 'btn ghost mini', 'data-action': 'source-code', 'data-tip': '回到源文件正文',
        onclick: () => { state.panel = null; render(); },
      }, '返回源码'));
    const problems = Array.isArray(panel.problems) && panel.problems.length
      ? h('div', { class: 'srcv-problems', role: 'status' },
        ...panel.problems.slice(0, 8).map((problem) => h('div', { class: 'srcv-problem' }, problem)),
        panel.problems.length > 8 ? h('div', { class: 'srcv-problem muted' }, `还有 ${panel.problems.length - 8} 处…`) : null)
      : null;
    const rows = [];
    for (const file of panel.diff?.files || []) {
      if (file.status === 'same') continue;
      rows.push(h('div', { class: 'srcv-dfile', 'data-status': file.status },
        h('span', { class: 'srcv-dfile-name' }, file.path),
        h('span', { class: 'srcv-dfile-stat' }, file.status === 'added'
          ? `新增 +${file.added}`
          : file.status === 'removed'
            ? `副本里没有（−${file.removed}，不改）`
            : `+${file.added} −${file.removed}`)));
      for (const line of file.lines) rows.push(diffRow(line));
    }
    if (!rows.length && !problems) rows.push(h('div', { class: 'srcv-problem muted' }, '没有修改'));
    return h('div', { class: 'srcv-pane srcv-diffpane', 'data-role': 'diff' },
      head,
      problems,
      h('div', { class: 'srcv-diffrows' }, ...rows));
  }

  function diffRow(line) {
    if (line.kind === 'gap') return h('div', { class: 'srcv-drow gap' }, h('span', {}, '…'));
    const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
    return h('div', { class: `srcv-drow ${line.kind}` },
      h('span', { class: 'srcv-dnum' }, line.a === null ? '' : String(line.a)),
      h('span', { class: 'srcv-dnum' }, line.b === null ? '' : String(line.b)),
      h('span', { class: 'srcv-dmark' }, mark),
      h('span', { class: 'srcv-dtext' }, line.text ?? ''));
  }

  // ------------------------------------------------------------------ actions

  function selectFile(path) {
    if (!path || path === state.file) return;
    state.file = path;
    state.panel = null;
    state.hash8 = null;
    render();
    void shortHash(currentText()).then((hash) => {
      state.hash8 = hash;
      if (state.open) render();
    });
  }

  async function runLoad() {
    if (state.busy) return null;
    state.busy = true;
    render();
    const result = await loadExternal(state.sourceId);
    state.busy = false;
    state.panel = panelFor(result);
    await refresh({ panel: state.panel });
    if (result.ok) deps.onLoaded?.(state.sourceId);
    notify(result);
    return result;
  }

  /** What the diff pane says after one load attempt. */
  function panelFor(result) {
    if (result.ok) {
      return {
        tone: 'ok',
        title: `已载入外部修改 · 来源 外部编辑器`,
        note: `${result.kind === 'sourceAdd' ? 'sourceAdd' : `${result.count} 个 sourceWrite`} · Ctrl+Z 撤销`,
        diff: result.diff,
        verdict: result.verdict,
        problems: [],
      };
    }
    if (result.reason === 'check' && result.verdict) {
      return {
        tone: 'bad',
        title: '没通过契约检查，没有写入',
        note: `${result.verdict.problems.length} 处`,
        problems: result.verdict.problems.map((problem) => (problem.file ? `${problem.file}: ` : '') + problem.message),
        diff: result.diff,
        verdict: result.verdict,
      };
    }
    return {
      tone: result.reason === 'no-change' ? 'muted' : 'bad',
      title: result.message || '没有写入',
      note: '',
      problems: [],
      diff: result.diff || null,
      verdict: result.verdict || null,
    };
  }

  function notify(result) {
    if (result.ok) {
      deps.toast(`已载入外部修改（来源 外部编辑器，Ctrl+Z 撤销）`, 'success');
    } else if (result.reason === 'no-change') {
      deps.toast(result.message || '副本和工程一致', 'info');
    } else if (result.reason === 'check') {
      deps.toast(result.message || '没通过契约检查，没有写入', 'error');
    } else {
      deps.toast(result.message || '没有载入', result.reason === 'write' ? 'error' : 'warn');
    }
  }

  async function recheck() {
    state.panel = null;
    await refresh({ panel: null });
    const registry = state.registry;
    if (registry?.ok) deps.toast('检查通过（manifest / 入口 / 静态扫描）', 'success');
    else deps.toast(`检查失败：${registry?.problems?.[0] || '未知原因'}`, 'error');
  }

  function askAI() {
    const intent = `请改源码 \`${state.sourceId}\`（sources/${state.sourceId}/${state.file || 'main.js'}）：`;
    close();
    deps.setAIDraft(intent);
  }

  async function openInEditor() {
    const payload = { sourceId: state.sourceId, file: state.file || 'main.js', files: sourceFiles(deps.getProject(), state.sourceId) };
    let result = null;
    try {
      result = await deps.openInEditor(payload);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result?.ok) deps.toast(`已用系统默认程序打开 ${result.path || payload.file}`, 'info');
    else deps.toast(`打开失败：${result?.error || '桌面版才能在系统编辑器里打开'}`, 'warn');
  }

  // ------------------------------------------------------------------ open/close

  async function open({ sourceId = '', focus = null } = {}) {
    const id = text(sourceId);
    if (!id) return false;
    state.open = true;
    state.sourceId = id;
    state.file = '';
    state.panel = null;
    state.busy = false;
    state.opener = document.activeElement;
    // Read the registry + the copy first, then show: a window that appears
    // already filled in cannot flash an empty file list.
    await refresh({ panel: null });
    if (!state.open || state.sourceId !== id) return false;
    modal.hidden = false;
    if (focus === 'check' && !state.registry?.ok) {
      state.panel = {
        tone: 'bad',
        title: '这个源没通过检查',
        note: `${state.registry.problems.length} 处`,
        problems: state.registry.problems,
        diff: null,
      };
      render();
    }
    return true;
  }

  function close() {
    if (!state.open) return false;
    state.open = false;
    modal.hidden = true;
    card.replaceChildren();
    const opener = state.opener;
    state.opener = null;
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
    return true;
  }

  // Esc closes; Ctrl+Z / Ctrl+Shift+Z still undo, because the app's own key
  // handler ignores keys while a modal is open (main.js) — inside this window
  // the transaction you just made must stay undoable.
  const onKey = (event) => {
    if (!state.open) return;
    if ([...document.querySelectorAll('.modal:not([hidden])')].pop() !== modal) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) deps.redo?.(); else deps.undo?.();
    }
  };
  window.addEventListener('keydown', onKey, true);

  modal.addEventListener('pointerdown', (event) => { if (event.target === modal) close(); });

  return {
    open,
    close,
    isOpen: () => state.open,
    current: () => (state.open ? state.sourceId : ''),
    refresh: () => refresh({ panel: state.panel }),
    /** The watch's [载入]: write quietly, open the window when there is a reason to look. */
    async load(sourceId) {
      const id = text(sourceId) || state.sourceId;
      const result = await loadExternal(id, { quiet: true });
      if (result.ok) deps.onLoaded?.(id);
      if (!state.open) {
        if (result.ok) {
          deps.toast('已载入外部修改（来源 外部编辑器，Ctrl+Z 撤销）', 'success');
          return result;
        }
        if (result.reason === 'no-change') return result;
        // A refusal (or a dead copy) needs the diff on screen.
        await open({ sourceId: id });
      } else if (state.sourceId === id) {
        state.panel = panelFor(result);
        await refresh({ panel: state.panel });
      }
      notify(result);
      return result;
    },
    modal,
  };
}

// ---------------------------------------------------------------------------
// The watch: non-modal notice when `sources/<id>/` changes
// ---------------------------------------------------------------------------

/**
 * Poll every registered source's copy and show `源码已在外部修改 [载入]` when
 * one differs from the project. Never a modal, never blocking (§7.1).
 *
 * @param {object} deps  same as the view plus `open({ sourceId })`
 */
export function createSourceWatch(deps) {
  const state = {
    timer: 0,
    running: false,
    cache: new Map(), // sourceId -> { key: `rev|signature`, summary } (diff cache)
    ignored: new Map(), // sourceId -> signature the user dismissed
    changes: new Map(), // sourceId -> { signature, summary }
    visible: false,
  };

  const banner = h('div', {
    id: 'sourceBanner', class: 'source-banner', role: 'status', hidden: true, 'data-role': 'source-watch',
  });
  document.querySelector('#stageWrap')?.append(banner);
  if (!banner.isConnected) document.body.append(banner);

  const signatureOf = (files) => JSON.stringify((Array.isArray(files) ? files : []).map((file) => [file.path, file.content]));

  function paint() {
    const entries = [...state.changes.entries()];
    if (!entries.length) {
      state.visible = false;
      banner.hidden = true;
      banner.replaceChildren();
      return;
    }
    const [sourceId, change] = entries[0];
    const more = entries.length > 1 ? ` 等 ${entries.length} 个源` : '';
    const label = deps.label?.(sourceId) || sourceId;
    state.visible = true;
    banner.hidden = false;
    banner.replaceChildren(
      h('span', { class: 'sb-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'sb-text' }, '源码已在外部修改'),
      h('span', { class: 'sb-src mono', 'data-role': 'source' }, `${label}${more}`),
      h('span', { class: 'sb-stat mono' }, `+${change.summary.added} −${change.summary.removed}`),
      h('button', {
        type: 'button', class: 'btn mini', 'data-action': 'source-load-now',
        'data-tip': '对比副本与工程正文，跑契约检查，通过后一次事务写入',
        onclick: () => {
          const id = [...state.changes.keys()][0];
          state.changes.delete(id);
          paint();
          void deps.load?.(id);
        },
      }, '载入'),
      h('button', {
        type: 'button', class: 'btn mini ghost', 'data-action': 'source-open-view',
        'data-tip': '打开源码视图，先看 diff 和检查结果',
        onclick: () => deps.open?.({ sourceId: [...state.changes.keys()][0] }),
      }, '查看'),
      h('button', {
        type: 'button', class: 'icon-btn mini sb-x', 'aria-label': '忽略这次修改', 'data-action': 'source-watch-dismiss',
        'data-tip': '忽略这次修改（工程正文不变）',
        onclick: () => {
          const id = [...state.changes.keys()][0];
          const change = state.changes.get(id);
          if (change) state.ignored.set(id, change.signature);
          state.changes.delete(id);
          paint();
          deps.toast?.('已忽略这次外部修改；副本还在，随时可以在源码视图里载入', 'info');
        },
      }, '×'));
  }

  async function poll() {
    if (state.running) return [];
    const project = deps.getProject();
    const records = Array.isArray(project?.sources) ? project.sources.filter((entry) => isRecord(entry) && isSafeSourceId(text(entry.id))) : [];
    if (!records.length) {
      if (state.changes.size) { state.changes.clear(); paint(); }
      return [];
    }
    state.running = true;
    const found = [];
    try {
      const rev = Number(project?.rev) || 0;
      for (const record of records) {
        const id = text(record.id);
        let copy;
        try {
          copy = await fetchJson(`/api/sources/${encodeURIComponent(id)}/files`);
        } catch {
          continue;
        }
        if (!copy.ok && copy.missing) {
          state.changes.delete(id);
          state.cache.delete(id);
          continue;
        }
        const signature = signatureOf(copy.files);
        // Diffing is the expensive half: an unchanged copy at an unchanged rev
        // reuses the last answer instead of walking the lines again.
        const key = `${rev}|${signature}`;
        const cached = state.cache.get(id);
        let summary = cached && cached.key === key ? cached.summary : null;
        if (!summary) {
          const before = sourceFiles(project, id);
          const after = (copy.files || []).map(({ path, content }) => ({ path, content }));
          summary = loadableSummary(sourceFileDiff(before, after));
          state.cache.set(id, { key, summary });
        }
        if (!summary.changedFiles) {
          state.changes.delete(id);
          continue;
        }
        if (state.ignored.get(id) === signature) continue;
        found.push({ id, signature, summary });
        state.changes.set(id, { signature, summary });
      }
      // A source that vanished from the project (or changed back) is stale.
      for (const id of [...state.changes.keys()]) {
        if (!found.some((entry) => entry.id === id)) state.changes.delete(id);
      }
    } finally {
      state.running = false;
    }
    paint();
    return found;
  }

  // Timers are throttled in a background tab, so the poll simply runs on its
  // interval; coming back to the page asks for one immediately.
  const tick = () => { void poll(); };

  return {
    start() {
      if (state.timer) return;
      state.timer = setInterval(tick, WATCH_INTERVAL);
      document.addEventListener('visibilitychange', tick);
      void poll();
    },
    stop() {
      if (state.timer) clearInterval(state.timer);
      state.timer = 0;
      document.removeEventListener('visibilitychange', tick);
      state.changes.clear();
      state.cache.clear();
      paint();
    },
    poll,
    banner,
    isVisible: () => state.visible,
    changed: () => [...state.changes.keys()],
    /** The modal loaded a copy: forget that source's notice immediately. */
    settle(sourceId) {
      state.changes.delete(text(sourceId));
      paint();
    },
  };
}
