#!/usr/bin/env node
// CLI shell for core/migrate-spatial.js — an explicit, one-shot 2D -> SpatialNode
// converter (PLAN-ui-round3 §2.3.2). It reads a project directory or JSON file
// and writes a *new* project JSON somewhere else; it never writes in place and
// refuses to touch `projects/` unless explicitly allowed.
//
//   node scripts/migrate-spatial.mjs --in <dir|json> --out <dir|json> \
//     --mode preserve|world|hybrid [--ids a,b,c] [--tag intro] [--dry-run] [--force]
//
// Modes:
//   preserve  convert every legacy 2D element to a fixed XY-plane node; keep the
//             @live screen parent (miku's 47 locked elements stay locked).
//   world     convert every legacy 2D element and release @live too; the old
//             parent object stays at legacy.parent.
//   hybrid    convert only --ids / --tag; everything else keeps the old
//             transform and keyframes. Selected @live elements keep their parent.
//
// Output rules:
//   - `--out` ending in `.json` is a file; anything else is a directory that
//     receives `project.vdm.json` (an existing directory always is).
//   - dry-run never creates a directory or file; it prints the plan JSON.
//   - the migrated document is validated with validateProject() before writing;
//     any issue is printed and exits non-zero without touching the target.
//   - an existing target is only overwritten with --force.
//
// This is a developer tool, not the project write path. A real upgrade still
// has to go through core/ops.js + a backup (PLAN-ui-round3 §2.3.1/§2.3.2).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { MIGRATION_MODES, planSpatialMigration } from '../core/migrate-spatial.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const USAGE = `Usage: node scripts/migrate-spatial.mjs <project-dir|project.json> [options]

Options:
  --in <path>              project directory or project.vdm.json (positional also accepted)
  --out <path>             output .json file or directory (default: <dir>/project.vdm.json)
  --mode <mode>            ${MIGRATION_MODES.join(' | ')} (default: preserve)
  --ids <a,b,c>            hybrid: element ids to convert (repeatable)
  --tag <tag>              hybrid: convert elements tagged meta.tag/meta.tags (repeatable)
  --dry-run                print stats/diff plan; do not create or write anything
  --force                  overwrite an existing output file
  -h, --help               show this help

The input is validated with validateProject(). The migrated document is validated
again before writing; issues are printed and the target is left untouched.`;

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function parseArgs(argv) {
  const opts = {
    input: null,
    out: null,
    mode: 'preserve',
    ids: [],
    tags: [],
    dryRun: false,
    force: false,
    help: false,
  };
  const args = argv.slice();
  const take = (i, inline, flag) => {
    if (inline !== null) return inline;
    if (i + 1 >= args.length) fail(`${flag} needs a value`);
    return args[i + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    switch (flag) {
      case '--in': opts.input = take(i, inline, flag); if (inline === null) i++; break;
      case '--out': opts.out = take(i, inline, flag); if (inline === null) i++; break;
      case '--mode': opts.mode = take(i, inline, flag); if (inline === null) i++; break;
      case '--ids': opts.ids.push(take(i, inline, flag)); if (inline === null) i++; break;
      case '--tag': opts.tags.push(take(i, inline, flag)); if (inline === null) i++; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (raw.startsWith('-')) fail(`unknown option ${raw}`);
        if (opts.input) fail(`unexpected second input ${raw}`);
        opts.input = raw;
    }
  }
  return opts;
}

function resolveInput(input) {
  if (!input) fail('missing input project directory or JSON file');
  const abs = path.resolve(input);
  let stat;
  try { stat = fs.statSync(abs); } catch { fail(`input does not exist: ${abs}`); }
  if (stat.isDirectory()) return path.join(abs, 'project.vdm.json');
  if (!stat.isFile()) fail(`input is not a file or directory: ${abs}`);
  return abs;
}

function resolveOutput(out) {
  if (!out) return null;
  const abs = path.resolve(out);
  let stat = null;
  try { stat = fs.statSync(abs); } catch { /* does not exist yet */ }
  if (stat?.isDirectory()) return path.join(abs, 'project.vdm.json');
  if (stat?.isFile() || abs.toLowerCase().endsWith('.json')) return abs;
  return path.join(abs, 'project.vdm.json');
}

function readProject(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { fail(`cannot read ${file}: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { fail(`cannot parse ${file}: ${e.message}`); }
}

