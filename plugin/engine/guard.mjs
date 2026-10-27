// Failsafe: spots risky and can't-be-undone actions before they run, takes a snapshot first,
// and can roll the project back.
//
//   city checkpoint ["why"]     snapshot the whole project now (unsaved work included)
//   city checkpoints            list snapshots
//   city rollback [id]          put the project back to a snapshot (the latest by default);
//                               takes a snapshot of the current state first, so it can be undone
//
// Snapshots are git commits kept under refs/talenscape/ (outside any branch), so they never
// change your branches, history or staged files. Files git ignores (e.g. secrets) and
// Talenscape's own .city/ folder are left alone.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = 30;
const DEEP_DIVE_MINUTES = 15;

function git(root, args, env = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trimEnd();
}
const tryGit = (root, args, env) => { try { return git(root, args, env); } catch { return null; } };
const listFile = (root) => path.join(root, '.city', 'checkpoints.json');

export function listCheckpoints(root) {
  try { return JSON.parse(fs.readFileSync(listFile(root), 'utf8')); } catch { return []; }
}

// A tree of every file in the working folder that git doesn't ignore, built in a throwaway index.
function snapshotTree(root) {
  const index = path.join(os.tmpdir(), `talenscape-index-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    if (tryGit(root, ['rev-parse', '--verify', 'HEAD'])) git(root, ['read-tree', 'HEAD'], env);
    git(root, ['add', '-A'], env);
    // Talenscape's own folder (notes, the snapshot list) is never part of a snapshot, so a
    // rollback can't lose notes or forget newer snapshots.
    git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.city'], env);
    return git(root, ['write-tree'], env);
  } finally {
    fs.rmSync(index, { force: true });
  }
}

export function checkpoint(root, reason = 'manual') {
  if (tryGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const tree = snapshotTree(root);
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD']);
  const branch = tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const args = ['commit-tree', tree, '-m', `talenscape checkpoint: ${reason}`];
  if (head) args.push('-p', head);
  const commit = git(root, args, { GIT_AUTHOR_NAME: 'Talenscape', GIT_AUTHOR_EMAIL: 'checkpoint@talenscape.local', GIT_COMMITTER_NAME: 'Talenscape', GIT_COMMITTER_EMAIL: 'checkpoint@talenscape.local' });
  const list = listCheckpoints(root);
  const id = (list.at(-1)?.id ?? 0) + 1;
  git(root, ['update-ref', `refs/talenscape/checkpoints/${id}`, commit]);
  list.push({ id, commit, tree, head, branch, reason: reason.slice(0, 120), at: new Date().toISOString() });
  for (const old of list.splice(0, Math.max(0, list.length - KEEP))) tryGit(root, ['update-ref', '-d', `refs/talenscape/checkpoints/${old.id}`]);
  fs.mkdirSync(path.dirname(listFile(root)), { recursive: true });
  fs.writeFileSync(listFile(root), JSON.stringify(list, null, 1));
  return list.at(-1);
}

export function rollback(root, id) {
  const list = listCheckpoints(root);
  const target = id ? list.find((c) => c.id === Number(id)) : list.at(-1);
  if (!target) return { ok: false, text: id ? `No checkpoint ${id}.` : 'No checkpoints yet.' };
  const safety = checkpoint(root, `before rollback to #${target.id}`);
  const index = path.join(os.tmpdir(), `talenscape-index-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    // Load the current files, then switch to the snapshot: files that didn't exist then are
    // removed, changed or deleted files come back.
    git(root, ['read-tree', safety.tree], env);
    git(root, ['read-tree', '-u', '--reset', target.tree], env);
  } finally {
    fs.rmSync(index, { force: true });
  }
  // Put the branch back where it was, if history was changed after the snapshot.
  if (target.branch && tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']) !== target.branch) {
    tryGit(root, ['symbolic-ref', 'HEAD', `refs/heads/${target.branch}`]);
  }
  if (target.head && tryGit(root, ['rev-parse', '--verify', 'HEAD']) !== target.head) git(root, ['reset', '-q', '--soft', target.head]);
  if (target.head) git(root, ['reset', '-q']); // staged list matches the branch again; changes stay as unsaved work
  return { ok: true, text: `Rolled back to checkpoint #${target.id} (${target.reason}, ${target.at.slice(0, 16).replace('T', ' ')}). Undo with: city rollback ${safety.id}` };
}

// ---------- spotting danger ----------

// Actions that leave the project: no snapshot can bring them back, so the owner must confirm.
const IRREVERSIBLE = [
  [/\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--delete\b|\s:\S)/, 'force-push or delete on the remote (rewrites shared history)'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdocker\s+push\b/, 'publishes a package (public)'],
  [/\bwrangler\s+(deploy|publish|pages\s+deploy|secret\s+put|r2\s+object\s+(put|delete))\b|\bwrangler\s+d1\s+(execute|migrations\s+apply)\b.*--remote\b/, 'changes the live Cloudflare site or online data'],
  [/\bgh\s+repo\s+(edit\b.*--visibility|delete|create)\b|\bgh\s+release\s+create\b/, 'changes the GitHub repository settings or publishes a release'],
  [/\bcurl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data|--data-\w+|-F|--form)\s)|\bwget\b.*--post/, 'sends data to an outside service'],
  [/\b(scp|sftp)\s|\brsync\b.*\S+:\S*/, 'copies files to another machine'],
  [/\bdeploy\/cloudflare\.mjs\s+(lock|site|domain|db|passkeys\s+--reset)\b/, 'changes the live Cloudflare site, login lock or online data'],
];

