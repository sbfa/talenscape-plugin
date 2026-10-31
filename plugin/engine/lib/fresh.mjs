// Fresh start: every reply re-reads the whole chat, so a long chat gets expensive. When this is
// switched on and the chat passes the limit, Claude is told (once, and again at twice the limit) to
// hand over and carry on in a new Claude Code chat by itself, named so a long job reads as
// "part 2", "part 3", … "finished".
//   city fresh            show whether it's on     city fresh on | off   switch it
//   city fresh limit N    change the limit (tokens)
// The setting lives in .city/state.json (saved with the project, so every new chat sees it). Off
// unless a project switches it on.
import fs from 'node:fs';
import path from 'node:path';

export const FRESH_START_TOKENS = 300_000;
const TAIL_BYTES = 512 * 1024;
const stateFile = (root) => path.join(root, '.city', 'state.json');
const fmt = (n) => n.toLocaleString('en-US');

export function freshSetting(root) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { /* no project notes yet */ }
  const f = st.freshStart ?? {};
  return { on: f.on === true, limit: Number.isInteger(f.limit) && f.limit > 0 ? f.limit : FRESH_START_TOKENS };
}

export function setFresh(root, change) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { /* first setting */ }
  st.freshStart = { ...freshSetting(root), ...change };
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify(st, null, 2) + '\n');
  return describe(st.freshStart);
}

const describe = ({ on, limit }) => on
  ? `Fresh start: on. Past ${fmt(limit)} tokens, the chat hands over and carries on in a new chat by itself. city fresh off stops it.`
  : `Fresh start: off (city fresh on to switch it on; the limit is ${fmt(limit)} tokens).`;

// The chat's size now: the last Claude reply's usage in the chat record (one JSON entry per line).
// Only the end of the file is read, so long chats stay fast. null when it can't tell.
export function chatSize(transcriptPath) {
  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let u;
    try { const e = JSON.parse(lines[i]); u = e.type === 'assistant' && e.message?.usage; } catch { continue; }
    if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return null;
}

// What Claude is told to do at the limit: everything it needs, in one message, so it works the same
// on the owner's message or partway through a job.
export function handOver(n, limit) {
  return `Talenscape fresh start: this chat is about ${fmt(n)} tokens (limit ${fmt(limit)}), and every reply re-reads all of it. ` +
    'Carry on in a new chat now, without asking the owner (they switched this on): ' +
    '1) stop soon: finish only the change you are in the middle of, so everything is saved and the tests pass; do not start the next piece of work, the new chat does it; ' +
    '2) city wrapup --last … --next … with exactly where things stand (what is done, what is left, the next step, open questions), short; commit and push; ' +
    '3) open a new Claude Code chat (create_session: this repository, the branch you are on) titled "Talenscape: <the job> · part N+1" (N = this chat\'s part from its title, 1 if none), ' +
    'with the prompt: "Continue Talenscape from the blink: <the job>, part N+1. First archive the previous chat <this chat\'s session id> (archive_session). Carry on with the step the owner already approved; ask before any new step, as always. ' +
    'When the whole job is done, rename this chat \'Talenscape: <the job> · finished ✅\' (set_session_title)."; ' +
    '4) rename this chat "Talenscape: <the job> · handed over to part N+1"; ' +
    '5) tell the owner in one line: "This chat got long, so I\'ve carried on in a new one: <link>". ' +
    'If you cannot open a chat yourself, tell the owner in plain words to start a new one: the hand-over is saved.';
}

// One message for Claude when the chat passes the limit: once, and again at twice the limit.
// Remembers per chat what it already said, so it never nags. Silent when switched off.
export function sizeCheck(root, { transcriptPath, chat } = {}) {
  if (!transcriptPath) return null;
  const { on, limit } = freshSetting(root);
  if (!on) return null;
  const n = chatSize(transcriptPath);
  if (n == null || n < limit) return null;
  const level = n >= 2 * limit ? 2 : 1;
  const said = path.join(root, '.city', 'size.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(said, 'utf8')); } catch { /* first time */ }
  const key = chat || transcriptPath;
  if ((st[key] ?? 0) >= level) return null;
  st[key] = level;
  fs.mkdirSync(path.dirname(said), { recursive: true });
  fs.writeFileSync(said, JSON.stringify(st));
  return handOver(n, limit);
}

export function main(root, [arg, value]) {
  if (arg === 'on' || arg === 'off') { console.log(setFresh(root, { on: arg === 'on' })); return; }
  if (arg === 'limit') {
    const limit = Number(String(value ?? '').replace(/[,_]/g, ''));
    if (!Number.isInteger(limit) || limit < 10_000) { console.log('city fresh limit <tokens>, at least 10,000 (for example 300000).'); process.exitCode = 1; return; }
    console.log(setFresh(root, { limit }));
    return;
  }
  console.log(describe(freshSetting(root)));
}
