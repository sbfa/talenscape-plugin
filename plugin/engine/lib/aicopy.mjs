// The AI copy: a small branch (talenscape-ai) with only the summary, the map and the shared files,
// as plain text in ordinary folders. For AIs that take in a whole project at once and choke on a big
// one (Gemini's code import): no code, no images, no hidden folders. Built without touching the
// working tree: a throwaway index, then a commit on the branch.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AI_BRANCH = 'talenscape-ai';

const README = (name) => `# ${name}: the AI copy

This is a small copy of the project for AIs that read a whole project at once (like Gemini's code
import). It holds only the summary, the map and the shared files: no code, no images.

1. Read \`BLINK.md\`: where the project left off, the owner's rules, decisions and what's next. Its rules
   apply to you too.
2. Making a skill, a tool or a plugin? Follow \`FORMATS.md\` exactly.
3. Then \`MAP.md\` and \`map/<area>.md\`: every file of the project, its pieces and their lines.
   \`GRAPH.md\`: what calls what. \`facts.md\`: more background.
4. \`shared/\`: each AI's list of skills, tools and plugins (yours is \`shared/<you>.md\`) and the
   library of notes, \`shared/notes/\`: \`NOTES.md\` lists the ones for you, each with its corrections.
   A question about another of the owner's projects: an exact word (a price, ID, address)? Search for it
   first. Vague? \`catalog/COMPANY.md\` (every project in one place, read once per chat), then that
   project's card, \`catalog/<project>.md\` (its key files).
5. Only the owner or Claude Code changes the project. You can't save here: hand anything to keep
   (your list, a note, a change) to the owner as text in your reply, and they pass it on.

This copy is rebuilt every time the project's work is pushed; import it again in a new chat to get
the latest.
`;

// Paths inside the project's hidden folder lose the folder name, the way they appear in the copy.
const plain = (text) => text.replace(/\.city\//g, '');

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim();
}

function filesOf(root) {
  const out = new Map();
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const have = (f) => fs.existsSync(path.join(root, f));
  out.set('README.md', README(path.basename(root)));
  for (const f of ['BLINK.md', 'MAP.md', 'GRAPH.md', 'NOTES.md', 'FORMATS.md', 'facts.md']) if (have(`.city/${f}`)) out.set(f, plain(read(`.city/${f}`)));
  // The map's how-to names the code pieces, which this copy leaves out.
  if (out.has('MAP.md')) out.set('MAP.md', out.get('MAP.md').replace(/^(# .*\n\n)[\s\S]*?\n(?=## )/, '$1'
    + 'Start with `BLINK.md` (where things stand). Then pick the area below and open its map: every file\n'
    + 'there, its pieces and their lines. What calls what: `GRAPH.md`. This copy has no code itself.\n\n'));
  if (have('.city/map')) for (const f of fs.readdirSync(path.join(root, '.city/map'))) out.set(`map/${f}`, plain(read(`.city/map/${f}`)).replace(/ A piece's own file: [^\n]*/, ''));
  if (have('.city/catalog')) for (const f of fs.readdirSync(path.join(root, '.city/catalog'), { recursive: true }).filter((x) => x.endsWith('.md'))) out.set(`catalog/${f.split(path.sep).join('/')}`, read(`.city/catalog/${f}`)); // with the big files' sections
  // Shared files as committed (the copy never carries unsaved work).
  for (const f of git(root, ['ls-files', '--', 'shared']).split('\n').filter((f) => f.endsWith('.md'))) out.set(f, read(f));
  return out;
}

// Brings the branch up to date. Returns 'updated', 'up to date' or 'skipped' (not a git project).
export function buildAiCopy(root) {
  try { git(root, ['rev-parse', '--git-dir']); } catch { return 'skipped'; }
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ai-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    for (const [f, text] of filesOf(root)) {
      const sha = git(root, ['hash-object', '-w', '--stdin'], { input: text });
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${sha},${f}`], { env });
    }
    const tree = git(root, ['write-tree'], { env });
    let parent = '';
    try { parent = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${AI_BRANCH}`]); } catch { /* first copy */ }
    if (parent && git(root, ['rev-parse', `${parent}^{tree}`]) === tree) return 'up to date';
    const commit = git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'AI copy: summary, map and shared files']);
    git(root, ['update-ref', `refs/heads/${AI_BRANCH}`, commit]);
    return 'updated';
  } finally {
    fs.rmSync(path.dirname(index), { recursive: true, force: true });
  }
}

// Sends the copy up: to the project as the talenscape-ai branch, and as the main version of the
// project's own AI repo (<repo>-ai) when the owner made one: Gemini can only import a main version.
// A repo that isn't there just fails, quietly. Returns where it went.
export function pushAiCopy(root) {
  const sent = [];
  // Only from main: a push from a test or side branch would put that branch's notes in the copy.
  let branch = '';
  try { branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* not a repository */ }
  if (branch !== 'main' && branch !== 'master') return sent;
  // Replace the copy only while it holds nothing but our own copies: if someone else saved there,
  // leave it and say so (their file would be lost), until it's moved into the project.
  const ours = (to, branch) => {
    try {
      git(root, ['fetch', '-q', to, `+refs/heads/${branch}:refs/talenscape/check`], { timeout: 60000 });
      const subjects = git(root, ['log', '--format=%s', 'refs/talenscape/check']).split('\n');
      return subjects.every((m) => m === 'AI copy: summary, map and shared files');
    } catch { return true; } // nothing there yet (or offline: the push fails anyway)
    finally { try { git(root, ['update-ref', '-d', 'refs/talenscape/check']); } catch { /* none */ } }
  };
  const push = (to, ref, branch) => {
    if (!ours(to, branch)) { sent.push(`${to} (skipped: someone else saved there; move their files into shared/notes/ first)`); return; }
    try { git(root, ['push', '-q', to, ref], { timeout: 60000 }); sent.push(to); } catch { /* not there, or offline */ }
  };
  try { git(root, ['rev-parse', '--verify', '-q', `refs/heads/${AI_BRANCH}`]); } catch { return sent; }
  push('origin', `+${AI_BRANCH}`, AI_BRANCH);
  let url = '';
  try { url = git(root, ['remote', 'get-url', 'origin']); } catch { return sent; }
  push(url.replace(/(\.git)?\/?$/, '-ai$1'), `+${AI_BRANCH}:main`, 'main');
  return sent;
}
