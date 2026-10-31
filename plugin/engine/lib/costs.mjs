// What every chat costs: a few numbers for the city's cost panel, sent with the check-in. From this
// project's newest Claude Code chat record (lib/receipt.mjs): the fixed start of every chat and the
// biggest shares after it; the skills list every session pays for (lib/budget.mjs); and the
// connectors the chat had (their tool names start mcp__<name>__). Only numbers and names: never the
// chat's text.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { receipt, newestChat } from './receipt.mjs';
import { skillBudget } from './budget.mjs';

const TOP = 5, MAX_CONNECTORS = 30;
const CONNECTOR_RE = /mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__/g; // a single _ can be part of the name, __ ends it

// Claude Code keeps a project's chats in ~/.claude/projects/<its folder, with every other character as ->.
// Cloud chats keep theirs under the session's id instead, one project per machine: then the newest chat.
export function projectChat(root, home = os.homedir()) {
  const dir = path.join(home, '.claude', 'projects', path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-'));
  let best = null;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n), t = fs.statSync(f).mtimeMs;
      if (!best || t > best.t) best = { f, t };
    }
  } catch { return newestChat(home); }
  return best?.f ?? null;
}

// The connectors a chat had: in its tool calls, and in the notes Claude Code adds (the tool lists).
export function connectorsIn(chatPath) {
  let lines;
  try { lines = fs.readFileSync(chatPath, 'utf8').split('\n'); } catch { return []; }
  const names = new Set();
  for (const l of lines) {
    if (!l.includes('mcp__')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const look = [];
    if (e.type === 'assistant') for (const c of Array.isArray(e.message?.content) ? e.message.content : []) if (c.type === 'tool_use') look.push(c.name);
    if (e.type === 'attachment') look.push(JSON.stringify(e.attachment ?? e));
    for (const s of look) for (const m of String(s ?? '').matchAll(CONNECTOR_RE)) names.add(m[1].slice(0, 60));
  }
  // A bare id (8-4-4-4-12) is a connector seen before it got its name: the named one is listed too.
  return [...names].filter((n) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(n)).sort().slice(0, MAX_CONNECTORS);
}

// What's using tokens, as four short lists (each { count, rows }, biggest first, at most MAX_ROWS rows):
//   skills: every skill the project has and every one used: listed (what being in the list costs every
//           chat), uses (Skill calls), tokens (what its instructions cost this chat when used)
//   tools:  one row per tool, a connector's tools as one (connector: true): uses, tokens (its results)
//   notes:  the notes added, by source (fixed keys, receipt.mjs NOTE_SOURCES); talenscape: one of its habits
//   agents: each helper started: its short description, its own total (null if not recorded), and
//           tokens (what its report cost this chat)
// tokens everywhere: size × the replies that re-read it, the same split as the bars, so they add up.
// Names only: tool, skill and connector names, fixed note keys and the helpers' short descriptions.
const MAX_ROWS = 30;
const list = (rows) => ({ count: rows.length, rows: rows.slice(0, MAX_ROWS) });
const connectorOf = (name) => name.match(/^mcp__(.+?)__/)?.[1];

function using(r, listed) {
  const tools = new Map();
  for (const t of r.tools) {
    const c = connectorOf(t.name), name = (c ?? t.name).slice(0, 60);
    const row = tools.get(name) ?? { name, ...(c ? { connector: true } : {}), uses: 0, tokens: 0 };
    row.uses += t.uses; row.tokens += t.reread;
    tools.set(name, row);
  }
  const skills = new Map(listed.map((s) => [s.name, { name: s.name.slice(0, 60), listed: s.tokens, uses: 0, tokens: 0 }]));
  for (const s of r.skills) skills.set(s.name, { ...(skills.get(s.name) ?? { name: s.name.slice(0, 60), listed: 0 }), uses: s.uses, tokens: s.reread });
  return {
    skills: list([...skills.values()].sort((a, b) => b.listed + b.tokens - a.listed - a.tokens || b.uses - a.uses)),
    tools: list([...tools.values()].sort((a, b) => b.tokens - a.tokens || b.uses - a.uses)),
    notes: list(r.notes.map((n) => ({ source: n.source, talenscape: n.talenscape, tokens: n.reread }))),
    agents: list(r.agents.map((a) => ({ name: a.description.replace(/\s+/g, ' ').trim().slice(0, 60), own: a.tokens, tokens: a.reread }))),
  };
}

// { at, chat, replies, read, start, top: [{ kind, tokens, share }], skills: { count, tokens }, connectors, using }, or
// null when there is no chat record. tokens: what that part cost over the whole chat (its size × the
// replies that re-read it); share: its part of everything the chat read.
export function chatCosts(root, { home = os.homedir(), chat = projectChat(root, home) } = {}) {
  const r = chat && receipt(chat);
  if (!r) return null;
  const start = r.rows.find((x) => x.kind === 'start')?.added ?? 0;
  const skills = skillBudget(root).claude;
  return {
    at: new Date(fs.statSync(chat).mtimeMs).toISOString(),
    chat: crypto.createHash('sha1').update(path.basename(chat)).digest('hex').slice(0, 12), // which chat (not its name): the running tally adds only what's new

    replies: r.replies,
    read: r.read.total,
    start,
    top: r.rows.slice(0, TOP).map((x) => ({ kind: x.kind, tokens: x.reread, share: Math.round(1000 * x.reread / (r.read.total || 1)) / 1000 })),
    skills: { count: skills.count, tokens: skills.tokens },
    connectors: connectorsIn(chat),
    using: using(r, skills.each),
  };
}
