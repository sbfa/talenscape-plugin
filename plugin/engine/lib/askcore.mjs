// The heart of `city ask` (and `city snip`'s body view): ranking pieces of code against a question and
// writing the short answer. Plain JavaScript with no Node.js parts, so the same code also runs on
// Cloudflare for the answer link other AIs use (worker/answers.mjs). It reads the map through
// src = { map, lines }: map answers the few lookups below (the city database here: query.mjs mapOf;
// the in-memory copy there: mapmem.mjs), lines(path) gives a file's lines.
import { tokens } from './tokens.mjs';

export const ABBR = { file: 'file', class: 'cls', function: 'fn', method: 'fn', skill: 'skill' };
export const MAX_LINE = 160;

export class Out {
  constructor(budget) { this.left = budget * 3.5; this.lines = []; }
  add(line) {
    if (line.length + 1 > this.left) return false;
    this.lines.push(line);
    this.left -= line.length + 1;
    return true;
  }
  toString() { return this.lines.join('\n'); }
}

export const clip = (s) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) + '…' : s);
export const loc = (n) => `${n.path}:${n.start_line}${n.end_line > n.start_line && n.kind !== 'file' ? '-' + n.end_line : ''}`;
export const at = (n, line) => (n.kind === 'file' ? `file ${n.path}:${line}` : `${label(n)} ${n.path}:${line}`);
export const label = (n) => `${ABBR[n.kind] ?? n.kind} ${n.kind === 'file' ? n.path : n.qname}`;
// Tests, examples and benchmarks rank lower unless the question is about them.
export const isSide = (p) => /(^|\/)(tests?|__tests__|spec|examples?|benchmarks?|test-?helpers?|fixtures?)\/|(^|\/)test_[^/]*$|\.(test|spec)\.[^/]+$/.test(p);
// Prose (docs, readmes, changelogs) ranks lower than code unless the question is about the docs.
export const isProse = (p) => /\.(md|mdx|rst|txt|adoc)$/i.test(p) || /(^|\/)docs?\//.test(p) || /(^|\/)(HISTORY|CHANGELOG|CHANGES|NEWS)(\.|$)/i.test(p);
export const langCode = (p) => /\.(m|c)?[jt]sx?$|\.py$/.test(p);
export const terms = (q) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? [])];
export const STOP = new Set('a an and are as at be by can do does for from how i in is it of on or show tell that the this to was what when where which who why with'.split(' '));
// Crude word stem so "matched", "matches" and "matching" all find "match".
export const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);
// Words of a name: sendFile / send_file / SendFile → ["send", "file"].
export const nameWords = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// The same word in another form: "confirm" / "confirmation", "color" / "colored". Only real word endings
// count ("string" / "stringify" are different words).
const ENDING = /^(ation|ations|ion|ions|ment|ments|ed|ing|ings|er|ers|s|es|al|ance|ence|ive|ly)$/;
export const sameWord = (a, b) => {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short) && ENDING.test(long.slice(short.length));
};
export const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;
// Programming words that name the same thing ("environment" / env). Local and fixed: no AI involved.
const SYNONYMS = [
  ['env', 'environment'], ['dict', 'dictionary', 'mapping'], ['serialize', 'serialise', 'dump'], ['deserialize', 'deserialise', 'load'],
  ['config', 'configuration', 'settings'], ['auth', 'authentication', 'authorization', 'login'], ['args', 'arguments', 'argv'], ['param', 'parameter', 'params'],
  ['err', 'error'], ['msg', 'message'], ['util', 'utility', 'helper'], ['init', 'initialize', 'initialise', 'setup'], ['repo', 'repository'],
  ['dir', 'directory', 'folder'], ['cmd', 'command'], ['opt', 'option'], ['str', 'string', 'text'], ['num', 'number'], ['req', 'request'],
  ['res', 'response', 'reply'], ['db', 'database'], ['simple', 'primitive', 'native', 'basic'], ['delete', 'remove', 'drop', 'strip'], ['create', 'make', 'new'],
  ['find', 'lookup', 'search', 'get'], ['check', 'validate', 'verify'], ['mistype', 'typo', 'similar'], ['alias', 'alternative', 'nickname'],
  ['post', 'after'], ['monitor', 'watch', 'watcher'],
];
const SYN = new Map();
for (const group of SYNONYMS) for (const w of group) SYN.set(stem(w), group.map(stem).filter((x) => x !== stem(w)));
export const synonymsOf = (stems) => [...new Set(stems.flatMap((w) => SYN.get(w) ?? []))].filter((x) => !stems.includes(x));
// Very common words in names ("function", "data", "value"): matching only these says little.
export const GENERIC = new Set('function func class object obj data value val item items type types field fields name names list result results info base thing'.split(' '));
export const TRIPLE = /("{3}|'{3})/;


export function ftsRows(map, words, limit, extra = []) {
  const run = (op, list = words) => map.fts(list.map((w) => `"${w.replace(/"/g, '')}"*`).join(op), limit); // prefix match: "match" finds "matched"
  // Chunks with every word first, then the best chunks with some of them (best match first), so one
  // chunk that happens to hold all the words can't hide the one that answers the question.
  const rows = run(' AND ');
  if (words.length > 1 && rows.length < limit) {
    const have = new Set(rows.map((r) => r.path + ':' + r.start_line));
    for (const r of run(' OR ', [...words, ...extra])) if (rows.length < limit && !have.has(r.path + ':' + r.start_line)) rows.push(r);
  }
  return rows;
}

export const neighbours = (map, id, dir, limit) => map.neighbours(id, dir, limit);

// ---------- ask: the one-shot answer (where + connections + the lines that matter) ----------

// Long symbols collect scattered word hits just by being long; damp their text score gently
// (no change up to 60 lines; a 300-line class counts about 60% as much).
export const lengthDamp = (n) => (n.kind === 'file' ? 1 : 1 + 0.35 * Math.log1p(Math.max(0, n.end_line - n.start_line + 1 - 60) / 60));

// Questions that ask for the code itself ("show …", "implementation of …") get the top hit's full body
// straight away, saving the follow-up call (query-type levels).
export const WANTS_BODY = /^\s*(show( me)?( the)?|code (of|for)|implementation of|source (of|for)|body of)\b\s*/i;
export function askCore(src, query, budget = 300) {
  const wantsBody = WANTS_BODY.test(query);
  if (wantsBody) query = query.replace(WANTS_BODY, '').replace(/\b(code|implementation|function|body)\b/gi, ' ');
  const { map } = src;
  {
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
    const like = { all: (w) => map.like(w, 40) };
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
        // A name that is just one word of a longer question ("body" for "where is the response body
        // written") says little on its own: half weight, so code that matches the question wins.
        const lone = hit.length === 1 && words.length >= 3 ? 0.5 : 1;
        if (covered > 1 || ownAll) bump(n, lone * (5 * covered + (ownAll ? 5 * Math.min(1, 2 / words.length) : 0)));
      }
    }
    const byName = { all: (v) => map.byName(v, 6) };
    // A one-word question that is exactly a name ("editDistance", "_run_validator") means that thing.
    // A name the question spells out (whole, or two words glued) is the thing asked for, even when
    // its code doesn't repeat the words.
    const spelled = (n) => { cands.get(n.id).exact = true; };
    if (all.length === 1) for (const n of byName.all(query.trim())) { bump(n, 40); spelled(n); }
    const byFile = { all: (v) => map.byFile(v, 3) };
    for (const [v, weight] of variants) {
      if (v.length < 3) continue;
      for (const n of byName.all(v)) {
        // Prefer names whose own words are exactly the query words (sendFile over sendfile).
        const exact = nameWords(n.name).join('') === v.replace(/_/g, '') && nameWords(n.name).length === weight;
        bump(n, 10 * weight + (exact ? 3 : 0));
        spelled(n);
      }
      for (const n of byFile.all(v)) bump(n, 4 * weight);
    }

    // 2. Text: search hits, credited to the smallest symbol around each matching line.
    const enclosing = { get: (p, l) => map.enclosing(p, l) }, nextSymbol = { get: (p, a, b) => map.nextSymbol(p, a, b) };
    ftsRows(map, stems, 25, syns).forEach((row, i) => {
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
        } else if (n && n.kind !== 'file' && lineNo <= n.start_line + 12 && inDocstring(src.lines, n, lineNo)) doc = true;
        if (n) bump(n, hits * weight * (n.kind === 'file' && langCode(n.path) ? 0.4 : 1) * (doc ? 1.6 : 1), lineNo);
      });
    });
    if (!cands.size) return 'No matches.';

    // Two pieces with the same name (Email in fields.py and in validate.py): the one in a file named
    // after a question word ("validate an email") fits better. Only a word the name doesn't already have counts.
    const sameName = new Map();
    for (const c of cands.values()) sameName.set(c.node.name, (sameName.get(c.node.name) ?? 0) + 1);
    const inFileNamed = (n) => n.kind !== 'file' && sameName.get(n.name) > 1 && nameWords(n.path.split('/').pop().replace(/\.[^.]+$/, '')).map(stem)
      .some((x) => !GENERIC.has(x) && x.length > 2 && stems.includes(x) && !nameWords(n.qname).map(stem).includes(x));
    const aboutTypes = stems.some((w) => /^(type|interfac|declar|signatur)/.test(w));
    const aboutSide = stems.some((w) => /^(test|exampl|benchmark|spec)/.test(w));
    const aboutDocs = stems.some((w) => /^(doc|readm|guid|changelog|histor|tutorial|explain)/.test(w));
    const ranked = [...cands.values()]
      .map((c) => ({ ...c, score: (c.name + Math.sqrt(c.text) * 2 / lengthDamp(c.node) + Math.log1p(c.node.rank) * 0.5) * (!aboutSide && isSide(c.node.path) ? 0.5 : 1) * (!aboutDocs && isProse(c.node.path) ? 0.45 : 1) * (inFileNamed(c.node) ? 1.25 : 1) * (!aboutTypes && /\.d\.[cm]?ts$/.test(c.node.path) ? 0.5 : 1) * (c.text === 0 && !c.exact ? 0.6 : 1) })) // a name with nothing in its code about the question counts for less
      .sort((a, b) => b.score - a.score);
    // TALENSCAPE_DEBUG=1: why each of the top candidates scored what it did.
    if (globalThis.process?.env?.TALENSCAPE_DEBUG) for (const c of ranked.slice(0, 6)) console.error(`${c.score.toFixed(1)} name ${c.name.toFixed(1)} text ${c.text.toFixed(1)} rank ${c.node.rank.toExponential(1)} ${c.node.qname} ${c.node.path}:${c.node.start_line}`);
    if (wantsBody && ranked[0].node.kind !== 'file') {
      const others = ranked.slice(1, 4).map((c) => `${label(c.node)} ${loc(c.node)}`).join(' · ');
      // Asked for the code itself: give it room (up to 600 tokens), still well under reading the file.
      return compressPaths(snipNode(map, src.lines, ranked[0].node, Math.max(budget, 600), 'body') + (others ? `\nalso: ${others}` : ''));
    }
    return render(map, src.lines, ranked, budget);
  }
}

