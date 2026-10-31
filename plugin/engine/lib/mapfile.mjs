// .city/MAP.md: the project map as one short plain file, for an AI that can read the project (for
// example Grok or ChatGPT through GitHub) but can't run `city`: what is in each file, with line
// numbers, so it opens only the lines it needs instead of whole files. Written at every wrap-up.

import { buildIndex } from './indexer.mjs';
import { openDb } from './db.mjs';
import { tokens } from './tokens.mjs';
import { collectSkills, SKILL_DIRS, MANAGED } from './sync.mjs';
import { parseSkill } from '../skills.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const MAP_BUDGET = 3000; // tokens: a small fraction of reading the files themselves

// The map in two levels, so an AI reads only the part it needs: .city/MAP.md is a short table of
// contents (skills, and each area of the project with what's in it), .city/map/<area>.md the detail
// (every file's pieces with their lines).
async function mapData(root) {
  await buildIndex(root);
  const db = openDb(root);
  let files;
  try {
    const q = db.prepare(`SELECT qname, start_line, end_line, rank FROM graph_nodes WHERE path = ? AND kind IN ('class', 'function', 'method')
      AND (end_line - start_line) >= 2 ORDER BY rank DESC, start_line`);
    files = db.prepare('SELECT path, district FROM files ORDER BY district, path').all()
      .map((f) => ({ ...f, area: (f.district || '(root)').replace(/^\(root\)$/, 'root'), syms: q.all(f.path) })).filter((f) => f.syms.length);
  } finally { db.close?.(); }
  return files;
}
const areaFile = (area) => `.city/map/${area.replace(/[^A-Za-z0-9_.-]/g, '_')}.md`;

export async function mapFile(root, budget = MAP_BUDGET) {
  const files = await mapData(root);
  // The skills every AI should know about: the project's own and the ones added in the Talenscape app.
  const skills = [...collectSkills(root)];
  for (const d of SKILL_DIRS) {
    try {
      for (const n of fs.readdirSync(path.join(root, d, 'skills'))) {
        const rel = `${d}/skills/${n}/SKILL.md`, meta = parseSkill(fs.readFileSync(path.join(root, rel), 'utf8')).meta;
        if (meta?.['managed-by'] === MANAGED && !skills.some((s) => s.name === meta.name)) skills.push({ name: meta.name, path: rel, description: meta.description ?? '', model: [].concat(meta.models ?? [])[0] ?? null });
      }
    } catch { /* none */ }
  }
  const areas = new Map();
  for (const f of files) (areas.get(f.area) ?? areas.set(f.area, []).get(f.area)).push(f);
  const top = (list) => list.flatMap((f) => f.syms.map((x) => ({ ...x, path: f.path }))).sort((a, b) => b.rank - a.rank).slice(0, 4).map((x) => x.qname).join(', ');
  const text = [
    '# Project map', '',
    'For an AI that can read this project but not run `city`. Start with `.city/BLINK.md` (where things stand).',
    'Know the name you need (a function, class or method)? Open `.city/names/<its first two letters>.md` (pick:',
    '`pi.md`, lowercase): where it is and its own small file. Otherwise pick the area below and open',
    'its map: every file there, its pieces and their lines.',
    'Each piece is also its own small file: `.city/snips/<file>/<name>.txt` (where it is, what it calls, what',
    'calls it, its code). Open that instead of the whole file. What calls what overall: `.city/GRAPH.md`.', '',
    ...(skills.length ? ['## Skills (read the file when its use fits the task; "for X": only that AI uses it)', ...skills.map((s) => `- ${s.name}${s.model ? ` (for ${s.model})` : ''}: ${String(s.description).slice(0, 140)} (${s.path})`), ''] : []),
    '## Areas', '',
    ...[...areas].map(([a, list]) => `- ${a}: ${list.length} file(s), ${list.reduce((n, f) => n + f.syms.length, 0)} pieces, e.g. ${top(list)} → \`${areaFile(a)}\``), '',
  ].join('\n');
  return tokens(text) <= budget ? text : text.slice(0, budget * 3);
}

// One area's map: its files, each with its pieces (most important first) and their lines.
export async function mapAreas(root, budget = MAP_BUDGET) {
  const files = await mapData(root), out = new Map();
  const areas = new Map();
  for (const f of files) (areas.get(f.area) ?? areas.set(f.area, []).get(f.area)).push(f);
  for (const [a, list] of areas) {
    const head = `# Map: ${a}\n\nEvery file in this area, its pieces (most important first) and their lines. A piece's own file: \`.city/snips/<file>/<name>.txt\`.\n\n`;
    let text = head;
    for (let per = 12; per >= 1; per--) {
      const body = list.map((f) => `- ${f.path}: ${f.syms.slice(0, per).map((x) => `${x.qname} ${x.start_line}-${x.end_line}`).join(', ')}${f.syms.length > per ? ` +${f.syms.length - per}` : ''}`).join('\n');
      text = `${head}${body}\n`;
      if (tokens(text) <= budget) break;
    }
    out.set(areaFile(a), text);
  }
  return out;
}

