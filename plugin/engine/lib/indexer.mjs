// Builds and refreshes the practice database: search index + knowledge graph + skill list.
// Only changed files are re-read; links between files are re-resolved every run (cheap).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';
import { walk, looksBinary, langOf, districtOf, MAX_FILE_BYTES } from './files.mjs';
import { commits, coChange, lastChanged } from './history.mjs';
import { parseFile } from './parse.mjs';
import { findSkills, parseSkill } from '../skills.mjs';

const CHUNK_LINES = 40;
const JS_EXT = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '/index.js', '/index.ts', '/index.mjs'];
const CALLABLE = new Set(['function', 'method', 'class']);

export async function buildIndex(root) {
  const db = openDb(root);
  const known = new Map(db.prepare('SELECT path, mtime, size, hash FROM files').all().map((r) => [r.path, r]));
  const seen = new Set();
  const stats = { added: 0, updated: 0, removed: 0, unchanged: 0 };
  const q = {
    insChunk: db.prepare('INSERT INTO snippet_fts (path, start_line, end_line, body) VALUES (?, ?, ?, ?)'),
    insNode: db.prepare('INSERT INTO graph_nodes (kind, name, qname, path, start_line, end_line, parent, district, main) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insRef: db.prepare('INSERT INTO graph_refs (src, kind, target, line, path) VALUES (?, ?, ?, ?, ?)'),
    upFile: db.prepare('INSERT OR REPLACE INTO files (path, hash, size, mtime, lang, district, runs) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    keepFile: db.prepare('UPDATE files SET hash = ?, size = ?, mtime = ? WHERE path = ?'),
  };
  const forget = (rel) => {
    db.prepare('DELETE FROM snippet_fts WHERE path = ?').run(rel);
    db.prepare('DELETE FROM graph_refs WHERE path = ?').run(rel);
    db.prepare('DELETE FROM graph_nodes WHERE path = ?').run(rel);
  };

  db.exec('BEGIN');
  try {
    for (const { full, rel } of walk(root)) {
      const st = fs.statSync(full);
      if (st.size > MAX_FILE_BYTES) continue;
      const old = known.get(rel);
      if (old && old.mtime === st.mtimeMs && old.size === st.size) { seen.add(rel); stats.unchanged++; continue; }
      const buf = fs.readFileSync(full);
      if (looksBinary(buf)) continue;
      seen.add(rel);
      const hash = createHash('sha1').update(buf).digest('hex');
      const lang = langOf(rel);
      const district = districtOf(rel);
      if (old && old.hash === hash) { q.keepFile.run(hash, st.size, st.mtimeMs, rel); stats.unchanged++; continue; }

      forget(rel);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += CHUNK_LINES) {
        const end = Math.min(i + CHUNK_LINES, lines.length);
        q.insChunk.run(rel, i + 1, end, rel + '\n' + lines.slice(i, end).join('\n'));
      }

      const fileId = Number(q.insNode.run('file', path.posix.basename(rel), rel, rel, 1, lines.length, null, district, 0).lastInsertRowid);
      const { symbols, refs } = lang ? await parseFile(lang, text, moduleName(rel)) : { symbols: [], refs: [] };
      const ids = [];
      for (const s of symbols) {
        const parent = s.parent >= 0 ? ids[s.parent] : fileId;
        ids.push(Number(q.insNode.run(s.kind, s.name, s.qname, rel, s.start, s.end, parent, district, s.main ? 1 : 0).lastInsertRowid));
      }
      for (const r of refs) q.insRef.run(r.from >= 0 ? ids[r.from] : fileId, r.kind, r.target, r.line, rel);

      q.upFile.run(rel, hash, st.size, st.mtimeMs, lang, district, /^#!/.test(text) || /if __name__ == ['"]__main__['"]/.test(text) ? 1 : 0);
      old ? stats.updated++ : stats.added++;
    }
    for (const rel of known.keys()) {
      if (seen.has(rel)) continue;
      forget(rel);
      db.prepare('DELETE FROM files WHERE path = ?').run(rel);
      stats.removed++;
    }
    resolveEdges(db);
    addHistory(db, root);
    rankNodes(db);
    refreshSkills(db, root);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    stats.nodes = db.prepare('SELECT count(*) AS n FROM graph_nodes').get().n;
    stats.edges = db.prepare('SELECT count(*) AS n FROM graph_edges').get().n;
    db.close();
  }
  return stats;
}

// Git history: when each file last changed, and which files change together. Kept apart from the
// code links, so ranking and "who depends on this" stay about the code itself.
function addHistory(db, root) {
  const list = commits(root);
  db.exec('DELETE FROM cochange');
  if (!list.length) return;
  const known = new Set(db.prepare('SELECT path FROM files').all().map((r) => r.path));
  const at = lastChanged(list), setAt = db.prepare('UPDATE files SET changed_at = ? WHERE path = ?');
  for (const f of known) setAt.run(at.get(f) ?? null, f);
  const ins = db.prepare('INSERT OR REPLACE INTO cochange (a, b, together, jaccard) VALUES (?, ?, ?, ?)');
  for (const p of coChange(list, known)) ins.run(p.a, p.b, p.together, p.jaccard);
}

// "lib/router/index.js" → "router", "src/app.js" → "app".
function moduleName(rel) {
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, '');
  return base === 'index' || base === '__init__' ? path.posix.basename(path.posix.dirname(rel)) || base : base;
}

// Turns raw references (names, import strings) into edges between node ids.
function resolveEdges(db) {
  db.exec('DELETE FROM graph_edges');
  const files = new Map(db.prepare("SELECT id, path FROM graph_nodes WHERE kind = 'file'").all().map((r) => [r.path, r.id]));
  const pyModules = pythonModuleMap([...files.keys()]);
  const byName = new Map();
  const sql = `SELECT n.id, n.kind, n.name, n.path, n.main, p.kind AS parentKind FROM graph_nodes n
    LEFT JOIN graph_nodes p ON p.id = n.parent WHERE n.kind != 'file'`;
  for (const n of db.prepare(sql).all()) {
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name).push(n);
  }
  const refs = db.prepare('SELECT src, kind, target, line, path FROM graph_refs').all();
  const ins = db.prepare('INSERT OR IGNORE INTO graph_edges (src, dst, kind, line) VALUES (?, ?, ?, ?)');

  // Pass 1: imports and file mentions, so name lookups below can prefer imported files.
  const importsOf = new Map();
  const binds = new Map(); // file → (local name → { file, orig })
  for (const r of refs) {
    if (r.kind === 'binds') {
      const [local, spec, orig] = r.target.split(' ');
      const target = resolveImport(r.path, spec, files, pyModules);
      if (!target) continue;
      if (!binds.has(r.path)) binds.set(r.path, new Map());
      binds.get(r.path).set(local, { file: target, orig });
      continue;
    }
    if (r.kind !== 'imports' && !(r.kind === 'mentions' && r.target.startsWith('path:'))) continue;
    const target = r.kind === 'imports' ? resolveImport(r.path, r.target, files, pyModules) : resolveMention(r.path, r.target.slice(5), files);
    if (!target || target === r.path) continue;
    ins.run(r.src, files.get(target), r.kind, r.line);
    if (r.kind === 'imports') {
      if (!importsOf.has(r.path)) importsOf.set(r.path, new Set());
      importsOf.get(r.path).add(target);
    }
  }

  // Pass 2: calls, inherits and name mentions. Rules that keep links trustworthy:
  //  - a function nested inside another function is only reachable from its own file;
  //  - `x.name()` calls only link within the same file or to files it imports;
  //  - otherwise a name links anywhere only if exactly one thing has that name.
  const mainOf = new Map();
  for (const list of byName.values()) for (const n of list) if (n.main) mainOf.set(n.path, n);
  for (const r of refs) {
    if (r.kind === 'imports' || r.kind === 'binds' || r.target.startsWith('path:')) continue;
    const isMember = r.target.startsWith('.');
    const name = isMember ? r.target.slice(1) : r.target;
    const bound = !isMember && binds.get(r.path)?.get(name);
    if (bound) {
      // A name brought in by import/require: link to what that file exports.
      const named = bound.orig && (byName.get(bound.orig) ?? []).find((n) => n.path === bound.file);
      const dst = named ?? mainOf.get(bound.file);
      ins.run(r.src, dst ? dst.id : files.get(bound.file), r.kind, r.line);
      continue;
    }
    const nested = (n) => n.parentKind === 'function' || n.parentKind === 'method';
    const all = (byName.get(name) ?? []).filter((n) => n.id !== r.src && !(isMember && nested(n))
      && (r.kind === 'inherits' ? n.kind === 'class' : CALLABLE.has(n.kind) || n.kind === 'skill'));
    if (!all.length) continue;
    let pick = all.filter((n) => n.path === r.path);
    if (!pick.length) pick = all.filter((n) => !nested(n) && importsOf.get(r.path)?.has(n.path));
    const global = all.filter((n) => !nested(n));
    if (!pick.length && !isMember && global.length === 1 && (r.kind !== 'mentions' || name.length >= 4)) pick = global;
    if (pick.length > 2) continue; // too ambiguous to be useful
    for (const n of pick) if (n.id !== r.src) ins.run(r.src, n.id, r.kind, r.line);
  }
}

