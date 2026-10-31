#!/usr/bin/env node
// Claude Code "the owner sent a message" hook: has another AI left a note in the library since we
// last looked? Checks GitHub (a quiet git fetch, at most every 2 minutes) for new files in
// shared/notes/ and, if there are any, tells Claude in one line, so a note left mid-session is seen
// at the next message instead of the next session. Prints nothing otherwise; never blocks.
// Also passes on the fresh-start check (lib/fresh.mjs): past the limit, Claude hands over to a new chat.
// And what the owner changed in the app (skills, habits, notes) comes in here too (lib/sync.mjs appPeek).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sizeCheck } from './lib/fresh.mjs';

const EVERY_MS = 2 * 60 * 1000;
const git = (root, ...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim(); } catch { return null; } };

export function peek(root, { now = Date.now(), fetch = true } = {}) {
  const stateFile = path.join(root, '.city', 'peek.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first look */ }
  if (typeof st.at === 'number' && now - st.at < EVERY_MS) return null;
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch || branch === 'HEAD') return null;
  if (fetch) git(root, 'fetch', '-q', 'origin', branch);
  const remote = (git(root, 'ls-tree', '--name-only', `origin/${branch}`, 'shared/notes/') ?? '').split('\n').filter((f) => /\.md$/.test(f) && !/readme\.md$/i.test(f));
  const local = new Set(fs.existsSync(path.join(root, 'shared/notes')) ? fs.readdirSync(path.join(root, 'shared/notes')).map((f) => `shared/notes/${f}`) : []);
  const known = new Set(st.seen ?? []);
  const fresh = remote.filter((f) => !local.has(f) && !known.has(f));
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ at: now, seen: [...new Set([...known, ...remote])] }));
  if (!fresh.length) return null;
  const title = (f) => (git(root, 'show', `origin/${branch}:${f}`) ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(f, '.md');
  return `Talenscape library: ${fresh.length} new note(s) on GitHub, not in this copy yet: ${fresh.slice(0, 4).map((f) => `${path.basename(f).split('-')[0]}: ${title(f)} (${f})`).join('; ')}. Bring them in with git pull when it fits.`;
}

export async function main() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let input = {};
  try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* no hook message */ }
  const lines = [];
  try { lines.push(sizeCheck(root, { transcriptPath: input.transcript_path, chat: input.session_id })); } catch { /* never in the way */ }
  try { lines.push(peek(root)); } catch { /* never in the way */ }
  try { lines.push(await (await import('./lib/sync.mjs')).appPeek(root)); } catch { /* never in the way */ }
  const out = lines.filter(Boolean).join('\n');
  if (out) process.stdout.write(out + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
