// Connectors the owner switched off in the app, applied to Claude Code on this computer at check-in.
// Claude Code keeps a per-project list of switched-off connectors in ~/.claude.json, under
// projects["<absolute project path>"].disabledMcpServers. Talenscape only adds and removes the names it
// added itself (remembered in .city/connectors.json, which stays on this computer), so a connector the
// owner switched off by hand is never switched back on. Cloud chats are not on a computer: skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The documented form, not yet checked on a real computer: the tool prefix claude_ai_Gmail is the
// connector "claude.ai Gmail".
export const displayName = (name) => `claude.ai ${String(name).replace(/^claude_ai_/, '').replace(/_/g, ' ')}`;

const mineFile = (root) => path.join(root, '.city', 'connectors.json');
const readMine = (root) => { try { const v = JSON.parse(fs.readFileSync(mineFile(root), 'utf8')).added; return Array.isArray(v) ? v : []; } catch { return []; } };

// off: the owner's list of connector names (claude_ai_Gmail). Returns how many entries changed, or null when skipped.
export function applyConnectorsOff(root, off, { home = os.homedir(), env = process.env } = {}) {
  if (!Array.isArray(off) || env.CLAUDE_CODE_REMOTE === 'true') return null;
  const file = path.join(home, '.claude.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const key = path.resolve(root);
  const proj = cfg.projects?.[key] ?? {};
  const list = Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : [];
  const want = new Set(off.filter((n) => typeof n === 'string').map(displayName));
  const mine = new Set(readMine(root).filter((n) => list.includes(n))); // one the owner removed by hand is no longer ours
  const next = list.filter((n) => !mine.has(n) || want.has(n));
  for (const n of want) if (!next.includes(n)) { next.push(n); mine.add(n); }
  for (const n of mine) if (!want.has(n)) mine.delete(n);
  const changed = next.filter((n) => !list.includes(n)).length + list.filter((n) => !next.includes(n)).length;
  if (changed) {
    cfg.projects = { ...(cfg.projects ?? {}), [key]: { ...proj, disabledMcpServers: next } };
    const tmp = `${file}.talenscape-${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: fs.statSync(file).mode & 0o777 });
      fs.renameSync(tmp, file);
    } catch { fs.rmSync(tmp, { force: true }); return null; }
  }
  try { fs.mkdirSync(path.dirname(mineFile(root)), { recursive: true }); fs.writeFileSync(mineFile(root), JSON.stringify({ added: [...mine].sort() }) + '\n'); } catch { /* optional */ }
  return changed;
}
