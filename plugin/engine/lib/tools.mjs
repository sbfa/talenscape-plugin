// Claude Code and Grok Build send the same "before a tool runs" hook with different names: Claude
// uses tool_name / tool_input and Bash, Read, Edit; Grok uses toolName / toolInput and
// run_terminal_command, read_file, search_replace. Talenscape's hooks work in Claude's names, so a
// Grok call is translated on the way in and a rewritten call is translated back on the way out.

const GROK_TOOLS = { run_terminal_command: 'Bash', read_file: 'Read', search_replace: 'Edit', write_file: 'Write', edit_file: 'Edit' };
const FILE_KEYS = ['file_path', 'path', 'target_file', 'filePath', 'file'];
const PART_KEYS = ['offset', 'limit', 'start_line', 'end_line', 'line_start', 'line_end', 'startLine', 'endLine', 'lines', 'range'];

// Returns { input (Claude's shape), from ('claude' | 'grok'), back(updatedInput) → the caller's own shape }.
export function fromHook(raw) {
  if (!raw || raw.tool_name || !raw.toolName) return { input: raw, from: 'claude', back: (u) => u };
  const ti = raw.toolInput ?? {};
  const fileKey = FILE_KEYS.find((k) => typeof ti[k] === 'string');
  const partial = PART_KEYS.some((k) => ti[k] !== undefined);
  const input = {
    ...raw,
    tool_name: GROK_TOOLS[raw.toolName] ?? raw.toolName,
    tool_input: { ...ti, ...(fileKey ? { file_path: ti[fileKey] } : {}), ...(partial && ti.offset === undefined ? { offset: 1 } : {}) },
    cwd: raw.cwd ?? raw.workspaceRoot,
  };
  // Only the command is ever rewritten; everything else goes back exactly as Grok sent it.
  return { input, from: 'grok', back: (u) => ({ ...ti, ...(u.command !== undefined ? { command: u.command } : {}) }) };
}
