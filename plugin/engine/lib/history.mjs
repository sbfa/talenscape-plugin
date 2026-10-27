// What git history knows that the code doesn't: files that change together (hidden coupling with no
// import between them), when each file last changed, and which files are the project's entry points.
// Read with plain git, cached per commit, no AI involved.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_COMMITS = 400;   // how far back to look
const BULK = 20;           // commits touching more files than this are bulk changes (renames, formatting): skipped
const MIN_TOGETHER = 2;    // a pair must change together at least this often
const MIN_JACCARD = 0.3;   // together / min(changes of A, changes of B)
const PER_FILE = 6;        // keep each file's strongest partners only
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|HANDOFF\.md|CHANGELOG\.md|HISTORY\.md)$|^\.city\//;

const git = (root, args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch { return null; } };

// Commits newest first: [{ time, files }], cached in .city/history.json for the current HEAD.
export function commits(root) {
  const head = git(root, ['rev-parse', 'HEAD'])?.trim();
  if (!head) return [];
  const cache = path.join(root, '.city', 'history.json');
  try { const c = JSON.parse(fs.readFileSync(cache, 'utf8')); if (c.head === head) return c.commits; } catch { /* rebuild */ }
  const log = git(root, ['log', '--no-merges', `-n${MAX_COMMITS}`, '--format=@%ct', '--name-only']) ?? '';
  const list = log.split('@').filter(Boolean).map((block) => {
    const [time, ...files] = block.trim().split('\n').filter(Boolean);
    return { time: Number(time), files: files.filter((f) => !NOISE.test(f)) };
  }).filter((c) => c.files.length);
  try { fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, JSON.stringify({ head, commits: list })); } catch { /* cache is optional */ }
  return list;
}

// Pairs of files that change together: [{ a, b, together, jaccard }], strongest first.
export function coChange(list, known = null) {
  const changes = new Map(), pairs = new Map();
  for (const c of list) {
    const files = [...new Set(c.files)].filter((f) => !known || known.has(f));
    if (files.length < 2 || files.length > BULK) { for (const f of files) changes.set(f, (changes.get(f) ?? 0) + 1); continue; }
    for (const f of files) changes.set(f, (changes.get(f) ?? 0) + 1);
    files.sort();
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
      const k = files[i] + '\0' + files[j];
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  const out = [];
  for (const [k, together] of pairs) {
    if (together < MIN_TOGETHER) continue;
    const [a, b] = k.split('\0');
    const jaccard = together / Math.min(changes.get(a), changes.get(b));
    if (jaccard >= MIN_JACCARD) out.push({ a, b, together, jaccard: Math.round(jaccard * 100) / 100 });
  }
  out.sort((x, y) => y.together - x.together || y.jaccard - x.jaccard || (x.a + x.b).localeCompare(y.a + y.b));
  const count = new Map(), kept = [];
  for (const p of out) {
    if ((count.get(p.a) ?? 0) >= PER_FILE && (count.get(p.b) ?? 0) >= PER_FILE) continue;
    count.set(p.a, (count.get(p.a) ?? 0) + 1); count.set(p.b, (count.get(p.b) ?? 0) + 1);
    kept.push(p);
  }
  return kept;
}

// When each file last changed (unix seconds), from the commits above.
export function lastChanged(list) {
  const at = new Map();
  for (const c of list) for (const f of c.files) if (!at.has(f)) at.set(f, c.time);
  return at;
}

export const age = (t, now = Date.now() / 1000) => {
  const d = (now - t) / 86400;
  return d < 1 ? 'today' : d < 60 ? `${Math.round(d)}d ago` : d < 730 ? `${Math.round(d / 30)}mo ago` : `${Math.round(d / 365)}y ago`;
};
