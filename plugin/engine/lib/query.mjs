// Read-only questions against the graph + search index. Every answer has a hard token budget.
// Token counts are estimates (about 4 characters per token).

import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';
import { age } from './history.mjs';

export { tokens } from './tokens.mjs';
import { tokens } from './tokens.mjs';
import { askCore, snipNode, Out, clip, loc, at, label, terms, ftsRows, neighbours, isSide, isProse, UNSURE_LEAD, compressPaths, expandPaths, SNIP_LONG } from './askcore.mjs';
export { isSide, isProse, UNSURE_LEAD, compressPaths, expandPaths, SNIP_LONG };

function fileLines(root, rel, cache = new Map()) {
  if (!cache.has(rel)) {
    try { cache.set(rel, fs.readFileSync(path.join(root, rel), 'utf8').split('\n')); } catch { cache.set(rel, []); }
  }
  return cache.get(rel);
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

// The map's lookups askcore.mjs needs, answered by the city database (worker/mapmem.mjs answers the same
// ones from the copy on Cloudflare, so the answer link gives the same answers).
export function mapOf(db) {
  const q = (sql) => db.prepare(sql);
  const like = q(`SELECT * FROM graph_nodes WHERE kind != 'file' AND name LIKE '%' || ? || '%' ORDER BY rank DESC LIMIT ?`);
  const byName = q(`SELECT * FROM graph_nodes WHERE kind != 'file' AND name = ? COLLATE NOCASE ORDER BY rank DESC LIMIT ?`);
  const byFile = q(`SELECT * FROM graph_nodes WHERE kind = 'file' AND (name = ?1 COLLATE NOCASE OR name LIKE ?1 || '.%') LIMIT ?2`);
  const enclosing = q(`SELECT * FROM graph_nodes WHERE path = ? AND start_line <= ?2 AND end_line >= ?2
      ORDER BY (kind = 'file'), (end_line - start_line) LIMIT 1`);
  const nextSymbol = q("SELECT * FROM graph_nodes WHERE path = ?1 AND kind != 'file' AND start_line > ?2 AND start_line <= ?3 ORDER BY start_line LIMIT 1");
  const fts = q('SELECT path, start_line, body FROM snippet_fts WHERE snippet_fts MATCH ? ORDER BY bm25(snippet_fts) LIMIT ?');
  const ins = q("SELECT e.kind AS ekind, e.line AS eline, n.* FROM graph_edges e JOIN graph_nodes n ON n.id = e.src WHERE e.dst = ? ORDER BY (e.kind = 'mentions'), n.rank DESC LIMIT ?");
  const outs = q("SELECT e.kind AS ekind, e.line AS eline, n.* FROM graph_edges e JOIN graph_nodes n ON n.id = e.dst WHERE e.src = ? ORDER BY (e.kind = 'mentions'), n.rank DESC LIMIT ?");
  const node = q('SELECT * FROM graph_nodes WHERE id = ?');
  const topLevel = q("SELECT * FROM graph_nodes WHERE path = ? AND kind != 'file' AND parent = (SELECT id FROM graph_nodes WHERE kind = 'file' AND path = ?) AND id != ? ORDER BY start_line LIMIT ?");
  const members = q("SELECT * FROM graph_nodes WHERE parent = ? AND kind IN ('method','function','class') ORDER BY start_line LIMIT ?");
  return {
    like: (w, limit) => like.all(w, limit), byName: (v, limit) => byName.all(v, limit), byFile: (v, limit) => byFile.all(v, limit),
    enclosing: (p, line) => enclosing.get(p, line), nextSymbol: (p, from, to) => nextSymbol.get(p, from, to),
    fts: (match, limit) => fts.all(match, limit), neighbours: (id, dir, limit) => (dir === 'in' ? ins : outs).all(id, limit),
    node: (id) => node.get(id), topLevel: (p, id, limit) => topLevel.all(p, p, id, limit), members: (id, limit) => members.all(id, limit),
  };
}

export function ask(root, query, budget = 300) {
  const db = openDb(root);
  try { return askCore({ map: mapOf(db), lines: (rel) => fileLines(root, rel) }, query, budget); } finally { db.close(); }
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
      const map = mapOf(db), rows = ids.flatMap((id) => neighbours(map, id, dir, 50)).filter((e) => !inside.has(e.id));
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
export function snip(root, name, budget = 400, level = 'auto') {
  const db = openDb(root);
  try {
    const [n, ...more] = findNodes(db, name, 6);
    if (!n) return `Not found: ${name}`;
    // The same name elsewhere (e.g. two apps): say so, and how to pick the other one.
    const others = more.filter((o) => o.kind !== 'file' && o.path !== n.path);
    const also = others.length ? `\nalso named ${n.name}: ${others.map((o) => `${o.path}:${o.start_line}`).join(', ')} · pick one: city snip <file>:${n.name}` : '';
    return snipNode(mapOf(db), (rel) => fileLines(root, rel), n, budget, level) + also;
  } finally { db.close(); }
}
// Plain text search: only the matching lines.
export function search(root, query, limit = 8) {
  const words = terms(query);
  if (!words.length) return [];
  const db = openDb(root);
  try {
    const hits = [];
    for (const row of ftsRows(mapOf(db), words, limit * 3)) {
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
