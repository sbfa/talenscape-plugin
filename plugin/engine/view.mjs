// `city view`: the 3D city on this computer, from this project's own files. Nothing leaves the
// computer: the same city pages and server code as the online app, answering from a small local
// database (.city/view.db) that is filled by the same check-in the online app uses.
//   city view            open it (prints the address; stop with Ctrl+C)
//   city view --port N   a fixed port (default: any free one)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sync, projectId, isOwner } from './lib/sync.mjs';

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
  for (const [t, c] of [['projects', 'layout TEXT'], ['projects', 'design TEXT']]) if (!db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c.split(' ')[0])) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`);
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

export async function startView(root, { port = 0, host = '127.0.0.1', view = VIEW } = {}) {
  VIEW = view;
  const server = await import(pathToFileURL(path.join(VIEW, 'server', 'items.mjs')));
  const { handleSync } = await import(pathToFileURL(path.join(VIEW, 'server', 'sync.mjs')));
  fs.mkdirSync(path.join(root, '.city'), { recursive: true });
  const db = d1(path.join(root, '.city', 'view.db'));
  const env = { DB: db };
  // The catalog travels with the plugin: refreshed every start.
  const catalog = JSON.parse(fs.readFileSync(path.join(VIEW, 'catalog.json'), 'utf8'));
  await db.batch([db.prepare('DELETE FROM catalog_items'), ...catalog.map((c) => db.prepare('INSERT INTO catalog_items (name, type, description, triggers, plugin, includes, version, tokens, body, starter, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(c.name, c.type, c.description, c.triggers, c.plugin, JSON.stringify(c.includes), c.version, c.tokens, c.body, c.starter ? 1 : 0, 'now'))]);
  // A key that exists only while this runs, for the check-in below (never written anywhere).
  const key = `tsk_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(key).digest('base64url');
  await db.batch([db.prepare("DELETE FROM sync_keys WHERE label = 'city view'"), db.prepare("INSERT INTO sync_keys (id, owner, kind, hash, label, enabled, created_at) VALUES ('local', 'me', 'sync', ?, 'city view', 1, ?)").bind(hash, new Date().toISOString())]);
  const project = projectId(root);
  // The check-in: this project's skills, each AI's list, the library and the summary, into the local database;
  // skills and notes added in the city come back down as files.
  const checkIn = () => sync(root, { key, url: 'http://local/api/sync', fetchImpl: (url, init) => handleSync(new Request(url, init), env, { json, refuse }) });
  await checkIn();

  const api = async (route, body, query) => {
    if (!query.get('project') && !body.project) query.set('project', project); // this project unless another is chosen
    if (route === 'GET /api/session') return { unlocked: true, hasPasskeys: true, email: 'local' };
    if (route === 'GET /api/keys') return { keys: [] };
    if (route === 'GET /api/savings') return savings(root);
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
    const out = await server.itemsApi(route, body, db, query, 'me', { id: project, name: project }); // this project is the city shown
    if (route === 'GET /api/skills' && out?.project === project) { out.layout = readLayout(root); out.design = readDesign(root); }
    if (out && !out.error && route.startsWith('POST ')) await checkIn().catch(() => {}); // what was just added is a file in this project before the answer
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
  return { url: `http://${host}:${http1.address().port}/`, close: () => new Promise((ok) => http1.close(ok)), db };
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
  const v = await startView(root, { port: i >= 0 ? Number(args[i + 1]) : 0, view });
  console.log(`Your city: ${v.url}  (only on this computer; stop with Ctrl+C)`);
}
