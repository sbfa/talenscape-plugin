// The company catalog: what each of the owner's projects is, where it stands and where it lives, made from
// each project's own files (never written by hand), so any AI finds the right project and file cheaply.
//   .city/catalog/COMPANY.md   one short entry per project (read when a question spans projects)
//   .city/catalog/<name>.md    that project's key files: what each holds, its web addresses
//   .city/catalog/stamps.json  the version each entry was read from (city catalog check: what changed since)
// The projects are listed in .city/catalog/projects.json (folders relative to this project): add them with
// `city catalog add <folder>…`, then `city catalog` builds the files. The projects stay the source of
// truth: a fact is fixed in its project, then the catalog is rebuilt.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { SECRET_RE } from './skill-rules.mjs';
import { tokens } from './tokens.mjs';
import * as notesLib from './notes.mjs';
import { langOf } from './files.mjs';

export const CATALOG_DIR = path.join('.city', 'catalog');
const STATUS_FILES = ['HANDOFF.md', '.city/HANDOFF.md', 'STATUS.md'];
const KEY_NAMES = /^(readme|claude|handoff|status|agents|notes-for-claude)\.md$/i;
const SKIP_URL = /(fonts\.(googleapis|gstatic)|w3\.org|localhost|127\.0\.0\.1|example\.(com|org)|schema\.org|claude\.(ai|com)|anthropic\.com|npmjs\.(com|org))/;
const GENERIC = new Set(['workers.dev', 'pages.dev', 'github.com', 'tally.so', 'cloudflare.com']); // only with a path
const MAX_FILES = 40; // per project card
export const SMALL = 3500; // chars (~1,000 tokens): a file this small is cheaper to open whole than to search
export const BIG = 12000; // chars: a file this big is also cut into section files, for AIs that can only fetch whole files
const PIECE = 6000; // chars: the most one section file holds
export const WORTH_IT = 35000; // chars of key files across all projects: below this, opening files beats a catalog
const MAX_NOTS = 8; // "not true any more" lines in the company file

const git = (cwd, ...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).trim(); } catch { return ''; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const clean = (s) => s.replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
const safe = (text) => text.split('\n').filter((l) => !SECRET_RE.test(l)).join('\n');

// projects.json: { projects: [{ name, path }], consent: 'yes' | 'no', share: true | false }. consent is the
// owner's one answer to "include your other projects?"; share whether the catalog is saved to git, where the
// project's other AIs read it (it copies summaries and pieces of the other projects, so it stays on this
// computer unless the owner says yes). A list made before these two answers existed counts as yes to both.
export function readConfig(root) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(root, CATALOG_DIR, 'projects.json'), 'utf8')); } catch { /* none yet */ }
  const projects = c.projects ?? [];
  const legacy = c.consent === undefined && projects.length > 0;
  return { projects, consent: legacy ? 'yes' : c.consent, share: legacy ? true : !!c.share };
}
export const readProjects = (root) => readConfig(root).projects;
export function saveConfig(root, config) {
  const dir = path.join(root, CATALOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects: config.projects, consent: config.consent, share: config.share }, null, 2) + '\n');
  // Not shared: everything in the catalog folder stays out of git (on this computer only).
  const ignore = path.join(dir, '.gitignore');
  if (config.share) fs.rmSync(ignore, { force: true });
  else fs.writeFileSync(ignore, '# Kept on this computer: switch on sharing in the city\'s Setup card (or city catalog share on) to save it for your other AIs\n*\n');
}
const saveProjects = (root, projects) => saveConfig(root, { ...readConfig(root), projects });

// The owner's other projects: git folders next to this one (on a computer, the folder they keep projects in;
// in a cloud session, the other repositories attached to it). Hidden folders are skipped.
export function discover(root) {
  const parent = path.dirname(path.resolve(root));
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return []; }
  return names.filter((n) => !n.startsWith('.')).map((n) => path.join(parent, n))
    .filter((d) => path.resolve(d) !== path.resolve(root) && fs.existsSync(path.join(d, '.git')));
}

// Other projects are included by themselves only where that makes sense: not beside the home folder or in the
// system's temp folder, and not when the folder holds more projects than anyone keeps by hand.
export const MAX_AUTO = 25;
export function autoIncludes(root, found = discover(root)) {
  const parent = path.resolve(path.dirname(path.resolve(root)));
  return found.length > 0 && found.length <= MAX_AUTO && ![os.homedir(), os.tmpdir()].map((d) => path.resolve(d)).includes(parent);
}

