// Live traffic: each skill or tool the AI uses lights up its building in the owner's open cities.
// The "after a tool ran" hook (this file, after every tool) only notes the name in .city/pulse.txt,
// which takes a few milliseconds and prints nothing. One sender in the background takes what has been noted every few
// seconds and sends it as one small message (names and counts only, never what the tool did) to
// share.talenscape.com/api/pulse with the project key; after a quiet while it stops. No key: nothing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readKey, projectId, isScratch, SYNC_URL } from './sync.mjs';

export const EVERY_MS = 4000, QUIET_ROUNDS = 3, STALE_MS = 30_000;
const NAME_RE = /^[A-Za-z0-9_:.-]{1,60}$/;
const files = (root) => ({ queue: path.join(root, '.city', 'pulse.txt'), lock: path.join(root, '.city', 'pulse.lock') });

// The name the city knows it by: a skill's own name, a connector's name (mcp__<name>__tool), or the tool's.
export function pulseName(input) {
  const tool = String(input?.tool_name ?? '');
  const name = tool === 'Skill' ? String(input?.tool_input?.skill ?? '') : tool.match(/^mcp__(.+?)__/)?.[1] ?? tool;
  return NAME_RE.test(name) ? name : null;
}

// From the hook: note the name, and start the sender unless one is already at work.
export function notePulse(root, input, { env = process.env, home = os.homedir(), start = startSender } = {}) {
  const name = pulseName(input);
  if (!name || !readKey(env, home)) return false;
  if (start === startSender && isScratch(root, env)) return false; // tests and temp folders never reach the live app
  const { queue, lock } = files(root);
  fs.mkdirSync(path.dirname(queue), { recursive: true });
  fs.appendFileSync(queue, `${name}\n`);
  let busy = false;
  try { busy = Date.now() - fs.statSync(lock).mtimeMs < STALE_MS; } catch { /* no sender */ }
  if (!busy) { fs.writeFileSync(lock, String(process.pid)); start(root); }
  return true;
}

function startSender(root) {
  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), 'send', root], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

// Takes what has been noted so far: [{ name, n }], most used first.
export function takeNoted(root) {
  const { queue } = files(root), taking = `${queue}.${process.pid}`;
  try { fs.renameSync(queue, taking); } catch { return []; }
  const counts = new Map();
  for (const n of fs.readFileSync(taking, 'utf8').split('\n')) if (NAME_RE.test(n)) counts.set(n, (counts.get(n) ?? 0) + 1);
  fs.rmSync(taking, { force: true });
  return [...counts].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}

export async function sendLoop(root, { env = process.env, home = os.homedir(), fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { lock } = files(root), key = readKey(env, home), project = projectId(root);
  const url = `${new URL(env.TALENSCAPE_SYNC_URL || SYNC_URL).origin}/api/pulse`;
  let quiet = 0, sent = 0;
  try {
    while (quiet < QUIET_ROUNDS) {
      await wait(EVERY_MS);
      try { fs.utimesSync(lock, new Date(), new Date()); } catch { /* gone: carry on */ }
      const names = takeNoted(root);
      if (!names.length) { quiet++; continue; }
      quiet = 0;
      try {
        await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ project, names }), signal: AbortSignal.timeout(5000) });
        sent++;
      } catch { /* offline: this batch is skipped, it was only for show */ }
    }
  } finally { fs.rmSync(lock, { force: true }); }
  return sent;
}

async function hook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try { const input = JSON.parse(raw); notePulse(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), input); } catch { /* only for show: never in the way */ }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'send') sendLoop(process.argv[3]).catch(() => {});
  else hook();
}
