// Receipt: where a chat's tokens went, from the chat's own record (exact counts, not guesses).
// Every Claude reply re-reads the whole chat, so each reply's input minus the one before is exactly
// what was added in between. That growth is split between what was added (your messages, images,
// files read, command output, …) by their rough size, and each piece is charged once per later
// reply that re-read it.
//   city receipt [chat.jsonl]   default: the newest chat record in ~/.claude/projects
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IMAGE_TOKENS = 1600; // a phone screenshot, roughly (Anthropic: width × height ÷ 750, after resizing)
const READS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
const LABELS = {
  start: 'Start (fixed setup + first message)',
  you: 'Your messages',
  images: 'Images',
  files: 'Files read',
  commands: 'Command output',
  tools: 'Other tools',
  mine: 'My replies and commands',
  notes: 'Notes added by the app and hooks',
  other: 'Other',
};

const est = (v) => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v ?? '')).length / 3.5);
const inputOf = (u) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

export function newestChat(home = os.homedir()) {
  const dir = path.join(home, '.claude', 'projects');
  let best = null;
  try {
    for (const d of fs.readdirSync(dir)) {
      let names;
      try { names = fs.readdirSync(path.join(dir, d)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(dir, d, n), t = fs.statSync(f).mtimeMs;
        if (!best || t > best.t) best = { f, t };
      }
    }
  } catch { /* no records */ }
  return best?.f ?? null;
}

// Where a note came from. Hooks by when they run (Talenscape's own are the start-of-chat summary,
// the check-in before each message, the tool steering and the connector follow-up); Claude Code's own
// notes by their type. Records Claude Code keeps for itself (a copy of the setup, tool-input copies)
// are not part of what Claude reads: they add nothing.
const HOOK_SOURCES = { SessionStart: 'start', UserPromptSubmit: 'checkin', PreToolUse: 'steer', PostToolUse: 'after', Stop: 'stop' };
const TALENSCAPE_HOOK = /talenscape|hooks\/start\.sh|engine\/(steer|peek|after|session)\.mjs/i;
const LISTS = new Set(['skill_listing', 'deferred_tools_delta', 'mcp_instructions_delta', 'agent_listing_delta']);
const SETUP = new Set(['environment', 'model', 'instructions', 'session_context', 'auto_mode', 'credential_org', 'remote_session_change', 'command_permissions']);
const REMINDERS = new Set(['task_reminder', 'todo_reminder', 'silent_turn_reminder', 'edited_text_file', 'date', 'inlined_image_paths', 'plan_mode', 'critical_system_reminder', 'output_style']);
const UNREAD = new Set(['prompt_snapshot', 'deferred_tools_record']);
export const NOTE_SOURCES = ['start', 'checkin', 'steer', 'after', 'stop', 'hooks', 'lists', 'setup', 'reminders', 'other'];

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '');

// The helper (Agent call) a report or notice belongs to: by its call's id, or the helper's own id.
function agentOf(s, ctx) {
  const id = s.match(/<tool-use-id>([^<\s]+)/)?.[1];
  if (id && ctx.agents.has(id)) return id;
  const from = s.match(/<agent-message from="([^"]+)"/)?.[1] ?? s.match(/<task-id>([^<\s]+)/)?.[1];
  return from && ctx.agentIds.get(from);
}

// What one record entry adds to the chat: [kind, what, rough size] (rough sizes; only the split uses
// them). what names the tool (Bash, Skill/<skill>, Agent/<call id>) or the note's source.
function pieces(e, ctx) {
  const out = [];
  const add = (k, what, n) => { if (n > 0) out.push([k, what, n]); };
  const tool = (id, n) => {
    const name = ctx.toolNames.get(id);
    const what = name === 'Skill' ? `Skill/${ctx.skills.get(id) ?? ''}` : name === 'Agent' || name === 'Task' ? `Agent/${id}` : name ?? 'unknown';
    add(READS.has(name) ? 'files' : name === 'Bash' ? 'commands' : 'tools', what, n);
  };
  // A helper's report or a notice it finished, arriving like a message: the Agent tool's.
  const fromAgent = (s, n) => { const id = agentOf(s, ctx); if (!id) return false; add('tools', `Agent/${id}`, n); return true; };
  const content = e.message?.content;
  if (e.type === 'user') {
    const s = textOf(content);
    if (e.sourceToolUseID && ctx.toolNames.has(e.sourceToolUseID)) { tool(e.sourceToolUseID, est(s)); return out; } // a skill's instructions, loaded by its call
    if (e.origin?.kind && e.origin.kind !== 'human' && s && fromAgent(s, est(s))) return out;
    if (e.isMeta && s) { add('notes', /^Stop hook feedback/.test(s) ? 'stop' : 'reminders', est(s)); return out; }
    if (typeof content === 'string') add('you', 'you', est(content));
    for (const c of Array.isArray(content) ? content : []) {
      if (c.type === 'image') add('images', 'images', IMAGE_TOKENS);
      else if (c.type === 'text') add('you', 'you', est(c.text));
      else if (c.type === 'tool_result') tool(c.tool_use_id, est(c.content));
    }
  } else if (e.type === 'assistant') {
    for (const c of Array.isArray(content) ? content : []) {
      if (c.type === 'text') add('mine', 'mine', est(c.text));
      else if (c.type === 'tool_use') add('mine', 'mine', est(c.input));
    }
  } else if (e.type === 'attachment') {
    const a = e.attachment ?? {}, t = a.type;
    if (UNREAD.has(t)) return out;
    if (t === 'queued_command') { // a message that came in while Claude was working
      const s = String(a.prompt ?? '');
      if (a.origin?.kind === 'human') add('you', 'you', est(s));
      else if (!fromAgent(s, est(s))) add('notes', 'other', est(s));
    } else if (a.hookEvent) {
      const src = HOOK_SOURCES[a.hookEvent];
      const ours = a.command ? TALENSCAPE_HOOK.test(a.command) : ctx.ourHooks.has(a.hookEvent);
      add('notes', src && (ours || src === 'stop') ? src : 'hooks', est(a.content ?? '')); // only the hook's content reaches Claude
    } else add('notes', LISTS.has(t) ? 'lists' : SETUP.has(t) ? 'setup' : REMINDERS.has(t) ? 'reminders' : 'other', est(a));
  }
  return out;
}

