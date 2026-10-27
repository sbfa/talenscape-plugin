#!/usr/bin/env node
// Claude Code "before a tool runs" hook (a safety net that saves tokens):
// - Read: a full read of a big file first gets a short outline (what is on which lines), so the
//   AI reads just the part it needs.
// - Bash: a command known to print a lot (tests, installs, builds, long git logs) is rewritten to
//   run through the trimmer, which returns only what matters (full log saved).
// Repeating a big read is allowed, so nothing is ever blocked for good. Small files, partial
// reads, files outside the project and quiet or piped commands pass straight through.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { addSaving } from './lib/savings.mjs';
import { guard, deepDive } from './guard.mjs';
import { fromHook } from './lib/tools.mjs';

export const BIG_LINES = 250;
export const BIG_BYTES = 12_000;
const OUTLINE_BUDGET = 220; // tokens
const RUN_TOOL = fileURLToPath(new URL('run.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('cli.mjs', import.meta.url));
// Commands that usually flood the output. Already-piped/redirected commands are left alone.
const NOISY = /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:test|t|ci|install|i|add|run(?:\s+-s)?\s+(?:test|build|lint|bench|check)\b)|npx\s+(?:vitest|jest|tsc|eslint|playwright|mocha)\b|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest|pip\s+install)\b|pytest\b|pip3?\s+install\b|cargo\s+(?:build|test|check)\b|go\s+(?:build|test|vet)\b|make\b|gradle\b|mvn\b|tsc\b|git\s+log\b(?!.*(?:\s-n\s*\d|\s-\d|--max-count)))/;
const PASS_THROUGH = /\.(png|jpe?g|gif|webp|svg|ico|pdf|ipynb)$/i;
import { tokens } from './lib/tokens.mjs';

