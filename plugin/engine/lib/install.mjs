// `city install <project folder>`: put Talenscape inside another project, so it works there the same in
// Claude Code in the cloud and on a computer, with nothing to install and no key in any file:
//   .talenscape/plugin/            a copy of this plugin (run again to update it)
//   .claude/settings.json          its hooks (session start, before each tool, each owner message), merged
//   .claude/skills/talenscape/     the skill Claude reads for lookups and wrap-up
//   CLAUDE.md                      two lines: the blink at session start, the skill
// Anything the project already has is kept; Talenscape's own entries are added or refreshed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontDoor } from './frontdoor.mjs';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url));
const HOOKS = {
  SessionStart: { command: '"$CLAUDE_PROJECT_DIR"/.talenscape/plugin/hooks/start.sh', timeout: 120 },
  PreToolUse: { matcher: 'Read|Bash|Grep|Write|Edit|MultiEdit|NotebookEdit', command: 'node --no-warnings "$CLAUDE_PROJECT_DIR"/.talenscape/plugin/engine/steer.mjs', timeout: 30 },
  UserPromptSubmit: { command: 'node --no-warnings "$CLAUDE_PROJECT_DIR"/.talenscape/plugin/engine/peek.mjs', timeout: 15 },
  PostToolUse: [
    { matcher: 'mcp__.*', command: 'node --no-warnings "$CLAUDE_PROJECT_DIR"/.talenscape/plugin/engine/after.mjs', timeout: 15 },
    { command: 'node --no-warnings "$CLAUDE_PROJECT_DIR"/.talenscape/plugin/engine/lib/pulse.mjs', timeout: 5 }, // the city's live traffic
  ],
};
const CLAUDE_LINES = 'Session context arrives as a `[blink]` block at start (owner rules, decisions, where we left off).\nNo block? Run `city blink` (or `node .talenscape/plugin/engine/cli.mjs blink`) and follow it. Lookups and wrap-up: skill `talenscape`.\n';

export function install(target) {
  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`no folder at ${root}`);
  if (path.resolve(PLUGIN) === path.resolve(root, '.talenscape/plugin')) throw new Error('that is this copy itself');
  const done = [];
  // 1. The plugin itself (not its downloaded add-ons, which install on first use).
  // An update replaces the plugin's files but keeps the add-ons it already downloaded.
  const dest = path.join(root, '.talenscape', 'plugin');
  if (fs.existsSync(dest)) for (const f of fs.readdirSync(dest)) if (f !== 'node_modules') fs.rmSync(path.join(dest, f), { recursive: true, force: true });
  fs.cpSync(PLUGIN, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.endsWith('package-lock.json') });
  done.push('.talenscape/plugin/');
  // 2. Its hooks, merged with the project's own (Talenscape's are recognised by their path and refreshed).
  const file = path.join(root, '.claude', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
  settings.hooks ??= {};
  for (const [event, h] of Object.entries(HOOKS)) {
    const list = (settings.hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some((x) => String(x.command).includes('.talenscape/plugin/')));
    for (const one of [h].flat()) list.push({ ...(one.matcher ? { matcher: one.matcher } : {}), hooks: [{ type: 'command', command: one.command, timeout: one.timeout }] });
    settings.hooks[event] = list;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  done.push('.claude/settings.json');
  // The same hooks at the folder holding the owner's projects, for chats opened there (lib/frontdoor.mjs).
  const door = frontDoor(root, { plugin: path.join(root, '.talenscape', 'plugin') });
  if (door.written && !door.unchanged) done.push(door.written);
  // 3. The skills (talenscape, game-3d…), where Claude Code finds project skills.
  for (const name of fs.readdirSync(path.join(PLUGIN, 'skills'))) {
    const from = path.join(PLUGIN, 'skills', name, 'SKILL.md');
    if (!fs.existsSync(from)) continue;
    const skill = path.join(root, '.claude', 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.copyFileSync(from, skill);
    done.push(`.claude/skills/${name}/SKILL.md`);
  }
  // 4. CLAUDE.md: the two lines, once.
  const md = path.join(root, 'CLAUDE.md'), have = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
  if (!have.includes('[blink]')) { fs.writeFileSync(md, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${have ? '\n' : ''}${CLAUDE_LINES}`); done.push('CLAUDE.md'); }
  // 5. Keep the plugin's downloaded add-ons out of git.
  const gi = path.join(root, '.gitignore'), ign = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '', line = '.talenscape/plugin/node_modules/';
  if (!ign.split('\n').includes(line)) { fs.writeFileSync(gi, `${ign}${ign && !ign.endsWith('\n') ? '\n' : ''}${line}\n`); done.push('.gitignore'); }
  return done;
}

// What the person sees once it's in: what they got, where the city is, where to read more.
export const WELCOME = `Welcome to Talenscape.
- Your AI now starts every session with a short summary of where you left off, answers code questions
  in a few lines instead of whole files, and trims noisy command output.
- See your project as a 3D city: get a free City key at talenscape.com/city, type  city license YOUR-KEY,
  then  city view  (it opens on your computer).
- Features, pricing and help: talenscape.com`;

export function main([target]) {
  if (!target) { console.log('Usage: city install <project folder>'); process.exitCode = 1; return; }
  const done = install(target);
  console.log(`Talenscape is now inside ${path.resolve(target)}: ${done.join(', ')}.\nNext: commit and push those files in that project; its next Claude Code session starts with the blink.\n\n${WELCOME}`);
}