// What the record tells before the split: tool names by call id, the skill each Skill call loaded,
// the helpers started (Agent calls) with their own token totals, and which hooks are Talenscape's.
function lookups(entries) {
  const ctx = { toolNames: new Map(), skills: new Map(), agents: new Map(), agentIds: new Map(), uses: new Map(), skillUses: new Map(), ourHooks: new Set() };
  for (const e of entries) {
    if (e.type === 'assistant') for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (c.type !== 'tool_use') continue;
      ctx.toolNames.set(c.id, c.name);
      ctx.uses.set(c.name, (ctx.uses.get(c.name) ?? 0) + 1);
      if (c.name === 'Skill' && c.input?.skill) { ctx.skills.set(c.id, String(c.input.skill)); ctx.skillUses.set(String(c.input.skill), (ctx.skillUses.get(String(c.input.skill)) ?? 0) + 1); }
      if (c.name === 'Agent' || c.name === 'Task') ctx.agents.set(c.id, { description: String(c.input?.description ?? c.input?.subagent_type ?? 'Helper'), tokens: null });
    }
    if (e.type === 'user') {
      const r = e.toolUseResult;
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        const a = c.type === 'tool_result' && ctx.agents.get(c.tool_use_id);
        if (!a || !r || typeof r !== 'object') continue;
        if (r.agentId) ctx.agentIds.set(String(r.agentId), c.tool_use_id);
        if (Number.isFinite(r.totalTokens)) a.tokens = r.totalTokens;
      }
    }
    const a = e.type === 'attachment' && e.attachment;
    if (a?.hookEvent && a.command && TALENSCAPE_HOOK.test(a.command)) ctx.ourHooks.add(a.hookEvent);
  }
  // A helper started in the background tells its total when it finishes, in a notice.
  for (const e of entries) {
    const a = e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment;
    const s = a ? String(a.prompt ?? '') : e.type === 'user' ? textOf(e.message?.content) : '';
    if (!s.includes('<task-notification>')) continue;
    const id = agentOf(s, ctx), total = a?.usage?.totalTokens ?? Number(s.match(/<total_tokens>(\d+)/)?.[1]);
    if (id && Number.isFinite(total)) ctx.agents.get(id).tokens = total;
  }
  return ctx;
}

