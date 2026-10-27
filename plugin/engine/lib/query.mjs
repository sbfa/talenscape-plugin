// Read-only questions against the graph + search index. Every answer has a hard token budget.
// Token counts are estimates (about 4 characters per token).

import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';
import { age } from './history.mjs';

export { tokens } from './tokens.mjs';
import { tokens } from './tokens.mjs';
const ABBR = { file: 'file', class: 'cls', function: 'fn', method: 'fn', skill: 'skill' };
const MAX_LINE = 160;

class Out {
  constructor(budget) { this.left = budget * 3.5; this.lines = []; }
  add(line) {
    if (line.length + 1 > this.left) return false;
    this.lines.push(line);
    this.left -= line.length + 1;
    return true;
  }
  toString() { return this.lines.join('\n'); }
}

const clip = (s) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) + '…' : s);
const loc = (n) => `${n.path}:${n.start_line}${n.end_line > n.start_line && n.kind !== 'file' ? '-' + n.end_line : ''}`;
const at = (n, line) => (n.kind === 'file' ? `file ${n.path}:${line}` : `${label(n)} ${n.path}:${line}`);
const label = (n) => `${ABBR[n.kind] ?? n.kind} ${n.kind === 'file' ? n.path : n.qname}`;
// Tests, examples and benchmarks rank lower unless the question is about them.
export const isSide = (p) => /(^|\/)(tests?|__tests__|spec|examples?|benchmarks?|test-?helpers?|fixtures?)\/|(^|\/)test_[^/]*$|\.(test|spec)\.[^/]+$/.test(p);
// Prose (docs, readmes, changelogs) ranks lower than code unless the question is about the docs.
export const isProse = (p) => /\.(md|mdx|rst|txt|adoc)$/i.test(p) || /(^|\/)docs?\//.test(p) || /(^|\/)(HISTORY|CHANGELOG|CHANGES|NEWS)(\.|$)/i.test(p);
const langCode = (p) => /\.(m|c)?[jt]sx?$|\.py$/.test(p);
const terms = (q) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? [])];
const STOP = new Set('a an and are as at be by can do does for from how i in is it of on or show tell that the this to was what when where which who why with'.split(' '));
// Crude word stem so "matched", "matches" and "matching" all find "match".
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);
// Words of a name: sendFile / send_file / SendFile → ["send", "file"].
const nameWords = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// The same word in another form: "confirm" / "confirmation", "color" / "colored". Only real word endings
// count ("string" / "stringify" are different words).
const ENDING = /^(ation|ations|ion|ions|ment|ments|ed|ing|ings|er|ers|s|es|al|ance|ence|ive|ly)$/;
const sameWord = (a, b) => {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short) && ENDING.test(long.slice(short.length));
};
const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;
// Programming words that name the same thing ("environment" / env). Local and fixed: no AI involved.
const SYNONYMS = [
  ['env', 'environment'], ['dict', 'dictionary', 'mapping'], ['serialize', 'serialise', 'dump'], ['deserialize', 'deserialise', 'load'],
  ['config', 'configuration', 'settings'], ['auth', 'authentication', 'login'], ['args', 'arguments', 'argv'], ['param', 'parameter', 'params'],
  ['err', 'error'], ['msg', 'message'], ['util', 'utility', 'helper'], ['init', 'initialize', 'initialise', 'setup'], ['repo', 'repository'],
  ['dir', 'directory', 'folder'], ['cmd', 'command'], ['opt', 'option'], ['str', 'string', 'text'], ['num', 'number'], ['req', 'request'],
  ['res', 'response', 'reply'], ['db', 'database'], ['simple', 'primitive', 'native', 'basic'], ['delete', 'remove'], ['create', 'make', 'new'],
  ['find', 'lookup', 'search', 'get'], ['check', 'validate', 'verify'], ['mistype', 'typo', 'similar'], ['alias', 'alternative', 'nickname'],
];
const SYN = new Map();
for (const group of SYNONYMS) for (const w of group) SYN.set(stem(w), group.map(stem).filter((x) => x !== stem(w)));
const synonymsOf = (stems) => [...new Set(stems.flatMap((w) => SYN.get(w) ?? []))].filter((x) => !stems.includes(x));
// Very common words in names ("function", "data", "value"): matching only these says little.
const GENERIC = new Set('function func class object obj data value val item items type types field fields name names list result results info base thing'.split(' '));
const TRIPLE = /("{3}|'{3})/;

function fileLines(root, rel, cache = new Map()) {
  if (!cache.has(rel)) {
    try { cache.set(rel, fs.readFileSync(path.join(root, rel), 'utf8').split('\n')); } catch { cache.set(rel, []); }
  }
  return cache.get(rel);
}

function ftsRows(db, words, limit, extra = []) {
  const run = (op, list = words) => db.prepare('SELECT path, start_line, body FROM snippet_fts WHERE snippet_fts MATCH ? ORDER BY bm25(snippet_fts) LIMIT ?')
    .all(list.map((w) => `"${w.replace(/"/g, '')}"*`).join(op), limit); // prefix match: "match" finds "matched"
  // Chunks with every word first, then the best chunks with some of them (best match first), so one
  // chunk that happens to hold all the words can't hide the one that answers the question.
  const rows = run(' AND ');
  if (words.length > 1 && rows.length < limit) {
    const have = new Set(rows.map((r) => r.path + ':' + r.start_line));
    for (const r of run(' OR ', [...words, ...extra])) if (rows.length < limit && !have.has(r.path + ':' + r.start_line)) rows.push(r);
  }
  return rows;
}

// Finds nodes for a name: exact symbol name, qualified name, or file path.
export function findNodes(db, name, limit = 5) {
  // "admin/app.js:formatDate" (or "admin:formatDate"): only that name in files whose path has that part.
  const scoped = String(name).match(/^(.+):([^/:]+)$/);
  if (scoped) {
    return db.prepare(`SELECT * FROM graph_nodes WHERE kind != 'file' AND (name = ?1 COLLATE NOCASE OR qname = ?1 COLLATE NOCASE)
      AND path LIKE '%' || ?2 || '%' ORDER BY rank DESC LIMIT ?3`).all(scoped[2], scoped[1], limit);
  }
  const rows = db.prepare(`SELECT * FROM graph_nodes WHERE (kind != 'file' AND (name = ?1 COLLATE NOCASE OR qname = ?1 COLLATE NOCASE))
    OR (kind = 'file' AND (path = ?1 OR path LIKE '%/' || ?1)) ORDER BY (kind = 'file'), rank DESC LIMIT ?2`).all(name, limit);
  return rows;
}

function neighbours(db, id, dir, limit) {
  const sql = dir === 'in'
    ? "SELECT e.kind AS ekind, e.line AS eline, n.* FROM graph_edges e JOIN graph_nodes n ON n.id = e.src WHERE e.dst = ? ORDER BY (e.kind = 'mentions'), n.rank DESC LIMIT ?"
    : "SELECT e.kind AS ekind, e.line AS eline, n.* FROM graph_edges e JOIN graph_nodes n ON n.id = e.dst WHERE e.src = ? ORDER BY (e.kind = 'mentions'), n.rank DESC LIMIT ?";
  return db.prepare(sql).all(id, limit);
}

// ---------- ask: the one-shot answer (where + connections + the lines that matter) ----------

// Long symbols collect scattered word hits just by being long; damp their text score gently
// (no change up to 60 lines; a 300-line class counts about 60% as much).
const lengthDamp = (n) => (n.kind === 'file' ? 1 : 1 + 0.35 * Math.log1p(Math.max(0, n.end_line - n.start_line + 1 - 60) / 60));

// Questions that ask for the code itself ("show …", "implementation of …") get the top hit's full body
// straight away, saving the follow-up call (query-type levels).
const WANTS_BODY = /^\s*(show( me)?( the)?|code (of|for)|implementation of|source (of|for)|body of)\b\s*/i;
export function ask(root, query, budget = 300) {
  const wantsBody = WANTS_BODY.test(query);
  if (wantsBody) query = query.replace(WANTS_BODY, '').replace(/\b(code|implementation|function|body)\b/gi, ' ');
  const db = openDb(root);
  try {
    const all = terms(query);
    const kept = all.filter((w) => !STOP.has(w));
    const words = kept.length ? kept : all;
    if (!words.length) return 'Nothing to look for.';
    const stems = words.map(stem);
    const syns = synonymsOf(stems); // other words for the same things, counted a little lower
    const cands = new Map();
    const bump = (node, score, line) => {
      const c = cands.get(node.id) ?? { node, name: 0, text: 0, lines: new Set() };
      if (line) { c.text += score; c.lines.add(line); } else c.name += score;
      cands.set(node.id, c);
    };

    // 1. Names: single words, neighbouring pairs and the whole query glued together
    //    ("send file" finds sendFile / send_file).
    const variants = new Map();
    words.forEach((w, i) => {
      if (i + 1 < words.length) { variants.set(w + words[i + 1], 2); variants.set(w + '_' + words[i + 1], 2); }
    });
    if (words.length > 2) { variants.set(words.join(''), words.length); variants.set(words.join('_'), words.length); }
    // Names containing a query word score by how many query words (filler words included)
    // their full name covers: "config from object" → Config.from_object.
    const allStems = new Set(all.map(stem));
    const like = db.prepare(`SELECT * FROM graph_nodes WHERE kind != 'file' AND name LIKE '%' || ? || '%' ORDER BY rank DESC LIMIT 40`);
    const seenLike = new Set();
    for (const x of syns) allStems.add(x);
    const inQuery = (x) => allStems.has(x) || [...allStems].some((q) => sameWord(q, x));
    for (const w of new Set([...stems, ...syns].flatMap((x) => (x.length > 6 ? [x, x.slice(0, 6)] : [x])))) {
      if (w.length < 3) continue;
      for (const n of like.all(w)) {
        if (seenLike.has(n.id)) continue;
        seenLike.add(n.id);
        const hit = [...new Set(nameWords(n.qname).filter((x) => !STOP.has(x)).map(stem).filter(inQuery))]; // filler words (is, get, of…) don't count
        // Generic words ("function", "data") count for less; a name made only of them hardly counts.
        const typed = (x) => stems.includes(x) || stems.some((q) => sameWord(q, x));
        const covered = hit.reduce((sum, x) => sum + (GENERIC.has(x) ? 0.3 : typed(x) ? 1 : 0.5), 0); // a synonym-only match counts half
        const ownAll = nameWords(n.name).map(stem).every(inQuery) && hit.some((x) => !GENERIC.has(x));
        // A name that is all query words is strong evidence when it covers much of the question;
        // one word out of five (a property called "name") is weak.
        if (covered > 1 || ownAll) bump(n, 5 * covered + (ownAll ? 5 * Math.min(1, 2 / words.length) : 0));
      }
    }
    const byName = db.prepare(`SELECT * FROM graph_nodes WHERE kind != 'file' AND name = ? COLLATE NOCASE ORDER BY rank DESC LIMIT 6`);
    // A one-word question that is exactly a name ("editDistance", "_run_validator") means that thing.
    if (all.length === 1) for (const n of byName.all(query.trim())) bump(n, 40);
    const byFile = db.prepare(`SELECT * FROM graph_nodes WHERE kind = 'file' AND (name = ?1 COLLATE NOCASE OR name LIKE ?1 || '.%') LIMIT 3`);
    for (const [v, weight] of variants) {
      if (v.length < 3) continue;
      for (const n of byName.all(v)) {
        // Prefer names whose own words are exactly the query words (sendFile over sendfile).
        const exact = nameWords(n.name).join('') === v.replace(/_/g, '') && nameWords(n.name).length === weight;
        bump(n, 10 * weight + (exact ? 3 : 0));
      }
      for (const n of byFile.all(v)) bump(n, 4 * weight);
    }

    // 2. Text: search hits, credited to the smallest symbol around each matching line.
    const enclosing = db.prepare(`SELECT * FROM graph_nodes WHERE path = ? AND start_line <= ?2 AND end_line >= ?2
      ORDER BY (kind = 'file'), (end_line - start_line) LIMIT 1`);
    const nextSymbol = db.prepare("SELECT * FROM graph_nodes WHERE path = ?1 AND kind != 'file' AND start_line > ?2 AND start_line <= ?3 ORDER BY start_line LIMIT 1");
    ftsRows(db, stems, 25, syns).forEach((row, i) => {
      const weight = 1 / (1 + i * 0.3);
      row.body.split('\n').slice(1).forEach((text, j) => {
        const lower = text.toLowerCase();
        const hits = stems.filter((w) => lower.includes(w)).length + 0.6 * syns.filter((w) => lower.includes(w)).length;
        if (!hits) return;
        const lineNo = row.start_line + j;
        let n = enclosing.get(row.path, lineNo), doc = false;
        // A comment just above a function explains it: credit the function, not the file.
        if (n?.kind === 'file' && COMMENT.test(text)) {
          const below = nextSymbol.get(row.path, lineNo, lineNo + 15);
          if (below) { n = below; doc = true; }
        } else if (n && n.kind !== 'file' && lineNo <= n.start_line + 12 && inDocstring(root, n, lineNo)) doc = true;
        if (n) bump(n, hits * weight * (n.kind === 'file' && langCode(n.path) ? 0.4 : 1) * (doc ? 1.6 : 1), lineNo);
      });
    });
    if (!cands.size) return 'No matches.';

    const aboutSide = stems.some((w) => /^(test|exampl|benchmark|spec)/.test(w));
    const aboutDocs = stems.some((w) => /^(doc|readm|guid|changelog|histor|tutorial|explain)/.test(w));
    const ranked = [...cands.values()]
      .map((c) => ({ ...c, score: (c.name + Math.sqrt(c.text) * 2 / lengthDamp(c.node) + Math.log1p(c.node.rank) * 0.5) * (!aboutSide && isSide(c.node.path) ? 0.5 : 1) * (!aboutDocs && isProse(c.node.path) ? 0.45 : 1) }))
      .sort((a, b) => b.score - a.score);
    // TALENSCAPE_DEBUG=1: why each of the top candidates scored what it did.
    if (process.env.TALENSCAPE_DEBUG) for (const c of ranked.slice(0, 6)) console.error(`${c.score.toFixed(1)} name ${c.name.toFixed(1)} text ${c.text.toFixed(1)} rank ${c.node.rank.toExponential(1)} ${c.node.qname} ${c.node.path}:${c.node.start_line}`);
    if (wantsBody && ranked[0].node.kind !== 'file') {
      const others = ranked.slice(1, 4).map((c) => `${label(c.node)} ${loc(c.node)}`).join(' · ');
      // Asked for the code itself: give it room (up to 600 tokens), still well under reading the file.
      return compressPaths(snipNode(db, root, ranked[0].node, Math.max(budget, 600), 'body') + (others ? `\nalso: ${others}` : ''));
    }
    return render(db, root, ranked, budget);
  } finally {
    db.close();
  }
}

function render(db, root, ranked, budget) {
  const out = new Out(budget);
  const [top, ...rest] = ranked;
  const n = top.node;
  out.add(`${label(n)} ${loc(n)}`);
  if (n.kind !== 'file') {
    const ins = neighbours(db, n.id, 'in', 4);
    const outs = neighbours(db, n.id, 'out', 6);
    if (ins.length) out.add(clip(' <- ' + ins.map((e) => `${e.ekind} ${at(e, e.eline)}`).join(' | ')));
    if (outs.length) out.add(clip(' → ' + outs.map((e) => `${e.ekind === 'calls' ? '' : e.ekind + ' '}${e.kind === 'file' ? e.path : e.qname}`).join(', ')));
  }

  // Reserve room for the "also" line before spending the rest on code.
  const also = rest.slice(0, 4).map((c) => at(c.node, [...c.lines][0] ?? c.node.start_line));
  const alsoLine = also.length ? 'also: ' + also.join(' · ') : '';
  out.left -= alsoLine.length + 1;

  const lines = fileLines(root, n.path);
  const pick = new Set();
  if (n.kind !== 'file') { pick.add(n.start_line); pick.add(n.start_line + 1); }
  [...top.lines].sort((a, b) => a - b).forEach((l) => pick.add(l));
  let prev = 0;
  for (const l of [...pick].filter((l) => l >= n.start_line && l <= n.end_line).sort((a, b) => a - b)) {
    const text = lines[l - 1];
    if (text === undefined) continue;
    if (prev && l > prev + 1 && !out.add('  …')) break;
    if (!out.add(clip(`${l} ${text.trimEnd()}`))) break;
    prev = l;
  }
  if (n.end_line - n.start_line > 1 && n.kind !== 'file') out.add(`  (full: show ${n.path} ${n.start_line}-${n.end_line})`);
  out.left += alsoLine.length + 1;
  if (alsoLine) out.add(clip(alsoLine));
  return compressPaths(out.toString());
}

// Long folder paths repeated in an answer are written once ("@1=src/flask/sansio/"), then as
// "@1/app.py". Only used when it saves a fair amount.
const PATH_RE = /(?<![\w@/.-])((?:[\w.-]+\/){2,})[\w.-]+/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function compressPaths(text) {
  const counts = new Map();
  for (const m of text.matchAll(PATH_RE)) {
    const dirs = m[1].split('/').filter(Boolean);
    for (let i = 2; i <= dirs.length; i++) {
      const p = dirs.slice(0, i).join('/') + '/';
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const aliases = [];
  while (aliases.length < 2) {
    let best = null, bestGain = 0;
    for (const [p, c] of counts) {
      if (aliases.some((a) => p.startsWith(a) || a.startsWith(p))) continue;
      const gain = c * (p.length - 3) - (p.length + 4); // characters saved, minus the "@N=…" header
      if (gain > bestGain) { best = p; bestGain = gain; }
    }
    if (!best || bestGain < 16) break;
    aliases.push(best);
  }
  if (!aliases.length) return text;
  // Lines that are commands to copy ("show <path> …") keep their full paths.
  const out = text.split('\n').map((line) => (/\bshow \S+ \d/.test(line) ? line
    : aliases.reduce((l, p, i) => l.replace(new RegExp(`(?<![\\w@/.-])${escapeRe(p)}`, 'g'), `@${i + 1}/`), line))).join('\n');
  return `${aliases.map((p, i) => `@${i + 1}=${p}`).join(' ')}\n${out}`;
}

// Undoes compressPaths (used by the scoreboard to check answers).
export function expandPaths(text) {
  const [first, ...rest] = text.split('\n');
  const defs = [...first.matchAll(/@(\d+)=(\S+)/g)];
  if (!defs.length || !/^@\d+=/.test(first)) return text;
  return rest.join('\n').replace(/@(\d+)\//g, (m, n) => defs.find((d) => d[1] === n)?.[2] ?? m);
}

// ---------- the other short questions ----------

export function where(root, name, budget = 200) {
  const db = openDb(root);
  try {
    const out = new Out(budget);
    const rows = findNodes(db, name, 20);
    if (!rows.length) return `Not found: ${name}`;
    for (const n of rows) if (!out.add(`${label(n)} ${loc(n)}`)) break;
    return compressPaths(out.toString());
  } finally { db.close(); }
}

function linkList(root, name, dir, budget) {
  const db = openDb(root);
  try {
    const nodes = findNodes(db, name, 3);
    if (!nodes.length) return `Not found: ${name}`;
    const out = new Out(budget);
    for (const n of nodes) {
      // For a file, include links to and from everything defined inside it.
      const ids = n.kind === 'file' ? db.prepare('SELECT id FROM graph_nodes WHERE path = ?').all(n.path).map((r) => r.id) : [n.id];
      const inside = new Set(ids);
      const rows = ids.flatMap((id) => neighbours(db, id, dir, 50)).filter((e) => !inside.has(e.id));
      if (!rows.length && nodes.length > 1) continue;
      out.add(`${label(n)} ${loc(n)}: ${rows.length} ${dir === 'in' ? 'used by' : 'uses'}`);
      const seen = new Set();
      for (const e of rows.sort((a, b) => (a.ekind === 'mentions') - (b.ekind === 'mentions') || b.rank - a.rank)) {
        const key = e.id + e.ekind;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = dir === 'in' ? at(e, e.eline) : e.kind === 'file' ? `file ${e.path}` : `${label(e)} ${loc(e)}`;
        if (!out.add(` ${dir === 'in' ? '<-' : '->'} ${e.ekind} ${where}`)) return compressPaths(out.toString() + '\n …');
      }
    }
    return compressPaths(out.toString());
  } finally { db.close(); }
}

export const deps = (root, name, budget = 250) => linkList(root, name, 'in', budget);
export const uses = (root, name, budget = 250) => linkList(root, name, 'out', budget);

const isTestPath = (p) => /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|\.(test|spec)\.[^/]+$/.test(p);

// Before changing something: what depends on it (two levels), and which tests cover it,
// with the command to run just those tests.
export function impact(root, name, budget = 250) {
  const db = openDb(root);
  try {
    const nodes = findNodes(db, name, 3);
    if (!nodes.length) return `Not found: ${name}`;
    const callers = db.prepare("SELECT src AS id FROM graph_edges WHERE dst = ? AND kind != 'mentions'");
    const byId = db.prepare('SELECT * FROM graph_nodes WHERE id = ?');
    const fileOf = db.prepare("SELECT id FROM graph_nodes WHERE kind = 'file' AND path = ?");
    const inFile = db.prepare('SELECT id FROM graph_nodes WHERE path = ?');
    const start = new Set(nodes.flatMap((n) => (n.kind === 'file' ? inFile.all(n.path).map((r) => r.id) : [n.id])));
    const seen = new Set(start);
    const levels = [];
    let frontier = [...start];
    for (let depth = 0; depth < 3; depth++) {
      const next = [];
      for (const id of frontier) for (const { id: src } of callers.all(id)) if (!seen.has(src)) { seen.add(src); next.push(src); }
      levels.push(next.map((id) => byId.get(id)));
      frontier = next;
    }
    // Tests: anything in a test file within three steps, plus test files importing the target's file.
    const testFiles = new Set(levels.flat().filter((n) => isTestPath(n.path)).map((n) => n.path));
    for (const n of nodes) {
      const f = fileOf.get(n.path);
      if (f) for (const { id } of callers.all(f.id)) { const t = byId.get(id); if (isTestPath(t.path)) testFiles.add(t.path); }
    }
    const out = new Out(budget);
    out.add(nodes.map((n) => `${label(n)} ${loc(n)}`).join(' | '));
    const show = (title, list) => {
      const code = list.filter((n) => !isTestPath(n.path)).sort((a, b) => b.rank - a.rank);
      if (code.length) out.add(` ${title} (${code.length}): ${code.slice(0, 6).map((n) => at(n, n.start_line)).join(', ')}${code.length > 6 ? ` +${code.length - 6} more` : ''}`);
    };
    show('direct', levels[0]);
    show('then', levels[1]);
    // From git history: files that usually change with this one (no code link needed), its age, and
    // whether it is an entry point (changing it affects users directly).
    for (const p of [...new Set(nodes.map((n) => n.path))]) {
      const extra = historyNotes(db, root, p, new Set([...seen].map((id) => byId.get(id)?.path)));
      if (extra) out.add(clip(` ${extra}`));
    }
    const tests = [...testFiles].sort();
    if (!tests.length) out.add(' tests: none found (nothing in a test file depends on it)');
    else {
      out.add(clip(` tests (${tests.length}): ${tests.join(', ')}`));
      const js = tests.filter((t) => /\.[cm]?[jt]sx?$/.test(t)), py = tests.filter((t) => t.endsWith('.py'));
      if (js.length) out.add(`  run: node --test ${js.join(' ')}`);
      if (py.length) out.add(`  run: pytest ${py.join(' ')}`);
    }
    return compressPaths(out.toString());
  } finally { db.close(); }
}

// One line of what git history says about a file: entry point, last change, files that change with it.
// Code partners come first; docs and generated notes only when there is nothing else.
function historyNotes(db, root, rel, alreadyShown = new Set()) {
  const f = db.prepare('SELECT changed_at, runs FROM files WHERE path = ?').get(rel);
  if (!f) return '';
  const partners = db.prepare('SELECT a, b, together FROM cochange WHERE a = ? OR b = ? ORDER BY together DESC, jaccard DESC').all(rel, rel)
    .map((r) => ({ path: r.a === rel ? r.b : r.a, together: r.together })).filter((p) => !alreadyShown.has(p.path));
  const code = partners.filter((p) => !isProse(p.path));
  const list = (code.length ? code : partners).slice(0, 4);
  const entry = f.runs ? 'runs directly' : packageEntries(root).has(rel) ? 'published by package.json' : '';
  return [
    entry && `ENTRY POINT (${entry})`,
    f.changed_at && `last changed ${age(f.changed_at)}`,
    list.length && `changes with: ${list.map((p) => `${p.path} (${p.together}×)`).join(', ')}`,
  ].filter(Boolean).join(' · ');
}
const packageEntries = (root) => {
  const out = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const add = (v) => { if (typeof v === 'string') out.add(v.replace(/^\.\//, '')); else if (v && typeof v === 'object') Object.values(v).forEach(add); };
    add(pkg.main); add(pkg.bin); add(pkg.exports); add(pkg.module);
  } catch { /* not a node package */ }
  return out;
};

// Shortest chain of links between two things (follows links in either direction).
export function connect(root, a, b, budget = 250) {
  const db = openDb(root);
  try {
    const from = findNodes(db, a, 3), to = findNodes(db, b, 3);
    if (!from.length) return `Not found: ${a}`;
    if (!to.length) return `Not found: ${b}`;
    const goal = new Set(to.map((n) => n.id));
    const found = chainBetween(db, from, goal, false) ?? chainBetween(db, from, goal, true);
    if (!found) return `No connection found between ${a} and ${b} (within 6 steps).`;
    const chain = found.map((p) => ({ node: db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(p.id), how: p.how }));
    const out = new Out(budget);
    out.add(chain.map((c, i) => (i ? `${c.how} ` : '') + label(c.node)).join(' '));
    for (const c of chain) if (!out.add(` ${label(c.node)} ${loc(c.node)}`)) break;
    return compressPaths(out.toString());
  } finally { db.close(); }
}

// Breadth-first search over links in both directions; returns [{ id, how }] or null.
function chainBetween(db, from, goal, withMentions) {
  const skip = withMentions ? '' : " AND kind != 'mentions'";
  const outE = db.prepare('SELECT dst AS id, kind FROM graph_edges WHERE src = ?' + skip);
  const inE = db.prepare('SELECT src AS id, kind FROM graph_edges WHERE dst = ?' + skip);
  const parentOf = db.prepare('SELECT parent FROM graph_nodes WHERE id = ?');
  const childrenOf = db.prepare('SELECT id FROM graph_nodes WHERE parent = ?');
  const prev = new Map(from.map((n) => [n.id, null]));
  let frontier = from.map((n) => n.id);
  let found = null;
  for (let depth = 0; depth < 6 && frontier.length && !found; depth++) {
    const next = [];
    for (const id of frontier) {
      const steps = [
        ...outE.all(id).map((e) => ({ id: e.id, how: `${e.kind}>` })),
        ...inE.all(id).map((e) => ({ id: e.id, how: `<${e.kind}` })),
        ...[parentOf.get(id)?.parent].filter(Boolean).map((p) => ({ id: p, how: 'in' })),
        ...childrenOf.all(id).map((c) => ({ id: c.id, how: 'has' })),
      ];
      for (const s of steps) {
        if (prev.has(s.id)) continue;
        prev.set(s.id, { id, how: s.how });
        if (goal.has(s.id)) { found = s.id; break; }
        next.push(s.id);
      }
      if (found || prev.size > 50000) break;
    }
    frontier = next;
  }
  if (!found) return null;
  const chain = [];
  for (let id = found; id !== undefined && id !== null;) {
    const p = prev.get(id);
    chain.unshift({ id, how: p?.how });
    id = p?.id ?? null;
  }
  return chain;
}

// The lines of one symbol at one of three levels:
//   L0 (sig)     its signature and the comment / docstring that explains it, about 20 tokens
//   L1 (body)    the whole body, cut to the budget
//   L2 (context) the body plus its class or file around it: the header and the other members' signatures
// level 'auto' picks L1 for short symbols and L0 for long ones (with the command for more).
export const SNIP_LONG = 40;
export function snip(root, name, budget = 400, level = 'auto') {
  const db = openDb(root);
  try {
    const [n, ...more] = findNodes(db, name, 6);
    if (!n) return `Not found: ${name}`;
    // The same name elsewhere (e.g. two apps): say so, and how to pick the other one.
    const others = more.filter((o) => o.kind !== 'file' && o.path !== n.path);
    const also = others.length ? `\nalso named ${n.name}: ${others.map((o) => `${o.path}:${o.start_line}`).join(', ')} · pick one: city snip <file>:${n.name}` : '';
    return snipNode(db, root, n, budget, level) + also;
  } finally { db.close(); }
}
function snipNode(db, root, n, budget, level) {
  {
    const lines = fileLines(root, n.path);
    const length = n.end_line - n.start_line + 1;
    const lv = level === 'auto' ? (n.kind === 'class' || length > SNIP_LONG ? 'sig' : 'body') : level;
    const out = new Out(budget);
    out.add(`${label(n)} ${loc(n)}${lv === 'sig' ? ` (${length} lines)` : ''}`);
    if (lv === 'sig') {
      for (const l of [...docAbove(lines, n.start_line), ...signature(lines, n.start_line, n.end_line)]) out.add(clip(`${l} ${lines[l - 1].trimEnd()}`));
      if (n.kind === 'class') for (const m of members(db, n)) if (!out.add(clip(`  ${m.start_line} ${lines[m.start_line - 1].trim()}`))) break;
      out.add(`  more: snip ${n.qname} --body | --context`);
      return out.toString();
    }
    if (lv === 'context') {
      const parent = db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(n.parent);
      if (parent && parent.kind !== 'file') {
        out.add(`in ${label(parent)} ${loc(parent)}:`);
        for (const l of signature(lines, parent.start_line, parent.end_line)) out.add(clip(`${l} ${lines[l - 1].trimEnd()}`));
        for (const m of members(db, parent)) if (m.id !== n.id && !out.add(clip(`  ${m.start_line} ${lines[m.start_line - 1].trim()}`))) break;
      } else {
        const top = db.prepare("SELECT * FROM graph_nodes WHERE path = ? AND kind != 'file' AND parent = (SELECT id FROM graph_nodes WHERE kind = 'file' AND path = ?) AND id != ? ORDER BY start_line LIMIT 12").all(n.path, n.path, n.id);
        out.add(`in file ${n.path} (${top.length ? 'also: ' + top.map((t) => `${t.name}:${t.start_line}`).join(', ') : 'nothing else'})`);
      }
    }
    // Too long to fit? Fold the docstring / long comments into one line so the code itself fits.
    const all = [];
    for (let l = n.start_line; l <= n.end_line; l++) all.push(l);
    const fits = tokens(all.map((l) => lines[l - 1] ?? '').join('\n')) <= budget * 0.9;
    const doc = fits ? null : docRange(lines, n);
    for (let l = n.start_line; l <= n.end_line; l++) {
      if (doc && l >= doc[0] && l <= doc[1]) {
        if (l === doc[0]) out.add(`${l} ${lines[l - 1].trimEnd()}  … (${doc[1] - doc[0] + 1} lines of explanation folded: show ${n.path} ${doc[0]}-${doc[1]})`);
        continue;
      }
      if (!out.add(clip(`${l} ${lines[l - 1]?.trimEnd() ?? ''}`))) {
        out.lines.push(`  … cut at the size limit (rest: show ${n.path} ${l}-${n.end_line})`);
        break;
      }
    }
    return out.toString();
  }
}
// The explanation inside a symbol: a Python docstring, or the longest run of comment lines (3+).
function docRange(lines, n) {
  if (n.path.endsWith('.py')) {
    let sigEnd = n.start_line;
    while (sigEnd < Math.min(n.end_line, n.start_line + 8) && !/:\s*(#.*)?$/.test(lines[sigEnd - 1] ?? '')) sigEnd++;
    const first = sigEnd + 1, opener = (lines[first - 1] ?? '').trim();
    if (!TRIPLE.test(opener.slice(0, 4))) return null;
    let last = first;
    if ((opener.match(/("{3}|'{3})/g) ?? []).length < 2) while (last < n.end_line && !TRIPLE.test(lines[last] ?? '')) last++;
    return last + 1 > first + 1 ? [first, Math.min(last + 1, n.end_line)] : null;
  }
  let best = null;
  for (let l = n.start_line + 1, run = null; l <= n.end_line + 1; l++) {
    if (l <= n.end_line && COMMENT.test(lines[l - 1] ?? '')) run ??= l;
    else if (run) { if (l - run >= 3 && (!best || l - run > best[1] - best[0] + 1)) best = [run, l - 1]; run = null; }
  }
  return best;
}
// Is this line inside the symbol's docstring (Python: the string right after the signature)?
function inDocstring(root, n, lineNo) {
  if (!n.path.endsWith('.py')) return false;
  const lines = fileLines(root, n.path);
  let sigEnd = n.start_line;
  while (sigEnd < Math.min(n.end_line, n.start_line + 8) && !/:\s*(#.*)?$/.test(lines[sigEnd - 1] ?? '')) sigEnd++;
  const first = sigEnd + 1;
  if (!TRIPLE.test((lines[first - 1] ?? '').trim().slice(0, 4))) return false;
  let last = first;
  const opener = lines[first - 1].trim();
  if ((opener.match(/("{3}|'{3})/g) ?? []).length < 2) while (last < n.end_line && !TRIPLE.test(lines[last] ?? '')) last++;
  return lineNo >= first && lineNo <= last + 1;
}
// The comment block just above a definition (JS/TS // and /* */; Python # comments), up to 6 lines.
function docAbove(lines, start) {
  const out = [];
  for (let l = start - 1; l >= 1 && out.length < 6; l--) {
    const t = lines[l - 1]?.trim() ?? '';
    if (/^(\/\/|\/\*|\*|#(?!!)|@)/.test(t)) out.unshift(l); else break;
  }
  return out;
}
// The signature lines (to the opening brace or colon), then a Python docstring if there is one.
function signature(lines, start, end) {
  const out = [];
  let l = start;
  for (; l <= Math.min(end, start + 3); l++) { out.push(l); if (/[{:]\s*(\/\/.*)?$|=>\s*\S/.test(lines[l - 1] ?? '')) break; }
  const next = lines[l]?.trim() ?? '';
  if (/^("""|\'\'\')/.test(next)) {
    for (let k = l + 1; k <= Math.min(end, l + 6); k++) { out.push(k); if (k > l + 1 && /("""|\'\'\')/.test(lines[k - 1]) || /^("""|\'\'\').*("""|\'\'\')\s*$/.test(lines[k - 1].trim())) break; }
  }
  return out;
}
const members = (db, parent) => db.prepare("SELECT * FROM graph_nodes WHERE parent = ? AND kind IN ('method','function','class') ORDER BY start_line LIMIT 30").all(parent.id);

// Plain text search: only the matching lines.
export function search(root, query, limit = 8) {
  const words = terms(query);
  if (!words.length) return [];
  const db = openDb(root);
  try {
    const hits = [];
    for (const row of ftsRows(db, words, limit * 3)) {
      const scored = row.body.split('\n').slice(1)
        .map((text, i) => ({ text, line: row.start_line + i, score: words.filter((w) => text.toLowerCase().includes(w)).length }))
        .filter((l) => l.score > 0)
        .sort((a, b) => b.score - a.score || a.line - b.line)
        .slice(0, 2);
      for (const l of scored) hits.push({ path: row.path, line: l.line, score: l.score, text: clip(l.text.trim()) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...h }) => h);
  } finally { db.close(); }
}

export function show(root, file, from, to) {
  const full = path.resolve(root, file);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('File is outside the project folder.');
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  return lines.slice(from - 1, to).map((t, i) => `${from + i}: ${t}`).join('\n');
}