export const UNSURE_LEAD = 1.35;
export function render(map, linesOf, ranked, budget) {
  const out = new Out(budget);
  const [top, ...rest] = ranked;
  const n = top.node;
  out.add(`${label(n)} ${loc(n)}`);
  if (n.kind !== 'file') {
    const ins = neighbours(map, n.id, 'in', 4);
    const outs = neighbours(map, n.id, 'out', 6);
    if (ins.length) out.add(clip(' <- ' + ins.map((e) => `${e.ekind} ${at(e, e.eline)}`).join(' | ')));
    if (outs.length) out.add(clip(' → ' + outs.map((e) => `${e.ekind === 'calls' ? '' : e.ekind + ' '}${e.kind === 'file' ? e.path : e.qname}`).join(', ')));
  }

  // Reserve room for the "also" line before spending the rest on code.
  const also = rest.slice(0, 4).map((c) => at(c.node, [...c.lines][0] ?? c.node.start_line));
  // A close race means a shaky first pick: measured on the scoreboard sets, a lead under 35% was wrong
  // about 4 times in 10, a bigger one less than 1 in 10. Saying so lets the AI check these first
  // instead of reading whole files, and trust the sure answers.
  const unsure = rest.length && top.score < rest[0].score * UNSURE_LEAD;
  const alsoLine = also.length ? `${unsure ? 'unsure, also check' : 'also'}: ` + also.join(' · ') : '';
  out.left -= alsoLine.length + 1;

  const lines = linesOf(n.path);
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
export const PATH_RE = /(?<![\w@/.-])((?:[\w.-]+\/){2,})[\w.-]+/g;
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export const SNIP_LONG = 40;

export function snipNode(map, linesOf, n, budget, level) {
  {
    const lines = linesOf(n.path);
    const length = n.end_line - n.start_line + 1;
    const lv = level === 'auto' ? (n.kind === 'class' || length > SNIP_LONG ? 'sig' : 'body') : level;
    const out = new Out(budget);
    out.add(`${label(n)} ${loc(n)}${lv === 'sig' ? ` (${length} lines)` : ''}`);
    if (lv === 'sig') {
      for (const l of [...docAbove(lines, n.start_line), ...signature(lines, n.start_line, n.end_line)]) out.add(clip(`${l} ${lines[l - 1].trimEnd()}`));
      if (n.kind === 'class') for (const m of members(map, n)) if (!out.add(clip(`  ${m.start_line} ${lines[m.start_line - 1].trim()}`))) break;
      out.add(`  more: snip ${n.qname} --body | --context`);
      return out.toString();
    }
    if (lv === 'context') {
      const parent = map.node(n.parent);
      if (parent && parent.kind !== 'file') {
        out.add(`in ${label(parent)} ${loc(parent)}:`);
        for (const l of signature(lines, parent.start_line, parent.end_line)) out.add(clip(`${l} ${lines[l - 1].trimEnd()}`));
        for (const m of members(map, parent)) if (m.id !== n.id && !out.add(clip(`  ${m.start_line} ${lines[m.start_line - 1].trim()}`))) break;
      } else {
        const top = map.topLevel(n.path, n.id, 12);
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
export function docRange(lines, n) {
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
export function inDocstring(linesOf, n, lineNo) {
  if (!n.path.endsWith('.py')) return false;
  const lines = linesOf(n.path);
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
export function docAbove(lines, start) {
  const out = [];
  for (let l = start - 1; l >= 1 && out.length < 6; l--) {
    const t = lines[l - 1]?.trim() ?? '';
    if (/^(\/\/|\/\*|\*|#(?!!)|@)/.test(t)) out.unshift(l); else break;
  }
  return out;
}
// The signature lines (to the opening brace or colon), then a Python docstring if there is one.
export function signature(lines, start, end) {
  const out = [];
  let l = start;
  for (; l <= Math.min(end, start + 3); l++) { out.push(l); if (/[{:]\s*(\/\/.*)?$|=>\s*\S/.test(lines[l - 1] ?? '')) break; }
  const next = lines[l]?.trim() ?? '';
  if (/^("""|\'\'\')/.test(next)) {
    for (let k = l + 1; k <= Math.min(end, l + 6); k++) { out.push(k); if (k > l + 1 && /("""|\'\'\')/.test(lines[k - 1]) || /^("""|\'\'\').*("""|\'\'\')\s*$/.test(lines[k - 1].trim())) break; }
  }
  return out;
}
export const members = (map, parent) => map.members(parent.id, 30);
