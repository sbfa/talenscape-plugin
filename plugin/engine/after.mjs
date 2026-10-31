#!/usr/bin/env node
// Claude Code "after a tool ran" hook, for add-on (MCP) tools: GitHub, browsers, mail and the like can
// return thousands of lines at once, which then sit in the chat and are re-read on every reply. Past
// the same limit as commands (run.mjs CAP_TOKENS), the result is shortened the same way (start, error
// lines, end) and the full text saved to search (city run --log N words). Short results are left as
// they are. Prints nothing otherwise; never blocks.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cap, CAP_TOKENS } from './run.mjs';
import { tokens } from './lib/tokens.mjs';

// The text inside a tool's result, whatever its shape: plain text, MCP content blocks
// ([{ type: 'text', text }]), an object holding them ({ content: [...] }), or other data.
function textOf(response) {
  if (typeof response === 'string') return response;
  const blocks = Array.isArray(response) ? response : Array.isArray(response?.content) ? response.content : null;
  if (blocks) return blocks.every((b) => b?.type === 'text') ? blocks.map((b) => b.text).join('\n') : null; // images etc.: leave alone
  return response == null ? '' : JSON.stringify(response, null, 1);
}

// The shortened text, in the same shape the tool gave it.
function sameShape(response, text) {
  if (typeof response === 'string') return text;
  if (Array.isArray(response)) return [{ type: 'text', text }];
  if (Array.isArray(response?.content)) return { ...response, content: [{ type: 'text', text }] };
  return [{ type: 'text', text }];
}

// Data sent as one long line (JSON) is laid out one field per line first, with the number of items on
// top, so the start and the end of the shortened text show whole items.
function readable(text) {
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    const data = JSON.parse(text);
    return (Array.isArray(data) ? `${data.length} items\n` : '') + JSON.stringify(data, null, 1);
  } catch { return text; }
}

// The same call made twice in a row comes back in full the second time (the AI needs all of it).
function secondCall(root, key) {
  const file = path.join(root, '.city', 'after.json');
  let last = null;
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')).last; } catch { /* first call */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ last: last === key ? null : key }));
  return last === key;
}

export function after(root, input, { limit = CAP_TOKENS } = {}) {
  if (!String(input?.tool_name ?? '').startsWith('mcp__')) return null;
  const text = textOf(input.tool_response);
  if (!text || tokens(text) <= limit) return null;
  const call = `${input.tool_name} ${JSON.stringify(input.tool_input ?? {})}`;
  if (secondCall(root, call)) return null;
  const short = cap(root, readable(text), call.slice(0, 160), { limit, again: 'Need it all? Make the same call again.' });
  return sameShape(input.tool_response, short);
}

export async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let out = null;
  try { out = after(root, input); } catch { return; } // never in the way
  if (!out) return;
  // updatedToolOutput is the current name; updatedMCPToolOutput the older, MCP-only one.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: out, updatedMCPToolOutput: out } }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
