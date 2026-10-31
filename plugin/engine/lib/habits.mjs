// Habits: the owner's standing instructions every AI follows (the OWNER and RULES lines of the blink).
// Each can be switched off (kept, but not in the blink, so it costs nothing) and back on, changed or
// dropped: in a chat (`city habit …`) or in the app, whose changes arrive at the next check-in.
// kind: 'me' (how to work with the owner, the OWNER line) or 'rule' (the RULES line).

import fs from 'node:fs';
import path from 'node:path';
import { tokens } from './tokens.mjs';
import { listHabits, applyHabit } from './skill-rules.mjs';

export { listHabits, applyHabit };

const ROOM = 140; // tokens of switched-on habits before Talenscape suggests merging or switching some off

const stateFile = (root) => path.join(root, '.city', 'state.json');
const read = (root) => { try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return {}; } };
const write = (root, st) => { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), JSON.stringify(st, null, 2) + '\n'); };

// Changes made in the app, brought down by a check-in: applied to this project's habits.
export function applyHabits(root, changes) {
  if (!changes?.length) return 0;
  const st = read(root);
  const n = changes.filter((c) => applyHabit(st, c)).length;
  if (n) write(root, st);
  return n;
}

export const habitsOf = (root) => listHabits(read(root));

function show(st) {
  const all = listHabits(st);
  const on = all.filter((h) => h.on), room = tokens(on.map((h) => h.text).join(' · '));
  return [
    ...all.map((h, i) => `${i + 1}. [${h.on ? 'on ' : 'off'}] ${h.kind === 'me' ? '(you) ' : ''}${h.text}`),
    `${on.length} on (~${room} tokens in every chat)${room > ROOM ? ': getting long; merge or switch some off' : ''}, ${all.length - on.length} off.`,
    'Change: city habit add "words" [--me] | on N | off N | edit N "words" | drop N',
  ].join('\n');
}

// city habit                          list them, numbered
// city habit add "words" [--me]       a new habit (--me: about how to work with the owner)
// city habit on|off|drop N            switch one on or off, or drop it
// city habit edit N "new words"
export function main(root, [action, ...rest]) {
  const st = read(root);
  if (!action) { console.log(show(st)); return; }
  const all = listHabits(st), n = Number(rest[0]), pick = all[n - 1];
  let c;
  if (action === 'add') c = { action, text: rest.filter((a) => a !== '--me').join(' '), kind: rest.includes('--me') ? 'me' : 'rule' };
  else if (['on', 'off', 'drop', 'edit'].includes(action)) {
    if (!pick) { console.log(`No habit ${rest[0] ?? ''}: pick a number from city habit.`); process.exitCode = 1; return; }
    c = { action, text: pick.text, to: rest.slice(1).join(' ') };
  } else { console.log('city habit [add "words" [--me] | on N | off N | drop N | edit N "new words"]'); process.exitCode = 1; return; }
  if (!applyHabit(st, c)) { console.log('Nothing changed (already like that, or empty).'); return; }
  write(root, st);
  console.log(show(st));
}
