// Note headers: who a note in the library (shared/notes/) is for, and what it replaces or corrects.
// A note may start with a short header block:
//   ---
//   author: muse
//   date: 2026-10-29
//   to: [claude, grok]          who should read it (left out or empty: all four AIs)
//   supersedes: [old-note-id]   whole notes this one replaces (readers drop them)
//   amends: [plan-note-id]      notes this one partly corrects (readers read both)
//   ---
// A note's id is its file name without .md. Notes without a header still count: for everyone,
// replacing nothing. `city notes check` fails loudly on a broken header; `city notes [--for grok]`
// lists what a reader should read; .city/NOTES.md is that list for every AI, made from the notes.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSkill } from '../skills.mjs';
import { tokens } from './tokens.mjs';

export const NOTES_DIR = path.join('shared', 'notes');
export const READERS = ['claude', 'muse', 'grok', 'gemini'];
const AUTHORS = new Set([...READERS, 'owner']);
const FIELDS = new Set(['id', 'author', 'date', 'topic', 'status', 'to', 'supersedes', 'amends']);
const STATUS = new Set(['active', 'amended', 'superseded']);
const CAP = 1500; // tokens: the index stays small however many notes pile up

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export function readNotes(root) {
  const dir = path.join(root, NOTES_DIR);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^[a-z0-9][a-zA-Z0-9-]*\.md$/.test(f) && f.toLowerCase() !== 'readme.md'); } catch { return []; }
  return files.sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8'), id = f.slice(0, -3);
    const { meta, body } = parseSkill(text);
    const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? id;
    const date = meta?.date ?? id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
    return {
      id, file: `shared/notes/${f}`, title, date, header: !!meta, meta: meta ?? {},
      author: meta?.author ?? id.split('-')[0],
      to: list(meta?.to), supersedes: list(meta?.supersedes), amends: list(meta?.amends),
    };
  });
}

