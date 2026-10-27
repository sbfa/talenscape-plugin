// The 3D city isn't in the public download: `city view` gets it from talenscape.com with the person's
// City key (free during early access, a paid key, or a gift), checks its fingerprint, and keeps it in
// the home folder (~/.config/talenscape/city/<version>/), so it works offline after that. A newer
// version comes down by itself; a broken or tampered download is never used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const CITY_URL = 'https://talenscape.com/api/city/download';
export const GET_KEY = 'The 3D city needs a City key: free during early access. Get yours at talenscape.com/city, then type: city license YOUR-KEY';
const base = (home) => path.join(home, '.config', 'talenscape', 'city');
const current = (home) => { try { return JSON.parse(fs.readFileSync(path.join(base(home), 'current.json'), 'utf8')); } catch { return null; } };
const ready = (dir) => !!dir && fs.existsSync(path.join(dir, 'server', 'items.mjs')) && fs.existsSync(path.join(dir, 'app', 'home.html'));

// The folder holding the city, downloading or updating it first when needed. { dir } or { error }.
export async function ensureCity(key, { home = os.homedir(), fetchImpl = fetch } = {}) {
  const have = current(home), haveDir = have && path.join(base(home), have.version);
  if (!key) return { error: GET_KEY };
  let out;
  try {
    const res = await fetchImpl(CITY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, have: ready(haveDir) ? have.version : null }), signal: AbortSignal.timeout(60000) });
    out = await res.json().catch(() => ({}));
    if (!res.ok) return ready(haveDir) && res.status >= 500 ? { dir: haveDir } : { error: out.error || `talenscape.com answered ${res.status}` };
  } catch {
    return ready(haveDir) ? { dir: haveDir, offline: true } : { error: 'Can\'t reach talenscape.com to get the city. Check the connection and try again.' };
  }
  if (out.same && ready(haveDir)) return { dir: haveDir };
  const gz = Buffer.from(String(out.data ?? ''), 'base64');
  if (!/^[\w.-]{1,40}$/.test(String(out.version)) || crypto.createHash('sha256').update(gz).digest('hex') !== out.sha256) return { error: 'The city download didn\'t check out (its fingerprint is wrong). Try again.' };
  const { files } = JSON.parse(gunzipSync(gz).toString('utf8'));
  const dir = path.join(base(home), out.version), tmp = `${dir}.part`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, b64] of Object.entries(files)) {
    const to = path.resolve(tmp, rel);
    if (!to.startsWith(tmp + path.sep)) continue; // only inside its own folder
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, Buffer.from(b64, 'base64'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  fs.writeFileSync(path.join(base(home), 'current.json'), JSON.stringify({ version: out.version }) + '\n');
  for (const old of fs.readdirSync(base(home))) if (old !== out.version && old !== 'current.json') fs.rmSync(path.join(base(home), old), { recursive: true, force: true }); // only the newest is kept
  return { dir, updated: true };
}
