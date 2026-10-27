#!/usr/bin/env node
// Runs a command and returns only what matters (pass/fail counts, errors with file:line, or the
// last few lines). The full output is saved so it can still be searched.
//
//   node tools/run.mjs <command …>        e.g. node tools/run.mjs npm test
//   node tools/run.mjs --log N [words]    lines from saved run N (matching the words, or the end)
// Add --budget N to change the token limit (default 150).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addSaving } from './lib/savings.mjs';

const KEEP_RUNS = 20;
const MAX_LINE = 160;
import { tokens } from './lib/tokens.mjs';
const clip = (s) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) + '…' : s);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const NOISE = /^(npm (notice|warn)|> \S+@\S+ |> node |\s*$|\(node:\d+\) (Experimental|\[DEP)|\(Use `node --trace)/;
const ERROR = /\b(error|errors|failed|failure|failing|exception|traceback|fatal|cannot|not found|denied|refused|ERR!|panic)\b|✗|✖/i;
const LOCATION = /(?:^|[\s('"])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z]{1,5}):(\d+)(?::(\d+))?/;

class Out {
  constructor(budget) { this.left = budget * 3.5; this.lines = []; }
  add(line) {
    line = clip(line);
    if (line.length + 1 > this.left) return false;
    this.lines.push(line);
    this.left -= line.length + 1;
    return true;
  }
}

// Turns a command's output into a few lines. Knows the usual test-runner summaries;
// otherwise keeps error lines (with their locations) or the last lines.
export function summarize(output, code, budget = 150) {
  const lines = output.replace(ANSI, '').split(/\r?\n/).filter((l) => !NOISE.test(l));
  const out = new Out(budget);

  // node --test / TAP
  const tap = {};
  for (const l of lines) {
    const m = l.match(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/);
    if (m) tap[m[1]] = Number(m[2]);
  }
  if (tap.tests !== undefined) {
    out.add(`tests ${tap.pass ?? 0}/${tap.tests} pass${tap.fail ? `, ${tap.fail} FAIL` : ''}${tap.cancelled ? `, ${tap.cancelled} cancelled` : ''}${tap.skipped ? `, ${tap.skipped} skipped` : ''}`);
    if (tap.fail) tapFailures(lines, out);
    return out.lines.join('\n');
  }

  // pytest, jest/vitest, mocha, cargo, go
  const summary = lines.find((l) => /^=+ .*\b(passed|failed|error)\b.* in [\d.]+s/.test(l) || /^\s*Tests?:\s+\d/.test(l)
    || /^\s*\d+ (passing|failing)\b/.test(l) || /^test result: /.test(l) || /^(ok|FAIL)\s+\S+\s+[\d.]+s$/.test(l));
  if (summary) out.add(summary.trim().replace(/^=+\s*|\s*=+$/g, ''));

  const errors = [];
  const seen = new Set();
  lines.forEach((l, i) => {
    if (!ERROR.test(l) || /\b0 (failed|failing|errors?)\b|# fail 0/.test(l)) return;
    const key = l.trim().replace(/\d+/g, '#');
    if (seen.has(key)) return;
    seen.add(key);
    // A location on this or the next line tells the reader where to look.
    const near = [l, lines[i + 1] ?? ''].map((x) => x.match(LOCATION)).find(Boolean);
    errors.push(l.trim() + (near && !l.includes(near[1]) ? `  @ ${near[1]}:${near[2]}` : ''));
  });
  if (code !== 0 || errors.length) {
    for (const e of errors.slice(0, 8)) if (!out.add(e)) break;
    if (errors.length > 8) out.add(`… ${errors.length - 8} more error lines`);
  }
  if (!out.lines.length || (code !== 0 && !errors.length)) {
    for (const l of lines.slice(-3)) out.add(l.trim());
  }
  return out.lines.join('\n');
}

function tapFailures(lines, out) {
  // Report the innermost failing tests with their error and location.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)not ok \d+ - (.*)$/);
    if (!m) continue;
    let error = '', location = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      if (/^\s*(not )?ok \d+ - /.test(lines[j])) break;
      const loc = lines[j].match(/location: '([^']+)'/);
      if (loc && !location) location = loc[1].replace(process.cwd() + '/', '');
      if (/^\s*error: /.test(lines[j]) && !error) {
        const inline = lines[j].replace(/^\s*error: /, '').trim();
        if (inline && !/^['"]?\|-?['"]?$/.test(inline)) error = inline.replace(/^['"]|['"]$/g, '');
        else {
          // Multi-line message: keep its first two non-empty lines ("values not equal" + "2 !== 3").
          const msg = [];
          for (let k = j + 1; k < lines.length && msg.length < 2 && !/^\s*\w+: /.test(lines[k]); k++) {
            const t = lines[k].trim().replace(/^['"]|['"]\s*\+?$/g, '').replace(/\\n$/, '').trim();
            if (t) msg.push(t);
          }
          error = msg.join(' ');
        }
      }
    }
    if (/subtestsFailed|\d+ subtests? failed/.test(error)) continue; // a parent; its child is reported
    if (!out.add(`FAIL ${m[2].trim()}${location ? ` @ ${location}` : ''}`)) return;
    if (error && !out.add(`  ${error}`)) return;
  }
}

function runsDir(root) {
  const dir = path.join(root, '.city', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveLog(root, command, output) {
  const dir = runsDir(root);
  const ids = fs.readdirSync(dir).map((f) => Number(f.replace('.log', ''))).filter(Number.isFinite).sort((a, b) => a - b);
  const id = (ids.at(-1) ?? 0) + 1;
  fs.writeFileSync(path.join(dir, `${id}.log`), `$ ${command}\n${output}`);
  for (const old of ids.slice(0, Math.max(0, ids.length + 1 - KEEP_RUNS))) fs.rmSync(path.join(dir, `${old}.log`), { force: true });
  return id;
}

// savingsRoot: where the savings meter lives (the project), when running inside a sub-folder.
export function run(root, command, budget = 150, { record = true, savingsRoot = root } = {}) {
  const started = Date.now();
  const r = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
  const output = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\n${r.error.message}` : '');
  const code = r.status ?? 1;
  const id = saveLog(root, command, output);
  const lineCount = output.split('\n').length;
  const head = `${code === 0 ? 'ok' : 'FAIL'} exit ${code} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${lineCount} lines (~${tokens(output)} tokens) → full log: city run --log ${id}`;
  const body = summarize(output, code, Math.max(budget - tokens(head), 30));
  const text = body ? `${head}\n${body}` : head;
  if (record) {
    addSaving(savingsRoot, 'trimmed output', tokens(output), tokens(text));
    remember(savingsRoot, command, code, body);
  }
  return { code, id, output, text };
}

// Last result (for the blink's IN PROGRESS line) and failures that later got fixed (for lessons).
function remember(root, command, code, body) {
  const dir = path.join(root, '.city');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
  const failing = body.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5).replace(/ @ .*/, ''));
  const fails = read('fails.json', {});
  const fixed = read('fixed.json', []);
  if (code === 0 && fails[command]?.length) fixed.push({ command, was: fails[command].slice(0, 3), at: new Date().toISOString() });
  if (code === 0) delete fails[command];
  else fails[command] = failing.length ? failing : [`"${command.slice(0, 40)}" failing`]; // not a test run: name the command
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lastrun.json'), JSON.stringify({ command, code, first: body.split('\n').slice(0, 2).join(' · '), at: Date.now() }));
    fs.writeFileSync(path.join(dir, 'fails.json'), JSON.stringify(fails));
    fs.writeFileSync(path.join(dir, 'fixed.json'), JSON.stringify(fixed.slice(-10)));
  } catch { /* never get in the way */ }
}