// .city/GRAPH.md: the links between pieces of code (what calls what, what imports what), the same
// graph `city deps` and `city uses` answer from, as one short file. Most important pieces first.
export const GRAPH_BUDGET = 4000;
const PER = 6;

export async function graphFile(root, budget = GRAPH_BUDGET) {
  await buildIndex(root);
  const db = openDb(root);
  let syms, files;
  try {
    const out = db.prepare("SELECT DISTINCT d.qname AS n FROM graph_edges e JOIN graph_nodes d ON d.id = e.dst WHERE e.src = ? AND e.kind IN ('calls', 'inherits') ORDER BY d.rank DESC");
    const inn = db.prepare("SELECT DISTINCT s.qname AS n FROM graph_edges e JOIN graph_nodes s ON s.id = e.src WHERE e.dst = ? AND e.kind IN ('calls', 'inherits') AND s.kind != 'file' ORDER BY s.rank DESC");
    syms = db.prepare("SELECT id, qname, path, start_line FROM graph_nodes WHERE kind IN ('class', 'function', 'method') ORDER BY rank DESC").all()
      .map((n) => ({ ...n, calls: out.all(n.id).map((r) => r.n), by: inn.all(n.id).map((r) => r.n) })).filter((n) => n.calls.length || n.by.length);
    const imp = db.prepare("SELECT DISTINCT d.path AS p FROM graph_edges e JOIN graph_nodes d ON d.id = e.dst WHERE e.src = ? AND e.kind = 'imports' AND d.path != ? ORDER BY d.path");
    // A relative import whose file isn't in the project (made at build time, or missing) is listed and
    // marked, never silently dropped: a reader of this file can't tell a dropped import from no import.
    const specs = db.prepare("SELECT DISTINCT target FROM graph_refs WHERE path = ? AND kind = 'imports' AND target LIKE '.%'");
    const known = new Set(db.prepare("SELECT path FROM graph_nodes WHERE kind = 'file'").all().map((r) => r.path));
    const missing = (file) => specs.all(file).map((r) => path.posix.normalize(path.posix.join(path.posix.dirname(file), r.target)))
      .filter((p) => ![p, `${p}.js`, `${p}.mjs`, `${p}.ts`, `${p}/index.js`].some((c) => known.has(c))).map((p) => `${p} (not in the project)`);
    files = db.prepare("SELECT id, path FROM graph_nodes WHERE kind = 'file' ORDER BY path").all()
      .map((f) => ({ path: f.path, uses: [...imp.all(f.id, f.path).map((r) => r.p), ...missing(f.path)] })).filter((f) => f.uses.length);
  } finally { db.close?.(); }
  const list = (a) => a.slice(0, PER).join(', ') + (a.length > PER ? ` +${a.length - PER}` : '');
  const head = ['# Code graph', '', 'What calls what, for an AI that reads this project but cannot run `city`. "→" calls, "←" called by.',
    'Find a piece here, then its lines in `.city/MAP.md`.', '', '## Files and what they import', '',
    ...files.map((f) => `- ${f.path} → ${list(f.uses)}`), '', '## Functions and classes (most important first)', ''].join('\n');
  const lines = syms.map((n) => `- ${n.qname} (${n.path}:${n.start_line})${n.calls.length ? ` → ${list(n.calls)}` : ''}${n.by.length ? ` ← ${list(n.by)}` : ''}`);
  const kept = [];
  for (const l of lines) { if (tokens(`${head}${[...kept, l].join('\n')}\n`) > budget) break; kept.push(l); }
  return `${head}${kept.join('\n')}\n${kept.length < lines.length ? `\n(${lines.length - kept.length} less important pieces left out to stay short.)\n` : ''}`;
}

// .city/snips/<file>/<name>.txt: each function, class and method as its own tiny file, so an AI that
// reads the project through GitHub (which only fetches whole files) opens just the piece it needs.
// Each one starts with where it is and what it calls / what calls it. Rewritten with the map; pieces
// that no longer exist are removed. Files that look like they hold a key are left out.
export const SNIPS_DIR = path.join('.city', 'snips');
const LONG_LINES = 45, SHORT_LINES = 28; // longer pieces get a short version first
const safe = (s) => s.replace(/[^A-Za-z0-9_.$-]/g, '_').slice(0, 120);
export const snipPath = (file, qname) => `.city/snips/${file}/${safe(qname)}.txt`;

