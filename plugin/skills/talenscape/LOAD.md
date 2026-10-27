# Load Talenscape in a browser AI (Grok, Meta Muse, ChatGPT…) that can read GitHub

## The one starting message (send it once, in the AI's project or chat)

```
Set up Talenscape from GitHub: repo sbfa/talenscape-plugin (main). Read AGENTS.md there and follow it.
```

The AI finds its own file in `shared/`, asks you once whether it may save a Talenscape note to its
memory (say yes: then every new chat starts with the project summary), writes its list of skills,
tools and plugins, and deletes the setup. Asking you first keeps AI safety checks from mistaking the
memory note for a planted instruction.

## Older way: saved instructions

Paste the box below once into the AI's saved instructions (custom instructions / personalization).
After that, typing `ts owner/repo` (or `ts owner/repo@branch`) in any chat loads the project the
Talenscape way. It is short on purpose: saved instructions are read in every chat.

```
Talenscape: when I write "ts owner/repo" (optionally "@branch"), use GitHub to read AGENTS.md in that
repo and branch and follow it (it starts you with .city/BLINK.md, the same summary Claude Code gets).
Then do the task I give you with that context. Only I or Claude Code change the project: give changes
back as text or a patch. The one file you may change is your own shared/<you>.md (do its setup once).
"ts" alone: the last project.
```

## Gemini (and other AIs that import a whole project at once)

Gemini's "Import code" can't read branch links, and a whole project eats its usage. Give it the small
AI copy instead (only the summary, the map and the shared files, rebuilt on every push): the owner
makes an empty private repo named `<repo>-ai` (e.g. `you/your-project-ai`) and lets Gemini see it;
each push then sends the copy there as its main version. Import `https://github.com/<owner>/<repo>-ai`. Then: "Read README.md and BLINK.md in this import and follow
them." Gemini can't save to GitHub: it hands its list or notes to the owner as text.
