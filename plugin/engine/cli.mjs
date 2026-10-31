// The `city` command: one short entry point for everything Talenscape does.
// Runs against the project (git top folder, or the current folder); `city run` runs where you are.

import { execFileSync } from 'node:child_process';

const HELP = `city <command> …
  blink | wrapup --last … --next … | decisions      session start / end
  context [--commit]                                refresh what other AIs read
  check [--no-bench]                                ready to call it done?
  checkpoint ["why"] | checkpoints | rollback [id]   snapshots and undo
  note "…" | note --fact "…" | facts <words>        notes that survive; lasting facts
  notes [--for grok] | notes check | notes index      the library: who reads which note
  catalog | catalog add <folder>… | catalog check     every project in one place; what changed since
  catalog find <words>                              an exact word across every project
  frontdoor [--setup-script]                        hooks for chats opened on the folder holding all projects
  ask <words> | where | deps | uses | impact <name> | connect <a> <b> | snip <name>
  search <words> | show <file> <from>-<to> | index    the project map
  run <command> | run --log N [words]                 trimmed command output
  check-skills | sync                                 check the skills shelf; sync with the app
  license [key] | ping [on|off]                       City plan key; the weekly anonymous count
  fresh [on|off|limit N]                             long chat: carry on in a new chat by itself
  receipt [chat.jsonl]                              where this chat's tokens went
  ais                                               get this project ready for Grok, Muse, ChatGPT…
  install <project folder>                          put Talenscape inside another project`;
const SESSION = new Set(['blink', 'wrapup', 'decisions', 'note', 'facts', 'context']);
const SAFETY = new Set(['checkpoint', 'checkpoints', 'rollback']);
const MAP = new Set(['index', 'ask', 'where', 'deps', 'uses', 'impact', 'connect', 'snip', 'search', 'show']);

function projectRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return process.cwd();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const root = process.env.TALENSCAPE_ROOT || process.env.CLAUDE_PROJECT_DIR || projectRoot();
process.env.TALENSCAPE_ROOT = root;

if (cmd === 'run') {
  await (await import('./run.mjs')).main(rest);
} else if (cmd === 'fresh') {
  (await import('./lib/fresh.mjs')).main(root, rest);
} else if (cmd === 'receipt') {
  (await import('./lib/receipt.mjs')).main(root, rest);
} else if (cmd === 'habit' || cmd === 'habits') {
  (await import('./lib/habits.mjs')).main(root, rest);
} else if (cmd === 'frontdoor') {
  await (await import('./lib/frontdoor.mjs')).main(root, rest);
} else if (cmd === 'catalog') {
  await (await import('./lib/catalog.mjs')).main(root, rest);
} else if (cmd === 'notes') {
  (await import('./lib/notes.mjs')).main(root, rest);
} else if (cmd === 'install') {
  (await import('./lib/install.mjs')).main(rest);
} else if (SESSION.has(cmd) || MAP.has(cmd) || SAFETY.has(cmd) || cmd === 'check-skills' || cmd === 'check' || cmd === 'sync' || cmd === 'ais' || cmd === 'view' || cmd === 'license' || cmd === 'ping' || cmd === 'export') {
  process.chdir(root);
  if (SESSION.has(cmd)) await (await import('./session.mjs')).main([cmd, ...rest]);
  else if (MAP.has(cmd)) await (await import('./city.mjs')).main([cmd, ...rest]);
  else if (cmd === 'check') await (await import('./check.mjs')).main(rest);
  else if (SAFETY.has(cmd)) (await import('./guard.mjs')).main([cmd, ...rest]);
  else if (cmd === 'sync') await (await import('./lib/sync.mjs')).main(rest);
  else if (cmd === 'view') await (await import('./view.mjs')).main(rest);
  else if (cmd === 'license') await (await import('./lib/license.mjs')).main(rest);
  else if (cmd === 'ping') (await import('./lib/ping.mjs')).main(rest);
  else if (cmd === 'export') (await import('./lib/export.mjs')).main(rest);
  else if (cmd === 'ais') await (await import('./lib/ais.mjs')).main(rest);
  else (await import('./skills.mjs')).main(['check']);
} else {
  console.log(HELP);
  process.exitCode = cmd ? 1 : 0;
}
