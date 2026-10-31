// The front door: Claude Code reads hooks only from the folder a chat starts in. A chat opened on the folder
// that holds all the owner's projects (on a computer, the projects folder; in the cloud, a chat with several
// repositories attached) never sees this project's hooks, so no blink, no steering, no trimming. This writes
// the same hooks into that folder's .claude/settings.json, pointed at this project, merged with whatever is
// there (ours are recognised by the marker at the end of each command and refreshed). Never in the home
// folder itself: there they would run in every Claude Code chat on the computer.
//   city frontdoor                 write them (also done at install and at each chat start)
//   city frontdoor --setup-script  print a script for a cloud environment's Setup script, which runs
//                                  before every cloud chat (the container starts fresh each time)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './catalog.mjs';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const MARK = '# talenscape-front-door';
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export function frontDoorHooks(root, plugin = PLUGIN) {
  const env = `CLAUDE_PROJECT_DIR=${q(root)}`;
  const guard = (file, cmd) => `[ -f ${q(file)} ] && ${env} ${cmd} || true ${MARK}`;
  return {
    SessionStart: { command: guard(`${plugin}/hooks/start.sh`, `sh ${q(`${plugin}/hooks/start.sh`)}`), timeout: 120 },
    PreToolUse: { matcher: 'Read|Bash|Grep|Write|Edit|MultiEdit|NotebookEdit', command: guard(`${plugin}/engine/steer.mjs`, `node --no-warnings ${q(`${plugin}/engine/steer.mjs`)}`), timeout: 30 },
    UserPromptSubmit: { command: guard(`${plugin}/engine/peek.mjs`, `node --no-warnings ${q(`${plugin}/engine/peek.mjs`)}`), timeout: 15 },
  };
}

export function merged(settings, hooks) {
  const out = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const [event, h] of Object.entries(hooks)) {
    const list = (out.hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some((x) => String(x.command).includes(MARK)));
    list.push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: h.command, timeout: h.timeout }] });
    out.hooks[event] = list;
  }
  return out;
}

// Returns { written: file } or { skipped: why }.
export function frontDoor(root, { home = os.homedir(), plugin = PLUGIN } = {}) {
  const parent = path.dirname(path.resolve(root));
  if (path.resolve(parent) === path.resolve(home) || parent === path.parse(parent).root) return { skipped: 'the folder above is your home folder or the top of the disk: hooks there would run in every chat' };
  if (!discover(root).length) return { skipped: 'no other projects next to this one' };
  const file = path.join(parent, '.claude', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (fs.existsSync(file)) return { skipped: `${file} is not valid JSON: left alone` }; }
  const next = JSON.stringify(merged(settings, frontDoorHooks(path.resolve(root), plugin)), null, 2) + '\n';
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (old === next) return { written: file, unchanged: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return { written: file };
}

// For a cloud environment's Setup script: writes the front-door hooks before each chat, whether or not the
// repositories are cloned yet (each hook checks its file is there when it runs).
export function setupScript(root, plugin = PLUGIN) {
  const parent = path.dirname(path.resolve(root));
  const json = JSON.stringify(merged({}, frontDoorHooks(path.resolve(root), plugin)), null, 2);
  return `# Talenscape: start-of-chat summary and helpers in chats with several repositories attached.\nmkdir -p ${q(`${parent}/.claude`)}\ncat > ${q(`${parent}/.claude/settings.json`)} <<'TALENSCAPE_JSON'\n${json}\nTALENSCAPE_JSON\n`;
}

export async function main(root, args) {
  if (args.includes('--setup-script')) { process.stdout.write(setupScript(root)); return; }
  // In the cloud, hooks already in place before this chat mean the Setup script ran: the Setup card shows it done.
  // (Not when this container wrote them itself, in an earlier chat: that leaves a mark in its temp folder.)
  const wroteHere = path.join(os.tmpdir(), 'talenscape-front-door-written');
  if (process.env.CLAUDE_CODE_REMOTE === 'true' && !fs.existsSync(wroteHere)) { try { if (fs.readFileSync(path.join(path.dirname(path.resolve(root)), '.claude', 'settings.json'), 'utf8').includes(MARK)) (await import('./setup.mjs')).noteFrontDoor(root, true); } catch { /* none yet */ } }
  const r = frontDoor(root);
  if (r.written && !r.unchanged) try { fs.writeFileSync(wroteHere, ''); } catch { /* no temp folder */ }
  if (!args.includes('--quiet')) console.log(r.written ? `${r.unchanged ? 'Already set' : 'Set'}: ${r.written}` : `Not set: ${r.skipped}`);
}
