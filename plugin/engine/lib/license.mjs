// The City plan's license key (sold through Lemon Squeezy). The free token saver never needs one;
// the city view and the multi-AI extras do.
//   city license <key>   activate the key on this computer
//   city license         show the plan on this computer
// The key is kept in the person's home folder (~/.config/talenscape/license.json, only they can read
// it), never in a project, so it isn't committed. It is checked with Lemon Squeezy's public license
// address (no secret of ours is involved) once a week; offline, a checked key keeps working for two weeks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Filled in when the store exists: only keys for this store and product count. Until then (null),
// nothing is locked.
export const STORE = { id: null, product: null };
export const enforced = () => STORE.id !== null;

const API = 'https://api.lemonsqueezy.com/v1/licenses';
// Gift keys (TSG-…) come from the owner's Owner page, not Lemon Squeezy, and are checked with talenscape.com.
const GIFT_API = 'https://talenscape.com/api/gift/check';
const GIFT_KEY = /^TSG-[a-f0-9]{32}$/;
const RECHECK_MS = 7 * 24 * 3600e3, GRACE_MS = 14 * 24 * 3600e3;
export const licenseFile = (home = os.homedir()) => path.join(home, '.config', 'talenscape', 'license.json');

function read(home) { try { return JSON.parse(fs.readFileSync(licenseFile(home), 'utf8')); } catch { return null; } }
function save(home, data) {
  const f = licenseFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function giftCall(fetchImpl, key) {
  const res = await fetchImpl(GIFT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }), signal: AbortSignal.timeout(15000) });
  return res.json().catch(() => ({ ok: false, why: `talenscape.com answered ${res.status}` }));
}

async function call(fetchImpl, action, fields) {
  const res = await fetchImpl(`${API}/${action}`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(15000) });
  return res.json().catch(() => ({ error: `Lemon Squeezy answered ${res.status}` }));
}

// The key belongs to our store and product, and is on.
function ours(out) {
  if (out.error) return out.error;
  if (out.valid === false || out.activated === false) return 'That key is not active.';
  if (STORE.id !== null && out.meta?.store_id !== STORE.id) return 'That key is for a different store.';
  if (STORE.product !== null && out.meta?.product_id !== STORE.product) return 'That key is for a different product.';
  if (out.license_key && !['active', 'inactive'].includes(out.license_key.status)) return `That key is ${out.license_key.status}.`;
  return null;
}

export async function activate(key, { home = os.homedir(), fetchImpl = fetch, now = Date.now() } = {}) {
  key = String(key ?? '').trim();
  const offline = { ok: false, error: 'Can\'t reach the key check. Check the internet connection and try again.' };
  if (GIFT_KEY.test(key)) {
    let out;
    try { out = await giftCall(fetchImpl, key); } catch { return offline; }
    if (!out.ok) return { ok: false, error: out.why || 'That gift is not active.' };
    save(home, { key, gift: true, ends: out.ends ?? null, checkedAt: now });
    return { ok: true, gift: true, early: out.name === 'Early access', ends: out.ends ?? null };
  }
  if (!/^[A-Za-z0-9-]{16,100}$/.test(key)) return { ok: false, error: 'That does not look like a license key.' };
  let out;
  try { out = await call(fetchImpl, 'activate', { license_key: key, instance_name: `${os.hostname()} (Talenscape)` }); } catch { return offline; }
  const bad = ours(out);
  if (bad) return { ok: false, error: bad };
  save(home, { key, instance: out.instance?.id ?? null, email: out.meta?.customer_email ?? null, checkedAt: now });
  return { ok: true, email: out.meta?.customer_email ?? null };
}

// Is the City plan on here? { ok, why } — re-checks with Lemon Squeezy when the last check is a week old.
export async function plan({ home = os.homedir(), fetchImpl = fetch, now = Date.now(), env = process.env } = {}) {
  if (!enforced()) return { ok: true, why: 'not locked yet' };
  const lic = read(home) ?? (env.TALENSCAPE_LICENSE ? { key: env.TALENSCAPE_LICENSE, instance: null, checkedAt: 0 } : null);
  if (!lic) return { ok: false, why: 'no license key on this computer' };
  if (now - lic.checkedAt < RECHECK_MS) return { ok: true, why: 'checked this week' };
  let out;
  try { out = lic.gift ? await giftCall(fetchImpl, lic.key) : await call(fetchImpl, 'validate', { license_key: lic.key, ...(lic.instance ? { instance_id: lic.instance } : {}) }); }
  catch { return now - lic.checkedAt < GRACE_MS ? { ok: true, why: 'offline, still within two weeks' } : { ok: false, why: 'not checked for two weeks (offline?)' }; }
  const bad = lic.gift ? (out.ok ? null : out.why || 'That gift is not active.') : ours(out);
  if (bad) return { ok: false, why: bad };
  if (read(home)) save(home, { ...lic, checkedAt: now });
  return { ok: true, why: 'checked now' };
}

// The key kept on this computer (for the city download), or the TALENSCAPE_LICENSE setting.
export const savedKey = ({ home = os.homedir(), env = process.env } = {}) => read(home)?.key ?? env.TALENSCAPE_LICENSE ?? null;

export const NEED = 'The city view is part of the City plan ($7 a month at talenscape.com). Got a key? Run: city license <your key>';

export async function main([key]) {
  if (key) {
    const r = await activate(key);
    const until = r.ends ? `, until ${new Date(r.ends * 1000).toDateString()}` : '';
    console.log(r.ok ? `City plan on for this computer${r.early ? ' (free early access). Now type: city view' : r.gift ? ` (a gift${until})` : r.email ? ` (${r.email})` : ''}.` : `Not activated: ${r.error}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  const p = await plan();
  console.log(p.ok ? `City plan: on (${p.why}).` : `City plan: off (${p.why}). ${NEED}`);
}
