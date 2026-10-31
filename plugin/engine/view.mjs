// `city view`: the 3D city on this computer, with the same city pages as the online app.
// With the project key and the online city reachable, it shows the online city itself: skills come
// from there and changes go there (one truth for the phone and the computer), and it keeps a live line
// to the online room, so a change made on the phone shows here within a second and its skill files
// are written into (or taken out of) this project at once.
// Without the key, or while the online city can't be reached, it answers from a small local database
// (.city/view.db) filled by the same check-in; then it only takes out skill files it handed out itself,
// and what was changed here goes up once the online city is back.
//   city view            open it (prints the address; stop with Ctrl+C)
//   city view --port N   a fixed port (default: any free one)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sync, projectId, isOwner, readKey, SYNC_URL } from './lib/sync.mjs';

// The city's files: in a project checkout of Talenscape they sit beside the engine (plugin/view);
// an installed copy downloads them with its City key (lib/citypkg.mjs).
const BESIDE = fileURLToPath(new URL('../view/', import.meta.url));
let VIEW = BESIDE;
export const hasCityBeside = () => fs.existsSync(path.join(BESIDE, 'server', 'items.mjs'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

// The local database, shaped like Cloudflare's D1 so the server code runs unchanged.
function d1(file) {
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(VIEW, 'schema.sql'), 'utf8'));
  // A database made by an older version gets the columns added since.
  for (const [t, c] of [['projects', 'layout TEXT'], ['projects', 'design TEXT'], ['projects', 'costs TEXT'], ['projects', 'usage TEXT'], ['projects', 'connectors_off TEXT']]) if (!db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c.split(' ')[0])) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`);
  // Search rows made before they shared their code piece's rowid (server/answers.mjs removes them by rowid): rebuilt once.
  if (db.prepare('SELECT COUNT(*) AS n FROM code_fts f LEFT JOIN code_pieces p ON p.rowid = f.rowid AND p.path = f.path AND p.qname = f.qname WHERE p.rowid IS NULL').get().n) {
    db.exec('DELETE FROM code_fts; INSERT INTO code_fts (rowid, owner, project, path, qname, body) SELECT rowid, owner, project, path, qname, body FROM code_pieces;');
  }
  const wrap = (sql) => {
    const st = db.prepare(sql);
    let args = [];
    const q = {
      bind: (...a) => { args = a; return q; },
      first: async () => st.get(...args) ?? null,
      all: async () => ({ results: st.all(...args) }),
      run: async () => { st.run(...args); return { success: true }; },
      _run: () => st.run(...args),
    };
    return q;
  };
  return {
    raw: db, prepare: wrap,
    async batch(list) { db.exec('BEGIN'); try { for (const q of list) q._run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return list.map(() => ({ success: true })); },
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...HEADERS, 'Content-Type': 'application/json' } });
const refuse = (status, error) => json({ error }, status);

const readLayout = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.city', 'layout.json'), 'utf8')); } catch { return {}; } };
const readDesign = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.city', 'design.json'), 'utf8')); } catch { return {}; } };

// The savings meter on this computer (the same numbers the online app shows).
function savings(root) {
  let meter = {};
  try { meter = JSON.parse(fs.readFileSync(path.join(root, '.city', 'savings.json'), 'utf8')); } catch { /* no meter yet */ }
  const sessions = [...(meter.history ?? [])];
  if (Object.keys(meter.current ?? {}).length) sessions.push({ at: meter.startedAt ?? new Date().toISOString(), totals: meter.current, live: true });
  return { sessions, bench: [] };
}

// key: the project key (no key: local only). online: the online city's address. fetchImpl and WebSocketImpl
// are swapped in tests.
export async function startView(root, { port = 0, host = '127.0.0.1', view = VIEW, key = '', online = new URL(SYNC_URL).origin, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, home = os.homedir() } = {}) {
  VIEW = view;
  const server = await import(pathToFileURL(path.join(VIEW, 'server', 'items.mjs')));
  const { keepLive } = await import(pathToFileURL(path.join(VIEW, 'app', 'live.js'))).catch(() => ({})); // an older city package has no live line
  const { handleSync } = await import(pathToFileURL(path.join(VIEW, 'server', 'sync.mjs')));
  fs.mkdirSync(path.join(root, '.city'), { recursive: true });
  const db = d1(path.join(root, '.city', 'view.db'));
  const env = { DB: db };
  // The catalog travels with the plugin: refreshed every start.
  const catalog = JSON.parse(fs.readFileSync(path.join(VIEW, 'catalog.json'), 'utf8'));
  await db.batch([db.prepare('DELETE FROM catalog_items'), ...catalog.map((c) => db.prepare('INSERT INTO catalog_items (name, type, description, triggers, plugin, includes, version, tokens, body, starter, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(c.name, c.type, c.description, c.triggers, c.plugin, JSON.stringify(c.includes), c.version, c.tokens, c.body, c.starter ? 1 : 0, 'now'))]);
  // A key that exists only while this runs, for the local check-in below (never written anywhere).
  const localKey = `tsk_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(localKey).digest('base64url');
  await db.batch([db.prepare("DELETE FROM sync_keys WHERE label = 'city view'"), db.prepare("INSERT INTO sync_keys (id, owner, kind, hash, label, enabled, created_at) VALUES ('local', 'me', 'sync', ?, 'city view', 1, ?)").bind(hash, new Date().toISOString())]);
  const project = projectId(root);
  // The check-in: this project's skills, each AI's list, the library and the summary, into the local database;
  // skills and notes added in the city come back down as files.
  // Skills made in the online app aren't in this local database: this check-in may only take out skills it
  // handed out itself (remembered in .city/view-skills.json, which stays on this computer).
  const handedOut = path.join(root, '.city', 'view-skills.json');
  const checkIn = async () => {
    let removable;
    try { removable = new Set(JSON.parse(fs.readFileSync(handedOut, 'utf8'))); } catch { removable = new Set(); }
    const r = await sync(root, { key: localKey, url: 'http://local/api/sync', fetchImpl: (url, init) => handleSync(new Request(url, init), env, { json, refuse }), applyConnectors: false, removable });
    if (Array.isArray(r?.listed)) fs.writeFileSync(handedOut, JSON.stringify(r.listed));
    return r;
  };

  // ---------- the online city, when it can be reached ----------
  let isOnline = false, lineUp = false;
  const pages = new Set(); // this computer's open city pages, told of changes (Server-Sent Events)
  const tell = (msg) => { for (const res of pages) res.write(`data: ${JSON.stringify(msg)}\n\n`); };
  const linkState = () => tell({ t: 'link', online: isOnline && lineUp });
  // One route of the online city, with the project key. null: it can't be reached (then the local copy answers).
  const ask = async (route, body, query) => {
    const [method, p] = route.split(' ');
    let res;
    try {
      res = await fetchImpl(`${online}/api/city/${p.slice('/api/'.length)}?${query}`, { method, headers: { Authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    } catch { return null; }
    if (res.status === 401 || res.status >= 500) return null; // key switched off, or the online city is down
    const out = await res.json().catch(() => ({}));
    return res.ok ? out : { status: res.status, error: out.error || `The online city answered ${res.status}.` };
  };
  // Following the online city: its skills for this project become files here, and ones taken out there go
  // (the truth is shared now). One at a time; a change during one runs one more.
  let following = null, again = false;
  const follow = (full = false) => {
    if (following) { again = true; return following; }
    following = (async () => {
      do {
        again = false;
        try { await sync(root, { key, url: `${online}/api/sync`, fetchImpl, home, light: !full }); full = false; } catch { goOffline(); }
      } while (again && isOnline);
      following = null;
    })();
    return following;
  };
  // Changes made here while the online city couldn't be reached: sent up once it is back.
  const outbox = path.join(root, '.city', 'view-outbox.json');
  const readOutbox = () => { try { return JSON.parse(fs.readFileSync(outbox, 'utf8')); } catch { return []; } };
  const goOnline = async (full = false) => {
    const waiting = readOutbox();
    for (const [i, w] of waiting.entries()) {
      if ((await ask(w.route, w.body, new URLSearchParams(w.query))) === null) { fs.writeFileSync(outbox, JSON.stringify(waiting.slice(i))); return false; }
    }
    fs.rmSync(outbox, { force: true });
    isOnline = true;
    await follow(full);
    if (!isOnline) return false;
    linkState();
    tell({ t: 'skills', project: null });
    return true;
  };
  function goOffline() { if (isOnline) { isOnline = false; linkState(); } }

  if (!(key && (await goOnline(true)))) await checkIn();

  // The live line to the online room: a change anywhere reaches this computer's pages and files at once.
  let line = null;
  if (key && keepLive && WebSocketImpl) {
    line = keepLive({
      open: () => new WebSocketImpl(`${online.replace(/^http/, 'ws')}/api/live`, { headers: { Authorization: `Bearer ${key}` } }),
      onState: async (on) => {
        lineUp = on;
        if (on && !isOnline) return goOnline(); // back: what changed here goes up, what changed there comes down
        linkState();
        if (on) follow();
      },
      onMessage: (msg) => {
        if (msg.t === 'hello' || msg.t === 'link') return; // 'link' is this computer's own word to its pages
        tell(msg); // the pages redraw (and hear anything else the room passes on)
        if (msg.t === 'skills' && (!msg.project || msg.project === project)) follow();
      },
    });
  }

  const api = async (route, body, query) => {
    if (!query.get('project') && !body.project) query.set('project', project); // this project unless another is chosen
    if (route === 'GET /api/session') return { unlocked: true, hasPasskeys: true, email: 'local' };
    if (route === 'GET /api/keys') return { keys: [] };
    if (route === 'GET /api/savings') return savings(root);
    // The Setup card: the owner's choices and one-time steps for this project (lib/setup.mjs).
    if (route === 'GET /api/setup') return (await import('./lib/setup.mjs')).setupStatus(root);
    if (route === 'POST /api/setup') return (await import('./lib/setup.mjs')).saveSetup(root, body);
    // Connector switches live in the online app (its check-in applies them here); offline the local city only lists them.
    if (route === 'POST /api/projects/connectors' && !isOnline) return { status: 400, error: 'Switch connectors in the online city: this computer follows it at the next check-in.' };
    if (route === 'POST /api/export') { const r = (await import('./lib/export.mjs')).exportPlugin(root, String(body.name ?? '')); return r.error ? { status: 400, error: r.error } : r; }
    // The design of this project's city lives in the project (.city/layout.json): it travels with it
    // through git, so everyone working on it sees the same city.
    if (route === 'POST /api/projects/layout' && (body.project ?? query.get('project')) === project) {
      const layout = body.reset ? {} : server.mergeLayout(readLayout(root), body.moves);
      fs.writeFileSync(path.join(root, '.city', 'layout.json'), JSON.stringify(layout, null, 1) + '\n');
      return { layout };
    }
    if (route === 'POST /api/projects/design' && (body.project ?? query.get('project')) === project) {
      const design = body.reset ? {} : server.mergeDesign(readDesign(root), body);
      fs.writeFileSync(path.join(root, '.city', 'design.json'), JSON.stringify(design, null, 1) + '\n');
      return { design };
    }
    const cityRoute = server.isItemsRoute(route) || server.isLibraryRoute(route);
    // Online: the online city answers (the same truth as the phone); what was just changed is a file
    // in this project before the answer.
    const there = cityRoute && isOnline ? await ask(route, body, query) : null;
    if (there === null && cityRoute && isOnline) goOffline();
    if (there) {
      if (route === 'GET /api/skills' && there.project === project) { there.layout = readLayout(root); there.design = readDesign(root); }
      if (route === 'GET /api/projects') there.home = project;
      if (!there.error && route.startsWith('POST ')) await follow();
      return there;
    }
    const out = server.isLibraryRoute(route) ? await server.libraryApi(route, body, db, 'me')
      : await server.itemsApi(route, body, db, query, 'me', { id: project, name: project }); // this project is the city shown
    if (route === 'GET /api/skills' && out?.project === project) { out.layout = readLayout(root); out.design = readDesign(root); }
    if (route === 'GET /api/skills' && out) delete out.connectorsOff;
    if (out && !out.error && route.startsWith('POST ')) {
      await checkIn().catch(() => {}); // what was just added is a file in this project before the answer
      if (key && cityRoute) fs.writeFileSync(outbox, JSON.stringify([...readOutbox(), { route, body, query: String(query) }].slice(-100))); // goes up once the online city is back
      tell({ t: 'skills', project: body.project ?? query.get('project') }); // other pages of it on this computer
    }
    return out;
  };

  // Only this computer's own page may use it. Another website open in the same browser can't: the
  // address must be this one (no look-alike names pointing here), changes must come from this page as
  // JSON, and every call needs a cookie made fresh for this run, which browsers never send from other sites.
  const ticket = randomBytes(24).toString('base64url');
  let me = '';
  const ours = (req) => {
    if (![`127.0.0.1:${me}`, `localhost:${me}`].includes(req.headers.host)) return false;
    const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
    if (origin && origin !== `http://${req.headers.host}`) return false;
    if (site && !['same-origin', 'none'].includes(site)) return false;
    return true;
  };
  const hasTicket = (req) => (req.headers.cookie ?? '').split(/;\s*/).includes(`ts_local=${ticket}`);

  const http1 = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (status, type, data, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(data); };
    if (!ours(req)) return send(403, 'text/plain', 'Only this computer\'s own city page can use this.');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!hasTicket(req)) return send(403, 'application/json', JSON.stringify({ error: 'Open the city from the address city view printed.' }));
        if (url.pathname === '/api/live' && req.method === 'GET') { // this page's live stream (app/live.js)
          res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ t: 'link', online: isOnline && lineUp })}\n\n`);
          pages.add(res);
          req.on('close', () => pages.delete(res));
          return;
        }
        if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, 'application/json', JSON.stringify({ error: 'Not readable.' }));
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 2_000_000) return send(413, 'application/json', JSON.stringify({ error: 'Too much at once.' })); }
        const body = req.method === 'POST' ? JSON.parse(raw || '{}') : {};
        const out = await api(`${req.method} ${url.pathname}`, body, url.searchParams);
        if (!out) return send(404, 'application/json', JSON.stringify({ error: 'Not here in the local city.' }));
        return send(out.error ? out.status ?? 400 : 200, 'application/json', JSON.stringify(out.error ? { error: out.error } : out));
      }
      const name = url.pathname === '/' || url.pathname === '/home' ? 'home.html' : url.pathname.slice(1);
      const file = path.join(VIEW, 'app', name);
      if (!file.startsWith(path.join(VIEW, 'app') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'text/plain', 'Not found');
      let data = fs.readFileSync(file);
      if (name !== 'home.html') return send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', data);
      data = data.toString('utf8').replace('<body ', `<body data-local="1" ${isOwner() ? 'data-owner="1" ' : ''}`);
      return send(200, TYPES['.html'], data, { 'Set-Cookie': `ts_local=${ticket}; Path=/; HttpOnly; SameSite=Strict` });
    } catch (err) {
      console.error(err);
      return send(500, 'application/json', JSON.stringify({ error: 'Something went wrong.' }));
    }
  });
  await new Promise((ok) => http1.listen(port, host, ok));
  me = String(http1.address().port);
  const beat = setInterval(() => { for (const res of pages) res.write(': still here\n\n'); }, 25_000);
  beat.unref();
  const close = async () => {
    clearInterval(beat);
    line?.stop();
    for (const res of pages) res.end();
    await following;
    await new Promise((ok) => { http1.close(ok); http1.closeAllConnections?.(); });
  };
  return { url: `http://${host}:${http1.address().port}/`, close, db, get online() { return isOnline; }, get live() { return lineUp; }, settled: () => following ?? Promise.resolve() };
}

export async function main(args) {
  const { plan, NEED, savedKey } = await import('./lib/license.mjs');
  const p = await plan();
  if (!p.ok) { console.log(`${NEED} (${p.why})`); process.exitCode = 1; return; }
  let view = BESIDE;
  if (!hasCityBeside()) {
    const got = await (await import('./lib/citypkg.mjs')).ensureCity(savedKey());
    if (got.error) { console.log(got.error); process.exitCode = 1; return; }
    if (got.updated) console.log('Got the newest 3D city from talenscape.com.');
    view = got.dir;
  }
  const i = args.indexOf('--port');
  const root = process.env.TALENSCAPE_ROOT || process.cwd();
  const v = await startView(root, { port: i >= 0 ? Number(args[i + 1]) : 0, view, key: readKey(), online: new URL(process.env.TALENSCAPE_SYNC_URL || SYNC_URL).origin });
  console.log(`Your city: ${v.url}  (${v.online ? 'your online city, live' : 'from this computer only: the online city can\'t be reached'}; stop with Ctrl+C)`);
}