// Builds the catalog in a process of its own, so a chat never waits for it (the next chat uses it). One at a time.
function buildInBackground(root) {
  const lock = path.join(root, CATALOG_DIR, '.building');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60e3) return; } catch { /* not building */ }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  spawn(process.execPath, ['--no-warnings', '-e', `const fs=require('fs');import(${JSON.stringify(new URL('./catalog.mjs', import.meta.url).href)}).then((c)=>c.build(${JSON.stringify(root)})).finally(()=>fs.rmSync(${JSON.stringify(lock)},{force:true}))`], { cwd: root, detached: true, stdio: 'ignore' }).unref();
}

// At the start of each chat: new projects are added and the catalog is rebuilt when any project changed. With
// { background: true } (chat start) the building happens in its own process and this returns at once. Quiet.
export async function autoCatalog(root, { background = false } = {}) {
  const config = readConfig(root), found = discover(root);
  const known = new Set(config.projects.map((p) => path.resolve(root, p.path)));
  const names = new Set(config.projects.map((p) => p.name)); // the same project in a folder spelt another way is not new
  const fresh = found.filter((d) => !known.has(path.resolve(d))).filter((d) => !names.has(projectName(d))); // git asked only about folders not listed
  // No answer yet: other projects are included, kept on this computer (the Setup card in the city can switch it
  // off, or share it with the other AIs); nobody is asked in chat.
  if (!config.consent) { if (!autoIncludes(root, found)) return {}; config.consent = 'yes'; config.share = false; saveConfig(root, config); }
  if (config.consent !== 'yes') return {};
  if (fresh.length) {
    if (!known.has(path.resolve(root))) config.projects.unshift({ name: projectName(root), path: '.' });
    for (const d of fresh) config.projects.push({ name: projectName(d), path: path.relative(root, d) || '.' });
    saveConfig(root, config);
  }
  const built = fs.existsSync(path.join(root, CATALOG_DIR, 'COMPANY.md'));
  if (!fresh.length && built && !stale(root).length) return {};
  const total = config.projects.reduce((n, p) => { const dir = path.resolve(root, p.path); return fs.existsSync(dir) ? n + keyFiles(dir).reduce((m, f) => m + read(dir, f).length, 0) : n; }, 0);
  if (total < WORTH_IT) return {};
  if (background) { buildInBackground(root); return { building: config.projects.length, added: fresh.map((d) => projectName(d)) }; }
  await build(root);
  return { built: config.projects.length, added: fresh.map((d) => projectName(d)) };
}
export function projectName(dir) {
  const url = git(dir, 'remote', 'get-url', 'origin');
  return (url.match(/([^/:]+?)(\.git)?$/)?.[1] ?? path.basename(path.resolve(dir))).toLowerCase();
}

// The files worth pointing at: the top folder's notes and pages, docs/, status files one folder down,
// and the library (shared/notes/). Saved files only (git), never node_modules or builds.
function keyFiles(dir) {
  const all = git(dir, 'ls-files').split('\n').filter(Boolean);
  const files = all.length ? all : fs.readdirSync(dir);
  const pick = files.filter((f) => {
    const parts = f.split('/'), base = parts.at(-1);
    if (parts.length === 1) return /\.(md|html|txt)$/i.test(base) && !/^(license|security)/i.test(base);
    if (parts[0] === 'docs' && parts.length === 2) return /\.md$/i.test(base);
    if (parts.length === 2) return KEY_NAMES.test(base);
    return f.startsWith('shared/notes/') && parts.length === 3 && /\.md$/i.test(base) && !/^readme\.md$/i.test(base);
  });
  const rank = (f) => (KEY_NAMES.test(path.basename(f)) && !f.includes('/') ? 0 : !f.includes('/') ? 1 : f.startsWith('docs/') ? 2 : f.startsWith('shared/') ? 4 : 3);
  return pick.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_FILES);
}

function replacedNotes(dir) {
  if (!fs.existsSync(path.join(dir, 'shared', 'notes'))) return [];
  const { readNotes, resolve } = notesLib;
  return [...resolve(readNotes(dir)).dead].map(([old, by]) => ({ old, by }));
}