export function receipt(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return null; }
  const entries = [];
  for (const l of lines) { try { if (l) entries.push(JSON.parse(l)); } catch { /* broken line */ } }
  const ctx = lookups(entries);

  // One reply can span several record entries (thinking, text, tool call): they share a message id.
  const calls = [];
  let pending = {}, seen = new Map();
  for (const e of entries) {
    const u = e.type === 'assistant' && e.message?.usage;
    if (u) {
      const id = e.message.id ?? e.uuid;
      if (seen.has(id)) { calls[seen.get(id)].usage = u; }
      else { seen.set(id, calls.length); calls.push({ usage: u, added: pending }); pending = {}; }
    }
    for (const [k, what, n] of pieces(e, ctx)) pending[`${k}|${what}`] = (pending[`${k}|${what}`] ?? 0) + n;
  }
  if (!calls.length) return null;

  // Each kind, and inside it each tool or note source: the same shares, so they add up to the kind.
  const rows = Object.fromEntries(Object.keys(LABELS).map((k) => [k, { added: 0, reread: 0 }]));
  const parts = new Map();
  let prev = 0;
  calls.forEach((c, i) => {
    const now = inputOf(c.usage), later = calls.length - i; // this reply and every one after it read it
    const grow = now - prev;
    prev = now;
    if (i === 0) { rows.start.added += now; rows.start.reread += now * later; return; }
    if (grow <= 0) return; // the chat was shortened (compacted), nothing new to charge
    const added = Object.entries(c.added), sum = added.reduce((s, [, n]) => s + n, 0);
    const share = sum ? added.map(([k, n]) => [k, grow * n / sum]) : [['other|other', grow]];
    for (const [key, n] of share) {
      const r = rows[key.split('|')[0]], p = parts.get(key) ?? { added: 0, reread: 0 };
      r.added += n; r.reread += n * later;
      p.added += n; p.reread += n * later;
      parts.set(key, p);
    }
  });

  // The tools, skills and note sources, with what they added (summed over their parts).
  const group = (pick) => {
    const out = new Map();
    for (const [key, p] of parts) {
      const [kind, ...rest] = key.split('|'), name = pick(kind, rest.join('|'));
      if (name == null) continue;
      const g = out.get(name) ?? { added: 0, reread: 0 };
      g.added += p.added; g.reread += p.reread;
      out.set(name, g);
    }
    return out;
  };
  const round = (g) => ({ added: Math.round(g?.added ?? 0), reread: Math.round(g?.reread ?? 0) });
  const byTool = group((k, w) => (['files', 'commands', 'tools'].includes(k) ? w.split('/')[0] : null));
  const bySkill = group((k, w) => (w.startsWith('Skill/') ? w.slice(6) : null));
  const byAgent = group((k, w) => (w.startsWith('Agent/') ? w.slice(6) : null));
  const byNote = group((k, w) => (k === 'notes' ? w : null));
  const biggest = (a, b) => b.reread - a.reread || (b.uses ?? 0) - (a.uses ?? 0);

  const sumU = (f) => calls.reduce((s, c) => s + (c.usage[f] ?? 0), 0);
  return {
    replies: calls.length,
    read: { total: sumU('input_tokens') + sumU('cache_read_input_tokens') + sumU('cache_creation_input_tokens'), cached: sumU('cache_read_input_tokens') },
    wrote: { total: sumU('output_tokens'), thinking: calls.reduce((s, c) => s + (c.usage.output_tokens_details?.thinking_tokens ?? 0), 0) },
    rows: Object.entries(rows).filter(([, r]) => r.added > 0).map(([k, r]) => ({ kind: k, label: LABELS[k], added: Math.round(r.added), reread: Math.round(r.reread) })).sort((a, b) => b.reread - a.reread),
    // Every tool called or whose results were read: times used, and what its results added.
    tools: [...new Set([...ctx.uses.keys(), ...byTool.keys()])].map((name) => ({ name, uses: ctx.uses.get(name) ?? 0, ...round(byTool.get(name)) })).sort(biggest),
    skills: [...new Set([...ctx.skillUses.keys(), ...bySkill.keys()])].filter(Boolean).map((name) => ({ name, uses: ctx.skillUses.get(name) ?? 0, ...round(bySkill.get(name)) })).sort(biggest),
    notes: [...byNote].map(([source, g]) => ({ source, talenscape: ['start', 'checkin', 'steer', 'after'].includes(source), ...round(g) })).sort(biggest),
    // tokens: the helper's own total (its work is its own chat, not this one's reading); null if not recorded.
    agents: [...ctx.agents].map(([id, a]) => ({ description: a.description, tokens: a.tokens, ...round(byAgent.get(id)) })).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.reread - a.reread),
  };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

export function describe(r) {
  const pct = (n) => `${Math.round(100 * n / (r.read.total || 1))}%`;
  const width = Math.max(...r.rows.map((x) => x.label.length));
  return [
    `Receipt: ${fmt(r.replies)} replies · read ${fmt(r.read.total)} tokens (${fmt(r.read.cached)} cheap re-reads) · wrote ${fmt(r.wrote.total)} (${fmt(r.wrote.thinking)} of it reasoning)`,
    `${'What'.padEnd(width)}  ${'added'.padStart(9)}  ${'read in all'.padStart(11)}  share`,
    ...r.rows.map((x) => `${x.label.padEnd(width)}  ${fmt(x.added).padStart(9)}  ${fmt(x.reread).padStart(11)}  ${pct(x.reread).padStart(5)}`),
    'Read in all = its size × the replies that re-read it. Splits inside one step are by rough size.',
  ].join('\n');
}

export function main(root, [file]) {
  const f = file || newestChat();
  const r = f && receipt(f);
  if (!r) { console.log('No chat record with replies found (city receipt <chat.jsonl>).'); process.exitCode = 1; return; }
  console.log(describe(r));
}
