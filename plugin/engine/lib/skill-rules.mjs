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
