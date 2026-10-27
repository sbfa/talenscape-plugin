# Making a skill, a tool or a plugin: the formats that work

Follow these exactly: they're what Claude Code, Codex, Gemini CLI, Grok Build and Muse Code check.
(In Talenscape's city, + Add and the workbench write all of this for you.)

## A skill: `<name>/SKILL.md`
```
---
name: release-notes
description: Writes short release notes from the past week's commits. Use when asked for release notes.
---

The instructions, in steps.
```
- The header block (between the `---` lines) is required. `# Skill:` or `Description:` as text doesn't count.
- `name`: lowercase words joined by hyphens, the same as the folder name, at most 64 characters.
- `description`: what it does and when to use it, at most 1024 characters.
- Where: `.claude/skills/<name>/` (Claude Code), `.agents/skills/<name>/` (Codex, Gemini CLI and most
  others), `.grok/skills/<name>/` (Grok Build).
- Good instructions say, in short sections: when to use it, what to ask first, the steps, what "done"
  looks like, and what to do if a step fails.

## A tool: a script plus a skill
Put the script in the skill's own folder (`word-count/word-count.py`), standalone or inside a plugin's
`skills/`, and say in the SKILL.md when to run it, the exact command, and what to report. Never put keys
or passwords in either.

## A Claude Code plugin: one folder
```
weekly-report/
  .claude-plugin/plugin.json
  skills/weekly-report/SKILL.md      (header as above)
  commands/weekly-report.md          header: --- description: … ---   ($ARGUMENTS = what was typed after it)
  agents/weekly-report-reviewer.md   header: --- name: …  description: … ---
  README.md                          40+ words: what it does, how to use it, the install line below
  LICENSE                            the full text (MIT is fine), never cut short
  .claude-plugin/icon.png            optional: a square PNG, 512 to 2048 px
```
`plugin.json`:
```
{ "name": "weekly-report", "version": "1.0.0", "description": "…",
  "author": { "name": "Your name" }, "license": "MIT" }
```
`author` must be an object like that, not plain text, or the plugin won't install.
Install line for the README: `/plugin install weekly-report --marketplace <owner>/<repo>`.

## A Gemini CLI extension: one folder
`gemini-extension.json` (`{ "name", "version", "description", "contextFileName": "GEMINI.md" }`),
`GEMINI.md`, `skills/<name>/SKILL.md`, and `commands/<name>.toml`:
```
description = "…"
prompt = """
Use the weekly-report skill. {{args}}
"""
```

## Before saying it's done
Check each file against this page: header blocks present, names match folders, `author` is an object,
README long enough, LICENSE complete. If you can run it, `claude plugin validate <folder>` and
`gemini extensions validate <folder>` say for sure.