function resolveImport(from, target, files, pyModules) {
  if (target.startsWith('py:')) return resolvePython(from, target.slice(3), files, pyModules);
  if (!target.startsWith('.')) return null; // outside package
  const base = path.posix.join(path.posix.dirname(from), target);
  for (const ext of JS_EXT) if (files.has(base + ext)) return base + ext;
  // TypeScript projects often import "./x.js" for a file that is really x.ts
  const noExt = base.replace(/\.(m|c)?js$/, '');
  for (const ext of JS_EXT) if (files.has(noExt + ext)) return noExt + ext;
  return null;
}

function resolvePython(from, spec, files, pyModules) {
  const optional = spec.endsWith('?');
  if (optional) spec = spec.slice(0, -1);
  let dotted = spec;
  const dots = spec.match(/^\.+/)?.[0].length ?? 0;
  if (dots) {
    let dir = path.posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    const rest = spec.slice(dots);
    const base = path.posix.join(dir, rest.replace(/\./g, '/'));
    for (const c of [base + '.py', base + '/__init__.py']) if (files.has(c.replace(/^\.\//, ''))) return c.replace(/^\.\//, '');
    return null;
  }
  return pyModules.get(dotted) ?? null;
}

// Maps dotted module names (and their shorter tails, when unambiguous) to .py files.
function pythonModuleMap(paths) {
  const map = new Map();
  for (const p of paths) {
    if (!p.endsWith('.py')) continue;
    const parts = p.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/');
    for (let i = 0; i < parts.length; i++) {
      const name = parts.slice(i).join('.');
      map.set(name, map.has(name) && map.get(name) !== p ? null : p);
    }
  }
  return map;
}

function resolveMention(from, target, files) {
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  if (files.has(rel)) return rel;
  const fromRoot = path.posix.normalize(target.replace(/^\.?\//, ''));
  return files.has(fromRoot) ? fromRoot : null;
}

// PageRank: importance flows from a node to the things it uses.
function rankNodes(db, iterations = 30, damping = 0.85) {
  const ids = db.prepare('SELECT id FROM graph_nodes').all().map((r) => r.id);
  if (!ids.length) return;
  const index = new Map(ids.map((id, i) => [id, i]));
  const out = ids.map(() => []);
  for (const e of db.prepare('SELECT src, dst FROM graph_edges').all()) {
    const s = index.get(e.src), d = index.get(e.dst);
    if (s !== undefined && d !== undefined) out[s].push(d);
  }
  const n = ids.length;
  let rank = new Float64Array(n).fill(1 / n);
  for (let k = 0; k < iterations; k++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!out[i].length) { dangling += rank[i]; continue; }
      const share = (damping * rank[i]) / out[i].length;
      for (const d of out[i]) next[d] += share;
    }
    const spread = (damping * dangling) / n;
    for (let i = 0; i < n; i++) next[i] += spread;
    rank = next;
  }
  const up = db.prepare('UPDATE graph_nodes SET rank = ? WHERE id = ?');
  for (let i = 0; i < n; i++) up.run(rank[i] * n, ids[i]); // 1.0 = average node
}

function refreshSkills(db, root) {
  db.exec('DELETE FROM skills');
  const ins = db.prepare('INSERT OR REPLACE INTO skills (name, path, area, model, description, triggers, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  for (const file of findSkills(root)) {
    const { meta } = parseSkill(fs.readFileSync(path.join(root, file), 'utf8'));
    if (!meta?.name) continue;
    const parts = file.split('/');
    const triggers = Array.isArray(meta.triggers) ? meta.triggers.join(', ') : meta.triggers ?? '';
    ins.run(meta.name, file, parts[1], parts[1] === 'user' ? parts[2] : null, meta.description ?? '', triggers, meta.version ?? '', now);
  }
}
