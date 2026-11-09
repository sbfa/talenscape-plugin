// Which AIs may change this project's code (owner 2026-11-09: "a switch or option where people can choose to let
// whatever ai they want change their code ... its their own projects"). Each person decides for their own
// projects only: the choice lives in the project (.city/editors.json) and in that person's own city online,
// never anyone else's. Claude Code always may; every other AI hands changes back until switched on here.
// where: "branch" (their changes go on a branch of their own, for the project's owner to take in) or "main".
import fs from 'node:fs';
import path from 'node:path';

import { EDIT_AIS, AI_NAMES, EDIT_BRANCH, cleanEditors, editsLine } from './skill-rules.mjs'; // shared with the online city
export { EDIT_AIS, AI_NAMES, EDIT_BRANCH, cleanEditors, editsLine };
const FILE = (root) => path.join(root, '.city', 'editors.json');
export function readEditors(root) {
  try { return cleanEditors(JSON.parse(fs.readFileSync(FILE(root), 'utf8'))); } catch { return null; } // null: never set here
}
export function writeEditors(root, v) {
  const clean = cleanEditors(v);
  fs.mkdirSync(path.dirname(FILE(root)), { recursive: true });
  fs.writeFileSync(FILE(root), JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

// city editors                    who may change the code here
// city editors muse on|off        let an AI change it, or not
// city editors where branch|main  where their changes go
export function main(args, root = process.cwd()) {
  const now = readEditors(root) ?? cleanEditors({});
  const [a, b] = args.map((x) => String(x).toLowerCase());
  if (a === 'where' && (b === 'branch' || b === 'main')) writeEditors(root, { ...now, where: b });
  else if (EDIT_AIS.includes(a) && (b === 'on' || b === 'off')) writeEditors(root, { ...now, ais: b === 'on' ? [...now.ais, a] : now.ais.filter((x) => x !== a) });
  else if (a) { console.log(`Usage: city editors [${EDIT_AIS.join('|')} on|off] [where branch|main]`); process.exitCode = 1; return; }
  const e = readEditors(root) ?? now;
  console.log(e.ais.length ? `May change this project's code: Claude Code, ${e.ais.map((x) => AI_NAMES[x]).join(', ')} (their changes go ${e.where === 'main' ? 'straight on main' : `on the branch ${EDIT_BRANCH}`}).` : 'Only Claude Code may change this project\'s code. Let another AI: city editors <ai> on');
}