const samePath = (a, b) => path.resolve(a) === path.resolve(b)
  || (process.platform === 'win32' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());

function assertWritableTarget(file, force) {
  if (!file) fail('missing --out (required unless --dry-run)');
  if (!force && fs.existsSync(file)) fail(`output already exists (use --force to overwrite): ${file}`);
  const segments = path.resolve(file).split(path.sep).map((s) => s.toLowerCase());
  if (segments.includes('projects')) {
    fail(`refusing to write under projects/ (copy the project to .tmp/fixtures and migrate that instead): ${file}`);
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  if (fs.existsSync(file)) fs.rmSync(file, { force: true }); // only reached with --force
  fs.renameSync(tmp, file);
}

function printIssues(issues) {
  for (const issue of issues) process.stderr.write(`[migrate-spatial] issue ${issue.path}: ${issue.msg}\n`);
}

function summary(report) {
  const s = report.stats;
  const k = s.keyframes;
  return `[migrate-spatial] ${report.mode}: ${s.converted}/${s.total} element(s) converted`
    + ` (${s.fromScreenParent} @live, ${s.fromFree} free), ${s.screenParentKept} screen parent(s) kept,`
    + ` ${s.screenParentReleased} released, keys ${k.rewritten} rewritten -> ${k.output} entries`
    + ` (${k.kept} non-spatial kept), validation ${report.issues.length} issue(s),`
    + ` node diff maxPivot=${report.diff.maxPivot} maxScale=${report.diff.maxScale} maxRoll=${report.diff.maxRoll}`;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!MIGRATION_MODES.includes(opts.mode)) {
    fail(`unknown mode "${opts.mode}" (expected ${MIGRATION_MODES.join(', ')})`);
  }
  const inputFile = resolveInput(opts.input);
  const outputFile = resolveOutput(opts.out);
  if (outputFile && samePath(inputFile, outputFile)) fail('refusing to write over the input file; choose another --out');
  if (!opts.dryRun) assertWritableTarget(outputFile, opts.force);

  const project = readProject(inputFile);
  const plan = planSpatialMigration(project, {
    mode: opts.mode,
    ids: opts.ids,
    tags: opts.tags,
  });

  const report = {
    ok: plan.issues.length === 0,
    dryRun: opts.dryRun,
    mode: opts.mode,
    version: plan.version,
    input: inputFile,
    output: outputFile,
    written: false,
    stats: plan.stats,
    diff: plan.diff,
    changes: plan.changes,
    issues: plan.issues,
  };
  process.stderr.write(`${summary(report)}\n`);
  if (plan.issues.length) {
    printIssues(plan.issues);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write('[migrate-spatial] validation failed; nothing written.\n');
    return 1;
  }
  if (opts.dryRun) {
    process.stderr.write(`[migrate-spatial] dry-run: would write ${outputFile || '(no --out)'} — not written.\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  writeAtomic(outputFile, `${JSON.stringify(plan.project, null, 2)}\n`);
  report.written = true;
  process.stderr.write(`[migrate-spatial] wrote ${outputFile}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`[migrate-spatial] error: ${error.message}\n`);
    process.exitCode = 1;
  } else if (error?.name === 'SpatialMigrationError') {
    process.stderr.write(`[migrate-spatial] error: ${error.message}\n`);
    printIssues(error.issues || []);
    process.exitCode = 1;
  } else {
    process.stderr.write(`[migrate-spatial] unexpected error: ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