const read = (dir, f) => { try { return safe(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return ''; } };

export function urlsIn(text) {
  const seen = new Map();
  for (const m of text.matchAll(/(?<![\w.@-])(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|app|dev|io|so|co|ai|net|org)(?:\/[\w\-./]*[\w/])?)/gi)) {
    const u = m[1].replace(/\/$/, '').replace(/^www\./, '').toLowerCase();
    if (SKIP_URL.test(u) || GENERIC.has(u.split('/')[0]) && !u.includes('/') || /\.(md|js|mjs|json|html|css|png|jpg)$/.test(u)) continue;
    seen.set(u, (seen.get(u) ?? 0) + 1);
  }
  return [...seen].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([u]) => u);
}

// What a file holds, in one line: its title and section headings (HTML: <title> and <h1>/<h2>).
function describe(text, file) {
  if (/\.html$/i.test(file)) {
    const title = text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
    const heads = [...text.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, ' '));
    return clean([title, ...heads].filter(Boolean).join(' · '));
  }
  const heads = [...text.matchAll(/^#{1,2}\s+(.+)$/gm)].map((m) => m[1]);
  return clean((heads.length ? heads : [text.split('\n').find((l) => l.trim()) ?? '']).join(' · '));
}

// The first real paragraph (not a heading, list or table), for "what is it". A section titled "What this is"
// (or "What is here") wins over the opening lines, which are often about the owner rather than the project.
function firstParagraph(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const what = body.split(/^##\s+/m).slice(1).find((sec) => /^what (this|it) is|^what is here/i.test(sec));
  for (const para of (what ? what.split('\n').slice(1).join('\n') : body).split(/\n\s*\n/)) {
    const p = para.split('\n').filter((l) => !/^#/.test(l.trim())).join('\n').trim();
    if (!p || /^(\||```|<|-{3})/.test(p) || /^this file provides guidance/i.test(p)) continue;
    return clean(p.replace(/^[-*]\s+/gm, ''));
  }
  return '';
}

// Where it stands: the first status-like section of the handoff (or the summary's NOW line).
function status(dir) {
  const blink = read(dir, '.city/BLINK.md').match(/^NOW:\s*(.+)$/m)?.[1];
  if (blink) return { text: clean(blink), file: '.city/BLINK.md' };
  for (const f of [...STATUS_FILES, ...keyFiles(dir).filter((x) => /\/status\.md$/i.test(x))]) {
    const text = read(dir, f);
    if (!text) continue;
    const parts = text.split(/^##\s+/m).slice(1);
    const sec = parts.find((s) => /status|stand|left off|current|session|now/i.test(s.split('\n')[0])) ?? parts[0];
    if (!sec) return { text: clean(firstParagraph(text)), file: f };
    const [head, ...rest] = sec.split('\n');
    const line = rest.map((l) => l.trim()).find((l) => l && !/^(\||```|#)/.test(l)) ?? '';
    const lead = /session|\d{4}-\d{2}-\d{2}/i.test(head) ? `${clean(head)}: ` : '';
    return { text: clean(lead + line.replace(/^[-*]\s+/, '')), file: f };
  }
  return { text: 'no status file', file: '' };
}

// A big file cut into sections at its headings (a page: its text only, no code), each at most PIECE chars,
// with the lines it came from. For AIs that read files whole from GitHub: they fetch one small section
// instead of the whole file. [{ title, from, to, text }]
export function sections(text, file) {
  let lines;
  if (/\.html?$/i.test(file)) {
    const plain = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_, h) => `\n## ${h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`)
      .replace(/<(br|\/p|\/li|\/div|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/&[a-z]+;/g, ' ');
    lines = plain.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] ?? '') !== '');
  } else lines = text.split('\n');
  const html = /\.html?$/i.test(file), out = [];
  let cur = null;
  const flush = () => { if (cur && cur.text.trim()) out.push(cur); };
  lines.forEach((l, i) => {
    const head = l.match(/^#{1,3}\s+(.+)/);
    if (!cur || (head && cur.text.length >= 1500) || cur.text.length + l.length > PIECE) {
      flush();
      cur = { title: head ? clean(head[1]) : null, under: head ? clean(head[1]) : out.at(-1)?.under ?? cur?.under ?? path.basename(file), from: i + 1, to: i + 1, text: '' };
    }
    cur.text += `${l}\n`;
    cur.to = i + 1;
  });
  flush();
  // A piece that starts mid-section is named by its section and its own first line, so the index tells pieces apart.
  for (const sec of out) sec.title ??= `${sec.under} — ${clip(clean(sec.text.split('\n').find((l) => l.trim()) ?? ''), 70)}`;
  return out.map(({ under, ...sec }) => (html ? { ...sec, from: null, to: null } : sec));
}
// Big code files cut into pieces at their top-level functions and classes (Tree-sitter, run locally), each piece
// at most PIECE chars, small neighbours packed together, a piece too big for one file split by lines. For AIs
// that can only fetch whole files: they find the name in the index and fetch one piece. Tests are left out
// (rarely asked about), and so are bundled, minified and vendored files. [{ names, from, to, text }]
const CODE_SKIP = /(^|\/)(\.[^/]+|vendor|dist|build|node_modules|tests?|__tests__)\/|\.(min|test|spec)\.|-check\.mjs$/;
export async function cutCode(text, file) {
  const lang = langOf(file);
  if (!['js', 'ts', 'tsx', 'py'].includes(lang)) return null;
  const { parseFile } = await import('./parse.mjs');
  let symbols;
  try { ({ symbols } = await parseFile(lang, text)); } catch { return null; }
  const lines = text.split('\n'), tops = symbols.filter((x) => x.parent === -1).sort((a, b) => a.start - b.start);
  const segs = []; // each top-level piece with the loose lines (imports, constants, comments) just above it
  let next = 1;
  for (const t of tops) {
    if (t.end < next) continue;
    segs.push({ names: [t.name], from: next, to: t.end });
    next = t.end + 1;
  }
  if (next <= lines.length) segs.push({ names: [], from: next, to: lines.length });
  const size = (g) => lines.slice(g.from - 1, g.to).join('\n').length + 1;
  const out = [];
  for (const g of segs) {
    if (size(g) > PIECE) { // one huge function (or data): cut by lines
      let from = g.from;
      while (from <= g.to) {
        let to = from, len = 0;
        while (to <= g.to && (len + lines[to - 1].length + 1 <= PIECE || to === from)) len += lines[to++ - 1].length + 1;
        out.push({ names: from === g.from ? g.names : g.names.map((n) => `${n} (cont.)`), from, to: to - 1 });
        from = to;
      }
      continue;
    }
    const last = out.at(-1);
    if (last && !last.big && size({ from: last.from, to: g.to }) <= PIECE) { last.names.push(...g.names); last.to = g.to; }
    else out.push({ names: [...g.names], from: g.from, to: g.to });
  }
  return out.map((c) => ({ ...c, text: lines.slice(c.from - 1, c.to).join('\n') + '\n' }));
}
async function codePieces(dir) {
  const files = git(dir, 'ls-files').split('\n').filter((f) => f && ['js', 'ts', 'tsx', 'py'].includes(langOf(f)) && !CODE_SKIP.test(f));
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (text.length < BIG || text.length > 2_000_000) continue;
    const pieces = await cutCode(safe(text), f);
    if (pieces?.length) out.push({ file: f, chars: text.length, pieces });
  }
  return out;
}

const pieceDir = (name, file) => path.join(CATALOG_DIR, name, file.replace(/\//g, '__'));

// "Not true any more" lines: a section in the project's own files titled "Not true", "Ruled out", "No longer"
// or "Retired" (one line per item), plus notes the library's headers mark as replaced. The project keeps them;
// the catalog only copies them, so a dead fact is fixed in one place.
function nots(dir, files) {
  const out = [];
  for (const f of files.filter((x) => /\.md$/i.test(x) && !x.startsWith('shared/notes/'))) {
    for (const sec of read(dir, f).split(/^##\s+/m).slice(1)) {
      if (!/^(not true|ruled out|no longer|retired|dead facts)/i.test(sec)) continue;
      for (const l of sec.split('\n').slice(1)) if (/^\s*[-*]\s+\S/.test(l)) out.push({ text: clean(l.replace(/^\s*[-*]\s+/, '')), file: f });
    }
  }
  return out;
}

export function scanProject(dir, name = projectName(dir)) {
  const files = keyFiles(dir);
  const readme = files.find((f) => /^readme\.md$/i.test(f)), guide = files.find((f) => /^claude\.md$/i.test(f));
  const what = firstParagraph(read(dir, readme ?? '')) || firstParagraph(read(dir, guide ?? '')) || describe(read(dir, files[0] ?? ''), files[0] ?? '');
  const st = status(dir);
  const named = new Set(urlsIn(what));
  const urls = urlsIn([readme, guide, ...STATUS_FILES].filter(Boolean).map((f) => read(dir, f)).join('\n')).sort((a, b) => named.has(b) - named.has(a));
  const head = git(dir, 'rev-parse', '--short', 'HEAD') || 'no git', date = git(dir, 'log', '-1', '--format=%cs') || '';
  const entries = files.map((f) => {
    const text = read(dir, f);
    return { file: f, chars: text.length, about: describe(text, f), urls: urlsIn(text).slice(0, 4), changed: git(dir, 'log', '-1', '--format=%h', '--', f) || '', pieces: text.length >= BIG && /\.(md|txt|html?)$/i.test(f) ? sections(text, f) : null };
  });
  return { name, what, status: st, urls, head, date, entries, nots: nots(dir, files), replaced: replacedNotes(dir) };
}

// The words a project's files are about (file names and headings, most used first): lets a reader tell
// which project a question is about without opening every card.
const COMMON = new Set('the and for with from this that what how you your our its are was not all new one two part more page file files notes note session sessions claude muse grok gemini owner readme handoff md html test tests done next last update updated plan into about only when where here have has use used out them they then than show shows each make made also just can will some any per get see run did does doing still keep added add help working work like into over under now day'.split(' '));
export function topics(s, n = 12) {
  const out = [];
  const add = (w) => { if (w && !out.includes(w) && out.length < n) out.push(w); };
  const generic = /^(readme|claude|handoff|index|agents|status|gemini|license|security|notes-for-[a-z]+|start-here.*|package)$/i;
  for (const e of s.entries) { // folder and file names first: they say most about what lives where
    if (e.file.startsWith('shared/notes/')) continue;
    const parts = e.file.replace(/\.[a-z]+$/i, '').split('/');
    for (const p of parts) if (!generic.test(p) && p !== 'docs') add(p.toLowerCase().replace(/\s+/g, '-'));
  }
  const count = new Map();
  for (const e of s.entries) {
    for (const w of new Set(e.about.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [])) if (!COMMON.has(w) && !s.name.split('-').includes(w)) count.set(w, (count.get(w) ?? 0) + 1);
  }
  for (const [w] of [...count].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) add(w);
  return out;
}

// kept: lines from the last company file for projects not on this computer, so they aren't dropped. order: project names.
export function companyFile(scans, kept = { lines: [], nots: [] }, order = []) {
  const lines = [
    '# Company catalog: every project in one place',
    '',
    'Made from each project\'s own files by `city catalog`; don\'t edit (fix the project, then rebuild).',
    'An exact word (a price, ID, address, name)? Search for it first (`city catalog find <words>`). No search, vague,',
    'or about another project? Find the project here, open its card (`.city/catalog/<project>.md`), then open only',
    'the small file or the one section it points to (a big file with no sections: open it whole).',
    'Asked what something is or is called? Check the file the search or card names before answering.',
    '',
  ];
  const entries = [...scans.map((s) => {
    const small = s.entries.length && s.entries.every((e) => e.chars < SMALL);
    return { name: s.name, line: `- **${s.name}**: ${clip(s.what, 70)}${s.urls[0] ? ` At ${s.urls[0]}.` : ''} ${small ? `Small: open ${s.entries.map((e) => e.file).join(', ')}.` : `Topics: ${topics(s, 7).join(', ')}.`}` };
  }), ...kept.lines];
  const at = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  lines.push(...entries.sort((a, b) => at(a.name) - at(b.name)).map((e) => e.line));
  const nots = [...scans.flatMap((s) => s.nots.map((n) => `- ${clip(n.text, 120)} (${s.name}/${n.file})`)), ...kept.nots];
  if (nots.length) lines.push('', 'Not true any more (the live fact is in the file named):', ...nots.slice(0, MAX_NOTS), ...(nots.length > MAX_NOTS ? [`- …${nots.length - MAX_NOTS} more on the project cards`] : []));
  return lines.join('\n') + '\n';
}

export function projectFile(s) {
  const lines = [
    `# ${s.name}: key files`,
    '',
    // This card is saved inside the project it describes: naming the latest commit (or copying where things stand)
    // would change it after every save, so it names neither.
    `Made from ${s.self ? 'this project\'s files as saved alongside this card' : `the project at ${s.head} (${s.date})`} by \`city catalog\`; don't edit. What it is: ${clip(s.what, 300)}`,
    s.self ? 'Now: where things stand is in .city/BLINK.md' : `Now (${s.status.file || 'none'}): ${clip(s.status.text, 300)}`,
    s.urls.length ? `Web addresses: ${s.urls.slice(0, 8).join(', ')}` : 'Web addresses: none found',
    '',
  ];
  for (const e of s.entries) {
    lines.push(`- ${e.file} (${e.chars < SMALL ? 'small: open it whole' : `${Math.round(e.chars / 1000)}k chars: ${e.pieces ? `read only the section you need: ${pieceDir(s.name, e.file).split(path.sep).join('/')}/INDEX.md, or search it` : 'search it, or open it whole if you can\'t search'}`}): ${clip(e.about, 160) || '(no headings)'}${e.urls.length ? ` · ${e.urls.join(', ')}` : ''}`);
  }
  if (s.code?.length) lines.push('', 'Big code files, cut into pieces at their functions (find the name in the index, fetch one piece):',
    ...s.code.map((c) => `- ${c.file} (${Math.round(c.chars / 1000)}k chars): ${pieceDir(s.name, c.file).split(path.sep).join('/')}/INDEX.md`));
  if (s.nots.length) lines.push('', 'Not true any more:', ...s.nots.map((n) => `- ${clip(n.text, 200)} (${n.file})`));
  if (s.replaced.length) lines.push('', `Replaced notes (skip them): ${s.replaced.map((r) => `${r.old} (by ${r.by})`).join('; ')}`);
  return lines.join('\n') + '\n';
}

export async function build(root) {
  const projects = readProjects(root), dir = path.join(root, CATALOG_DIR), stamps = {}, scans = [], missing = [];
  for (const p of projects) {
    const folder = path.resolve(root, p.path);
    if (!fs.existsSync(folder)) { missing.push(p.name); continue; }
    const s = scanProject(folder, p.name);
    s.self = path.resolve(folder) === path.resolve(root);
    // This project's own code already has its pieces (.city/snips); the others' big code files get them here.
    s.code = s.self ? [] : await codePieces(folder);
    scans.push(s);
    if (!s.self) stamps[s.name] = { head: s.head, files: Object.fromEntries(s.entries.map((e) => [e.file, e.changed])) }; // this project's own card is rebuilt with its saves
  }
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(['projects.json', 'stamps.json', 'COMPANY.md', '.gitignore', ...scans.map((s) => `${s.name}.md`)]);
  for (const s of scans) keep.add(s.name); // its folder of sections
  for (const f of fs.readdirSync(dir)) if (!keep.has(f) && !missing.some((m) => f === `${m}.md` || f === m)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  const was = (() => { try { return fs.readFileSync(path.join(dir, 'COMPANY.md'), 'utf8').split('\n'); } catch { return []; } })();
  const kept = {
    lines: missing.flatMap((m) => was.filter((l) => l.startsWith(`- **${m}**: `)).map((line) => ({ name: m, line }))),
    nots: was.filter((l) => !l.startsWith('- **') && missing.some((m) => new RegExp(` \\(${m.replace(/[^\w-]/g, '\\$&')}/[^)]*\\)$`).test(l))), // its "not true any more" lines
  };
  fs.writeFileSync(path.join(dir, 'COMPANY.md'), companyFile(scans, kept, projects.map((p) => p.name)));
  for (const s of scans) {
    fs.writeFileSync(path.join(dir, `${s.name}.md`), projectFile(s));
    fs.rmSync(path.join(dir, s.name), { recursive: true, force: true });
    for (const e of s.entries.filter((x) => x.pieces)) {
      const pd = path.join(root, pieceDir(s.name, e.file)), n = e.pieces.length, at = (sec) => (sec.from ? ` (lines ${sec.from}-${sec.to})` : '');
      fs.mkdirSync(pd, { recursive: true });
      e.pieces.forEach((sec, i) => fs.writeFileSync(path.join(pd, `${String(i + 1).padStart(2, '0')}.md`), `${s.name}/${e.file}, section ${i + 1} of ${n}${at(sec)}: ${sec.title}\n\n${sec.text}`));
      fs.writeFileSync(path.join(pd, 'INDEX.md'), [`# ${s.name}/${e.file}: its sections`, '', `Made from ${s.name} at ${s.head} by \`city catalog\`; don't edit. Fetch only the section you need.`, '',
        ...e.pieces.map((sec, i) => `- ${String(i + 1).padStart(2, '0')}.md: ${clip(sec.title, 90)}${at(sec)}, ~${Math.ceil(sec.text.length / 3500)}k tokens`)].join('\n') + '\n');
    }
    for (const c of s.code) {
      const pd = path.join(root, pieceDir(s.name, c.file)), n = c.pieces.length, pad = (i) => String(i + 1).padStart(String(n).length, '0');
      fs.mkdirSync(pd, { recursive: true });
      c.pieces.forEach((p, i) => fs.writeFileSync(path.join(pd, `${pad(i)}.txt`), `${s.name}/${c.file}, piece ${i + 1} of ${n} (lines ${p.from}-${p.to})${p.names.length ? `: ${p.names.join(', ')}` : ''}\n\n${p.text}`));
      fs.writeFileSync(path.join(pd, 'INDEX.md'), [`# ${s.name}/${c.file}: its pieces`, '', `Made from ${s.name} at ${s.head} by \`city catalog\`; don't edit. Find the name, fetch only that piece.`, '',
        ...c.pieces.map((p, i) => `- ${pad(i)}.txt (lines ${p.from}-${p.to}): ${p.names.length ? clip(p.names.join(', '), 200) : '(no named functions)'}`)].join('\n') + '\n');
    }
  }
  const old = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'stamps.json'), 'utf8')); } catch { return {}; } })();
  for (const m of missing) if (old[m]) stamps[m] = old[m]; // a folder not on this computer keeps its last entry
  fs.writeFileSync(path.join(dir, 'stamps.json'), JSON.stringify(stamps, null, 2) + '\n');
  return { scans, missing };
}

