// `city ais`: get this project ready for other AIs (Grok, Meta Muse, ChatGPT, Gemini) that read it
// through GitHub: the start-here file (AGENTS.md), a shared/ folder with each AI's one-time setup and
// the library, and the context they read (.city/BLINK.md, MAP.md, GRAPH.md, snips). Nothing that is
// already there is overwritten. Prints the one message to send each AI.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));
export const AIS = { grok: 'Grok', muse: 'Meta Muse', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const git = (root, ...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

// owner/name from the git address (github.com/owner/name or git@github.com:owner/name).
export function repoName(root) {
  const url = git(root, 'remote', 'get-url', 'origin').replace(/\.git$/, '');
  return url.match(/[/:]([^/:]+\/[^/]+)$/)?.[1] ?? path.basename(root);
}

export async function prepareAis(root) {
  const repo = repoName(root), branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD') || 'main';
  const made = [];
  const put = (rel, text) => {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    made.push(rel);
  };
  put('AGENTS.md', fs.readFileSync(path.join(TEMPLATES, 'AGENTS.md'), 'utf8'));
  put('shared/README.md', fs.readFileSync(path.join(TEMPLATES, 'shared/README.md'), 'utf8'));
  put('shared/notes/README.md', fs.readFileSync(path.join(TEMPLATES, 'shared/notes/README.md'), 'utf8'));
  const ai = fs.readFileSync(path.join(TEMPLATES, 'shared/AI.md'), 'utf8');
  for (const [id, name] of Object.entries(AIS)) put(`shared/${id}.md`, ai.replaceAll('{{repo}}', repo).replaceAll('{{branch}}', branch).replaceAll('{{name}}', name).replaceAll('{{ai}}', id));
  // The context they read, written now (and refreshed on every push from here on).
  const { publishContext } = await import('../session.mjs');
  await publishContext(root);
  const message = `Set up Talenscape from GitHub: repo ${repo}, branch ${branch}. Read AGENTS.md there and follow it.`;
  return { made, repo, branch, message };
}

export async function main() {
  const r = await prepareAis(process.cwd());
  console.log(`${r.made.length ? `Made: ${r.made.join(', ')}` : 'Already set up.'} Context for other AIs written (.city/BLINK.md, MAP.md, GRAPH.md, snips).`);
  console.log('Next: commit and push these files (with .city/BLINK.md, MAP.md, GRAPH.md and .city/snips), so the AIs can read them on GitHub.');
  console.log(`Then send this once to each AI (Grok, Meta Muse, ChatGPT…) that can read GitHub:\n\n  ${r.message}\n`);
}