// What's on which lines: classes, functions and methods for code; headings for Markdown.
export async function outline(root, rel, text, budget = OUTLINE_BUDGET) {
  const items = [];
  if (/\.(md|markdown|rst)$/i.test(rel)) {
    text.split('\n').forEach((l, i) => {
      const m = l.match(/^(#{1,3})\s+(.*)/);
      if (m) items.push(`${'#'.repeat(m[1].length)} ${m[2].trim()} :${i + 1}`);
    });
  } else {
    try {
      const { buildIndex } = await import('./lib/indexer.mjs');
      const { openDb } = await import('./lib/db.mjs');
      await buildIndex(root); // only changed files are re-read
      const db = openDb(root);
      const rows = db.prepare(`SELECT n.kind, n.qname, n.start_line, n.end_line, p.kind AS pk FROM graph_nodes n
        JOIN graph_nodes p ON p.id = n.parent WHERE n.path = ? AND n.kind != 'file' AND (p.kind IN ('file', 'class'))
        ORDER BY n.start_line`).all(rel);
      db.close();
      for (const r of rows) {
        const lines = r.end_line > r.start_line ? `${r.start_line}-${r.end_line}` : `${r.start_line}`;
        // Members of a class are written ".name" right after it, so the class name isn't repeated.
        const name = r.pk === 'class' ? '.' + r.qname.split('.').pop() : r.qname;
        items.push(`${r.kind === 'class' ? 'cls ' : r.kind === 'skill' ? 'skill ' : ''}${name} ${lines}`);
      }
    } catch { /* no map available: the size note alone still helps */ }
  }
  let left = budget * 3.5;
  const kept = [];
  for (const it of items) {
    if (it.length + 3 > left) { kept.push(`… +${items.length - kept.length} more`); break; }
    kept.push(it);
    left -= it.length + 3;
  }
  return kept.join(' · ');
}

function memoryFile(root) {
  return path.join(root, '.city', 'steer.json');
}

// Remembers a nudge; returns true if this exact call was already nudged (so it goes through now).
function secondTry(root, key) {
  let memory = {};
  try { memory = JSON.parse(fs.readFileSync(memoryFile(root), 'utf8')); } catch { /* first use */ }
  const again = Boolean(memory[key]);
  if (again) delete memory[key];
  else {
    memory = Object.fromEntries(Object.entries(memory).slice(-50));
    memory[key] = Date.now();
  }
  fs.mkdirSync(path.dirname(memoryFile(root)), { recursive: true });
  fs.writeFileSync(memoryFile(root), JSON.stringify(memory));
  return again;
}

// Decide what to do with one tool call: null lets it through, a string is shown instead of
// running it, { updatedInput } runs a rewritten call, { ask } needs the owner's confirmation,
// { context } lets it run with a note to the AI.
export async function steer(root, input, { record = true } = {}) {
  // Safety first: risky actions get a snapshot and a deep dive; can't-be-undone ones go to the owner.
  const safety = await guard(root, input).catch(() => null);
  if (safety) return safety;
  if (deepDive(root)) return null; // during a deep dive, nothing is trimmed or outlined
  if (input?.tool_name === 'Bash') return steerBash(root, input.tool_input ?? {});
  if (input?.tool_name !== 'Read') return null;
  const ti = input.tool_input ?? {};
  if (!ti.file_path || ti.offset !== undefined || ti.limit !== undefined || PASS_THROUGH.test(ti.file_path)) return null;
  const full = path.resolve(root, ti.file_path);
  const rel = path.relative(root, full).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let st;
  try { st = fs.statSync(full); } catch { return null; }
  if (!st.isFile()) return null;
  const text = fs.readFileSync(full, 'utf8');
  const lineCount = text.split('\n').length;
  if (lineCount <= BIG_LINES && st.size <= BIG_BYTES) return null;

  // Second try at the same full read (file unchanged): the AI really needs it, so allow it.
  if (secondTry(root, `${rel}@${st.mtimeMs}`)) return null;

  const map = await outline(root, rel, text);
  const message = `Talenscape: ${rel} is big (${lineCount} lines, ~${tokens(text).toLocaleString('en-US')} tokens). ` +
    `Read only the part you need (a line range, or \`city snip <name>\`).` +
    (map ? `\nOutline: ${map}` : '') +
    `\nIf you truly need all of it, repeat the same Read and it will be allowed.`;
  if (record) addSaving(root, 'outlines', tokens(text), tokens(message));
  return message;
}

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Rewrites a noisy command to run through the trimmer, in the same turn. Claude Code still applies
// its normal permission rules to the rewritten command. Raw output stays available (run --log N).
function steerBash(root, toolInput) {
  let command = toolInput.command ?? '';
  if (command.includes('run.mjs')) return null;
  // Pushing work: first bring the context other AIs read up to date, in the same push (only in
  // projects that share it; a failure never stops the push).
  let pushed = false;
  if (/\bgit\s+push\b/.test(command) && !command.includes(' context --commit') && fs.existsSync(path.join(root, '.city', 'BLINK.md'))) {
    // After the push, the small AI copy goes up too (see lib/aicopy.mjs); the push's own result is kept.
    command = `TALENSCAPE_ROOT=${shellQuote(root)} node --no-warnings ${shellQuote(CLI)} context --commit >/dev/null 2>&1; ${command}`
      + `; ts_s=$?; TALENSCAPE_ROOT=${shellQuote(root)} node --no-warnings ${shellQuote(CLI)} context --push-ai >/dev/null 2>&1; (exit $ts_s)`;
    pushed = true;
  }
  // Only the noisy steps of a multi-step command are wrapped, so the other steps' output still
  // shows. A step that is already piped or redirected is left alone.
  let changed = false;
  const rewritten = command.split(/(\n|&&|\|\||;)/).map((part) => {
    const step = part.trim();
    if (!step || !NOISY.test(step) || /[|>]/.test(step)) return part;
    changed = true;
    return part.replace(step, `TALENSCAPE_ROOT=${shellQuote(root)} node --no-warnings ${shellQuote(RUN_TOOL)} ${shellQuote(step)}`);
  }).join('');
  return changed || pushed ? { updatedInput: { ...toolInput, command: rewritten } } : null;
}

export async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { return; } // never get in the way on bad input
  const hook = fromHook(input); // Claude Code or Grok Build: same hook, different names
  input = hook.input;
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const result = await steer(root, input).catch(() => null);
  if (!result) return;
  if (result.updatedInput) result.updatedInput = hook.back(result.updatedInput);
  const out = typeof result === 'string' ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result }
    : result.ask ? { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: result.ask }
      : result.context ? { hookEventName: 'PreToolUse', additionalContext: result.context }
        : { hookEventName: 'PreToolUse', updatedInput: result.updatedInput };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
