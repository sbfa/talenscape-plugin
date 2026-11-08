// The project's map in memory: the lookups askcore.mjs needs, answered from a plain copy of the city
// database's map tables instead of SQLite. Cloudflare's answer link (worker/answers.mjs) runs `city ask`
// on it, so other AIs get the same answers Claude Code gets. Plain JavaScript, no Node.js parts.
//
// The copy (mapCopy in sync.mjs makes it at check-in): { nodes: [[...NODE_COLS]], edges: [[src, dst,
// kind, line]], snips: [[path, start_line, end_line, body]] }. Every lookup copies SQLite's: the same
// order (ties by id, as the database returns them), LIKE and NOCASE folding only A-Z, and the text search
// scored like FTS5's bm25 with the same tokens (letters, digits and _; case and accents folded).
export const NODE_COLS = ['id', 'kind', 'name', 'qname', 'path', 'start_line', 'end_line', 'parent', 'district', 'main', 'rank'];

const fold = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()); // SQLite's NOCASE and LIKE: A-Z only
const likeRe = (pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 's');
const byRank = (a, b) => b.rank - a.rank || a.id - b.id;
const tokensOf = (s) => (s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}\p{Co}_]+/gu) ?? []);

export function memMap({ nodes: rows, edges, snips }) {
  const nodes = rows.map((r) => Object.fromEntries(NODE_COLS.map((c, i) => [c, r[i]])));
  for (const n of nodes) n.folded = fold(n.name);
  const strip = ({ folded, ...n }) => n;
  const byId = new Map(nodes.map((n) => [n.id, n])), byPath = new Map(), byParent = new Map();
  for (const n of [...nodes].sort((a, b) => a.start_line - b.start_line || a.id - b.id)) {
    if (!byPath.has(n.path)) byPath.set(n.path, []);
    byPath.get(n.path).push(n);
    if (n.parent != null) { if (!byParent.has(n.parent)) byParent.set(n.parent, []); byParent.get(n.parent).push(n); }
  }
  const symbols = nodes.filter((n) => n.kind !== 'file').sort(byRank), files = nodes.filter((n) => n.kind === 'file').sort((a, b) => a.id - b.id);
  const into = new Map(), from = new Map();
  for (const [src, dst, kind, line] of edges) {
    for (const [m, k, other] of [[from, src, dst], [into, dst, src]]) { if (!m.has(k)) m.set(k, []); m.get(k).push({ ekind: kind, eline: line, other }); }
  }

  // Text search: each chunk's tokens, an index of token -> chunks (with counts), tokens sorted for prefixes.
  const docs = snips.map(([path, start_line, end_line, body]) => ({ path, start_line, end_line, body })), postings = new Map();
  let total = 0;
  docs.forEach((d, i) => {
    const toks = tokensOf(d.body);
    d.len = toks.length; total += toks.length;
    d.toks = toks;
    const counts = new Map();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([i, c]); }
  });
  const vocab = [...postings.keys()].sort(), avgdl = total / Math.max(1, docs.length);
  const withPrefix = (p) => { // every token starting with p
    let lo = 0, hi = vocab.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (vocab[mid] < p) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < vocab.length && vocab[i].startsWith(p); i++) out.push(vocab[i]);
    return out;
  };
  // One phrase ("send"* or a few tokens in a row, the last one a prefix): how often it occurs in each chunk.
  const phrase = (text) => {
    const toks = tokensOf(text), hits = new Map();
    if (!toks.length) return hits;
    if (toks.length === 1) {
      for (const t of withPrefix(toks[0])) for (const [i, c] of postings.get(t)) hits.set(i, (hits.get(i) ?? 0) + c);
      return hits;
    }
    const first = postings.get(toks[0]) ?? [];
    for (const [i] of first) {
      const dt = docs[i].toks;
      let c = 0;
      for (let k = 0; k + toks.length <= dt.length; k++) {
        if (toks.every((t, j) => (j === toks.length - 1 ? dt[k + j].startsWith(t) : dt[k + j] === t))) c++;
      }
      if (c) hits.set(i, c);
    }
    return hits;
  };
  // FTS5's bm25 (k1 1.2, b 0.75): the best chunks first, ties in the order they were stored.
  const fts = (match, limit) => {
    const and = !/ OR /.test(match), parts = match.split(and ? ' AND ' : ' OR ').map((p) => phrase(p.replace(/^"|"\*?$/g, '').replace(/""/g, '"')));
    const N = docs.length, idf = parts.map((h) => Math.max(1e-6, Math.log((N - h.size + 0.5) / (h.size + 0.5))));
    const found = new Set(parts.flatMap((h) => [...h.keys()]));
    const scored = [];
    for (const i of found) {
      if (and && !parts.every((h) => h.has(i))) continue;
      const d = docs[i];
      let score = 0;
      parts.forEach((h, k) => { const f = h.get(i) ?? 0; if (f) score += idf[k] * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avgdl)); });
      scored.push({ i, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map(({ i }) => ({ path: docs[i].path, start_line: docs[i].start_line, body: docs[i].body }));
  };

  // A file's lines, put back together from its chunks (each chunk: a header line, then its lines).
  const lines = new Map();
  for (const d of docs) {
    if (!lines.has(d.path)) lines.set(d.path, []);
    const arr = lines.get(d.path);
    d.body.split('\n').slice(1).forEach((t, k) => { arr[d.start_line + k - 1] = t; });
  }
  for (const d of docs) delete d.toks; // only needed while indexing

  const edgeRows = (list, limit) => (list ?? []).filter((e) => byId.has(e.other)).map((e) => ({ ekind: e.ekind, eline: e.eline, ...strip(byId.get(e.other)) }))
    .sort((a, b) => (a.ekind === 'mentions') - (b.ekind === 'mentions') || b.rank - a.rank || a.id - b.id).slice(0, limit);
  const map = {
    like: (w, limit) => { const re = likeRe(`%${fold(w)}%`); return symbols.filter((n) => re.test(n.folded)).slice(0, limit).map(strip); },
    byName: (v, limit) => { const f = fold(v); return symbols.filter((n) => n.folded === f).slice(0, limit).map(strip); },
    byFile: (v, limit) => { const f = fold(v), re = likeRe(`${f}.%`); return files.filter((n) => n.folded === f || re.test(n.folded)).slice(0, limit).map(strip); },
    enclosing: (p, line) => {
      const hit = (byPath.get(p) ?? []).filter((n) => n.start_line <= line && n.end_line >= line)
        .sort((a, b) => (a.kind === 'file') - (b.kind === 'file') || (a.end_line - a.start_line) - (b.end_line - b.start_line) || a.start_line - b.start_line || a.id - b.id)[0];
      return hit ? strip(hit) : undefined;
    },
    nextSymbol: (p, after, upTo) => { const n = (byPath.get(p) ?? []).find((x) => x.kind !== 'file' && x.start_line > after && x.start_line <= upTo); return n ? strip(n) : undefined; },
    fts,
    neighbours: (id, dir, limit) => edgeRows((dir === 'in' ? into : from).get(id), limit),
    node: (id) => (byId.has(id) ? strip(byId.get(id)) : undefined),
    topLevel: (p, id, limit) => {
      const file = files.find((f) => f.path === p);
      return file ? (byPath.get(p) ?? []).filter((n) => n.kind !== 'file' && n.parent === file.id && n.id !== id).slice(0, limit).map(strip) : [];
    },
    members: (id, limit) => (byParent.get(id) ?? []).filter((n) => ['method', 'function', 'class'].includes(n.kind)).slice(0, limit).map(strip),
  };
  return { map, lines: (p) => lines.get(p) ?? [] };
}