export function readLog(root, id, words = [], budget = 200) {
  const file = path.join(runsDir(root), `${id}.log`);
  if (!fs.existsSync(file)) return `No saved run ${id}.`;
  const lines = fs.readFileSync(file, 'utf8').replace(ANSI, '').split('\n');
  const want = words.map((w) => w.toLowerCase());
  const picked = want.length
    ? lines.map((l, i) => [i + 1, l]).filter(([, l]) => want.some((w) => l.toLowerCase().includes(w)))
    : lines.map((l, i) => [i + 1, l]).slice(-20);
  const out = new Out(budget);
  for (const [n, l] of picked) if (!out.add(`${n}: ${l}`)) { out.lines.push(`… more (${picked.length} matching lines)`); break; }
  return out.lines.join('\n') || 'No matching lines.';
}

export function main(argv) {
  const b = argv.indexOf('--budget');
  const budget = b >= 0 ? Number(argv.splice(b, 2)[1]) || 150 : 150;
  if (argv[0] === '--log') {
    console.log(readLog(process.cwd(), argv[1], argv.slice(2), budget));
    return;
  }
  if (!argv.length) {
    console.log('Usage: city run <command …> | city run --log N [words]  [--budget N]');
    process.exitCode = 1;
  }
  const { code, text } = run(process.cwd(), argv.join(' '), budget, { savingsRoot: process.env.TALENSCAPE_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd() });
  console.log(text);
  process.exitCode = code; // not process.exit(): that can cut off piped output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
