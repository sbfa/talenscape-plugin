#!/usr/bin/env node
// Claude Code "before a tool runs" hook (a safety net that saves tokens):
// - Read: a full read of a big file first gets a short outline (what is on which lines), so the
//   AI reads just the part it needs.
// - Bash: a command known to print a lot (tests, installs, builds, long git logs) is rewritten to
//   run through the trimmer, which returns only what matters (full log saved). Any other command's
//   output is capped: unchanged when short, start + errors + end when long (full log saved).
// - Search (grep, rg, git grep, or the Grep tool) reaching into the owner's other projects: answered
//   with the company catalog's best lines (`city catalog find`), which measured ~38% fewer tokens on
//   fresh questions than plain search; asked again, the search runs as typed.
// Repeating a big read is allowed, so nothing is ever blocked for good. Small files, partial
// reads, files outside the project and quiet or piped commands pass straight through.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { addSaving } from './lib/savings.mjs';
import { guard } from './guard.mjs';
import { fromHook } from './lib/tools.mjs';
import { sizeCheck } from './lib/fresh.mjs';
import * as catalog from './lib/catalog.mjs';

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
  // Safety first: risky actions get a snapshot; can't-be-undone ones go to the owner.
  const safety = await guard(root, input).catch(() => null);
  if (safety) return safety;
  if (input?.tool_name === 'Grep') return steerSearch(root, input.tool_input?.pattern, [input.tool_input?.path ?? root], `grep:${JSON.stringify(input.tool_input)}`);
  if (input?.tool_name === 'Bash') {
    const search = searchOf(input.tool_input?.command ?? '');
    if (search) {
      const answer = steerSearch(root, search.pattern, search.paths, `bash:${input.tool_input.command}`);
      if (answer) return answer;
    }
    return steerBash(root, input.tool_input ?? {});
  }
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

// A plain search command, as words: grep -r / rg / git grep with its pattern and paths. Only a single
// command (an optional `| head` after it is fine); anything more involved is left alone.
export function searchOf(command) {
  const first = command.split(/\|\s*head\b/)[0];
  if (/[;&|<>`$(]/.test(first)) return null;
  const words = first.match(/'[^']*'|"[^"]*"|\S+/g)?.map((w) => w.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  let i = 0;
  if (words[0] === 'git' && words[1] === 'grep') i = 2;
  else if (words[0] === 'grep' || words[0] === 'rg' || words[0] === 'egrep') i = 1;
  else return null;
  const VALUED = new Set(['-A', '-B', '-C', '-m', '--max-count', '-g', '--glob', '-t', '--type', '--include', '--exclude', '-f']);
  let pattern = null; const paths = [];
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '-e' || w === '--regexp') { pattern ??= words[++i]; continue; }
    if (VALUED.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    if (pattern === null) pattern = w; else paths.push(w);
  }
  return pattern ? { pattern, paths: paths.length ? paths : ['.'] } : null;
}

// Does this search reach into another of the owner's projects (or a folder holding several)? Then the
// catalog's best lines answer it first. A search inside this project alone goes through as typed.
function steerSearch(root, pattern, paths, key) {
  if (!pattern) return null;
  let cat;
  try { cat = catalog; } catch { return null; }
  const projects = cat.readProjects(root).map((p) => path.resolve(root, p.path)).filter((d) => path.resolve(d) !== path.resolve(root));
  if (!projects.length) return null;
  const inside = (a, b) => { const r = path.relative(b, a); return !r.startsWith('..') && !path.isAbsolute(r); };
  const reaches = paths.some((p) => { const full = path.resolve(root, p); return projects.some((d) => inside(full, d) || inside(d, full)); });
  if (!reaches) return null;
  const words = pattern.replace(/\\[a-z]/gi, ' ').split(/[^A-Za-z0-9$%@#._/:-]+/).filter(Boolean);
  if (!words.length) return null;
  if (secondTry(root, key)) return null;
  const { hits, more } = cat.find(root, words);
  if (!hits.length) return null; // nothing in the catalog's search: let the search run
  return `Talenscape: this searches your other projects. Best lines first (\`city catalog find ${words.join(' ')}\`):\n${hits.join('\n')}`
    + `${more ? `\n(${more} more lines: add a word to narrow it)` : ''}\nRead only the lines you need from these files. If you truly need the search as typed, run it again and it will go through.`;
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
  if (changed || pushed) return { updatedInput: { ...toolInput, command: rewritten } };
  // Any other command: its output goes through the cap (short output unchanged, long output shortened
  // with the full text saved). It still runs in the same shell, so cd and exported settings carry on.
  // Left alone: background runs, commands that end the shell, and the same command asked again
  // straight after (the AI needs all of it).
  if (!command.trim() || toolInput.run_in_background || /\bexit\b/.test(command) || /\\\s*$/.test(command)) return null;
  if (secondTry(root, `bash:${command}`)) return null;
  const label = shellQuote(command.replace(/\s+/g, ' ').slice(0, 120));
  return { updatedInput: { ...toolInput, command: `ts_f=$(mktemp); { ${command}\n} >"$ts_f" 2>&1; ts_s=$?; TALENSCAPE_ROOT=${shellQuote(root)} node --no-warnings ${shellQuote(RUN_TOOL)} --cap "$ts_f" ${label}; rm -f "$ts_f"; (exit $ts_s)` } };
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
  // Partway through a long job, the chat may pass the fresh-start limit: say so with this tool call.
  let fresh = null;
  try { fresh = sizeCheck(root, { transcriptPath: input.transcript_path, chat: input.session_id }); } catch { /* never in the way */ }
  if (!result && !fresh) return;
  if (result?.updatedInput) result.updatedInput = hook.back(result.updatedInput);
  const out = !result ? { hookEventName: 'PreToolUse' }
    : typeof result === 'string' ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result }
      : result.ask ? { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: result.ask }
        : result.context ? { hookEventName: 'PreToolUse', additionalContext: result.context }
          : { hookEventName: 'PreToolUse', updatedInput: result.updatedInput };
  if (fresh) out.additionalContext = [out.additionalContext, fresh].filter(Boolean).join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
