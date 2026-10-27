// Blink Manifest V2: the pieces of the session summary beyond the basics, and the rule for squeezing
// it into its budget. All local, no AI involved.
//
//   attempts        approaches that failed, so no session pays for them twice
//   questions       decisions only the owner can make (they block named actions until answered)
//   freshness       how sure each "where we are" line is: verified / reported / inferred / stale
//   git             branch, head, unsaved count
//   symbols         functions and classes changed last session (the blast radius to look at first)
//   hot             1-3 file:line pointers most likely needed next
//   env             the non-secret runtime contract (which environment, mock or real services, auth)
//   skills delta    skills added or removed since the last wrap-up
//
// Compression: when the summary is over budget, a fixed order decides what goes (see compress()).

import { execFileSync } from 'node:child_process';

export const REASON_MAX = 140;
export const STALE_HOURS = 72;

const git = (root, ...args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd(); } catch { return null; } };
// Shorten at a natural break (between list items, then between words), never mid-word.
const clip = (s, n) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const item = Math.max(...[' · ', '; ', ', ', ' | ', ' — ', ' or '].map((b) => cut.lastIndexOf(b)));
  const at = item >= n * 0.55 ? item : cut.lastIndexOf(' ') >= n * 0.55 ? cut.lastIndexOf(' ') : n - 1;
  return s.slice(0, at).replace(/[\s,;·|—-]+$/, '') + '…';
};

// ---------- attempts ----------

// "approach | why it failed | retry?" where retry? is no, yes, or "when <condition>".
export function parseAttempt(text, at = new Date().toISOString()) {
  const [approach, reason = '', retry = 'no'] = String(text).split('|').map((s) => s.trim());
  const cond = retry.match(/^(?:when|if|conditional:?)\s+(.+)/i);
  return {
    approach: clip(approach, 120), reason: clip(reason, REASON_MAX),
    retryable: cond ? 'conditional' : /^(yes|true)$/i.test(retry) ? 'true' : 'false',
    ...(cond ? { retry_condition: clip(cond[1], 100) } : {}), at,
  };
}
const attemptLine = (a, short) => `${a.approach}${short ? '' : `: ${a.reason}`}${a.retryable === 'conditional' ? ` (retry only when ${a.retry_condition})` : a.retryable === 'true' ? ' (may retry)' : ''}`;

// ---------- questions only the owner can answer ----------

// "question? [option a / option b] {blocks: deploy/cloudflare.mjs site; npm publish}"
export function parseQuestion(text, at = new Date().toISOString()) {
  if (typeof text === 'object' && text) return text;
  let q = String(text);
  const blocks = q.match(/\{blocks?:\s*([^}]*)\}/i)?.[1].split(';').map((s) => s.trim()).filter(Boolean) ?? [];
  q = q.replace(/\{blocks?:[^}]*\}/i, '').trim();
  const options = q.match(/\[([^\]]+)\]\s*$/)?.[1].split('/').map((s) => s.trim()).filter(Boolean) ?? [];
  q = q.replace(/\[[^\]]+\]\s*$/, '').trim();
  return { question: q, ...(options.length ? { options } : { open_ended: true }), raised_at: at, blocks };
}
export const questionsOf = (st) => (st.questions ?? []).map((q) => parseQuestion(q, st.wrappedAt));

// The owner's open decision that a command would jump ahead of, if any.
export function gatedBy(st, command) {
  for (const q of questionsOf(st)) for (const b of q.blocks ?? []) if (b && command.includes(b)) return q;
  return null;
}

// ---------- freshness ----------

// verified: tests passed at wrap-up and nothing changed since; reported: said at wrap-up but not
// checked; inferred: worked out by the tool; stale: too old, or commits were made since.
export function freshness(st, { commitsSince = 0, now = Date.now() } = {}) {
  const at = st.wrappedAt ? Date.parse(st.wrappedAt) : null;
  const hours = at ? (now - at) / 3_600_000 : Infinity;
  const passed = /\bok\b/.test(st.verified ?? '');
  // Any commit after the wrap-up means the notes describe an older state of the project.
  const status = !at ? 'reported' : hours > (st.ttlHours ?? STALE_HOURS) || commitsSince > 0 ? 'stale' : passed ? 'verified' : 'reported';
  const age = !at ? '' : hours < 1 ? 'just now' : hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
  return { status, age, updated_at: st.wrappedAt ?? null, verified_at: passed ? st.verifiedAt ?? st.wrappedAt ?? null : null };
}

// ---------- git, symbols, hot pointers ----------

export function gitContext(root, dirtyCount) {
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  const head = git(root, 'rev-parse', '--short', 'HEAD');
  return branch ? { branch, head_sha: head, dirty_files_count: dirtyCount } : null;
}

