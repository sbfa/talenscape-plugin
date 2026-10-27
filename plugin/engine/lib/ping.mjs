// The weekly "still here" count: once a week an installed copy sends talenscape.com a random number
// (made on this computer, not tied to anyone) and the version. Never names, projects or code.
//   city ping        show whether it's on     city ping off | on   switch it
// Only installed plugins send it (not project checkouts or tests); TALENSCAPE_NO_PING=1 also stops it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const URL = 'https://talenscape.com/api/ping';
const WEEK_MS = 7 * 24 * 3600e3;
const file = (home) => path.join(home, '.config', 'talenscape', 'install.json');
function read(home) { try { return JSON.parse(fs.readFileSync(file(home), 'utf8')); } catch { return null; } }
function save(home, data) {
  fs.mkdirSync(path.dirname(file(home)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(home), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
const fresh = () => ({ install: crypto.randomBytes(16).toString('hex'), off: false, sentAt: 0 });

// Called at session start; quick, quiet, never holds up or breaks the session.
export async function weeklyPing({ home = os.homedir(), env = process.env, fetchImpl = fetch, now = Date.now(), version = '' } = {}) {
  if (!env.CLAUDE_PLUGIN_ROOT || env.TALENSCAPE_NO_PING) return 'skipped';
  const s = read(home) ?? fresh();
  if (s.off) return 'off';
  if (now - s.sentAt < WEEK_MS) return 'sent this week';
  try {
    const res = await fetchImpl(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ install: s.install, version }), signal: AbortSignal.timeout(2500) });
    if (!res.ok) return 'not counted';
    save(home, { ...s, sentAt: now });
    return 'sent';
  } catch { return 'offline'; }
}

export function setPing(on, { home = os.homedir() } = {}) {
  const s = read(home) ?? fresh();
  save(home, { ...s, off: !on });
  return !on ? 'Weekly count off: this computer sends nothing.' : 'Weekly count on: a random number and the version, once a week.';
}

export function main([arg]) {
  if (arg === 'off' || arg === 'on') { console.log(setPing(arg === 'on')); return; }
  const s = read(os.homedir());
  console.log(s?.off ? 'Weekly count: off (city ping on to switch it back).' : 'Weekly count: on. Once a week, a random number and the version go to talenscape.com: never names, projects or code. city ping off stops it.');
}
