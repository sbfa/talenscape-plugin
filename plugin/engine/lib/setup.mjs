// The Setup card: the few choices and one-time steps Talenscape can't make by itself, in one place in the
// city (instead of questions in chat). Each item says where it stands, worked out from the project itself, so
// a step shows done as soon as it is. The owner's "seen" mark lives in .city/setup.json.
//   items: other projects (include them, on unless switched off) · share them with the other AIs (off until
//   switched on) · cloud chats with several projects (a one-time paste, cloud only) · the app key
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, saveConfig, discover, projectName, autoCatalog } from './catalog.mjs';
import { setupScript } from './frontdoor.mjs';
import { readKey } from './sync.mjs';

const FILE = (root) => path.join(root, '.city', 'setup.json');
export const readSetup = (root) => { try { return JSON.parse(fs.readFileSync(FILE(root), 'utf8')); } catch { return {}; } };
const writeSetup = (root, s) => { fs.mkdirSync(path.join(root, '.city'), { recursive: true }); fs.writeFileSync(FILE(root), JSON.stringify(s, null, 1) + '\n'); };

// Where each item stands. done: nothing left for the owner (every item done, or the card was closed with Done).
export function setupStatus(root, { env = process.env, home, quick = false } = {}) {
  // quick (chat start): once the card was closed with Done there is nothing to work out.
  if (quick && readSetup(root).seen) return { items: [], done: true };
  const found = discover(root).map((d) => (quick ? path.basename(d) : projectName(d))), config = readConfig(root), saved = readSetup(root);
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  const items = [];
  if (found.length) {
    items.push({ id: 'catalog', kind: 'switch', on: config.consent !== 'no', done: true,
      title: 'Include my other projects', text: `${found.length} other project(s) next to this one (${found.slice(0, 4).join(', ')}${found.length > 4 ? '…' : ''}). Questions about them then cost fewer tokens. Kept on this computer.` });
    items.push({ id: 'share', kind: 'switch', on: config.consent !== 'no' && config.share, done: true, off: config.consent === 'no',
      title: 'Share them with my other AIs', text: 'Saves the catalog with the project on GitHub, so Muse, Grok and others can read it too. Off until you switch it on.' });
  }
  if (cloud && found.length) {
    items.push({ id: 'frontdoor', kind: 'steps', done: !!saved.frontDoorPreset,
      title: 'Cloud chats with several projects', text: 'So chats with several projects attached get the summary too. Once, on claude.ai:',
      steps: ['Open Claude Code on the web, then this environment\'s settings.', 'Find "Setup script" and paste the text below (Copy).', 'Save. It shows Done here after your next chat starts.'],
      copy: setupScript(root) });
  }
  items.push({ id: 'key', kind: 'steps', done: !!readKey(env, home),
    title: 'Your city app key', text: 'So this project\'s skills show in your online city and what you add there comes back. Once:',
    steps: ['Open your city app, Owner page, Keys: make a project key.', cloud ? 'Add it to this environment\'s settings as TALENSCAPE_KEY.' : 'Save it in the file ~/.talenscape/key on this computer.', 'It shows Done here at the next chat start.'] });
  return { items, done: !!saved.seen || items.every((i) => i.done && i.kind !== 'switch') };
}

// The owner's choices from the card: { catalog: bool, share: bool, seen: bool }.
export async function saveSetup(root, body) {
  const config = readConfig(root);
  if (typeof body.catalog === 'boolean' || typeof body.share === 'boolean') {
    const consent = body.catalog === false ? 'no' : body.catalog === true ? 'yes' : config.consent ?? 'yes';
    saveConfig(root, { ...config, consent, share: consent === 'yes' && (typeof body.share === 'boolean' ? body.share : config.share) });
    if (consent === 'yes') await autoCatalog(root, { background: true }).catch(() => ({})); // the page answers at once
  }
  if (typeof body.seen === 'boolean') writeSetup(root, { ...readSetup(root), seen: body.seen });
  return setupStatus(root);
}

// At chat start in the cloud: were the front-door hooks already there before this chat (the Setup script ran)?
export function noteFrontDoor(root, before) {
  if (before && !readSetup(root).frontDoorPreset) writeSetup(root, { ...readSetup(root), frontDoorPreset: true });
}
