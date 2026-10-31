// `city sync`: this project's city, both ways. Sends the skills the project keeps as files (names and
// descriptions only) to the owner's Talenscape app, and writes back the skills the owner added to this
// project's city in the app, as .claude/skills/<name>/SKILL.md and .agents/skills/<name>/SKILL.md, or
// only the folder of the one AI a skill is for (marked, so only those are ever changed or removed).
// It also sends what every chat costs (lib/costs.mjs: numbers and connector names, no chat text), and switches off on this
// computer the connectors the owner switched off in the app (lib/connectors.mjs).
// Needs the owner's project key: the TALENSCAPE_KEY setting, or ~/.talenscape/key.
// No key: nothing happens. No AI involved; the only address it talks to is the owner's own app.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSkills, parseSkill } from '../skills.mjs';
import { MODELS, NAME_RE, SECRET_RE } from './skill-rules.mjs';

export const SYNC_URL = 'https://share.talenscape.com/api/sync';
export const MANAGED = 'talenscape-app'; // the managed-by mark on files this writes
const TIMEOUT_MS = 6000;

const git = (root, ...args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export function projectId(root) {
  const remote = git(root, 'remote', 'get-url', 'origin').replace(/\.git$/, '');
  return slug(remote.split(/[/:]/).pop() || path.basename(root)) || 'project';
}

export function readKey(env = process.env, home = os.homedir()) {
  if (env.TALENSCAPE_KEY) return env.TALENSCAPE_KEY.trim();
  try { return fs.readFileSync(path.join(home, '.talenscape', 'key'), 'utf8').trim(); } catch { return ''; }
}

// The skills this project keeps as files: skills/** (not Talenscape's own catalog or the template)
// and .claude/, .grok/ and .agents/skills/*, leaving out the ones this command wrote.
export function collectSkills(root) {
  const files = findSkills(root).filter((f) => !f.startsWith('skills/catalog/'));
  // Each AI tool's own skills folder (Claude Code, Grok Build) and the shared one (.agents, any AI).
  for (const folder of ['.claude', '.grok', '.agents']) {
    const dot = path.join(root, folder, 'skills');
    try { for (const d of fs.readdirSync(dot)) if (fs.existsSync(path.join(dot, d, 'SKILL.md'))) files.push(`${folder}/skills/${d}/SKILL.md`); } catch { /* none */ }
  }
  const out = [];
  for (const file of files) {
    const { meta } = parseSkill(fs.readFileSync(path.join(root, file), 'utf8'));
    if (!meta?.name || meta['managed-by'] === MANAGED) continue;
    const parts = file.split('/'), models = [].concat(meta.models ?? []);
    const model = parts[0] === '.claude' ? 'claude' : parts[0] === '.grok' ? 'grok' : parts[0] === '.agents' ? null : parts[1] === 'user' && MODELS.includes(parts[2]) ? parts[2] : models.length === 1 && MODELS.includes(models[0]) ? models[0] : null;
    out.push({ name: meta.name, path: file, model, description: meta.description ?? '', triggers: [].concat(meta.triggers ?? []).join(', '), version: meta.version ?? '', plugin: meta.plugin ?? null });
  }
  return out;
}

// A skill the owner wrote in the app is their draft, in their own words: the AI it is for writes it
// up properly once (status: draft → written). The write-up stays until the owner changes the draft,
// which the draft mark (a fingerprint of the owner's words) tells.
export const draftMark = (s) => 'd' + crypto.createHash('sha256').update(JSON.stringify([s.name, s.description, s.triggers ?? '', s.body ?? '', s.model ?? ''])).digest('hex').slice(0, 12); // starts with a letter: never read as a number
// The app sends the fingerprint (draft) and, once an AI has written the skill up, that write-up.
const markOf = (s) => s.draft ?? draftMark(s);
const fileFor = (s) => {
  const t = s.written ? { ...s, ...s.written } : s;
  return [
    '---', `name: ${s.name}`, `description: ${String(t.description).replace(/\n/g, ' ')}`,
    ...(t.triggers ? [`triggers: [${t.triggers}]`] : []), ...(s.plugin ? [`plugin: ${s.plugin}`] : []),
    ...(MODELS.includes(s.model) ? [`models: [${s.model}]`] : []), // the AI it is for (the others leave it alone)
    `managed-by: ${MANAGED}`, ...(s.source === 'mine' ? [`status: ${s.written ? 'written' : 'draft'}`, `draft: ${markOf(s)}`] : []), '---', '', (t.body || `# ${s.name}\n\n${t.description}`).trim(), '',
  ].join('\n');
};

// Write-ups an AI made in this project, for the owner's library: [{ name, draft, description, triggers, body, by }].
export function writeUps(root) {
  const out = [];
  for (const d of SKILL_DIRS) {
    try {
      for (const n of fs.readdirSync(path.join(root, d, 'skills'))) {
        let parsed;
        try { parsed = parseSkill(fs.readFileSync(path.join(root, d, 'skills', n, 'SKILL.md'), 'utf8')); } catch { continue; }
        const { meta, body } = parsed;
        if (meta?.['managed-by'] !== MANAGED || meta.status !== 'written' || !meta.draft || out.some((o) => o.name === n)) continue;
        const by = { '.claude': 'claude', '.grok': 'grok', '.gemini': 'gemini' }[d] ?? [].concat(meta.models ?? [])[0] ?? null;
        out.push({ name: n, draft: String(meta.draft), description: meta.description ?? '', triggers: [].concat(meta.triggers ?? []).join(', '), body: body.trim(), by });
      }
    } catch { /* no folder */ }
  }
  return out;
}

// The owner's drafts still to write up, for the blink: [{ name, model, file }].
export function draftsToWrite(root) {
  const out = [];
  for (const d of SKILL_DIRS) {
    try {
      for (const n of fs.readdirSync(path.join(root, d, 'skills'))) {
        const file = `${d}/skills/${n}/SKILL.md`;
        let meta;
        try { meta = parseSkill(fs.readFileSync(path.join(root, file), 'utf8')).meta; } catch { continue; }
        if (meta?.['managed-by'] === MANAGED && meta.status === 'draft' && !out.some((o) => o.name === n)) out.push({ name: n, model: [].concat(meta.models ?? [])[0] ?? null, file });
      }
    } catch { /* no folder */ }
  }
  return out;
}

// Write the app's skills into the project, in Claude Code's folder (.claude/skills) and the shared
// one other AI tools read (.agents/skills); a skill for one AI goes only where that AI reads (Claude
// reads .agents too, so a Grok or Gemini skill goes in their own folder). Remove the ones taken out
// of the city. Never touches a file it did not write. They are ordinary project files, saved with the
// rest of the work, so every AI that reads the project (through GitHub too) sees the same skills.
export const SKILL_DIRS = ['.claude', '.agents', '.grok', '.gemini'];
export const dirsFor = (model) => ({ claude: ['.claude'], grok: ['.grok'], gemini: ['.gemini'] })[model] ?? (MODELS.includes(model) ? ['.agents'] : ['.claude', '.agents']);
// removable: when given, only these names may be taken out (the local city knows only what it handed out itself).
export function writeDown(root, skills, { removable = null } = {}) {
  const done = { written: [], removed: [], skipped: [] };
  const wanted = new Set(), names = new Set(); // "folder/name", and the names
  for (const s of skills) {
    if (!NAME_RE.test(s.name ?? '')) continue;
    names.add(s.name);
    let wrote = false;
    for (const d of dirsFor(s.model)) {
      wanted.add(`${d}/${s.name}`);
      const file = path.join(root, d, 'skills', s.name, 'SKILL.md'), text = fileFor(s);
      let old = null;
      try { old = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
      const was = old === null ? null : parseSkill(old).meta;
      if (old !== null && was?.['managed-by'] !== MANAGED) { if (!done.skipped.includes(s.name)) done.skipped.push(s.name); continue; } // the project's own file wins
      if (old === text) continue;
      if (was?.status === 'written' && s.source === 'mine' && String(was.draft) === markOf(s)) continue; // written up from this very draft: keep it
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      wrote = true;
    }
    if (wrote) done.written.push(s.name);
  }
  for (const d of SKILL_DIRS) {
    const dir = path.join(root, d, 'skills');
    try {
      for (const n of fs.readdirSync(dir)) {
        const file = path.join(dir, n, 'SKILL.md');
        if (wanted.has(`${d}/${n}`) || (removable && !removable.has(n)) || !fs.existsSync(file) || parseSkill(fs.readFileSync(file, 'utf8')).meta?.['managed-by'] !== MANAGED) continue;
        fs.rmSync(path.join(dir, n), { recursive: true });
        if (!names.has(n) && !done.removed.includes(n)) done.removed.push(n); // moved to another AI's folder: not removed
      }
    } catch { /* no folder */ }
  }
  // Earlier versions kept these files out of git; take back those lines, so the files are saved.
  const exclude = git(root, 'rev-parse', '--git-path', 'info/exclude');
  if (exclude) {
    const p = path.resolve(root, exclude);
    try {
      const have = fs.readFileSync(p, 'utf8'), keep = have.split('\n').filter((l) => !/^\/\.claude\/skills\/[a-z0-9-]+\/$/.test(l));
      if (keep.length !== have.split('\n').length) fs.writeFileSync(p, keep.join('\n'));
    } catch { /* none */ }
  }
  return { ...done, listed: [...names] };
}

// shared/: the one folder other AIs may write in (until the city's shared space is live). A file named
// after an AI (shared/grok.md) holds that AI's list of its skills, tools and plugins.
export function sharedLists(root) {
  const dir = path.join(root, 'shared');
  try {
    return fs.readdirSync(dir).filter((f) => MODELS.includes(f.replace(/\.(md|txt)$/, '')))
      .map((f) => ({ model: f.replace(/\.(md|txt)$/, ''), text: fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 40000) }));
  } catch { return []; }
}

// The code index for the answer link other AIs open: per file its hash, its pieces (functions,
// classes, methods, with their code) and the links from them; small files whole. Built from the local
// map; a file that looks like it holds a key is never sent.
const BATCH_BYTES = 400_000, MAX_BATCHES = 6;
export async function codeIndex(root) {
  const { buildIndex } = await import('./indexer.mjs');
  const { openDb } = await import('./db.mjs');
  await buildIndex(root);
  const db = openDb(root);
  try {
    const files = [];
    const pieces = db.prepare("SELECT id, qname, name, kind, start_line, end_line FROM graph_nodes WHERE path = ? AND kind IN ('function', 'class', 'method') ORDER BY start_line");
    const links = db.prepare(`SELECT CASE WHEN s.kind = 'file' THEN s.path ELSE s.qname END AS src, CASE WHEN d.kind = 'file' THEN d.path ELSE d.qname END AS dst, e.kind
      FROM graph_edges e JOIN graph_nodes s ON s.id = e.src JOIN graph_nodes d ON d.id = e.dst WHERE s.path = ?`);
    for (const f of db.prepare('SELECT path, hash FROM files ORDER BY path').all()) {
      let text;
      try { text = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
      if (SECRET_RE.test(text)) continue;
      const lines = text.split('\n');
      files.push({
        path: f.path, hash: f.hash, lines: lines.length, ...(text.length <= 60_000 ? { text } : {}),
        pieces: pieces.all(f.path).map((n) => ({ qname: n.qname, name: n.name, kind: n.kind, start: n.start_line, end: n.end_line, body: lines.slice(n.start_line - 1, n.end_line).join('\n').slice(0, 4000) })),
        links: links.all(f.path),
      });
    }
    return files;
  } finally { db.close?.(); }
}

// The library: notes in shared/notes/<who>-<date>-<title>.md, from the AIs, the owner and Claude.
export const NOTES_DIR = path.join('shared', 'notes');
export function readNotes(root) {
  const dir = path.join(root, NOTES_DIR);
  try {
    return fs.readdirSync(dir).filter((f) => /^[a-z0-9][a-zA-Z0-9-]*\.md$/.test(f) && f.toLowerCase() !== 'readme.md').map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8'), id = f.slice(0, -3);
      const title = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? id;
      return { id, ai: id.split('-')[0], title, body: text.replace(/^#\s+.+\n?/m, '').trim(), at: fs.statSync(path.join(dir, f)).mtime.toISOString() };
    });
  } catch { return []; }
}
// Notes left in the app, written into shared/notes/ so every AI (and git) has them.
export function writeNotes(root, notes) {
  const dir = path.join(root, NOTES_DIR), written = [];
  for (const n of notes ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(n.id ?? '')) continue;
    const file = path.join(dir, `${n.id}.md`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `# ${n.title}\n\n_From ${n.ai ?? 'the owner'}, ${String(n.created_at ?? '').slice(0, 10)} (left in the app)_\n\n${n.body}\n`);
    written.push(n.id);
  }
  return written;
}

// The same request through curl (which uses the environment's proxy settings). The key goes in a
// private temporary file, never on the command line. Returns a fetch-like answer, or null.
export function curlPost(url, key, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talenscape-sync-'));
  try {
    const cfg = path.join(dir, 'cfg'), data = path.join(dir, 'body');
    fs.writeFileSync(cfg, `header = "Authorization: Bearer ${key}"\nheader = "Content-Type: application/json"\n`, { mode: 0o600 });
    fs.writeFileSync(data, body, { mode: 0o600 });
    const out = execFileSync('curl', ['-sS', '-m', String(TIMEOUT_MS / 1000 + 4), '-K', cfg, '--data-binary', `@${data}`, '-w', '\n%{http_code}', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const status = Number(out.slice(out.lastIndexOf('\n') + 1)), text = out.slice(0, out.lastIndexOf('\n'));
    return status ? { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) } : null;
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Is this computer the owner's? Kept in the home folder from the last check-in (never in a project):
// the city on this computer then shows a link to the online Owner page.
export const ownerFile = (home = os.homedir()) => path.join(home, '.config', 'talenscape', 'owner.json');
export function isOwner(home) { try { return JSON.parse(fs.readFileSync(ownerFile(home), 'utf8')).owner === true; } catch { return false; } }
function saveOwner(home, owner) {
  try { fs.mkdirSync(path.dirname(ownerFile(home)), { recursive: true, mode: 0o700 }); fs.writeFileSync(ownerFile(home), JSON.stringify({ owner: !!owner }) + '\n', { mode: 0o600 }); } catch { /* optional */ }
}

// light: only what was added or changed in the app, both ways (no code for answer links, no summary): the quick
// check before each of the owner's messages.
// A folder in the temp area is never a real project (tests make them), and TALENSCAPE_NO_SYNC=1 (set by npm test)
// switches the real check-in off. Before this, every test run created a "talenscape-session-…" project in the
// owner's live app (110 on 2026-10-30) and nearly used up the free plan's daily database writes.
export function isScratch(root, env = process.env) {
  if (env.TALENSCAPE_NO_SYNC === '1') return true;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const tmp = real(os.tmpdir()), dir = real(root);
  return dir === tmp || dir.startsWith(tmp + path.sep);
}

export async function sync(root, { key = readKey(), url = process.env.TALENSCAPE_SYNC_URL || SYNC_URL, fetchImpl = fetch, home = os.homedir(), light = false, applyConnectors = true, removable = null } = {}) {
  if (!key) return { off: true };
  if (fetchImpl === fetch && isScratch(root)) return { off: true, scratch: true }; // only the real app is guarded; tests with a pretend app still run
  const id = projectId(root);
  const post = async (payload) => {
    const body = JSON.stringify({ project: { id, name: id }, ...payload });
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      // Some networks only let traffic out through a proxy that Node's own fetch doesn't use: try curl.
      if (fetchImpl !== fetch) throw err;
      res = curlPost(url, key, body);
      if (!res) throw new Error(`can't reach ${new URL(url).host}: allow that address in this environment's network settings (${err.cause?.code ?? err.message})`);
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `the app answered ${res.status}`);
    return out;
  };
  let code = [];
  if (!light) try { code = await codeIndex(root); } catch { /* no map: no answers for other AIs this time */ }
  const manifest = Object.fromEntries(code.map((f) => [f.path, f.hash]));
  let blink;
  if (!light) try { blink = await (await import('../session.mjs')).blink(root, undefined, { shared: true }); } catch { /* optional */ }
  // What every chat costs (numbers and connector names only, never the chat's text): the full check-in only.
  let costs;
  if (!light) try { costs = (await import('./costs.mjs')).chatCosts(root, { home }) ?? undefined; } catch { /* optional */ }
  const { habitsOf, applyHabits } = await import('./habits.mjs');
  const out = await post({ skills: collectSkills(root), lists: sharedLists(root), notes: readNotes(root), written: writeUps(root), habits: habitsOf(root), blink, costs, ...(light ? {} : { code: { manifest } }) });
  const habits = applyHabits(root, out.habitChanges); // switched on or off, added, changed in the app
  saveOwner(home, out.owner);
  let connectors = null; // switched off in the app: applied to Claude Code on this computer (not in cloud chats)
  if (applyConnectors) try { connectors = (await import('./connectors.mjs')).applyConnectorsOff(root, out.connectorsOff, { home }); } catch { /* optional */ }
  // Then only the files the app doesn't have yet (changed or new), in a few batches.
  let need = new Set(out.codeNeed ?? []), batches = 0, codeSent = 0;
  while (need.size && batches < MAX_BATCHES) {
    const batch = [];
    let size = 0;
    for (const f of code) {
      if (!need.has(f.path)) continue;
      const n = JSON.stringify(f).length;
      if (batch.length && size + n > BATCH_BYTES) break;
      batch.push(f); size += n;
    }
    if (!batch.length) break;
    const r = await post({ code: { manifest, files: batch } });
    codeSent += batch.length; batches++;
    need = new Set(r.codeNeed ?? []);
  }
  const notes = writeNotes(root, out.notes);
  return { project: id, sent: out.kept ?? 0, code: codeSent, codeLeft: need.size, notes, habits, connectors, ...writeDown(root, out.skills ?? [], { removable }), others: out.others ?? [] };
}

// The last check-in, for the blink's CITY line: { at, ok, project?, error? } (or no key).
const statusFile = (root) => path.join(root, '.city', 'sync.json');
export function syncStatus(root) { try { return JSON.parse(fs.readFileSync(statusFile(root), 'utf8')); } catch { return null; } }
function saveStatus(root, st) { try { fs.mkdirSync(path.dirname(statusFile(root)), { recursive: true }); fs.writeFileSync(statusFile(root), JSON.stringify({ at: new Date().toISOString(), ...st })); } catch { /* optional */ } }

// Before each of the owner's messages (Claude's message hook): what was changed in the app since the
// last check-in comes in, at most every 2 minutes, with a light check-in. One line when something did.
export async function appPeek(root, { now = Date.now(), ...opts } = {}) {
  const last = Date.parse(syncStatus(root)?.at ?? '') || 0;
  if (now - last < 2 * 60_000) return null;
  let r;
  try { r = await sync(root, { ...opts, light: true }); } catch (err) { saveStatus(root, { ok: false, error: String(err.message).slice(0, 120) }); return null; }
  saveStatus(root, r.off ? { ok: false, nokey: true } : { ok: true, project: r.project, notes: r.notes.length, skills: r.written.length });
  if (r.off) return null;
  const changed = [...r.written.map((n) => `+${n}`), ...r.removed.map((n) => `-${n}`), ...r.notes.map((n) => `+note ${n}`), ...(r.habits ? [`${r.habits} habit change(s)`] : [])];
  return changed.length ? `Talenscape app: brought in what the owner changed there: ${changed.join(' ')}. Skills are files now; habits are in the OWNER/RULES lists (city habit). Follow them from here on.` : null;
}

export async function main(args) {
  const quiet = args.includes('--quiet'), root = process.cwd();
  try {
    const r = await sync(root);
    saveStatus(root, r.off ? { ok: false, nokey: true } : { ok: true, project: r.project, notes: r.notes.length, skills: r.written.length });
    if (r.off) { if (!quiet) console.log('No project key yet: make one in the app (Projects → Connect a project).'); return; }
    const changed = [...r.written.map((n) => `+${n}`), ...r.removed.map((n) => `-${n}`), ...r.notes.map((n) => `+note ${n}`), ...(r.habits ? [`${r.habits} habit change(s)`] : [])];
    if (!quiet || changed.length || r.skipped.length) {
      console.log(`city sync ${r.project}: ${r.sent} skill file(s) sent${r.code ? `, ${r.code} changed code file(s) for answer links${r.codeLeft ? ` (${r.codeLeft} more next time)` : ''}` : ''}${changed.length ? `; from the app: ${changed.join(' ')}` : ''}${r.skipped.length ? `; kept the project's own ${r.skipped.join(', ')}` : ''}`);
    }
  } catch (err) {
    saveStatus(root, { ok: false, error: String(err.message).slice(0, 120) });
    if (!quiet) { console.log(`city sync: could not reach the app (${err.message}). Nothing changed.`); process.exitCode = 1; }
  }
}
