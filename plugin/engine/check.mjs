// `city check`: one line answering "is this ready to call done?" Runs the tests (and Talenscape's
// own scoreboard when present), checks the blink size and looks for unsaved work.

import fs from 'node:fs';
import path from 'node:path';
import { run } from './run.mjs';
import { blink, unsaved } from './session.mjs';
import { tokens } from './lib/tokens.mjs';

const BLINK_LIMIT = 400;

export async function check(root, { bench = true } = {}) {
  const parts = [];
  let ready = true;
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* not a node project */ }
  if (pkg?.scripts?.test) {
    const r = run(root, 'npm test', 80);
    const lines = r.text.split('\n').slice(1);
    parts.push(r.code === 0 ? (lines[0] ?? 'tests ok') : `tests FAIL: ${lines.slice(0, 2).join(' ')}`);
    ready &&= r.code === 0;
  } else if (fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'tests'))) {
    parts.push('tests: not run (no npm test script; run them with city run …)');
  } else {
    parts.push('no tests found');
  }
  if (bench && fs.existsSync(path.join(root, 'bench', 'scoreboard.mjs'))) {
    const r = run(root, 'node --no-warnings bench/scoreboard.mjs', 40);
    parts.push(r.code === 0 ? 'scoreboard ok' : 'scoreboard FAIL (city run --log for details)');
    ready &&= r.code === 0;
  }
  const size = tokens(await blink(root, undefined, { nextSession: true }));
  parts.push(`blink ${size}/${BLINK_LIMIT}`);
  ready &&= size <= BLINK_LIMIT;
  const files = unsaved(root);
  if (files.length) {
    parts.push(`${files.length} unsaved (${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}): commit them`);
    ready = false;
  }
  return { ready, text: `${ready ? 'READY' : 'NOT READY'}: ${parts.join(' · ')}` };
}

export async function main(args) {
  const { ready, text } = await check(process.cwd(), { bench: !args.includes('--no-bench') });
  console.log(text);
  process.exitCode = ready ? 0 : 1;
}