export async function writeSnips(root) {
  const { SECRET_RE } = await import('./skill-rules.mjs');
  await buildIndex(root);
  const db = openDb(root);
  const wanted = new Map();
  try {
    const nodes = db.prepare("SELECT id, qname, kind, path, start_line, end_line FROM graph_nodes WHERE kind IN ('class', 'function', 'method') AND (end_line - start_line) >= 2 ORDER BY path, start_line").all();
    const out = db.prepare("SELECT DISTINCT d.qname AS n FROM graph_edges e JOIN graph_nodes d ON d.id = e.dst WHERE e.src = ? AND e.kind IN ('calls', 'inherits') LIMIT 12");
    const inn = db.prepare("SELECT DISTINCT s.qname AS n FROM graph_edges e JOIN graph_nodes s ON s.id = e.src WHERE e.dst = ? AND e.kind IN ('calls', 'inherits') AND s.kind != 'file' LIMIT 12");
    const kids = db.prepare("SELECT qname, start_line, end_line FROM graph_nodes WHERE parent = ? AND kind IN ('method', 'function', 'class') AND (end_line - start_line) >= 2 ORDER BY start_line");
    const texts = new Map();
    for (const n of nodes) {
      if (!texts.has(n.path)) { let t = null; try { t = fs.readFileSync(path.join(root, n.path), 'utf8'); } catch { /* gone */ } texts.set(n.path, t && !SECRET_RE.test(t) ? t.split('\n') : null); }
      const lines = texts.get(n.path);
      if (!lines) continue;
      const calls = out.all(n.id).map((r) => r.n), by = inn.all(n.id).map((r) => r.n);
      // No line numbers in a piece: code moving down a file then leaves the piece as it is (where each piece
      // starts is in .city/names), so a save only rewrites the pieces whose code changed.
      const num = (from, to) => lines.slice(from - 1, to).join('\n');
      const head = `${n.path} · ${n.kind} ${n.qname} (lines: .city/names)\ncalls: ${calls.join(', ') || 'nothing in the project'}\ncalled by: ${by.join(', ') || 'nothing in the project'}\n\n`;
      const size = n.end_line - n.start_line + 1, members = n.kind === 'class' ? kids.all(n.id) : [];
      const fullName = snipPath(n.path, n.qname).replace(/\.txt$/, '.full.txt');
      let body;
      // A class: its first lines and a list of its parts, each with its own small file.
      if (members.length) body = `${num(n.start_line, Math.min(n.end_line, n.start_line + 7))}\n      …\nparts: ${members.map((m) => `${m.qname} (${snipPath(n.path, m.qname)})`).join(', ')}`;
      // A long piece: its beginning, and the whole of it in a second file, opened only when needed.
      else if (size > LONG_LINES) { body = `${num(n.start_line, n.start_line + SHORT_LINES - 1)}\n      … ${size - SHORT_LINES} more lines. The whole piece: ${fullName}`; wanted.set(fullName, `${head}${num(n.start_line, n.end_line)}\n`); }
      else body = num(n.start_line, n.end_line);
      wanted.set(snipPath(n.path, n.qname), `${head}${body}\n`);
    }
  } finally { db.close?.(); }
  // Write what changed, remove what's gone.
  const dir = path.join(root, SNIPS_DIR);
  const have = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => `.city/snips/${String(f).split(path.sep).join('/')}`).filter((f) => f.endsWith('.txt')) : [];
  for (const f of have) if (!wanted.has(f)) fs.rmSync(path.join(root, f));
  for (const [f, t] of wanted) {
    const full = path.join(root, f);
    let old = null;
    try { old = fs.readFileSync(full, 'utf8'); } catch { /* new */ }
    if (old !== t) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, t); }
  }
  return wanted.size;
}

// .city/names/<first two letters>.md: every piece by name, split by how it starts, so an AI that already knows
// what it is looking for ("what does pick do?") opens one tiny list instead of a whole area's map.
export async function nameIndex(root) {
  await buildIndex(root);
  const db = openDb(root);
  let rows;
  try {
    rows = db.prepare("SELECT name, qname, path, start_line, end_line FROM graph_nodes WHERE kind IN ('class', 'function', 'method') AND (end_line - start_line) >= 2 ORDER BY lower(name), path").all();
  } finally { db.close?.(); }
  const out = new Map();
  for (const r of rows) {
    const two = r.name.slice(0, 2).toLowerCase(), key = /^[a-z][a-z0-9_]$/.test(two) ? two : /^[a-z]/i.test(r.name) ? `${two[0]}_` : '_';
    const file = `.city/names/${key}.md`;
    if (!out.has(file)) out.set(file, [`# Names starting with "${key.replace('_', '')}"`, '', 'name · where · its own small file', '']);
    out.get(file).push(`- ${r.name}${r.qname !== r.name ? ` (${r.qname})` : ''} · ${r.path}:${r.start_line}-${r.end_line} · ${snipPath(r.path, r.qname)}`);
  }
  return new Map([...out].map(([f, l]) => [f, `${l.join('\n')}\n`]));
}
