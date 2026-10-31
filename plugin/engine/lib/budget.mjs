// The skill budget: every skill an AI tool can use puts its name and description into every session,
// before a word is said. Claude Code also has only so much room for that list (about 15,000
// characters by outside measurements; Anthropic doesn't publish it): past it, skills are silently
// dropped or cut short. This adds it up per folder each tool reads, so the blink and the city can
// warn before that happens.
import fs from 'node:fs';
import path from 'node:path';
import { parseSkill } from '../skills.mjs';

export const LISTING_ROOM = 15000; // characters (unofficial; see above)
const FOLDERS = { claude: ['.claude/skills', '.agents/skills'], grok: ['.grok/skills', '.agents/skills'], gemini: ['.gemini/skills', '.agents/skills'], codex: ['.agents/skills'] };
const ENTRY_EXTRA = 30; // the list's own wording around each skill

function skillsIn(root, dir) {
  const out = [];
  try {
    for (const d of fs.readdirSync(path.join(root, dir))) {
      const f = path.join(root, dir, d, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const { meta } = parseSkill(fs.readFileSync(f, 'utf8'));
      const models = [].concat(meta?.models ?? []);
      out.push({ name: meta?.name ?? d, description: String(meta?.description ?? ''), models });
    }
  } catch { /* no folder */ }
  return out;
}

// { claude: { count, chars, tokens, share, biggest: [names], each: [{ name, tokens }] }, … }: what each
// tool loads every session, in all and per skill.
export function skillBudget(root) {
  const out = {};
  for (const [ai, dirs] of Object.entries(FOLDERS)) {
    const seen = new Map();
    for (const d of dirs) for (const s of skillsIn(root, d)) if (!seen.has(s.name) && (!s.models.length || s.models.includes(ai) || (ai === 'codex' && s.models.includes('chatgpt')))) seen.set(s.name, s);
    const list = [...seen.values()], chars = list.reduce((a, s) => a + s.name.length + s.description.length + ENTRY_EXTRA, 0);
    out[ai] = { count: list.length, chars, tokens: Math.ceil(chars / 3.5), share: chars / LISTING_ROOM, // tokens: ~3.5 characters each, as lib/tokens.mjs
      biggest: list.sort((a, b) => b.description.length - a.description.length).slice(0, 3).map((s) => s.name),
      each: list.map((s) => ({ name: s.name, tokens: Math.ceil((s.name.length + s.description.length + ENTRY_EXTRA) / 3.5) })) };
  }
  return out;
}

// The blink's line: only when Claude's list is getting full (60% of the room or more).
export function budgetLine(root) {
  const c = skillBudget(root).claude;
  if (c.share < 0.6) return null;
  const pct = Math.round(c.share * 100);
  return `SKILLS: ${c.count} for Claude cost ~${c.tokens} tokens every session, ${pct}% of the room Claude Code has for listing them${c.share >= 1 ? ' (over: some are being dropped or cut short)' : ''}. Biggest: ${c.biggest.join(', ')}. Unload unused ones in the city, or shorten their descriptions.`;
}
