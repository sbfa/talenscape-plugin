// The rules every skill, tool and plugin must follow, shared by the skill checker (on disk) and the
// app's server (things added from the app). No file or network access here.

export const MODELS = ['claude', 'chatgpt', 'gemini', 'grok', 'muse'];
export const TYPES = ['skill', 'tool', 'plugin']; // tools and plugins can run programs: catalog only
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SECRET_RE = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
export const DESC_MIN = 20, DESC_MAX = 300, NAME_MAX = 60, BODY_MAX = 8000;

// A skill made in the app: [] when fine, otherwise plain-words problems.
export function checkItem({ name, description, triggers = '', body = '', plugin = '' }) {
  const bad = [];
  if (!name) bad.push('Give it a name.');
  else if (!NAME_RE.test(name) || name.length > NAME_MAX) bad.push('The name must be lowercase words joined by hyphens, like pdf-summary.');
  if (!description) bad.push('Say what it does.');
  else if (description.length < DESC_MIN || description.length > DESC_MAX) bad.push(`"What it does" should be ${DESC_MIN}–${DESC_MAX} characters (it is ${description.length}).`);
  if (plugin && (!NAME_RE.test(plugin) || plugin.length > NAME_MAX)) bad.push('The district name must be lowercase words joined by hyphens.');
  if (String(triggers).length > 300) bad.push('Keep "when to use it" under 300 characters.');
  if (String(body).length > BODY_MAX) bad.push(`Keep the instructions under ${BODY_MAX} characters.`);
  if (SECRET_RE.test([name, description, triggers, body, plugin].join('\n'))) bad.push('It looks like it contains a key or password. Remove it.');
  return bad;
}

// ---------- habits: the owner's standing instructions (see habits.mjs) ----------
// A project's habits live in its .city/state.json: switched on in owner (kind 'me') and rules
// (kind 'rule'), switched off in habitsOff. The app keeps the same shape, so both apply changes alike.
const KEY = { me: 'owner', rule: 'rules' };

// All habits in order: switched on first (as the blink shows them), then the switched-off ones.
export function listHabits(st) {
  return [
    ...(st.owner ?? []).map((text) => ({ text, kind: 'me', on: true })),
    ...(st.rules ?? []).map((text) => ({ text, kind: 'rule', on: true })),
    ...(st.habitsOff ?? []).map((h) => ({ text: h.text, kind: h.kind === 'me' ? 'me' : 'rule', on: false })),
  ];
}

// One change: { action: add | on | off | edit | drop, text, kind?, to? }. Returns false when it found nothing to change.
export function applyHabit(st, c) {
  const text = String(c?.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!text) return false;
  const found = listHabits(st).find((h) => h.text === text);
  const take = (h) => { // out of wherever it is now
    if (h.on) st[KEY[h.kind]] = st[KEY[h.kind]].filter((t) => t !== h.text);
    else st.habitsOff = st.habitsOff.filter((o) => o.text !== h.text);
  };
  const put = (t, kind, on) => {
    if (on) st[KEY[kind]] = [...(st[KEY[kind]] ?? []), t];
    else st.habitsOff = [...(st.habitsOff ?? []), { text: t, kind }];
  };
  if (c.action === 'add') {
    if (found) return false;
    put(text, c.kind === 'me' ? 'me' : 'rule', true);
  } else if (!found) return false;
  else if (c.action === 'on' || c.action === 'off') {
    if (found.on === (c.action === 'on')) return false;
    take(found); put(found.text, found.kind, c.action === 'on');
  } else if (c.action === 'edit') {
    const to = String(c.to ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!to || to === found.text || listHabits(st).some((h) => h.text === to)) return false;
    const list = found.on ? st[KEY[found.kind]] : st.habitsOff;
    const i = found.on ? list.indexOf(found.text) : list.findIndex((o) => o.text === found.text);
    list[i] = found.on ? to : { ...list[i], text: to }; // keeps its place
  } else if (c.action === 'drop') take(found);
  else return false;
  st.rulesAt = new Date().toISOString();
  return true;
}

// Which other AIs may change a project's code (editors.mjs on a computer; the online city keeps a copy).
export const EDIT_AIS = ['chatgpt', 'gemini', 'grok', 'muse', 'cursor', 'codex', 'copilot'];
export const AI_NAMES = { chatgpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok', muse: 'Meta Muse', cursor: 'Cursor', codex: 'Codex', copilot: 'GitHub Copilot' };
export const EDIT_BRANCH = 'talenscape-edits';

export const cleanEditors = (v) => ({
  ais: [...new Set((Array.isArray(v?.ais) ? v.ais : []).map((a) => String(a).toLowerCase()).filter((a) => EDIT_AIS.includes(a)))].sort((a, b) => EDIT_AIS.indexOf(a) - EDIT_AIS.indexOf(b)),
  where: v?.where === 'main' ? 'main' : 'branch',
});
// The line every AI's start-of-chat summary shows, only when an AI besides Claude may change the project.
export function editsLine(v) {
  const e = cleanEditors(v ?? {});
  if (!e.ais.length) return '';
  const where = e.where === 'main' ? 'straight on main' : `on the branch ${EDIT_BRANCH} (the owner takes it in)`;
  return `EDITS: ${e.ais.map((a) => AI_NAMES[a]).join(', ')} may change this project's code, ${where}: keep the tests passing, never put keys in files, leave a note in shared/notes/ saying what changed (this overrides AGENTS.md step 4 for them). Other AIs hand changes back as text.`;
}