// Problems with headers: [{ file, msg }]. Notes without a header are fine (they count for everyone).
export function checkNotes(notes) {
  const ids = new Set(notes.map((n) => n.id)), problems = [];
  const bad = (n, msg) => problems.push({ file: n.file, msg });
  for (const n of notes.filter((x) => x.header)) {
    for (const k of Object.keys(n.meta)) if (!FIELDS.has(k)) bad(n, `unknown field "${k}" (allowed: ${[...FIELDS].join(', ')})`);
    if (!n.meta.author) bad(n, 'missing author');
    else if (!AUTHORS.has(n.meta.author)) bad(n, `author "${n.meta.author}" is not one of ${[...AUTHORS].join(', ')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(n.meta.date ?? '')) bad(n, 'date must be yyyy-mm-dd');
    if (n.meta.id && n.meta.id !== n.id) bad(n, `id "${n.meta.id}" must be the file name: ${n.id}`);
    if (n.meta.status && !STATUS.has(n.meta.status)) bad(n, `status "${n.meta.status}" must be active, amended or superseded`);
    for (const r of n.to) if (!READERS.includes(r)) bad(n, `to: "${r}" is not one of ${READERS.join(', ')}`);
    for (const k of ['supersedes', 'amends']) {
      for (const t of n[k]) {
        if (t === n.id) bad(n, `${k} names the note itself`);
        else if (!ids.has(t)) bad(n, `${k}: no note "${t}" in shared/notes/ (use the file name without .md)`);
      }
    }
  }
  return problems;
}

// Who reads what. A note named in any supersedes list is dead, even if the note that named it was later
// replaced too (replacing a replacement never brings the original back). A correction goes to everyone
// the corrected note goes to, and a reader of a note always gets its live corrections with it.
export function resolve(notes) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const dead = new Map();
  for (const n of notes) for (const t of n.supersedes) if (byId.has(t) && t !== n.id) dead.set(t, n.id);
  const live = notes.filter((n) => !dead.has(n.id));
  const amendedBy = new Map();
  for (const n of live) for (const t of n.amends) if (byId.has(t)) amendedBy.set(t, [...(amendedBy.get(t) ?? []), n.id]);
  const audience = new Map(); // id -> Set of readers
  const audienceOf = (id, seen = new Set()) => {
    if (audience.has(id)) return audience.get(id);
    const n = byId.get(id);
    if (!n || seen.has(id)) return new Set(READERS);
    seen.add(id);
    const set = new Set(n.to.length ? n.to : READERS);
    for (const t of n.amends) for (const r of audienceOf(t, seen)) set.add(r);
    audience.set(id, set);
    return set;
  };
  for (const n of notes) audienceOf(n.id);
  const forReader = (reader) => {
    const out = new Set();
    const add = (id) => {
      if (out.has(id) || dead.has(id)) return;
      out.add(id);
      for (const a of amendedBy.get(id) ?? []) add(a);
    };
    for (const n of live) if (audience.get(n.id).has(reader)) add(n.id);
    return live.filter((n) => out.has(n.id));
  };
  return { live, dead, amendedBy, audience, forReader };
}

function head(root) {
  const g = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const sha = g('log', '-1', '--format=%h', '--', NOTES_DIR); // the last saved change to the notes: stays put while other work is saved
  const dirty = g('status', '--porcelain', '--', NOTES_DIR) !== '';
  return sha ? `${sha}${dirty ? ' + unsaved notes' : ''}` : 'no git';
}

const who = (set) => (set.size === READERS.length ? 'all' : [...set].join(', '));

// .city/NOTES.md: the library's reading list, newest first, made from the notes (never edited by hand).
export function notesFile(root, notes = readNotes(root)) {
  const r = resolve(notes), problems = checkNotes(notes);
  const live = [...r.live].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const lines = [
    '# Library reading list',
    '',
    `Made from shared/notes/ at ${head(root)} by \`city notes index\`; don't edit. Read the notes listed for you,`,
    'each with the corrections under it. Notes listed as replaced are out of date: skip them.',
    '',
  ];
  let cut = 0;
  for (const n of live) {
    const fix = (r.amendedBy.get(n.id) ?? []).filter((a) => !r.dead.has(a));
    const line = `- ${n.id} · for ${who(r.audience.get(n.id))} · ${n.title}${fix.length ? `\n  corrected by: ${fix.join(', ')}` : ''}`;
    if (tokens(lines.join('\n') + line) > CAP) { cut++; continue; }
    lines.push(line);
  }
  if (cut) lines.push(`- …and ${cut} older note(s): ls shared/notes/`);
  if (r.dead.size) lines.push('', `Replaced: ${[...r.dead].map(([o, by]) => `${o} (by ${by})`).join('; ')}`);
  if (problems.length) lines.push('', `Header problems (${problems.length}): run city notes check`);
  return lines.join('\n') + '\n';
}

export function main(root, args) {
  const notes = readNotes(root);
  if (args[0] === 'check') {
    const problems = checkNotes(notes);
    const headed = notes.filter((n) => n.header).length;
    for (const p of problems) console.log(`FAIL ${p.file}: ${p.msg}`);
    console.log(problems.length ? `${problems.length} header problem(s).` : `Note headers OK (${headed} of ${notes.length} notes have one).`);
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  if (args[0] === 'index') {
    fs.mkdirSync(path.join(root, '.city'), { recursive: true });
    fs.writeFileSync(path.join(root, '.city', 'NOTES.md'), notesFile(root, notes));
    console.log('Wrote .city/NOTES.md');
    return;
  }
  const i = args.indexOf('--for'), reader = i >= 0 ? args[i + 1] : 'claude';
  if (!READERS.includes(reader)) { console.log(`--for must be one of ${READERS.join(', ')}`); process.exitCode = 1; return; }
  const r = resolve(notes), mine = r.forReader(reader);
  console.log(`${mine.length} note(s) for ${reader} (${r.dead.size} replaced, skipped):`);
  for (const n of mine.sort((a, b) => b.date.localeCompare(a.date))) {
    const fix = r.amendedBy.get(n.id);
    console.log(`- ${n.file}${fix ? ` (corrected by ${fix.join(', ')})` : ''}`);
  }
}