// Actions that can destroy work in the project: snapshot first, then look closely.
const RISKY = [
  [/\brm\s+(-\w*[rRf]\w*\s+)+|\brm\s+.*[*?]/, 'deletes files'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+(--\s+)?\.|restore\s+(\S+\s+)*\.|rebase\b|commit\s+--amend|branch\s+-D|stash\s+(drop|clear)|filter-branch|filter-repo)/, 'changes or discards saved history or unsaved work'],
  [/\bfind\b.*\s-delete\b|\bxargs\b.*\brm\b/, 'deletes many files'],
  [/\bsed\s+-i\b.*(\*|\$\(|`)|\bfind\b.*-exec\s+sed\s+-i/, 'edits many files at once'],
  [/\b(chmod|chown)\s+-R\b|\bdd\s+if=|\bmkfs\b|\btruncate\s+-s/, 'changes permissions or wipes data'],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b/i, 'deletes database data'],
];

const CORE_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|schema\.sql|settings\.json|hooks\.json|plugin\.json|marketplace\.json|wrangler\.toml|\.gitignore)$|(^|\/)(migrations|\.github)\//;
const MANY_DEPENDENTS = 15;
const BIG_DELETE_LINES = 40;

// How many other files depend on this one. A plain read of the map, without refreshing it:
// this runs before every edit and must stay quick.
async function dependentsOf(root, rel) {
  if (!fs.existsSync(path.join(root, '.city', 'city.db'))) return 0;
  try {
    const { openDb } = await import('./lib/db.mjs');
    const db = openDb(root);
    try {
      return db.prepare(`SELECT count(DISTINCT s.path) AS n FROM graph_edges e JOIN graph_nodes d ON d.id = e.dst
        JOIN graph_nodes s ON s.id = e.src WHERE d.path = ? AND s.path != d.path AND e.kind != 'mentions'`).get(rel).n;
    } finally { db.close(); }
  } catch { return 0; }
}

// Returns { level: 'normal' | 'risky' | 'irreversible', reason }.
export async function classify(root, input) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  if (tool === 'Bash') {
    // A commit message only describes work; its words ("reset --hard", "rm -rf"…) aren't commands.
    // Nor is a script handed to python/node/ruby/perl, or text written to a file with cat/tee.
    const cmd = (ti.command ?? '')
      .replace(/(\bgit\s+commit\b[^\n]*?\s-m\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1""')
      .replace(/(\b(?:python3?|node|ruby|perl|cat|tee)\b[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*\n)[\s\S]*?\n\2(?=\n|$)/g, '$1');
    for (const [re, why] of IRREVERSIBLE) if (re.test(cmd)) return { level: 'irreversible', reason: why };
    for (const [re, why] of RISKY) if (re.test(cmd)) return { level: 'risky', reason: why };
    const mv = cmd.match(/\bmv\s+(?:-\w+\s+)*(\S+)\s+\S+/);
    if (mv && fs.existsSync(path.resolve(root, mv[1])) && fs.statSync(path.resolve(root, mv[1])).isDirectory()) return { level: 'risky', reason: 'moves a whole folder' };
    return { level: 'normal' };
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && ti.file_path) {
    const full = path.resolve(root, ti.file_path);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (rel.startsWith('..')) return { level: 'normal' };
    if (CORE_FILE.test(rel) && fs.existsSync(full)) return { level: 'risky', reason: `changes a core file (${rel})` };
    const removed = tool === 'Edit' ? (ti.old_string ?? '').split('\n').length - (ti.new_string ?? '').split('\n').length
      : tool === 'MultiEdit' ? (ti.edits ?? []).reduce((n, e) => n + (e.old_string ?? '').split('\n').length - (e.new_string ?? '').split('\n').length, 0)
        : tool === 'Write' && fs.existsSync(full) ? fs.readFileSync(full, 'utf8').split('\n').length - (ti.content ?? '').split('\n').length : 0;
    if (removed >= BIG_DELETE_LINES) return { level: 'risky', reason: `removes ${removed} lines from ${rel}` };
    const n = await dependentsOf(root, rel);
    if (n >= MANY_DEPENDENTS) return { level: 'risky', reason: `${n} other files depend on ${rel}` };
  }
  return { level: 'normal' };
}

// ---------- deep-dive mode: while active, savings step aside ----------

const deepFile = (root) => path.join(root, '.city', 'deepdive.json');

export function startDeepDive(root, reason) {
  fs.mkdirSync(path.dirname(deepFile(root)), { recursive: true });
  fs.writeFileSync(deepFile(root), JSON.stringify({ until: Date.now() + DEEP_DIVE_MINUTES * 60_000, reason }));
}

export function deepDive(root) {
  try {
    const d = JSON.parse(fs.readFileSync(deepFile(root), 'utf8'));
    return d.until > Date.now() ? d : null;
  } catch { return null; }
}

// Called by the safety-net hook before every action. Returns null, or what the hook should say.
export async function guard(root, input) {
  // A decision only the owner can make holds the actions it names until it is answered.
  if (input?.tool_name === 'Bash') {
    const { readState } = await import('./session.mjs');
    const { gatedBy } = await import('./lib/manifest.mjs');
    const q = gatedBy(readState(root), input.tool_input?.command ?? '');
    if (q) return { ask: `Talenscape: this waits on an owner decision: "${q.question}". Ask the owner first (city wrapup --answered N once decided).` };
  }
  const c = await classify(root, input);
  if (c.level === 'irreversible') {
    return { ask: `Talenscape failsafe: this ${c.reason}. It can't be rolled back, so the owner must confirm it.` };
  }
  if (c.level === 'risky') {
    let cp = null;
    try { cp = checkpoint(root, c.reason); } catch { /* still warn */ }
    startDeepDive(root, c.reason);
    return {
      context: `Talenscape failsafe: this ${c.reason}. ` +
        (cp ? `Snapshot #${cp.id} taken (undo: city rollback ${cp.id}). ` : 'No snapshot possible (not a git project). ') +
        `Deep-dive mode for ${DEEP_DIVE_MINUTES} min: full reads and full output, no trimming. Check what depends on it ` +
        '(city impact <name>), read the affected code fully, run the full tests afterwards, and city check before calling it done.',
    };
  }
  return null;
}

export function main([cmd, ...rest]) {
  const root = process.cwd();
  if (cmd === 'checkpoint') {
    const cp = checkpoint(root, rest.join(' ') || 'manual');
    console.log(cp ? `Checkpoint #${cp.id} saved (undo later with: city rollback ${cp.id}).` : 'Not a git project: checkpoints need git.');
  } else if (cmd === 'checkpoints') {
    const list = listCheckpoints(root);
    console.log(list.length ? list.slice(-10).map((c) => `#${c.id} ${c.at.slice(0, 16).replace('T', ' ')} ${c.reason}`).join('\n') : 'No checkpoints yet.');
  } else if (cmd === 'rollback') {
    const r = rollback(root, rest[0]);
    console.log(r.text);
    process.exitCode = r.ok ? 0 : 1;
  }
}