// What changed since the catalog was made: per project, the files whose last saved change differs.
export function stale(root) {
  const stamps = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, CATALOG_DIR, 'stamps.json'), 'utf8')); } catch { return {}; } })();
  const out = [];
  for (const p of readProjects(root)) {
    const folder = path.resolve(root, p.path), was = stamps[p.name];
    if (folder === path.resolve(root)) continue; // this project's own card: rebuilt with each save, never stale by itself
    if (!was) { out.push({ name: p.name, why: 'not in the catalog yet' }); continue; }
    if (!fs.existsSync(folder)) continue; // not on this computer: can't tell
    if ((git(folder, 'rev-parse', '--short', 'HEAD') || 'no git') === was.head) continue;
    const now = keyFiles(folder);
    const changed = now.filter((f) => (git(folder, 'log', '-1', '--format=%h', '--', f) || '') !== (was.files[f] ?? null));
    const gone = Object.keys(was.files).filter((f) => !now.includes(f));
    if (changed.length || gone.length) out.push({ name: p.name, why: [...changed, ...gone.map((f) => `${f} (gone)`)].join(', ') });
  }
  return out;
}

// Lines holding all the words, across every project's saved files (text files only, no builds or
// pictures): the fast way to an exact word (a price, ID, address). Best first: the words side by side as
// typed, then notes and docs before pages and code, then short lines; a line seen already (a copy in another
// project) is skipped, and one file gives at most two lines. Returns { hits, more }.
// A file's own name for itself (a page's <title>, a note's first heading), so a search line says what the file is.
const titleOf = (text, f) => clip(clean((/\.html?$/i.test(f) ? text.match(/<title>([^<]*)<\/title>/i)?.[1] : /\.md$/i.test(f) ? text.match(/^#\s+(.+)$/m)?.[1] : '') ?? ''), 60);
const KIND = (f) => (/\.(md|txt)$/i.test(f) ? 0 : /\.html?$/i.test(f) ? 1 : /\.json$/i.test(f) ? 3 : 2);
export function find(root, words, max = 8) {
  const ws = words.map((w) => w.toLowerCase()).filter(Boolean), phrase = ws.join(' ');
  if (!ws.length) return { hits: [], more: 0 };
  const all = [];
  for (const p of readProjects(root)) {
    const dir = path.resolve(root, p.path);
    if (!fs.existsSync(dir)) continue;
    for (const f of git(dir, 'ls-files').split('\n').filter((x) => x && !/^(\.city|bench|shared\/evidence)\/|(^|\/)(node_modules|dist|vendor)\/|\.(png|jpe?g|gif|pdf|db|wasm|ico|woff2?|lock)$|package-lock\.json$/i.test(x))) {
      const text = read(dir, f);
      if (!text || text.length > 2_000_000) continue;
      text.split('\n').forEach((line, i) => {
        const low = line.toLowerCase();
        if (ws.every((w) => low.includes(w))) all.push({ at: `${p.name}/${f}`, title: titleOf(text, f), i, line: line.trim(), rank: (ws.length > 1 && low.includes(phrase) ? 0 : 10) + KIND(f) * 2 + Math.min(line.length, 600) / 300 });
      });
    }
  }
  all.sort((x, y) => x.rank - y.rank);
  const seen = new Set(), perFile = new Map(), hits = [];
  let more = 0;
  for (const h of all) {
    const key = h.line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if ((perFile.get(h.at) ?? 0) >= 2 || hits.length >= max) { more++; continue; }
    perFile.set(h.at, (perFile.get(h.at) ?? 0) + 1);
    hits.push(`${h.at}:${h.i + 1}${h.title ? ` [${h.title}]` : ''}: ${clip(h.line, 200)}`);
  }
  return { hits, more };
}

export async function main(root, args) {
  if (args[0] === 'find') {
    const { hits, more } = find(root, args.slice(1));
    console.log(hits.length ? hits.join('\n') + (more ? `\n(${more} more lines: add a word to narrow it)` : '') : 'No line holds all those words: try fewer, or the company file.');
    return;
  }
  if (args[0] === 'yes' || args[0] === 'no') {
    const config = readConfig(root);
    config.consent = args[0];
    if (args.includes('--share')) config.share = true;
    if (args[0] === 'no') { saveConfig(root, config); console.log('Other projects left out. Change your mind: city catalog yes'); return; }
    saveConfig(root, config);
    const r = await autoCatalog(root);
    console.log(`Catalog on: ${readProjects(root).length} project(s)${r.built ? ', built' : ''}; ${config.share ? 'saved to git for your other AIs' : 'kept on this computer (share it with your other AIs: city catalog share on)'}.`);
    return;
  }
  if (args[0] === 'share') {
    const config = readConfig(root);
    config.share = args[1] !== 'off';
    saveConfig(root, config);
    console.log(config.share ? 'The catalog is now saved to git with the project, for your other AIs.' : 'The catalog now stays on this computer only.');
    return;
  }
  if (args[0] === 'add') {
    const projects = readProjects(root);
    for (const f of args.slice(1)) {
      const folder = path.resolve(process.cwd(), f);
      if (!fs.existsSync(folder)) { console.log(`no folder ${f}`); continue; }
      const name = projectName(folder), rel = path.relative(root, folder) || '.';
      const at = projects.findIndex((p) => p.name === name);
      if (at >= 0) projects[at].path = rel; else projects.push({ name, path: rel });
      console.log(`${name}: ${rel}`);
    }
    saveConfig(root, { ...readConfig(root), projects, consent: 'yes' }); // naming folders is the owner's yes
    return;
  }
  if (args[0] === 'check') {
    const list = stale(root);
    for (const s of list) console.log(`STALE ${s.name}: ${clip(s.why, 200)}`);
    console.log(list.length ? `${list.length} project(s) changed since the catalog was made: run city catalog` : 'Catalog up to date.');
    process.exitCode = list.length ? 1 : 0;
    return;
  }
  if (!readProjects(root).length) { console.log('No projects yet: city catalog add <folder>…'); return; }
  if (!args.includes('--force')) {
    const total = readProjects(root).reduce((n, p) => { const dir = path.resolve(root, p.path); return fs.existsSync(dir) ? n + keyFiles(dir).reduce((m, f) => m + read(dir, f).length, 0) : n; }, 0);
    if (total < WORTH_IT) { console.log(`Not worth a catalog yet: the projects' key files are ~${Math.round(total / 3.5)} tokens in all, cheaper to open than to catalog (city catalog --force builds it anyway).`); return; }
  }
  const { scans, missing } = await build(root);
  const size = tokens(fs.readFileSync(path.join(root, CATALOG_DIR, 'COMPANY.md'), 'utf8'));
  console.log(`Catalog: ${scans.length} project(s), COMPANY.md ~${size} tokens${missing.length ? `; not on this computer (kept as they were): ${missing.join(', ')}` : ''}.`);
}