// Functions/classes whose lines changed between two commits, most important first.
export function symbolsChanged(root, db, from, to = 'HEAD', limit = 8) {
  if (!from) return [];
  const diff = git(root, 'diff', '-U0', '--no-color', `${from}..${to}`, '--', '.', ':(exclude).city', ':(exclude)HANDOFF.md');
  if (!diff) return [];
  const touched = [];
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : null;
    const m = file && line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) touched.push({ file, start: +m[1], end: +m[1] + Math.max(0, (m[2] === undefined ? 1 : +m[2]) - 1) });
  }
  // The innermost function/class around each changed hunk; scored by how many changed lines it holds.
  const q = db.prepare(`SELECT qname, name, path, start_line, end_line, rank FROM graph_nodes WHERE path = ? AND kind IN ('function','method','class')
    AND start_line <= ? AND end_line >= ? ORDER BY (end_line - start_line) ASC`);
  const seen = new Map();
  for (const t of touched) {
    // Skip throwaway names (one or two letters, like $ or g) and pick the nearest meaningful one.
    const n = q.all(t.file, t.end, t.start).find((x) => x.name.length > 2 && x.qname.split('.').length <= 3);
    if (!n) continue;
    const k = n.qname + n.path, lines = Math.min(t.end, n.end_line) - Math.max(t.start, n.start_line) + 1;
    seen.set(k, { n, lines: (seen.get(k)?.lines ?? 0) + Math.max(1, lines) });
  }
  return [...seen.values()].sort((a, b) => b.lines - a.lines || b.n.rank - a.n.rank).slice(0, limit)
    .map(({ n }) => ({ name: n.qname, path: n.path, line: n.start_line }));
}

// ---------- skills ----------

export function skillsDelta(before = [], now = []) {
  const b = new Set(before), n = new Set(now);
  const added = now.filter((x) => !b.has(x)), removed = before.filter((x) => !n.has(x));
  return [...added.map((x) => `+${x}`), ...removed.map((x) => `-${x}`)].join(' ');
}

// ---------- compression: a fixed order, so the same state always gives the same summary ----------

// Each entry: { key, text, kind, short?, drop? }. kind decides its fate when over budget
// (drop: among extras, a higher number goes sooner):
//   extra (map key spots, skill names, savings) → shortened, then dropped, first of all
//   resolved                  → step 1: dropped (oldest first)
//   superseded                → step 2: dropped
//   done                      → step 3: summarized to one line (its `short`)
//   progress                  → step 4: summarized, current step kept (its `short`)
//   blocker                   → step 5: summarized (its `short`), never dropped
//   operator                  → last of all: summarized (questions clipped), never dropped
//   rule, frame               → never dropped; if these alone are over budget the report says so
export function compress(entries, budget, count) {
  const report = [], list = entries.filter((e) => e.text).map((e, i) => ({ ...e, at: i }));
  const size = () => count(list.map((e) => e.text).join('\n'));
  // Among extras, the least useful go first; the rest go from the bottom of the summary up.
  const order = (e) => -(e.drop ?? 0) * 1000 - e.at;
  const steps = [
    ['extra', 'shorten'], ['extra', 'drop'], ['resolved', 'drop'], ['superseded', 'drop'],
    ['done', 'shorten'], ['progress', 'shorten'], ['blocker', 'shorten'], ['operator', 'shorten'],
  ];
  const dropped = [];
  for (const [kind, how] of steps) {
    for (const e of list.filter((x) => x.kind === kind).sort((a, b) => order(a) - order(b))) {
      if (size() <= budget) break;
      if (how === 'drop') { list.splice(list.indexOf(e), 1); dropped.push(e); report.push(`dropped ${e.key}`); }
      else if (e.short && e.short !== e.text) { e.text = e.short; report.push(`shortened ${e.key}`); }
    }
  }
  // Room left after the later steps: bring dropped extras back, short form, most useful first.
  for (const e of dropped.sort((a, b) => order(b) - order(a))) {
    const back = { ...e, text: e.short ?? e.text };
    list.splice(list.findIndex((x) => x.at > e.at) >>> 0, 0, back);
    if (size() > budget) list.splice(list.indexOf(back), 1);
    else report.push(`kept ${e.key} (short)`);
  }
  list.sort((a, b) => a.at - b.at);
  const over = size() > budget;
  if (over) report.push(`OVER BUDGET: ${size()} > ${budget} tokens even with only rules, owner decisions and blockers left`);
  return { text: list.map((e) => e.text).join('\n'), report, over };
}

export { attemptLine, clip };
